import { createPostgresConnection, PostgresBoundaryError } from '../connection.ts';
import type { ConnectionOptions, PgOutcome, PostgresTarget } from '../connection.ts';
import { verifyPostgresDeployment } from '../deployment.ts';
import type { ExpectedPostgresDeployment } from '../deployment.ts';
import { verifySeoulServingPrivileges } from './privileges.ts';
import { parseSeoulAdmissionEnvelope, parseSeoulArchiveReceipt, parseSeoulIngestInput, parseSeoulPatAdmission,
  parseSeoulPatDigest, parseSeoulSearchInput, parseSeoulSearchResult } from './codecs.ts';
import { SeoulRepositoryError } from './types.ts';
import type { SeoulErrorCode, SeoulRepository, SeoulRequestOptions } from './types.ts';

export type SeoulRepositoryOptions = Readonly<{
  /** Native transport injection only. All deployment/catalog and command SQL still execute. */
  clientFactory?: ConnectionOptions['clientFactory'];
  /** Elapsed time, never a wall-clock comparison with the database's epoch. */
  monotonicNow?: () => number;
}>;
const schemas = ['memory_control', 'memory_identity', 'memory_content', 'memory_search', 'memory_jobs', 'memory_ops'];
const sqlStates: Readonly<Record<string, SeoulErrorCode>> = Object.freeze({
  PA001: 'seoul_input_invalid', PA002: 'seoul_pat_denied', PA003: 'seoul_space_denied',
  PA004: 'seoul_processing_denied', PA005: 'seoul_operation_conflict', PA006: 'seoul_quota_exceeded', PA007: 'seoul_authority_expired',
});
const statements = Object.freeze({
  preauthenticatePat: 'SELECT memory_identity.seoul_pat_check($1::text) AS value',
  ingest: 'SELECT memory_content.seoul_archive_ingest($1::text,$2::jsonb) AS value',
  search: 'SELECT memory_content.seoul_keyword_search($1::text,$2::jsonb) AS value',
});
function fail(code: SeoulErrorCode, outcome: PgOutcome = 'not_started'): never { throw new SeoulRepositoryError(code, outcome); }
function requestOptions(options: SeoulRequestOptions | undefined): SeoulRequestOptions {
  if (options === undefined) return {};
  if (!options || typeof options !== 'object' || Object.getPrototypeOf(options) !== Object.prototype
    || Reflect.ownKeys(options).some(key => key !== 'signal')) fail('seoul_input_invalid');
  const descriptor = Object.getOwnPropertyDescriptor(options, 'signal');
  if (!descriptor) return {};
  if (!('value' in descriptor) || !descriptor.enumerable
    || (descriptor.value !== undefined && !(descriptor.value instanceof AbortSignal))) fail('seoul_input_invalid');
  return { signal: descriptor.value };
}

/** Fixed Seoul storage-only service. The SQL commands independently enforce the
 * current Space's approved-processors profile and native PAT authority. No other
 * region, storage backend, SQL target or automatic mutation retry is selected. */
export function createSeoulRepository(target: PostgresTarget, expected: ExpectedPostgresDeployment,
  options: SeoulRepositoryOptions = {}): Readonly<SeoulRepository> {
  let connection: ReturnType<typeof createPostgresConnection>;
  let clock: () => number;
  try {
    if (!options || typeof options !== 'object') fail('seoul_unavailable');
    clock = options.monotonicNow ?? (() => performance.now());
    if (!target || !expected || target.provider !== 'supabase' || target.region !== 'kr-seoul'
      || expected.region !== 'kr-seoul' || expected.deploymentId !== target.deploymentId
      || expected.schemaVersion !== 4 || expected.processingPolicyId !== 'kr-primary-storage-v1'
      || !Array.isArray(target.applicationSchemas) || target.applicationSchemas.length !== schemas.length
      || new Set(target.applicationSchemas).size !== schemas.length || schemas.some(name => !target.applicationSchemas.includes(name))
      || typeof clock !== 'function' || (options.clientFactory !== undefined && typeof options.clientFactory !== 'function')) fail('seoul_unavailable');
    const wanted = Object.freeze({ ...expected }), role = target.expectedRole;
    connection = createPostgresConnection(target, { clientFactory: options.clientFactory, async verifyDeployment(session) {
      const metadata = await verifyPostgresDeployment(session, wanted);
      await verifySeoulServingPrivileges(session, role);
      return metadata;
    } });
  } catch { fail('seoul_unavailable'); }
  const leases = new WeakMap<object, () => void>();

  async function execute<T>(action: keyof typeof statements | 'probe', digest: string | undefined,
    body: string | undefined, decode: ((value: unknown) => T) | undefined, options?: SeoulRequestOptions): Promise<T> {
    const request = requestOptions(options), write = action === 'ingest';
    let last = -1, started = 0, ttl: number | undefined, terminal = false;
    let localError: SeoulRepositoryError | undefined;
    let dispatched = false;
    const check = (outcome: PgOutcome = 'not_started') => {
      let now: number;
      try { now = clock(); } catch { terminal = true; fail('seoul_authority_expired', outcome); }
      if (terminal || !Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER || now < last
        || (ttl !== undefined && now - started >= ttl)) {
        terminal = true; fail('seoul_authority_expired', outcome);
      }
      last = now;
      return now;
    };
    started = check();
    try {
      const value = await connection.transaction(async session => {
        try {
          check();
          if (action === 'probe') return undefined as T;
          dispatched = true;
          const response = await session.query(statements[action], body === undefined ? [digest!] : [digest!, body]);
          if (response.rows.length !== 1) fail('seoul_response_invalid');
          const row = response.rows[0];
          if (!row || typeof row !== 'object' || Reflect.ownKeys(row).length !== 1) fail('seoul_response_invalid');
          const descriptor = Object.getOwnPropertyDescriptor(row, 'value');
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('seoul_response_invalid');
          const envelope = parseSeoulAdmissionEnvelope(descriptor.value);
          ttl = envelope.admission.expiresAtMs - envelope.admission.issuedAtMs;
          const result = decode!(envelope.result);
          check(); // Include all startup, locks and validation in the DB-issued TTL.
          return result;
        } catch (error) {
          // connection.ts deliberately strips arbitrary callback error messages.
          // Retain only our own fixed code locally and use its confirmed outcome.
          if (error instanceof SeoulRepositoryError) {
            localError = error;
            throw new PostgresBoundaryError('postgres_operation_failed');
          }
          throw error;
        }
      }, request);
      check('committed'); // COMMIT and socket cleanup also consume admission TTL.
      if (request.signal?.aborted) fail('seoul_unavailable', 'committed');
      if ((action === 'ingest' || action === 'search') && value && typeof value === 'object') {
        leases.set(value, () => {
          try {
            if (request.signal?.aborted) { terminal = true; fail('seoul_authority_expired', 'committed'); }
            check('committed');
          } catch { fail(write ? 'seoul_write_outcome_unknown' : 'seoul_authority_expired', 'committed'); }
        });
      }
      return value;
    } catch (error) {
      const outcome = error instanceof PostgresBoundaryError || error instanceof SeoulRepositoryError ? error.outcome : 'unknown';
      if (write && dispatched && (outcome === 'committed' || outcome === 'unknown')) fail('seoul_write_outcome_unknown', outcome);
      const code = localError?.code ?? (error instanceof SeoulRepositoryError ? error.code
        : error instanceof PostgresBoundaryError && error.sqlState ? sqlStates[error.sqlState] : undefined);
      fail(code ?? 'seoul_unavailable', outcome);
    }
  }

  const repository: SeoulRepository = {
    assertDisclosure: result => {
      const lease = result && typeof result === 'object' ? leases.get(result) : undefined;
      if (!lease) fail('seoul_response_invalid');
      lease();
    },
    probe: options => execute<void>('probe', undefined, undefined, undefined, options),
    preauthenticatePat: async (digest, options) => execute<void>('preauthenticatePat', parseSeoulPatDigest(digest), undefined, parseSeoulPatAdmission, options),
    ingest: async (digest, input, options) => {
      const token = parseSeoulPatDigest(digest), saved = parseSeoulIngestInput(input), body = JSON.stringify(saved);
      return execute('ingest', token, body, value => parseSeoulArchiveReceipt(value, saved), options);
    },
    search: async (digest, input, options) => {
      const token = parseSeoulPatDigest(digest), saved = parseSeoulSearchInput(input), body = JSON.stringify(saved);
      return execute('search', token, body, value => parseSeoulSearchResult(value, saved), options);
    },
  };
  return Object.freeze(repository);
}

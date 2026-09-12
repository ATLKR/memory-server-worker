import type { Database, Value } from './types.ts';
import { prepareSeoulHeadCandidate, type SeoulHeadCandidate } from './seoul-projection-source-codec.ts';

type Failure = 'invalid_revision' | 'source_missing' | 'source_invalid' | 'source_contract_unsupported' | 'source_mismatch'
  | 'prepared_identity_conflict' | 'inconsistent_preparation' | 'staging_retained' | 'preparation_absent' | 'preparation_uncertain' | 'request_limit';
export type SeoulPreparationResult = { status: Failure } | {
  /** Exact persisted completion observed before/after this call's one attempt.
   * Neither status claims insertion ownership or regional application. */
  status: 'prepared' | 'already_prepared'; revision: number; eventId: string;
  sourceChangeSha256: string; transportPayloadSha256: string;
};
export interface SeoulProjectionPreparer { prepare(revision: unknown): Promise<SeoulPreparationResult> }
type Plan = { sql: string; values: Value[]; mode: 'all' };
const utf8 = new TextEncoder();
const flagNames = ['source_present', 'source_exact', 'prepared_present', 'prepared_exact', 'event_present', 'event_exact', 'delivery_present', 'head_complete', 'head_newer', 'head_pending', 'stage_present'] as const;
type Flags = Record<typeof flagNames[number], 0 | 1>;
type Observation = 'complete' | 'absent' | 'source_mismatch' | 'prepared_identity_conflict' | 'inconsistent_preparation' | 'staging_retained' | 'preparation_uncertain';
const SOURCE_SQL = 'SELECT revision,source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at FROM release_seoul_authority_changes WHERE revision=? LIMIT 1';
const candidateColumns = 'revision,source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at,source_sha256,transport_sha256,payload_bytes';
// All predicates bind indexed identities first. No current-head-only source
// selection, changes(), guessed rowid, SQL SHA or application transaction.
const sourceExact = (c: string, v: string) => `${c}.revision=${v}.revision AND ${c}.source_command_id=${v}.source_command_id AND ${c}.stream_kind=${v}.stream_kind
 AND ${c}.stream_key=${v}.stream_key AND ${c}.event_id=${v}.event_id AND ${c}.record_bytes=${v}.record_bytes AND ${c}.created_at=${v}.created_at`;
const preparedExact = (p: string, v: string) => `${p}.revision=${v}.revision AND ${p}.event_id=${v}.event_id AND ${p}.source_sha256=${v}.source_sha256 AND ${p}.transport_sha256=${v}.transport_sha256`;
const eventExact = (e: string, v: string) => `${e}.event_id=${v}.event_id AND ${e}.source_revision=${v}.revision AND ${e}.event_kind='head'
 AND ${e}.stream_kind=${v}.stream_kind AND ${e}.stream_key=${v}.stream_key AND ${e}.source_sha256=${v}.source_sha256
 AND ${e}.space_id IS NULL AND ${e}.snapshot_seq IS NULL AND ${e}.issued_at IS NULL AND ${e}.expires_at IS NULL
 AND ${e}.payload_bytes=${v}.payload_bytes AND ${e}.payload_sha256=${v}.transport_sha256`;
const headKey = (h: string, v: string) => `${h}.stream_kind=${v}.stream_kind AND ${h}.stream_key=${v}.stream_key`;
const currentComplete = (h: string, v: string) => `${h}.revision=${v}.revision AND ${h}.event_id=${v}.event_id AND ${h}.payload_sha256=${v}.source_sha256`;
const pairJoin = (v: string) => `JOIN release_seoul_prepared_sources p ON ${preparedExact('p', v)} JOIN release_seoul_projection_events e ON ${eventExact('e', v)}`;
const deliveryJoin = (v: string) => `JOIN release_seoul_projection_deliveries d ON d.event_id=${v}.event_id`;
const RECONCILE_SQL = `WITH v(${candidateColumns}) AS (VALUES(?,?,?,?,?,?,?,?,?,?)) SELECT
 EXISTS(SELECT 1 FROM release_seoul_authority_changes c WHERE c.revision=v.revision LIMIT 1) source_present,
 EXISTS(SELECT 1 FROM release_seoul_authority_changes c WHERE ${sourceExact('c', 'v')} LIMIT 1) source_exact,
 EXISTS(SELECT 1 FROM release_seoul_prepared_sources p WHERE p.revision=v.revision OR p.event_id=v.event_id LIMIT 1) prepared_present,
 EXISTS(SELECT 1 FROM release_seoul_prepared_sources p WHERE ${preparedExact('p', 'v')} LIMIT 1) prepared_exact,
 EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE e.event_id=v.event_id LIMIT 1) event_present,
 EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE ${eventExact('e', 'v')} LIMIT 1) event_exact,
 EXISTS(SELECT 1 FROM release_seoul_projection_deliveries d WHERE d.event_id=v.event_id LIMIT 1) delivery_present,
 EXISTS(SELECT 1 FROM release_seoul_authority_heads h WHERE ${headKey('h', 'v')} AND ${currentComplete('h', 'v')} LIMIT 1) head_complete,
 EXISTS(SELECT 1 FROM release_seoul_authority_heads h WHERE ${headKey('h', 'v')} AND h.revision>v.revision LIMIT 1) head_newer,
 EXISTS(SELECT 1 FROM release_seoul_authority_heads h WHERE ${headKey('h', 'v')} AND h.revision=v.revision AND h.event_id=v.event_id AND h.payload_sha256 IS NULL LIMIT 1) head_pending,
 EXISTS(SELECT 1 FROM release_seoul_preparation_stage LIMIT 1) stage_present FROM v LIMIT 1`;

function values(c: SeoulHeadCandidate): Value[] {
  const r = c.rowGuard; return [r.revision, r.source_command_id, r.stream_kind, r.stream_key, r.event_id, r.record_bytes, r.created_at,
    c.sourceChangeSha256, c.transportPayloadSha256, c.eventText];
}
function plans(c: SeoulHeadCandidate): Plan[] {
  const token = crypto.randomUUID();
  const result: Plan[] = [];
  const add = (sql: string, parameters: Value[] = [token]) => result.push({ sql, values: parameters, mode: 'all' });
  // The SELECT below ALWAYS has one row; eligibility is a column, never an
  // INSERT filter. A retained witness must reach the BEFORE INSERT guard.
  add(`INSERT INTO release_seoul_preparation_stage(token,${candidateColumns},eligible)
 SELECT v.*,CASE WHEN EXISTS(SELECT 1 FROM release_seoul_authority_changes c WHERE ${sourceExact('c', 'v')})
  AND NOT EXISTS(SELECT 1 FROM release_seoul_prepared_sources p WHERE p.revision=v.revision OR p.event_id=v.event_id)
  AND NOT EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE e.event_id=v.event_id)
  AND NOT EXISTS(SELECT 1 FROM release_seoul_projection_deliveries d WHERE d.event_id=v.event_id) THEN 1 ELSE 0 END
 FROM (SELECT ? token,? revision,? source_command_id,? stream_kind,? stream_key,? event_id,? record_bytes,? created_at,? source_sha256,? transport_sha256,? payload_bytes) v`, [token, ...values(c)]);
  add(`INSERT INTO release_seoul_prepared_sources(revision,event_id,source_sha256,transport_sha256)
 SELECT s.revision,s.event_id,s.source_sha256,s.transport_sha256 FROM release_seoul_preparation_stage s WHERE s.token=? AND s.eligible=1`);
  add(`INSERT INTO release_seoul_projection_events(event_id,source_revision,event_kind,stream_kind,stream_key,source_sha256,space_id,snapshot_seq,issued_at,expires_at,payload_bytes,payload_sha256)
 SELECT s.event_id,s.revision,'head',s.stream_kind,s.stream_key,s.source_sha256,NULL,NULL,NULL,NULL,s.payload_bytes,s.transport_sha256
 FROM release_seoul_preparation_stage s JOIN release_seoul_prepared_sources p ON ${preparedExact('p', 's')} WHERE s.token=? AND s.eligible=1`);
  add(`INSERT INTO release_seoul_projection_deliveries(event_id)
 SELECT s.event_id FROM release_seoul_preparation_stage s ${pairJoin('s')} WHERE s.token=? AND s.eligible=1`);
  add(`UPDATE release_seoul_authority_heads AS h SET payload_sha256=(SELECT s.source_sha256 FROM release_seoul_preparation_stage s WHERE s.token=? AND s.eligible=1)
 WHERE h.payload_sha256 IS NULL AND EXISTS(SELECT 1 FROM release_seoul_preparation_stage s ${pairJoin('s')} ${deliveryJoin('s')}
  WHERE s.token=? AND s.eligible=1 AND ${headKey('h', 's')} AND h.revision=s.revision AND h.event_id=s.event_id)`, [token, token]);
  add(`UPDATE release_seoul_preparation_stage AS s SET complete_guard=CASE WHEN s.eligible=0 THEN 1
 WHEN EXISTS(SELECT 1 FROM release_seoul_authority_changes c ${pairJoin('s')} ${deliveryJoin('s')}
  WHERE ${sourceExact('c', 's')} AND EXISTS(SELECT 1 FROM release_seoul_authority_heads h WHERE ${headKey('h', 's')}
   AND ((${currentComplete('h', 's')}) OR h.revision>s.revision))) THEN 1 ELSE 0 END WHERE s.token=?`);
  add('DELETE FROM release_seoul_preparation_stage WHERE token=?');
  return result;
}
function bounded(request: Plan[]): boolean {
  // Parent's conservative SQL/value request policy, not the Durable adapter's
  // 4 MiB limit. The reserve exceeds the bounded adapter identity/envelope.
  return request.length <= 100 && request.every(s => s.values.length <= 100 && utf8.encode(s.sql).length <= 100_000)
    && utf8.encode(JSON.stringify({ statements: request })).length + 4096 <= 1024 * 1024;
}
function ownFlags(value: unknown): Flags {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw Error();
  const keys = Reflect.ownKeys(value); if (keys.length !== flagNames.length || keys.some(key => typeof key !== 'string' || !flagNames.includes(key as typeof flagNames[number]))) throw Error();
  const flags = Object.create(null) as Flags;
  for (const key of flagNames) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d) || (d.value !== 0 && d.value !== 1) || Object.is(d.value, -0)) throw Error(); flags[key] = d.value;
  }
  return flags;
}
function classify(f: Flags): Observation {
  if (f.stage_present) return 'staging_retained';
  if (!f.source_present || !f.source_exact) return 'source_mismatch';
  // Contradictory adapter observations must not be mistaken for conflicts or
  // completion. One reconciliation SELECT supplies a single DB observation.
  if ((f.prepared_exact && !f.prepared_present) || (f.event_exact && !f.event_present)
    || f.head_complete + f.head_newer + f.head_pending > 1) return 'preparation_uncertain';
  if ((f.prepared_present && !f.prepared_exact) || (f.event_present && !f.event_exact)) return 'prepared_identity_conflict';
  if (f.prepared_exact && f.event_exact) return f.delivery_present && (f.head_complete || f.head_newer) ? 'complete' : 'inconsistent_preparation';
  if (f.prepared_present || f.event_present || f.delivery_present) return 'preparation_uncertain';
  return f.head_pending || f.head_newer ? 'absent' : 'inconsistent_preparation';
}
async function observe(database: Database, candidate: SeoulHeadCandidate): Promise<Observation> {
  try { return classify(ownFlags(await database.withSession('first-primary').prepare(RECONCILE_SQL).bind(...values(candidate)).first())); }
  catch { return 'preparation_uncertain'; }
}
function completed(c: SeoulHeadCandidate, status: 'prepared' | 'already_prepared'): SeoulPreparationResult {
  return { status, revision: c.rowGuard.revision, eventId: c.rowGuard.event_id, sourceChangeSha256: c.sourceChangeSha256, transportPayloadSha256: c.transportPayloadSha256 };
}

/** Explicit trusted same-database atomic composition only. The adapter label
 * is an assertion by the caller, not proof that arbitrary code is native D1
 * or uses the reviewed Durable client -> transactionSync engine. No factory
 * is wired into runtime, routes or background work by this inactive module. */
export function createSeoulProjectionPreparer(database: Database, adapter: 'native-d1' | 'durable-sql'): SeoulProjectionPreparer {
  if (!database || typeof database.prepare !== 'function' || typeof database.batch !== 'function' || typeof database.withSession !== 'function'
    || (adapter !== 'native-d1' && adapter !== 'durable-sql')) throw new Error('seoul_preparer_adapter_unsupported');
  return Object.freeze({ async prepare(revision: unknown): Promise<SeoulPreparationResult> {
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || Object.is(revision, -0) || revision < 1) return { status: 'invalid_revision' };
    let row: unknown;
    try { row = await database.withSession('first-primary').prepare(SOURCE_SQL).bind(revision).first(); }
    catch { return { status: 'preparation_uncertain' }; }
    if (row === null) return { status: 'source_missing' };
    // Do not invoke a returned row's getter to compare the requested revision.
    try { const d = row && typeof row === 'object' ? Object.getOwnPropertyDescriptor(row, 'revision') : undefined;
      if (!d || !('value' in d) || d.value !== revision) return { status: 'source_mismatch' };
    } catch { return { status: 'source_mismatch' }; }
    let candidate: SeoulHeadCandidate;
    try { candidate = await prepareSeoulHeadCandidate(row); }
    catch (error) { return { status: error instanceof Error && error.message === 'seoul_authority_source_contract_unsupported' ? 'source_contract_unsupported' : 'source_invalid' }; }
    if (candidate.rowGuard.revision !== revision) return { status: 'source_mismatch' };
    const before = await observe(database, candidate);
    if (before === 'complete') return completed(candidate, 'already_prepared');
    if (before !== 'absent') return { status: before };
    let request: Plan[];
    try { request = plans(candidate); if (!bounded(request)) return { status: 'request_limit' }; }
    catch { return { status: 'preparation_uncertain' }; }
    try { await database.batch(request.map(s => database.prepare(s.sql).bind(...s.values))); }
    catch { /* ACK loss, rollback and a losing comparison require readback. */ }
    const after = await observe(database, candidate);
    if (after === 'complete') return completed(candidate, 'prepared');
    return { status: after === 'absent' ? 'preparation_absent' : after };
  } });
}

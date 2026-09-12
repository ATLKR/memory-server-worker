import type { Hono } from 'hono';
import type { ConnectionOptions, PostgresTarget } from '../connection.ts';
import type { ExpectedPostgresDeployment } from '../deployment.ts';
import { createSeoulApp } from './app.ts';
import { createSeoulRepository } from './repository.ts';
import { SeoulRepositoryError } from './types.ts';
import type { SeoulRepository } from './types.ts';

export interface SeoulWorkerEnv {
  MEMORY_SEOUL_ENABLED?: 'true' | 'false';
  MEMORY_SEOUL_TARGET_JSON?: string;
  MEMORY_SEOUL_RUNTIME_PASSWORD?: string;
  MEMORY_SEOUL_TLS_CA?: string;
  PRODUCT_NAME?: string;
}

type SeoulWorkerTestOptions = Readonly<{ clientFactory?: ConnectionOptions['clientFactory'] }>;
type Scalar = Readonly<{ present: boolean; valid: boolean; value?: string }>;

const applicationSchemas = Object.freeze([
  'memory_control', 'memory_identity', 'memory_content', 'memory_search', 'memory_jobs', 'memory_ops',
]);
const targetKeys = Object.freeze([
  'connectionMode', 'database', 'deploymentId', 'expectedRole', 'host', 'port', 'user',
]);
const encoder = new TextEncoder();

function ownScalar(source: object, key: string): Scalar {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return { present: false, valid: true };
  if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string'))
    return { present: true, valid: false };
  return { present: true, valid: true, value: descriptor.value };
}

function unavailableApp(): Hono {
  const fail = async (): Promise<never> => { throw new SeoulRepositoryError('seoul_unavailable'); };
  const repository: SeoulRepository = Object.freeze({
    probe: fail, preauthenticatePat: fail, ingest: fail, search: fail,
    assertDisclosure() { throw new SeoulRepositoryError('seoul_unavailable'); },
  });
  return createSeoulApp({ repository, enabled: false });
}

function parseTarget(value: string, password: string, ca: string | undefined): {
  target: PostgresTarget; expected: ExpectedPostgresDeployment;
} {
  if (!value || value.includes('\0') || encoder.encode(value).length > 8192) throw new Error('seoul_unavailable');
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype
    || Reflect.ownKeys(parsed).some(key => typeof key !== 'string')
    || Object.keys(parsed).sort().join(',') !== targetKeys.join(',')) throw new Error('seoul_unavailable');
  const input = parsed as Record<string, unknown>;
  if (typeof input.host !== 'string' || typeof input.port !== 'number' || typeof input.database !== 'string'
    || typeof input.user !== 'string' || typeof input.expectedRole !== 'string' || typeof input.deploymentId !== 'string'
    || !['direct', 'session-pooler'].includes(String(input.connectionMode))) throw new Error('seoul_unavailable');
  const target: PostgresTarget = {
    provider: 'supabase', region: 'kr-seoul', host: input.host, port: input.port, database: input.database,
    user: input.user, password, expectedRole: input.expectedRole, deploymentId: input.deploymentId,
    applicationSchemas, connectionMode: input.connectionMode as 'direct' | 'session-pooler',
    ssl: { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) },
  };
  const expected: ExpectedPostgresDeployment = Object.freeze({
    region: 'kr-seoul', deploymentId: input.deploymentId,
    processingPolicyId: 'kr-primary-storage-v1', schemaVersion: 5,
  });
  return { target, expected };
}

/** Standalone Seoul composition. Only trusted own scalar bindings are read; all
 * deployment policy and schema values remain fixed in this module. */
export function createSeoulWorkerApp(env: SeoulWorkerEnv, testOptions?: SeoulWorkerTestOptions): Hono {
  try {
    if (!env || typeof env !== 'object') return unavailableApp();
    const enabled = ownScalar(env, 'MEMORY_SEOUL_ENABLED');
    if (!enabled.valid || enabled.value !== 'true') return unavailableApp();

    const targetJson = ownScalar(env, 'MEMORY_SEOUL_TARGET_JSON');
    const password = ownScalar(env, 'MEMORY_SEOUL_RUNTIME_PASSWORD');
    const tlsCa = ownScalar(env, 'MEMORY_SEOUL_TLS_CA');
    const productName = ownScalar(env, 'PRODUCT_NAME');
    if (!targetJson.valid || !password.valid || !tlsCa.valid || !productName.valid
      || typeof targetJson.value !== 'string' || typeof password.value !== 'string'
      || !password.value || password.value.includes('\0') || encoder.encode(password.value).length > 4096
      || (tlsCa.value !== undefined && (!tlsCa.value || tlsCa.value.includes('\0') || encoder.encode(tlsCa.value).length > 65536))
      || (productName.value !== undefined && (!productName.value.trim()
        || encoder.encode(productName.value).length > 128 || /[\u0000-\u001f\u007f]/u.test(productName.value)))) return unavailableApp();

    let clientFactory: ConnectionOptions['clientFactory'];
    if (testOptions !== undefined) {
      if (!testOptions || typeof testOptions !== 'object') return unavailableApp();
      const descriptor = Object.getOwnPropertyDescriptor(testOptions, 'clientFactory');
      if (descriptor && (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'function')))
        return unavailableApp();
      clientFactory = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    }
    const { target, expected } = parseTarget(targetJson.value, password.value, tlsCa.value);
    const repository = createSeoulRepository(target, expected, { clientFactory });
    return createSeoulApp({ repository, enabled: true, title: productName.value ?? 'Memory', timeoutMs: 30000 });
  } catch {
    return unavailableApp();
  }
}

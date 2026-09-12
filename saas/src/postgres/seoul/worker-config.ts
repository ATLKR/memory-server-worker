import type { Hono } from 'hono';
import type { ConnectionOptions, PostgresTarget } from '../connection.ts';
import type { ExpectedPostgresDeployment } from '../deployment.ts';
import { createSeoulApp } from './app.ts';
import { createSeoulRepository } from './repository.ts';
import { SeoulRepositoryError } from './types.ts';
import type { SeoulRepository } from './types.ts';

export interface SeoulWorkerEnv {
  MEMORY_SEOUL_ENABLED?: 'true' | 'false';
  MEMORY_SEOUL_TRANSPORT?: 'native' | 'hyperdrive';
  MEMORY_SEOUL_TARGET_JSON?: string;
  MEMORY_SEOUL_RUNTIME_PASSWORD?: string;
  MEMORY_SEOUL_TLS_CA?: string;
  SEOUL_HYPERDRIVE?: Hyperdrive;
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
const hyperdriveTargetKeys = Object.freeze(['database', 'deploymentId', 'expectedRole']);
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

function parseTargetJson(value: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || value.includes('\0') || encoder.encode(value).length > 8192) throw new Error('seoul_unavailable');
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype
    || Reflect.ownKeys(parsed).some(key => typeof key !== 'string')
    || Object.keys(parsed).sort().join(',') !== keys.join(',')) throw new Error('seoul_unavailable');
  return parsed as Record<string, unknown>;
}

function expectedDeployment(deploymentId: string): ExpectedPostgresDeployment {
  return Object.freeze({region: 'kr-seoul', deploymentId, processingPolicyId: 'kr-primary-storage-v1', schemaVersion: 5});
}

function parseTarget(value: string, password: string, ca: string | undefined): {
  target: PostgresTarget; expected: ExpectedPostgresDeployment;
} {
  const input = parseTargetJson(value, targetKeys);
  if (typeof input.host !== 'string' || typeof input.port !== 'number' || typeof input.database !== 'string'
    || typeof input.user !== 'string' || typeof input.expectedRole !== 'string' || typeof input.deploymentId !== 'string'
    || !['direct', 'session-pooler'].includes(String(input.connectionMode))) throw new Error('seoul_unavailable');
  const target: PostgresTarget = {
    transport: 'native', provider: 'supabase', region: 'kr-seoul', host: input.host, port: input.port, database: input.database,
    user: input.user, password, expectedRole: input.expectedRole, deploymentId: input.deploymentId,
    applicationSchemas, connectionMode: input.connectionMode as 'direct' | 'session-pooler',
    ssl: { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) },
  };
  return { target, expected: expectedDeployment(input.deploymentId) };
}

function parseHyperdriveTarget(value: string, env: SeoulWorkerEnv): {
  target: PostgresTarget; expected: ExpectedPostgresDeployment;
} {
  const input = parseTargetJson(value, hyperdriveTargetKeys);
  if (typeof input.database !== 'string' || typeof input.expectedRole !== 'string' || typeof input.deploymentId !== 'string')
    throw new Error('seoul_unavailable');
  const descriptor = Object.getOwnPropertyDescriptor(env, 'SEOUL_HYPERDRIVE');
  if (!descriptor || !('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object')
    throw new Error('seoul_unavailable');
  // Runtime Hyperdrive bindings have a native prototype and an additional ip
  // field. Snapshot only the documented six own primitive connection fields.
  const snapshot: Record<string, string | number> = {};
  for (const key of ['connectionString', 'host', 'port', 'user', 'password', 'database']) {
    const field = Object.getOwnPropertyDescriptor(descriptor.value, key);
    if (!field || !('value' in field) || typeof field.value !== (key === 'port' ? 'number' : 'string'))
      throw new Error('seoul_unavailable');
    snapshot[key] = field.value;
  }
  const hyperdrive = Object.freeze({connectionString: snapshot.connectionString as string, host: snapshot.host as string,
    port: snapshot.port as number, user: snapshot.user as string, password: snapshot.password as string, database: snapshot.database as string});
  return {target: {transport: 'hyperdrive', provider: 'supabase', region: 'kr-seoul', database: input.database,
    expectedRole: input.expectedRole, deploymentId: input.deploymentId, applicationSchemas, hyperdrive},
    expected: expectedDeployment(input.deploymentId)};
}

/** Standalone Seoul composition. Trusted own scalar and Hyperdrive bindings are read; all
 * deployment policy and schema values remain fixed in this module. */
export function createSeoulWorkerApp(env: SeoulWorkerEnv, testOptions?: SeoulWorkerTestOptions): Hono {
  try {
    if (!env || typeof env !== 'object') return unavailableApp();
    const enabled = ownScalar(env, 'MEMORY_SEOUL_ENABLED');
    if (!enabled.valid || enabled.value !== 'true') return unavailableApp();

    const targetJson = ownScalar(env, 'MEMORY_SEOUL_TARGET_JSON');
    const transport = ownScalar(env, 'MEMORY_SEOUL_TRANSPORT');
    const productName = ownScalar(env, 'PRODUCT_NAME');
    if (!targetJson.valid || !transport.valid || !productName.valid || typeof targetJson.value !== 'string'
      || (transport.value !== undefined && !['native', 'hyperdrive'].includes(transport.value))
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
    let configuration: {target: PostgresTarget; expected: ExpectedPostgresDeployment};
    if (transport.value === 'hyperdrive') {
      // Origin credentials and TLS belong to the provider Hyperdrive config.
      // Reject mixed transports without evaluating irrelevant binding accessors.
      if (Object.getOwnPropertyDescriptor(env, 'MEMORY_SEOUL_RUNTIME_PASSWORD')
        || Object.getOwnPropertyDescriptor(env, 'MEMORY_SEOUL_TLS_CA')) return unavailableApp();
      configuration = parseHyperdriveTarget(targetJson.value, env);
    } else {
      if (Object.getOwnPropertyDescriptor(env, 'SEOUL_HYPERDRIVE')) return unavailableApp();
      const password = ownScalar(env, 'MEMORY_SEOUL_RUNTIME_PASSWORD');
      const tlsCa = ownScalar(env, 'MEMORY_SEOUL_TLS_CA');
      if (!password.valid || !tlsCa.valid || typeof password.value !== 'string'
        || !password.value || password.value.includes('\0') || encoder.encode(password.value).length > 4096
        || (tlsCa.value !== undefined && (!tlsCa.value || tlsCa.value.includes('\0') || encoder.encode(tlsCa.value).length > 65536)))
        return unavailableApp();
      configuration = parseTarget(targetJson.value, password.value, tlsCa.value);
    }
    const {target, expected} = configuration;
    const repository = createSeoulRepository(target, expected, { clientFactory });
    return createSeoulApp({ repository, enabled: true, title: productName.value ?? 'Memory', timeoutMs: 30000 });
  } catch {
    return unavailableApp();
  }
}

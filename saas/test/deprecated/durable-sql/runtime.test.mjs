import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReleaseEnv } from '../../../src/deprecated-durable-sql/runtime.ts';
import { inspectStorage } from '../../../src/release/storage-readiness.ts';
import worker from '../../../src/release/worker.ts';

const mapping = { DB: { databaseId: 'authority', kind: 'control' }, HOT_A: { databaseId: 'payload-a', kind: 'hot' }, HOT_B: { databaseId: 'payload-b', kind: 'hot' } };
const shards = [{ id: 'a', binding: 'HOT_A', mode: 'active' }, { id: 'b', binding: 'HOT_B', mode: 'draining' }];
function configured(overrides = {}) {
  const named = [], executions = [], reads = [];
  const env = {
    MEMORY_SQL_BACKEND: 'durable', MEMORY_SQL_DEPLOYMENT_ID: 'synthetic-stage', MEMORY_SQL_EPOCH: '2',
    MEMORY_SQL_DATABASES_JSON: JSON.stringify(mapping),
    STORAGE_MODE: 'sharded', STORAGE_SHARDS_JSON: JSON.stringify(shards),
    MEMORY_PAYLOADS: { async head(key) { reads.push(key); return null; }, async get() { return null; }, async put() { return null; } },
    REQUEST_LIMITER: { async limit() { return { success: true }; } },
    MEMORY_SQL: { getByName(name) { named.push(name); return { async execute(input) {
      executions.push({ name, input });
      return input.statements.map(statement => statement.mode === 'run'
        ? { success: true, results: [], meta: { changes: 0 } }
        : { success: true, results: statement.sql.includes('payload_meta') ? [{ version: 1 }] : [{ ready: 1 }], meta: { changes: 0 } });
    } }; } },
    ...overrides,
  };
  let d1Reads = 0;
  for (const binding of ['DB', 'HOT_A', 'HOT_B']) Object.defineProperty(env, binding, { enumerable: true, get() { d1Reads++; throw Error('D1 binding must never be read'); } });
  return { env, named, executions, reads, d1Reads: () => d1Reads };
}

test('durable selection never reads D1 getters and pins one adapter per binding per invocation', async () => {
  const f = configured(), env = resolveReleaseEnv(f.env);
  assert.equal(f.d1Reads(), 0); assert.notEqual(env, f.env);
  assert.equal(env.DB, env.DB); assert.notEqual(env.HOT_A, env.HOT_B); assert.notEqual(env.DB, env.HOT_A);
  assert.deepEqual(f.named, ['sql:synthetic-stage:authority:2', 'sql:synthetic-stage:payload-a:2', 'sql:synthetic-stage:payload-b:2']);
  assert.equal(env.MEMORY_PAYLOADS, f.env.MEMORY_PAYLOADS); assert.equal(env.REQUEST_LIMITER, f.env.REQUEST_LIMITER);
  await env.DB.withSession('first-primary').prepare('SELECT 1 AS ready').first();
  await env.HOT_A.prepare('SELECT max(version) AS version FROM payload_meta').first();
  assert.deepEqual(f.executions.map(({ input }) => input.identity), [
    { deploymentId: 'synthetic-stage', databaseId: 'authority', kind: 'control', epoch: 2 },
    { deploymentId: 'synthetic-stage', databaseId: 'payload-a', kind: 'hot', epoch: 2 },
  ]);
  assert.equal(f.d1Reads(), 0);
  assert.notEqual(resolveReleaseEnv(f.env).DB, env.DB);
});

test('inline durable deployment needs only its control object and no D1 binding', () => {
  const f = configured({ STORAGE_MODE: 'inline', STORAGE_SHARDS_JSON: undefined, MEMORY_SQL_DATABASES_JSON: JSON.stringify({ DB: mapping.DB }) });
  const env = resolveReleaseEnv(f.env);
  assert.equal(typeof env.DB.prepare, 'function'); assert.equal(f.d1Reads(), 0);
  assert.deepEqual(f.named, ['sql:synthetic-stage:authority:2']);
});

test('default and explicit D1 preserve the original bindings, permitting an unserved durable namespace only', () => {
  const DB = { prepare() {}, batch() {}, withSession() {} };
  for (const MEMORY_SQL_BACKEND of [undefined, 'd1']) {
    const env = { DB, MEMORY_SQL_BACKEND, MEMORY_SQL: { getByName() { throw Error('must not select durable'); } } };
    assert.equal(resolveReleaseEnv(env), env);
  }
});

for (const key of ['MEMORY_SQL_DEPLOYMENT_ID', 'MEMORY_SQL_EPOCH', 'MEMORY_SQL_DATABASES_JSON'])
  test('D1 rejects ambiguous durable variable ' + key, () => {
    assert.throws(() => resolveReleaseEnv({ DB: {}, MEMORY_SQL_BACKEND: 'd1', [key]: '' }), /memory_sql_configuration_invalid/);
  });

for (const [label, overrides] of [
  ['unknown backend', { MEMORY_SQL_BACKEND: 'postgres' }],
  ['missing namespace', { MEMORY_SQL: undefined }],
  ['invalid namespace', { MEMORY_SQL: {} }],
  ['missing deployment', { MEMORY_SQL_DEPLOYMENT_ID: undefined }],
  ['ambiguous deployment', { MEMORY_SQL_DEPLOYMENT_ID: 'synthetic:stage' }],
  ['oversized deployment', { MEMORY_SQL_DEPLOYMENT_ID: 'a'.repeat(65) }],
  ...['0', '01', '-1', '1.0', '1e2', ' 1', '1 ', '9007199254740992', '', undefined, 1].map(value => ['invalid epoch ' + String(value), { MEMORY_SQL_EPOCH: value }]),
  ['missing mapping', { MEMORY_SQL_DATABASES_JSON: undefined }],
  ['malformed mapping', { MEMORY_SQL_DATABASES_JSON: '{' }],
  ['array mapping', { MEMORY_SQL_DATABASES_JSON: '[]' }],
  ['missing control', { MEMORY_SQL_DATABASES_JSON: JSON.stringify({ HOT_A: mapping.HOT_A, HOT_B: mapping.HOT_B }) }],
  ['missing hot', { MEMORY_SQL_DATABASES_JSON: JSON.stringify({ DB: mapping.DB, HOT_A: mapping.HOT_A }) }],
  ['extra binding', { MEMORY_SQL_DATABASES_JSON: JSON.stringify({ ...mapping, EXTRA: { databaseId: 'extra', kind: 'hot' } }) }],
  ['duplicate identity', { MEMORY_SQL_DATABASES_JSON: JSON.stringify({ ...mapping, HOT_B: mapping.HOT_A }) }],
  ['cross-kind control', { MEMORY_SQL_DATABASES_JSON: JSON.stringify({ ...mapping, DB: { databaseId: 'authority', kind: 'hot' } }) }],
  ['cross-kind hot', { MEMORY_SQL_DATABASES_JSON: JSON.stringify({ ...mapping, HOT_A: { databaseId: 'payload-a', kind: 'control' } }) }],
  ['extra identity property', { MEMORY_SQL_DATABASES_JSON: JSON.stringify({ ...mapping, DB: { ...mapping.DB, epoch: 3 } }) }],
  ['ambiguous database id', { MEMORY_SQL_DATABASES_JSON: JSON.stringify({ ...mapping, DB: { databaseId: 'bad:id', kind: 'control' } }) }],
  ['reserved control binding as a hot alias', { STORAGE_SHARDS_JSON: JSON.stringify([{ ...shards[0], binding: 'MEMORY_SQL' }, shards[1]]),
    MEMORY_SQL_DATABASES_JSON: JSON.stringify({ DB: mapping.DB, MEMORY_SQL: mapping.HOT_A, HOT_B: mapping.HOT_B }) }],
  ['invalid shard registry', { STORAGE_SHARDS_JSON: '{}' }],
  ['duplicate shard binding', { STORAGE_SHARDS_JSON: JSON.stringify([shards[0], { ...shards[1], binding: 'HOT_A' }]) }],
  ['duplicate shard id', { STORAGE_SHARDS_JSON: JSON.stringify([shards[0], { ...shards[1], id: 'a' }]) }],
  ['missing sharded registry', { STORAGE_SHARDS_JSON: undefined }],
  ['no active shard', { STORAGE_SHARDS_JSON: JSON.stringify(shards.map(s => ({ ...s, mode: 'draining' }))) }],
]) test('invalid durable configuration fails before namespace or D1 access: ' + label, () => {
  const f = configured(overrides);
  assert.throws(() => resolveReleaseEnv(f.env), /memory_sql_configuration_invalid/);
  assert.equal(f.d1Reads(), 0); assert.deepEqual(f.named, []);
});

test('durable storage readiness probes the control and both real hot adapters', async () => {
  const f = configured(), env = resolveReleaseEnv(f.env);
  assert.equal((await inspectStorage(env)).ready, true);
  assert.deepEqual(new Set(f.executions.map(e => e.input.identity.kind)), new Set(['control', 'hot']));
  assert.equal(f.executions.length, 3); assert.deepEqual(f.reads, ['_health/provider-probe']); assert.equal(f.d1Reads(), 0);
});

test('unready control object or mismatched hot object fails storage readiness without D1 fallback', async () => {
  for (const failedDatabase of ['authority', 'payload-a']) {
    const f = configured(); f.env.MEMORY_SQL.getByName = name => ({ async execute(input) {
      if (input.identity.databaseId === failedDatabase) throw Error('durable_sql_not_ready');
      return input.statements.map(() => ({ success: true, results: [{ ready: 1, version: 1 }], meta: { changes: 0 } }));
    } });
    assert.equal((await inspectStorage(resolveReleaseEnv(f.env))).ready, false); assert.equal(f.d1Reads(), 0);
  }
});

test('both HTTP and scheduled reject missing durable namespace and never fall back to D1', async () => {
  const f = configured({ MEMORY_SQL: undefined });
  const response = await worker.fetch(new Request('https://memory.allenlabs.org/health'), f.env);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  await assert.rejects(() => worker.scheduled({}, f.env), /memory_sql_configuration_invalid/);
  assert.equal(f.d1Reads(), 0);
});

test('Hono entry preserves 405 and Allow while HTTP HEAD has no response body', async () => {
  const f = configured();
  for (const method of ['POST', 'HEAD']) {
    const response = await worker.fetch(new Request('https://memory.allenlabs.org/health', { method }), f.env);
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (method === 'HEAD') assert.equal(await response.text(), '');
  }
  assert.equal(f.d1Reads(), 0);
});

test('Hono normalizes non-Error configuration throws and still records sanitized failure telemetry', async () => {
  const f = configured(), points = [];
  f.env.METRICS = { writeDataPoint(point) { points.push(point); } };
  f.env.MEMORY_SQL.getByName = () => { throw 'synthetic private provider detail'; };
  const response = await worker.fetch(new Request('https://memory.allenlabs.org/health'), f.env);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  assert.deepEqual(points.map(point => point.blobs), [['public', 'GET', '503']]);
  assert.equal(f.d1Reads(), 0);
});

test('maintenance rejects every HTTP route before SQL binding resolution or request-body consumption', async () => {
  const f = configured({ MEMORY_SQL_MAINTENANCE: 'true' });
  let namespaceReads = 0;
  Object.defineProperty(f.env, 'MEMORY_SQL', { get() { namespaceReads++; throw Error('namespace accessed during maintenance'); } });
  for (const path of ['/health', '/ready', '/auth/login', '/auth/callback', '/mcp', '/v1/spaces/s1/memories', '/webhooks/identity']) {
    const request = new Request('https://memory.allenlabs.org' + path, { method: 'POST', body: 'synthetic body must remain unread' });
    const response = await worker.fetch(request, f.env);
    assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'service_unavailable' }); assert.equal(request.bodyUsed, false);
  }
  await worker.scheduled({}, f.env);
  assert.equal(f.d1Reads(), 0); assert.equal(namespaceReads, 0); assert.deepEqual(f.executions, []);
});

test('maintenance health exposes only compiled build metadata without touching storage',async()=>{
 let reads=0;
 const bindings={MEMORY_SQL_MAINTENANCE:'true',BUILD_REVISION:'untrusted runtime override',BUILD_FINGERPRINT:'untrusted runtime override'};
 for(const name of ['DB','MEMORY_SQL','REQUEST_LIMITER'])Object.defineProperty(bindings,name,{get(){reads++;throw Error('must not access');}});
 const response=await worker.fetch(new Request('https://memory.allenlabs.org/health'),bindings);
 assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'60');assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(await response.json(),{error:'service_unavailable',build:{sourceRevision:'unreleased',resourceFingerprint:'',payloadFormat:2}});
 assert.equal(reads,0);
});

for (const value of ['', 'TRUE', 'yes', '0', true, null])
  test('invalid maintenance setting fails closed before SQL selection: ' + String(value), async () => {
    const f = configured({ MEMORY_SQL_MAINTENANCE: value });
    const response = await worker.fetch(new Request('https://memory.allenlabs.org/health'), f.env);
    assert.equal(response.status, 503);
    await assert.rejects(() => worker.scheduled({}, f.env), /memory_sql_maintenance_configuration_invalid/);
    assert.equal(f.d1Reads(), 0); assert.deepEqual(f.named, []); assert.deepEqual(f.executions, []);
  });

test('explicit false maintenance setting keeps normal HTTP and scheduled work active', async () => {
  const f = configured({ MEMORY_SQL_MAINTENANCE: 'false' });
  const response = await worker.fetch(new Request('https://memory.allenlabs.org/health'), f.env);
  assert.equal(response.status, 200); assert.equal(response.headers.get('retry-after'), null);
  // Scheduled work reaches real SQL resolution rather than the maintenance
  // short-circuit; the canned namespace above cannot answer payload queries.
  await assert.rejects(() => worker.scheduled({}, f.env), /invalid_object/);
  assert.ok(f.executions.length > 0); assert.equal(f.d1Reads(), 0);
});

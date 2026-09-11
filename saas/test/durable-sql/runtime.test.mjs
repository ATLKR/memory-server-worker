import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReleaseEnv } from '../../src/durable-sql/runtime.ts';
import { inspectStorage } from '../../src/release/storage-readiness.ts';
import worker from '../../src/release/worker.ts';
import { fixture } from '../../release-validation/tests/db.mjs';
import { AUTH_ISSUER } from '../../src/config.ts';
import { hmac } from '../../src/release/util.ts';

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
      return input.statements.map(statement => ({ success: true, results: statement.sql.includes('payload_meta') ? [{ version: 1 }] : [{ ready: 1 }], meta: { changes: 0 } }));
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

async function applicationFixture(t) {
  const f = configured({ STORAGE_MODE: 'inline', STORAGE_SHARDS_JSON: undefined, MEMORY_SQL_DATABASES_JSON: JSON.stringify({ DB: mapping.DB }) });
  // Exercise a real raw deployment shape with no D1 bindings at all. Separate
  // selector tests above use throwing getters to detect any attempted access.
  const descriptors = Object.getOwnPropertyDescriptors(f.env);
  for (const binding of ['DB', 'HOT_A', 'HOT_B']) delete descriptors[binding];
  f.env = Object.defineProperties({}, descriptors);
  const original = await fixture({ clock: Date.now }); t.after(() => original.db.close());
  f.env.MEMORY_SQL.getByName = name => { f.named.push(name); return { async execute(input) {
    f.executions.push({ name, input });
    original.db.raw.exec('BEGIN IMMEDIATE');
    try {
      const results = input.statements.map(({ sql, values, mode }) => {
        const statement = original.db.raw.prepare(sql);
        if (mode === 'run') { const result = statement.run(...values); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
        const rows = statement.all(...values);
        return { success: true, results: mode === 'first' ? rows.slice(0, 1) : rows, meta: { changes: 0 } };
      });
      original.db.raw.exec('COMMIT'); return results;
    } catch (error) { original.db.raw.exec('ROLLBACK'); throw error; }
  } }; };
  // The shared fixture has deterministic credential times; use current time for
  // this invocation-level test so normal request authentication remains valid.
  original.db.raw.prepare('UPDATE credentials SET expires_at=?, reauthenticated_at=?').run(Date.now() + 60000, Date.now());
  return { ...f, original };
}

test('HTTP serves authenticated actual app requests through durable SQL with zero D1 access', async t => {
  const f = await applicationFixture(t);
  assert.equal(Object.hasOwn(f.env, 'DB'), false);
  const response = await worker.fetch(new Request('https://memory.allenlabs.org/v1/spaces', { headers: { authorization: 'Bearer ' + f.original.key } }), f.env);
  assert.equal(response.status, 200); assert.ok((await response.json()).results.some(space => space.id === 's1'));
  assert.ok(f.executions.length > 0); assert.equal(f.d1Reads(), 0); assert.equal(f.named.length, 1);
});

test('scheduled maintenance and heartbeat use the same durable selector without D1 access', async t => {
  const f = await applicationFixture(t);
  assert.equal(Object.hasOwn(f.env, 'DB'), false);
  await worker.scheduled({}, f.env);
  assert.ok(f.original.db.raw.prepare("SELECT last_success_at FROM release_heartbeats WHERE name='maintenance'").get().last_success_at > 0);
  assert.ok(f.executions.length > 0); assert.equal(f.d1Reads(), 0); assert.equal(f.named.length, 1);
});

test('both HTTP and scheduled reject missing durable namespace and never fall back to D1', async () => {
  const f = configured({ MEMORY_SQL: undefined });
  const response = await worker.fetch(new Request('https://memory.allenlabs.org/health'), f.env);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  await assert.rejects(() => worker.scheduled({}, f.env), /memory_sql_configuration_invalid/);
  assert.equal(f.d1Reads(), 0);
});

test('Hono entry preserves signed webhook bytes, application receipt and exact response headers', async t => {
  const f = await applicationFixture(t), secret = 'synthetic-signature-key-'.repeat(3);
  f.env.IDENTITY_WEBHOOK_SECRET = secret;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({ id: 'hono-raw-webhook', issuer: AUTH_ISSUER, subject: 'synthetic-disabled-subject', type: 'account.disabled', description: '본문 서명 유지\nwith whitespace' }, null, 2);
  const signature = await hmac(secret, timestamp + '.' + raw);
  const response = await worker.fetch(new Request('https://memory.allenlabs.org/webhooks/identity', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-memory-timestamp': timestamp, 'x-memory-signature': signature }, body: raw }), f.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.ok(response.headers.get('x-request-id'));
  assert.equal(f.original.db.raw.prepare("SELECT count(*) AS n FROM release_webhook_events WHERE event_id='hono-raw-webhook'").get().n, 1);
  assert.equal(f.d1Reads(), 0);
});

test('Hono entry preserves authenticated MCP JSON-RPC responses and Origin denial', async t => {
  const f = await applicationFixture(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'memory_spaces', arguments: {} } });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + f.original.key };
  const response = await worker.fetch(new Request('https://memory.allenlabs.org/mcp', { method: 'POST', headers, body }), f.env);
  assert.equal(response.status, 200);
  const raw = await response.text();
  const reply = JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? raw.split('\n').find(line => line.startsWith('data: ')).slice(6) : raw);
  assert.equal(reply.jsonrpc, '2.0'); assert.equal(reply.id, 9); assert.equal(reply.result.isError, false);
  assert.ok(reply.result.content.some(item => item.text.includes('s1')));
  const denied = await worker.fetch(new Request('https://memory.allenlabs.org/mcp', { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' }, body }), f.env);
  assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'origin_denied' });
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

test('Hono request context isolates concurrent environments and records one sanitized metric each', async t => {
  const first = await applicationFixture(t), second = await applicationFixture(t);
  second.env.MEMORY_SQL_DEPLOYMENT_ID = 'another-stage';
  const firstMetrics = [], secondMetrics = [];
  first.env.METRICS = { writeDataPoint(point) { firstMetrics.push(point); } };
  second.env.METRICS = { writeDataPoint(point) { secondMetrics.push(point); } };
  const responses = await Promise.all([first, second].map(f => worker.fetch(new Request('https://memory.allenlabs.org/v1/spaces', {
    headers: { authorization: 'Bearer ' + f.original.key },
  }), f.env)));
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.ok(first.executions.every(call => call.input.identity.deploymentId === 'synthetic-stage'));
  assert.ok(second.executions.every(call => call.input.identity.deploymentId === 'another-stage'));
  for (const points of [firstMetrics, secondMetrics]) {
    assert.equal(points.length, 1); assert.deepEqual(points[0].blobs, ['memory', 'GET', '200']);
    assert.ok(!JSON.stringify(points).includes(first.original.key));
  }
  assert.equal(first.d1Reads() + second.d1Reads(), 0);
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

test('explicit false maintenance setting keeps normal HTTP and scheduled work active', async t => {
  const f = await applicationFixture(t); f.env.MEMORY_SQL_MAINTENANCE = 'false';
  assert.equal((await worker.fetch(new Request('https://memory.allenlabs.org/v1/spaces', { headers: { authorization: 'Bearer ' + f.original.key } }), f.env)).status, 200);
  await worker.scheduled({}, f.env);
  assert.ok(f.original.db.raw.prepare("SELECT last_success_at FROM release_heartbeats WHERE name='maintenance'").get().last_success_at > 0);
});

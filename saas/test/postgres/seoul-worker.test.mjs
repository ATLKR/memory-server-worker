import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSeoulWorkerApp } from '../../src/postgres/seoul/worker-config.ts';
import worker from '../../src/postgres/seoul/worker.ts';
import { createLifecycleFixture } from './seoul-lifecycle-fixture.mjs';
import { seoulIngest, seoulSearch } from './seoul-fixture.mjs';

const origin = 'https://seoul-worker.example.test';
const projectRef = 'abcdefghijklmnopqrst';
const tlsCa = '-----BEGIN CERTIFICATE-----\nsynthetic-fixture-ca\n-----END CERTIFICATE-----';
const target = overrides => JSON.stringify({
  host: `db.${projectRef}.supabase.co`, port: 5432, database: 'template1',
  user: 'memory_seoul_runtime', expectedRole: 'memory_seoul_runtime',
  deploymentId: 'memory-seoul', connectionMode: 'direct', ...overrides,
});
const enabled = overrides => ({
  MEMORY_SEOUL_ENABLED: 'true', MEMORY_SEOUL_TARGET_JSON: target(),
  MEMORY_SEOUL_RUNTIME_PASSWORD: 'synthetic-runtime-password', ...overrides,
});
const rpcRequest = (token, method, params = {}) => new Request(origin + '/mcp', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'x-memory-routing': '2', 'mcp-protocol-version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'worker:one', method, params }),
});
async function rpc(response) {
  const text = await response.text();
  const line = response.headers.get('content-type')?.startsWith('text/event-stream')
    ? text.split(/\r?\n/).find(value => value.startsWith('data:'))?.slice(5).trim() : text;
  return JSON.parse(line);
}
async function tool(app, token, name, args) {
  const response = await app.fetch(rpcRequest(token, 'tools/call', { name, arguments: args }));
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await rpc(response)).result;
  return { isError: result.isError === true, value: JSON.parse(result.content[0].text) };
}
async function composedFixture(t) {
  const fixture = await createLifecycleFixture(t);
  await fixture.grant();
  const token = 'synthetic-worker-pat-' + 'a'.repeat(48);
  const digest = createHash('sha256').update(token).digest('hex');
  await fixture.asOwner(async db => {
    await db.query(`INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at)
      VALUES('pat:worker','account:a','personal_key',$1,9007199254740991)`, [digest]);
    await db.exec(`INSERT INTO memory_identity.pat_space_grants
      (credential_id,account_id,space_id,can_ingest,can_search,can_erase,can_retire,expires_at)
      VALUES('pat:worker','account:a','space:a',true,true,true,true,9007199254740991)`);
  });
  const initial = (await fixture.db.query('SELECT current_database() AS database, session_user AS role')).rows[0];
  const restore = `SET SESSION AUTHORIZATION "${initial.role.replaceAll('"', '""')}"`;
  const configs = [];
  const clientFactory = config => {
    configs.push(config);
    return {
      async connect() { await fixture.db.exec('SET SESSION AUTHORIZATION memory_seoul_runtime'); },
      async query(query) {
        const value = await fixture.db.query(query.text, query.values);
        return { rows: value.rows, rowCount: value.affectedRows ?? null };
      },
      async end() { await fixture.db.exec(`ROLLBACK; ${restore}`); },
      on() {},
    };
  };
  const env = enabled({ MEMORY_SEOUL_TARGET_JSON: target({
    host: 'aws-0-ap-northeast-2.pooler.supabase.com', database: initial.database,
    user: `memory_seoul_runtime.${projectRef}`, connectionMode: 'session-pooler',
  }), MEMORY_SEOUL_TLS_CA: tlsCa, PRODUCT_NAME: 'Seoul Fixture Memory' });
  const app = createSeoulWorkerApp(env, { clientFactory });
  return { ...fixture, app, configs, env, token, database: initial.database };
}

test('empty or disabled bindings expose only an unready Seoul surface and ignore unrelated accessors', async () => {
  for (const setting of [undefined, 'false']) {
    let reads = 0;
    const env = {};
    if (setting !== undefined) env.MEMORY_SEOUL_ENABLED = setting;
    for (const name of ['MEMORY_SEOUL_RUNTIME_PASSWORD', 'MEMORY_SEOUL_TARGET_JSON', 'MEMORY_SEOUL_TLS_CA',
      'DB', 'MEMORY_SQL', 'MEMORY_INDEX', 'AI', 'postgres']) {
      Object.defineProperty(env, name, { get() { reads++; throw new Error('private binding accessor'); } });
    }
    const app = createSeoulWorkerApp(env);
    const discovery = await app.fetch(new Request(origin + '/.well-known/memory-routing-v2'));
    assert.equal(discovery.status, 200);
    assert.deepEqual(await discovery.json(), { version: 2, protocol: 'memory-routing-v2', target: {
      route: 'seoul', storage: 'postgres', region: 'kr-seoul', ready: false,
      capabilities: { ingest: false, search: { keyword: false, semantic: false } },
    } });
    const response = await app.fetch(new Request(origin + '/mcp', { method: 'POST', headers: { 'x-memory-routing': '2' } }));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'seoul_unavailable' });
    assert.equal(reads, 0);
  }
});

test('malformed enabled configuration fails closed without constructing a client or echoing bindings', async () => {
  const secret = 'SYNTHETIC_CONFIG_MUST_NOT_ECHO'; let clients = 0;
  const cases = [
    { MEMORY_SEOUL_RUNTIME_PASSWORD: undefined }, { MEMORY_SEOUL_RUNTIME_PASSWORD: '' },
    { MEMORY_SEOUL_RUNTIME_PASSWORD: `bad\0${secret}` }, { MEMORY_SEOUL_RUNTIME_PASSWORD: 'x'.repeat(4097) },
    { MEMORY_SEOUL_TARGET_JSON: undefined }, { MEMORY_SEOUL_TARGET_JSON: '' },
    { MEMORY_SEOUL_TARGET_JSON: '{' }, { MEMORY_SEOUL_TARGET_JSON: target({ password: secret }) },
    { MEMORY_SEOUL_TARGET_JSON: target({ connectionMode: 'transaction-pooler' }) },
    { MEMORY_SEOUL_TARGET_JSON: target({ host: 'untrusted.example.test' }) },
  ];
  const accessor = enabled();
  Object.defineProperty(accessor, 'MEMORY_SEOUL_RUNTIME_PASSWORD', { get() { throw new Error(secret); } });
  cases.push(accessor);
  for (const change of cases) {
    const app = createSeoulWorkerApp(change === accessor ? change : enabled(change), {
      clientFactory() { clients++; throw new Error(secret); },
    });
    const discovery = await app.fetch(new Request(origin + '/.well-known/memory-routing-v2'));
    const response = await app.fetch(rpcRequest('x'.repeat(40), 'ping'));
    assert.equal((await discovery.json()).target.ready, false);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(secret));
  }
  assert.equal(clients, 0);
});

test('the composed repository snapshots the exact trusted target and native TLS settings', async t => {
  const f = await composedFixture(t);
  f.env.MEMORY_SEOUL_RUNTIME_PASSWORD = 'mutated-password';
  f.env.MEMORY_SEOUL_TARGET_JSON = target({ host: 'db.zzzzzzzzzzzzzzzzzzzz.supabase.co' });
  f.env.MEMORY_SEOUL_TLS_CA = '-----BEGIN CERTIFICATE-----\nmutated\n-----END CERTIFICATE-----';
  const response = await f.app.fetch(new Request(origin + '/.well-known/memory-routing-v2'));
  assert.equal((await response.json()).target.ready, true);
  assert.equal(f.configs.length, 1);
  const config = f.configs[0];
  assert.deepEqual({ host: config.host, port: config.port, database: config.database, user: config.user,
    password: config.password, ssl: config.ssl, connectionTimeoutMillis: config.connectionTimeoutMillis,
    query_timeout: config.query_timeout, statement_timeout: config.statement_timeout,
    lock_timeout: config.lock_timeout, idle_in_transaction_session_timeout: config.idle_in_transaction_session_timeout,
    application_name: config.application_name, options: config.options, client_encoding: config.client_encoding,
    sslnegotiation: config.sslnegotiation }, {
    host: 'aws-0-ap-northeast-2.pooler.supabase.com', port: 5432, database: f.database,
    user: `memory_seoul_runtime.${projectRef}`, password: 'synthetic-runtime-password',
    ssl: { rejectUnauthorized: true, servername: 'aws-0-ap-northeast-2.pooler.supabase.com', ca: tlsCa },
    connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 0, lock_timeout: 0,
    idle_in_transaction_session_timeout: 0, application_name: 'memory-postgres-runtime', options: '',
    client_encoding: 'UTF8', sslnegotiation: 'postgres',
  });
});

test('the Hono Worker composition executes the schema-5 repository contract', async t => {
  const f = await composedFixture(t);
  const discovery = await f.app.fetch(new Request(origin + '/.well-known/memory-routing-v2'));
  assert.equal((await discovery.json()).target.ready, true);
  const initialized = await rpc(await f.app.fetch(rpcRequest(f.token, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
  })));
  assert.equal(initialized.result.serverInfo.title, 'Seoul Fixture Memory');
  const listed = await rpc(await f.app.fetch(rpcRequest(f.token, 'tools/list')));
  assert.deepEqual(listed.result.tools.map(value => value.name).sort(), [
    'memory_archive_erase', 'memory_ingest', 'memory_lifecycle_status', 'memory_pat_revoke_self',
    'memory_search', 'memory_space_retire',
  ]);
  const source = seoulIngest();
  const stored = await tool(f.app, f.token, 'memory_ingest', source);
  assert.equal(stored.isError, false); assert.equal(stored.value.state, 'stored');
  assert.deepEqual((await tool(f.app, f.token, 'memory_ingest', source)).value, { ...stored.value, replayed: true });
  const found = await tool(f.app, f.token, 'memory_search', seoulSearch());
  assert.equal(found.value.mode, 'keyword'); assert.equal(found.value.count, 1);
  const status = await tool(f.app, f.token, 'memory_lifecycle_status', {
    kind: 'archive', spaceId: 'space:a', archiveId: stored.value.archiveId,
  });
  assert.equal(status.value.state, 'stored'); assert.equal(status.value.revision, 1);
  const erased = await tool(f.app, f.token, 'memory_archive_erase', {
    spaceId: 'space:a', archiveId: stored.value.archiveId, expectedRevision: 1,
    operationId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(erased.value.state, 'primary_erased');
  assert.equal((await tool(f.app, f.token, 'memory_search', seoulSearch())).value.count, 0);
});

test('unknown PATs and unrelated routes never read bodies or general bindings', async t => {
  const f = await composedFixture(t); let reads = 0, bindings = 0;
  for (const name of ['DB', 'MEMORY_SQL', 'MEMORY_INDEX', 'AI', 'postgres'])
    Object.defineProperty(f.env, name, { get() { bindings++; throw new Error('general binding read'); } });
  const body = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  const denied = await f.app.fetch(new Request(origin + '/mcp', { method: 'POST', headers: {
    authorization: 'Bearer ' + 'z'.repeat(40), 'content-type': 'application/json', 'x-memory-routing': '2',
  }, body, duplex: 'half' }));
  assert.equal(denied.status, 401); assert.equal(reads, 0);
  for (const url of ['/manage', '/auth/login', '/v1/memories', '/.well-known/memory-routing-v2?probe=1'])
    assert.ok((await f.app.fetch(new Request(origin + url))).status >= 400);
  assert.equal((await f.app.fetch(rpcRequest(f.token, 'ping', {}))).status, 200);
  const wrong = rpcRequest(f.token, 'ping'); wrong.headers.set('x-memory-routing', '1');
  assert.equal((await f.app.fetch(wrong)).status, 400);
  const semantic = await f.app.fetch(rpcRequest(f.token, 'tools/call', {
    name: 'memory_search', arguments: { ...seoulSearch(), mode: 'semantic' },
  }));
  assert.equal(semantic.status, 400); assert.deepEqual(await semantic.json(), { error: 'seoul_input_invalid' });
  const malformed = await f.app.fetch(rpcRequest(f.token, 'tools/call', {
    name: 'memory_lifecycle_status', arguments: { kind: 'archive', spaceId: 'space:a' },
  }));
  assert.equal(malformed.status, 400); assert.deepEqual(await malformed.json(), { error: 'seoul_input_invalid' });
  assert.equal(bindings, 0);
});

test('the fetch-only Worker bundle loads disabled under native workerd', { timeout: 30000 }, async t => {
  const { outputFiles, metafile } = await build({ entryPoints: ['src/postgres/seoul/worker.ts'], absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    bundle: true, format: 'esm', platform: 'node', target: 'es2022', conditions: ['workerd', 'worker', 'browser'],
    banner: { js: "import { createRequire as __createRequire } from 'node:module';const require=__createRequire('/worker/index.mjs');" },
    write: false, metafile: true });
  const sources = Object.keys(metafile.inputs).map(value => value.replaceAll('\\', '/'));
  const outputInputs = Object.values(metafile.outputs)[0].inputs;
  const bundledSources = Object.keys(outputInputs).map(value => value.replaceAll('\\', '/'));
  assert.ok(sources.some(value => value.endsWith('src/postgres/seoul/worker.ts')));
  // app.ts reuses routingRequestIdSchema; its module imports release/util.ts for
  // another export. Esbuild retains only that utility module's TextEncoder
  // initializer, never the release application or its request/provider helpers.
  const releaseSources = bundledSources.filter(value => /(?:^|\/)src\/release\//.test(value));
  assert.equal(releaseSources.length, 1);
  assert.match(releaseSources[0], /(?:^|\/)src\/release\/util\.ts$/);
  assert.deepEqual(bundledSources.filter(value => /(?:^|\/)src\/(?:operator|admin)\//.test(value)), []);
  assert.deepEqual(bundledSources.filter(value => /(?:^|\/)migrations?\//.test(value)), []);
  for (const name of ['ReleaseError', 'remoteJson', 'requestText', 'requestObject', 'createReleaseApp'])
    assert.ok(!outputFiles[0].text.includes(name));
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'seoul-worker-disabled', modules: true,
    compatibilityDate: '2026-09-07', compatibilityFlags: ['nodejs_compat'], cf: false, script: outputFiles[0].text }));
  t.after(() => mf.dispose());
  const discovery = await mf.dispatchFetch(origin + '/.well-known/memory-routing-v2');
  assert.equal(discovery.status, 200); assert.equal((await discovery.json()).target.ready, false);
  const unavailable = await mf.dispatchFetch(origin + '/mcp', { method: 'POST', headers: { 'x-memory-routing': '2' } });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(Object.keys(worker), ['fetch']);
});

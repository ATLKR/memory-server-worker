import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { fixture as sourceFixture } from '../../release-validation/tests/db.mjs';
import { MemoryStore } from '../../src/release/memory.ts';
import { snapshotCanonical } from '../../src/durable-sql/snapshot.ts';

const origin = 'https://memory-native.example.test', issuer = 'https://auth-api.allen.company';
const deploymentId = 'native-http', control = { deploymentId, databaseId: 'authority', kind: 'control', epoch: 1 };
const hotA = { deploymentId, databaseId: 'payload-a', kind: 'hot', epoch: 1 }, hotB = { deploymentId, databaseId: 'payload-b', kind: 'hot', epoch: 1 };
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const hash = value => createHash('sha256').update(snapshotCanonical(value)).digest('hex');
function authorize(plan) {
  const payload = { planHash: hash(plan), notBeforeMs: Date.now() - 5000, expiresAtMs: Date.now() + 600000 };
  return { ...payload, signature: sign(null, Buffer.from(snapshotCanonical(payload)), keys.privateKey).toString('base64url') };
}
const built = await build({ entryPoints: [fileURLToPath(new URL('../../src/worker.ts', import.meta.url))], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'],
  define: { BUILD_SOURCE_REVISION: JSON.stringify('a'.repeat(40)), BUILD_RESOURCE_FINGERPRINT: JSON.stringify('b'.repeat(64)) } });
// This bridge exists only inside this test's isolated operator Worker. The
// application entry above is the actual deployed source and has no SQL route.
const operatorScript = `export default {async fetch(request,env){
 const {identity,method,input,grant}=await request.json();
 if(!['execute','beginImport','appendImport','sealImport','abandonImport'].includes(method))return Response.json({error:'fixture_method'},{status:400});
 const name='sql:'+identity.deploymentId+':'+identity.databaseId+':'+identity.epoch;
 try{return Response.json({value:await env.MEMORY_SQL.getByName(name)[method](input,grant)});}
 catch(error){return Response.json({error:error.message},{status:400});}
}}`;
const mailerScript = `import {WorkerEntrypoint} from 'cloudflare:workers';
const messages=[];
export class Mailer extends WorkerEntrypoint {async send(message){messages.push(message);return {messageId:'synthetic-mail-'+messages.length};}}
export default {fetch(){return Response.json(messages);}};`;

async function nativeFixture(t, { missingNamespace = false, missingImportKey = false } = {}) {
  const providerCalls = [];
  const { privateKey, publicKey: ssoPublicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(ssoPublicKey), kid: 'native-http-key', alg: 'RS256', use: 'sig' };
  const issuedAt = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({ token_use: 'access', client_id: 'native-http-client', azp: 'native-http-client',
    scope: 'openid profile email memory:read memory:write memory:delete', email: 'native-sso@example.test', emailVerified: true })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: jwk.kid }).setIssuer(issuer).setAudience(origin)
    .setSubject('synthetic-native-subject').setJti('native-http-jti').setIssuedAt(issuedAt).setExpirationTime(issuedAt + 900).sign(privateKey);
  const bindings = { PUBLIC_ORIGIN: origin, SSO_CLIENT_ID: 'native-http-client', MEMORY_SQL_BACKEND: 'durable',
    MEMORY_SQL_DEPLOYMENT_ID: deploymentId, MEMORY_SQL_EPOCH: '1', MEMORY_SQL_IMPORT_PUBLIC_KEY: publicKey,
    MEMORY_SQL_DATABASES_JSON: JSON.stringify({ DB: { databaseId: control.databaseId, kind: 'control' },
      HOT_A: { databaseId: hotA.databaseId, kind: 'hot' }, HOT_B: { databaseId: hotB.databaseId, kind: 'hot' } }),
    STORAGE_MODE: 'sharded', STORAGE_SHARDS_JSON: JSON.stringify([{ id: 'a', binding: 'HOT_A', mode: 'active' }, { id: 'b', binding: 'HOT_B', mode: 'active' }]),
    RELEASE_MODE: 'pilot', ENROLLMENT_MODE: 'open', PAID_BILLING_ENABLED: 'false', BACKGROUND_JOBS_ENABLED: 'false', MAIL_FROM: 'memory@example.test' };
  if (missingImportKey) delete bindings.MEMORY_SQL_IMPORT_PUBLIC_KEY;
  const application = { name: 'application', modules: true, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
    script: built.outputFiles[0].text, bindings,
    ...(missingNamespace ? {} : { durableObjects: { MEMORY_SQL: { className: 'MemorySqlDatabase', useSQLite: true } } }),
    r2Buckets: ['MEMORY_PAYLOADS'], ratelimits: { REQUEST_LIMITER: { namespace_id: '2086091188', simple: { limit: 10000, period: 60 } } },
    serviceBindings: { EMAIL: { name: 'mailer', entrypoint: 'Mailer' } },
    outboundService: async request => {
      const body = await request.text(); providerCalls.push({ url: request.url, method: request.method, body });
      if (request.url === issuer + '/oauth/token') return Response.json({ access_token: accessToken, token_type: 'Bearer' });
      if (request.url === issuer + '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
      return new Response('Unexpected outbound request', { status: 503 });
    } };
  assert.equal(Object.hasOwn(application, 'd1Databases'), false);
  assert.ok(['DB', 'HOT_A', 'HOT_B'].every(name => !Object.hasOwn(bindings, name)));
  const workers = [application, { name: 'mailer', modules: true, compatibilityDate: '2026-09-08', script: mailerScript,
    outboundService: () => new Response('Outbound disabled', { status: 503 }) }];
  if (!missingNamespace) workers.push({ name: 'operator', modules: true, compatibilityDate: '2026-09-08', script: operatorScript,
    durableObjects: { MEMORY_SQL: { className: 'MemorySqlDatabase', scriptName: 'application', useSQLite: true } },
    outboundService: () => new Response('Outbound disabled', { status: 503 }) });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers }));
  t.after(() => mf.dispose());
  let operator = missingNamespace ? undefined : await mf.getWorker('operator');
  let mailbox = await mf.getWorker('mailer');
  const call = async (identity, method, input, grant) => {
    const response = await operator.fetch('https://operator.example.test', { method: 'POST', body: JSON.stringify({ identity, method, input, grant }) });
    const body = await response.json(); if (!response.ok) throw Error(body.error); return body.value;
  };
  const sql = async (identity, query, values = [], mode = 'all') => (await call(identity, 'execute', { identity, statements: [{ sql: query, values, mode }] }))[0];
  const request = (path, { token, cookie, method = 'GET', body, headers = {} } = {}) => mf.dispatchFetch(origin + path, {
    method, redirect: 'manual', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { mf, call, sql, request, providerCalls, bindings, mails: async () => (await mailbox.fetch('https://mailer.example.test')).json(),
    async setMaintenance(value) {
      bindings.MEMORY_SQL_MAINTENANCE = value; await mf.setOptions(convertV4MiniflareOptions({ workers }));
      operator = missingNamespace ? undefined : await mf.getWorker('operator'); mailbox = await mf.getWorker('mailer');
    } };
}

test('native actual Hono application rejects missing SQL namespace without any D1 binding', { timeout: 30000 }, async t => {
  const f = await nativeFixture(t, { missingNamespace: true });
  const response = await f.request('/health');
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  const worker = await f.mf.getWorker('application');
  assert.equal((await worker.scheduled({ cron: '* * * * *' })).outcome, 'exception');
  await f.setMaintenance('true');
  const maintenance = await f.request('/auth/login'); assert.equal(maintenance.status, 503); assert.equal(maintenance.headers.get('retry-after'), '60');
  assert.equal((await (await f.mf.getWorker('application')).scheduled({ cron: '* * * * *' })).outcome, 'ok');
  assert.equal(f.providerCalls.length, 0);
});

test('native import key is mandatory even for a valid signed empty snapshot', { timeout: 30000 }, async t => {
  const f = await nativeFixture(t, { missingImportKey: true });
  const schema = [{ type: 'table', name: 'empty_fixture', tableName: 'empty_fixture', sql: 'CREATE TABLE empty_fixture(id TEXT PRIMARY KEY)' }];
  const tables = [{ name: 'empty_fixture', columns: ['rowid', 'id'], rowCount: 0 }], chunks = [];
  const plan = { version: 1, identity: control, schema, tables, chunks, schemaHash: hash(schema), snapshotHash: hash({ tables, chunks }),
    sourceRevision: 'a'.repeat(40), sourceFrozenAtMs: Date.now() };
  await assert.rejects(() => f.call(control, 'beginImport', plan, authorize(plan)), /snapshot_authorization/);
  await assert.rejects(() => f.sql(control, 'SELECT 1'), /durable_sql_not_ready/);
  assert.equal(f.providerCalls.length, 0);
});

test('native actual Hono and sealed SQL objects retain SSO, PAT, Space, payload and maintenance contracts without D1', { timeout: 180000 }, async t => {
  const f = await nativeFixture(t);
  await assert.rejects(() => f.call(control, 'beginImport', {}, {}), /snapshot_manifest/);
  const { exportDurableSnapshot } = await import('../../scripts/durable-snapshot.mjs');
  const source = await sourceFixture({ clock: Date.now }); t.after(() => source.db.close());
  const now = Date.now();
  source.db.raw.prepare('UPDATE credentials SET expires_at=?,reauthenticated_at=?').run(now + 900000, now);
  const historical = await new MemoryStore(source.db).create(source.key, 's1', { body: 'Historical restored memory' }, 'native-historical');
  const snapshot = identity => ({ identity, sourceRevision: 'a'.repeat(40), sourceFrozenAtMs: Date.now(), freeze: { confirmed: true, evidenceRef: 'fixture:paused' } });
  const exported = await exportDurableSnapshot(source.db, snapshot(control));
  const grant = authorize(exported.plan);

  await t.test('signed imports remain unserved until every chunk is sealed', async () => {
    await assert.rejects(() => f.sql(control, 'SELECT 1'), /durable_sql_not_ready/);
    await assert.rejects(() => f.call(control, 'beginImport', exported.plan, { ...grant, signature: 'A'.repeat(86) }), /snapshot_authorization/);
    await f.call(control, 'beginImport', exported.plan, grant);
    assert.equal((await f.request('/v1/spaces', { token: source.key })).status, 500);
    await assert.rejects(() => f.call(control, 'sealImport', { planHash: grant.planHash }, grant), /snapshot_incomplete/);
    for (const chunk of exported.chunks) await f.call(control, 'appendImport', chunk, grant);
    const sealed = await f.call(control, 'sealImport', { planHash: grant.planHash }, grant);
    assert.equal(sealed.ready, true); assert.equal(sealed.snapshotHash, exported.plan.snapshotHash);
    await assert.rejects(() => f.call(control, 'appendImport', exported.chunks[0], grant), /snapshot_closed/);
    assert.deepEqual((await f.sql(control, 'SELECT body FROM memories WHERE id=?', [historical.id])).results, [{ body: 'Historical restored memory' }]);
  });

  const hotSource = new DatabaseSync(':memory:'); t.after(() => hotSource.close());
  hotSource.exec(await readFile(new URL('../../shard-migrations/0001_payloads.sql', import.meta.url), 'utf8'));
  const hotDatabase = { withSession() { return this; }, prepare(sql) { let values = []; return { bind(...next) { values = next; return this; }, async all() { return { success: true, results: hotSource.prepare(sql).all(...values), meta: {} }; } }; } };
  for (const identity of [hotA, hotB]) {
    const exportedHot = await exportDurableSnapshot(hotDatabase, snapshot(identity)), hotGrant = authorize(exportedHot.plan);
    await f.call(identity, 'beginImport', exportedHot.plan, hotGrant);
    for (const chunk of exportedHot.chunks) await f.call(identity, 'appendImport', chunk, hotGrant);
    assert.equal((await f.call(identity, 'sealImport', { planHash: hotGrant.planHash }, hotGrant)).ready, true);
  }

  await t.test('readiness probes actual sealed control and HOT objects', async () => {
    const response = await f.request('/ready'), body = await response.json();
    assert.equal(response.status, 503); assert.equal(body.checks.schema, true); assert.equal(body.checks.storage, true); assert.equal(body.checks.metering, true);
    const read = await f.request('/v1/spaces/s1/memories/' + historical.id, { token: source.key });
    assert.equal(read.status, 200); assert.equal((await read.json()).body, 'Historical restored memory');
  });

  await t.test('abandon cleans a pending import and keeps its failed object unavailable', async () => {
    const identity = { ...control, databaseId: 'abandoned' }, plan = { ...exported.plan, identity }, abandonedGrant = authorize(plan);
    await f.call(identity, 'beginImport', plan, abandonedGrant);
    await f.call(identity, 'appendImport', { ...exported.chunks[0], planHash: abandonedGrant.planHash }, abandonedGrant);
    assert.equal((await f.call(identity, 'abandonImport', { planHash: abandonedGrant.planHash }, abandonedGrant)).abandoned, true);
    assert.equal((await f.call(identity, 'abandonImport', { planHash: abandonedGrant.planHash }, abandonedGrant)).abandoned, true);
    await assert.rejects(() => f.sql(identity, 'SELECT 1'), /durable_sql_not_ready/);
    await assert.rejects(() => f.call(identity, 'sealImport', { planHash: abandonedGrant.planHash }, abandonedGrant), /snapshot_closed/);
    await assert.rejects(() => f.call(control, 'abandonImport', { planHash: grant.planHash }, grant), /snapshot_closed/);
  });

  let sessionCookie, sessionSpace, scopedKey;
  await t.test('real PKCE callback verifies remote JWKS, creates session and scopes a new PAT', async () => {
    const login = await f.request('/auth/login'); assert.equal(login.status, 302);
    const authorization = new URL(login.headers.get('location')), flowCookie = login.headers.get('set-cookie').split(';')[0];
    const callback = await f.request('/auth/callback?' + new URLSearchParams({ code: 'native-synthetic-code', state: authorization.searchParams.get('state'), iss: issuer }), { cookie: flowCookie });
    assert.equal(callback.status, 303, await callback.text());
    const cookies = callback.headers.getSetCookie();
    sessionCookie = cookies.find(cookie => cookie.startsWith('__Host-memory_session=')).split(';')[0];
    assert.ok(sessionCookie);
    const view = await f.request('/v1/workspace', { cookie: sessionCookie }); assert.equal(view.status, 200);
    const workspace = await view.json(); sessionSpace = workspace.spaces[0].id;
    const issue = () => f.request('/v1/keys', { cookie: sessionCookie, method: 'POST', headers: { origin },
      body: { label: 'Native storage verification', capabilities: ['read', 'create', 'update', 'delete'], spaceIds: [sessionSpace], expiresInDays: 1 } });
    const blocked = await issue(); assert.equal(blocked.status, 403); assert.deepEqual(await blocked.json(), { error: 'recent_reauthentication_required' });
    const challenge = await f.request('/v1/account/reauth', { cookie: sessionCookie, method: 'POST', headers: { origin }, body: { emailId: workspace.account.emails[0].id } });
    assert.equal(challenge.status, 202, await challenge.clone().text());
    const challengeId = (await challenge.json()).id, messages = await f.mails();
    assert.equal(messages.length, 1); assert.equal(messages[0].to, 'native-sso@example.test');
    const proof = /Proof: ([A-Za-z0-9_-]+)/.exec(messages[0].text)[1];
    const reauth = await f.request('/v1/account/reauth/complete', { cookie: sessionCookie, method: 'POST', headers: { origin }, body: { challengeId, proof } });
    assert.equal(reauth.status, 200, await reauth.clone().text());
    const issued = await issue();
    assert.equal(issued.status, 201, await issued.clone().text()); scopedKey = (await issued.json()).token;
    assert.deepEqual(f.providerCalls.map(call => call.url), [issuer + '/oauth/token', issuer + '/.well-known/jwks.json']);
    const exchange = new URLSearchParams(f.providerCalls[0].body);
    assert.equal(exchange.get('resource'), origin);
    assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
    assert.equal((await f.request('/v1/spaces/s1/memories', { token: scopedKey })).status, 403);
  });

  let memory;
  await t.test('PAT CRUD writes native HOT SQL and private R2, and lexical search preserves Space authority', async () => {
    const created = await f.request(`/v1/spaces/${sessionSpace}/memories`, { token: scopedKey, method: 'POST',
      body: { body: 'Synthetic phonograph initial', operationId: 'native-created' } });
    assert.equal(created.status, 201, await created.clone().text()); memory = await created.json();
    const got = await f.request(`/v1/spaces/${sessionSpace}/memories/${memory.id}`, { token: scopedKey });
    assert.equal(got.status, 200); assert.equal((await got.json()).body, 'Synthetic phonograph initial');
    assert.equal((await f.request(`/v1/spaces/${sessionSpace}/memories/${memory.id}`, { token: source.other })).status, 403);
    const updated = await f.request(`/v1/spaces/${sessionSpace}/memories/${memory.id}`, { token: scopedKey, method: 'PATCH',
      body: { body: 'Synthetic phonograph revised', expectedRevision: memory.revision, operationId: 'native-updated' } });
    assert.equal(updated.status, 200, await updated.clone().text()); memory = await updated.json();
    const search = await f.request(`/v1/spaces/${sessionSpace}/memories?query=phonograph`, { token: scopedKey });
    assert.equal(search.status, 200, await search.clone().text()); assert.ok((await search.json()).results.some(row => row.id === memory.id));
    const bucket = await f.mf.getR2Bucket('MEMORY_PAYLOADS', 'application'), objects = await bucket.list();
    assert.equal(objects.objects.length, 2);
    assert.ok((await Promise.all(objects.objects.map(async object => (await bucket.get(object.key)).text()))).some(body => body.includes('phonograph revised')));
    const payloads = (await Promise.all([hotA, hotB].map(identity => f.sql(identity, 'SELECT id FROM payloads')))).flatMap(row => row.results);
    assert.equal(payloads.length, 2);
  });

  await t.test('MCP uses the authenticated product tool path and no public route exposes SQL or import RPC', async () => {
    const response = await f.request('/mcp', { token: scopedKey, method: 'POST', headers: { accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_get', arguments: { spaceId: sessionSpace, memoryId: memory.id } } } });
    assert.equal(response.status, 200);
    const raw = await response.text(), message = JSON.parse(response.headers.get('content-type').includes('text/event-stream') ? raw.split('\n').find(line => line.startsWith('data: ')).slice(6) : raw);
    assert.equal(message.id, 1); assert.equal(message.result.isError, false); assert.ok(message.result.content[0].text.includes('phonograph revised'));
    for (const path of ['/execute', '/beginImport', '/appendImport', '/sealImport', '/abandonImport', '/v1/durable-sql/execute']) {
      assert.ok([401, 404].includes((await f.request(path, { method: 'POST', body: { sql: 'DELETE FROM accounts' } })).status));
      assert.equal((await f.request(path, { token: scopedKey, method: 'POST', body: { sql: 'DELETE FROM accounts' } })).status, 404);
    }
  });

  await t.test('delete tombstones hide current memory and scheduled work persists its heartbeat', async () => {
    const removed = await f.request(`/v1/spaces/${sessionSpace}/memories/${memory.id}`, { token: scopedKey, method: 'DELETE',
      body: { expectedRevision: memory.revision, operationId: 'native-deleted' } });
    assert.equal(removed.status, 204, await removed.text());
    assert.equal((await f.request(`/v1/spaces/${sessionSpace}/memories/${memory.id}`, { token: scopedKey })).status, 404);
    const search = await f.request(`/v1/spaces/${sessionSpace}/memories?query=phonograph`, { token: scopedKey });
    assert.deepEqual((await search.json()).results, []);
    const runtime = await f.mf.getWorker('application');
    assert.equal((await runtime.scheduled({ cron: '* * * * *' })).outcome, 'ok');
    assert.ok((await f.sql(control, "SELECT last_success_at FROM release_heartbeats WHERE name='maintenance'")).results[0].last_success_at > 0);
    const ready = await f.request('/ready'); assert.equal((await ready.json()).checks.maintenance, true);
  });

  await t.test('maintenance quiesces actual HTTP and cron while preserving existing durable state', async () => {
    const observe = () => f.sql(control, "SELECT (SELECT count(*) FROM auth_flows) AS flows,(SELECT count(*) FROM memories) AS memories,(SELECT last_success_at FROM release_heartbeats WHERE name='maintenance') AS heartbeat");
    const before = await observe(), outbound = f.providerCalls.length;
    await f.setMaintenance('true');
    const health = await f.request('/health');
    assert.equal(health.status, 503);
    assert.deepEqual((await health.json()).build, { sourceRevision: 'a'.repeat(40), resourceFingerprint: 'b'.repeat(64), payloadFormat: 2 });
    for (const path of ['/health', '/ready', '/auth/login', '/auth/callback', '/mcp', `/v1/spaces/${sessionSpace}/memories`]) {
      const response = await f.request(path, { token: scopedKey, method: 'POST', body: { body: 'This must never be stored', operationId: 'maintenance-rejected' } });
      assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('retry-after'), '60');
    }
    const runtime = await f.mf.getWorker('application'); assert.equal((await runtime.scheduled({ cron: '* * * * *' })).outcome, 'ok');
    // The separately bound operator can still observe SQL. This flag therefore
    // does not replace the cutover's SQL fence and in-flight work drain.
    assert.deepEqual(await observe(), before); assert.equal(f.providerCalls.length, outbound);
    await f.setMaintenance('false'); assert.equal((await f.request('/health')).status, 200);
  });
});

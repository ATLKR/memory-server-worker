import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
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

// The product application is now PostgreSQL-only, so this suite keeps only the
// retired engine's own contract: the previous end-to-end product-on-durable
// coverage lives in the removed block below and is superseded by test/postgres.

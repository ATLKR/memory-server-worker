import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { DB, at } from './db.mjs';
import { SERVICE_VERSION } from '../../src/config.ts';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { Billing } from '../../src/release/billing.ts';

const keys = await generateKeyPair('EdDSA');
const publicKey = await exportSPKI(keys.publicKey);
const origin = 'https://memory-staging.example.org';
const revision = 'a'.repeat(40), fingerprint = 'b'.repeat(64);
const profile = 'managed-ai-metered';
const issuer = 'urn:allenlabs:memory:live-acceptance';
const gates = ['source-validation', 'sso-session', 'mail-proof', 'workspace-authority', 'identity-revocation', 'pat-mcp-clients', 'ai-retrieval', 'reviewed-ingestion', 'sharing-export-erasure', 'metering-quotas', 'physical-storage', 'multi-store-recovery', 'load-capacity', 'observability-response', 'operational-policy'];
const compiledModule = (async () => {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../../src/release/readiness.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    define: { BUILD_SOURCE_REVISION: JSON.stringify(revision), BUILD_RESOURCE_FINGERPRINT: JSON.stringify(fingerprint) } });
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
})();

function claims(overrides = {}) {
  return { format: 2, profile, releaseVersion: SERVICE_VERSION, sourceRevision: revision, environment: 'staging',
    centralSchemaVersion: 21, hotSchemaVersion: 1, resourceFingerprint: fingerprint,
    gates: gates.map(id => ({ id, status: 'passed', completedAt: at / 1000 - 60, evidenceRef: `private:acceptance/${id}/internal-resource-name`, evidenceSha256: 'c'.repeat(64) })),
    ...overrides };
}

async function sign(payload = claims(), options = {}) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuer(options.issuer ?? issuer).setAudience(options.audience ?? origin).setJti(options.id ?? 'ga-acceptance-20260910')
    .setIssuedAt(options.issuedAt ?? at / 1000 - 30).setExpirationTime(options.expiresAt ?? at / 1000 + 3600)
    .sign(options.privateKey ?? keys.privateKey);
}

async function readyFixture(t, overrides = {}) {
  const db = new DB(); db.migrate(21); t.after(() => db.close());
  db.raw.prepare('INSERT INTO release_heartbeats(name,last_success_at) VALUES(?,?)').run('maintenance', at);
  const env = { DB: db, PUBLIC_ORIGIN: origin, SSO_CLIENT_ID: 'registered-central-client',
    AI: { run() {} }, MEMORY_INDEX: { query() {}, upsert() {}, deleteByIds() {}, getByIds() {} },
    PAYLOAD_KEY: Buffer.alloc(32, 1).toString('base64url'), EMAIL: { send() {} }, MAIL_FROM: 'memory@example.org',
    IDENTITY_WEBHOOK_SECRET: 'd'.repeat(32), METRICS: { writeDataPoint() {} }, REQUEST_LIMITER: { limit() {} },
    BACKGROUND_JOBS_ENABLED: 'true', RELEASE_MODE: 'ga', PAID_BILLING_ENABLED: 'false', GA_PROFILE: profile,
    ENROLLMENT_MODE: 'invite', AI_MONTHLY_BUDGET_MICROUSD: '200000',
    DEPLOYMENT_ENVIRONMENT: 'staging', SOURCE_REVISION: revision, LIVE_ACCEPTANCE_PUBLIC_KEY: publicKey,
    LIVE_ACCEPTANCE_JWS: await sign(), ...overrides };
  const options = { centralSchemaVersion: 21, hotSchemaVersion: 1, clock: () => at,
    inspectStorage: async () => ({ ready: true, hotSchemaVersion: 1, resourceFingerprint: fingerprint }) };
  const { evaluateReadiness } = await compiledModule;
  return { db, env, options, evaluate: () => evaluateReadiness(env, options) };
}

test('all-feature metered GA accepts real Ed25519 attestation without paid billing credentials', async t => {
  const f = await readyFixture(t);
  const result = await f.evaluate();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(result.profile, profile);
  assert.equal(result.stage, 'operator-enabled-ga');
  assert.equal(result.acceptanceId, 'ga-acceptance-20260910');
  assert.ok(Object.values(result.checks).every(value => value === true));
  assert.doesNotMatch(JSON.stringify(result), /internal-resource-name|private:|evidence|BEGIN PUBLIC KEY|bbbbbbbb|cccccccc/);
});

test('arbitrary legacy acceptance ID does not attest readiness', async t => {
  const f = await readyFixture(t, { LIVE_ACCEPTANCE_JWS: undefined, LIVE_ACCEPTANCE_ID: 'some-arbitrary-id' });
  const result = await f.evaluate();
  assert.equal(result.ready, false); assert.equal(result.checks.operatorAcceptance, false);
});

test('valid acceptance survives pilot to ga promotion without a new signature', async t => {
  const f = await readyFixture(t, { RELEASE_MODE: 'pilot' });
  const before = await f.evaluate();
  assert.equal(before.ready, false); assert.equal(before.checks.operatorAcceptance, true); assert.equal(before.checks.gaMode, false);
  f.env.RELEASE_MODE = 'ga';
  assert.equal((await f.evaluate()).ready, true);
});

for (const [name, payload, options] of [
  ['version', { releaseVersion: 'different-version' }], ['source commit', { sourceRevision: 'd'.repeat(40) }],
  ['environment', { environment: 'production' }], ['profile', { profile: 'paid-enterprise' }],
  ['central schema', { centralSchemaVersion: 20 }], ['hot schema', { hotSchemaVersion: 2 }],
  ['resources', { resourceFingerprint: 'e'.repeat(64) }], ['format', { format: 1 }],
  ['audience', {}, { audience: 'https://memory.allenlabs.org' }], ['issuer', {}, { issuer: 'https://untrusted.example.org' }],
  ['expiry cutoff', {}, { expiresAt: at / 1000 }], ['future issuance', {}, { issuedAt: at / 1000 + 1 }],
  ['acceptance longer than seven days', {}, { expiresAt: at / 1000 + 7 * 86400 }],
  ['unsafe record identifier', {}, { id: 'private-user@example.org' }],
]) {
  test(`acceptance rejects mismatched ${name}`, async t => {
    const f = await readyFixture(t, { LIVE_ACCEPTANCE_JWS: await sign(claims(payload), options) });
    const result = await f.evaluate();
    assert.equal(result.checks.operatorAcceptance, false); assert.equal(result.ready, false);
    assert.equal(result.acceptanceId, undefined);
  });
}

for (const [name, mutate] of [
  ['missing metering gate', items => items.filter(item => item.id !== 'metering-quotas')],
  ['missing AI gate', items => items.filter(item => item.id !== 'ai-retrieval')],
  ['missing recovery gate', items => items.filter(item => item.id !== 'multi-store-recovery')],
  ['duplicate gate', items => [...items, items[0]]],
  ['unrecognized gate', items => [...items, { ...items[0], id: 'paid-billing' }]],
  ['failed gate', items => items.map((item, i) => i ? item : { ...item, status: 'failed' })],
  ['missing evidence hash', items => items.map((item, i) => i ? item : { ...item, evidenceSha256: '' })],
  ['missing evidence reference', items => items.map((item, i) => i ? item : { ...item, evidenceRef: '' })],
  ['gate dated after attestation', items => items.map((item, i) => i ? item : { ...item, completedAt: at / 1000 })],
  ['stale live evidence', items => items.map((item, i) => i ? item : { ...item, completedAt: at / 1000 - 8 * 86400 })],
]) {
  test(`acceptance rejects ${name}`, async t => {
    const f = await readyFixture(t, { LIVE_ACCEPTANCE_JWS: await sign(claims({ gates: mutate(claims().gates) })) });
    assert.equal((await f.evaluate()).checks.operatorAcceptance, false);
  });
}

test('untrusted signature and altered JWT are rejected', async t => {
  const f = await readyFixture(t);
  const other = await generateKeyPair('EdDSA');
  for (const token of [await sign(claims(), { privateKey: other.privateKey }), f.env.LIVE_ACCEPTANCE_JWS.replace(/\.[^.]+$/, '.AAAA')]) {
    f.env.LIVE_ACCEPTANCE_JWS = token;
    assert.equal((await f.evaluate()).ready, false);
  }
});

for (const [name, override, check] of [
  ['AI', { AI: undefined }, 'semantic'], ['Vectorize', { MEMORY_INDEX: undefined }, 'semantic'],
  ['encryption key', { PAYLOAD_KEY: 'not-a-key' }, 'encryptedIngest'], ['mail', { EMAIL: undefined }, 'mail'],
  ['revocation receiver', { IDENTITY_WEBHOOK_SECRET: 'short' }, 'deprovisioning'],
  ['metrics', { METRICS: undefined }, 'observability'], ['background jobs', { BACKGROUND_JOBS_ENABLED: 'false' }, 'backgroundJobs'],
  ['paid mode', { PAID_BILLING_ENABLED: 'true' }, 'paidBillingDisabled'], ['unspecified paid mode', { PAID_BILLING_ENABLED: undefined }, 'paidBillingDisabled'],
  ['request limiter', { REQUEST_LIMITER: undefined }, 'rateLimiting'],
]) {
  test(`required ${name} cannot be satisfied by an otherwise valid signature`, async t => {
    const f = await readyFixture(t, override);
    const result = await f.evaluate(); assert.equal(result.ready, false); assert.equal(result.checks[check], false);
  });
}

test('metering checks live database tables and budget/meter triggers', async t => {
  const f = await readyFixture(t);
  f.db.raw.exec('DROP TRIGGER release_operation_meter');
  assert.equal((await f.evaluate()).checks.metering, false);
});

test('schema, storage and maintenance failures are sanitized and fail closed', async t => {
  const f = await readyFixture(t);
  f.options.centralSchemaVersion = 22;
  assert.equal((await f.evaluate()).checks.schema, false);
  f.options.centralSchemaVersion = 21;
  f.options.inspectStorage = async () => { throw new Error('private-database-id'); };
  const failed = await f.evaluate();
  assert.equal(failed.checks.storage, false); assert.doesNotMatch(JSON.stringify(failed), /private-database-id/);
  f.options.inspectStorage = async () => ({ ready: true, hotSchemaVersion: 1, resourceFingerprint: fingerprint });
  for (const heartbeat of [at - 900000, at + 1]) {
    f.db.raw.prepare('UPDATE release_heartbeats SET last_success_at=?').run(heartbeat);
    assert.equal((await f.evaluate()).checks.maintenance, false);
  }
});

test('acceptance expiration is rechecked after asynchronous verification', async t => {
  const f = await readyFixture(t);
  let calls = 0;
  f.options.clock = () => ++calls < 3 ? at : at + 3600000;
  assert.equal((await f.evaluate()).checks.operatorAcceptance, false);
});

test('native workerd verifies Ed25519 acceptance with real D1 readiness probes', async t => {
  const bindings = {
    PUBLIC_ORIGIN: origin, SSO_CLIENT_ID: 'registered-central-client', PAYLOAD_KEY: Buffer.alloc(32, 1).toString('base64url'),
    MAIL_FROM: 'memory@example.org', IDENTITY_WEBHOOK_SECRET: 'd'.repeat(32), BACKGROUND_JOBS_ENABLED: 'true',
    RELEASE_MODE: 'ga', PAID_BILLING_ENABLED: 'false', GA_PROFILE: profile, DEPLOYMENT_ENVIRONMENT: 'staging',
    ENROLLMENT_MODE: 'invite', AI_MONTHLY_BUDGET_MICROUSD: '200000',
    SOURCE_REVISION: revision, LIVE_ACCEPTANCE_PUBLIC_KEY: publicKey, LIVE_ACCEPTANCE_JWS: await sign(),
  };
  const { outputFiles } = await build({ stdin: {
    contents: `import {evaluateReadiness} from './src/release/readiness.ts';
      export default {async fetch(request,env) {
        const mode=new URL(request.url).searchParams.get('mode');
        const configured={...env,AI:{run(){}},MEMORY_INDEX:{query(){},upsert(){},deleteByIds(){},getByIds(){}},
          EMAIL:{send(){}},METRICS:{writeDataPoint(){}},REQUEST_LIMITER:{limit(){}}};
        if(mode==='pilot') configured.RELEASE_MODE='pilot';
        if(mode==='tampered') configured.LIVE_ACCEPTANCE_JWS=configured.LIVE_ACCEPTANCE_JWS.replace(/\\.[^.]+$/,'.AAAA');
        const result=await evaluateReadiness(configured,{centralSchemaVersion:21,hotSchemaVersion:1,clock:()=>${at},
          inspectStorage:async()=>({ready:true,hotSchemaVersion:1,resourceFingerprint:${JSON.stringify(fingerprint)}})});
        return Response.json(result,{status:result.ready?200:503});
      }}`,
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)), sourcefile: 'readiness-native-test.mjs', loader: 'js',
  }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    define: { BUILD_SOURCE_REVISION: JSON.stringify(revision), BUILD_RESOURCE_FINGERPRINT: JSON.stringify(fingerprint) } });
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'readiness-native-test', modules: true,
    compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], script: outputFiles[0].text,
    d1Databases: ['DB'], bindings,
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  // Minimal native catalog fixture; the preceding Node tests use all actual migrations.
  await db.batch([
    'CREATE TABLE release_meta(version INTEGER)', 'INSERT INTO release_meta VALUES(21)',
    'CREATE TABLE release_heartbeats(name TEXT,last_success_at INTEGER)', `INSERT INTO release_heartbeats VALUES('maintenance',${at})`,
    'CREATE TABLE release_operations(id TEXT)', 'CREATE TABLE release_usage_events(id TEXT)',
    'CREATE TABLE release_usage_counters(id TEXT)', 'CREATE TABLE release_pools(id TEXT)',
    'CREATE VIEW release_space_pools AS SELECT id FROM release_pools',
    'CREATE TRIGGER release_operation_budget BEFORE INSERT ON release_operations BEGIN SELECT 1; END',
    'CREATE TRIGGER release_operation_meter AFTER INSERT ON release_operations BEGIN SELECT 1; END',
  ].map(sql => db.prepare(sql)));
  await t.test('valid operator key returns 200 without revealing evidence', async () => {
    const response = await mf.dispatchFetch(origin + '/ready');
    assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.ready, true); assert.equal(result.checks.metering, true);
    assert.doesNotMatch(JSON.stringify(result), /internal-resource-name|private:|evidenceSha256|bbbbbbbb|BEGIN PUBLIC KEY/);
  });
  await t.test('tampering is rejected by native WebCrypto', async () => {
    const response = await mf.dispatchFetch(origin + '/ready?mode=tampered');
    assert.equal(response.status, 503); assert.equal((await response.json()).checks.operatorAcceptance, false);
  });
  await t.test('pilot preserves signed acceptance while withholding GA', async () => {
    const response = await mf.dispatchFetch(origin + '/ready?mode=pilot');
    assert.equal(response.status, 503); const result = await response.json();
    assert.equal(result.checks.operatorAcceptance, true); assert.equal(result.checks.gaMode, false);
  });
});

test('a declared environment revision alone cannot authorize an unpinned Node/ad-hoc build', async t => {
  const f = await readyFixture(t);
  const { evaluateReadiness } = await import('../../src/release/readiness.ts');
  assert.equal((await evaluateReadiness(f.env, f.options)).checks.operatorAcceptance, false);
});

test('compiled source pin works without a self-referential tracked SOURCE_REVISION variable', async t => {
  const f = await readyFixture(t, { SOURCE_REVISION: undefined });
  assert.equal((await f.evaluate()).ready, true);
});

test('runtime inspector and signed record cannot substitute another resource fingerprint for the compiled target', async t => {
  const changed = 'f'.repeat(64);
  const f = await readyFixture(t, { LIVE_ACCEPTANCE_JWS: await sign(claims({ resourceFingerprint: changed })) });
  f.options.inspectStorage = async () => ({ ready: true, hotSchemaVersion: 1, resourceFingerprint: changed });
  assert.equal((await f.evaluate()).checks.operatorAcceptance, false);
});

for (const [name, mode, expected] of [
  ['explicit disabled flag', { PAID_BILLING_ENABLED: 'false' }, false],
  ['metered profile', { GA_PROFILE: profile }, false],
  ['GA without paid opt-in', { RELEASE_MODE: 'ga' }, false],
  ['legacy non-GA fixture compatibility', {}, true],
]) {
  test(`billing configuration honors ${name} even with valid provider credentials`, () => {
    const configured = { BACKGROUND_JOBS_ENABLED: 'true', STRIPE_SECRET_KEY: 'synthetic-key', STRIPE_WEBHOOK_SECRET: 's'.repeat(32),
      STRIPE_API_VERSION: '2026-01-01', BILLING_PRICES_JSON: JSON.stringify({ price_example: { plan: 'example', monthlyUnits: 100, storageBytes: 1000 } }), ...mode };
    assert.equal(new Billing(configured).configuration().available, expected);
  });
}

for (const [environment, budget, valid] of [
  ['production', '20000000', true], ['production', '20000001', false],
  ['staging', '200000', true], ['staging', '200001', false],
  ['staging', undefined, false], ['staging', '0', false], ['staging', '200000.0', false],
  ['staging', 200000, false], ['staging', ['200000'], false],
]) {
  test(`AI reservation budget ${environment}/${budget} is bounded independently of the total invoice`, async t => {
    const f = await readyFixture(t, { DEPLOYMENT_ENVIRONMENT: environment, AI_MONTHLY_BUDGET_MICROUSD: budget,
      LIVE_ACCEPTANCE_JWS: await sign(claims({ environment })) });
    assert.equal((await f.evaluate()).checks.aiBudget, valid);
  });
}

test('open or unspecified enrollment cannot pass the invite-based GA profile', async t => {
  for (const mode of ['open', undefined]) {
    const f = await readyFixture(t, { ENROLLMENT_MODE: mode });
    assert.equal((await f.evaluate()).checks.inviteEnrollment, false);
  }
});

test('malformed invite rosters cannot pass readiness while an empty roster remains intentionally closed', async t => {
  for (const [roster, expected] of [['["not-a-hash"]', false], ['{', false], ['[]', true], [undefined, true]]) {
    const f = await readyFixture(t, { ENROLLMENT_EMAIL_HASHES_JSON: roster });
    assert.equal((await f.evaluate()).checks.inviteEnrollment, expected);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportPKCS8, exportSPKI, jwtVerify, importSPKI } from 'jose';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'jsonc-parser';
import { GA_PROFILE, ACCEPTANCE_ISSUER, REQUIRED_ACCEPTANCE_GATES } from '../src/release/readiness.ts';
import { SERVICE_VERSION } from '../src/config.ts';
import { deploymentFingerprint } from './deployment-config.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const keys = await generateKeyPair('EdDSA', { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey), publicKey = await exportSPKI(keys.publicKey);
const now = Date.UTC(2026, 8, 10, 12), source = { revision: 'a'.repeat(40), dirty: false };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'private memory acceptance '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = parse(await readFile(join(project, 'wrangler.jsonc'), 'utf8'));
  config.name = 'memory-acceptance-staging';
  config.vars.STORAGE_MODE = 'inline';
  delete config.vars.STORAGE_SHARDS_JSON;
  config.vectorize = [{ binding: 'MEMORY_INDEX', index_name: 'memory-acceptance-staging-index' }];
  config.analytics_engine_datasets = [{ binding: 'METRICS', dataset: 'memory_acceptance_staging_metrics' }];
  Object.assign(config.vars, { DEPLOYMENT_ENVIRONMENT: 'staging', PUBLIC_ORIGIN: 'https://memory-staging.example.org',
    GA_PROFILE, PAID_BILLING_ENABLED: 'false', ENROLLMENT_MODE: 'invite', AI_MONTHLY_BUDGET_MICROUSD: '200000',
    LIVE_ACCEPTANCE_PUBLIC_KEY: publicKey });
  config.routes = [{ pattern: 'memory-staging.example.org', custom_domain: true }];
  config.d1_databases = [{ binding: 'DB', database_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', database_name: 'memory-acceptance-staging' }];
  config.r2_buckets = [{ binding: 'MEMORY_PAYLOADS', bucket_name: 'memory-acceptance-staging' }];
  const path = join(directory, 'target.jsonc'); await writeFile(path, JSON.stringify(config));
  const target = { path, config, environment: 'staging', settings: { origin: config.vars.PUBLIC_ORIGIN } };
  const schemas = { centralSchemaVersion: 23, hotSchemaVersion: 1 };
  const context = { sourceRevision: source.revision, releaseVersion: SERVICE_VERSION, environment: target.environment,
    origin: target.settings.origin, ...schemas, resourceFingerprint: deploymentFingerprint(config) };
  const record = { format: 2, id: 'ga-test-20260910', profile: GA_PROFILE, ...context, gates: [] };
  for (const id of REQUIRED_ACCEPTANCE_GATES) {
    const evidenceFile = id + '.json';
    const evidence = { format: 1, gate: id, outcome: 'passed', ...context, observedAt: now / 1000 - 60,
      checks: [{ name: 'operator-verified-case', outcome: 'passed', observation: 'private-internal-resource' }] };
    const body = JSON.stringify(evidence); await writeFile(join(directory, evidenceFile), body);
    record.gates.push({ id, status: 'passed', completedAt: evidence.observedAt, evidenceFile,
      evidenceRef: 'private:acceptance/' + evidenceFile, evidenceSha256: createHash('sha256').update(body).digest('hex') });
  }
  const options = { record, target, source, schemas, privateKey, expiresAt: now / 1000 + 3600, clock: () => now, recordDirectory: directory };
  return { directory, path, target, schemas, record, options };
}

test('pending template carries exact target facts and never marks evidence passed', async t => {
  const f = await fixture(t);
  const { createPendingAcceptance } = await import('./acceptance-record.mjs');
  const record = createPendingAcceptance(f.target, source, f.schemas);
  assert.equal(record.sourceRevision, source.revision); assert.equal(record.resourceFingerprint, deploymentFingerprint(f.target.config));
  assert.deepEqual(record.gates.map(gate => gate.id), [...REQUIRED_ACCEPTANCE_GATES]);
  assert.ok(record.gates.every(gate => gate.status === 'pending' && gate.evidenceSha256 === '' && gate.evidenceFile === ''));
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE KEY/);
});

test('signing verifies every actual evidence hash and signs only bounded public manifest fields', async t => {
  const f = await fixture(t);
  const { signAcceptanceRecord } = await import('./acceptance-record.mjs');
  const token = await signAcceptanceRecord(f.options);
  const { payload } = await jwtVerify(token, await importSPKI(publicKey, 'EdDSA'), { issuer: ACCEPTANCE_ISSUER, audience: f.target.settings.origin, currentDate: new Date(now) });
  assert.equal(payload.sourceRevision, source.revision); assert.equal(payload.jti, f.record.id);
  assert.equal(payload.gates.length, REQUIRED_ACCEPTANCE_GATES.length);
  assert.ok(payload.gates.every(gate => !('evidenceFile' in gate)));
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE KEY|private-internal-resource|private memory acceptance/);
});

for (const [name, mutate] of [
  ['pending gate', f => { f.record.gates[0].status = 'pending'; }],
  ['missing gate', f => { f.record.gates.pop(); }],
  ['duplicate gate', f => { f.record.gates[1] = f.record.gates[0]; }],
  ['wrong source', f => { f.record.sourceRevision = 'b'.repeat(40); }],
  ['dirty source', f => { f.options.source = { ...source, dirty: true }; }],
  ['wrong config fingerprint', f => { f.record.resourceFingerprint = 'b'.repeat(64); }],
  ['wrong schema', f => { f.record.centralSchemaVersion--; }],
  ['expired deadline', f => { f.options.expiresAt = now / 1000; }],
  ['overlong deadline', f => { f.options.expiresAt = now / 1000 + 7 * 86400 + 1; }],
  ['missing hash', f => { f.record.gates[0].evidenceSha256 = ''; }],
  ['changed evidence bytes', async f => { await writeFile(join(f.directory, f.record.gates[0].evidenceFile), '{}'); }],
  ['missing evidence file', f => { f.record.gates[0].evidenceFile = 'missing.json'; }],
]) {
  test(`signing rejects ${name}`, async t => {
    const f = await fixture(t); await mutate(f);
    const { signAcceptanceRecord } = await import('./acceptance-record.mjs');
    await assert.rejects(signAcceptanceRecord(f.options));
  });
}

for (const [name, mutate] of [
  ['failed observed check', e => { e.checks[0].outcome = 'failed'; }],
  ['empty checks', e => { e.checks = []; }], ['unrelated gate', e => { e.gate = 'unrelated'; }],
  ['different deployment', e => { e.environment = 'production'; }],
  ['future evidence', e => { e.observedAt = now / 1000 + 1; }],
]) {
  test(`a fresh hash cannot conceal ${name}`, async t => {
    const f = await fixture(t), gate = f.record.gates[0];
    const path = join(f.directory, gate.evidenceFile), evidence = JSON.parse(await readFile(path, 'utf8'));
    mutate(evidence); const body = JSON.stringify(evidence); await writeFile(path, body);
    gate.evidenceSha256 = createHash('sha256').update(body).digest('hex');
    const { signAcceptanceRecord } = await import('./acceptance-record.mjs');
    await assert.rejects(signAcceptanceRecord(f.options));
  });
}

test('wrong operator key cannot sign for the configured trusted public key', async t => {
  const f = await fixture(t), other = await generateKeyPair('EdDSA', { extractable: true });
  const { signAcceptanceRecord } = await import('./acceptance-record.mjs');
  await assert.rejects(signAcceptanceRecord({ ...f.options, privateKey: await exportPKCS8(other.privateKey) }));
});

test('CLI refuses private key arguments and never prints their values', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', join(project, 'scripts/acceptance-record.mjs'), 'sign', '--private-key=private-key-do-not-print'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /private-key-do-not-print/);
  assert.match(result.stderr, /argument|stdin|environment/i);
});

test('acceptance output refuses a public repository path', async t => {
  const f = await fixture(t);
  const { runAcceptanceCommand } = await import('./acceptance-record.mjs');
  await assert.rejects(runAcceptanceCommand(['template', '--config', f.path, '--out', resolve(project, 'do-not-create-acceptance.json')], {
    inspectSource: async () => source, schemas: f.schemas,
  }), /outside.*repository/i);
});

test('sign command writes only the signed artifact with a supplied stdin-style key reader', async t => {
  const f = await fixture(t), recordPath = join(f.directory, 'record.json'), output = join(f.directory, 'acceptance.jws');
  await writeFile(recordPath, JSON.stringify(f.record));
  const { runAcceptanceCommand } = await import('./acceptance-record.mjs');
  await runAcceptanceCommand(['sign', '--config', f.path, '--record', recordPath, '--out', output, '--expires-at', new Date(now + 3600000).toISOString().replace('.000Z', 'Z'), '--key-stdin'], {
    inspectSource: async () => source, schemas: f.schemas, clock: () => now, readKey: async () => privateKey, processEnvironment: {},
  });
  const token = (await readFile(output, 'utf8')).trim();
  assert.equal((await jwtVerify(token, keys.publicKey, { currentDate: new Date(now) })).payload.jti, f.record.id);
  assert.doesNotMatch(token, /PRIVATE KEY/);
});

test('signing refuses stale live evidence even if its status and hash have been refreshed', async t => {
  const f = await fixture(t), gate = f.record.gates[0], path = join(f.directory, gate.evidenceFile);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  gate.completedAt = evidence.observedAt = now / 1000 - 8 * 86400;
  const body = JSON.stringify(evidence); await writeFile(path, body); gate.evidenceSha256 = createHash('sha256').update(body).digest('hex');
  const { signAcceptanceRecord } = await import('./acceptance-record.mjs');
  await assert.rejects(signAcceptanceRecord(f.options), /dated evidence|fresh|deadline/i);
});

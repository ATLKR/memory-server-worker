import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, truncate, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'jsonc-parser';
import { deploymentFingerprint } from './deployment-config.mjs';
import { SERVICE_VERSION } from '../src/config.ts';
import { runRecoveryCommand, RECOVERY_CHECKS } from './recovery-manifest.mjs';

const now = 1800000000000, revision = 'a'.repeat(40);
const schemas = { centralSchemaVersion: 24, hotSchemaVersion: 1 };
const options = { inspectSource: async () => ({ revision, dirty: false }), schemas, clock: () => now, processEnvironment: {} };
const hash = value => createHash('sha256').update(value).digest('hex');
const base = parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
function config(n) {
  const c = structuredClone(base);
  c.name = `recovery-${n}`; c.vars.DEPLOYMENT_ENVIRONMENT = 'staging'; c.vars.PUBLIC_ORIGIN = `https://recovery-${n}.example.org`;
  c.vars.STORAGE_MODE = 'sharded'; c.vars.RELEASE_MODE = 'pilot';
  c.vars.STORAGE_SHARDS_JSON = JSON.stringify([{ id: 'a', binding: 'HOT_A', mode: 'active' }, { id: 'b', binding: 'HOT_B', mode: 'draining' }]);
  c.routes = [{ pattern: `recovery-${n}.example.org`, custom_domain: true }];
  c.d1_databases = ['DB', 'HOT_A', 'HOT_B'].map((binding, i) => ({ binding, database_name: `recovery-${n}-${i}`, database_id: `${n}${i}aaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`, migrations_dir: i ? 'shard-migrations' : 'migrations' }));
  c.r2_buckets = [{ binding: 'MEMORY_PAYLOADS', bucket_name: `recovery-${n}-payloads` }];
  c.vectorize = [{ binding: 'MEMORY_INDEX', index_name: `recovery-${n}-index` }];
  c.analytics_engine_datasets = [{ binding: 'METRICS', dataset: `recovery-${n}-metrics` }];
  return c;
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'memory recovery '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = config(1), destination = config(2), sourcePath = join(dir, 'source.jsonc'), destinationPath = join(dir, 'destination.jsonc');
  await writeFile(sourcePath, JSON.stringify(source)); await writeFile(destinationPath, JSON.stringify(destination));
  const body = JSON.stringify({ body: 'Private recovered body', provenance: {}, source: null });
  const ref = { id: 'p1', shardId: 'a', objectKey: 'payload/v1/p1', sha256: hash(body), bytes: Buffer.byteLength(body) };
  const meta = { payloadId: 'p1', shardId: 'a', spaceId: 's1', memoryId: 'm1', sha256: ref.sha256, state: 'payload' };
  const inventory = {
    format: 1, context: { releaseVersion: SERVICE_VERSION, sourceRevision: revision, environment: 'staging', origin: source.vars.PUBLIC_ORIGIN, resourceFingerprint: deploymentFingerprint(source), ...schemas },
    capturedAt: now - 1000, capture: { writesStopped: true, inventoryComplete: true, evidenceRef: 'private-capture-001' },
    exports: [{ binding: 'DB', file: 'central.sql' }, { binding: 'HOT_A', file: 'hot-a.sql' }, { binding: 'HOT_B', file: 'hot-b.sql' }],
    objects: [{ key: ref.objectKey, file: 'p1.json', metadata: meta }],
    currentHeads: [{ spaceId: 's1', memoryId: 'm1', revision: 1, payload: ref }], hotTombstones: [], pendingPurges: [],
  };
  for (const entry of inventory.exports) await writeFile(join(dir, entry.file), '-- operator database export\n');
  await writeFile(join(dir, 'p1.json'), body);
  const inventoryPath = join(dir, 'inventory.json'), manifestPath = join(dir, 'manifest.json'), planPath = join(dir, 'plan.json');
  const save = () => writeFile(inventoryPath, JSON.stringify(inventory)); await save();
  const prepare = () => runRecoveryCommand(['prepare', '--config', sourcePath, '--inventory', inventoryPath, '--out', manifestPath], options);
  const verify = sha => runRecoveryCommand(['verify', '--config', sourcePath, '--manifest', manifestPath, '--sha256', sha], options);
  const plan = (sha, extra = []) => runRecoveryCommand(['drill-plan', '--config', sourcePath, '--manifest', manifestPath, '--sha256', sha, '--destination', destinationPath, '--quarantine', '--out', planPath, ...extra], options);
  return { dir, source, destination, sourcePath, destinationPath, inventory, inventoryPath, manifestPath, planPath, save, prepare, verify, plan };
}
async function passedEvidence(f, manifestHash) {
  const destinationFingerprint = deploymentFingerprint(f.destination), checks = [];
  for (const id of RECOVERY_CHECKS) {
    const evidenceFile = `${id}.json`, bytes = JSON.stringify({ format: 1, check: id, outcome: 'passed', manifestSha256: manifestHash, destinationFingerprint,
      observedAt: now, checks: [{ name: 'Operator observed required quarantine control', outcome: 'passed' }] });
    await writeFile(join(f.dir, evidenceFile), bytes);
    checks.push({ id, outcome: 'passed', evidenceRef: `private-${id}`, evidenceFile, evidenceSha256: hash(bytes) });
  }
  const evidence = { format: 1, manifestSha256: manifestHash, destinationFingerprint, observedAt: now, checks, measurements: { rpoSeconds: 3, rtoSeconds: 65 } };
  const path = join(f.dir, 'drill.json'); await writeFile(path, JSON.stringify(evidence)); return { path, evidence };
}

test('prepare hashes real exports and payloads; verify and quarantine plan preserve private contents', async t => {
  const f = await fixture(t), result = await f.prepare();
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
  assert.equal(manifest.files.length, 4); assert.equal(manifest.files.find(v => v.path === 'p1.json').sha256, f.inventory.currentHeads[0].payload.sha256);
  assert.doesNotMatch(JSON.stringify(result), /Private|s1|m1|bucket|database/);
  assert.equal((await f.verify(result.manifestSha256)).status, 'verified');
  await f.plan(result.manifestSha256);
  const plan = JSON.parse(await readFile(f.planPath, 'utf8'));
  assert.equal(plan.quarantine, true); assert.equal(plan.promotionAllowed, false); assert.equal(plan.status, 'evidence-pending');
  assert.deepEqual(plan.measurements, { rpoSeconds: null, rtoSeconds: null });
  assert.equal(plan.rebuild.currentHeads, 1); assert.equal(plan.checks.length, RECOVERY_CHECKS.length);
  assert.doesNotMatch(JSON.stringify(plan), /Private recovered body/);
});

for (const [name, mutate] of [
  ['export tampering', async f => writeFile(join(f.dir, 'central.sql'), 'modified')],
  ['object tampering', async f => writeFile(join(f.dir, 'p1.json'), 'modified')],
  ['manifest tampering', async f => writeFile(f.manifestPath, (await readFile(f.manifestPath, 'utf8')).replace('private-capture-001', 'private-capture-002'))],
]) test(`verify rejects ${name}`, async t => { const f = await fixture(t), result = await f.prepare(); await mutate(f); await assert.rejects(f.verify(result.manifestSha256), /hash|SHA|changed|integrity/i); });

for (const [name, mutate] of [
  ['parent traversal', i => { i.exports[0].file = '../secret.sql'; }],
  ['absolute path', i => { i.exports[0].file = 'C:/private.sql'; }],
  ['Windows stream', i => { i.exports[0].file = 'central.sql:token'; }],
  ['backslash traversal', i => { i.exports[0].file = '..\\secret.sql'; }],
  ['duplicate path', i => { i.exports[1].file = i.exports[0].file; }],
  ['missing hot export', i => { i.exports.pop(); }],
  ['stale schema', i => { i.context.centralSchemaVersion--; }],
  ['pre-sharding schema', i => { i.context.centralSchemaVersion = 21; }],
  ['unknown secret field', i => { i.secretToken = 'DO-NOT-PRINT'; }],
  ['unfenced capture', i => { i.capture.writesStopped = false; }],
  ['partial inventory', i => { i.capture.inventoryComplete = false; }],
  ['missing authoritative object', i => { i.objects = []; }],
  ['wrong object context', i => { i.objects[0].metadata.spaceId = 'other-space'; }],
  ['wrong payload digest', i => { i.currentHeads[0].payload.sha256 = 'b'.repeat(64); }],
  ['duplicate current memory', i => { i.currentHeads.push(structuredClone(i.currentHeads[0])); }],
  ['retired current head', i => { i.hotTombstones.push({ payloadId: 'p1', shardId: 'a', spaceId: 's1', memoryId: 'm1', retiredAt: now - 2000 }); }],
  ['erased current head', i => { i.pendingPurges.push({ spaceId: 's1', memoryId: 'm1', payload: i.currentHeads[0].payload }); }],
]) test(`prepare rejects ${name}`, async t => { const f = await fixture(t); mutate(f.inventory); await f.save(); await assert.rejects(f.prepare()); });

test('prepare rejects symlinked export directories without reading outside the bundle', async t => {
  const f = await fixture(t); await mkdir(join(f.dir, 'outside')); await writeFile(join(f.dir, 'outside', 'export.sql'), 'private');
  await symlink(join(f.dir, 'outside'), join(f.dir, 'link'), 'junction');
  f.inventory.exports[0].file = 'link/export.sql'; await f.save(); await assert.rejects(f.prepare(), /symbolic|link/i);
});
test('payload validation retains zero-byte R2 purged metadata and HOT tombstones', async t => {
  const f = await fixture(t); f.inventory.currentHeads = [];
  f.inventory.objects[0].metadata.state = 'purged'; await writeFile(join(f.dir, 'p1.json'), '');
  f.inventory.hotTombstones.push({ payloadId: 'p1', shardId: 'a', spaceId: 's1', memoryId: 'm1', retiredAt: now - 2000 }); await f.save();
  const result = await f.prepare(); await f.plan(result.manifestSha256);
  const plan = JSON.parse(await readFile(f.planPath)); assert.equal(plan.rebuild.currentHeads, 0); assert.equal(plan.preserve.r2Purged, 1); assert.equal(plan.preserve.hotTombstones, 1);
});
test('pending erasure is preserved as required isolated work without reconstructing old content', async t => {
  const f = await fixture(t); f.inventory.pendingPurges = [{ spaceId: 's1', memoryId: 'm1', payload: f.inventory.currentHeads[0].payload }]; f.inventory.currentHeads = []; await f.save();
  const result = await f.prepare(); await f.plan(result.manifestSha256);
  const plan = JSON.parse(await readFile(f.planPath)); assert.equal(plan.rebuild.currentHeads, 0); assert.equal(plan.preserve.pendingPurges, 1); assert.equal(plan.promotionAllowed, false);
});
for (const [name, mutate] of [
  ['production target', c => { c.vars.DEPLOYMENT_ENVIRONMENT = 'production'; }],
  ['GA target', c => { c.vars.RELEASE_MODE = 'ga'; }],
  ['inline target', c => { c.vars.STORAGE_MODE = 'inline'; }],
  ['D1 overlap', (c, f) => { c.d1_databases[1].database_id = f.source.d1_databases[1].database_id; }],
  ['R2 overlap', (c, f) => { c.r2_buckets = f.source.r2_buckets; }],
  ['Vectorize overlap', (c, f) => { c.vectorize = f.source.vectorize; }],
  ['Analytics overlap', (c, f) => { c.analytics_engine_datasets = f.source.analytics_engine_datasets; }],
  ['origin overlap', (c, f) => { c.vars.PUBLIC_ORIGIN = f.source.vars.PUBLIC_ORIGIN; c.routes = f.source.routes; }],
]) test(`drill refuses ${name}`, async t => { const f = await fixture(t), result = await f.prepare(); mutate(f.destination, f); await writeFile(f.destinationPath, JSON.stringify(f.destination)); await assert.rejects(f.plan(result.manifestSha256), /isolat|overlap|staging|sharded|pilot/i); });

test('drill requires explicit quarantine and never silently uses a default production config', async t => {
  const f = await fixture(t), result = await f.prepare();
  await assert.rejects(runRecoveryCommand(['drill-plan', '--config', f.sourcePath, '--manifest', f.manifestPath, '--sha256', result.manifestSha256, '--destination', f.destinationPath, '--out', f.planPath], options), /quarantine/i);
  await assert.rejects(runRecoveryCommand(['verify', '--manifest', f.manifestPath, '--sha256', result.manifestSha256], options), /explicit|config/i);
});

test('passed drill evidence binds the exact manifest and target, with measured RPO/RTO but no promotion', async t => {
  const f = await fixture(t), result = await f.prepare();
  const { evidence, path: evidencePath } = await passedEvidence(f, result.manifestSha256);
  await f.plan(result.manifestSha256, ['--evidence', evidencePath]);
  const plan = JSON.parse(await readFile(f.planPath)); assert.equal(plan.status, 'evidence-verified'); assert.equal(plan.promotionAllowed, false); assert.deepEqual(plan.measurements, evidence.measurements);
  await rm(f.planPath); evidence.checks.find(c => c.id === 'credentials-invalidated').outcome = 'pending'; await writeFile(evidencePath, JSON.stringify(evidence));
  await assert.rejects(f.plan(result.manifestSha256, ['--evidence', evidencePath]), /evidence|passed/i);
});

for (const [name, mutate] of [
  ['wrong manifest', e => { e.manifestSha256 = 'b'.repeat(64); }],
  ['wrong destination', e => { e.destinationFingerprint = 'b'.repeat(64); }],
  ['missing identity check', e => { e.checks = e.checks.filter(c => c.id !== 'identity-reconciled'); }],
  ['duplicate check', e => { e.checks[1] = e.checks[0]; }],
  ['future observation', e => { e.observedAt = now + 1; }],
  ['invented null measurement', e => { e.measurements.rpoSeconds = null; }],
  ['evidence traversal', e => { e.checks[0].evidenceFile = '../outside.json'; }],
  ['wrong evidence hash', e => { e.checks[0].evidenceSha256 = 'b'.repeat(64); }],
]) test(`drill evidence rejects ${name}`, async t => {
  const f = await fixture(t), result = await f.prepare(), { path, evidence } = await passedEvidence(f, result.manifestSha256); mutate(evidence); await writeFile(path, JSON.stringify(evidence));
  await assert.rejects(f.plan(result.manifestSha256, ['--evidence', path]));
});
test('a refreshed evidence digest cannot hide a failed identity reconciliation observation', async t => {
  const f = await fixture(t), result = await f.prepare(), { path, evidence } = await passedEvidence(f, result.manifestSha256);
  const check = evidence.checks.find(c => c.id === 'identity-reconciled'), proof = JSON.parse(await readFile(join(f.dir, check.evidenceFile)));
  proof.checks[0].outcome = 'failed'; const bytes = JSON.stringify(proof); await writeFile(join(f.dir, check.evidenceFile), bytes); check.evidenceSha256 = hash(bytes); await writeFile(path, JSON.stringify(evidence));
  await assert.rejects(f.plan(result.manifestSha256, ['--evidence', path]), /passed|evidence/i);
});
test('duplicate JSON input keys fail before producing a manifest', async t => {
  const f = await fixture(t); await writeFile(f.inventoryPath, JSON.stringify(f.inventory).replace('"format":1', '"format":1,"format":1'));
  await assert.rejects(f.prepare(), /Duplicate/);
});
test('oversized sparse export is rejected before reading its contents', async t => {
  const f = await fixture(t); await truncate(join(f.dir, 'central.sql'), 256 * 1024 * 1024 + 1); await assert.rejects(f.prepare(), /size limit/);
});
test('dirty or changed source cannot be recorded as the pinned recovery source', async t => {
  const f = await fixture(t), args = ['prepare', '--config', f.sourcePath, '--inventory', f.inventoryPath, '--out', f.manifestPath];
  await assert.rejects(runRecoveryCommand(args, { ...options, inspectSource: async () => ({ revision, dirty: true }) }), /clean/);
  let calls = 0; await assert.rejects(runRecoveryCommand(args, { ...options, inspectSource: async () => ({ revision: ++calls === 1 ? revision : 'b'.repeat(40), dirty: false }) }), /changed/);
});
test('oversized explicit config is bounded before parsing or source inspection', async t => {
  const f = await fixture(t); await truncate(f.sourcePath, 1048577);
  await assert.rejects(f.prepare(), /size limit/);
});
test('pending purge cannot contradict a permanent tombstone even when R2 is absent', async t => {
  const f = await fixture(t); f.inventory.pendingPurges = [{ spaceId: 's1', memoryId: 'm1', payload: f.inventory.currentHeads[0].payload }];
  f.inventory.currentHeads = []; f.inventory.objects = [];
  f.inventory.hotTombstones = [{ payloadId: 'p1', shardId: 'a', spaceId: 'another-space', memoryId: 'm1', retiredAt: now - 2000 }];
  await f.save(); await assert.rejects(f.prepare(), /context/);
});
test('returned recovery stdout omits plaintext and supplied path when valid config later fails', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, ['--experimental-strip-types', resolve('scripts/recovery-cli.mjs'), 'prepare', '--config', f.sourcePath, '--inventory', f.inventoryPath, '--out', f.manifestPath], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /Private recovered body|source\.jsonc|inventory\.json|recovery-1-payloads/);
});

test('exclusive atomic output does not overwrite existing private artifacts', async t => {
  const f = await fixture(t); await writeFile(f.manifestPath, 'keep'); await assert.rejects(f.prepare()); assert.equal(await readFile(f.manifestPath, 'utf8'), 'keep');
  assert.equal((await readdir(f.dir)).some(name => name.startsWith('.recovery-')), false);
});
test('CLI rejects unknown credential arguments without printing their values', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', resolve('scripts/recovery-cli.mjs'), 'verify', '--token', 'PRIVATE-TOKEN'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-TOKEN/);
});

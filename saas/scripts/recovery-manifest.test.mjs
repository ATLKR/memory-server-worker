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

const canonical = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value; }
async function historicalFixture(t) {
  const f = await fixture(t), i = f.inventory, at = i.capturedAt, c = f.source, version = '11111111-1111-4111-8111-111111111111';
  const modules = [{ name: 'worker.js', bytes: 7, sha256: hash('fixture') }];
  const policy = { format: 1, contract: 'memory-payload-monotonic-v1', accountId: c.account_id, workerName: c.name, bucketName: c.r2_buckets[0].bucket_name, bucketCreatedAt: at - 1000,
    sourceRevision: revision, resourceFingerprint: i.context.resourceFingerprint, writerSourceSha256: hash('reviewed writer source'),
    versions: [{ id: version, sourceRevision: revision, writerSourceSha256: hash('reviewed writer source'), modules, receiptSha256: hash('retained deployment') }],
    coordinator: { issuedAt: at - 100, expiresAt: at + 100, scope: 'exclusive-operators-during-capture', activeWriters: [c.name], evidenceSha256: hash('operator inventory') } };
  const prefix = '/accounts/' + c.account_id, script = prefix + '/workers/scripts/' + c.name, bucket = prefix + '/r2/buckets/' + policy.bucketName;
  const observation = { format: 1, observedAt: at, accountId: c.account_id, workerName: c.name, currentVersionId: version,
    versionPages: [{ page: 1, perPage: 100, items: [{ id: version, createdAt: at - 500 }] }], modules,
    bindings: [...c.d1_databases.map(d => ({ name: d.binding, type: 'd1', id: d.database_id })), { name: 'MEMORY_PAYLOADS', type: 'r2_bucket', bucket_name: policy.bucketName }, ...Object.entries(c.vars).map(([name, text]) => ({ name, type: 'plain_text', text }))],
    bucket: { name: policy.bucketName, createdAt: policy.bucketCreatedAt, lifecycleRules: [] }, activeWriters: [{ name: c.name, buckets: [policy.bucketName] }],
    requestEvidence: [script + '/content/v2', script + '/settings', script + '/deployments', script + '/versions?page=1&per_page=100', bucket, bucket + '/lifecycle', prefix + '/workers/scripts'].map(path => ({ method: 'GET', path, sha256: hash(path) })) };
  const objects = i.objects.map(o => ({ key: o.key, size: i.currentHeads[0].payload.bytes, etag: 'actual-etag', custom_metadata: o.metadata }));
  const scan = { startedAt: at, completedAt: at, pageSize: 200, objects, pages: [{ cursor: null, nextCursor: null, count: objects.length, terminal: 'explicit', sha256: hash(canonical(objects)) }], listingSha256: hash(canonical(objects)) };
  const artifacts = await Promise.all([...i.exports, ...i.objects].map(async o => { const bytes = await readFile(join(f.dir, o.file)); return { file: o.file, bytes: bytes.length, sha256: hash(bytes) }; }));
  const p = i.currentHeads[0].payload, row = { id: 'm1', space_id: 's1', deleted_at: null, erased_at: null, revision: 1, payload_id: p.id, payload_shard_id: p.shardId, payload_object_key: p.objectKey, payload_sha256: p.sha256, payload_bytes: p.bytes };
  const reconciliation = { format: 1, capturedAt: at, sourceFingerprint: i.context.resourceFingerprint, central: { heads: [row], history: [], stages: [{ ...row, id: p.id, memory_id: 'm1' }], purges: [], erasures: [], accounts: [], emails: [], intents: [], retirements: [], lifecycle: { events: [], heads: [], receipts: [], proofs: [], guards: ['release_lifecycle_event_time','release_lifecycle_jwt_time'].map(name => { const sql = 'CREATE TRIGGER ' + name + ' BEFORE INSERT ON fixture BEGIN SELECT 1; END'; return { name, sql, sha256: hash(sql) }; }) } } };
  reconciliation.central.permanent = { providerRevocations: [], externalBlocks: [], domainBlocks: [], receipts: [], domains: [], revocations: [] };
  const body = { ...i }; delete body.capture;
  const evidence = { format: 2, mode: 'immutable-historical-cut-v1', startedAt: at, capturedAt: at, consistentAtCut: at, context: i.context, policy, sourceBefore: observation, sourceAfter: structuredClone(observation),
    before: { DB: 'd1-1', HOT_A: 'd1-2', HOT_B: 'd1-3' }, after: { DB: 'd1-1', HOT_A: 'd1-2', HOT_B: 'd1-3' }, scanA: scan, scanB: structuredClone(scan),
    downloads: objects.map(o => ({ key: o.key, bytes: o.size, sha256: o.custom_metadata.sha256, metadataSha256: hash(canonical(o.custom_metadata)), metadataBasis: 'matching-complete-scans', etag: o.etag })),
    artifacts, reconciliation: {}, inventoryBodySha256: hash(canonical(body)), complete: true,
    assumption: 'Coordinator excludes out-of-band administrative/S3 writers during this bounded interval; provider reads do not prove absence of global credentials.' };
  const saveHistorical = async () => {
    const bytes = Buffer.from(JSON.stringify(reconciliation)); await writeFile(join(f.dir, 'reconciliation.json'), bytes);
    evidence.reconciliation = { file: 'reconciliation.json', bytes: bytes.length, sha256: hash(bytes) };
    const record = Buffer.from(JSON.stringify(evidence)); await writeFile(join(f.dir, 'capture-evidence.json'), record);
    i.capture = { mode: evidence.mode, writesStopped: false, providersDrained: null, inventoryComplete: true, consistentAtCut: at, evidenceRef: 'capture-evidence.json', evidenceSha256: hash(record) };
    await f.save();
  };
  await saveHistorical(); return { ...f, evidence, reconciliation, saveHistorical };
}

test('historical cut preserves explicit unstopped semantics and hashes both evidence sidecars', async t => {
  const f = await historicalFixture(t), result = await f.prepare();
  assert.equal((await f.verify(result.manifestSha256)).status, 'verified');
  const manifest = JSON.parse(await readFile(f.manifestPath)); assert.equal(manifest.files.length, 6);
  assert.equal(manifest.inventory.capture.writesStopped, false); assert.equal(manifest.inventory.capture.providersDrained, null);
  await writeFile(join(f.dir, 'reconciliation.json'), '{}'); await assert.rejects(f.verify(result.manifestSha256), /hash|SHA|changed|reconciliation/i);
});
const defaultMultipartRule = () => ({ id: 'Default Multipart Abort Rule', enabled: true, conditions: {}, abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } } });
test('historical lifecycle evidence preserves the actual prefixless multipart-abort default', async t => {
  const f = await historicalFixture(t), rule = defaultMultipartRule();
  for (const observation of [f.evidence.sourceBefore, f.evidence.sourceAfter]) observation.bucket.lifecycleRules = [structuredClone(rule)];
  await f.saveHistorical(); const result = await f.prepare();
  assert.equal((await f.verify(result.manifestSha256)).status, 'verified');
  const retained = JSON.parse(await readFile(join(f.dir, 'capture-evidence.json')));
  assert.deepEqual(retained.sourceBefore.bucket.lifecycleRules, [rule]);
  assert.deepEqual(retained.sourceAfter.bucket.lifecycleRules, [rule]);
  assert.equal(Object.hasOwn(retained.sourceBefore.bucket.lifecycleRules[0].conditions, 'prefix'), false);
});
for (const [name, mutate] of [
  ['object deletion', r => { r.deleteObjectsTransition = { condition: { type: 'Age', maxAge: 86400 } }; }],
  ['storage transition', r => { r.storageClassTransitions = [{ storageClass: 'InfrequentAccess', condition: { type: 'Age', maxAge: 86400 } }]; }],
  ['unknown transition', r => { r.futureTransition = {}; }],
  ['missing abort', r => { delete r.abortMultipartUploadsTransition; }],
  ['missing condition', r => { r.abortMultipartUploadsTransition = {}; }],
  ['unknown abort field', r => { r.abortMultipartUploadsTransition.unknown = true; }],
  ['unknown age field', r => { r.abortMultipartUploadsTransition.condition.unknown = true; }],
  ['different condition', r => { r.abortMultipartUploadsTransition.condition = { type: 'Date', date: '2030-01-01' }; }],
  ['invalid age', r => { r.abortMultipartUploadsTransition.condition.maxAge = -1; }],
  ['unknown filter', r => { r.conditions.tag = 'unreviewed'; }],
  ['null prefix', r => { r.conditions.prefix = null; }],
]) test('historical lifecycle prefix omission refuses ' + name, async t => {
  const f = await historicalFixture(t), rule = defaultMultipartRule(); mutate(rule);
  for (const observation of [f.evidence.sourceBefore, f.evidence.sourceAfter]) observation.bucket.lifecycleRules = [structuredClone(rule)];
  await f.saveHistorical(); await assert.rejects(f.prepare(), /lifecycle/i);
});
for (const [name, mutate] of [
  ['changed primary bookmark', f => { f.evidence.after.DB = 'new'; }],
  ['incomplete terminal scan', f => { f.evidence.scanB.pages[0].terminal = null; }],
  ['overwritten payload', f => { f.evidence.scanB.objects[0].etag = 'changed'; }],
  ['missing object', f => { f.evidence.scanB.objects = []; }],
  ['download missing metadata binding', f => { delete f.evidence.downloads[0].metadataSha256; }],
  ['invented stopped assertion', f => { f.evidence.providersDrained = true; }],
  ['missing writer history', f => { f.evidence.policy.versions = []; }],
  ['unknown provider writer', f => { f.evidence.sourceAfter.activeWriters.push({ name: 'other', buckets: [f.evidence.policy.bucketName] }); }],
  ['expired coordinator interval', f => { f.evidence.policy.coordinator.expiresAt = f.inventory.capturedAt; }],
  ['missing lifecycle history', f => { delete f.reconciliation.central.lifecycle; }],
  ['missing standing revocations', f => { delete f.reconciliation.central.permanent; }],
  ['missing central history object', f => { f.reconciliation.central.history.push({ ...f.reconciliation.central.heads[0], payload_id: 'missing', payload_object_key: 'payload/v1/missing' }); }],
  ['evidence path traversal', f => { f.evidence.reconciliation.file = '../private.json'; }],
]) test('historical validator refuses ' + name, async t => {
  const f = await historicalFixture(t); mutate(f); await f.saveHistorical();
  // Preserve a deliberately modified sidecar path after the helper refreshes hashes.
  if (name === 'evidence path traversal') { f.inventory.capture.evidenceRef = '../private.json'; await f.save(); }
  await assert.rejects(f.prepare());
});

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

import { open, lstat, realpath, readdir, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseTree, getNodeValue } from 'jsonc-parser';
import { SERVICE_VERSION } from '../src/config.ts';
import { deploymentFingerprint, loadDeploymentConfiguration, PROJECT_DIRECTORY } from './deployment-config.mjs';
import { inspectGitSource } from './deployment-command.mjs';
import { HISTORICAL_MODE, validateHistoricalEvidence } from './recovery-consistency.mjs';

export class RecoveryError extends Error {}
const fail = message => { throw new RecoveryError(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const stamp = value => Number.isSafeInteger(value) && value > 0;
const refText = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const canonical = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value; }
function exact(value, keys) { if (!object(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('Unexpected or missing recovery fields. Do not include credentials.'); }
function entries(value, maximum = 10000) { if (!Array.isArray(value) || value.length > maximum) fail('Recovery inventory exceeds its item limit.'); return value; }
const RECORD_LIMIT = 32 * 1024 * 1024, FILE_LIMIT = 256 * 1024 * 1024, TOTAL_LIMIT = 2 * 1024 * 1024 * 1024;
export const RECOVERY_CHECKS = Object.freeze(['quarantine-isolation', 'credentials-invalidated', 'memberships-invalidated', 'identity-reconciled',
  'tombstones-reconciled', 'current-heads-reconciled', 'schema-inventory-consistency', 'indexes-rebuilt', 'key-recovery-tested', 'authority-negative-tests']);

function json(bytes) {
  let text, tree; const errors = [];
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); tree = parseTree(text, errors, { disallowComments: true }); }
  catch { fail('Recovery input must be bounded UTF-8 JSON.'); }
  if (errors.length || !tree || tree.type !== 'object') fail('Recovery input must be a JSON object.');
  const visit = (node, depth) => {
    if (depth > 64) fail('Recovery JSON nesting exceeds its limit.');
    if (node.type === 'object') {
      const names = new Set();
      for (const property of node.children ?? []) { const name = property.children[0].value; if (names.has(name)) fail('Duplicate recovery JSON key.'); names.add(name); }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(tree, 0); return getNodeValue(tree);
}
function inside(root, path) { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); }
function safePath(path) {
  if (typeof path !== 'string' || path.length > 512 || !/^[A-Za-z0-9_.\/-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
    fail('Artifact path must be a safe relative path without traversal or Windows streams.');
}
async function safeArtifact(root, path) {
  safePath(path); let current = root;
  for (const part of path.split('/')) { current = resolve(current, part); if ((await lstat(current)).isSymbolicLink()) fail('Symbolic links and junctions are not recovery artifacts.'); }
  const actual = await realpath(current); if (!inside(root, actual)) fail('Artifact path leaves the private bundle.'); return actual;
}
async function readBounded(path, maximum = RECORD_LIMIT) {
  if ((await lstat(path)).isSymbolicLink()) fail('Symbolic links are not recovery records.');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > maximum) fail('Recovery file exceeds its size limit or is not regular.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maximum + 1)); let length = 0;
    while (length < buffer.length) { const r = await file.read(buffer, length, buffer.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
    if (length !== stat.size || length > maximum) fail('Recovery file changed while reading.');
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}
async function fileDigest(root, path, maximum) {
  const file = await open(await safeArtifact(root, path), 'r');
  try {
    const before = await file.stat(); if (!before.isFile() || before.size > maximum) fail('Recovery artifact exceeds its size limit or is not regular.');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536); let bytes = 0;
    while (true) { const r = await file.read(buffer, 0, buffer.length, null); if (!r.bytesRead) break; bytes += r.bytesRead; if (bytes > maximum) fail('Recovery artifact exceeds its size limit.'); digest.update(buffer.subarray(0, r.bytesRead)); }
    const after = await file.stat(); if (before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('Recovery artifact changed while hashing.');
    return { path, bytes, sha256: digest.digest('hex') };
  } finally { await file.close(); }
}
async function privateDirectory(path) {
  const directory = await realpath(dirname(path)), repository = await realpath(resolve(PROJECT_DIRECTORY, '..'));
  if (inside(repository, directory)) fail('Keep recovery records outside the public repository.');
  return directory;
}
async function atomicOutput(path, value) {
  await privateDirectory(path);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); if (bytes.length > RECORD_LIMIT) fail('Recovery output exceeds its size limit.');
  const temporary = resolve(dirname(path), '.recovery-' + randomUUID() + '.tmp'); let file;
  try {
    file = await open(temporary, 'wx', 0o600); await file.writeFile(bytes); await file.sync(); await file.close(); file = undefined;
    // link is an atomic exclusive install: unlike rename it cannot overwrite an existing artifact.
    await link(temporary, path); return hash(bytes);
  } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
}
function resources(target) {
  return { worker: target.config.name, origin: target.settings.origin,
    d1: target.config.d1_databases.map(v => ({ binding: v.binding, id: v.database_id, name: v.database_name, previewId: v.preview_database_id ?? null })).sort((a, b) => a.binding.localeCompare(b.binding)),
    r2: (target.config.r2_buckets ?? []).map(v => ({ binding: v.binding, name: v.bucket_name, previewName: v.preview_bucket_name ?? null })),
    vectorize: (target.config.vectorize ?? []).map(v => v.index_name), analytics: (target.config.analytics_engine_datasets ?? []).map(v => v.dataset),
    shards: JSON.parse(target.config.vars.STORAGE_SHARDS_JSON) };
}
function context(target, source, schemas) {
  if (source.dirty || !/^[a-f0-9]{40}$/.test(source.revision)) fail('Recovery validation requires clean, pinned source.');
  if (target.config.vars.STORAGE_MODE !== 'sharded' || schemas.centralSchemaVersion < 22 || schemas.hotSchemaVersion < 1) fail('Inline and pre-sharding backups require a separate offline migration; they cannot restore a live sharded service.');
  return { releaseVersion: SERVICE_VERSION, sourceRevision: source.revision, environment: target.environment, origin: target.settings.origin, resourceFingerprint: deploymentFingerprint(target.config), ...schemas };
}
function payload(ref, shardIds) {
  exact(ref, ['id', 'shardId', 'objectKey', 'sha256', 'bytes']);
  if (!identifier(ref.id) || !shardIds.has(ref.shardId) || ref.objectKey !== 'payload/v1/' + ref.id || !sha(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 131072) fail('Invalid payload locator or unknown shard.');
}
function bindingContext(value) { if (!identifier(value.spaceId) || !identifier(value.memoryId)) fail('Invalid payload context.'); }
function sameObject(value, ref, ctx) { return value.key === ref.objectKey && value.metadata.payloadId === ref.id && value.metadata.shardId === ref.shardId && value.metadata.sha256 === ref.sha256 && value.metadata.spaceId === ctx.spaceId && value.metadata.memoryId === ctx.memoryId; }
async function validateInventory(inventory, expected, target, root, now) {
  exact(inventory, ['format', 'context', 'capturedAt', 'capture', 'exports', 'objects', 'currentHeads', 'hotTombstones', 'pendingPurges']);
  if (inventory.format !== 1 || canonical(inventory.context) !== canonical(expected)) fail('Recovery source, schema or configuration does not match the current pinned target.');
  if (!stamp(inventory.capturedAt) || inventory.capturedAt > now) fail('Invalid capture time.');
  const historical = inventory.capture?.mode === HISTORICAL_MODE;
  if (!historical) {
    exact(inventory.capture, ['writesStopped', 'inventoryComplete', 'evidenceRef']);
    if (inventory.capture.writesStopped !== true || inventory.capture.inventoryComplete !== true || !refText(inventory.capture.evidenceRef)) fail('A fenced, complete capture and its operator evidence are required.');
  }
  const paths = new Set(), files = [], shardIds = new Set(JSON.parse(target.config.vars.STORAGE_SHARDS_JSON).map(v => v.id)); let total = 0;
  const addFile = async (path, limit = FILE_LIMIT) => {
    safePath(path); const key = path.toLowerCase(); if (paths.has(key)) fail('Duplicate artifact path.'); paths.add(key);
    const result = await fileDigest(root, path, limit); total += result.bytes; if (total > TOTAL_LIMIT) fail('Recovery bundle exceeds its total size limit.'); files.push(result); return result;
  };
  const expectedBindings = new Set(['DB', ...target.hotBindings]), exportBindings = new Set();
  for (const item of entries(inventory.exports, 17)) { exact(item, ['binding', 'file']); if (!expectedBindings.has(item.binding) || exportBindings.has(item.binding)) fail('Unknown or duplicate database export binding.'); exportBindings.add(item.binding); const result = await addFile(item.file); if (!result.bytes) fail('Database export must not be empty.'); }
  if (exportBindings.size !== expectedBindings.size) fail('Every central and hot database requires an export.');
  const objects = new Map();
  for (const item of entries(inventory.objects)) {
    exact(item, ['key', 'file', 'metadata']); exact(item.metadata, ['payloadId', 'shardId', 'spaceId', 'memoryId', 'sha256', 'state']);
    const m = item.metadata; bindingContext(m);
    if (!identifier(m.payloadId) || !shardIds.has(m.shardId) || item.key !== 'payload/v1/' + m.payloadId || !sha(m.sha256) || !['payload', 'purged'].includes(m.state) || objects.has(item.key)) fail('Invalid or duplicate R2 inventory object.');
    const digest = await addFile(item.file, 131072);
    if (m.state === 'purged') { if (digest.bytes !== 0) fail('Purged R2 tombstones must remain zero-byte objects.'); }
    else {
      if (digest.sha256 !== m.sha256) fail('R2 payload SHA-256 integrity mismatch.');
      const bytes = await readBounded(await safeArtifact(root, item.file), 131072), content = json(bytes);
      exact(content, ['body', 'provenance', 'source']);
      if (typeof content.body !== 'string' || !object(content.provenance) || !(content.source === null || typeof content.source === 'string') || canonical(content) !== bytes.toString('utf8') || hash(bytes) !== digest.sha256) fail('R2 payload is not canonical content or changed during validation.');
    }
    objects.set(item.key, { ...item, bytes: digest.bytes });
  }
  const retired = new Map();
  for (const item of entries(inventory.hotTombstones)) {
    exact(item, ['payloadId', 'shardId', 'spaceId', 'memoryId', 'retiredAt']); bindingContext(item);
    if (!identifier(item.payloadId) || !shardIds.has(item.shardId) || !stamp(item.retiredAt) || item.retiredAt > inventory.capturedAt || retired.has(item.payloadId)) fail('Invalid or duplicate hot tombstone.');
    const cold = objects.get('payload/v1/' + item.payloadId);
    if (cold && (cold.metadata.spaceId !== item.spaceId || cold.metadata.memoryId !== item.memoryId || cold.metadata.shardId !== item.shardId)) fail('Tombstone context mismatch.'); retired.set(item.payloadId, item);
  }
  const purges = new Set();
  for (const item of entries(inventory.pendingPurges)) {
    exact(item, ['spaceId', 'memoryId', 'payload']); bindingContext(item); payload(item.payload, shardIds);
    if (purges.has(item.payload.id)) fail('Duplicate pending purge.'); purges.add(item.payload.id);
    const cold = objects.get(item.payload.objectKey); if (cold && !sameObject(cold, item.payload, item)) fail('Pending purge context mismatch.');
    const tombstone = retired.get(item.payload.id);
    if (tombstone && (tombstone.spaceId !== item.spaceId || tombstone.memoryId !== item.memoryId || tombstone.shardId !== item.payload.shardId)) fail('Pending purge and tombstone context mismatch.');
  }
  const memories = new Set(), payloadIds = new Set();
  for (const item of entries(inventory.currentHeads)) {
    exact(item, ['spaceId', 'memoryId', 'revision', 'payload']); bindingContext(item); payload(item.payload, shardIds);
    const memoryKey = canonical([item.spaceId, item.memoryId]), cold = objects.get(item.payload.objectKey);
    if (!Number.isSafeInteger(item.revision) || item.revision < 1 || memories.has(memoryKey) || payloadIds.has(item.payload.id)) fail('Invalid or duplicate current memory head.');
    if (!cold || !sameObject(cold, item.payload, item) || cold.metadata.state !== 'payload' || cold.bytes !== item.payload.bytes || retired.has(item.payload.id) || purges.has(item.payload.id)) fail('Current head is missing, inconsistent, retired or erased; reconcile capture before recovery.');
    memories.add(memoryKey); payloadIds.add(item.payload.id);
  }
  if (historical) {
    const artifacts = files.slice(), record = await addFile(inventory.capture.evidenceRef, RECORD_LIMIT);
    if (record.sha256 !== inventory.capture.evidenceSha256) fail('Historical evidence SHA-256 mismatch.');
    const bytes = await readBounded(await safeArtifact(root, record.path));
    if (hash(bytes) !== record.sha256) fail('Historical evidence changed while reading.');
    const evidence = json(bytes), sidecar = await addFile(evidence.reconciliation?.file, RECORD_LIMIT);
    if (sidecar.sha256 !== evidence.reconciliation.sha256 || sidecar.bytes !== evidence.reconciliation.bytes) fail('Reconciliation artifact hash/size mismatch.');
    const reconciliation = await readBounded(await safeArtifact(root, sidecar.path));
    if (hash(reconciliation) !== sidecar.sha256) fail('Reconciliation changed while reading.');
    validateHistoricalEvidence(evidence, inventory, target.config, artifacts, json(reconciliation));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function isolated(source, destination) {
  if (destination.environment !== 'staging' || destination.config.vars.RELEASE_MODE !== 'pilot' || destination.config.vars.STORAGE_MODE !== 'sharded') fail('Recovery destination must be isolated staging, sharded and pilot; production/GA restore is forbidden.');
  const a = resources(source), b = resources(destination);
  if (a.worker === b.worker || a.origin === b.origin) fail('Recovery destination Worker and origin must be isolated.');
  const sets = r => [r.d1.flatMap(v => [v.id, v.name, v.previewId]).filter(Boolean).map(v => v.toLowerCase()), r.r2.flatMap(v => [v.name, v.previewName]).filter(Boolean), r.vectorize, r.analytics];
  const original = sets(a), restored = sets(b);
  if (original.some((set, i) => restored[i].some(value => set.includes(value)))) fail('Recovery destination resource overlap is forbidden. Never overwrite live R2 from an older backup.');
  if (canonical(a.shards) !== canonical(b.shards)) fail('Quarantine must preserve logical shard IDs, bindings and modes; only physical resources may change.');
}
async function evidenceChecks(evidence, manifestHash, destination, capturedAt, now, root) {
  exact(evidence, ['format', 'manifestSha256', 'destinationFingerprint', 'observedAt', 'checks', 'measurements']);
  if (evidence.format !== 1 || evidence.manifestSha256 !== manifestHash || evidence.destinationFingerprint !== deploymentFingerprint(destination.config) || !stamp(evidence.observedAt) || evidence.observedAt < capturedAt || evidence.observedAt > now) fail('Drill evidence does not bind this manifest, destination or observation time.');
  const seen = new Set(), verified = [];
  for (const check of entries(evidence.checks, RECOVERY_CHECKS.length)) {
    exact(check, ['id', 'outcome', 'evidenceRef', 'evidenceFile', 'evidenceSha256']);
    if (!RECOVERY_CHECKS.includes(check.id) || seen.has(check.id) || check.outcome !== 'passed' || !refText(check.evidenceRef) || !sha(check.evidenceSha256)) fail('All quarantine reconciliation checks require explicit passed evidence.');
    seen.add(check.id);
    const bytes = await readBounded(await safeArtifact(root, check.evidenceFile), 1048576);
    if (hash(bytes) !== check.evidenceSha256) fail('Drill evidence SHA-256 mismatch.');
    const observed = json(bytes);
    exact(observed, ['format', 'check', 'outcome', 'manifestSha256', 'destinationFingerprint', 'observedAt', 'checks']);
    if (observed.format !== 1 || observed.check !== check.id || observed.outcome !== 'passed' || observed.manifestSha256 !== manifestHash ||
        observed.destinationFingerprint !== evidence.destinationFingerprint || !stamp(observed.observedAt) || observed.observedAt < capturedAt || observed.observedAt > evidence.observedAt ||
        !entries(observed.checks, 1000).length || observed.checks.some(v => { exact(v, ['name', 'outcome']); return !refText(v.name) || v.outcome !== 'passed'; }))
      fail('Drill evidence must contain passed observations for this exact manifest and destination.');
    verified.push({ id: check.id, outcome: 'passed', evidenceRef: check.evidenceRef, evidenceSha256: check.evidenceSha256 });
  }
  if (seen.size !== RECOVERY_CHECKS.length) fail('All quarantine reconciliation checks require explicit passed evidence.');
  exact(evidence.measurements, ['rpoSeconds', 'rtoSeconds']);
  if (Object.values(evidence.measurements).some(v => !Number.isFinite(v) || v < 0 || v > 31536000)) fail('Record actual finite nonnegative measured RPO/RTO seconds.');
  return { ...evidence, checks: verified };
}
function argsFor(argv) {
  const [mode, ...args] = argv, permitted = { prepare: ['--config', '--inventory', '--out'], verify: ['--config', '--manifest', '--sha256'], 'drill-plan': ['--config', '--manifest', '--sha256', '--destination', '--quarantine', '--out', '--evidence'] };
  if (!Object.hasOwn(permitted, mode)) fail('Choose prepare, verify or drill-plan.');
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; if (!permitted[mode].includes(key) || Object.hasOwn(values, key)) fail('Unsupported or repeated recovery argument. No values are forwarded.');
    if (key === '--quarantine') { values[key] = true; continue; }
    const value = args[++i]; if (!value || value.startsWith('-') || /[\x00-\x1f]/.test(value)) fail('Recovery argument requires a file path or digest.'); values[key] = value;
  }
  const required = permitted[mode].filter(key => key !== '--evidence');
  if (required.some(key => !values[key])) fail('Provide every explicit source/config/output argument and quarantine for a drill.');
  if (mode !== 'prepare' && !sha(values['--sha256'])) fail('Provide the independently recorded manifest SHA-256.');
  return { mode, values };
}
async function sourceSchemas() {
  const latest = async folder => { const versions = (await readdir(resolve(PROJECT_DIRECTORY, folder))).filter(name => /^\d{4}_.+\.sql$/.test(name)).map(name => Number(name.slice(0, 4))); if (!versions.length) fail('Source migrations unavailable.'); return Math.max(...versions); };
  return { centralSchemaVersion: await latest('migrations'), hotSchemaVersion: await latest('shard-migrations') };
}
export async function runRecoveryCommand(argv, { cwd = process.cwd(), inspectSource = inspectGitSource, schemas, clock = Date.now, processEnvironment = process.env } = {}) {
  const { mode, values } = argsFor(argv), load = async path => {
    await readBounded(resolve(cwd, path), 1048576);
    return loadDeploymentConfiguration({ configPath: path, cwd, processEnvironment });
  };
  const target = await load(values['--config']), source = await inspectSource(), expected = context(target, source, schemas ?? await sourceSchemas());
  const input = resolve(cwd, values[mode === 'prepare' ? '--inventory' : '--manifest']), root = await privateDirectory(input);
  const raw = await readBounded(input); let inventory, manifest, manifestHash;
  if (mode === 'prepare') inventory = json(raw);
  else {
    if (hash(raw) !== values['--sha256']) fail('Manifest SHA-256 mismatch.');
    manifestHash = hash(raw); manifest = json(raw); exact(manifest, ['format', 'kind', 'createdAt', 'resources', 'inventory', 'files']);
    if (manifest.format !== 1 || manifest.kind !== 'memory-multi-store-backup' || !stamp(manifest.createdAt) || manifest.createdAt > clock() || canonical(manifest.resources) !== canonical(resources(target))) fail('Invalid manifest or changed source resources.');
    inventory = manifest.inventory;
  }
  const files = await validateInventory(inventory, expected, target, root, clock());
  if (manifest && canonical(files) !== canonical(manifest.files)) fail('Artifact hash or size changed since capture.');
  let output;
  if (mode === 'prepare') output = { format: 1, kind: 'memory-multi-store-backup', createdAt: clock(), resources: resources(target), inventory, files };
  if (mode === 'drill-plan') {
    const destination = await load(values['--destination']); isolated(target, destination);
    let evidence;
    if (values['--evidence']) {
      const path = resolve(cwd, values['--evidence']), directory = await privateDirectory(path);
      evidence = await evidenceChecks(json(await readBounded(path, 1048576)), manifestHash, destination, inventory.capturedAt, clock(), directory);
    }
    output = { format: 1, kind: 'memory-quarantine-drill', manifestSha256: manifestHash, context: expected, destination: resources(destination), destinationFingerprint: deploymentFingerprint(destination.config),
      quarantine: true, promotionAllowed: false, status: evidence ? 'evidence-verified' : 'evidence-pending',
      measurements: evidence?.measurements ?? { rpoSeconds: null, rtoSeconds: null },
      checks: evidence?.checks ?? RECOVERY_CHECKS.map(id => ({ id, outcome: 'pending', evidenceRef: '' })),
      preserve: { r2Purged: inventory.objects.filter(v => v.metadata.state === 'purged').length, hotTombstones: inventory.hotTombstones.length, pendingPurges: inventory.pendingPurges.length },
      rebuild: { currentHeads: inventory.currentHeads.length, authority: 'reconciled central current heads plus authoritative R2 inventory; never blindly import HOT exports' },
      steps: ['Keep destination routes, sign-in, jobs and all outbound providers isolated; prove isolation independently of pilot mode.',
        'Restore central export only into isolated DB; invalidate restored credentials, sessions, proofs and memberships before any user access.',
        'Quarantine every unpublished payload intent as durable purge-pending work; a pre-capture preparation must never publish on restored authority.',
        'Reconcile current central identity revocations, ACLs, retention and erasure state against independent post-capture evidence.',
        'Restore R2 payloads only into the isolated empty bucket; merge all later purge markers and pending erasures first. Never overwrite a live bucket.',
        'Preserve HOT tombstones, reconstruct current eligible payloads from verified R2/current heads, then rebuild FTS and Vectorize under reconciled authority.',
        'Test negative authority and payload erasure, decrypt retained temporary material with the recovered key, and measure RPO/RTO.',
        'Submit actual private drill evidence to the multi-store-recovery GA gate. This plan cannot promote or deploy.'] };
    const latestDestination = await load(values['--destination']); if (deploymentFingerprint(latestDestination.config) !== deploymentFingerprint(destination.config)) fail('Destination changed during validation.');
  }
  const latestSource = await inspectSource(), latestTarget = await load(values['--config']);
  if (latestSource.dirty || latestSource.revision !== source.revision || deploymentFingerprint(latestTarget.config) !== expected.resourceFingerprint) fail('Source or configuration changed during recovery validation.');
  if (output) {
    const out = resolve(cwd, values['--out']);
    if (mode === 'prepare' && await privateDirectory(out) !== root) fail('Manifest must stay beside its inventory and relative artifacts.');
    const outputHash = await atomicOutput(out, output); if (mode === 'prepare') manifestHash = outputHash;
  }
  return { status: mode === 'prepare' ? 'prepared' : mode === 'verify' ? 'verified' : output.status, manifestSha256: manifestHash, artifactCount: files.length, quarantine: mode === 'drill-plan', promotionAllowed: false };
}

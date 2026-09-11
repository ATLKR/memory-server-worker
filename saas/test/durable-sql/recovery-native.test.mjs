import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { openLocalDatabase } from '../../dev/sqlite.mjs';
import { WorkspaceService } from '../../src/workspace.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { createDurableDatabase } from '../../src/durable-sql/client.ts';
import { validateSnapshotPlan } from '../../src/durable-sql/snapshot.ts';
import { encryptSnapshotBackup, decryptSnapshotBackup } from '../../src/durable-sql/backup.ts';
import { exportDurableSnapshot } from '../../scripts/durable-snapshot.mjs';

const importKeys = generateKeyPairSync('ed25519'), recoveryKeys = generateKeyPairSync('ed25519');
const publicKey = keys => keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
// This independent canonicalizer/hash keeps the wire assertions independent
// of the production recovery implementation and its hashing helpers.
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const hash = value => bytesHash(Buffer.from(canonical(value)));
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const identity = (databaseId = 'control', kind = 'control', epoch = 1) => ({ deploymentId: 'recovery-native', databaseId, kind, epoch });
const objectName = value => `sql:${value.deploymentId}:${value.databaseId}:${value.epoch}`;
const sourceRevision = 'a'.repeat(40);
const actions = { freezeRecovery: 'freeze', recoveryStatus: 'status', prepareRecoveryExport: 'prepare-export',
  readRecoveryManifest: 'manifest-page', readRecoveryChunk: 'chunk', releaseRecovery: 'release' };
const signed = (payload, keys) => ({ ...payload, signature: sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString('base64url') });
function importGrant(plan) {
  return signed({ planHash: hash(plan), notBeforeMs: Date.now() - 5000, expiresAtMs: Date.now() + 600000 }, importKeys);
}
function recoveryGrant(method, input, changes = {}, keys = recoveryKeys) {
  return signed({ domain: 'memory-sql-recovery-v1', action: actions[method], identity: input.identity, runId: input.runId,
    requestHash: hash(input), notBeforeMs: Date.now() - 5000, expiresAtMs: Date.now() + 600000, ...changes }, keys);
}
function freezeInput(value, runId = '1'.repeat(24)) { return { version: 1, identity: value, runId, sourceRevision }; }
function scopeOf(input) { return { identity: input.identity, runId: input.runId, freezeRequestHash: hash(input) }; }

const bridge = `
import {Hono} from 'hono';
const app=new Hono();
app.post('/',async c=>{
 const {identity,method,input,grant}=await c.req.json();
 if(!['execute','beginImport','appendImport','sealImport','abandonImport','freezeRecovery','recoveryStatus',
 'prepareRecoveryExport','readRecoveryManifest','readRecoveryChunk','releaseRecovery','legacySeed','legacyState','testControl'].includes(method))
   return c.json({error:'fixture_method'},400);
 const stub=c.env.SQL.getByName('sql:'+identity.deploymentId+':'+identity.databaseId+':'+identity.epoch);
 try{return c.json({value:await stub[method](input,grant)});}
 catch(error){return c.json({error:error.message},400);}
});
export default app;`;
async function bundle(source) {
  return (await build({ stdin: { contents: source + bridge, resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    sourcefile: 'recovery-native-operator.mjs' }, bundle: true, write: false, format: 'esm', platform: 'neutral',
    target: 'es2022', external: ['cloudflare:workers'] })).outputFiles[0].text;
}
const script = await bundle("export {MemorySqlDatabase} from '../../src/durable-sql/object.ts';\n");

async function native(t, { persist = false, recoveryPublicKey = publicKey(recoveryKeys), initialScript = script } = {}) {
  const path = persist ? await mkdtemp(join(tmpdir(), 'memory-recovery-native-')) : undefined;
  let mf;
  const start = content => { mf = new Miniflare(convertV4MiniflareOptions({ name: 'recovery-native', modules: true,
    compatibilityDate: '2026-09-08', script: content, bindings: { MEMORY_SQL_IMPORT_PUBLIC_KEY: publicKey(importKeys),
      ...(recoveryPublicKey === null ? {} : { MEMORY_SQL_RECOVERY_PUBLIC_KEY: recoveryPublicKey }) },
    durableObjects: { SQL: { className: 'MemorySqlDatabase', useSQLite: true } },
    ...(path ? { resourcePersistencePath: path } : {}), outboundService: () => new Response('outbound disabled', { status: 503 }) })); };
  start(initialScript);
  t.after(async () => { await mf.dispose(); if (path) {
    const target = resolve(path), root = resolve(tmpdir());
    assert.ok(target.startsWith(root + sep)); assert.ok(target.slice(root.length + 1).startsWith('memory-recovery-native-'));
    await rm(target, { recursive: true, force: true });
  } });
  function object(value) {
    const call = async (method, input, grant, routedIdentity = value) => {
      const response = await mf.dispatchFetch('https://fixture.test/', { method: 'POST',
        body: JSON.stringify({ identity: routedIdentity, method, input, grant }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error); return body.value;
    };
    return { identity: value, call,
      recovery: (method, input) => call(method, input, recoveryGrant(method, input)),
      db: createDurableDatabase({ execute: input => call('execute', input) }, value),
      async restore(snapshot) {
        const grant = importGrant(snapshot.plan);
        await call('beginImport', snapshot.plan, grant);
        for (const chunk of snapshot.chunks) await call('appendImport', chunk, grant);
        return call('sealImport', { planHash: hash(snapshot.plan) }, grant);
      },
    };
  }
  return { object, async restart(content = script) { await mf.dispose(); start(content); } };
}
function readOnly(raw) {
  return { withSession(constraint) {
    assert.equal(constraint, 'first-primary');
    return { prepare(sql) {
      assert.match(sql, /^(SELECT|PRAGMA)\b/i);
      return { bind(...values) { return { async all() { return { success: true, results: raw.prepare(sql).all(...values) }; } }; } };
    } };
  } };
}
async function initialSnapshot(raw, value) {
  return exportDurableSnapshot(readOnly(raw), { identity: value, sourceRevision, sourceFrozenAtMs: Date.now() - 1000,
    freeze: { confirmed: true, evidenceRef: 'fixture:in-memory-writers-stopped' } });
}
function synthetic(t) {
  const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
  raw.exec(`CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT);
    INSERT INTO records(id,value) VALUES(2,'initial'),(9,'retire');
    CREATE TABLE empty_records(id TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE record_history(id INTEGER PRIMARY KEY AUTOINCREMENT,record_id INTEGER,previous TEXT);
    CREATE TRIGGER record_history_update AFTER UPDATE ON records BEGIN
      INSERT INTO record_history(record_id,previous) VALUES(OLD.id,OLD.value); END;`);
  return raw;
}
function rebind(snapshot, value) {
  const plan = structuredClone(snapshot.plan); plan.identity = value;
  const planHash = hash(plan);
  return { plan, chunks: snapshot.chunks.map(chunk => ({ planHash, index: chunk.index, rows: structuredClone(chunk.rows) })) };
}
async function release(source, scope, expectedPlanHash = null, decision = 'operator-abort') {
  const input = { ...scope, expectedPlanHash, decision, evidenceHash: 'e'.repeat(64) };
  return { input, receipt: await source.recovery('releaseRecovery', input) };
}
async function readTables(source, tables) {
  const results = new Map();
  for (const table of tables) {
    const rows = await source.db.prepare(`SELECT ${table.columns.map(column => quote(column) + ' AS ' + quote(column)).join(',')} FROM ${quote(table.name)} ORDER BY rowid`).all();
    results.set(table.name, rows.results.map(row => table.columns.map(column => row[column])));
  }
  return results;
}
async function exportCurrent(source, scope) {
  const summary = await source.recovery('prepareRecoveryExport', scope);
  assert.equal(summary.version, 1);
  assert.deepEqual(summary.identity, source.identity);
  assert.equal(summary.runId, scope.runId);
  assert.equal(summary.freezeRequestHash, scope.freezeRequestHash);
  assert.ok(summary.planBytes > 0 && summary.planBytes <= 1048576);
  assert.equal(summary.manifestPages, Math.ceil(summary.planBytes / 262144));
  const pages = [], rawPages = [];
  // Out-of-order reads must be deterministic and have no advancing cursor.
  for (let pageIndex = summary.manifestPages - 1; pageIndex >= 0; pageIndex--) {
    const input = { ...scope, planHash: summary.planHash, pageIndex };
    const page = await source.recovery('readRecoveryManifest', input);
    assert.deepEqual({ identity: page.identity, runId: page.runId, freezeRequestHash: page.freezeRequestHash,
      planHash: page.planHash, pageIndex: page.pageIndex }, input);
    const bytes = Buffer.from(page.data, 'base64url');
    assert.equal(bytes.toString('base64url'), page.data);
    assert.equal(bytes.byteLength, page.bytes);
    assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 262144);
    assert.equal(bytesHash(bytes), page.sha256);
    pages[pageIndex] = page; rawPages[pageIndex] = bytes;
  }
  const serialized = Buffer.concat(rawPages);
  assert.equal(serialized.byteLength, summary.planBytes);
  assert.equal(bytesHash(serialized), summary.planHash);
  const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(serialized));
  assert.equal(serialized.toString(), canonical(plan));
  validateSnapshotPlan(plan, objectName(source.identity));
  assert.deepEqual(plan.identity, source.identity);
  assert.equal(plan.sourceFrozenAtMs, summary.sourceFrozenAtMs);
  assert.equal(plan.sourceRevision, sourceRevision);
  assert.equal(hash(plan.schema), plan.schemaHash);
  assert.equal(hash({ tables: plan.tables, chunks: plan.chunks }), plan.snapshotHash);
  assert.equal(summary.schemaHash, plan.schemaHash);
  assert.equal(summary.snapshotHash, plan.snapshotHash);
  assert.equal(summary.chunkCount, plan.chunks.length);
  assert.ok(!plan.schema.some(item => /^(durable_sql_|__cf_|sqlite_)/i.test(item.name)));
  assert.ok(!plan.tables.some(table => /^(durable_sql_|__cf_)/i.test(table.name)));
  const chunks = [], parts = [];
  for (let index = plan.chunks.length - 1; index >= 0; index--) {
    const input = { ...scope, planHash: summary.planHash, index }, descriptor = plan.chunks[index];
    const part = await source.recovery('readRecoveryChunk', input);
    assert.deepEqual({ identity: part.identity, runId: part.runId, freezeRequestHash: part.freezeRequestHash,
      planHash: part.planHash, index: part.index }, input);
    assert.equal(part.version, 1);
    assert.equal(hash(part.rows), descriptor.hash);
    assert.equal(part.hash, descriptor.hash);
    assert.equal(part.rows.length, descriptor.rowCount);
    assert.ok(part.rows.length <= 500);
    assert.ok(Buffer.byteLength(canonical(part.rows)) <= 524288);
    assert.ok(Buffer.byteLength(canonical(part)) <= 614400);
    parts[index] = part;
    chunks[index] = { planHash: summary.planHash, index, rows: part.rows };
  }
  assert.equal(summary.rowCount, plan.tables.reduce((sum, table) => sum + table.rowCount, 0));
  assert.equal(summary.rowBytes, chunks.reduce((sum, chunk) => sum + Buffer.byteLength(canonical(chunk.rows)), 0));
  return { plan, chunks, summary, pages, parts };
}
function bundleRows(snapshot, table) {
  return snapshot.chunks.filter(chunk => snapshot.plan.chunks[chunk.index].table === table).flatMap(chunk => chunk.rows);
}

async function controlFixture(t) {
  let now = Date.now() - 86400000;
  const fixture = openLocalDatabase({ workspace: true, release: true, clock: () => now });
  t.after(() => fixture.close());
  const workspace = new WorkspaceService(fixture.db, () => now, { identityLifecycle: true });
  const memory = new MemoryStore(fixture.db, () => now);
  const principal = subject => ({ issuer: 'https://recovery.invalid', subject, permission: 'write', issuedAt: now, expiresAt: now + 900000 });
  const expired = await workspace.signIn(principal('owner'));
  const space = (await workspace.snapshot(expired.token)).spaces[0];
  const original = await memory.create(expired.token, space.id, { body: 'Historical recovery alpha' }, 'initial-memory');
  now = Date.now();
  const owner = await workspace.signIn(principal('owner')), other = await workspace.signIn(principal('other'));
  fixture.raw.exec(`CREATE TABLE recovery_fixture_values(id INTEGER PRIMARY KEY,value TEXT,nullable TEXT);
    INSERT INTO recovery_fixture_values VALUES(-8,'old',NULL),(1001,'remove','present');
    CREATE TABLE recovery_fixture_empty(id TEXT PRIMARY KEY);
    CREATE TRIGGER recovery_fixture_guard BEFORE INSERT ON recovery_fixture_values WHEN NEW.id=999
    BEGIN SELECT RAISE(ABORT,'fixture_runtime_guard'); END;`);
  return { ...fixture, owner, other, expired, space, memoryId: original.id };
}

test('native signed freeze denies whole subsequent SQL batches and keeps its receipt across restart and release replay', { timeout: 45000 }, async t => {
  const f = await native(t, { persist: true }), source = f.object(identity());
  const initial = await initialSnapshot(synthetic(t), source.identity);
  await source.restore(initial);
  await source.db.batch([source.db.prepare("UPDATE records SET value='committed' WHERE id=2"), source.db.prepare('DELETE FROM records WHERE id=9')]);
  const input = freezeInput(source.identity), scope = scopeOf(input);
  const receipt = await source.recovery('freezeRecovery', input);
  assert.equal(receipt.importPlanHash, hash(initial.plan));
  assert.equal(receipt.freezeRequestHash, hash(input));
  assert.equal(receipt.sourceRevision, sourceRevision);
  assert.ok(Number.isSafeInteger(receipt.frozenAtMs));
  assert.deepEqual(await source.recovery('freezeRecovery', input), receipt);
  await assert.rejects(source.db.prepare('SELECT 1').all(), /durable_sql_frozen/);
  await assert.rejects(source.db.prepare('SELECT * FROM empty_records').all(), /durable_sql_frozen/);
  await assert.rejects(source.db.batch([source.db.prepare("INSERT INTO records(value) VALUES('denied')"),
    source.db.prepare("UPDATE records SET value='denied' WHERE id=2")]), /durable_sql_frozen/);
  const originalGrant = importGrant(initial.plan);
  for (const [method, value] of [['beginImport', initial.plan], ['appendImport', initial.chunks[0]],
    ['sealImport', { planHash: hash(initial.plan) }], ['abandonImport', { planHash: hash(initial.plan) }]])
    await assert.rejects(source.call(method, value, originalGrant), /durable_sql_frozen|recovery_conflict/);
  await f.restart();
  assert.deepEqual((await source.recovery('recoveryStatus', scope)).receipt, receipt);
  await assert.rejects(source.db.prepare('SELECT 1').all(), /durable_sql_frozen/);
  const completed = await release(source, scope);
  assert.deepEqual((await source.db.prepare('SELECT id,value FROM records').all()).results, [{ id: 2, value: 'committed' }]);
  assert.equal((await source.db.prepare('SELECT count(*) AS n FROM record_history').first()).n, 1);
  await assert.rejects(source.recovery('freezeRecovery', input), /recovery_closed/);
  await assert.rejects(source.recovery('releaseRecovery', { ...completed.input, evidenceHash: 'f'.repeat(64) }), /recovery_conflict|recovery_closed/);
  const later = freezeInput(source.identity, '2'.repeat(24)), laterScope = scopeOf(later);
  await source.recovery('freezeRecovery', later);
  assert.deepEqual(await source.recovery('releaseRecovery', completed.input), completed.receipt);
  await assert.rejects(source.db.prepare('SELECT 1').all(), /durable_sql_frozen/);
  assert.equal((await source.recovery('recoveryStatus', laterScope)).state, 'frozen');
  await release(source, laterScope);
});

test('native full control recovery exports current committed rows and restores every table, history and FTS into a distinct signed identity', { timeout: 60000 }, async t => {
  const seed = await controlFixture(t), f = await native(t, { persist: true });
  const source = f.object(identity()), target = f.object(identity('restored-control', 'control', 2));
  const initial = await initialSnapshot(seed.raw, source.identity);
  await source.restore(initial);
  const memory = new MemoryStore(source.db);
  await memory.update(seed.owner.token, seed.space.id, seed.memoryId,
    { expectedRevision: 1, body: 'Current recovered beta 한글' }, 'post-import-memory');
  await memory.create(seed.owner.token, seed.space.id, { body: 'New post-import survivor' }, 'post-import-survivor');
  await source.db.batch([source.db.prepare("UPDATE recovery_fixture_values SET value='changed 한글' WHERE id=-8"),
    source.db.prepare('DELETE FROM recovery_fixture_values WHERE id=1001'),
    source.db.prepare("INSERT INTO recovery_fixture_values VALUES(6001,'inserted',NULL)")]);
  const expected = await readTables(source, initial.plan.tables);
  assert.deepEqual(expected.get('recovery_fixture_values'), [[-8, -8, 'changed 한글', null], [6001, 6001, 'inserted', null]]);
  assert.deepEqual(expected.get('recovery_fixture_empty'), []);
  const input = freezeInput(source.identity), scope = scopeOf(input);
  const receipt = await source.recovery('freezeRecovery', input);
  const exported = await exportCurrent(source, scope);
  assert.notEqual(exported.plan.snapshotHash, initial.plan.snapshotHash, 'The old import hash cannot prove current data');
  assert.equal(exported.plan.sourceFrozenAtMs, receipt.frozenAtMs);
  for (const table of exported.plan.tables) assert.deepEqual(bundleRows(exported, table.name), expected.get(table.name), table.name);
  assert.ok(exported.plan.tables.find(table => table.name === 'memory_versions').rowCount > 0);
  assert.ok(exported.plan.schema.some(item => item.name === 'recovery_fixture_guard'));
  assert.deepEqual(await source.recovery('prepareRecoveryExport', scope), exported.summary);
  await f.restart();
  assert.deepEqual((await source.recovery('recoveryStatus', scope)).exportSummary, exported.summary);
  for (const page of exported.pages) assert.deepEqual(await source.recovery('readRecoveryManifest',
    { ...scope, planHash: exported.summary.planHash, pageIndex: page.pageIndex }), page);
  for (const part of exported.parts) assert.deepEqual(await source.recovery('readRecoveryChunk',
    { ...scope, planHash: exported.summary.planHash, index: part.index }), part);
  await assert.rejects(source.db.prepare('SELECT 1').all(), /durable_sql_frozen/);
  const sourceBundle = { plan: exported.plan, chunks: exported.chunks };
  const backupIdentity = { runId: scope.runId, identity: source.identity, planHash: exported.summary.planHash };
  const secret = Buffer.alloc(32, 17).toString('base64url');
  const ciphertext = await encryptSnapshotBackup(secret, backupIdentity, sourceBundle);
  assert.ok(!ciphertext.includes('Current recovered beta'));
  const decrypted = await decryptSnapshotBackup(secret, backupIdentity, ciphertext);
  assert.deepEqual(decrypted, sourceBundle);
  const restored = rebind(decrypted, target.identity);
  assert.notEqual(hash(restored.plan), exported.summary.planHash);
  assert.deepEqual({ ...restored.plan, identity: source.identity }, exported.plan);
  await assert.rejects(target.call('beginImport', restored.plan, importGrant(exported.plan)), /snapshot_authorization/);
  assert.equal((await target.restore(restored)).ready, true);
  for (const [name, rows] of await readTables(target, restored.plan.tables)) assert.deepEqual(rows, expected.get(name), name);
  assert.equal((await new MemoryStore(target.db).get(seed.owner.token, seed.space.id, seed.memoryId)).body, 'Current recovered beta 한글');
  assert.equal((await target.db.prepare('SELECT memory_id FROM release_fts WHERE release_fts MATCH ?').bind('beta').first()).memory_id, seed.memoryId);
  await assert.rejects(new WorkspaceService(target.db).snapshot(seed.expired.token), /Workspace operation denied/);
  await assert.rejects(new MemoryStore(target.db).get(seed.other.token, seed.space.id, seed.memoryId), /access_denied/);
  await assert.rejects(target.db.prepare("INSERT INTO recovery_fixture_values VALUES(999,'blocked',NULL)").run(), /fixture_runtime_guard/);
  const anotherPlan = rebind(initial, target.identity);
  await assert.rejects(target.call('beginImport', anotherPlan.plan, importGrant(anotherPlan.plan)), /snapshot_conflict|snapshot_target_not_empty|snapshot_closed/);
  const completed = await release(source, scope, exported.summary.planHash, 'backup-verified');
  assert.equal((await source.recovery('recoveryStatus', scope)).state, 'released');
  await assert.rejects(source.recovery('readRecoveryChunk', { ...scope, planHash: exported.summary.planHash, index: 0 }), /recovery_closed/);
  assert.equal(completed.receipt.releaseRequestHash, hash(completed.input));
  for (const [name, rows] of await readTables(source, initial.plan.tables)) assert.deepEqual(rows, expected.get(name), name);
});

test('native both HOT objects preserve post-import permanent erasure, sparse rowids and AUTOINCREMENT maxima', { timeout: 60000 }, async t => {
  const f = await native(t);
  for (const [number, databaseId] of ['hot-01', 'hot-02'].entries()) {
    const source = f.object(identity(databaseId, 'hot')), target = f.object(identity('restored-' + databaseId, 'hot', 2));
    const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
    raw.exec(await readFile(new URL('../../shard-migrations/0001_payloads.sql', import.meta.url), 'utf8'));
    const content = JSON.stringify({ body: 'Synthetic searchable survivor', source: null, provenance: { originKind: 'user' } });
    const values = id => [id, 'space', id, content, bytesHash(content), Buffer.byteLength(content), Date.now()];
    const insert = 'INSERT INTO payloads(id,space_id,memory_id,content,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?)';
    raw.prepare('INSERT INTO payloads(row_id,id,space_id,memory_id,content,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)').run(4, ...values('initial'));
    const initial = await initialSnapshot(raw, source.identity);
    await source.restore(initial);
    await source.db.prepare('INSERT INTO payloads(row_id,id,space_id,memory_id,content,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(90, ...values('retired')).run();
    await source.db.prepare(insert).bind(...values('survivor')).run();
    await source.db.prepare('INSERT INTO payload_tombstones VALUES(?,?,?,?)').bind('retired', 'space', 'retired', Date.now()).run();
    assert.equal((await source.db.prepare("SELECT row_id FROM payloads WHERE id='survivor'").first()).row_id, 91);
    const expected = await readTables(source, initial.plan.tables);
    const input = freezeInput(source.identity, String(number + 3).repeat(24)), scope = scopeOf(input);
    await source.recovery('freezeRecovery', input);
    const exported = await exportCurrent(source, scope);
    assert.notEqual(exported.plan.snapshotHash, initial.plan.snapshotHash);
    for (const table of exported.plan.tables) assert.deepEqual(bundleRows(exported, table.name), expected.get(table.name), `${databaseId}:${table.name}`);
    assert.equal((await target.restore(rebind(exported, target.identity))).ready, true);
    for (const [name, rows] of await readTables(target, exported.plan.tables)) assert.deepEqual(rows, expected.get(name), `${databaseId}:${name}`);
    assert.equal((await target.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='payloads'").first()).seq, 91);
    assert.equal((await target.db.prepare("SELECT count(*) AS n FROM payloads WHERE id='retired'").first()).n, 0);
    assert.equal((await target.db.prepare("SELECT count(*) AS n FROM payload_tombstones WHERE id='retired'").first()).n, 1);
    assert.equal((await target.db.prepare("SELECT count(*) AS n FROM payload_fts WHERE payload_id='retired'").first()).n, 0);
    assert.equal((await target.db.prepare("SELECT payload_id FROM payload_fts WHERE payload_fts MATCH ? AND payload_id='survivor'").bind('searchable').first()).payload_id, 'survivor');
    await assert.rejects(target.db.prepare(insert).bind(...values('retired')).run(), /payload_retired/);
    await target.db.prepare(insert).bind(...values('next')).run();
    assert.equal((await target.db.prepare("SELECT row_id FROM payloads WHERE id='next'").first()).row_id, 92);
    await release(source, scope, exported.summary.planHash, 'backup-verified');
    for (const [name, rows] of await readTables(source, initial.plan.tables)) assert.deepEqual(rows, expected.get(name), `${databaseId}:${name}`);
  }
});

test('native recovery RPC grants bind the exact action, body, run, identity and authority without creating a lock on denial', { timeout: 45000 }, async t => {
  const f = await native(t), source = f.object(identity()), raw = synthetic(t);
  await source.restore(await initialSnapshot(raw, source.identity));
  const input = freezeInput(source.identity), scope = scopeOf(input), now = Date.now();
  const wrongKeys = generateKeyPairSync('ed25519');
  const grants = [
    recoveryGrant('freezeRecovery', input, {}, wrongKeys),
    recoveryGrant('freezeRecovery', input, {}, importKeys),
    recoveryGrant('freezeRecovery', input, { domain: 'memory-sql-import-v1' }),
    recoveryGrant('freezeRecovery', input, { action: 'release' }),
    recoveryGrant('freezeRecovery', input, { runId: '9'.repeat(24) }),
    recoveryGrant('freezeRecovery', input, { requestHash: 'f'.repeat(64) }),
    recoveryGrant('freezeRecovery', input, { notBeforeMs: now - 5000, expiresAtMs: now - 1000 }),
    recoveryGrant('freezeRecovery', input, { notBeforeMs: now + 60000, expiresAtMs: now + 120000 }),
    recoveryGrant('freezeRecovery', input, { notBeforeMs: now - 1000, expiresAtMs: now + 1800001 }),
  ];
  for (const grant of grants) {
    await assert.rejects(source.call('freezeRecovery', input, grant), /recovery_authorization/);
    assert.equal((await source.recovery('recoveryStatus', scope)).state, 'absent');
    assert.equal((await source.db.prepare('SELECT count(*) AS n FROM records').first()).n, 2);
  }
  await assert.rejects(source.call('freezeRecovery', { ...input, sourceRevision: 'b'.repeat(40) }, recoveryGrant('freezeRecovery', input)), /recovery_authorization/);
  const extra = { ...input, unexpected: true };
  await assert.rejects(source.call('freezeRecovery', extra, recoveryGrant('freezeRecovery', extra)), /recovery_input/);
  for (const wrongIdentity of [{ ...source.identity, epoch: 2 }, { ...source.identity, kind: 'hot' }]) {
    const wrong = freezeInput(wrongIdentity);
    await assert.rejects(source.call('freezeRecovery', wrong, recoveryGrant('freezeRecovery', wrong)), /recovery_identity/);
  }
  const unsealed = f.object(identity('unsealed')), missing = freezeInput(unsealed.identity), missingScope = scopeOf(missing);
  await assert.rejects(unsealed.recovery('freezeRecovery', missing), /recovery_not_ready/);
  await assert.rejects(unsealed.recovery('recoveryStatus', missingScope), /recovery_not_ready/);
  await assert.rejects(unsealed.db.prepare('SELECT 1').first(), /durable_sql_not_ready/);
  const unsealedBundle = rebind(await initialSnapshot(raw, source.identity), unsealed.identity);
  assert.equal((await unsealed.restore(unsealedBundle)).ready, true, 'Recovery initialization must preserve signed empty-target import');
  assert.equal((await source.recovery('recoveryStatus', scope)).state, 'absent');
  await source.recovery('freezeRecovery', input);
  const otherRun = freezeInput(source.identity, '3'.repeat(24));
  await assert.rejects(source.recovery('freezeRecovery', otherRun), /recovery_conflict/);
  await assert.rejects(source.recovery('recoveryStatus', scopeOf(otherRun)), /recovery_conflict/);
  await assert.rejects(source.recovery('recoveryStatus', { ...scope, freezeRequestHash: 'f'.repeat(64) }), /recovery_conflict/);
  await release(source, scope);
});

test('native missing recovery key fails closed while the separate signed importer still initializes a blank target', { timeout: 30000 }, async t => {
  const f = await native(t, { recoveryPublicKey: null }), source = f.object(identity());
  await source.restore(await initialSnapshot(synthetic(t), source.identity));
  const input = freezeInput(source.identity);
  await assert.rejects(source.recovery('freezeRecovery', input), /recovery_authorization/);
  await assert.rejects(source.recovery('recoveryStatus', scopeOf(input)), /recovery_authorization/);
  assert.equal((await source.db.prepare('SELECT count(*) AS n FROM records').first()).n, 2);
});

test('native committed freeze survives grant expiry and process restart until a freshly authorized explicit release', { timeout: 30000 }, async t => {
  const f = await native(t, { persist: true }), source = f.object(identity());
  await source.restore(await initialSnapshot(synthetic(t), source.identity));
  const input = freezeInput(source.identity), scope = scopeOf(input);
  const expiresAtMs = Date.now() + 750;
  const grant = recoveryGrant('freezeRecovery', input, { expiresAtMs });
  const receipt = await source.call('freezeRecovery', input, grant);
  await f.restart();
  // The bounded wait only exercises expiry; it never establishes an unlock.
  await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, expiresAtMs - Date.now() + 1)));
  await assert.rejects(source.call('freezeRecovery', input, grant), /recovery_authorization/);
  const status = await source.recovery('recoveryStatus', scope);
  assert.equal(status.state, 'frozen');
  assert.deepEqual(status.receipt, receipt);
  await assert.rejects(source.db.prepare('SELECT 1').all(), /durable_sql_frozen/);
  await release(source, scope);
  assert.deepEqual(await source.db.prepare('SELECT 1 AS ready').first(), { ready: 1 });
});

test('native multipart export bounds manifest UTF-8 slices and row chunks, rejects part substitutions and replays after restart', { timeout: 60000 }, async t => {
  const f = await native(t, { persist: true }), source = f.object(identity());
  let initial;
  for (let padding = 0; padding < 2; padding++) {
    const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
    raw.exec('CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT)');
    for (let index = 0; index < 4; index++) raw.exec(`CREATE TABLE padding_${index}(id INTEGER PRIMARY KEY,value TEXT CHECK(value <> '${' '.repeat(index === 0 ? padding : 0)}${'한'.repeat(25000)}'))`);
    const insert = raw.prepare('INSERT INTO records VALUES(?,?)');
    for (let index = 0; index < 501; index++) insert.run(index - 250, 'value-' + index + '-' + 'x'.repeat(1400));
    initial = await initialSnapshot(raw, source.identity);
    const bytes = Buffer.from(canonical(initial.plan));
    let boundarySplitsCharacter = false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 262144)); } catch { boundarySplitsCharacter = true; }
    if (boundarySplitsCharacter) break;
  }
  await source.restore(initial);
  const input = freezeInput(source.identity), scope = scopeOf(input);
  await source.recovery('freezeRecovery', input);
  const exported = await exportCurrent(source, scope);
  assert.ok(exported.summary.manifestPages > 1);
  assert.ok(exported.plan.chunks.filter(chunk => chunk.table === 'records').length > 1);
  const recordRows = bundleRows(exported, 'records');
  assert.equal(recordRows.length, 501);
  assert.deepEqual(recordRows.map(row => row[0]), Array.from({ length: 501 }, (_, index) => index - 250));
  assert.equal(recordRows[0][2], 'value-0-' + 'x'.repeat(1400));
  assert.equal(recordRows[500][2], 'value-500-' + 'x'.repeat(1400));
  assert.ok(exported.pages.some(page => {
    try { new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(page.data, 'base64url')); return false; }
    catch { return true; }
  }), 'The fixture must exercise a multibyte character split between raw manifest pages');
  for (const [method, part] of [['readRecoveryManifest', { pageIndex: 0 }], ['readRecoveryChunk', { index: 0 }]]) {
    const correct = { ...scope, planHash: exported.summary.planHash, ...part };
    const changed = { ...correct, ...('pageIndex' in part ? { pageIndex: 1 } : { index: 1 }) };
    await assert.rejects(source.call(method, changed, recoveryGrant(method, correct)), /recovery_authorization/);
    await assert.rejects(source.recovery(method, { ...correct, planHash: 'f'.repeat(64) }), /recovery_part|recovery_conflict/);
    await assert.rejects(source.recovery(method, { ...correct, ...('pageIndex' in part ? { pageIndex: 1000 } : { index: 1000 }) }), /recovery_input|recovery_part/);
  }
  await f.restart();
  for (const page of exported.pages) assert.deepEqual(await source.recovery('readRecoveryManifest',
    { ...scope, planHash: exported.summary.planHash, pageIndex: page.pageIndex }), page);
  for (const part of exported.parts) assert.deepEqual(await source.recovery('readRecoveryChunk',
    { ...scope, planHash: exported.summary.planHash, index: part.index }), part);
  await assert.rejects(source.recovery('releaseRecovery', { ...scope, expectedPlanHash: null, decision: 'operator-abort', evidenceHash: 'e'.repeat(64) }), /recovery_conflict/);
  await release(source, scope, exported.summary.planHash, 'backup-verified');
});

test('native recovery upgrade preserves a persisted sealed object with only the three historical metadata tables', { timeout: 45000 }, async t => {
  // This test-only legacy class constructs the exact historical persisted SQL
  // shape. Restart then replaces the class implementation, keeping the Worker,
  // namespace, class export and named-object identity unchanged.
  const legacyScript = await bundle(`
import {DurableObject} from 'cloudflare:workers';
export class MemorySqlDatabase extends DurableObject {
 legacySeed(input){return this.ctx.storage.transactionSync(()=>{
  const sql=this.ctx.storage.sql,plan=input.plan;
  sql.exec("CREATE TABLE durable_sql_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),deployment_id TEXT NOT NULL,database_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('control','hot')),epoch INTEGER NOT NULL CHECK(epoch>=1),status TEXT NOT NULL CHECK(status IN ('importing','ready','failed')),schema_hash TEXT NOT NULL,snapshot_hash TEXT NOT NULL)");
  sql.exec('CREATE TABLE durable_sql_import(singleton INTEGER PRIMARY KEY CHECK(singleton=1),plan_hash TEXT NOT NULL,plan_json TEXT NOT NULL,next_chunk INTEGER NOT NULL,total_bytes INTEGER NOT NULL,sealed_at_ms INTEGER)');
  sql.exec('CREATE TABLE durable_sql_import_rows(chunk_index INTEGER PRIMARY KEY,table_name TEXT NOT NULL,start_row INTEGER NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL)');
  for(const item of plan.schema.filter(item=>item.type==='table'))sql.exec(item.sql);
  const q=name=>'"'+name.replaceAll('"','""')+'"';
  for(const table of plan.tables){
   if(table.name==='sqlite_sequence')sql.exec('DELETE FROM sqlite_sequence');
   const insert='INSERT INTO '+q(table.name)+'('+table.columns.map(q).join(',')+') VALUES('+table.columns.map(()=>'?').join(',')+')';
   for(const chunk of input.chunks.filter(chunk=>plan.chunks[chunk.index].table===table.name))for(const row of chunk.rows)sql.exec(insert,...row);
  }
  for(const item of plan.schema.filter(item=>item.type!=='table'))sql.exec(item.sql);
  const id=plan.identity;
  sql.exec("INSERT INTO durable_sql_state VALUES(1,?,?,?,?,'ready',?,?)",id.deploymentId,id.databaseId,id.kind,id.epoch,plan.schemaHash,plan.snapshotHash);
  sql.exec('INSERT INTO durable_sql_import VALUES(1,?,?,?,?,?)',input.planHash,input.planJson,plan.chunks.length,input.totalBytes,Date.now());
  return this.legacyState();
 });}
 legacyState(){return this.ctx.storage.sql.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'durable_sql_*' ORDER BY name").toArray().map(row=>row.name);}
}
`);
  const f = await native(t, { persist: true, initialScript: legacyScript }), source = f.object(identity());
  const initial = await initialSnapshot(synthetic(t), source.identity);
  const metadata = await source.call('legacySeed', { ...initial, planHash: hash(initial.plan), planJson: canonical(initial.plan),
    totalBytes: initial.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(canonical(chunk.rows)), 0) });
  assert.deepEqual(metadata, ['durable_sql_import', 'durable_sql_import_rows', 'durable_sql_state']);
  await f.restart();
  assert.deepEqual((await source.db.prepare('SELECT id,value FROM records ORDER BY id').all()).results,
    [{ id: 2, value: 'initial' }, { id: 9, value: 'retire' }]);
  await source.db.prepare("UPDATE records SET value='after-upgrade' WHERE id=2").run();
  const input = freezeInput(source.identity), scope = scopeOf(input);
  assert.equal((await source.recovery('recoveryStatus', scope)).state, 'absent');
  const receipt = await source.recovery('freezeRecovery', input);
  assert.equal(receipt.importPlanHash, hash(initial.plan));
  const exported = await exportCurrent(source, scope);
  assert.deepEqual(bundleRows(exported, 'records'), [[2, 2, 'after-upgrade'], [9, 9, 'retire']]);
  assert.deepEqual(bundleRows(exported, 'record_history'), [[1, 1, 2, 'initial']]);
  await f.restart();
  assert.deepEqual((await source.recovery('recoveryStatus', scope)).receipt, receipt);
  await release(source, scope, exported.summary.planHash, 'backup-verified');
});

test('native deferred freeze can commit after early absence but cannot commit after a source-validated expiry barrier', { timeout: 45000 }, async t => {
  const gatedScript = await bundle(`
import {MemorySqlDatabase as ActualMemorySqlDatabase} from '../../src/durable-sql/object.ts';
const realNow=Date.now.bind(Date),realVerify=crypto.subtle.verify.bind(crypto.subtle);
let currentTime=null,holdNext=false,held=false,resumeVerification,notifyHeld;
Date.now=()=>currentTime??realNow();
crypto.subtle.verify=async(...args)=>{
 const valid=await realVerify(...args);
 const payload=JSON.parse(new TextDecoder().decode(args[3]));
 if(holdNext&&payload.domain==='memory-sql-recovery-v1'&&payload.action==='freeze'){
  holdNext=false;held=true;notifyHeld?.();notifyHeld=undefined;
  await new Promise(resolve=>resumeVerification=resolve);
 }
 return valid;
};
export class MemorySqlDatabase extends ActualMemorySqlDatabase {
 testControl(input){
  if(input.operation==='hold'){currentTime=input.now;holdNext=true;held=false;return true;}
  if(input.operation==='wait'){return held?true:new Promise(resolve=>notifyHeld=()=>resolve(true));}
  if(input.operation==='advance'){currentTime=input.now;return true;}
  if(input.operation==='resume'){held=false;resumeVerification?.();resumeVerification=undefined;return true;}
  throw new Error('fixture_control');
 }
}
`);
  const f = await native(t, { initialScript: gatedScript });
  for (const expired of [false, true]) {
    const source = f.object(identity(expired ? 'barrier-control' : 'early-control'));
    await source.restore(await initialSnapshot(synthetic(t), source.identity));
    const now = Date.now(), expiresAtMs = now + 1000;
    const input = freezeInput(source.identity), scope = scopeOf(input);
    await source.call('testControl', { operation: 'hold', now });
    const pending = source.call('freezeRecovery', input, recoveryGrant('freezeRecovery', input, { notBeforeMs: now - 1, expiresAtMs }));
    pending.catch(() => {});
    await source.call('testControl', { operation: 'wait' });
    try {
      const early = await source.call('recoveryStatus', scope, recoveryGrant('recoveryStatus', scope, { notBeforeMs: now - 1, expiresAtMs: now + 10000 }));
      assert.equal(early.state, 'absent');
      if (expired) {
        await source.call('testControl', { operation: 'advance', now: expiresAtMs });
        const barrier = await source.call('recoveryStatus', scope,
          recoveryGrant('recoveryStatus', scope, { notBeforeMs: expiresAtMs, expiresAtMs: expiresAtMs + 10000 }));
        assert.equal(barrier.state, 'absent');
      }
      await source.call('testControl', { operation: 'resume' });
      if (expired) {
        await assert.rejects(pending, /recovery_authorization/);
        assert.equal((await source.recovery('recoveryStatus', scope)).state, 'absent');
        assert.equal((await source.db.prepare('SELECT count(*) AS n FROM records').first()).n, 2);
      } else {
        const receipt = await pending;
        assert.equal(receipt.frozenAtMs, now);
        assert.equal((await source.recovery('recoveryStatus', scope)).state, 'frozen');
        await assert.rejects(source.db.prepare('SELECT 1').all(), /durable_sql_frozen/);
        await release(source, scope);
      }
    } finally { await source.call('testControl', { operation: 'resume' }); await pending.catch(() => {}); }
  }
});

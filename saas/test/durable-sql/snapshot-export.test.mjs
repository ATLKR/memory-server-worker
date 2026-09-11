import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { snapshotCanonical, snapshotHash } from '../../src/durable-sql/snapshot.ts';

const implementation = await import('../../scripts/durable-snapshot.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const options = () => ({ identity: { deploymentId: 'staging', databaseId: 'control', kind: 'control', epoch: 1 },
  sourceRevision: 'a'.repeat(40), sourceFrozenAtMs: Date.now() - 1000, freeze: { confirmed: true, evidenceRef: 'fixture:paused' } });
function fixture(t, { noTableList = false, beforeRead = () => {} } = {}) {
  assert.equal(typeof implementation.exportDurableSnapshot, 'function', 'The read-only snapshot exporter must be implemented');
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT);
    INSERT INTO records(id,value) VALUES(2,'alpha'),(9,'beta');
    CREATE INDEX records_value ON records(value);
    CREATE VIEW live_records AS SELECT * FROM records;
    CREATE TABLE _cf_KV(key TEXT,value TEXT);CREATE TABLE _cf_METADATA(key TEXT,value TEXT);
    CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT);INSERT INTO d1_migrations(name) VALUES('applied');
    CREATE TABLE __cf_kv(key TEXT,value TEXT);CREATE TABLE durable_sql_fixture(private TEXT);`);
  const calls = [];
  const db = { withSession(constraint) { assert.equal(constraint, 'first-primary'); return { prepare(sql) {
    function bound(values) { return { bind(...next) { return bound(next); }, async all() {
      assert.match(sql.trim(), /^(SELECT|PRAGMA)\b/i, 'Export must never dispatch writes');
      calls.push(sql); beforeRead(sql, raw);
      if (noTableList && /^PRAGMA table_list\b/i.test(sql)) throw new Error('unsupported pragma');
      return { success: true, results: raw.prepare(sql).all(...values) };
    } }; }
    return bound([]);
  } }; } };
  t.after(() => raw.close());
  return { raw, db, calls };
}

test('export preserves exact schema, rowids and application sequence while excluding explicit provider metadata', async t => {
  const f = fixture(t);
  f.raw.exec("CREATE TRIGGER memory_runtime_guard BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT,'retained'); END");
  const result = await implementation.exportDurableSnapshot(f.db, options());
  assert.deepEqual(result.plan.schema.map(row => row.name), ['records', 'records_value', 'live_records', 'memory_runtime_guard']);
  assert.equal(result.plan.schema.find(row => row.type === 'trigger').sql, f.raw.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_runtime_guard'").get().sql);
  assert.deepEqual(result.plan.tables.map(table => table.name), ['records', 'sqlite_sequence']);
  assert.deepEqual(result.plan.tables[0].columns, ['rowid', 'id', 'value']);
  assert.deepEqual(result.chunks.find(chunk => result.plan.chunks[chunk.index].table === 'records').rows, [[2, 2, 'alpha'], [9, 9, 'beta']]);
  assert.deepEqual(result.chunks.find(chunk => result.plan.chunks[chunk.index].table === 'sqlite_sequence').rows.map(row => row.slice(1)), [['records', 9]]);
  assert.equal(result.plan.schemaHash, await snapshotHash(result.plan.schema));
  assert.equal(result.plan.snapshotHash, await snapshotHash({ tables: result.plan.tables, chunks: result.plan.chunks }));
  assert.ok(result.chunks.every(chunk => chunk.planHash === result.chunks[0].planHash));
  assert.equal(result.chunks[0].planHash, await snapshotHash(result.plan));
  assert.ok(f.calls.filter(sql => sql.includes('sqlite_schema')).length >= 4);
});

test('FTS visible content is exported and generated shadow storage is omitted with native and fallback discovery', async t => {
  for (const noTableList of [false, true]) {
    const f = fixture(t, { noTableList });
    f.raw.exec("CREATE VIRTUAL TABLE search USING fts5(body,tokenize='unicode61');INSERT INTO search(rowid,body) VALUES(12,'native search')");
    const result = await implementation.exportDurableSnapshot(f.db, options());
    assert.ok(result.plan.schema.some(row => row.name === 'search'));
    assert.ok(!result.plan.schema.some(row => row.name.startsWith('search_')));
    assert.deepEqual(result.plan.tables.find(table => table.name === 'search').columns, ['rowid', 'body']);
    assert.deepEqual(result.chunks.find(chunk => result.plan.chunks[chunk.index].table === 'search').rows, [[12, 'native search']]);
  }
});

test('contentless and external-content FTS are rejected before either catalog or row export', async t => {
  for (const noTableList of [false, true]) for (const content of ['', 'records']) {
    const f = fixture(t, { noTableList });
    f.raw.exec(`CREATE VIRTUAL TABLE search USING fts5(value,content='${content}')`);
    await assert.rejects(implementation.inspectDurableSourceCatalog(f.db), /snapshot_export_schema/);
    await assert.rejects(implementation.exportDurableSnapshot(f.db, options()), /snapshot_export_schema/);
    assert.ok(!f.calls.some(sql => /FROM "search"/.test(sql)), 'Unsupported FTS storage must be rejected before reading its visible rows');
  }
});

test('unknown application tables are retained rather than silently discarded by prefix filtering', async t => {
  const f = fixture(t);
  f.raw.exec("CREATE TABLE _cf_NEW(id TEXT);INSERT INTO _cf_NEW VALUES('retained');CREATE TABLE _migrations(id TEXT);INSERT INTO _migrations VALUES('history')");
  const result = await implementation.exportDurableSnapshot(f.db, options());
  assert.ok(result.plan.tables.some(table => table.name === '_cf_NEW' && table.rowCount === 1));
  assert.ok(result.plan.tables.some(table => table.name === '_migrations' && table.rowCount === 1));
});

test('explicit freeze evidence is required and a same-count content change between reads aborts export', async t => {
  let catalogReads = 0;
  const f = fixture(t, { beforeRead(sql, raw) {
    if (sql.includes('FROM sqlite_schema') && ++catalogReads === 3) raw.exec("UPDATE records SET value='changed' WHERE id=2");
  } });
  const invalid = options(); delete invalid.freeze;
  await assert.rejects(implementation.exportDurableSnapshot(f.db, invalid), /snapshot_export_freeze/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(implementation.exportDurableSnapshot(f.db, options()), /snapshot_export_source_changed/);
});

test('chunks honor both row and encoded byte bounds and retain deterministic order', async t => {
  const f = fixture(t);
  f.raw.exec('CREATE TABLE large(id INTEGER PRIMARY KEY,value TEXT)');
  const insert = f.raw.prepare('INSERT INTO large VALUES(?,?)');
  for (let i = 1; i <= 501; i++) insert.run(i, i <= 2 ? '가'.repeat(90000) : 'tiny');
  const result = await implementation.exportDurableSnapshot(f.db, options());
  const chunks = result.chunks.filter(chunk => result.plan.chunks[chunk.index].table === 'large');
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.rows.length, 0), 501);
  assert.ok(chunks.every(chunk => chunk.rows.length <= 500 && Buffer.byteLength(snapshotCanonical(chunk.rows)) <= 524288));
  assert.deepEqual(chunks.flatMap(chunk => chunk.rows.map(row => row[0])), Array.from({ length: 501 }, (_, index) => index + 1));
});

test('oversized rows, unsupported row identity, unsafe values and unsupported names fail instead of truncating', async t => {
  for (const setup of [
    "UPDATE records SET value=hex(zeroblob(300000)) WHERE id=2",
    'CREATE TABLE no_rowid(id TEXT PRIMARY KEY) WITHOUT ROWID',
    "CREATE TABLE blobs(value BLOB);INSERT INTO blobs VALUES(X'010203')",
    'CREATE TABLE "unsupported-name"(value TEXT)',
  ]) {
    const f = fixture(t); f.raw.exec(setup);
    await assert.rejects(implementation.exportDurableSnapshot(f.db, options()), /snapshot_export_(capacity|rowid|value|schema)/);
  }
});

test('total snapshot capacity is enforced across many individually valid chunks', async t => {
  const f = fixture(t); f.raw.exec('CREATE TABLE large(id INTEGER PRIMARY KEY,value TEXT)');
  const insert = f.raw.prepare('INSERT INTO large VALUES(?,?)');
  for (let i = 0; i < 35; i++) insert.run(i, 'x'.repeat(500000));
  await assert.rejects(implementation.exportDurableSnapshot(f.db, options()), /snapshot_export_capacity/);
});

test('only explicitly declared write fences with exact SQL hashes are excluded from the destination', async t => {
  const f = fixture(t);
  f.raw.exec("CREATE TRIGGER memory_cutover_fence BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT,'frozen'); END");
  f.raw.exec("CREATE TRIGGER memory_runtime_guard BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT,'retained'); END");
  const sql = f.raw.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_cutover_fence'").get().sql;
  const input = options(); input.freeze.excludedTriggers = [{ name: 'memory_cutover_fence', sqlHash: createHash('sha256').update(sql).digest('hex') }];
  const result = await implementation.exportDurableSnapshot(f.db, input);
  assert.ok(!result.plan.schema.some(item => item.name === 'memory_cutover_fence'));
  assert.ok(result.plan.schema.some(item => item.name === 'memory_runtime_guard'));
  assert.ok(f.raw.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_cutover_fence'").get());
});

test('missing, mismatched, duplicated or changed declared fences abort source export', async t => {
  for (const mutate of [list => { list[0].name = 'unknown_fence'; }, list => { list[0].sqlHash = 'a'.repeat(64); }, list => { list.push({ ...list[0] }); }]) {
    const f = fixture(t);
    f.raw.exec("CREATE TRIGGER memory_cutover_fence BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT,'frozen'); END");
    const sql = f.raw.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_cutover_fence'").get().sql;
    const input = options(); input.freeze.excludedTriggers = [{ name: 'memory_cutover_fence', sqlHash: createHash('sha256').update(sql).digest('hex') }];
    mutate(input.freeze.excludedTriggers);
    await assert.rejects(implementation.exportDurableSnapshot(f.db, input), /snapshot_export_fence/);
  }
  let catalogReads = 0;
  const f = fixture(t, { beforeRead(sql, raw) {
    if (sql.includes('FROM sqlite_schema') && ++catalogReads === 3) raw.exec("DROP TRIGGER memory_cutover_fence;CREATE TRIGGER memory_cutover_fence BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'changed'); END");
  } });
  f.raw.exec("CREATE TRIGGER memory_cutover_fence BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT,'frozen'); END");
  const sql = f.raw.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_cutover_fence'").get().sql;
  const input = options(); input.freeze.excludedTriggers = [{ name: 'memory_cutover_fence', sqlHash: createHash('sha256').update(sql).digest('hex') }];
  await assert.rejects(implementation.exportDurableSnapshot(f.db, input), /snapshot_export_(fence|source_changed)/);
});

test('pre-freeze inspection reads only bounded schema metadata and makes no frozen-data assertion', async t => {
  const f = fixture(t);
  assert.equal(typeof implementation.inspectDurableSourceCatalog, 'function', 'A separate read-only pre-freeze catalog inspector is required');
  const inspected = await implementation.inspectDurableSourceCatalog(f.db);
  assert.deepEqual(Object.keys(inspected).sort(), ['schema', 'schemaHash']);
  assert.deepEqual(inspected.schema.map(row => row.name), ['records', 'records_value', 'live_records']);
  assert.equal(inspected.schemaHash, await snapshotHash(inspected.schema));
  assert.ok(f.calls.every(sql => sql.includes('FROM sqlite_schema') || sql === 'PRAGMA table_list'));
  const exported = await implementation.exportDurableSnapshot(f.db, options());
  assert.deepEqual(inspected.schema, exported.plan.schema);
  assert.equal(inspected.schemaHash, exported.plan.schemaHash);
});

test('catalog inspection retains installed fences and rejects malformed source metadata', async t => {
  const f = fixture(t);
  assert.equal(typeof implementation.inspectDurableSourceCatalog, 'function');
  f.raw.exec("CREATE TRIGGER memory_cutover_fence BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT,'frozen'); END");
  const inspected = await implementation.inspectDurableSourceCatalog(f.db);
  assert.ok(inspected.schema.some(item => item.name === 'memory_cutover_fence'));
  await assert.rejects(implementation.inspectDurableSourceCatalog({ withSession() { return { prepare() { return { bind() { return { async all() { return { success: true, results: [{ name: 'unexpected' }] }; } }; } }; } }; } }), /snapshot_export_schema/);
});

test('pre-freeze catalog inspection accommodates bounded fence metadata without enlarging the export schema', async t => {
  const f = fixture(t);
  for (let index = 0; index < 981; index++) f.raw.exec(`CREATE INDEX fence_catalog_${index} ON records(value)`);
  const inspected = await implementation.inspectDurableSourceCatalog(f.db);
  assert.equal(inspected.schema.length, 984);
  assert.equal(inspected.schemaHash, await snapshotHash(inspected.schema));
  await assert.rejects(implementation.exportDurableSnapshot(f.db, options()), /snapshot_export_schema/);
  f.raw.exec('CREATE INDEX beyond_fence_catalog_limit ON records(value)');
  await assert.rejects(implementation.inspectDurableSourceCatalog(f.db), /snapshot_export_schema/);
});

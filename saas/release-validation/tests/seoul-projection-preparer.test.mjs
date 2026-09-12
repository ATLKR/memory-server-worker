import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fixture, at } from './db.mjs';
import { createSeoulProjectionPreparer } from '../../src/release/seoul-projection-preparer.ts';
import { prepareSeoulHeadCandidate } from '../../src/release/seoul-projection-source-codec.ts';
import { decodeSeoulHeadEvent } from '../../src/release/seoul-projection-head-codec.ts';
import { createDurableDatabase } from '../../src/durable-sql/client.ts';
import { SqlDatabaseEngine } from '../../src/durable-sql/engine.ts';

const schema = new URL('../../seoul-projection-preparation-schema.sql', import.meta.url);
const migration = new URL('../../migrations/0029_seoul-projection-preparation-schema.sql', import.meta.url);
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const copy = value => structuredClone(value);
const tables = ['release_seoul_authority_changes', 'release_seoul_prepared_sources', 'release_seoul_projection_events', 'release_seoul_projection_deliveries', 'release_seoul_authority_heads', 'release_seoul_preparation_stage'];
const rows = (f, table) => f.raw.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all().map(r => ({ ...r }));
const snapshot = f => Object.fromEntries(tables.map(table => [table, rows(f, table)]));
function credential(id = 'credential:one', negative = false) {
 return { version: 3, kind: 'credential-source', id, accountId: 'alice', credentialKind: negative ? 'api_key' : 'personal_key', tokenDigest: 'a'.repeat(64), membershipId: negative ? 'm1' : null, emailId: negative ? 'e1' : null, permission: 'write', expiresAtMs: at + 10000, revokedAtMs: negative ? at : null, policy: null,
  origin: { kind: 'command', commandType: negative ? 'self-email-unlink' : 'scoped-key-issue', receiptId: negative ? 'receipt:unlink' : null },
  effect: negative ? { type: 'entity-negative', entityKind: 'credential', entityId: id, state: 'revoked', occurredAtMs: at } : { type: 'entity-head', disposition: 'present' } };
}
function insertSource(f, number = 1, body = credential()) {
 const streamKind = body.kind.startsWith('subject') ? 'subject' : body.kind.replace('-source', ''), streamKey = streamKind === 'subject' ? 'https://auth-api.allen.company\n' + body.subject : body.id;
 f.raw.prepare('INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?)').run(uuid(1000 + number), streamKind, streamKey, uuid(number), JSON.stringify(body), at);
 return { ...f.raw.prepare('SELECT revision,source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at FROM release_seoul_authority_changes WHERE event_id=?').get(uuid(number)) };
}
async function setup(t, recursive = 'ON', mode = 'durable-sql', install = true) {
 const f = await fixture(); t.after(() => f.db.close()); f.raw = f.db.raw; f.calls = []; f.attempts = 0; f.hooks = {}; f.sessions = [];
 for (const name of ['0026_seoul-projection-schema.sql', '0027_seoul-projection-capture-schema.sql', '0028_seoul-projection-bootstrap-schema.sql']) f.raw.exec(readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
 if (install) { assert.ok(existsSync(schema), 'new preparation source schema exists'); f.raw.exec(readFileSync(migration, 'utf8')); }
 f.raw.exec('PRAGMA recursive_triggers=' + recursive);
 const storage = { sql: { exec(sql, ...values) { const statement = f.raw.prepare(sql), result = statement.all(...values), readonly = statement.columns().length > 0 && /^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim()); return { rowsWritten: readonly ? 0 : Number(f.raw.prepare('SELECT changes() n').get().n), toArray: () => result, [Symbol.iterator]: () => result[Symbol.iterator]() }; } }, transactionSync(fn) { f.raw.exec('BEGIN IMMEDIATE'); try { const result = fn(); f.raw.exec('COMMIT'); return result; } catch (error) { f.raw.exec('ROLLBACK'); throw error; } } };
 f.engine = new SqlDatabaseEngine(storage, { objectName: 'sql:staging:control:1' }); f.engine.initialize(); f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging', 'control', 'control', 1, 'ready', 'a'.repeat(64), 'b'.repeat(64));
 const execute = async request => {
  f.calls.push(copy(request)); const batch = request.statements.length > 1;
  if (batch) { f.attempts++; await f.hooks.beforeBatch?.(request); }
  else await f.hooks.beforeRead?.(request);
  // A local D1-shaped adapter runs plain SQLite batches. The durable branch
  // uses the actual production client and SqlDatabaseEngine. Neither is live D1.
  const result = mode === 'durable-sql' ? f.engine.execute(request) : storage.transactionSync(() => request.statements.map(s => {
   const statement = f.raw.prepare(s.sql), result = statement.all(...s.values), readonly = statement.columns().length > 0 && /^(SELECT|WITH)/i.test(s.sql.trim());
   return { success: true, results: s.mode === 'first' ? result.slice(0, 1) : result, meta: { changes: readonly ? 0 : Number(f.raw.prepare('SELECT changes() n').get().n) } };
  }));
  if (batch) await f.hooks.afterCommit?.(request);
  else await f.hooks.afterRead?.(result, request);
  return result;
 };
 const identity = { deploymentId: 'staging', databaseId: 'control', kind: 'control', epoch: 1 }, owned = new WeakMap();
 function prepare(sql, values = []) {
  const s = { bind(...parameters) { return prepare(sql, parameters); }, async first() { return (await execute({ identity, statements: [{ sql, values, mode: 'first' }] }))[0].results[0] ?? null; }, async all() { return (await execute({ identity, statements: [{ sql, values, mode: 'all' }] }))[0]; }, async run() { return this.all(); } };
  owned.set(s, { sql, values, mode: 'all' }); return s;
 }
 const underlying = mode === 'durable-sql' ? createDurableDatabase({ execute }, identity) : { prepare, batch(statements) { return execute({ identity, statements: statements.map(s => owned.get(s)) }); }, withSession() { return { prepare }; } };
 f.adapter = { prepare: underlying.prepare, batch: underlying.batch, withSession(constraint) { f.sessions.push(constraint); return underlying.withSession(constraint); } };
 f.preparer = createSeoulProjectionPreparer(f.adapter, mode); return f;
}
function expected(candidate, status) { return { status, revision: candidate.rowGuard.revision, eventId: candidate.rowGuard.event_id, sourceChangeSha256: candidate.sourceChangeSha256, transportPayloadSha256: candidate.transportPayloadSha256 }; }
function batch(f) { return f.calls.find(request => request.statements.length === 7); }
function assertClean(f) { assert.deepEqual(rows(f, 'release_seoul_preparation_stage'), []); assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), []); }
function persistedPair(f, c, { delivery = true, finalize = true, badHash = false, badTransport = false, badText = false } = {}) {
 const r = c.rowGuard, sourceHash = badHash ? 'f'.repeat(64) : c.sourceChangeSha256, transportHash = badTransport ? 'e'.repeat(64) : c.transportPayloadSha256;
 f.raw.exec('BEGIN IMMEDIATE'); try {
  f.raw.prepare('INSERT INTO release_seoul_prepared_sources VALUES(?,?,?,?)').run(r.revision, r.event_id, sourceHash, transportHash);
  f.raw.prepare("INSERT INTO release_seoul_projection_events(event_id,source_revision,event_kind,stream_kind,stream_key,source_sha256,space_id,snapshot_seq,issued_at,expires_at,payload_bytes,payload_sha256) VALUES(?,?,'head',?,?,?,NULL,NULL,NULL,NULL,?,?)").run(r.event_id, r.revision, r.stream_kind, r.stream_key, sourceHash, badText ? c.eventText + ' ' : c.eventText, transportHash);
  if (delivery) f.raw.prepare('INSERT INTO release_seoul_projection_deliveries(event_id) VALUES(?)').run(r.event_id);
  if (finalize) f.raw.prepare('UPDATE release_seoul_authority_heads SET payload_sha256=? WHERE revision=?').run(sourceHash, r.revision);
  f.raw.exec('COMMIT');
 } catch (error) { f.raw.exec('ROLLBACK'); throw error; }
}

test('trusted factory and invalid revisions cannot access the database', async () => {
 let calls = 0; const database = { prepare() { calls++; throw Error(); }, batch() { calls++; throw Error(); }, withSession() { calls++; throw Error(); } };
 for (const adapter of [null, 'unknown']) assert.throws(() => createSeoulProjectionPreparer(database, adapter), /seoul_preparer_adapter_unsupported/);
 const p = createSeoulProjectionPreparer(database, 'native-d1'); assert.deepEqual(Object.keys(p), ['prepare']);
 for (const revision of [0, -0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', {}, null]) assert.deepEqual(await p.prepare(revision), { status: 'invalid_revision' });
 assert.equal(calls, 0);
});

test('additive source/generated 0029 preserves all populated prior schema and rows', async t => {
 const f = await setup(t, 'ON', 'durable-sql', false); insertSource(f);
 const old = f.raw.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
 const oldTables = old.filter(r => /^CREATE TABLE/.test(r.sql ?? '') && !r.name.startsWith('release_fts')).map(r => r.name), before = new Map(oldTables.map(name => [name, rows(f, name)]));
 assert.ok(existsSync(schema)); assert.equal(readFileSync(migration, 'utf8'), '-- Forward SaaS migration 29: seoul-projection-preparation-schema.sql\n' + readFileSync(schema, 'utf8'));
 f.raw.exec(readFileSync(migration, 'utf8')); assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version, 29);
 for (const table of oldTables.filter(name => name !== 'release_meta')) assert.deepEqual(rows(f, table), before.get(table), table);
 for (const prior of old) assert.equal(f.raw.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(prior.name).sql, prior.sql, prior.name);
 assertClean(f);
});

for (const recursive of ['ON', 'OFF']) for (const mode of ['native-d1', 'durable-sql']) test(`exact one-source prepare and read-only replay; ${mode}, recursion ${recursive}`, async t => {
 const f = await setup(t, recursive, mode), source = insertSource(f), c = await prepareSeoulHeadCandidate(source);
 assert.deepEqual(await f.preparer.prepare(source.revision), expected(c, 'prepared'));
 assert.deepEqual(rows(f, 'release_seoul_prepared_sources'), [{ revision: source.revision, event_id: source.event_id, source_sha256: c.sourceChangeSha256, transport_sha256: c.transportPayloadSha256 }]);
 const event = rows(f, 'release_seoul_projection_events')[0]; assert.equal(event.payload_bytes, c.eventText); assert.equal(event.payload_sha256, c.transportPayloadSha256); assert.equal(event.source_sha256, c.sourceChangeSha256);
 for (const field of ['space_id', 'snapshot_seq', 'issued_at', 'expires_at']) assert.equal(event[field], null);
 assert.equal(event.event_kind, 'head'); assert.equal(event.event_id, source.event_id); assert.equal(rows(f, 'release_seoul_authority_heads')[0].payload_sha256, c.sourceChangeSha256);
 assert.deepEqual(rows(f, 'release_seoul_projection_deliveries'), [{ event_id: source.event_id, state: 'pending', attempts: 0, next_attempt_at: 0, fence_token: null, claimed_at: null, fence_expires_at: null, receipt_bytes: null }]);
 f.raw.prepare("UPDATE release_seoul_projection_deliveries SET state='applied',attempts=3,receipt_bytes='synthetic-receipt' WHERE event_id=?").run(source.event_id);
 const before = snapshot(f); assert.deepEqual(await f.preparer.prepare(source.revision), expected(c, 'already_prepared')); assert.deepEqual(snapshot(f), before); assert.equal(f.attempts, 1);
  const request = batch(f); assert.equal(request.statements.length, 7); assert.ok(Buffer.byteLength(JSON.stringify(request)) < 1048576); assert.ok(request.statements.every(s => s.values.length <= 100)); assertClean(f);
 assert.deepEqual(f.sessions, Array(5).fill('first-primary'), 'source/readback sessions are fresh for preparation and replay');
});

for (const recursive of ['ON', 'OFF']) test('historical terminal source remains deliverable without lowering newer pending head; recursion ' + recursive, async t => {
 const f = await setup(t, recursive), old = insertSource(f, 1, credential('credential:one', true)), newer = insertSource(f, 2, credential('credential:one', true));
 const before = rows(f, 'release_seoul_authority_heads'); assert.equal((await f.preparer.prepare(old.revision)).status, 'prepared');
 assert.deepEqual(rows(f, 'release_seoul_authority_heads'), before); assert.equal(before[0].revision, newer.revision);
 assert.equal(decodeSeoulHeadEvent(new TextEncoder().encode(rows(f, 'release_seoul_projection_events')[0].payload_bytes)).effect.state, 'revoked'); assert.equal(rows(f, 'release_seoul_projection_deliveries').length, 1); assertClean(f);
});

test('missing/invalid/unsupported sources and forged adapter rows stay unready without writes', async t => {
 const f = await setup(t); assert.deepEqual(await f.preparer.prepare(1), { status: 'source_missing' });
 const r = insertSource(f); const actual = copy(r);
 f.hooks.afterRead = (results, request) => { if (request.statements[0].sql.includes('record_bytes') && request.statements[0].sql.includes('WHERE revision=?')) results[0].results[0].revision = 123; };
 assert.deepEqual(await f.preparer.prepare(r.revision), { status: 'source_mismatch' });
 f.hooks.afterRead = (results, request) => { if (request.statements[0].sql.includes('WHERE revision=?')) results[0].results[0].record_bytes = JSON.stringify({ ...credential(), expiresAtMs: at + 20000 }); };
 assert.deepEqual(await f.preparer.prepare(r.revision), { status: 'source_mismatch' });
 f.hooks.afterRead = undefined;
 f.raw.prepare('INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?)').run(uuid(1002), 'credential', 'bad', uuid(2), '{}', at);
 assert.deepEqual(await f.preparer.prepare(2), { status: 'source_invalid' });
 f.raw.prepare('INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?)').run(uuid(1003), 'target', 'target:one', uuid(3), '{"version":3,"kind":"target-source"}', at);
 assert.deepEqual(await f.preparer.prepare(3), { status: 'source_contract_unsupported' });
 assert.deepEqual(rows(f, 'release_seoul_authority_changes')[0], actual); assert.equal(f.attempts, 0); assert.equal(rows(f, 'release_seoul_prepared_sources').length, 0); assertClean(f);
});

test('immutable pair conflict is distinct from incomplete exact pair and neither is repaired', async t => {
 for (const options of [{ badHash: true }, { badTransport: true }, { badText: true }, { delivery: false }, { finalize: false }]) {
  const f = await setup(t), r = insertSource(f), c = await prepareSeoulHeadCandidate(r); persistedPair(f, c, options); const before = snapshot(f);
  assert.deepEqual(await f.preparer.prepare(r.revision), { status: options.badHash || options.badTransport || options.badText ? 'prepared_identity_conflict' : 'inconsistent_preparation' }); assert.deepEqual(snapshot(f), before); assert.equal(f.attempts, 0);
 }
});

for (const recursive of ['ON', 'OFF']) test('competing preparation loses CAS with zero downstream durable changes; recursion ' + recursive, async t => {
 const f = await setup(t, recursive), r = insertSource(f); let second, before;
 f.hooks.beforeBatch = async () => { f.hooks.beforeBatch = undefined; second = await f.preparer.prepare(r.revision); f.raw.prepare("UPDATE release_seoul_projection_deliveries SET attempts=2,next_attempt_at=9 WHERE event_id=?").run(r.event_id); before = snapshot(f); };
 const first = await f.preparer.prepare(r.revision); assert.equal(second.status, 'prepared'); assert.equal(first.status, 'prepared'); assert.deepEqual(snapshot(f), before); assert.equal(f.attempts, 2); assertClean(f);
});

for (const recursive of ['ON', 'OFF']) test('fresh unconditional witness rejects retained same/different token and replacement even with false eligibility; recursion ' + recursive, async t => {
 const f = await setup(t, recursive), r = insertSource(f); await f.preparer.prepare(r.revision); const request = batch(f), before = snapshot(f), first = request.statements[0];
 assert.match(first.sql, /^INSERT INTO release_seoul_preparation_stage/); f.engine.execute(request); assert.deepEqual(snapshot(f), before, 'same token clean replay is an eligible0 no-op');
 const witness = copy(first); f.engine.execute({ ...request, statements: [witness] }); assert.equal(rows(f, 'release_seoul_preparation_stage')[0].eligible, 0); const retained = snapshot(f);
 assert.deepEqual(await f.preparer.prepare(r.revision), { status: 'staging_retained' }); assert.deepEqual(snapshot(f), retained);
 assert.throws(() => f.engine.execute(request), /staging/); assert.deepEqual(snapshot(f), retained);
 const other = copy(request); other.statements[0].values[0] = uuid(9001); assert.throws(() => f.engine.execute(other), /staging/); assert.deepEqual(snapshot(f), retained);
 const replace = copy(request); replace.statements[0].sql = replace.statements[0].sql.replace('INSERT INTO', 'INSERT OR REPLACE INTO'); assert.throws(() => f.engine.execute(replace), /staging/); assert.deepEqual(snapshot(f), retained);
 for (const patch of ["eligible=1", "token='" + uuid(9002) + "'", "record_bytes='{}'", "source_sha256='" + 'f'.repeat(64) + "'"]) assert.throws(() => f.raw.exec('UPDATE release_seoul_preparation_stage SET ' + patch), /immutable/);
 assert.throws(() => f.raw.exec('UPDATE release_seoul_preparation_stage SET complete_guard=0'), /CHECK/);
});

for (const recursive of ['ON', 'OFF']) test('every original source guard mismatch gives eligible0 or FK rollback and no durable writes; recursion ' + recursive, async t => {
 for (const field of ['revision', 'source_command_id', 'stream_kind', 'stream_key', 'event_id', 'record_bytes', 'created_at']) {
  const f = await setup(t, recursive), r = insertSource(f), before = snapshot(f); let checked = false;
  const indexes = { revision: 1, source_command_id: 2, stream_kind: 3, stream_key: 4, event_id: 5, record_bytes: 6, created_at: 7 };
  const altered = { revision: 99, source_command_id: uuid(9999), stream_kind: 'membership', stream_key: 'other', event_id: uuid(8888), record_bytes: JSON.stringify({ ...credential(), expiresAtMs: at + 50000 }), created_at: at + 1 };
  f.hooks.beforeBatch = request => { request.statements[0].values[indexes[field]] = altered[field]; checked = true; };
  assert.deepEqual(await f.preparer.prepare(r.revision), { status: 'preparation_absent' }, field); assert.ok(checked); assert.equal(f.attempts, 1); assert.deepEqual(snapshot(f), before); assertClean(f);
 }
});

const lateFailures = [
 ['prepared', 'BEFORE INSERT ON release_seoul_prepared_sources'], ['event', 'BEFORE INSERT ON release_seoul_projection_events'],
 ['delivery', 'BEFORE INSERT ON release_seoul_projection_deliveries'], ['head', 'BEFORE UPDATE ON release_seoul_authority_heads'],
 ['assert', 'BEFORE UPDATE ON release_seoul_preparation_stage'], ['cleanup', 'BEFORE DELETE ON release_seoul_preparation_stage'],
];
for (const recursive of ['ON', 'OFF']) for (const [name, trigger] of lateFailures) test(`late ${name} failure rolls back complete atomic attempt; recursion ${recursive}`, async t => {
 const f = await setup(t, recursive), r = insertSource(f), before = snapshot(f);
 f.raw.exec(`CREATE TRIGGER injected_failure ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END`);
 assert.deepEqual(await f.preparer.prepare(r.revision), { status: 'preparation_absent' }); assert.deepEqual(snapshot(f), before); assert.equal(f.attempts, 1); assertClean(f);
});

for (const recursive of ['ON', 'OFF']) test('complete assertion and deferred FK COMMIT failure each roll back; recursion ' + recursive, async t => {
 for (const commit of [false, true]) {
  const f = await setup(t, recursive), r = insertSource(f); const ghost = commit ? insertSource(f, 2, credential('credential:ghost')) : null, before = snapshot(f);
  if (commit) f.raw.exec(`CREATE TRIGGER inject_commit_debt AFTER INSERT ON release_seoul_prepared_sources WHEN NEW.revision=${r.revision} BEGIN INSERT INTO release_seoul_prepared_sources VALUES(${ghost.revision},'${ghost.event_id}','${'a'.repeat(64)}','${'b'.repeat(64)}'); END`);
  else f.raw.exec("CREATE TRIGGER skip_required_event BEFORE INSERT ON release_seoul_projection_events BEGIN SELECT RAISE(IGNORE); END");
  assert.deepEqual(await f.preparer.prepare(r.revision), { status: 'preparation_absent' }); assert.deepEqual(snapshot(f), before); assert.equal(f.attempts, 1); assertClean(f);
 }
});

test('unknown ACK after COMMIT is reconciled as observed completion with one attempt', async t => {
 const f = await setup(t), r = insertSource(f), c = await prepareSeoulHeadCandidate(r); f.hooks.afterCommit = () => { throw Error('synthetic ACK loss'); };
 assert.deepEqual(await f.preparer.prepare(r.revision), expected(c, 'prepared')); assert.equal(f.attempts, 1); assertClean(f);
});

test('unreadable/mixed readback is uncertain and never automatically retries', async t => {
 for (const mixed of [false, true]) {
  const f = await setup(t), r = insertSource(f); f.hooks.afterCommit = () => { if (mixed) f.hooks.afterRead = results => { results[0].results[0].prepared_present = 0; results[0].results[0].prepared_exact = 0; }; else f.hooks.beforeRead = () => { throw Error('private failure text'); }; throw Error('lost ACK'); };
  assert.deepEqual(await f.preparer.prepare(r.revision), { status: 'preparation_uncertain' }); assert.equal(f.attempts, 1);
 }
});

test('targeted reads use source/event/head indexes and fixed LIMITs', async t => {
 const f = await setup(t), r = insertSource(f); await f.preparer.prepare(r.revision);
 for (const request of f.calls.filter(r => r.statements.length === 1)) {
  const s = request.statements[0], plan = f.raw.prepare('EXPLAIN QUERY PLAN ' + s.sql).all(...s.values).map(r => r.detail);
  assert.ok(plan.some(detail => /SEARCH.*(INTEGER PRIMARY KEY|INDEX)/.test(detail)), JSON.stringify(plan));
  assert.ok(!plan.some(detail => /SCAN (?:c|p|e|h|d)\b/.test(detail)), JSON.stringify(plan)); assert.match(s.sql, /LIMIT 1/i);
 }
});

test('serialized request guard rejects oversize accounting before batch submission', async t => {
 const f = await setup(t), r = insertSource(f), stringify = JSON.stringify;
 JSON.stringify = function (value, ...args) { if (value && typeof value === 'object' && Array.isArray(value.statements) && value.statements.length === 7) return 'x'.repeat(1048577); return stringify(value, ...args); };
 try { assert.deepEqual(await f.preparer.prepare(r.revision), { status: 'request_limit' }); } finally { JSON.stringify = stringify; }
 assert.equal(f.attempts, 0); assert.equal(rows(f, 'release_seoul_prepared_sources').length, 0); assertClean(f);
});

test('one exact 128 KiB source body and larger core fit the bounded real Durable request', async t => {
 const f = await setup(t), issuer = 'https://auth-api.allen.company';
 const identities = Array.from({ length: 512 }, (_, i) => ({ issuer, subject: String(i).padStart(4, '0'), accountId: 'alice', createdAtMs: at }));
 const body = { version: 3, kind: 'subject-source', issuer, subject: '0000', accountId: 'alice', accountDisabledAtMs: null, providerIdentities: identities, lifecycle: { state: 'absent' }, legacyDisabled: false, origin: { kind: 'command', commandType: 'workspace-sign-in', receiptId: 'receipt:one' }, effect: { type: 'entity-head', disposition: 'changed' } };
 let gap = 131072 - Buffer.byteLength(JSON.stringify(body));
 for (let i = identities.length - 1; i > 0 && gap > 0; i--) { const count = Math.min(gap, 512 - identities[i].subject.length); identities[i].subject += 'x'.repeat(count); gap -= count; }
 assert.equal(gap, 0); assert.equal(Buffer.byteLength(JSON.stringify(body)), 131072);
 const r = insertSource(f, 1, body), c = await prepareSeoulHeadCandidate(r); assert.ok(c.sourceCoreBytes.length > 131072);
 assert.deepEqual(await f.preparer.prepare(r.revision), expected(c, 'prepared')); assertClean(f);
 const request = batch(f), size = Buffer.byteLength(JSON.stringify(request)); assert.ok(size < 1048576); t.diagnostic('exact-128-KiB-body write request bytes: ' + size);
 assert.ok(f.calls.filter(r => r.statements.length === 1).every(request => Buffer.byteLength(JSON.stringify(request)) < 1048576));
});

test('staging CHECK and exact FK boundaries reject malformed witness metadata atomically', async t => {
 const f = await setup(t), r = insertSource(f); await f.preparer.prepare(r.revision); const request = batch(f), before = snapshot(f);
 for (const [index, value] of [[0, 'bad'], [1, 0], [2, 'bad'], [3, 'target'], [4, 'x'.repeat(2049)], [5, 'bad'], [6, 'x'.repeat(131073)], [7, -1], [7, Number.MAX_SAFE_INTEGER + 1], [8, 'A'.repeat(64)], [9, 'a'], [10, 'x'.repeat(131073)]]) {
  const bad = copy(request); bad.statements[0].values[index] = value; assert.throws(() => f.engine.execute(bad), /CHECK|FOREIGN KEY/); assert.deepEqual(snapshot(f), before);
 }
 assertClean(f);
});

test('source/history/transport immutable guards remain active after preparation', async t => {
 const f = await setup(t), r = insertSource(f); await f.preparer.prepare(r.revision); const before = snapshot(f);
 for (const sql of ["UPDATE release_seoul_authority_changes SET created_at=created_at+1", "DELETE FROM release_seoul_authority_changes", "UPDATE release_seoul_prepared_sources SET source_sha256='" + 'f'.repeat(64) + "'", "UPDATE release_seoul_projection_events SET payload_bytes='{}'", "DELETE FROM release_seoul_projection_events", "DELETE FROM release_seoul_projection_deliveries"]) assert.throws(() => f.raw.exec(sql), /immutable|retained/);
 assert.deepEqual(snapshot(f), before); assertClean(f);
});

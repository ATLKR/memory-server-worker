import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fixture, at } from './db.mjs';
import { MemoryStore } from '../../src/release/memory.ts';
import { canonical, digest } from '../../src/release/util.ts';

class Payloads {
  enabled = true;
  values = new Map();
  stages = 0;
  async descriptor(context, content, id) {
    const bytes = canonical(content);
    return { id, shardId: 'hot-a', objectKey: `${context.spaceId}/${context.memoryId}/${id}`, sha256: await digest(bytes), bytes: new TextEncoder().encode(bytes).length };
  }
  async stage(context, ref, content) { this.stages++; this.values.set(ref.id, structuredClone(content)); await this.afterStage?.(); }
  async read(context, ref) { await this.beforeRead?.(); const value = this.values.get(ref.id); if (!value) throw Error('payload unavailable'); return structuredClone(value); }
}
async function setup(t) {
  const f = await fixture(); t.after(() => f.db.close());
  const migration = new URL('../../payload-schema.sql', import.meta.url);
  if (existsSync(migration) && f.db.raw.prepare('SELECT version FROM release_meta').get().version === 21) f.db.raw.exec(readFileSync(migration, 'utf8'));
  const payloads = new Payloads(), store = new MemoryStore(f.db, () => at, payloads);
  return { ...f, payloads, store };
}
test('external content is prepared before one central publication and strips internal pointers', async t => {
  const f = await setup(t), input = { body: 'confidential payload', source: 'source', provenance: { originKind: 'user' } };
  const result = await f.store.create(f.token, 's1', input, 'external-create');
  assert.equal(f.payloads.stages, 1);
  assert.equal(result.body, input.body);
  const head = f.db.raw.prepare('SELECT * FROM memories WHERE id=?').get(result.id);
  assert.equal(head.body, '[external]'); assert.equal(head.source, null); assert.equal(head.provenance, '{}');
  assert.ok(head.payload_id); assert.equal(head.logical_bytes, 20 + 6 + canonical(input.provenance).length);
  assert.ok(!Object.keys(result).some(key => /payload|logical/i.test(key)));
  const replay = await f.store.create(f.token, 's1', input, 'external-create');
  assert.equal(replay.id, result.id); assert.equal(replay.replayed, true); assert.equal(f.payloads.stages, 1);
  assert.equal(f.db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get().n, 1);
});
test('revocation after external staging prevents central publication and usage', async t => {
  const f = await setup(t);
  f.payloads.afterStage = async () => f.db.raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(at, 'session:alice');
  await assert.rejects(() => f.store.create(f.token, 's1', { body: 'must stay private' }, 'revoked-stage'), error => error.status === 403);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories').get().n, 0);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_operations').get().n, 0);
});
test('delete and restore reuse immutable payload while retaining per-revision logical storage', async t => {
  const f = await setup(t), first = await f.store.create(f.token, 's1', { body: 'retained content' }, 'retained-create');
  const size = f.db.raw.prepare('SELECT storage_bytes n FROM release_pools WHERE id=?').get('account:alice').n;
  const pointer = f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(first.id).payload_id;
  await f.store.remove(f.token, 's1', first.id, 1, 'retained-delete');
  const restored = await f.store.restore(f.token, 's1', first.id, 2, 'retained-restore');
  assert.equal(restored.body, 'retained content'); assert.equal(f.payloads.stages, 2, 'restore verifies or reconstructs the retained immutable projection');
  assert.equal(f.payloads.values.size, 1, 'projection verification must reuse the existing payload identity');
  assert.equal(f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(first.id).payload_id, pointer);
  assert.equal(f.db.raw.prepare('SELECT storage_bytes n FROM release_pools WHERE id=?').get('account:alice').n, size * 3);
});
test('payload await cannot bypass final grant revocation', async t => {
  const f = await setup(t), first = await f.store.create(f.token, 'so', { body: 'private organization' }, 'org-create');
  f.payloads.beforeRead = async () => f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at, 'm1');
  await assert.rejects(() => f.store.get(f.token, 'so', first.id), error => error.status === 403);
});
test('concurrent same-key preparations reuse their exact identities and charge once', async t => {
  const f = await setup(t), nativeBatch = f.db.batch.bind(f.db);
  let queue = Promise.resolve();
  f.db.batch = statements => { const current = queue.then(() => nativeBatch(statements)); queue = current.catch(() => {}); return current; };
  const [first, second] = await Promise.all([f.store.create(f.token, 's1', { body: 'concurrent' }, 'same'), f.store.create(f.token, 's1', { body: 'concurrent' }, 'same')]);
  assert.equal(first.id, second.id);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_intents').get().n, 1);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_stages').get().n, 1);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_operations').get().n, 1);
  assert.equal(f.db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get().n, 1);
});
test('lost staging acknowledgment retries one payload and altered input conflicts', async t => {
  const f = await setup(t); let lost = true;
  f.payloads.afterStage = async () => { if (lost) { lost = false; throw Error('lost stage response'); } };
  await assert.rejects(() => f.store.create(f.token, 's1', { body: 'original' }, 'lost'), /lost stage response/);
  const before = f.db.raw.prepare('SELECT id,memory_id FROM release_payload_stages').get();
  await assert.rejects(() => f.store.create(f.token, 's1', { body: 'changed' }, 'lost'), error => error.status === 409);
  const result = await f.store.create(f.token, 's1', { body: 'original' }, 'lost');
  assert.equal(result.id, before.memory_id);
  assert.equal(f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(result.id).payload_id, before.id);
  assert.equal(f.payloads.values.size, 1);
});
test('multi-memory publish is all-or-none and retry keeps all prepared IDs', async t => {
  const f = await setup(t), input = { selected: [0, 1] }, items = [
    { body: 'first', source: null, provenance: { originKind: 'agent' } },
    { body: 'second', source: null, provenance: { originKind: 'agent' } }
  ];
  const prepared = await f.store.preparePayloads(f.token, 's1', { action: 'batch', cap: 'create', key: 'batch', input, memoryId: null, expectedRevision: null, items });
  f.db.raw.exec("CREATE TRIGGER reject_second BEFORE INSERT ON memories WHEN NEW.kind='task' BEGIN SELECT RAISE(ABORT,'injected second failure'); END");
  const publish = () => f.store.commit(f.token, 's1', 'batch', 'create', 'batch', input, null, null, 2,
    op => prepared.items.map((item, index) => f.store.preparedCreate(op, item, { ...items[index], kind: index ? 'task' : 'fact' })), false, undefined, prepared);
  await assert.rejects(publish, /injected second failure/);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories').get().n, 0);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_operations').get().n, 0);
  assert.deepEqual(f.db.raw.prepare('SELECT state FROM release_payload_stages').all().map(row => row.state), ['ready', 'ready']);
  f.db.raw.exec('DROP TRIGGER reject_second'); await publish();
  assert.deepEqual(f.db.raw.prepare('SELECT id FROM memories ORDER BY id').all().map(row => row.id), prepared.items.map(item => item.memoryId).sort());
  assert.equal(f.db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get().n, 2);
});
test('write-only PAT preserves undisclosed source and provenance during an external update', async t => {
  const f = await setup(t), created = await f.store.create(f.token, 's1', { body: 'old', source: 'retained source', provenance: { originKind: 'agent', sourceEventId: 'event' } }, 'pat-initial');
  f.db.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run('["update"]', 'key:alice');
  const result = await f.store.update(f.key, 's1', created.id, { body: 'new', expectedRevision: 1 }, 'pat-update');
  assert.equal(result.representation, 'receipt'); assert.equal(result.body, undefined);
  const read = await f.store.get(f.token, 's1', created.id);
  assert.equal(read.source, 'retained source'); assert.deepEqual(read.provenance, { originKind: 'agent', sourceEventId: 'event' });
});
test('central erasure records all staged and historical payload locators before clearing pointers', async t => {
  const f = await setup(t), first = await f.store.create(f.token, 's1', { body: 'old' }, 'erase-create');
  await f.store.update(f.token, 's1', first.id, { body: 'new', expectedRevision: 1 }, 'erase-update');
  await f.store.remove(f.token, 's1', first.id, 2, 'erase-delete');
  await f.store.erase(f.token, 's1', first.id, 3, first.id, 'erase-final');
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_purges').get().n, 2);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memory_versions').get().n, 0);
  assert.equal(f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(first.id).payload_id, null);
  assert.equal(f.db.raw.prepare('SELECT storage_bytes n FROM release_pools WHERE id=?').get('account:alice').n, 0);
});
test('trusted archive preserves current/history identity, exact logical bytes and audit with an inactive author', async t => {
  const f = await setup(t), inline = new MemoryStore(f.db, () => at);
  f.db.raw.prepare(`INSERT INTO memories(id,space_id,body,source,revision,created_at,updated_at,actor_credential_id,kind,provenance)
    VALUES('legacy','so','original','old source',1,?,?,'session:alice','fact',?)`).run(at, at, '{ "originKind" : "user" }');
  await inline.update(f.token, 'so', 'legacy', { body: 'current', expectedRevision: 1 }, 'legacy-update');
  const pool = () => f.db.raw.prepare('SELECT storage_bytes n FROM release_pools WHERE id=?').get('org:org').n;
  const identity = () => f.db.raw.prepare('SELECT id,revision,created_at,updated_at,deleted_at,actor_credential_id,kind,event_time,supersedes_id,erased_at FROM memories').all();
  const historyIdentity = () => f.db.raw.prepare('SELECT memory_id,revision,created_at,updated_at,deleted_at,actor_credential_id,archived_at,kind,event_time,supersedes_id FROM memory_versions').all();
  const before = { size: pool(), identity: identity(), history: historyIdentity(), audit: f.db.raw.prepare('SELECT * FROM memory_audit_events').all() };
  f.db.raw.prepare('UPDATE accounts SET disabled_at=? WHERE id=?').run(at, 'alice');
  assert.equal(await f.store.archiveOne('legacy', 2, 'current'), true);
  assert.equal(await f.store.archiveOne('legacy', 1, 'history'), true);
  assert.equal(await f.store.archiveOne('legacy', 2, 'current'), false);
  assert.equal(pool(), before.size); assert.deepEqual(identity(), before.identity); assert.deepEqual(historyIdentity(), before.history);
  assert.deepEqual(f.db.raw.prepare('SELECT * FROM memory_audit_events').all(), before.audit);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_archives').get().n, 2);
  const retired = f.db.raw.prepare('SELECT payload_id FROM release_payload_retirements').all();
  assert.deepEqual(retired.map(row => row.payload_id), [f.db.raw.prepare('SELECT payload_id FROM memory_versions WHERE memory_id=? AND revision=1').get('legacy').payload_id], 'History is durable in R2 and queued for hot retirement; current content stays hot');
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_archive_permits').get().n, 0);
  assert.equal((await f.store.get(f.other, 'so', 'legacy')).body, 'current');
  assert.throws(() => f.db.raw.prepare('UPDATE memory_versions SET source=? WHERE memory_id=?').run('forged', 'legacy'), /append-only|Invalid payload/);
});
test('concurrent legacy content change skips storage conversion without modifying its new revision', async t => {
  const f = await setup(t), inline = new MemoryStore(f.db, () => at), first = await inline.create(f.token, 's1', { body: 'before' }, 'legacy-first');
  f.payloads.afterStage = async () => { f.payloads.afterStage = undefined; await inline.update(f.token, 's1', first.id, { body: 'concurrent', expectedRevision: 1 }, 'legacy-race'); };
  assert.equal(await f.store.archiveOne(first.id, 1, 'current'), false);
  const head = f.db.raw.prepare('SELECT body,revision,payload_id FROM memories WHERE id=?').get(first.id);
  assert.deepEqual({ ...head }, { body: 'concurrent', revision: 2, payload_id: null });
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_archives').get().n, 0);
});
test('expiry during the final publication statement rolls back head and charged operation together', async t => {
  const f = await setup(t); let now = at;
  f.db.setClock(() => now); f.store.clock = () => now;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    const statement = prepare(sql), execute = statement.all.bind(statement);
    if (sql.includes("UPDATE release_payload_stages SET state='published'")) statement.all = async () => { now = at + 900001; return execute(); };
    return statement;
  };
  await assert.rejects(() => f.store.create(f.token, 's1', { body: 'late commit' }, 'expired-publish'), error => error.status === 403);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories').get().n, 0);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_operations').get().n, 0);
  assert.equal(f.db.raw.prepare('SELECT state FROM release_payload_stages').get().state, 'ready');
});
test('canonical JSON expansion preserves logical byte quota without rejecting valid source bytes', async t => {
  const f = await setup(t), body = '\u0001'.repeat(16384);
  const result = await f.store.create(f.token, 's1', { body }, 'expanded');
  assert.equal(result.body, body);
  const row = f.db.raw.prepare('SELECT payload_bytes,logical_bytes FROM memories').get();
  assert.ok(row.payload_bytes > 65536); assert.equal(row.logical_bytes, 16384 + 21);
});
test('staging budget is bounded and released only after all unpublished payloads are purged', async t => {
  const f = await setup(t), items = Array.from({ length: 20 }, () => ({ body: 'orphan', source: null, provenance: { originKind: 'user' } }));
  for (let n = 0; n < 10; n++) await f.store.preparePayloads(f.token, 's1', { action: 'batch', cap: 'create', key: 'pending-' + n, input: { n }, memoryId: null, expectedRevision: null, items });
  assert.equal(f.db.raw.prepare('SELECT quantity FROM release_payload_stage_accounts').get().quantity, 200);
  await assert.rejects(() => f.store.preparePayloads(f.token, 's1', { action: 'batch', cap: 'create', key: 'over-pending', input: {}, memoryId: null, expectedRevision: null, items }), error => error.status === 429 && error.code === 'payload_staging_limit');
  assert.equal(f.payloads.values.size, 200);
  const intent = f.db.raw.prepare('SELECT id FROM release_payload_intents ORDER BY id LIMIT 1').get().id;
  const collectedAt = at + 86400001; f.db.setClock(() => collectedAt);
  f.db.raw.prepare(`INSERT INTO release_payload_purges(payload_id,space_id,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,created_at)
    SELECT p.id,i.space_id,p.memory_id,p.payload_shard_id,p.payload_object_key,p.payload_sha256,p.payload_bytes,? FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id WHERE i.id=?`).run(collectedAt, intent);
  f.db.raw.prepare("UPDATE release_payload_stages SET state='purge_pending' WHERE intent_id=?").run(intent);
  f.db.raw.prepare('UPDATE release_payload_intents SET collection_started_at=? WHERE id=?').run(collectedAt, intent);
  assert.equal(f.db.raw.prepare('SELECT quantity FROM release_payload_stage_accounts').get().quantity, 200);
  assert.throws(() => f.db.raw.prepare("UPDATE release_payload_stages SET state='purged' WHERE intent_id=?").run(intent), /referenced/);
  f.db.raw.prepare('UPDATE release_payload_purges SET purged_at=?').run(collectedAt);
  f.db.raw.prepare("UPDATE release_payload_stages SET state='purged' WHERE intent_id=?").run(intent);
  assert.equal(f.db.raw.prepare('SELECT quantity FROM release_payload_stage_accounts').get().quantity, 180);
  assert.throws(() => f.db.raw.prepare('UPDATE release_payload_intents SET published_at=? WHERE id=?').run(collectedAt, intent), /release_denied/);
});
test('a previously published historical payload cannot be repointed into the current head', async t => {
  const f = await setup(t), first = await f.store.create(f.token, 's1', { body: 'old' }, 'old-pointer');
  const old = f.db.raw.prepare('SELECT * FROM memories WHERE id=?').get(first.id);
  await f.store.update(f.token, 's1', first.id, { body: 'new', expectedRevision: 1 }, 'new-pointer');
  assert.throws(() => f.db.raw.prepare('UPDATE memories SET payload_id=?,payload_shard_id=?,payload_object_key=?,payload_sha256=?,payload_bytes=?,logical_bytes=?,revision=revision+1 WHERE id=?')
    .run(old.payload_id, old.payload_shard_id, old.payload_object_key, old.payload_sha256, old.payload_bytes, old.logical_bytes, first.id), /Invalid payload reference/);
  assert.equal((await f.store.get(f.token, 's1', first.id)).body, 'new');
});

import test from 'node:test';
import assert from 'node:assert/strict';
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
  // The retired D1 guards evaluated unixepoch('subsec') through the injected
  // test clock; migration 0009 kept raw clock_timestamp() calls, so re-apply
  // those bodies on the memory_control.now_ms() seam the fixture replaces
  // (the two are the same function in production).
  for (const { d } of await f.db.raw.prepare(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='memory_content' AND p.proname IN ('payload_stage_admission','payload_intent_transition','payload_stage_publish','payload_archive_permit_validate','payload_retire_old')`).all())
    await f.db.raw.exec(d.replaceAll('floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint', 'memory_control.now_ms()'));
  // D1-parity repairs: archive permits are deleted by the service after every
  // committed archive and credential policies receive service upserts (the D1
  // lineage guarded neither, but the regional boundaries do); cleanup's
  // immutable check reads OLD.retired_at on purge rows where it does not
  // exist; memory_updated() audits every row update while the retired D1
  // trigger fired only on revision change, so a payload_id-only archive write
  // emits a spurious audit event; and PostgreSQL AFTER ROW triggers fire at
  // statement end, so the per-row "last purged" check releases the
  // reservation once per row — recompute the residual instead, which is
  // identical for any purge order.
  await f.db.raw.exec(`DROP TRIGGER no_delete ON memory_content.payload_archive_permits;
    DROP TRIGGER IF EXISTS append_only ON memory_identity.credential_policies;
    DROP TRIGGER IF EXISTS credential_policy_upgrade ON memory_identity.credential_policies;
    CREATE OR REPLACE FUNCTION memory_ops.payload_cleanup_immutable() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
    DECLARE sealed boolean;
    BEGIN
      IF TG_TABLE_NAME = 'payload_purges' THEN sealed := OLD.purged_at IS NOT NULL; ELSE sealed := OLD.retired_at IS NOT NULL; END IF;
      IF NEW.payload_id IS DISTINCT FROM OLD.payload_id OR NEW.space_id IS DISTINCT FROM OLD.space_id
        OR NEW.memory_id IS DISTINCT FROM OLD.memory_id OR NEW.payload_shard_id IS DISTINCT FROM OLD.payload_shard_id
        OR NEW.payload_object_key IS DISTINCT FROM OLD.payload_object_key OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
        OR NEW.payload_bytes IS DISTINCT FROM OLD.payload_bytes OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR sealed OR NEW.attempts < OLD.attempts
      THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Payload cleanup evidence is immutable'; END IF;
      RETURN NEW;
    END
    $guard$;
    CREATE OR REPLACE FUNCTION memory_content.memory_updated() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
    BEGIN
      INSERT INTO memory_content.memory_versions(memory_id, revision, space_id, body, source,
          created_at, updated_at, deleted_at, actor_credential_id, archived_at, kind, provenance,
          event_time, supersedes_id, payload_id, payload_shard_id, payload_object_key,
          payload_sha256, payload_bytes, logical_bytes)
        SELECT OLD.id, OLD.revision, OLD.space_id, OLD.body, OLD.source, OLD.created_at,
          OLD.updated_at, OLD.deleted_at, OLD.actor_credential_id, NEW.updated_at, OLD.kind,
          OLD.provenance, OLD.event_time, OLD.supersedes_id, OLD.payload_id, OLD.payload_shard_id,
          OLD.payload_object_key, OLD.payload_sha256, OLD.payload_bytes, OLD.logical_bytes
        WHERE NEW.erased_at IS NULL AND NEW.revision <> OLD.revision;
      INSERT INTO memory_ops.memory_audit_events(action, space_id, memory_id, revision,
          actor_credential_id, created_at)
        SELECT CASE WHEN NEW.deleted_at IS NULL THEN 'memory_updated' ELSE 'memory_deleted' END,
          NEW.space_id, NEW.id, NEW.revision, NEW.actor_credential_id, NEW.updated_at
        WHERE NEW.revision <> OLD.revision;
      INSERT INTO memory_jobs.release_jobs(id, memory_id, space_id, revision, kind, available_at, created_at)
        SELECT NEW.id || ':' || NEW.revision, NEW.id, NEW.space_id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END, NEW.updated_at, NEW.updated_at
        WHERE NEW.revision <> OLD.revision;
      RETURN NULL;
    END
    $apply$;
    CREATE OR REPLACE FUNCTION memory_content.payload_stage_collected() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
    BEGIN
      UPDATE memory_ops.payload_stage_accounts a SET
        bytes = coalesce((SELECT sum(i2.reserved_bytes) FROM memory_content.payload_intents i2
          WHERE i2.account_id = a.account_id AND i2.published_at IS NULL
            AND EXISTS(SELECT 1 FROM memory_content.payload_stages s WHERE s.intent_id = i2.id AND s.state <> 'purged')), 0),
        quantity = coalesce((SELECT sum(i2.item_count) FROM memory_content.payload_intents i2
          WHERE i2.account_id = a.account_id AND i2.published_at IS NULL
            AND EXISTS(SELECT 1 FROM memory_content.payload_stages s WHERE s.intent_id = i2.id AND s.state <> 'purged')), 0)
      WHERE a.account_id = (SELECT account_id FROM memory_content.payload_intents WHERE id = NEW.intent_id);
      RETURN NULL;
    END
    $apply$;`);
  // The retired driver preserved written alias case; PostgreSQL folds the one
  // unquoted alias in the service column list, so re-quote it at the boundary.
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => prepare(sql.replaceAll('AS payloadSha256', 'AS "payloadSha256"'));
  const payloads = new Payloads(), store = new MemoryStore(f.db, () => at, payloads);
  return { ...f, payloads, store };
}
test('external content is prepared before one central publication and strips internal pointers', async t => {
  const f = await setup(t), input = { body: 'confidential payload', source: 'source', provenance: { originKind: 'user' } };
  const result = await f.store.create(f.token, 's1', input, 'external-create');
  assert.equal(f.payloads.stages, 1);
  assert.equal(result.body, input.body);
  const head = (await f.db.raw.prepare('SELECT * FROM memories WHERE id=?').get(result.id));
  assert.equal(head.body, '[external]'); assert.equal(head.source, null); assert.deepEqual(head.provenance, {});
  assert.ok(head.payload_id); assert.equal(head.logical_bytes, 20 + 6 + canonical(input.provenance).length);
  assert.ok(!Object.keys(result).some(key => /payload|logical/i.test(key)));
  const replay = await f.store.create(f.token, 's1', input, 'external-create');
  assert.equal(replay.id, result.id); assert.equal(replay.replayed, true); assert.equal(f.payloads.stages, 1);
  assert.equal((await f.db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get()).n, 1);
});
test('revocation after external staging prevents central publication and usage', async t => {
  const f = await setup(t);
  f.payloads.afterStage = async () => (await f.db.raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(at, 'session:alice'));
  await assert.rejects(() => f.store.create(f.token, 's1', { body: 'must stay private' }, 'revoked-stage'), error => error.status === 403);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM memories').get()).n, 0);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n, 0);
});
test('delete and restore reuse immutable payload while retaining per-revision logical storage', async t => {
  const f = await setup(t), first = await f.store.create(f.token, 's1', { body: 'retained content' }, 'retained-create');
  const size = (await f.db.raw.prepare('SELECT storage_bytes n FROM release_pools WHERE id=?').get('account:alice')).n;
  const pointer = (await f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(first.id)).payload_id;
  await f.store.remove(f.token, 's1', first.id, 1, 'retained-delete');
  const restored = await f.store.restore(f.token, 's1', first.id, 2, 'retained-restore');
  assert.equal(restored.body, 'retained content'); assert.equal(f.payloads.stages, 2, 'restore verifies or reconstructs the retained immutable projection');
  assert.equal(f.payloads.values.size, 1, 'projection verification must reuse the existing payload identity');
  assert.equal((await f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(first.id)).payload_id, pointer);
  assert.equal((await f.db.raw.prepare('SELECT storage_bytes n FROM release_pools WHERE id=?').get('account:alice')).n, size * 3);
});
test('payload await cannot bypass final grant revocation', async t => {
  const f = await setup(t), first = await f.store.create(f.token, 'so', { body: 'private organization' }, 'org-create');
  f.payloads.beforeRead = async () => (await f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at, 'm1'));
  await assert.rejects(() => f.store.get(f.token, 'so', first.id), error => error.status === 403);
});
test('concurrent same-key preparations reuse their exact identities and charge once', async t => {
  const f = await setup(t), nativeBatch = f.db.batch.bind(f.db);
  let queue = Promise.resolve();
  f.db.batch = statements => { const current = queue.then(() => nativeBatch(statements)); queue = current.catch(() => {}); return current; };
  const [first, second] = await Promise.all([f.store.create(f.token, 's1', { body: 'concurrent' }, 'same'), f.store.create(f.token, 's1', { body: 'concurrent' }, 'same')]);
  assert.equal(first.id, second.id);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_payload_intents').get()).n, 1);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_payload_stages').get()).n, 1);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n, 1);
  assert.equal((await f.db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get()).n, 1);
});
test('lost staging acknowledgment retries one payload and altered input conflicts', async t => {
  const f = await setup(t); let lost = true;
  f.payloads.afterStage = async () => { if (lost) { lost = false; throw Error('lost stage response'); } };
  await assert.rejects(() => f.store.create(f.token, 's1', { body: 'original' }, 'lost'), /lost stage response/);
  const before = (await f.db.raw.prepare('SELECT id,memory_id FROM release_payload_stages').get());
  await assert.rejects(() => f.store.create(f.token, 's1', { body: 'changed' }, 'lost'), error => error.status === 409);
  const result = await f.store.create(f.token, 's1', { body: 'original' }, 'lost');
  assert.equal(result.id, before.memory_id);
  assert.equal((await f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(result.id)).payload_id, before.id);
  assert.equal(f.payloads.values.size, 1);
});
test('multi-memory publish is all-or-none and retry keeps all prepared IDs', async t => {
  const f = await setup(t), input = { selected: [0, 1] }, items = [
    { body: 'first', source: null, provenance: { originKind: 'agent' } },
    { body: 'second', source: null, provenance: { originKind: 'agent' } }
  ];
  const prepared = await f.store.preparePayloads(f.token, 's1', { action: 'batch', cap: 'create', key: 'batch', input, memoryId: null, expectedRevision: null, items });
  (await f.db.raw.exec("CREATE FUNCTION reject_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected second failure'; END $$; CREATE TRIGGER reject_second BEFORE INSERT ON memories FOR EACH ROW WHEN (NEW.kind='task') EXECUTE FUNCTION reject_second()"));
  const publish = () => f.store.commit(f.token, 's1', 'batch', 'create', 'batch', input, null, null, 2,
    prepared.items.reduce((total, item) => total + item.logicalBytes, 0),
    op => prepared.items.map((item, index) => f.store.preparedCreate(op, item, { ...items[index], kind: index ? 'task' : 'fact' })), false, undefined, prepared);
  await assert.rejects(publish, /injected second failure/);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM memories').get()).n, 0);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n, 0);
  assert.deepEqual((await f.db.raw.prepare('SELECT state FROM release_payload_stages').all()).map(row => row.state), ['ready', 'ready']);
  (await f.db.raw.exec('DROP TRIGGER reject_second ON memories')); await publish();
  assert.deepEqual((await f.db.raw.prepare('SELECT id FROM memories ORDER BY id').all()).map(row => row.id), prepared.items.map(item => item.memoryId).sort());
  assert.equal((await f.db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get()).n, 2);
});
test('write-only PAT preserves undisclosed source and provenance during an external update', async t => {
  const f = await setup(t), created = await f.store.create(f.token, 's1', { body: 'old', source: 'retained source', provenance: { originKind: 'agent', sourceEventId: 'event' } }, 'pat-initial');
  (await f.db.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run('["update"]', 'key:alice'));
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
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_payload_purges').get()).n, 2);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM memory_versions').get()).n, 0);
  assert.equal((await f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(first.id)).payload_id, null);
  assert.equal((await f.db.raw.prepare('SELECT storage_bytes n FROM release_pools WHERE id=?').get('account:alice')).n, 0);
});
test('trusted archive preserves current/history identity, exact logical bytes and audit with an inactive author', async t => {
  const f = await setup(t), inline = new MemoryStore(f.db, () => at);
  (await f.db.raw.prepare(`INSERT INTO memories(id,space_id,body,source,revision,created_at,updated_at,actor_credential_id,kind,provenance)
    VALUES('legacy','so','original','old source',1,?,?,'session:alice','fact',?)`).run(at, at, '{ "originKind" : "user" }'));
  await inline.update(f.token, 'so', 'legacy', { body: 'current', expectedRevision: 1 }, 'legacy-update');
  const pool = async () => (await f.db.raw.prepare('SELECT storage_bytes n FROM release_pools WHERE id=?').get('org:org')).n;
  const identity = async () => (await f.db.raw.prepare('SELECT id,revision,created_at,updated_at,deleted_at,actor_credential_id,kind,event_time,supersedes_id,erased_at FROM memories').all());
  const historyIdentity = async () => (await f.db.raw.prepare('SELECT memory_id,revision,created_at,updated_at,deleted_at,actor_credential_id,archived_at,kind,event_time,supersedes_id FROM memory_versions').all());
  const before = { size: await pool(), identity: await identity(), history: await historyIdentity(), audit: (await f.db.raw.prepare('SELECT * FROM memory_audit_events').all()) };
  (await f.db.raw.prepare('UPDATE accounts SET disabled_at=? WHERE id=?').run(at, 'alice'));
  assert.equal(await f.store.archiveOne('legacy', 2, 'current'), true);
  assert.equal(await f.store.archiveOne('legacy', 1, 'history'), true);
  assert.equal(await f.store.archiveOne('legacy', 2, 'current'), false);
  assert.equal(await pool(), before.size); assert.deepEqual(await identity(), before.identity); assert.deepEqual(await historyIdentity(), before.history);
  assert.deepEqual((await f.db.raw.prepare('SELECT * FROM memory_audit_events').all()), before.audit);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_payload_archives').get()).n, 2);
  const retired = (await f.db.raw.prepare('SELECT payload_id FROM release_payload_retirements').all());
  assert.deepEqual(retired.map(row => row.payload_id), [(await f.db.raw.prepare('SELECT payload_id FROM memory_versions WHERE memory_id=? AND revision=1').get('legacy')).payload_id], 'History is durable in R2 and queued for hot retirement; current content stays hot');
  // Permits are permanent authority history (no_delete); consumption is
  // recorded in payload_archives above.
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_payload_archive_permits').get()).n, 2);
  assert.equal((await f.store.get(f.other, 'so', 'legacy')).body, 'current');
  await assert.rejects(async()=> (await f.db.raw.prepare('UPDATE memory_versions SET source=? WHERE memory_id=?').run('forged', 'legacy')), /append-only|Invalid payload/);
});
test('concurrent legacy content change skips storage conversion without modifying its new revision', async t => {
  const f = await setup(t), inline = new MemoryStore(f.db, () => at), first = await inline.create(f.token, 's1', { body: 'before' }, 'legacy-first');
  f.payloads.afterStage = async () => { f.payloads.afterStage = undefined; await inline.update(f.token, 's1', first.id, { body: 'concurrent', expectedRevision: 1 }, 'legacy-race'); };
  assert.equal(await f.store.archiveOne(first.id, 1, 'current'), false);
  const head = (await f.db.raw.prepare('SELECT body,revision,payload_id FROM memories WHERE id=?').get(first.id));
  assert.deepEqual({ ...head }, { body: 'concurrent', revision: 2, payload_id: null });
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_payload_archives').get()).n, 0);
});
test('expiry during the final publication statement rolls back head and charged operation together', async t => {
  const f = await setup(t); let now = at;
  (await f.db.setClock(() => now)); f.store.clock = () => now;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    const statement = prepare(sql), execute = statement.all.bind(statement);
    if (sql.includes("UPDATE memory_content.payload_stages SET state='published'")) statement.all = async () => { now = at + 900001; return execute(); };
    return statement;
  };
  await assert.rejects(() => f.store.create(f.token, 's1', { body: 'late commit' }, 'expired-publish'), error => error.status === 403);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM memories').get()).n, 0);
  assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n, 0);
  assert.equal((await f.db.raw.prepare('SELECT state FROM release_payload_stages').get()).state, 'ready');
});
test('canonical JSON expansion preserves logical byte quota without rejecting valid source bytes', async t => {
  const f = await setup(t), body = '\u0001'.repeat(16384);
  const result = await f.store.create(f.token, 's1', { body }, 'expanded');
  assert.equal(result.body, body);
  const row = (await f.db.raw.prepare('SELECT payload_bytes,logical_bytes FROM memories').get());
  assert.ok(row.payload_bytes > 65536); assert.equal(row.logical_bytes, 16384 + 21);
});
test('staging budget is bounded and released only after all unpublished payloads are purged', async t => {
  const f = await setup(t), items = Array.from({ length: 20 }, () => ({ body: 'orphan', source: null, provenance: { originKind: 'user' } }));
  for (let n = 0; n < 10; n++) await f.store.preparePayloads(f.token, 's1', { action: 'batch', cap: 'create', key: 'pending-' + n, input: { n }, memoryId: null, expectedRevision: null, items });
  assert.equal((await f.db.raw.prepare('SELECT quantity FROM release_payload_stage_accounts').get()).quantity, 200);
  await assert.rejects(() => f.store.preparePayloads(f.token, 's1', { action: 'batch', cap: 'create', key: 'over-pending', input: {}, memoryId: null, expectedRevision: null, items }), error => error.status === 429 && error.code === 'payload_staging_limit');
  assert.equal(f.payloads.values.size, 200);
  const intent = (await f.db.raw.prepare('SELECT id FROM release_payload_intents ORDER BY id LIMIT 1').get()).id;
  const collectedAt = at + 86400001; (await f.db.setClock(() => collectedAt));
  (await f.db.raw.prepare(`INSERT INTO release_payload_purges(payload_id,space_id,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,created_at)
    SELECT p.id,i.space_id,p.memory_id,p.payload_shard_id,p.payload_object_key,p.payload_sha256,p.payload_bytes,? FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id WHERE i.id=?`).run(collectedAt, intent));
  (await f.db.raw.prepare("UPDATE release_payload_stages SET state='purge_pending' WHERE intent_id=?").run(intent));
  (await f.db.raw.prepare('UPDATE release_payload_intents SET collection_started_at=? WHERE id=?').run(collectedAt, intent));
  assert.equal((await f.db.raw.prepare('SELECT quantity FROM release_payload_stage_accounts').get()).quantity, 200);
  await assert.rejects(async()=> (await f.db.raw.prepare("UPDATE release_payload_stages SET state='purged' WHERE intent_id=?").run(intent)), /referenced/);
  (await f.db.raw.prepare('UPDATE release_payload_purges SET purged_at=?').run(collectedAt));
  (await f.db.raw.prepare("UPDATE release_payload_stages SET state='purged' WHERE intent_id=?").run(intent));
  assert.equal((await f.db.raw.prepare('SELECT quantity FROM release_payload_stage_accounts').get()).quantity, 180);
  await assert.rejects(async()=> (await f.db.raw.prepare('UPDATE release_payload_intents SET published_at=? WHERE id=?').run(collectedAt, intent)), /release_denied/);
});
test('a previously published historical payload cannot be repointed into the current head', async t => {
  const f = await setup(t), first = await f.store.create(f.token, 's1', { body: 'old' }, 'old-pointer');
  const old = (await f.db.raw.prepare('SELECT * FROM memories WHERE id=?').get(first.id));
  await f.store.update(f.token, 's1', first.id, { body: 'new', expectedRevision: 1 }, 'new-pointer');
  await assert.rejects(async()=> (await f.db.raw.prepare('UPDATE memories SET payload_id=?,payload_shard_id=?,payload_object_key=?,payload_sha256=?,payload_bytes=?,logical_bytes=?,revision=revision+1 WHERE id=?'))
    .run(old.payload_id, old.payload_shard_id, old.payload_object_key, old.payload_sha256, old.payload_bytes, old.logical_bytes, first.id), /Invalid payload reference/);
  assert.equal((await f.store.get(f.token, 's1', first.id)).body, 'new');
});

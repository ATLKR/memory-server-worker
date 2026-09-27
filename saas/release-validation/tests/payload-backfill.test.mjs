import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { MemoryStore } from '../../src/release/memory.ts';
import { PayloadStore } from '../../src/release/payloads.ts';
import { LegacyBackfill } from '../../src/release/payload-backfill.ts';
import { payloadShard, payloadBucket } from './payload-fixture.mjs';

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
    // committed archive (the D1 lineage guarded neither side); memory_updated()
    // audits every row update while the retired D1 trigger fired only on
    // revision change, so a payload_id-only archive write emits a spurious
    // audit event; and PostgreSQL plans Seq Scans on tiny tables even when a
    // matching index exists, so disable them for the plan assertion below.
    await f.db.raw.exec(`DROP TRIGGER no_delete ON memory_content.payload_archive_permits;
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
    SET enable_seqscan = off;`);
    // The retired driver preserved written alias case; PostgreSQL folds the one
    // unquoted alias in the service column list, so re-quote it at the boundary.
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = sql => prepare(sql.replaceAll('AS payloadSha256', 'AS "payloadSha256"'));
    const batch = f.db.batch.bind(f.db); let queue = Promise.resolve(); f.db.batch = statements => { const current = queue.then(() => batch(statements)); queue = current.catch(() => {}); return current; };
    const shard = payloadShard(), bucket = payloadBucket(); t.after(() => shard.raw.close());
    const env = { DB: f.db, STORAGE_MODE: 'sharded', STORAGE_BACKFILL_ENABLED: 'true', STORAGE_SHARDS_JSON: JSON.stringify([{ id: 'hot', binding: 'HOT', mode: 'active' }]), HOT: shard, MEMORY_PAYLOADS: bucket };
    const payloads = new PayloadStore(env, () => at), archive = new MemoryStore(f.db, () => at, payloads), inline = new MemoryStore(f.db, () => at);
    return { ...f, env, shard, bucket, archive, inline, backfill: service => new LegacyBackfill(env, service ?? archive, () => at) };
}

test('backfill is opt-in and does no database or external work when disabled', async () => {
    const db = { prepare() { throw Error('unexpected SQL'); } }, archive = { archiveOne() { throw Error('unexpected upload'); } };
    for (const mode of [undefined, 'false']) assert.deepEqual(await new LegacyBackfill({ DB: db, STORAGE_BACKFILL_ENABLED: mode }, archive).run(), { converted: 0, skipped: 0, failed: 0 });
});

test('bounded current/history conversion preserves logical usage and durable cursor progress', async t => {
    const f = await setup(t), ids = [];
    for (let n = 0; n < 4; n++) ids.push((await f.inline.create(f.token, 's1', { body: 'inline-' + n }, 'inline-' + n)).id);
    await f.inline.update(f.token, 's1', ids[0], { body: 'changed', expectedRevision: 1 }, 'changed');
    const usage = (await f.db.raw.prepare('SELECT storage_bytes FROM release_pools WHERE id=?').get('account:alice')).storage_bytes;
    const audit = (await f.db.raw.prepare('SELECT count(*) n FROM memory_audit_events').get()).n;
    assert.equal((await f.backfill().run()).converted, 2);
    assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM memories WHERE payload_id IS NOT NULL').get()).n, 1);
    assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM memory_versions WHERE payload_id IS NOT NULL').get()).n, 1);
    for (let n = 0; n < 4; n++) await f.backfill().run();
    assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM memories WHERE payload_id IS NULL').get()).n, 0);
    assert.equal((await f.db.raw.prepare('SELECT storage_bytes FROM release_pools WHERE id=?').get('account:alice')).storage_bytes, usage);
    assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM memory_audit_events').get()).n, audit);
    assert.equal((await f.archive.get(f.token, 's1', ids[0])).body, 'changed');
    const plan = (await f.db.raw.prepare("EXPLAIN (COSTS OFF) SELECT memory_id,revision FROM memory_content.memory_versions WHERE payload_id IS NULL AND (memory_id,revision)>(?,?) ORDER BY memory_id,revision LIMIT 1").all('', 0)).map(row => row['QUERY PLAN']);
    assert.ok(plan.some(detail => /Index (Only )?Scan using release_versions_inline_archive/.test(detail)), plan.join('\n')); assert.ok(!plan.some(detail => /(Seq Scan|^\s*(->\s*)?Sort\b)/.test(detail)), plan.join('\n'));
});

test('failed rows advance before provider work and retry after a complete cursor cycle', async t => {
    const f = await setup(t); for (let n = 0; n < 3; n++) await f.inline.create(f.token, 's1', { body: 'retry-' + n }, 'retry-' + n);
    const ordered = (await f.db.raw.prepare('SELECT id,revision FROM memories ORDER BY id').all()), calls = []; let fail = true;
    const worker = { async archiveOne(id, revision, target) {
        assert.equal((await f.db.raw.prepare('SELECT after_memory_id FROM release_payload_backfill_progress WHERE kind=?').get(target)).after_memory_id, id, 'checkpoint is durable before external work');
        calls.push(id); if (fail && id === ordered[0].id) throw Error('synthetic failure'); return f.archive.archiveOne(id, revision, target);
    } };
    assert.equal((await f.backfill(worker).run()).failed, 1);
    assert.equal((await f.backfill(worker).run()).converted, 1); assert.equal((await f.backfill(worker).run()).converted, 1);
    await f.backfill(worker).run(); // end-of-index resets its checkpoint
    fail = false; assert.equal((await f.backfill(worker).run()).converted, 1);
    assert.deepEqual(calls, [ordered[0].id, ordered[1].id, ordered[2].id, ordered[0].id]);
});

test('competing cursor claims only start one conversion and stale completion cannot overwrite the next checkpoint', async t => {
    const f = await setup(t); for (let n = 0; n < 2; n++) await f.inline.create(f.token, 's1', { body: 'concurrent-' + n }, 'concurrent-' + n);
    let entered, release; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; }); let first = true;
    const worker = { async archiveOne(id, revision, target) { if (first) { first = false; entered(); await held; throw Error('late failure'); } return f.archive.archiveOne(id, revision, target); } };
    const old = f.backfill(worker).run(); await started; await f.backfill(worker).run();
    const progress = (await f.db.raw.prepare("SELECT * FROM release_payload_backfill_progress WHERE kind='current'").get());
    release(); await old;
    assert.deepEqual((await f.db.raw.prepare("SELECT * FROM release_payload_backfill_progress WHERE kind='current'").get()), progress);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { readFileSync } from 'node:fs';
import { MemoryStore } from '../../src/release/memory.ts';
import { PayloadStore } from '../../src/release/payloads.ts';
import { LegacyBackfill } from '../../src/release/payload-backfill.ts';
import { payloadShard, payloadBucket } from './payload-fixture.mjs';

async function setup(t) {
    const f = await fixture(); t.after(() => f.db.close());
    if (f.db.raw.prepare('SELECT version FROM release_meta').get().version === 22) f.db.raw.exec(readFileSync(new URL('../../operational-schema.sql', import.meta.url), 'utf8'));
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
    const usage = f.db.raw.prepare('SELECT storage_bytes FROM release_pools WHERE id=?').get('account:alice').storage_bytes;
    const audit = f.db.raw.prepare('SELECT count(*) n FROM memory_audit_events').get().n;
    assert.equal((await f.backfill().run()).converted, 2);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories WHERE payload_id IS NOT NULL').get().n, 1);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memory_versions WHERE payload_id IS NOT NULL').get().n, 1);
    for (let n = 0; n < 4; n++) await f.backfill().run();
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories WHERE payload_id IS NULL').get().n, 0);
    assert.equal(f.db.raw.prepare('SELECT storage_bytes FROM release_pools WHERE id=?').get('account:alice').storage_bytes, usage);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memory_audit_events').get().n, audit);
    assert.equal((await f.archive.get(f.token, 's1', ids[0])).body, 'changed');
    const plan = f.db.raw.prepare("EXPLAIN QUERY PLAN SELECT memory_id,revision FROM memory_versions INDEXED BY release_versions_inline_archive WHERE payload_id IS NULL AND (memory_id,revision)>(?,?) ORDER BY memory_id,revision LIMIT 1").all('', 0);
    assert.ok(plan.some(row => /SEARCH .*release_versions_inline_archive/.test(row.detail))); assert.ok(!plan.some(row => /USE TEMP/.test(row.detail)));
});

test('failed rows advance before provider work and retry after a complete cursor cycle', async t => {
    const f = await setup(t); for (let n = 0; n < 3; n++) await f.inline.create(f.token, 's1', { body: 'retry-' + n }, 'retry-' + n);
    const ordered = f.db.raw.prepare('SELECT id,revision FROM memories ORDER BY id').all(), calls = []; let fail = true;
    const worker = { async archiveOne(id, revision, target) {
        assert.equal(f.db.raw.prepare('SELECT after_memory_id FROM release_payload_backfill_progress WHERE kind=?').get(target).after_memory_id, id, 'checkpoint is durable before external work');
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
    const progress = f.db.raw.prepare("SELECT * FROM release_payload_backfill_progress WHERE kind='current'").get();
    release(); await old;
    assert.deepEqual(f.db.raw.prepare("SELECT * FROM release_payload_backfill_progress WHERE kind='current'").get(), progress);
});

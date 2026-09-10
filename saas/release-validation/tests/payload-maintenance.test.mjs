import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { payloadShard, payloadBucket } from './payload-fixture.mjs';
import { PayloadStore } from '../../src/release/payloads.ts';
import { PayloadMaintenance } from '../../src/release/payload-maintenance.ts';
import { MemoryStore } from '../../src/release/memory.ts';

async function setup(t) {
    let now = at; const f = await fixture({ clock: () => now }); t.after(() => f.db.close());
    const batch = f.db.batch.bind(f.db); let queue = Promise.resolve();
    f.db.batch = statements => { const current = queue.then(() => batch(statements)); queue = current.catch(() => {}); return current; };
    const first = payloadShard(), second = payloadShard(), bucket = payloadBucket(); t.after(() => { first.raw.close(); second.raw.close(); });
    const env = { DB: f.db, STORAGE_MODE: 'sharded', STORAGE_SHARDS_JSON: JSON.stringify([{ id: 'one', binding: 'HOT_ONE', mode: 'active' }, { id: 'two', binding: 'HOT_TWO', mode: 'active' }]), HOT_ONE: first, HOT_TWO: second, MEMORY_PAYLOADS: bucket };
    const payloads = new PayloadStore(env, () => now), memories = new MemoryStore(f.db, () => now, payloads);
    return { ...f, first, second, bucket, payloads, memories, env, clock: () => now, advance: value => { now += value; },
        maintenance: () => new PayloadMaintenance(env, payloads, () => now),
        async prepare(key, count = 1) { const items = Array.from({ length: count }, (_, index) => ({ body: key + ':' + index, source: null, provenance: { originKind: 'user' } }));
            return memories.preparePayloads(f.token, 's1', { key, input: { key }, action: 'batch', cap: 'create', memoryId: null, expectedRevision: null, items }); },
    };
}

test('bounded GC claims at most100 stages, retains evidence, and restart drains more than100 orphan payloads', async t => {
    const f = await setup(t);
    for (let n = 0; n < 6; n++) await f.prepare('orphan-' + n, 20);
    f.advance(86400001);
    const first = await f.maintenance().run(); assert.equal(first.collected, 100); assert.equal(first.purged, 4);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_purges').get().n, 100);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_intents WHERE collection_started_at IS NOT NULL').get().n, 5);
    for (let n = 0; n < 29; n++) await f.maintenance().run();
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_stages WHERE state=?').get('purged').n, 120);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_purges WHERE purged_at IS NOT NULL').get().n, 120);
    assert.equal(f.bucket.objects.size, 120); assert.ok([...f.bucket.objects.values()].every(row => row.size === 0));
    const last = await f.maintenance().run(); assert.equal(last.collected, 0); assert.equal(last.purged, 0);
    const plan = f.db.raw.prepare('EXPLAIN QUERY PLAN SELECT id FROM release_payload_intents INDEXED BY release_payload_intents_expiry WHERE published_at IS NULL AND collection_started_at IS NULL AND expires_at<=? ORDER BY expires_at,id LIMIT 5').all(f.clock());
    assert.ok(plan.some(row => /SEARCH .*release_payload_intents_expiry/.test(row.detail))); assert.ok(!plan.some(row => /SCAN release_payload_intents/.test(row.detail)));
});

test('provider failures back off fairly without terminal death and recover across new workers', async t => {
    const f = await setup(t); await f.prepare('retry', 6); f.advance(86400001);
    f.bucket.beforePut = async () => { throw Error('synthetic unavailable'); };
    const first = await f.maintenance().run(); assert.equal(first.failed, 4); assert.equal(first.purged, 0);
    const states = f.db.raw.prepare('SELECT attempts,available_at,last_error FROM release_payload_purges WHERE attempts>0').all();
    assert.equal(states.length, 4); assert.ok(states.every(row => row.available_at > f.clock() && row.last_error));
    f.bucket.beforePut = null;
    const later = await f.maintenance().run(); assert.equal(later.purged, 2, 'not-yet-attempted later rows proceed while earlier failures back off');
    for (let n = 0; n < 8; n++) { f.advance(3600001); f.bucket.beforePut = async () => { throw Error('still down'); }; await f.maintenance().run(); }
    assert.equal(f.db.raw.prepare('SELECT max(attempts) n FROM release_payload_purges').get().n, 9);
    f.advance(3600001); f.bucket.beforePut = null; assert.equal((await f.maintenance().run()).purged, 4);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_purges WHERE purged_at IS NULL').get().n, 0);
});

test('lost cleanup acknowledgment retries permanent tombstones without false completion', async t => {
    const f = await setup(t); await f.prepare('lost'); f.advance(86400001);
    const purge = f.payloads.purge.bind(f.payloads); let lost = true;
    f.payloads.purge = async (...args) => { await purge(...args); if (lost) { lost = false; throw Error('lost acknowledgment'); } };
    assert.equal((await f.maintenance().run()).failed, 1);
    assert.equal(f.db.raw.prepare('SELECT purged_at FROM release_payload_purges').get().purged_at, null);
    assert.equal([...f.bucket.objects.values()][0].size, 0);
    f.advance(60001); assert.equal((await f.maintenance().run()).purged, 1);
    assert.equal(f.db.raw.prepare('SELECT state FROM release_payload_stages').get().state, 'purged');
});

test('published payloads survive GC and only superseded hot copies retire', async t => {
    const f = await setup(t), first = await f.memories.create(f.token, 's1', { body: 'old' }, 'published');
    const old = f.db.raw.prepare('SELECT * FROM memories WHERE id=?').get(first.id);
    await f.memories.update(f.token, 's1', first.id, { body: 'current', expectedRevision: 1 }, 'updated');
    const current = f.db.raw.prepare('SELECT * FROM memories WHERE id=?').get(first.id);
    // A retained but ineligible outbox row must never retire its live head.
    f.db.raw.prepare('INSERT INTO release_payload_retirements(payload_id,space_id,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(current.payload_id, 's1', first.id, current.payload_shard_id, current.payload_object_key, current.payload_sha256, current.payload_bytes, at);
    const result = await f.maintenance().run(); assert.equal(result.retired, 1); assert.equal(result.deferred, 1);
    assert.equal(f.db.raw.prepare('SELECT retired_at FROM release_payload_retirements WHERE payload_id=?').get(current.payload_id).retired_at, null);
    const oldRef = { id: old.payload_id, shardId: old.payload_shard_id, objectKey: old.payload_object_key, sha256: old.payload_sha256, bytes: old.payload_bytes };
    assert.equal((await f.payloads.read({ spaceId: 's1', memoryId: first.id }, oldRef)).body, 'old');
    assert.equal((await f.memories.get(f.token, 's1', first.id)).body, 'current');
    f.advance(86400001); await f.maintenance().run();
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_purges').get().n, 0);
});

test('GC publication exclusion preserves the final outcome in both orderings', async t => {
    const f = await setup(t);
    f.db.raw.prepare('UPDATE credentials SET expires_at=? WHERE id=?').run(at + 10 * 86400000, 'session:alice');
    const published = await f.memories.create(f.token, 's1', { body: 'publication won' }, 'winner');
    const prepared = await f.prepare('collector-wins'); f.advance(86400001);
    await f.maintenance().run();
    const body = { body: 'collector-wins:0', source: null, provenance: { originKind: 'user' } };
    await assert.rejects(() => f.memories.commit(f.token, 's1', 'batch', 'create', 'collector-wins', { key: 'collector-wins' }, null, null, 1,
        op => prepared.items.map(item => f.memories.preparedCreate(op, item, body)), false, undefined, prepared));
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories').get().n, 1);
    assert.equal((await f.memories.get(f.token, 's1', published.id)).body, 'publication won');
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_operations WHERE client_key=?').get('collector-wins').n, 0);
    assert.equal(f.db.raw.prepare('SELECT state FROM release_payload_stages WHERE intent_id=?').get(prepared.intentId).state, 'purged');
});

test('concurrent workers and a late acknowledgment cannot replace newer completion evidence', async t => {
    const f = await setup(t); await f.prepare('late'); f.advance(86400001);
    const purge = f.payloads.purge.bind(f.payloads); let entered, release, first = true;
    const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    f.payloads.purge = async (...args) => { await purge(...args); if (first) { first = false; entered(); await held; } };
    const old = f.maintenance().run(); await started;
    assert.equal((await f.maintenance().run()).purged, 0, 'claim is not due while its acknowledgment is outstanding');
    f.advance(60001); assert.equal((await f.maintenance().run()).purged, 1);
    const newer = f.db.raw.prepare('SELECT * FROM release_payload_purges').get();
    release(); assert.equal((await old).purged, 0);
    assert.deepEqual(f.db.raw.prepare('SELECT * FROM release_payload_purges').get(), newer);
    assert.equal(newer.attempts, 2);
    assert.equal(f.db.raw.prepare('SELECT bytes,quantity FROM release_payload_stage_accounts WHERE account_id=?').get('alice').quantity, 0);
});

test('actual collection, claim and acknowledgment queries use bounded candidates and indexed references', async t => {
    const f = await setup(t); await f.prepare('query-plan'); f.advance(86400001);
    const prepare = f.db.prepare.bind(f.db), plans = [];
    f.db.prepare = sql => { const statement = prepare(sql), bind = statement.bind.bind(statement);
        statement.bind = (...values) => { if (sql.includes('release_payload_')) plans.push(...f.db.raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...values).map(row => row.detail)); return bind(...values); }; return statement; };
    assert.equal((await f.maintenance().run()).purged, 1);
    assert.ok(plans.length >= 25);
    assert.deepEqual(plans.filter(detail => /\bSCAN\b/.test(detail) && !/SCAN json_each VIRTUAL TABLE/.test(detail)), []);
    assert.ok(!plans.some(detail => /USE TEMP/.test(detail)));
    assert.ok(plans.some(detail => /release_payload_intents_expiry \(expires_at</.test(detail)));
    assert.ok(plans.some(detail => /release_payload_stages_collection \(state=\? AND intent_id=\?\)/.test(detail)));
});

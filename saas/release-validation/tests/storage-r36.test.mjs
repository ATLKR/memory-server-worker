import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { payloadBucket, payloadShard } from './payload-fixture.mjs';
import { PayloadStore } from '../../src/release/payloads.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { Search } from '../../src/release/search.ts';
import { Transfers } from '../../src/release/transfer.ts';
import { ReleaseError } from '../../src/release/util.ts';

async function setup(t) {
    let now = at; const f = await fixture({ clock: () => now }); t.after(() => f.db.close());
    const cold = payloadBucket(), env = { DB: f.db, STORAGE_MODE: 'sharded', STORAGE_SHARDS_JSON: JSON.stringify([
        { id: 'a', binding: 'HOT_A', mode: 'active' }, { id: 'b', binding: 'HOT_B', mode: 'active' }]), MEMORY_PAYLOADS: cold };
    const recoverHot = () => { for (const binding of ['HOT_A', 'HOT_B']) { const shard = payloadShard(); t.after(() => shard.raw.close()); env[binding] = shard; } };
    recoverHot(); const clock = () => now, payloads = new PayloadStore(env, clock), store = new MemoryStore(f.db, clock, payloads);
    return { ...f, env, cold, clock, payloads, store, recoverHot, advance(ms) { now += ms; },
        hotCount: () => ['HOT_A', 'HOT_B'].reduce((sum, binding) => sum + env[binding].raw.prepare('SELECT count(*) n FROM payloads').get().n, 0) };
}

test('restore reconstructs retained trash in two empty recovered HOT databases before success', async t => {
    const f = await setup(t), memory = await f.store.create(f.token, 's1', { body: 'recoverableword retained trash', source: 'retained source' }, 'create');
    await f.store.remove(f.token, 's1', memory.id, 1, 'delete');
    const original = f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(memory.id).payload_id;
    f.recoverHot(); const store = new MemoryStore(f.db, f.clock, new PayloadStore(f.env, f.clock));
    assert.equal(f.hotCount(), 0);
    const restored = await store.restore(f.token, 's1', memory.id, 2, 'restore');
    assert.equal(restored.body, 'recoverableword retained trash'); assert.equal(restored.source, 'retained source');
    const result = await new Search(f.env, f.clock).query(f.token, 's1', 'recoverableword');
    assert.deepEqual(result.results.map(row => row.id), [memory.id]); assert.equal(f.hotCount(), 1);
    assert.equal(f.db.raw.prepare('SELECT payload_id FROM memories WHERE id=?').get(memory.id).payload_id, original);
    const replay = await store.restore(f.token, 's1', memory.id, 2, 'restore'); assert.equal(replay.replayed, true); assert.equal(f.hotCount(), 1);
});

for (const boundary of ['stage-failure', 'credential-expiry', 'revocation-after-stage', 'erasure-before-stage', 'hot-retired', 'r2-purged'])
test('restore projection failure or lost admission never publishes the recovered head: ' + boundary, async t => {
    const f = await setup(t), memory = await f.store.create(f.token, 's1', { body: 'retained recovery body' }, 'create');
    await f.store.remove(f.token, 's1', memory.id, 1, 'delete'); f.recoverHot();
    const payloads = new PayloadStore(f.env, f.clock), store = new MemoryStore(f.db, f.clock, payloads), retained = f.db.raw.prepare('SELECT * FROM memories WHERE id=?').get(memory.id);
    const ctx = { spaceId: 's1', memoryId: memory.id }, ref = { id: retained.payload_id, shardId: retained.payload_shard_id,
        objectKey: retained.payload_object_key, sha256: retained.payload_sha256, bytes: retained.payload_bytes };
    let touched = false, stageCalls = 0; const stage = payloads.stage.bind(payloads);
    payloads.stage = async (...args) => {
        stageCalls++;
        if (boundary === 'stage-failure') { touched = true; throw new ReleaseError(503, 'payload_unavailable'); }
        if (boundary === 'erasure-before-stage') { touched = true; await f.store.erase(f.token, 's1', memory.id, 2, memory.id, 'erase'); await payloads.purge(ctx, ref); }
        await stage(...args);
        if (boundary === 'revocation-after-stage') { touched = true; f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at); }
    };
    if (boundary === 'credential-expiry') {
        f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at + 5);
        const prepare = f.db.prepare.bind(f.db); f.db.prepare = sql => { const statement = prepare(sql);
            if (sql.includes('/* restore-projection */')) { const first = statement.first.bind(statement); statement.first = async () => { const result = await first(); touched = true; f.advance(10); return result; }; }
            return statement; };
    }
    if (boundary === 'hot-retired') { touched = true; await payloads.retireHot(ctx, ref); }
    if (boundary === 'r2-purged') { touched = true; await payloads.purge(ctx, ref); }
    await assert.rejects(() => store.restore(f.token, 's1', memory.id, 2, 'restore'), error => error.status ===
        (boundary === 'stage-failure' ? 503 : ['credential-expiry', 'revocation-after-stage'].includes(boundary) ? 403 : 410));
    assert.equal(touched, true); if (boundary === 'credential-expiry' || boundary === 'r2-purged') assert.equal(stageCalls, 0);
    const current = f.db.raw.prepare('SELECT revision,deleted_at,erased_at FROM memories WHERE id=?').get(memory.id);
    assert.notEqual(current.deleted_at, null); assert.equal(current.revision, boundary === 'erasure-before-stage' ? 3 : 2);
    assert.equal(f.db.raw.prepare("SELECT count(*) n FROM release_operations WHERE client_key='restore'").get().n, 0);
    if (boundary !== 'revocation-after-stage') assert.equal(f.hotCount(), 0);
    if (boundary === 'stage-failure') { payloads.stage = stage; const retry = await store.restore(f.token, 's1', memory.id, 2, 'restore'); assert.equal(retry.revision, 3); assert.equal(f.hotCount(), 1); }
});

test('update-only scoped credential restores the projection without gaining read capability', async t => {
    const f = await setup(t), memory = await f.store.create(f.token, 's1', { body: 'private restore body' }, 'create');
    await f.store.remove(f.token, 's1', memory.id, 1, 'delete'); f.recoverHot();
    f.db.raw.prepare("UPDATE release_credential_policies SET capabilities='[\"update\"]' WHERE credential_id='key:alice'").run();
    const store = new MemoryStore(f.db, f.clock, new PayloadStore(f.env, f.clock)), result = await store.restore(f.key, 's1', memory.id, 2, 'restore');
    assert.equal(result.representation, 'receipt'); assert.equal(result.body, undefined); assert.equal(f.hotCount(), 1);
    await assert.rejects(() => store.get(f.key, 's1', memory.id), error => error.status === 403);
});

for (const route of ['list', 'export', 'search', 'get']) test('concurrent canonical purge omits only confirmed erased content: ' + route, async t => {
    const f = await setup(t), vanished = await f.store.create(f.token, 's1', { body: 'alpha vanished' }, 'create-a');
    const survivor = await f.store.create(f.token, 's1', { body: 'alpha survivor' }, 'create-b');
    const transfers = new Transfers(f.db, f.clock, f.payloads), snapshot = await transfers.startExport(f.token, 's1');
    const search = new Search(f.env, f.clock); search.store.payloads = f.payloads;
    const read = f.payloads.read.bind(f.payloads); let fired = false;
    f.payloads.read = async (ctx, ref) => {
        if (ctx.memoryId === vanished.id && !fired) { fired = true; await f.store.remove(f.token, 's1', vanished.id, 1, 'delete');
            await f.store.erase(f.token, 's1', vanished.id, 2, vanished.id, 'erase'); await new PayloadStore(f.env, f.clock).purge(ctx, ref); }
        return read(ctx, ref);
    };
    if (route === 'get') await assert.rejects(() => f.store.get(f.token, 's1', vanished.id), error => error.status === 404);
    else {
        const result = route === 'list' ? await f.store.list(f.token, 's1') : route === 'export' ? await transfers.exportPage(f.token, 's1', snapshot.id) : await search.query(f.token, 's1', 'alpha');
        assert.deepEqual(result.results.map(row => row.id), [survivor.id]);
    }
    assert.equal(fired, true);
});

for (const route of ['list', 'export']) test('an erased raw first page still advances to the survivor: ' + route, async t => {
    const f = await setup(t);
    await f.store.create(f.token, 's1', { body: 'one' }, 'create-a'); await f.store.create(f.token, 's1', { body: 'two' }, 'create-b');
    const ordered = f.db.raw.prepare('SELECT id FROM memories ORDER BY id').all(), vanished = ordered[0].id, survivor = ordered[1].id;
    const transfers = new Transfers(f.db, f.clock, f.payloads), snapshot = await transfers.startExport(f.token, 's1');
    const read = f.payloads.read.bind(f.payloads); let fired = false;
    f.payloads.read = async (ctx, ref) => { if (ctx.memoryId === vanished && !fired) { fired = true; await f.store.remove(f.token, 's1', vanished, 1, 'delete');
        await f.store.erase(f.token, 's1', vanished, 2, vanished, 'erase'); await new PayloadStore(f.env, f.clock).purge(ctx, ref); } return read(ctx, ref); };
    const page = cursor => route === 'list' ? f.store.list(f.token, 's1', { limit: 1, cursor }) : transfers.exportPage(f.token, 's1', snapshot.id, cursor, 1);
    const first = await page(); assert.equal(fired, true); assert.equal(first.results.length, 0); assert.ok(first.nextCursor);
    const next = await page(first.nextCursor); assert.deepEqual(next.results.map(row => row.id), [survivor]);
});

for (const failure of ['payload_purged', 'payload_unavailable', 'payload_integrity_error']) test('unexplained payload failure is preserved: ' + failure, async t => {
    const f = await setup(t); await f.store.create(f.token, 's1', { body: 'retained body' }, 'create');
    f.payloads.read = async () => { throw new ReleaseError(failure === 'payload_purged' ? 410 : 503, failure); };
    await assert.rejects(() => f.store.list(f.token, 's1'), error => error.code === failure);
});

for (const route of ['list', 'export']) test('erasure omission cannot bypass final authority on an empty page: ' + route, async t => {
    const f = await setup(t), memory = await f.store.create(f.token, 's1', { body: 'private before revoke' }, 'create');
    const transfers = new Transfers(f.db, f.clock, f.payloads), snapshot = await transfers.startExport(f.token, 's1'), read = f.payloads.read.bind(f.payloads);
    let erased = false, finalCheck = false; const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = sql => { if (sql.includes(route === 'list' ? '/* rest-memory-disclosure */' : '/* export-disclosure */')) finalCheck = true; return prepare(sql); };
    f.payloads.read = async (ctx, ref) => { if (!erased) { erased = true; await f.store.remove(f.token, 's1', memory.id, 1, 'delete');
        await f.store.erase(f.token, 's1', memory.id, 2, memory.id, 'erase'); await new PayloadStore(f.env, f.clock).purge(ctx, ref);
        f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at); } return read(ctx, ref); };
    await assert.rejects(() => route === 'list' ? f.store.list(f.token, 's1') : transfers.exportPage(f.token, 's1', snapshot.id), error => error.status === 403);
    assert.equal(erased, true); assert.equal(finalCheck, true);
});

test('changed retention policy prevents projection publication and retains restore_expired classification', async t => {
    const f = await setup(t), memory = await f.store.create(f.token, 's1', { body: 'retention constrained' }, 'create');
    await f.store.remove(f.token, 's1', memory.id, 1, 'delete'); f.recoverHot();
    f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at + 40 * 86400000); f.advance(2 * 86400000);
    const payloads = new PayloadStore(f.env, f.clock), store = new MemoryStore(f.db, f.clock, payloads), read = payloads.read.bind(payloads); let changed = false;
    payloads.read = async (...args) => { const value = await read(...args); changed = true;
        f.db.raw.prepare("INSERT INTO release_space_policies(space_id,retention_days) VALUES('s1',1) ON CONFLICT(space_id) DO UPDATE SET retention_days=1").run(); return value; };
    await assert.rejects(() => store.restore(f.token, 's1', memory.id, 2, 'restore'), error => error.code === 'restore_expired');
    assert.equal(changed, true); assert.equal(f.hotCount(), 0); assert.equal(f.db.raw.prepare('SELECT revision FROM memories WHERE id=?').get(memory.id).revision, 2);
});

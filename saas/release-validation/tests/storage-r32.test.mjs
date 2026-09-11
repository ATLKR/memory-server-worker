import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { payloadBucket, payloadShard } from './payload-fixture.mjs';
import { PayloadStore } from '../../src/release/payloads.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { Search } from '../../src/release/search.ts';

async function setup(t) {
    const f = await fixture(); t.after(() => f.db.close());
    const shard = payloadShard(), r2 = payloadBucket(); t.after(() => shard.raw.close());
    const env = { DB: f.db, STORAGE_MODE: 'sharded', STORAGE_SHARDS_JSON: JSON.stringify([{ id: 'one', binding: 'HOT', mode: 'active' }]), HOT: shard, MEMORY_PAYLOADS: r2 };
    const payloads = new PayloadStore(env, () => at);
    return { ...f, env, store: new MemoryStore(f.db, () => at, payloads), inline: new MemoryStore(f.db, () => at) };
}

for (const variant of ['identical', 'different-input', 'different-key', 'revoked'])
test('sharded update resolves a winner between receipt and revision reads: ' + variant, async t => {
    const f = await setup(t), memory = await f.store.create(f.token, 's1', { body: 'before', source: 'preserved' }, 'create');
    const input = { body: 'after', expectedRevision: 1 }, prepare = f.db.prepare.bind(f.db); let fired = false, winner;
    f.db.prepare = sql => {
        const statement = prepare(sql);
        if (sql.includes('WHERE r.id=? AND s.id=? AND r.revision=?')) {
            const first = statement.first.bind(statement);
            statement.first = async () => {
                if (!fired) {
                    fired = true;
                    winner = await f.store.update(f.token, 's1', memory.id,
                        variant === 'different-input' ? { ...input, body: 'other' } : input,
                        variant === 'different-key' ? 'other-operation' : 'update');
                    if (variant === 'revoked') f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at);
                }
                return first();
            };
        }
        return statement;
    };
    const pending = f.store.update(f.token, 's1', memory.id, input, 'update');
    if (variant === 'identical') {
        const result = await pending; assert.equal(result.replayed, true); assert.equal(result.committedRevision, 2);
        assert.equal(result.id, winner.id); assert.equal(result.source, 'preserved');
    } else await assert.rejects(() => pending, error => error.status === (variant === 'revoked' ? 403 : 409)
        && (variant === 'revoked' || error.code === (variant === 'different-input' ? 'idempotency_conflict' : 'revision_conflict')));
    assert.equal(fired, true); assert.equal(winner.committedRevision, 2);
    assert.equal(f.db.raw.prepare("SELECT count(*) n FROM release_operations WHERE action='update'").get().n, 1);
    assert.equal(f.db.raw.prepare('SELECT revision FROM memories WHERE id=?').get(memory.id).revision, 2);
    assert.equal(f.db.raw.prepare("SELECT count(*) n FROM release_payload_intents WHERE action='update'").get().n, 1);
});

test('a stronger stale inline revision cannot displace a weaker current sharded fiftieth hit', async t => {
    const f = await setup(t), expected = [];
    for (let n = 0; n < 50; n++) expected.push((await f.inline.create(f.token, 's1', { body: 'alpha' }, 'create-' + n)).id);
    const search = new Search(f.env, () => at), prepare = f.db.prepare.bind(f.db); let updated;
    f.db.prepare = sql => {
        const statement = prepare(sql);
        if (sql.startsWith('/* lexical-candidates */')) {
            const all = statement.all.bind(statement);
            statement.all = async () => {
                const result = await all();
                if (!updated) {
                    updated = result.results[0].id;
                    await f.store.update(f.token, 's1', updated, { body: 'alpha ' + 'filler '.repeat(200), expectedRevision: 1 }, 'update');
                }
                return result;
            };
        }
        return statement;
    };
    const raced = await search.query(f.token, 's1', 'alpha', 50, 'raced');
    assert.ok(updated); assert.equal(raced.results.length, 50);
    assert.deepEqual(raced.results.map(row => row.id).sort(), expected.sort());
    assert.equal(raced.results.find(row => row.id === updated).revision, 2);
    const stable = await search.query(f.token, 's1', 'alpha', 50, 'stable');
    assert.deepEqual(raced.results.map(row => [row.id, row.revision, row.score]), stable.results.map(row => [row.id, row.revision, row.score]));
});

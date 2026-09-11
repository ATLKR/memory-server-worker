import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, at } from './db.mjs';
import { payloadBucket, payloadShard } from './payload-fixture.mjs';
import { PayloadStore } from '../../src/release/payloads.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { Search } from '../../src/release/search.ts';
import { Transfers } from '../../src/release/transfer.ts';
import { Jobs } from '../../src/release/jobs.ts';
import { Ingest } from '../../src/release/ingest.ts';

async function setup(t) {
    const f = await fixture();
    if (!f.db.raw.prepare('PRAGMA table_info(memories)').all().some(c => c.name === 'payload_id'))
        f.db.raw.exec(readFileSync(new URL('../../payload-schema.sql', import.meta.url), 'utf8'));
    const a = payloadShard(), b = payloadShard(), r2 = payloadBucket();
    t.after(() => { f.db.close(); a.raw.close(); b.raw.close(); });
    const env = { DB: f.db, STORAGE_MODE: 'sharded', STORAGE_SHARDS_JSON: JSON.stringify([
        { id: 'a', binding: 'HOT_A', mode: 'active' }, { id: 'b', binding: 'HOT_B', mode: 'active' }
    ]), HOT_A: a, HOT_B: b, MEMORY_PAYLOADS: r2 };
    const payloads = new PayloadStore(env, () => at);
    return { ...f, env, r2, payloads, store: new MemoryStore(f.db, () => at, payloads),
        search: new Search(env, () => at), transfer: new Transfers(f.db, () => at, payloads) };
}

test('mixed inline and sharded search returns real content and excludes unpublished payloads', async t => {
    const f = await setup(t);
    const inline = new MemoryStore(f.db, () => at);
    const old = await inline.create(f.token, 's1', { body: 'alpha legacy' }, 'old');
    const newer = await f.store.create(f.token, 's1', { body: 'alpha sharded' }, 'new');
    const ctx = { spaceId: 's1', memoryId: 'unpublished' }, data = { body: 'alpha', source: null, provenance: { originKind: 'user' } };
    const staged = await f.payloads.descriptor(ctx, data, 'unpublished');
    await f.payloads.stage(ctx, staged, data);
    const result = await f.search.query(f.token, 's1', 'alpha');
    assert.deepEqual(new Set(result.results.map(r => r.id)), new Set([old.id, newer.id]));
    assert.deepEqual(new Set(result.results.map(r => r.body)), new Set(['alpha legacy', 'alpha sharded']));
    for (const row of result.results) assert.equal(Object.keys(row).some(k => /payload|logicalBytes/i.test(k)), false);
    assert.deepEqual((await f.search.query(f.other, 's2', 'alpha')).results, []);
});

test('FTS scans past a page of prepared versions to find the committed head', async t => {
    const f = await setup(t), wanted = await f.store.create(f.token, 's1', { body: 'alpha current longer text' }, 'new');
    for (let n = 0; n < 61; n++) {
        const ctx = { spaceId: 's1', memoryId: 'stage-' + n }, data = { body: 'alpha', source: null, provenance: { originKind: 'user' } };
        const ref = await f.payloads.descriptor(ctx, data, 'stage-' + n); await f.payloads.stage(ctx, ref, data);
    }
    assert.deepEqual((await f.search.query(f.token, 's1', 'alpha')).results.map(row => row.id), [wanted.id]);
});

test('sharded search exhaustion is explicit and never a successful empty page', async t => {
    const f = await setup(t);
    let calls = 0;
    f.search.payloads.searchPage = async () => ({ results: [], nextCursor: 'next-' + ++calls });
    await assert.rejects(() => f.search.query(f.token, 's1', 'alpha'), error => error.code === 'search_scan_exhausted' && error.status === 503);
    assert.ok(calls <= 16);
});

test('historical export hydrates an immutable R2 revision after hot retirement', async t => {
    const f = await setup(t);
    const memory = await f.store.create(f.token, 's1', { body: 'old body', source: 'old source' }, 'create');
    const snapshot = await f.transfer.startExport(f.token, 's1');
    const head = f.db.raw.prepare('SELECT * FROM memories WHERE id=?').get(memory.id);
    await f.store.update(f.token, 's1', memory.id, { body: 'new body', expectedRevision: 1 }, 'update');
    await f.payloads.retireHot({ spaceId: 's1', memoryId: memory.id }, {
        id: head.payload_id, shardId: head.payload_shard_id, objectKey: head.payload_object_key, sha256: head.payload_sha256, bytes: head.payload_bytes
    });
    const page = await f.transfer.exportPage(f.token, 's1', snapshot.id);
    assert.equal(page.results[0].body, 'old body'); assert.equal(page.results[0].source, 'old source');
    assert.equal(page.results[0].revision, 1); assert.equal('payloadId' in page.results[0], false);
});

for (const mode of ['search', 'export']) test(mode + ' rejects credentials revoked while an external payload is being read', async t => {
    const f = await setup(t), memory = await f.store.create(f.token, 's1', { body: 'alpha secret' }, 'create');
    const snapshot = mode === 'export' ? await f.transfer.startExport(f.token, 's1') : null;
    const target = mode === 'search' ? f.search.store.payloads : f.payloads, read = target.read.bind(target);
    target.read = async (...args) => { const value = await read(...args); f.db.raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(at, 'session:alice'); return value; };
    await assert.rejects(() => mode === 'search' ? f.search.query(f.token, 's1', 'alpha') : f.transfer.exportPage(f.token, 's1', snapshot.id),
        error => error.code === 'access_denied');
});

test('semantic index workers embed sharded plaintext and retain revision metadata', async t => {
    const f = await setup(t), inputs = [], indexed = [];
    const memory = await f.store.create(f.token, 's1', { body: 'actual external fact' }, 'create');
    const jobs = new Jobs({ ...f.env, AI: { async run(model, input) { inputs.push(input.text); return { data: [Array(1024).fill(0.01)] }; } },
        MEMORY_INDEX: { async upsert(values) { indexed.push(...values); }, async deleteByIds() {}, async getByIds() { return []; } } }, () => at);
    await jobs.drain(1);
    assert.deepEqual(inputs, [['actual external fact']]);
    assert.deepEqual(indexed[0].metadata, { memoryId: memory.id, revision: 1 });
});

test('human-approved AI proposals publish sharded payloads atomically with one metered receipt', async t => {
    const f = await setup(t), env = { ...f.env, BACKGROUND_JOBS_ENABLED: 'true', PAYLOAD_KEY: Buffer.alloc(32, 6).toString('base64url'),
        AI: { async run() { return { response: { memories: [{ body: 'Remember alpha', kind: 'fact', sourceMessageId: 'm1', quote: 'alpha' }] } }; } } };
    const ingest = new Ingest(env, () => at), jobs = new Jobs(env, () => at); jobs.ingest = job => ingest.process(job);
    const started = await ingest.submit(f.token, 's1', { messages: [{ id: 'm1', role: 'user', content: 'alpha' }] }, 'submit');
    await jobs.drain(1);
    const approved = await ingest.approve(f.token, 's1', started.id, [0], 'approve');
    const head = f.db.raw.prepare('SELECT body,payload_id FROM memories WHERE id=?').get(approved.memories[0]);
    assert.equal(head.body, '[external]'); assert.ok(head.payload_id);
    assert.equal((await f.store.get(f.token, 's1', approved.memories[0])).body, 'Remember alpha');
    assert.deepEqual((await ingest.approve(f.token, 's1', started.id, [0], 'approve')).memories, approved.memories);
    assert.equal(f.db.raw.prepare("SELECT count(*) AS n FROM release_operations WHERE action='approve_ingest'").get().n, 1);
});

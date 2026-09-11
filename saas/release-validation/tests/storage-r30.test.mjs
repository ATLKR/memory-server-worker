import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fixture, DB, at } from './db.mjs';
import { payloadBucket, payloadShard } from './payload-fixture.mjs';
import { PayloadStore } from '../../src/release/payloads.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { Search } from '../../src/release/search.ts';
import { Jobs } from '../../src/release/jobs.ts';
import { createRelease } from '../../src/release/extension.ts';
import { digest } from '../../src/release/util.ts';
import { shardedLexical } from '../../src/release/payload-search.ts';

function storage(t, db) {
    const shard = payloadShard(), r2 = payloadBucket(); t.after(() => shard.raw.close());
    const env = { DB: db, STORAGE_MODE: 'sharded', STORAGE_SHARDS_JSON: JSON.stringify([{ id: 'one', binding: 'HOT', mode: 'active' }]), HOT: shard, MEMORY_PAYLOADS: r2 };
    const payloads = new PayloadStore(env, () => at);
    return { env, r2, shard, payloads, memory: new MemoryStore(db, () => at, payloads) };
}

test('HTTP erasure acknowledges access removal without claiming retained R2/hot source is gone', async t => {
    const f = await fixture(); t.after(() => f.db.close()); const s = storage(t, f.db);
    const memory = await s.memory.create(f.token, 's1', { body: 'private body', source: 'private source' }, 'create');
    await s.memory.remove(f.token, 's1', memory.id, 1, 'trash');
    const release = createRelease({ ...s.env, PUBLIC_ORIGIN: 'https://memory.example.test' }, { clock: () => at }), request = () => release.route(new Request('https://memory.example.test/v1/spaces/s1/memories/' + memory.id + '/erase', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 2, confirmation: memory.id, operationId: 'erase' }) }), f.token);
    const response = await request(); assert.equal(response.status, 200); const receipt = await response.json();
    assert.equal(receipt.status, 'access_removed_cleanup_pending'); assert.equal(receipt.accessRemoved, true);
    assert.equal(receipt.payloadCleanup, 'not_confirmed'); assert.equal(receipt.indexCleanup, 'not_confirmed');
    assert.ok([...s.r2.objects.values()].some(row => row.text.includes('private source')));
    assert.equal(s.shard.raw.prepare('SELECT count(*) n FROM payloads').get().n, 1);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_payload_purges WHERE purged_at IS NULL').get().n, 1);
    await assert.rejects(() => s.memory.get(f.token, 's1', memory.id), error => error.status === 404);
    assert.deepEqual(await (await request()).json(), receipt, 'a replay preserves the acknowledgment, not a fabricated physical-cleanup observation');
});

for (const ai of [false, true]) test('schema7 completed job cleanup bypasses external hydration and AI after archival: AI=' + ai, async t => {
    const db = new DB(); db.migrate(7); t.after(() => db.close()); const token = 'a'.repeat(64);
    db.raw.exec("INSERT INTO accounts(id) VALUES('legacy');");
    db.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission) VALUES('legacy-session','legacy','session',?,?,?,'write')").run(await digest(token), at + 900000, at);
    db.raw.prepare("INSERT INTO spaces VALUES('legacy-space','Legacy','legacy',NULL,'managed',?,'legacy-session')").run(at);
    db.raw.prepare("INSERT INTO memories(id,space_id,body,revision,created_at,updated_at,actor_credential_id) VALUES('legacy-memory','legacy-space',?,1,?,?,'legacy-session')").run('old '.repeat(900), at, at);
    db.raw.prepare("UPDATE memories SET body=?,revision=2,updated_at=? WHERE id='legacy-memory'").run('new '.repeat(900), at + 1);
    db.raw.exec("UPDATE release_jobs SET state='done',available_at=0");
    const vectors = new Set(); for (let revision = 1; revision <= 2; revision++) for (let chunk = 0; chunk < 3; chunk++) {
        const id = 'revision-' + revision + ':' + chunk; vectors.add(id);
        db.raw.prepare('INSERT INTO release_vector_refs(memory_id,vector_id,revision) VALUES(?,?,?)').run('legacy-memory', id, revision);
    }
    for (const file of readdirSync(new URL('../../migrations/', import.meta.url)).filter(file => /^\d{4}_/.test(file) && Number(file.slice(0, 4)) >= 8 && Number(file.slice(0, 4)) <= 23).sort())
        db.raw.exec(readFileSync(new URL('../../migrations/' + file, import.meta.url), 'utf8'));
    const s = storage(t, db); assert.equal(await s.memory.archiveOne('legacy-memory', 2), true);
    assert.equal(db.raw.prepare('SELECT body FROM memories').get().body, '[external]');
    let deletes = 0, embeddings = 0, hydrations = 0;
    const jobs = new Jobs({ ...s.env, BACKGROUND_JOBS_ENABLED: 'true', ...(ai ? { AI: { async run() { embeddings++; return { data: [Array(1024).fill(.1)] }; } } } : {}),
        MEMORY_INDEX: { async upsert() {}, async deleteByIds(ids) { deletes++; ids.forEach(id => vectors.delete(id)); }, async getByIds(ids) { return ids.filter(id => vectors.has(id)).map(id => ({ id })); } } }, () => at);
    const read = jobs.store.payloads.read.bind(jobs.store.payloads); jobs.store.payloads.read = async (...args) => { hydrations++; return read(...args); };
    await jobs.maintain(); assert.equal(db.raw.prepare("SELECT cleanup_only FROM release_jobs WHERE id='legacy-memory:2'").get().cleanup_only, 1);
    await jobs.drain(1);
    assert.equal(deletes, 1); assert.equal(embeddings, 0); assert.equal(hydrations, 0);
    assert.deepEqual([...vectors], ['revision-2:0', 'revision-2:1', 'revision-2:2']);
    assert.equal(db.raw.prepare("SELECT state FROM release_jobs WHERE id='legacy-memory:2'").get().state, 'done');
    assert.equal(db.raw.prepare('SELECT count(*) n FROM release_vector_refs').get().n, 6);
});

test('archive between inline and sharded search reads cannot duplicate a rank and displace the fiftieth hit', async t => {
    const f = await fixture(); t.after(() => f.db.close()); const s = storage(t, f.db), inline = new MemoryStore(f.db, () => at), expected = [];
    for (let n = 0; n < 50; n++) expected.push((await inline.create(f.token, 's1', { body: 'alpha' }, 'm-' + n)).id);
    const search = new Search(s.env, () => at), prepare = f.db.prepare.bind(f.db); let archived = false;
    f.db.prepare = sql => { const statement = prepare(sql); if (sql.startsWith('/* lexical-candidates */')) {
        const all = statement.all.bind(statement); statement.all = async () => { const result = await all(); if (!archived) { archived = true; await s.memory.archiveOne(result.results[0].id, result.results[0].revision); } return result; };
    } return statement; };
    const during = await search.query(f.token, 's1', 'alpha', 50, 'during');
    assert.equal(archived, true); assert.equal(during.results.length, 50); assert.deepEqual(during.results.map(row => row.id).sort(), expected.sort());
    const stable = await search.query(f.token, 's1', 'alpha', 50, 'stable');
    assert.deepEqual(during.results.map(row => [row.id, row.revision, row.score]), stable.results.map(row => [row.id, row.revision, row.score]));
});

test('duplicate shard candidates cannot stop pagination before a second distinct committed memory', async t => {
    const f = await fixture(); t.after(() => f.db.close()); const s = storage(t, f.db);
    await s.memory.create(f.token, 's1', { body: 'alpha' }, 'one'); await s.memory.create(f.token, 's1', { body: 'alpha' }, 'two');
    const heads = f.db.raw.prepare('SELECT id,payload_id FROM memories ORDER BY id').all(); let pages = 0;
    const candidates = heads.map(head => ({ memoryId: head.id, payloadId: head.payload_id, score: 1 }));
    const result = await shardedLexical(f.db, { shardIds: () => ['one'], async searchPage() { pages++;
        return pages === 1 ? { results: [candidates[0], candidates[0]], nextCursor: 'next' } : { results: [candidates[1]], nextCursor: null }; } }, await digest(f.token), 's1', '"alpha"*', 2, () => at);
    assert.equal(pages, 2); assert.deepEqual(result.map(row => row.id), heads.map(row => row.id));
});

test('a stale lexical revision cannot replace a stronger current revision observed after archival', async t => {
    const f = await fixture(); t.after(() => f.db.close()); const s = storage(t, f.db), inline = new MemoryStore(f.db, () => at);
    const changing = await inline.create(f.token, 's1', { body: 'alpha with older longer text' }, 'changing');
    const stable = await inline.create(f.token, 's1', { body: 'alpha' }, 'stable');
    const search = new Search(s.env, () => at), prepare = f.db.prepare.bind(f.db); let changed = false;
    f.db.prepare = sql => { const statement = prepare(sql); if (sql.startsWith('/* lexical-candidates */')) {
        const all = statement.all.bind(statement); statement.all = async () => { const result = await all(); if (!changed) {
            changed = true; await s.memory.archiveOne(changing.id, 1); await s.memory.update(f.token, 's1', changing.id, { body: 'alpha', expectedRevision: 1 }, 'advance');
        } return result; };
    } return statement; };
    const result = await search.query(f.token, 's1', 'alpha', 10, 'revision-race');
    assert.equal(changed, true); assert.deepEqual(new Map(result.results.map(row => [row.id, row.revision])), new Map([[changing.id, 2], [stable.id, 1]]));
});

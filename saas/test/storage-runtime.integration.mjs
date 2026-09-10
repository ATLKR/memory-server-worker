import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { PayloadStore } from '../src/release/payloads.ts';
import { canonical } from '../src/release/util.ts';
import { ftsQuery } from '../src/release/search.ts';
import { applySql } from './apply-sql.mjs';
import { WorkspaceService } from '../src/workspace.ts';
import { MemoryStore } from '../src/release/memory.ts';
import { PayloadMaintenance } from '../src/release/payload-maintenance.ts';
import { LegacyBackfill } from '../src/release/payload-backfill.ts';

const content = { body: '₿budget 🫠alpha x🫠y cafe\u0301ine', source: 'Private source', provenance: { originKind: 'user' } };
const code = value => error => error.code === value;

test('native physical D1 payload shards and private R2', { timeout: 180000 }, async t => {
    const mf = new Miniflare(convertV4MiniflareOptions({ name: 'payload-storage-native-test', modules: true,
        compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
        script: 'export default {fetch(){return new Response("synthetic storage fixture");}}',
        d1Databases: ['DB', 'HOT_ONE', 'HOT_TWO'], r2Buckets: ['MEMORY_PAYLOADS'],
        outboundService: () => new Response('Outbound network disabled', { status: 503 }),
    }));
    t.after(() => mf.dispose());
    const first = await mf.getD1Database('HOT_ONE'), second = await mf.getD1Database('HOT_TWO'), bucket = await mf.getR2Bucket('MEMORY_PAYLOADS');
    for (const db of [first, second]) {
        const parser = new DatabaseSync(':memory:');
        try { await applySql(parser, db, readFileSync(new URL('../shard-migrations/0001_payloads.sql', import.meta.url), 'utf8')); }
        finally { parser.close(); }
    }
    const configuration = [{ id: 'one', binding: 'HOT_ONE', mode: 'active' }, { id: 'two', binding: 'HOT_TWO', mode: 'active' }];
    const env = { STORAGE_MODE: 'sharded', STORAGE_SHARDS_JSON: JSON.stringify(configuration), HOT_ONE: first, HOT_TWO: second, MEMORY_PAYLOADS: bucket };
    const store = new PayloadStore(env), selected = ref => ref.shardId === 'one' ? first : second;
    const placements = new Map();
    for (let n = 0; placements.size < 2 && n < 30; n++) {
        const ctx = { spaceId: 'native-space', memoryId: 'native-memory-' + n };
        const ref = await store.descriptor(ctx, content, 'native-payload-' + n); placements.set(ref.shardId, { ctx, ref });
    }
    assert.equal(placements.size, 2);

    await t.test('each active placement writes a different native D1 and retains exact private R2 bytes', async () => {
        for (const { ctx, ref } of placements.values()) {
            await store.stage(ctx, ref, content);
            assert.deepEqual(await store.read(ctx, ref), content);
            assert.equal((await selected(ref).prepare('SELECT content FROM payloads WHERE id=?').bind(ref.id).first()).content, canonical(content));
            assert.equal(await (ref.shardId === 'one' ? second : first).prepare('SELECT id FROM payloads WHERE id=?').bind(ref.id).first(), null);
            assert.equal(await (await bucket.get(ref.objectKey)).text(), canonical(content));
            const etag = (await bucket.head(ref.objectKey)).etag;
            await store.stage(ctx, ref, content);
            assert.equal((await bucket.head(ref.objectKey)).etag, etag, 'native conditional put preserves immutable object');
        }
        assert.equal((await first.prepare('SELECT count(*) AS n FROM payloads').first()).n, 1);
        assert.equal((await second.prepare('SELECT count(*) AS n FROM payloads').first()).n, 1);
    });

    await t.test('native Unicode61 FTS is tenant scoped and pages immutable versions in deterministic order', async () => {
        const { ctx, ref } = placements.get('one');
        for (const query of ['₿budget', '🫠alpha', 'x🫠y', 'cafe\u0301ine']) {
            const page = await store.searchPage('one', ctx.spaceId, ftsQuery(query), null, 1);
            assert.deepEqual(page.results.map(row => row.payloadId), [ref.id]);
        }
        assert.deepEqual((await store.searchPage('one', ctx.spaceId, ftsQuery('xylophone yellow'), null, 10)).results, []);
        const other = { ...ctx, spaceId: 'foreign-native-space' }, foreign = { ...await store.descriptor(other, content, 'native-foreign'), shardId: 'one' };
        await store.stage(other, foreign, content);
        const ids = [ref.id];
        for (let n = 0; n < 4; n++) { const next = { ...await store.descriptor(ctx, content, 'native-version-' + n), shardId: 'one' }; await store.stage(ctx, next, content); ids.push(next.id); }
        const found = []; let after = null;
        do { const page = await store.searchPage('one', ctx.spaceId, ftsQuery('₿budget'), after, 2); found.push(...page.results.map(row => row.payloadId)); after = page.nextCursor; } while (after);
        assert.deepEqual(found, ids.sort());
        const cursor = (await store.searchPage('one', ctx.spaceId, ftsQuery('₿budget'), null, 2)).nextCursor;
        await assert.rejects(() => store.searchPage('one', other.spaceId, ftsQuery('₿budget'), cursor, 2), code('invalid_cursor'));
    });

    await t.test('draining placements remain readable and cold retirement retains R2 history', async () => {
        const { ctx, ref } = placements.get('two');
        const draining = new PayloadStore({ ...env, STORAGE_SHARDS_JSON: JSON.stringify([{ ...configuration[0], mode: 'draining' }, configuration[1]]) });
        assert.equal((await draining.descriptor(ctx, content, 'active-only')).shardId, 'two');
        const existing = placements.get('one'); assert.deepEqual(await draining.read(existing.ctx, existing.ref), content);
        await store.retireHot(ctx, ref); await store.retireHot(ctx, ref);
        assert.equal(await second.prepare('SELECT id FROM payloads WHERE id=?').bind(ref.id).first(), null);
        assert.equal(await second.prepare('SELECT payload_id FROM payload_fts WHERE rowid=(SELECT row_id FROM payloads WHERE id=?)').bind(ref.id).first(), null);
        assert.deepEqual(await store.read(ctx, ref), content);
        await assert.rejects(() => store.stage(ctx, ref, content), code('payload_retired'));
        await assert.rejects(() => store.read({ ...ctx, memoryId: 'wrong-memory' }, ref), code('payload_context_mismatch'));
    });

    await t.test('native R2 purge tombstone fences a late create-only upload across new store instances', async () => {
        const ctx = { spaceId: 'late-r2-space', memoryId: 'late-r2-memory' }, ref = await store.descriptor(ctx, content, 'late-r2-payload');
        let entered, release;
        const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
        const delayedBucket = { head: key => bucket.head(key), get: key => bucket.get(key), async put(key, value, options) {
            if (key === ref.objectKey && value.length) { entered(); await held; }
            return bucket.put(key, value, options);
        } };
        const upload = new PayloadStore({ ...env, MEMORY_PAYLOADS: delayedBucket }).stage(ctx, ref, content);
        await started; await new PayloadStore(env).purge(ctx, ref); release();
        await assert.rejects(() => upload, code('payload_purged'));
        assert.equal((await bucket.head(ref.objectKey)).size, 0);
        assert.equal(await selected(ref).prepare('SELECT id FROM payloads WHERE id=?').bind(ref.id).first(), null);
        await new PayloadStore(env).purge(ctx, ref);
        await assert.rejects(() => new PayloadStore(env).read(ctx, ref), code('payload_purged'));
    });

    await t.test('native tombstone trigger fences a late shard insert after R2 was uploaded', async () => {
        const ctx = { spaceId: 'late-d1-space', memoryId: 'late-d1-memory' }, ref = await store.descriptor(ctx, content, 'late-d1-payload'), db = selected(ref);
        let entered, release;
        const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
        const delayed = { batch: (...args) => db.batch(...args), withSession: (...args) => db.withSession(...args), prepare(sql) {
            let statement = db.prepare(sql);
            const wrapper = { bind(...values) { statement = statement.bind(...values); return wrapper; }, first: () => statement.first(), all: () => statement.all(),
                async run() { if (sql.startsWith('INSERT INTO payloads')) { entered(); await held; } return statement.run(); } };
            return wrapper;
        } };
        const upload = new PayloadStore({ ...env, [ref.shardId === 'one' ? 'HOT_ONE' : 'HOT_TWO']: delayed }).stage(ctx, ref, content);
        await started; await store.purge(ctx, ref); release(); await assert.rejects(() => upload, code('payload_retired'));
        assert.equal((await bucket.head(ref.objectKey)).size, 0);
        assert.equal(await db.prepare('SELECT id FROM payloads WHERE id=?').bind(ref.id).first(), null);
        await assert.rejects(() => db.prepare('DELETE FROM payload_tombstones WHERE id=?').bind(ref.id).run(), /payload_tombstone_immutable/);
    });

    await t.test('provider failure stays visible and retry verifies an already uploaded native object', async () => {
        const ctx = { spaceId: 'partial-space', memoryId: 'partial-memory' }, ref = await store.descriptor(ctx, content, 'partial-payload'), db = selected(ref);
        const broken = { batch: (...args) => db.batch(...args), withSession: (...args) => db.withSession(...args), prepare(sql) { if (sql.startsWith('INSERT INTO payloads')) throw Error('synthetic_native_shard_unavailable'); return db.prepare(sql); } };
        await assert.rejects(() => new PayloadStore({ ...env, [ref.shardId === 'one' ? 'HOT_ONE' : 'HOT_TWO']: broken }).stage(ctx, ref, content), /synthetic_native_shard_unavailable/);
        assert.equal(await (await bucket.get(ref.objectKey)).text(), canonical(content));
        await store.stage(ctx, ref, content); assert.deepEqual(await store.read(ctx, ref), content);
        await store.retireHot(ctx, ref);
        const saved = await bucket.head(ref.objectKey);
        await bucket.put(ref.objectKey, 'corrupt', { customMetadata: saved.customMetadata });
        await assert.rejects(() => store.read(ctx, ref), code('payload_integrity_error'));
        await store.purge(ctx, ref); assert.equal((await bucket.head(ref.objectKey)).size, 0);
    });

    await t.test('native central publication, retained history and erasure operate over actual external providers', async () => {
        const db = await mf.getD1Database('DB'), parser = new DatabaseSync(':memory:');
        try {
            const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(file => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= 21).sort();
            for (const file of migrations) await applySql(parser, db, readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
            await applySql(parser, db, readFileSync(new URL('../payload-schema.sql', import.meta.url), 'utf8'));
            await applySql(parser, db, readFileSync(new URL('../operational-schema.sql', import.meta.url), 'utf8'));
        } finally { parser.close(); }
        const workspace = new WorkspaceService(db), identity = await workspace.signIn({ issuer: 'https://auth-api.allen.company', subject: 'native-storage-owner',
            email: 'storage-owner@example.test', emailVerified: true, permission: 'write', expiresAt: Date.now() + 900000 });
        await db.prepare("UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind='session'").bind(Date.now(), identity.accountId).run();
        const space = await db.prepare("SELECT id FROM spaces WHERE account_id=? AND organization_id IS NULL ORDER BY id LIMIT 1").bind(identity.accountId).first();
        const memories = new MemoryStore(db, Date.now, store), initial = await memories.create(identity.token, space.id, content, 'native-external-create');
        assert.equal(initial.body, content.body); assert.ok(!Object.keys(initial).some(key => /payload|logical/i.test(key)));
        const head = await db.prepare('SELECT * FROM memories WHERE id=?').bind(initial.id).first();
        assert.equal(head.body, '[external]'); assert.equal(head.source, null); assert.ok(head.payload_id);
        assert.equal((await db.prepare('SELECT state FROM release_payload_stages WHERE id=?').bind(head.payload_id).first()).state, 'published');
        const replay = await memories.create(identity.token, space.id, content, 'native-external-create'); assert.equal(replay.id, initial.id); assert.equal(replay.replayed, true);
        await memories.update(identity.token, space.id, initial.id, { body: 'new native revision', expectedRevision: 1 }, 'native-external-update');
        const old = { id: head.payload_id, shardId: head.payload_shard_id, objectKey: head.payload_object_key, sha256: head.payload_sha256, bytes: head.payload_bytes };
        const ctx = { spaceId: space.id, memoryId: initial.id };
        await store.retireHot(ctx, old); assert.deepEqual(await store.read(ctx, old), content);
        assert.equal((await memories.get(identity.token, space.id, initial.id)).body, 'new native revision');
        await memories.remove(identity.token, space.id, initial.id, 2, 'native-external-delete');
        await memories.erase(identity.token, space.id, initial.id, 3, initial.id, 'native-external-erase');
        await assert.rejects(() => memories.get(identity.token, space.id, initial.id), error => error.status === 404);
        const outbox = (await db.prepare('SELECT * FROM release_payload_purges WHERE memory_id=?').bind(initial.id).all()).results;
        assert.equal(outbox.length, 2); assert.equal((await db.prepare('SELECT count(*) AS n FROM memory_versions WHERE memory_id=?').bind(initial.id).first()).n, 0);
        for (const row of outbox) {
            const ref = { id: row.payload_id, shardId: row.payload_shard_id, objectKey: row.payload_object_key, sha256: row.payload_sha256, bytes: row.payload_bytes };
            await store.purge(ctx, ref); assert.equal((await bucket.head(ref.objectKey)).size, 0);
        }
        assert.equal((await db.prepare('SELECT storage_bytes FROM release_pools WHERE id=?').bind('account:' + identity.accountId).first()).storage_bytes, 0);
        const cleanup = await new PayloadMaintenance({ DB: db }, store).run();
        assert.equal(cleanup.purged, 2); assert.equal(cleanup.retired, 2);
        assert.equal((await db.prepare("SELECT count(*) AS n FROM release_payload_stages WHERE memory_id=? AND state='purged'").bind(initial.id).first()).n, 2);
        // A short-lived synthetic intent uses native execution time. No clock
        // override is used to make expired staging collectible.
        const orphanContext = { spaceId: space.id, memoryId: 'native-orphan-memory' }, orphan = await store.descriptor(orphanContext, content, 'native-orphan-payload');
        const now = Date.now(), expires = now + 3000;
        await db.batch([
            db.prepare('INSERT INTO release_payload_intents(id,account_id,space_id,client_key,request_hash,action,memory_id,expected_revision,item_count,reserved_bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
                .bind('native-orphan-intent', identity.accountId, space.id, 'native-orphan-key', 'synthetic-request-hash', 'create', null, null, 1, orphan.bytes, now, expires),
            db.prepare('INSERT INTO release_payload_stages(id,intent_id,ordinal,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,logical_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
                .bind(orphan.id, 'native-orphan-intent', 0, orphanContext.memoryId, orphan.shardId, orphan.objectKey, orphan.sha256, orphan.bytes, 100, now),
        ]);
        await store.stage(orphanContext, orphan, content);
        await new Promise(resolve => setTimeout(resolve, Math.max(1, expires - Date.now() + 10)));
        const collected = await new PayloadMaintenance({ DB: db }, store).run(); assert.equal(collected.collected, 1); assert.equal(collected.purged, 1);
        assert.equal((await bucket.head(orphan.objectKey)).size, 0);
        assert.equal((await db.prepare('SELECT quantity FROM release_payload_stage_accounts WHERE account_id=?').bind(identity.accountId).first()).quantity, 0);
        assert.equal((await db.prepare("SELECT state FROM release_payload_stages WHERE id=?").bind(orphan.id).first()).state, 'purged');
        const inline = new MemoryStore(db), legacy = await inline.create(identity.token, space.id, { body: 'native legacy retained source', source: 'original' }, 'native-legacy');
        await inline.update(identity.token, space.id, legacy.id, { body: 'native legacy current', expectedRevision: 1 }, 'native-legacy-update');
        const before = await db.prepare('SELECT storage_bytes FROM release_pools WHERE id=?').bind('account:' + identity.accountId).first();
        const archive = await new LegacyBackfill({ DB: db, STORAGE_BACKFILL_ENABLED: 'true' }, memories).run();
        assert.equal(archive.converted, 2); assert.equal(archive.failed, 0);
        assert.equal((await db.prepare('SELECT body FROM memories WHERE id=?').bind(legacy.id).first()).body, '[external]');
        assert.equal((await db.prepare('SELECT body FROM memory_versions WHERE memory_id=? AND revision=1').bind(legacy.id).first()).body, '[external]');
        assert.equal((await memories.get(identity.token, space.id, legacy.id)).body, 'native legacy current');
        assert.deepEqual(await db.prepare('SELECT storage_bytes FROM release_pools WHERE id=?').bind('account:' + identity.accountId).first(), before);
        assert.equal((await new PayloadMaintenance({ DB: db }, store).run()).retired, 1, 'historical-only conversion retires its hot projection');
    });
});

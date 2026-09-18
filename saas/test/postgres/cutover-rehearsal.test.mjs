import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSession } from './pg-database-fixture.mjs';
import { createHash } from 'node:crypto';
import { copyTable, exportManifest, freezeRuntime, listRegionalTables, payloadInventory,
    sealPayloadObjects, sealTable, unfreezeRuntime, verifyManifest, verifyPayloadObjects } from '../../src/postgres/cutover.ts';

const NOW = 1758000000000;
// Regional tables with real seeded content — a representative cut, not the
// full 60-table surface the production rehearsal enumerates.
// Parent-before-child order: the importer writes plain INSERTs, so every
// referenced row must land before its dependents.
const CUT_TABLES = ['memory_control.deployment_identity', 'memory_identity.accounts',
    'memory_identity.credentials', 'memory_control.spaces',
    'memory_content.memories', 'memory_jobs.release_jobs'];

async function regionalDb(t, seed = true) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const dir = new URL('../../postgres/migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort())
        await db.exec(await readFile(new URL(name, dir), 'utf8'));
    await db.exec(`CREATE OR REPLACE FUNCTION memory_control.now_ms() RETURNS bigint
        LANGUAGE sql STABLE AS $$ SELECT ${NOW}::bigint $$`);
    if (seed) {
        await db.query(`INSERT INTO memory_control.deployment_identity(singleton, deployment_id, storage_region, processing_policy_id, created_at_ms)
            VALUES (1,'memory-seoul','kr-seoul','policy:test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('acct:a'),('acct:b')`);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at, permission, reauthenticated_at)
            VALUES ('cred:a','acct:a','session',$1,$2,'write',$3)`, ['a'.repeat(64), NOW + 900000, NOW]);
        await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, deployment_id, data_policy,
            source_byte_limit, message_limit, name, security_mode, created_at_ms)
            VALUES ('s1','acct:a','memory-seoul','{}'::jsonb,67108864,100000,'Space','managed',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_content.memories(id,space_id,body,revision,created_at,updated_at,actor_credential_id)
            VALUES ('m1','s1','cutover body',1,$1,$1,'cred:a'),('m2','s1','{"nested":true}'::text,1,$1,$1,'cred:a')`, [NOW]);
        await db.query(`INSERT INTO memory_jobs.release_jobs(id,space_id,revision,kind,available_at,created_at)
            VALUES ('j1','s1',0,'upsert',$1,$1)`, [NOW]);
    }
    return { db, session: createPgliteSession(db) };
}

test('full-surface enumeration seals every regional table and re-verifies on a fresh target', async t => {
    const { session: source } = await regionalDb(t);
    const { session: target } = await regionalDb(t, false);
    const all = await listRegionalTables(source);
    assert.ok(all.length >= 50, 'the enumeration must cover the full regional surface, not a hand-picked subset');
    const manifest = await exportManifest(source, 'memory-seoul', 'kr-seoul', all, NOW);
    // Provision-seeded tables (maintenance_progress, payload_backfill_progress,
    // ...) are reconciliation checks, not copy targets — the seal still
    // verifies the target's seed matches the source's.
    const provisionSeeded = [];
    for (const table of all)
        if ((await target.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length) provisionSeeded.push(table);
    assert.deepEqual(provisionSeeded.sort(), ['memory_ops.maintenance_progress', 'memory_ops.payload_backfill_progress']);
    for (const table of all) if (!provisionSeeded.includes(table)) await copyTable(source, target, table);
    assert.deepEqual(await verifyManifest(target, manifest), []);
});

test('sealed export reproduces byte-identical rows on a fresh target', async t => {
    const { session: source } = await regionalDb(t);
    const { session: target } = await regionalDb(t, false);
    const manifest = await exportManifest(source, 'memory-seoul', 'kr-seoul', CUT_TABLES, NOW);
    assert.equal(manifest.tables.length, CUT_TABLES.length);
    for (const table of CUT_TABLES) await copyTable(source, target, table);
    assert.deepEqual(await verifyManifest(target, manifest), []);
});

test('a mutated or partial target fails verification instead of activating', async t => {
    const { session: source } = await regionalDb(t);
    const { db: rawTarget, session: target } = await regionalDb(t, false);
    const manifest = await exportManifest(source, 'memory-seoul', 'kr-seoul', CUT_TABLES, NOW);
    for (const table of CUT_TABLES) await copyTable(source, target, table);
    // Rollback rehearsal: a divergent target is detected and discarded — the
    // source digest is untouched and remains the authority. The update is a
    // legal transition (the schema's own guards still hold on the target).
    await rawTarget.query(`UPDATE memory_content.memories SET body='tampered',revision=revision+1,updated_at=$1 WHERE id='m1'`, [NOW + 1]);
    const mismatched = await verifyManifest(target, manifest);
    // The upsert trigger wrote an outbox row on the target — the seal catches
    // the tampered row and its derived divergence together.
    assert.deepEqual(mismatched.map(m => m.table), ['memory_content.memories', 'memory_jobs.release_jobs']);
    assert.deepEqual(await verifyManifest(source, manifest), []);
});

test('post-cut writes change the seal; a rebuilt target re-verifies', async t => {
    const { db: rawSource, session: source } = await regionalDb(t);
    const { db: rawTarget, session: target } = await regionalDb(t, false);
    const first = await exportManifest(source, 'memory-seoul', 'kr-seoul', CUT_TABLES, NOW);
    // A write lands after the cut — the second seal must differ.
    await rawSource.query(`INSERT INTO memory_identity.accounts(id) VALUES ('acct:late')`);
    const second = await exportManifest(source, 'memory-seoul', 'kr-seoul', CUT_TABLES, NOW);
    assert.notEqual(second.tables.find(s => s.table === 'memory_identity.accounts').sha256,
        first.tables.find(s => s.table === 'memory_identity.accounts').sha256);
    // Rollback path: rebuild the target from scratch — no merge, no dual write.
    for (const table of CUT_TABLES) await copyTable(source, target, table);
    assert.deepEqual(await verifyManifest(target, second), []);
});

test('copy refuses a non-empty target and an unknown table', async t => {
    const { session: source } = await regionalDb(t);
    const { session: target } = await regionalDb(t, false);
    const manifest = await exportManifest(source, 'memory-seoul', 'kr-seoul', CUT_TABLES, NOW);
    await copyTable(source, target, 'memory_identity.accounts');
    await assert.rejects(() => copyTable(source, target, 'memory_identity.accounts'),
        e => e.message === 'cutover_target_not_empty');
    await assert.rejects(() => sealTable(source, 'memory_identity.nonexistent'),
        e => e.message === 'cutover_table_missing');
    await assert.rejects(() => sealTable(source, 'memory_identity.accounts; DROP TABLE x'),
        e => e.message === 'cutover_table_name_invalid');
    assert.ok(manifest.schemaDigest.length === 64);
});

test('payload objects seal against the row inventory and verify on the target store', async t => {
    const { db, session } = await regionalDb(t);
    // Live references come from memories, memory_versions, and non-terminal
    // payload_stages; staging/purged stages are reconciliation outcomes only.
    const body = new TextEncoder().encode('payload-bytes');
    const sha = createHash('sha256').update(body).digest('hex');
    await db.query(`INSERT INTO memory_content.payload_intents(id,account_id,space_id,client_key,request_hash,action,
        item_count,reserved_bytes,created_at,expires_at)
        VALUES ('i1','acct:a','s1','ck1','rh1','archive',3,1024,$1,$2)`, [NOW, NOW + 60000]);
    // Admission only accepts 'staging' inserts; each state is reached through
    // the transition guard, not seeded directly. The archive permit's
    // logical_bytes must equal the source memory's body+source+provenance
    // bytes — computed from the row, not hand-counted.
    await db.query(`INSERT INTO memory_content.payload_stages(id,intent_id,ordinal,memory_id,payload_shard_id,
        payload_object_key,payload_sha256,payload_bytes,logical_bytes,state,created_at)
        SELECT 'p1','i1',0,'m1','hot-01','k1',$1,$2,
          octet_length(m.body)+coalesce(octet_length(m.source),0)+octet_length(m.provenance::text),
          'staging',$3 FROM memory_content.memories m WHERE m.id='m1'`, [sha, body.length, NOW]);
    await db.query(`INSERT INTO memory_content.payload_stages(id,intent_id,ordinal,memory_id,payload_shard_id,
        payload_object_key,payload_sha256,payload_bytes,logical_bytes,state,created_at)
        VALUES ('p2','i1',1,'m1','hot-01','k2',$1,$2,$2,'staging',$3),
               ('p3','i1',2,'m1','hot-01','k3',$1,$2,$2,'staging',$3)`, [sha, body.length, NOW]);
    await db.query(`UPDATE memory_content.payload_stages SET state='ready' WHERE id='p1'`);
    await db.query(`INSERT INTO memory_ops.payload_purges(payload_id,space_id,memory_id,payload_shard_id,
        payload_object_key,payload_sha256,payload_bytes,created_at,purged_at)
        VALUES ('p3','s1','m1','hot-01','k3',$1,$2,$3,$3)`, [sha, body.length, NOW]);
    await db.query(`UPDATE memory_content.payload_stages SET state='purge_pending' WHERE id='p3'`);
    await db.query(`UPDATE memory_content.payload_stages SET state='purged' WHERE id='p3'`);
    // The reference guard requires the external body marker plus a matching
    // ready-stage + archive permit — the publication path, not a raw write.
    await db.query(`INSERT INTO memory_content.payload_archive_permits(payload_id,memory_id,revision,target,created_at)
        VALUES ('p1','m1',1,'current',$1)`, [NOW]);
    await db.query(`UPDATE memory_content.memories SET body='[external]',source=NULL,provenance='{}',
        payload_id='p1',payload_shard_id='hot-01',payload_object_key='k1',
        payload_sha256=$1,payload_bytes=$2,
        logical_bytes=(SELECT logical_bytes FROM memory_content.payload_stages WHERE id='p1'),
        revision=revision+1,updated_at=$3 WHERE id='m1'`, [sha, body.length, NOW + 1]);

    // m1's live reference and p1's published stage both name hot-01/k1 with the
    // same digest — they collapse to one inventory row.
    const inventory = await payloadInventory(session);
    assert.deepEqual(inventory, [{ shard: 'hot-01', key: 'k1', sha256: sha, bytes: body.length }]);

    const store = new Map([['hot-01/k1', body]]);
    const fetcher = async (shard, key) => store.get(`${shard}/${key}`) ?? null;
    const seal = await sealPayloadObjects(session, fetcher);
    assert.equal(seal.unresolved.length, 0);
    assert.equal(seal.objects.length, inventory.length);

    // Target store holding identical bytes verifies; a missing or corrupt
    // object is reported instead of activating.
    assert.deepEqual(await verifyPayloadObjects(seal, fetcher), []);
    store.set('hot-01/k1', new TextEncoder().encode('tampered'));
    assert.deepEqual((await verifyPayloadObjects(seal, fetcher)).map(r => r.key), ['k1']);
    store.delete('hot-01/k1');
    const missing = await sealPayloadObjects(session, fetcher);
    assert.deepEqual(missing.unresolved.map(r => r.key), ['k1']);
});

test('the cut window freezes the runtime role at the authority and restores it', async t => {
    const { session: admin } = await regionalDb(t);
    const login = async () => (await admin.query(
        `SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname='memory_runtime'`)).rows[0].rolcanlogin;
    // Migrations provision memory_runtime NOLOGIN; the operator grants LOGIN at
    // provisioning time, so start from the unfrozen state before the cut.
    await unfreezeRuntime(admin);
    assert.equal(await login(), true);
    await freezeRuntime(admin);
    assert.equal(await login(), false);
    await unfreezeRuntime(admin);
    assert.equal(await login(), true);
    await assert.rejects(() => freezeRuntime(admin, 'memory_runtime; DROP TABLE x'),
        e => e.message === 'cutover_role_invalid');
});

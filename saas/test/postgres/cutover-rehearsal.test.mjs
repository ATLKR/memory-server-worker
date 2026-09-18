import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSession } from './pg-database-fixture.mjs';
import { copyTable, exportManifest, listRegionalTables, sealTable, verifyManifest } from '../../src/postgres/cutover.ts';

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

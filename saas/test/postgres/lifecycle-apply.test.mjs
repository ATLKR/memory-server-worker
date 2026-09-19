import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSession } from './pg-database-fixture.mjs';
import { createPostgresDatabase } from '../../src/postgres/database.ts';
import { applyLifecycleEvent, syncLifecycleJournal } from '../../src/postgres/lifecycle-apply.ts';

const NOW = 1758000000000;
const ISSUER = 'https://issuer.example';
const HASH = 'a'.repeat(64);

async function regionalDb(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const dir = new URL('../../postgres/migrations/', import.meta.url);
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
    for (const name of files) await db.exec(await readFile(new URL(name, dir), 'utf8'));
    await db.exec(`CREATE OR REPLACE FUNCTION memory_control.now_ms() RETURNS bigint
        LANGUAGE sql STABLE AS $$ SELECT ${NOW}::bigint $$`);
    await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('acct:one')`);
    await db.query(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
        VALUES ($1,'sub-1','acct:one',$2)`, [ISSUER, NOW]);
    await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
        VALUES ('cred:1','acct:one','session',$1,$2)`, ['b'.repeat(64), NOW + 900000]);
    return { db, region: createPostgresDatabase(createPgliteSession(db)) };
}

async function controlDb(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const dir = new URL('../../postgres/migrations/', import.meta.url);
    await db.exec(await readFile(new URL('0001_private_namespaces.sql', dir), 'utf8'));
    await db.exec(await readFile(new URL('0002_deployment_identity.sql', dir), 'utf8'));
    const controlDir = new URL('../../postgres/control/', import.meta.url);
    for (const name of (await readdir(controlDir)).filter(f => f.endsWith('.sql')).sort())
        await db.exec(await readFile(new URL(name, controlDir), 'utf8'));
    return { db, control: createPostgresDatabase(createPgliteSession(db)) };
}

async function journalEvent(db, { id, sequence, kind, address = '', signedAt = Date.now() }) {
    const now = Date.now();
    await db.query(`INSERT INTO memory_ops.webhook_events(provider, event_id, body_hash, created_at_ms)
        VALUES ('identity',$1,$2,$3)`, [id, HASH, now]);
    await db.query(`INSERT INTO memory_ops.lifecycle_events
        (id, issuer, subject, sequence, kind, address, occurred_at_ms, received_at_ms, signed_at_ms, body_hash)
        VALUES ($1,$2,'sub-1',$3,$4,$5,$6,$6,$7,$8)`, [id, ISSUER, sequence, kind, address, now, signedAt, HASH]);
}

const evt = overrides => ({ id: 'evt:x', issuer: ISSUER, subject: 'sub-1', sequence: 1, kind: 'account.suspended', address: '', occurredAtMs: NOW, ...overrides });

test('applied events advance the head; stale and terminal rules hold', async t => {
    const { region } = await regionalDb(t);
    await applyLifecycleEvent(region, evt({ sequence: 3 }));
    await applyLifecycleEvent(region, evt({ id: 'evt:y', sequence: 2, kind: 'account.resumed' }));
    const state = (await region.prepare(`SELECT kind, sequence FROM memory_ops.lifecycle_applied_state
        WHERE issuer=? AND subject='sub-1' AND address=''`).bind(ISSUER).first());
    assert.deepEqual(state, { kind: 'account.suspended', sequence: 3 });
    const head = (await region.prepare(`SELECT applied_sequence AS n FROM memory_ops.lifecycle_apply_head WHERE issuer=?`).bind(ISSUER).first());
    assert.equal(head.n, 3);
    // account.deleted is terminal: a later sequence cannot rewrite the row.
    await applyLifecycleEvent(region, evt({ id: 'evt:z', sequence: 4, kind: 'account.deleted' }));
    await applyLifecycleEvent(region, evt({ id: 'evt:w', sequence: 5, kind: 'account.resumed' }));
    const terminal = (await region.prepare(`SELECT kind FROM memory_ops.lifecycle_applied_state WHERE issuer=? AND subject='sub-1'`).bind(ISSUER).first());
    assert.equal(terminal.kind, 'account.deleted');
    const headAfter = (await region.prepare(`SELECT applied_sequence AS n FROM memory_ops.lifecycle_apply_head WHERE issuer=?`).bind(ISSUER).first());
    assert.equal(headAfter.n, 5);
});

test('malformed events are rejected before touching state', async t => {
    const { region } = await regionalDb(t);
    await assert.rejects(() => applyLifecycleEvent(region, evt({ kind: 'subject.deleted' })), e => e.code === 'lifecycle_event_invalid');
    await assert.rejects(() => applyLifecycleEvent(region, evt({ sequence: 0 })), e => e.code === 'lifecycle_event_invalid');
});

test('sync applies journal events in order and suspends the subject regionally', async t => {
    const { db: regionDb, region } = await regionalDb(t);
    const { db: ctl, control } = await controlDb(t);
    // An active credential exists before the suspension applies.
    assert.equal((await regionDb.query(`SELECT count(*) n FROM memory_identity.active_credentials`)).rows[0].n, 1);
    await journalEvent(ctl, { id: 'evt:1', sequence: 1, kind: 'account.suspended' });
    const result = await syncLifecycleJournal(control, region);
    assert.equal(result.applied, 1);
    assert.equal(result.head, 1);
    assert.equal((await regionDb.query(`SELECT count(*) n FROM memory_identity.active_credentials`)).rows[0].n, 0);
    // A second sync is a no-op; the resume event restores the credential.
    assert.equal((await syncLifecycleJournal(control, region)).applied, 0);
    await journalEvent(ctl, { id: 'evt:2', sequence: 2, kind: 'account.resumed' });
    assert.equal((await syncLifecycleJournal(control, region)).applied, 1);
    assert.equal((await regionDb.query(`SELECT count(*) n FROM memory_identity.active_credentials`)).rows[0].n, 1);
});

test('an empty journal still stamps the issuer apply-head', async t => {
    const { region } = await regionalDb(t);
    const { control } = await controlDb(t);
    // The bound issuer has no pending events; without a stamped head the
    // staleness gate would deny its accounts indefinitely.
    assert.equal((await syncLifecycleJournal(control, region)).applied, 0);
    const head = (await region.prepare(`SELECT applied_sequence AS n, applied_at_ms AS at
        FROM memory_ops.lifecycle_apply_head WHERE issuer=?`).bind(ISSUER).first());
    assert.deepEqual(head, { n: 0, at: NOW });
});

test('email-scoped events apply under their own address key', async t => {
    const { region } = await regionalDb(t);
    const { db: ctl, control } = await controlDb(t);
    await journalEvent(ctl, { id: 'evt:e1', sequence: 1, kind: 'email.revoked', address: 'alice@example.com' });
    assert.equal((await syncLifecycleJournal(control, region)).applied, 1);
    const row = (await region.prepare(`SELECT address, kind FROM memory_ops.lifecycle_applied_state
        WHERE issuer=? AND subject='sub-1'`).bind(ISSUER).first());
    assert.deepEqual(row, { address: 'alice@example.com', kind: 'email.revoked' });
});

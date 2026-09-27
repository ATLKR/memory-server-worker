import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSession } from './pg-database-fixture.mjs';
import { createPostgresDatabase } from '../../src/postgres/database.ts';
import { enrollAccount, enrollOrganization, removeAccountEnrollment, removeOrganizationEnrollment,
    accountEnrolled, organizationEnrolled } from '../../src/postgres/enrollment.ts';

const NOW = 1758000000000;

/** Control-plane fixture. `setCaller` simulates a serving worker from the
 * given region — enrollment commands only ever register the caller's own
 * region, matching the attested `memory.caller_region` pin in production. */
async function createControlFixture(t, caller = 'sg') {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const migrations = new URL('../../postgres/migrations/', import.meta.url);
    await db.exec(await readFile(new URL('0001_private_namespaces.sql', migrations), 'utf8'));
    await db.exec(await readFile(new URL('0002_deployment_identity.sql', migrations), 'utf8'));
    const controlDir = new URL('../../postgres/control/', import.meta.url);
    for (const name of (await readdir(controlDir)).filter(f => f.endsWith('.sql')).sort())
        await db.exec(await readFile(new URL(name, controlDir), 'utf8'));
    await db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',$1),('kr-seoul',$1)`, [NOW]);
    const setCaller = region => db.query(`SELECT pg_catalog.set_config('memory.caller_region',$1,false)`, [region]);
    await setCaller(caller);
    const control = createPostgresDatabase(createPgliteSession(db));
    return { db, control, setCaller };
}

test('account enrollment registers the canonical skeleton once and is idempotent', async t => {
    const { db, control, setCaller } = await createControlFixture(t);
    assert.equal((await enrollAccount(control, 'account:a', 'sg', NOW)).kind, 'enrolled');
    assert.equal((await enrollAccount(control, 'account:a', 'sg', NOW + 1)).kind, 'already_enrolled');
    await setCaller('kr-seoul');
    assert.equal((await enrollAccount(control, 'account:a', 'kr-seoul', NOW + 2)).kind, 'enrolled');
    const accounts = (await db.query(`SELECT id, created_at_ms FROM memory_control.accounts`)).rows;
    assert.deepEqual(accounts, [{ id: 'account:a', created_at_ms: NOW }]);
    const enrollments = (await db.query(`SELECT region FROM memory_control.account_enrollments
        WHERE account_id='account:a' AND removed_at_ms IS NULL ORDER BY region`)).rows;
    assert.deepEqual(enrollments.map(r => r.region), ['kr-seoul', 'sg']);
});

test('organization enrollment registers the skeleton and is idempotent', async t => {
    const { db, control } = await createControlFixture(t, 'kr-seoul');
    assert.equal((await enrollOrganization(control, 'org:a', 'kr-seoul', NOW)).kind, 'enrolled');
    assert.equal((await enrollOrganization(control, 'org:a', 'kr-seoul', NOW + 1)).kind, 'already_enrolled');
    assert.equal((await db.query(`SELECT count(*) n FROM memory_control.organizations`).then(r => r.rows[0].n)), 1);
});

test('retired regions refuse new enrollments but keep live ones', async t => {
    const { db, control, setCaller } = await createControlFixture(t);
    await enrollAccount(control, 'account:a', 'sg', NOW);
    await db.query(`UPDATE memory_control.regions SET retired_at_ms=$1 WHERE region='kr-seoul'`, [NOW + 1]);
    await setCaller('kr-seoul');
    await assert.rejects(() => enrollAccount(control, 'account:a', 'kr-seoul', NOW + 2), e => e.code === 'region_unavailable');
    assert.ok(await accountEnrolled(control, 'account:a', 'sg'));
});

test('enrollment removal is terminal and re-enrollment creates a fresh row', async t => {
    const { db, control } = await createControlFixture(t);
    await enrollAccount(control, 'account:a', 'sg', NOW);
    assert.equal((await removeAccountEnrollment(control, 'account:a', 'sg', NOW + 1)).kind, 'removed');
    assert.equal((await removeAccountEnrollment(control, 'account:a', 'sg', NOW + 2)).kind, 'not_enrolled');
    assert.ok(!(await accountEnrolled(control, 'account:a', 'sg')));
    // The removal is terminal; un-removing is denied by the row trigger.
    await assert.rejects(() => db.query(`UPDATE memory_control.account_enrollments SET removed_at_ms=NULL
        WHERE account_id='account:a' AND region='sg'`), e => String(e?.message ?? e).includes('memory_immutable_record'));
    assert.equal((await enrollAccount(control, 'account:a', 'sg', NOW + 3)).kind, 'enrolled');
    const rows = (await db.query(`SELECT enrolled_at_ms, removed_at_ms FROM memory_control.account_enrollments
        WHERE account_id='account:a' ORDER BY enrolled_at_ms`)).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.some(r => r.removed_at_ms !== null));
});

test('organization enrollment removal closes the live row only', async t => {
    const { control } = await createControlFixture(t);
    await enrollOrganization(control, 'org:a', 'sg', NOW);
    assert.equal((await removeOrganizationEnrollment(control, 'org:a', 'sg', NOW + 1)).kind, 'removed');
    assert.ok(!(await organizationEnrolled(control, 'org:a', 'sg')));
});

test('enrollment checks report live state only', async t => {
    const { control } = await createControlFixture(t);
    assert.ok(!(await accountEnrolled(control, 'account:missing', 'sg')));
    assert.ok(!(await organizationEnrolled(control, 'org:missing', 'kr-seoul')));
    await enrollAccount(control, 'account:a', 'sg', NOW);
    assert.ok(await accountEnrolled(control, 'account:a', 'sg'));
    assert.ok(!(await accountEnrolled(control, 'account:a', 'kr-seoul')));
});

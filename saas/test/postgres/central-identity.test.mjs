// Central identity events (docs/plans/2026-09-19-central-identity-events.md):
// the control journal carries enrollment.removed/restored and subject.unlinked
// to regions on the reserved 'memory:control' issuer. Fixtures stand up the
// full control lineage in one PGlite engine and the full regional lineage in
// another — the lifecycle-apply/enrollment sibling pattern — and assert the
// journaled effects end to end: writer definers, the directory-truth guard,
// the region-filtered bounded read, the regional apply and serving denial.
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSession } from './pg-database-fixture.mjs';
import { createPostgresDatabase } from '../../src/postgres/database.ts';
import { enrollAccount, enrollOrganization, removeAccountEnrollment,
    removeOrganizationEnrollment, unlinkSubject } from '../../src/postgres/enrollment.ts';
import { syncLifecycleJournal } from '../../src/postgres/lifecycle-apply.ts';
import { interactive, LIFECYCLE_STALENESS_MS } from '../../src/release/authority.ts';
import { tokenHash } from '../../src/release/util.ts';

const NOW = 1758000000000;
const ISSUER = 'https://issuer.example';
const CONTROL = 'memory:control';
const TOKEN = 'central-identity-test-token-0000000000000';
const SOLO_TOKEN = 'central-identity-solo-token-00000000000000';
const d = n => n.toString(16).padStart(64, '0');
const SG_POLICY = { policyVersion: 1, residency: 'sg', profile: 'standard',
    processingBoundary: 'approved-processors', dataClass: 'general',
    classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 };

/** Full regional lineage; now_ms() pinned so the execution-time guards compare
 * against NOW instead of the wall clock. */
async function regionalDb(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const dir = new URL('../../postgres/migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort())
        await db.exec(await readFile(new URL(name, dir), 'utf8'));
    await db.exec(`CREATE OR REPLACE FUNCTION memory_control.now_ms() RETURNS bigint
        LANGUAGE sql STABLE AS $$ SELECT ${NOW}::bigint $$`);
    await db.query(`INSERT INTO memory_control.deployment_identity VALUES(1,'memory-sg','sg','standard-v1',1)`);
    return { db, region: createPostgresDatabase(createPgliteSession(db)) };
}

/** Full control lineage. `setCaller` simulates a serving worker from the given
 * region — enrollment commands only ever register the caller's own region,
 * matching the attested `memory.caller_region` pin in production. Passing ''
 * unsets the claim (the owner/test session that sees every control row). */
async function controlDb(t, caller = 'sg') {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const dir = new URL('../../postgres/migrations/', import.meta.url);
    await db.exec(await readFile(new URL('0001_private_namespaces.sql', dir), 'utf8'));
    await db.exec(await readFile(new URL('0002_deployment_identity.sql', dir), 'utf8'));
    const controlDir = new URL('../../postgres/control/', import.meta.url);
    for (const name of (await readdir(controlDir)).filter(f => f.endsWith('.sql')).sort())
        await db.exec(await readFile(new URL(name, controlDir), 'utf8'));
    await db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',$1),('kr-seoul',$1)`, [NOW]);
    const setCaller = region => db.query(`SELECT pg_catalog.set_config('memory.caller_region',$1,false)`, [region]);
    await setCaller(caller);
    return { db, control: createPostgresDatabase(createPgliteSession(db)), setCaller };
}

/** Regional seed: an account, one provider binding and one live session. */
async function seedBoundAccount(db, { account, subject, credential, digest }) {
    await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ($1)`, [account]);
    await db.query(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
        VALUES ($1,$2,$3,$4)`, [ISSUER, subject, account, NOW]);
    await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
        VALUES ($1,$2,'session',$3,$4)`, [credential, account, digest, NOW + 900000]);
}

/** A sign-in record: the binding→credential linkage apply_subject_unlink
 * revokes on. The seeded binding already exists, so the apply mints only the
 * session credential (and the account's personal Space on the first record). */
async function signIn(db, { id, subject, account, credential, digest, email, space }) {
    await db.query(`INSERT INTO memory_identity.workspace_sign_ins(id, issuer, subject,
        new_account_id, credential_id, token_digest, expires_at, permission, email_id,
        address, domain, personal_space_id, data_policy, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'write',$8,NULL,NULL,$9,$10,$11)`,
        [id, ISSUER, subject, account, credential, digest, NOW + 900000, email, space,
            JSON.stringify(SG_POLICY), NOW]);
}

const denied = e => String(e?.code ?? '') === '55000' || /denied|rejected|missing/i.test(String(e?.message ?? e));

test('account enrollment removal journals a control event the region applies as denial', async t => {
    const { db: ctl, control } = await controlDb(t);
    const { db: reg, region } = await regionalDb(t);
    await seedBoundAccount(reg, { account: 'account:a', subject: 'sub-1', credential: 'sess:a', digest: d(1) });
    await seedBoundAccount(reg, { account: 'account:b', subject: 'sub-2', credential: 'sess:b', digest: d(2) });
    await enrollAccount(control, 'account:a', 'sg', NOW);
    await enrollAccount(control, 'account:b', 'sg', NOW);
    // A first-ever enrollment emits nothing — absent state already means allowed.
    assert.equal((await ctl.query(`SELECT count(*)::int n FROM memory_ops.lifecycle_events
        WHERE issuer='memory:control'`)).rows[0].n, 0);
    assert.equal((await removeAccountEnrollment(control, 'account:a', 'sg', NOW + 1)).kind, 'removed');
    const journal = (await ctl.query(`SELECT kind, source, region, scope, target_id
        FROM memory_ops.lifecycle_events WHERE issuer='memory:control'`)).rows;
    assert.deepEqual(journal, [{ kind: 'enrollment.removed', source: 'control', region: 'sg',
        scope: 'account', target_id: 'account:a' }]);
    // The region reads it through the bounded definer; the caller claim is 'sg'.
    assert.equal((await ctl.query(`SELECT count(*)::int n
        FROM memory_ops.lifecycle_events_after('memory:control',0,100)`)).rows[0].n, 1);
    assert.deepEqual(await syncLifecycleJournal(control, region), { applied: 1, head: 1 });
    assert.deepEqual((await reg.query(`SELECT scope, subject_id, kind
        FROM memory_ops.enrollment_applied_state`)).rows,
        [{ scope: 'account', subject_id: 'account:a', kind: 'enrollment.removed' }]);
    // Denial is scoped to the removed account; the still-enrolled account is live.
    assert.deepEqual((await reg.query(`SELECT id FROM memory_identity.active_credentials ORDER BY id`)).rows
        .map(r => r.id), ['sess:b']);
    // The event never lands in the provider applied state — a non-resumed row
    // on (issuer, subject, '') would deny by lifecycle kind, not enrollment.
    assert.equal((await reg.query(`SELECT count(*)::int n FROM memory_ops.lifecycle_applied_state`)).rows[0].n, 0);
});

test('re-enrollment journals enrollment.restored and the region restores access', async t => {
    const { db: ctl, control } = await controlDb(t);
    const { db: reg, region } = await regionalDb(t);
    await seedBoundAccount(reg, { account: 'account:a', subject: 'sub-1', credential: 'sess:a', digest: d(1) });
    await enrollAccount(control, 'account:a', 'sg', NOW);
    await removeAccountEnrollment(control, 'account:a', 'sg', NOW + 1);
    await syncLifecycleJournal(control, region);
    assert.equal((await reg.query(`SELECT count(*)::int n FROM memory_identity.active_credentials`)).rows[0].n, 0);
    // A prior removed row makes this a restore, not a first enrollment.
    assert.equal((await enrollAccount(control, 'account:a', 'sg', NOW + 2)).kind, 'enrolled');
    assert.deepEqual((await ctl.query(`SELECT kind FROM memory_ops.lifecycle_events
        WHERE issuer='memory:control' ORDER BY sequence`)).rows.map(r => r.kind),
        ['enrollment.removed', 'enrollment.restored']);
    assert.equal((await syncLifecycleJournal(control, region)).applied, 1);
    assert.equal((await reg.query(`SELECT kind FROM memory_ops.enrollment_applied_state
        WHERE scope='account' AND subject_id='account:a'`)).rows[0].kind, 'enrollment.restored');
    assert.equal((await reg.query(`SELECT count(*)::int n FROM memory_identity.active_credentials`)).rows[0].n, 1);
});

test('organization enrollment removal denies memberships after sync', async t => {
    const { control } = await controlDb(t);
    const { db: reg, region } = await regionalDb(t);
    await reg.query(`INSERT INTO memory_control.organizations(id) VALUES ('org:a')`);
    await reg.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a')`);
    await reg.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
        VALUES ('email:a','account:a','a@example.test','example.test',$1)`, [NOW]);
    await reg.query(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
        VALUES ('member:a','org:a','account:a','email:a','owner')`);
    assert.equal((await reg.query(`SELECT count(*)::int n FROM memory_identity.active_memberships`)).rows[0].n, 1);
    await enrollOrganization(control, 'org:a', 'sg', NOW);
    assert.equal((await removeOrganizationEnrollment(control, 'org:a', 'sg', NOW + 1)).kind, 'removed');
    assert.equal((await syncLifecycleJournal(control, region)).applied, 1);
    assert.deepEqual((await reg.query(`SELECT scope, subject_id, kind FROM memory_ops.enrollment_applied_state`)).rows,
        [{ scope: 'organization', subject_id: 'org:a', kind: 'enrollment.removed' }]);
    assert.equal((await reg.query(`SELECT count(*)::int n FROM memory_identity.active_memberships`)).rows[0].n, 0);
    // The authority row itself is retained — only the live view excludes it.
    assert.equal((await reg.query(`SELECT count(*)::int n FROM memory_identity.memberships WHERE revoked_at IS NULL`)).rows[0].n, 1);
});

test('subject.unlinked tombstones the binding and revokes only its minted sessions', async t => {
    const { db: ctl, control } = await controlDb(t);
    const { db: reg, region } = await regionalDb(t);
    // Central directory: the account skeleton and the live binding to unlink.
    await ctl.query(`INSERT INTO memory_control.accounts(id, created_at_ms) VALUES ('acct:one',$1)`, [NOW]);
    await ctl.query(`INSERT INTO memory_control.provider_identities(issuer, subject, account_id, created_at_ms)
        VALUES ($1,'sub-1','acct:one',$2)`, [ISSUER, NOW]);
    // Regional: one account carrying two bindings, each with a session minted
    // through a sign-in record, plus a PAT no binding minted.
    await reg.query(`INSERT INTO memory_identity.accounts(id) VALUES ('acct:one')`);
    await reg.query(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
        VALUES ($1,'sub-1','acct:one',$2),($1,'sub-2','acct:one',$2)`, [ISSUER, NOW]);
    await signIn(reg, { id: 'sign:1', subject: 'sub-1', account: 'acct:one',
        credential: 'sess:one', digest: d(1), email: 'email:one', space: 'space:one' });
    await signIn(reg, { id: 'sign:2', subject: 'sub-2', account: 'acct:one',
        credential: 'sess:two', digest: d(2), email: 'email:two', space: 'space:two' });
    await reg.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
        VALUES ('pat:one','acct:one','personal_key',$1,$2)`, [d(3), NOW + 900000]);
    assert.equal((await unlinkSubject(control, ISSUER, 'sub-1', NOW + 10)).kind, 'unlinked');
    // Already unlinked reports instead of failing — and does not double-journal.
    assert.equal((await unlinkSubject(control, ISSUER, 'sub-1', NOW + 11)).kind, 'already_unlinked');
    assert.deepEqual(await control.prepare(`SELECT unlinked_at_ms AS at FROM memory_control.provider_identities
        WHERE issuer=? AND subject='sub-1'`).bind(ISSUER).first(), { at: NOW + 10 });
    assert.deepEqual((await ctl.query(`SELECT kind, region, target_issuer FROM memory_ops.lifecycle_events
        WHERE issuer='memory:control'`)).rows,
        [{ kind: 'subject.unlinked', region: null, target_issuer: ISSUER }]);
    assert.equal((await syncLifecycleJournal(control, region)).applied, 1);
    // The regional tombstone lands on provider_revocations; no applied-state
    // row is written — a non-resumed kind on (issuer, subject, '') would deny
    // the whole account through the surviving binding.
    assert.deepEqual((await region.prepare(`SELECT issuer, subject, kind, address, created_at_ms
        FROM memory_ops.provider_revocations`).bind().all()).results,
        [{ issuer: ISSUER, subject: 'sub-1', kind: 'subject.unlinked', address: '', created_at_ms: NOW + 10 }]);
    assert.equal((await reg.query(`SELECT count(*)::int n FROM memory_ops.lifecycle_applied_state`)).rows[0].n, 0);
    // Only the dead binding's minted session is revoked; the sibling session
    // and the PAT survive, so the account stays live.
    assert.deepEqual((await region.prepare(`SELECT id, revoked_at FROM memory_identity.credentials
        ORDER BY id`).bind().all()).results,
        [{ id: 'pat:one', revoked_at: null }, { id: 'sess:one', revoked_at: NOW + 10 }, { id: 'sess:two', revoked_at: null }]);
    assert.deepEqual((await reg.query(`SELECT id FROM memory_identity.active_credentials ORDER BY id`)).rows
        .map(r => r.id), ['pat:one', 'sess:two']);
    assert.deepEqual((await reg.query(`SELECT subject FROM memory_identity.active_provider_identities
        ORDER BY subject`)).rows.map(r => r.subject), ['sub-2']);
    // The dead pair cannot mint a new session; the live pair still can.
    await assert.rejects(() => signIn(reg, { id: 'sign:3', subject: 'sub-1', account: 'acct:one',
        credential: 'sess:three', digest: d(5), email: 'email:three', space: 'space:three' }), denied);
    await signIn(reg, { id: 'sign:4', subject: 'sub-2', account: 'acct:one',
        credential: 'sess:four', digest: d(6), email: 'email:four', space: 'space:four' });
    assert.equal((await reg.query(`SELECT count(*)::int n FROM memory_identity.credentials
        WHERE id='sess:four'`)).rows[0].n, 1);
});

test('a control journal row that does not restate directory truth is rejected', async t => {
    const { db: ctl, control } = await controlDb(t);
    await enrollAccount(control, 'account:real', 'sg', NOW);
    await removeAccountEnrollment(control, 'account:real', 'sg', NOW + 1);
    const real = (await ctl.query(`SELECT id FROM memory_ops.lifecycle_events WHERE issuer='memory:control'`)).rows;
    assert.equal(real.length, 1);
    // Forge by copying the truthful row: the copy keeps every channel invariant
    // and changes only the directory fact it asserts.
    const forged = (id, kind, region) => ctl.query(`INSERT INTO memory_ops.lifecycle_events(id, issuer, subject,
        sequence, kind, address, occurred_at_ms, received_at_ms, signed_at_ms, body_hash,
        source, region, scope, target_id, target_issuer)
        SELECT $2, issuer, subject, sequence + 100, $3, address, occurred_at_ms, received_at_ms,
            signed_at_ms, body_hash, source, $4, scope, target_id, target_issuer
        FROM memory_ops.lifecycle_events WHERE id = $1`, [real[0].id, id, kind, region]);
    // A kr-seoul removal the directory never recorded.
    await assert.rejects(() => forged('cev:forged-region', 'enrollment.removed', 'kr-seoul'), denied);
    // A restore while the only enrollment row for the target stands removed.
    await assert.rejects(() => forged('cev:forged-restore', 'enrollment.restored', 'sg'), denied);
    assert.equal((await ctl.query(`SELECT count(*)::int n FROM memory_ops.lifecycle_events`)).rows[0].n, 1);
});

test('the bounded journal read hides control rows outside the caller region', async t => {
    const { db: ctl, control, setCaller } = await controlDb(t, 'sg');
    await enrollAccount(control, 'account:sg', 'sg', NOW);
    await removeAccountEnrollment(control, 'account:sg', 'sg', NOW + 1);
    await setCaller('kr-seoul');
    await enrollAccount(control, 'account:kr', 'kr-seoul', NOW);
    await removeAccountEnrollment(control, 'account:kr', 'kr-seoul', NOW + 1);
    assert.equal((await ctl.query(`SELECT count(*)::int n FROM memory_ops.lifecycle_events
        WHERE issuer='memory:control'`)).rows[0].n, 2);
    const visible = async caller => {
        await setCaller(caller);
        return (await ctl.query(`SELECT region FROM memory_ops.lifecycle_events_after('memory:control',0,100)
            ORDER BY sequence`)).rows.map(r => r.region);
    };
    assert.deepEqual(await visible('sg'), ['sg']);
    assert.deepEqual(await visible('kr-seoul'), ['kr-seoul']);
    // An unset claim (owner/test sessions) sees every control row.
    assert.deepEqual(await visible(''), ['sg', 'kr-seoul']);
});

test('a stale or missing control apply-head denies provider-bound accounts', async t => {
    const { control } = await controlDb(t);
    const { db: reg, region } = await regionalDb(t);
    await seedBoundAccount(reg, { account: 'account:a', subject: 'sub-1', credential: 'sess:a',
        digest: await tokenHash(TOKEN) });
    // A region-only account carries no central state to be stale about.
    await reg.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:solo')`);
    await reg.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
        VALUES ('sess:solo','account:solo','session',$1,$2)`, [await tokenHash(SOLO_TOKEN), NOW + 900000]);
    // No heads at all: the bound account denies before the first sync.
    await assert.rejects(() => interactive(region, TOKEN, () => NOW),
        e => e?.status === 403 && e?.code === 'interactive_session_required');
    // After sync both heads (issuer + control channel) are fresh and the
    // session authorizes.
    await syncLifecycleJournal(control, region);
    assert.equal((await interactive(region, TOKEN, () => NOW)).accountId, 'account:a');
    // Age only the control head beyond the staleness budget: the issuer head
    // stays fresh yet the bound account denies.
    await reg.query(`UPDATE memory_ops.lifecycle_apply_head SET applied_at_ms=$1 WHERE issuer='memory:control'`,
        [NOW - LIFECYCLE_STALENESS_MS - 1]);
    await assert.rejects(() => interactive(region, TOKEN, () => NOW),
        e => e?.status === 403 && e?.code === 'interactive_session_required');
    assert.equal((await interactive(region, SOLO_TOKEN, () => NOW)).accountId, 'account:solo');
});

test('an empty control stream still stamps the control apply-head', async t => {
    const { control } = await controlDb(t);
    const { region } = await regionalDb(t);
    // No bindings and no events: the control channel is still synced so its
    // watermark lands — without it the staleness gate would deny bound
    // accounts forever.
    assert.deepEqual(await syncLifecycleJournal(control, region), { applied: 0, head: 0 });
    assert.deepEqual(await region.prepare(`SELECT applied_sequence AS n, applied_at_ms AS at
        FROM memory_ops.lifecycle_apply_head WHERE issuer='memory:control'`).bind().first(),
        { n: 0, at: NOW });
});

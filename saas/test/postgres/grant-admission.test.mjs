import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSession } from './pg-database-fixture.mjs';
import { createPostgresDatabase } from '../../src/postgres/database.ts';
import { accountGrantAdmission, deploymentRegion, enrollAccount, enrollOrganization,
    organizationGrantAdmission, removeAccountEnrollment, removeOrganizationEnrollment } from '../../src/postgres/enrollment.ts';
import { WorkspaceService } from '../../src/workspace.ts';
import { Transfers } from '../../src/release/transfer.ts';

const NOW = 1758000000000;
const ISSUER = 'https://issuer.example';
const ACTOR_TOKEN = 'actor-session-token-0123456789abcdef';
const ACTOR_DIGEST = createHash('sha256').update(ACTOR_TOKEN).digest('hex');
const SEOUL_POLICY = { policyVersion: 1, residency: 'kr-seoul', profile: 'kr-primary-storage',
    processingBoundary: 'approved-processors', dataClass: 'personal', classificationStatus: 'declared',
    sensitivityTags: [], placementEpoch: 1 };

async function regionalDb(t, { deployment = 'kr-seoul' } = {}) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const dir = new URL('../../postgres/migrations/', import.meta.url);
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
    for (const name of files) await db.exec(await readFile(new URL(name, dir), 'utf8'));
    await db.exec(`CREATE OR REPLACE FUNCTION memory_control.now_ms() RETURNS bigint
        LANGUAGE sql STABLE AS $$ SELECT ${NOW}::bigint $$`);
    if (deployment !== null)
        await db.query(`INSERT INTO memory_control.deployment_identity(singleton, deployment_id, storage_region, processing_policy_id, created_at_ms)
            VALUES (1, $1, $2, 'policy:test', $3)`, [deployment === 'kr-seoul' ? 'memory-seoul' : 'memory-sg', deployment, NOW]);
    const region = createPostgresDatabase(createPgliteSession(db));
    const boundAccount = async (accountId, { credential = false, digest = ACTOR_DIGEST } = {}) => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ($1)`, [accountId]);
        await db.query(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
            VALUES ($1, $2, $3, $4)`, [ISSUER, `sub-${accountId}`, accountId, NOW]);
        if (credential) {
            await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at, permission, reauthenticated_at)
                VALUES ($1, $2, 'session', $3, $4, 'write', $5)`, [`cred:${accountId}`, accountId, digest, NOW + 900000, NOW]);
            await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
                VALUES ($1, $2, $3, 'example.com', $4)`, [`em:${accountId}`, accountId, `${accountId}@example.com`, NOW]);
            await db.query(`INSERT INTO memory_ops.lifecycle_apply_head(issuer, applied_sequence, applied_at_ms)
                VALUES ($1, 1, $2), ('memory:control', 1, $2) ON CONFLICT (issuer) DO NOTHING`, [ISSUER, NOW]);
        }
    };
    return { db, region, boundAccount };
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
    await db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',$1),('kr-seoul',$1)`, [NOW]);
    // The serving worker attests its region; enrollment commands only ever
    // register rows for the caller's own region.
    await db.query(`SELECT pg_catalog.set_config('memory.caller_region','kr-seoul',false)`);
    return { db, control: createPostgresDatabase(createPgliteSession(db)) };
}

test('deploymentRegion reads the singleton and fails closed without one', async t => {
    const { region } = await regionalDb(t);
    assert.equal(await deploymentRegion(region), 'kr-seoul');
    const bare = await regionalDb(t, { deployment: null });
    assert.equal(await deploymentRegion(bare.region), null);
});

test('account grant admission: bound accounts need a live enrollment', async t => {
    const { region, boundAccount } = await regionalDb(t);
    const { db: ctl, control } = await controlDb(t);
    await boundAccount('acct:a');
    assert.equal(await accountGrantAdmission(region, control, 'acct:a'), false);
    await enrollAccount(control, 'acct:a', 'kr-seoul', NOW);
    assert.equal(await accountGrantAdmission(region, control, 'acct:a'), true);
    await removeAccountEnrollment(control, 'acct:a', 'kr-seoul', NOW + 1);
    assert.equal(await accountGrantAdmission(region, control, 'acct:a'), false);
    // Enrollment in a different region does not satisfy this deployment. A
    // foreign-region row can only be registered by that region's own worker —
    // seed it as directory state rather than through this caller's command.
    await ctl.query(`INSERT INTO memory_control.accounts(id, created_at_ms) VALUES ('acct:b',$1)
        ON CONFLICT (id) DO NOTHING`, [NOW]);
    await ctl.query(`INSERT INTO memory_control.account_enrollments(account_id, region, enrolled_at_ms)
        VALUES ('acct:b','sg',$1)`, [NOW]);
    await boundAccount('acct:b');
    assert.equal(await accountGrantAdmission(region, control, 'acct:b'), false);
});

test('account grant admission: region-only accounts are exempt; single-cluster skips', async t => {
    const { region } = await regionalDb(t);
    const { control } = await controlDb(t);
    await region.prepare(`INSERT INTO memory_identity.accounts(id) VALUES ('acct:local')`).bind().run();
    assert.equal(await accountGrantAdmission(region, control, 'acct:local'), true);
    assert.equal(await accountGrantAdmission(region, undefined, 'acct:anything'), true);
    // A missing deployment identity fails closed when a directory exists.
    const bare = await regionalDb(t, { deployment: null });
    assert.equal(await accountGrantAdmission(bare.region, control, 'acct:local'), false);
});

test('organization grant admission requires the org enrollment', async t => {
    const { region } = await regionalDb(t);
    const { control } = await controlDb(t);
    assert.equal(await organizationGrantAdmission(region, control, 'org:a'), false);
    await enrollOrganization(control, 'org:a', 'kr-seoul', NOW);
    assert.equal(await organizationGrantAdmission(region, control, 'org:a'), true);
    await removeOrganizationEnrollment(control, 'org:a', 'kr-seoul', NOW + 1);
    assert.equal(await organizationGrantAdmission(region, control, 'org:a'), false);
    assert.equal(await organizationGrantAdmission(region, undefined, 'org:anything'), true);
});

test('workspace issueKey denies an unenrolled actor and admits an enrolled one', async t => {
    const { db, region, boundAccount } = await regionalDb(t);
    const { control } = await controlDb(t);
    await boundAccount('acct:actor', { credential: true });
    const workspace = new WorkspaceService(region, () => NOW, { control });
    await assert.rejects(() => workspace.issueKey(ACTOR_TOKEN, { label: 'k', permission: 'write', expiresInDays: 7 }),
        e => e.code === 'enrollment_required' && e.status === 403);
    await enrollAccount(control, 'acct:actor', 'kr-seoul', NOW);
    const issued = await workspace.issueKey(ACTOR_TOKEN, { label: 'k', permission: 'write', expiresInDays: 7 });
    assert.equal(typeof issued.token, 'string');
    const keys = await db.query(`SELECT count(*) n FROM memory_identity.credentials WHERE account_id='acct:actor' AND kind='personal_key'`);
    assert.equal(keys.rows[0].n, 1);
});

test('workspace issueKey denies org-scoped keys for an unenrolled organization', async t => {
    const { db, region, boundAccount } = await regionalDb(t);
    const { control } = await controlDb(t);
    await boundAccount('acct:actor', { credential: true });
    await enrollAccount(control, 'acct:actor', 'kr-seoul', NOW);
    // Regional org + owner membership exist, but the org is not enrolled.
    await db.query(`INSERT INTO memory_control.organizations(id) VALUES ('org:a')`);
    await db.query(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
        VALUES ('mem:a','org:a','acct:actor','em:acct:actor','owner')`);
    const workspace = new WorkspaceService(region, () => NOW, { control });
    await assert.rejects(() => workspace.issueKey(ACTOR_TOKEN, { label: 'k', organizationId: 'org:a', permission: 'write', expiresInDays: 7 }),
        e => e.code === 'enrollment_required');
    await enrollOrganization(control, 'org:a', 'kr-seoul', NOW);
    const issued = await workspace.issueKey(ACTOR_TOKEN, { label: 'k', organizationId: 'org:a', permission: 'write', expiresInDays: 7 });
    assert.equal(typeof issued.token, 'string');
});

test('createOrganization enrolls the new org in the serving region', async t => {
    const { db, region, boundAccount } = await regionalDb(t);
    const { db: ctl, control } = await controlDb(t);
    await boundAccount('acct:actor', { credential: true });
    const workspace = new WorkspaceService(region, () => NOW, { control });
    await assert.rejects(() => workspace.createOrganization(ACTOR_TOKEN, { name: 'Org', emailId: 'em:acct:actor' }),
        e => e.code === 'enrollment_required');
    assert.equal((await ctl.query(`SELECT count(*) n FROM memory_control.organizations`)).rows[0].n, 0);
    await enrollAccount(control, 'acct:actor', 'kr-seoul', NOW);
    const created = await workspace.createOrganization(ACTOR_TOKEN, { name: 'Org', emailId: 'em:acct:actor' });
    const rows = await ctl.query(`SELECT region FROM memory_control.organization_enrollments
        WHERE organization_id=$1 AND removed_at_ms IS NULL`, [created.id]);
    assert.deepEqual(rows.rows.map(r => r.region), ['kr-seoul']);
    const regional = await db.query(`SELECT count(*) n FROM memory_control.organizations WHERE id=$1`, [created.id]);
    assert.equal(regional.rows[0].n, 1);
});

test('acceptInvite requires both invitee and organization enrollment', async t => {
    const { db, region, boundAccount } = await regionalDb(t);
    const { control } = await controlDb(t);
    await boundAccount('acct:owner', { credential: true, digest: createHash('sha256').update('owner-token').digest('hex') });
    await boundAccount('acct:actor', { credential: true });
    // Owner's org + owner membership + invitation addressed to the actor.
    await db.query(`INSERT INTO memory_control.organizations(id) VALUES ('org:a')`);
    await db.query(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
        VALUES ('mem:owner','org:a','acct:owner','em:acct:owner','owner')`);
    const inviteDigest = createHash('sha256').update('invite-proof-token-0123456789abcdef').digest('hex');
    await db.query(`INSERT INTO memory_identity.workspace_invitations(id, organization_id, address, role, token_digest,
        creator_membership_id, actor_credential_id, created_at, expires_at)
        VALUES ('inv:a','org:a','acct:actor@example.com','member',$1,'mem:owner','cred:acct:owner',$2,$3)`,
        [inviteDigest, NOW, NOW + 86400000]);
    const workspace = new WorkspaceService(region, () => NOW, { control });
    await assert.rejects(() => workspace.acceptInvite(ACTOR_TOKEN, 'invite-proof-token-0123456789abcdef'),
        e => e.code === 'enrollment_required');
    await enrollAccount(control, 'acct:actor', 'kr-seoul', NOW);
    await assert.rejects(() => workspace.acceptInvite(ACTOR_TOKEN, 'invite-proof-token-0123456789abcdef'),
        e => e.code === 'enrollment_required');
    await enrollOrganization(control, 'org:a', 'kr-seoul', NOW);
    const accepted = await workspace.acceptInvite(ACTOR_TOKEN, 'invite-proof-token-0123456789abcdef');
    assert.equal(accepted.organizationId, 'org:a');
    const member = await db.query(`SELECT count(*) n FROM memory_identity.memberships
        WHERE organization_id='org:a' AND account_id='acct:actor'`);
    assert.equal(member.rows[0].n, 1);
});

test('share denies a recipient that is not enrolled in the Space region', async t => {
    const { db, region, boundAccount } = await regionalDb(t);
    const { control } = await controlDb(t);
    await boundAccount('acct:actor', { credential: true });
    await boundAccount('acct:guest');
    await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
        VALUES ('em:guest','acct:guest','guest@example.com','example.com',$1)`, [NOW]);
    await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, deployment_id, data_policy,
        source_byte_limit, message_limit, name, security_mode, created_at_ms)
        VALUES ('space:a','acct:actor','memory-seoul',$1::jsonb,67108864,100000,'Space','managed',$2)`,
        [JSON.stringify(SEOUL_POLICY), NOW]);
    const transfers = new Transfers(region, () => NOW, undefined, control);
    // Recipient has SSO bindings but no enrollment in this region.
    await assert.rejects(() => transfers.share(ACTOR_TOKEN, 'space:a', 'guest@example.com'),
        e => e.code === 'recipient_or_authority_unavailable');
    // Enrolled recipient passes admission; the deferred-share guard still denies.
    await enrollAccount(control, 'acct:actor', 'kr-seoul', NOW);
    await enrollAccount(control, 'acct:guest', 'kr-seoul', NOW);
    await assert.rejects(() => transfers.share(ACTOR_TOKEN, 'space:a', 'guest@example.com'),
        e => e.code === 'share_unavailable');
});

test('share admission skips the directory on single-cluster deployments', async t => {
    const { db, region, boundAccount } = await regionalDb(t);
    await boundAccount('acct:actor', { credential: true });
    await boundAccount('acct:guest');
    await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
        VALUES ('em:guest','acct:guest','guest@example.com','example.com',$1)`, [NOW]);
    await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, deployment_id, data_policy,
        source_byte_limit, message_limit, name, security_mode, created_at_ms)
        VALUES ('space:a','acct:actor','memory-seoul',$1::jsonb,67108864,100000,'Space','managed',$2)`,
        [JSON.stringify(SEOUL_POLICY), NOW]);
    const transfers = new Transfers(region, () => NOW);
    await assert.rejects(() => transfers.share(ACTOR_TOKEN, 'space:a', 'guest@example.com'),
        e => e.code === 'share_unavailable');
});

import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const NOW = 1758000000000;
const MAX = 9007199254740991;
const d = n => n.toString(16).padStart(64, '0');
const SG_POLICY = { policyVersion: 1, residency: 'sg', profile: 'standard', processingBoundary: 'approved-processors',
    dataClass: 'general', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 };

async function createFixture(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const initial = (await db.query('SELECT current_database() AS name,current_user AS role')).rows[0];
    const restore = 'SET SESSION AUTHORIZATION "' + initial.role.replaceAll('"', '""') + '"';
    await db.exec('CREATE ROLE fixture_provisioner LOGIN CREATEROLE');
    if (initial.name === 'template1') {
        await db.exec('GRANT "' + initial.role.replaceAll('"', '""') + '" TO fixture_provisioner WITH SET FALSE, INHERIT TRUE, ADMIN FALSE');
    } else {
        await db.exec(`GRANT CREATE ON DATABASE "${initial.name.replaceAll('"', '""')}" TO fixture_provisioner`);
    }
    await db.exec(`GRANT pg_read_all_data TO fixture_provisioner;
        SET SESSION AUTHORIZATION fixture_provisioner;
        SET createrole_self_grant='set, inherit';`);
    const migrations = new URL('../../postgres/migrations/', import.meta.url);
    for (const name of ['0001_private_namespaces.sql', '0002_deployment_identity.sql', '0003_identity_foundation.sql',
        '0004_seoul_pat_archive.sql', '0005_seoul_archive_lifecycle.sql', '0006_identity_authority.sql',
        '0007_workspace_regional.sql']) {
        await db.exec(await readFile(new URL(name, migrations), 'utf8'));
    }
    await db.exec(`RESET ROLE; ${restore}`);
    const asOwner = async fn => { await db.exec('SET ROLE memory_owner'); try { return await fn(db); } finally { await db.exec('ROLLBACK'); await db.exec('RESET ROLE'); } };
    await asOwner(() => db.query(`INSERT INTO memory_control.deployment_identity
        VALUES(1,'memory-sg','sg','standard-v1',1)`));
    return { db, asOwner };
}

const denied = e => /55000|42501|23505|23514|23503/.test(String(e?.code ?? ''))
    || /workspace operation denied|release_denied|residency|denied|immutable/.test(String(e?.message ?? e));

test('installs as regional version 7 with the workspace schema set', async t => {
    const { db } = await createFixture(t);
    const rows = (await db.query('SELECT version, name FROM memory_control.schema_migrations ORDER BY version')).rows;
    assert.equal(rows.at(-1).version, 7);
    assert.equal(rows.at(-1).name, '0007_workspace_regional.sql');
    const cols = (await db.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='memory_control' AND table_name='spaces' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
    for (const c of ['name', 'security_mode', 'created_at_ms', 'actor_credential_id']) assert.ok(cols.includes(c), c);
});

test('sign-in bootstraps a new account with session, email claim and Personal space', async t => {
    const { db, asOwner } = await createFixture(t);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_sign_ins(id, issuer, subject, new_account_id,
            credential_id, token_digest, expires_at, permission, email_id, address, domain,
            personal_space_id, data_policy, created_at)
            VALUES ('sign:1','https://iss.example','sub-1','account:1','sess:1',$1,$2,'write',
                'email:1','a@example.test','example.test','space:1',$3,$4)`,
            [d(1), NOW + 60000, JSON.stringify(SG_POLICY), NOW]);
    });
    const account = (await db.query(`SELECT id FROM memory_identity.accounts WHERE id='account:1'`)).rows;
    assert.equal(account.length, 1);
    const binding = (await db.query(`SELECT account_id FROM memory_identity.provider_identities
        WHERE issuer='https://iss.example' AND subject='sub-1'`)).rows;
    assert.deepEqual(binding, [{ account_id: 'account:1' }]);
    const session = (await db.query(`SELECT kind, permission FROM memory_identity.credentials WHERE id='sess:1'`)).rows;
    assert.deepEqual(session, [{ kind: 'session', permission: 'write' }]);
    const claim = (await db.query(`SELECT address FROM memory_identity.account_emails WHERE id='email:1'`)).rows;
    assert.deepEqual(claim, [{ address: 'a@example.test' }]);
    const space = (await db.query(`SELECT owner_account_id, name, security_mode, deployment_id
        FROM memory_control.spaces WHERE id='space:1'`)).rows;
    assert.deepEqual(space, [{ owner_account_id: 'account:1', name: 'Personal', security_mode: 'managed', deployment_id: 'memory-sg' }]);
    const audit = (await db.query(`SELECT action, account_id FROM memory_ops.workspace_audit_events`)).rows;
    assert.deepEqual(audit, [{ action: 'signed_in', account_id: 'account:1' }]);
});

test('sign-in rejects residency that disagrees with the deployment', async t => {
    const { db, asOwner } = await createFixture(t);
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_sign_ins(id, issuer, subject, new_account_id,
            credential_id, token_digest, expires_at, permission, email_id, personal_space_id, data_policy, created_at)
            VALUES ('sign:1','iss','sub','account:1','sess:1',$1,$2,'write','email:1','space:1',$3,$4)`,
            [d(1), NOW + 60000, JSON.stringify({ ...SG_POLICY, residency: 'kr-seoul' }), NOW]);
    }), denied);
    assert.equal((await db.query('SELECT count(*)::int n FROM memory_identity.accounts')).rows[0].n, 0);
});

test('org creation, invitation acceptance, key issuance and revocations flow through commands', async t => {
    const { db, asOwner } = await createFixture(t);
    // Bootstrap two accounts with live sessions.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a'),('account:b')`);
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('email:a','account:a','a@example.test','example.test',$1),
                   ('email:b','account:b','b@example.test','example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at, reauthenticated_at)
            VALUES ('sess:a','account:a','session',$1,$2,$3),('sess:b','account:b','session',$4,$2,$3)`,
            [d(1), MAX, NOW, d(2)]);
    });
    // Org creation by account:a.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_organization_creations(id, name,
            actor_credential_id, email_id, membership_id, space_id, data_policy, created_at)
            VALUES ('org:1','Acme','sess:a','email:a','member:a','space:org1',$1,$2)`,
            [JSON.stringify(SG_POLICY), NOW]);
    });
    assert.deepEqual((await db.query(`SELECT organization_id, role FROM memory_identity.memberships`)).rows,
        [{ organization_id: 'org:1', role: 'owner' }]);
    assert.equal((await db.query(`SELECT name FROM memory_control.spaces WHERE id='space:org1'`)).rows[0].name, 'Acme');
    // Invite account:b (admin cannot be invited by a non-admin — sess:b is not a member).
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_invitations(id, organization_id, address, role,
            token_digest, creator_membership_id, actor_credential_id, created_at, expires_at)
            VALUES ('inv:bad','org:1','b@example.test','member',$1,'member:a','sess:b',$2,$3)`, [d(3), NOW, NOW + 1000]);
    }), denied);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_invitations(id, organization_id, address, role,
            token_digest, creator_membership_id, actor_credential_id, created_at, expires_at)
            VALUES ('inv:1','org:1','b@example.test','admin',$1,'member:a','sess:a',$2,$3)`, [d(3), NOW, NOW + 1000]);
        await db.query(`INSERT INTO memory_identity.workspace_invitation_acceptances(id, invitation_id,
            actor_credential_id, email_id, created_at)
            VALUES ('acc:1','inv:1','sess:b','email:b',$1)`, [NOW + 10]);
    });
    const memberships = (await db.query(`SELECT account_id, role FROM memory_identity.memberships`)).rows;
    assert.deepEqual(memberships.map(m => m.role).sort(), ['admin', 'owner']);
    // Key issuance: org-scoped write key by the new admin.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_key_issuances(id, actor_credential_id,
            organization_id, label, permission, token_digest, created_at, expires_at)
            VALUES ('key:1','sess:b','org:1','ci','write',$1,$2,$3)`, [d(4), NOW, NOW + 86400000]);
    });
    const key = (await db.query(`SELECT kind, permission, membership_id FROM memory_identity.credentials WHERE id='key:1'`)).rows[0];
    assert.deepEqual(key, { kind: 'api_key', permission: 'write', membership_id: 'acc:1' });
    // Key revocation by the owner session.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_key_revocations(id, actor_credential_id,
            credential_id, created_at) VALUES ('rev:k1','sess:a','key:1',$1)`, [NOW + 20]);
    });
    assert.equal((await db.query(`SELECT revoked_at FROM memory_identity.credentials WHERE id='key:1'`)).rows[0].revoked_at, NOW + 20);
    // Membership revocation cascades to the admin's credentials.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_membership_revocations(id, actor_credential_id,
            organization_id, membership_id, created_at) VALUES ('rev:m1','sess:a','org:1','acc:1',$1)`, [NOW + 30]);
    });
    assert.equal((await db.query(`SELECT revoked_at FROM memory_identity.memberships WHERE id='acc:1'`)).rows[0].revoked_at, NOW + 30);
});

test('child org creation enforces parent membership and cycle freedom', async t => {
    const { db, asOwner } = await createFixture(t);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a')`);
        await db.query(`INSERT INTO memory_control.organizations(id) VALUES ('org:p')`);
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('email:a','account:a','a@example.test','example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
            VALUES ('member:a','org:p','account:a','email:a','owner')`);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
            VALUES ('sess:a','account:a','session',$1,$2)`, [d(1), MAX]);
        await db.query(`INSERT INTO memory_identity.workspace_child_organization_creations(id,
            parent_organization_id, name, actor_credential_id, email_id, membership_id, space_id,
            data_policy, created_at)
            VALUES ('org:c','org:p','Child','sess:a','email:a','member:c','space:c',$1,$2)`,
            [JSON.stringify(SG_POLICY), NOW]);
    });
    assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.organization_hierarchy`)).rows[0].n, 1);
    // A cycle through the edge table alone is rejected by the command check.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.organization_hierarchy(organization_id, parent_organization_id)
            VALUES ('org:p','org:c')`);
    }), denied);
});

test('scim key issuance and deletion revoke memberships', async t => {
    const { db, asOwner } = await createFixture(t);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a'),('account:b')`);
        await db.query(`INSERT INTO memory_control.organizations(id) VALUES ('org:1')`);
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('email:a','account:a','a@example.test','example.test',$1),
                   ('email:b','account:b','b@example.test','example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
            VALUES ('member:a','org:1','account:a','email:a','owner'),('member:b','org:1','account:b','email:b','member')`);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at, reauthenticated_at, permission)
            VALUES ('sess:a','account:a','session',$1,$2,$3,'write')`, [d(1), MAX, NOW]);
        await db.query(`INSERT INTO memory_identity.scim_keys(id, organization_id, token_digest,
            creator_credential_id, expires_at, creator_membership_id, creator_email_id, created_at)
            VALUES ('scim:1','org:1',$1,'sess:a',$2,'member:a','email:a',$3)`, [d(2), NOW + 86400000, NOW]);
    });
    // A member cannot be deleted by an expired/revoked key; valid key deletes.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.scim_deletions(membership_id, scim_key_id, deleted_at)
            VALUES ('member:b','scim:1',$1)`, [NOW + 5]);
    });
    assert.equal((await db.query(`SELECT revoked_at FROM memory_identity.memberships WHERE id='member:b'`)).rows[0].revoked_at, NOW + 5);
});

test('external blocks and provider tombstones gate claims and challenges', async t => {
    const { db, asOwner } = await createFixture(t);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a')`);
        await db.query(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
            VALUES ('iss','sub','account:a',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_ops.provider_revocations(issuer, subject, kind, address, created_at_ms)
            VALUES ('iss','sub','email.revoked','bad@example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.external_email_blocks(account_id, address, created_at)
            VALUES ('account:a','ext@example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at, reauthenticated_at)
            VALUES ('sess:a','account:a','session',$1,$2,$3)`, [d(1), MAX, NOW]);
    });
    // Externally blocked claim raises.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('e:1','account:a','ext@example.test','example.test',$1)`, [NOW]);
    }), denied);
    // Provider-revoked address claim raises.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('e:2','account:a','bad@example.test','example.test',$1)`, [NOW]);
    }), denied);
    // A challenge for a blocked address is silently skipped (row absent).
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.email_challenges(id, account_id, address, domain, token_digest, expires_at)
            VALUES ('ch:b','account:a','ext@example.test','example.test',$1,$2)`, [d(3), MAX]);
    });
    assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.email_challenges`)).rows[0].n, 0);
});

import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const NOW = 1758000000000;
const MAX = 9007199254740991;
const d = n => n.toString(16).padStart(64, '0');
const POLICY = { policyVersion: 1, residency: 'sg', profile: 'standard', processingBoundary: 'approved-processors',
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
        '0007_workspace_regional.sql', '0008_regional_space.sql', '0009_payload_staging.sql',
        '0010_execution_time_guards.sql']) {
        await db.exec(await readFile(new URL(name, migrations), 'utf8'));
    }
    await db.exec(`RESET ROLE; ${restore}`);
    const asOwner = async fn => { await db.exec('SET ROLE memory_owner'); try { return await fn(db); } finally { await db.exec('ROLLBACK'); await db.exec('RESET ROLE'); } };
    await asOwner(() => db.query(`INSERT INTO memory_control.deployment_identity
        VALUES(1,'memory-sg','sg','standard-v1',1)`));
    return { db, asOwner };
}

const denied = e => ['55000', '23505', '23514', '23503', '42501'].includes(String(e?.code ?? ''));

test('installs as regional version 10 with corrected cursor shapes', async t => {
    const { db } = await createFixture(t);
    assert.equal((await db.query(`SELECT version FROM memory_control.schema_migrations ORDER BY version DESC LIMIT 1`)).rows[0].version, 10);
    assert.deepEqual((await db.query(`SELECT name FROM memory_ops.maintenance_progress ORDER BY name`)).rows,
        [{ name: 'source_erasure' }, { name: 'vector_resweep' }]);
    assert.deepEqual((await db.query(`SELECT kind, after_revision, generation FROM memory_ops.payload_backfill_progress ORDER BY kind`)).rows,
        [{ kind: 'current', after_revision: 0, generation: 0 }, { kind: 'history', after_revision: 0, generation: 0 }]);
    assert.ok((await db.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='memory_jobs' AND table_name='release_jobs' AND column_name='cleanup_only'`)).rows.length === 1);
    assert.ok((await db.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='memory_identity' AND table_name='workspace_sign_ins' AND column_name='issued_at'`)).rows.length === 1);
});

test('applied lifecycle suspension denies sign-in, credential mint, claim and challenge', async t => {
    const { db, asOwner } = await createFixture(t);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a')`);
        await db.query(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
            VALUES ('iss','sub','account:a',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_ops.lifecycle_applied_state(issuer, subject, address, sequence, kind, occurred_at_ms, event_id)
            VALUES ('iss','sub','',3,'account.suspended',$1,'ev:1')`, [NOW]);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_sign_ins(id, issuer, subject, new_account_id,
            credential_id, token_digest, expires_at, permission, email_id, personal_space_id, data_policy, created_at)
            VALUES ('sign:1','iss','sub','account:b','sess:1',$1,$2,'write','email:1','space:1',$3,$4)`,
            [d(1), Date.now() + 60000, JSON.stringify(POLICY), NOW]);
    }), denied);
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
            VALUES ('sess:x','account:a','session',$1,$2)`, [d(2), MAX]);
    }), denied);
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('e:1','account:a','a@example.test','example.test',$1)`, [NOW]);
    }), denied);
    // Challenges are silently skipped — the row never appears.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.email_challenges(id, account_id, address, domain, token_digest, expires_at)
            VALUES ('ch:1','account:a','a@example.test','example.test',$1,$2)`, [d(3), MAX]);
    });
    assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.email_challenges`)).rows[0].n, 0);
    // account.resumed lifts the suspension.
    await asOwner(async () => {
        await db.query(`UPDATE memory_ops.lifecycle_applied_state SET sequence=4, kind='account.resumed',
            occurred_at_ms=$1, event_id='ev:2' WHERE issuer='iss'`, [NOW + 1]);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
            VALUES ('sess:x','account:a','session',$1,$2)`, [d(2), MAX]);
    });
    assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.credentials`)).rows[0].n, 1);
});

test('reauth consumption validates the live session then stamps reauthenticated_at', async t => {
    const { db, asOwner } = await createFixture(t);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a')`);
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('e:1','account:a','a@example.test','example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at, permission)
            VALUES ('sess:a','account:a','session',$1,$2,'write')`, [d(1), MAX]);
        await db.query(`INSERT INTO memory_identity.reauth_challenges(id, credential_id, email_id, token_digest, expires_at)
            VALUES ('rc:1','sess:a','e:1',$1,$2)`, [d(2), MAX]);
    });
    // Consumption by a session other than the bound credential is denied.
    await asOwner(async () => {
        await db.query(`UPDATE memory_identity.reauth_challenges SET used_at=$1 WHERE id='rc:1'`, [NOW + 10]);
    });
    assert.equal((await db.query(`SELECT reauthenticated_at FROM memory_identity.credentials WHERE id='sess:a'`)).rows[0].reauthenticated_at, NOW + 10);
});

test('SCIM keys are revoked when the creating membership is revoked', async t => {
    const { db, asOwner } = await createFixture(t);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a'),('account:b')`);
        await db.query(`INSERT INTO memory_control.organizations(id) VALUES ('org:1')`);
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('e:a','account:a','a@example.test','example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
            VALUES ('m:a','org:1','account:a','e:a','owner')`);
        const live = Date.now();
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at, reauthenticated_at, permission)
            VALUES ('sess:a','account:a','session',$1,$2,$3,'write')`, [d(1), MAX, live]);
        await db.query(`INSERT INTO memory_identity.scim_keys(id, organization_id, token_digest,
            creator_credential_id, expires_at, creator_membership_id, creator_email_id, created_at)
            VALUES ('scim:1','org:1',$1,'sess:a',$2,'m:a','e:a',$3)`, [d(2), live + 86400000, live]);
        await db.query(`UPDATE memory_identity.memberships SET revoked_at=$1 WHERE id='m:a'`, [NOW + 5]);
    });
    assert.equal((await db.query(`SELECT revoked_at FROM memory_identity.scim_keys WHERE id='scim:1'`)).rows[0].revoked_at, NOW + 5);
});

test('execution-time evaluation denies credentials already expired at the wall clock', async t => {
    const { db, asOwner } = await createFixture(t);
    const past = Date.now() - 120000;
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a')`);
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('e:a','account:a','a@example.test','example.test',$1)`, [past]);
        // Backdated row: created long ago, session already expired at the wall
        // clock even though expires_at > recorded created_at.
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
            VALUES ('sess:old','account:a','session',$1,$2)`, [d(1), past + 60000]);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.workspace_organization_creations(id, name,
            actor_credential_id, email_id, membership_id, space_id, data_policy, created_at)
            VALUES ('org:1','Acme','sess:old','e:a','m:1','space:1',$1,$2)`,
            [JSON.stringify(POLICY), past]);
    }), denied);
});

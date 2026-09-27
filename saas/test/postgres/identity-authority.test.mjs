import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const NOW = 1758000000000;
const MAX = 9007199254740991;
const DIGEST = 'a'.repeat(64);

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
        '0004_seoul_pat_archive.sql', '0005_seoul_archive_lifecycle.sql', '0006_identity_authority.sql']) {
        await db.exec(await readFile(new URL(name, migrations), 'utf8'));
    }
    await db.exec(`RESET ROLE; ${restore};
        CREATE ROLE memory_probe LOGIN INHERIT;
        GRANT memory_runtime TO memory_probe WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;`);
    const asOwner = async fn => { await db.exec('SET ROLE memory_owner'); try { return await fn(db); } finally { await db.exec('ROLLBACK'); await db.exec('RESET ROLE'); } };
    const asRuntime = async fn => { await db.exec('SET SESSION AUTHORIZATION memory_probe'); try { return await fn(db); } finally { await db.exec('ROLLBACK'); await db.exec(restore); } };
    // Minimal live identity: account + verified email + owner membership + session credential.
    const seedIdentity = () => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a'),('account:b')`);
        await db.query(`INSERT INTO memory_control.organizations(id) VALUES ('org:a')`);
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('email:a','account:a','a@example.test','example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
            VALUES ('member:a','org:a','account:a','email:a','owner')`);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at, reauthenticated_at)
            VALUES ('sess:a','account:a','session',$1,$2,$3)`, [DIGEST, MAX, NOW]);
    });
    return { db, asOwner, asRuntime, seedIdentity };
}

const denied = e => String(e?.code ?? '') === '42501' || /permission denied/.test(String(e?.message ?? e));
const rejected = e => ['55000', '23505', '23514', '23503', '23502'].includes(String(e?.code ?? ''))
    || /violates|duplicate key/.test(String(e?.message ?? e));

test('installs as regional version 6 after the foundation lineage', async t => {
    const { db } = await createFixture(t);
    const rows = (await db.query('SELECT version, name FROM memory_control.schema_migrations ORDER BY version')).rows;
    assert.equal(rows.at(-1).version, 6);
    assert.equal(rows.at(-1).name, '0006_identity_authority.sql');
});

test('runtime has no access to identity authority tables', async t => {
    const { db, asRuntime, seedIdentity } = await createFixture(t);
    await seedIdentity();
    for (const table of ['memory_identity.domains', 'memory_identity.email_challenges',
        'memory_identity.revocations', 'memory_identity.email_blocks',
        'memory_ops.identity_audit_events', 'memory_ops.lifecycle_applied_state']) {
        await assert.rejects(() => asRuntime(() => db.query(`SELECT * FROM ${table}`)), denied);
    }
});

test('domains: one live owner per name, immutable binding, live-claim membership guard', async t => {
    const { db, asOwner, seedIdentity } = await createFixture(t);
    await seedIdentity();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.domains(id, organization_id, name, verified_until)
            VALUES ('domain:a','org:a','example.test',$1)`, [MAX]);
        await db.query(`INSERT INTO memory_identity.domain_managers(domain_id, membership_id)
            VALUES ('domain:a','member:a')`);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.domains(id, organization_id, name, verified_until)
            VALUES ('domain:dup','org:a','example.test',$1)`, [MAX]);
    }), rejected);
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_identity.domains SET name='other.test' WHERE id='domain:a'`);
    }), rejected);
    // Plain member cannot be delegated domain management.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('email:b','account:b','b@example.test','example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
            VALUES ('member:b','org:a','account:b','email:b','member')`);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.domain_managers(domain_id, membership_id)
            VALUES ('domain:a','member:b')`);
    }), rejected);
});

test('email challenge → consumption issues the claim, uses the challenge, audits', async t => {
    const { db, asOwner, seedIdentity } = await createFixture(t);
    await seedIdentity();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.email_challenges(id, account_id, address, domain, token_digest, expires_at)
            VALUES ('ch:1','account:a','new@example.test','example.test',$1,$2)`, ['b'.repeat(64), MAX]);
    });
    // Without a recent session reauthentication the consumption is denied.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.email_consumptions(id, challenge_id, actor_credential_id, created_at)
            VALUES ('cons:1','ch:1','sess:a',$1)`, [NOW + 400000]);
    }), rejected);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.email_consumptions(id, challenge_id, actor_credential_id, created_at)
            VALUES ('cons:1','ch:1','sess:a',$1)`, [NOW + 1000]);
    });
    const claim = (await db.query(`SELECT account_id, address FROM memory_identity.account_emails WHERE id='cons:1'`)).rows;
    assert.deepEqual(claim, [{ account_id: 'account:a', address: 'new@example.test' }]);
    const challenge = (await db.query(`SELECT used_at FROM memory_identity.email_challenges WHERE id='ch:1'`)).rows[0];
    assert.equal(challenge.used_at, NOW + 1000);
    const audit = (await db.query(`SELECT event_type, account_id, email_id FROM memory_ops.identity_audit_events`)).rows;
    assert.deepEqual(audit, [{ event_type: 'email_verified', account_id: 'account:a', email_id: 'cons:1' }]);
    // The same challenge cannot be consumed twice.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.email_consumptions(id, challenge_id, actor_credential_id, created_at)
            VALUES ('cons:2','ch:1','sess:a',$1)`, [NOW + 2000]);
    }), rejected);
});

test('self revocation cascades to memberships, credentials and challenges', async t => {
    const { db, asOwner, seedIdentity } = await createFixture(t);
    await seedIdentity();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, membership_id, email_id, kind, token_digest, expires_at)
            VALUES ('key:a','account:a','member:a','email:a','api_key',$1,$2)`, ['c'.repeat(64), MAX]);
        await db.query(`INSERT INTO memory_identity.email_challenges(id, account_id, address, domain, token_digest, expires_at)
            VALUES ('ch:x','account:a','a@example.test','example.test',$1,$2)`, ['d'.repeat(64), MAX]);
    });
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.revocations(id, kind, actor_credential_id, email_id, created_at)
            VALUES ('rev:1','self','sess:a','email:a',$1)`, [NOW + 10]);
    });
    const email = (await db.query(`SELECT revoked_at FROM memory_identity.account_emails WHERE id='email:a'`)).rows[0];
    assert.equal(email.revoked_at, NOW + 10);
    const membership = (await db.query(`SELECT revoked_at FROM memory_identity.memberships WHERE id='member:a'`)).rows[0];
    assert.equal(membership.revoked_at, NOW + 10);
    const key = (await db.query(`SELECT revoked_at FROM memory_identity.credentials WHERE id='key:a'`)).rows[0];
    assert.equal(key.revoked_at, NOW + 10);
    const challenge = (await db.query(`SELECT invalidated_at FROM memory_identity.email_challenges WHERE id='ch:x'`)).rows[0];
    assert.equal(challenge.invalidated_at, NOW + 10);
    const events = (await db.query(`SELECT event_type FROM memory_ops.identity_audit_events`)).rows;
    assert.deepEqual(events.map(r => r.event_type).sort(),
        ['credential_revoked', 'email_revoked', 'membership_revoked', 'self_revocation'].sort());
});

test('domain revocation blocks the address and revokes matching claims', async t => {
    const { db, asOwner, seedIdentity } = await createFixture(t);
    await seedIdentity();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.domains(id, organization_id, name, verified_until)
            VALUES ('domain:a','org:a','corp.example',$1)`, [MAX]);
        await db.query(`INSERT INTO memory_identity.domain_managers(domain_id, membership_id)
            VALUES ('domain:a','member:a')`);
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('email:v','account:b','victim@corp.example','corp.example',$1)`, [NOW]);
    });
    // A non-manager session cannot revoke the domain's addresses.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at, reauthenticated_at)
            VALUES ('sess:b','account:b','session',$1,$2,$3)`, ['e'.repeat(64), MAX, NOW]);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.revocations(id, kind, actor_credential_id, domain_id, address, created_at)
            VALUES ('rev:d','domain','sess:b','domain:a','victim@corp.example',$1)`, [NOW + 5]);
    }), rejected);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.revocations(id, kind, actor_credential_id, domain_id, address, created_at)
            VALUES ('rev:d','domain','sess:a','domain:a','victim@corp.example',$1)`, [NOW + 5]);
    });
    const block = (await db.query(`SELECT domain_id, revocation_id FROM memory_identity.email_blocks WHERE address='victim@corp.example'`)).rows;
    assert.deepEqual(block, [{ domain_id: 'domain:a', revocation_id: 'rev:d' }]);
    const email = (await db.query(`SELECT revoked_at FROM memory_identity.account_emails WHERE id='email:v'`)).rows[0];
    assert.equal(email.revoked_at, NOW + 5);
    // Blocked address cannot receive a new challenge.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.email_challenges(id, account_id, address, domain, token_digest, expires_at)
            VALUES ('ch:blocked','account:a','victim@corp.example','corp.example',$1,$2)`, ['f'.repeat(64), MAX]);
    }), rejected);
});

test('active_credentials hides suspended accounts via applied lifecycle state', async t => {
    const { db, asOwner, seedIdentity } = await createFixture(t);
    await seedIdentity();
    let rows = (await db.query(`SELECT id FROM memory_identity.active_credentials`)).rows;
    assert.deepEqual(rows, [{ id: 'sess:a' }]);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
            VALUES ('iss','sub','account:a',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_ops.lifecycle_applied_state(issuer, subject, address, sequence, kind, occurred_at_ms, event_id)
            VALUES ('iss','sub','',1,'account.suspended',$1,'evt:1')`, [NOW]);
    });
    rows = (await db.query(`SELECT id FROM memory_identity.active_credentials`)).rows;
    assert.deepEqual(rows, []);
    // A resume clears the suspension.
    await asOwner(async () => {
        await db.query(`UPDATE memory_ops.lifecycle_applied_state SET sequence=2, kind='account.resumed', occurred_at_ms=$1, event_id='evt:2'
            WHERE issuer='iss' AND subject='sub' AND address=''`, [NOW + 1]);
    });
    rows = (await db.query(`SELECT id FROM memory_identity.active_credentials`)).rows;
    assert.deepEqual(rows, [{ id: 'sess:a' }]);
});

test('append-only and boundary triggers hold on the ledger tables', async t => {
    const { db, asOwner, seedIdentity } = await createFixture(t);
    await seedIdentity();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.email_challenges(id, account_id, address, domain, token_digest, expires_at)
            VALUES ('ch:1','account:a','n@example.test','example.test',$1,$2)`, ['b'.repeat(64), MAX]);
        await db.query(`INSERT INTO memory_identity.email_consumptions(id, challenge_id, actor_credential_id, created_at)
            VALUES ('cons:1','ch:1','sess:a',$1)`, [NOW + 1]);
        await db.query(`INSERT INTO memory_identity.revocations(id, kind, actor_credential_id, email_id, created_at)
            VALUES ('rev:1','self','sess:a','email:a',$1)`, [NOW + 2]);
    });
    for (const [table, key] of [['email_consumptions', 'cons:1'], ['revocations', 'rev:1'], ['email_challenges', 'ch:1']]) {
        await assert.rejects(() => asOwner(async () => {
            await db.query(`DELETE FROM memory_identity.${table} WHERE id='${key}'`);
        }), rejected);
    }
    await assert.rejects(() => asOwner(async () => {
        await db.query(`DELETE FROM memory_ops.identity_audit_events`);
    }), rejected);
});

// Real-role runtime access tests. Every serving statement runs under
// SET SESSION AUTHORIZATION memory_runtime so forced RLS and grants are
// evaluated exactly as the production serving role sees them — no
// superuser/table-owner masking.
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const NOW = 1758000000000;
const MAX = 9007199254740991;
const d = n => n.toString(16).padStart(64, '0');
const SG_POLICY = { policyVersion: 1, residency: 'sg', profile: 'standard', processingBoundary: 'approved-processors',
    dataClass: 'general', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 };

const REGIONAL = ['migrations/0001_private_namespaces.sql', 'migrations/0002_deployment_identity.sql',
    'migrations/0003_identity_foundation.sql', 'migrations/0004_seoul_pat_archive.sql',
    'migrations/0005_seoul_archive_lifecycle.sql', 'migrations/0006_identity_authority.sql',
    'migrations/0007_workspace_regional.sql', 'migrations/0008_regional_space.sql',
    'migrations/0009_payload_staging.sql', 'migrations/0010_execution_time_guards.sql',
    'migrations/0011_deferred_shares.sql', 'migrations/0012_scim_key_freeze.sql',
    'migrations/0013_retrieval_progress.sql', 'migrations/0014_runtime_access.sql'];
const CONTROL = ['migrations/0001_private_namespaces.sql', 'migrations/0002_deployment_identity.sql',
    'control/0003_placement_directory.sql', 'control/0004_billing_catalog.sql',
    'control/0005_checkout_attempt_freeze.sql', 'control/0006_runtime_access.sql'];

async function createFixture(t, names) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const initial = (await db.query('SELECT current_database() AS name,current_user AS role')).rows[0];
    const restore = 'SET SESSION AUTHORIZATION "' + initial.role.replaceAll('"', '""') + '"';
    await db.exec('CREATE ROLE fixture_provisioner LOGIN CREATEROLE');
    if (initial.name === 'template1' || initial.name === 'postgres') {
        await db.exec('GRANT "' + initial.role.replaceAll('"', '""') + '" TO fixture_provisioner WITH SET FALSE, INHERIT TRUE, ADMIN FALSE');
    } else {
        await db.exec(`GRANT CREATE ON DATABASE "${initial.name.replaceAll('"', '""')}" TO fixture_provisioner`);
    }
    await db.exec(`GRANT pg_read_all_data TO fixture_provisioner;
        SET SESSION AUTHORIZATION fixture_provisioner;
        SET createrole_self_grant='set, inherit';`);
    // API-facing roles exist before migration, matching the managed install.
    for (const role of ['anon', 'authenticated'])
        if (!(await db.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [role])).rows.length)
            await db.query(`CREATE ROLE ${role} NOLOGIN`);
    const migrations = new URL('../../postgres/', import.meta.url);
    for (const name of names) await db.exec(await readFile(new URL(name, migrations), 'utf8'));
    await db.exec(restore);
    const asOwner = async fn => { await db.exec('SET SESSION AUTHORIZATION memory_owner'); try { return await fn(db); } finally { await db.exec(restore); } };
    const asRuntime = async fn => { await db.exec('SET SESSION AUTHORIZATION memory_runtime'); try { return await fn(db); } finally { await db.exec(restore); } };
    return { db, asOwner, asRuntime };
}

const createRegion = t => createFixture(t, REGIONAL);
const createControl = t => createFixture(t, CONTROL);

const denied = e => /42501|55000|23503/.test(String(e?.code ?? ''))
    || /permission denied|denied|immutable|rejected|unavailable|receipt/i.test(String(e?.message ?? e));
const rejects = (fn, why) => assert.rejects(fn, denied, why);

// Standard two-account org seed. Runs as owner: these rows are authority
// data, not runtime traffic.
async function seedOrg(db, asOwner) {
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_control.deployment_identity
            VALUES(1,'memory-sg','sg','standard-v1',1)`);
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a'),('account:b')`);
        await db.query(`INSERT INTO memory_control.organizations(id) VALUES ('org:1')`);
        await db.query(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ('email:a','account:a','a@example.test','example.test',$1),
                   ('email:b','account:b','b@example.test','example.test',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
            VALUES ('member:a','org:1','account:a','email:a','owner'),
                   ('member:b','org:1','account:b','email:b','admin')`);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest,
            expires_at, reauthenticated_at, permission)
            VALUES ('sess:a','account:a','session',$1,$2,$3,'write'),
                   ('sess:b','account:b','session',$4,$2,$3,'write')`, [d(1), MAX, NOW, d(2)]);
    });
}

async function seedSpace(db, asOwner) {
    await asOwner(() => db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, name,
        security_mode, deployment_id, data_policy, source_byte_limit, message_limit, created_at_ms)
        VALUES ('space:1','account:a','Personal','managed','memory-sg',$1,67108864,100000,$2)`,
        [JSON.stringify(SG_POLICY), NOW]));
}

test('regional runtime reads owner views but cannot touch authority tables', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    await asRuntime(async () => {
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.runtime_accounts`)).rows[0].n, 2);
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.runtime_memberships`)).rows[0].n, 2);
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.runtime_credentials`)).rows[0].n, 2);
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.runtime_account_emails`)).rows[0].n, 2);
        await rejects(() => db.query(`SELECT count(*) FROM memory_identity.accounts`), 'accounts readable');
        await rejects(() => db.query(`SELECT count(*) FROM memory_identity.account_emails`), 'emails readable');
        await rejects(() => db.query(`SELECT count(*) FROM memory_identity.credentials`), 'credentials readable');
        await rejects(() => db.query(`SELECT count(*) FROM memory_identity.memberships`), 'memberships readable');
        await rejects(() => db.query(`SELECT count(*) FROM memory_identity.provider_identities`), 'identities readable');
        await rejects(() => db.query(`UPDATE memory_identity.memberships SET revoked_at=1 WHERE id='member:b'`), 'membership writable');
        await rejects(() => db.query(`INSERT INTO memory_identity.accounts(id) VALUES('x')`), 'account writable');
        await rejects(() => db.query(`UPDATE memory_identity.credentials SET revoked_at=1 WHERE id='sess:b'`), 'credential writable');
        await rejects(() => db.query(`SELECT count(*) FROM memory_control.organizations`), 'org directory readable');
    });
});

test('runtime command records mint authority owner-side', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await asOwner(() => db.query(`INSERT INTO memory_control.deployment_identity
        VALUES(1,'memory-sg','sg','standard-v1',1)`));
    // Sign-in record: the validator reads authority tables owner-side and the
    // apply mints account/email/credential/space — all under the runtime role.
    await asRuntime(() => db.query(`INSERT INTO memory_identity.workspace_sign_ins(id, issuer, subject,
        new_account_id, credential_id, token_digest, expires_at, permission, email_id, address, domain,
        personal_space_id, data_policy, created_at)
        VALUES ('sign:1','https://iss.example','sub-1','account:1','sess:1',$1,$2,'write',
            'email:1','a@example.test','example.test','space:1',$3,$4)`,
        [d(1), Date.now() + 600000, JSON.stringify(SG_POLICY), Date.now()]));
    await asRuntime(async () => {
        assert.equal((await db.query(`SELECT id FROM memory_identity.runtime_accounts WHERE id='account:1'`)).rows.length, 1);
        assert.deepEqual((await db.query(`SELECT kind, permission FROM memory_identity.active_credentials WHERE id='sess:1'`)).rows,
            [{ kind: 'session', permission: 'write' }]);
        assert.equal((await db.query(`SELECT security_mode FROM memory_control.spaces WHERE id='space:1'`)).rows[0].security_mode, 'managed');
        await rejects(() => db.query(`UPDATE memory_identity.workspace_sign_ins SET subject='other' WHERE id='sign:1'`), 'sign-in record mutable');
    });
});

test('revoke_session revokes only the digest-matched credential', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    await asRuntime(async () => {
        await db.query(`SELECT memory_identity.revoke_session($1,$2)`, [d(9), NOW + 10]);
        assert.equal((await db.query(`SELECT revoked_at FROM memory_identity.runtime_credentials WHERE id='sess:a'`)).rows[0].revoked_at, null);
        await db.query(`SELECT memory_identity.revoke_session($1,$2)`, [d(1), NOW + 10]);
        assert.equal((await db.query(`SELECT revoked_at FROM memory_identity.runtime_credentials WHERE id='sess:a'`)).rows[0].revoked_at, NOW + 10);
    });
});

test('key issuance flows through workspace_key_issuances, not direct credential inserts', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    await asRuntime(async () => {
        await rejects(() => db.query(`INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at)
            VALUES('key:direct','account:b','api_key',$1,$2)`, [d(5), MAX]), 'direct credential insert');
        await db.query(`INSERT INTO memory_identity.workspace_key_issuances(id, actor_credential_id,
            organization_id, label, permission, token_digest, created_at, expires_at)
            VALUES ('key:1','sess:b','org:1','ci','write',$1,$2,$3)`, [d(4), NOW, NOW + 86400000]);
        assert.deepEqual((await db.query(`SELECT kind, membership_id FROM memory_identity.runtime_credentials WHERE id='key:1'`)).rows,
            [{ kind: 'api_key', membership_id: 'member:b' }]);
        await db.query(`INSERT INTO memory_identity.workspace_key_revocations(id, actor_credential_id,
            credential_id, created_at) VALUES ('rev:k1','sess:a','key:1',$1)`, [NOW + 20]);
        assert.equal((await db.query(`SELECT revoked_at FROM memory_identity.runtime_credentials WHERE id='key:1'`)).rows[0].revoked_at, NOW + 20);
    });
});

test('scim deactivation runs the definer; deletion stays a command record', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    // The execution-time validator runs its reauthentication/expiry checks
    // against real now_ms(); seed at wall-clock time.
    const live = Date.now();
    await asOwner(async () => {
        await db.query(`UPDATE memory_identity.credentials SET reauthenticated_at=$1 WHERE id='sess:a'`, [live]);
        await db.query(`INSERT INTO memory_identity.scim_keys(id, organization_id, token_digest,
            creator_credential_id, expires_at, creator_membership_id, creator_email_id, created_at)
            VALUES ('scim:1','org:1',$1,'sess:a',$2,'member:a','email:a',$3)`, [d(7), live + 86400000, live]);
    });
    await asRuntime(async () => {
        // SCIM PATCH active:false — membership stays listed, revoked_at set.
        const rows = (await db.query(`SELECT id, "userName", active FROM memory_identity.scim_deactivate($1,$2,$3,$4)`,
            ['member:b', 'org:1', d(7), NOW + 5])).rows;
        assert.deepEqual(rows, [{ id: 'member:b', userName: 'b@example.test', active: 0 }]);
        assert.equal((await db.query(`SELECT revoked_at FROM memory_identity.runtime_memberships WHERE id='member:b'`)).rows[0].revoked_at, NOW + 5);
        // SCIM DELETE — the tombstone record path still applies.
        await db.query(`INSERT INTO memory_identity.scim_deletions(membership_id, scim_key_id, deleted_at)
            VALUES ('member:b','scim:1',$1)`, [live + 6]);
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.scim_deletions`)).rows[0].n, 1);
    });
});

test('provider revocation applies only with the webhook receipt', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    await asOwner(() => db.query(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
        VALUES ('iss','sub','account:a',$1)`, [NOW]));
    await asRuntime(async () => {
        // No receipt: the definer is inert.
        await db.query(`SELECT memory_ops.apply_provider_revocation('iss','sub','account.disabled','',$1,'e-no-receipt',$2)`,
            [NOW + 1, d(8)]);
        assert.equal((await db.query(`SELECT disabled_at FROM memory_identity.runtime_accounts WHERE id='account:a'`)).rows[0].disabled_at, null);
        // Receipt + tombstone + apply — mirroring the service batch order.
        await db.query(`INSERT INTO memory_ops.webhook_events(provider,event_id,body_hash,created_at)
            VALUES ('identity','e1',$1,$2)`, [d(8), NOW]);
        await db.query(`INSERT INTO memory_ops.provider_revocations(issuer,subject,kind,address,created_at_ms)
            SELECT 'iss','sub','account.disabled','',$1
            WHERE EXISTS(SELECT 1 FROM memory_ops.webhook_events WHERE provider='identity' AND event_id='e1')
            ON CONFLICT DO NOTHING`, [NOW + 2]);
        await db.query(`SELECT memory_ops.apply_provider_revocation('iss','sub','account.disabled','',$1,'e1',$2)`, [NOW + 2, d(8)]);
        assert.equal((await db.query(`SELECT disabled_at FROM memory_identity.runtime_accounts WHERE id='account:a'`)).rows[0].disabled_at, NOW + 2);
    });
});

test('reauth challenges allow consume and expired cleanup but freeze bindings', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    await asOwner(() => db.query(`INSERT INTO memory_identity.reauth_challenges(id, credential_id, email_id,
        token_digest, expires_at) VALUES ('re:1','sess:a','email:a',$1,$2),('re:2','sess:a','email:a',$1,$3)`,
        [d(3), Date.now() + 60000, NOW - 1]));
    await asRuntime(async () => {
        await db.query(`UPDATE memory_identity.reauth_challenges SET used_at=$1 WHERE id='re:1'`, [NOW + 1]);
        await rejects(() => db.query(`UPDATE memory_identity.reauth_challenges SET credential_id='sess:b' WHERE id='re:1'`), 'binding mutable');
        await rejects(() => db.query(`DELETE FROM memory_identity.reauth_challenges WHERE id='re:1'`), 'live consumed row deletable');
        await db.query(`DELETE FROM memory_identity.reauth_challenges WHERE id='re:2'`);
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.reauth_challenges`)).rows[0].n, 1);
    });
});

test('auth flows allow verifier erasure and expiry cleanup only', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await asOwner(async () => {
        const live = Date.now();
        await db.query(`INSERT INTO memory_identity.auth_flows(state_digest, browser_digest, verifier,
            issuer, client_id, redirect_uri, created_at, expires_at, consumed_at)
            VALUES ($1,$2,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','iss','cid','https://cb',$3,$4,$5)`,
            [d(1), d(2), live, live + 600000, live + 1]);
        await db.query(`INSERT INTO memory_identity.auth_flows(state_digest, browser_digest, verifier,
            issuer, client_id, redirect_uri, created_at, expires_at)
            VALUES ($1,$2,NULL,'iss','cid','https://cb',$3,$4)`,
            [d(3), d(2), NOW - 700000, NOW - 100000]);
    });
    await asRuntime(async () => {
        await db.query(`UPDATE memory_identity.auth_flows SET verifier=NULL WHERE state_digest=$1`, [d(1)]);
        await rejects(() => db.query(`DELETE FROM memory_identity.auth_flows WHERE state_digest=$1`, [d(1)]), 'live flow deletable');
        await db.query(`DELETE FROM memory_identity.auth_flows WHERE expires_at<=$1`, [NOW]);
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.auth_flows`)).rows[0].n, 1);
    });
});

test('domain verification applies through the deferred foreign key', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.domain_challenges(id, organization_id,
            actor_account_id, domain, proof, expires_at) VALUES ('ch:1','org:1','account:a','example.test','p1',$1)`,
            [Date.now() + 120000]);
        // The validator re-checks a fresh reauthentication against real time.
        await db.query(`UPDATE memory_identity.credentials SET reauthenticated_at=$1 WHERE id='sess:a'`, [Date.now()]);
    });
    // One transaction: the verification insert fires the apply that creates
    // the referenced domains row before commit — only valid under the
    // deferred foreign key.
    await db.exec('BEGIN');
    try {
        await db.exec('SET LOCAL ROLE memory_runtime');
        await db.query(`INSERT INTO memory_identity.domain_verifications(id, challenge_id, domain_id,
            actor_credential_id, membership_id, created_at, verified_until)
            VALUES ('dv:1','ch:1','dom:1','sess:a','member:a',$1,$2)`, [NOW, NOW + 2592000000]);
        await db.exec('COMMIT');
    } catch (e) { await db.exec('ROLLBACK'); throw e; }
    await asRuntime(async () => {
        assert.equal((await db.query(`SELECT name FROM memory_identity.domains WHERE id='dom:1'`)).rows[0].name, 'example.test');
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_identity.domain_managers WHERE domain_id='dom:1'`)).rows[0].n, 1);
    });
});

test('memory_versions delete requires an erasure permit', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    await seedSpace(db, asOwner);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at,
            updated_at, actor_credential_id) VALUES ('m:1','space:1','body',1,$1,$1,'sess:a')`, [NOW]);
        await db.query(`INSERT INTO memory_content.memory_versions(memory_id, space_id, body, revision,
            created_at, updated_at, actor_credential_id, archived_at)
            VALUES ('m:1','space:1','body',1,$1,$1,'sess:a',$1)`, [NOW]);
    });
    await asRuntime(async () => {
        await rejects(() => db.query(`DELETE FROM memory_content.memory_versions WHERE memory_id='m:1'`), 'version deleted without permit');
        await rejects(() => db.query(`UPDATE memory_content.memory_versions SET body='x' WHERE memory_id='m:1'`), 'version updatable');
        await db.query(`INSERT INTO memory_ops.erasure_permits(memory_id, actor_credential_id, created_at)
            VALUES ('m:1','sess:a',$1)`, [NOW]);
        await db.query(`DELETE FROM memory_content.memory_versions WHERE memory_id='m:1'`);
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_content.memory_versions`)).rows[0].n, 0);
        await db.query(`DELETE FROM memory_ops.erasure_permits WHERE memory_id='m:1'`);
    });
});

test('fts_rows rejects mutation even for owner writes', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    await seedSpace(db, asOwner);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at,
            updated_at, actor_credential_id) VALUES ('m:1','space:1','body',1,$1,$1,'sess:a')`, [NOW]);
        // The memories trigger materializes the fts row itself.
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_search.fts_rows WHERE memory_id='m:1'`)).rows[0].n, 1);
    });
    await asRuntime(() => rejects(() => db.query(`SELECT count(*) FROM memory_search.fts_rows`), 'fts readable'));
    await asOwner(async () => {
        await rejects(() => db.query(`UPDATE memory_search.fts_rows SET memory_id='m:2'`), 'fts mutable');
        await rejects(() => db.query(`DELETE FROM memory_search.fts_rows`), 'fts deletable');
    });
});

test('payload cleanup queues advance under runtime while evidence stays frozen', async t => {
    const { db, asOwner, asRuntime } = await createRegion(t);
    await seedOrg(db, asOwner);
    await seedSpace(db, asOwner);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.payload_intents(id, account_id, space_id, client_key,
            request_hash, action, item_count, reserved_bytes, created_at, expires_at)
            VALUES ('pi:1','account:a','space:1','ck','rh','put',1,100,$1,$2)`, [NOW, Date.now() + 60000]);
        await db.query(`INSERT INTO memory_content.payload_stages(id, intent_id, ordinal, memory_id,
            payload_shard_id, payload_object_key, payload_sha256, payload_bytes, logical_bytes, created_at)
            VALUES ('p:1','pi:1',0,'m:1','s1','k1',$1,10,10,$2)`, [d(4), NOW]);
        await db.query(`INSERT INTO memory_ops.payload_purges(payload_id, space_id, memory_id,
            payload_shard_id, payload_object_key, payload_sha256, payload_bytes, created_at, available_at)
            VALUES ('p:1','space:1','m:1','s1','k1',$1,10,$2,$2)`, [d(4), NOW - 1]);
    });
    await asRuntime(async () => {
        await db.query(`UPDATE memory_ops.payload_purges SET attempts=attempts+1,available_at=$1 WHERE payload_id='p:1'`, [NOW]);
        assert.equal((await db.query(`SELECT attempts FROM memory_ops.payload_purges WHERE payload_id='p:1'`)).rows[0].attempts, 1);
        await rejects(() => db.query(`UPDATE memory_ops.payload_purges SET payload_object_key='x' WHERE payload_id='p:1'`), 'evidence mutable');
    });
});

test('internal ledgers and seoul relations stay closed to runtime', async t => {
    const { asRuntime } = await createRegion(t);
    await asRuntime(async db => {
        for (const rel of ['memory_ops.usage_events', 'memory_ops.workspace_audit_events',
            'memory_ops.payload_stage_accounts', 'memory_content.archives', 'memory_content.archive_messages',
            'memory_ops.space_usage', 'memory_ops.meter_events', 'memory_ops.lifecycle_receipts',
            'memory_identity.pat_space_grants'])
            await rejects(() => db.query(`SELECT count(*) FROM ${rel}`), `${rel} readable`);
        await rejects(() => db.query(`SELECT memory_control.reject_mutation()`), 'owner trigger callable');
    });
});

test('anon and authenticated hold no runtime surface', async t => {
    const { db } = await createRegion(t);
    for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET SESSION AUTHORIZATION ${role}`);
        try {
            await rejects(() => db.query(`SELECT count(*) FROM memory_identity.runtime_accounts`), `${role} reads views`);
            await rejects(() => db.query(`SELECT count(*) FROM memory_control.spaces`), `${role} reads spaces`);
            await rejects(() => db.query(`SELECT memory_identity.revoke_session('x',1)`), `${role} calls definer`);
            await rejects(() => db.query(`SELECT count(*) FROM memory_ops.usage_counters`), `${role} reads counters`);
        } finally { await db.exec('RESET SESSION AUTHORIZATION'); }
    }
});

// --- Control plane -----------------------------------------------------------

test('control runtime reads the directory but writes only through commands', async t => {
    const { db, asOwner, asRuntime } = await createControl(t);
    await asOwner(() => db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',1)`));
    await asRuntime(async () => {
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_control.regions`)).rows[0].n, 1);
        await rejects(() => db.query(`INSERT INTO memory_control.regions(region,added_at_ms) VALUES('kr-seoul',1)`), 'region writable');
        await rejects(() => db.query(`INSERT INTO memory_control.accounts(id,created_at_ms) VALUES('a',1)`), 'account writable');
        await rejects(() => db.query(`INSERT INTO memory_control.account_enrollments(account_id,region,enrolled_at_ms) VALUES('a','sg',1)`), 'enrollment writable');
        await rejects(() => db.query(`SELECT count(*) FROM memory_ops.lifecycle_events`), 'journal readable');
        await rejects(() => db.query(`SELECT count(*) FROM memory_ops.lifecycle_state`), 'state readable');
        await rejects(() => db.query(`SELECT count(*) FROM memory_ops.provider_revocations`), 'revocations readable');
        await rejects(() => db.query(`SELECT count(*) FROM memory_ops.lifecycle_jwt_proofs`), 'proofs readable');
    });
});

test('enrollment commands bind the caller region and stay idempotent', async t => {
    const { db, asOwner, asRuntime } = await createControl(t);
    await asOwner(() => db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',1)`));
    await asRuntime(async () => {
        await rejects(() => db.query(`SELECT memory_control.enroll_account('account:1','sg',$1)`, [NOW]), 'enroll without claim');
        await db.query(`SELECT pg_catalog.set_config('memory.caller_region','sg',false)`);
        await rejects(() => db.query(`SELECT memory_control.enroll_account('account:1','kr-seoul',$1)`, [NOW]), 'cross-region enroll');
        await db.query(`SELECT memory_control.enroll_account('account:1','sg',$1)`, [NOW]);
        await db.query(`SELECT memory_control.enroll_account('account:1','sg',$1)`, [NOW + 1]);
        assert.equal((await db.query(`SELECT count(*)::int n FROM memory_control.account_enrollments`)).rows[0].n, 1);
        await db.query(`SELECT memory_control.enroll_organization('org:1','sg',$1)`, [NOW]);
        assert.equal((await db.query(`SELECT memory_control.remove_organization_enrollment('org:1','sg',$1) AS applied`, [NOW])).rows[0].applied, true);
        assert.equal((await db.query(`SELECT removed_at_ms FROM memory_control.organization_enrollments`)).rows[0].removed_at_ms, NOW);
    });
});

test('lifecycle journal is readable only through the bounded definer', async t => {
    const { db, asOwner, asRuntime } = await createControl(t);
    await asOwner(async () => {
        const at = NOW - 60000;
        await db.query(`INSERT INTO memory_ops.webhook_events(provider,event_id,body_hash,created_at_ms)
            VALUES ('identity','e1',$1,$2),('identity','e2',$3,$2)`, [d(1), at, d(2)]);
        // A live JWT proof substitutes the signature-freshness window.
        await db.query(`INSERT INTO memory_ops.lifecycle_jwt_proofs(event_id,body_hash,issued_at_ms,expires_at_ms)
            VALUES ('e1',$1,$2,$3),('e2',$4,$2,$3)`,
            [d(1), Math.floor(Date.now() / 1000) * 1000 - 60000, Math.floor(Date.now() / 1000) * 1000 + 60000, d(2)]);
        await db.query(`INSERT INTO memory_ops.lifecycle_events(id,issuer,subject,sequence,kind,address,
            occurred_at_ms,received_at_ms,signed_at_ms,body_hash)
            VALUES ('e1','iss','sub',1,'account.suspended','',$2,$2,$2,$1),
                   ('e2','iss','sub',2,'account.resumed','',$3,$3,$3,$4)`,
            [d(1), at, at + 1000, d(2)]);
    });
    await asRuntime(async () => {
        const rows = (await db.query(`SELECT id, sequence FROM memory_ops.lifecycle_events_after('iss',1,10)`)).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, 'e2');
        assert.equal(Number(rows[0].sequence), 2);
        await rejects(() => db.query(`INSERT INTO memory_ops.lifecycle_events(id,issuer,subject,sequence,kind,
            address,occurred_at_ms,received_at_ms,signed_at_ms,body_hash) VALUES('x','i','s',9,'account.suspended','',1,1,1,$1)`, [d(9)]), 'journal writable');
    });
});

test('control billing verbs are scoped to the catalog', async t => {
    const { db, asOwner, asRuntime } = await createControl(t);
    await asOwner(() => db.query(`INSERT INTO memory_control.pools(id) VALUES ('pool:1')`));
    await asRuntime(async () => {
        await db.query(`UPDATE memory_control.pools SET customer_id='cus_1' WHERE id='pool:1' AND customer_id IS NULL`);
        await db.query(`INSERT INTO memory_ops.billing_events(id, subscription_id, available_at, created_at)
            VALUES ('be:1','sub_1',$1,$1)`, [NOW]);
        await db.query(`UPDATE memory_ops.billing_events SET state='done' WHERE id='be:1'`);
        await db.query(`UPDATE memory_ops.billing_lock SET token='t1',expires_at=$1 WHERE id=1`, [NOW + 60000]);
        await db.query(`INSERT INTO memory_ops.webhook_events(provider,event_id,body_hash,created_at_ms)
            VALUES ('stripe','we:1',$1,$2)`, [d(5), NOW]);
        await rejects(() => db.query(`INSERT INTO memory_control.pools(id) VALUES('x')`), 'pool writable');
        await rejects(() => db.query(`DELETE FROM memory_control.pools WHERE id='pool:1'`), 'pool deletable');
        await rejects(() => db.query(`UPDATE memory_ops.checkout_closures SET state='x'`), 'closure mutable');
    });
});

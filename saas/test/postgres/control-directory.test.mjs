import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const NOW = 1758000000000; // fixed ms epoch inside the valid range
const POLICY = { policyVersion: 1, residency: 'sg', profile: 'standard', processingBoundary: 'approved-processors',
    dataClass: 'general', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 };

async function createControlFixture(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const initial = (await db.query("SELECT current_database() AS name,current_user AS role")).rows[0];
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
    await db.exec(await readFile(new URL('0001_private_namespaces.sql', migrations), 'utf8'));
    await db.exec(await readFile(new URL('0002_deployment_identity.sql', migrations), 'utf8'));
    await db.exec(await readFile(new URL('../../postgres/control/0003_placement_directory.sql', import.meta.url), 'utf8'));
    await db.exec(`RESET ROLE; ${restore};
        CREATE ROLE memory_control_runtime LOGIN INHERIT;
        GRANT memory_runtime TO memory_control_runtime WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;`);
    const asOwner = async fn => { await db.exec('SET ROLE memory_owner'); try { return await fn(db); } finally { await db.exec('ROLLBACK'); await db.exec('RESET ROLE'); } };
    const asRuntime = async fn => { await db.exec('SET SESSION AUTHORIZATION memory_control_runtime'); try { return await fn(db); } finally { await db.exec('ROLLBACK'); await db.exec(restore); } };
    const seed = () => asOwner(async () => {
        await db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',$1),('kr-seoul',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.deployments(deployment_id, region, processing_policy_id, added_at_ms)
            VALUES ('memory-sg','sg','standard-v1',$1),('memory-seoul','kr-seoul','kr-primary-storage-v1',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.accounts(id, created_at_ms) VALUES ('account:a',$1),('account:b',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.organizations(id, created_at_ms) VALUES ('org:a',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.provider_identities(issuer, subject, account_id, created_at_ms)
            VALUES ('https://issuer.example','sub-1','account:a',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.account_enrollments(account_id, region, enrolled_at_ms)
            VALUES ('account:a','sg',$1),('account:a','kr-seoul',$1),('account:b','sg',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.organization_enrollments(organization_id, region, enrolled_at_ms)
            VALUES ('org:a','kr-seoul',$1)`, [NOW]);
    });
    return { db, asOwner, asRuntime, seed };
}

test('foundation + control lineage installs with contiguous ledger', async t => {
    const { db } = await createControlFixture(t);
    const rows = (await db.query('SELECT version, name FROM memory_control.schema_migrations ORDER BY version')).rows;
    assert.deepEqual(rows, [
        { version: 1, name: '0001_private_namespaces.sql' },
        { version: 2, name: '0002_deployment_identity.sql' },
        { version: 3, name: '0003_placement_directory.sql' },
    ]);
});

test('runtime may read the directory but not the lifecycle journal', async t => {
    const { db, seed, asRuntime } = await createControlFixture(t);
    await seed();
    await asRuntime(async () => {
        const spaces = (await db.query('SELECT id FROM memory_control.spaces')).rows;
        assert.deepEqual(spaces, []);
        const enrollments = (await db.query('SELECT account_id, region FROM memory_control.account_enrollments ORDER BY 1,2')).rows;
        assert.equal(enrollments.length, 3);
    });
    await assert.rejects(() => asRuntime(async () => {
        await db.query('SELECT * FROM memory_ops.lifecycle_events');
    }), e => /permission denied|42501/.test(String(e?.message ?? e)));
    await assert.rejects(() => asRuntime(async () => {
        await db.query("INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('us-east',1)");
    }), e => /permission denied|row-level security|42501/.test(String(e?.message ?? e)));
});

test('regions and deployments are append-only with monotonic retirement', async t => {
    const { asOwner } = await createControlFixture(t);
    await asOwner(async db => {
        await db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.deployments(deployment_id, region, processing_policy_id, added_at_ms)
            VALUES ('d1','sg','standard-v1',$1)`, [NOW]);
    });
    await assert.rejects(() => asOwner(async db => {
        await db.query(`UPDATE memory_control.regions SET region='us-east' WHERE region='sg'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
    await assert.rejects(() => asOwner(async db => {
        await db.query(`UPDATE memory_control.deployments SET region='kr-seoul' WHERE deployment_id='d1'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
    await assert.rejects(() => asOwner(async db => {
        await db.query(`DELETE FROM memory_control.regions WHERE region='sg'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
    // Retire then attempt to un-retire.
    await asOwner(async db => {
        await db.query(`UPDATE memory_control.regions SET retired_at_ms=$1 WHERE region='sg'`, [NOW + 1]);
    });
    await assert.rejects(() => asOwner(async db => {
        await db.query(`UPDATE memory_control.regions SET retired_at_ms=NULL WHERE region='sg'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
    await assert.rejects(() => asOwner(async db => {
        // FK: deployments must reference an existing region.
        await db.query(`INSERT INTO memory_control.deployments(deployment_id, region, processing_policy_id, added_at_ms)
            VALUES ('d2','no-such-region','x',$1)`, [NOW]);
    }), e => /23503|violates foreign key/.test(String(e?.message ?? e)));
});

test('enrollment directory keeps one live row per (id, region) with terminal removal', async t => {
    const { asOwner, seed } = await createControlFixture(t);
    await seed();
    await assert.rejects(() => asOwner(async db => {
        await db.query(`INSERT INTO memory_control.account_enrollments(account_id, region, enrolled_at_ms)
            VALUES ('account:a','sg',$1)`, [NOW + 1]);
    }), e => /duplicate key|23505/.test(String(e?.message ?? e)));
    // Remove, then re-enroll as a fresh row.
    await asOwner(async db => {
        await db.query(`UPDATE memory_control.account_enrollments SET removed_at_ms=$1
            WHERE account_id='account:a' AND region='sg' AND removed_at_ms IS NULL`, [NOW + 2]);
        await db.query(`INSERT INTO memory_control.account_enrollments(account_id, region, enrolled_at_ms)
            VALUES ('account:a','sg',$1)`, [NOW + 3]);
    });
    // Removal cannot be cleared and identity columns cannot change.
    await assert.rejects(() => asOwner(async db => {
        await db.query(`UPDATE memory_control.account_enrollments SET removed_at_ms=NULL
            WHERE account_id='account:a' AND region='sg'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
    await assert.rejects(() => asOwner(async db => {
        await db.query(`UPDATE memory_control.account_enrollments SET region='kr-seoul'
            WHERE account_id='account:a' AND region='sg'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
    // Enrollments must reference real accounts and regions.
    await assert.rejects(() => asOwner(async db => {
        await db.query(`INSERT INTO memory_control.account_enrollments(account_id, region, enrolled_at_ms)
            VALUES ('account:ghost','sg',$1)`, [NOW]);
    }), e => /23503|foreign key/.test(String(e?.message ?? e)));
});

test('space placement skeleton enforces declared residency and epoch', async t => {
    const { db, asOwner, seed } = await createControlFixture(t);
    await seed();
    const insert = policy => asOwner(async () => {
        await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, home_region, data_policy, placement_epoch, created_at_ms)
            VALUES ($1,'account:a','sg',$2,$3,$4)`, ['space:x', JSON.stringify(policy), policy?.placementEpoch ?? 1, NOW]);
    });
    // Missing key, residency≠home_region, epoch mismatch, null residency.
    await assert.rejects(() => insert({ ...POLICY, residency: undefined }), e => /23514|check/i.test(String(e?.message ?? e)));
    await assert.rejects(() => insert({ ...POLICY, residency: 'kr-seoul' }), e => /23514|check/i.test(String(e?.message ?? e)));
    // Column epoch disagrees with the policy's declared placementEpoch.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, home_region, data_policy, placement_epoch, created_at_ms)
            VALUES ('space:bad-epoch','account:a','sg',$1,1,$2)`, [JSON.stringify({ ...POLICY, placementEpoch: 9 }), NOW]);
    }), e => /23514|check/i.test(String(e?.message ?? e)));
    await assert.rejects(() => insert({ ...POLICY, residency: null }), e => /23514|check/i.test(String(e?.message ?? e)));
    // Both owners set / neither owner set rejected.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_control.spaces(id, home_region, data_policy, placement_epoch, created_at_ms)
            VALUES ('space:none','sg',$1,1,$2)`, [JSON.stringify(POLICY), NOW]);
    }), e => /23514|check/i.test(String(e?.message ?? e)));
    // Valid insert.
    await insert(POLICY);
});

test('space re-placement requires a strictly greater epoch; closed spaces freeze', async t => {
    const { db, asOwner, seed } = await createControlFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, home_region, data_policy, placement_epoch, created_at_ms)
            VALUES ('space:x','account:a','sg',$1,1,$2)`, [JSON.stringify(POLICY), NOW]);
    });
    // Region change without epoch bump rejected; epoch decrease rejected.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET home_region='kr-seoul',
            data_policy=$1 WHERE id='space:x'`,
            [JSON.stringify({ ...POLICY, residency: 'kr-seoul', profile: 'kr-primary-storage' })]);
    }), e => /memory_immutable_record|23514/.test(String(e?.message ?? e)));
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET placement_epoch=0 WHERE id='space:x'`);
    }), e => /memory_immutable_record|23514/.test(String(e?.message ?? e)));
    // Owner change rejected even with an epoch bump.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET owner_account_id='account:b', placement_epoch=2 WHERE id='space:x'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
    // Valid re-placement: epoch bump + matching policy.
    await asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET home_region='kr-seoul', placement_epoch=2,
            data_policy=$1 WHERE id='space:x'`,
            [JSON.stringify({ ...POLICY, residency: 'kr-seoul', profile: 'kr-primary-storage', placementEpoch: 2 })]);
        const row = (await db.query(`SELECT home_region, placement_epoch FROM memory_control.spaces WHERE id='space:x'`)).rows[0];
        assert.deepEqual(row, { home_region: 'kr-seoul', placement_epoch: 2 });
    });
    // Close, then everything is frozen.
    await asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET closed_at_ms=$1 WHERE id='space:x'`, [NOW + 5]);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET home_region='sg', placement_epoch=3,
            data_policy=$1 WHERE id='space:x'`, [JSON.stringify(POLICY)]);
    }), e => /memory_immutable_record|23514/.test(String(e?.message ?? e)));
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET closed_at_ms=NULL WHERE id='space:x'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
});

test('provider identity binding is immutable; unlink is terminal', async t => {
    const { asOwner, seed } = await createControlFixture(t);
    await seed();
    await assert.rejects(() => asOwner(async db => {
        await db.query(`UPDATE memory_control.provider_identities SET account_id='account:b'
            WHERE issuer='https://issuer.example' AND subject='sub-1'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
    await asOwner(async db => {
        await db.query(`UPDATE memory_control.provider_identities SET unlinked_at_ms=$1
            WHERE issuer='https://issuer.example' AND subject='sub-1'`, [NOW + 1]);
    });
    await assert.rejects(() => asOwner(async db => {
        await db.query(`UPDATE memory_control.provider_identities SET unlinked_at_ms=NULL
            WHERE issuer='https://issuer.example' AND subject='sub-1'`);
    }), e => String(e?.message ?? e).includes('memory_immutable_record'));
});

test('lifecycle journal requires a webhook receipt and applies ordered state', async t => {
    const { db, asOwner } = await createControlFixture(t);
    const hash = 'a'.repeat(64);
    const now = Date.now(); // signature freshness is checked against the DB clock
    // No receipt -> rejected.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_ops.lifecycle_events
            (id, issuer, subject, sequence, kind, address, occurred_at_ms, received_at_ms, signed_at_ms, body_hash)
            VALUES ('evt:1','iss','sub',1,'account.suspended','',$1,$1,$1,$2)`, [now, hash]);
    }), e => String(e?.message ?? e).includes('identity_lifecycle_receipt_missing'));
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_ops.webhook_events(provider, event_id, body_hash, created_at_ms)
            VALUES ('identity','evt:1',$1,$2)`, [hash, now]);
        await db.query(`INSERT INTO memory_ops.lifecycle_events
            (id, issuer, subject, sequence, kind, address, occurred_at_ms, received_at_ms, signed_at_ms, body_hash)
            VALUES ('evt:1','iss','sub',2,'account.suspended','',$1,$1,$1,$2)`, [now, hash]);
    });
    const state = (await db.query(`SELECT kind, sequence FROM memory_ops.lifecycle_state WHERE issuer='iss' AND subject='sub'`)).rows;
    assert.deepEqual(state, [{ kind: 'account.suspended', sequence: 2 }]);
    // Older sequence cannot regress state.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_ops.webhook_events(provider, event_id, body_hash, created_at_ms)
            VALUES ('identity','evt:0',$1,$2)`, [hash, now]);
        await db.query(`INSERT INTO memory_ops.lifecycle_events
            (id, issuer, subject, sequence, kind, address, occurred_at_ms, received_at_ms, signed_at_ms, body_hash)
            VALUES ('evt:0','iss','sub',1,'account.resumed','',$1,$1,$1,$2)`, [now, hash]);
    });
    const still = (await db.query(`SELECT kind, sequence FROM memory_ops.lifecycle_state WHERE issuer='iss' AND subject='sub'`)).rows;
    assert.deepEqual(still, [{ kind: 'account.suspended', sequence: 2 }]);
});

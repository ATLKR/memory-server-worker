import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const NOW = 1758000000000;
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
    await db.exec(await readFile(new URL('../../postgres/control/0004_billing_catalog.sql', import.meta.url), 'utf8'));
    await db.exec(`RESET ROLE; ${restore}`);
    const asOwner = async fn => { await db.exec('SET ROLE memory_owner'); try { return await fn(db); } finally { await db.exec('ROLLBACK'); await db.exec('RESET ROLE'); } };
    return { db, asOwner };
}

test('installs as control version 4 with the billing catalog', async t => {
    const { db } = await createControlFixture(t);
    assert.equal((await db.query(`SELECT version FROM memory_control.schema_migrations ORDER BY version DESC LIMIT 1`)).rows[0].version, 4);
    const tables = (await db.query(`SELECT table_schema||'.'||table_name t FROM information_schema.tables
        WHERE table_name IN ('pools','checkout_requests','checkout_closures','billing_events','billing_lock','heartbeats','provider_budgets')
        ORDER BY 1`)).rows.map(r => r.t);
    assert.deepEqual(tables, ['memory_control.checkout_requests', 'memory_control.pools',
        'memory_ops.billing_events', 'memory_ops.billing_lock', 'memory_ops.checkout_closures',
        'memory_ops.heartbeats', 'memory_ops.provider_budgets']);
});

test('space placement creates the derived owner pool once', async t => {
    const { db, asOwner } = await createControlFixture(t);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.deployments(deployment_id, region, processing_policy_id, added_at_ms)
            VALUES ('memory-sg','sg','standard-v1',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.accounts(id, created_at_ms) VALUES ('account:a',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.account_enrollments(account_id, region, enrolled_at_ms)
            VALUES ('account:a','sg',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, home_region,
            data_policy, placement_epoch, created_at_ms)
            VALUES ('space:1','account:a','sg',$1,1,$2)`,
            [JSON.stringify(POLICY), NOW]);
        await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, home_region,
            data_policy, placement_epoch, created_at_ms)
            VALUES ('space:2','account:a','sg',$1,1,$2)`,
            [JSON.stringify(POLICY), NOW]);
    });
    assert.deepEqual((await db.query(`SELECT id, plan, monthly_units FROM memory_control.pools`)).rows,
        [{ id: 'account:account:a', plan: 'free', monthly_units: 1000 }]);
});

test('checkout request/closure records stay consistent and immutable', async t => {
    const { db, asOwner } = await createControlFixture(t);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_control.pools(id) VALUES ('account:account:a')`);
        await db.query(`INSERT INTO memory_control.checkout_requests(id, pool_id, price_id, created_at,
            operation_key, session_id, checkout_url, expires_at, checkout_attempted)
            VALUES ('req:1','account:account:a','price:pro',$1,'op:1','sess:1','https://checkout',$2,1)`, [NOW, NOW + 3600000]);
        await db.query(`INSERT INTO memory_ops.checkout_closures(request_id, session_id, state,
            actor_credential_id, checked_at) VALUES ('req:1','sess:1','expired','cred:x',$1)`, [NOW + 3700000]);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_ops.checkout_closures SET state='subscription_ended', subscription_id='sub:1'`);
    }), e => ['55000', '42501'].includes(String(e?.code ?? '')));
    await assert.rejects(() => asOwner(async () => {
        await db.query(`DELETE FROM memory_ops.checkout_closures`);
    }), e => ['55000', '42501'].includes(String(e?.code ?? '')));
    // The state/subscription consistency check holds.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_control.checkout_requests(id, pool_id, price_id, created_at)
            VALUES ('req:2','account:account:a','price:pro',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_ops.checkout_closures(request_id, session_id, state,
            actor_credential_id, checked_at) VALUES ('req:2','s','subscription_ended','c',$1)`, [NOW]);
    }), e => ['23514', '42501'].includes(String(e?.code ?? '')));
});

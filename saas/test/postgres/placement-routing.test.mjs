import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSession } from './pg-database-fixture.mjs';
import { createPostgresDatabase } from '../../src/postgres/database.ts';
import { resolveMemoryRoute } from '../../src/routing/placement.ts';

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
    await db.exec(`RESET ROLE; ${restore}`);
    const asOwner = async fn => { await db.exec('SET ROLE memory_owner'); try { return await fn(db); } finally { await db.exec('ROLLBACK'); await db.exec('RESET ROLE'); } };
    const seed = () => asOwner(async () => {
        await db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',$1),('kr-seoul',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.deployments(deployment_id, region, processing_policy_id, added_at_ms)
            VALUES ('memory-sg','sg','standard-v1',$1),('memory-seoul','kr-seoul','kr-primary-storage-v1',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.accounts(id, created_at_ms) VALUES ('account:a',$1)`, [NOW]);
        await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, home_region, data_policy, placement_epoch, created_at_ms)
            VALUES ('space:sg','account:a','sg',$1,1,$2)`, [JSON.stringify(POLICY), NOW]);
        await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, home_region, data_policy, placement_epoch, created_at_ms)
            VALUES ('space:seoul','account:a','kr-seoul',$1,1,$2)`,
            [JSON.stringify({ ...POLICY, residency: 'kr-seoul', profile: 'kr-primary-storage' }), NOW]);
    });
    return { db, asOwner, seed, directory: createPostgresDatabase(createPgliteSession(db)) };
}

test('resolveMemoryRoute returns the region and live deployment for a homed Space', async t => {
    const { directory, seed } = await createControlFixture(t);
    await seed();
    const route = await resolveMemoryRoute(directory, 'space:sg');
    assert.equal(route.kind, 'routed');
    if (route.kind !== 'routed') return;
    assert.equal(route.region, 'sg');
    assert.equal(route.deploymentId, 'memory-sg');
    assert.equal(route.processingPolicyId, 'standard-v1');
    assert.equal(route.placementEpoch, 1);
    assert.equal(route.dataPolicy.residency, 'sg');
    const seoul = await resolveMemoryRoute(directory, 'space:seoul');
    assert.equal(seoul.kind, 'routed');
    if (seoul.kind === 'routed') {
        assert.equal(seoul.region, 'kr-seoul');
        assert.equal(seoul.deploymentId, 'memory-seoul');
    }
});

test('unknown or malformed Space ids never route', async t => {
    const { directory, seed } = await createControlFixture(t);
    await seed();
    assert.equal((await resolveMemoryRoute(directory, 'space:missing')).kind, 'not_found');
    await assert.rejects(() => resolveMemoryRoute(directory, 'bad id!'));
});

test('closed Spaces and retired regions refuse to route', async t => {
    const { db, asOwner, directory, seed } = await createControlFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET closed_at_ms=$1 WHERE id='space:sg'`, [NOW + 1]);
    });
    assert.equal((await resolveMemoryRoute(directory, 'space:sg')).kind, 'closed');
    await asOwner(async () => {
        await db.query(`UPDATE memory_control.regions SET retired_at_ms=$1 WHERE region='kr-seoul'`, [NOW + 2]);
    });
    assert.equal((await resolveMemoryRoute(directory, 'space:seoul')).kind, 'unavailable');
});

test('zero or several live deployments fail closed', async t => {
    const { db, asOwner, directory, seed } = await createControlFixture(t);
    await seed();
    // Retire the only seoul deployment: no serving target remains.
    await asOwner(async () => {
        await db.query(`UPDATE memory_control.deployments SET retired_at_ms=$1 WHERE deployment_id='memory-seoul'`, [NOW + 1]);
    });
    assert.equal((await resolveMemoryRoute(directory, 'space:seoul')).kind, 'unavailable');
    // Two live deployments in one region is ambiguous; never guess a target.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_control.deployments(deployment_id, region, processing_policy_id, added_at_ms)
            VALUES ('memory-sg-2','sg','standard-v1',$1)`, [NOW + 1]);
    });
    assert.equal((await resolveMemoryRoute(directory, 'space:sg')).kind, 'unavailable');
});

test('re-placement to a bumped epoch resolves to the new region', async t => {
    const { db, asOwner, directory, seed } = await createControlFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET home_region='kr-seoul', placement_epoch=2, data_policy=$1
            WHERE id='space:sg'`,
            [JSON.stringify({ ...POLICY, residency: 'kr-seoul', profile: 'kr-primary-storage', placementEpoch: 2 })]);
    });
    const route = await resolveMemoryRoute(directory, 'space:sg');
    assert.equal(route.kind, 'routed');
    if (route.kind === 'routed') {
        assert.equal(route.region, 'kr-seoul');
        assert.equal(route.placementEpoch, 2);
        assert.equal(route.dataPolicy.placementEpoch, 2);
    }
});

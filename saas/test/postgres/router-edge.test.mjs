import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createRoutingWorkerApp } from '../../src/routing/router.ts';

const NOW = 1758000000000;
const POLICY = { policyVersion: 1, residency: 'sg', profile: 'standard', processingBoundary: 'approved-processors',
    dataClass: 'general', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 };
const CONTROL = { region: 'sg', processingPolicyId: 'standard-v1', schemaVersion: 3, prefix: 'MEMORY_CONTROL', hyperdriveBinding: 'CONTROL_HYPERDRIVE' };
const TARGET = JSON.stringify({ connectionMode: 'direct', database: 'postgres', deploymentId: 'memory-ctl-0001',
    expectedRole: 'memory_runtime', host: 'ep-test.ap-southeast-1.aws.neon.tech', port: 5432, user: 'memory_runtime' });
const ENDPOINTS = JSON.stringify({ sg: 'https://sg.memory.test', 'kr-seoul': 'https://seoul.memory.test' });

async function controlDb(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const migrations = new URL('../../postgres/migrations/', import.meta.url);
    await db.exec(await readFile(new URL('0001_private_namespaces.sql', migrations), 'utf8'));
    await db.exec(await readFile(new URL('0002_deployment_identity.sql', migrations), 'utf8'));
    await db.exec(await readFile(new URL('../../postgres/control/0003_placement_directory.sql', import.meta.url), 'utf8'));
    await db.query(`INSERT INTO memory_control.deployment_identity(singleton, deployment_id, storage_region, processing_policy_id, created_at_ms)
        VALUES (1,'memory-ctl-0001','sg','standard-v1',1)`);
    await db.query(`INSERT INTO memory_control.regions(region, added_at_ms) VALUES ('sg',$1),('kr-seoul',$1)`, [NOW]);
    await db.query(`INSERT INTO memory_control.deployments(deployment_id, region, processing_policy_id, added_at_ms)
        VALUES ('memory-sg','sg','standard-v1',$1),('memory-seoul','kr-seoul','kr-primary-storage-v1',$1)`, [NOW]);
    await db.query(`INSERT INTO memory_control.accounts(id, created_at_ms) VALUES ('account:a',$1)`, [NOW]);
    return db;
}

function clientFactory(db) {
    return () => ({
        connect: async () => { await db.exec('SET SESSION AUTHORIZATION memory_runtime'); },
        query: async config => { const r = await db.query(config.text, config.values ?? []); return { rows: r.rows, rowCount: r.affectedRows ?? null }; },
        end: async () => { await db.exec('SET SESSION AUTHORIZATION postgres'); },
        on: () => undefined,
    });
}

/** Test-side mutations run as the fixture role, not the runtime session. */
const mutate = (db, sql, params) => db.exec('SET SESSION AUTHORIZATION postgres').then(() => db.query(sql, params));

function stubFetch(t) {
    const calls = [];
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (input, init) => {
        calls.push(String(input instanceof Request ? input.url : input));
        return new Response('proxied', { status: 200 });
    };
    return calls;
}

const bindings = extra => ({ MEMORY_CONTROL_TARGET_JSON: TARGET, MEMORY_CONTROL_RUNTIME_PASSWORD: 'pw-12345678', MEMORY_REGION_ENDPOINTS_JSON: ENDPOINTS, ...extra });

async function seedSpaces(db) {
    await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, home_region, data_policy, placement_epoch, created_at_ms)
        VALUES ('space:sg','account:a','sg',$1,1,$2)`, [JSON.stringify(POLICY), NOW]);
    await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, home_region, data_policy, placement_epoch, created_at_ms)
        VALUES ('space:seoul','account:a','kr-seoul',$1,1,$2)`, [JSON.stringify({ ...POLICY, residency: 'kr-seoul', profile: 'kr-primary-storage' }), NOW]);
}

test('health answers locally; unscoped paths get a typed refusal', async t => {
    const db = await controlDb(t);
    const app = createRoutingWorkerApp(bindings(), { control: CONTROL }, { clientFactory: clientFactory(db) });
    assert.equal((await app(new Request('https://router.test/health'))).status, 200);
    const response = await app(new Request('https://router.test/v1/memories'));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'space_scope_required');
});

test('space-scoped requests proxy to the home region endpoint', async t => {
    const db = await controlDb(t);
    await seedSpaces(db);
    const calls = stubFetch(t);
    const app = createRoutingWorkerApp(bindings(), { control: CONTROL }, { clientFactory: clientFactory(db) });
    const sg = await app(new Request('https://router.test/v1/spaces/space:sg/memories', { method: 'POST', body: '{}' }));
    assert.equal(sg.status, 200);
    const seoul = await app(new Request('https://router.test/v1/spaces/space:seoul/memories'));
    assert.equal(seoul.status, 200);
    assert.deepEqual(calls, ['https://sg.memory.test/v1/spaces/space:sg/memories', 'https://seoul.memory.test/v1/spaces/space:seoul/memories']);
});

test('missing, closed, and unroutable Spaces never proxy', async t => {
    const db = await controlDb(t);
    await seedSpaces(db);
    const calls = stubFetch(t);
    const app = createRoutingWorkerApp(bindings(), { control: CONTROL }, { clientFactory: clientFactory(db) });
    assert.equal((await app(new Request('https://router.test/v1/spaces/space:missing/memories'))).status, 404);
    await mutate(db, `UPDATE memory_control.spaces SET closed_at_ms=$1 WHERE id='space:seoul'`, [NOW + 1]);
    assert.equal((await app(new Request('https://router.test/v1/spaces/space:seoul/memories'))).status, 410);
    await mutate(db, `UPDATE memory_control.deployments SET retired_at_ms=$1 WHERE deployment_id='memory-sg'`, [NOW + 2]);
    assert.equal((await app(new Request('https://router.test/v1/spaces/space:sg/memories'))).status, 503);
    assert.equal(calls.length, 0);
});

test('a region without a configured endpoint refuses rather than guessing', async t => {
    const db = await controlDb(t);
    await seedSpaces(db);
    const calls = stubFetch(t);
    const app = createRoutingWorkerApp(bindings({ MEMORY_REGION_ENDPOINTS_JSON: JSON.stringify({ 'kr-seoul': 'https://seoul.memory.test' }) }),
        { control: CONTROL }, { clientFactory: clientFactory(db) });
    assert.equal((await app(new Request('https://router.test/v1/spaces/space:sg/memories'))).status, 503);
    assert.equal(calls.length, 0);
    assert.equal((await app(new Request('https://router.test/v1/spaces/space:seoul/memories'))).status, 200);
});

test('missing control-plane configuration refuses scoped traffic', async t => {
    const app = createRoutingWorkerApp({}, { control: CONTROL });
    assert.equal((await app(new Request('https://router.test/health'))).status, 200);
    assert.equal((await app(new Request('https://router.test/v1/spaces/space:sg/memories'))).status, 503);
});

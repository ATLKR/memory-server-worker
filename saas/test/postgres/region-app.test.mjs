import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createRegionWorkerApp } from '../../src/postgres/region-app.ts';

const CONFIG = { region: 'sg', processingPolicyId: 'standard-v1', schemaVersion: 2, prefix: 'MEMORY_SG', hyperdriveBinding: 'SG_HYPERDRIVE' };
// The attestation pins the exact contiguous migration count per cluster:
// 17 regional, 7 control. Bump when the lineage grows.
const FULL_CONFIG = { ...CONFIG, schemaVersion: 17, controlSchemaVersion: 7 };
const ORIGIN = 'https://memory.test';
const TARGET = JSON.stringify({ connectionMode: 'direct', database: 'postgres', deploymentId: 'memory-sg-0001',
    expectedRole: 'memory_runtime', host: 'ep-test.ap-southeast-1.aws.neon.tech', port: 5432, user: 'memory_runtime' });

async function pgliteDb(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const migrations = new URL('../../postgres/migrations/', import.meta.url);
    await db.exec(await readFile(new URL('0001_private_namespaces.sql', migrations), 'utf8'));
    await db.exec(await readFile(new URL('0002_deployment_identity.sql', migrations), 'utf8'));
    await db.query(`INSERT INTO memory_control.deployment_identity(singleton, deployment_id, storage_region, processing_policy_id, created_at_ms)
        VALUES (1,'memory-sg-0001','sg','standard-v1',1)`);
    return db;
}

function pgliteClientFactory(db) {
    return () => ({
        connect: async () => { await db.exec('SET SESSION AUTHORIZATION memory_runtime'); },
        query: async config => {
            const result = await db.query(config.text, config.values ?? []);
            return { rows: result.rows, rowCount: result.affectedRows ?? null };
        },
        end: async () => undefined,
        on: () => undefined,
    });
}

function env(overrides = {}) {
    return { PUBLIC_ORIGIN: ORIGIN, ...overrides };
}

test('disabled or unconfigured region app refuses to serve', async () => {
    const off = createRegionWorkerApp(env(), CONFIG);
    assert.equal((await off.fetch(new Request(ORIGIN + '/health'), env())).status, 503);
    const missing = createRegionWorkerApp(env({ MEMORY_SG_ENABLED: 'true' }), CONFIG);
    assert.equal((await missing.fetch(new Request(ORIGIN + '/health'), env({ MEMORY_SG_ENABLED: 'true' }))).status, 503);
    const malformed = env({ MEMORY_SG_ENABLED: 'true', MEMORY_SG_TARGET_JSON: '{"bad"', MEMORY_SG_RUNTIME_PASSWORD: 'pw-12345678' });
    assert.equal((await createRegionWorkerApp(malformed, CONFIG).fetch(new Request(ORIGIN + '/health'), malformed)).status, 503);
});

test('configured region app attests the deployment and serves the release app', async t => {
    const db = await pgliteDb(t);
    const bindings = env({ MEMORY_SG_ENABLED: 'true', MEMORY_SG_TARGET_JSON: TARGET, MEMORY_SG_RUNTIME_PASSWORD: 'pw-12345678' });
    const app = createRegionWorkerApp(bindings, CONFIG, { clientFactory: pgliteClientFactory(db) });
    const response = await app.fetch(new Request(ORIGIN + '/health'), bindings);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
});

test('region-first path prefix is stripped before app routing', async t => {
    const db = await pgliteDb(t);
    const bindings = env({ MEMORY_SG_ENABLED: 'true', MEMORY_SG_TARGET_JSON: TARGET, MEMORY_SG_RUNTIME_PASSWORD: 'pw-12345678' });
    const app = createRegionWorkerApp(bindings, CONFIG, { clientFactory: pgliteClientFactory(db) });
    assert.equal((await app.fetch(new Request(ORIGIN + '/sg/health'), bindings)).status, 200);
    assert.equal((await app.fetch(new Request(ORIGIN + '/sg'), bindings)).status, 200);
    // A foreign region's prefix must not be silently absorbed.
    const foreign = await app.fetch(new Request(ORIGIN + '/kr-seoul/health'), bindings);
    assert.notEqual(foreign.status, 500);
});

test('a deployment attestation mismatch refuses the session', async t => {
    const db = await pgliteDb(t);
    // The configured target names a deployment the cluster is not: attestation fails closed.
    const wrong = JSON.stringify({ ...JSON.parse(TARGET), deploymentId: 'memory-sg-9999' });
    const bindings = env({ MEMORY_SG_ENABLED: 'true', MEMORY_SG_TARGET_JSON: wrong, MEMORY_SG_RUNTIME_PASSWORD: 'pw-12345678' });
    const app = createRegionWorkerApp(bindings, CONFIG, { clientFactory: pgliteClientFactory(db) });
    const response = await app.fetch(new Request(ORIGIN + '/health'), bindings);
    assert.equal(response.status, 503);
});

/** Full regional schema — scheduled maintenance and journal apply need the
 * complete migration set, not only the deployment-identity foundation. */
async function regionalDb(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const dir = new URL('../../postgres/migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort())
        await db.exec(await readFile(new URL(name, dir), 'utf8'));
    await db.query(`INSERT INTO memory_control.deployment_identity(singleton, deployment_id, storage_region, processing_policy_id, created_at_ms)
        VALUES (1,'memory-sg-0001','sg','standard-v1',1)`);
    return db;
}

/** Control-plane fixture: shared foundation + the placement directory and
 * billing catalog lineages, plus the control deployment's own identity. */
async function controlDb(t, deploymentId = 'memory-control-0001') {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const dir = new URL('../../postgres/migrations/', import.meta.url);
    await db.exec(await readFile(new URL('0001_private_namespaces.sql', dir), 'utf8'));
    await db.exec(await readFile(new URL('0002_deployment_identity.sql', dir), 'utf8'));
    const controlDir = new URL('../../postgres/control/', import.meta.url);
    for (const name of (await readdir(controlDir)).filter(f => f.endsWith('.sql')).sort())
        await db.exec(await readFile(new URL(name, controlDir), 'utf8'));
    await db.query(`INSERT INTO memory_control.deployment_identity(singleton, deployment_id, storage_region, processing_policy_id, created_at_ms)
        VALUES (1,$1,'sg','standard-v1',1)`, [deploymentId]);
    return db;
}

const CONTROL_TARGET = JSON.stringify({ connectionMode: 'direct', database: 'postgres', deploymentId: 'memory-control-0001',
    expectedRole: 'memory_runtime', host: 'control.internal', port: 5432, user: 'memory_runtime' });
const CONTROL_KEYS = { MEMORY_SG_CONTROL_TARGET_JSON: CONTROL_TARGET, MEMORY_SG_CONTROL_RUNTIME_PASSWORD: 'pw-12345678' };

/** Route fake clients to the right fixture by the target's configured host. */
function splitClientFactory(map, calls = []) {
    return plan => {
        const host = plan?.config?.host ?? plan?.host;
        calls.push(host);
        const db = map.get(host);
        if (!db) throw new Error(`unexpected host ${host}`);
        return {
            connect: async () => { await db.exec('SET SESSION AUTHORIZATION memory_runtime'); },
            query: async config => {
                const result = await db.query(config.text, config.values ?? []);
                return { rows: result.rows, rowCount: result.affectedRows ?? null };
            },
            end: async () => undefined,
            on: () => undefined,
        };
    };
}

test('a configured _CONTROL_ target opens a second attested session per request', async t => {
    const regional = await regionalDb(t), control = await controlDb(t);
    const calls = [];
    const bindings = env({ MEMORY_SG_ENABLED: 'true', MEMORY_SG_TARGET_JSON: TARGET, MEMORY_SG_RUNTIME_PASSWORD: 'pw-12345678', ...CONTROL_KEYS });
    const app = createRegionWorkerApp(bindings, FULL_CONFIG,
        { clientFactory: splitClientFactory(new Map([['ep-test.ap-southeast-1.aws.neon.tech', regional], ['control.internal', control]]), calls) });
    const response = await app.fetch(new Request(ORIGIN + '/health'), bindings);
    assert.equal(response.status, 200);
    assert.deepEqual(calls.sort(), ['control.internal', 'ep-test.ap-southeast-1.aws.neon.tech']);
});

test('a malformed _CONTROL_ target disables the whole region app', async t => {
    const regional = await regionalDb(t);
    const bindings = env({ MEMORY_SG_ENABLED: 'true', MEMORY_SG_TARGET_JSON: TARGET, MEMORY_SG_RUNTIME_PASSWORD: 'pw-12345678',
        MEMORY_SG_CONTROL_TARGET_JSON: '{"bad"', MEMORY_SG_CONTROL_RUNTIME_PASSWORD: 'pw-12345678' });
    const app = createRegionWorkerApp(bindings, FULL_CONFIG, { clientFactory: splitClientFactory(new Map([['ep-test.ap-southeast-1.aws.neon.tech', regional]])) });
    assert.equal((await app.fetch(new Request(ORIGIN + '/health'), bindings)).status, 503);
});

test('a control attestation mismatch refuses the request', async t => {
    const regional = await regionalDb(t), control = await controlDb(t, 'memory-control-9999');
    const bindings = env({ MEMORY_SG_ENABLED: 'true', MEMORY_SG_TARGET_JSON: TARGET, MEMORY_SG_RUNTIME_PASSWORD: 'pw-12345678', ...CONTROL_KEYS });
    const app = createRegionWorkerApp(bindings, FULL_CONFIG,
        { clientFactory: splitClientFactory(new Map([['ep-test.ap-southeast-1.aws.neon.tech', regional], ['control.internal', control]])) });
    assert.equal((await app.fetch(new Request(ORIGIN + '/health'), bindings)).status, 503);
});

test('scheduled maintenance syncs the central lifecycle journal over the control session', async t => {
    const regional = await regionalDb(t), control = await controlDb(t);
    // A regional account carrying the issuer's binding is what the sync pulls for.
    await regional.query(`INSERT INTO memory_identity.accounts(id) VALUES ('acct:one')`);
    await regional.query(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
        VALUES ('https://issuer.example','sub-1','acct:one',1)`);
    // Journal the suspension centrally: receipt first, then the event itself.
    const now = Date.now(), hash = 'a'.repeat(64);
    await control.query(`INSERT INTO memory_ops.webhook_events(provider, event_id, body_hash, created_at_ms)
        VALUES ('identity','evt:1',$1,$2)`, [hash, now]);
    await control.query(`INSERT INTO memory_ops.lifecycle_events
        (id, issuer, subject, sequence, kind, address, occurred_at_ms, received_at_ms, signed_at_ms, body_hash)
        VALUES ('evt:1','https://issuer.example','sub-1',1,'account.suspended','',$2,$2,$2,$1)`,
        [hash, now]);
    const bindings = env({ MEMORY_SG_ENABLED: 'true', MEMORY_SG_TARGET_JSON: TARGET, MEMORY_SG_RUNTIME_PASSWORD: 'pw-12345678', ...CONTROL_KEYS });
    const app = createRegionWorkerApp(bindings, FULL_CONFIG,
        { clientFactory: splitClientFactory(new Map([['ep-test.ap-southeast-1.aws.neon.tech', regional], ['control.internal', control]])) });
    await app.scheduled({}, bindings);
    const head = await regional.query(`SELECT applied_sequence n FROM memory_ops.lifecycle_apply_head WHERE issuer='https://issuer.example'`);
    assert.equal(head.rows[0]?.n, 1);
    const applied = await regional.query(`SELECT kind FROM memory_ops.lifecycle_applied_state
        WHERE issuer='https://issuer.example' AND subject='sub-1' AND address=''`);
    assert.equal(applied.rows[0]?.kind, 'account.suspended');
});

// Live Postgres deployment attestation for a regional or control-plane cluster.
//
//   node --experimental-strip-types scripts/postgres-attest.mjs \
//     --region sg --policy <processing-policy-id> --env-file <path>
//
// --env-file is a private JSON object holding the same env shape the region
// worker consumes (MEMORY_SG_* for sg, MEMORY_KR_SEOUL_* for kr-seoul):
//
//   { "MEMORY_SG_ENABLED": "true",
//     "MEMORY_SG_TARGET_JSON": "{\"connectionMode\":\"direct\",\"database\":\"...\",\"deploymentId\":\"...\",\"expectedRole\":\"memory_runtime\",\"host\":\"ep-...-ap-southeast-1.aws.neon.tech\",\"port\":5432,\"user\":\"memory_runtime\"}",
//     "MEMORY_SG_RUNTIME_PASSWORD": "...",
//     "MEMORY_SG_TRANSPORT": "native" }
//
// A control-plane target uses the _CONTROL_ suffix keys. Keep the env file in
// an access-controlled directory outside the repository — this tool reads it,
// never writes or echoes credentials.
//
// On success it prints a bounded JSON attestation report (no secrets): the
// deployment identity, contiguous schema lineage, runtime-role privilege
// denials, and the enumerated regional table count. On any failure it exits
// non-zero with the boundary code only.

import { readFile } from 'node:fs/promises';
import { resolvePostgresConnection } from '../src/postgres/region-app.ts';
import { listRegionalTables } from '../src/postgres/cutover.ts';

const PREFIX = { sg: 'MEMORY_SG', 'kr-seoul': 'MEMORY_KR_SEOUL' };
const HYPERDRIVE = { sg: 'SG_HYPERDRIVE', 'kr-seoul': 'KR_SEOUL_HYPERDRIVE' };

function usage(message) {
    if (message) process.stderr.write(message + '\n');
    process.stderr.write('Usage: node --experimental-strip-types scripts/postgres-attest.mjs --region sg|kr-seoul --policy <id> --env-file <path> [--control] [--schema-version N] [--control-schema-version N]\n');
    process.exitCode = 2;
}

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const region = arg('--region'), policy = arg('--policy'), envFile = arg('--env-file');
const control = args.includes('--control');
const schemaVersion = Number(arg('--schema-version') ?? '16');
const controlSchemaVersion = Number(arg('--control-schema-version') ?? '6');

if (!PREFIX[region] || !policy || !/^[a-z][a-z0-9-]{2,63}$/.test(policy) || !envFile
    || !Number.isSafeInteger(schemaVersion) || !Number.isSafeInteger(controlSchemaVersion)) {
    usage('Missing or invalid arguments.');
    process.exit(2);
}

let env;
try {
    const parsed = JSON.parse(await readFile(envFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    // "env:NAME" values resolve from the process environment so secrets can be
    // injected (e.g. pass-cli run) without ever sitting in the file on disk;
    // "file:PATH" reads a local file (CA PEMs and other non-secret assets).
    for (const [k, v] of Object.entries(parsed))
        if (typeof v === 'string' && v.startsWith('env:')) {
            const resolved = process.env[v.slice(4)];
            if (!resolved) { process.stderr.write(`Env indirection ${v} for ${k} resolved to nothing.\n`); process.exit(2); }
            parsed[k] = resolved;
        } else if (typeof v === 'string' && v.startsWith('file:')) {
            try { parsed[k] = await readFile(v.slice(5), 'utf8'); }
            catch { process.stderr.write(`File indirection ${v} for ${k} is unreadable.\n`); process.exit(2); }
        }
    env = parsed;
} catch {
    usage('Cannot read the env file or it is not a JSON object.');
    process.exit(2);
}

const config = {
    region, prefix: PREFIX[region], hyperdriveBinding: HYPERDRIVE[region],
    processingPolicyId: policy, schemaVersion, controlSchemaVersion,
};

const connection = resolvePostgresConnection(env, config, control ? '_CONTROL_' : '_',
    control ? `${config.prefix}_CONTROL_HYPERDRIVE` : config.hyperdriveBinding, undefined);
if (!connection) {
    process.stderr.write('No target JSON for ' + (control ? 'control' : region) + ' in the env file.\n');
    process.exit(2);
}

// The connection itself performs the role-boundary probe (ROLE_SQL: no
// superuser/createdb/created role/RLS-bypass/replication/schema ownership) and
// the pinned deployment attestation before the callback runs.
try {
    const report = await connection.withConnection(async session => {
        const deployment = (await session.query(
            `SELECT deployment_id AS "deploymentId", storage_region AS "storageRegion",
               processing_policy_id AS "processingPolicyId", created_at_ms AS "createdAtMs"
             FROM memory_control.deployment_identity`)).rows[0];
        const versions = (await session.query(
            `SELECT version FROM memory_control.schema_migrations ORDER BY version`)).rows.map(r => Number(r.version));
        const tables = control ? [] : await listRegionalTables(session);
        // Privilege boundary probes — every one of these must be denied for the
        // runtime role. A probe that succeeds is an attestation failure.
        const probes = {};
        for (const [name, sql] of [
            ['pg_authid', 'SELECT 1 FROM pg_catalog.pg_authid LIMIT 1'],
            ['pg_shadow', 'SELECT 1 FROM pg_shadow LIMIT 1'],
            ['create_table_public', 'CREATE TABLE public.attest_probe(i int)'],
            ['copy_stdout', 'COPY (SELECT 1) TO STDOUT'],
            ['alter_system', 'ALTER SYSTEM SET work_mem = $1'],
        ]) {
            // A denied statement poisons the transaction; each probe runs under
            // its own savepoint so the rest of the attestation continues.
            await session.query('SAVEPOINT attest_probe');
            try { await session.query(sql, name === 'alter_system' ? ['4MB'] : []); probes[name] = 'ALLOWED'; }
            catch (e) {
                try { await session.query('ROLLBACK TO attest_probe'); } catch { /* transaction already failed */ }
                // Session-layer denials (postgres_transaction_control_denied)
                // and DB-layer denials (42501 etc.) both count — the report
                // records which layer held.
                probes[name] = e && typeof e === 'object' && 'code' in e ? `denied:${e.code}` : 'denied';
            }
            try { await session.query('RELEASE attest_probe'); } catch { /* rolled back */ }
        }
        return {
            attested: true, kind: control ? 'control' : 'regional', region,
            deployment, schemaVersions: versions,
            regionalTables: tables.length || undefined,
            privilegeDenials: probes,
        };
    });
    const denied = Object.values(report.privilegeDenials).every(v => typeof v === 'string' && v.startsWith('denied'));
    report.allDenialsHeld = denied;
    if (!denied) report.attested = false;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!denied) process.exitCode = 1;
} catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : 'postgres_attestation_failed';
    process.stdout.write(JSON.stringify({ attested: false, code }) + '\n');
    process.exitCode = 1;
}

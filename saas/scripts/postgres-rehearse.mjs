// Sealed cutover rehearsal between two live Postgres clusters, driven by the
// src/postgres/cutover.ts primitives over raw pg Clients. Never uses
// createPostgresConnection: its guarded session rejects non-DML statements and
// admin logins, while the cut needs ALTER ROLE, session_replication_role and
// SAVEPOINT on the same connection.
//
//   node --experimental-strip-types scripts/postgres-rehearse.mjs --seed|--run
//
// Env (no other source of connection parameters; secrets are never printed):
//   PGSOURCE_HOST PGSOURCE_PORT PGSOURCE_DATABASE PGSOURCE_USER PGSOURCE_PASSWORD [PGSOURCE_SSLROOTCERT]
//   PGTARGET_* same set (--run only; --seed touches the source alone).
// PORT defaults to 5432, SSLROOTCERT is an optional PEM CA string. TLS is
// always verified. Missing/invalid input exits 2 with a usage line.
//
// --seed inserts a small idempotent 'rehearsal-'-prefixed fixture into SOURCE
// (memory_control.deployment_identity is provision-seeded and never written).
// --run freezes the source runtime role, seals the full regional surface,
// INSERT-copies every non-provision-seeded table into an empty target, runs
// the payload-object pass with a null fetcher (recorded as skipped — no object
// store is configured), verifies the manifest on the target, then always
// unfreezes. Evidence is one JSON object; failures print a bounded
// {"rehearsed":false,"code":...} line and exit 1.

import { createHash } from 'node:crypto';
import pg from 'pg';
import { copyOrder, copyTable, exportManifest, freezeRuntime, listRegionalTables, payloadInventory,
    sealPayloadObjects, unfreezeRuntime, verifyManifest, verifyPayloadObjects }
    from '../src/postgres/cutover.ts';

function usage(message) {
    if (message) process.stderr.write(message + '\n');
    process.stderr.write('Usage: node --experimental-strip-types scripts/postgres-rehearse.mjs --seed|--run\n');
    process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 1 || !['--seed', '--run'].includes(args[0])) usage('Missing or invalid mode.');
const mode = args[0].slice(2);

function clusterConfig(prefix) {
    for (const k of ['HOST', 'DATABASE', 'USER', 'PASSWORD'])
        if (!process.env[`${prefix}_${k}`]) usage(`Missing ${prefix}_${k}.`);
    const port = Number(process.env[`${prefix}_PORT`] ?? '5432');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) usage(`Invalid ${prefix}_PORT.`);
    const host = process.env[`${prefix}_HOST`], ca = process.env[`${prefix}_SSLROOTCERT`];
    return { host, port, database: process.env[`${prefix}_DATABASE`], user: process.env[`${prefix}_USER`],
        password: process.env[`${prefix}_PASSWORD`],
        ssl: { rejectUnauthorized: true, servername: host, ...(ca ? { ca } : {}) } };
}

const sourceConfig = clusterConfig('PGSOURCE');
const targetConfig = mode === 'run' ? clusterConfig('PGTARGET') : undefined;

// Failure output is a bounded code only — a pg sqlstate, a cutover_* boundary
// code carried in Error.message, or the generic fallback.
function boundedCode(error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[a-zA-Z0-9_]{1,64}$/.test(error.code) ? error.code
        : /^[a-z][a-z0-9_]{1,63}$/.test(String(error?.message ?? '')) ? error.message : 'rehearsal_failed';
    return code;
}
function fail(key, error) {
    process.stdout.write(JSON.stringify({ [key]: false, code: boundedCode(error) }) + '\n');
    process.exit(1);
}

const sessionOf = client => ({ inTransaction: false, query: (text, values = []) => client.query(text, values) });

// --seed ---------------------------------------------------------------------
// A representative regional fixture, all ids 'rehearsal-'-prefixed so residue
// is identifiable. Runs inside one transaction; safe to re-run (existence
// guards, ON CONFLICT, state-guarded UPDATEs). Note: memories.body is capped
// at 16384 octets by schema CHECK — the "large" row is a 16KB in-row body plus
// one external-payload row carrying a 64KB object reference, the only >16KB
// representation this schema admits.
async function seed() {
    const client = new pg.Client(sourceConfig);
    try { await client.connect(); } catch (e) { fail('seeded', e); }
    const q = (text, values = []) => client.query(text, values);
    // Fixture DML needs the owner policy (FORCE RLS). Best-effort: a member
    // login granted SET TRUE assumes it; a BYPASSRLS admin ignores the failure.
    await q(`SET ROLE memory_owner`).catch(() => {});
    const now = Date.now();
    const sha = createHash('sha256').update(Buffer.alloc(65536, 0x61)).digest('hex');
    const token = createHash('sha256').update('rehearsal-session-a').digest('hex');
    try {
        const dep = (await q(`SELECT deployment_id AS d, storage_region AS r FROM memory_control.deployment_identity`)).rows[0];
        if (!dep) throw new Error('seed_identity_missing');
        const policy = JSON.stringify({ classificationStatus: 'classified', dataClass: 'regional',
            placementEpoch: 1, policyVersion: 1, processingBoundary: 'region', profile: 'standard',
            residency: dep.r, sensitivityTags: ['rehearsal'] });
        await q('BEGIN');
        await q(`INSERT INTO memory_identity.accounts(id) VALUES ($1),($2) ON CONFLICT DO NOTHING`,
            ['rehearsal-acct-a', 'rehearsal-acct-b']);
        await q(`INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
            VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            ['https://idp.rehearsal.invalid', 'rehearsal-subject-a', 'rehearsal-acct-a', now]);
        await q(`INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            ['rehearsal-email-a', 'rehearsal-acct-a', 'rehearsal-a@rehearsal.invalid', 'rehearsal.invalid', now]);
        await q(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at,
            reauthenticated_at, permission) VALUES ($1,$2,'session',$3,$4,$5,'write') ON CONFLICT DO NOTHING`,
            ['rehearsal-cred-a', 'rehearsal-acct-a', token, now + 86400000, now]);
        await q(`INSERT INTO memory_control.organizations(id) VALUES ($1) ON CONFLICT DO NOTHING`,
            ['rehearsal-org-a']);
        await q(`INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
            VALUES ($1,$2,$3,$4,'owner') ON CONFLICT DO NOTHING`,
            ['rehearsal-membership-a', 'rehearsal-org-a', 'rehearsal-acct-a', 'rehearsal-email-a']);
        await q(`INSERT INTO memory_control.spaces(id, owner_account_id, deployment_id, data_policy,
            source_byte_limit, message_limit, name, security_mode, created_at_ms, actor_credential_id)
            VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,'managed',$8,$9) ON CONFLICT DO NOTHING`,
            ['rehearsal-space-personal', 'rehearsal-acct-a', dep.d, policy, 67108864, 100000,
                'Rehearsal Personal', now, 'rehearsal-cred-a']);
        await q(`INSERT INTO memory_control.spaces(id, organization_id, deployment_id, data_policy,
            source_byte_limit, message_limit, name, security_mode, created_at_ms, actor_credential_id)
            VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,'managed',$8,$9) ON CONFLICT DO NOTHING`,
            ['rehearsal-space-org', 'rehearsal-org-a', dep.d, policy, 67108864, 100000,
                'Rehearsal Org', now, 'rehearsal-cred-a']);
        await q(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at, updated_at,
            actor_credential_id, kind) VALUES
            ('rehearsal-mem-1',$1,$2,1,$3,$3,$4,'fact'),
            ('rehearsal-mem-2',$1,$5,1,$3,$3,$4,'event'),
            ('rehearsal-mem-3',$1,$6,1,$3,$3,$4,'fact'),
            ('rehearsal-mem-ext',$1,$7,1,$3,$3,$4,'fact') ON CONFLICT DO NOTHING`,
            ['rehearsal-space-personal', 'rehearsal note: sealed-cut fixture',
                now, 'rehearsal-cred-a', JSON.stringify({ rehearsal: true, nested: { ok: 1 } }),
                'rehearsal-large:'.padEnd(16384, 'x'), 'rehearsal external payload carrier']);
        // External-payload chain for the ~64KB object: intent -> stage(staging)
        // -> ready -> archive permit -> memory carries the reference -> publish.
        // Guarded by existence: the admission trigger fires even when ON
        // CONFLICT would skip, and a re-run past expires_at would fail there.
        if (!(await q(`SELECT 1 FROM memory_content.payload_stages WHERE id='rehearsal-payload-1'`)).rows.length) {
            await q(`INSERT INTO memory_content.payload_intents(id, account_id, space_id, client_key, request_hash,
                action, item_count, reserved_bytes, created_at, expires_at)
                VALUES ('rehearsal-intent-1',$1,$2,'rehearsal-ck-1','rehearsal-rh-1','archive',1,$3,$4,$5)`,
                ['rehearsal-acct-a', 'rehearsal-space-personal', 65536, now, now + 3600000]);
            await q(`INSERT INTO memory_content.payload_stages(id, intent_id, ordinal, memory_id, payload_shard_id,
                payload_object_key, payload_sha256, payload_bytes, logical_bytes, state, created_at)
                SELECT 'rehearsal-payload-1','rehearsal-intent-1',0,'rehearsal-mem-ext','rehearsal-shard',
                  'rehearsal/object-1',$1,$2,
                  octet_length(m.body)+coalesce(octet_length(m.source),0)+octet_length(m.provenance::text),
                  'staging',$3 FROM memory_content.memories m WHERE m.id='rehearsal-mem-ext'`,
                [sha, 65536, now]);
            await q(`UPDATE memory_content.payload_stages SET state='ready' WHERE id='rehearsal-payload-1'`);
            await q(`INSERT INTO memory_content.payload_archive_permits(payload_id, memory_id, revision, target, created_at)
                VALUES ('rehearsal-payload-1','rehearsal-mem-ext',1,'current',$1)`, [now]);
            await q(`UPDATE memory_content.memories SET body='[external]', source=NULL, provenance='{}'::jsonb,
                payload_id='rehearsal-payload-1', payload_shard_id='rehearsal-shard',
                payload_object_key='rehearsal/object-1', payload_sha256=$1, payload_bytes=$2,
                logical_bytes=(SELECT logical_bytes FROM memory_content.payload_stages WHERE id='rehearsal-payload-1'),
                revision=revision+1, updated_at=$3 WHERE id='rehearsal-mem-ext'`,
                [sha, 65536, now + 1]);
            await q(`UPDATE memory_content.payload_stages SET state='published' WHERE id='rehearsal-payload-1'`);
        }
        await q(`INSERT INTO memory_jobs.release_jobs(id, memory_id, space_id, revision, kind, available_at, created_at)
            VALUES ('rehearsal-job-1','rehearsal-mem-1',$1,1,'upsert',$2,$2),
                   ('rehearsal-job-2',NULL,$1,NULL,'ingest',$2,$2) ON CONFLICT DO NOTHING`,
            ['rehearsal-space-personal', now]);
        await q('COMMIT');
    } catch (e) {
        await q('ROLLBACK').catch(() => {});
        await client.end().catch(() => {});
        fail('seeded', e);
    }
    await client.end().catch(() => {});
    process.stdout.write(JSON.stringify({ seeded: true }) + '\n');
}

// --run ----------------------------------------------------------------------
async function run() {
    const sourceClient = new pg.Client(sourceConfig);
    const targetClient = new pg.Client(targetConfig);
    try { await sourceClient.connect(); } catch (e) { fail('rehearsed', e); }
    try { await targetClient.connect(); } catch (e) { fail('rehearsed', e); }
    const source = sessionOf(sourceClient), target = sessionOf(targetClient);
    let frozen = false; // the source runtime role is currently NOLOGIN-fenced
    let report;
    let phase = 'sanity';
    try {
        // Sanity: identical contiguous lineage on both clusters, deployment
        // identity present on both, and a provably empty target — the cut
        // never merges.
        const versions = async s => (await s.query(
            `SELECT version FROM memory_control.schema_migrations ORDER BY version`)).rows.map(r => Number(r.version));
        const [sv, tv] = [await versions(source), await versions(target)];
        const contiguous = l => l.length > 0 && l.every((v, i) => i === 0 || v === l[i - 1] + 1);
        if (JSON.stringify(sv) !== JSON.stringify(tv) || !contiguous(sv))
            throw new Error('cutover_lineage_mismatch');
        const identity = async s => (await s.query(
            `SELECT deployment_id AS d, storage_region AS r FROM memory_control.deployment_identity`)).rows[0];
        const [sdep, tdep] = [await identity(source), await identity(target)];
        if (!sdep || !tdep) throw new Error('cutover_identity_missing');
        if ((await target.query(`SELECT 1 FROM memory_identity.accounts LIMIT 1`)).rows.length
            || (await target.query(`SELECT 1 FROM memory_content.memories LIMIT 1`)).rows.length)
            throw new Error('cutover_target_not_empty');

        const t0 = Date.now();
        try {
            phase = 'freeze';
            await freezeRuntime(source);
            frozen = true;
            const tFreeze = Date.now();
            const tables = await listRegionalTables(source);
            // Provision-seeded tables are non-empty on a fresh target: sealed
            // into the manifest as reconciliation checks, never copied.
            const provisionSeeded = [];
            for (const t of tables)
                if ((await target.query(`SELECT 1 FROM ${t} LIMIT 1`)).rows.length) provisionSeeded.push(t);
            const tEnumerate = Date.now();
            phase = 'seal';
            const manifest = await exportManifest(source, sdep.d, sdep.r, tables, Date.now());
            const inventory = await payloadInventory(source);
            const nullFetcher = async () => null;
            const seal = await sealPayloadObjects(source, nullFetcher);
            const tSeal = Date.now();
            let copiedRows = 0;
            phase = 'copy';
            // Parents-first order; intra-cycle FKs are dropped for the load
            // window and re-added (validated) after — managed Postgres grants
            // no way to suspend RI triggers.
            const plan = await copyOrder(target, tables);
            for (const c of plan.cyclicConstraints)
                await target.query(`ALTER TABLE ${c.table} DROP CONSTRAINT "${c.name}"`);
            const dropped = plan.cyclicConstraints;
            let copyError;
            try {
                for (const t of plan.order)
                    if (!provisionSeeded.includes(t)) copiedRows += await copyTable(source, target, t);
            } catch (e) { copyError = e; }
            // Re-adding validates every copied row; on a failed copy the
            // partial load may not validate — that failure is secondary.
            for (const c of dropped) {
                try { await target.query(`ALTER TABLE ${c.table} ADD CONSTRAINT "${c.name}" ${c.def}`); }
                catch (e) { copyError ??= e; }
            }
            if (copyError) throw copyError;
            const tCopy = Date.now();
            phase = 'verify';
            await verifyPayloadObjects(seal, nullFetcher);
            const mismatches = await verifyManifest(target, manifest);
            const tVerify = Date.now();
            report = {
                rehearsed: true, region: sdep.r, deploymentId: sdep.d, targetDeploymentId: tdep.d,
                sourceHost: sourceConfig.host, targetHost: targetConfig.host,
                tables: tables.length, copiedRows, provisionSeeded,
                cyclicConstraintsDropped: dropped.map(c => `${c.table}.${c.name}`),
                manifestSha256: manifest.schemaDigest,
                mismatches: mismatches.map(m => m.table),
                payloadObjects: inventory.length,
                payloadVerify: 'skipped', payloadVerifyDetail: 'no object store configured',
                timings: { freezeMs: tFreeze - t0, enumerateMs: tEnumerate - tFreeze,
                    sealMs: tSeal - tEnumerate, copyMs: tCopy - tSeal, verifyMs: tVerify - tCopy,
                    totalMs: tVerify - t0 },
                rpo: 0,
            };
        } finally {
            if (frozen) {
                try { await unfreezeRuntime(source); frozen = false; } catch { /* still fenced */ }
            }
        }
        report.unfrozen = !frozen;
        process.stdout.write(JSON.stringify(report) + '\n');
        if (report.mismatches.length || frozen) process.exitCode = 1;
    } catch (e) {
        process.stdout.write(JSON.stringify({ rehearsed: false, code: boundedCode(e), phase, unfrozen: !frozen }) + '\n');
        process.exitCode = 1;
    } finally {
        await sourceClient.end().catch(() => {});
        await targetClient.end().catch(() => {});
    }
}

if (mode === 'seed') await seed(); else await run();

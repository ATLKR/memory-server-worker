// Applies SQL migration files to a live Postgres cluster over a raw pg Client.
//
//   node --experimental-strip-types scripts/postgres-migrate.mjs --cluster regional|control
//
// --cluster regional applies postgres/migrations/*.sql in sorted order;
// --cluster control applies postgres/control/*.sql in sorted order.
//
// Connection parameters come from the environment only — PGHOST, PGPORT
// (default 5432), PGDATABASE, PGUSER, PGPASSWORD, optional PGSSLROOTCERT (a
// PEM string, used as the CA only when set). TLS is always verified;
// PGSSLMODE=disable is refused. Nothing is hardcoded and no secret value is
// ever printed.
//
// Each pending file is applied as ONE client.query(fileText) call (simple
// protocol) so the file's own BEGIN/COMMIT and SET LOCAL ROLE memory_owner
// run verbatim — the connecting login must already hold that membership
// (granted WITH SET TRUE); this script never SETs ROLE itself. Files already
// recorded in memory_control.schema_migrations (leading 4-digit version <=
// the ledger max) are skipped. On failure one bounded JSON line
// {"migrate_failed":...,"code":...} is printed and the process exits non-zero,
// leaving prior files committed. On success: one {"applied":"<file>"} line
// per file and a final {"done":true,"versions":[...]}.

import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

function usage(message) {
    if (message) process.stderr.write(message + '\n');
    process.stderr.write('Usage: node --experimental-strip-types scripts/postgres-migrate.mjs --cluster regional|control\n');
    process.exit(2);
}

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const cluster = arg('--cluster');
const from = arg('--from');
const fromNum = from === undefined ? 0 : Number(from);
const rolesExist = args.includes('--roles-exist');
const argCount = 2 + (from !== undefined ? 2 : 0) + (rolesExist ? 1 : 0);
if (args.length !== argCount || (cluster !== 'regional' && cluster !== 'control')
    || (from !== undefined && (!Number.isSafeInteger(fromNum) || fromNum < 0))) usage('Missing or invalid arguments.');

const env = process.env;
const port = Number(env.PGPORT ?? '5432');
if (!env.PGHOST || !env.PGDATABASE || !env.PGUSER || !env.PGPASSWORD
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || env.PGSSLMODE === 'disable') usage('Missing or invalid PG* environment.');

function redacted(error) {
    let message = String(error && typeof error === 'object' && 'message' in error ? error.message : error ?? '');
    if (env.PGPASSWORD) message = message.split(env.PGPASSWORD).join('[redacted]');
    return message.replace(/(password|passwd|pwd|secret|token)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 400);
}
function fail(file, error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'migrate_failed';
    process.stdout.write(JSON.stringify({ migrate_failed: file, code, message: redacted(error) }) + '\n');
    process.exit(1);
}

const dir = new URL(`../postgres/${cluster === 'regional' ? 'migrations' : 'control'}/`, import.meta.url);
const files = (await readdir(dir)).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
if (!files.length) usage('No migration files found.');

const client = new pg.Client({
    host: env.PGHOST, port, database: env.PGDATABASE, user: env.PGUSER, password: env.PGPASSWORD,
    ssl: { rejectUnauthorized: true, servername: env.PGHOST, ...(env.PGSSLROOTCERT ? { ca: env.PGSSLROOTCERT } : {}) },
});
try { await client.connect(); } catch (e) { fail(null, e); }

// The ledger may not exist on an empty cluster — that is version 0, not an error.
let appliedMax = 0;
try {
    appliedMax = Number((await client.query(`SELECT max(version) AS v FROM memory_control.schema_migrations`)).rows[0].v ?? 0);
} catch (e) {
    if (!(e && typeof e === 'object' && e.code === '42P01')) fail(null, e);
}

// --from N additionally skips files numbered <= N — used when a cluster's
// bootstrap already ran (roles are cluster-global, so 0001 cannot re-run on a
// second database of the same cluster; its schema portion is applied outside
// this script and the ledger rows are still recorded by 0002).
const pending = files.filter(f => Number(f.slice(0, 4)) > Math.max(appliedMax, fromNum));

// --roles-exist: for a second database on a cluster where the reserved
// memory_* roles were already provisioned (roles are cluster-global). Drops
// CREATE ROLE statements for roles that exist and 0001's existence guard —
// catalog-identical outcome on a provisioned cluster. Never use this to
// suppress real drift: it verifies each named role actually exists first.
let existing = new Set();
if (rolesExist) {
    existing = new Set((await client.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'memory\\_%'`))
        .rows.map(r => r.rolname));
}
for (const file of pending) {
    let text = await readFile(new URL(file, dir), 'utf8');
    if (rolesExist) {
        text = text
            .replace(/DO \$bootstrap\$[\s\S]*?\$bootstrap\$;/, '')
            .replace(/^CREATE ROLE ([a-z_][a-z0-9_]*) .*$/gm,
                (m, name) => existing.has(name) ? '' : m);
    }
    try { await client.query(text); } catch (e) { await client.end().catch(() => {}); fail(file, e); }
    process.stdout.write(JSON.stringify({ applied: file }) + '\n');
}

// Ledger validation: every file at-or-below the ledger max must have a row,
// and the recorded versions must be gap-free. A failed file's own INSERT would
// show up here as a missing or non-contiguous version.
let versions = [];
try {
    versions = (await client.query(`SELECT version FROM memory_control.schema_migrations ORDER BY version`))
        .rows.map(r => Number(r.version));
} catch (e) {
    if (!(e && typeof e === 'object' && e.code === '42P01')) { await client.end().catch(() => {}); fail(null, e); }
}
await client.end().catch(() => {});
const ledgerMax = versions.length ? versions[versions.length - 1] : 0;
const contiguous = versions.every((v, i) => i === 0 || v === versions[i - 1] + 1);
const recorded = pending.every(f => versions.includes(Number(f.slice(0, 4))))
    && files.filter(f => Number(f.slice(0, 4)) <= ledgerMax)
        .every(f => versions.includes(Number(f.slice(0, 4))));
if (!contiguous || !recorded)
    fail(null, { code: 'migrate_ledger_mismatch', message: `versions=${versions.join(',')}` });
process.stdout.write(JSON.stringify({ done: true, versions }) + '\n');

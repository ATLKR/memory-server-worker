import { createHash } from 'node:crypto';
import type { PgSession, PgValue } from './connection.ts';

/** Sealed-import primitives for the regional cutover rehearsal (P-6): an
 * exact consistent cut of named tables, a manifest of per-table row counts and
 * canonical digests, and a verifier that recomputes both on the target.
 * The importer writes only INSERTs into an empty target — no dual writers,
 * no UPDATE/DELETE, so a failed verification leaves the source untouched and
 * the target discardable. */

export interface TableSeal {
    table: string;
    columns: string[];
    rows: number;
    sha256: string;
}
export interface CutoverManifest {
    deploymentId: string;
    region: string;
    sealedAtMs: number;
    tables: TableSeal[];
    /** sha256 over the canonical column inventory of every sealed table. */
    schemaDigest: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const QUALIFIED = /^[a-z_][a-z0-9_]*$/;

function qualify(table: string): string {
    if (!IDENTIFIER.test(table) || !table.split('.').every(part => QUALIFIED.test(part))) throw new Error('cutover_table_name_invalid');
    return table;
}

/** Canonical serialization: sorted keys, JSON.stringify — matching the
 * recovery bundle's canonicalization so a sealed manifest survives a
 * byte-for-byte compare on a fresh target. */
function canonical(value: unknown): string {
    const sort = (v: unknown): unknown =>
        Array.isArray(v) ? v.map(sort)
            : v !== null && typeof v === 'object'
                ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
                : v;
    return JSON.stringify(sort(value));
}

async function columnList(session: PgSession, table: string): Promise<string[]> {
    const [schema, name] = table.split('.') as [string, string];
    const r = await session.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns
         WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, name]);
    if (!r.rows.length) throw new Error('cutover_table_missing');
    return r.rows.map(row => row.c);
}

/** Writable columns only — generated columns recompute on the target and the
 * seal still covers them, so a wrong generation expression fails verify. */
async function writableColumns(session: PgSession, table: string): Promise<string[]> {
    const [schema, name] = table.split('.') as [string, string];
    const r = await session.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns
         WHERE table_schema=$1 AND table_name=$2 AND is_generated='NEVER' ORDER BY ordinal_position`, [schema, name]);
    return r.rows.map(row => row.c);
}

/** Every base table in the regional memory_* schemas — the full cutover
 * surface, so the rehearsal cannot silently miss a table added by a later
 * migration. Copies run under session_replication_role='replica', which
 * suppresses constraint triggers, so enumeration order is immaterial. */
export async function listRegionalTables(session: PgSession): Promise<string[]> {
    const r = await session.query<{ t: string }>(
        `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
         WHERE table_schema IN ('memory_control','memory_identity','memory_content','memory_jobs','memory_ops','memory_search')
           AND table_type='BASE TABLE'
           AND table_name NOT IN ('schema_migrations') ORDER BY 1`);
    return r.rows.map(row => row.t);
}

/** Write freeze for the cut window. Revoking the runtime role's LOGIN is the
 * airtight fence: every serving connection dies, writes and reads alike, while
 * the admin session running the seal is unaffected. The alternative —
 * read-only transactions — is session-bypassable; replaying the grant list is
 * error-prone. `unfreezeRuntime` restores login exactly. */
export async function freezeRuntime(admin: PgSession, role = 'memory_runtime'): Promise<void> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('cutover_role_invalid');
    await admin.query(`ALTER ROLE ${role} NOLOGIN`);
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1`, [role]);
}

/** Restore the runtime role's login after a verified or abandoned cut. */
export async function unfreezeRuntime(admin: PgSession, role = 'memory_runtime'): Promise<void> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('cutover_role_invalid');
    await admin.query(`ALTER ROLE ${role} LOGIN`);
}

/** Digest every row of `table` under the caller's snapshot/transaction. */
export async function sealTable(session: PgSession, table: string): Promise<TableSeal> {
    const qualified = qualify(table);
    const columns = await columnList(session, qualified);
    const order = columns.map(c => `"${c}"`).join(',');
    const rows = await session.query(`SELECT ${order} FROM ${qualified} ORDER BY ${order}`);
    const digest = createHash('sha256');
    for (const row of rows.rows) digest.update(canonical(row) + '\n');
    return { table: qualified, columns, rows: rows.rows.length, sha256: digest.digest('hex') };
}

export async function exportManifest(session: PgSession, deploymentId: string, region: string, tables: string[], sealedAtMs: number): Promise<CutoverManifest> {
    const sealed: TableSeal[] = [];
    for (const table of tables) sealed.push(await sealTable(session, table));
    const schemaDigest = createHash('sha256')
        .update(canonical(sealed.map(t => ({ table: t.table, columns: t.columns })))).digest('hex');
    return { deploymentId, region, sealedAtMs, tables: sealed, schemaDigest };
}

/** INSERT-copy one table in deterministic order. The target table must be
 * empty — the cutover never merges. */
export async function copyTable(source: PgSession, target: PgSession, table: string): Promise<number> {
    const qualified = qualify(table);
    const columns = await writableColumns(source, qualified);
    const order = columns.map(c => `"${c}"`).join(',');
    const rows = await source.query(`SELECT ${order} FROM ${qualified} ORDER BY ${order}`);
    const targetColumns = await writableColumns(target, qualified);
    if (canonical(columns) !== canonical(targetColumns)) throw new Error('cutover_schema_mismatch');
    if ((await target.query(`SELECT 1 FROM ${qualified} LIMIT 1`)).rows.length) throw new Error('cutover_target_not_empty');
    // Suppress target-side triggers during the bulk load — derived rows (job
    // outbox, fts mapping) are carried by the cut itself, not regenerated.
    // Same mechanism pg_restore uses; restored to 'origin' before returning.
    await target.query(`SET session_replication_role='replica'`);
    try {
        let written = 0;
        for (const row of rows.rows) {
            const values = columns.map((_, i) => `$${i + 1}`).join(',');
            // OVERRIDING SYSTEM VALUE preserves GENERATED ALWAYS AS IDENTITY
            // values — the cut carries the source's exact identifiers.
            await target.query(`INSERT INTO ${qualified}(${order}) OVERRIDING SYSTEM VALUE VALUES(${values})`,
                columns.map((c): PgValue => {
                    const v = row[c];
                    if (v === null || v === undefined) return null;
                    if (typeof v === 'object') return v instanceof Uint8Array ? v : JSON.stringify(v);
                    return v as PgValue;
                }));
            written++;
        }
        // Resync identity/serial sequences so post-cut writes never reuse a
        // copied id — pg_restore performs the same setval pass.
        for (const c of columns) {
            const seq = await target.query<{ s: string | null }>(`SELECT pg_get_serial_sequence($1,$2) AS s`, [qualified, c]);
            if (seq.rows[0]?.s)
                await target.query(`SELECT setval($1, coalesce((SELECT max("${c}") FROM ${qualified}),1))`, [seq.rows[0].s]);
        }
        return written;
    } finally { await target.query(`SET session_replication_role='origin'`); }
}

/** Recompute every seal on the target; returns the tables that differ. */
export async function verifyManifest(session: PgSession, manifest: CutoverManifest): Promise<TableSeal[]> {
    const mismatched: TableSeal[] = [];
    for (const expected of manifest.tables) {
        let actual: TableSeal;
        try { actual = await sealTable(session, expected.table); }
        catch { mismatched.push({ table: expected.table, columns: [], rows: -1, sha256: 'missing' }); continue; }
        if (actual.rows !== expected.rows || actual.sha256 !== expected.sha256
            || canonical(actual.columns) !== canonical(expected.columns)) mismatched.push(actual);
    }
    return mismatched;
}

// ---------------------------------------------------------------------------
// Payload/object layer. Row cuts carry (payload_shard_id, payload_object_key,
// payload_sha256, payload_bytes) references; the bytes live in the object store
// outside Postgres. The seal therefore needs a parallel object pass: inventory
// the live references, fetch every object, verify content digests, and record
// the result so the target store can be reconciled the same way.

export interface PayloadObjectRef { shard: string; key: string; sha256: string; bytes: number }
export interface ObjectSeal extends PayloadObjectRef { verified: boolean }
export interface PayloadSeal {
    objects: ObjectSeal[];
    /** References whose object could not be fetched or whose digest disagreed. */
    unresolved: PayloadObjectRef[];
    sha256: string;
}
/** (shard, key) → object bytes, or null when absent. R2, S3 or a fixture store. */
export type PayloadFetcher = (shard: string, key: string) => Promise<Uint8Array | null>;

/** Every live object reference. Staging/purged stages are excluded: a staging
 * object may not be uploaded yet and a purged one is already gone — both are
 * reconciliation outcomes, not cutover content. Two rows naming the same key
 * must agree on its digest; a conflict seals as unresolved. */
export async function payloadInventory(session: PgSession): Promise<PayloadObjectRef[]> {
    const r = await session.query<{ shard: string; key: string; sha256: string; bytes: number }>(
        `SELECT shard,key,sha256,bytes FROM (
          SELECT payload_shard_id AS shard,payload_object_key AS key,payload_sha256 AS sha256,payload_bytes AS bytes
            FROM memory_content.memories WHERE payload_object_key IS NOT NULL
          UNION ALL
          SELECT payload_shard_id,payload_object_key,payload_sha256,payload_bytes
            FROM memory_content.memory_versions WHERE payload_object_key IS NOT NULL
          UNION ALL
          SELECT payload_shard_id,payload_object_key,payload_sha256,payload_bytes
            FROM memory_content.payload_stages WHERE state IN ('ready','published','purge_pending')
        ) inv GROUP BY shard,key,sha256,bytes ORDER BY shard,key`);
    return r.rows.map(row => ({ shard: row.shard, key: row.key, sha256: row.sha256, bytes: Number(row.bytes) }));
}

/** Fetch every inventoried object, verify its stored digest, and seal the set. */
export async function sealPayloadObjects(session: PgSession, fetcher: PayloadFetcher): Promise<PayloadSeal> {
    const inventory = await payloadInventory(session);
    const objects: ObjectSeal[] = [];
    const unresolved: PayloadObjectRef[] = [];
    for (const ref of inventory) {
        const body = await fetcher(ref.shard, ref.key);
        if (!body || body.length !== ref.bytes
            || createHash('sha256').update(body).digest('hex') !== ref.sha256) {
            unresolved.push(ref);
            continue;
        }
        objects.push({ ...ref, verified: true });
    }
    const sha256 = createHash('sha256').update(canonical(objects.map(o => ({ shard: o.shard, key: o.key, sha256: o.sha256 })))).digest('hex');
    return { objects, unresolved, sha256 };
}

/** Re-fetch every sealed object on the target store and compare digests. */
export async function verifyPayloadObjects(seal: PayloadSeal, fetcher: PayloadFetcher): Promise<PayloadObjectRef[]> {
    const mismatched: PayloadObjectRef[] = [];
    for (const ref of seal.objects) {
        const body = await fetcher(ref.shard, ref.key);
        if (!body || body.length !== ref.bytes
            || createHash('sha256').update(body).digest('hex') !== ref.sha256) mismatched.push(ref);
    }
    return mismatched;
}

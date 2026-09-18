import { createHash } from 'node:crypto';
import type { PgSession } from './connection.ts';

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
    const [schema, name] = table.split('.');
    const r = await session.query(
        `SELECT column_name AS c FROM information_schema.columns
         WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, name]);
    if (!r.rows.length) throw new Error('cutover_table_missing');
    return r.rows.map((row: { c: string }) => row.c);
}

/** Writable columns only — generated columns recompute on the target and the
 * seal still covers them, so a wrong generation expression fails verify. */
async function writableColumns(session: PgSession, table: string): Promise<string[]> {
    const [schema, name] = table.split('.');
    const r = await session.query(
        `SELECT column_name AS c FROM information_schema.columns
         WHERE table_schema=$1 AND table_name=$2 AND is_generated='NEVER' ORDER BY ordinal_position`, [schema, name]);
    return r.rows.map((row: { c: string }) => row.c);
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
            await target.query(`INSERT INTO ${qualified}(${order}) VALUES(${values})`,
                columns.map(c => { const v = row[c]; return v === null || v === undefined ? null : (typeof v === 'object' ? JSON.stringify(v) : v); }));
            written++;
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

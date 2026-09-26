import { durableSqlReject } from './types.ts';
import { parseRecoveryReceipt, parseRecoverySummary, recoveryDigest, recoveryInteger, recoveryScopeOf } from './recovery-types.ts';
import type { RecoveryFreezeReceipt, RecoveryExportSummary } from './recovery-types.ts';
import { snapshotCanonical, validateSnapshotPlan } from './snapshot.ts';
import type { SnapshotPlan } from './snapshot.ts';

export interface RecoveryMetadataStorage {
  sql: { exec(sql: string, ...values: (string | number | null)[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(callback: () => T): T;
}
export const RECOVERY_RUNS_SCHEMA = `CREATE TABLE IF NOT EXISTS durable_sql_recovery_runs(
 run_id TEXT PRIMARY KEY,freeze_request_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,
 plan_json TEXT,summary_json TEXT,release_request_hash TEXT,released_at_ms INTEGER)`;
export const RECOVERY_ACTIVE_SCHEMA = `CREATE TABLE IF NOT EXISTS durable_sql_recovery_active(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),run_id TEXT NOT NULL)`;
export const RECOVERY_TABLE_NAMES = ['durable_sql_recovery_runs', 'durable_sql_recovery_active'] as const;
const normalize = (sql: string) => sql.replace(/\bIF\s+NOT\s+EXISTS\s+/i, '').trim();
const invalid = (): never => durableSqlReject('recovery_metadata_invalid');

/** Called only inside the caller's synchronous transaction. Unknown objects,
 * triggers and indexes in this namespace are never internal metadata. */
export function validateRecoveryCatalog(storage: RecoveryMetadataStorage): boolean {
  const catalog = storage.sql.exec("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE lower(name) GLOB 'durable_sql_recovery*' OR lower(tbl_name) GLOB 'durable_sql_recovery*'").toArray();
  if (!catalog.length) return false;
  const expected = new Map<string, string>([[RECOVERY_TABLE_NAMES[0], RECOVERY_RUNS_SCHEMA], [RECOVERY_TABLE_NAMES[1], RECOVERY_ACTIVE_SCHEMA]]);
  const found = new Set<string>();
  for (const item of catalog) {
    const name = item.name as string;
    if (item.type === 'index' && name === 'sqlite_autoindex_durable_sql_recovery_runs_1'
      && item.tbl_name === RECOVERY_TABLE_NAMES[0] && item.sql === null) continue;
    if (item.type !== 'table' || item.tbl_name !== name || !expected.has(name) || typeof item.sql !== 'string'
      || normalize(item.sql) !== normalize(expected.get(name)!) || found.has(name)) invalid();
    found.add(name);
  }
  if (found.size !== expected.size) invalid();
  return true;
}
export function initializeRecoveryMetadata(storage: RecoveryMetadataStorage): void {
  storage.transactionSync(() => {
    if (!validateRecoveryCatalog(storage)) {
      storage.sql.exec(RECOVERY_RUNS_SCHEMA).toArray();
      storage.sql.exec(RECOVERY_ACTIVE_SCHEMA).toArray();
    }
    validateRecoveryCatalog(storage);
  });
}
/** No await may occur between this check and application/import SQL. */
export function assertRecoveryUnlocked(storage: RecoveryMetadataStorage): void {
  if (readRecoveryState(storage).active !== null) durableSqlReject('durable_sql_frozen');
}
export interface RecoveryRun {
  receipt: RecoveryFreezeReceipt; planJson: string | null; summary: RecoveryExportSummary | null;
  releaseHash: string | null; releasedAtMs: number | null;
}
function storedJson(value: unknown, max: number): unknown {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > max) invalid();
  try { const result: unknown = JSON.parse(value as string); if (snapshotCanonical(result) !== value) invalid(); return result; }
  catch { return invalid(); }
}
/** Validates every retained run/lock relationship, including closed history.
 * Callers provide the synchronous transaction and never hold rows across await. */
export function readRecoveryState(storage: RecoveryMetadataStorage): { runs: Map<string, RecoveryRun>; active: string | null } {
  if (!validateRecoveryCatalog(storage)) invalid();
  const rows = storage.sql.exec('SELECT * FROM durable_sql_recovery_runs LIMIT 129').toArray();
  const active = storage.sql.exec('SELECT singleton,run_id FROM durable_sql_recovery_active LIMIT 2').toArray();
  if (rows.length > 128 || active.length > 1) invalid();
  const runs = new Map<string, RecoveryRun>();
  for (const row of rows) {
    try {
      const receipt = parseRecoveryReceipt(storedJson(row.receipt_json, 4096));
      const summary = row.summary_json === null ? null : parseRecoverySummary(storedJson(row.summary_json, 4096));
      if (receipt.runId !== row.run_id || receipt.freezeRequestHash !== row.freeze_request_hash || runs.has(receipt.runId)
        || (summary !== null && (snapshotCanonical(recoveryScopeOf(summary)) !== snapshotCanonical(recoveryScopeOf(receipt)) || summary.sourceFrozenAtMs !== receipt.frozenAtMs))
        || ((row.release_request_hash === null) !== (row.released_at_ms === null))
        || (row.release_request_hash !== null && (!recoveryDigest(row.release_request_hash) || !recoveryInteger(row.released_at_ms, receipt.frozenAtMs)))
        || (row.release_request_hash === null && (row.plan_json === null) !== (summary === null))) invalid();
      if (row.plan_json !== null) {
        const plan = storedJson(row.plan_json, 1048576) as SnapshotPlan;
        validateSnapshotPlan(plan, `sql:${receipt.identity.deploymentId}:${receipt.identity.databaseId}:${receipt.identity.epoch}`);
        if (!summary || snapshotCanonical(plan.identity) !== snapshotCanonical(receipt.identity)
          || plan.sourceRevision !== receipt.sourceRevision || plan.sourceFrozenAtMs !== receipt.frozenAtMs
          || plan.schemaHash !== summary.schemaHash || plan.snapshotHash !== summary.snapshotHash
          || plan.chunks.length !== summary.chunkCount || plan.tables.reduce((n, table) => n + table.rowCount, 0) !== summary.rowCount
          || new TextEncoder().encode(row.plan_json as string).length !== summary.planBytes) invalid();
      }
      runs.set(receipt.runId, { receipt, summary, planJson: row.plan_json as string | null, releaseHash: row.release_request_hash as string | null, releasedAtMs: row.released_at_ms as number | null });
    } catch { invalid(); }
  }
  const frozen = [...runs.values()].filter(row => row.releaseHash === null);
  if (active.length !== frozen.length || frozen.length > 1
    || (active.length && (active[0]!.singleton !== 1 || active[0]!.run_id !== frozen[0]!.receipt.runId))) invalid();
  return { runs, active: active.length ? active[0]!.run_id as string : null };
}

import type { Result } from '../release/types.ts';
import { copyDurableSqlRow, durableSqlBytes, durableSqlObjectName, durableSqlReject, DURABLE_SQL_LIMITS,
  parseDurableSqlExecution } from './types.ts';
import type { DurableSqlExecution, DurableSqlIdentity, DurableSqlStorage } from './types.ts';

/** This metadata never activates itself. The separately reviewed snapshot
 * importer owns binding, verification and the transition to ready. */
export const DURABLE_SQL_STATE_SCHEMA = `CREATE TABLE IF NOT EXISTS durable_sql_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),deployment_id TEXT NOT NULL,database_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('control','hot')),epoch INTEGER NOT NULL CHECK(epoch>=1),
 status TEXT NOT NULL CHECK(status IN ('importing','ready','failed')),schema_hash TEXT NOT NULL,snapshot_hash TEXT NOT NULL)`;

/** SQLite recognizes quoted identifiers, including legacy single-quoted table
 * names. Decode quotes and comments before checking the private namespace. A
 * semicolon is accepted only as one terminal statement delimiter. */
export function validateDurableSql(sql: string): void {
  if (sql.includes('\0')) durableSqlReject('durable_sql_statement_invalid');
  let index = 0, first: string | undefined, terminated = false;
  const reserved = (value: string) => {
    if (value.toLowerCase().startsWith('durable_sql_')) durableSqlReject('durable_sql_metadata_access');
  };
  while (index < sql.length) {
    const current = sql[index]!;
    if (/\s/.test(current)) { index++; continue; }
    if (sql.startsWith('--', index)) { const end = sql.indexOf('\n', index + 2); index = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) durableSqlReject('durable_sql_statement_invalid');
      index = end + 2; continue;
    }
    if (terminated) durableSqlReject('durable_sql_statement_invalid');
    if (current === ';') { terminated = true; index++; continue; }
    if (current === "'" || current === '"' || current === '`' || current === '[') {
      if (first === undefined) durableSqlReject('durable_sql_statement_invalid');
      const endQuote = current === '[' ? ']' : current;
      let value = '', closed = false; index++;
      while (index < sql.length) {
        const next = sql[index++]!;
        if (next !== endQuote) { value += next; continue; }
        if (current !== '[' && sql[index] === endQuote) { value += endQuote; index++; continue; }
        closed = true; break;
      }
      if (!closed) durableSqlReject('durable_sql_statement_invalid');
      reserved(value); continue;
    }
    if (/[A-Za-z_]/.test(current)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index++;
      const word = sql.slice(start, index);
      reserved(word); first ??= word.toUpperCase(); continue;
    }
    if (first === undefined) durableSqlReject('durable_sql_statement_invalid');
    index++;
  }
  if (!first || !['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE'].includes(first)) durableSqlReject('durable_sql_statement_invalid');
}

/** One execution is one synchronous transaction, including the ready/identity
 * check and every cursor read. Nothing crosses an await or can observe a mixed
 * authority snapshot. The central object is a bounded compatibility bridge. */
export class SqlDatabaseEngine {
  private readonly storage: DurableSqlStorage;
  private readonly objectName: string;
  constructor(storage: DurableSqlStorage, options: { objectName: string }) {
    this.storage = storage; this.objectName = options.objectName;
  }
  initialize(): void { this.storage.transactionSync(() => { this.storage.sql.exec(DURABLE_SQL_STATE_SCHEMA).toArray(); }); }
  private ready(identity: DurableSqlIdentity): void {
    if (this.objectName !== durableSqlObjectName(identity)) durableSqlReject('durable_sql_identity_mismatch');
    const row = this.storage.sql.exec('SELECT deployment_id,database_id,kind,epoch,status,schema_hash,snapshot_hash FROM durable_sql_state WHERE singleton=1').toArray()[0];
    if (!row) durableSqlReject('durable_sql_not_ready');
    if (row.deployment_id !== identity.deploymentId || row.database_id !== identity.databaseId || row.kind !== identity.kind || row.epoch !== identity.epoch)
      durableSqlReject('durable_sql_identity_mismatch');
    if (row.status !== 'ready' || typeof row.schema_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.schema_hash)
      || typeof row.snapshot_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.snapshot_hash)) durableSqlReject('durable_sql_not_ready');
  }
  execute(input: DurableSqlExecution): Result[] {
    const value = parseDurableSqlExecution(input);
    for (const statement of value.statements) validateDurableSql(statement.sql);
    return this.storage.transactionSync(() => {
      this.ready(value.identity);
      let consumedRows = 0, consumedBytes = 0;
      const results: Result[] = [];
      for (const statement of value.statements) {
        const cursor = this.storage.sql.exec(statement.sql, ...statement.values);
        const rows: Record<string, unknown>[] = [];
        for (const raw of cursor) {
          const row = copyDurableSqlRow(raw);
          consumedRows++; consumedBytes += durableSqlBytes(JSON.stringify(row)) + 1;
          if (consumedRows > DURABLE_SQL_LIMITS.resultRows || consumedBytes > DURABLE_SQL_LIMITS.resultBytes) durableSqlReject('durable_sql_limit');
          if (statement.mode === 'all' || (statement.mode === 'first' && rows.length === 0)) rows.push(row);
        }
        // rowsWritten includes trigger/index effects; changes() counts only the
        // top-level statement, as existing workspace writes require. A read has
        // zero changes even if the previous connection statement was a write.
        const changes = cursor.rowsWritten > 0 ? this.storage.sql.exec('SELECT changes() AS changes').toArray()[0]?.changes : 0;
        if (!Number.isSafeInteger(changes) || Number(changes) < 0) durableSqlReject('durable_sql_result_invalid');
        results.push({ success: true, results: rows, meta: { changes: Number(changes) } });
      }
      if (durableSqlBytes(JSON.stringify(results)) > DURABLE_SQL_LIMITS.resultBytes) durableSqlReject('durable_sql_limit');
      return results;
    });
  }
}

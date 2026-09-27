import type { Result, Value } from '../release/types.ts';

export interface DurableSqlIdentity {
  deploymentId: string;
  databaseId: string;
  kind: 'control' | 'hot';
  epoch: number;
}
export interface DurableSqlStatement { sql: string; values: Value[]; mode: 'all' | 'first' | 'run' }
export interface DurableSqlExecution { identity: DurableSqlIdentity; statements: DurableSqlStatement[] }
export interface DurableSqlStub { execute(input: DurableSqlExecution): Promise<Result[]> }
export interface DurableSqlCursor extends Iterable<Record<string, unknown>> {
  readonly rowsWritten: number;
  toArray(): Record<string, unknown>[];
}
export interface DurableSqlStorage {
  sql: { exec(sql: string, ...values: Value[]): DurableSqlCursor };
  transactionSync<T>(callback: () => T): T;
}

export const DURABLE_SQL_LIMITS = Object.freeze({ sqlBytes: 100_000, parameters: 100, statements: 100,
  requestBytes: 4 * 1024 * 1024, resultBytes: 4 * 1024 * 1024, resultRows: 10_000 });
export class DurableSqlError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'DurableSqlError'; this.code = code; }
}
export function durableSqlReject(code: string): never { throw new DurableSqlError(code); }
const invalid = () => durableSqlReject('durable_sql_input_invalid');
const encoder = new TextEncoder();
export function durableSqlBytes(value: string): number { return encoder.encode(value).byteLength; }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}
export function parseDurableSqlIdentity(value: unknown): DurableSqlIdentity {
  if (!exact(value, ['deploymentId', 'databaseId', 'kind', 'epoch'])) return invalid();
  const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  if (typeof value.deploymentId !== 'string' || !identifier.test(value.deploymentId)
    || typeof value.databaseId !== 'string' || !identifier.test(value.databaseId)
    || (value.kind !== 'control' && value.kind !== 'hot')
    || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1) return invalid();
  return { deploymentId: value.deploymentId, databaseId: value.databaseId, kind: value.kind, epoch: Number(value.epoch) };
}
export function durableSqlObjectName(identity: DurableSqlIdentity): string {
  const value = parseDurableSqlIdentity(identity);
  return `sql:${value.deploymentId}:${value.databaseId}:${value.epoch}`;
}
export function copyDurableSqlValues(value: unknown): Value[] {
  if (!Array.isArray(value)) return invalid();
  if (value.length > DURABLE_SQL_LIMITS.parameters) durableSqlReject('durable_sql_limit');
  return Array.from(value, item => {
    if (item === null || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (typeof item === 'string') {
      if (durableSqlBytes(item) > DURABLE_SQL_LIMITS.requestBytes) durableSqlReject('durable_sql_limit');
      return item;
    }
    return invalid();
  });
}
export function parseDurableSqlStatement(value: unknown): DurableSqlStatement {
  if (!exact(value, ['sql', 'values', 'mode']) || typeof value.sql !== 'string' || value.sql.length === 0
    || typeof value.mode !== 'string' || !['all', 'first', 'run'].includes(value.mode)) return invalid();
  if (durableSqlBytes(value.sql) > DURABLE_SQL_LIMITS.sqlBytes) durableSqlReject('durable_sql_limit');
  return { sql: value.sql, values: copyDurableSqlValues(value.values), mode: value.mode as DurableSqlStatement['mode'] };
}
export function parseDurableSqlExecution(value: unknown): DurableSqlExecution {
  if (!exact(value, ['identity', 'statements']) || !Array.isArray(value.statements)) return invalid();
  if (value.statements.length < 1 || value.statements.length > DURABLE_SQL_LIMITS.statements) durableSqlReject('durable_sql_limit');
  const parsed = { identity: parseDurableSqlIdentity(value.identity), statements: Array.from(value.statements, parseDurableSqlStatement) };
  if (durableSqlBytes(JSON.stringify(parsed)) > DURABLE_SQL_LIMITS.requestBytes) durableSqlReject('durable_sql_limit');
  return parsed;
}

export function copyDurableSqlRow(value: unknown): Record<string, Value> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) durableSqlReject('durable_sql_result_invalid');
  const entries = Object.entries(value);
  if (entries.some(([, item]) => item !== null && typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item))))
    durableSqlReject('durable_sql_result_invalid');
  return Object.fromEntries(entries) as Record<string, Value>;
}
/** RPC responses are bounded again in the caller; no raw backend diagnostics or
 * arbitrary host objects can be returned as application data. */
export function copyDurableSqlResults(value: unknown, statements: DurableSqlStatement[]): Result[] {
  if (!Array.isArray(value) || value.length !== statements.length) durableSqlReject('durable_sql_result_invalid');
  let rows = 0;
  const results = Array.from(value, (item, index) => {
    if (!exact(item, ['success', 'results', 'meta']) || item.success !== true || !Array.isArray(item.results)
      || !exact(item.meta, ['changes']) || !Number.isSafeInteger(item.meta.changes) || Number(item.meta.changes) < 0)
      durableSqlReject('durable_sql_result_invalid');
    rows += item.results.length;
    if (rows > DURABLE_SQL_LIMITS.resultRows) durableSqlReject('durable_sql_limit');
    if ((statements[index]!.mode === 'first' && item.results.length > 1) || (statements[index]!.mode === 'run' && item.results.length > 0))
      durableSqlReject('durable_sql_result_invalid');
    return { success: true, results: Array.from(item.results, copyDurableSqlRow), meta: { changes: Number(item.meta.changes) } };
  });
  if (durableSqlBytes(JSON.stringify(results)) > DURABLE_SQL_LIMITS.resultBytes) durableSqlReject('durable_sql_limit');
  return results;
}

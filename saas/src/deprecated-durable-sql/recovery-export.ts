import { snapshotCanonical, snapshotHash, validateSnapshotPlan } from './snapshot.ts';
import type { SnapshotPlan, SnapshotSchema, SnapshotTable, SnapshotValue } from './snapshot.ts';
import type { DurableSqlStorage } from './types.ts';
import { durableSqlObjectName } from './types.ts';
import { parseRecoveryReceipt, recoveryInteger, recoveryReject, recoveryScopeOf } from './recovery-types.ts';
import type { RecoveryFreezeReceipt, RecoveryExportSummary } from './recovery-types.ts';
import { validateRecoveryCatalog, RECOVERY_TABLE_NAMES } from './recovery-state.ts';

export interface CollectedRecoverySnapshot {
  receipt: RecoveryFreezeReceipt;
  planWithoutHashes: Omit<SnapshotPlan, 'schemaHash' | 'snapshotHash' | 'chunks'>;
  chunks: { table: string; start: number; rows: SnapshotValue[][] }[];
}
const enc = new TextEncoder();
const limits = { objects: 600, planBytes: 1048576, tables: 128, rows: 100000, totalBytes: 16777216, chunks: 1000, chunkRows: 500, chunkBytes: 524288 };
const providers = new Set(['__cf_kv']);
const internals = new Set<string>(['durable_sql_state', 'durable_sql_import', 'durable_sql_import_rows', ...RECOVERY_TABLE_NAMES]);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const size = (value: unknown) => enc.encode(snapshotCanonical(value)).byteLength;
const changed = (): never => recoveryReject('recovery_source_changed');
const capacity = (): never => recoveryReject('recovery_capacity');
const internal = (name: string) => providers.has(name) || internals.has(name);
function catalog(storage: DurableSqlStorage): { schema: SnapshotSchema[]; sequence: boolean } {
  if (!validateRecoveryCatalog(storage)) recoveryReject('recovery_metadata_invalid');
  const raw: SnapshotSchema[] = [];
  let bytes = 2;
  for (const item of storage.sql.exec('SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid LIMIT 1001')) {
    if (raw.length >= 1000) capacity();
    if (!identifier(item.name) || !identifier(item.tableName) || typeof item.sql !== 'string'
      || !['table', 'index', 'view', 'trigger'].includes(item.type as string)) changed();
    if (enc.encode(item.sql as string).byteLength > 100000) capacity();
    bytes += size(item) + 1;
    // Includes internal/shadow DDL, so unsupported giant catalogs cannot hide
    // behind filtering before the retained schema limit is applied.
    if (bytes > limits.planBytes) capacity();
    const name = item.name as string, tableName = item.tableName as string;
    if ((/^durable_sql_/i.test(name) && !internals.has(name))
      || (/^durable_sql_/i.test(tableName) && !internals.has(tableName))) recoveryReject('recovery_metadata_invalid');
    if ((internal(name) || internal(tableName)) && (item.type !== 'table' || name !== tableName)) changed();
    raw.push({ type: item.type as SnapshotSchema['type'], name, tableName, sql: item.sql as string });
  }
  const virtual = raw.filter(item => item.type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(item.sql));
  // The supported FTS mode uses SQLite's default owned shadow tables. An
  // explicit columnsize option can leave a preexisting docsize-named table
  // unused, so neither its name nor even its exact DDL proves FTS ownership.
  for (const item of virtual) if (!/\bUSING\s+fts5\s*\(/i.test(item.sql)
    || /\b(?:content|columnsize)\s*=/i.test(item.sql)) changed();
  const shadows = new Set<string>();
  for (const item of virtual) {
    const visible = columns(storage, item.name, raw).length - 1;
    const definitions: Record<string, string> = {
      data: '(id INTEGER PRIMARY KEY, block BLOB)',
      idx: '(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID',
      content: '(id INTEGER PRIMARY KEY' + Array.from({ length: visible }, (_, index) => ', c' + index).join('') + ')',
      docsize: '(id INTEGER PRIMARY KEY, sz BLOB)',
      config: '(k PRIMARY KEY, v) WITHOUT ROWID',
    };
    for (const [suffix, definition] of Object.entries(definitions)) {
      const name = item.name + '_' + suffix, found = raw.find(row => row.name === name);
      // FTS reserves suffix names even if a table with that name predates the
      // virtual table. Only the exact SQLite-created definition is omittable.
      if (found && (found.type !== 'table' || found.tableName !== name
        || found.sql !== `CREATE TABLE '${name}'${definition}`)) changed();
      if (found) shadows.add(name);
    }
  }
  const schema: SnapshotSchema[] = [];
  for (const item of raw) {
    if (internal(item.name)) continue;
    if (item.name === 'sqlite_sequence' && item.type === 'table') continue;
    if (shadows.has(item.name)) { if (item.type !== 'table' || item.name !== item.tableName) changed(); continue; }
    if (shadows.has(item.tableName) || /^(sqlite_|__cf_)/i.test(item.name) || /^(sqlite_|__cf_)/i.test(item.tableName)) changed();
    if (schema.length >= limits.objects) capacity();
    schema.push(item);
  }
  if (!schema.length || size(schema) > limits.planBytes) changed();
  return { schema, sequence: raw.some(item => item.name === 'sqlite_sequence' && item.type === 'table') };
}
function columns(storage: DurableSqlStorage, name: string, schema: SnapshotSchema[]): string[] {
  if (schema.some(item => item.name === name && /\bWITHOUT\s+ROWID\b/i.test(item.sql))) changed();
  const result = ['rowid'];
  for (const row of storage.sql.exec(`PRAGMA table_info(${quote(name)})`)) {
    if (!identifier(row.name) || ['rowid', '_rowid_', 'oid'].includes((row.name as string).toLowerCase())
      || result.some(column => column.toLowerCase() === (row.name as string).toLowerCase())) changed();
    if (result.length >= 99) capacity();
    result.push(row.name as string);
  }
  if (result.length < 2) changed();
  return result;
}
function retainedSequence(row: Record<string, unknown>, schema: SnapshotSchema[]): boolean {
  if (typeof row.name !== 'string') changed();
  if (internal(row.name as string)) return false;
  if (!schema.some(item => item.type === 'table' && item.name === row.name && /\bAUTOINCREMENT\b/i.test(item.sql))
    || !recoveryInteger(row.seq)) changed();
  return true;
}
function valuesOf(row: Record<string, unknown>, table: SnapshotTable): SnapshotValue[] {
  if (!Number.isSafeInteger(row.rowid)) changed();
  return table.columns.map(column => {
    const value = row[column];
    if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value)))) return value;
    return changed();
  });
}
function rowsCursor(storage: DurableSqlStorage, table: SnapshotTable) {
  return storage.sql.exec(`SELECT ${table.columns.map(column => quote(column) + ' AS ' + quote(column)).join(',')} FROM ${quote(table.name)} ORDER BY rowid`);
}

/** Synchronous and transaction-only. Every cursor is consumed before hashing;
 * no customer-row copy is ever written into recovery metadata. */
export function collectRecoverySnapshot(storage: DurableSqlStorage, suppliedReceipt: RecoveryFreezeReceipt): CollectedRecoverySnapshot {
  try {
    const receipt = parseRecoveryReceipt(suppliedReceipt), observed = catalog(storage);
    const names = observed.schema.filter(item => item.type === 'table').map(item => item.name);
    if (observed.sequence) names.push('sqlite_sequence');
    if (!names.length || names.length > limits.tables) capacity();
    const tables: SnapshotTable[] = [], chunks: CollectedRecoverySnapshot['chunks'] = [];
    let totalRows = 0, totalBytes = 0;
    for (const name of names) {
      const table: SnapshotTable = { name, columns: columns(storage, name, observed.schema), rowCount: 0 };
      let pending: SnapshotValue[][] = [], pendingBytes = 2, start = 0, lastRowid: number | undefined, observedRows = 0;
      const flush = () => {
        if (!pending.length) return;
        if (chunks.length >= limits.chunks || totalBytes + pendingBytes > limits.totalBytes) capacity();
        totalBytes += pendingBytes; chunks.push({ table: name, start, rows: pending });
        start += pending.length; pending = []; pendingBytes = 2;
      };
      for (const row of rowsCursor(storage, table)) {
        if (++observedRows > limits.rows || !Number.isSafeInteger(row.rowid)
          || (lastRowid !== undefined && Number(row.rowid) <= lastRowid)) capacity();
        lastRowid = Number(row.rowid);
        if (name === 'sqlite_sequence' && !retainedSequence(row, observed.schema)) continue;
        const values = valuesOf(row, table), rowBytes = size(values);
        if (rowBytes + 2 > limits.chunkBytes || ++totalRows > limits.rows) capacity();
        if (pending.length >= limits.chunkRows || pendingBytes + rowBytes + (pending.length ? 1 : 0) > limits.chunkBytes) flush();
        if (totalBytes + pendingBytes + rowBytes + (pending.length ? 1 : 0) > limits.totalBytes) capacity();
        pendingBytes += rowBytes + (pending.length ? 1 : 0); pending.push(values); table.rowCount++;
      }
      flush(); tables.push(table);
    }
    const planWithoutHashes: CollectedRecoverySnapshot['planWithoutHashes'] = { version: 1, identity: { ...receipt.identity }, schema: observed.schema, tables,
      sourceRevision: receipt.sourceRevision, sourceFrozenAtMs: receipt.frozenAtMs };
    const projected = { ...planWithoutHashes, schemaHash: '0'.repeat(64), snapshotHash: '0'.repeat(64),
      chunks: chunks.map((chunk, index) => ({ index, table: chunk.table, start: chunk.start, rowCount: chunk.rows.length, hash: '0'.repeat(64) })) };
    if (size(projected) > limits.planBytes) capacity();
    validateSnapshotPlan(projected, durableSqlObjectName(receipt.identity));
    return { receipt, planWithoutHashes, chunks };
  } catch (error) {
    if (error instanceof Error && /^recovery_(capacity|source_changed|metadata_invalid)$/.test(error.message)) throw error;
    return changed();
  }
}
/** Pure asynchronous hashing: no storage, network or mutable run lookup. */
export async function finalizeRecoverySnapshot(collected: CollectedRecoverySnapshot): Promise<{ plan: SnapshotPlan; summary: RecoveryExportSummary }> {
  const chunks: SnapshotPlan['chunks'] = [];
  let rowBytes = 0;
  for (const chunk of collected.chunks) {
    rowBytes += size(chunk.rows);
    chunks.push({ index: chunks.length, table: chunk.table, start: chunk.start, rowCount: chunk.rows.length, hash: await snapshotHash(chunk.rows) });
  }
  const plan: SnapshotPlan = { ...collected.planWithoutHashes, chunks, schemaHash: await snapshotHash(collected.planWithoutHashes.schema),
    snapshotHash: await snapshotHash({ tables: collected.planWithoutHashes.tables, chunks }) };
  validateSnapshotPlan(plan, durableSqlObjectName(collected.receipt.identity));
  const planBytes = size(plan);
  return { plan, summary: { ...recoveryScopeOf(collected.receipt), version: 1, planHash: await snapshotHash(plan), schemaHash: plan.schemaHash,
    snapshotHash: plan.snapshotHash, planBytes, manifestPages: Math.ceil(planBytes / 262144), chunkCount: chunks.length,
    rowCount: plan.tables.reduce((sum, table) => sum + table.rowCount, 0), rowBytes, sourceFrozenAtMs: collected.receipt.frozenAtMs } };
}
/** Descriptor indices count retained rows, including filtered sqlite_sequence.
 * This query supplies no caller-controlled SQL, name, range or continuation. */
export function readCollectedChunk(storage: DurableSqlStorage, plan: SnapshotPlan, index: number): SnapshotValue[][] {
  try {
    const descriptor = plan.chunks[index], table = plan.tables.find(item => item.name === descriptor?.table);
    if (!descriptor || !table) recoveryReject('recovery_part');
    const result: SnapshotValue[][] = [];
    let retained = 0, observed = 0, bytes = 2;
    for (const row of rowsCursor(storage, table!)) {
      if (++observed > limits.rows) capacity();
      if (table!.name === 'sqlite_sequence' && !retainedSequence(row, plan.schema)) continue;
      if (retained++ < descriptor!.start) continue;
      const values = valuesOf(row, table!), rowBytes = size(values);
      bytes += rowBytes + (result.length ? 1 : 0);
      if (bytes > limits.chunkBytes) capacity();
      result.push(values);
      if (result.length === descriptor!.rowCount) break;
    }
    if (result.length !== descriptor!.rowCount) changed();
    return result;
  } catch (error) {
    if (error instanceof Error && /^recovery_(capacity|source_changed|part)$/.test(error.message)) throw error;
    return changed();
  }
}

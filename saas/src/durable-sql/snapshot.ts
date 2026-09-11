/** Operator-only, signed snapshot restoration. Never exposed as an application
 * HTTP route. Historical command rows are copied before live triggers exist. */
import { assertRecoveryUnlocked, initializeRecoveryMetadata, RECOVERY_TABLE_NAMES, validateRecoveryCatalog } from './recovery-state.ts';
export type SnapshotValue = string | number | null;
export interface SnapshotIdentity { deploymentId: string; databaseId: string; kind: 'control' | 'hot'; epoch: number }
export interface SnapshotSchema { type: 'table' | 'index' | 'view' | 'trigger'; name: string; tableName: string; sql: string }
export interface SnapshotTable { name: string; columns: string[]; rowCount: number }
export interface SnapshotChunk { index: number; table: string; start: number; rowCount: number; hash: string }
export interface SnapshotPlan {
  version: 1; identity: SnapshotIdentity; schema: SnapshotSchema[]; tables: SnapshotTable[]; chunks: SnapshotChunk[];
  schemaHash: string; snapshotHash: string; sourceRevision: string; sourceFrozenAtMs: number;
}
export interface SnapshotGrant { planHash: string; notBeforeMs: number; expiresAtMs: number; signature: string }
interface SnapshotStorage {
  sql: { exec(sql: string, ...values: SnapshotValue[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(callback: () => T): T;
}
const enc = new TextEncoder(), MAX_CHUNK_BYTES = 524288, MAX_TOTAL_BYTES = 16 * 1024 * 1024, MAX_ROWS = 100000;
function fail(code: string): never { throw new Error(code); }
const ident = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
const publicName = (value: unknown): value is string => ident(value) && !/^(durable_sql_|sqlite_|__cf_)/i.test(value);
const digestName = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const q = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
export function snapshotCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(snapshotCanonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + snapshotCanonical(record[key])).join(',') + '}';
  }
  return fail('snapshot_manifest');
}
export async function snapshotHash(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(snapshotCanonical(value))));
  return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}
function decode(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('snapshot_authorization');
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); } catch { return fail('snapshot_authorization'); }
  if (bytes.length !== length || btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== value) fail('snapshot_authorization');
  return bytes;
}
function identityValid(identity: SnapshotIdentity, objectName: string): void {
  if (!exact(identity, ['deploymentId', 'databaseId', 'kind', 'epoch'])
    || ![identity.deploymentId, identity.databaseId].every(x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x))
    || !['control', 'hot'].includes(identity.kind) || !integer(identity.epoch, 1, Number.MAX_SAFE_INTEGER)
    || objectName !== `sql:${identity.deploymentId}:${identity.databaseId}:${identity.epoch}`) fail('snapshot_identity');
}
function validatePlan(plan: SnapshotPlan, objectName: string): void {
  if (!exact(plan, ['version', 'identity', 'schema', 'tables', 'chunks', 'schemaHash', 'snapshotHash', 'sourceRevision', 'sourceFrozenAtMs'])
    || plan.version !== 1 || !digestName(plan.schemaHash) || !digestName(plan.snapshotHash)
    || !/^[a-f0-9]{40}$/.test(plan.sourceRevision) || !integer(plan.sourceFrozenAtMs, 0, Number.MAX_SAFE_INTEGER)
    || !Array.isArray(plan.schema) || !plan.schema.length || plan.schema.length > 600
    || !Array.isArray(plan.tables) || !plan.tables.length || plan.tables.length > 128
    || !Array.isArray(plan.chunks) || plan.chunks.length > 1000 || enc.encode(snapshotCanonical(plan)).length > 1048576) fail('snapshot_manifest');
  identityValid(plan.identity, objectName);
  const names = new Set<string>();
  for (const item of plan.schema) {
    if (!exact(item, ['type', 'name', 'tableName', 'sql']) || !['table', 'index', 'view', 'trigger'].includes(item.type)
      || !publicName(item.name) || !publicName(item.tableName) || names.has(item.name.toLowerCase()) || typeof item.sql !== 'string'
      || enc.encode(item.sql).length > 100000 || /\bdurable_sql_|\b__cf_/i.test(item.sql)) fail('snapshot_manifest');
    // The signed plan pins the complete DDL, including the source's runtime
    // guards. Only CREATE definitions of the declared object can enter it.
    const prefix = item.type === 'table' ? '(?:VIRTUAL\\s+)?TABLE' : item.type === 'index' ? '(?:UNIQUE\\s+)?INDEX' : item.type;
    const match = new RegExp('^CREATE\\s+' + prefix + '\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"([A-Za-z_][A-Za-z0-9_]*)"|`([A-Za-z_][A-Za-z0-9_]*)`|\\[([A-Za-z_][A-Za-z0-9_]*)\\]|([A-Za-z_][A-Za-z0-9_]*))(?=\\s|\\()', 'i').exec(item.sql.trim());
    if (!match || (match[1] ?? match[2] ?? match[3] ?? match[4]) !== item.name) fail('snapshot_manifest');
    if (item.type === 'table' && item.name !== item.tableName) fail('snapshot_manifest');
    if (item.type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(item.sql.trim())
      && (!/\bUSING\s+fts5\s*\(/i.test(item.sql) || /\bcontent\s*=/i.test(item.sql))) fail('snapshot_manifest');
    names.add(item.name.toLowerCase());
  }
  const tables = new Map<string, SnapshotTable>(), next = new Map<string, number>();
  let total = 0;
  for (const table of plan.tables) {
    if (!exact(table, ['name', 'columns', 'rowCount']) || (!publicName(table.name) && table.name !== 'sqlite_sequence')
      || tables.has(table.name) || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 100
      || table.columns.some(column => !ident(column)) || new Set(table.columns.map(x => x.toLowerCase())).size !== table.columns.length
      || !integer(table.rowCount, 0, MAX_ROWS)
      || (table.name !== 'sqlite_sequence' && !plan.schema.some(s => s.type === 'table' && s.name === table.name))) fail('snapshot_manifest');
    tables.set(table.name, table); next.set(table.name, 0); total += table.rowCount;
  }
  if (total > MAX_ROWS || plan.schema.some(s => s.type === 'table' && !tables.has(s.name))) fail('snapshot_manifest');
  for (const [index, chunk] of plan.chunks.entries()) {
    if (!exact(chunk, ['index', 'table', 'start', 'rowCount', 'hash']) || chunk.index !== index || !tables.has(chunk.table)
      || !integer(chunk.start, 0, MAX_ROWS) || chunk.start !== next.get(chunk.table) || !integer(chunk.rowCount, 1, 500)
      || !digestName(chunk.hash)) fail('snapshot_manifest');
    next.set(chunk.table, chunk.start + chunk.rowCount);
  }
  if (plan.tables.some(t => next.get(t.name) !== t.rowCount)) fail('snapshot_manifest');
}
export { validatePlan as validateSnapshotPlan };

export class SnapshotImporter {
  private readonly storage: SnapshotStorage;
  private readonly options: { objectName: string; publicKey: string; clock?: () => number };
  constructor(storage: SnapshotStorage, options: { objectName: string; publicKey: string; clock?: () => number }) { this.storage = storage; this.options = options; }
  initialize(): void {
    initializeRecoveryMetadata(this.storage);
    this.storage.transactionSync(() => {
      this.storage.sql.exec('CREATE TABLE IF NOT EXISTS durable_sql_import(singleton INTEGER PRIMARY KEY CHECK(singleton=1),plan_hash TEXT NOT NULL,plan_json TEXT NOT NULL,next_chunk INTEGER NOT NULL,total_bytes INTEGER NOT NULL,sealed_at_ms INTEGER)').toArray();
      this.storage.sql.exec('CREATE TABLE IF NOT EXISTS durable_sql_import_rows(chunk_index INTEGER PRIMARY KEY,table_name TEXT NOT NULL,start_row INTEGER NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL)').toArray();
    });
  }
  private now(): number { return (this.options.clock ?? Date.now)(); }
  private time(grant: SnapshotGrant): void {
    const now = this.now();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER) || now < grant.notBeforeMs || now >= grant.expiresAtMs) fail('snapshot_authorization');
  }
  private async authorize(grant: SnapshotGrant, planHash: string): Promise<void> {
    if (!exact(grant, ['planHash', 'notBeforeMs', 'expiresAtMs', 'signature']) || !digestName(planHash) || grant.planHash !== planHash
      || !integer(grant.notBeforeMs, 0, Number.MAX_SAFE_INTEGER) || !integer(grant.expiresAtMs, 1, Number.MAX_SAFE_INTEGER)
      || grant.expiresAtMs <= grant.notBeforeMs || grant.expiresAtMs - grant.notBeforeMs > 1800000 || typeof grant.signature !== 'string') fail('snapshot_authorization');
    this.time(grant);
    try {
      const key = await crypto.subtle.importKey('spki', decode(this.options.publicKey, 44), { name: 'Ed25519' }, false, ['verify']);
      const payload = { planHash, notBeforeMs: grant.notBeforeMs, expiresAtMs: grant.expiresAtMs };
      if (!await crypto.subtle.verify('Ed25519', key, decode(grant.signature, 64), enc.encode(snapshotCanonical(payload)))) fail('snapshot_authorization');
    } catch { fail('snapshot_authorization'); }
    this.time(grant);
  }
  private stored(planHash: string): { plan: SnapshotPlan; next: number; bytes: number; sealed: boolean } {
    const row = this.storage.sql.exec('SELECT * FROM durable_sql_import WHERE singleton=1').toArray()[0];
    if (!row || row.plan_hash !== planHash) fail('snapshot_conflict');
    if (this.storage.sql.exec('SELECT status FROM durable_sql_state WHERE singleton=1').toArray()[0]?.status === 'failed') fail('snapshot_closed');
    return { plan: JSON.parse(row.plan_json as string) as SnapshotPlan, next: row.next_chunk as number, bytes: row.total_bytes as number, sealed: row.sealed_at_ms !== null };
  }
  async begin(input: SnapshotPlan, authorization: SnapshotGrant): Promise<{ planHash: string; replayed: boolean }> {
    // Copy all caller-owned values before the first await.
    const plan = JSON.parse(snapshotCanonical(input)) as SnapshotPlan, grant = { ...authorization };
    validatePlan(plan, this.options.objectName);
    const planHash = await snapshotHash(plan);
    await this.authorize(grant, planHash);
    if (plan.schemaHash !== await snapshotHash(plan.schema) || plan.snapshotHash !== await snapshotHash({ tables: plan.tables, chunks: plan.chunks })) fail('snapshot_manifest');
    return this.storage.transactionSync(() => {
      this.time(grant);
      assertRecoveryUnlocked(this.storage);
      const prior = this.storage.sql.exec('SELECT plan_hash FROM durable_sql_import WHERE singleton=1').toArray()[0];
      if (prior) { if (prior.plan_hash !== planHash) fail('snapshot_conflict'); return { planHash, replayed: true }; }
      const existing = this.storage.sql.exec("SELECT name FROM sqlite_master WHERE lower(name) NOT IN ('durable_sql_state','durable_sql_import','durable_sql_import_rows','durable_sql_recovery_runs','durable_sql_recovery_active','__cf_kv') AND NOT (lower(name) GLOB 'sqlite_autoindex_durable_sql_*' AND lower(tbl_name) IN ('durable_sql_state','durable_sql_import','durable_sql_import_rows','durable_sql_recovery_runs','durable_sql_recovery_active'))").toArray();
      if (existing.length || this.storage.sql.exec('SELECT singleton FROM durable_sql_state').toArray().length
        || this.storage.sql.exec('SELECT run_id FROM durable_sql_recovery_runs LIMIT 1').toArray().length) fail('snapshot_target_not_empty');
      const x = plan.identity;
      this.storage.sql.exec("INSERT INTO durable_sql_state VALUES(1,?,?,?,?, 'importing',?,?)", x.deploymentId, x.databaseId, x.kind, x.epoch, plan.schemaHash, plan.snapshotHash).toArray();
      this.storage.sql.exec('INSERT INTO durable_sql_import VALUES(1,?,?,0,0,NULL)', planHash, snapshotCanonical(plan)).toArray();
      return { planHash, replayed: false };
    });
  }
  async append(input: { planHash: string; index: number; rows: SnapshotValue[][] }, authorization: SnapshotGrant): Promise<{ replayed: boolean; nextChunk: number }> {
    if (!exact(input, ['planHash', 'index', 'rows']) || !integer(input.index, 0, 999) || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 500) fail('snapshot_chunk');
    const payload = snapshotCanonical(input.rows), bytes = enc.encode(payload).length, rows = JSON.parse(payload) as SnapshotValue[][];
    if (bytes > MAX_CHUNK_BYTES || rows.some(row => !Array.isArray(row) || row.length > 100 || row.some(v => v !== null && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)))))) fail('snapshot_chunk');
    const planHash = input.planHash, index = input.index, grant = { ...authorization }, chunkHash = await snapshotHash(rows);
    await this.authorize(grant, planHash);
    return this.storage.transactionSync(() => {
      this.time(grant);
      assertRecoveryUnlocked(this.storage);
      const current = this.stored(planHash), chunk = current.plan.chunks[index];
      if (current.sealed) fail('snapshot_closed');
      if (!chunk || chunk.hash !== chunkHash || chunk.rowCount !== rows.length) fail('snapshot_chunk_hash');
      const table = current.plan.tables.find(t => t.name === chunk.table)!;
      if (rows.some(row => row.length !== table.columns.length)) fail('snapshot_chunk');
      if (index < current.next) {
        const prior = this.storage.sql.exec('SELECT payload,hash FROM durable_sql_import_rows WHERE chunk_index=?', index).toArray()[0];
        if (!prior || prior.hash !== chunkHash || prior.payload !== payload) fail('snapshot_chunk_hash');
        return { replayed: true, nextChunk: current.next };
      }
      if (index !== current.next) fail('snapshot_chunk_order');
      if (current.bytes + bytes > MAX_TOTAL_BYTES) fail('snapshot_capacity');
      this.storage.sql.exec('INSERT INTO durable_sql_import_rows VALUES(?,?,?,?,?)', index, chunk.table, chunk.start, payload, chunkHash).toArray();
      this.storage.sql.exec('UPDATE durable_sql_import SET next_chunk=next_chunk+1,total_bytes=total_bytes+? WHERE singleton=1', bytes).toArray();
      return { replayed: false, nextChunk: index + 1 };
    });
  }
  async seal(input: { planHash: string }, authorization: SnapshotGrant): Promise<{ ready: true; rows: number; snapshotHash: string }> {
    if (!exact(input, ['planHash'])) fail('snapshot_manifest');
    const planHash = input.planHash, grant = { ...authorization };
    await this.authorize(grant, planHash);
    return this.storage.transactionSync(() => {
      this.time(grant);
      assertRecoveryUnlocked(this.storage);
      const current = this.stored(planHash), plan = current.plan, rows = plan.tables.reduce((sum, table) => sum + table.rowCount, 0);
      if (current.sealed) return { ready: true, rows, snapshotHash: plan.snapshotHash };
      if (current.next !== plan.chunks.length) fail('snapshot_incomplete');
      // One transaction covers all constraints and activation. Foreign keys
      // remain enabled, but references may point to a later table/chunk.
      this.storage.sql.exec('PRAGMA defer_foreign_keys=ON').toArray();
      for (const item of plan.schema.filter(s => s.type === 'table')) this.storage.sql.exec(item.sql).toArray();
      for (const table of plan.tables) {
        const actual = this.storage.sql.exec(`PRAGMA table_info(${q(table.name)})`).toArray().map(row => row.name as string);
        const supplied = table.columns.filter(column => column !== 'rowid');
        if (snapshotCanonical(actual) !== snapshotCanonical(supplied)) fail('snapshot_columns');
        if (table.name === 'sqlite_sequence') this.storage.sql.exec('DELETE FROM sqlite_sequence').toArray();
        const sql = `INSERT INTO ${q(table.name)}(${table.columns.map(q).join(',')}) VALUES(${table.columns.map(() => '?').join(',')})`;
        const chunks = this.storage.sql.exec('SELECT payload FROM durable_sql_import_rows WHERE table_name=? ORDER BY start_row', table.name).toArray();
        let inserted = 0;
        for (const chunk of chunks) {
          const values = JSON.parse(chunk.payload as string) as SnapshotValue[][];
          for (const row of values) { this.storage.sql.exec(sql, ...row).toArray(); inserted++; }
        }
        if (inserted !== table.rowCount || this.storage.sql.exec(`SELECT count(*) AS n FROM ${q(table.name)}`).toArray()[0]?.n !== table.rowCount) fail('snapshot_row_count');
        // Compare exact copied values before live triggers are installed. The
        // exporter orders by and includes rowid when the table has one.
        const actualRows = this.storage.sql.exec(`SELECT ${table.columns.map(column => q(column) + ' AS ' + q(column)).join(',')} FROM ${q(table.name)} ORDER BY rowid`).toArray();
        let offset = 0;
        for (const chunk of chunks) for (const expected of JSON.parse(chunk.payload as string) as SnapshotValue[][]) {
          const found = actualRows[offset++]!;
          if (snapshotCanonical(table.columns.map(column => found[column])) !== snapshotCanonical(expected)) fail('snapshot_value_mismatch');
        }
      }
      if (this.storage.sql.exec('PRAGMA foreign_key_check').toArray().length) fail('snapshot_foreign_keys');
      for (const item of plan.schema.filter(s => s.type !== 'table')) this.storage.sql.exec(item.sql).toArray();
      for (const item of plan.schema) {
        const found = this.storage.sql.exec('SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?', item.name).toArray()[0];
        if (!found || found.type !== item.type || found.tbl_name !== item.tableName || found.sql !== item.sql.trim().replace(/;$/, '')) fail('snapshot_schema_mismatch');
      }
      const expectedNames = new Set(plan.schema.map(item => item.name));
      if (plan.tables.some(table => table.name === 'sqlite_sequence')) expectedNames.add('sqlite_sequence');
      for (const item of plan.schema.filter(item => item.type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(item.sql))) {
        for (const suffix of ['data', 'idx', 'content', 'docsize', 'config']) expectedNames.add(item.name + '_' + suffix);
      }
      validateRecoveryCatalog(this.storage);
      for (const name of RECOVERY_TABLE_NAMES) expectedNames.add(name);
      for (const item of this.storage.sql.exec('SELECT name,tbl_name,sql FROM sqlite_master').toArray()) {
        const name = item.name as string;
        if (['durable_sql_state', 'durable_sql_import', 'durable_sql_import_rows', '__cf_kv'].includes(name)
          || (item.sql === null && name.startsWith('sqlite_autoindex_') && expectedNames.has(item.tbl_name as string))) continue;
        if (!expectedNames.has(name)) fail('snapshot_schema_mismatch');
      }
      this.time(grant);
      this.storage.sql.exec("UPDATE durable_sql_state SET status='ready' WHERE singleton=1 AND status='importing'").toArray();
      this.storage.sql.exec('UPDATE durable_sql_import SET sealed_at_ms=? WHERE singleton=1', this.now()).toArray();
      // Avoid retaining a second plaintext copy after successful activation.
      this.storage.sql.exec('DELETE FROM durable_sql_import_rows').toArray();
      return { ready: true, rows, snapshotHash: plan.snapshotHash };
    });
  }
  async abandon(input: { planHash: string }, authorization: SnapshotGrant): Promise<{ abandoned: true }> {
    if (!exact(input, ['planHash'])) fail('snapshot_manifest');
    const planHash = input.planHash, grant = { ...authorization };
    await this.authorize(grant, planHash);
    return this.storage.transactionSync(() => {
      this.time(grant);
      assertRecoveryUnlocked(this.storage);
      const imported = this.storage.sql.exec('SELECT plan_hash,sealed_at_ms FROM durable_sql_import WHERE singleton=1').toArray()[0];
      if (!imported || imported.plan_hash !== planHash) fail('snapshot_conflict');
      const state = this.storage.sql.exec('SELECT status FROM durable_sql_state WHERE singleton=1').toArray()[0];
      if (imported.sealed_at_ms !== null || !state || !['importing', 'failed'].includes(state.status as string)) fail('snapshot_closed');
      this.storage.sql.exec('DELETE FROM durable_sql_import_rows').toArray();
      this.storage.sql.exec("UPDATE durable_sql_state SET status='failed' WHERE singleton=1").toArray();
      return { abandoned: true };
    });
  }
}

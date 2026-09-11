import { parseDurableSqlIdentity, durableSqlObjectName } from '../src/durable-sql/types.ts';
import { snapshotCanonical, snapshotHash, validateSnapshotPlan } from '../src/durable-sql/snapshot.ts';
import { createHash } from 'node:crypto';

const limits = Object.freeze({ totalBytes: 16 * 1024 * 1024, rows: 100000, chunkBytes: 524288, chunkRows: 500, chunks: 1000 });
const providerTables = new Set(['_cf_kv', '_cf_metadata', 'd1_migrations', '__cf_kv']);
const identifier = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const size = value => new TextEncoder().encode(snapshotCanonical(value)).byteLength;
const fail = code => { throw new Error(code); };
const omitted = name => providerTables.has(name.toLowerCase()) || /^(durable_sql_|sqlite_)/i.test(name);
function valueAllowed(value) {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value)));
}
function options(input) {
  if (!input || typeof input !== 'object' || !input.freeze || input.freeze.confirmed !== true
    || typeof input.freeze.evidenceRef !== 'string' || input.freeze.evidenceRef.length > 512
    || !input.freeze.evidenceRef.trim() || /[\r\n\0]/.test(input.freeze.evidenceRef)) fail('snapshot_export_freeze');
  let identity;
  try { identity = parseDurableSqlIdentity(input.identity); } catch { fail('snapshot_export_input'); }
  if (typeof input.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/.test(input.sourceRevision)
    || !Number.isSafeInteger(input.sourceFrozenAtMs) || input.sourceFrozenAtMs < 0 || input.sourceFrozenAtMs > Date.now()) fail('snapshot_export_input');
  const excluded = input.freeze.excludedTriggers ?? [];
  if (!Array.isArray(excluded) || excluded.length > 512) fail('snapshot_export_fence');
  const excludedTriggers = Array.from(excluded, item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'name,sqlHash'
      || !identifier(item.name) || omitted(item.name) || typeof item.sqlHash !== 'string' || !/^[0-9a-f]{64}$/.test(item.sqlHash)) fail('snapshot_export_fence');
    return { name: item.name, sqlHash: item.sqlHash };
  });
  if (new Set(excludedTriggers.map(item => item.name.toLowerCase())).size !== excludedTriggers.length) fail('snapshot_export_fence');
  return { identity, sourceRevision: input.sourceRevision, sourceFrozenAtMs: input.sourceFrozenAtMs, excludedTriggers };
}

function primaryReader(database) {
  if (!database || typeof database.withSession !== 'function') fail('snapshot_export_input');
  async function read(sql, values = []) {
    // A D1 session only pins its first read to the primary. Start a fresh one
    // for every observation so a later verification cannot read an old replica.
    const primary = database.withSession('first-primary');
    if (!primary || typeof primary.prepare !== 'function') fail('snapshot_export_input');
    const result = await primary.prepare(sql).bind(...values).all();
    if (!result || result.success !== true || !Array.isArray(result.results)) fail('snapshot_export_source_unavailable');
    return result.results;
  }
  return read;
}
async function readSourceCatalog(read, excludedTriggers = [], maximumObjects = 600) {
    const raw = await read('SELECT rowid AS schemaRowId,type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid LIMIT 1001');
    if (raw.length > 1000) fail('snapshot_export_capacity');
    for (const item of raw) if (typeof item.name !== 'string' || typeof item.tableName !== 'string' || typeof item.sql !== 'string'
      || !['table', 'index', 'trigger', 'view'].includes(item.type)) fail('snapshot_export_schema');
    const virtual = raw.filter(item => item.type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(item.sql));
    // Visible rows cannot reconstruct an external or contentless FTS index.
    // Reject these modes even when native shadow-table discovery is available.
    for (const item of virtual) if (!/\bUSING\s+fts5\s*\(/i.test(item.sql) || /\bcontent\s*=/i.test(item.sql)) fail('snapshot_export_schema');
    let listed;
    try { listed = await read('PRAGMA table_list'); }
    catch (error) {
      if (!(error instanceof Error) || !/unsupported|not authorized|unknown pragma|syntax error/i.test(error.message)) throw error;
      listed = [];
    }
    const shadows = new Set();
    if (listed.length) {
      for (const item of listed) if (item.schema === 'main' && item.type === 'shadow') {
        if (typeof item.name !== 'string' || !virtual.some(table => ['data', 'idx', 'content', 'docsize', 'config'].some(suffix => item.name === `${table.name}_${suffix}`)))
          fail('snapshot_export_schema');
        shadows.add(item.name);
      }
    } else {
      // This fallback is only valid for the current internal-content FTS5
      // schema. External/contentless tables need a separate reviewed exporter;
      // guessing their shadow names could discard a real application table.
      for (const item of virtual) {
        for (const suffix of ['data', 'idx', 'content', 'docsize', 'config']) shadows.add(`${item.name}_${suffix}`);
      }
    }
    const sourceSchema = raw.filter(item => !omitted(item.name) && !omitted(item.tableName)
      && !shadows.has(item.name) && !shadows.has(item.tableName)).map(({ type, name, tableName, sql }) => {
      if (!identifier(name) || !identifier(tableName)) fail('snapshot_export_schema');
      return { type, name, tableName, sql };
    });
    for (const exclusion of excludedTriggers) {
      const item = sourceSchema.find(item => item.name === exclusion.name);
      if (!item || item.type !== 'trigger' || createHash('sha256').update(item.sql, 'utf8').digest('hex') !== exclusion.sqlHash) fail('snapshot_export_fence');
    }
    const excludedNames = new Set(excludedTriggers.map(item => item.name));
    const schema = sourceSchema.filter(item => !excludedNames.has(item.name));
    if (!schema.length || schema.length > maximumObjects || size(schema) > 1048576
      || schema.some(item => new TextEncoder().encode(item.sql).byteLength > 100000)) fail('snapshot_export_schema');
    // Keep excluded fences in the comparison evidence. Exclusion from the
    // destination must never hide their disappearance or replacement at source.
    return { schema, sourceSchema, sequence: raw.some(item => item.type === 'table' && item.name === 'sqlite_sequence') };
}

/** Pre-freeze metadata observation for constructing a write-fence plan. This
 * reads no application rows and makes no assertion that writers are stopped.
 * Installed fences remain visible so the operator can verify exact coverage. */
export async function inspectDurableSourceCatalog(database) {
  const read = primaryReader(database), observed = await readSourceCatalog(read, [], 984);
  if (snapshotCanonical(await readSourceCatalog(read, [], 984)) !== snapshotCanonical(observed)) fail('snapshot_export_source_changed');
  return { schema: observed.schema, schemaHash: await snapshotHash(observed.schema) };
}

/** Read-only, bounded operator helper. The caller must actually freeze HTTP,
 * scheduled and other writers and retain the supplied freeze evidence. Two
 * equal observations detect drift; they do not establish a write freeze. No
 * credentials, payloads, SQL dumps or files are logged or written here. */
export async function exportDurableSnapshot(database, suppliedOptions) {
  const configuration = options(suppliedOptions), read = primaryReader(database);
  const catalog = () => readSourceCatalog(read, configuration.excludedTriggers);
  async function collect() {
    const observed = await catalog(), schema = observed.schema;
    const names = schema.filter(item => item.type === 'table').map(item => item.name);
    if (observed.sequence) names.push('sqlite_sequence');
    if (names.length > 128) fail('snapshot_export_capacity');
    const tables = [], descriptors = [], payloads = [];
    let totalRows = 0, totalBytes = 0;
    const retainedNames = new Set(schema.filter(item => item.type === 'table').map(item => item.name));
    for (const name of names) {
      if (schema.some(item => item.type === 'table' && item.name === name && /\bWITHOUT\s+ROWID\b/i.test(item.sql))) fail('snapshot_export_rowid');
      const columns = (await read(`PRAGMA table_info(${quote(name)})`)).map(row => row.name);
      if (!columns.length || columns.length >= 100 || columns.some(column => !identifier(column))
        || new Set(columns.map(column => column.toLowerCase())).size !== columns.length) fail('snapshot_export_schema');
      if (columns.some(column => ['rowid', '_rowid_', 'oid'].includes(column.toLowerCase()))) fail('snapshot_export_rowid');
      const allColumns = ['rowid', ...columns];
      const counts = await read(`SELECT count(*) AS n FROM ${quote(name)}`);
      const expected = counts[0]?.n;
      if (counts.length !== 1 || !Number.isSafeInteger(expected) || expected < 0 || expected > limits.rows || totalRows + expected > limits.rows) fail('snapshot_export_capacity');
      let lastRowid, observedRows = 0, rowCount = 0, pending = [], pendingBytes = 2, nextStart = 0;
      async function flush() {
        if (!pending.length) return;
        const bytes = pendingBytes;
        totalBytes += bytes;
        if (bytes > limits.chunkBytes || totalBytes > limits.totalBytes || descriptors.length >= limits.chunks) fail('snapshot_export_capacity');
        const rows = pending; pending = []; pendingBytes = 2;
        descriptors.push({ index: descriptors.length, table: name, start: nextStart, rowCount: rows.length, hash: await snapshotHash(rows) });
        payloads.push(rows); nextStart += rows.length;
      }
      while (observedRows < expected) {
        const rows = await read(`SELECT rowid AS rowid,${columns.map(quote).join(',')} FROM ${quote(name)}${lastRowid === undefined ? '' : ' WHERE rowid>?'} ORDER BY rowid LIMIT ?`,
          lastRowid === undefined ? [limits.chunkRows] : [lastRowid, limits.chunkRows]);
        if (!rows.length || rows.length > limits.chunkRows) fail('snapshot_export_source_changed');
        for (const row of rows) {
          if (!Number.isSafeInteger(row.rowid) || (lastRowid !== undefined && row.rowid <= lastRowid)) fail('snapshot_export_rowid');
          lastRowid = row.rowid; observedRows++;
          if (observedRows > expected) fail('snapshot_export_source_changed');
          if (name === 'sqlite_sequence' && typeof row.name === 'string' && omitted(row.name)) continue;
          if (name === 'sqlite_sequence' && (!retainedNames.has(row.name)
            || !schema.some(item => item.type === 'table' && item.name === row.name && /\bAUTOINCREMENT\b/i.test(item.sql)))) fail('snapshot_export_schema');
          const values = allColumns.map(column => row[column]);
          if (values.some(value => !valueAllowed(value))) fail('snapshot_export_value');
          const rowBytes = size(values);
          if (rowBytes + 2 > limits.chunkBytes) fail('snapshot_export_capacity');
          if (pending.length === limits.chunkRows || pendingBytes + rowBytes + (pending.length ? 1 : 0) > limits.chunkBytes) await flush();
          pendingBytes += rowBytes + (pending.length ? 1 : 0);
          pending.push(values); rowCount++;
        }
      }
      const finalCount = (await read(`SELECT count(*) AS n FROM ${quote(name)}`))[0]?.n;
      if (finalCount !== expected) fail('snapshot_export_source_changed');
      await flush();
      totalRows += rowCount;
      tables.push({ name, columns: allColumns, rowCount });
    }
    if (snapshotCanonical(await catalog()) !== snapshotCanonical(observed)) fail('snapshot_export_source_changed');
    const plan = { version: 1, identity: configuration.identity, schema, tables, chunks: descriptors,
      schemaHash: await snapshotHash(schema), snapshotHash: await snapshotHash({ tables, chunks: descriptors }),
      sourceRevision: configuration.sourceRevision, sourceFrozenAtMs: configuration.sourceFrozenAtMs };
    validateSnapshotPlan(plan, durableSqlObjectName(configuration.identity));
    return { plan, payloads };
  }
  const first = await collect(), second = await collect();
  if (snapshotCanonical(first.plan) !== snapshotCanonical(second.plan)) fail('snapshot_export_source_changed');
  const planHash = await snapshotHash(first.plan);
  return { plan: first.plan, chunks: first.payloads.map((rows, index) => ({ planHash, index, rows })) };
}

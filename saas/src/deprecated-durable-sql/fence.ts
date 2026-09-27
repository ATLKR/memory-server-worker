import { snapshotCanonical, snapshotHash } from './snapshot.ts';
import type { SnapshotSchema } from './snapshot.ts';

export interface WriteFencePlan {
  version: 1; runId: string; sourceSchemaHash: string; source: SnapshotSchema[]; triggers: SnapshotSchema[];
}
function fail(code: string): never { throw new Error(code); }
const name = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
const q = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
function catalog(schema: SnapshotSchema[], maximum = 600): SnapshotSchema[] {
  if (!Array.isArray(schema) || schema.length === 0 || schema.length > maximum) fail('fence_input');
  const seen = new Set<string>();
  return schema.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'name,sql,tableName,type'
      || !name(item.name) || !name(item.tableName) || seen.has(item.name.toLowerCase())
      || !['table', 'index', 'view', 'trigger'].includes(item.type) || typeof item.sql !== 'string' || item.sql.length > 100000) fail('fence_input');
    seen.add(item.name.toLowerCase());
    return { type: item.type, name: item.name, tableName: item.tableName, sql: item.sql };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
/** Pure operator plan. Caller supplies the exporter's filtered application
 * catalog: never internal SQLite/provider or FTS-shadow tables. This fence
 * stops SQL writes, not previously dispatched R2/AI/provider operations. */
export async function buildWriteFence(input: { runId: string; schema: SnapshotSchema[] }): Promise<WriteFencePlan> {
  if (!input || typeof input.runId !== 'string' || !/^[a-f0-9]{24}$/.test(input.runId)) fail('fence_input');
  const runId = input.runId, source = catalog(input.schema), triggers: SnapshotSchema[] = [];
  if (source.some(item => /^(memory_sql_fence_|durable_sql_|sqlite_|__cf_|_cf_)/i.test(item.name))) fail('fence_input');
  const virtual = source.filter(item => item.type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(item.sql)).map(item => item.name);
  if (source.some(item => virtual.some(prefix => ['data', 'idx', 'content', 'docsize', 'config'].some(suffix => item.name === prefix + '_' + suffix)))) fail('fence_input');
  const tables = source.filter(item => item.type === 'table' && !virtual.includes(item.name));
  if (!tables.length || tables.length > 128) fail('fence_input');
  for (const [index, table] of tables.entries()) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const triggerName = `memory_sql_fence_${runId}_${String(index).padStart(3, '0')}_${operation[0]!.toLowerCase()}`;
    const sql = `CREATE TRIGGER ${q(triggerName)} BEFORE ${operation} ON ${q(table.name)} BEGIN SELECT RAISE(ABORT,'memory_sql_cutover_frozen:${runId}'); END`;
    triggers.push({ type: 'trigger', name: triggerName, tableName: table.name, sql });
  }
  return { version: 1, runId, sourceSchemaHash: await snapshotHash(source), source, triggers };
}
/** Every current definition must be the exact source or this run's exact fence.
 * Partial installation is observable; it must not be treated as a frozen source. */
export async function verifyWriteFence(plan: WriteFencePlan, current: SnapshotSchema[]): Promise<{ complete: boolean; installed: string[]; missing: string[] }> {
  plan = JSON.parse(snapshotCanonical(plan));
  const observed = catalog(current, 984);
  const expected = await buildWriteFence({ runId: plan.runId, schema: plan.source });
  if (snapshotCanonical(expected) !== snapshotCanonical(plan)) fail('fence_input');
  const fence = new Map(plan.triggers.map(item => [item.name, item]));
  const installed: string[] = [], baseline: SnapshotSchema[] = [];
  for (const item of observed) {
    const owned = fence.get(item.name);
    if (owned) {
      if (snapshotCanonical(item) !== snapshotCanonical(owned)) fail('fence_definition_mismatch');
      installed.push(item.name);
    } else baseline.push(item);
  }
  if (snapshotCanonical(baseline) !== snapshotCanonical(plan.source)) fail('fence_source_changed');
  const missing = plan.triggers.filter(item => !installed.includes(item.name)).map(item => item.name);
  return { complete: missing.length === 0, installed, missing };
}
/** Produces only exact-owned DROP statements. The caller separately proves
 * rollback eligibility; never invoke this automatically after target writes. */
export async function fenceRemovalStatements(plan: WriteFencePlan, current: SnapshotSchema[]): Promise<string[]> {
  return (await verifyWriteFence(plan, current)).installed.map(trigger => 'DROP TRIGGER ' + q(trigger));
}

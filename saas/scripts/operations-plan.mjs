import { deploymentFingerprint } from './deployment-config.mjs';

export class OperationsError extends Error {}
export const fail = message => { throw new OperationsError(message); };
export const SAMPLE_LIMIT = 1001;
export function createOperationsPlan(target, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now <= 0 || !['production', 'staging'].includes(target.environment) || target.config.vars.STORAGE_MODE !== 'sharded') fail('Operations requires an explicit validated sharded target and observation time.');
  const d1 = [], add = (id, sql, columns, { binding = 'DB', params = [], maxRows = SAMPLE_LIMIT, category = 'queue' } = {}) => d1.push({ id, binding, sql, params, columns, maxRows, category });
  add('heartbeat', "SELECT last_success_at AS lastSuccessAt FROM release_heartbeats WHERE name='maintenance' LIMIT 1", ['lastSuccessAt'], { maxRows: 1, category: 'heartbeat' });
  for (const [kind, cleanup] of [['upsert', 0], ['upsert', 1], ['delete', 0], ['ingest', 0]]) {
    add(`jobs-pending-${kind}-${cleanup}`, `SELECT queued_at AS queuedAt,available_at AS availableAt,attempt,last_error IS NOT NULL AS hasError FROM release_jobs INDEXED BY release_jobs_pending_claim WHERE state='pending' AND kind='${kind}' AND cleanup_only=${cleanup} ORDER BY available_at,id LIMIT ${SAMPLE_LIMIT}`, ['queuedAt', 'availableAt', 'attempt', 'hasError']);
    add(`jobs-leased-${kind}-${cleanup}`, `SELECT queued_at AS queuedAt,lease_until AS leaseUntil,attempt,last_error IS NOT NULL AS hasError FROM release_jobs INDEXED BY release_jobs_leased_claim WHERE state='leased' AND attempt<5 AND kind='${kind}' AND cleanup_only=${cleanup} ORDER BY lease_until,id LIMIT ${SAMPLE_LIMIT}`, ['queuedAt', 'leaseUntil', 'attempt', 'hasError']);
  }
  add('jobs-exhausted-leases', `SELECT queued_at AS queuedAt,lease_until AS leaseUntil,attempt,last_error IS NOT NULL AS hasError FROM release_jobs INDEXED BY release_jobs_exhausted_lease WHERE state='leased' AND attempt>=5 ORDER BY lease_until,id LIMIT ${SAMPLE_LIMIT}`, ['queuedAt', 'leaseUntil', 'attempt', 'hasError']);
  add('jobs-dead', `SELECT queued_at AS queuedAt,available_at AS availableAt,attempt,last_error IS NOT NULL AS hasError FROM release_jobs INDEXED BY release_jobs_due WHERE state='dead' ORDER BY available_at,lease_until LIMIT ${SAMPLE_LIMIT}`, ['queuedAt', 'availableAt', 'attempt', 'hasError']);
  add('payload-intents', `SELECT created_at AS createdAt,expires_at AS expiresAt FROM release_payload_intents INDEXED BY release_payload_intents_expiry WHERE published_at IS NULL AND collection_started_at IS NULL ORDER BY expires_at,id LIMIT ${SAMPLE_LIMIT}`, ['createdAt', 'expiresAt']);
  for (const [table, done] of [['purges', 'purged_at'], ['retirements', 'retired_at']]) add(`payload-${table}`, `SELECT created_at AS createdAt,available_at AS availableAt,attempts AS attempt,last_error IS NOT NULL AS hasError FROM release_payload_${table} INDEXED BY release_payload_${table}_pending WHERE ${done} IS NULL ORDER BY available_at,created_at,payload_id LIMIT ${SAMPLE_LIMIT}`, ['createdAt', 'availableAt', 'attempt', 'hasError']);
  add('backfill', 'SELECT kind,updated_at AS updatedAt,generation,last_error IS NOT NULL AS hasError,last_error_at AS lastErrorAt FROM release_payload_backfill_progress ORDER BY kind LIMIT 2', ['kind', 'updatedAt', 'generation', 'hasError', 'lastErrorAt'], { maxRows: 2, category: 'backfill' });
  add('inline-current', `SELECT count(*) AS count FROM (SELECT 1 FROM memories INDEXED BY release_memories_inline_archive WHERE payload_id IS NULL AND erased_at IS NULL LIMIT ${SAMPLE_LIMIT}) LIMIT 1`, ['count'], { maxRows: 1, category: 'inline' });
  add('inline-history', `SELECT count(*) AS count FROM (SELECT 1 FROM memory_versions INDEXED BY release_versions_inline_archive WHERE payload_id IS NULL LIMIT ${SAMPLE_LIMIT}) LIMIT 1`, ['count'], { maxRows: 1, category: 'inline' });
  add('ai-budget', 'SELECT kind,calls,reserved_microusd AS reservedMicrousd FROM release_provider_budgets WHERE month=? ORDER BY kind LIMIT 2', ['kind', 'calls', 'reservedMicrousd'], { params: [new Date(now).toISOString().slice(0, 7)], maxRows: 2, category: 'ai' });
  for (const binding of target.hotBindings) add(`tombstones-${binding}`, `SELECT count(*) AS count FROM (SELECT 1 FROM payload_tombstones LIMIT ${SAMPLE_LIMIT}) LIMIT 1`, ['count'], { binding, maxRows: 1, category: 'tombstones' });
  const dataset = target.config.analytics_engine_datasets?.find(v => v.binding === 'METRICS')?.dataset;
  if (dataset !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(dataset)) fail('Analytics dataset requires a safe SQL identifier for this collector.');
  return { format: 1, environment: target.environment, resourceFingerprint: deploymentFingerprint(target.config), observedAt: now, month: new Date(now).toISOString().slice(0, 7),
    sampling: { maximumRowsPerQueue: SAMPLE_LIMIT, countsAreLowerBoundsWhenSaturated: true, oldestIsObservedSampleOnly: true }, d1,
    analytics: dataset ? [{ id: 'traffic', windowSeconds: 300, sql: `SELECT SUM(_sample_interval*double1) AS requests,SUM(IF(blob3>='500' AND blob3<'600',_sample_interval*double1,0.0)) AS serverErrors,quantileExactWeighted(0.95)(double2,_sample_interval) AS p95Ms FROM ${dataset} WHERE index1='memory' AND timestamp>=toDateTime(${Math.floor(now / 1000) - 300}) AND timestamp<toDateTime(${Math.floor(now / 1000)}) LIMIT 1` }] : [],
    providerCaptures: ['Actual D1 storage bytes and applicable per-database limit for DB and every HOT binding.', 'Private R2 total bytes/object count and retained purged-object inventory if available.', 'Primary Memory-wide staging plus production current UTC month costs or explicitly labelled usage estimates, including shared/base fees.'],
    providerMutation: false, alertDelivery: false };
}

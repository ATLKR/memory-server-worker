import { deploymentFingerprint } from './deployment-config.mjs';
import { createOperationsPlan, fail, SAMPLE_LIMIT } from './operations-plan.mjs';

export const COST_CATEGORIES = Object.freeze(['workers', 'd1', 'r2', 'vectorize', 'analytics', 'ai', 'other']);
export const DEFAULT_POLICY = Object.freeze({ databaseMaxAgeSeconds: 900, heartbeatMaxAgeSeconds: 900, capacityMaxAgeSeconds: 3600, costMaxAgeSeconds: 86400,
  trafficMaxAgeSeconds: 900, jobWarnAgeSeconds: 900, jobCriticalAgeSeconds: 3600, cleanupWarnAgeSeconds: 300, cleanupCriticalAgeSeconds: 3600,
  capacityWarnFraction: 0.70, capacityCriticalFraction: 0.85, monthlyWarnUsd: 40, monthlyCriticalUsd: 45, errorWarnFraction: 0.01, errorCriticalFraction: 0.05, latencyWarnMs: 2000, latencyCriticalMs: 5000 });
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = v => Number.isSafeInteger(v) && v >= 0;
function exact(v, keys) { if (!obj(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) fail('Unexpected or missing snapshot fields; provide sanitized aggregates only.'); }
function observed(v, now) { if (!integer(v) || !v || v > now) fail('Invalid or future observation timestamp.'); }
function list(v, max) { if (!Array.isArray(v) || v.length > max) fail('Invalid or excessive snapshot items.'); return v; }
function policyFor(custom) {
  if (!obj(custom) || Object.keys(custom).some(k => !Object.hasOwn(DEFAULT_POLICY, k))) fail('Unknown threshold policy.');
  const p = { ...DEFAULT_POLICY, ...custom };
  if (Object.values(p).some(v => !number(v) || v <= 0) || p.monthlyWarnUsd >= p.monthlyCriticalUsd || p.monthlyCriticalUsd > 50 || p.capacityWarnFraction >= p.capacityCriticalFraction || p.capacityCriticalFraction > 1 || p.errorWarnFraction >= p.errorCriticalFraction || p.errorCriticalFraction > 1 || p.jobWarnAgeSeconds >= p.jobCriticalAgeSeconds || p.cleanupWarnAgeSeconds >= p.cleanupCriticalAgeSeconds || p.latencyWarnMs >= p.latencyCriticalMs) fail('Invalid conservative threshold policy. Monthly budget cannot exceed USD50.');
  return p;
}
export function assessOperations(target, snapshot, { now = Date.now(), policy = {} } = {}) {
  const p = policyFor(policy), plan = createOperationsPlan(target, { now });
  exact(snapshot, ['format', 'environment', 'resourceFingerprint', 'collectedAt', 'database', 'capacity', 'traffic', 'budget']); observed(snapshot.collectedAt, now);
  if (snapshot.format !== 1 || snapshot.environment !== target.environment || snapshot.resourceFingerprint !== deploymentFingerprint(target.config)) fail('Snapshot does not match the explicitly selected target.');
  const issues = [], queues = [], retained = []; const add = (code, severity = 'warning', metric, value, threshold) => issues.push({ code, severity, ...(metric === undefined ? {} : { metric }), ...(value === undefined ? {} : { value }), ...(threshold === undefined ? {} : { threshold }) });
  const stale = (at, maximum, code) => { observed(at, now); if (at > snapshot.collectedAt) fail('Metric observation is later than collection.'); if ((now - at) / 1000 > maximum) add(code, 'critical'); };
  let ai = { reservedUsd: null, configuredLimitUsd: null }, budget = { totalUsd: null, remainingUsd: null, monthlyBudgetUsd: 50, basis: 'unknown', hardCapGuaranteed: false };
  if ((now - snapshot.collectedAt) / 1000 > p.databaseMaxAgeSeconds) add('snapshot_stale', 'critical');
  const limit = target.config.vars.AI_MONTHLY_BUDGET_MICROUSD, cap = target.environment === 'staging' ? 200000 : 20000000;
  if (typeof limit !== 'string' || !/^[1-9][0-9]{0,8}$/.test(limit) || Number(limit) > cap) add('ai_budget_configuration', 'critical');
  else { ai.configuredLimitUsd = Number(limit) / 1000000; if (Number(limit) < 200) add('ai_provider_admission_stopped', 'critical'); }
  if (target.config.vars.ENROLLMENT_MODE !== 'invite') add('invite_enrollment_required', 'critical');
  if (target.config.vars.PAID_BILLING_ENABLED !== 'false') add('paid_billing_must_be_disabled', 'critical');
  if (target.config.vars.BACKGROUND_JOBS_ENABLED !== 'true') add('provider_jobs_paused', 'warning');
  if (snapshot.database === null) add('database_unknown', 'critical');
  else {
    exact(snapshot.database, ['observedAt', 'month', 'results']); stale(snapshot.database.observedAt, p.databaseMaxAgeSeconds, 'database_stale');
    if (typeof snapshot.database.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(snapshot.database.month)) fail('Record the actual UTC month bound to the AI reservation query.');
    const values = snapshot.database.results;
    if (!obj(values) || Object.keys(values).some(id => !plan.d1.some(q => q.id === id))) fail('Unknown database result group.');
    for (const q of plan.d1) {
      if (values[q.id] === null || values[q.id] === undefined) { add('database_metric_unknown', 'critical', q.id); continue; }
      const rows = list(values[q.id], q.maxRows);
      for (const row of rows) {
        exact(row, q.columns);
        for (const key of q.columns) {
          if (key === 'kind') { if (!(q.category === 'ai' ? ['embedding', 'extraction'] : ['current', 'history']).includes(row[key])) fail('Unknown aggregate kind.'); }
          else if (['lastErrorAt', 'queuedAt'].includes(key) && row[key] === null) continue;
          else if (!integer(row[key]) || (key === 'hasError' && row[key] > 1)) fail('Database metric must be a finite sanitized count, timestamp or flag.');
          if (['lastSuccessAt', 'updatedAt', 'lastErrorAt', 'createdAt', 'queuedAt'].includes(key) && row[key] > snapshot.database.observedAt)
            fail((q.category === 'queue' ? 'Queue start' : 'Historical metric') + ' is in the future relative to its database observation.');
        }
      }
      if (q.category === 'heartbeat') { if (!rows.length) add('heartbeat_missing', 'critical'); else if ((now - rows[0].lastSuccessAt) / 1000 > p.heartbeatMaxAgeSeconds) add('heartbeat_stale', 'critical'); }
      if (q.category === 'queue') {
        const ageField = q.id.startsWith('jobs-') ? 'queuedAt' : 'createdAt', unknownEpisode = rows.some(r => r[ageField] === null);
        const age = unknownEpisode ? null : rows.length ? Math.max(...rows.map(r => (now - r[ageField]) / 1000)) : 0;
        if (unknownEpisode) add('queue_episode_unknown', 'critical', q.id);
        // Provider jobs increment attempt when acquiring a lease. A pending job
        // with a prior attempt is awaiting a retry; its first lease is not one.
        // Payload cleanup also increments before I/O, but has no lease state:
        // a second attempt or a failed first attempt proves retry work there.
        const retries = rows.filter(r => q.id.startsWith('jobs-') ? r.attempt > (q.id.startsWith('jobs-pending-') ? 0 : 1) : r.attempt > 1 || r.attempt > 0 && r.hasError === 1).length;
        queues.push({ metric: q.id, observedCount: rows.length, countExact: rows.length < SAMPLE_LIMIT, oldestObservedAgeSeconds: age,
          retriesObserved: rows.length && !q.columns.includes('attempt') ? null : retries,
          failuresObserved: rows.length && !q.columns.includes('hasError') ? null : rows.filter(r => r.hasError === 1).length });
        if (rows.length === SAMPLE_LIMIT) add('queue_sample_saturated', 'critical', q.id, rows.length);
        if (q.id === 'jobs-dead' && rows.length) add('provider_jobs_dead', 'critical', q.id, rows.length);
        else if (q.id === 'jobs-exhausted-leases' && rows.some(r => r.leaseUntil <= now)) add('provider_leases_exhausted', 'critical', q.id);
        else if (q.id === 'payload-intents') {
          const expiredAge = Math.max(0, ...rows.map(r => (now - r.expiresAt) / 1000)); if (expiredAge > p.cleanupWarnAgeSeconds) add('payload_intents_expired', expiredAge >= p.cleanupCriticalAgeSeconds ? 'critical' : 'warning', q.id, expiredAge);
        } else {
          const cleanup = q.id.startsWith('payload-'), warn = cleanup ? p.cleanupWarnAgeSeconds : p.jobWarnAgeSeconds, critical = cleanup ? p.cleanupCriticalAgeSeconds : p.jobCriticalAgeSeconds;
          if (rows.length && age >= warn) add(cleanup ? 'payload_cleanup_delayed' : age >= critical ? 'provider_job_age_critical' : 'provider_job_age_warning', age >= critical ? 'critical' : 'warning', q.id, age, critical);
          if (rows.some(r => r.attempt >= 3 || r.hasError === 1)) add(cleanup ? 'payload_cleanup_retrying' : 'provider_jobs_retrying', 'warning', q.id);
          if (q.id.startsWith('jobs-leased-') && rows.some(r => r.leaseUntil <= now)) add('provider_lease_expired', 'warning', q.id);
        }
      }
      if (q.category === 'ai') {
        if (new Set(rows.map(r => r.kind)).size !== rows.length) fail('Duplicate AI reservation kind.');
        if (snapshot.database.month !== plan.month || new Date(snapshot.database.observedAt).toISOString().slice(0, 7) !== plan.month) { add('ai_reservation_period_unknown', 'critical'); continue; }
        const reserved = rows.reduce((sum, r) => sum + r.reservedMicrousd, 0); if (!Number.isSafeInteger(reserved)) fail('AI reservation aggregate exceeds its numeric limit.'); ai.reservedUsd = reserved / 1000000;
        if (ai.configuredLimitUsd !== null && (ai.configuredLimitUsd === 0 || ai.reservedUsd >= ai.configuredLimitUsd * 0.8)) add('ai_reservation_near_limit', ai.reservedUsd >= ai.configuredLimitUsd ? 'critical' : 'warning', undefined, ai.reservedUsd, ai.configuredLimitUsd);
      }
      if (q.category === 'backfill') {
        if (rows.length !== 2 || new Set(rows.map(r => r.kind)).size !== 2) add('backfill_progress_unknown', 'critical');
        if (rows.some(r => r.hasError)) add('backfill_failed', 'warning');
        if (target.config.vars.STORAGE_BACKFILL_ENABLED === 'true') for (const row of rows) {
          const candidates = values['inline-' + row.kind]; if (candidates?.[0]?.count > 0 && (now - row.updatedAt) / 1000 > p.databaseMaxAgeSeconds) add('backfill_stalled', 'warning', 'inline-' + row.kind);
        }
      }
      if (['inline', 'tombstones'].includes(q.category)) {
        if (rows.length !== 1 || rows[0].count > SAMPLE_LIMIT) fail('Invalid bounded count result.');
        retained.push({ metric: q.id, observedCount: rows[0].count, countExact: rows[0].count < SAMPLE_LIMIT });
      }
    }
  }
  if (snapshot.capacity === null) add('capacity_unknown', 'critical');
  else {
    const c = snapshot.capacity; exact(c, ['observedAt', 'databases', 'r2']); stale(c.observedAt, p.capacityMaxAgeSeconds, 'capacity_stale');
    const expected = new Set(target.config.d1_databases.map(v => v.binding)), seen = new Set();
    for (const row of list(c.databases, 17)) {
      exact(row, ['binding', 'bytes', 'limitBytes']); if (!expected.has(row.binding) || seen.has(row.binding) || !integer(row.bytes) || !integer(row.limitBytes) || row.limitBytes <= 0 || row.limitBytes > 10 * 1024 ** 3) fail('Capacity requires every actual unique DB binding and its applicable limit.'); seen.add(row.binding);
      const fraction = row.bytes / row.limitBytes; if (fraction >= p.capacityWarnFraction) add(fraction >= p.capacityCriticalFraction ? 'database_capacity_critical' : 'database_capacity_warning', fraction >= p.capacityCriticalFraction ? 'critical' : 'warning', row.binding, row.bytes, row.limitBytes);
    }
    if (seen.size !== expected.size) fail('Missing shard or central capacity measurement.');
    if (c.r2 === null) add('r2_usage_unknown', 'critical'); else { exact(c.r2, ['bytes', 'objects', 'purgedObjects']); if (!integer(c.r2.bytes) || !integer(c.r2.objects) || !(c.r2.purgedObjects === null || integer(c.r2.purgedObjects) && c.r2.purgedObjects <= c.r2.objects)) fail('Invalid R2 aggregate.'); retained.push({ metric: 'r2-purged-objects', observedCount: c.r2.purgedObjects, countExact: c.r2.purgedObjects !== null }); }
  }
  if (target.hotBindings.length >= 14) add('shard_binding_headroom', 'warning', undefined, target.hotBindings.length, 16);
  if (snapshot.traffic === null) add('traffic_unknown', 'critical');
  else {
    const r = snapshot.traffic; exact(r, ['observedAt', 'windowSeconds', 'requests', 'primaryRequests', 'serverErrors', 'p95Ms', 'sampled']); stale(r.observedAt, p.trafficMaxAgeSeconds, 'traffic_stale');
    if (!integer(r.windowSeconds) || r.windowSeconds < 60 || r.windowSeconds > 3600 || !number(r.requests) || !number(r.serverErrors) || r.serverErrors > r.requests || !(r.primaryRequests === null || number(r.primaryRequests)) || typeof r.sampled !== 'boolean' || !(r.requests === 0 && r.p95Ms === null || number(r.p95Ms))) fail('Invalid aggregate traffic window.');
    if (r.primaryRequests === null) add('primary_request_usage_unknown', 'critical');
    else if (r.primaryRequests > 0 && (r.requests === 0 || r.primaryRequests >= 20 && r.requests < r.primaryRequests * 0.5)) add('telemetry_coverage_gap', 'critical');
    const errorRate = r.requests ? r.serverErrors / r.requests : 0;
    if (r.serverErrors > 0 && (r.requests < 20 || errorRate >= p.errorWarnFraction)) add(errorRate >= p.errorCriticalFraction && r.requests >= 20 ? 'server_errors_critical' : 'server_errors_warning', errorRate >= p.errorCriticalFraction && r.requests >= 20 ? 'critical' : 'warning', undefined, errorRate);
    if (r.requests >= 20 && r.p95Ms >= p.latencyWarnMs) add(r.p95Ms >= p.latencyCriticalMs ? 'latency_critical' : 'latency_warning', r.p95Ms >= p.latencyCriticalMs ? 'critical' : 'warning', undefined, r.p95Ms);
  }
  if (snapshot.budget === null) add('cost_unknown', 'critical');
  else {
    const b = snapshot.budget; exact(b, ['observedAt', 'month', 'scope', 'environments', 'evidenceRef', 'complete', 'costs']); stale(b.observedAt, p.costMaxAgeSeconds, 'cost_stale');
    if (typeof b.complete !== 'boolean' || typeof b.evidenceRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(b.evidenceRef)) fail('Cost capture requires a sanitized primary evidence reference.');
    if (b.month !== plan.month || b.scope !== 'memory-staging-production' || !Array.isArray(b.environments) || [...b.environments].sort().join(',') !== 'production,staging' || !b.complete) add('cost_coverage_unknown', 'critical');
    const seen = new Set(); let total = 0, estimate = false;
    for (const cost of list(b.costs, 7)) { exact(cost, ['category', 'usd', 'basis']); if (!COST_CATEGORIES.includes(cost.category) || seen.has(cost.category) || !number(cost.usd) || cost.usd > 1000000000 || !['billed', 'usage-estimate'].includes(cost.basis)) fail('Invalid or duplicate monthly cost category.'); seen.add(cost.category); total += cost.usd; estimate ||= cost.basis === 'usage-estimate'; }
    if (seen.size !== COST_CATEGORIES.length) add('cost_coverage_unknown', 'critical');
    if (!issues.some(i => i.code === 'cost_coverage_unknown')) { total = Math.round(total * 1000000) / 1000000; budget = { ...budget, totalUsd: total, remainingUsd: Math.max(0, 50 - total), basis: estimate ? 'usage-estimate' : 'billed' }; }
    if (estimate) add('cost_estimated', 'warning');
    if (total >= p.monthlyWarnUsd) add(total >= p.monthlyCriticalUsd ? 'monthly_budget_critical' : 'monthly_budget_warning', total >= p.monthlyCriticalUsd ? 'critical' : 'warning', undefined, total, 50);
  }
  return { format: 1, environment: target.environment, assessedAt: now, status: issues.length ? 'attention' : 'healthy', exitCode: issues.length ? 2 : 0,
    issues, queues, retained, ai, budget, policy: p, alertDelivered: false, providerMutation: false,
    limitations: ['Observed queue ages are sample lower bounds; saturated counts are not exact.', 'Capacity and cost depend on actual adapter captures; no invoice hard cap is guaranteed.', 'This report does not deliver alerts or change admission, jobs, cleanup or deployment.'] };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'jsonc-parser';
import { fixture, DB, at } from '../release-validation/tests/db.mjs';
import { deploymentFingerprint } from './deployment-config.mjs';
import { createOperationsPlan } from './operations-plan.mjs';
import { assessOperations, COST_CATEGORIES } from './operations-assess.mjs';
import { runOperationsCommand } from './operations-cli.mjs';
import { MemoryStore } from '../src/release/memory.ts';
import { Jobs } from '../src/release/jobs.ts';
import { reserveProvider } from '../src/release/provider-budget.ts';
import { evaluateReadiness } from '../src/release/readiness.ts';
import { loadDeploymentConfiguration } from './deployment-config.mjs';

const base = parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
function target() {
  const config = structuredClone(base);
  config.vectorize = [{ binding: 'MEMORY_INDEX', index_name: 'memory-operations-staging-index' }];
  Object.assign(config.vars, { DEPLOYMENT_ENVIRONMENT: 'staging', PUBLIC_ORIGIN: 'https://ops.example.org', STORAGE_MODE: 'sharded', AI_MONTHLY_BUDGET_MICROUSD: '200000', BACKGROUND_JOBS_ENABLED: 'true', STORAGE_BACKFILL_ENABLED: 'false', ENROLLMENT_MODE: 'invite', PAID_BILLING_ENABLED: 'false', STORAGE_SHARDS_JSON: JSON.stringify([{ id: 'a', binding: 'HOT_A', mode: 'active' }, { id: 'b', binding: 'HOT_B', mode: 'draining' }]) });
  config.name = 'operations-test'; config.routes = [{ pattern: 'ops.example.org', custom_domain: true }];
  config.d1_databases = ['DB', 'HOT_A', 'HOT_B'].map((binding, i) => ({ binding, database_name: `ops-${i}`, database_id: `${i}aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`, migrations_dir: i ? 'shard-migrations' : 'migrations' }));
  config.r2_buckets = [{ binding: 'MEMORY_PAYLOADS', bucket_name: 'operations-test-payloads' }];
  config.analytics_engine_datasets = [{ binding: 'METRICS', dataset: 'operations_test_metrics' }];
  return { config, environment: 'staging', hotBindings: ['HOT_A', 'HOT_B'] };
}
async function setup(t) {
  const { db } = await fixture(); t.after(() => db.close());
  db.raw.prepare("INSERT INTO release_heartbeats VALUES('maintenance',?)").run(at);
  const hot = new DatabaseSync(':memory:'); hot.exec(readFileSync(new URL('../shard-migrations/0001_payloads.sql', import.meta.url), 'utf8')); t.after(() => hot.close());
  const selected = target(), plan = createOperationsPlan(selected, { now: at });
  const collect = () => Object.fromEntries(plan.d1.map(q => [q.id, (q.binding === 'DB' ? db.raw : hot).prepare(q.sql).all(...q.params)]));
  const snapshot = () => ({ format: 1, environment: 'staging', resourceFingerprint: deploymentFingerprint(selected.config), collectedAt: at,
    database: { observedAt: at, month: '2026-09', results: collect() },
    capacity: { observedAt: at, databases: selected.config.d1_databases.map(v => ({ binding: v.binding, bytes: 1000000, limitBytes: 10000000000 })), r2: { bytes: 1000, objects: 10, purgedObjects: 2 } },
    traffic: { observedAt: at, windowSeconds: 300, requests: 100, primaryRequests: 100, serverErrors: 0, p95Ms: 50, sampled: true },
    budget: { observedAt: at, month: '2026-09', scope: 'memory-staging-production', environments: ['production', 'staging'], evidenceRef: 'test-primary-capture', complete: true,
      costs: COST_CATEGORIES.map(category => ({ category, usd: 0.01, basis: 'billed' })) } });
  return { db, hot, selected, plan, collect, snapshot };
}
test('query plan executes against actual central/HOT schemas and all collection queries remain read-only/bounded', async t => {
  const f = await setup(t); const results = f.collect();
  assert.equal(Object.keys(results).length, f.plan.d1.length);
  for (const q of f.plan.d1) { assert.match(q.sql, /^SELECT /); assert.match(q.sql, /LIMIT \d+/); assert.doesNotMatch(q.sql, /SELECT \*|token_digest|space_id|memory_id|last_error AS/i); f.db.raw.prepare(q.binding === 'DB' ? 'EXPLAIN QUERY PLAN ' + q.sql : 'SELECT 1').all(...(q.binding === 'DB' ? q.params : [])); }
  const queue = f.plan.d1.find(q => q.id === 'jobs-pending-upsert-0');
  const explain = JSON.stringify(f.db.raw.prepare('EXPLAIN QUERY PLAN ' + queue.sql).all(...queue.params)); assert.match(explain, /release_jobs_pending_claim/); assert.doesNotMatch(explain, /TEMP B-TREE/);
  assert.match(f.plan.analytics[0].sql, /_sample_interval/); assert.doesNotMatch(JSON.stringify(f.plan), /https:|SSO_CLIENT_ID/);
});
test('Analytics Engine conditional branches keep the weighted double and zero the same numeric type', () => {
  const sql = createOperationsPlan(target(), { now: at }).analytics[0].sql;
  assert.match(sql, /IF\(blob3>='500' AND blob3<'600',_sample_interval\*double1,0\.0\)/);
});
test('healthy complete actual captures produce exit0 without inventing alert delivery or hard budget cap', async t => {
  const f = await setup(t), report = assessOperations(f.selected, f.snapshot(), { now: at });
  assert.equal(report.exitCode, 0); assert.equal(report.status, 'healthy'); assert.equal(report.budget.totalUsd, 0.07); assert.equal(report.budget.hardCapGuaranteed, false); assert.equal(report.alertDelivered, false);
  assert.doesNotMatch(JSON.stringify(report), /https:|ops\.example|token|PRIVATE-PAYLOAD/);
});
for (const [metric, field] of [['heartbeat', 'lastSuccessAt'], ['payload-backfill', 'updatedAt'], ['payload-backfill', 'lastErrorAt']]) test(`historical ${field} cannot follow its database observation even when assessment is later`, async t => {
  const f = await setup(t); f.selected.config.vars.STORAGE_BACKFILL_ENABLED = 'true'; const s = f.snapshot();
  s.collectedAt = at + 1000; s.database.results['inline-current'][0].count = 1;
  const group = metric === 'heartbeat' ? 'heartbeat' : f.plan.d1.find(q => q.category === 'backfill').id;
  s.database.results[group][0][field] = at + 1;
  assert.throws(() => assessOperations(f.selected, s, { now: at + 1000 }), /future.*database observation/i);
});
for (const key of ['toString', 'constructor', '__proto__']) test(`threshold policy rejects inherited Object key ${key}`, async t => {
  const f = await setup(t), policy = JSON.parse('{"' + key + '":1}');
  assert.throws(() => assessOperations(f.selected, f.snapshot(), { now: at, policy }), /Unknown threshold policy/);
});
for (const [name, mutate, code] of [
  ['heartbeat stale', s => { s.database.results.heartbeat[0].lastSuccessAt = at - 901000; }, 'heartbeat_stale'],
  ['heartbeat missing', s => { s.database.results.heartbeat = []; }, 'heartbeat_missing'],
  ['unknown capacity', s => { s.capacity = null; }, 'capacity_unknown'],
  ['unknown costs', s => { s.budget = null; }, 'cost_unknown'],
  ['unknown traffic', s => { s.traffic = null; }, 'traffic_unknown'],
  ['unknown primary requests', s => { s.traffic.primaryRequests = null; }, 'primary_request_usage_unknown'],
  ['silent telemetry loss', s => { s.traffic.requests = 0; s.traffic.p95Ms = null; }, 'telemetry_coverage_gap'],
  ['stale observations', s => { s.database.observedAt = at - 901000; s.database.results.heartbeat[0].lastSuccessAt = s.database.observedAt; }, 'database_stale'],
  ['old query month despite fresh arrival', s => { s.database.month = '2026-08'; }, 'ai_reservation_period_unknown'],
  ['capacity near limit', s => { s.capacity.databases[0].bytes = 8600000000; }, 'database_capacity_critical'],
  ['billing across environments', s => { s.budget.costs[0].usd = 46; }, 'monthly_budget_critical'],
  ['staging-only billing', s => { s.budget.environments = ['staging']; }, 'cost_coverage_unknown'],
  ['partial costs', s => { s.budget.complete = false; }, 'cost_coverage_unknown'],
  ['estimated costs', s => { s.budget.costs[0].basis = 'usage-estimate'; }, 'cost_estimated'],
  ['provider errors', s => { s.traffic.serverErrors = 6; }, 'server_errors_critical'],
  ['slow requests', s => { s.traffic.p95Ms = 6000; }, 'latency_critical'],
]) test(`assessment flags ${name}`, async t => { const f = await setup(t), s = f.snapshot(); mutate(s); const report = assessOperations(f.selected, s, { now: at }); assert.equal(report.exitCode, 2); assert.ok(report.issues.some(i => i.code === code), JSON.stringify(report)); });
test('old/retry/dead provider jobs are observed without disclosing retained errors or identifiers', async t => {
  const f = await setup(t);
  f.db.setClock(() => at - 8000000);
  f.db.raw.prepare("INSERT INTO release_jobs(id,kind,state,attempt,available_at,created_at,last_error) VALUES('private-job','upsert','pending',4,?,?,?)").run(at - 8000000, at - 8000000, 'https://secret.example/?token=PRIVATE');
  f.db.setClock(() => at);
  f.db.raw.prepare("INSERT INTO release_jobs(id,kind,state,attempt,available_at,created_at) VALUES('dead-job','ingest','dead',5,?,?)").run(at, at);
  const report = assessOperations(f.selected, f.snapshot(), { now: at });
  assert.ok(report.issues.some(i => i.code === 'provider_job_age_critical')); assert.ok(report.issues.some(i => i.code === 'provider_jobs_dead'));
  assert.doesNotMatch(JSON.stringify(report), /private-job|dead-job|PRIVATE|https:/);
});
test('schema25 preserves history, marks ambiguous upgraded episodes unknown, and stamps all new queue episodes', t => {
  let now = at; const db = new DB(() => now); db.migrate(24); t.after(() => db.close());
  const insert = db.raw.prepare('INSERT INTO release_jobs(id,kind,state,attempt,available_at,created_at) VALUES(?,?,?,?,?,?)');
  insert.run('initial', 'upsert', 'pending', 0, at - 10000, at - 10000);
  insert.run('legacy-retry', 'delete', 'pending', 2, at - 100, at - 10000);
  insert.run('completed', 'delete', 'done', 0, at - 100, at - 10000);
  db.raw.exec(readFileSync(new URL('../migrations/0025_queue-episode-schema.sql', import.meta.url), 'utf8'));
  assert.deepEqual(db.raw.prepare('SELECT id,created_at,queued_at FROM release_jobs ORDER BY id').all().map(r => ({ ...r })), [
    { id: 'completed', created_at: at - 10000, queued_at: null }, { id: 'initial', created_at: at - 10000, queued_at: at - 10000 }, { id: 'legacy-retry', created_at: at - 10000, queued_at: null }]);
  now += 1000; db.raw.prepare("UPDATE release_jobs SET state='pending',available_at=? WHERE id='completed'").run(now);
  assert.equal(db.raw.prepare("SELECT queued_at FROM release_jobs WHERE id='completed'").get().queued_at, now);
  const start = now; now += 1000; db.raw.prepare("UPDATE release_jobs SET state='leased',attempt=1,lease_until=? WHERE id='completed'").run(now + 120000);
  now += 1000; db.raw.prepare("UPDATE release_jobs SET state='pending',attempt=2,available_at=? WHERE id='completed'").run(now + 10000);
  assert.equal(db.raw.prepare("SELECT queued_at FROM release_jobs WHERE id='completed'").get().queued_at, start);
  db.raw.exec("UPDATE release_jobs SET state='dead' WHERE id='completed'"); now += 1000; db.raw.exec("UPDATE release_jobs SET state='pending' WHERE id='completed'");
  assert.equal(db.raw.prepare("SELECT queued_at FROM release_jobs WHERE id='completed'").get().queued_at, now);
  insert.run('new', 'ingest', 'pending', 0, at, at); assert.equal(db.raw.prepare("SELECT queued_at FROM release_jobs WHERE id='new'").get().queued_at, now);
  assert.equal(db.raw.prepare('SELECT version FROM release_meta').get().version, 25); assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), []);
});
test('routine completed-delete reconciliation starts a fresh episode and retries preserve its real age', async t => {
  const f = await setup(t), store = new MemoryStore(f.db, () => at), memory = await store.create('a'.repeat(64), 's1', { body: 'completed content' }, 'episode-create');
  await store.remove('a'.repeat(64), 's1', memory.id, 1, 'episode-remove'); f.db.raw.prepare("UPDATE release_jobs SET state='done',available_at=?").run(at);
  let now = at + 2 * 86400000; f.db.setClock(() => now);
  const report = () => { const s = f.snapshot(); s.collectedAt = now; for (const k of ['database','capacity','traffic','budget']) s[k].observedAt = now; s.database.results.heartbeat[0].lastSuccessAt = now; return assessOperations(f.selected, s, { now }); };
  assert.equal(report().exitCode, 0);
  const jobs = new Jobs({ DB: f.db, BACKGROUND_JOBS_ENABLED: 'true', MEMORY_INDEX: {} }, () => now); await jobs.maintain();
  const fresh = report(); assert.equal(fresh.exitCode, 0, JSON.stringify(fresh.issues)); assert.equal(fresh.queues.find(q => q.metric === 'jobs-pending-delete-0').oldestObservedAgeSeconds, 0);
  f.db.raw.prepare('INSERT INTO release_vector_refs(memory_id,vector_id,revision) VALUES(?,?,2)').run(memory.id, 'pending-provider-delete');
  now += 3601000; await jobs.drain(1);
  const delayed = report(); assert.ok(delayed.issues.some(i => i.code === 'provider_job_age_critical')); assert.equal(delayed.queues.find(q => q.metric === 'jobs-pending-delete-0').oldestObservedAgeSeconds, 3601);
});
test('positive one-microusd stop passes configuration checks and rejects both current AI reservations', async t => {
  const f = await setup(t), dir = await mkdtemp(join(tmpdir(), 'memory stop ')); t.after(() => rm(dir, { recursive: true, force: true }));
  f.selected.config.vars.AI_MONTHLY_BUDGET_MICROUSD = '1'; const path = join(dir, 'staging.jsonc'); await writeFile(path, JSON.stringify(f.selected.config));
  const configured = await loadDeploymentConfiguration({ configPath: path }); assert.equal(configured.config.vars.AI_MONTHLY_BUDGET_MICROUSD, '1');
  const ready = await evaluateReadiness({ ...configured.config.vars, DB: f.db }, { centralSchemaVersion: 25, hotSchemaVersion: 1, clock: () => at, inspectStorage: async () => ({ ready: false, hotSchemaVersion: 1, resourceFingerprint: '' }) });
  assert.equal(ready.checks.aiBudget, true);
  for (const kind of ['embedding', 'extraction']) await assert.rejects(reserveProvider({ DB: f.db, AI_MONTHLY_BUDGET_MICROUSD: '1' }, kind), error => error.code === 'provider_budget_exhausted');
  assert.equal(f.db.raw.prepare('SELECT count(*) AS n FROM release_provider_budgets').get().n, 0);
  const report = assessOperations(f.selected, f.snapshot(), { now: at }); assert.ok(report.issues.some(i => i.code === 'ai_provider_admission_stopped')); assert.equal(report.exitCode, 2);
  f.selected.config.vars.AI_MONTHLY_BUDGET_MICROUSD = '0'; assert.ok(assessOperations(f.selected, f.snapshot(), { now: at }).issues.some(i => i.code === 'ai_budget_configuration'));
});
test('queue sampling is bounded and saturation is actionable instead of a false exact count', async t => {
  const f = await setup(t), stmt = f.db.raw.prepare("INSERT INTO release_jobs(id,kind,state,available_at,created_at) VALUES(?,'upsert','pending',?,?)");
  f.db.raw.exec('BEGIN'); for (let i = 0; i < 2000; i++) stmt.run(`j${i}`, at, at); f.db.raw.exec('COMMIT');
  const s = f.snapshot(); assert.equal(s.database.results['jobs-pending-upsert-0'].length, 1001);
  const report = assessOperations(f.selected, s, { now: at }); assert.ok(report.issues.some(i => i.code === 'queue_sample_saturated')); assert.equal(report.queues.find(q => q.metric === 'jobs-pending-upsert-0').countExact, false);
});
test('AI reservation reports conservative reserved cost separately from billed Cloudflare costs', async t => {
  const f = await setup(t); f.db.raw.exec("INSERT INTO release_provider_budgets VALUES('2026-09','extraction',6,180000)");
  const report = assessOperations(f.selected, f.snapshot(), { now: at }); assert.equal(report.ai.reservedUsd, 0.18); assert.equal(report.ai.configuredLimitUsd, 0.2); assert.equal(report.budget.totalUsd, 0.07); assert.ok(report.issues.some(i => i.code === 'ai_reservation_near_limit'));
});
test('disabled backfill with no candidates is valid; enabled failed backfill is actionable', async t => {
  const f = await setup(t); f.selected.config.vars.STORAGE_BACKFILL_ENABLED = 'true'; f.db.raw.exec("UPDATE release_payload_backfill_progress SET last_error='PRIVATE',last_error_at=1 WHERE kind='current'");
  const report = assessOperations(f.selected, f.snapshot(), { now: at }); assert.ok(report.issues.some(i => i.code === 'backfill_failed')); assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});
test('expired intents and failed pending payload purges/retirements are indexed and actionable', async t => {
  const f = await setup(t), intent = f.db.raw.prepare("INSERT INTO release_payload_intents(id,account_id,space_id,client_key,request_hash,action,item_count,reserved_bytes,created_at,expires_at) VALUES(?,'alice','s1',?,'hash','create',1,128,?,?)");
  intent.run('future', 'future', at - 10000000, at + 10000); intent.run('expired', 'expired', at - 10000000, at - 2000000);
  f.db.raw.prepare("INSERT INTO release_payload_stages(id,intent_id,ordinal,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,logical_bytes,created_at) VALUES('p1','future',0,'private-memory','a','payload/v1/p1',?,64,64,?)").run('a'.repeat(64), at);
  for (const table of ['purges', 'retirements']) f.db.raw.prepare(`INSERT INTO release_payload_${table}(payload_id,space_id,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,created_at,attempts,last_error) VALUES('p1','s1','private-memory','a','payload/v1/p1',?,64,?,4,'PRIVATE ERROR')`).run('a'.repeat(64), at - 8000000);
  const report = assessOperations(f.selected, f.snapshot(), { now: at });
  assert.ok(report.issues.some(i => i.code === 'payload_intents_expired')); assert.equal(report.issues.filter(i => i.code === 'payload_cleanup_delayed').length, 2);
  assert.equal(report.issues.filter(i => i.code === 'payload_cleanup_retrying').length, 2); assert.doesNotMatch(JSON.stringify(report), /private-memory|PRIVATE ERROR/);
  for (const id of ['payload-intents', 'payload-purges', 'payload-retirements']) { const q = f.plan.d1.find(q => q.id === id), explain = JSON.stringify(f.db.raw.prepare('EXPLAIN QUERY PLAN ' + q.sql).all()); assert.match(explain, /USING INDEX/); assert.doesNotMatch(explain, /TEMP B-TREE/); }
});
test('missing query results are critical unknowns, while tombstone samples remain explicit lower bounds', async t => {
  const f = await setup(t), s = f.snapshot(); delete s.database.results['ai-budget']; s.database.results['tombstones-HOT_A'] = [{ count: 1001 }];
  const report = assessOperations(f.selected, s, { now: at }); assert.equal(report.exitCode, 2); assert.equal(report.ai.reservedUsd, null); assert.ok(report.issues.some(i => i.code === 'database_metric_unknown'));
  assert.deepEqual(report.retained.find(r => r.metric === 'tombstones-HOT_A'), { metric: 'tombstones-HOT_A', observedCount: 1001, countExact: false });
});
test('ambiguous legacy queue start stays unknown instead of reporting a fabricated backlog age', async t => {
  const f = await setup(t); f.db.raw.prepare("INSERT INTO release_jobs(id,kind,state,available_at,created_at) VALUES('legacy','delete','pending',?,?)").run(at, at - 172800000);
  f.db.raw.exec("UPDATE release_jobs SET queued_at=NULL WHERE id='legacy'");
  const report = assessOperations(f.selected, f.snapshot(), { now: at }); assert.ok(report.issues.some(i => i.code === 'queue_episode_unknown'));
  assert.equal(report.queues.find(q => q.metric === 'jobs-pending-delete-0').oldestObservedAgeSeconds, null); assert.equal(report.issues.some(i => i.code === 'provider_job_age_critical'), false);
});

for (const collectionDelay of [0, 1000]) test(`future queue episode is rejected even when assessment arrives ${collectionDelay}ms later`, async t => {
  const f = await setup(t);
  f.db.raw.prepare("INSERT INTO release_jobs(id,kind,state,available_at,created_at) VALUES('future-episode','delete','pending',?,?)").run(at, at);
  f.db.raw.prepare("UPDATE release_jobs SET queued_at=? WHERE id='future-episode'").run(at + 1);
  const s = f.snapshot(); s.collectedAt += collectionDelay;
  assert.throws(() => assessOperations(f.selected, s, { now: at + collectionDelay }), /future.*queue|queue.*future/i);
});

test('payload intent creation cannot occur after the database observation', async t => {
  const f = await setup(t);
  f.db.raw.prepare("INSERT INTO release_payload_intents(id,account_id,space_id,client_key,request_hash,action,item_count,reserved_bytes,created_at,expires_at) VALUES('future-intent','alice','s1','future-intent','hash','create',1,128,?,?)").run(at + 1, at + 10000);
  assert.throws(() => assessOperations(f.selected, f.snapshot(), { now: at }), /future.*queue|queue.*future/i);
});

test('dead and exhausted queries preserve sanitized failure counts without retained error text', async t => {
  const f = await setup(t);
  const insert = f.db.raw.prepare('INSERT INTO release_jobs(id,kind,state,attempt,available_at,created_at,lease_until,last_error) VALUES(?,?,?,?,?,?,?,?)');
  insert.run('dead-with-error', 'delete', 'dead', 5, at, at, null, 'PRIVATE failure URL');
  insert.run('dead-without-error', 'delete', 'dead', 5, at, at, null, null);
  insert.run('exhausted-with-error', 'delete', 'leased', 5, at, at, at + 1000, 'PRIVATE prior failure');
  const snapshot = f.snapshot(), report = assessOperations(f.selected, snapshot, { now: at });
  assert.equal(report.queues.find(q => q.metric === 'jobs-dead').failuresObserved, 1);
  assert.equal(report.queues.find(q => q.metric === 'jobs-exhausted-leases').failuresObserved, 1);
  assert.doesNotMatch(JSON.stringify(snapshot) + JSON.stringify(report), /PRIVATE|dead-with|exhausted-with/);
});

test('the first actual provider lease is not a retry; failed pending and second lease are retries', async t => {
  const f = await setup(t);
  f.db.raw.prepare("INSERT INTO release_jobs(id,kind,state,available_at,created_at) VALUES('first-lease','delete','pending',?,?)").run(at, at);
  const jobs = new Jobs({ DB: f.db, BACKGROUND_JOBS_ENABLED: 'true', MEMORY_INDEX: {} }, () => at);
  assert.equal((await jobs.claim()).attempt, 1);
  let report = assessOperations(f.selected, f.snapshot(), { now: at });
  assert.equal(report.queues.find(q => q.metric === 'jobs-leased-delete-0').retriesObserved, 0);
  f.db.raw.prepare("UPDATE release_jobs SET state='pending',lease_until=NULL,lease_token=NULL,last_error='provider_or_processing_failure',available_at=? WHERE id='first-lease'").run(at);
  report = assessOperations(f.selected, f.snapshot(), { now: at });
  assert.equal(report.queues.find(q => q.metric === 'jobs-pending-delete-0').retriesObserved, 1);
  assert.equal((await jobs.claim()).attempt, 2);
  report = assessOperations(f.selected, f.snapshot(), { now: at });
  assert.equal(report.queues.find(q => q.metric === 'jobs-leased-delete-0').retriesObserved, 1);
});

test('intent queues do not invent retry or failure counters that their schema cannot supply', async t => {
  const f = await setup(t);
  f.db.raw.prepare("INSERT INTO release_payload_intents(id,account_id,space_id,client_key,request_hash,action,item_count,reserved_bytes,created_at,expires_at) VALUES('intent-counters','alice','s1','intent-counters','hash','create',1,128,?,?)").run(at, at + 10000);
  const q = assessOperations(f.selected, f.snapshot(), { now: at }).queues.find(q => q.metric === 'payload-intents');
  assert.equal(q.retriesObserved, null); assert.equal(q.failuresObserved, null);
});

for (const [attempt, error, expected] of [[1, null, 0], [1, 'provider_failure', 1], [2, null, 1]]) test(`payload cleanup attempt${attempt} error${Boolean(error)} has ${expected} observed retry`, async t => {
  const f = await setup(t);
  f.db.raw.prepare("INSERT INTO release_payload_intents(id,account_id,space_id,client_key,request_hash,action,item_count,reserved_bytes,created_at,expires_at) VALUES('cleanup-intent','alice','s1','cleanup-intent','hash','create',1,128,?,?)").run(at, at + 10000);
  f.db.raw.prepare("INSERT INTO release_payload_stages(id,intent_id,ordinal,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,logical_bytes,created_at) VALUES('cleanup-payload','cleanup-intent',0,'private-memory','a','payload/v1/cleanup',?,64,64,?)").run('a'.repeat(64), at);
  f.db.raw.prepare("INSERT INTO release_payload_purges(payload_id,space_id,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,created_at,available_at,attempts,last_error) VALUES('cleanup-payload','s1','private-memory','a','payload/v1/cleanup',?,64,?,?,?,?)").run('a'.repeat(64), at, at + 60000, attempt, error);
  const q = assessOperations(f.selected, f.snapshot(), { now: at }).queues.find(q => q.metric === 'payload-purges');
  assert.equal(q.retriesObserved, expected); assert.equal(q.failuresObserved, error ? 1 : 0);
});
test('empty traffic with independently zero HTTP requests is valid and overrides cannot raise the USD50 ceiling', async t => {
  const f = await setup(t), s = f.snapshot(); Object.assign(s.traffic, { requests: 0, primaryRequests: 0, p95Ms: null }); assert.equal(assessOperations(f.selected, s, { now: at }).exitCode, 0);
  assert.throws(() => assessOperations(f.selected, s, { now: at, policy: { monthlyCriticalUsd: 51 } }), /50/);
});
test('reported provider byte limits accept 10GiB paid capacity and a smaller free-plan limit', async t => {
  const f = await setup(t), s = f.snapshot(); s.capacity.databases[0].limitBytes = 10 * 1024 ** 3; s.capacity.databases[1].limitBytes = 500 * 1024 ** 2;
  assert.equal(assessOperations(f.selected, s, { now: at }).exitCode, 0);
});
for (const [name, mutate] of [
  ['extra private field', s => { s.token = 'PRIVATE'; }], ['wrong target', s => { s.resourceFingerprint = 'b'.repeat(64); }],
  ['future capture', s => { s.collectedAt = at + 1; }], ['negative bytes', s => { s.capacity.databases[0].bytes = -1; }],
  ['missing shard', s => { s.capacity.databases.pop(); }], ['extra raw result', s => { s.database.results.heartbeat[0].token = 'PRIVATE'; }],
]) test(`invalid snapshot rejects ${name}`, async t => { const f = await setup(t), s = f.snapshot(); mutate(s); assert.throws(() => assessOperations(f.selected, s, { now: at })); });
test('CLI refuses arbitrary credential flags without echoing them', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', resolve('scripts/operations-cli.mjs'), 'assess', '--token', 'PRIVATE'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Unsupported/); assert.doesNotMatch(result.stderr + result.stdout, /PRIVATE/);
});
test('CLI uses the actual config and emits a redacted nonzero assessment for old actual captures', async t => {
  const f = await setup(t), dir = await mkdtemp(join(tmpdir(), 'memory operations ')); t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'target.jsonc'), input = join(dir, 'snapshot.json'); await writeFile(configPath, JSON.stringify(f.selected.config)); await writeFile(input, JSON.stringify(f.snapshot()));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', resolve('scripts/operations-cli.mjs'), 'assess', '--config', configPath, '--snapshot', input], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr); assert.equal(JSON.parse(result.stdout).alertDelivered, false); assert.doesNotMatch(result.stdout, /https:|ops\.example/);
});
test('CLI records unknown metrics with exit2 and installs output exclusively', async t => {
  const f = await setup(t), dir = await mkdtemp(join(tmpdir(), 'memory operations ')); t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'target.jsonc'), input = join(dir, 'snapshot.json'), out = join(dir, 'report.json'); await writeFile(configPath, JSON.stringify(f.selected.config));
  const s = f.snapshot(); s.budget = null; await writeFile(input, JSON.stringify(s));
  const args = ['assess', '--config', configPath, '--snapshot', input, '--out', out], result = await runOperationsCommand(args, { now: at });
  assert.equal(result.exitCode, 2); assert.equal(JSON.parse(await readFile(out, 'utf8')).budget.totalUsd, null);
  await assert.rejects(runOperationsCommand(args, { now: at }));
  await writeFile(input, JSON.stringify(s).replace('"format":1', '"format":1,"format":1'));
  await assert.rejects(runOperationsCommand(args.slice(0, -2), { now: at }), /Duplicate/);
});

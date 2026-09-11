import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const built = await build({ stdin: { contents: `
import { AgentMemoryBudgetLedger } from '../../src/routing/budget-ledger-object.ts';
export class TestBudget extends AgentMemoryBudgetLedger {
 constructor(ctx,env) {
  super(ctx,env);
  this.ledger.now=()=>this.ctx.storage.sql.exec('SELECT at_ms FROM fixture_clock WHERE singleton=1').toArray()[0]?.at_ms??Date.now();
  ctx.blockConcurrencyWhile(async()=>this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_clock(singleton INTEGER PRIMARY KEY,at_ms INTEGER)').toArray());
 }
 setTime(at) { this.ctx.storage.sql.exec('INSERT INTO fixture_clock VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET at_ms=excluded.at_ms',at).toArray(); }
 inspect() { return {months:this.ctx.storage.sql.exec('SELECT * FROM budget_months ORDER BY month').toArray(),
  reservations:this.ctx.storage.sql.exec('SELECT * FROM budget_reservations ORDER BY reservation_id').toArray(),
  total:this.ctx.storage.sql.exec('SELECT total_reservations FROM budget_capacity').toArray()[0].total_reservations}; }
 capacity() { this.ctx.storage.sql.exec('UPDATE budget_capacity SET total_reservations=1000000').toArray(); }
 failNext() { this.ctx.storage.sql.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON budget_reservations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").toArray(); }
 clearFailure() { this.ctx.storage.sql.exec('DROP TRIGGER fixture_failure').toArray(); }
}
const allowed=new Set(['reserve','finalize','usage','setTime','inspect','capacity','failNext','clearFailure']);
export default {async fetch(request,env) {
 const {method,input,name}=await request.json();
 if(!allowed.has(method))return new Response(null,{status:400});
 try {const stub=name===null?env.BUDGET.get(env.BUDGET.newUniqueId()):env.BUDGET.getByName(name);
  return Response.json({value:await stub[method](input)});}
 catch(error) {return Response.json({error:error.message},{status:400});}
}};`, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'budget-native-fixture.mjs' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'] });
const script = built.outputFiles[0].text;
const at = Date.UTC(2026, 8, 11, 10);
const policy = { version: 1, revision: 'pilot-1', validUntilMs: Date.UTC(2026, 10, 1),
  maxMonthlyRequests: 100, maxMonthlyInputBytes: 1000000, maxMonthlyReservedMicroUsd: 50000000,
  ingestBaseMicroUsd: 10, ingestMicroUsdPerKiB: 3, searchBaseMicroUsd: 20, searchMicroUsdPerKiB: 5,
  pricingBasis: 'operator-upper-bound' };
const base = { budgetId: 'deployment', reservationId: 'ticket-1', spaceId: 'space-1', operation: 'memory_ingest',
  payloadHash: 'a'.repeat(64), usage: { inputBytes: 1025, messageCount: 1 }, authorityExpiresAtMs: at + 120000, policy };
const denied = code => error => error.message.includes(code);
async function fixture(t, persist = false) {
  const directory = persist ? await mkdtemp(join(tmpdir(), 'memory-budget-native-')) : undefined;
  let mf;
  const start = () => { mf = new Miniflare(convertV4MiniflareOptions({ name: 'routing-budget-test', modules: true,
    compatibilityDate: '2026-09-08', script, durableObjects: { BUDGET: { className: 'TestBudget', useSQLite: true } },
    ...(directory ? { resourcePersistencePath: directory } : {}), outboundService: () => new Response('outbound disabled', { status: 503 }) })); };
  start();
  t.after(async () => { await mf.dispose(); if (directory) {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); assert.ok(directory.includes('memory-budget-native-'));
    await rm(directory, { recursive: true, force: true });
  } });
  const call = async (method, input = {}, name = 'budget:deployment') => {
    const response = await mf.dispatchFetch('https://fixture.test', { method: 'POST', body: JSON.stringify({ method, input, name }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error); return body.value;
  };
  await call('setTime', at);
  return { call, reserve(extra = {}) { return call('reserve', { ...base, ...extra }); },
    usage() { return call('usage', { budgetId: 'deployment' }); }, async restart() { await mf.dispose(); start(); } };
}

test('native budget RPC admits one concurrent reservation and persists its original expiry and policy across restart', { timeout: 30000 }, async t => {
  const f = await fixture(t, true);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.reserve()));
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(new Set(results.map(result => result.expiresAtMs)).size, 1);
  assert.equal((await f.usage()).requests, 1); assert.equal((await f.usage()).reservedMicroUsd, 16);
  const before = await f.call('inspect'); assert.equal(before.total, 1); assert.equal(before.reservations.length, 1);
  assert.match(before.months[0].policy_hash, /^[0-9a-f]{64}$/);
  await f.restart(); await f.call('setTime', at + 90000);
  const replay = await f.reserve({ authorityExpiresAtMs: at + 200000 }); assert.equal(replay.replayed, true);
  assert.equal(replay.expiresAtMs, at + 60000); assert.deepEqual(await f.call('inspect'), before);
  await assert.rejects(f.reserve({ spaceId: 'other' }), denied('routing_budget_reservation_conflict'));
});

test('native concurrent Spaces share one exact request, byte and reservation-money boundary', { timeout: 30000 }, async t => {
  const f = await fixture(t), capped = { ...policy, maxMonthlyRequests: 3, maxMonthlyInputBytes: 3075, maxMonthlyReservedMicroUsd: 48 };
  const results = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => f.reserve({ reservationId: 'r-' + i, spaceId: 'space-' + i, policy: capped })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => denied('routing_budget_exhausted')(result.reason)));
  assert.deepEqual(await f.usage(), { month: '2026-09', requests: 3, inputBytes: 3075, reservedMicroUsd: 48,
    accepted: 0, unknown: 0, readFailed: 0, notDispatched: 0, billingVerified: false });
  const stored = await f.call('inspect'); assert.equal(stored.total, 3); assert.equal(stored.reservations.length, 3);
  for (const row of stored.reservations) await f.call('finalize', { budgetId: 'deployment', reservationId: row.reservation_id, state: 'not_dispatched' });
  assert.equal((await f.usage()).notDispatched, 3); assert.equal((await f.usage()).reservedMicroUsd, 48);
  await assert.rejects(f.reserve({ reservationId: 'after-failure', policy: capped }), denied('routing_budget_exhausted'));
});

test('native policy race pins a single policy with no mixed pricing, replays or partial losers', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.reserve({ reservationId: 'one', policy: { ...policy, revision: 'one' } }),
    f.reserve({ reservationId: 'two', policy: { ...policy, revision: 'two', ingestBaseMicroUsd: 30 } }) ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(denied('routing_budget_policy_conflict')(results.find(result => result.status === 'rejected').reason));
  const stored = await f.call('inspect'); assert.equal(stored.total, 1); assert.equal(stored.months.length, 1);
  const winner = JSON.parse(stored.months[0].policy_record).revision;
  assert.equal(stored.reservations[0].reservation_id, winner);
  assert.equal(stored.months[0].reserved_micro_usd, winner === 'one' ? 16 : 36);
});

test('native UTC rollover and late finalization retain prior charges, terminal outcomes and replay tombstones', { timeout: 30000 }, async t => {
  const f = await fixture(t), boundary = Date.UTC(2026, 9, 1);
  await f.call('setTime', boundary - 1);
  const input = { authorityExpiresAtMs: boundary + 120000, operation: 'memory_search', usage: { inputBytes: 1, messageCount: 0 } };
  const first = await f.reserve(input);
  await f.call('setTime', boundary + 90000);
  await f.call('finalize', { budgetId: 'deployment', reservationId: 'ticket-1', state: 'read_failed' });
  await f.call('finalize', { budgetId: 'deployment', reservationId: 'ticket-1', state: 'read_failed' });
  await assert.rejects(f.call('finalize', { budgetId: 'deployment', reservationId: 'ticket-1', state: 'accepted' }), denied('routing_budget_transition_invalid'));
  assert.deepEqual(await f.reserve(input), { ...first, replayed: true }); assert.equal((await f.usage()).requests, 0);
  await f.reserve({ ...input, reservationId: 'october', policy: { ...policy, revision: 'october', searchBaseMicroUsd: 30 } });
  const stored = await f.call('inspect'); assert.equal(stored.total, 2);
  assert.deepEqual(stored.months.map(row => [row.month, row.requests, row.reserved_micro_usd, row.read_failed]), [['2026-09', 1, 25, 1], ['2026-10', 1, 35, 0]]);
});

test('native strict metadata boundaries, identity binding and fresh expiry checks reject before accounting', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.reserve({ text: 'private transcript' }), denied('routing_budget_input_invalid'));
  await assert.rejects(f.reserve({ policy: { ...policy, bearer: 'private token' } }), denied('routing_budget_input_invalid'));
  await assert.rejects(f.reserve({ budgetId: 'different' }), denied('routing_budget_identity_mismatch'));
  await assert.rejects(f.call('reserve', base, 'budget:fresh'), denied('routing_budget_identity_mismatch'));
  await assert.rejects(f.call('usage', { budgetId: 'deployment' }, null), denied('routing_budget_identity_mismatch'));
  await assert.rejects(f.reserve({ authorityExpiresAtMs: at }), denied('routing_budget_authority_expired'));
  await assert.rejects(f.reserve({ policy: { ...policy, validUntilMs: at } }), denied('routing_budget_policy_expired'));
  await assert.rejects(f.reserve({ policy: { ...policy, maxMonthlyReservedMicroUsd: 50000001 } }), denied('routing_budget_input_invalid'));
  assert.equal((await f.call('inspect')).total, 0);
  const short = await f.reserve({ policy: { ...policy, validUntilMs: at + 30 } }); assert.equal(short.expiresAtMs, at + 30);
  await f.call('setTime', at + 30);
  await assert.rejects(f.reserve({ policy: { ...policy, validUntilMs: at + 30 } }), denied('routing_budget_policy_expired'));
  await f.call('finalize', { budgetId: 'deployment', reservationId: 'ticket-1', state: 'unknown' });
  assert.equal((await f.usage()).unknown, 1); assert.equal((await f.usage()).billingVerified, false);
  const stored = JSON.stringify(await f.call('inspect')); assert.equal(stored.includes('private transcript'), false); assert.equal(stored.includes('private token'), false);
});

test('native SQLite rolls back all partial admission writes and conservatively bounds lifetime tombstones', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.call('failNext');
  await assert.rejects(f.reserve(), /fixture failure/);
  let stored = await f.call('inspect'); assert.equal(stored.total, 0); assert.equal(stored.months.length, 0); assert.equal(stored.reservations.length, 0);
  await f.call('clearFailure'); await f.reserve();
  await f.call('capacity');
  await assert.rejects(f.reserve({ reservationId: 'fresh' }), denied('routing_budget_capacity_exceeded'));
  assert.equal((await f.reserve()).replayed, true);
  await f.call('finalize', { budgetId: 'deployment', reservationId: 'ticket-1', state: 'unknown' });
  stored = await f.call('inspect'); assert.equal(stored.total, 1000000); assert.equal(stored.reservations.length, 1);
  assert.equal((await f.usage()).requests, 1); assert.equal((await f.usage()).unknown, 1);
});

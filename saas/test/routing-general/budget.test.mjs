import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RoutingBudgetLedger, parseRoutingBudgetPolicy } from '../../src/routing/budget-ledger.ts';

const at = Date.UTC(2026, 8, 11, 10);
const policy = { version: 1, revision: 'pilot-1', validUntilMs: Date.UTC(2026, 10, 1),
  maxMonthlyRequests: 100, maxMonthlyInputBytes: 1000000, maxMonthlyReservedMicroUsd: 50000000,
  ingestBaseMicroUsd: 10, ingestMicroUsdPerKiB: 3, searchBaseMicroUsd: 20, searchMicroUsdPerKiB: 5,
  pricingBasis: 'operator-upper-bound' };
const input = { budgetId: 'deployment', reservationId: 'ticket-1', spaceId: 'space-1', operation: 'memory_ingest',
  payloadHash: 'a'.repeat(64), usage: { inputBytes: 1025, messageCount: 1 }, authorityExpiresAtMs: at + 120000, policy };
const denied = code => error => error.message.includes(code);
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const storage = { sql: { exec(query, ...values) {
    if (!values.length && query.includes(';')) { db.exec(query); return { toArray: () => [] }; }
    return { toArray: () => db.prepare(query).all(...values) };
  } }, transactionSync(callback) { db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; } } };
  let time = at;
  const make = () => new RoutingBudgetLedger(storage, { now: () => time, objectName: 'budget:deployment', ...options });
  const ledger = make(); ledger.initialize();
  return { db, ledger, time(value) { time = value; }, restart() { const next = make(); next.initialize(); return next; },
    reserve(extra = {}) { return ledger.reserve({ ...input, ...extra }); }, usage() { return ledger.usage({ budgetId: 'deployment' }); } };
}

test('global budget reserves ceil KiB once across replay and exposes unverified billing', async t => {
  const f = fixture(t), first = await f.reserve();
  assert.deepEqual(first, { reservationId: 'ticket-1', month: '2026-09', reservedMicroUsd: 16, expiresAtMs: at + 60000, replayed: false });
  assert.deepEqual(await f.reserve(), { ...first, replayed: true });
  assert.deepEqual(await f.usage(), { month: '2026-09', requests: 1, inputBytes: 1025, reservedMicroUsd: 16,
    accepted: 0, unknown: 0, readFailed: 0, notDispatched: 0, billingVerified: false });
  assert.deepEqual(await f.restart().reserve(input), { ...first, replayed: true });
});

test('empty ingest still reserves a positive base cost and searches use their separate rates', async t => {
  const f = fixture(t);
  assert.equal((await f.reserve({ usage: { inputBytes: 0, messageCount: 1 } })).reservedMicroUsd, 10);
  assert.equal((await f.reserve({ reservationId: 'search', operation: 'memory_search', usage: { inputBytes: 1024, messageCount: 0 } })).reservedMicroUsd, 25);
  assert.equal((await f.reserve({ reservationId: 'ingest-1024', usage: { inputBytes: 1024, messageCount: 500 } })).reservedMicroUsd, 13);
  assert.equal((await f.usage()).requests, 3);
});

test('strict RPC rejects content, secrets, invalid operation and inconsistent usage before mutations', async t => {
  const f = fixture(t);
  const malformed = [ { text: 'private transcript' }, { token: 'private-bearer' }, { budgetId: '../other' },
    { reservationId: '' }, { payloadHash: 'a'.repeat(63) }, { operation: 'memory_clear_space' },
    { usage: { inputBytes: 1, messageCount: 1, query: 'private' } }, { usage: { inputBytes: -1, messageCount: 1 } },
    { usage: { inputBytes: 1, messageCount: 501 } }, { usage: { inputBytes: 1, messageCount: 0 } },
    { operation: 'memory_search', usage: { inputBytes: 0, messageCount: 0 } },
    { operation: 'memory_search', usage: { inputBytes: 1, messageCount: 1 } },
    { usage: { inputBytes: 1.5, messageCount: 1 } }, { usage: { inputBytes: Number.MAX_SAFE_INTEGER, messageCount: 1 } },
    { authorityExpiresAtMs: Infinity }, { authorityExpiresAtMs: -1 } ];
  for (const extra of malformed) await assert.rejects(f.reserve(extra), denied('routing_budget_input_invalid'));
  await assert.rejects(f.ledger.usage({ budgetId: 'deployment', query: 'secret' }), denied('routing_budget_input_invalid'));
  await assert.rejects(f.ledger.finalize({ budgetId: 'deployment', reservationId: 'ticket-1', state: 'accepted', result: 'secret' }), denied('routing_budget_input_invalid'));
  assert.equal((await f.usage()).requests, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM budget_months').get().n, 0);
});

test('policy structural parser bounds ceilings and rates without depending on the current time', () => {
  assert.deepEqual(parseRoutingBudgetPolicy({ ...policy, validUntilMs: 1 }), { ...policy, validUntilMs: 1 });
  for (const change of [ { version: 2 }, { revision: '' }, { pricingBasis: 'actual-bill' }, { maxMonthlyRequests: 0 },
    { maxMonthlyRequests: 100001 }, { maxMonthlyInputBytes: 1000000001 }, { maxMonthlyInputBytes: 0 },
    { maxMonthlyReservedMicroUsd: 50000001 }, { maxMonthlyReservedMicroUsd: 0 }, { ingestBaseMicroUsd: 0 },
    { ingestMicroUsdPerKiB: -1 }, { searchBaseMicroUsd: 50000001 }, { searchMicroUsdPerKiB: 1.5 },
    { maxMonthlyReservedMicroUsd: Number.MAX_SAFE_INTEGER }, { validUntilMs: NaN }, { token: 'secret' } ]) {
    assert.throws(() => parseRoutingBudgetPolicy({ ...policy, ...change }), denied('routing_budget_input_invalid'));
  }
});

test('identity is immutable and the first request must agree with the object name', async t => {
  const f = fixture(t);
  await assert.rejects(f.reserve({ budgetId: 'other' }), denied('routing_budget_identity_mismatch'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM budget_identity').get().n, 0);
  await f.reserve();
  await assert.rejects(f.ledger.usage({ budgetId: 'other' }), denied('routing_budget_identity_mismatch'));
  await assert.rejects(f.ledger.finalize({ budgetId: 'other', reservationId: 'ticket-1', state: 'accepted' }), denied('routing_budget_identity_mismatch'));
  assert.throws(() => f.db.exec("UPDATE budget_identity SET budget_id='other'"));
  assert.throws(() => f.db.exec('DELETE FROM budget_identity'));
  const unnamed = fixture(t, { objectName: undefined }); await unnamed.reserve();
  await assert.rejects(unnamed.reserve({ budgetId: 'other' }), denied('routing_budget_identity_mismatch'));
});

test('monthly policy hash is deterministic independent of property order and freezes every policy field', async t => {
  const f = fixture(t); await f.reserve();
  const reversed = Object.fromEntries(Object.entries(policy).reverse());
  assert.equal((await f.reserve({ policy: reversed })).replayed, true);
  const row = f.db.prepare('SELECT * FROM budget_months').get(); assert.match(row.policy_hash, /^[0-9a-f]{64}$/);
  for (const change of [ { revision: 'pilot-2' }, { validUntilMs: policy.validUntilMs + 1 },
    { maxMonthlyRequests: 99 }, { maxMonthlyInputBytes: 999999 }, { maxMonthlyReservedMicroUsd: 49999999 },
    { ingestBaseMicroUsd: 11 }, { ingestMicroUsdPerKiB: 4 }, { searchBaseMicroUsd: 21 }, { searchMicroUsdPerKiB: 6 } ]) {
    await assert.rejects(f.reserve({ reservationId: 'fresh', policy: { ...policy, ...change } }), denied('routing_budget_policy_conflict'));
    await assert.rejects(f.reserve({ policy: { ...policy, ...change } }), denied('routing_budget_policy_conflict'));
  }
  assert.equal((await f.usage()).requests, 1);
  assert.throws(() => f.db.exec("UPDATE budget_months SET policy_hash='changed'"));
});

test('request, byte and monetary ceilings enforce one global admission boundary across Spaces', async t => {
  for (const limits of [ { maxMonthlyRequests: 2 }, { maxMonthlyInputBytes: 2050 }, { maxMonthlyReservedMicroUsd: 32 } ]) {
    const f = fixture(t), capped = { ...policy, ...limits };
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => f.reserve({ reservationId: 'r-' + i, spaceId: 's-' + i, policy: capped })));
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 2);
    assert.ok(outcomes.filter(outcome => outcome.status === 'rejected').every(outcome => denied('routing_budget_exhausted')(outcome.reason)));
    const usage = await f.usage(); assert.equal(usage.requests, 2); assert.equal(usage.inputBytes, 2050); assert.equal(usage.reservedMicroUsd, 32);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM budget_reservations').get().n, 2);
  }
});

test('a rejected first admission does not pin policy or partially charge counters', async t => {
  const f = fixture(t);
  await assert.rejects(f.reserve({ policy: { ...policy, maxMonthlyReservedMicroUsd: 15 } }), denied('routing_budget_exhausted'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM budget_months').get().n, 0);
  assert.equal(f.db.prepare('SELECT total_reservations FROM budget_capacity').get().total_reservations, 0);
  assert.equal((await f.reserve()).reservedMicroUsd, 16);
});

test('safe integer arithmetic rejects high exact costs instead of overflowing or rounding', async t => {
  const f = fixture(t);
  await assert.rejects(f.reserve({ usage: { inputBytes: 1000000000, messageCount: 1 }, policy: { ...policy,
    maxMonthlyInputBytes: 1000000000, ingestBaseMicroUsd: 50000000, ingestMicroUsdPerKiB: 50000000 } }), denied('routing_budget_exhausted'));
  assert.equal((await f.usage()).requests, 0);
  const reservation = await f.reserve({ usage: { inputBytes: 1024, messageCount: 1 }, policy: { ...policy,
    ingestBaseMicroUsd: 49999999, ingestMicroUsdPerKiB: 1 } });
  assert.equal(reservation.reservedMicroUsd, 50000000);
  await assert.rejects(f.reserve({ reservationId: 'another', usage: { inputBytes: 0, messageCount: 1 }, policy: { ...policy,
    ingestBaseMicroUsd: 49999999, ingestMicroUsdPerKiB: 1 } }), denied('routing_budget_exhausted'));
});

test('reservation replay cannot change its Space, operation, payload or usage', async t => {
  const f = fixture(t); await f.reserve();
  for (const extra of [ { spaceId: 'other' }, { payloadHash: 'b'.repeat(64) }, { usage: { inputBytes: 1024, messageCount: 1 } },
    { usage: { inputBytes: 1025, messageCount: 2 } }, { operation: 'memory_search', usage: { inputBytes: 1025, messageCount: 0 } } ]) {
    await assert.rejects(f.reserve(extra), denied('routing_budget_reservation_conflict'));
  }
  assert.equal((await f.usage()).requests, 1);
});

test('replay is allowed at an exhausted quota but never renews the original expiration', async t => {
  const f = fixture(t), capped = { ...policy, maxMonthlyRequests: 1 };
  const first = await f.reserve({ policy: capped }); f.time(at + 90000);
  const replay = await f.reserve({ policy: capped, authorityExpiresAtMs: at + 200000 });
  assert.deepEqual(replay, { ...first, replayed: true }); assert.ok(replay.expiresAtMs < at + 90000);
  await assert.rejects(f.reserve({ reservationId: 'fresh', policy: capped, authorityExpiresAtMs: at + 200000 }), denied('routing_budget_exhausted'));
});

test('reservation expiration is bounded by authority, policy and fresh post-hash server clock', async t => {
  const f = fixture(t);
  assert.equal((await f.reserve({ authorityExpiresAtMs: at + 25 })).expiresAtMs, at + 25);
  const g = fixture(t);
  assert.equal((await g.reserve({ policy: { ...policy, validUntilMs: at + 40 } })).expiresAtMs, at + 40);
  const h = fixture(t); const pending = h.reserve(); h.time(at + 1000);
  assert.equal((await pending).expiresAtMs, at + 61000);
  const i = fixture(t); const value = structuredClone(input); const attempt = i.ledger.reserve(value);
  value.policy.ingestBaseMicroUsd = 50000000; value.usage.inputBytes = 0;
  assert.equal((await attempt).reservedMicroUsd, 16);
});

test('expired policy or authority denies first reservation and existing-ID replay', async t => {
  const f = fixture(t);
  await assert.rejects(f.reserve({ authorityExpiresAtMs: at }), denied('routing_budget_authority_expired'));
  await assert.rejects(f.reserve({ policy: { ...policy, validUntilMs: at } }), denied('routing_budget_policy_expired'));
  await f.reserve({ policy: { ...policy, validUntilMs: at + 100 } }); f.time(at + 100);
  await assert.rejects(f.reserve({ policy: { ...policy, validUntilMs: at + 100 } }), denied('routing_budget_policy_expired'));
  assert.equal((await f.usage()).requests, 1);
});

test('UTC month rollover resets totals, allows a new policy, and never recharges old reservation IDs', async t => {
  const f = fixture(t), end = Date.UTC(2026, 8, 30, 23, 59, 59, 999); f.time(end);
  const first = await f.reserve({ authorityExpiresAtMs: end + 120000 }); assert.equal(first.month, '2026-09');
  f.time(end + 1); assert.equal((await f.usage()).month, '2026-10'); assert.equal((await f.usage()).requests, 0);
  assert.deepEqual(await f.reserve({ authorityExpiresAtMs: end + 120000 }), { ...first, replayed: true });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM budget_months').get().n, 1);
  await f.reserve({ reservationId: 'october', policy: { ...policy, revision: 'october' }, authorityExpiresAtMs: end + 120000 });
  assert.equal((await f.usage()).requests, 1);
  await assert.rejects(f.reserve({ policy: { ...policy, revision: 'october' }, authorityExpiresAtMs: end + 120000 }), denied('routing_budget_policy_conflict'));
  assert.deepEqual(await f.reserve({ authorityExpiresAtMs: end + 120000 }), { ...first, replayed: true });
});

test('finalization after expiry charges the original month once and never refunds any outcome', async t => {
  const f = fixture(t);
  for (const [i, state] of ['accepted', 'unknown', 'read_failed', 'not_dispatched'].entries()) {
    await f.reserve({ reservationId: 'r-' + i, operation: 'memory_search', usage: { inputBytes: 1, messageCount: 0 } });
  }
  f.time(Date.UTC(2026, 9, 1));
  for (const [i, state] of ['accepted', 'unknown', 'read_failed', 'not_dispatched'].entries()) {
    const done = { budgetId: 'deployment', reservationId: 'r-' + i, state };
    assert.equal(await f.ledger.finalize(done), undefined); assert.equal(await f.ledger.finalize(done), undefined);
    await assert.rejects(f.ledger.finalize({ ...done, state: state === 'accepted' ? 'unknown' : 'accepted' }), denied('routing_budget_transition_invalid'));
  }
  assert.equal((await f.usage()).requests, 0);
  const stored = f.db.prepare("SELECT * FROM budget_months WHERE month='2026-09'").get();
  assert.equal(stored.requests, 4); assert.equal(stored.reserved_micro_usd, 100);
  assert.deepEqual([stored.accepted, stored.unknown, stored.read_failed, stored.not_dispatched], [1, 1, 1, 1]);
});

test('only search may read-fail and finalization cannot invent a reservation', async t => {
  const f = fixture(t); await f.reserve();
  await assert.rejects(f.ledger.finalize({ budgetId: 'deployment', reservationId: 'missing', state: 'unknown' }), denied('routing_budget_reservation_unavailable'));
  await assert.rejects(f.ledger.finalize({ budgetId: 'deployment', reservationId: 'ticket-1', state: 'read_failed' }), denied('routing_budget_transition_invalid'));
  await f.ledger.finalize({ budgetId: 'deployment', reservationId: 'ticket-1', state: 'unknown' });
  assert.equal((await f.reserve()).replayed, true); assert.equal((await f.usage()).unknown, 1);
  assert.throws(() => f.db.exec("DELETE FROM budget_reservations WHERE reservation_id='ticket-1'"));
  assert.throws(() => f.db.exec("UPDATE budget_reservations SET payload_hash='changed'"));
});

test('permanent tombstone capacity fails closed while allowing replay and terminal accounting', async t => {
  const f = fixture(t); await f.reserve();
  // Accelerate the trusted lifetime counter to its documented ceiling without a million-row test fixture.
  f.db.exec('UPDATE budget_capacity SET total_reservations=1000000');
  await assert.rejects(f.reserve({ reservationId: 'fresh' }), denied('routing_budget_capacity_exceeded'));
  assert.equal((await f.reserve()).replayed, true);
  await f.ledger.finalize({ budgetId: 'deployment', reservationId: 'ticket-1', state: 'not_dispatched' });
  assert.equal((await f.usage()).notDispatched, 1); assert.equal((await f.usage()).requests, 1);
  assert.throws(() => f.db.exec('UPDATE budget_capacity SET total_reservations=0'));
  assert.throws(() => f.db.exec('DELETE FROM budget_capacity'));
});

test('transaction failure rolls back reservation, counters and policy together', async t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON budget_reservations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  await assert.rejects(f.reserve(), /fixture failure/);
  assert.equal((await f.usage()).requests, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM budget_months').get().n, 0);
  assert.equal(f.db.prepare('SELECT total_reservations FROM budget_capacity').get().total_reservations, 0);
  f.db.exec('DROP TRIGGER fixture_failure'); await f.reserve(); assert.equal((await f.usage()).requests, 1);
});

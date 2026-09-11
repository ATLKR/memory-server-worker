import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GeneralSpaceLedger } from '../../src/routing/general-ledger.ts';

const identity = { spaceId: 'space', owner: { kind: 'organization', id: 'organization' }, provider: { accountId: 'provider', namespace: 'namespace' } };
const actor = { accountId: 'user', credentialId: 'credential' };
const at = Date.UTC(2026, 8, 11);
const base = { identity, actor, operation: 'memory_ingest', operationId: 'operation', payloadHash: 'a'.repeat(64), usage: { inputBytes: 123, messageCount: 2 }, authorityExpiresAtMs: at + 120000 };
const retire = { identity, actor, operationId: 'clear', payloadHash: 'b'.repeat(64), authorityExpiresAtMs: at + 120000 };
const denied = code => error => error.message.includes(code);
function fixture(t, objectName = 'space:space') {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let time = at;
  const storage = { sql: { exec(query, ...values) {
    if (!values.length && query.includes(';')) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query); return { toArray: () => statement.all(...values) };
  } }, transactionSync(callback) { db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  let ledger;
  const restart = () => { ledger = new GeneralSpaceLedger(storage, { now: () => time, objectName }); ledger.initialize(); return ledger; };
  restart();
  return { get ledger() { return ledger; }, db, restart, setTime(value) { time = value; } };
}
const finish = (ticket, state) => ({ identity, actor, ticketId: ticket.id, state });
const check = (ticket, phase, extra = {}) => ({ identity, actor, ticketId: ticket.id, authorityExpiresAtMs: at + 120000, phase, ...extra });

test('first admission persists one bounded ticket and accounts input once under concurrent replay and restart', async t => {
  const f = fixture(t);
  const tickets = await Promise.all(Array.from({ length: 20 }, () => f.ledger.admit(base)));
  assert.equal(tickets.filter(value => value.dispatch).length, 1);
  assert.equal(new Set(tickets.map(value => value.id)).size, 1);
  assert.equal(tickets[0].generation, 1); assert.equal(tickets[0].state, 'admitted');
  assert.equal(tickets[0].expiresAtMs, at + 60000);
  f.restart();
  assert.deepEqual(await f.ledger.admit(base), { ...tickets[0], dispatch: false });
  assert.deepEqual(await f.ledger.usage({ identity }), { month: '2026-09', generation: 1, admissions: 1, ingestRequests: 1, inputBytes: 123, messages: 2,
    searchRequests: 0, queryBytes: 0, accepted: 0, unknown: 0, readFailed: 0, notDispatched: 0, clearRequests: 0, pendingRetirements: 0 });
});

test('identity binds actual owner and provider permanently, including the fresh object name', async t => {
  const f = fixture(t); await f.ledger.admit(base);
  for (const replacement of [
    { ...identity, spaceId: 'another' }, { ...identity, owner: { kind: 'account', id: identity.owner.id } },
    { ...identity, owner: { ...identity.owner, id: 'another' } }, { ...identity, provider: { ...identity.provider, accountId: 'another' } },
    { ...identity, provider: { ...identity.provider, namespace: 'another' } },
  ]) await assert.rejects(f.ledger.usage({ identity: replacement }), denied('routing_space_identity_mismatch'));
  await assert.rejects(fixture(t, 'space:other').ledger.admit(base), denied('routing_space_identity_mismatch'));
  assert.throws(() => f.db.exec("UPDATE general_identity SET owner_id='another'"));
  assert.throws(() => f.db.exec('DELETE FROM general_identity'));
});

test('operation IDs cannot change actor, operation, content hash, usage or cross retirement boundaries', async t => {
  const f = fixture(t); const first = await f.ledger.admit(base);
  for (const replacement of [
    { ...base, actor: { ...actor, accountId: 'another' } }, { ...base, actor: { ...actor, credentialId: 'another' } },
    { ...base, operation: 'memory_search', usage: { inputBytes: 123, messageCount: 0 } },
    { ...base, payloadHash: 'c'.repeat(64) }, { ...base, usage: { inputBytes: 124, messageCount: 2 } },
    { ...base, usage: { inputBytes: 123, messageCount: 3 } },
  ]) await assert.rejects(f.ledger.admit(replacement), denied('routing_space_operation_conflict'));
  await assert.rejects(f.ledger.retire({ ...retire, operationId: base.operationId }), denied('routing_space_operation_conflict'));
  await f.ledger.retire(retire);
  await assert.rejects(f.ledger.admit({ ...base, operationId: retire.operationId }), denied('routing_space_operation_conflict'));
  assert.deepEqual(await f.ledger.admit(base), { ...first, dispatch: false });
  await assert.rejects(f.ledger.check(check(first, 'dispatch')), denied('routing_space_ticket_unavailable'));
  assert.throws(() => f.db.exec('DELETE FROM general_operations'));
});

test('authority and immutable 60-second ticket expiry gate dispatch and disclosure exactly at boundary', async t => {
  const f = fixture(t); const ticket = await f.ledger.admit({ ...base, authorityExpiresAtMs: at + 100 });
  assert.equal(ticket.expiresAtMs, at + 100);
  await f.ledger.check(check(ticket, 'dispatch'));
  await assert.rejects(f.ledger.check(check(ticket, 'disclose')), denied('routing_space_ticket_unavailable'));
  await assert.rejects(f.ledger.check(check(ticket, 'dispatch', { actor: { ...actor, accountId: 'other' } })), denied('routing_space_ticket_unavailable'));
  await assert.rejects(f.ledger.check(check(ticket, 'dispatch', { authorityExpiresAtMs: at })), denied('routing_space_authority_expired'));
  f.setTime(at + 100);
  await assert.rejects(f.ledger.check(check(ticket, 'dispatch')), denied('routing_space_ticket_unavailable'));
  await f.ledger.finalize(finish(ticket, 'accepted'));
  await assert.rejects(f.ledger.check(check(ticket, 'disclose')), denied('routing_space_ticket_unavailable'));
  await assert.rejects(f.ledger.admit({ ...base, operationId: 'new', authorityExpiresAtMs: at + 100 }), denied('routing_space_authority_expired'));
  await assert.rejects(f.ledger.retire({ ...retire, authorityExpiresAtMs: at + 100 }), denied('routing_space_authority_expired'));
});

test('terminal outcomes persist after expiry and retirement without redispatch, recharging or late disclosure', async t => {
  const f = fixture(t); const ticket = await f.ledger.admit(base);
  await assert.rejects(f.ledger.finalize(finish(ticket, 'read_failed')), denied('routing_space_transition_invalid'));
  await assert.rejects(f.ledger.finalize({ ...finish(ticket, 'accepted'), actor: { ...actor, credentialId: 'another' } }), denied('routing_space_ticket_unavailable'));
  await f.ledger.retire(retire); f.setTime(at + 70000);
  await f.ledger.finalize(finish(ticket, 'unknown')); await f.ledger.finalize(finish(ticket, 'unknown'));
  await assert.rejects(f.ledger.finalize(finish(ticket, 'accepted')), denied('routing_space_transition_invalid'));
  const replay = await f.ledger.admit({ ...base, authorityExpiresAtMs: at + 200000 });
  assert.equal(replay.dispatch, false); assert.equal(replay.state, 'unknown'); assert.equal(replay.generation, 1);
  await assert.rejects(f.ledger.check(check(ticket, 'disclose')), denied('routing_space_ticket_unavailable'));
  assert.equal((await f.ledger.usage({ identity })).unknown, 1);
});

test('search failures and not-dispatched outcomes remain separately metered without body storage', async t => {
  const f = fixture(t);
  const search = await f.ledger.admit({ ...base, operation: 'memory_search', operationId: 'search', usage: { inputBytes: 17, messageCount: 0 } });
  const ingest = await f.ledger.admit(base);
  await f.ledger.finalize(finish(search, 'read_failed')); await f.ledger.finalize(finish(ingest, 'not_dispatched'));
  const usage = await f.ledger.usage({ identity });
  assert.equal(usage.admissions, 2); assert.equal(usage.readFailed, 1); assert.equal(usage.notDispatched, 1);
  assert.equal(usage.queryBytes, 17); assert.equal(usage.inputBytes, 123); assert.equal(usage.messages, 2);
  await assert.rejects(f.ledger.finalize(finish(search, 'accepted')), denied('routing_space_transition_invalid'));
});

test('retirement atomically advances generation once and returns only immutable retired targets for reconciliation', async t => {
  const f = fixture(t); const old = await f.ledger.admit(base); await f.ledger.finalize(finish(old, 'accepted'));
  const attempts = await Promise.all(Array.from({ length: 12 }, () => f.ledger.retire(retire)));
  assert.equal(attempts.filter(value => value.dispatch).length, 1);
  assert.equal(new Set(attempts.map(value => value.id)).size, 1);
  const first = attempts[0];
  assert.equal(first.generation, 1); assert.equal(first.nextGeneration, 2); assert.equal(first.state, 'pending');
  assert.equal(first.logicallyHidden, true); assert.equal(first.physicalPurgeVerified, false);
  await assert.rejects(f.ledger.check(check(old, 'disclose')), denied('routing_space_ticket_unavailable'));
  assert.equal((await f.ledger.admit({ ...base, operationId: 'new' })).generation, 2);
  const next = await f.ledger.retire({ ...retire, operationId: 'clear-2' });
  assert.equal(next.generation, 2); assert.equal(next.nextGeneration, 3);
  assert.deepEqual(await f.ledger.pending({ identity, limit: 1 }), [{ ...first, dispatch: false }]);
  f.restart();
  assert.deepEqual(await f.ledger.pending({ identity, limit: 10 }), [{ ...next, dispatch: false }, { ...first, dispatch: false }]);
  await assert.rejects(f.ledger.retire({ ...retire, payloadHash: 'c'.repeat(64) }), denied('routing_space_operation_conflict'));
  await assert.rejects(f.ledger.retire({ ...retire, actor: { ...actor, accountId: 'other' } }), denied('routing_space_operation_conflict'));
  const usage = await f.ledger.usage({ identity }); assert.equal(usage.clearRequests, 2); assert.equal(usage.pendingRetirements, 2);
});

test('unknown deletions remain reconcilable and acknowledgement is terminal without claiming physical purge', async t => {
  const f = fixture(t); const item = await f.ledger.retire(retire);
  await f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'unknown' });
  assert.equal((await f.ledger.pending({ identity, limit: 10 }))[0].state, 'unknown');
  f.setTime(at + 300000);
  await f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'acknowledged' });
  await f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'acknowledged' });
  await assert.rejects(f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'unknown' }), denied('routing_space_transition_invalid'));
  assert.deepEqual(await f.ledger.pending({ identity, limit: 10 }), []);
  const replay = await f.ledger.retire({ ...retire, authorityExpiresAtMs: at + 400000 });
  assert.equal(replay.dispatch, false); assert.equal(replay.state, 'acknowledged'); assert.equal(replay.physicalPurgeVerified, false);
  assert.equal((await f.ledger.usage({ identity })).pendingRetirements, 0);
  assert.throws(() => f.db.exec('DELETE FROM general_retirements'));
});

test('deletion acknowledgement waits for admitted ingests so a late provider write cannot silently close the outbox', async t => {
  const f = fixture(t); const ticket = await f.ledger.admit(base); const item = await f.ledger.retire(retire);
  await assert.rejects(f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'acknowledged' }), denied('routing_space_retirement_inflight'));
  assert.equal((await f.ledger.pending({ identity, limit: 10 }))[0].state, 'pending');
  await f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'unknown' });
  await assert.rejects(f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'acknowledged' }), denied('routing_space_retirement_inflight'));
  f.setTime(at + 200000);
  await assert.rejects(f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'acknowledged' }), denied('routing_space_retirement_inflight'));
  await f.ledger.finalize(finish(ticket, 'accepted'));
  await f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'acknowledged' });
  assert.deepEqual(await f.ledger.pending({ identity, limit: 10 }), []);
  assert.equal((await f.ledger.retire({ ...retire, authorityExpiresAtMs: at + 300000 })).physicalPurgeVerified, false);
  await assert.rejects(f.ledger.check(check(ticket, 'disclose', { authorityExpiresAtMs: at + 300000 })), denied('routing_space_ticket_unavailable'));
});

test('UTC month rollover keeps historical outcomes and tombstones without charging replays to a new month', async t => {
  const f = fixture(t); const old = await f.ledger.admit(base); await f.ledger.retire(retire);
  const october = Date.UTC(2026, 9, 1); f.setTime(october);
  await f.ledger.finalize(finish(old, 'accepted'));
  assert.equal((await f.ledger.admit({ ...base, authorityExpiresAtMs: october + 100000 })).dispatch, false);
  const usage = await f.ledger.usage({ identity });
  assert.equal(usage.month, '2026-10'); assert.equal(usage.admissions, 0); assert.equal(usage.accepted, 0);
  assert.equal(usage.clearRequests, 0); assert.equal(usage.pendingRetirements, 1);
  await f.ledger.admit({ ...base, operationId: 'october', authorityExpiresAtMs: october + 100000 });
  assert.equal((await f.ledger.usage({ identity })).admissions, 1);
});

test('pending reconciliation rotates past blocked prefixes and resumes its cursor after restart without changing outcomes', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 25; i++) {
    const item = await f.ledger.retire({ ...retire, operationId: 'clear-' + i });
    await f.ledger.finishRetirement({ identity, retirementId: item.id, state: 'unknown' });
  }
  const before = f.db.prepare('SELECT * FROM general_retirements ORDER BY generation').all();
  assert.deepEqual((await f.ledger.pending({ identity, limit: 10 })).map(row => row.generation), [1,2,3,4,5,6,7,8,9,10]);
  f.restart();
  assert.deepEqual((await f.ledger.pending({ identity, limit: 10 })).map(row => row.generation), [11,12,13,14,15,16,17,18,19,20]);
  assert.deepEqual((await f.ledger.pending({ identity, limit: 10 })).map(row => row.generation), [21,22,23,24,25,1,2,3,4,5]);
  assert.deepEqual(f.db.prepare('SELECT * FROM general_retirements ORDER BY generation').all(), before);
});

test('reconciliation skips acknowledged targets and wraps without duplicates or cross-identity cursor changes', async t => {
  const f = fixture(t); const items = [];
  for (let i = 1; i <= 3; i++) items.push(await f.ledger.retire({ ...retire, operationId: 'clear-' + i }));
  await f.ledger.finishRetirement({ identity, retirementId: items[1].id, state: 'acknowledged' });
  assert.deepEqual((await f.ledger.pending({ identity, limit: 1 })).map(row => row.generation), [1]);
  await assert.rejects(f.ledger.pending({ identity: { ...identity, owner: { kind: 'account', id: 'other' } }, limit: 100 }), denied('routing_space_identity_mismatch'));
  await assert.rejects(f.ledger.pending({ identity, limit: 101 }), denied('routing_space_input_invalid'));
  assert.deepEqual((await f.ledger.pending({ identity, limit: 100 })).map(row => row.generation), [3,1]);
  assert.deepEqual((await f.ledger.pending({ identity, limit: 100 })).map(row => row.generation), [3,1]);
  assert.throws(() => f.db.exec('UPDATE general_reconciliation SET cursor_generation=-1'));
  assert.throws(() => f.db.exec('UPDATE general_reconciliation SET cursor_generation=1001'));
  assert.throws(() => f.db.exec('UPDATE general_reconciliation SET cursor_generation=4'));
  assert.throws(() => f.db.exec('UPDATE general_reconciliation SET singleton=2'));
  assert.throws(() => f.db.exec('DELETE FROM general_reconciliation'));
});

test('initialization adds reconciliation scheduling to existing ledger storage without rewriting retained operations', async t => {
  const f = fixture(t); const ticket = await f.ledger.admit(base); const item = await f.ledger.retire(retire);
  // This empty, newly introduced table is absent in a ledger created by the
  // previous schema; the existing identity, operation and retirement stay real.
  f.db.exec('DROP TABLE general_reconciliation');
  f.restart();
  assert.equal((await f.ledger.admit(base)).id, ticket.id);
  assert.deepEqual(await f.ledger.pending({ identity, limit: 10 }), [{ ...item, dispatch: false }]);
  assert.equal(f.db.prepare('SELECT cursor_generation FROM general_reconciliation').get().cursor_generation, 1);
});

test('invalid and raw metadata are rejected before identity or operation writes', async t => {
  const f = fixture(t);
  const invalid = [
    { ...base, content: 'secret transcript' }, { ...base, identity: { ...identity, query: 'secret query' } },
    { ...base, actor: { ...actor, token: 'secret bearer' } }, { ...base, usage: { ...base.usage, body: 'secret' } },
    { ...base, identity: { ...identity, owner: { ...identity.owner, content: 'secret' } } },
    { ...base, identity: { ...identity, provider: { ...identity.provider, token: 'secret' } } },
    { ...base, operationId: 'line\nbreak' }, { ...base, payloadHash: 'not-a-hash' },
    { ...base, usage: { inputBytes: -1, messageCount: 2 } }, { ...base, usage: { inputBytes: 2 ** 21 + 1, messageCount: 2 } },
    { ...base, usage: { inputBytes: 123, messageCount: 0 } }, { ...base, usage: { inputBytes: 123, messageCount: 501 } },
    { ...base, operation: 'memory_search' }, { ...base, authorityExpiresAtMs: NaN },
  ];
  for (const input of invalid) await assert.rejects(f.ledger.admit(input), denied('routing_space_input_invalid'));
  for (const input of [{ identity, limit: 0 }, { identity, limit: 101 }, { identity, limit: 1, token: 'secret' }]) {
    await assert.rejects(f.ledger.pending(input), denied('routing_space_input_invalid'));
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM general_identity').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM general_operations').get().n, 0);
});

test('monthly admission capacity retains replays and still allows privacy retirement', async t => {
  const f = fixture(t); const first = await f.ledger.admit(base);
  f.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9999)
    INSERT INTO general_operations SELECT 'seed-'||x,'user','credential','memory_ingest','seed-'||x,'${'a'.repeat(64)}',1,'unknown',${at},${at},${at + 100},'2026-09',1,1 FROM n`);
  await assert.rejects(f.ledger.admit({ ...base, operationId: 'overflow' }), denied('routing_space_capacity_exceeded'));
  assert.equal((await f.ledger.admit(base)).id, first.id);
  assert.equal((await f.ledger.retire(retire)).generation, 1);
  assert.equal((await f.ledger.usage({ identity })).admissions, 10000);
  f.setTime(Date.UTC(2026, 9, 1));
  assert.equal((await f.ledger.admit({ ...base, operationId: 'next-month', authorityExpiresAtMs: Date.UTC(2026, 9, 1) + 1000 })).dispatch, true);
});

test('retirement capacity fails atomically without changing active generation or erasing prior IDs', async t => {
  const f = fixture(t); await f.ledger.usage({ identity });
  f.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO general_retirements SELECT 'seed-'||x,'user','credential','seed-'||x,'${'b'.repeat(64)}',x,x+1,'acknowledged',${at},${at},'2026-09' FROM n;`);
  await assert.rejects(f.ledger.retire(retire), denied('routing_space_capacity_exceeded'));
  assert.equal((await f.ledger.usage({ identity })).generation, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM general_retirements').get().n, 1000);
  // Once no future deletion target can be retained, accepting another ingest
  // would create data that this ledger could no longer retire.
  await assert.rejects(f.ledger.admit(base), denied('routing_space_capacity_exceeded'));
});

test('total operation cap survives UTC rollover and rejects new ingest without deleting retained tombstones', async t => {
  const f = fixture(t); await f.ledger.usage({ identity });
  f.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
    INSERT INTO general_operations SELECT 'seed-'||x,'user','credential','memory_ingest','seed-'||x,'${'a'.repeat(64)}',1,'unknown',${at},${at},${at + 100},'2026-08',1,1 FROM n`);
  await assert.rejects(f.ledger.admit(base), denied('routing_space_capacity_exceeded'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM general_operations').get().n, 100000);
  assert.equal((await f.ledger.retire(retire)).generation, 1);
});

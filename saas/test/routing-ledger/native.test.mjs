import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const worker = await build({ stdin: { contents: `
import { OrganizationConsentLedger } from '../../src/routing/ledger-object.ts';
export class TestLedger extends OrganizationConsentLedger {
 constructor(ctx,env) {
  super(ctx,env);
  this.ledger.now=()=>this.ctx.storage.sql.exec("SELECT at_ms FROM fixture_clock WHERE singleton=1").toArray()[0]?.at_ms??Date.now();
  ctx.blockConcurrencyWhile(async()=>this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_clock(singleton INTEGER PRIMARY KEY,at_ms INTEGER)').toArray());
 }
 setTime(at) {this.ctx.storage.sql.exec('INSERT INTO fixture_clock VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET at_ms=excluded.at_ms',at).toArray();}
 inspect() {return {receipts:this.ctx.storage.sql.exec('SELECT * FROM ledger_receipts').toArray(),
  operations:this.ctx.storage.sql.exec('SELECT * FROM ledger_operations').toArray(),audit:this.ctx.storage.sql.exec('SELECT * FROM ledger_audit').toArray()};}
 seedOperations() {this.ctx.storage.sql.exec(\`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
  INSERT INTO ledger_operations SELECT 'seed-'||x,'a','c','s','memory_ingest','seed-'||x,'request','hash','consent',1,'unknown',100000,100000,100001,'1970-01' FROM n\`).toArray();}
}
const allowed=new Set(['get','grant','revoke','issue','consume','finalize','checkTicket','setTime','inspect','seedOperations']);
export default { async fetch(request,env) {
 const {method,input,name}=await request.json();
 if(!allowed.has(method))return new Response(null,{status:400});
 const stub=env.LEDGER.getByName(name);
 try {return Response.json({value:await stub[method](input)});}
 catch(error){return Response.json({error:error.message},{status:400});}
}};`, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'native-fixture.mjs' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'] });
const script = worker.outputFiles[0].text;
const base = { organizationId: 'org', accountId: 'actor', credentialId: 'credential', spaceId: 'space', operation: 'memory_ingest', requestId: 'request', authorityExpiresAtMs: 300000 };
const grant = { organizationId: 'org', approvedBy: 'admin', expectedVersion: 0, grant: {
  spaceScope: { kind: 'all-spaces' }, scopes: ['ingest','storage','extraction','embedding','recall'], validFromMs: 0, evidenceRef: 'evidence' } };
const withoutExpiry = ({ authorityExpiresAtMs, ...actor }) => actor;
const reference = receipt => ({ consentId: receipt.consentId, version: receipt.consentVersion });
async function fixture(t, persist = false) {
  let directory;
  if (persist) directory = await mkdtemp(join(tmpdir(), 'memory-ledger-native-'));
  let mf;
  const start = () => { mf = new Miniflare(convertV4MiniflareOptions({ name: 'routing-ledger-test', modules: true,
    compatibilityDate: '2026-09-08', script, durableObjects: { LEDGER: { className: 'TestLedger', useSQLite: true } },
    ...(directory ? { resourcePersistencePath: directory } : {}),
    outboundService: () => new Response('outbound disabled', { status: 503 }) })); };
  start();
  t.after(async () => { await mf.dispose(); if (directory) {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    assert.ok(directory.includes('memory-ledger-native-')); await rm(directory, { recursive: true, force: true });
  } });
  const call = async (method, input = {}, name = 'organization:org') => {
    const response = await mf.dispatchFetch('https://fixture.test', { method: 'POST', body: JSON.stringify({ method, input, name }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body.value;
  };
  await call('setTime', 100000);
  return { call, async setup(overrides = {}) { return call('grant', { ...grant, ...overrides }); },
    async permit(actor = base) { return call('issue', actor); },
    async admit(receipt, extra = {}, actor = base) { return call('consume', { ...actor, receipt: receipt.receipt, reference: reference(receipt), operationId: 'op', payloadHash: 'a'.repeat(64), ...extra }); },
    async restart() { await mf.dispose(); start(); } };
}
const denied = code => error => error.message.includes(code);

test('real SQLite DO persists one organization, CAS grants, immutable audit and fresh ID after revoke', { timeout: 30000 }, async t => {
  const f = await fixture(t, true);
  assert.equal(await f.call('get', { organizationId: 'org' }), null);
  const first = await f.setup(); assert.equal(first.version, 1);
  await assert.rejects(f.setup(), denied('routing_ledger_version_conflict'));
  const revoked = await f.call('revoke', { organizationId: 'org', approvedBy: 'revoker', expectedVersion: 1 });
  assert.equal(revoked.status, 'revoked'); assert.equal(revoked.version, 2);
  assert.deepEqual(await f.call('revoke', { organizationId: 'org', approvedBy: 'revoker', expectedVersion: 2 }), revoked);
  const renewed = await f.setup({ expectedVersion: 2 });
  assert.notEqual(renewed.id, first.id); assert.equal(renewed.version, 3);
  await assert.rejects(f.call('get', { organizationId: 'other' }), denied('routing_ledger_organization_mismatch'));
  await f.restart();
  assert.deepEqual(await f.call('get', { organizationId: 'org' }), renewed);
  const audit = (await f.call('inspect')).audit;
  assert.deepEqual(audit.map(row => [row.version,row.action,row.actor_id,row.at_ms]), [[1,'grant','admin',100000],[2,'revoke','revoker',100000],[3,'grant','admin',100000]]);
});

test('receipt is hashed, context-bound and atomically single-use under concurrent requests', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.setup(); const permit = await f.permit();
  assert.equal(permit.expiresAtMs, 160000); assert.equal(permit.receipt.length, 43);
  const rows = (await f.call('inspect')).receipts;
  assert.match(rows[0].hash, /^[0-9a-f]{64}$/); assert.equal(JSON.stringify(rows).includes(permit.receipt), false);
  for (const field of ['accountId','credentialId','spaceId','requestId']) await assert.rejects(f.admit(permit, {}, { ...base, [field]: 'other' }), denied('routing_ledger_receipt_invalid'));
  await assert.rejects(f.admit(permit, {}, { ...base, operation: 'memory_search' }), denied('routing_ledger_receipt_invalid'));
  const outcomes = await Promise.allSettled([f.admit(permit), f.admit(permit)]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'fulfilled').value.dispatch, true);
  assert.equal((await f.call('inspect')).operations.length, 1);
});

test('new object name cannot bind a different organization and distinct organizations stay isolated', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.setup();
  await assert.rejects(f.call('get', { organizationId: 'unexpected' }, 'organization:fresh'), denied('routing_ledger_organization_mismatch'));
  await f.call('setTime', 100000, 'organization:other');
  const other = await f.call('grant', { ...grant, organizationId: 'other' }, 'organization:other');
  assert.equal(other.organizationId, 'other'); assert.equal(other.version, 1);
  const issued = await f.permit();
  await assert.rejects(f.call('consume', { ...base, organizationId: 'other', receipt: issued.receipt,
    reference: { consentId: other.id, version: other.version }, payloadHash: 'a'.repeat(64), operationId: 'op' }, 'organization:other'), denied('routing_ledger_receipt_invalid'));
  assert.equal((await f.call('inspect', {}, 'organization:other')).operations.length, 0);
});

test('two valid receipts race one operation admission, with only one dispatch winner', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.setup();
  const actors = [base, { ...base, requestId: 'parallel-request' }];
  const receipts = await Promise.all(actors.map(actor => f.permit(actor)));
  const tickets = await Promise.all(receipts.map((receipt, i) => f.admit(receipt, {}, actors[i])));
  assert.equal(new Set(tickets.map(ticket => ticket.id)).size, 1);
  assert.equal(tickets.filter(ticket => ticket.dispatch).length, 1);
  assert.equal((await f.call('inspect')).receipts.filter(row => row.consumed_at_ms !== null).length, 2);
});

test('unknown provider outcomes never redispatch; operation mismatch cannot consume a valid receipt', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.setup(); const admitted = await f.admit(await f.permit());
  const actor = withoutExpiry(base);
  const outcome = await f.call('finalize', { ...actor, ticketId: admitted.id, state: 'unknown' });
  assert.equal(outcome.state, 'unknown'); assert.equal(outcome.dispatch, false);
  await assert.rejects(f.call('finalize', { ...actor, ticketId: admitted.id, state: 'accepted' }), denied('routing_ledger_transition_invalid'));
  const next = { ...base, requestId: 'request-2' }, permit = await f.permit(next);
  await assert.rejects(f.admit(permit, { payloadHash: 'b'.repeat(64) }, next), denied('routing_ledger_operation_conflict'));
  const replay = await f.admit(permit, {}, next);
  assert.equal(replay.id, admitted.id); assert.equal(replay.state, 'unknown'); assert.equal(replay.dispatch, false);
  await assert.rejects(f.call('checkTicket', { ...base, ticketId: admitted.id, phase: 'dispatch' }), denied('routing_ledger_ticket_unavailable'));
});

test('future, expired, revoked, narrowed and authority-expired grants prevent new dispatch', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.setup({ grant: { ...grant.grant, validFromMs: 110000 } });
  await assert.rejects(f.permit(), denied('routing_consent_unavailable'));
  await f.setup({ expectedVersion: 1 }); const permit = await f.permit();
  await f.setup({ expectedVersion: 2, grant: { ...grant.grant, spaceScope: { kind: 'spaces', spaceIds: ['other'] } } });
  await assert.rejects(f.admit(permit), denied('routing_consent_scope_denied'));
  await f.setup({ expectedVersion: 3, grant: { ...grant.grant, expiresAtMs: 100010 } });
  const short = await f.permit(); assert.equal(short.expiresAtMs, 100010);
  await f.call('setTime', 100010); await assert.rejects(f.admit(short), denied('routing_consent_unavailable'));
  await f.setup({ expectedVersion: 4 });
  await assert.rejects(f.permit({ ...base, authorityExpiresAtMs: 100010 }), denied('routing_ledger_authority_expired'));
  await f.call('revoke', { organizationId: 'org', approvedBy: 'admin', expectedVersion: 5 });
  await assert.rejects(f.permit(), denied('routing_consent_unavailable'));
});

test('ticket phase, context and current grant are checked before dispatch and disclosure', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.setup(); const ticket = await f.admit(await f.permit());
  const input = { ...base, ticketId: ticket.id };
  assert.equal((await f.call('checkTicket', { ...input, phase: 'dispatch' })).dispatch, false);
  await assert.rejects(f.call('checkTicket', { ...input, phase: 'disclose' }), denied('routing_ledger_ticket_unavailable'));
  await assert.rejects(f.call('finalize', { ...withoutExpiry(base), ticketId: ticket.id, state: 'read_failed' }), denied('routing_ledger_transition_invalid'));
  await f.call('revoke', { organizationId: 'org', approvedBy: 'admin', expectedVersion: 1 });
  // Provider evidence remains recordable after grant loss, but no plaintext is returned.
  await f.call('finalize', { ...withoutExpiry(base), ticketId: ticket.id, state: 'accepted' });
  await assert.rejects(f.call('checkTicket', { ...input, phase: 'disclose' }), denied('routing_consent_unavailable'));
  await assert.rejects(f.call('finalize', { ...withoutExpiry(base), accountId: 'other', ticketId: ticket.id, state: 'accepted' }), denied('routing_ledger_ticket_unavailable'));
});

test('accepted reads disclose only under fresh authority and read failures are terminal', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.setup();
  const actor = { ...base, operation: 'memory_search' };
  const ticket = await f.admit(await f.permit(actor), {}, actor);
  const finalized = await f.call('finalize', { ...withoutExpiry(actor), ticketId: ticket.id, state: 'accepted' });
  assert.equal(finalized.dispatch, false);
  assert.equal((await f.call('checkTicket', { ...actor, ticketId: ticket.id, phase: 'disclose' })).state, 'accepted');
  await assert.rejects(f.call('checkTicket', { ...actor, authorityExpiresAtMs: 100000, ticketId: ticket.id, phase: 'disclose' }), denied('routing_ledger_authority_expired'));
  const next = { ...actor, requestId: 'failed-read' };
  const failed = await f.admit(await f.permit(next), { operationId: 'failed-read' }, next);
  await f.call('finalize', { ...withoutExpiry(next), ticketId: failed.id, state: 'read_failed' });
  await assert.rejects(f.call('checkTicket', { ...next, ticketId: failed.id, phase: 'disclose' }), denied('routing_ledger_ticket_unavailable'));
  await assert.rejects(f.call('finalize', { ...withoutExpiry(next), ticketId: failed.id, state: 'accepted' }), denied('routing_ledger_transition_invalid'));
});

test('receipt and ticket deadlines are enforced with expiry cleanup preserving operation tombstones', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.setup(); const first = await f.permit(); const ticket = await f.admit(first);
  const outstanding = await f.permit({ ...base, requestId: 'unused' });
  await f.call('setTime', 160000);
  await assert.rejects(f.admit(outstanding, {}, { ...base, requestId: 'unused' }), denied('routing_ledger_receipt_invalid'));
  await assert.rejects(f.call('checkTicket', { ...base, ticketId: ticket.id, phase: 'dispatch' }), denied('routing_ledger_ticket_unavailable'));
  await f.permit({ ...base, requestId: 'new' });
  const stored = await f.call('inspect'); assert.equal(stored.receipts.length, 1); assert.equal(stored.operations.length, 1);
});

test('outstanding actor receipts and monthly organization operations are bounded', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.setup();
  for (let i = 0; i < 100; i++) await f.permit({ ...base, requestId: 'r-' + i });
  await assert.rejects(f.permit(), denied('routing_ledger_capacity_exceeded'));
  await f.call('setTime', 160000); const permit = await f.permit();
  await f.call('seedOperations');
  await assert.rejects(f.admit(permit), denied('routing_ledger_capacity_exceeded'));
  const stored = await f.call('inspect'); assert.equal(stored.operations.length, 10000); assert.equal(stored.receipts[0].consumed_at_ms, null);
});

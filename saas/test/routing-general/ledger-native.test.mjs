import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const built = await build({ stdin: { contents: `
import { AgentMemorySpaceLedger } from '../../src/routing/general-ledger-object.ts';
export class TestLedger extends AgentMemorySpaceLedger {
 constructor(ctx,env) {
  super(ctx,env);
  this.ledger.now=()=>this.ctx.storage.sql.exec('SELECT at_ms FROM fixture_clock WHERE singleton=1').toArray()[0]?.at_ms??Date.now();
  ctx.blockConcurrencyWhile(async()=>this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_clock(singleton INTEGER PRIMARY KEY,at_ms INTEGER)').toArray());
 }
 setTime(at){this.ctx.storage.sql.exec('INSERT INTO fixture_clock VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET at_ms=excluded.at_ms',at).toArray();}
 failRetirement(){this.ctx.storage.sql.exec("CREATE TRIGGER fixture_abort_generation BEFORE UPDATE ON general_generation BEGIN SELECT RAISE(ABORT,'fixture_abort'); END;").toArray();}
 inspect(){return {operations:this.ctx.storage.sql.exec('SELECT * FROM general_operations').toArray(),
  retirements:this.ctx.storage.sql.exec('SELECT * FROM general_retirements').toArray(),identity:this.ctx.storage.sql.exec('SELECT * FROM general_identity').toArray()};}
}
const allowed=new Set(['admit','check','finalize','retire','pending','finishRetirement','usage','setTime','inspect','failRetirement']);
export default { async fetch(request,env) {
 const {method,input,name,random}=await request.json();
 if(!allowed.has(method))return new Response(null,{status:400});
 const stub=random?env.LEDGER.get(env.LEDGER.newUniqueId()):env.LEDGER.getByName(name);
 try{return Response.json({value:await stub[method](input)});}
 catch(error){return Response.json({error:error.message},{status:400});}
}};`, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'general-native-fixture.mjs' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'] });
const identity = { spaceId: 'space', owner: { kind: 'account', id: 'owner' }, provider: { accountId: 'provider', namespace: 'namespace' } };
const actor = { accountId: 'owner', credentialId: 'credential' };
const at = Date.UTC(2026, 8, 11);
const base = { identity, actor, operation: 'memory_ingest', operationId: 'operation', payloadHash: 'a'.repeat(64),
  usage: { inputBytes: 123, messageCount: 2 }, authorityExpiresAtMs: at + 120000 };
const retirement = { identity, actor, operationId: 'clear', payloadHash: 'b'.repeat(64), authorityExpiresAtMs: at + 120000 };
const denied = code => error => error.message.includes(code);
async function fixture(t, persist = false) {
  const directory = persist ? await mkdtemp(join(tmpdir(), 'memory-general-ledger-')) : undefined;
  let mf;
  const start = () => { mf = new Miniflare(convertV4MiniflareOptions({ name: 'routing-general-ledger-test', modules: true,
    compatibilityDate: '2026-09-08', script: built.outputFiles[0].text,
    durableObjects: { LEDGER: { className: 'TestLedger', useSQLite: true } },
    ...(directory ? { resourcePersistencePath: directory } : {}),
    outboundService: () => new Response('outbound disabled', { status: 503 }) })); };
  start();
  t.after(async () => { await mf.dispose(); if (directory) {
    const path = resolve(directory); assert.ok(path.startsWith(resolve(tmpdir()) + sep));
    assert.ok(path.includes('memory-general-ledger-')); await rm(path, { recursive: true, force: true });
  } });
  const call = async (method, input = {}, options = {}) => {
    const response = await mf.dispatchFetch('https://fixture.test', { method: 'POST', body: JSON.stringify({ method, input, name: 'space:space', ...options }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error); return body.value;
  };
  await call('setTime', at);
  return { call, async restart() { await mf.dispose(); start(); } };
}

test('real workerd RPC and SQLite restart retain one dispatch, usage and permanent owner/provider identity', { timeout: 30000 }, async t => {
  const f = await fixture(t, true);
  const tickets = await Promise.all(Array.from({ length: 12 }, () => f.call('admit', base)));
  assert.equal(tickets.filter(ticket => ticket.dispatch).length, 1);
  assert.equal(new Set(tickets.map(ticket => ticket.id)).size, 1);
  await f.restart();
  assert.deepEqual(await f.call('admit', base), { ...tickets[0], dispatch: false });
  const usage = await f.call('usage', { identity });
  assert.equal(usage.admissions, 1); assert.equal(usage.messages, 2); assert.equal(usage.inputBytes, 123);
  await assert.rejects(f.call('usage', { identity: { ...identity, owner: { kind: 'organization', id: 'owner' } } }), denied('routing_space_identity_mismatch'));
  await assert.rejects(f.call('usage', { identity }, { name: 'space:other' }), denied('routing_space_identity_mismatch'));
  await assert.rejects(f.call('usage', { identity }, { random: true }), denied('routing_space_identity_mismatch'));
});

test('real workerd hides retired generations from late provider replies and keeps deletion outcome reconciliation separate', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const first = await f.call('admit', base);
  await f.call('check', { identity, actor, ticketId: first.id, phase: 'dispatch', authorityExpiresAtMs: base.authorityExpiresAtMs });
  const clears = await Promise.all(Array.from({ length: 8 }, () => f.call('retire', retirement)));
  assert.equal(clears.filter(value => value.dispatch).length, 1);
  await assert.rejects(f.call('finishRetirement', { identity, retirementId: clears[0].id, state: 'acknowledged' }), denied('routing_space_retirement_inflight'));
  assert.equal((await f.call('pending', { identity, limit: 10 }))[0].state, 'pending');
  await f.call('setTime', at + 70000);
  await f.call('finalize', { identity, actor, ticketId: first.id, state: 'accepted' });
  await assert.rejects(f.call('check', { identity, actor, ticketId: first.id, phase: 'disclose', authorityExpiresAtMs: base.authorityExpiresAtMs }), denied('routing_space_ticket_unavailable'));
  assert.equal((await f.call('admit', base)).dispatch, false);
  const next = await f.call('admit', { ...base, operationId: 'next' }); assert.equal(next.generation, 2);
  await f.call('finishRetirement', { identity, retirementId: clears[0].id, state: 'unknown' });
  assert.equal((await f.call('pending', { identity, limit: 10 }))[0].state, 'unknown');
  await f.call('finishRetirement', { identity, retirementId: clears[0].id, state: 'acknowledged' });
  assert.deepEqual(await f.call('pending', { identity, limit: 10 }), []);
  await assert.rejects(f.call('finishRetirement', { identity, retirementId: clears[0].id, state: 'unknown' }), denied('routing_space_transition_invalid'));
  const replay = await f.call('retire', retirement);
  assert.equal(replay.state, 'acknowledged'); assert.equal(replay.dispatch, false); assert.equal(replay.physicalPurgeVerified, false);
});

test('real workerd synchronous transaction rolls back outbox insertion when generation change fails', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.call('usage', { identity }); await f.call('failRetirement');
  await assert.rejects(f.call('retire', retirement), denied('fixture_abort'));
  assert.equal((await f.call('usage', { identity })).generation, 1);
  assert.deepEqual(await f.call('pending', { identity, limit: 10 }), []);
  assert.equal((await f.call('inspect')).retirements.length, 0);
});

test('real RPC rejects raw bodies and unexpected nested metadata before durable writes', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('admit', { ...base, query: 'private query' }), denied('routing_space_input_invalid'));
  await assert.rejects(f.call('admit', { ...base, identity: { ...identity, provider: { ...identity.provider, token: 'private bearer' } } }), denied('routing_space_input_invalid'));
  await assert.rejects(f.call('retire', { ...retirement, content: 'private transcript' }), denied('routing_space_input_invalid'));
  const rows = await f.call('inspect'); assert.deepEqual(rows, { operations: [], retirements: [], identity: [] });
});

test('native reconciliation rotates concurrent bounded pages past blocked targets and persists progress across restart', { timeout: 30000 }, async t => {
  const f = await fixture(t, true);
  for (let i = 1; i <= 25; i++) {
    const row = await f.call('retire', { ...retirement, operationId: 'clear-' + i });
    await f.call('finishRetirement', { identity, retirementId: row.id, state: 'unknown' });
  }
  const before = await f.call('inspect');
  const pages = await Promise.all([f.call('pending', { identity, limit: 10 }), f.call('pending', { identity, limit: 10 })]);
  assert.equal(new Set(pages.flat().map(row => row.id)).size, 20);
  assert.deepEqual(pages.flat().map(row => row.generation).sort((a,b) => a-b), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]);
  await f.restart();
  const next = await f.call('pending', { identity, limit: 10 });
  assert.deepEqual(next.map(row => row.generation), [21,22,23,24,25,1,2,3,4,5]);
  assert.equal(next.every(row => row.dispatch === false && row.state === 'unknown'), true);
  assert.deepEqual(await f.call('inspect'), before);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createSeoulApp } from '../../src/postgres/seoul/app.ts';

const token = 'synthetic-lifecycle-pat-' + 'a'.repeat(40), digest = createHash('sha256').update(token).digest('hex');
const operationId = '11111111-1111-4111-8111-111111111111', archiveId = 'arc:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const erase = { spaceId: 'space:a', archiveId, expectedRevision: 1, operationId };
const retired = { spaceId: 'space:a', operationId, state: 'retired', replayed: false };
const erased = { spaceId: 'space:a', archiveId, operationId, revision: 2, state: 'primary_erased', replayed: false,
  primaryRowsRemoved: true, removedMessages: 2, removedSourceBytes: 50, restoreAllowed: false,
  backupCleanup: 'not_confirmed', physicalMediaCleanup: 'not_confirmed' };
const variants = [
  ['memory_archive_erase', 'eraseArchive', erase, erased],
  ['memory_space_retire', 'retireSpace', { spaceId: 'space:a', operationId }, retired],
  ['memory_pat_revoke_self', 'revokeSelf', { operationId }, { operationId, state: 'revoked', replayed: false }],
  ['memory_lifecycle_status', 'status', { kind: 'archive', spaceId: 'space:a', archiveId },
    { kind: 'archive', spaceId: 'space:a', archiveId, revision: 2, state: 'primary_erased' }],
];
function request(name, args, init = {}) {
  return new Request('https://seoul.example.test/mcp', { method: 'POST', headers: {
    authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'x-memory-routing': '2', 'mcp-protocol-version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'lifecycle:one', method: 'tools/call', params: { name, arguments: args } }), ...init });
}
async function rpc(response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const lines = text.split(/\r?\n/).filter(line => line.startsWith('data:'));
    assert.equal(lines.length, 1); return JSON.parse(lines[0].slice(5).trim());
  }
  return JSON.parse(text);
}
function fixture({ version = 5, lifecycle = {}, disclosure, authenticate, ...options } = {}) {
  const calls = [], results = [];
  const group = Object.fromEntries(variants.map(([_tool, method, _input, result]) => [method, async (hash, input, opts) => {
    assert.equal(hash, digest); assert.ok(opts.signal instanceof AbortSignal);
    calls.push([method, input]); const value = structuredClone(result); results.push(value); return value;
  }]));
  Object.assign(group, lifecycle);
  const repo = { async probe() {}, async preauthenticatePat(hash) { calls.push(['auth']); assert.equal(hash, digest); await authenticate?.(); },
    async ingest() { assert.fail('lifecycle used ingest'); }, async search() { assert.fail('lifecycle used search'); },
    assertDisclosure(value) { assert.ok(results.includes(value)); disclosure?.(value); },
    ...(version === 5 ? { lifecycle: group } : {}) };
  return { calls, group, repo, app: createSeoulApp({ repository: repo, enabled: true, ...options }) };
}
test('version5 advertises exactly four bounded lifecycle tools with destructive mutation annotations', async () => {
  for (const version of [4, 5]) {
    const f = fixture({ version });
    const response = await f.app.fetch(request('', {}, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }));
    const tools = (await rpc(response)).result.tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['memory_ingest', 'memory_search',
      ...(version === 5 ? variants.map(row => row[0]) : [])].sort());
    for (const tool of tools.filter(tool => variants.some(row => row[0] === tool.name))) {
      const mutation = tool.name !== 'memory_lifecycle_status';
      assert.equal(tool.annotations.readOnlyHint, !mutation); assert.equal(tool.annotations.destructiveHint, mutation);
      assert.equal(JSON.stringify(tool).includes('confirmation'), false);
    }
    const metadata = await (await f.app.fetch(new Request('https://seoul.example.test/.well-known/memory-routing-v2'))).json();
    assert.deepEqual(metadata.target.capabilities, { ingest: true, search: { keyword: true, semantic: false } });
  }
});
test('all lifecycle calls return strict metadata and check the original result twice', async () => {
  for (const [tool, method, input, expected] of variants) {
    let checks = 0; const f = fixture({ disclosure() { checks++; } });
    const response = await f.app.fetch(request(tool, input)); assert.equal(response.status, 200);
    const result = (await rpc(response)).result; assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), expected); assert.equal(checks, 2);
    assert.deepEqual(f.calls, [['auth'], [method, input]]);
  }
});
test('v4 rejects lifecycle calls and v5 rejects unknown fields before SDK dispatch', async () => {
  for (const [tool, _method, input] of variants) {
    for (const f of [fixture({ version: 4 }), fixture()]) {
      const response = await f.app.fetch(request(tool, { ...input, confirmation: 'not-in-contract' }));
      assert.equal(response.status, 400); assert.deepEqual(f.calls, [['auth']]);
      assert.ok(!(await response.text()).includes('not-in-contract'));
    }
    const f = fixture({ version: 4 }); assert.equal((await f.app.fetch(request(tool, input))).status, 400);
  }
});
test('each lifecycle mutation deadline remains uncertain with its operation ID and no retry', async () => {
  for (const [tool, method, input] of variants.slice(0, 3)) {
    let calls = 0, signal;
    const f = fixture({ timeoutMs: 30, lifecycle: { async [method](_digest, _input, opts) { calls++; signal = opts.signal; return new Promise(() => {}); } } });
    const response = await f.app.fetch(request(tool, input));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'operation_outcome_unknown', operationId });
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
  }
});
test('each lifecycle mutation final lease failure preserves uncertainty and suppresses receipt', async () => {
  for (const [tool, _method, input] of variants.slice(0, 3)) {
    let checks = 0;
    const f = fixture({ disclosure() { if (++checks === 2) throw { code: 'seoul_write_outcome_unknown' }; } });
    const response = await f.app.fetch(request(tool, input)); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'operation_outcome_unknown', operationId });
    assert.equal(checks, 2);
  }
});
test('a returned lifecycle mutation with malformed metadata is uncertain and cannot publish the invalid receipt', async () => {
  for (const [tool, method, input, receipt] of variants.slice(0, 3)) {
    const f = fixture();
    const original = f.group[method];
    // The app captured its original method at composition. Construct a second
    // app around the intentionally malformed boundary while retaining leases.
    f.repo.lifecycle[method] = async (...args) => { const value = await original(...args); value.privateExtra = 'synthetic-private'; return value; };
    const app = createSeoulApp({ repository: f.repo, enabled: true });
    const response = await app.fetch(request(tool, input)); assert.equal(response.status, 200);
    const result = (await rpc(response)).result;
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { error: 'seoul_write_outcome_unknown', operationId });
    assert.equal(JSON.stringify(result).includes(receipt.state), false);
    assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
  }
});
test('lifecycle status is a leased read, never classified as a mutation', async () => {
  let checks = 0;
  const f = fixture({ disclosure() { if (++checks === 2) throw { code: 'seoul_authority_expired' }; } });
  const response = await f.app.fetch(request(variants[3][0], variants[3][2]));
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'seoul_authority_expired' });
});
test('revoked PAT preauthentication prevents body reads and lifecycle invocation', async () => {
  const f = fixture({ authenticate() { throw { code: 'seoul_pat_denied' }; } }); let reads = 0;
  const body = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  const response = await f.app.fetch(request(variants[0][0], erase, { body, duplex: 'half' }));
  assert.equal(response.status, 401); assert.equal(reads, 0); assert.deepEqual(f.calls, [['auth']]);
});
test('foreign diagnostic getters and hostile proxies cannot reach SDK error text on any tool', async () => {
  const attacks = [
    reads => Object.defineProperty({}, 'code', { get() { reads.count++; throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC_ONLY'); } }),
    reads => Object.defineProperty({ code: 'seoul_space_denied' }, 'message', { get() { reads.count++; throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC_ONLY'); } }),
    () => new Proxy({}, { getPrototypeOf() { throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC_ONLY'); },
      getOwnPropertyDescriptor() { throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC_ONLY'); } }),
    reads => new Proxy({}, { get(_target, key) { if (key === 'code') { reads.count++; throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC_ONLY'); } } }),
  ];
  const tools = [...variants, ['memory_ingest', 'ingest', { spaceId: 'space:a', operationId: 'ingest:one',
    routing: { version: 1, classification: 'medical', destination: 'seoul' }, messages: [{ role: 'user', content: 'fixture' }] }],
  ['memory_search', 'search', { spaceId: 'space:a', routing: { version: 1, classification: 'medical', destination: 'seoul' }, query: 'fixture' }]];
  for (const [tool, method, input] of tools) for (const attack of attacks) {
    const reads = { count: 0 }, f = fixture(), error = attack(reads);
    const receiver = method === 'ingest' || method === 'search' ? f.repo : f.repo.lifecycle;
    receiver[method] = async () => { throw error; };
    const app = createSeoulApp({ repository: f.repo, enabled: true });
    const response = await app.fetch(request(tool, input)); assert.equal(response.status, 200);
    const result = (await rpc(response)).result;
    assert.equal(result.isError, true);
    const output = JSON.parse(result.content[0].text);
    assert.ok(['seoul_unavailable', 'seoul_space_denied'].includes(output.error));
    assert.equal(reads.count, 0); assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC_ONLY'), false);
  }
});

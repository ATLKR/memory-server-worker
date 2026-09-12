import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createSeoulApp } from '../../src/postgres/seoul/app.ts';
import { createRoutingClient } from '../../src/routing/client.ts';

const origin = 'https://seoul.example.test';
const token = 'synthetic-native-pat-' + 'a'.repeat(43);
const tokenDigest = createHash('sha256').update(token).digest('hex');
const routing = { version: 1, classification: 'medical', destination: 'seoul' };
const ingest = { spaceId: 'space:one', operationId: 'op:one', routing,
  messages: [{ role: 'user', content: '서울에서 보관한 원문' }] };
const search = { spaceId: 'space:one', routing, query: '서울', mode: 'keyword', limit: 2 };
const receipt = { spaceId: 'space:one', operationId: 'op:one', archiveId: 'archive:one',
  state: 'stored', extraction: 'none', messageCount: 1, sourceBytes: 29, replayed: false };
const found = { spaceId: 'space:one', mode: 'keyword',
  matches: [{ memoryId: 'message:one', revision: 1, excerpt: '서울에서 보관한 원문' }], count: 1 };
function fixture(overrides = {}, options = {}) {
  const calls = [];
  const repository = {
    async probe() { calls.push(['probe']); },
    async preauthenticatePat(digest) { calls.push(['authenticate', digest]); },
    async ingest(digest, input) { calls.push(['ingest', digest, input]); return structuredClone(receipt); },
    async search(digest, input) { calls.push(['search', digest, input]); return structuredClone(found); },
    assertDisclosure() {},
    ...overrides,
  };
  const app = createSeoulApp({ repository, enabled: true, title: 'Renamed Memory', ...options });
  return { app, calls, repository };
}
function request(name = 'memory_search', args = search, init = {}) {
  return new Request(origin + '/mcp', { method: 'POST', headers: {
    authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'x-memory-routing': '2', 'mcp-protocol-version': '2025-11-25',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 'test:one', method: 'tools/call',
    params: { name, arguments: args } }), ...init });
}
async function rpcBody(response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
    assert.equal(data.length, 1);
    return JSON.parse(data[0]);
  }
  return JSON.parse(text);
}
async function tool(response) {
  assert.equal(response.status, 200);
  const value = await rpcBody(response);
  assert.equal(value.id, 'test:one');
  return value.result;
}
test('native v2 discovery advertises only a fresh successful configured repository', async () => {
  const f = fixture();
  const response = await f.app.fetch(new Request(origin + '/.well-known/memory-routing-v2'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const metadata = await response.json();
  assert.equal(metadata.protocol, 'memory-routing-v2');
  assert.deepEqual(metadata.target.capabilities, { ingest: true, search: { keyword: true, semantic: false } });
  assert.equal(metadata.target.ready, true); assert.deepEqual(f.calls, [['probe']]);
});
test('disabled and unhealthy native endpoints never advertise readiness', async () => {
  for (const f of [fixture({}, { enabled: false }), fixture({ async probe() { throw new Error('private SQL diagnostic'); } })]) {
    const response = await f.app.fetch(new Request(origin + '/.well-known/memory-routing-v2'));
    const metadata = await response.json();
    assert.equal(metadata.target.ready, false);
    assert.deepEqual(metadata.target.capabilities, { ingest: false, search: { keyword: false, semantic: false } });
    assert.ok(!JSON.stringify(metadata).includes('diagnostic'));
  }
  const f = fixture({}, { enabled: false });
  assert.equal((await f.app.fetch(request())).status, 503); assert.deepEqual(f.calls, []);
});
test('native endpoint preauthenticates a digest before consuming the request body', async () => {
  const order = [];
  const f = fixture({ async preauthenticatePat(digest) { order.push('authenticate'); assert.equal(digest, tokenDigest); } });
  const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 'test:one', method: 'tools/call',
    params: { name: 'memory_search', arguments: search } }));
  const body = new ReadableStream({ pull(controller) { order.push('body'); controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
  await tool(await f.app.fetch(request('memory_search', search, { body, duplex: 'half' })));
  assert.deepEqual(order, ['authenticate', 'body']);
  assert.equal(f.calls[0][1], tokenDigest);
});
test('unknown PAT fails without consuming or echoing private request content', async () => {
  const f = fixture({ async preauthenticatePat() { throw Object.assign(new Error('private SQL diagnostic'), { code: 'seoul_pat_denied' }); } });
  let reads = 0;
  const body = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  const response = await f.app.fetch(request('memory_search', search, { body, duplex: 'half' }));
  assert.equal(response.status, 401); assert.equal(reads, 0);
  assert.ok(!(await response.text()).includes('diagnostic')); assert.deepEqual(f.calls, []);
});
test('missing bearer, wrong routing version and unrelated routes have no database fallback', async () => {
  for (const init of [{ headers: { 'x-memory-routing': '2' } },
    { headers: { authorization: 'Bearer ' + token, 'x-memory-routing': '1' } },
    { headers: { authorization: 'Bearer ' + token, 'x-memory-routing': '2, 1' } }]) {
    const f = fixture(); const response = await f.app.fetch(request('memory_search', search, init));
    assert.ok(response.status >= 400); assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  assert.equal((await f.app.fetch(new Request(origin + '/manage'))).status, 404);
  assert.equal((await f.app.fetch(new Request(origin + '/mcp'))).status, 405);
  assert.deepEqual(f.calls, []);
});
test('actual routing client uses the Hono v2 endpoint and returns validated source results', async () => {
  const f = fixture();
  const client = createRoutingClient({ targets: { seoul: { origin, spaceId: 'space:one', protocol: 'memory-routing-v2' } },
    credential: async () => ({ kind: 'pat', token }), fetch: (url, init) => f.app.fetch(new Request(url, init)) });
  const result = await client.call('memory_search', { routing, query: '서울', limit: 2 });
  assert.deepEqual(result.result.structuredContent, found);
  assert.deepEqual(f.calls.map(c => c[0]), ['probe', 'authenticate', 'search']);
  assert.equal(f.calls[2][2].mode, 'keyword');
});
test('verbatim ingest returns a receipt without claiming extraction or echoing messages', async () => {
  const f = fixture(); const result = await tool(await f.app.fetch(request('memory_ingest', ingest)));
  assert.notEqual(result.isError, true); assert.deepEqual(JSON.parse(result.content[0].text), receipt);
  assert.deepEqual(f.calls.map(c => c[0]), ['authenticate', 'ingest']);
  assert.equal(f.calls[1][1], tokenDigest);
  assert.ok(!JSON.stringify(result).includes(ingest.messages[0].content));
});
test('semantic, cross-route and malformed input never reach native content commands', async () => {
  for (const [name, args] of [
    ['memory_search', { ...search, mode: 'semantic' }], ['memory_search', { ...search, query: '\0' }],
    ['memory_search', { ...search, routing: { version: 1, classification: 'general', destination: 'agent-memory' } }],
    ['memory_search', { ...search, arbitraryHost: 'https://elsewhere.example.test' }],
    ['memory_ingest', { ...ingest, messages: [{ role: 'user', content: 'bad\0text' }] }],
    ['memory_clear_space', { spaceId: 'space:one' }],
  ]) {
    const f = fixture(); const response = await f.app.fetch(request(name, args));
    const value = await response.json();
    assert.ok(response.status >= 400 || value.result?.isError === true || value.error);
    assert.deepEqual(f.calls.map(c => c[0]), ['authenticate']);
  }
});
test('SDK initialization and tool discovery retain renameable branding and only supported tools', async () => {
  const f = fixture();
  async function control(method, params) {
    return rpcBody(await f.app.fetch(request('memory_search', search, { body: JSON.stringify({ jsonrpc: '2.0', id: 'control', method, params }) })));
  }
  const initialized = await control('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.serverInfo.title, 'Renamed Memory');
  const listed = await control('tools/list', {});
  assert.deepEqual(listed.result.tools.map(t => t.name).sort(), ['memory_ingest', 'memory_search']);
  assert.match(listed.result.tools.find(t => t.name === 'memory_ingest').description, /verbatim/i);
});
test('request deadline aborts native work and does not disclose a late response', async () => {
  let signal;
  const f = fixture({ async search(_digest, _input, options) { signal = options.signal; return new Promise(() => {}); } }, { timeoutMs: 40 });
  const response = await f.app.fetch(request());
  assert.equal(response.status, 504); assert.equal(signal.aborted, true);
  assert.ok(!(await response.text()).includes(found.matches[0].excerpt));
});
test('a cancelled dispatched write is uncertain and never retried', async () => {
  let calls = 0;
  const f = fixture({ async ingest() { calls++; return new Promise(() => {}); } }, { timeoutMs: 40 });
  const response = await f.app.fetch(request('memory_ingest', ingest));
  const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.error, 'operation_outcome_unknown');
  assert.equal(body.operationId, 'op:one'); assert.equal(calls, 1);
});
test('request cancellation before admission touches no repository and all failures are no-store', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture(); const response = await f.app.fetch(request('memory_search', search, { signal: controller.signal }));
  assert.equal(response.status, 499); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(f.calls, []);
});
test('a read lease expiring during SDK serialization cannot disclose buffered source text', async () => {
  let checks = 0;
  const f = fixture({ assertDisclosure(result) {
    assert.deepEqual(result, found);
    if (++checks === 2) throw Object.assign(new Error('private expiry diagnostic'), { code: 'seoul_authority_expired' });
  } });
  const response = await f.app.fetch(request());
  assert.equal(response.status, 403); assert.equal(checks, 2);
  assert.deepEqual(await response.json(), { error: 'seoul_authority_expired' });
});
test('a committed write with an expired disclosure lease preserves its uncertain receipt', async () => {
  let checks = 0;
  const f = fixture({ assertDisclosure() {
    if (++checks === 2) throw Object.assign(new Error('private expiry diagnostic'), { code: 'seoul_write_outcome_unknown' });
  } });
  const response = await f.app.fetch(request('memory_ingest', ingest));
  assert.equal(response.status, 503); assert.equal(checks, 2);
  assert.deepEqual(await response.json(), { error: 'operation_outcome_unknown', operationId: 'op:one' });
});

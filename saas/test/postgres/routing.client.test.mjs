import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutingClient } from '../../src/routing/client.ts';

const cf = { route: 'agent-memory', storage: 'cloudflare-agent-memory', vector: 'managed-agent-memory', region: 'cloudflare', ready: true };
const seoul = { route: 'seoul', storage: 'postgres', vector: 'pgvector', region: 'kr-seoul', ready: true };
const origins = { 'agent-memory': 'https://cf.example.test', seoul: 'https://seoul.example.test' };
const targets = Object.fromEntries(Object.entries(origins).map(([route, origin]) => [route, { origin, spaceId: route+'-space' }]));
const input = { routing: { version: 1, classification: 'medical' }, operationId: 'stable-operation-1',
  sessionId: 'conversation-1', messages: [{ role: 'user', content: '  원문을 공백까지 보존한다.\n', timestamp: '2026-09-11T00:00:00.000Z' }, { role: 'assistant', content: '알겠습니다.' }] };
const ack = { content: [{ type: 'text', text: '{"accepted":true}' }], isError: false };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(options = {}) {
  const calls = [], credentials = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: String(url).startsWith(origins.seoul) ? seoul : cf });
    const rpc = JSON.parse(init.body);
    return json({ jsonrpc: '2.0', id: rpc.id, result: ack });
  };
  const credential = async target => { credentials.push(target); return { kind: 'pat', token: target.route+'-synthetic-token' }; };
  return { calls, credentials, client: createRoutingClient({ targets, credential, fetch, ...options }) };
}

test('provider-invalid raw values fail locally before discovery or credential access', async () => {
  for (const args of [
    ...['.', '..', 'a\nb', 'a\u007fb', '\ud800'].map(sessionId => ({ ...input, sessionId })),
    { ...input, messages: [{ role: 'user', content: '\udc00' }] },
    ...['0000-01-01T00:00:00Z', '2026-09-11T00:00Z', '2026-09-11T00:00:00.1234567890Z'].map(timestamp =>
      ({ ...input, messages: [{ role: 'user', content: 'valid', timestamp }] })),
  ]) {
    const f = fixture();
    await assert.rejects(f.client.call('memory_ingest', args), { code: 'routing_request_invalid' });
    assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.client.call('memory_search', { routing: input.routing, query: '\ud800' }), { code: 'routing_request_invalid' });
  assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0);
});

test('well-formed Unicode and nanosecond timestamps retain their original wire values', async () => {
  const f = fixture(), args = { ...input, sessionId: '서울😀',
    messages: [{ role: 'user', content: '유니코드 😀', timestamp: '2026-09-11T00:00:00.123456789+09:00' }] };
  await f.client.call('memory_ingest', args);
  const sent = JSON.parse(f.calls[1].init.body).params.arguments;
  assert.equal(sent.sessionId, args.sessionId); assert.deepEqual(sent.messages, args.messages);
});

test('medical transcript selects Seoul locally, preflights without token/body and then preserves full raw input', async () => {
  const f = fixture();
  const result = await f.client.call('memory_ingest', input);
  assert.equal(result.routing.route, 'seoul');
  assert.deepEqual(result.result, ack);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, origins.seoul+'/.well-known/memory-routing');
  assert.equal(f.calls[0].init.body, undefined);
  assert.equal(new Headers(f.calls[0].init.headers).has('authorization'), false);
  assert.equal(f.calls[1].url, origins.seoul+'/mcp');
  const posted = JSON.parse(f.calls[1].init.body);
  assert.deepEqual(posted.params.arguments, { ...input, routing: { ...input.routing, destination: 'seoul', requiredRegion: 'kr-seoul' }, spaceId: 'seoul-space' });
  assert.equal(new Headers(f.calls[1].init.headers).get('authorization'), 'Bearer seoul-synthetic-token');
  assert.deepEqual(f.credentials, [{ route: 'seoul', origin: origins.seoul }]);
  assert.ok(f.calls.every(call => call.init.redirect === 'error' && call.init.credentials === 'omit'));
});

test('general raw ingest works with its own SSO bearer and no BAA flag', async () => {
  const f = fixture({ credential: async target => ({ kind: 'sso', token: target.route+'-sso-value' }) });
  const result = await f.client.call('memory_ingest', { ...input, routing: { version: 1, classification: 'general' } });
  assert.equal(result.routing.route, 'agent-memory');
  assert.ok(f.calls.every(c => c.url.startsWith(origins['agent-memory'])));
  assert.equal(new Headers(f.calls[1].init.headers).get('authorization'), 'Bearer agent-memory-sso-value');
});

test('search query also routes before egress; no automatic fan-out to Cloudflare', async () => {
  const f = fixture();
  await f.client.call('memory_search', { routing: { version: 1, classification: 'uncertain' }, query: '민감할 수 있는 질의', limit: 3 });
  assert.equal(f.calls[1].url, origins.seoul+'/mcp');
  assert.equal(JSON.parse(f.calls[1].init.body).params.arguments.limit, 3);
});

test('missing Seoul configuration makes zero network and credential calls', async () => {
  const f = fixture({ targets: { 'agent-memory': targets['agent-memory'] } });
  await assert.rejects(f.client.call('memory_ingest', input), { code: 'routing_target_unavailable' });
  assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0);
});

test('legacy or unready endpoint cannot receive a token or transcript', async () => {
  for (const value of [{ status: 'ok' }, { version: 1, protocol: 'memory-routing-v1', target: { ...seoul, ready: false } },
    { version: 1, protocol: 'memory-routing-v1', target: cf }, { version: 1, protocol: 'memory-routing-v1', target: { ...seoul, vector: 'cloudflare-vectorize' } }]) {
    const seen = [], f = fixture({ fetch: async (url, init) => { seen.push(init); return json(value); } });
    await assert.rejects(f.client.call('memory_ingest', input), { code: 'routing_target_unavailable' });
    assert.equal(seen.length, 1); assert.equal(f.credentials.length, 0); assert.equal(seen[0].body, undefined);
  }
});

test('unsafe operator endpoint URLs are rejected without any request', () => {
  for (const origin of ['http://example.test', 'https://x:y@example.test', 'https://example.test/path', 'https://example.test?token=x',
    'https://example.test#fragment', 'https://example.test/', 'https://example.test:443', 'https://EXAMPLE.test']) {
    assert.throws(() => fixture({ targets: { seoul: { origin, spaceId: 's1' } } }), { code: 'routing_configuration_invalid' });
  }
});

test('unknown arguments cannot override target URL, auth, space or metadata request', async () => {
  const f = fixture();
  for (const key of ['url', 'spaceId', 'token', 'headers', 'target', 'sourceRestrictions']) {
    await assert.rejects(f.client.call('memory_ingest', { ...input, [key]: 'override' }), { code: 'routing_request_invalid' });
  }
  assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0);
});

test('oversized, empty and invalid raw messages fail without truncation or upload', async () => {
  const f = fixture();
  for (const messages of [[], Array(501).fill({ role: 'user', content: 'a' }), [{ role: 'tool', content: 'x' }],
    [{ role: 'user', content: '가'.repeat(10923) }], [{ role: 'user', content: 'x', timestamp: 'yesterday' }],
    Array(40).fill({ role: 'user', content: 'a'.repeat(32768) })]) {
    await assert.rejects(f.client.call('memory_ingest', { ...input, messages }), { code: 'routing_request_invalid' });
  }
  await assert.rejects(f.client.call('memory_search', { routing: input.routing, query: '가'.repeat(342) }), { code: 'routing_request_invalid' });
  assert.equal(f.calls.length, 0);
});

test('caller mutation while preflighting cannot change content, classification or credential origin', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [], cfg = { ...targets.seoul };
  const request = structuredClone(input);
  const f = fixture({ targets: { seoul: cfg }, fetch: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'GET') { await gate; return json({ version: 1, protocol: 'memory-routing-v1', target: seoul }); }
    return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: ack });
  } });
  const pending = f.client.call('memory_ingest', request);
  request.messages[0].content = 'changed'; request.routing.classification = 'general'; cfg.origin = origins['agent-memory'];
  release(); await pending;
  assert.equal(calls[1].url, origins.seoul+'/mcp');
  assert.deepEqual(JSON.parse(calls[1].init.body).params.arguments.messages, input.messages);
});

test('uncertain provider write is reported once without a hidden alternate route or retry', async () => {
  let count = 0;
  const f = fixture({ fetch: async (_url, init) => {
    count++;
    if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: seoul });
    throw Error('private upstream content');
  } });
  await assert.rejects(f.client.call('memory_ingest', input), e => e.code === 'routing_write_outcome_unknown' && !String(e).includes('private'));
  assert.equal(count, 2);
});

test('pre-aborted request makes no network or credential call', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.call('memory_ingest', input, { signal: controller.signal }), { code: 'routing_request_aborted' });
  assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0);
});

test('metadata and response deadlines remain bounded even if an injected fetch ignores cancellation', async () => {
  const f = fixture({ timeoutMs: 20, fetch: async () => new Promise(() => {}) });
  await assert.rejects(f.client.call('memory_ingest', input), { code: 'routing_request_timeout' });
  assert.equal(f.credentials.length, 0);
});

test('MCP SSE responses are supported without returning notifications or a different request result', async () => {
  const f = fixture({ fetch: async (_url, init) => {
    if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: seoul });
    const id = JSON.parse(init.body).id;
    return new Response('event: message\ndata: '+JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })+'\n\n'+
      'event: message\ndata: '+JSON.stringify({ jsonrpc: '2.0', id, result: ack })+'\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.deepEqual((await f.client.call('memory_ingest', input)).result, ack);
});

test('malformed or oversized provider bodies are sanitized and never replayed', async () => {
  for (const reply of ['sensitive upstream failure', JSON.stringify({ jsonrpc: '2.0', id: 'wrong', result: ack }), 'x'.repeat(2*1024*1024)]) {
    let posts = 0;
    const f = fixture({ fetch: async (_url, init) => {
      if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: seoul });
      posts++; return new Response(reply, { headers: { 'content-type': 'application/json' } });
    } });
    await assert.rejects(f.client.call('memory_ingest', input), { code: 'routing_write_outcome_unknown' });
    assert.equal(posts, 1);
  }
});

test('SSE completes at its matching result even if the server leaves the stream open', async () => {
  let cancelled = false;
  const f = fixture({ timeoutMs: 100, fetch: async (_url, init) => {
    if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: seoul });
    const data = 'event: message\r\ndata: '+JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: ack })+'\r\n\r\n';
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); }, cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.deepEqual((await f.client.call('memory_ingest', input)).result, ack);
  assert.equal(cancelled, true);
});

test('cancellation during credential refresh prevents a late provider upload', async () => {
  let release;
  const credential = () => new Promise(r => { release = r; });
  const f = fixture({ credential, timeoutMs: 20 });
  await assert.rejects(f.client.call('memory_ingest', input), { code: 'routing_request_timeout' });
  release({ kind: 'pat', token: 'late-private-token' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(f.calls.length, 1);
});

test('operator source restrictions apply identically to local plan and actual upload', async () => {
  const restrictions = [{ route: 'seoul', requiredRegion: 'kr-seoul' }];
  const f = fixture({ restrictions });
  restrictions.length = 0;
  const routing = { version: 1, classification: 'general' };
  assert.equal(f.client.plan(routing).route, 'seoul');
  const result = await f.client.call('memory_ingest', { ...input, routing });
  assert.equal(result.routing.route, 'seoul');
  assert.ok(f.calls.every(c => c.url.startsWith(origins.seoul)));
  assert.equal(JSON.parse(f.calls[1].init.body).params.arguments.routing.requiredRegion, 'kr-seoul');
  assert.throws(() => fixture().client.plan(routing, [{ route: 'seoul' }]), { code: 'routing_configuration_invalid' });
});

test('a media-type parameter cannot impersonate routing JSON metadata', async () => {
  let requests = 0;
  const f = fixture({ fetch: async () => {
    requests++;
    return new Response(JSON.stringify({ version: 1, protocol: 'memory-routing-v1', target: seoul }),
      { headers: { 'content-type': 'text/plain; marker=application/json' } });
  } });
  await assert.rejects(f.client.call('memory_ingest', input), { code: 'routing_target_unavailable' });
  assert.equal(requests, 1); assert.equal(f.credentials.length, 0);
});

const consentInput = { ...input, routing: { version: 1, classification: 'medical', medicalCloudflareConsent: { consentId: 'consent-001', version: 3 } } };
function consentFixture(change = {}) {
  const seen = [];
  const f = fixture({ fetch: async (url, init) => {
    seen.push({ url, init });
    if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: cf });
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/v1/routing/consent/check')) return json({ version: 1, allowed: true,
      requestId: body.requestId, spaceId: body.spaceId, consentId: 'consent-001', consentVersion: 3,
      operation: body.operation, expiresAtMs: Date.now()+30000, receipt: 'opaque-synthetic-receipt', ...change });
    return json({ jsonrpc: '2.0', id: body.id, result: ack });
  } });
  return { ...f, seen };
}

test('medical consent flag checks a current scoped receipt before Cloudflare sees raw content', async () => {
  const f = consentFixture();
  const result = await f.client.call('memory_ingest', consentInput);
  assert.equal(result.routing.route, 'agent-memory'); assert.equal(f.seen.length, 3);
  const check = JSON.parse(f.seen[1].init.body), posted = JSON.parse(f.seen[2].init.body);
  assert.equal(check.requestId, posted.id);
  assert.deepEqual(check.consent, consentInput.routing.medicalCloudflareConsent);
  assert.equal(check.spaceId, 'agent-memory-space');
  assert.equal(check.operation, 'memory_ingest');
  assert.equal(f.seen[1].init.body.includes(input.messages[0].content), false);
  assert.equal(check.messages, undefined); assert.equal(check.query, undefined);
  assert.equal(new Headers(f.seen[2].init.headers).get('x-memory-consent-receipt'), 'opaque-synthetic-receipt');
  assert.deepEqual(posted.params.arguments.messages, input.messages);
});

test('revoked, expired, wrong-Space or wrong-version consent cannot upload medical content', async () => {
  for (const change of [{ allowed: false }, { expiresAtMs: Date.now()-1 }, { expiresAtMs: Date.now()+600000 },
    { consentVersion: 2 }, { spaceId: 'different-space' }, { requestId: 'different-request' },
    { operation: 'memory_search' }, { receipt: 'line\nbreak' }]) {
    const f = consentFixture(change);
    await assert.rejects(f.client.call('memory_ingest', consentInput), { code: 'routing_consent_unavailable' });
    assert.equal(f.seen.length, 2);
    assert.ok(f.seen.every(c => !c.init.body || !c.init.body.includes('messages')));
  }
});

test('medical search consent is checked without disclosing its query to the check endpoint', async () => {
  const f = consentFixture();
  await f.client.call('memory_search', { routing: consentInput.routing, query: '복약 기록 질의' });
  assert.equal(JSON.parse(f.seen[1].init.body).operation, 'memory_search');
  assert.equal(JSON.parse(f.seen[1].init.body).query, undefined);
});

test('consent cannot send a workspace pinned to Seoul through Cloudflare', async () => {
  const f = fixture({ restrictions: [{ route: 'seoul' }] });
  const result = await f.client.call('memory_ingest', consentInput);
  assert.equal(result.routing.route, 'seoul');
  assert.ok(f.calls.every(c => c.url.startsWith(origins.seoul)));
  assert.equal(f.calls.length, 2);
});

test('a company standing consent is resolved without asking the employee for a consent ID', async () => {
  const f = consentFixture();
  const routing = { version: 1, classification: 'medical', medicalCloudflareConsent: { mode: 'organization' } };
  const result = await f.client.call('memory_ingest', { ...input, routing });
  assert.equal(result.routing.route, 'agent-memory');
  assert.deepEqual(JSON.parse(f.seen[1].init.body).consent, { mode: 'organization' });
  const posted = JSON.parse(f.seen[2].init.body).params.arguments;
  assert.deepEqual(posted.routing.medicalCloudflareConsent, { consentId: 'consent-001', version: 3 });
  assert.equal(posted.routing.classification, 'medical');
  assert.deepEqual(posted.messages, input.messages);
});

test('company consent is checked again on the next call so a revocation cannot reuse a cached grant', async () => {
  let grants = 0, uploads = 0;
  const f = fixture({ fetch: async (url, init) => {
    if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: cf });
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/consent/check')) {
      grants++;
      return json({ version: 1, allowed: grants === 1, requestId: body.requestId, spaceId: body.spaceId,
        consentId: 'standing-consent', consentVersion: 4, operation: body.operation,
        expiresAtMs: Date.now()+30000, receipt: 'opaque-company-receipt' });
    }
    uploads++;
    return json({ jsonrpc: '2.0', id: body.id, result: ack });
  } });
  const request = { ...input, routing: { version: 1, classification: 'medical', medicalCloudflareConsent: { mode: 'organization' } } };
  await f.client.call('memory_ingest', request);
  await assert.rejects(f.client.call('memory_ingest', request), { code: 'routing_consent_unavailable' });
  assert.equal(grants, 2); assert.equal(uploads, 1);
});

test('an absolute deadline prevents upload after a credential provider blocks the event loop', async () => {
  const f = fixture({ timeoutMs: 30, credential: async () => {
    const until = Date.now()+70;
    while (Date.now() < until) { /* Simulate synchronous credential-provider work. */ }
    return { kind: 'pat', token: 'synthetic-token' };
  } });
  await assert.rejects(f.client.call('memory_ingest', input), { code: 'routing_request_timeout' });
  assert.equal(f.calls.length, 1);
});

test('replacing call options cannot retain the original abort listener after completion', async () => {
  const controller = new AbortController(), listeners = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, listener, options) => { if (type === 'abort') listeners.add(listener); return add(type, listener, options); };
  controller.signal.removeEventListener = (type, listener, options) => { if (type === 'abort') listeners.delete(listener); return remove(type, listener, options); };
  const options = { signal: controller.signal }, f = fixture();
  const pending = f.client.call('memory_ingest', input, options);
  assert.equal(listeners.size, 1);
  options.signal = new AbortController().signal;
  await pending;
  assert.equal(listeners.size, 0);
});

test('SSE ignores the protocol empty priming event before reading its actual result', async () => {
  const f = fixture({ fetch: async (_url, init) => {
    if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: seoul });
    return new Response('id: event-1\ndata:\n\nid: event-2\ndata: '+JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: ack })+'\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.deepEqual((await f.client.call('memory_ingest', input)).result, ack);
});

test('SSE processes CR-only terminators immediately on an open stream', async () => {
  let cancelled = false;
  const f = fixture({ timeoutMs: 200, fetch: async (_url, init) => {
    if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: seoul });
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: ack })+'\r\r'));
    }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.deepEqual((await f.client.call('memory_ingest', input)).result, ack);
  assert.equal(cancelled, true);
});

test('SSE treats CRLF split across chunks as a single terminator', async () => {
  const f = fixture({ fetch: async (_url, init) => {
    if (init.method === 'GET') return json({ version: 1, protocol: 'memory-routing-v1', target: seoul });
    const parts = ['data: {\r', '\ndata: "jsonrpc":"2.0",\r', '\ndata: "id":"'+JSON.parse(init.body).id+'",\r',
      '\ndata: "result":'+JSON.stringify(ack)+'}\r', '\n\r', '\n'];
    return new Response(new ReadableStream({ pull(c) { parts.length ? c.enqueue(new TextEncoder().encode(parts.shift())) : c.close(); } }),
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.deepEqual((await f.client.call('memory_ingest', input)).result, ack);
});

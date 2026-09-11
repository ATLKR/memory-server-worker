import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMemoryHttp, AgentMemoryHttpError } from '../../src/agent-memory/http.ts';

const base = { accountId: 'a'.repeat(32), namespace: 'memory-test', token: 'private-test-token' };
const memory = { id: 'memory-1', type: 'fact', summary: 'A derived fact', content: 'Full derived content', sessionId: 'session-1', createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:01.000Z' };
const envelope = result => ({ success: true, errors: [], messages: [], result });
const response = result => Response.json(envelope(result));
const create = (fetch, options = {}) => createAgentMemoryHttp({ ...base, fetch, ...options });
const raw = [{ role: 'system', content: '시스템\nKeep this exact.' }, { role: 'user', content: 'private full transcript\n\t"raw" \u0000 👨‍👩‍👧', timestamp: '2026-09-11T09:00:00+09:00' }, { role: 'assistant', content: 'Original reply' }];
function safeError(error, code, outcome) {
  assert.ok(error instanceof AgentMemoryHttpError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.outcome, outcome);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(error), /private-test-token|private full transcript|PROVIDER_SECRET/);
  return true;
}

test('ingest preserves full raw messages, pins HTTPS and disables redirects/ambient credentials', async () => {
  let calls = 0;
  const api = create(async (url, init) => {
    calls++;
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${base.accountId}/agent-memory/namespaces/memory-test/profiles/space-1/ingest`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${base.token}`);
    assert.deepEqual(JSON.parse(init.body), { messages: raw, sessionId: 'session-1' });
    return response(null);
  });
  await api.ingest('space-1', raw, 'session-1');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(api), /private-test-token/);
});

test('list/get/recall/delete use native HTTP fields and validated normalized output', async () => {
  const seen = [];
  const api = create(async (url, init) => {
    seen.push([new URL(url), init]);
    if (url.includes('/memories?')) return Response.json({ ...envelope([{ ...memory, content: undefined }]), result_info: { cursor: 'next+=/', count: 1, per_page: 2 } });
    if (url.endsWith('/memories/memory-1')) return response(memory);
    if (url.endsWith('/recall')) return response({ count: 1, answer: 'Derived answer', candidates: [{ id: memory.id, summary: memory.summary, sessionId: 'session-1', score: 0.87 }] });
    return response(null);
  });
  const page = await api.list('space-1', { limit: 2, cursor: 'previous?&', sessionId: 'session-1', type: 'fact' });
  assert.equal(page.cursor, 'next+=/');
  assert.equal(page.memories[0].content, undefined);
  assert.equal(seen[0][0].searchParams.get('per_page'), '2');
  assert.equal(seen[0][0].searchParams.get('session_id'), 'session-1');
  assert.equal(seen[0][0].searchParams.get('cursor'), 'previous?&');
  assert.equal(new Headers(seen[0][1].headers).has('content-type'), false);
  assert.deepEqual(await api.get('space-1', 'memory-1'), memory);
  assert.equal((await api.recall('space-1', 'What happened?', { thinkingLevel: 'low', responseLength: 'short', referenceDate: '2026-09-11T00:00:00Z' })).candidates[0].id, memory.id);
  await api.deleteSession('space-1', 'session-1');
  await api.deleteProfile('space-1');
  assert.equal(seen[3][0].pathname.endsWith('/sessions/session-1'), true);
  assert.equal(seen[3][1].method, 'DELETE');
  assert.equal(seen[4][0].pathname.endsWith('/profiles/space-1'), true);
  assert.equal(seen[4][1].method, 'DELETE');
});

test('path segments and cursors are encoded without altering raw source content', async () => {
  const api = create(async url => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.cloudflare.com');
    assert.equal(parsed.pathname.endsWith('/profiles/team%2F%3F%23%25/ingest'), true);
    return response(null);
  });
  await api.ingest('team/?#%', raw, 'session-1');
});

test('configuration rejects alternate targets, header injection and unbounded limits', () => {
  for (const patch of [{ accountId: '../other' }, { namespace: '..' }, { token: 'secret\r\nInjected: yes' }, { timeoutMs: 0 }, { timeoutMs: 60001 }, { maxResponseBytes: 0 }, { maxResponseBytes: 16777217 }]) {
    assert.throws(() => create(() => assert.fail('network'), patch), e => safeError(e, 'agent_memory_configuration_invalid', 'not_dispatched'));
  }
});

test('invalid requests never dispatch, including UTF-8 byte limits and unknown raw fields', async () => {
  const api = create(() => assert.fail('network'));
  const cases = [
    () => api.ingest('..', raw, 'session-1'),
    () => api.ingest('space-1', [], 'session-1'),
    () => api.ingest('space-1', new Array(1), 'session-1'),
    () => api.ingest('space-1', Array.from({ length: 501 }, () => raw[0]), 'session-1'),
    () => api.ingest('space-1', [{ role: 'tool', content: 'hello' }], 'session-1'),
    () => api.ingest('space-1', [{ role: 'user', content: '가'.repeat(10923) }], 'session-1'),
    () => api.ingest('space-1', [{ role: 'user', content: '\ud800' }], 'session-1'),
    () => api.ingest('space-1', [{ role: 'user', content: 'x', sourceId: 'unmapped' }], 'session-1'),
    () => api.ingest('space-1', raw, 's'.repeat(65)),
    () => api.recall('space-1', '가'.repeat(342)),
    () => api.recall('space-1', 'q', { thinkingLevel: 'unbounded' }),
    () => api.list('space-1', { limit: 501 }),
    () => api.list('space-1', { cursor: 'c'.repeat(4097) }),
    () => api.get('space-1', '..'),
  ];
  for (const invoke of cases) await assert.rejects(invoke(), e => safeError(e, 'agent_memory_input_invalid', 'not_dispatched'));
});

test('request byte cap rejects escaped payload without truncation', async () => {
  const api = create(() => assert.fail('network'), { maxRequestBytes: 128 });
  await assert.rejects(api.ingest('space-1', raw, 'session-1'), e => safeError(e, 'agent_memory_input_invalid', 'not_dispatched'));
});

test('pre-aborted and elapsed deadlines never dispatch', async () => {
  const api = create(() => assert.fail('network'));
  for (const call of [{ signal: AbortSignal.abort('PROVIDER_SECRET') }, { deadlineMs: Date.now() - 1 }]) {
    await assert.rejects(api.ingest('space-1', raw, 'session-1', call), e => safeError(e, call.signal ? 'agent_memory_aborted' : 'agent_memory_timeout', 'not_dispatched'));
  }
});

for (const operation of ['ingest', 'deleteSession', 'deleteProfile']) test(`${operation} reports uncertain dispatch without retry or secret leakage`, async () => {
  let calls = 0;
  const api = create(async () => { calls++; throw new Error('PROVIDER_SECRET private-test-token private full transcript'); });
  const invoke = operation === 'ingest' ? api.ingest('space-1', raw, 'session-1') : operation === 'deleteSession' ? api.deleteSession('space-1', 'session-1') : api.deleteProfile('space-1');
  await assert.rejects(invoke, e => safeError(e, 'agent_memory_transport_failed', 'unknown'));
  assert.equal(calls, 1);
});

test('hard timeout bounds a fetch which ignores AbortSignal and cancels its late response', async () => {
  let release, cancelled = false;
  const api = create(() => new Promise(resolve => { release = resolve; }), { timeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(api.ingest('space-1', raw, 'session-1'), e => safeError(e, 'agent_memory_timeout', 'unknown'));
  assert.ok(Date.now() - started < 1000);
  release(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
});

test('external abort terminates a pending body read and records mutation uncertainty', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const api = create(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
  const pending = api.deleteProfile('space-1', { signal: controller.signal });
  setTimeout(() => controller.abort('PROVIDER_SECRET'), 10);
  await assert.rejects(pending, e => safeError(e, 'agent_memory_aborted', 'unknown'));
  assert.equal(cancelled, true);
});

test('body timeout is bounded independently of headers and cancels stream', async () => {
  let cancelled = false;
  const api = create(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }), { timeoutMs: 20 });
  await assert.rejects(api.get('space-1', 'memory-1'), e => safeError(e, 'agent_memory_timeout', 'read_failed'));
  assert.equal(cancelled, true);
});

test('one absolute deadline includes fetch and body time', async () => {
  let cancelled = false;
  const api = create(async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  }, { timeoutMs: 1000 });
  await assert.rejects(api.ingest('space-1', raw, 'session-1', { deadlineMs: Date.now() + 45 }), e => safeError(e, 'agent_memory_timeout', 'unknown'));
  assert.equal(cancelled, true);
});

for (const [label, result, code] of [
  ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), 'agent_memory_http_error'],
  ['HTML', () => new Response('PROVIDER_SECRET', { headers: { 'content-type': 'text/html' } }), 'agent_memory_response_invalid'],
  ['invalid JSON', () => new Response('{PROVIDER_SECRET', { headers: { 'content-type': 'application/json' } }), 'agent_memory_response_invalid'],
  ['provider error', () => Response.json({ success: false, errors: [{ message: 'PROVIDER_SECRET' }], result: null }), 'agent_memory_provider_error'],
  ['inconsistent success', () => Response.json({ ...envelope(null), errors: [{ message: 'PROVIDER_SECRET' }] }), 'agent_memory_response_invalid'],
  ['unexpected mutation result', () => response({ id: 'x' }), 'agent_memory_response_invalid'],
  ['HTTP error', () => new Response('PROVIDER_SECRET', { status: 503 }), 'agent_memory_http_error'],
]) test(`${label} is sanitized and a dispatched write stays unknown`, async () => {
  let calls = 0;
  const api = create(async () => { calls++; return result(); });
  await assert.rejects(api.ingest('space-1', raw, 'session-1'), e => safeError(e, code, 'unknown'));
  assert.equal(calls, 1);
});

test('response byte limit applies to chunked body, not just Content-Length', async () => {
  let cancelled = false;
  const api = create(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(300)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json', 'content-length': '1' } }), { maxResponseBytes: 256 });
  await assert.rejects(api.get('space-1', 'memory-1'), e => safeError(e, 'agent_memory_response_too_large', 'read_failed'));
  assert.equal(cancelled, true);
});

test('invalid UTF-8 is rejected instead of silently replacing original bytes', async () => {
  const bytes = new Uint8Array([0xff]);
  const api = create(async () => new Response(bytes, { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(api.get('space-1', 'memory-1'), e => safeError(e, 'agent_memory_response_invalid', 'read_failed'));
});

test('get rejects mismatched IDs, malformed dates and unsafe output fields', async () => {
  for (const patch of [{ id: 'another-memory' }, { type: 'secret' }, { updatedAt: 'invalid' }, { sessionId: 123 }, { content: 123 }]) {
    await assert.rejects(create(async () => response({ ...memory, ...patch })).get('space-1', 'memory-1'), e => safeError(e, 'agent_memory_response_invalid', 'read_failed'));
  }
});

test('list rejects oversized pages, malformed cursors and a repeated input cursor', async () => {
  const entry = { ...memory }; delete entry.content;
  for (const body of [
    { ...envelope([entry, entry]), result_info: { count: 2 } },
    { ...envelope([entry]), result_info: { cursor: 123 } },
    { ...envelope([entry]), result_info: { cursor: 'same' } },
  ]) await assert.rejects(create(async () => Response.json(body)).list('space-1', { limit: 1, cursor: 'same' }), e => safeError(e, 'agent_memory_response_invalid', 'read_failed'));
});

test('recall validates counts, candidate shape and finite scores', async () => {
  const candidate = { id: memory.id, summary: 'summary', sessionId: null, score: 0.5 };
  for (const value of [{ count: -1, answer: '', candidates: [] }, { count: 1, answer: '', candidates: [{ ...candidate, score: null }] }, { count: 1, answer: 12, candidates: [candidate] }]) {
    await assert.rejects(create(async () => response(value)).recall('space-1', 'query'), e => safeError(e, 'agent_memory_response_invalid', 'read_failed'));
  }
});

test('calendar-invalid timestamps and malformed call options are sanitized before dispatch', async () => {
  const api = create(() => assert.fail('network'));
  for (const invoke of [
    () => api.ingest('space-1', [{ role: 'user', content: 'original', timestamp: '2026-02-30T00:00:00Z' }], 'session-1'),
    () => api.ingest('space-1', raw, 'session-1', { signal: null }),
    () => api.get('space-1', 'memory-1', null),
  ]) await assert.rejects(invoke(), e => safeError(e, 'agent_memory_input_invalid', 'not_dispatched'));
});

test('off-origin response metadata is rejected even when an injected fetch ignores redirect:error', async () => {
  const api = create(async () => {
    const r = response(null);
    Object.defineProperty(r, 'url', { value: 'https://evil.example/' });
    return r;
  });
  await assert.rejects(api.ingest('space-1', raw, 'session-1'), e => safeError(e, 'agent_memory_response_invalid', 'unknown'));
});

test('a deadline exceeded synchronously still cancels the returned body before reader acquisition', async () => {
  let cancelled = false;
  const api = create(async () => {
    const until = Date.now() + 25;
    while (Date.now() < until) { /* Simulate an event-loop-delayed deadline. */ }
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  }, { timeoutMs: 10 });
  await assert.rejects(api.ingest('space-1', raw, 'session-1'), e => safeError(e, 'agent_memory_timeout', 'unknown'));
  assert.equal(cancelled, true);
});

test('configuration credentials and target are copied before caller mutation', async () => {
  const config = { ...base, fetch: async (url, init) => {
    assert.ok(url.includes(`/accounts/${base.accountId}/`));
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${base.token}`);
    return response(null);
  } };
  const api = createAgentMemoryHttp(config);
  config.accountId = 'b'.repeat(32); config.token = 'other-token';
  await api.ingest('space-1', raw, 'session-1');
});

test('call options are captured once and cleanup removes the original abort listener', async () => {
  const controller = new AbortController(), listeners = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, listener, options) => { if (type === 'abort') listeners.add(listener); return add(type, listener, options); };
  controller.signal.removeEventListener = (type, listener, options) => { if (type === 'abort') listeners.delete(listener); return remove(type, listener, options); };
  let release;
  const api = create(() => new Promise(resolve => { release = resolve; }));
  const call = { signal: controller.signal, deadlineMs: Date.now() + 1000 };
  const pending = api.ingest('space-1', raw, 'session-1', call);
  assert.equal(listeners.size, 1);
  call.signal = AbortSignal.abort(); call.deadlineMs = 1;
  release(response(null));
  await pending;
  assert.equal(listeners.size, 0);
});

test('replacing the caller options does not disconnect the original cancellation signal', async () => {
  const controller = new AbortController();
  let release;
  const api = create(() => new Promise(resolve => { release = resolve; }));
  const call = { signal: controller.signal };
  const pending = api.deleteProfile('space-1', call);
  call.signal = new AbortController().signal;
  controller.abort();
  await assert.rejects(pending, e => safeError(e, 'agent_memory_aborted', 'unknown'));
  release(response(null));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import gate from './management-gate.ts';

const origin = 'https://memory.example.test';
const cookie = '__Host-memory_session=interactive-cookie';

test('management requires a cookie session and keeps the login on its origin and prefix', async () => {
  for (const prefix of ['', '/region-one', '//elsewhere.example.test']) {
    for (const headers of [{}, { authorization: 'Bearer cli-token' },
      { cookie: '__Host-memory_session=expired-cookie' }, { cookie: '__Host-memory_session=pat-cookie' },
      { accept: 'text/html', upgrade: 'websocket' }]) {
      const calls = [];
      const result = await gate.fetch(new Request(`${origin}${prefix}/manage?discard=me`, { headers }), {
        PUBLIC_ORIGIN: origin,
        MEMORY_API: { async fetch(request) { calls.push(request); return new Response('private', { status: 401 }); } },
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${origin}${prefix}/v1/workspace`);
      assert.equal(calls[0].headers.get('authorization'), null);
      assert.equal(calls[0].headers.get('cookie'), headers.cookie ?? null);
      assert.equal(calls[0].redirect, 'manual');
      assert.equal(result.status, 302);
      assert.equal(result.headers.get('location'), `${origin}${prefix}/auth/login`);
      assert.equal(new URL(result.headers.get('location')).origin, origin);
      assert.equal(result.headers.get('cache-control'), 'private, no-store');
      assert.equal(await result.text(), '');
    }
  }
});

test('a successful cookie probe discards private metadata and forwards management without bearer auth', async () => {
  let reads = 0, cancellations = 0;
  const calls = [];
  const privateBody = new ReadableStream({
    pull() { reads++; },
    cancel() { cancellations++; return Promise.reject(new Error('synthetic cancellation failure')); },
  }, { highWaterMark: 0 });
  const original = new Request(`${origin}/region-one/manage?keep=me`, { headers: {
    cookie, authorization: 'Bearer cli-token', origin, 'cf-connecting-ip': '192.0.2.1',
    'x-memory-account-id': 'synthetic-account', 'if-none-match': 'synthetic-etag', range: 'bytes=0-10',
  } });
  const result = await gate.fetch(original, {
    PUBLIC_ORIGIN: origin,
    MEMORY_API: { async fetch(request) {
      calls.push(request);
      return calls.length === 1 ? new Response(privateBody) : new Response('management', {
        headers: { 'content-security-policy': "default-src 'self'", 'set-cookie': 'example=1; Secure', 'cache-control': 'public' },
      });
    } },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${origin}/region-one/v1/workspace`);
  assert.deepEqual([...calls[0].headers.keys()].sort(), ['accept', 'cache-control', 'cf-connecting-ip', 'cookie', 'origin']);
  assert.equal(calls[0].headers.get('origin'), origin);
  assert.equal(calls[0].headers.get('cf-connecting-ip'), '192.0.2.1');
  assert.equal(calls[1].url, original.url);
  const expectedHeaders = new Headers(original.headers);
  expectedHeaders.delete('authorization');
  assert.deepEqual([...calls[1].headers], [...expectedHeaders]);
  assert.equal(cancellations, 1);
  assert.equal(reads, 0);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.headers.get('content-security-policy'), "default-src 'self'");
  assert.equal(result.headers.get('set-cookie'), 'example=1; Secure');
  assert.equal(await result.text(), 'management');
});

test('probe errors, redirects and unexpected success statuses never return management', async (t) => {
  for (const [status, expected] of [[403, 403], [429, 429], [301, 503], [302, 503], [204, 503], [500, 503]]) {
    let calls = 0;
    const result = await gate.fetch(new Request(`${origin}/manage`), {
      PUBLIC_ORIGIN: origin,
      MEMORY_API: { async fetch() { calls++; return new Response(null, { status }); } },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, expected);
    assert.equal(result.headers.has('location'), false);
    assert.equal(await result.text(), '');
  }
  for (const delay of ['3600', 'Wed, 21 Oct 2026 07:28:00 GMT', 'Invalid Date', 'tomorrow']) {
    const result = await gate.fetch(new Request(`${origin}/manage`), {
      PUBLIC_ORIGIN: origin,
      MEMORY_API: { async fetch() { return new Response(null, { status: 429, headers: { 'retry-after': delay } }); } },
    });
    assert.equal(result.headers.get('retry-after'), ['Invalid Date', 'tomorrow'].includes(delay) ? null : delay);
  }
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 5000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('synthetic timeout', 'TimeoutError')), 10);
    return controller.signal;
  });
  let deadline, calls = 0;
  try {
    const result = await Promise.race([
      gate.fetch(new Request(`${origin}/manage`), {
        PUBLIC_ORIGIN: origin,
        MEMORY_API: { fetch(request) {
          calls++;
          return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
        } },
      }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('gate did not time out')), 1000); }),
    ]);
    assert.equal(calls, 1);
    assert.equal(result.status, 503);
    assert.equal(await result.text(), '');
  } finally { clearTimeout(deadline); }
});

test('invalid configuration and mismatched origins fail before forwarding cookies', async () => {
  for (const configured of ['invalid', 'http://memory.example.test', `${origin}/`, `${origin}/path`,
    `${origin}?x=1`, `${origin}#x`, 'https://user@memory.example.test', undefined]) {
    const result = await gate.fetch(new Request(`${origin}/manage`, { headers: { cookie } }), {
      PUBLIC_ORIGIN: configured,
      MEMORY_API: { fetch() { assert.fail('invalid configuration reached backend'); } },
    });
    assert.equal(result.status, 503);
  }
  const result = await gate.fetch(new Request('https://alias.example.test/manage', { headers: { cookie } }), {
    PUBLIC_ORIGIN: origin,
    MEMORY_API: { fetch() { assert.fail('cookie crossed canonical origin'); } },
  });
  assert.equal(result.status, 421);
});

test('other methods, APIs, OAuth and websocket endpoints preserve the original request and response', async () => {
  for (const [path, method, headers] of [
    ['/manage', 'HEAD', {}], ['/manage', 'POST', { authorization: 'Bearer cli-token' }],
    ['/v1/workspace', 'GET', { authorization: 'Bearer cli-token' }], ['/mcp', 'POST', {}],
    ['/mcp', 'GET', { upgrade: 'websocket' }], ['/auth/login', 'GET', {}],
    ['/auth/callback?code=synthetic', 'GET', {}], ['/management', 'GET', {}],
    ['/manage/', 'GET', {}], ['/manage/child', 'GET', {}],
  ]) {
    const original = new Request(`${origin}${path}`, { method, headers, ...(
      method === 'POST' ? { body: 'original bytes' } : {}
    ) });
    const backend = new Response(null, { status: 405, headers: { allow: 'GET' } });
    let calls = 0;
    const result = await gate.fetch(original, {
      PUBLIC_ORIGIN: origin,
      MEMORY_API: { async fetch(request) { calls++; assert.equal(request, original); return backend; } },
    });
    assert.equal(calls, 1);
    assert.equal(result, backend);
    if (method === 'POST') assert.equal(await original.text(), 'original bytes');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers.mjs';
import { digestToken } from '../src/identity.ts';
import { body as readBody, createMemoryApi } from '../src/api.ts';

const NOW = 1_800_000_000_000;
const TOKEN = 'synthetic-api-session-token-0000000000000000';
async function fixture(t) {
  const f = createDatabase();
  t.after(() => f.close());
  const { readFileSync } = await import('node:fs');
  f.raw.exec(readFileSync(new URL('../memory-schema.sql', import.meta.url), 'utf8'));
  f.raw.prepare('INSERT INTO accounts(id) VALUES (?)').run('api-account');
  f.raw.prepare(`INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at)
    VALUES (?,?, 'session',?,?,?)`).run('api-session', 'api-account', await digestToken(TOKEN), NOW + 60_000, NOW);
  const api = createMemoryApi(f.db, () => NOW);
  const request = async (path, { method = 'GET', body, token = TOKEN, headers = {} } = {}) => {
    const res = await api(new Request('http://localhost' + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }));
    return { res, data: res.status === 204 ? null : await res.json() };
  };
  return { ...f, api, request };
}

test('HTTP lifecycle preserves revisions and denies deleted records', async t => {
  const { request } = await fixture(t);
  const space = await request('/v1/spaces', { method: 'POST', body: { name: 'Personal notes' } });
  assert.equal(space.res.status, 201);
  const base = `/v1/spaces/${space.data.id}/memories`;
  const created = await request(base, { method: 'POST', body: { body: 'Cloudflare memory design', source: 'test' } });
  assert.equal(created.res.status, 201);
  assert.equal(created.data.revision, 1);
  const item = `${base}/${created.data.id}`;
  const read = await request(item);
  assert.equal(read.data.body, 'Cloudflare memory design');
  const search = await request(`${base}?query=memory&limit=5`);
  assert.equal(search.data.results.length, 1);
  assert.equal(search.data.results[0].id, created.data.id);
  const update = await request(item, { method: 'PATCH', body: { body: 'Revised memory design', expectedRevision: 1 } });
  assert.equal(update.res.status, 200);
  assert.equal(update.data.revision, 2);
  const stale = await request(item, { method: 'PATCH', body: { body: 'Lost update', expectedRevision: 1 } });
  assert.equal(stale.res.status, 409);
  const removed = await request(item, { method: 'DELETE', body: { expectedRevision: 2 } });
  assert.equal(removed.res.status, 204);
  assert.equal((await request(item)).res.status, 403);
  assert.deepEqual((await request(`${base}?query=memory`)).data, { results: [] });
});

test('HTTP requires a bearer credential and sanitizes denial', async t => {
  const { request } = await fixture(t);
  const noToken = await request('/v1/spaces', { method: 'POST', body: { name: 'x' }, token: null });
  assert.equal(noToken.res.status, 401);
  assert.equal(noToken.res.headers.get('www-authenticate'), 'Bearer');
  const invalid = await request('/v1/spaces', { method: 'POST', body: { name: 'x' }, token: 'not-a-valid-token' });
  assert.equal(invalid.res.status, 403);
  assert.deepEqual(invalid.data, { error: 'access_denied' });
  assert.equal(invalid.res.headers.get('cache-control'), 'no-store');
});

test('revocation immediately denies previously working HTTP access', async t => {
  const { request, raw } = await fixture(t);
  const space = await request('/v1/spaces', { method: 'POST', body: { name: 'private' } });
  const base = `/v1/spaces/${space.data.id}/memories`;
  const created = await request(base, { method: 'POST', body: { body: 'private memory' } });
  raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(NOW, 'api-session');
  assert.equal((await request(`${base}/${created.data.id}`)).res.status, 403);
});

test('HTTP rejects malformed, non-object, unknown-field and zero-access input', async t => {
  const { request } = await fixture(t);
  for (const body of ['{', '[]', 'null', { name: 'x', accountId: 'someone-else' }, { name: 'x', securityMode: 'zero_access' }]) {
    const out = await request('/v1/spaces', { method: 'POST', body });
    assert.equal(out.res.status, 400);
    assert.deepEqual(out.data, { error: 'invalid_request' });
  }
  const badType = await request('/v1/spaces', { method: 'POST', body: { name: 'x' }, headers: { 'content-type': 'text/plain' } });
  assert.equal(badType.res.status, 415);
});

test('HTTP enforces actual stream size without trusting content-length', async t => {
  const { request } = await fixture(t);
  const out = await request('/v1/spaces', { method: 'POST', body: ' '.repeat(30 * 1024), headers: { 'content-length': '1' } });
  assert.equal(out.res.status, 413);
});

test('HTTP validates numeric query limits and unsupported routes', async t => {
  const { request } = await fixture(t);
  const space = await request('/v1/spaces', { method: 'POST', body: { name: 'private' } });
  for (const limit of ['NaN', '0', '1.5', '51', '1e1']) {
    assert.equal((await request(`/v1/spaces/${space.data.id}/memories?query=x&limit=${limit}`)).res.status, 400);
  }
  assert.equal((await request('/v1/spaces', { method: 'PUT' })).res.status, 405);
  assert.equal((await request('/v1/unknown')).res.status, 404);
});

test('HTTP suppresses internal database messages and never logs memory bodies', async () => {
  const db = { prepare() { throw new Error('SQL secret/private memory'); }, withSession() { return this; } };
  const api = createMemoryApi(db, () => NOW);
  const res = await api(new Request('http://localhost/v1/spaces', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"name":"x"}'
  }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal_error' });
});

test('HTTP rejects NUL text as invalid input without storing broken search content', async t => {
  const { request } = await fixture(t);
  const invalidSpace = await request('/v1/spaces', { method: 'POST', body: { name: '\u0000hidden' } });
  assert.equal(invalidSpace.res.status, 400);
  const space = await request('/v1/spaces', { method: 'POST', body: { name: 'Valid Space' } });
  const base = `/v1/spaces/${space.data.id}/memories`;
  for (const body of [{ body: '\u0000hidden' }, { body: 'before\u0000hidden' }, { body: 'valid', source: 'nul\u0000source' }]) {
    const out = await request(base, { method: 'POST', body });
    assert.equal(out.res.status, 400);
    assert.deepEqual(out.data, { error: 'invalid_request' });
  }
  assert.equal((await request(`${base}?query=${encodeURIComponent('hid\u0000den')}`)).res.status, 400);
  assert.deepEqual((await request(`${base}?query=hidden`)).data, { results: [] });
});

const turn = () => new Promise(resolve => setImmediate(resolve));
for (const releaseEnabled of [false, true]) for (const path of ['/v1/spaces', '/v1/organizations', '/v1/invitations/accept'])
test('foundation body deadline cancels stalled HTTP '+path+'; release='+releaseEnabled, async t => {
  const { createFixture } = await import('./helpers.mjs');
  const { createApplication } = await import('../src/app.ts');
  const { readSettings, PUBLIC_ORIGIN } = await import('../src/config.ts');
  const { createRelease } = await import('../src/release/extension.ts');
  const f = await createFixture({ workspace: true }); t.after(f.close);
  const env = { DB: f.db, REQUEST_LIMITER: { limit: async () => ({ success: true }) } };
  const app = createApplication(f.db, readSettings(env), { clock: f.clock,
    ...(releaseEnabled ? { release: createRelease(env, { clock: f.clock }) } : {}) });
  let controller, cancelled = 0, started;
  const reading = new Promise(resolve => { started = resolve; });
  const stream = new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode('{')); },
    pull() { started(); }, cancel() { cancelled++; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = new Request(PUBLIC_ORIGIN + path, { method: 'POST', duplex: 'half', body: stream,
    headers: { authorization: 'Bearer ' + f.tokens.alice, 'content-type': 'application/json' } });
  let response;
  const pending = app(request).then(value => { response = value; });
  await reading;
  await turn();
  t.mock.timers.tick(9999); await turn();
  assert.equal(response, undefined); assert.equal(cancelled, 0);
  t.mock.timers.tick(1); await turn();
  const timedOut = response !== undefined;
  // Release the intentionally stalled body even on the unfixed implementation.
  if (!timedOut) controller.close();
  await pending;
  assert.equal(timedOut, true, 'request must settle at its body deadline');
  assert.equal(response.status, 408); assert.deepEqual(await response.json(), { error: 'read_timeout' });
  assert.equal(cancelled, 1);
});

for (const cancellation of ['stalls', 'rejects']) test('foundation deadline also settles when stream cancellation '+cancellation, async t => {
  let cancelled = 0, controller, finishCancel;
  const request = new Request('http://localhost/v1/spaces', { method: 'POST', duplex: 'half',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ start(value) { controller = value; }, cancel() {
      cancelled++; return cancellation === 'rejects' ? Promise.reject(new Error('synthetic cancel failure')) : new Promise(resolve => { finishCancel = resolve; });
    } }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let outcome;
  const pending = readBody(request, ['name']).then(value => { outcome = value; }, error => { outcome = error; });
  t.mock.timers.tick(10000); await turn();
  const timedOut = outcome !== undefined;
  if (!timedOut) controller.error(new Error('release stalled test body'));
  finishCancel?.();
  await pending;
  assert.equal(timedOut, true);
  assert.equal(outcome.status, 408); assert.equal(outcome.code, 'read_timeout'); assert.equal(cancelled, 1);
  assert.equal(request.body.locked, false);
});

test('foundation oversize rejection does not await an uncooperative cancel callback', async t => {
  let cancelled = 0, finishCancel;
  const request = new Request('http://localhost/v1/spaces', { method: 'POST', duplex: 'half',
    headers: { 'content-type': 'application/json', 'content-length': '1' },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(24 * 1024 + 1)); },
      cancel() { cancelled++; return new Promise(resolve => { finishCancel = resolve; }); } }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let error;
  const pending = readBody(request, ['name']).catch(value => { error = value; });
  await turn();
  const settledBeforeCancellation = error !== undefined;
  finishCancel?.();
  await pending;
  assert.equal(settledBeforeCancellation, true, 'oversize rejection must not wait for cancellation completion');
  assert.equal(error.status, 413); assert.equal(error.code, 'request_too_large'); assert.equal(cancelled, 1);
  assert.equal(request.body.locked, false);
});

test('foundation body uses one total deadline despite progressive chunks', async t => {
  let controller, cancelled = 0, error;
  const request = new Request('http://localhost/v1/spaces', { method: 'POST', duplex: 'half',
    headers: { 'content-type': 'application/json' }, body: new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled++; } }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = readBody(request, ['name']).catch(value => { error = value; });
  for (const chunk of ['{"name":"', 'still sending']) {
    t.mock.timers.tick(4000); controller.enqueue(new TextEncoder().encode(chunk)); await turn();
  }
  t.mock.timers.tick(1999); await turn(); assert.equal(error, undefined);
  t.mock.timers.tick(1); await turn();
  const timedOut = error !== undefined;
  if (!timedOut) controller.close();
  await pending;
  assert.equal(timedOut, true); assert.equal(error.status, 408); assert.equal(error.code, 'read_timeout'); assert.equal(cancelled, 1);
});

test('foundation body keeps normal chunked parsing and clears its deadline', async t => {
  let cancelled = 0;
  const request = new Request('http://localhost/v1/spaces', { method: 'POST', duplex: 'half',
    headers: { 'content-type': 'Application/JSON; charset=utf-8' }, body: new ReadableStream({ start(controller) {
      for (const chunk of ['{"na', 'me":"ok"}', ' '.repeat(24 * 1024 - 13)]) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }, cancel() { cancelled++; } }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.deepEqual(await readBody(request, ['name']), { name: 'ok' });
  assert.equal(request.body.locked, false); t.mock.timers.tick(10000); assert.equal(cancelled, 0);
});

test('foundation body stream failures remain sanitized server errors', async t => {
  const f = await fixture(t);
  const request = new Request('http://localhost/v1/spaces', { method: 'POST', duplex: 'half',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: new ReadableStream({ start(controller) { controller.error(new Error('synthetic stream failure')); } }) });
  const response = await f.api(request);
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: 'internal_error' });
  assert.equal(request.body.locked, false);
});

for (const deadline of [false, true]) test('foundation rejected pending read '+(deadline ? 'after timeout remains408' : 'before timeout remains500'), async t => {
  const f = await fixture(t), failure = new Error('Stream was cancelled.');
  let rejectRead, released = false;
  const request = new Request('http://localhost/v1/spaces', { method: 'POST', headers: {
    authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: '{}' });
  // Native workerd rejects the pending read after cancelling its incoming body.
  request.body.getReader = () => ({
    read: () => deadline ? new Promise((_, reject) => { rejectRead = reject; }) : Promise.reject(failure),
    cancel: () => { rejectRead?.(failure); return Promise.resolve(); },
    releaseLock: () => { released = true; },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.api(request);
  if (deadline) t.mock.timers.tick(10000);
  const response = await pending;
  assert.equal(response.status, deadline ? 408 : 500);
  assert.deepEqual(await response.json(), { error: deadline ? 'read_timeout' : 'internal_error' });
  assert.equal(released, true);
});

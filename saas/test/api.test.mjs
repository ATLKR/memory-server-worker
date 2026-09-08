import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers.mjs';
import { digestToken } from '../src/identity.ts';
import { createMemoryApi } from '../src/api.ts';

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

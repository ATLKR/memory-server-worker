import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createAuthController } from '../src/auth.ts';
import { createDatabase, seedCredential, NOW } from './helpers.mjs';

const settings = {
  origin: 'https://memory.allenlabs.org', issuer: 'https://auth-api.allen.company',
  authorizationEndpoint: 'https://auth-api.allen.company/oauth/authorize',
  tokenEndpoint: 'https://auth-api.allen.company/oauth/token',
  jwksUri: 'https://auth-api.allen.company/.well-known/jwks.json', clientId: 'registered-browser-client',
};
const keys = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(keys.publicKey), alg: 'RS256', kid: 'test-key', use: 'sig' };
const jwks = createLocalJWKSet({ keys: [publicJwk] });
const seconds = NOW / 1000;
async function signed(overrides = {}, header = {}) {
  return new SignJWT({ sub: 'stable-provider-subject', iss: settings.issuer, aud: settings.origin,
    client_id: settings.clientId, azp: settings.clientId, jti: 'unique-provider-token',
    token_use: 'access', iat: seconds, exp: seconds + 900, banned: false,
    scope: 'openid profile email memory:read memory:write memory:delete',
    email: 'alice@example.com', emailVerified: true, name: 'Alice', ...overrides,
  }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'test-key', ...header }).sign(keys.privateKey);
}
async function fixture(opts = {}) {
  const storage = createDatabase();
  storage.raw.exec(readFileSync(new URL('../auth-schema.sql', import.meta.url), 'utf8'));
  storage.raw.exec("INSERT INTO accounts(id) VALUES ('alice')");
  let now = NOW;
  const principals = [];
  const exchanges = [];
  const localToken = 'browser-local-session-00000000000000000000000000000000';
  const signIn = async (principal, externalToken) => {
    principals.push({ ...principal, externalToken });
    const token = externalToken ? 'mapped-machine-session-000000000000000000000000000' : localToken;
    await seedCredential(storage.raw, { id: crypto.randomUUID(), accountId: 'alice', token,
      expiresAt: principal.expiresAt, permission: principal.permission, reauthenticatedAt: null });
    return { token, accountId: 'alice', expiresAt: principal.expiresAt };
  };
  const network = async (url, init) => {
    exchanges.push({ url: String(url), init });
    return Response.json({ access_token: await signed(opts.claims), token_type: 'Bearer',
      expires_in: 900, refresh_token: 'must-not-be-stored' });
  };
  const controller = createAuthController(storage.db, { ...settings, ...opts.settings }, signIn,
    { clock: () => now, ...(opts.remoteJwks ? {} : { jwks }), fetch: opts.fetch ?? network,
      publicKeyCache: opts.publicKeyCache });
  const request = (path, init) => new Request(`${settings.origin}${path}`, init);
  const begin = async () => {
    const response = await controller.handle(request('/auth/login'));
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'));
    const cookie = response.headers.getSetCookie().find(c => c.startsWith('__Host-memory_flow=')).split(';')[0];
    return { response, location, cookie, state: location.searchParams.get('state') };
  };
  const callback = (flow, query = {}, cookie = flow.cookie) => {
    const params = new URLSearchParams({ code: 'one-time-provider-code', state: flow.state,
      iss: settings.issuer, ...query });
    return controller.handle(request(`/auth/callback?${params}`, { headers: { cookie } }));
  };
  return { ...storage, ...controller, request, begin, callback, principals, exchanges, localToken,
    setNow: value => { now = value; } };
}

test('browser login binds PKCE to a single-use callback and stores only the opaque local session', async t => {
  const f = await fixture(); t.after(f.close);
  const flow = await f.begin();
  assert.equal(flow.location.origin + flow.location.pathname, settings.authorizationEndpoint);
  assert.equal(flow.location.searchParams.get('redirect_uri'), `${settings.origin}/auth/callback`);
  assert.equal(flow.location.searchParams.get('resource'), settings.origin);
  assert.equal(flow.location.searchParams.get('code_challenge_method'), 'S256');
  assert.match(flow.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(flow.response.headers.get('set-cookie'), /; Secure; HttpOnly; SameSite=Lax/);
  const response = await f.callback(flow);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  const body = new URLSearchParams(f.exchanges[0].init.body);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),
    flow.location.searchParams.get('code_challenge'));
  assert.equal(body.get('resource'), settings.origin);
  assert.equal(f.exchanges[0].init.redirect, 'error');
  assert.match(response.headers.get('set-cookie'), new RegExp(`__Host-memory_session=${f.localToken}`));
  assert.match(response.headers.get('set-cookie'), /Max-Age=900/);
  assert.equal(f.principals[0].emailVerified, true);
  assert.equal(f.principals[0].permission, 'write');
  assert.equal(f.principals[0].externalToken, undefined);
  assert.equal('reauthenticatedAt' in f.principals[0], false);
  const row = f.raw.prepare('SELECT * FROM auth_flows').get();
  assert.equal(row.verifier, null);
  assert.equal(JSON.stringify(row).includes(flow.state), false);
  assert.equal(JSON.stringify(row).includes('must-not-be-stored'), false);
  assert.equal((await f.callback(flow)).status, 400);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM credentials').get().n, 1);
});

test('callback rejects expired, unbound, duplicate and issuer-confused requests before exchanging', async t => {
  for (const scenario of ['binding', 'state', 'issuer', 'duplicate', 'error', 'expiry']) {
    await t.test(scenario, async t => {
      const f = await fixture(); t.after(f.close);
      const flow = await f.begin();
      let response;
      if (scenario === 'binding') response = await f.callback(flow, {}, '__Host-memory_flow=wrong-browser-000000000000000000000000000');
      if (scenario === 'state') response = await f.callback(flow, { state: 'other-state-000000000000000000000000000000000' });
      if (scenario === 'issuer') response = await f.callback(flow, { iss: 'https://untrusted.example' });
      if (scenario === 'error') response = await f.callback(flow, { error: 'access_denied' });
      if (scenario === 'duplicate') response = await f.handle(f.request(`/auth/callback?code=x&code=y&state=${flow.state}&iss=${encodeURIComponent(settings.issuer)}`, { headers: { cookie: flow.cookie } }));
      if (scenario === 'expiry') { f.setNow(NOW + 600_001); response = await f.callback(flow); }
      assert.equal(response.status, 400);
      assert.equal(f.exchanges.length, 0);
      assert.equal(f.raw.prepare('SELECT count(*) AS n FROM credentials').get().n, 0);
    });
  }
});

test('real signed bearer validation rejects wrong token authority, use, lifetime and capabilities', async t => {
  const invalid = [
    { iss: 'https://another.example' }, { aud: 'https://memory.allenlim.net' },
    { aud: [settings.origin, 'https://memory.allenlim.net'] }, { exp: seconds },
    { iat: seconds + 1 }, { iat: seconds - 1, exp: seconds + 900 }, { jti: '' },
    { sub: '' }, { client_id: '' }, { azp: 'different-client' }, { token_use: 'id' },
    { scope: 'openid profile email memory:write' }, { banned: true }, { banned: 'false' },
  ];
  for (const claims of invalid) await t.test(JSON.stringify(claims), async t => {
    const f = await fixture(); t.after(f.close);
    await assert.rejects(f.resolveBearer(await signed(claims)));
    assert.equal(f.raw.prepare('SELECT count(*) AS n FROM credentials').get().n, 0);
  });
  const f = await fixture(); t.after(f.close);
  await assert.rejects(f.resolveBearer(await signed({}, { typ: 'JWT' })));
  await assert.rejects(f.resolveBearer(`${await signed()}bad`));
});

test('MCP clients may differ from browser client but write access requires both write and delete', async t => {
  const f = await fixture(); t.after(f.close);
  const token = await signed({ client_id: 'registered-mcp-client', azp: 'registered-mcp-client',
    scope: 'openid email memory:read memory:write', emailVerified: false });
  assert.match(await f.resolveBearer(token), /^mapped-machine-session-/);
  assert.equal(f.principals[0].permission, 'read');
  assert.equal(f.principals[0].externalToken, token);
  assert.equal(f.principals[0].emailVerified, false);
});

test('browser callback rejects access tokens issued to a different registered client', async t => {
  const f = await fixture({ claims: { client_id: 'other-client', azp: 'other-client' } }); t.after(f.close);
  assert.equal((await f.callback(await f.begin())).status, 400);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM credentials').get().n, 0);
});

test('logout requires exact Origin POST and permanently revokes the browser credential', async t => {
  const f = await fixture(); t.after(f.close);
  await f.callback(await f.begin());
  const headers = { cookie: `__Host-memory_session=${f.localToken}` };
  for (const origin of [undefined, 'https://evil.example', `${settings.origin}/path`]) {
    const response = await f.handle(f.request('/auth/logout', { method: 'POST', headers: { ...headers, ...(origin ? { origin } : {}) } }));
    assert.equal(response.status, 403);
  }
  assert.equal(f.raw.prepare('SELECT revoked_at FROM credentials').get().revoked_at, null);
  assert.equal((await f.handle(f.request('/auth/logout', { headers }))).status, 405);
  const response = await f.handle(f.request('/auth/logout', { method: 'POST', headers: { ...headers, origin: settings.origin } }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get('set-cookie'), /__Host-memory_session=;.*Max-Age=0/);
  assert.equal(f.raw.prepare('SELECT revoked_at FROM credentials').get().revoked_at, NOW);
});

test('missing client configuration leaves unrelated public pages routable and fails login closed', async t => {
  const f = await fixture({ settings: { clientId: '' } }); t.after(f.close);
  assert.equal(await f.handle(f.request('/')), null);
  assert.equal((await f.handle(f.request('/auth/login'))).status, 503);
});

test('provider redirects, oversized bodies and callback races cannot issue sessions', async t => {
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    Response.json({ access_token: 'x'.repeat(50_000) })]) {
    const f = await fixture({ fetch: async () => response }); t.after(f.close);
    assert.equal((await f.callback(await f.begin())).status, 400);
    assert.equal(f.raw.prepare('SELECT count(*) AS n FROM credentials').get().n, 0);
  }
  const f = await fixture(); t.after(f.close);
  const flow = await f.begin();
  const responses = await Promise.all([f.callback(flow), f.callback(flow)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [303, 400]);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM credentials').get().n, 1);
});

test('production JWKS transport verifies real provider keys and rejects redirects or oversized key sets', async t => {
  const token = await signed();
  const f = await fixture({ remoteJwks: true, fetch: async () => Response.json({ keys: [publicJwk] }) });
  t.after(f.close);
  assert.match(await f.resolveBearer(token), /^mapped-machine-session-/);
  assert.equal(f.principals[0].subject, 'stable-provider-subject');
  for (const result of [new Response(null, { status: 302, headers: { location: 'https://evil.example/jwks' } }),
    Response.json({ keys: [publicJwk], padding: 'x'.repeat(70_000) }),
    Response.json({ keys: [{ ...publicJwk, kid: 'wrong-key' }] })]) {
    const bad = await fixture({ remoteJwks: true, fetch: async () => result });
    t.after(bad.close);
    await assert.rejects(bad.resolveBearer(token));
    assert.equal(bad.raw.prepare('SELECT count(*) AS n FROM credentials').get().n, 0);
  }
});

test('invalid provider configuration and duplicate session cookies cannot become authority', async t => {
  for (const override of [{ issuer: 'http://auth-api.allen.company' },
    { tokenEndpoint: 'https://unexpected.example/token' }, { origin: `${settings.origin}/extra` }]) {
    const f = await fixture({ settings: override }); t.after(f.close);
    assert.equal((await f.handle(new Request(`${override.origin ?? settings.origin}/auth/login`)))?.status === 302, false);
    await assert.rejects(f.resolveBearer(await signed()));
  }
  const f = await fixture(); t.after(f.close);
  await f.callback(await f.begin());
  const response = await f.handle(f.request('/auth/logout', { method: 'POST', headers: {
    origin: settings.origin, cookie: `__Host-memory_session=${f.localToken}; __Host-memory_session=${f.localToken}`,
  } }));
  assert.equal(response.status, 303);
  assert.equal(f.raw.prepare('SELECT revoked_at FROM credentials').get().revoked_at, null);
});

test('separate request controllers reuse public JWKS data and refresh an expired cache', async t => {
  const publicKeyCache = {};
  const token = await signed();
  const first = await fixture({ remoteJwks: true, publicKeyCache,
    fetch: async () => Response.json({ keys: [publicJwk] }) });
  t.after(first.close);
  assert.match(await first.resolveBearer(token), /^mapped-machine-session-/);
  const second = await fixture({ remoteJwks: true, publicKeyCache,
    fetch: async () => { throw new Error('fresh public keys must survive the earlier request'); } });
  t.after(second.close);
  assert.match(await second.resolveBearer(token), /^mapped-machine-session-/);
  assert.deepEqual(Object.keys(publicKeyCache).sort(), ['jwks', 'uat']);
  assert.deepEqual(publicKeyCache.jwks.keys, [publicJwk]);
  // A stale snapshot with the wrong key cannot authenticate unless reloaded.
  publicKeyCache.uat = Date.now() - 600_001;
  publicKeyCache.jwks = { keys: [{ ...publicJwk, kid: 'retired-key' }] };
  const third = await fixture({ remoteJwks: true, publicKeyCache,
    fetch: async () => Response.json({ keys: [publicJwk] }) });
  t.after(third.close);
  assert.match(await third.resolveBearer(token), /^mapped-machine-session-/);
});

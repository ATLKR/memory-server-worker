import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createDatabase, NOW } from './helpers.mjs';
import { WorkspaceService } from '../src/workspace.ts';
import { createApplication } from '../src/app.ts';
import { readSettings, PUBLIC_ORIGIN, AUTH_ISSUER, SERVICE_ID } from '../src/config.ts';
import { SESSION_COOKIE } from '../src/auth.ts';

async function fixture(t, options = {}) {
  const f = createDatabase({ workspace: true }); t.after(f.close);
  const settings = readSettings({ SSO_CLIENT_ID: 'test-client', ...options.vars });
  let now = NOW;
  const workspace = new WorkspaceService(f.db, () => now);
  const session = await workspace.signIn({ issuer: AUTH_ISSUER, subject: 'integration-user', email: 'owner@example.org', emailVerified: true, expiresAt: NOW + 900000, permission: 'write' });
  const app = createApplication(f.db, settings, { clock: () => now, ...options.app });
  const cookie = `${SESSION_COOKIE}=${session.token}`;
  async function request(path, { method = 'GET', data, headers = {}, authenticated = true } = {}) {
    return app(new Request(PUBLIC_ORIGIN + path, { method,
      headers: { ...(authenticated ? { cookie } : {}), ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(data !== undefined ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}),
    }));
  }
  return { ...f, settings, workspace, session, cookie, app, request, setNow: at => { now = at; } };
}
const sameOrigin = { origin: PUBLIC_ORIGIN };

test('browser organization creation preserves an explicit parent without granting inherited access', async t => {
  const f = await fixture(t);
  const snap = await (await f.request('/v1/workspace')).json();
  const emailId = snap.account.emails[0].id;
  const parentResponse = await f.request('/v1/organizations', { method: 'POST', headers: sameOrigin, data: { name: 'Parent organization', emailId } });
  assert.equal(parentResponse.status, 201);
  const parent = await parentResponse.json();
  const childResponse = await f.request('/v1/organizations', { method: 'POST', headers: sameOrigin, data: { name: 'Child organization', emailId, parentOrganizationId: parent.id } });
  assert.equal(childResponse.status, 201);
  const child = await childResponse.json();
  const after = await (await f.request('/v1/workspace')).json();
  assert.equal(after.organizations.find(org => org.id === child.id).parentId, parent.id);
  const outsider = await f.workspace.signIn({ issuer: AUTH_ISSUER, subject: 'hierarchy-outsider', email: 'outsider@example.org', emailVerified: true, expiresAt: NOW + 900000, permission: 'write' });
  const outsiderSnap = await f.workspace.snapshot(outsider.token);
  const outsiderHeaders = { ...sameOrigin, cookie: `${SESSION_COOKIE}=${outsider.token}` };
  const denied = await f.request('/v1/organizations', { method: 'POST', headers: outsiderHeaders, data: { name: 'Unauthorized child', emailId: outsiderSnap.account.emails[0].id, parentOrganizationId: parent.id } });
  assert.equal(denied.status, 403);
  assert.equal((await f.request(`/v1/spaces/${child.spaceId}/memories`, { headers: outsiderHeaders })).status, 403);
  const invalid = await f.request('/v1/organizations', { method: 'POST', headers: sameOrigin, data: { name: 'Bad parent', emailId, parentOrganizationId: 123 } });
  assert.equal(invalid.status, 400);
});

test('console branding can change while stable origin, identity and stored memory remain intact', async t => {
  const f = await fixture(t);
  const snapshot = await (await f.request('/v1/workspace')).json();
  const space = snapshot.spaces[0];
  const created = await f.request(`/v1/spaces/${space.id}/memories`, { method: 'POST', headers: sameOrigin, data: { body: '상표명과 독립된 기억' } });
  assert.equal(created.status, 201);
  const renamed = readSettings({ SSO_CLIENT_ID: 'test-client', PRODUCT_NAME: 'Future Registered Brand', PRODUCT_SHORT_NAME: 'Future' });
  const app = createApplication(f.db, renamed, { clock: () => NOW });
  const html = await (await app(new Request(PUBLIC_ORIGIN))).text();
  assert.match(html, /<title>Future Registered Brand/);
  const after = await (await app(new Request(PUBLIC_ORIGIN + '/v1/workspace', { headers: { cookie: f.cookie } }))).json();
  assert.equal(after.account.id, snapshot.account.id); assert.equal(after.spaces[0].id, space.id);
  assert.equal(renamed.auth.issuer, AUTH_ISSUER); assert.equal(renamed.origin, PUBLIC_ORIGIN);
  const metadata = await (await app(new Request(PUBLIC_ORIGIN + '/.well-known/oauth-protected-resource'))).json();
  assert.equal(metadata.resource_name, 'Future Registered Brand'); assert.equal(metadata.resource, PUBLIC_ORIGIN);
});

test('browser CSRF, invalid Host/Origin, missing authentication and duplicate cookies fail closed', async t => {
  const f = await fixture(t);
  const data = { name: 'Forged', emailId: 'x' };
  assert.equal((await f.request('/v1/organizations', { method: 'POST', data })).status, 403);
  assert.equal((await f.request('/v1/organizations', { method: 'POST', data, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/v1/workspace', { authenticated: false })).status, 401);
  assert.equal((await f.request('/v1/workspace', { headers: { cookie: `${f.cookie}; ${f.cookie}` } })).status, 401);
  assert.equal((await f.app(new Request('https://different.example/v1/workspace', { headers: { cookie: f.cookie } }))).status, 421);
  const anonymousMcp = await f.request('/mcp', { method: 'POST', data: {}, authenticated: true });
  assert.equal(anonymousMcp.status, 401); assert.match(anonymousMcp.headers.get('www-authenticate'), /oauth-protected-resource/);
  f.setNow(NOW + 900001); assert.equal((await f.request('/v1/workspace')).status, 401);
});

test('workspace owner can issue, use and revoke personal key across REST and MCP', async t => {
  const f = await fixture(t);
  const snap = await (await f.request('/v1/workspace')).json();
  const issued = await f.request('/v1/keys', { method: 'POST', headers: sameOrigin, data: { label: 'Agent', permission: 'write', expiresInDays: 3 } });
  assert.equal(issued.status, 201);
  const key = await issued.json(); const bearer = { authorization: `Bearer ${key.token}` };
  const base = `/v1/spaces/${snap.spaces[0].id}/memories`;
  const created = await f.request(base, { method: 'POST', authenticated: false, headers: bearer, data: { body: 'Agent memory' } });
  assert.equal(created.status, 201);
  assert.equal((await f.request('/v1/workspace', { authenticated: false, headers: bearer })).status, 401);
  const mcpHeaders = { ...bearer, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
  async function rpc(method, params = {}) {
    const response = await f.request('/mcp', { method: 'POST', authenticated: false, headers: mcpHeaders, data: { jsonrpc: '2.0', id: 1, method, params } });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(x => x.startsWith('data:')).slice(5) : text);
  }
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, SERVICE_ID);
  assert.equal((await rpc('tools/list')).result.tools.length, 7);
  const listed = await rpc('tools/call', { name: 'memory_list', arguments: { spaceId: snap.spaces[0].id } });
  assert.equal(JSON.parse(listed.result.content[0].text).results[0].body, 'Agent memory');
  assert.equal((await f.request(`/v1/keys/${key.id}`, { method: 'DELETE', headers: sameOrigin })).status, 204);
  assert.equal((await f.request(base, { authenticated: false, headers: bearer })).status, 401);
});

test('real signed OAuth callback provisions stable browser account; external grants cannot manage workspace', async t => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwt = await new SignJWT({ token_use: 'access', client_id: 'test-client', azp: 'test-client', scope: 'openid email memory:read memory:write memory:delete', email: 'sso@example.org', emailVerified: true })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).setIssuer(AUTH_ISSUER).setAudience(PUBLIC_ORIGIN).setSubject('sso-subject').setJti('test-jti')
    .setIssuedAt(NOW / 1000).setExpirationTime(NOW / 1000 + 900).sign(privateKey);
  const f = await fixture(t, { app: { auth: { jwks: async () => publicKey,
    fetch: async () => new Response(JSON.stringify({ access_token: jwt, token_type: 'Bearer' }), { headers: { 'content-type': 'application/json' } }) } } });
  const login = await f.request('/auth/login', { authenticated: false }); assert.equal(login.status, 302);
  const location = new URL(login.headers.get('location'));
  assert.equal(location.origin, AUTH_ISSUER); assert.equal(location.searchParams.get('resource'), PUBLIC_ORIGIN);
  const callback = await f.request(`/auth/callback?code=synthetic&state=${location.searchParams.get('state')}&iss=${encodeURIComponent(AUTH_ISSUER)}`, {
    authenticated: false, headers: { cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(callback.status, 303);
  const sessionCookie = callback.headers.getSetCookie().find(x => x.startsWith(SESSION_COOKIE + '=')).split(';')[0];
  const snap = await (await f.request('/v1/workspace', { headers: { cookie: sessionCookie } })).json();
  assert.equal(snap.account.emails[0].address, 'sso@example.org');
  const external = { authorization: `Bearer ${jwt}` };
  assert.equal((await f.request('/v1/workspace', { authenticated: false, headers: external })).status, 403);
  assert.equal((await f.request('/v1/keys', { method: 'POST', authenticated: false, headers: external, data: { label: 'escalation', permission: 'write', expiresInDays: 90 } })).status, 403);
  const spaces = await (await f.request('/v1/spaces', { authenticated: false, headers: external })).json();
  assert.equal(spaces.results[0].id, snap.spaces[0].id);
  assert.equal((await f.request('/v1/spaces', { method: 'POST', authenticated: false, headers: external, data: { name: 'Escalated workspace' } })).status, 403);
  const dbSession = f.raw.prepare("SELECT reauthenticated_at FROM credentials WHERE account_id=? LIMIT 1").get(snap.account.id);
  assert.equal(dbSession.reauthenticated_at, null);
  const logout = await f.request('/auth/logout', { method: 'POST', headers: { ...sameOrigin, cookie: sessionCookie } }); assert.equal(logout.status, 303);
  assert.equal((await f.request('/v1/workspace', { headers: { cookie: sessionCookie } })).status, 401);
});

test('rate limiting and security headers apply without disclosing identity data', async t => {
  const f = await fixture(t, { app: { limit: async () => ({ success: false }) } });
  const response = await f.request('/v1/workspace'); assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60'); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(await response.json(), { error: 'rate_limited' });
});

test('production configuration rejects injected styles, mail headers and non-HTTPS service origins', () => {
  for (const vars of [{ PRODUCT_ACCENT_COLOR: 'red; background:url(https://evil.example)' }, { PRODUCT_SUPPORT_EMAIL: 'foo@example.org\ncc:evil@example.org' }, { PUBLIC_ORIGIN: 'http://memory.allenlabs.org' }, { PUBLIC_ORIGIN: PUBLIC_ORIGIN + '/path' }]) assert.throws(() => readSettings(vars));
});

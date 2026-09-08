import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parse } from 'jsonc-parser';
import { WorkspaceService } from '../src/workspace.ts';

const config = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'saas-product-integration', modules: true,
  scriptPath: fileURLToPath(new URL('../.local/build/worker.js', import.meta.url)),
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  d1Databases: ['DB'], bindings: config.vars,
  ratelimits: { REQUEST_LIMITER: { namespace_id: '2086090801', simple: { limit: 120, period: 60 } } },
}));
const parser = new DatabaseSync(':memory:');
try {
  const db = await mf.getD1Database('DB');
  for (const file of ['schema.sql', 'memory-schema.sql', 'product-schema.sql', 'auth-schema.sql']) parser.exec(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  for (const row of parser.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').all()) await db.prepare(row.sql).run();
  const baselineLastRow = parser.prepare('SELECT max(rowid) AS id FROM sqlite_master').get().id;
  const workspace = new WorkspaceService(db);
  const principal = subject => ({ issuer: 'https://auth-api.allen.company', subject, email: `${subject}@example.org`, emailVerified: true, permission: 'write', expiresAt: Date.now() + 900000 });
  const owner = await workspace.signIn(principal('owner'));
  const guest = await workspace.signIn(principal('guest'));
  const ownerEmail = await db.prepare('SELECT id FROM account_emails WHERE account_id=?').bind(owner.accountId).first();
  const organization = await workspace.createOrganization(owner.token, { name: 'D1 team', emailId: ownerEmail.id });
  // Apply the forward migration to a populated four-migration D1 database.
  parser.exec(readFileSync(new URL('../migrations/0005_hierarchy-schema.sql', import.meta.url), 'utf8'));
  for (const row of parser.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND rowid>? ORDER BY rowid').all(baselineLastRow)) await db.prepare(row.sql).run();
  assert.equal((await workspace.snapshot(owner.token)).organizations[0].parentId, null);
  const invite = await workspace.createInvite(owner.token, organization.id, { email: 'guest@example.org', role: 'admin' });
  await workspace.acceptInvite(guest.token, invite.token);
  const key = await workspace.issueKey(guest.token, { label: 'D1 integration', organizationId: organization.id, permission: 'write', expiresInDays: 1 });
  const guestSnap = await workspace.snapshot(guest.token);
  const child = await workspace.createOrganization(guest.token, { name: 'Independent child', emailId: guestSnap.account.emails[0].id, parentOrganizationId: organization.id });
  assert.equal((await workspace.snapshot(guest.token)).organizations.find(org => org.id === child.id).parentId, organization.id);
  assert.ok((await workspace.snapshot(owner.token)).organizations.every(org => org.id !== child.id));
  const childKey = await workspace.issueKey(guest.token, { label: 'Independent child key', organizationId: child.id, permission: 'write', expiresInDays: 1 });
  const origin = config.vars.PUBLIC_ORIGIN;
  async function request(path, { method = 'GET', data, token = key.token, headers = {} } = {}) {
    return mf.dispatchFetch(origin + path, { method, redirect: 'manual', headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  }
  assert.equal((await request('/')).status, 200);
  const health = await (await request('/health')).json(); assert.equal(health.status, 'ok');
  const base = `/v1/spaces/${organization.spaceId}/memories`;
  const childBase = `/v1/spaces/${child.spaceId}/memories`;
  assert.equal((await request(childBase, { token: owner.token })).status, 403);
  assert.equal((await request(childBase)).status, 403);
  assert.equal((await request(childBase, { method: 'POST', token: childKey.token, data: { body: 'Child-only memory' } })).status, 201);
  const created = await request(base, { method: 'POST', data: { body: '실제 workerd + D1 검증' } });
  assert.equal(created.status, 201); const memory = await created.json();
  const updated = await request(`${base}/${memory.id}`, { method: 'PATCH', data: { body: 'D1 updated', expectedRevision: 1 } });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).revision, 2);
  assert.equal((await request(`${base}/${memory.id}`, { method: 'PATCH', data: { body: 'stale', expectedRevision: 1 } })).status, 409);
  const mcp = await request('/mcp', { method: 'POST', data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' } });
  assert.equal(mcp.status, 200); assert.match(await mcp.text(), /memory_search/);
  const members = await workspace.listMembers(owner.token, organization.id);
  await workspace.revokeMembership(owner.token, organization.id, members.find(m => m.accountId === guest.accountId).id);
  assert.equal((await request(base)).status, 401);
  assert.equal((await request(childBase, { token: childKey.token })).status, 200);
  assert.equal((await workspace.snapshot(guest.token)).organizations.find(org => org.id === child.id).parentId, null);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM memory_versions').first()).n, 1);
  const authStart = await request('/auth/login'); assert.equal(authStart.status, 302);
  assert.equal(new URL(authStart.headers.get('location')).origin, 'https://auth-api.allen.company');
  console.log('PASS bundled Worker on local workerd/D1: populated forward migration, independent nested organizations, SSO bootstrap, invitation, key issuance, REST revisions, MCP, exact-organization offboarding, OAuth redirect.');
} finally { parser.close(); await mf.dispose(); }

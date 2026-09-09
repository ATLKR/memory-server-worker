import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parse } from 'jsonc-parser';
import { WorkspaceService } from '../src/workspace.ts';
import { MemoryService } from '../src/memory.ts';
import { Jobs } from '../src/release/jobs.ts';
import { applySql } from './apply-sql.mjs';

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
  const original = new MemoryService(db);
  const historical = await original.create(key.token, organization.spaceId, { body: 'Before release migration' });
  await original.update(key.token, organization.spaceId, historical.id, { body: 'Preserved populated revision', expectedRevision: 1 });
  await applySql(parser, db, readFileSync(new URL('../migrations/0006_release-schema.sql', import.meta.url), 'utf8'));
  await applySql(parser, db, readFileSync(new URL('../migrations/0007_maintenance-schema.sql', import.meta.url), 'utf8'));
  for (const name of ['release_ingests_expiry', 'release_exports_expiry', 'release_domains_expiry', 'release_reauth_expiry', 'release_mail_budget_day'])
    assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name=?").bind(name).first()).n, 1);
  assert.equal((await db.prepare('SELECT body FROM memories WHERE id=?').bind(historical.id).first()).body, 'Preserved populated revision');
  assert.equal((await db.prepare('SELECT body FROM memory_versions WHERE memory_id=? AND revision=1').bind(historical.id).first()).body, 'Before release migration');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_fts WHERE memory_id=?').bind(historical.id).first()).n, 1);
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
  const retryData = { body: 'Idempotent native D1', operationId: 'native-create-1' };
  const first = await (await request(base, { method: 'POST', data: retryData })).json();
  const replay = await (await request(base, { method: 'POST', data: retryData })).json();
  assert.equal(first.id, replay.id); assert.equal(replay.replayed, true);
  assert.equal((await request(base, { method: 'POST', data: { ...retryData, body: 'Changed retry' } })).status, 409);
  const search = await request(`${base}?query=Idempotent`);
  assert.equal(search.status, 200); assert.match(await search.text(), /Idempotent native D1/);
  const removed = await request(`${base}/${first.id}`, { method: 'DELETE', data: { expectedRevision: 1, operationId: 'native-delete-1' } });
  assert.equal(removed.status, 204);
  const restored = await request(`${base}/${first.id}/restore`, { method: 'POST', data: { expectedRevision: 2, operationId: 'native-restore-1' } });
  assert.equal(restored.status, 200); assert.equal((await restored.json()).revision, 3);
  assert.equal((await request('/manage')).status, 200);
  const readiness = await request('/ready'); assert.equal(readiness.status, 503); assert.equal((await readiness.json()).checks.schema, true);
  const mcp = await request('/mcp', { method: 'POST', data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' } });
  assert.equal(mcp.status, 200); assert.match(await mcp.text(), /memory_search/);
  const members = await workspace.listMembers(owner.token, organization.id);
  await workspace.revokeMembership(owner.token, organization.id, members.find(m => m.accountId === guest.accountId).id);
  assert.equal((await request(base)).status, 401);
  assert.equal((await request(childBase, { token: childKey.token })).status, 200);
  assert.equal((await workspace.snapshot(guest.token)).organizations.find(org => org.id === child.id).parentId, null);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM memory_versions').first()).n, 4);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  const authStart = await request('/auth/login'); assert.equal(authStart.status, 302);
  assert.equal(new URL(authStart.headers.get('location')).origin, 'https://auth-api.allen.company');

  // Exercise the deployed scheduled handler, including native D1 tuple cleanup
  // and the forward indexes. This database and every identity below are synthetic.
  assert.equal(config.vars.BACKGROUND_JOBS_ENABLED, 'false');
  assert.equal(config.vars.AUTO_ERASURE_ENABLED, 'false');
  const maintenanceAt = Date.now(), expiredAt = maintenanceAt - 60000, liveUntil = maintenanceAt + 600000;
  const personalSpace = (await workspace.snapshot(owner.token)).spaces.find(space => space.organizationId === null);
  assert.ok(personalSpace);
  const oldStore = new MemoryService(db, () => maintenanceAt - 31 * 86400000);
  const retained = await oldStore.create(owner.token, personalSpace.id, { body: 'Personal content beyond the restore window' });
  await oldStore.remove(owner.token, personalSpace.id, retained.id, 1);
  const ownerCredential = await db.prepare("SELECT id FROM credentials WHERE account_id=? AND kind='session' LIMIT 1").bind(owner.accountId).first();
  for (let n = 0; n < 105; n++)
    await db.prepare('INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES(?,?,?,?,?)')
      .bind(`scheduled-expired-${n}`, ownerCredential.id, ownerEmail.id, 'synthetic-proof-digest', expiredAt).run();
  await db.prepare('INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES(?,?,?,?,?)')
    .bind('scheduled-live-proof', ownerCredential.id, ownerEmail.id, 'synthetic-live-digest', liveUntil).run();
  for (const [id, expiry] of [['scheduled-expired-export', expiredAt], ['scheduled-live-export', liveUntil]])
    await db.prepare('INSERT INTO release_export_sessions(id,account_id,space_id,watermark,expires_at,created_at) VALUES(?,?,?,0,?,?)')
      .bind(id, owner.accountId, personalSpace.id, expiry, maintenanceAt - 120000).run();
  await db.prepare('INSERT INTO email_challenges(id,account_id,address,domain,token_digest,expires_at) VALUES(?,?,?,?,?,?)')
    .bind('scheduled-identity-audit', owner.accountId, 'scheduled-audit@example.org', 'example.org', 'd'.repeat(64), expiredAt).run();
  await db.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,available_at,created_at) VALUES('scheduled-source',?,0,'ingest',?,?)")
    .bind(personalSpace.id, expiredAt, expiredAt).run();
  await db.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,ciphertext,proposals,expires_at,created_at) VALUES('scheduled-source',?,?,?,'synthetic-expired-ciphertext','[]',?,?)")
    .bind(owner.accountId, personalSpace.id, ownerCredential.id, expiredAt, expiredAt).run();
  const oldBudgetDay = new Date(maintenanceAt - 2 * 86400000).toISOString().slice(0, 10);
  const futureBudgetDay = new Date(maintenanceAt + 2 * 86400000).toISOString().slice(0, 10);
  for (const day of [oldBudgetDay, futureBudgetDay])
    await db.prepare('INSERT INTO release_mail_budget(account_id,day,quantity) VALUES(?,?,20)').bind(owner.accountId, day).run();
  const preservedTables = ['memories', 'memory_versions', 'memory_audit_events', 'email_challenges', 'email_consumptions', 'release_events', 'release_jobs'];
  const beforeCleanup = new Map();
  for (const table of preservedTables)
    beforeCleanup.set(table, (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results);
  const worker = await mf.getWorker();
  const firstSweep = await worker.scheduled({ cron: config.triggers.crons[0] });
  assert.equal(firstSweep.outcome, 'ok');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_reauth_challenges WHERE expires_at<=?').bind(maintenanceAt).first()).n, 5);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM release_reauth_challenges WHERE id='scheduled-live-proof'").first()).n, 1);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM release_export_sessions WHERE id='scheduled-expired-export'").first()).n, 0);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM release_export_sessions WHERE id='scheduled-live-export'").first()).n, 1);
  assert.deepEqual(await db.prepare("SELECT ciphertext,proposals,state FROM release_ingests WHERE id='scheduled-source'").first(),
    { ciphertext: null, proposals: null, state: 'expired' });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_mail_budget WHERE account_id=? AND day=?').bind(owner.accountId, oldBudgetDay).first()).n, 0);
  assert.equal((await db.prepare('SELECT quantity FROM release_mail_budget WHERE account_id=? AND day=?').bind(owner.accountId, futureBudgetDay).first()).quantity, 20);
  const secondSweep = await worker.scheduled({ cron: config.triggers.crons[0] });
  assert.equal(secondSweep.outcome, 'ok');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_reauth_challenges WHERE expires_at<=?').bind(maintenanceAt).first()).n, 0);
  for (const table of preservedTables)
    assert.deepEqual((await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results, beforeCleanup.get(table), `${table} must survive cleanup unchanged`);
  const heartbeat = await db.prepare("SELECT last_success_at FROM release_heartbeats WHERE name='maintenance'").first();
  assert.ok(heartbeat.last_success_at >= maintenanceAt && heartbeat.last_success_at <= Date.now());
  const afterCleanupReady = await (await request('/ready')).json();
  assert.equal(afterCleanupReady.checks.maintenance, true);
  assert.equal(afterCleanupReady.checks.backgroundJobs, false);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);

  // Management requests use synthetic recently verified sessions. Confirm native
  // D1 counts an idempotent acceptance update and never changes its consent time.
  await db.prepare('UPDATE credentials SET reauthenticated_at=? WHERE id=?').bind(Date.now(), ownerCredential.id).run();
  const shareResponse = await request(`/v1/spaces/${personalSpace.id}/shares`, {
    method: 'POST', token: owner.token, data: { email: 'guest@example.org', days: 7 },
  });
  assert.equal(shareResponse.status, 201); const shared = await shareResponse.json();
  const acceptPath = `/v1/shares/${shared.id}/accept`;
  assert.equal((await request(acceptPath, { method: 'POST', token: guest.token, data: {} })).status, 200);
  const consent = await db.prepare('SELECT accepted_at FROM release_shares WHERE id=?').bind(shared.id).first();
  assert.equal((await request(acceptPath, { method: 'POST', token: guest.token, data: {} })).status, 200);
  assert.equal((await db.prepare('SELECT accepted_at FROM release_shares WHERE id=?').bind(shared.id).first()).accepted_at, consent.accepted_at);
  assert.equal((await request(acceptPath, { method: 'POST', token: owner.token, data: {} })).status, 403);
  assert.equal((await request(`/v1/spaces/${personalSpace.id}/shares/${shared.id}`, { method: 'DELETE', token: owner.token })).status, 204);
  assert.equal((await request(acceptPath, { method: 'POST', token: guest.token, data: {} })).status, 403);

  const scimKeyResponse = await request(`/v1/organizations/${organization.id}/scim-keys`, { method: 'POST', token: owner.token, data: {} });
  assert.equal(scimKeyResponse.status, 201); const scimKey = await scimKeyResponse.json();
  const scimPath = `/scim/v2/${organization.id}/Users`;
  const scimCountResponse = await request(scimPath + '?count=0', { token: scimKey.token });
  assert.equal(scimCountResponse.status, 200); assert.match(scimCountResponse.headers.get('content-type'), /^application\/scim\+json/);
  const scimCount = await scimCountResponse.json();
  assert.equal(scimCount.totalResults, 2); assert.equal(scimCount.itemsPerPage, 0); assert.deepEqual(scimCount.Resources, []);
  const ownerMember = members.find(member => member.accountId === owner.accountId);
  const scimDenied = await request(scimPath + '/' + ownerMember.id, {
    method: 'PATCH', token: scimKey.token, headers: { 'content-type': 'application/scim+json; charset=utf-8' },
    data: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] },
  });
  assert.equal(scimDenied.status, 403); assert.match(scimDenied.headers.get('content-type'), /^application\/scim\+json/);
  const scimError = await scimDenied.json();
  assert.equal(scimError.status, '403'); assert.deepEqual(scimError.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
  assert.equal((await db.prepare('SELECT revoked_at FROM memberships WHERE id=?').bind(ownerMember.id).first()).revoked_at, null);

  // The production cron keeps provider jobs disabled. Exercise lease SQL against
  // this native D1 database directly, with no provider or outbound API calls.
  await db.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,available_at,created_at) VALUES('native-lease-fixture',?,1,'upsert',0,0)").bind(personalSpace.id).run();
  let leaseAt = Date.now();
  const leaseJobs = new Jobs({ DB: db, AI: {}, MEMORY_INDEX: {} }, () => leaseAt);
  const lease = await leaseJobs.claim(); assert.equal(lease.id, 'native-lease-fixture');
  await leaseJobs.renew(lease); // Same timestamp/value still reports one matched D1 row.
  leaseAt += 30000; await leaseJobs.renew(lease);
  const leaseRow = await db.prepare('SELECT lease_until,lease_token FROM release_jobs WHERE id=?').bind(lease.id).first();
  assert.equal(leaseRow.lease_until, leaseAt + 120000); assert.equal(leaseRow.lease_token, lease.leaseToken);
  await db.prepare("UPDATE release_jobs SET lease_token='replacement-worker' WHERE id=?").bind(lease.id).run();
  await assert.rejects(() => leaseJobs.renew(lease), error => error.message === 'lease_lost');
  assert.equal((await db.prepare('SELECT lease_token FROM release_jobs WHERE id=?').bind(lease.id).first()).lease_token, 'replacement-worker');
  leaseAt = leaseRow.lease_until + 1;
  await assert.rejects(() => leaseJobs.renew({ ...lease, leaseToken: 'replacement-worker' }), error => error.message === 'lease_lost');
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  console.log('PASS bundled Worker on local workerd/D1: populated migrations 5-7, bounded scheduled cleanup and preserved personal memories/audit/jobs, maintenance heartbeat, lease fencing/renewal, retryable share consent, SCIM media type/count/owner protection, FTS backfill/search, atomic idempotency, revisions, trash/restore, independent nested organizations, SSO bootstrap, invitations, keys, MCP, offboarding, readiness and integrity.');
} finally { parser.close(); await mf.dispose(); }

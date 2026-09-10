import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { Admin } from '../../src/release/admin.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { requireSpace } from '../../src/release/authority.ts';
import { WorkspaceService } from '../../src/workspace.ts';

const denied = fn => assert.rejects(fn, error => [401, 403].includes(error.status));
const readKey = { label: 'Team reader', organizationId: 'org', capabilities: ['read'], expiresInDays: 1 };

for (const scoped of [false, true]) test('members can issue read-only organization PATs; explicit Space scope=' + scoped, async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const admin = new Admin({ DB: f.db }, () => at), store = new MemoryStore(f.db, () => at);
  const child = await new WorkspaceService(f.db, () => at).createOrganization(f.token,
    { name: 'Child', emailId: 'e1', parentOrganizationId: 'org' });
  const memory = await store.create(f.token, 'so', { body: 'Team knowledge' }, 'seed-team');
  const key = await admin.issueKey(f.other, { ...readKey, ...(scoped ? { spaceIds: ['so'] } : {}) });
  assert.deepEqual(key.capabilities, ['read']);
  assert.deepEqual(key.spaceIds, scoped ? ['so'] : null);
  assert.equal((await store.get(key.token, 'so', memory.id)).body, 'Team knowledge');
  for (const action of ['create', 'update', 'delete', 'export'])
    await denied(() => requireSpace(f.db, key.token, 'so', action, () => at));
  for (const space of ['s1', 's2', child.spaceId])
    await denied(() => requireSpace(f.db, key.token, space, 'read', () => at));
  const binding = f.db.raw.prepare('SELECT membership_id,email_id,kind,permission FROM credentials WHERE id=?').get(key.id);
  assert.deepEqual({ ...binding }, { membership_id: 'm2', email_id: 'e2', kind: 'api_key', permission: 'read' });
});

test('member PAT issuance retains non-read and exact-organization restrictions', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const admin = new Admin({ DB: f.db }, () => at);
  for (const capability of ['create', 'update', 'delete', 'export'])
    await denied(() => admin.issueKey(f.other, { ...readKey, capabilities: ['read', capability] }));
  await denied(() => admin.issueKey(f.other, { ...readKey, organizationId: 'unknown-org' }));
  await denied(() => admin.issueKey(f.other, { ...readKey, spaceIds: ['s2'] }));
  f.db.raw.prepare('UPDATE memberships SET expires_at=? WHERE id=?').run(at, 'm2');
  await denied(() => admin.issueKey(f.other, readKey));
});

test('read-only member PATs retain exact revocation bindings when membership is recreated', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const admin = new Admin({ DB: f.db }, () => at);
  const key = await admin.issueKey(f.other, { ...readKey, spaceIds: ['so'] });
  f.db.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE id=?').run(at, 'e2');
  await denied(() => requireSpace(f.db, key.token, 'so', 'read', () => at));
  f.db.raw.prepare('INSERT INTO account_emails(id,account_id,address,domain,verified_at) VALUES(?,?,?,?,?)')
    .run('e2-new', 'bob', 'bob@example.com', 'example.com', at);
  f.db.raw.prepare('INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES(?,?,?,?,?)')
    .run('m2-new', 'org', 'bob', 'e2-new', 'member');
  await denied(() => requireSpace(f.db, key.token, 'so', 'read', () => at));
  assert.equal(f.db.raw.prepare('SELECT revoked_at FROM credentials WHERE id=?').get(key.id).revoked_at, at);
});

test('member PAT issuance rechecks membership in the credential insertion', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const admin = new Admin({ DB: f.db }, () => at), batch = f.db.batch.bind(f.db);
  let raced = false;
  f.db.batch = async statements => {
    raced = true;
    f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at, 'm2');
    return batch(statements);
  };
  await denied(() => admin.issueKey(f.other, { ...readKey, spaceIds: ['so'] }));
  assert.equal(raced, true);
  assert.equal(f.db.raw.prepare("SELECT count(*) AS n FROM credentials WHERE kind='api_key'").get().n, 0);
});

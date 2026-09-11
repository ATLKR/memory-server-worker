import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { Admin } from '../../src/release/admin.ts';
import { Transfers } from '../../src/release/transfer.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { requireSpace } from '../../src/release/authority.ts';

const denied = fn => assert.rejects(fn, error => [401, 403].includes(error.status));
const readKey = { label: 'Shared knowledge reader', capabilities: ['read'], spaceIds: ['so'], expiresInDays: 1 };

async function sharingFixture(t) {
  const f = await fixture(); t.after(() => f.db.close());
  f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at, 'm2');
  return { ...f, admin: new Admin({ DB: f.db }, () => at), transfers: new Transfers(f.db, () => at) };
}

test('personal read PATs may select an accepted organization Space share without organization membership', async t => {
  const f = await sharingFixture(t), store = new MemoryStore(f.db, () => at);
  const share = await f.transfers.share(f.token, 'so', 'bob@example.com');
  await f.transfers.accept(f.other, share.id);
  const memory = await store.create(f.token, 'so', { body: 'Shared team knowledge' }, 'shared-team-seed');
  for (const spaceIds of [['so'], ['s2', 'so']]) {
    const key = await f.admin.issueKey(f.other, { ...readKey, spaceIds });
    assert.equal((await store.get(key.token, 'so', memory.id)).body, 'Shared team knowledge');
    assert.deepEqual(key.spaceIds, spaceIds);
    const credential = f.db.raw.prepare('SELECT kind,membership_id,email_id FROM credentials WHERE id=?').get(key.id);
    assert.deepEqual({ ...credential }, { kind: 'personal_key', membership_id: null, email_id: null });
    await denied(() => requireSpace(f.db, key.token, 's1', 'read', () => at));
    for (const action of ['create', 'update', 'delete', 'export'])
      await denied(() => requireSpace(f.db, key.token, 'so', action, () => at));
  }
  await denied(() => f.admin.issueKey(f.other, { ...readKey, organizationId: 'org' }));
});

test('organization membership alone never gives personal PATs organization authority', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const admin = new Admin({ DB: f.db }, () => at);
  await denied(() => admin.issueKey(f.other, readKey));
  const key = await admin.issueKey(f.other, { ...readKey, spaceIds: undefined });
  await denied(() => requireSpace(f.db, key.token, 'so', 'read', () => at));
});

test('personal PAT scope selection requires accepted live sharing and read-only capability', async t => {
  const f = await sharingFixture(t);
  const share = await f.transfers.share(f.token, 'so', 'bob@example.com');
  await denied(() => f.admin.issueKey(f.other, readKey));
  await f.transfers.accept(f.other, share.id);
  for (const capability of ['create', 'update', 'delete', 'export'])
    await denied(() => f.admin.issueKey(f.other, { ...readKey, capabilities: ['read', capability] }));
  await f.transfers.revoke(f.token, 'so', share.id);
  await denied(() => f.admin.issueKey(f.other, readKey));
});

for (const revocation of ['share', 'grantor', 'recipient', 'expired']) test('scoped shared-Space PAT rechecks effective sharing after ' + revocation, async t => {
  const f = await sharingFixture(t);
  const share = await f.transfers.share(f.token, 'so', 'bob@example.com', 1);
  await f.transfers.accept(f.other, share.id);
  const key = await f.admin.issueKey(f.other, { ...readKey, expiresInDays: 2 });
  await requireSpace(f.db, key.token, 'so', 'read', () => at);
  let now = at;
  if (revocation === 'share') await f.transfers.revoke(f.token, 'so', share.id);
  if (revocation === 'grantor') f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at, 'm1');
  if (revocation === 'recipient') f.db.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE id=?').run(at, 'e2');
  if (revocation === 'expired') now += 86400000;
  await denied(() => requireSpace(f.db, key.token, 'so', 'read', () => now));
});

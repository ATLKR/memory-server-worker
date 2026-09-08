import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, seedCredential, NOW } from './helpers.mjs';
import { MemoryService, MemoryDenied, MemoryInvalid } from '../src/memory.ts';

test('listing paginates tied timestamps and never includes tombstones or another Space', async t => {
  const f = await createFixture({ memory: true }); t.after(f.close);
  const m = new MemoryService(f.db, f.clock);
  const space = await m.createSpace(f.tokens.alice, { name: 'Personal' });
  const other = await m.createSpace(f.tokens.alice, { name: 'Other' });
  const items = [];
  for (let i = 0; i < 5; i++) items.push(await m.create(f.tokens.alice, space.id, { body: `memory ${i}` }));
  await m.create(f.tokens.alice, other.id, { body: 'Other secret' });
  await m.remove(f.tokens.alice, space.id, items[0].id, 1);
  const first = await m.list(f.tokens.alice, space.id, { limit: 2 });
  assert.equal(first.results.length, 2); assert.ok(first.nextCursor);
  const second = await m.list(f.tokens.alice, space.id, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.results.length, 2); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.results, ...second.results].map(x => x.id)).size, 4);
  await assert.rejects(m.list(f.tokens.bob, space.id), MemoryDenied);
  await assert.rejects(m.list(f.tokens.alice, space.id, { cursor: 'invalid' }), MemoryInvalid);
  f.raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(NOW, 's-alice');
  await assert.rejects(m.list(f.tokens.alice, space.id, { cursor: first.nextCursor }), MemoryDenied);
});

test('personal API keys access only personal Spaces and obey read-only permission', async t => {
  const f = await createFixture({ memory: true }); t.after(f.close);
  const m = new MemoryService(f.db, f.clock);
  const personal = await m.createSpace(f.tokens.alice, { name: 'Personal' });
  const org = await m.createSpace(f.tokens.alice, { name: 'Organization', organizationId: 'org-one' });
  const key = 'personal-key-synthetic-000000000000000000000';
  await seedCredential(f.raw, { id: 'personal-key', accountId: 'alice', kind: 'personal_key', token: key, permission: 'read' });
  assert.deepEqual((await m.list(key, personal.id)).results, []);
  await assert.rejects(m.list(key, org.id), MemoryDenied);
  await assert.rejects(f.service.authorizeOrganization(key, 'org-one'));
  assert.deepEqual((await m.listSpaces(key)).map(s => s.id), [personal.id]);
  await assert.rejects(m.create(key, personal.id, { body: 'Denied write' }), MemoryDenied);
});

test('write API keys cannot administer Spaces', async t => {
  const f = await createFixture({ memory: true }); t.after(f.close);
  const m = new MemoryService(f.db, f.clock);
  const key = 'synthetic-personal-write-key-000000000000000';
  await seedCredential(f.raw, { id: 'personal-write', accountId: 'alice', kind: 'personal_key', token: key });
  await assert.rejects(m.createSpace(key, { name: 'Escalated personal' }), MemoryDenied);
  await assert.rejects(m.createSpace(f.tokens.key, { name: 'Escalated org', organizationId: 'org-one' }), MemoryDenied);
});

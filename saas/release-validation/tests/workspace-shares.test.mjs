import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { createApplication } from '../../src/app.ts';
import { createRelease } from '../../src/release/extension.ts';
import { readSettings } from '../../src/config.ts';
import { Transfers } from '../../src/release/transfer.ts';

for (const source of ['personal', 'organization']) test(`workspace exposes accepted ${source} shares read-only and removes revoked shares`, async t => {
  const { db, token, other } = await fixture(); t.after(() => db.close());
  db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m2'").run(at);
  const spaceId = source === 'personal' ? 's1' : 'so';
  db.raw.prepare('INSERT INTO spaces VALUES(?,?,?,?,?,?,?)').run('other-org-space', 'Unshared organization Space', null, 'org', 'managed', at, 'session:alice');
  const env = { DB: db }, settings = readSettings({});
  const app = createApplication(db, settings, { clock: () => at, release: createRelease(env, { clock: () => at }) });
  const snapshot = async () => {
    const response = await app(new Request(settings.origin + '/v1/workspace', { headers: { authorization: 'Bearer ' + other } }));
    assert.equal(response.status, 200); return response.json();
  };
  const transfers = new Transfers(db, () => at);
  const invitation = await transfers.share(token, spaceId, 'bob@example.com', 1);
  assert.ok(!(await snapshot()).spaces.some(space => space.id === spaceId));
  await transfers.accept(other, invitation.id);
  const shared = (await snapshot()).spaces.find(space => space.id === spaceId);
  assert.ok(shared, 'The original editor consumes this snapshot for its sidebar');
  assert.equal(shared.canWrite, false);
  assert.equal(shared.organizationId, source === 'personal' ? null : 'org');
  assert.ok(!(await snapshot()).spaces.some(space => space.id === 'other-org-space'));
  await transfers.revoke(token, spaceId, invitation.id);
  assert.ok(!(await snapshot()).spaces.some(space => space.id === spaceId));
});

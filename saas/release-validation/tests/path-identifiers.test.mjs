import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { createApplication } from '../../src/app.ts';
import { createRelease } from '../../src/release/extension.ts';
import { readSettings } from '../../src/config.ts';
import { Admin } from '../../src/release/admin.ts';
import { MemoryStore } from '../../src/release/memory.ts';

async function setup(t) {
  const f = await fixture(); t.after(() => f.db.close());
  const settings = readSettings({}), env = { DB: f.db, BACKGROUND_JOBS_ENABLED: 'true' };
  const app = createApplication(f.db, settings, { clock: () => at, release: createRelease(env, { clock: () => at }) });
  const request = (path, method = 'GET', token = f.token) => app(new Request(settings.origin + path,
    { method, headers: { authorization: 'Bearer ' + token } }));
  return { ...f, env, request };
}

test('percent-encoded PAT IDs emitted by both consoles revoke the actual credential', async t => {
  const f = await setup(t);
  const issued = await new Admin(f.env, () => at).issueKey(f.token,
    { label: 'Encoded revocation', capabilities: ['read'], spaceIds: ['s1'], expiresInDays: 1 });
  assert.ok(issued.id.startsWith('key:'));
  assert.equal((await f.request('/v1/spaces/s1/memories', 'GET', issued.token)).status, 200);
  assert.equal((await f.request('/v1/keys/' + encodeURIComponent(issued.id), 'DELETE')).status, 204);
  assert.equal(f.db.raw.prepare('SELECT revoked_at FROM credentials WHERE id=?').get(issued.id).revoked_at, at);
  assert.equal((await f.request('/v1/spaces/s1/memories', 'GET', issued.token)).status, 401);
});

test('percent-encoded revision job IDs can be explicitly retried without resetting progress', async t => {
  const f = await setup(t);
  const memory = await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'Retry this index' }, 'path-job');
  const jobId = memory.id + ':1';
  f.db.raw.prepare("UPDATE release_jobs SET state='dead',attempt=5,next_chunk=1 WHERE id=?").run(jobId);
  assert.equal((await f.request('/v1/spaces/s1/jobs/' + encodeURIComponent(jobId) + '/retry', 'POST')).status, 202);
  assert.deepEqual({ ...f.db.raw.prepare('SELECT state,attempt,next_chunk FROM release_jobs WHERE id=?').get(jobId) },
    { state: 'pending', attempt: 0, next_chunk: 1 });
});

test('identifier decoding is one pass, preserves segment boundaries and rejects malformed escapes', async t => {
  const f = await setup(t);
  assert.equal((await f.request('/v1/spaces/%73%31/memories')).status, 200);
  for (const value of ['bad%', '%FF', 'key%253Atest', 'key%2Ftest', 'key%5Ctest', '%00']) {
    assert.equal((await f.request('/v1/keys/' + value, 'DELETE')).status, 400, value);
    assert.equal((await f.request('/v1/spaces/' + value + '/memories')).status, 400, value);
  }
});

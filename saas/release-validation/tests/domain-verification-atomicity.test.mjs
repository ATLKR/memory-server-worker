import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { Admin } from '../../src/release/admin.ts';
import { createApplication } from '../../src/app.ts';
import { createRelease } from '../../src/release/extension.ts';
import { readSettings, PUBLIC_ORIGIN } from '../../src/config.ts';

async function setup(t, boundary) {
  let now = at, challenge, delayed = false, dnsCalls = 0;
  const f = await fixture({ clock: () => now }); t.after(() => f.db.close());
  const env = { DB: f.db, REQUEST_LIMITER: { limit: async () => ({ success: true }) },
    fetch: async () => { dnsCalls++; return Response.json({ Status: 0, Answer: [{ name: challenge.name, type: 16, data: JSON.stringify(challenge.value) }] }); } };
  challenge = await new Admin(env, () => now).beginDomain(f.token, 'org', 'atomicity.example');
  now = challenge.expiresAt - 1;
  f.db.raw.prepare("UPDATE credentials SET expires_at=?,reauthenticated_at=? WHERE id='session:alice'").run(now + 900000, now);
  // Delay a separate dependent statement, if the implementation has one. An
  // atomic trigger has no such second statement to delay after consuming proof.
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    const statement = prepare(sql);
    if (boundary && sql.startsWith(boundary)) {
      const all = statement.all.bind(statement);
      statement.all = async () => { if (!delayed) { delayed = true; now += 2; } return all(); };
    }
    return statement;
  };
  const app = createApplication(f.db, readSettings(env), { clock: () => now, release: createRelease(env, { clock: () => now }) });
  const request = (token = f.token, challengeId = challenge.id) => app(new Request(PUBLIC_ORIGIN + '/v1/domains/verify', { method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ challengeId }) }));
  const renew = next => { now = next; f.db.raw.prepare("UPDATE credentials SET expires_at=?,reauthenticated_at=? WHERE id='session:alice'").run(now + 900000, now); };
  return { ...f, challenge, request, renew, env, clock: () => now, setNow: value => { now = value; }, dnsCalls: () => dnsCalls };
}

for (const boundary of [null, 'INSERT INTO domains', 'INSERT INTO domain_managers'])
  test('domain verification either persists its complete result or leaves the proof unconsumed: ' + (boundary ?? 'ordinary success'), async t => {
    const f = await setup(t, boundary), response = await f.request(), body = await response.json();
    const proof = f.db.raw.prepare('SELECT used_at,verification_id FROM release_domain_challenges WHERE id=?').get(f.challenge.id);
    const domains = f.db.raw.prepare("SELECT * FROM domains WHERE name='atomicity.example'").all();
    const managers = f.db.raw.prepare('SELECT * FROM domain_managers').all();
    if (response.status === 200) {
      assert.equal(domains.length, 1, '200 must identify a persisted domain');
      assert.equal(domains[0].id, body.id); assert.equal(domains[0].verified_until, body.verifiedUntil);
      assert.equal(domains[0].organization_id, 'org'); assert.equal(domains[0].revoked_at, null);
      assert.deepEqual(managers.map(row => ({ ...row })), [{ domain_id: body.id, membership_id: 'm1', revoked_at: null }], '200 must include the exact live manager assignment');
      assert.notEqual(proof.used_at, null); assert.notEqual(proof.verification_id, null);
    } else {
      assert.equal(response.status, 403);
      assert.deepEqual({ ...proof }, { used_at: null, verification_id: null }, 'a failed transaction must not burn the DNS proof');
      assert.equal(domains.length, 0); assert.equal(managers.length, 0);
    }
  });

test('a lost verification response resolves its exact accepted result after DNS proof expiry', async t => {
  const f = await setup(t), first = await f.request(), result = await first.json(); assert.equal(first.status, 200);
  f.renew(f.challenge.expiresAt + 1000);
  const dnsBefore = f.dnsCalls();
  const replay = await f.request(); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), result);
  assert.equal(f.dnsCalls(), dnsBefore, 'accepted verification must not re-run DNS');
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_domain_verifications').get().n, 1);
});

test('concurrent verification requests converge on one receipt and exact manager assignment', async t => {
  const f = await setup(t), responses = await Promise.all([f.request(), f.request(), f.request()]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[0], results[2]);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_domain_verifications').get().n, 1);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM domain_managers').get().n, 1);
});

test('expiry at the atomic command boundary consumes no proof and persists no partial verification', async t => {
  const f = await setup(t), prepare = f.db.prepare.bind(f.db); let fired = false;
  f.db.prepare = sql => { const statement = prepare(sql); if (sql.includes('/* domain-verification-command */')) {
    const run = statement.run.bind(statement); statement.run = async () => { fired = true; f.setNow(f.challenge.expiresAt); return run(); };
  } return statement; };
  assert.equal((await f.request()).status, 403); assert.equal(fired, true);
  for (const table of ['domains', 'domain_managers', 'release_domain_verifications']) assert.equal(f.db.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.db.raw.prepare('SELECT used_at FROM release_domain_challenges WHERE id=?').get(f.challenge.id).used_at, null);
});

test('an unrelated manager insert failure rolls back the complete verification and leaves the proof retryable', async t => {
  const f = await setup(t);
  f.db.raw.exec("CREATE TRIGGER fail_verification_manager BEFORE INSERT ON domain_managers BEGIN SELECT RAISE(ABORT,'synthetic unrelated database failure'); END;");
  assert.equal((await f.request()).status, 500);
  for (const table of ['domains', 'domain_managers', 'release_domain_verifications']) assert.equal(f.db.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.db.raw.prepare('SELECT used_at FROM release_domain_challenges WHERE id=?').get(f.challenge.id).used_at, null);
  f.db.raw.exec('DROP TRIGGER fail_verification_manager'); assert.equal((await f.request()).status, 200);
});

for (const [label, invalidate] of [
  ['revoked manager', f => f.db.raw.exec("UPDATE domain_managers SET revoked_at=1 WHERE membership_id='m1'")],
  ['revoked membership', f => f.db.raw.exec("UPDATE memberships SET revoked_at=1 WHERE id='m1'")],
  ['demoted membership', f => f.db.raw.exec("UPDATE memberships SET role='member' WHERE id='m1'")],
  ['expired recent proof', f => f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(f.clock() - 300001)],
]) test('accepted verification replay cannot bypass ' + label, async t => {
  const f = await setup(t); assert.equal((await f.request()).status, 200);
  const before = f.db.raw.prepare('SELECT * FROM release_domain_verifications').all(); invalidate(f);
  assert.equal((await f.request()).status, 403); assert.deepEqual(f.db.raw.prepare('SELECT * FROM release_domain_verifications').all(), before);
});

test('accepted verification cannot be claimed by another account', async t => {
  const f = await setup(t); assert.equal((await f.request()).status, 200);
  f.db.raw.prepare("UPDATE credentials SET expires_at=?,reauthenticated_at=? WHERE id='session:bob'").run(f.clock() + 900000, f.clock());
  assert.equal((await f.request(f.other)).status, 403);
});

test('verification receipts reject update, delete and replacement', async t => {
  const f = await setup(t); assert.equal((await f.request()).status, 200);
  for (const sql of ['UPDATE release_domain_verifications SET verified_until=verified_until+1', 'DELETE FROM release_domain_verifications', 'INSERT OR REPLACE INTO release_domain_verifications SELECT * FROM release_domain_verifications'])
    assert.throws(() => f.db.raw.exec(sql), /immutable/);
});

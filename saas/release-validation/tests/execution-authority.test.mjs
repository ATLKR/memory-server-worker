import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { authority, params, recentSql } from '../../src/release/authority.ts';
import { SQL_NOW_MS, sqlNow } from '../../src/sql-clock.ts';
import { Admin } from '../../src/release/admin.ts';
import { createRelease } from '../../src/release/extension.ts';
import { digest } from '../../src/release/util.ts';

for (const expiry of ['credential', 'membership', 'proof']) test('queued SQL rejects expired ' + expiry + ' with bound application time unchanged', async () => {
  let now = at;
  const { db, token } = await fixture({ clock: () => now });
  try {
    const hash = await digest(token);
    if (expiry === 'credential') db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at + 1);
    if (expiry === 'membership') db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at + 1);
    if (expiry === 'proof') db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at - 300000 + 1);
    const space = expiry === 'membership' ? 'so' : 's1';
    db.raw.exec('CREATE TABLE queued_admissions(id TEXT PRIMARY KEY)');
    const statement = db.prepare(`INSERT INTO queued_admissions SELECT c.id FROM spaces s CROSS JOIN active_credentials c
      WHERE s.id=? AND ${authority('update')} ${expiry === 'proof' ? 'AND ' + recentSql() : ''}`)
      .bind(space, ...params(hash, at, 'update'), ...(expiry === 'proof' ? [at - 300000, at] : []));
    now = at + 2;
    assert.equal((await statement.run()).meta.changes, 0);
    assert.equal(db.raw.prepare('SELECT count(*) AS n FROM queued_admissions').get().n, 0);
  } finally { db.close(); }
});

function queueBeforeRun(db, matches, advance) {
  const prepare = db.prepare.bind(db);
  let observed = false;
  db.prepare = sql => {
    const statement = prepare(sql);
    if (matches(sql)) {
      const run = statement.run.bind(statement);
      statement.run = async () => { if (!observed) { observed = true; advance(); } return run(); };
    }
    return statement;
  };
  return () => observed;
}

for (const expiry of ['credential', 'membership']) test('SCIM-key revocation cannot cross queued ' + expiry + ' expiry', async () => {
  let now = at;
  const { db, token } = await fixture({ clock: () => now });
  try {
    const env = { DB: db };
    const key = await new Admin(env, () => at).issueScimKey(token, 'org');
    db.raw.prepare(expiry === 'credential'
      ? "UPDATE credentials SET expires_at=? WHERE id='session:alice'"
      : "UPDATE memberships SET expires_at=? WHERE id='m1'").run(at + 1);
    const observed = queueBeforeRun(db, sql => sql.startsWith('UPDATE release_scim_keys SET revoked_at='), () => { now = at + 2; });
    const response = await createRelease(env, { clock: () => at }).route(new Request('https://memory.allenlabs.org/v1/organizations/org/scim-keys/' + key.id, { method: 'DELETE' }), token);
    assert.equal(observed(), true);
    assert.equal(response.status, 403);
    assert.equal(db.raw.prepare('SELECT revoked_at FROM release_scim_keys WHERE id=?').get(key.id).revoked_at, null);
  } finally { db.close(); }
});

test('OAuth policy registration cannot materialize an already expired credential after queuing', async () => {
  let now = at;
  const { db } = await fixture({ clock: () => now });
  try {
    const token = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ scope: 'memory:read' })).toString('base64url') + '.synthetic-not-a-public-jwt';
    db.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,permission) VALUES('oauth:fixture','alice','session',?,?,'read')").run(await digest(token), at + 1);
    const observed = queueBeforeRun(db, sql => sql.startsWith('INSERT INTO release_credential_policies'), () => { now = at + 2; });
    // The app's verified-JWT hook is isolated here; public JWT verification has
    // separate HTTP/native coverage and is not bypassed by any public route.
    await createRelease({ DB: db }, { clock: () => at }).signedIn({}, { token }, true);
    assert.equal(observed(), true);
    assert.equal(db.raw.prepare("SELECT count(*) AS n FROM release_credential_policies WHERE credential_id='oauth:fixture'").get().n, 0);
  } finally { db.close(); }
});

test('manual retry leaves an ingest dead when its source deadline passes in the SQL queue', async () => {
  let now = at;
  const { db, token } = await fixture({ clock: () => now });
  try {
    db.raw.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,state,attempt,available_at,created_at) VALUES('queued-retry','s1',0,'ingest','dead',5,?,?)").run(at, at);
    db.raw.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,ciphertext,proposals,state,expires_at,created_at) VALUES('queued-retry','alice','s1','session:alice','synthetic-source','[]','queued',?,?)").run(at + 1, at);
    const observed = queueBeforeRun(db, sql => sql.startsWith("UPDATE release_jobs SET state='pending',attempt=0"), () => { now = at + 2; });
    const response = await createRelease({ DB: db }, { clock: () => at }).route(new Request('https://memory.allenlabs.org/v1/spaces/s1/jobs/queued-retry/retry', { method: 'POST' }), token);
    assert.equal(observed(), true);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'job_not_retryable' });
    assert.deepEqual({ ...db.raw.prepare("SELECT state,attempt FROM release_jobs WHERE id='queued-retry'").get() }, { state: 'dead', attempt: 5 });
  } finally { db.close(); }
});

test('SQL clock advances after binding and conservatively retains an application clock ahead of D1', async () => {
  let now = at;
  const { db } = await fixture({ clock: () => now });
  try {
    const statement = db.prepare(`SELECT ${SQL_NOW_MS} AS databaseNow,${sqlNow()} AS checkedAt`).bind(at + 100);
    now = at + 50;
    assert.deepEqual({ ...await statement.first() }, { databaseNow: at + 50, checkedAt: at + 100 });
    now = at + 200;
    assert.deepEqual({ ...await statement.first() }, { databaseNow: at + 200, checkedAt: at + 200 });
    assert.equal(db.raw.prepare("SELECT unixepoch('1970-01-01T00:00:01Z') AS value").get().value, 1);
    assert.equal(db.raw.prepare("SELECT unixepoch('1970-01-01T00:00:01Z', '+1 second') AS value").get().value, 2);
  } finally { db.close(); }
});

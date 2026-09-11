import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { Admin } from '../../src/release/admin.ts';
import { Jobs } from '../../src/release/jobs.ts';

test('bounded cleanup skips retained consumed DNS proofs and keeps authorized receipt replay intact', async t => {
  const { db, token, other } = await fixture(); t.after(() => db.close());
  let proof;
  const env = { DB: db, fetch: async () => Response.json({ Status: 0,
    Answer: [{ name: proof.name, type: 16, data: JSON.stringify(proof.value) }] }) };
  const admin = new Admin(env, () => at), retained = [];
  // A backlog larger than the cleanup page consists of actual successful
  // commands, including immutable receipts, rather than unreferenced mock rows.
  for (let n = 0; n < 101; n++) {
    proof = await admin.beginDomain(token, 'org', 'retention.example');
    const result = await admin.verifyDomain(token, proof.id); retained.push({ id: proof.id, result });
  }
  db.raw.prepare('UPDATE release_domain_challenges SET expires_at=? WHERE used_at IS NOT NULL').run(at - 1000);
  const insert = db.raw.prepare(`INSERT INTO release_domain_challenges
    (id,organization_id,actor_account_id,domain,proof,expires_at,used_at,verification_id)
    VALUES(?,'org','alice','retention.example','synthetic',?,?,?)`);
  for (let n = 0; n < 3; n++) insert.run('legacy-' + n, at - 2000, at - 3000, 'legacy-receipt-' + n);
  for (let n = 0; n < 105; n++) insert.run('unused-' + String(n).padStart(3, '0'), at - 1, null, null);
  insert.run('live-unused', at + 1, null, null);
  db.raw.prepare("INSERT INTO release_export_sessions VALUES('expired-export','alice','s1',0,?,?)").run(at - 1, at - 1000);
  db.raw.prepare("INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES('expired-reauth','session:alice','e1','synthetic',?)").run(at - 1);
  const snapshots = ['release_domain_verifications', 'domains', 'domain_managers'].map(table => [table, db.raw.prepare('SELECT * FROM ' + table).all()]);
  const consumed = db.raw.prepare('SELECT * FROM release_domain_challenges WHERE used_at IS NOT NULL ORDER BY id').all();
  const prepare = db.prepare.bind(db), cleanupPlans = [];
  db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('DELETE FROM release_domain_challenges')) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => { cleanupPlans.push(db.raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...values).map(row => row.detail).join('\n')); return bind(...values); };
    }
    return statement;
  };
  const jobs = new Jobs(env, () => at); await jobs.maintain();
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_domain_challenges WHERE used_at IS NULL AND expires_at<=?').get(at).n, 5);
  assert.deepEqual(db.raw.prepare('SELECT * FROM release_domain_challenges WHERE used_at IS NOT NULL ORDER BY id').all(), consumed);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_export_sessions').get().n, 0);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_reauth_challenges').get().n, 0);
  await jobs.maintain();
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_domain_challenges WHERE used_at IS NULL AND expires_at<=?').get(at).n, 0);
  assert.ok(db.raw.prepare("SELECT id FROM release_domain_challenges WHERE id='live-unused'").get());
  for (const [table, before] of snapshots) assert.deepEqual(db.raw.prepare('SELECT * FROM ' + table).all(), before, table + ' remains intact');
  for (const { id, result } of [retained[0], retained.at(-1)]) assert.deepEqual(await admin.verifyDomain(token, id), result);
  await assert.rejects(() => admin.verifyDomain(other, retained[0].id), error => error.status === 403);
  db.raw.prepare("UPDATE domain_managers SET revoked_at=? WHERE membership_id='m1'").run(at);
  await assert.rejects(() => admin.verifyDomain(token, retained[0].id), error => error.status === 403);
  assert.equal(cleanupPlans.length, 2, 'Both maintenance passes reached the domain cleanup');
  for (const plan of cleanupPlans) {
    assert.match(plan, /SEARCH release_domain_challenges USING INDEX release_domains_pending_expiry \(expires_at</);
    assert.doesNotMatch(plan, /SCAN release_domain_challenges|USE TEMP B-TREE/);
  }
});

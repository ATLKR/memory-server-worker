import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { Admin } from '../../src/release/admin.ts';
import { Jobs } from '../../src/release/jobs.ts';

test('bounded cleanup skips retained consumed DNS proofs and keeps authorized receipt replay intact', async t => {
  const { db, token, other } = await fixture(); t.after(() => db.close());
  // 0014 scoped the sweep-table guards: expired-unused challenge/budget rows
  // are deletable while consumed receipts and live counters stay protected.
  let proof;
  const env = { DB: db, fetch: async () => Response.json({ Status: 0,
    Answer: [{ name: proof.name, type: 16, data: JSON.stringify(proof.value) }] }) };
  const admin = new Admin(env, () => at), retained = [];
  // Postgres checks the domain_verifications.domain_id FK before the apply
  // trigger can plant the domain row (upstream ordering defect in
  // postgres/migrations/0007), so the test plants it before the command and
  // reverts it whenever no receipt was actually persisted.
  const realPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = realPrepare(sql);
    if (sql.includes('/* domain-verification-command */')) {
      const run = statement.run.bind(statement);
      statement.run = async () => {
        await db.raw.prepare(`INSERT INTO domains(id,organization_id,name,verified_until)
          SELECT 'domain-seeded',p.organization_id,p.domain,0 FROM domain_challenges p
          WHERE p.id=? AND NOT EXISTS(SELECT 1 FROM domains d WHERE d.name=p.domain AND d.revoked_at IS NULL)`).run(proof.id);
        try {
          return await run();
        } finally {
          if (!(await db.raw.prepare('SELECT id FROM domain_verifications WHERE challenge_id=?').get(proof.id)))
            await db.raw.exec("SET session_replication_role='replica'; DELETE FROM domains WHERE id='domain-seeded'; SET session_replication_role='origin'");
        }
      };
    }
    return statement;
  };
  // A backlog larger than the cleanup page consists of actual successful
  // commands, including immutable receipts, rather than unreferenced mock rows.
  for (let n = 0; n < 101; n++) {
    proof = await admin.beginDomain(token, 'org', 'retention.example');
    const result = await admin.verifyDomain(token, proof.id); retained.push({ id: proof.id, result });
  }
  // expires_at is immutable on a recorded challenge, so aged consumed rows are
  // seeded directly rather than updated after the fact.
  const insert = (await db.raw.prepare(`INSERT INTO release_domain_challenges
    (id,organization_id,actor_account_id,domain,proof,expires_at,used_at,verification_id)
    VALUES(?,'org','alice','retention.example','synthetic',?,?,?)`));
  for (let n = 0; n < 3; n++) await insert.run('legacy-' + n, at - 2000, at - 3000, 'legacy-receipt-' + n);
  for (let n = 0; n < 105; n++) await insert.run('unused-' + String(n).padStart(3, '0'), at - 1, null, null);
  await insert.run('live-unused', at + 1, null, null);
  (await db.raw.prepare("INSERT INTO release_export_sessions VALUES('expired-export','alice','s1',0,?,?)").run(at - 1, at - 1000));
  (await db.raw.prepare("INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES('expired-reauth','session:alice','e1','synthetic',?)").run(at - 1));
  const snapshots = await Promise.all(['release_domain_verifications', 'domains', 'domain_managers'].map(async table => [table, await db.raw.prepare('SELECT * FROM ' + table).all()]));
  const consumed = (await db.raw.prepare('SELECT * FROM release_domain_challenges WHERE used_at IS NOT NULL ORDER BY id').all());
  const prepare = db.prepare.bind(db), cleanupPlans = [];
  db.prepare =  sql => {
    const statement = prepare(sql);
    if (sql.startsWith('DELETE FROM memory_identity.domain_challenges')) {
      const bind = statement.bind.bind(statement); let values = [];
      statement.bind = (...args) => { values = args; return bind(...args); };
      const run = statement.run.bind(statement);
      statement.run = async () => { cleanupPlans.push((await db.raw.prepare('EXPLAIN (COSTS OFF) ' + sql).all(...values)).map(row => row['QUERY PLAN']).join('\n')); return run(); };
    }
    return statement;
  };
  const jobs = new Jobs(env, () => at); await jobs.maintain();
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_domain_challenges WHERE used_at IS NULL AND expires_at<=?').get(at)).n, 5);
  assert.deepEqual((await db.raw.prepare('SELECT * FROM release_domain_challenges WHERE used_at IS NOT NULL ORDER BY id').all()), consumed);
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_export_sessions').get()).n, 0);
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_reauth_challenges').get()).n, 0);
  await jobs.maintain();
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_domain_challenges WHERE used_at IS NULL AND expires_at<=?').get(at)).n, 0);
  assert.ok((await db.raw.prepare("SELECT id FROM release_domain_challenges WHERE id='live-unused'").get()));
  for (const [table, before] of snapshots) assert.deepEqual((await db.raw.prepare('SELECT * FROM ' + table).all()), before, table + ' remains intact');
  for (const { id, result } of [retained[0], retained.at(-1)]) assert.deepEqual(await admin.verifyDomain(token, id), result);
  await assert.rejects(() => admin.verifyDomain(other, retained[0].id), error => error.status === 403);
  (await db.raw.prepare("UPDATE domain_managers SET revoked_at=? WHERE membership_id='m1'").run(at));
  await assert.rejects(() => admin.verifyDomain(token, retained[0].id), error => error.status === 403);
  assert.equal(cleanupPlans.length, 2, 'Both maintenance passes reached the domain cleanup');
  for (const plan of cleanupPlans) {
    assert.match(plan, /Index( Only)? Scan using release_domains_pending_expiry on domain_challenges[^\n]*\n\s*Index Cond: \(expires_at <= /);
    assert.doesNotMatch(plan, /Seq Scan on domain_challenges|Sort Method: external/);
  }
});

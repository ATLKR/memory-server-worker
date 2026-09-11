import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { WorkspaceService } from '../src/workspace.ts';
import { IdentityService } from '../src/identity.ts';
import { Admin } from '../src/release/admin.ts';
import { Jobs } from '../src/release/jobs.ts';
import { createRelease } from '../src/release/extension.ts';
import { hmac } from '../src/release/util.ts';
import { applySql } from './apply-sql.mjs';

const origin = 'https://memory.example.test', issuer = 'https://auth-api.allen.company';
const webhookSecret = 'synthetic-native-domain-webhook-secret-'.repeat(2);
const commandMarker = '/* domain-verification-command */';

// Delay only the actual native command boundary. The SQL, clock and trigger
// execution stay native, including when the service uses a one-command batch.
function commandDatabase(db, beforeCommand) {
  let calls = 0;
  const enter = async sql => { if (sql.includes(commandMarker)) { calls++; await beforeCommand(); } };
  const wrap = primary => ({
    withSession() { return wrap(db.withSession('first-primary')); },
    async batch(statements) {
      for (const statement of statements) await enter(statement.sql ?? '');
      return db.batch(statements.map(statement => statement.native?.() ?? statement));
    },
    prepare(sql) {
      let statement = primary.prepare(sql);
      const wrapped = { sql, native: () => statement,
        bind(...values) { statement = statement.bind(...values); return wrapped; },
      };
      for (const method of ['first', 'all', 'run']) wrapped[method] = async (...args) => { await enter(sql); return statement[method](...args); };
      return wrapped;
    },
  });
  return { db: wrap(db), checks: () => calls };
}

test('native D1 domain verification commands and provider proof revocation', { timeout: 180000 }, async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'domain-verification-native-test', modules: true,
    compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
    script: 'export default {fetch(){return new Response("synthetic native D1 test");}}',
    d1Databases: ['DB'], outboundService: () => new Response('Outbound network disabled', { status: 503 }),
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB'), parser = new DatabaseSync(':memory:');
  try {
    const files = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 21).sort();
    assert.equal(files.at(-1), '0021_domain-retention-schema.sql', 'The forward command and retained-proof cleanup migrations must be present');
    for (const file of files) await applySql(parser, db, readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  } finally { parser.close(); }
  const nativeTime = await db.prepare("SELECT CAST(round(unixepoch('subsec')*1000) AS INTEGER) AS at").first();
  assert.ok(Math.abs(nativeTime.at - Date.now()) < 10000, 'Native D1 and service use the real wall clock');

  const dns = new Map(), dnsCalls = [], mail = [];
  const env = { DB: db, PUBLIC_ORIGIN: origin, IDENTITY_WEBHOOK_SECRET: webhookSecret, REQUEST_LIMITER: { limit: async () => ({ success: true }) },
    MAIL_FROM: 'memory@example.test', EMAIL: { async send(message) { mail.push(message); return { messageId: 'synthetic-mail-' + mail.length }; } },
    async fetch(input) {
      const url = new URL(typeof input === 'string' ? input : input.url);
      assert.equal(url.origin, 'https://cloudflare-dns.com'); assert.equal(url.pathname, '/dns-query'); assert.equal(url.searchParams.get('type'), 'TXT');
      const name = url.searchParams.get('name'); dnsCalls.push(name);
      return Response.json({ Status: 0, Answer: dns.has(name) ? [{ name: name + '.', type: 16, data: JSON.stringify(dns.get(name)) }] : [] });
    },
  };
  const workspace = new WorkspaceService(db), admin = new Admin(env), identity = new IdentityService(db);
  const release = createRelease(env, { identity });
  const request = (path, token, data) => release.route(new Request(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }), token);
  const signIn = async label => {
    const principal = { issuer, subject: 'native-domain-' + label, email: label + '@example.test', emailVerified: true, permission: 'write', expiresAt: Date.now() + 900000 };
    const session = await workspace.signIn(principal);
    await db.prepare("UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind='session'").bind(Date.now(), session.accountId).run();
    const snapshot = await workspace.snapshot(session.token);
    return { ...session, principal, emailId: snapshot.account.emails.find(email => email.address === principal.email).id };
  };
  const owner = async label => {
    const actor = await signIn(label), organization = await workspace.createOrganization(actor.token, { name: 'Native ' + label, emailId: actor.emailId });
    const member = await db.prepare('SELECT id FROM memberships WHERE organization_id=? AND account_id=? AND revoked_at IS NULL').bind(organization.id, actor.accountId).first();
    return { ...actor, organization, membershipId: member.id };
  };
  const challenge = async (actor, name) => {
    const result = await admin.beginDomain(actor.token, actor.organization.id, name); dns.set(result.name, result.value); return result;
  };
  const absent = async proof => {
    const row = await db.prepare('SELECT used_at,verification_id,domain FROM release_domain_challenges WHERE id=?').bind(proof.id).first();
    assert.equal(row.used_at, null); assert.equal(row.verification_id, null);
    assert.equal(await db.prepare('SELECT id FROM release_domain_verifications WHERE challenge_id=?').bind(proof.id).first(), null);
    assert.equal(await db.prepare('SELECT id FROM domains WHERE name=? AND revoked_at IS NULL').bind(row.domain).first(), null);
  };

  await t.test('new verification, renewal and same-account current-browser replay return persisted authority', async () => {
    const actor = await owner('domain-success'), proof = await challenge(actor, 'success.native.test');
    const verified = await admin.verifyDomain(actor.token, proof.id), domain = await db.prepare('SELECT * FROM domains WHERE id=?').bind(verified.id).first();
    assert.equal(verified.name, 'success.native.test'); assert.equal(domain.organization_id, actor.organization.id); assert.equal(domain.verified_until, verified.verifiedUntil);
    assert.ok(verified.verifiedUntil > Date.now() + 29 * 86400000);
    const receipt = await db.prepare('SELECT * FROM release_domain_verifications WHERE challenge_id=?').bind(proof.id).first();
    assert.equal(receipt.domain_id, verified.id); assert.equal(receipt.membership_id, actor.membershipId);
    assert.equal((await db.prepare('SELECT revoked_at FROM domain_managers WHERE domain_id=? AND membership_id=?').bind(verified.id, actor.membershipId).first()).revoked_at, null);
    const replayActor = await signIn('domain-success'), lookups = dnsCalls.length;
    assert.notEqual(replayActor.token, actor.token); assert.deepEqual(await admin.verifyDomain(replayActor.token, proof.id), verified); assert.equal(dnsCalls.length, lookups, 'An exact receipt replay needs no new DNS proof');
    const next = await challenge({ ...actor, token: replayActor.token }, 'success.native.test'), renewed = await admin.verifyDomain(replayActor.token, next.id);
    assert.equal(renewed.id, verified.id); assert.ok(renewed.verifiedUntil >= verified.verifiedUntil);
    assert.deepEqual(await admin.verifyDomain(replayActor.token, next.id), renewed);
    assert.equal((await db.prepare('SELECT verified_until FROM domains WHERE id=?').bind(verified.id).first()).verified_until, renewed.verifiedUntil);
  });

  for (const expiry of ['challenge', 'credential', 'membership', 'recent-proof']) await t.test('queued ' + expiry + ' expiry commits no partial verification', async () => {
    const actor = await owner('queue-' + expiry), proof = await challenge(actor, expiry + '.queue.native.test');
    const intercept = commandDatabase(db, async () => {
      const until = Date.now() + 80;
      if (expiry === 'challenge') await db.prepare('UPDATE release_domain_challenges SET expires_at=? WHERE id=?').bind(until, proof.id).run();
      else if (expiry === 'credential') await db.prepare('UPDATE credentials SET expires_at=? WHERE account_id=?').bind(until, actor.accountId).run();
      else if (expiry === 'membership') await db.prepare('UPDATE memberships SET expires_at=? WHERE id=?').bind(until, actor.membershipId).run();
      else await db.prepare("UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind='session'").bind(until - 300000, actor.accountId).run();
      await new Promise(resolve => setTimeout(resolve, Math.max(1, until - Date.now() + 25)));
    });
    await assert.rejects(() => new Admin({ ...env, DB: intercept.db }).verifyDomain(actor.token, proof.id), error => error.status === 403);
    assert.equal(intercept.checks(), 1, 'The expiration occurred at the native command, after the earlier checks'); await absent(proof);
  });

  await t.test('a native trigger failure rolls back proof, receipt and domain, then the same proof can succeed', async () => {
    const actor = await owner('domain-rollback'), proof = await challenge(actor, 'rollback.native.test');
    await db.prepare(`CREATE TRIGGER native_domain_manager_failure BEFORE INSERT ON domain_managers
      WHEN EXISTS(SELECT 1 FROM domains WHERE id=NEW.domain_id AND name='rollback.native.test')
      BEGIN SELECT RAISE(ABORT,'synthetic_domain_manager_failure'); END`).run();
    try { await assert.rejects(() => admin.verifyDomain(actor.token, proof.id), /synthetic_domain_manager_failure/); await absent(proof); }
    finally { await db.prepare('DROP TRIGGER native_domain_manager_failure').run(); }
    const verified = await admin.verifyDomain(actor.token, proof.id);
    assert.equal((await db.prepare('SELECT domain_id FROM domain_managers WHERE domain_id=? AND membership_id=? AND revoked_at IS NULL').bind(verified.id, actor.membershipId).first()).domain_id, verified.id);
    assert.deepEqual(await admin.verifyDomain(actor.token, proof.id), verified);
  });

  await t.test('wrong accounts and revoked assignments cannot replay or revive a manager; a current independent admin can recover', async () => {
    const actor = await owner('domain-recovery'), wrong = await signIn('domain-wrong'), proof = await challenge(actor, 'recovery.native.test');
    await assert.rejects(() => admin.verifyDomain(wrong.token, proof.id), error => error.status === 403); await absent(proof);
    const verified = await admin.verifyDomain(actor.token, proof.id);
    await assert.rejects(() => admin.verifyDomain(wrong.token, proof.id), error => error.status === 403);
    await db.prepare('UPDATE domain_managers SET revoked_at=? WHERE domain_id=? AND membership_id=?').bind(Date.now(), verified.id, actor.membershipId).run();
    await assert.rejects(() => admin.verifyDomain(actor.token, proof.id), error => error.status === 403);
    const denied = await challenge(actor, 'recovery.native.test');
    await assert.rejects(() => admin.verifyDomain(actor.token, denied.id), error => error.status === 403);
    assert.equal((await db.prepare('SELECT used_at FROM release_domain_challenges WHERE id=?').bind(denied.id).first()).used_at, null);
    const replacement = await signIn('domain-replacement'), invite = await workspace.createInvite(actor.token, actor.organization.id, { email: replacement.principal.email, role: 'admin' });
    await workspace.acceptInvite(replacement.token, invite.token);
    const fresh = await challenge({ ...replacement, organization: actor.organization }, 'recovery.native.test'), recovered = await admin.verifyDomain(replacement.token, fresh.id);
    assert.equal(recovered.id, verified.id); assert.deepEqual(await admin.verifyDomain(replacement.token, fresh.id), recovered);
    const assignments = (await db.prepare('SELECT g.membership_id,g.revoked_at,m.account_id FROM domain_managers g JOIN memberships m ON m.id=g.membership_id WHERE g.domain_id=?').bind(verified.id).all()).results;
    assert.ok(assignments.find(row => row.membership_id === actor.membershipId).revoked_at !== null);
    assert.equal(assignments.find(row => row.account_id === replacement.accountId).revoked_at, null);
  });

  await t.test('an accepted signed email.revoked event invalidates pending proof and HTTP completion returns403', async () => {
    const actor = await signIn('pending-provider-proof'), address = 'pending-claim@native.test';
    const started = await request('/v1/account/emails', actor.token, { email: address }); assert.equal(started.status, 202, await started.clone().text());
    const { challengeId } = await started.json(), proof = mail.at(-1).text.match(/Proof: ([^\n]+)/)[1];
    const pending = await db.prepare('SELECT used_at,invalidated_at FROM email_challenges WHERE id=?').bind(challengeId).first(); assert.deepEqual(pending, { used_at: null, invalidated_at: null });
    const raw = JSON.stringify({ id: 'native-pending-email-revocation', issuer, subject: actor.principal.subject, type: 'email.revoked', email: address }), timestamp = String(Math.floor(Date.now() / 1000));
    const event = await release.publicRoute(new Request(origin + '/webhooks/identity', { method: 'POST', headers: { 'x-memory-timestamp': timestamp, 'x-memory-signature': await hmac(webhookSecret, timestamp + '.' + raw) }, body: raw }));
    assert.equal(event.status, 200, await event.clone().text());
    assert.ok((await db.prepare('SELECT invalidated_at FROM email_challenges WHERE id=?').bind(challengeId).first()).invalidated_at !== null);
    const completed = await request('/v1/account/emails/verify', actor.token, { challengeId, proof }); assert.equal(completed.status, 403, await completed.clone().text());
    assert.equal(await db.prepare('SELECT id FROM account_emails WHERE account_id=? AND address=? AND revoked_at IS NULL').bind(actor.accountId, address).first(), null);
    assert.equal(await db.prepare('SELECT id FROM email_consumptions WHERE challenge_id=?').bind(challengeId).first(), null);
    assert.ok((await identity.getAccount(actor.token)).emails.some(email => email.address === actor.principal.email), 'The unrelated personal sign-in claim remains usable');
  });

  await t.test('native cleanup bounds unused expiry while preserving consumed proofs and receipt replay', async () => {
    const actor = await owner('domain-retention'), proof = await challenge(actor, 'retention.native.test');
    const result = await admin.verifyDomain(actor.token, proof.id), expiredAt = Date.now() - 1000;
    await db.prepare('UPDATE release_domain_challenges SET expires_at=? WHERE id=?').bind(expiredAt, proof.id).run();
    await db.prepare(`INSERT INTO release_domain_challenges(id,organization_id,actor_account_id,domain,proof,expires_at,used_at,verification_id)
      VALUES('native-legacy-consumed',?,?,'retention.native.test','synthetic',?,?,'native-legacy-receipt')`).bind(actor.organization.id, actor.accountId, expiredAt, expiredAt - 1000).run();
    await db.prepare(`INSERT INTO release_domain_challenges(id,organization_id,actor_account_id,domain,proof,expires_at)
      SELECT value,?,?,'retention.native.test','synthetic',? FROM json_each(?)`).bind(actor.organization.id, actor.accountId, expiredAt,
      JSON.stringify(Array.from({ length: 105 }, (_, index) => 'native-unused-' + String(index).padStart(3, '0')))).run();
    const retainedProofs = (await db.prepare('SELECT * FROM release_domain_challenges WHERE used_at IS NOT NULL ORDER BY id').all()).results;
    const receipts = (await db.prepare('SELECT * FROM release_domain_verifications ORDER BY id').all()).results;
    const pendingAt = Date.now(), pending = (await db.prepare('SELECT count(*) AS n FROM release_domain_challenges WHERE used_at IS NULL AND expires_at<=?').bind(pendingAt).first()).n;
    assert.ok(pending >= 105);
    const jobs = new Jobs(env); await jobs.maintain();
    assert.equal((await db.prepare('SELECT count(*) AS n FROM release_domain_challenges WHERE used_at IS NULL AND expires_at<=?').bind(pendingAt).first()).n, pending - 100);
    assert.deepEqual((await db.prepare('SELECT * FROM release_domain_challenges WHERE used_at IS NOT NULL ORDER BY id').all()).results, retainedProofs);
    assert.deepEqual((await db.prepare('SELECT * FROM release_domain_verifications ORDER BY id').all()).results, receipts);
    await jobs.maintain();
    assert.equal((await db.prepare("SELECT count(*) AS n FROM release_domain_challenges WHERE id LIKE 'native-unused-%'").first()).n, 0);
    assert.deepEqual((await db.prepare('SELECT * FROM release_domain_challenges WHERE used_at IS NOT NULL ORDER BY id').all()).results, retainedProofs);
    assert.deepEqual((await db.prepare('SELECT * FROM release_domain_verifications ORDER BY id').all()).results, receipts);
    assert.deepEqual(await admin.verifyDomain(actor.token, proof.id), result);
    const plan = (await db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM release_domain_challenges INDEXED BY release_domains_pending_expiry
      WHERE used_at IS NULL AND expires_at<=? ORDER BY expires_at,id LIMIT 100`).bind(Date.now()).all()).results.map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH release_domain_challenges USING INDEX release_domains_pending_expiry \(expires_at</);
    assert.doesNotMatch(plan, /SCAN release_domain_challenges|USE TEMP B-TREE/);
  });
});

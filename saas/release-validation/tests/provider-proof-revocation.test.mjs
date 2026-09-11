import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { IdentityService } from '../../src/identity.ts';
import { createApplication } from '../../src/app.ts';
import { createRelease } from '../../src/release/extension.ts';
import { readSettings, AUTH_ISSUER, PUBLIC_ORIGIN } from '../../src/config.ts';
import { hmac } from '../../src/release/util.ts';

async function setup(t) {
  const f = await fixture(); t.after(() => f.db.close()); const delivered = [], secret = 'synthetic-provider-proof-secret'.repeat(3);
  f.db.raw.prepare('INSERT INTO provider_identities(issuer,subject,account_id,created_at) VALUES(?,?,?,?)').run(AUTH_ISSUER, 'alice-provider', 'alice', at);
  const env = { DB: f.db, IDENTITY_WEBHOOK_SECRET: secret, REQUEST_LIMITER: { limit: async () => ({ success: true }) },
    MAIL_FROM: 'memory@example.com', EMAIL: { send: async message => { delivered.push(message.text.match(/Proof: ([^\n]+)/)[1]); return { messageId: 'synthetic' }; } } };
  const identity = new IdentityService(f.db, () => at), app = createApplication(f.db, readSettings(env), { clock: () => at, release: createRelease(env, { clock: () => at, identity }) });
  const post = (path, body, token = f.token) => app(new Request(PUBLIC_ORIGIN + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const start = async (token = f.token) => { const index = delivered.length, response = await post('/v1/account/emails', { email: 'pending@example.net' }, token); assert.equal(response.status, 202); return { ...(await response.json()), proof: delivered[index] }; };
  const revoke = async () => {
    const body = JSON.stringify({ id: 'provider-proof-revocation', issuer: AUTH_ISSUER, subject: 'alice-provider', type: 'email.revoked', email: 'pending@example.net' }), timestamp = String(at / 1000);
    return app(new Request(PUBLIC_ORIGIN + '/webhooks/identity', { method: 'POST', body, headers: { 'x-memory-timestamp': timestamp, 'x-memory-signature': await hmac(secret, timestamp + '.' + body) } }));
  };
  return { ...f, post, start, revoke, delivered };
}

test('accepted provider email revocation invalidates a pending proof and verification returns403', async t => {
  const f = await setup(t), proof = await f.start(); assert.equal((await f.revoke()).status, 200);
  const response = await f.post('/v1/account/emails/verify', proof);
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'access_denied' });
  const stored = f.db.raw.prepare('SELECT used_at,invalidated_at FROM email_challenges WHERE id=?').get(proof.challengeId);
  assert.equal(stored.used_at, null); assert.equal(stored.invalidated_at, at);
  assert.equal(f.db.raw.prepare("SELECT count(*) n FROM account_emails WHERE address='pending@example.net'").get().n, 0);
});

test('a standing provider tombstone denies consumption without a generic database error', async t => {
  const f = await setup(t), proof = await f.start();
  f.db.raw.prepare('INSERT INTO release_provider_revocations(issuer,subject,kind,address,created_at) VALUES(?,?,?,?,?)').run(AUTH_ISSUER, 'alice-provider', 'email.revoked', 'pending@example.net', at);
  assert.equal((await f.post('/v1/account/emails/verify', proof)).status, 403);
  assert.equal(f.db.raw.prepare('SELECT used_at FROM email_challenges WHERE id=?').get(proof.challengeId).used_at, null);
});

test('provider revocation leaves another account pending proof usable', async t => {
  const f = await setup(t), alice = await f.start(), bob = await f.start(f.other); assert.equal((await f.revoke()).status, 200);
  assert.equal((await f.post('/v1/account/emails/verify', alice)).status, 403);
  assert.equal((await f.post('/v1/account/emails/verify', bob, f.other)).status, 200);
  assert.equal(f.db.raw.prepare("SELECT account_id FROM account_emails WHERE address='pending@example.net'").get().account_id, 'bob');
});

test('unrelated claim storage failure stays500 and rolls back proof consumption', async t => {
  const f = await setup(t), proof = await f.start();
  f.db.raw.exec("CREATE TRIGGER injected_claim_failure BEFORE INSERT ON account_emails BEGIN SELECT RAISE(ABORT,'synthetic unrelated failure'); END;");
  assert.equal((await f.post('/v1/account/emails/verify', proof)).status, 500);
  assert.equal(f.db.raw.prepare('SELECT used_at FROM email_challenges WHERE id=?').get(proof.challengeId).used_at, null);
});

test('a fresh link request cannot create or send a proof for an exact standing revocation', async t => {
  const f = await setup(t); assert.equal((await f.revoke()).status, 200);
  assert.equal((await f.post('/v1/account/emails', { email: 'pending@example.net' })).status, 403);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM email_challenges').get().n, 0);
  assert.equal(f.delivered.length, 0);
});

test('pending-proof invalidation failure rolls back the accepted webhook and preserves a usable proof', async t => {
  const f = await setup(t), proof = await f.start();
  f.db.raw.exec("CREATE TRIGGER injected_proof_failure BEFORE UPDATE OF invalidated_at ON email_challenges BEGIN SELECT RAISE(ABORT,'synthetic unrelated proof failure'); END;");
  assert.equal((await f.revoke()).status, 500);
  for (const table of ['release_webhook_events', 'release_provider_revocations', 'release_external_email_blocks']) assert.equal(f.db.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.db.raw.prepare('SELECT invalidated_at FROM email_challenges WHERE id=?').get(proof.challengeId).invalidated_at, null);
  f.db.raw.exec('DROP TRIGGER injected_proof_failure');
  assert.equal((await f.post('/v1/account/emails/verify', proof)).status, 200);
});

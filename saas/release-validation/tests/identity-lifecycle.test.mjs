import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, at } from './db.mjs';
import { Admin } from '../../src/release/admin.ts';
import { WorkspaceService } from '../../src/workspace.ts';
import { IdentityService } from '../../src/identity.ts';
import { requireSpace } from '../../src/release/authority.ts';
import { hmac, digest } from '../../src/release/util.ts';

const issuer = 'https://auth-api.allen.company', secret = 'synthetic-lifecycle-secret-'.repeat(2);
async function setup(t) {
  let now = at; const f = await fixture({ clock: () => now }); t.after(() => f.db.close());
  if (!f.db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='release_identity_lifecycle_events'").get()) f.db.raw.exec(readFileSync(new URL('../../lifecycle-schema.sql', import.meta.url), 'utf8'));
  f.db.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer, 'central-alice', 'alice', at);
  const clock = () => now, admin = new Admin({ DB: f.db, IDENTITY_WEBHOOK_SECRET: secret }, clock);
  const event = (sequence, type, email, subject = 'central-alice', occurredAt = now) => ({ version: 2, id: 'event-' + sequence, sequence, issuer, subject, type, occurredAt, email: email ?? null });
  const request = async value => { const body = JSON.stringify(value), timestamp = String(Math.floor(now / 1000)); return new Request('https://memory.allenlabs.org/webhooks/identity', { method: 'POST', headers: { 'content-type': 'application/json', 'x-memory-timestamp': timestamp, 'x-memory-signature': await hmac(secret, timestamp + '.' + body) }, body }); };
  return { ...f, clock, advance(ms) { now += ms; }, admin, event, request, deliver: async value => admin.identityWebhook(await request(value)),
    workspace: new WorkspaceService(f.db, clock, { identityLifecycle: true }),
    principal: issuedAt => ({ issuer, subject: 'central-alice', email: 'alice@example.com', emailVerified: true, permission: 'write', expiresAt: now + 900000, issuedAt }),
    state: (address = '') => f.db.raw.prepare('SELECT * FROM release_identity_lifecycle_state WHERE issuer=? AND subject=? AND address=?').get(issuer, 'central-alice', address) };
}
test('suspension revokes every old key, session, membership, claim and pending proof atomically', async t => {
  const f = await setup(t);
  f.db.raw.prepare('INSERT INTO email_challenges(id,account_id,address,domain,token_digest,expires_at) VALUES(?,?,?,?,?,?)').run('pending', 'alice', 'new@example.com', 'example.com', await digest('proof'), at + 50000);
  assert.equal((await f.deliver(f.event(1, 'account.suspended'))).status, 200);
  for (const token of [f.token, f.key]) await assert.rejects(() => requireSpace(f.db, token, 's1', 'read', f.clock), error => error.status === 403);
  assert.equal(f.db.raw.prepare("SELECT count(*) n FROM credentials WHERE account_id='alice' AND revoked_at IS NULL").get().n, 0);
  assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m1'").get().revoked_at, at);
  assert.equal(f.db.raw.prepare("SELECT revoked_at FROM account_emails WHERE id='e1'").get().revoked_at, at);
  assert.equal(f.db.raw.prepare("SELECT invalidated_at FROM email_challenges WHERE id='pending'").get().invalidated_at, at);
  assert.equal(f.db.raw.prepare("SELECT disabled_at FROM accounts WHERE id='alice'").get().disabled_at, null);
});
test('resume requires a post-resume signed grant and never restores old ACL bindings', async t => {
  const f = await setup(t); await f.deliver(f.event(1, 'account.suspended')); f.advance(1200); const resumedAt = f.clock();
  await f.deliver(f.event(2, 'account.resumed'));
  for (const issuedAt of [undefined, at - 1000, Math.floor(resumedAt / 1000) * 1000])
    await assert.rejects(() => f.workspace.signIn(f.principal(issuedAt)), error => error.status === 403);
  f.advance(1000); const session = await f.workspace.signIn(f.principal(Math.floor(f.clock() / 1000) * 1000));
  assert.equal(session.accountId, 'alice'); await requireSpace(f.db, session.token, 's1', 'read', f.clock);
  await assert.rejects(() => requireSpace(f.db, session.token, 'so', 'read', f.clock), error => error.status === 403);
  for (const token of [f.token, f.key]) await assert.rejects(() => requireSpace(f.db, token, 's1', 'read', f.clock), error => error.status === 403);
  assert.notEqual(f.db.raw.prepare("SELECT id FROM account_emails WHERE account_id='alice' AND revoked_at IS NULL").get().id, 'e1');
});
test('a resume arriving first still invalidates old authority and ignores a late suspension', async t => {
  const f = await setup(t); await f.deliver(f.event(20, 'account.resumed')); f.advance(1000);
  const session = await f.workspace.signIn(f.principal(f.clock()));
  await f.deliver(f.event(19, 'account.suspended', undefined, 'central-alice', at - 1000));
  assert.equal(f.state().sequence, 20); await requireSpace(f.db, session.token, 's1', 'read', f.clock);
  await assert.rejects(() => requireSpace(f.db, f.key, 's1', 'read', f.clock), error => error.status === 403);
});
test('exact email lifecycle ordering cannot hide a different address revocation', async t => {
  const f = await setup(t);
  f.db.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,NULL)').run('extra', 'alice', 'extra@example.net', 'example.net', at);
  await f.deliver(f.event(30, 'email.revoked', 'alice@example.com'));
  await f.deliver(f.event(29, 'email.revoked', 'extra@example.net'));
  assert.equal(f.state('alice@example.com').sequence, 30); assert.equal(f.state('extra@example.net').sequence, 29);
  assert.equal(f.db.raw.prepare("SELECT count(*) n FROM account_emails WHERE account_id='alice' AND revoked_at IS NULL").get().n, 0);
  await requireSpace(f.db, f.token, 's1', 'read', f.clock);
});
test('an exact-address revocation on another account cannot suppress a new verified claim', async t => {
  const f = await setup(t);
  f.db.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer, 'central-bob', 'bob', at);
  await f.deliver(f.event(1, 'email.revoked', 'unclaimed@example.net', 'central-bob'));
  const session = await f.workspace.signIn({ ...f.principal(f.clock()), email: 'unclaimed@example.net' });
  assert.equal(session.accountId, 'alice');
  assert.equal(f.db.raw.prepare("SELECT account_id FROM account_emails WHERE address='unclaimed@example.net' AND revoked_at IS NULL").get()?.account_id, 'alice');
});
test('email reverification permits a new claim while old memberships, shares and proofs remain revoked', async t => {
  const f = await setup(t), revoked = f.event(1, 'email.revoked', 'alice@example.com'); await f.deliver(revoked);
  await assert.rejects(() => new IdentityService(f.db, f.clock).beginEmailLink(f.token, 'alice@example.com', async () => {}));
  f.advance(1000); await f.deliver(f.event(2, 'email.verified', 'alice@example.com')); f.advance(1000);
  const session = await f.workspace.signIn(f.principal(f.clock()));
  const claim = f.db.raw.prepare("SELECT id FROM account_emails WHERE address='alice@example.com' AND revoked_at IS NULL").get();
  assert.ok(claim); assert.notEqual(claim.id, 'e1');
  assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m1'").get().revoked_at, at);
  await assert.rejects(() => requireSpace(f.db, session.token, 'so', 'read', f.clock), error => error.status === 403);
  await f.deliver(revoked); assert.equal(f.state('alice@example.com').sequence, 2);
});
test('terminal deletion and v1 permanent revocations cannot be undone by v2 resume', async t => {
  const f = await setup(t); await f.deliver(f.event(3, 'account.deleted')); await f.deliver(f.event(4, 'account.resumed'));
  assert.equal(f.state().kind, 'account.deleted'); f.advance(1000);
  await assert.rejects(() => f.workspace.signIn(f.principal(f.clock())));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_identity_lifecycle_events').get().n, 2);
  const old = { id: 'legacy-v1', issuer, subject: 'legacy-other', type: 'account.disabled' };
  await f.deliver(old); await f.deliver(f.event(5, 'account.resumed', undefined, 'legacy-other')); f.advance(1000);
  await assert.rejects(() => f.workspace.signIn({ ...f.principal(f.clock()), subject: 'legacy-other' }));
});
test('unmapped lifecycle state blocks stale first sign-in before any new identity is created', async t => {
  const f = await setup(t); await f.deliver(f.event(8, 'account.suspended', undefined, 'unmapped'));
  await assert.rejects(() => f.workspace.signIn({ ...f.principal(at), subject: 'unmapped' }));
  assert.equal(f.db.raw.prepare("SELECT count(*) n FROM provider_identities WHERE subject='unmapped'").get().n, 0);
});
test('same event replay is harmless while changed bytes or reused sequence are conflicts', async t => {
  const f = await setup(t), event = f.event(9, 'email.revoked', 'alice@example.com'); await f.deliver(event);
  assert.equal((await (await f.deliver(event)).json()).replayed, true);
  await assert.rejects(() => f.deliver({ ...event, email: 'other@example.com' }), error => error.status === 409);
  await assert.rejects(() => f.deliver({ ...event, id: 'different-id' }), error => error.status === 409);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_identity_lifecycle_events').get().n, 1);
});
test('invalid lifecycle envelope or signature creates no receipt or state', async t => {
  const f = await setup(t);
  for (const event of [{ ...f.event(1, 'account.resumed'), sequence: '1' }, { ...f.event(1, 'account.resumed'), occurredAt: -1 }, f.event(1, 'account.enabled'), f.event(1, 'email.revoked', 'bad')])
    await assert.rejects(() => f.deliver(event), error => error.status === 400);
  const request = await f.request(f.event(1, 'account.suspended')); request.headers.set('x-memory-signature', '0'.repeat(64));
  await assert.rejects(() => f.admin.identityWebhook(request), error => error.status === 401);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_webhook_events').get().n, 0);
});
test('a queued lifecycle command cannot outlive its signature or leave partial revocation', async t => {
  const f = await setup(t), prepare = f.db.prepare.bind(f.db); let touched = false;
  f.db.prepare = sql => { const s = prepare(sql); if (sql.includes('INSERT INTO release_identity_lifecycle_events')) { const all = s.all.bind(s); s.all = async () => { touched = true; f.advance(300001); return all(); }; } return s; };
  await assert.rejects(() => f.deliver(f.event(1, 'account.suspended')), error => error.status === 401);
  assert.equal(touched, true); assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_webhook_events').get().n, 0);
  assert.equal(f.db.raw.prepare("SELECT revoked_at FROM credentials WHERE id='session:alice'").get().revoked_at, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { IdentityService } from '../../src/identity.ts';
import { WorkspaceService } from '../../src/workspace.ts';
import { MemoryService } from '../../src/memory.ts';
import { Admin } from '../../src/release/admin.ts';
import { Billing } from '../../src/release/billing.ts';
import { digest, hmac } from '../../src/release/util.ts';
import { DB } from './db.mjs';
import { readFileSync } from 'node:fs';

async function setup(t) {
  const f = await fixture(); t.after(() => f.db.close());
  let now = at;
  // Evaluate the same SQL runtime clock when SQLite executes, not when its
  // statement was constructed. No service code knows about the clock hook.
  f.db.setClock(() => now);
  const clock = () => now;
  const queue = (fragment, advance = at + 200) => {
    let executed = false;
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = sql => {
      const statement = prepare(sql);
      for (const method of ['run', 'all', 'first']) {
        const execute = statement[method].bind(statement);
        statement[method] = async () => {
          if (!executed && sql.includes(fragment)) { executed = true; now = advance; }
          return execute();
        };
      }
      return statement;
    };
    return () => assert.equal(executed, true, 'queued mutation must execute');
  };
  const raw = f.db.raw;
  const count = table => Number(raw.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  return { ...f, raw, clock, queue, count,
    expire: () => raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at + 100),
    identity: new IdentityService(f.db, clock), workspace: new WorkspaceService(f.db, clock),
    memory: new MemoryService(f.db, clock), admin: new Admin({ DB: f.db }, clock) };
}

for (const [name, marker, table, action] of [
  ['organization creation', 'INSERT INTO workspace_organization_creations', 'organizations', f => f.workspace.createOrganization(f.token, { name: 'Queued', emailId: 'e1' })],
  ['child organization creation', 'INSERT INTO workspace_child_organization_creations', 'organizations', f => f.workspace.createOrganization(f.token, { name: 'Queued', emailId: 'e1', parentOrganizationId: 'org' })],
  ['invitation creation', 'INSERT INTO workspace_invitations', 'workspace_invitations', f => f.workspace.createInvite(f.token, 'org', { email: 'new@example.com', role: 'member' })],
  ['foundation key issuance', 'INSERT INTO workspace_key_issuances', 'credentials', f => f.workspace.issueKey(f.token, { label: 'Queued', permission: 'write', expiresInDays: 1 })],
  ['Space creation', 'INSERT INTO spaces', 'spaces', f => f.memory.createSpace(f.token, { name: 'Queued' })],
  ['memory creation', 'INSERT INTO memories', 'memories', f => f.memory.create(f.token, 's1', { body: 'Queued content' })],
  ['scoped PAT issuance', 'INSERT INTO credentials', 'credentials', f => f.admin.issueKey(f.token, { label: 'Queued', capabilities: ['read'], expiresInDays: 1 })],
  ['domain challenge creation', 'INSERT INTO release_domain_challenges', 'release_domain_challenges', f => f.admin.beginDomain(f.token, 'org', 'example.net')],
  ['SCIM key issuance', 'INSERT INTO release_scim_keys', 'release_scim_keys', f => f.admin.issueScimKey(f.token, 'org')],
]) test(`${name} cannot persist when its prepared write executes after credential expiry`, async t => {
  const f = await setup(t); f.expire();
  const before = f.count(table), queued = f.queue(marker);
  await action(f).catch(() => {});
  queued(); assert.equal(f.count(table), before);
});

for (const key of [false, true]) test(`foundation ${key ? 'key' : 'membership'} revocation cannot persist after actor expiry in the queue`, async t => {
  const f = await setup(t); f.expire();
  const queued = f.queue(key ? 'INSERT INTO workspace_key_revocations' : 'INSERT INTO workspace_membership_revocations');
  await (key ? f.workspace.revokeKey(f.token, 'key:alice') : f.workspace.revokeMembership(f.token, 'org', 'm2')).catch(() => {});
  queued(); assert.equal(f.raw.prepare(`SELECT revoked_at FROM ${key ? 'credentials' : 'memberships'} WHERE id=?`).get(key ? 'key:alice' : 'm2').revoked_at, null);
});

test('invitation acceptance cannot consume a proof or create membership after expiry in the queue', async t => {
  const f = await setup(t), invitation = await f.workspace.createInvite(f.token, 'org', { email: 'new@example.com', role: 'member' });
  f.raw.exec(`INSERT INTO accounts(id) VALUES('invitee');
    INSERT INTO account_emails(id,account_id,address,domain,verified_at) VALUES('invite-email','invitee','new@example.com','example.com',${at});`);
  const token = 'invited'.padEnd(64, 'x');
  f.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,permission) VALUES('invite-session','invitee','session',?,?,'write')").run(await digest(token), at + 100);
  const queued = f.queue('INSERT INTO workspace_invitation_acceptances');
  await f.workspace.acceptInvite(token, invitation.token).catch(() => {});
  queued(); assert.equal(f.count('workspace_invitation_acceptances'), 0);
  assert.equal(f.raw.prepare('SELECT accepted_at FROM workspace_invitations WHERE id=?').get(invitation.id).accepted_at, null);
});

test('email proof cannot create a claim after its expiry in the queue', async t => {
  const f = await setup(t), proof = 'proof'.padEnd(64, 'x');
  f.raw.prepare("INSERT INTO email_challenges(id,account_id,address,domain,token_digest,expires_at) VALUES('email-proof','alice','new@example.com','example.com',?,?)").run(await digest(proof), at + 100);
  const before = f.count('account_emails'), queued = f.queue('INSERT INTO email_consumptions');
  await f.identity.completeEmailLink(f.token, 'email-proof', proof).catch(() => {});
  queued(); assert.equal(f.count('account_emails'), before);
  assert.equal(f.raw.prepare("SELECT used_at FROM email_challenges WHERE id='email-proof'").get().used_at, null);
});

test('reauthentication still consumes a valid proof and updates exactly its live credential atomically', async t => {
  const f = await setup(t);
  f.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at - 600000);
  f.raw.prepare('INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES(?,?,?,?,?)')
    .run('valid-proof', 'session:alice', 'e1', await digest('valid-proof'), at + 600000);
  const queued = f.queue('UPDATE release_reauth_challenges SET used_at=', at + 200);
  await f.admin.completeReauth(f.token, 'valid-proof', 'valid-proof');
  queued(); assert.equal(f.raw.prepare("SELECT used_at FROM release_reauth_challenges WHERE id='valid-proof'").get().used_at, at + 200);
  assert.equal(f.raw.prepare("SELECT reauthenticated_at FROM credentials WHERE id='session:alice'").get().reauthenticated_at, at + 200);
  await assert.rejects(() => f.admin.completeReauth(f.token, 'valid-proof', 'valid-proof'), error => error.status === 403);
});

test('domain verification cannot assign a domain when its atomic command executes after authority expiry', async t => {
  const f = await setup(t), challenge = await f.admin.beginDomain(f.token, 'org', 'example.net');
  f.admin.fetcher = async () => Response.json({ Status: 0, Answer: [{ name: challenge.name, type: 16, data: JSON.stringify(challenge.value) }] });
  f.expire(); const queued = f.queue('/* domain-verification-command */');
  await f.admin.verifyDomain(f.token, challenge.id).catch(() => {});
  queued(); assert.equal(f.count('domains'), 0); assert.equal(f.count('domain_managers'), 0);
});

test('email unlink cannot persist when recent proof expires in the mutation queue', async t => {
  const f = await setup(t), queued = f.queue('INSERT INTO revocations', at + 300001);
  await f.identity.unlinkEmail(f.token, 'e1').catch(() => {});
  queued(); assert.equal(f.raw.prepare("SELECT revoked_at FROM account_emails WHERE id='e1'").get().revoked_at, null);
  assert.equal(f.count('revocations'), 0);
});

for (const remove of [false, true]) test(`memory ${remove ? 'delete' : 'update'} cannot mutate after credential expiry in the execution queue`, async t => {
  const f = await setup(t), memory = await f.memory.create(f.token, 's1', { body: 'Original' });
  f.expire(); const queued = f.queue('UPDATE memories SET');
  await (remove ? f.memory.remove(f.token, 's1', memory.id, 1) : f.memory.update(f.token, 's1', memory.id, { body: 'Changed', expectedRevision: 1 })).catch(() => {});
  queued();
  assert.deepEqual({ ...f.raw.prepare('SELECT body,revision,deleted_at FROM memories WHERE id=?').get(memory.id) }, { body: 'Original', revision: 1, deleted_at: null });
});

test('sign-in does not create an identity or credential after its verified principal expires in the queue', async t => {
  const f = await setup(t), before = f.count('accounts'), queued = f.queue('INSERT INTO workspace_sign_ins');
  await f.workspace.signIn({ issuer: 'https://auth-api.allen.company', subject: 'queued-new-user', expiresAt: at + 100, permission: 'read' }).catch(() => {});
  queued(); assert.equal(f.count('accounts'), before); assert.equal(f.count('workspace_sign_ins'), 0);
});

test('reauth proof cannot be consumed or renew a session after proof expiry in the batch queue', async t => {
  const f = await setup(t);
  f.raw.prepare('INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES(?,?,?,?,?)')
    .run('queued-proof', 'session:alice', 'e1', await digest('synthetic-proof'), at + 100);
  const queued = f.queue('UPDATE release_reauth_challenges SET used_at=');
  await f.admin.completeReauth(f.token, 'queued-proof', 'synthetic-proof').catch(() => {});
  queued(); assert.equal(f.raw.prepare("SELECT used_at FROM release_reauth_challenges WHERE id='queued-proof'").get().used_at, null);
  assert.equal(f.raw.prepare("SELECT reauthenticated_at FROM credentials WHERE id='session:alice'").get().reauthenticated_at, at);
});

for (const operation of ['deactivate', 'delete']) test(`SCIM ${operation} cannot revoke a target after its issuing membership expires in the queue`, async t => {
  const f = await setup(t), key = await f.admin.issueScimKey(f.token, 'org');
  f.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at + 100);
  const queued = f.queue(operation === 'delete' ? 'INSERT INTO release_scim_deletions' : 'UPDATE memberships SET revoked_at=');
  await (operation === 'delete' ? f.admin.scimDelete(key.token, 'org', 'm2') : f.admin.scimDeactivate(key.token, 'org', 'm2')).catch(() => {});
  queued(); assert.equal(f.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at, null);
  assert.equal(f.count('release_scim_deletions'), 0);
});

test('domain delegation cannot persist after target membership expires in the queue', async t => {
  const f = await setup(t);
  f.raw.exec(`INSERT INTO domains(id,organization_id,name,verified_until) VALUES('domain','org','example.net',${at + 900000});
    INSERT INTO domain_managers(domain_id,membership_id) VALUES('domain','m1');
    UPDATE memberships SET role='admin',expires_at=${at + 100} WHERE id='m2';`);
  const queued = f.queue('INSERT INTO domain_managers');
  await f.admin.delegateDomain(f.token, 'domain', 'm2').catch(() => {});
  queued(); assert.equal(f.count('domain_managers'), 1);
});

test('checkout first-attempt marker is not claimed after recent proof expires in the queue', async t => {
  const f = await setup(t); let calls = 0;
  f.raw.exec("UPDATE release_pools SET customer_id='cus_test' WHERE id='account:alice'");
  const billing = new Billing({ DB: f.db, BACKGROUND_JOBS_ENABLED: 'true', STRIPE_SECRET_KEY: 'synthetic',
    STRIPE_WEBHOOK_SECRET: 'w'.repeat(64), STRIPE_API_VERSION: 'synthetic',
    BILLING_PRICES_JSON: JSON.stringify({ price_test: { plan: 'team', monthlyUnits: 10000, storageBytes: 1048576000 } }),
    fetch: async () => { calls++; return Response.json({ id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/test' }); } }, f.clock);
  const queued = f.queue('UPDATE release_checkout_requests SET expires_at=', at + 300001);
  await billing.checkout(f.token, 's1', 'price_test', 'queued').catch(() => {});
  queued(); assert.equal(calls, 0);
  assert.equal(f.raw.prepare('SELECT checkout_attempted FROM release_checkout_requests').get().checkout_attempted, 0);
});

test('a first checkout attempt persists its full 35-minute window from execution and freezes it for retries', async t => {
  const f = await setup(t), bodies = [];
  f.raw.exec("UPDATE release_pools SET customer_id='cus_test' WHERE id='account:alice'");
  const billing = new Billing({ DB: f.db, BACKGROUND_JOBS_ENABLED: 'true', STRIPE_SECRET_KEY: 'synthetic',
    STRIPE_WEBHOOK_SECRET: 'w'.repeat(64), STRIPE_API_VERSION: 'synthetic',
    BILLING_PRICES_JSON: JSON.stringify({ price_test: { plan: 'team', monthlyUnits: 10000, storageBytes: 1048576000 } }),
    fetch: async (_url, init) => { bodies.push(init.body); throw new Error('lost response'); } }, f.clock);
  const queued = f.queue('UPDATE release_checkout_requests SET expires_at=', at + 1000);
  await assert.rejects(() => billing.checkout(f.token, 's1', 'price_test', 'queued-safe-window'));
  queued();
  assert.equal(f.raw.prepare('SELECT expires_at FROM release_checkout_requests').get().expires_at, at + 1000 + 2100000);
  await assert.rejects(() => billing.checkout(f.token, 's1', 'price_test', 'queued-safe-window'));
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});

for (const failure of [false, true]) test(`billing ${failure ? 'failure retry' : 'subscription result'} cannot update after its lock expires in the execution queue`, async t => {
  const f = await setup(t);
  f.raw.exec(`UPDATE release_pools SET customer_id='cus_test',subscription_id='sub_test' WHERE id='account:alice';
    INSERT INTO release_billing_events(id,subscription_id,available_at,created_at) VALUES('queued-event','sub_test',${at},${at});`);
  const billing = new Billing({ DB: f.db, STRIPE_SECRET_KEY: 'synthetic', STRIPE_API_VERSION: 'synthetic',
    BILLING_PRICES_JSON: JSON.stringify({ price_test: { plan: 'team', monthlyUnits: 10000, storageBytes: 1048576000 } }),
    fetch: async () => failure ? Response.json({ error: 'provider_unavailable' }, { status: 503 }) :
      Response.json({ id: 'sub_test', customer: 'cus_test', status: 'active', items: { data: [{ price: { id: 'price_test' }, quantity: 1 }] } }) }, f.clock);
  const queued = f.queue(failure ? 'UPDATE release_billing_events SET state=?' : 'UPDATE release_pools SET plan=', at + 120001);
  await billing.drain(); queued();
  assert.equal(f.raw.prepare("SELECT plan FROM release_pools WHERE id='account:alice'").get().plan, 'free');
  assert.deepEqual({ ...f.raw.prepare("SELECT state,attempt FROM release_billing_events WHERE id='queued-event'").get() }, { state: 'pending', attempt: 0 });
});

test('migration19 retains populated command history and guards a direct command with an old timestamp', async t => {
  let now = at;
  const db = new DB(() => now); t.after(() => db.close()); db.migrate(18);
  const workspace = new WorkspaceService(db, () => now);
  const signedIn = await workspace.signIn({ issuer: 'https://auth-api.allen.company', subject: 'retained', expiresAt: at + 900000, permission: 'write', email: 'retained@example.com', emailVerified: true });
  const snapshot = await workspace.snapshot(signedIn.token);
  await workspace.createOrganization(signedIn.token, { name: 'Retained', emailId: snapshot.account.emails[0].id });
  const tables = ['accounts', 'account_emails', 'provider_identities', 'credentials', 'organizations', 'memberships', 'spaces', 'workspace_sign_ins', 'workspace_organization_creations', 'workspace_audit_events'];
  const before = Object.fromEntries(tables.map(table => [table, db.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  db.raw.exec(readFileSync(new URL('../../migrations/0019_execution-time-schema.sql', import.meta.url), 'utf8'));
  for (const table of tables) assert.deepEqual(db.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[table], table);
  assert.equal(db.raw.prepare('SELECT version FROM release_meta').get().version, 19);
  now = at + 900001;
  const actor = db.raw.prepare('SELECT id FROM credentials WHERE token_digest=?').get(await digest(signedIn.token));
  assert.throws(() => db.raw.prepare('INSERT INTO workspace_organization_creations(id,name,actor_credential_id,email_id,membership_id,space_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('late-org', 'Denied', actor.id, snapshot.account.emails[0].id, 'late-membership', 'late-space', at), /workspace operation denied/);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM organizations WHERE id='late-org'").get().n, 0);
});

for (const provider of ['identity', 'stripe']) test(`${provider} webhook cannot admit a signed event after its signature window expires in the queue`, async t => {
  const f = await setup(t), secret = 'synthetic-webhook-secret'.repeat(3), timestamp = String(at / 1000);
  f.raw.prepare('INSERT INTO provider_identities(issuer,subject,account_id,created_at) VALUES(?,?,?,?)').run('https://auth-api.allen.company', 'alice-provider', 'alice', at);
  const body = JSON.stringify(provider === 'identity' ? { id: 'queued-webhook', issuer: 'https://auth-api.allen.company', subject: 'alice-provider', type: 'account.disabled' } : { id: 'queued-webhook', type: 'customer.subscription.updated', data: { object: { id: 'sub_test' } } });
  const signature = await hmac(secret, timestamp + '.' + body), queued = f.queue('INSERT INTO release_webhook_events', at + 300001);
  const request = new Request('https://memory.allenlabs.org/webhooks/' + provider, { method: 'POST', body,
    headers: provider === 'identity' ? { 'x-memory-timestamp': timestamp, 'x-memory-signature': signature } : { 'stripe-signature': `t=${timestamp},v1=${signature}` } });
  let status = 200;
  try {
    if (provider === 'identity') await new Admin({ DB: f.db, IDENTITY_WEBHOOK_SECRET: secret }, f.clock).identityWebhook(request);
    else await new Billing({ DB: f.db, STRIPE_WEBHOOK_SECRET: secret }, f.clock).webhook(request);
  } catch (error) { status = error.status; }
  queued(); assert.equal(f.count('release_webhook_events'), 0);
  assert.equal(f.count('release_provider_revocations'), 0); assert.equal(f.count('release_billing_events'), 0);
  assert.equal(f.raw.prepare("SELECT disabled_at FROM accounts WHERE id='alice'").get().disabled_at, null);
  assert.equal(status, 401);
});

for (const kind of ['reauth', 'email_link']) test(`${kind} mail cannot spend the account budget when its proof expires in the execution queue`, async t => {
  const f = await setup(t); let sends = 0;
  if (kind === 'reauth') f.raw.prepare("INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES('mail-proof','session:alice','e1',?,?)").run(await digest('mail-proof'), at + 100);
  else f.raw.prepare("INSERT INTO email_challenges(id,account_id,address,domain,token_digest,expires_at) VALUES('mail-proof','alice','new@example.com','example.com',?,?)").run(await digest('mail-proof'), at + 100);
  const admin = new Admin({ DB: f.db, MAIL_FROM: 'memory@allenlabs.org', EMAIL: { send: async () => { sends++; return { messageId: 'synthetic' }; } } }, f.clock);
  const queued = f.queue('INSERT INTO release_mail_budget');
  await assert.rejects(() => admin.mail(f.token, kind === 'reauth' ? 'alice@example.com' : 'new@example.com', 'Subject', 'Proof', 'mail-proof', kind), error => error.status === 403);
  queued(); assert.equal(sends, 0); assert.equal(f.count('release_mail_budget'), 0);
});

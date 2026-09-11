import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createDatabase, NOW } from './helpers.mjs';
import { IdentityService, digestToken } from '../src/identity.ts';
import { MemoryService, MemoryDenied } from '../src/memory.ts';

// Load dynamically so the initial test fails as an absent feature, rather than
// an import-time crash. Every behavior below uses the real SQLite schemas.
let WorkspaceService, WorkspaceError;
if (existsSync(new URL('../src/workspace.ts', import.meta.url))) {
  ({ WorkspaceService, WorkspaceError } = await import('../src/workspace.ts'));
}
function fixture(t) {
  assert.equal(typeof WorkspaceService, 'function', 'workspace product service is implemented');
  const f = createDatabase({ workspace: true });
  t.after(f.close);
  let at = NOW;
  return { ...f, clock: () => at, setNow: value => { at = value; },
    service: new WorkspaceService(f.db, () => at), identity: new IdentityService(f.db, () => at) };
}
const principal = (subject = 'alice', overrides = {}) => ({ issuer: 'https://auth.allen.company', subject,
  email: `${subject}@corp.example`, emailVerified: true, displayName: subject,
  expiresAt: NOW + 3_600_000, permission: 'write', ...overrides });
const denied = fn => assert.rejects(fn, error => error instanceof WorkspaceError && [400, 401, 403, 409].includes(error.status));
const one = (f, sql, ...values) => f.raw.prepare(sql).get(...values);
const count = (f, table) => one(f, `SELECT count(*) AS n FROM ${table}`).n;
async function user(f, name = 'alice', overrides = {}) {
  const session = await f.service.signIn(principal(name, overrides));
  return { ...session, snapshot: await f.service.snapshot(session.token) };
}
async function organization(f, actor, name = 'Research') {
  return f.service.createOrganization(actor.token, { name, emailId: actor.snapshot.account.emails[0].id });
}
async function join(f, owner, org, member, role = 'member') {
  const invite = await f.service.createInvite(owner.token, org.id,
    { email: member.snapshot.account.emails[0].address, role });
  await f.service.acceptInvite(member.token, invite.token);
  return (await f.service.snapshot(member.token)).organizations.find(row => row.id === org.id);
}

test('sign-in atomically maps exact issuer and subject and provisions one personal Space', async t => {
  const f = fixture(t);
  const alice = await user(f);
  const again = await user(f);
  assert.equal(alice.accountId, again.accountId);
  assert.notEqual(alice.token, again.token);
  assert.equal(alice.expiresAt, NOW + 900_000);
  assert.deepEqual(alice.snapshot.spaces.map(({ name, organizationId, canWrite }) => ({ name, organizationId, canWrite })),
    [{ name: 'Personal', organizationId: null, canWrite: true }]);
  assert.equal(count(f, 'accounts'), 1);
  assert.equal(count(f, 'spaces'), 1);
  assert.equal(count(f, 'account_emails'), 1);
  assert.equal(one(f, 'SELECT reauthenticated_at FROM credentials').reauthenticated_at, null);
  const otherIssuer = await user(f, 'alice', { issuer: 'https://other.example' });
  assert.notEqual(otherIssuer.accountId, alice.accountId);
  assert.equal(otherIssuer.snapshot.account.emails.length, 0);
  await assert.rejects(() => f.identity.beginEmailLink(alice.token, 'new@corp.example', async () => {}));
  assert.ok(f.primaryReads.length > 0);
});

test('sign-in storage failure rolls back account, mapping, credential and personal Space', async t => {
  const f = fixture(t);
  f.raw.exec(`CREATE TRIGGER fail_personal_space BEFORE INSERT ON spaces
    BEGIN SELECT RAISE(ABORT,'private database details'); END;`);
  await assert.rejects(() => f.service.signIn(principal()), error => error instanceof WorkspaceError && !error.message.includes('private database'));
  for (const table of ['accounts', 'credentials', 'spaces', 'account_emails']) assert.equal(count(f, table), 0);
  f.raw.exec('DROP TRIGGER fail_personal_space');
  assert.equal((await user(f)).snapshot.spaces.length, 1);
});

test('external bearer verification reuses its digest credential and never resurrects revoked or expired tokens', async t => {
  const f = fixture(t);
  const token = 'verified-provider-jwt.' + 'a'.repeat(2000);
  const first = await f.service.signIn(principal(), token);
  const again = await f.service.signIn(principal(), token);
  assert.deepEqual(again, first);
  assert.equal(first.token, token);
  assert.equal(count(f, 'credentials'), 1);
  assert.equal(count(f, 'workspace_sign_ins'), 1);
  assert.equal(one(f, 'SELECT length(token_digest) AS n FROM credentials').n, 64);
  await denied(() => f.service.signIn(principal('bob'), token));
  f.raw.prepare('UPDATE credentials SET revoked_at=?').run(NOW);
  await denied(() => f.service.signIn(principal(), token));
  assert.equal(count(f, 'credentials'), 1);
  const expiring = 'verified-provider-jwt.' + 'b'.repeat(2000);
  await f.service.signIn(principal(), expiring);
  f.setNow(NOW + 900_000);
  await denied(() => f.service.signIn(principal(), expiring));
  assert.equal(count(f, 'credentials'), 2);
});

test('sign-in validates proof bounds, never exceeds provider expiry and keeps read permission', async t => {
  const f = fixture(t);
  for (const patch of [{ subject: '' }, { issuer: '' }, { expiresAt: NOW }, { expiresAt: NaN }, { permission: 'admin' }])
    await denied(() => f.service.signIn(principal('alice', patch)));
  await denied(() => f.service.signIn(principal(), 'x'.repeat(8193)));
  const alice = await user(f, 'alice', { expiresAt: NOW + 5000, permission: 'read', emailVerified: false });
  assert.equal(alice.expiresAt, NOW + 5000);
  assert.equal(alice.snapshot.account.emails.length, 0);
  assert.equal(alice.snapshot.spaces[0].canWrite, false);
  await denied(() => f.service.issueKey(alice.token, { label: 'escalation', permission: 'write', expiresInDays: 1 }));
  const key = await f.service.issueKey(alice.token, { label: 'reader', permission: 'read', expiresInDays: 1 });
  assert.equal(one(f, 'SELECT permission FROM credentials WHERE id=?', key.id).permission, 'read');
  f.setNow(NOW + 5000);
  await denied(() => f.service.snapshot(alice.token));
});

test('SSO email collisions never merge accounts and fresh claims never restore revoked memberships', async t => {
  const f = fixture(t);
  const alice = await user(f);
  const org = await organization(f, alice);
  const key = await f.service.issueKey(alice.token, { label: 'worker', organizationId: org.id, permission: 'write', expiresInDays: 30 });
  const bob = await user(f, 'bob', { email: 'ALICE@CORP.EXAMPLE' });
  assert.notEqual(bob.accountId, alice.accountId);
  assert.equal(bob.snapshot.account.emails.length, 0);
  f.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE account_id=?').run(NOW, alice.accountId);
  const newAlice = await user(f);
  assert.equal(newAlice.accountId, alice.accountId);
  assert.notEqual(newAlice.snapshot.account.emails[0].id, alice.snapshot.account.emails[0].id);
  assert.equal(newAlice.snapshot.organizations.length, 0);
  assert.equal(one(f, 'SELECT revoked_at FROM credentials WHERE id=?', key.id).revoked_at, NOW);
  assert.equal(one(f, 'SELECT revoked_at FROM memberships WHERE organization_id=?', org.id).revoked_at, NOW);
});

test('permanent domain blocks prevent SSO claims without blocking personal account sign-in', async t => {
  const f = fixture(t);
  const owner = await user(f, 'owner');
  const org = await organization(f, owner);
  const membership = (await f.service.snapshot(owner.token)).organizations[0].membershipId;
  f.raw.prepare('INSERT INTO domains(id,organization_id,name,verified_until) VALUES(?,?,?,?)').run('domain', org.id, 'corp.example', NOW + 3_600_000);
  f.raw.prepare('INSERT INTO domain_managers(domain_id,membership_id) VALUES(?,?)').run('domain', membership);
  f.raw.prepare('UPDATE credentials SET reauthenticated_at=? WHERE account_id=?').run(NOW, owner.accountId);
  await f.identity.revokeDomainEmail(owner.token, 'domain', 'alice@corp.example');
  assert.equal((await user(f)).snapshot.account.emails.length, 0);
});

test('organization creation binds the selected live claim and atomically stores the default Space', async t => {
  const f = fixture(t); const alice = await user(f); const bob = await user(f, 'bob');
  await denied(() => f.service.createOrganization(alice.token, { name: 'stolen', emailId: bob.snapshot.account.emails[0].id }));
  for (const name of ['', ' ', 'x'.repeat(101), 'hello\0world'])
    await denied(() => f.service.createOrganization(alice.token, { name, emailId: alice.snapshot.account.emails[0].id }));
  const org = await organization(f, alice, 'Lab Alpha');
  const snapshot = await f.service.snapshot(alice.token);
  assert.equal(snapshot.organizations[0].role, 'owner');
  assert.equal(snapshot.organizations[0].name, 'Lab Alpha');
  assert.equal(snapshot.spaces.find(space => space.id === org.spaceId).name, 'Lab Alpha');
  assert.equal(one(f, 'SELECT email_id FROM memberships WHERE organization_id=?', org.id).email_id, alice.snapshot.account.emails[0].id);
  assert.equal((await f.service.snapshot(bob.token)).organizations.length, 0);
  assert.equal((await f.service.snapshot(bob.token)).spaces.length, 1);
});

test('invitations require exact verified email, store digest only, and are single-use', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const bob = await user(f, 'bob'); const other = await user(f, 'other');
  const org = await organization(f, owner);
  const invite = await f.service.createInvite(owner.token, org.id, { email: ' BOB@CORP.EXAMPLE ', role: 'admin' });
  assert.equal(invite.expiresAt, NOW + 259_200_000);
  assert.notEqual(one(f, 'SELECT token_digest FROM workspace_invitations').token_digest, invite.token);
  await denied(() => f.service.acceptInvite(other.token, invite.token));
  assert.deepEqual(await f.service.acceptInvite(bob.token, invite.token), { organizationId: org.id });
  assert.equal((await f.service.snapshot(bob.token)).organizations[0].role, 'admin');
  await denied(() => f.service.acceptInvite(bob.token, invite.token));
  assert.equal(count(f, 'memberships'), 2);
});

test('invitations fail after creator revocation, role downgrade, organization disablement, or expiry', async t => {
  for (const invalidation of ['revoke', 'downgrade', 'disable', 'expire']) {
    const f = fixture(t); const owner = await user(f, 'owner'); const admin = await user(f, 'admin'); const bob = await user(f, 'bob');
    const org = await organization(f, owner); const adminMember = await join(f, owner, org, admin, 'admin');
    const invite = await f.service.createInvite(admin.token, org.id, { email: 'bob@corp.example', role: 'member' });
    if (invalidation === 'revoke') await f.service.revokeMembership(owner.token, org.id, adminMember.membershipId);
    if (invalidation === 'downgrade') f.raw.prepare("UPDATE memberships SET role='member' WHERE id=?").run(adminMember.membershipId);
    if (invalidation === 'disable') f.raw.prepare('UPDATE organizations SET disabled_at=? WHERE id=?').run(NOW, org.id);
    if (invalidation === 'expire') {
      f.setNow(invite.expiresAt);
      bob.token = (await f.service.signIn(principal('bob', { expiresAt: invite.expiresAt + 3_600_000 }))).token;
    }
    await denied(() => f.service.acceptInvite(bob.token, invite.token));
    assert.equal(count(f, 'memberships'), 2);
  }
});

test('members cannot invite, cross-tenant actions fail, and admins cannot grant ownership', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const bob = await user(f, 'bob'); const outsider = await user(f, 'outside');
  const org = await organization(f, owner); await join(f, owner, org, bob);
  await denied(() => f.service.createInvite(bob.token, org.id, { email: 'next@corp.example', role: 'member' }));
  await denied(() => f.service.createInvite(outsider.token, org.id, { email: 'next@corp.example', role: 'member' }));
  await denied(() => f.service.createInvite(owner.token, org.id, { email: 'next@corp.example', role: 'owner' }));
});

test('membership revocation checks actor authority, protects owners, and cascades exact keys', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const admin = await user(f, 'admin'); const member = await user(f, 'member');
  const org = await organization(f, owner); await join(f, owner, org, admin, 'admin'); const target = await join(f, owner, org, member);
  const ownerMembership = (await f.service.snapshot(owner.token)).organizations[0].membershipId;
  const key = await f.service.issueKey(member.token, { label: 'org agent', organizationId: org.id, permission: 'read', expiresInDays: 30 });
  const personal = await f.service.issueKey(member.token, { label: 'personal agent', permission: 'read', expiresInDays: 30 });
  await denied(() => f.service.revokeMembership(admin.token, org.id, ownerMembership));
  await denied(() => f.service.revokeMembership(owner.token, org.id, ownerMembership));
  await denied(() => f.service.revokeMembership(member.token, org.id, target.membershipId));
  await f.service.revokeMembership(admin.token, org.id, target.membershipId);
  assert.equal(one(f, 'SELECT revoked_at FROM credentials WHERE id=?', key.id).revoked_at, NOW);
  assert.equal(one(f, 'SELECT revoked_at FROM credentials WHERE id=?', personal.id).revoked_at, null);
  assert.equal((await f.service.snapshot(member.token)).organizations.length, 0);
  await denied(() => f.service.revokeMembership(admin.token, org.id, target.membershipId));
});

test('machine keys are digest-only, account or exact membership bound, and cannot administer workspaces', async t => {
  const f = fixture(t); const alice = await user(f); const bob = await user(f, 'bob'); const org = await organization(f, alice);
  const personal = await f.service.issueKey(alice.token, { label: 'Laptop', permission: 'write', expiresInDays: 90 });
  const organizationKey = await f.service.issueKey(alice.token, { label: 'CI', organizationId: org.id, permission: 'read', expiresInDays: 1 });
  assert.equal(personal.token.length, 64);
  assert.equal(personal.expiresAt, NOW + 7_776_000_000);
  assert.equal(organizationKey.expiresAt, NOW + 86_400_000);
  const personalRow = one(f, 'SELECT * FROM credentials WHERE id=?', personal.id);
  assert.equal(personalRow.kind, 'personal_key'); assert.equal(personalRow.membership_id, null); assert.equal(personalRow.email_id, null);
  assert.notEqual(personalRow.token_digest, personal.token);
  assert.equal(one(f, 'SELECT id FROM active_credentials WHERE id=?', personal.id).id, personal.id);
  const orgRow = one(f, 'SELECT * FROM credentials WHERE id=?', organizationKey.id);
  assert.equal(orgRow.kind, 'api_key'); assert.equal(orgRow.email_id, alice.snapshot.account.emails[0].id);
  const snapshot = await f.service.snapshot(alice.token);
  assert.equal(snapshot.keys.length, 2);
  assert.equal((await f.service.snapshot(bob.token)).keys.length, 0);
  assert.ok(!JSON.stringify(snapshot).includes('token_digest'));
  for (const key of [personal, organizationKey]) {
    await denied(() => f.service.snapshot(key.token));
    await denied(() => f.service.createOrganization(key.token, { name: 'Denied', emailId: alice.snapshot.account.emails[0].id }));
    await denied(() => f.service.issueKey(key.token, { label: 'chained', permission: 'read', expiresInDays: 1 }));
    await denied(() => f.service.createInvite(key.token, org.id, { email: 'bob@corp.example', role: 'member' }));
    await denied(() => f.service.revokeKey(key.token, personal.id));
    await assert.rejects(() => f.identity.getAccount(key.token));
  }
  await denied(() => f.service.issueKey(bob.token, { label: 'intruder', organizationId: org.id, permission: 'read', expiresInDays: 1 }));
});

test('key issuance validates label, lifetime and permission and rolls back on metadata failure', async t => {
  const f = fixture(t); const alice = await user(f);
  for (const patch of [{ label: '' }, { label: 'x'.repeat(101) }, { label: 'x\0y' }, { expiresInDays: 0 },
    { expiresInDays: 91 }, { expiresInDays: 1.5 }, { permission: 'admin' }])
    await denied(() => f.service.issueKey(alice.token, { label: 'valid', permission: 'read', expiresInDays: 1, ...patch }));
  f.raw.exec(`CREATE TRIGGER fail_key_metadata BEFORE INSERT ON workspace_key_metadata
    BEGIN SELECT RAISE(ABORT,'metadata private failure'); END;`);
  await denied(() => f.service.issueKey(alice.token, { label: 'failure', permission: 'read', expiresInDays: 1 }));
  assert.equal(count(f, 'credentials'), 1);
});

test('key revocation allows issuer or live org admin, rejects unrelated accounts and is audited', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member'); const outside = await user(f, 'outside');
  const org = await organization(f, owner); await join(f, owner, org, member);
  const orgKey = await f.service.issueKey(member.token, { label: 'agent', organizationId: org.id, permission: 'read', expiresInDays: 1 });
  const personal = await f.service.issueKey(member.token, { label: 'private', permission: 'write', expiresInDays: 1 });
  await denied(() => f.service.revokeKey(outside.token, orgKey.id));
  await denied(() => f.service.revokeKey(owner.token, personal.id));
  await f.service.revokeKey(owner.token, orgKey.id);
  await f.service.revokeKey(member.token, personal.id);
  assert.equal(one(f, 'SELECT revoked_at FROM credentials WHERE id=?', orgKey.id).revoked_at, NOW);
  assert.equal(one(f, 'SELECT revoked_at FROM credentials WHERE id=?', personal.id).revoked_at, NOW);
  assert.equal(count(f, 'audit_events'), 2);
  assert.equal((await f.service.snapshot(member.token)).keys.filter(k => k.revokedAt === NOW).length, 2);
  await denied(() => f.service.revokeKey(member.token, personal.id));
});

test('disabled account and expired membership are checked on each workspace action', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const org = await organization(f, owner); const membership = await join(f, owner, org, member);
  f.raw.prepare('UPDATE memberships SET expires_at=? WHERE id=?').run(NOW, membership.membershipId);
  assert.equal((await f.service.snapshot(member.token)).organizations.length, 0);
  await denied(() => f.service.issueKey(member.token, { label: 'expired', organizationId: org.id, permission: 'read', expiresInDays: 1 }));
  f.raw.prepare('UPDATE accounts SET disabled_at=? WHERE id=?').run(NOW, owner.accountId);
  await denied(() => f.service.snapshot(owner.token));
  await denied(() => f.service.signIn(principal('owner')));
  await denied(() => f.service.createInvite(owner.token, org.id, { email: 'other@corp.example', role: 'member' }));
});

test('snapshot write capabilities reflect the live organization role and provider permission', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const org = await organization(f, owner); const membership = await join(f, owner, org, member);
  let snapshot = await f.service.snapshot(member.token);
  assert.equal(snapshot.spaces.find(s => s.organizationId === null).canWrite, true);
  assert.equal(snapshot.spaces.find(s => s.organizationId === org.id).canWrite, false);
  await denied(() => f.service.issueKey(member.token, { label: 'Escalation', organizationId: org.id, permission: 'write', expiresInDays: 1 }));
  f.raw.prepare("UPDATE memberships SET role='admin' WHERE id=?").run(membership.membershipId);
  snapshot = await f.service.snapshot(member.token);
  assert.equal(snapshot.spaces.find(s => s.organizationId === org.id).canWrite, true);
  const readSession = await user(f, 'member', { permission: 'read' });
  assert.ok(readSession.snapshot.spaces.every(s => s.canWrite === false));
});

test('provider bearer sessions cannot administer even when passed directly to WorkspaceService', async t => {
  const f = fixture(t); const alice = await user(f); const org = await organization(f, alice);
  const external = await f.service.signIn(principal(), 'external-bearer.' + 'c'.repeat(200));
  await denied(() => f.service.snapshot(external.token));
  await denied(() => f.service.createOrganization(external.token, { name: 'Forbidden', emailId: alice.snapshot.account.emails[0].id }));
  await denied(() => f.service.createInvite(external.token, org.id, { email: 'bob@corp.example', role: 'member' }));
  await denied(() => f.service.issueKey(external.token, { label: 'Forbidden', permission: 'read', expiresInDays: 1 }));
  const credential = one(f, 'SELECT id FROM credentials WHERE token_digest=?', await digestToken(external.token));
  assert.throws(() => f.raw.prepare(`INSERT INTO workspace_key_issuances
    (id,actor_credential_id,label,permission,token_digest,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`)
    .run('attempt', credential.id, 'Forbidden', 'read', 'a'.repeat(64), NOW, NOW + 86_400_000));
});

test('workspace transaction records and metadata cannot be replaced, edited, or deleted', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const org = await organization(f, owner); await join(f, owner, org, member);
  const key = await f.service.issueKey(owner.token, { label: 'Immutable', permission: 'read', expiresInDays: 1 });
  await f.service.revokeKey(owner.token, key.id);
  const membership = (await f.service.snapshot(member.token)).organizations[0].membershipId;
  await f.service.revokeMembership(owner.token, org.id, membership);
  for (const recursive of ['ON', 'OFF']) {
    f.raw.exec(`PRAGMA recursive_triggers=${recursive}`);
    for (const table of ['provider_identities','workspace_sign_ins','workspace_organization_creations',
      'workspace_organization_metadata','workspace_invitations','workspace_invitation_acceptances','workspace_key_issuances',
      'workspace_key_metadata','workspace_membership_revocations','workspace_key_revocations','workspace_audit_events']) {
      const row = one(f, `SELECT * FROM ${table} LIMIT 1`); assert.ok(row, `${table} has a transaction record`);
      const field = Object.keys(row)[0];
      assert.throws(() => f.raw.exec(`UPDATE ${table} SET ${field}=${field} || '-tampered'`), `${table} cannot be updated`);
      assert.throws(() => f.raw.exec(`DELETE FROM ${table}`), `${table} cannot be deleted`);
      assert.throws(() => f.raw.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`), `${table} cannot be replaced`);
    }
  }
});

test('simultaneous verified sign-ins reuse one mapping and external credential', async t => {
  const f = fixture(t);
  const token = 'provider-proof.' + 'q'.repeat(150);
  const sessions = await Promise.all(Array.from({ length: 8 }, () => f.service.signIn(principal(), token)));
  assert.ok(sessions.every(session => session.accountId === sessions[0].accountId));
  assert.equal(count(f, 'accounts'), 1); assert.equal(count(f, 'provider_identities'), 1);
  assert.equal(count(f, 'credentials'), 1); assert.equal(count(f, 'account_emails'), 1); assert.equal(count(f, 'spaces'), 1);
});

test('competing acceptance requests consume an invitation exactly once', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const bob = await user(f, 'bob'); const org = await organization(f, owner);
  const invite = await f.service.createInvite(owner.token, org.id, { email: 'bob@corp.example', role: 'member' });
  const results = await Promise.allSettled([f.service.acceptInvite(bob.token, invite.token), f.service.acceptInvite(bob.token, invite.token)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(count(f, 'memberships'), 2); assert.equal(count(f, 'workspace_invitation_acceptances'), 1);
});

test('workspace mutations recheck authorization in the write after the request has started', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const org = await organization(f, owner);
  const originalPrepare = f.db.prepare.bind(f.db);
  let revoked = false;
  f.db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (/INSERT INTO workspace_invitations/.test(sql)) {
      const originalRun = statement.run.bind(statement);
      statement.run = async () => {
        f.raw.prepare('UPDATE memberships SET revoked_at=? WHERE organization_id=?').run(NOW, org.id);
        revoked = true;
        return originalRun();
      };
    }
    return statement;
  };
  await denied(() => f.service.createInvite(owner.token, org.id, { email: 'bob@corp.example', role: 'member' }));
  assert.equal(revoked, true); assert.equal(count(f, 'workspace_invitations'), 0);
});

test('membership and key revocations roll back together with mandatory product audit', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const org = await organization(f, owner); const membership = await join(f, owner, org, member);
  const key = await f.service.issueKey(member.token, { label: 'Reader', organizationId: org.id, permission: 'read', expiresInDays: 1 });
  f.raw.exec(`CREATE TRIGGER audit_failure BEFORE INSERT ON workspace_audit_events
    WHEN NEW.action IN ('membership_revoked','key_revoked') BEGIN SELECT RAISE(ABORT,'private audit failure'); END;`);
  await denied(() => f.service.revokeMembership(owner.token, org.id, membership.membershipId));
  assert.equal(one(f, 'SELECT revoked_at FROM memberships WHERE id=?', membership.membershipId).revoked_at, null);
  assert.equal(one(f, 'SELECT revoked_at FROM credentials WHERE id=?', key.id).revoked_at, null);
  await denied(() => f.service.revokeKey(owner.token, key.id));
  assert.equal(one(f, 'SELECT revoked_at FROM credentials WHERE id=?', key.id).revoked_at, null);
  assert.equal(count(f, 'workspace_membership_revocations'), 0); assert.equal(count(f, 'workspace_key_revocations'), 0);
  assert.equal(count(f, 'audit_events'), 0);
});

test('issued machine keys obey memory permission, tenant, expiry and membership revocation', async t => {
  const f = fixture(t); const alice = await user(f); const bob = await user(f, 'bob'); const org = await organization(f, alice);
  const memory = new MemoryService(f.db, f.clock);
  const personalSpace = alice.snapshot.spaces[0].id;
  const privateMemory = await memory.create(alice.token, personalSpace, { body: 'Private note' });
  const sharedMemory = await memory.create(alice.token, org.spaceId, { body: 'Shared note' });
  const personal = await f.service.issueKey(alice.token, { label: 'Reader', permission: 'read', expiresInDays: 1 });
  const orgKey = await f.service.issueKey(alice.token, { label: 'Writer', organizationId: org.id, permission: 'write', expiresInDays: 2 });
  assert.equal((await memory.get(personal.token, personalSpace, privateMemory.id)).body, 'Private note');
  await assert.rejects(() => memory.create(personal.token, personalSpace, { body: 'Escalation' }), MemoryDenied);
  await assert.rejects(() => memory.get(personal.token, org.spaceId, sharedMemory.id), MemoryDenied);
  await assert.rejects(() => memory.get(orgKey.token, personalSpace, privateMemory.id), MemoryDenied);
  await assert.rejects(() => memory.list(personal.token, bob.snapshot.spaces[0].id), MemoryDenied);
  assert.equal((await memory.update(orgKey.token, org.spaceId, sharedMemory.id, { body: 'Updated shared note', expectedRevision: 1 })).revision, 2);
  f.setNow(personal.expiresAt);
  await assert.rejects(() => memory.get(personal.token, personalSpace, privateMemory.id), MemoryDenied);
  assert.equal((await memory.get(orgKey.token, org.spaceId, sharedMemory.id)).revision, 2);
  f.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE id=?').run(personal.expiresAt, alice.snapshot.account.emails[0].id);
  await assert.rejects(() => memory.get(orgKey.token, org.spaceId, sharedMemory.id), MemoryDenied);
});

test('member directory is a fresh admin-only view of exact live organization memberships', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const admin = await user(f, 'admin');
  const member = await user(f, 'member'); const outsider = await user(f, 'outsider');
  const org = await organization(f, owner); const otherOrg = await organization(f, outsider, 'Other organization');
  const adminMembership = await join(f, owner, org, admin, 'admin'); const memberMembership = await join(f, owner, org, member);
  assert.equal(typeof f.service.listMembers, 'function', 'admin member directory is implemented');
  const expectedAccounts = [owner.accountId, admin.accountId, member.accountId].sort();
  const members = await f.service.listMembers(owner.token, org.id);
  assert.deepEqual(members.map(row => row.accountId).sort(), expectedAccounts);
  assert.deepEqual(Object.keys(members[0]).sort(), ['accountId','email','expiresAt','id','role']);
  assert.deepEqual(members.map(row => row.email).sort(), ['admin@corp.example','member@corp.example','owner@corp.example']);
  assert.equal(members.find(row => row.accountId === member.accountId).id, memberMembership.membershipId);
  assert.deepEqual((await f.service.listMembers(admin.token, org.id)).map(row => row.accountId).sort(), expectedAccounts);
  await denied(() => f.service.listMembers(member.token, org.id));
  await denied(() => f.service.listMembers(outsider.token, org.id));
  await denied(() => f.service.listMembers(owner.token, otherOrg.id));
  await denied(() => f.service.listMembers(owner.token, 'not-an-organization'));
  const personalKey = await f.service.issueKey(owner.token, { label: 'Personal', permission: 'read', expiresInDays: 1 });
  const orgKey = await f.service.issueKey(owner.token, { label: 'Org', organizationId: org.id, permission: 'read', expiresInDays: 1 });
  const external = await f.service.signIn(principal('owner'), 'verified-external.' + 'r'.repeat(200));
  for (const token of [personalKey.token, orgKey.token, external.token]) await denied(() => f.service.listMembers(token, org.id));
  f.raw.prepare("UPDATE memberships SET role='member' WHERE id=?").run(adminMembership.membershipId);
  await denied(() => f.service.listMembers(admin.token, org.id));
  await f.service.revokeMembership(owner.token, org.id, memberMembership.membershipId);
  assert.deepEqual((await f.service.listMembers(owner.token, org.id)).map(row => row.accountId).sort(), [owner.accountId, admin.accountId].sort());
  f.raw.prepare('UPDATE memberships SET expires_at=? WHERE id=?').run(NOW, adminMembership.membershipId);
  assert.equal((await f.service.listMembers(owner.token, org.id)).length, 1);
  f.raw.prepare('UPDATE credentials SET revoked_at=? WHERE account_id=?').run(NOW, owner.accountId);
  await denied(() => f.service.listMembers(owner.token, org.id));
});

test('organizations can nest deeply without a product depth cap while roots retain null parent metadata', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const root = await organization(f, owner, 'Root');
  let parent = root; const ancestry = new Map([[root.id, null]]);
  for (let depth = 1; depth <= 128; depth++) {
    const child = await f.service.createOrganization(owner.token, {
      name: `Level ${depth}`, emailId: owner.snapshot.account.emails[0].id, parentOrganizationId: parent.id,
    });
    ancestry.set(child.id, parent.id); parent = child;
  }
  const snapshot = await f.service.snapshot(owner.token);
  assert.equal(snapshot.organizations.length, 129);
  for (const org of snapshot.organizations) assert.equal(org.parentId, ancestry.get(org.id));
  assert.equal(count(f, 'organization_hierarchy'), 128);
});

test('parent and child organizations grant no inherited membership, memory or key authority', async t => {
  const f = fixture(t); const rootOwner = await user(f, 'root-owner'); const creator = await user(f, 'creator'); const childOnly = await user(f, 'child-only');
  const parent = await organization(f, rootOwner, 'Private parent'); await join(f, rootOwner, parent, creator, 'admin');
  const child = await f.service.createOrganization(creator.token, {
    name: 'Independent child', emailId: creator.snapshot.account.emails[0].id, parentOrganizationId: parent.id,
  });
  assert.equal((await f.service.snapshot(creator.token)).organizations.find(org => org.id === child.id).role, 'owner');
  await join(f, creator, child, childOnly, 'admin');
  const rootSnapshot = await f.service.snapshot(rootOwner.token);
  assert.deepEqual(rootSnapshot.organizations.map(org => org.id), [parent.id]);
  assert.ok(rootSnapshot.spaces.every(space => space.organizationId !== child.id));
  const childSnapshot = await f.service.snapshot(childOnly.token);
  assert.equal(childSnapshot.organizations.length, 1); assert.equal(childSnapshot.organizations[0].parentId, null);
  assert.ok(!JSON.stringify(childSnapshot).includes('Private parent'));
  assert.ok(!JSON.stringify(childSnapshot).includes(parent.id));
  const memory = new MemoryService(f.db, f.clock);
  const parentRecord = await memory.create(rootOwner.token, parent.spaceId, { body: 'Parent data' });
  const childRecord = await memory.create(creator.token, child.spaceId, { body: 'Child data' });
  await assert.rejects(() => memory.get(rootOwner.token, child.spaceId, childRecord.id), MemoryDenied);
  await assert.rejects(() => memory.get(childOnly.token, parent.spaceId, parentRecord.id), MemoryDenied);
  await denied(() => f.service.listMembers(rootOwner.token, child.id));
  await denied(() => f.service.listMembers(childOnly.token, parent.id));
  await denied(() => f.service.issueKey(rootOwner.token, { label: 'Inherited access', organizationId: child.id, permission: 'read', expiresInDays: 1 }));
  await denied(() => f.service.createInvite(rootOwner.token, child.id, { email: 'outside@corp.example', role: 'member' }));
  const parentKey = await f.service.issueKey(rootOwner.token, { label: 'Parent key', organizationId: parent.id, permission: 'write', expiresInDays: 1 });
  await assert.rejects(() => memory.get(parentKey.token, child.spaceId, childRecord.id), MemoryDenied);
  const grandchild = await f.service.createOrganization(childOnly.token, {
    name: 'Grandchild', emailId: childOnly.snapshot.account.emails[0].id, parentOrganizationId: child.id,
  });
  assert.equal((await f.service.snapshot(childOnly.token)).organizations.find(org => org.id === grandchild.id).parentId, child.id);
  assert.ok((await f.service.snapshot(creator.token)).organizations.every(org => org.id !== grandchild.id));
});

test('child creation requires current parent administration and the creator own verified claim', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member'); const outsider = await user(f, 'outside');
  const parent = await organization(f, owner); const membership = await join(f, owner, parent, member);
  const input = { name: 'Child', emailId: member.snapshot.account.emails[0].id, parentOrganizationId: parent.id };
  await denied(() => f.service.createOrganization(member.token, input));
  await denied(() => f.service.createOrganization(outsider.token, { ...input, emailId: outsider.snapshot.account.emails[0].id }));
  await denied(() => f.service.createOrganization(owner.token, input));
  await denied(() => f.service.createOrganization(owner.token, { ...input, emailId: owner.snapshot.account.emails[0].id, parentOrganizationId: 'missing' }));
  for (const invalidParent of ['', null, 'bad/id'])
    await denied(() => f.service.createOrganization(owner.token, { ...input, parentOrganizationId: invalidParent }));
  f.raw.prepare("UPDATE memberships SET role='admin' WHERE id=?").run(membership.membershipId);
  const key = await f.service.issueKey(member.token, { label: 'Parent agent', organizationId: parent.id, permission: 'write', expiresInDays: 1 });
  const external = await f.service.signIn(principal('member'), 'external-hierarchy.' + 'h'.repeat(150));
  for (const token of [key.token, external.token]) await denied(() => f.service.createOrganization(token, input));
  f.raw.prepare('UPDATE memberships SET expires_at=? WHERE id=?').run(NOW, membership.membershipId);
  await denied(() => f.service.createOrganization(member.token, input));
  f.raw.prepare('UPDATE organizations SET disabled_at=? WHERE id=?').run(NOW, parent.id);
  await denied(() => f.service.createOrganization(owner.token, { ...input, emailId: owner.snapshot.account.emails[0].id }));
  assert.equal(count(f, 'organizations'), 1);
});

test('child membership and keys remain independent when parent email or organization is revoked', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const creator = await user(f, 'creator');
  const parent = await organization(f, owner); await join(f, owner, parent, creator, 'admin');
  f.raw.prepare('INSERT INTO account_emails(id,account_id,address,domain,verified_at) VALUES(?,?,?,?,?)')
    .run('creator-child-email', creator.accountId, 'creator@personal.example', 'personal.example', NOW);
  const child = await f.service.createOrganization(creator.token, { name: 'Child', emailId: 'creator-child-email', parentOrganizationId: parent.id });
  const key = await f.service.issueKey(creator.token, { label: 'Child key', organizationId: child.id, permission: 'write', expiresInDays: 1 });
  f.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE id=?').run(NOW, creator.snapshot.account.emails[0].id);
  f.raw.prepare('UPDATE organizations SET disabled_at=? WHERE id=?').run(NOW, parent.id);
  const snapshot = await f.service.snapshot(creator.token);
  assert.equal(snapshot.organizations.length, 1); assert.equal(snapshot.organizations[0].id, child.id);
  assert.equal(snapshot.organizations[0].parentId, null);
  const memory = new MemoryService(f.db, f.clock);
  assert.equal((await memory.create(key.token, child.spaceId, { body: 'Independent authority' })).body, 'Independent authority');
  assert.equal(one(f, 'SELECT revoked_at FROM credentials WHERE id=?', key.id).revoked_at, null);
});

test('hierarchy edges cannot self-parent, form cycles, reparent, delete or replace', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const parent = await organization(f, owner);
  const child = await f.service.createOrganization(owner.token, { name: 'Child', emailId: owner.snapshot.account.emails[0].id, parentOrganizationId: parent.id });
  assert.equal(count(f, 'organization_hierarchy'), 1);
  for (const recursion of ['ON', 'OFF']) {
    f.raw.exec(`PRAGMA recursive_triggers=${recursion}`);
    assert.throws(() => f.raw.prepare('INSERT INTO organization_hierarchy(organization_id,parent_organization_id) VALUES(?,?)').run(parent.id, parent.id));
    assert.throws(() => f.raw.prepare('INSERT INTO organization_hierarchy(organization_id,parent_organization_id) VALUES(?,?)').run(parent.id, child.id));
    assert.throws(() => f.raw.prepare('UPDATE organization_hierarchy SET parent_organization_id=? WHERE organization_id=?').run(child.id, child.id));
    assert.throws(() => f.raw.exec('DELETE FROM organization_hierarchy'));
    assert.throws(() => f.raw.exec('INSERT OR REPLACE INTO organization_hierarchy SELECT * FROM organization_hierarchy'));
    assert.throws(() => f.raw.exec("UPDATE workspace_child_organization_creations SET name='changed'"));
    assert.throws(() => f.raw.exec('DELETE FROM workspace_child_organization_creations'));
    assert.throws(() => f.raw.exec('INSERT OR REPLACE INTO workspace_child_organization_creations SELECT * FROM workspace_child_organization_creations'));
  }
  assert.equal(one(f, 'SELECT parent_organization_id FROM organization_hierarchy WHERE organization_id=?', child.id).parent_organization_id, parent.id);
});

test('child organization bootstrap and its hierarchy edge roll back atomically', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const parent = await organization(f, owner);
  assert.equal(one(f, "SELECT count(*) AS n FROM sqlite_master WHERE name='organization_hierarchy'").n, 1);
  const before = Object.fromEntries(['organizations','memberships','spaces','workspace_organization_creations','workspace_audit_events'].map(table => [table,count(f,table)]));
  f.raw.exec("CREATE TRIGGER fail_hierarchy BEFORE INSERT ON organization_hierarchy BEGIN SELECT RAISE(ABORT,'private hierarchy fault'); END;");
  await denied(() => f.service.createOrganization(owner.token, { name: 'Child', emailId: owner.snapshot.account.emails[0].id, parentOrganizationId: parent.id }));
  for (const [table,total] of Object.entries(before)) assert.equal(count(f,table),total);
  assert.equal(count(f,'workspace_child_organization_creations'),0);
});

test('the fifth forward migration preserves populated organizations, claims, memory and revocations', async t => {
  const f = createDatabase({ memory: true }); t.after(f.close);
  for (const file of ['0003_product-schema.sql', '0004_auth-schema.sql'])
    f.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const service = new WorkspaceService(f.db, () => NOW);
  const owner = await service.signIn(principal('upgrade-owner'));
  const emailId = one(f, 'SELECT id FROM account_emails WHERE account_id=?', owner.accountId).id;
  const root = await service.createOrganization(owner.token, { name: 'Existing organization', emailId });
  const key = await service.issueKey(owner.token, { label: 'Revoked before upgrade', organizationId: root.id, permission: 'write', expiresInDays: 1 });
  await service.revokeKey(owner.token, key.id);
  const memory = new MemoryService(f.db, () => NOW);
  const record = await memory.create(owner.token, root.spaceId, { body: 'Retained through upgrade' });
  const tables = ['accounts', 'account_emails', 'credentials', 'organizations', 'memberships', 'spaces', 'memories', 'workspace_audit_events'];
  const before = Object.fromEntries(tables.map(table => [table, f.raw.prepare(`SELECT * FROM ${table}`).all()]));
  f.raw.exec(readFileSync(new URL('../migrations/0005_hierarchy-schema.sql', import.meta.url), 'utf8'));
  for (const table of tables) assert.deepEqual(f.raw.prepare(`SELECT * FROM ${table}`).all(), before[table]);
  assert.equal((await service.snapshot(owner.token)).organizations[0].parentId, null);
  const child = await service.createOrganization(owner.token, { name: 'New child', emailId, parentOrganizationId: root.id });
  assert.equal((await service.snapshot(owner.token)).organizations.find(org => org.id === child.id).parentId, root.id);
  assert.equal((await memory.get(owner.token, root.spaceId, record.id)).body, 'Retained through upgrade');
  await assert.rejects(() => memory.get(key.token, root.spaceId, record.id), MemoryDenied);
  assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), []);
});

test('child creation rechecks parent authority at the write and its command trigger rejects direct bypasses', async t => {
  const f = fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const root = await organization(f, owner); const membership = await join(f, owner, root, member, 'admin');
  const originalPrepare = f.db.prepare.bind(f.db);
  let changed = false;
  f.db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (/INSERT INTO workspace_child_organization_creations/.test(sql)) {
      const originalRun = statement.run.bind(statement);
      statement.run = async () => {
        f.raw.prepare("UPDATE memberships SET role='member' WHERE id=?").run(membership.membershipId);
        changed = true; return originalRun();
      };
    }
    return statement;
  };
  const emailId = member.snapshot.account.emails[0].id;
  await denied(() => f.service.createOrganization(member.token, { name: 'Child', emailId, parentOrganizationId: root.id }));
  assert.equal(changed, true);
  const actorId = one(f, 'SELECT id FROM credentials WHERE token_digest=?', await digestToken(member.token)).id;
  const command = f.raw.prepare(`INSERT INTO workspace_child_organization_creations
    (id,parent_organization_id,name,actor_credential_id,email_id,membership_id,space_id,created_at) VALUES(?,?,?,?,?,?,?,?)`);
  assert.throws(() => command.run('direct-child', root.id, 'Bypass', actorId, emailId, 'direct-member', 'direct-space', NOW));
  f.raw.prepare("UPDATE memberships SET role='admin' WHERE id=?").run(membership.membershipId);
  assert.throws(() => command.run(root.id, root.id, 'Self', actorId, emailId, 'direct-member', 'direct-space', NOW));
  assert.throws(() => command.run('wrong-claim', root.id, 'Bypass', actorId, owner.snapshot.account.emails[0].id, 'direct-member', 'direct-space', NOW));
  f.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE id=?').run(NOW, emailId);
  assert.throws(() => command.run('revoked-claim', root.id, 'Bypass', actorId, emailId, 'direct-member', 'direct-space', NOW));
  assert.equal(count(f, 'workspace_child_organization_creations'), 0);
  assert.equal(count(f, 'organizations'), 1);
});

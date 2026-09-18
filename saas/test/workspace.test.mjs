import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createDatabase, NOW } from './helpers.mjs';
import { IdentityService, digestToken } from '../src/identity.ts';
import { MemoryService, MemoryDenied } from '../src/memory.ts';
import { createPostgresDatabase } from '../src/postgres/database.ts';

// Load dynamically so the initial test fails as an absent feature, rather than
// an import-time crash. Every behavior below uses the real PostgreSQL schemas.
let WorkspaceService, WorkspaceError;
if (existsSync(new URL('../src/workspace.ts', import.meta.url))) {
  ({ WorkspaceService, WorkspaceError } = await import('../src/workspace.ts'));
}

const TABLES = {
  accounts: 'memory_identity.accounts',
  account_emails: 'memory_identity.account_emails',
  active_credentials: 'memory_identity.active_credentials',
  audit_events: 'memory_ops.workspace_audit_events',
  credentials: 'memory_identity.credentials',
  domain_managers: 'memory_identity.domain_managers',
  domains: 'memory_identity.domains',
  memberships: 'memory_identity.memberships',
  organization_hierarchy: 'memory_identity.organization_hierarchy',
  organizations: 'memory_control.organizations',
  provider_identities: 'memory_identity.provider_identities',
  spaces: 'memory_control.spaces',
  workspace_audit_events: 'memory_ops.workspace_audit_events',
  workspace_child_organization_creations: 'memory_identity.workspace_child_organization_creations',
  workspace_invitation_acceptances: 'memory_identity.workspace_invitation_acceptances',
  workspace_invitations: 'memory_identity.workspace_invitations',
  workspace_key_issuances: 'memory_identity.workspace_key_issuances',
  workspace_key_metadata: 'memory_identity.workspace_key_metadata',
  workspace_key_revocations: 'memory_identity.workspace_key_revocations',
  workspace_membership_revocations: 'memory_identity.workspace_membership_revocations',
  workspace_organization_creations: 'memory_identity.workspace_organization_creations',
  workspace_organization_metadata: 'memory_identity.workspace_organization_metadata',
  workspace_sign_ins: 'memory_identity.workspace_sign_ins',
};
const table = name => TABLES[name] ?? name;

async function fixture(t) {
  assert.equal(typeof WorkspaceService, 'function', 'workspace product service is implemented');
  const f = await createDatabase();
  t.after(f.close);
  let at = NOW;
  return { ...f, clock: () => at, setNow: async value => { at = value; await f.setClockValue(value); },
    service: new WorkspaceService(f.db, () => at), identity: new IdentityService(f.db, () => at) };
}
const principal = (subject = 'alice', overrides = {}) => ({ issuer: 'https://auth.allen.company', subject,
  email: `${subject}@corp.example`, emailVerified: true, displayName: subject,
  expiresAt: NOW + 3_600_000, permission: 'write', ...overrides });
const denied = fn => assert.rejects(fn, error => error instanceof WorkspaceError && [400, 401, 403, 409].includes(error.status));
const one = async (f, sql, ...values) => f.raw.prepare(sql).get(...values);
const count = async (f, name) => (await one(f, `SELECT count(*) AS n FROM ${table(name)}`)).n;
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
const failingInsertTrigger = name => `
  CREATE OR REPLACE FUNCTION memory_identity.${name}_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database details'; END $$;
  CREATE TRIGGER ${name} BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION memory_identity.${name}_fn();`;

test('sign-in atomically maps exact issuer and subject and provisions one personal Space', async t => {
  const f = await fixture(t);
  const alice = await user(f);
  const again = await user(f);
  assert.equal(alice.accountId, again.accountId);
  assert.notEqual(alice.token, again.token);
  assert.equal(alice.expiresAt, NOW + 900_000);
  assert.deepEqual(alice.snapshot.spaces.map(({ name, organizationId, canWrite }) => ({ name, organizationId, canWrite })),
    [{ name: 'Personal', organizationId: null, canWrite: true }]);
  assert.equal(await count(f, 'accounts'), 1);
  assert.equal(await count(f, 'spaces'), 1);
  assert.equal(await count(f, 'account_emails'), 1);
  assert.equal((await one(f, 'SELECT reauthenticated_at FROM memory_identity.credentials')).reauthenticated_at, null);
  const otherIssuer = await user(f, 'alice', { issuer: 'https://other.example' });
  assert.notEqual(otherIssuer.accountId, alice.accountId);
  assert.equal(otherIssuer.snapshot.account.emails.length, 0);
  await assert.rejects(() => f.identity.beginEmailLink(alice.token, 'new@corp.example', async () => {}));
  assert.ok(f.primaryReads.length > 0);
});

test('sign-in storage failure rolls back account, mapping, credential and personal Space', async t => {
  const f = await fixture(t);
  await f.raw.exec(failingInsertTrigger('fail_personal_space').replace('%s', 'memory_control.spaces'));
  await assert.rejects(() => f.service.signIn(principal()), error => error instanceof WorkspaceError && !error.message.includes('private database'));
  for (const name of ['accounts', 'credentials', 'spaces', 'account_emails']) assert.equal(await count(f, name), 0);
  await f.raw.exec('DROP TRIGGER fail_personal_space ON memory_control.spaces');
  assert.equal((await user(f)).snapshot.spaces.length, 1);
});

test('external bearer verification reuses its digest credential and never resurrects revoked or expired tokens', async t => {
  const f = await fixture(t);
  const token = 'verified-provider-jwt.' + 'a'.repeat(2000);
  const first = await f.service.signIn(principal(), token);
  const again = await f.service.signIn(principal(), token);
  assert.deepEqual(again, first);
  assert.equal(first.token, token);
  assert.equal(await count(f, 'credentials'), 1);
  assert.equal(await count(f, 'workspace_sign_ins'), 1);
  assert.equal((await one(f, 'SELECT length(token_digest) AS n FROM memory_identity.credentials')).n, 64);
  await denied(() => f.service.signIn(principal('bob'), token));
  await f.raw.prepare('UPDATE memory_identity.credentials SET revoked_at=?').run(NOW);
  await denied(() => f.service.signIn(principal(), token));
  assert.equal(await count(f, 'credentials'), 1);
  const expiring = 'verified-provider-jwt.' + 'b'.repeat(2000);
  await f.service.signIn(principal(), expiring);
  await f.setNow(NOW + 900_000);
  await denied(() => f.service.signIn(principal(), expiring));
  assert.equal(await count(f, 'credentials'), 2);
});

test('sign-in validates proof bounds, never exceeds provider expiry and keeps read permission', async t => {
  const f = await fixture(t);
  for (const patch of [{ subject: '' }, { issuer: '' }, { expiresAt: NOW }, { expiresAt: NaN }, { permission: 'admin' }])
    await denied(() => f.service.signIn(principal('alice', patch)));
  await denied(() => f.service.signIn(principal(), 'x'.repeat(8193)));
  const alice = await user(f, 'alice', { expiresAt: NOW + 5000, permission: 'read', emailVerified: false });
  assert.equal(alice.expiresAt, NOW + 5000);
  assert.equal(alice.snapshot.account.emails.length, 0);
  assert.equal(alice.snapshot.spaces[0].canWrite, false);
  await denied(() => f.service.issueKey(alice.token, { label: 'escalation', permission: 'write', expiresInDays: 1 }));
  const key = await f.service.issueKey(alice.token, { label: 'reader', permission: 'read', expiresInDays: 1 });
  assert.equal((await one(f, 'SELECT permission FROM memory_identity.credentials WHERE id=?', key.id)).permission, 'read');
  await f.setNow(NOW + 5000);
  await denied(() => f.service.snapshot(alice.token));
});

test('SSO email collisions never merge accounts and fresh claims never restore revoked memberships', async t => {
  const f = await fixture(t);
  const alice = await user(f);
  const org = await organization(f, alice);
  const key = await f.service.issueKey(alice.token, { label: 'worker', organizationId: org.id, permission: 'write', expiresInDays: 30 });
  const bob = await user(f, 'bob', { email: 'ALICE@CORP.EXAMPLE' });
  assert.notEqual(bob.accountId, alice.accountId);
  assert.equal(bob.snapshot.account.emails.length, 0);
  await f.raw.prepare('UPDATE memory_identity.account_emails SET revoked_at=? WHERE account_id=?').run(NOW, alice.accountId);
  const newAlice = await user(f);
  assert.equal(newAlice.accountId, alice.accountId);
  assert.notEqual(newAlice.snapshot.account.emails[0].id, alice.snapshot.account.emails[0].id);
  assert.equal(newAlice.snapshot.organizations.length, 0);
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.credentials WHERE id=?', key.id)).revoked_at, NOW);
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.memberships WHERE organization_id=?', org.id)).revoked_at, NOW);
});

test('permanent domain blocks prevent SSO claims without blocking personal account sign-in', async t => {
  const f = await fixture(t);
  const owner = await user(f, 'owner');
  const org = await organization(f, owner);
  const membership = (await f.service.snapshot(owner.token)).organizations[0].membershipId;
  await f.raw.prepare('INSERT INTO memory_identity.domains(id,organization_id,name,verified_until) VALUES(?,?,?,?)').run('domain', org.id, 'corp.example', NOW + 3_600_000);
  await f.raw.prepare('INSERT INTO memory_identity.domain_managers(domain_id,membership_id) VALUES(?,?)').run('domain', membership);
  await f.raw.prepare('UPDATE memory_identity.credentials SET reauthenticated_at=? WHERE account_id=?').run(NOW, owner.accountId);
  await f.identity.revokeDomainEmail(owner.token, 'domain', 'alice@corp.example');
  assert.equal((await user(f)).snapshot.account.emails.length, 0);
});

test('organization creation binds the selected live claim and atomically stores the default Space', async t => {
  const f = await fixture(t); const alice = await user(f); const bob = await user(f, 'bob');
  await denied(() => f.service.createOrganization(alice.token, { name: 'stolen', emailId: bob.snapshot.account.emails[0].id }));
  for (const name of ['', ' ', 'x'.repeat(101), 'hello\0world'])
    await denied(() => f.service.createOrganization(alice.token, { name, emailId: alice.snapshot.account.emails[0].id }));
  const org = await organization(f, alice, 'Lab Alpha');
  const snapshot = await f.service.snapshot(alice.token);
  assert.equal(snapshot.organizations[0].role, 'owner');
  assert.equal(snapshot.organizations[0].name, 'Lab Alpha');
  assert.equal(snapshot.spaces.find(space => space.id === org.spaceId).name, 'Lab Alpha');
  assert.equal((await one(f, 'SELECT email_id FROM memory_identity.memberships WHERE organization_id=?', org.id)).email_id, alice.snapshot.account.emails[0].id);
  assert.equal((await f.service.snapshot(bob.token)).organizations.length, 0);
  assert.equal((await f.service.snapshot(bob.token)).spaces.length, 1);
});

test('invitations require exact verified email, store digest only, and are single-use', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const bob = await user(f, 'bob'); const other = await user(f, 'other');
  const org = await organization(f, owner);
  const invite = await f.service.createInvite(owner.token, org.id, { email: ' BOB@CORP.EXAMPLE ', role: 'admin' });
  assert.equal(invite.expiresAt, NOW + 259_200_000);
  assert.notEqual((await one(f, 'SELECT token_digest FROM memory_identity.workspace_invitations')).token_digest, invite.token);
  await denied(() => f.service.acceptInvite(other.token, invite.token));
  assert.deepEqual(await f.service.acceptInvite(bob.token, invite.token), { organizationId: org.id });
  assert.equal((await f.service.snapshot(bob.token)).organizations[0].role, 'admin');
  await denied(() => f.service.acceptInvite(bob.token, invite.token));
  assert.equal(await count(f, 'memberships'), 2);
});

test('invitations fail after creator revocation, role downgrade, organization disablement, or expiry', async t => {
  for (const invalidation of ['revoke', 'downgrade', 'disable', 'expire']) {
    const f = await fixture(t); const owner = await user(f, 'owner'); const admin = await user(f, 'admin'); const bob = await user(f, 'bob');
    const org = await organization(f, owner); const adminMember = await join(f, owner, org, admin, 'admin');
    const invite = await f.service.createInvite(admin.token, org.id, { email: 'bob@corp.example', role: 'member' });
    if (invalidation === 'revoke') await f.service.revokeMembership(owner.token, org.id, adminMember.membershipId);
    if (invalidation === 'downgrade') await f.raw.prepare("UPDATE memory_identity.memberships SET role='member' WHERE id=?").run(adminMember.membershipId);
    if (invalidation === 'disable') await f.raw.prepare('UPDATE memory_control.organizations SET disabled_at=? WHERE id=?').run(NOW, org.id);
    if (invalidation === 'expire') {
      await f.setNow(invite.expiresAt);
      bob.token = (await f.service.signIn(principal('bob', { expiresAt: invite.expiresAt + 3_600_000 }))).token;
    }
    await denied(() => f.service.acceptInvite(bob.token, invite.token));
    assert.equal(await count(f, 'memberships'), 2);
  }
});

test('members cannot invite, cross-tenant actions fail, and admins cannot grant ownership', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const bob = await user(f, 'bob'); const outsider = await user(f, 'outside');
  const org = await organization(f, owner); await join(f, owner, org, bob);
  await denied(() => f.service.createInvite(bob.token, org.id, { email: 'next@corp.example', role: 'member' }));
  await denied(() => f.service.createInvite(outsider.token, org.id, { email: 'next@corp.example', role: 'member' }));
  await denied(() => f.service.createInvite(owner.token, org.id, { email: 'next@corp.example', role: 'owner' }));
});

test('membership revocation checks actor authority, protects owners, and cascades exact keys', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const admin = await user(f, 'admin'); const member = await user(f, 'member');
  const org = await organization(f, owner); await join(f, owner, org, admin, 'admin'); const target = await join(f, owner, org, member);
  const ownerMembership = (await f.service.snapshot(owner.token)).organizations[0].membershipId;
  const key = await f.service.issueKey(member.token, { label: 'org agent', organizationId: org.id, permission: 'read', expiresInDays: 30 });
  const personal = await f.service.issueKey(member.token, { label: 'personal agent', permission: 'read', expiresInDays: 30 });
  await denied(() => f.service.revokeMembership(admin.token, org.id, ownerMembership));
  await denied(() => f.service.revokeMembership(owner.token, org.id, ownerMembership));
  await denied(() => f.service.revokeMembership(member.token, org.id, target.membershipId));
  await f.service.revokeMembership(admin.token, org.id, target.membershipId);
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.credentials WHERE id=?', key.id)).revoked_at, NOW);
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.credentials WHERE id=?', personal.id)).revoked_at, null);
  assert.equal((await f.service.snapshot(member.token)).organizations.length, 0);
  await denied(() => f.service.revokeMembership(admin.token, org.id, target.membershipId));
});

test('machine keys are digest-only, account or exact membership bound, and cannot administer workspaces', async t => {
  const f = await fixture(t); const alice = await user(f); const bob = await user(f, 'bob'); const org = await organization(f, alice);
  const personal = await f.service.issueKey(alice.token, { label: 'Laptop', permission: 'write', expiresInDays: 90 });
  const organizationKey = await f.service.issueKey(alice.token, { label: 'CI', organizationId: org.id, permission: 'read', expiresInDays: 1 });
  assert.equal(personal.token.length, 64);
  assert.equal(personal.expiresAt, NOW + 7_776_000_000);
  assert.equal(organizationKey.expiresAt, NOW + 86_400_000);
  const personalRow = await one(f, 'SELECT * FROM memory_identity.credentials WHERE id=?', personal.id);
  assert.equal(personalRow.kind, 'personal_key'); assert.equal(personalRow.membership_id, null); assert.equal(personalRow.email_id, null);
  assert.notEqual(personalRow.token_digest, personal.token);
  assert.equal((await one(f, 'SELECT id FROM memory_identity.active_credentials WHERE id=?', personal.id)).id, personal.id);
  const orgRow = await one(f, 'SELECT * FROM memory_identity.credentials WHERE id=?', organizationKey.id);
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
  const f = await fixture(t); const alice = await user(f);
  for (const patch of [{ label: '' }, { label: 'x'.repeat(101) }, { label: 'x\0y' }, { expiresInDays: 0 },
    { expiresInDays: 91 }, { expiresInDays: 1.5 }, { permission: 'admin' }])
    await denied(() => f.service.issueKey(alice.token, { label: 'valid', permission: 'read', expiresInDays: 1, ...patch }));
  await f.raw.exec(failingInsertTrigger('fail_key_metadata').replace('%s', 'memory_identity.workspace_key_metadata'));
  await denied(() => f.service.issueKey(alice.token, { label: 'failure', permission: 'read', expiresInDays: 1 }));
  assert.equal(await count(f, 'credentials'), 1);
});

test('key revocation allows issuer or live org admin, rejects unrelated accounts and is audited', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member'); const outside = await user(f, 'outside');
  const org = await organization(f, owner); await join(f, owner, org, member);
  const orgKey = await f.service.issueKey(member.token, { label: 'agent', organizationId: org.id, permission: 'read', expiresInDays: 1 });
  const personal = await f.service.issueKey(member.token, { label: 'private', permission: 'write', expiresInDays: 1 });
  await denied(() => f.service.revokeKey(outside.token, orgKey.id));
  await denied(() => f.service.revokeKey(owner.token, personal.id));
  await f.service.revokeKey(owner.token, orgKey.id);
  await f.service.revokeKey(member.token, personal.id);
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.credentials WHERE id=?', orgKey.id)).revoked_at, NOW);
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.credentials WHERE id=?', personal.id)).revoked_at, NOW);
  assert.equal((await one(f, "SELECT count(*) AS n FROM memory_ops.workspace_audit_events WHERE action='key_revoked'")).n, 2);
  assert.equal((await f.service.snapshot(member.token)).keys.filter(k => k.revokedAt === NOW).length, 2);
  await denied(() => f.service.revokeKey(member.token, personal.id));
});

test('disabled account and expired membership are checked on each workspace action', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const org = await organization(f, owner); const membership = await join(f, owner, org, member);
  await f.raw.prepare('UPDATE memory_identity.memberships SET expires_at=? WHERE id=?').run(NOW, membership.membershipId);
  assert.equal((await f.service.snapshot(member.token)).organizations.length, 0);
  await denied(() => f.service.issueKey(member.token, { label: 'expired', organizationId: org.id, permission: 'read', expiresInDays: 1 }));
  await f.raw.prepare('UPDATE memory_identity.accounts SET disabled_at=? WHERE id=?').run(NOW, owner.accountId);
  await denied(() => f.service.snapshot(owner.token));
  await denied(() => f.service.signIn(principal('owner')));
  await denied(() => f.service.createInvite(owner.token, org.id, { email: 'other@corp.example', role: 'member' }));
});

test('snapshot write capabilities reflect the live organization role and provider permission', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const org = await organization(f, owner); const membership = await join(f, owner, org, member);
  let snapshot = await f.service.snapshot(member.token);
  assert.equal(snapshot.spaces.find(s => s.organizationId === null).canWrite, true);
  assert.equal(snapshot.spaces.find(s => s.organizationId === org.id).canWrite, false);
  await denied(() => f.service.issueKey(member.token, { label: 'Escalation', organizationId: org.id, permission: 'write', expiresInDays: 1 }));
  await f.raw.prepare("UPDATE memory_identity.memberships SET role='admin' WHERE id=?").run(membership.membershipId);
  snapshot = await f.service.snapshot(member.token);
  assert.equal(snapshot.spaces.find(s => s.organizationId === org.id).canWrite, true);
  const readSession = await user(f, 'member', { permission: 'read' });
  assert.ok(readSession.snapshot.spaces.every(s => s.canWrite === false));
});

test('provider bearer sessions cannot administer even when passed directly to WorkspaceService', async t => {
  const f = await fixture(t); const alice = await user(f); const org = await organization(f, alice);
  const external = await f.service.signIn(principal(), 'external-bearer.' + 'c'.repeat(200));
  await denied(() => f.service.snapshot(external.token));
  await denied(() => f.service.createOrganization(external.token, { name: 'Forbidden', emailId: alice.snapshot.account.emails[0].id }));
  await denied(() => f.service.createInvite(external.token, org.id, { email: 'bob@corp.example', role: 'member' }));
  await denied(() => f.service.issueKey(external.token, { label: 'Forbidden', permission: 'read', expiresInDays: 1 }));
  const credential = await one(f, 'SELECT id FROM memory_identity.credentials WHERE token_digest=?', await digestToken(external.token));
  await assert.rejects(() => f.raw.prepare(`INSERT INTO memory_identity.workspace_key_issuances
    (id,actor_credential_id,label,permission,token_digest,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`)
    .run('attempt', credential.id, 'Forbidden', 'read', 'a'.repeat(64), NOW, NOW + 86_400_000));
});

test('workspace transaction records and metadata cannot be replaced, edited, or deleted', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const org = await organization(f, owner); await join(f, owner, org, member);
  const key = await f.service.issueKey(owner.token, { label: 'Immutable', permission: 'read', expiresInDays: 1 });
  await f.service.revokeKey(owner.token, key.id);
  const membership = (await f.service.snapshot(member.token)).organizations[0].membershipId;
  await f.service.revokeMembership(owner.token, org.id, membership);
  for (const name of ['provider_identities','workspace_sign_ins','workspace_organization_creations',
    'workspace_organization_metadata','workspace_invitations','workspace_invitation_acceptances','workspace_key_issuances',
    'workspace_key_metadata','workspace_membership_revocations','workspace_key_revocations','workspace_audit_events']) {
    const row = await one(f, `SELECT * FROM ${table(name)} LIMIT 1`); assert.ok(row, `${name} has a transaction record`);
    const field = Object.keys(row)[0];
    await assert.rejects(() => f.raw.exec(`UPDATE ${table(name)} SET ${field}=${field} || '-tampered'`), undefined, `${name} cannot be updated`);
    await assert.rejects(() => f.raw.exec(`DELETE FROM ${table(name)}`), undefined, `${name} cannot be deleted`);
    await assert.rejects(() => f.raw.exec(`INSERT INTO ${table(name)} SELECT * FROM ${table(name)}`), undefined, `${name} cannot be replaced`);
  }
});

test('simultaneous verified sign-ins reuse one mapping and external credential', async t => {
  const f = await fixture(t);
  const token = 'provider-proof.' + 'q'.repeat(150);
  const sessions = await Promise.all(Array.from({ length: 8 }, () => f.service.signIn(principal(), token)));
  assert.ok(sessions.every(session => session.accountId === sessions[0].accountId));
  assert.equal(await count(f, 'accounts'), 1); assert.equal(await count(f, 'provider_identities'), 1);
  assert.equal(await count(f, 'credentials'), 1); assert.equal(await count(f, 'account_emails'), 1); assert.equal(await count(f, 'spaces'), 1);
});

test('competing acceptance requests consume an invitation exactly once', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const bob = await user(f, 'bob'); const org = await organization(f, owner);
  const invite = await f.service.createInvite(owner.token, org.id, { email: 'bob@corp.example', role: 'member' });
  const results = await Promise.allSettled([f.service.acceptInvite(bob.token, invite.token), f.service.acceptInvite(bob.token, invite.token)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await count(f, 'memberships'), 2); assert.equal(await count(f, 'workspace_invitation_acceptances'), 1);
});

test('workspace mutations recheck authorization in the write after the request has started', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const org = await organization(f, owner);
  const originalPrepare = f.db.prepare.bind(f.db);
  let revoked = false;
  f.db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (/INSERT INTO memory_identity\.workspace_invitations/.test(sql)) {
      const originalRun = statement.run.bind(statement);
      statement.run = async () => {
        await f.raw.prepare('UPDATE memory_identity.memberships SET revoked_at=? WHERE organization_id=?').run(NOW, org.id);
        revoked = true;
        return originalRun();
      };
    }
    return statement;
  };
  await denied(() => f.service.createInvite(owner.token, org.id, { email: 'bob@corp.example', role: 'member' }));
  assert.equal(revoked, true); assert.equal(await count(f, 'workspace_invitations'), 0);
});

test('membership and key revocations roll back together with mandatory product audit', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const org = await organization(f, owner); const membership = await join(f, owner, org, member);
  const key = await f.service.issueKey(member.token, { label: 'Reader', organizationId: org.id, permission: 'read', expiresInDays: 1 });
  await f.raw.exec(`CREATE OR REPLACE FUNCTION memory_identity.audit_failure_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private audit failure'; END $$;
  CREATE TRIGGER audit_failure BEFORE INSERT ON memory_ops.workspace_audit_events
    FOR EACH ROW WHEN (NEW.action IN ('membership_revoked','key_revoked')) EXECUTE FUNCTION memory_identity.audit_failure_fn();`);
  await denied(() => f.service.revokeMembership(owner.token, org.id, membership.membershipId));
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.memberships WHERE id=?', membership.membershipId)).revoked_at, null);
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.credentials WHERE id=?', key.id)).revoked_at, null);
  await denied(() => f.service.revokeKey(owner.token, key.id));
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.credentials WHERE id=?', key.id)).revoked_at, null);
  assert.equal(await count(f, 'workspace_membership_revocations'), 0); assert.equal(await count(f, 'workspace_key_revocations'), 0);
  assert.equal((await one(f, "SELECT count(*) AS n FROM memory_ops.workspace_audit_events WHERE action IN ('membership_revoked','key_revoked')")).n, 0);
});

test('issued machine keys obey memory permission, tenant, expiry and membership revocation', async t => {
  const f = await fixture(t); const alice = await user(f); const bob = await user(f, 'bob'); const org = await organization(f, alice);
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
  await f.setNow(personal.expiresAt);
  await assert.rejects(() => memory.get(personal.token, personalSpace, privateMemory.id), MemoryDenied);
  assert.equal((await memory.get(orgKey.token, org.spaceId, sharedMemory.id)).revision, 2);
  await f.raw.prepare('UPDATE memory_identity.account_emails SET revoked_at=? WHERE id=?').run(personal.expiresAt, alice.snapshot.account.emails[0].id);
  await assert.rejects(() => memory.get(orgKey.token, org.spaceId, sharedMemory.id), MemoryDenied);
});

test('member directory is a fresh admin-only view of exact live organization memberships', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const admin = await user(f, 'admin');
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
  await f.raw.prepare("UPDATE memory_identity.memberships SET role='member' WHERE id=?").run(adminMembership.membershipId);
  await denied(() => f.service.listMembers(admin.token, org.id));
  await f.service.revokeMembership(owner.token, org.id, memberMembership.membershipId);
  assert.deepEqual((await f.service.listMembers(owner.token, org.id)).map(row => row.accountId).sort(), [owner.accountId, admin.accountId].sort());
  await f.raw.prepare('UPDATE memory_identity.memberships SET expires_at=? WHERE id=?').run(NOW, adminMembership.membershipId);
  assert.equal((await f.service.listMembers(owner.token, org.id)).length, 1);
  await f.raw.prepare('UPDATE memory_identity.credentials SET revoked_at=? WHERE account_id=?').run(NOW, owner.accountId);
  await denied(() => f.service.listMembers(owner.token, org.id));
});

test('organizations can nest deeply without a product depth cap while roots retain null parent metadata', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const root = await organization(f, owner, 'Root');
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
  assert.equal(await count(f, 'organization_hierarchy'), 128);
});

test('parent and child organizations grant no inherited membership, memory or key authority', async t => {
  const f = await fixture(t); const rootOwner = await user(f, 'root-owner'); const creator = await user(f, 'creator'); const childOnly = await user(f, 'child-only');
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
  const f = await fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member'); const outsider = await user(f, 'outside');
  const parent = await organization(f, owner); const membership = await join(f, owner, parent, member);
  const input = { name: 'Child', emailId: member.snapshot.account.emails[0].id, parentOrganizationId: parent.id };
  await denied(() => f.service.createOrganization(member.token, input));
  await denied(() => f.service.createOrganization(outsider.token, { ...input, emailId: outsider.snapshot.account.emails[0].id }));
  await denied(() => f.service.createOrganization(owner.token, input));
  await denied(() => f.service.createOrganization(owner.token, { ...input, emailId: owner.snapshot.account.emails[0].id, parentOrganizationId: 'missing' }));
  for (const invalidParent of ['', null, 'bad/id'])
    await denied(() => f.service.createOrganization(owner.token, { ...input, parentOrganizationId: invalidParent }));
  await f.raw.prepare("UPDATE memory_identity.memberships SET role='admin' WHERE id=?").run(membership.membershipId);
  const key = await f.service.issueKey(member.token, { label: 'Parent agent', organizationId: parent.id, permission: 'write', expiresInDays: 1 });
  const external = await f.service.signIn(principal('member'), 'external-hierarchy.' + 'h'.repeat(150));
  for (const token of [key.token, external.token]) await denied(() => f.service.createOrganization(token, input));
  await f.raw.prepare('UPDATE memory_identity.memberships SET expires_at=? WHERE id=?').run(NOW, membership.membershipId);
  await denied(() => f.service.createOrganization(member.token, input));
  await f.raw.prepare('UPDATE memory_control.organizations SET disabled_at=? WHERE id=?').run(NOW, parent.id);
  await denied(() => f.service.createOrganization(owner.token, { ...input, emailId: owner.snapshot.account.emails[0].id }));
  assert.equal(await count(f, 'organizations'), 1);
});

test('child membership and keys remain independent when parent email or organization is revoked', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const creator = await user(f, 'creator');
  const parent = await organization(f, owner); await join(f, owner, parent, creator, 'admin');
  await f.raw.prepare('INSERT INTO memory_identity.account_emails(id,account_id,address,domain,verified_at) VALUES(?,?,?,?,?)')
    .run('creator-child-email', creator.accountId, 'creator@personal.example', 'personal.example', NOW);
  const child = await f.service.createOrganization(creator.token, { name: 'Child', emailId: 'creator-child-email', parentOrganizationId: parent.id });
  const key = await f.service.issueKey(creator.token, { label: 'Child key', organizationId: child.id, permission: 'write', expiresInDays: 1 });
  await f.raw.prepare('UPDATE memory_identity.account_emails SET revoked_at=? WHERE id=?').run(NOW, creator.snapshot.account.emails[0].id);
  await f.raw.prepare('UPDATE memory_control.organizations SET disabled_at=? WHERE id=?').run(NOW, parent.id);
  const snapshot = await f.service.snapshot(creator.token);
  assert.equal(snapshot.organizations.length, 1); assert.equal(snapshot.organizations[0].id, child.id);
  assert.equal(snapshot.organizations[0].parentId, null);
  const memory = new MemoryService(f.db, f.clock);
  assert.equal((await memory.create(key.token, child.spaceId, { body: 'Independent authority' })).body, 'Independent authority');
  assert.equal((await one(f, 'SELECT revoked_at FROM memory_identity.credentials WHERE id=?', key.id)).revoked_at, null);
});

test('hierarchy edges cannot self-parent, form cycles, reparent, delete or replace', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const parent = await organization(f, owner);
  const child = await f.service.createOrganization(owner.token, { name: 'Child', emailId: owner.snapshot.account.emails[0].id, parentOrganizationId: parent.id });
  assert.equal(await count(f, 'organization_hierarchy'), 1);
  await assert.rejects(() => f.raw.prepare('INSERT INTO memory_identity.organization_hierarchy(organization_id,parent_organization_id) VALUES(?,?)').run(parent.id, parent.id));
  await assert.rejects(() => f.raw.prepare('INSERT INTO memory_identity.organization_hierarchy(organization_id,parent_organization_id) VALUES(?,?)').run(parent.id, child.id));
  await assert.rejects(() => f.raw.prepare('UPDATE memory_identity.organization_hierarchy SET parent_organization_id=? WHERE organization_id=?').run(child.id, child.id));
  await assert.rejects(() => f.raw.exec('DELETE FROM memory_identity.organization_hierarchy'));
  await assert.rejects(() => f.raw.exec('INSERT INTO memory_identity.organization_hierarchy SELECT * FROM memory_identity.organization_hierarchy'));
  await assert.rejects(() => f.raw.exec("UPDATE memory_identity.workspace_child_organization_creations SET name='changed'"));
  await assert.rejects(() => f.raw.exec('DELETE FROM memory_identity.workspace_child_organization_creations'));
  await assert.rejects(() => f.raw.exec('INSERT INTO memory_identity.workspace_child_organization_creations SELECT * FROM memory_identity.workspace_child_organization_creations'));
  assert.equal((await one(f, 'SELECT parent_organization_id FROM memory_identity.organization_hierarchy WHERE organization_id=?', child.id)).parent_organization_id, parent.id);
});

test('child organization bootstrap and its hierarchy edge roll back atomically', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const parent = await organization(f, owner);
  assert.equal((await one(f, "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='memory_identity' AND table_name='organization_hierarchy'")).n, 1);
  const before = Object.fromEntries(await Promise.all(['organizations','memberships','spaces','workspace_organization_creations','workspace_audit_events']
    .map(async name => [name, await count(f, name)])));
  await f.raw.exec(failingInsertTrigger('fail_hierarchy').replace('%s', 'memory_identity.organization_hierarchy'));
  await denied(() => f.service.createOrganization(owner.token, { name: 'Child', emailId: owner.snapshot.account.emails[0].id, parentOrganizationId: parent.id }));
  for (const [name, total] of Object.entries(before)) assert.equal(await count(f, name), total);
  assert.equal(await count(f, 'workspace_child_organization_creations'), 0);
});

test('the latest forward migrations preserve populated organizations, claims, memory and revocations', async t => {
  // Populate a deployment at schema version 9, then apply 0010+.
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  const migDir = new URL('../postgres/migrations/', import.meta.url);
  const files = readdirSync(migDir).filter(name => name.endsWith('.sql')).sort();
  for (const name of files.filter(name => name < '0010_')) await engine.exec(readFileSync(new URL(name, migDir), 'utf8'));
  // The service clock function is introduced by migration 0007; install the
  // test-clock variant, restore it after each migration's own definition.
  const testClock = `CREATE OR REPLACE FUNCTION memory_control.now_ms() RETURNS bigint
    LANGUAGE sql AS $$ SELECT current_setting('app.test_now_ms', true)::bigint $$`;
  await engine.exec(testClock);
  await engine.query(`SELECT set_config('app.test_now_ms', $1, false)`, [String(NOW)]);
  await engine.query(`INSERT INTO memory_control.deployment_identity VALUES(1,'memory-sg','sg','standard-v1',1)`);
  // The pre-upgrade deployment is populated directly: the service SQL targets
  // the latest schema (the runtime_* views land in 0014), so a v9 population
  // is seeded as the rows the v9 applies would have written.
  const ownerToken = 'owner-session-token'.padEnd(64, '0'), ownerDigest = await digestToken(ownerToken);
  const revokedToken = 'revoked-key-token'.padEnd(64, '1'), revokedDigest = await digestToken(revokedToken);
  const policy = `'{"policyVersion":1,"residency":"sg","profile":"standard","processingBoundary":"approved-processors","dataClass":"general","classificationStatus":"declared","sensitivityTags":[],"placementEpoch":1}'::jsonb`;
  await engine.exec(`INSERT INTO memory_identity.accounts(id) VALUES('acct-owner');
    INSERT INTO memory_identity.account_emails(id,account_id,address,domain,verified_at) VALUES('e-owner','acct-owner','owner@corp.example','corp.example',${NOW});
    INSERT INTO memory_control.organizations(id) VALUES('org-root');
    INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role,expires_at) VALUES('m-owner','org-root','acct-owner','e-owner','owner',9007199254740991);
    INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission) VALUES('session:owner','acct-owner','session','${ownerDigest}',${NOW + 900000},${NOW},'write');
    INSERT INTO memory_identity.credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,revoked_at,permission) VALUES('key:revoked','acct-owner','m-owner','e-owner','api_key','${revokedDigest}',${NOW + 86400000},${NOW},'write');
    INSERT INTO memory_control.spaces(id,owner_account_id,organization_id,deployment_id,data_policy,source_byte_limit,message_limit,name,security_mode,created_at_ms,actor_credential_id) VALUES
      ('space-personal','acct-owner',NULL,'memory-sg',${policy},67108864,100000,'Personal','managed',${NOW},'session:owner'),
      ('space-root',NULL,'org-root','memory-sg',${policy},67108864,100000,'Existing organization','managed',${NOW},'session:owner');
    INSERT INTO memory_content.memories(id,space_id,body,revision,created_at,updated_at,actor_credential_id) VALUES('mem-retained','space-root','Retained through upgrade',1,${NOW},${NOW},'session:owner');
    INSERT INTO memory_ops.workspace_audit_events(action,actor_credential_id,account_id,created_at) VALUES('signed_in','session:owner','acct-owner',${NOW});`);
  const session = { query: async (text, values = []) => {
    const r = await engine.query(text, values); return { rows: r.rows, rowCount: r.rowCount ?? null }; } };
  const db = createPostgresDatabase(session);
  const service = new WorkspaceService(db, () => NOW);
  const owner = { token: ownerToken, accountId: 'acct-owner' };
  const emailId = 'e-owner', root = { id: 'org-root', spaceId: 'space-root' };
  const key = { token: revokedToken, id: 'key:revoked' };
  const memory = new MemoryService(db, () => NOW);
  const record = { id: 'mem-retained' };
  const names = ['memory_identity.accounts', 'memory_identity.account_emails', 'memory_identity.credentials',
    'memory_control.organizations', 'memory_identity.memberships', 'memory_control.spaces',
    'memory_content.memories', 'memory_ops.workspace_audit_events'];
  const before = Object.fromEntries(await Promise.all(names.map(async name => [name, (await engine.query(`SELECT * FROM ${name} ORDER BY 1`)).rows])));
  await engine.exec('DROP FUNCTION memory_control.now_ms()');
  for (const name of files.filter(name => name >= '0010_')) await engine.exec(readFileSync(new URL(name, migDir), 'utf8'));
  await engine.exec(testClock);
  // Later migrations may add columns; every pre-upgrade cell must be preserved.
  for (const name of names) {
    const after = (await engine.query(`SELECT * FROM ${name} ORDER BY 1`)).rows;
    assert.equal(after.length, before[name].length, name);
    for (const [index, row] of before[name].entries())
      for (const [column, value] of Object.entries(row)) assert.deepEqual(after[index][column], value, `${name}.${column}`);
  }
  assert.equal((await service.snapshot(owner.token)).organizations[0].parentId, null);
  const child = await service.createOrganization(owner.token, { name: 'New child', emailId, parentOrganizationId: root.id });
  assert.equal((await service.snapshot(owner.token)).organizations.find(org => org.id === child.id).parentId, root.id);
  assert.equal((await memory.get(owner.token, root.spaceId, record.id)).body, 'Retained through upgrade');
  await assert.rejects(() => memory.get(key.token, root.spaceId, record.id), MemoryDenied);
});

test('child creation rechecks parent authority at the write and its command trigger rejects direct bypasses', async t => {
  const f = await fixture(t); const owner = await user(f, 'owner'); const member = await user(f, 'member');
  const root = await organization(f, owner); const membership = await join(f, owner, root, member, 'admin');
  const originalPrepare = f.db.prepare.bind(f.db);
  let changed = false;
  f.db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (/INSERT INTO memory_identity\.workspace_child_organization_creations/.test(sql)) {
      const originalRun = statement.run.bind(statement);
      statement.run = async () => {
        await f.raw.prepare("UPDATE memory_identity.memberships SET role='member' WHERE id=?").run(membership.membershipId);
        changed = true; return originalRun();
      };
    }
    return statement;
  };
  const emailId = member.snapshot.account.emails[0].id;
  await denied(() => f.service.createOrganization(member.token, { name: 'Child', emailId, parentOrganizationId: root.id }));
  assert.equal(changed, true);
  const actorId = (await one(f, 'SELECT id FROM memory_identity.credentials WHERE token_digest=?', await digestToken(member.token))).id;
  const command = f.raw.prepare(`INSERT INTO memory_identity.workspace_child_organization_creations
    (id,parent_organization_id,name,actor_credential_id,email_id,membership_id,space_id,created_at) VALUES(?,?,?,?,?,?,?,?)`);
  await assert.rejects(() => command.run('direct-child', root.id, 'Bypass', actorId, emailId, 'direct-member', 'direct-space', NOW));
  await f.raw.prepare("UPDATE memory_identity.memberships SET role='admin' WHERE id=?").run(membership.membershipId);
  await assert.rejects(() => command.run(root.id, root.id, 'Self', actorId, emailId, 'direct-member', 'direct-space', NOW));
  await assert.rejects(() => command.run('wrong-claim', root.id, 'Bypass', actorId, owner.snapshot.account.emails[0].id, 'direct-member', 'direct-space', NOW));
  await f.raw.prepare('UPDATE memory_identity.account_emails SET revoked_at=? WHERE id=?').run(NOW, emailId);
  await assert.rejects(() => command.run('revoked-claim', root.id, 'Bypass', actorId, emailId, 'direct-member', 'direct-space', NOW));
  assert.equal(await count(f, 'workspace_child_organization_creations'), 0);
  assert.equal(await count(f, 'organizations'), 1);
});

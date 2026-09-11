import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from '../../release-validation/tests/db.mjs';
import { digest } from '../../src/release/util.ts';
import { Transfers } from '../../src/release/transfer.ts';
import { WorkspaceService } from '../../src/workspace.ts';
import { applyVerifiedLifecycle } from '../../src/release/lifecycle.ts';
import { resolveGeneralRoutingAuthority } from '../../src/routing/general-authority.ts';

const denied = { status: 403, code: 'access_denied' };
async function setup(t) {
  let now = at;
  const f = await fixture({ clock: () => now });
  t.after(() => f.db.close());
  return { ...f, clock: () => now, setNow(value) { now = value; } };
}
async function orgKey(f, { actor = 'alice', capabilities = ['read', 'create', 'delete'], spaces = ['so'] } = {}) {
  const token = (actor === 'alice' ? 'd' : 'e').repeat(64), credentialId = 'org-key:' + actor;
  f.db.raw.prepare('INSERT INTO credentials(id,account_id,kind,membership_id,email_id,token_digest,expires_at,permission) VALUES(?,?,?,?,?,?,?,?)')
    .run(credentialId, actor, 'api_key', actor === 'alice' ? 'm1' : 'm2', actor === 'alice' ? 'e1' : 'e2', await digest(token), at + 800000, 'write');
  f.db.raw.prepare('INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES(?,?,?)')
    .run(credentialId, JSON.stringify(capabilities), JSON.stringify(spaces));
  return token;
}
const resolve = (f, token, space = 's1', operation = 'memory_search') => resolveGeneralRoutingAuthority(f.db, token, space, operation, f.clock);
function shortOrgShare(f, expiresAt) {
  // The real schema validates this initial grant and keeps its expiry immutable.
  f.db.raw.prepare(`INSERT INTO release_shares(id,space_id,recipient_email_id,creator_credential_id,expires_at,created_at,creator_membership_id,creator_email_id)
    VALUES('short-share','so','e2','session:alice',?,?,'m1','e1')`).run(expiresAt, at);
  return { id: 'short-share' };
}

test('personal PAT returns the actual Space owner and an immutable primary-snapshot authority', async t => {
  const f = await setup(t), sessions = [], original = f.db.withSession.bind(f.db);
  f.db.withSession = consistency => { sessions.push(consistency); return original(consistency); };
  const actor = await resolve(f, f.key, 's1', 'memory_ingest');
  assert.deepEqual(actor, { spaceId: 's1', owner: { kind: 'account', id: 'alice' }, accountId: 'alice', credentialId: 'key:alice',
    operation: 'memory_ingest', authorityExpiresAtMs: at + 900000 });
  assert.deepEqual(sessions, ['first-primary']);
  assert.throws(() => { actor.owner.id = 'bob'; }, TypeError);
  assert.throws(() => { actor.operation = 'memory_clear_space'; }, TypeError);
});

test('personal PAT has exact Space and capability restrictions even when the account owns another Space', async t => {
  const f = await setup(t);
  f.db.raw.prepare("INSERT INTO spaces VALUES('s3','Second personal','alice',NULL,'managed',?,'session:alice')").run(at);
  await resolve(f, f.key, 's1', 'memory_usage');
  await assert.rejects(resolve(f, f.key, 's3'), denied);
  await assert.rejects(resolve(f, f.key, 's1', 'memory_clear_space'), denied);
  await assert.rejects(resolve(f, f.key, 'so'), denied);
  await assert.rejects(resolve(f, f.other), denied);
  await resolve(f, f.token, 's1', 'memory_clear_space');
});

test('organization PAT returns owning organization and minimum membership expiry', async t => {
  const f = await setup(t), token = await orgKey(f);
  f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at + 30000);
  const actor = await resolve(f, token, 'so', 'memory_ingest');
  assert.deepEqual(actor, { spaceId: 'so', owner: { kind: 'organization', id: 'org' }, accountId: 'alice', credentialId: 'org-key:alice',
    operation: 'memory_ingest', authorityExpiresAtMs: at + 30000 });
  await resolve(f, token, 'so', 'memory_clear_space');
  await assert.rejects(resolve(f, token, 's1'), denied);
});

for (const mode of ['wrong-space', 'read-only', 'wrong-membership']) test('organization PAT rejects ' + mode, async t => {
  const f = await setup(t);
  if (mode === 'wrong-membership') {
    const child = await new WorkspaceService(f.db, f.clock).createOrganization(f.token, { name: 'Child', emailId: 'e1', parentOrganizationId: 'org' });
    const token = await orgKey(f, { spaces: [child.spaceId] });
    await assert.rejects(resolve(f, token, child.spaceId), denied);
  } else {
    const token = await orgKey(f, { ...(mode === 'wrong-space' ? { spaces: ['s1'] } : {}),
      ...(mode === 'read-only' ? { capabilities: ['read'] } : {}) });
    await assert.rejects(resolve(f, token, 'so', 'memory_ingest'), denied);
  }
});

test('organization members may read usage and search but only owners or admins may ingest and clear', async t => {
  const f = await setup(t), token = await orgKey(f, { actor: 'bob' });
  for (const credential of [f.other, token]) {
    for (const operation of ['memory_search', 'memory_usage']) assert.deepEqual((await resolve(f, credential, 'so', operation)).owner, { kind: 'organization', id: 'org' });
    for (const operation of ['memory_ingest', 'memory_clear_space']) await assert.rejects(resolve(f, credential, 'so', operation), denied);
  }
  f.db.raw.prepare("UPDATE memberships SET role='admin' WHERE id='m2'").run();
  await resolve(f, token, 'so', 'memory_ingest');
  await resolve(f, token, 'so', 'memory_clear_space');
});

test('read-only interactive sessions cannot ingest or clear a personally owned Space', async t => {
  const f = await setup(t);
  f.db.raw.prepare("UPDATE credentials SET permission='read' WHERE id='session:alice'").run();
  await resolve(f, f.token);
  for (const operation of ['memory_ingest', 'memory_clear_space']) await assert.rejects(resolve(f, f.token, 's1', operation), denied);
});

test('materialized OAuth sessions require their verified capability and exact Space policy', async t => {
  const f = await setup(t), token = 'f'.repeat(64);
  f.db.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,permission) VALUES('oauth:actor','alice','session',?,?,'write')")
    .run(await digest(token), at + 120000);
  f.db.raw.prepare("INSERT INTO release_credential_policies(credential_id,capabilities,space_ids,verified_oauth) VALUES('oauth:actor','[\"read\"]','[\"so\"]',1)").run();
  assert.equal((await resolve(f, token, 'so')).authorityExpiresAtMs, at + 120000);
  await assert.rejects(resolve(f, token, 's1'), denied);
  await assert.rejects(resolve(f, token, 'so', 'memory_ingest'), denied);
  await assert.rejects(resolve(f, token, 'so', 'memory_clear_space'), denied);
});

for (const mode of ['credential', 'membership', 'email', 'actor-account', 'owner-organization']) test('organization authority immediately rejects revoked or disabled ' + mode, async t => {
  const f = await setup(t), token = await orgKey(f);
  await resolve(f, token, 'so');
  const sql = { credential: "UPDATE credentials SET revoked_at=? WHERE id='org-key:alice'", membership: "UPDATE memberships SET revoked_at=? WHERE id='m1'",
    email: "UPDATE account_emails SET revoked_at=? WHERE id='e1'", 'actor-account': "UPDATE accounts SET disabled_at=? WHERE id='alice'",
    'owner-organization': "UPDATE organizations SET disabled_at=? WHERE id='org'" }[mode];
  f.db.raw.prepare(sql).run(at);
  await assert.rejects(resolve(f, token, 'so'), denied);
});

test('accepted shares preserve actual owner and read-only rights after recipient organization membership ends', async t => {
  const f = await setup(t), transfers = new Transfers(f.db, f.clock);
  const share = shortOrgShare(f, at + 45000);
  await transfers.accept(f.other, share.id);
  f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m2'").run(at);
  const actor = await resolve(f, f.other, 'so');
  assert.deepEqual(actor.owner, { kind: 'organization', id: 'org' }); assert.equal(actor.accountId, 'bob');
  assert.equal(actor.authorityExpiresAtMs, at + 45000);
  await resolve(f, f.other, 'so', 'memory_usage');
  for (const operation of ['memory_ingest', 'memory_clear_space']) await assert.rejects(resolve(f, f.other, 'so', operation), denied);
});

test('a longer accepted share remains usable when a shorter recipient membership expires', async t => {
  const f = await setup(t), transfers = new Transfers(f.db, f.clock);
  const share = shortOrgShare(f, at + 60000); await transfers.accept(f.other, share.id);
  f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at + 1000);
  assert.equal((await resolve(f, f.other, 'so')).authorityExpiresAtMs, at + 60000);
  f.setNow(at + 1001);
  assert.equal((await resolve(f, f.other, 'so')).authorityExpiresAtMs, at + 60000);
});

for (const mode of ['unaccepted', 'revoked', 'expired', 'grantor-membership', 'recipient-email']) test('outside read share rejects ' + mode, async t => {
  const f = await setup(t), transfers = new Transfers(f.db, f.clock);
  const share = mode === 'expired' ? shortOrgShare(f, at + 30000) : await transfers.share(f.token, 'so', 'bob@example.com');
  if (mode !== 'unaccepted') await transfers.accept(f.other, share.id);
  f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m2'").run(at);
  if (mode === 'revoked') f.db.raw.prepare('UPDATE release_shares SET revoked_at=? WHERE id=?').run(at, share.id);
  if (mode === 'expired') f.setNow(at + 30000);
  if (mode === 'grantor-membership') f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m1'").run(at);
  if (mode === 'recipient-email') f.db.raw.prepare("UPDATE account_emails SET revoked_at=? WHERE id='e2'").run(at);
  await assert.rejects(resolve(f, f.other, 'so'), denied);
});

test('personal sharing is denied when the actual owner is disabled', async t => {
  const f = await setup(t), transfers = new Transfers(f.db, f.clock);
  const share = await transfers.share(f.token, 's1', 'bob@example.com'); await transfers.accept(f.other, share.id);
  assert.deepEqual((await resolve(f, f.other)).owner, { kind: 'account', id: 'alice' });
  f.db.raw.prepare("UPDATE accounts SET disabled_at=? WHERE id='alice'").run(at);
  await assert.rejects(resolve(f, f.other), denied);
});

test('a suspended owner blocks personal shares even while their account is not terminally disabled', async t => {
  const f = await setup(t), transfers = new Transfers(f.db, f.clock), issuer = 'https://auth-api.allen.company';
  const share = await transfers.share(f.token, 's1', 'bob@example.com'); await transfers.accept(f.other, share.id);
  f.db.raw.prepare('INSERT INTO provider_identities(issuer,subject,account_id,created_at) VALUES(?,?,?,?)').run(issuer, 'alice-central', 'alice', at);
  await applyVerifiedLifecycle(f.db, f.clock, { issuer, subject: 'alice-central', issuedAt: at, expiresAt: at + 60000,
    identityLifecycle: [JSON.stringify({ version: 2, id: 'suspend-owner', sequence: 1, issuer, subject: 'alice-central', type: 'account.suspended', occurredAt: at, email: null })] });
  assert.equal(f.db.raw.prepare("SELECT disabled_at FROM accounts WHERE id='alice'").get().disabled_at, null);
  await assert.rejects(resolve(f, f.other), denied);
});

test('parent membership does not authorize an independently revoked child membership', async t => {
  const f = await setup(t), child = await new WorkspaceService(f.db, f.clock).createOrganization(f.token,
    { name: 'Independent child', emailId: 'e1', parentOrganizationId: 'org' });
  f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE organization_id=?').run(at, child.id);
  await resolve(f, f.token, 'so');
  await assert.rejects(resolve(f, f.token, child.spaceId), denied);
});

test('database execution time rejects expired credentials despite an earlier application clock', async t => {
  const f = await setup(t);
  f.db.setClock(() => at + 900000);
  await assert.rejects(resolve(f, f.token), denied);
});

test('revocation while the primary statement is queued is visible at execution', async t => {
  const f = await setup(t), original = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    const query = original(sql);
    if (sql.includes('/* general-routing-authority */')) {
      const first = query.first.bind(query);
      query.first = async () => {
        f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='key:alice'").run(at);
        return first();
      };
    }
    return query;
  };
  await assert.rejects(resolve(f, f.key), denied);
});

test('an authority expiring after the primary query returns cannot escape as a usable snapshot', async t => {
  const f = await setup(t), original = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    const query = original(sql);
    if (sql.includes('/* general-routing-authority */')) {
      const first = query.first.bind(query);
      query.first = async () => { const row = await first(); f.setNow(at + 900000); return row; };
    }
    return query;
  };
  await assert.rejects(resolve(f, f.token), denied);
});

test('invalid IDs, operation and clocks are rejected instead of entering SQL authority', async t => {
  const f = await setup(t);
  for (const space of ['', '../s1', 'x'.repeat(129), {}, null]) await assert.rejects(resolve(f, f.token, space), { status: 400 });
  for (const operation of ['create', '__proto__', '', null]) await assert.rejects(resolve(f, f.token, 's1', operation), { status: 400 });
  for (const now of [NaN, Infinity, -1, at + 0.5, Number.MAX_SAFE_INTEGER]) {
    f.setNow(now);
    await assert.rejects(resolve(f, f.token), { status: 503, code: 'routing_clock_invalid' });
  }
});

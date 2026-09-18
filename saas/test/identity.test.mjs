import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityDenied, IdentityInvalid, canonicalEmail, digestToken } from '../src/identity.ts';
import { createFixture, startLink, seedCredential, NOW } from './helpers.mjs';

async function fixture(t) { const f = await createFixture(); t.after(f.close); return f; }
function one(f, sql, ...values) { return f.raw.prepare(sql).get(...values); }
async function count(f, table) { return (await one(f, `SELECT count(*) AS n FROM ${table}`)).n; }
const denied = fn => assert.rejects(fn, IdentityDenied);
// The adapter wraps driver failures; assert the driver-level cause survives.
const causeMatches = pattern => error => String(error?.cause ?? error).includes(pattern)
  || String(error).match(pattern) !== null;

test('mail normalization preserves plus/dot distinctions and rejects malformed mail', () => {
  assert.deepEqual(canonicalEmail(' Alice+tag@CORP.EXAMPLE '), { address: 'alice+tag@corp.example', domain: 'corp.example' });
  for (const address of ['x', '.x@corp.example', 'x..y@corp.example', 'x@-corp.example', 'é@corp.example', 'x@corp.example@bad.example'])
    assert.throws(() => canonicalEmail(address), IdentityInvalid);
});

test('account sessions return all live claims using fresh primary authorization', async t => {
  const f = await fixture(t);
  const account = await f.service.getAccount(f.tokens.alice);
  assert.equal(account.id, 'alice');
  assert.deepEqual(account.emails.map(e => e.id).sort(), ['e-personal', 'e-work']);
  assert.deepEqual(f.primaryReads, ['first-primary']);
});

test('membership keys authorize one organization and cannot expose personal account', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.authorizeOrganization(f.tokens.key, 'org-one')).membershipId, 'm-work');
  await denied(() => f.service.authorizeOrganization(f.tokens.key, 'org-two'));
  await denied(() => f.service.getAccount(f.tokens.key));
  await denied(() => f.service.beginEmailLink(f.tokens.key, 'key@mail.example', async () => {}));
});

test('email proof is delivered only to trusted sender, digest-only stored, bound to account, and single use', async t => {
  const f = await fixture(t);
  const p = await startLink(f, ' NEW@MAIL.EXAMPLE ');
  assert.equal(p.address, 'new@mail.example');
  assert.notEqual((await one(f, 'SELECT token_digest FROM memory_identity.email_challenges WHERE id=?', p.id)).token_digest, p.proofToken);
  await denied(() => f.service.completeEmailLink(f.tokens.bob, p.id, p.proofToken));
  await denied(() => f.service.completeEmailLink(f.tokens.alice, p.id, 'incorrect-proof-000000000000000000000000000000'));
  const emailId = await f.service.completeEmailLink(f.tokens.alice, p.id, p.proofToken);
  assert.equal((await one(f, 'SELECT account_id FROM memory_identity.account_emails WHERE id=?', emailId)).account_id, 'alice');
  assert.equal((await one(f, 'SELECT used_at FROM memory_identity.email_challenges WHERE id=?', p.id)).used_at, NOW);
  await denied(() => f.service.completeEmailLink(f.tokens.alice, p.id, p.proofToken));
  assert.equal(await count(f, 'memory_identity.email_consumptions'), 1);
});

test('expiry boundary rejects proof even with fresh session and leaves challenge unconsumed', async t => {
  const f = await fixture(t);
  const p = await startLink(f);
  await f.setNow(p.expiresAt);
  await f.raw.prepare('UPDATE memory_identity.credentials SET reauthenticated_at=? WHERE id=?').run(p.expiresAt, 's-alice');
  await denied(() => f.service.completeEmailLink(f.tokens.alice, p.id, p.proofToken));
  assert.equal((await one(f, 'SELECT used_at FROM memory_identity.email_challenges WHERE id=?', p.id)).used_at, null);
});

test('a current address cannot link to a second account', async t => {
  const f = await fixture(t);
  const p = await startLink(f, 'alice@corp.example', f.tokens.bob);
  await denied(() => f.service.completeEmailLink(f.tokens.bob, p.id, p.proofToken));
  assert.equal(await count(f, 'memory_identity.account_emails'), 4);
});

test('delivery failure invalidates its challenge', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.service.beginEmailLink(f.tokens.alice, 'new@mail.example', async () => { throw new Error('delivery unavailable'); }), /delivery unavailable/);
  assert.equal((await one(f, 'SELECT invalidated_at FROM memory_identity.email_challenges')).invalidated_at, NOW);
});

test('sensitive identity mutations require recent interactive reauthentication', async t => {
  const f = await fixture(t);
  for (const reauth of [NOW - 300_001, NOW + 1]) {
    await f.raw.prepare('UPDATE memory_identity.credentials SET reauthenticated_at=? WHERE id=?').run(reauth, 's-alice');
    await denied(() => f.service.beginEmailLink(f.tokens.alice, 'new@mail.example', async () => {}));
    await denied(() => f.service.unlinkEmail(f.tokens.alice, 'e-work'));
  }
  assert.equal(await count(f, 'memory_identity.revocations'), 0);
});

test('self removal atomically revokes all claim-derived authority and pending proofs only', async t => {
  const f = await fixture(t);
  const pending = await startLink(f, 'alice@corp.example');
  const unrelated = await startLink(f, 'different@mail.example');
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  assert.equal((await one(f, "SELECT revoked_at FROM memory_identity.account_emails WHERE id='e-work'")).revoked_at, NOW);
  assert.equal((await one(f, "SELECT revoked_at FROM memory_identity.memberships WHERE id='m-work'")).revoked_at, NOW);
  assert.equal((await one(f, "SELECT revoked_at FROM memory_identity.credentials WHERE id='k-work'")).revoked_at, NOW);
  assert.equal((await one(f, 'SELECT invalidated_at FROM memory_identity.email_challenges WHERE id=?', pending.id)).invalidated_at, NOW);
  assert.equal((await one(f, 'SELECT invalidated_at FROM memory_identity.email_challenges WHERE id=?', unrelated.id)).invalidated_at, null);
  assert.equal((await f.service.getAccount(f.tokens.alice)).emails.length, 1);
  assert.equal((await f.service.authorizeOrganization(f.tokens.alice, 'org-two')).membershipId, 'm-personal');
  await denied(() => f.service.authorizeOrganization(f.tokens.key, 'org-one'));
  await denied(() => f.service.completeEmailLink(f.tokens.alice, pending.id, pending.proofToken));
  assert.ok(await count(f, 'memory_ops.identity_audit_events') >= 4);
});

test('self removal rejects another account claim and replay', async t => {
  const f = await fixture(t);
  await denied(() => f.service.unlinkEmail(f.tokens.bob, 'e-work'));
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  await denied(() => f.service.unlinkEmail(f.tokens.alice, 'e-work'));
  assert.equal(await count(f, 'memory_identity.revocations'), 1);
});

test('reverification gets a fresh claim and never restores prior memberships or tokens', async t => {
  const f = await fixture(t);
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  const p = await startLink(f, 'alice@corp.example');
  const fresh = await f.service.completeEmailLink(f.tokens.alice, p.id, p.proofToken);
  assert.notEqual(fresh, 'e-work');
  assert.equal((await f.service.getAccount(f.tokens.alice)).emails.length, 2);
  await denied(() => f.service.authorizeOrganization(f.tokens.alice, 'org-one'));
  await denied(() => f.service.authorizeOrganization(f.tokens.key, 'org-one'));
});

test('exact verified delegated domain revocation blocks relinking and preserves unrelated authority', async t => {
  const f = await fixture(t);
  const pending = await startLink(f, 'alice@corp.example', f.tokens.bob);
  await f.service.revokeDomainEmail(f.tokens.admin, 'domain-one', 'ALICE@CORP.EXAMPLE');
  assert.equal((await one(f, "SELECT address FROM memory_identity.email_blocks WHERE address='alice@corp.example'")).address, 'alice@corp.example');
  assert.equal((await one(f, 'SELECT invalidated_at FROM memory_identity.email_challenges WHERE id=?', pending.id)).invalidated_at, NOW);
  await denied(() => f.service.beginEmailLink(f.tokens.alice, 'alice@corp.example', async () => {}));
  await denied(() => f.service.completeEmailLink(f.tokens.bob, pending.id, pending.proofToken));
  assert.equal((await f.service.getAccount(f.tokens.alice)).emails[0].id, 'e-personal');
  assert.equal((await f.service.authorizeOrganization(f.tokens.alice, 'org-two')).organizationId, 'org-two');
});

test('domain manager can block an address with no existing claim', async t => {
  const f = await fixture(t);
  await f.service.revokeDomainEmail(f.tokens.admin, 'domain-one', 'future@corp.example');
  await denied(() => f.service.beginEmailLink(f.tokens.bob, 'future@corp.example', async () => {}));
});

for (const [name, mutate, token, address] of [
  ['undelegated admin', async () => {}, 'alice', 'bob@corp.example'],
  ['subdomain', async () => {}, 'admin', 'bob@sub.corp.example'],
  ['domain suffix', async () => {}, 'admin', 'bob@evilcorp.example'],
  ['unverified domain', async raw => raw.prepare('UPDATE memory_identity.domains SET verified_until=?').run(NOW), 'admin', 'bob@corp.example'],
  ['revoked domain', async raw => raw.prepare('UPDATE memory_identity.domains SET revoked_at=?').run(NOW), 'admin', 'bob@corp.example'],
  ['revoked delegation', async raw => raw.prepare('UPDATE memory_identity.domain_managers SET revoked_at=?').run(NOW), 'admin', 'bob@corp.example'],
  ['ordinary member', async raw => raw.exec("UPDATE memory_identity.memberships SET role='member' WHERE id='m-admin'"), 'admin', 'bob@corp.example'],
  ['expired membership', async raw => raw.prepare("UPDATE memory_identity.memberships SET expires_at=? WHERE id='m-admin'").run(NOW), 'admin', 'bob@corp.example'],
  ['stale reauthentication', async raw => raw.prepare("UPDATE memory_identity.credentials SET reauthenticated_at=? WHERE id='s-admin'").run(NOW - 300_001), 'admin', 'bob@corp.example'],
  ['organization credential', async () => {}, 'key', 'bob@corp.example'],
]) test(`domain revocation rejects ${name}`, async t => {
  const f = await fixture(t); await mutate(f.raw);
  await denied(() => f.service.revokeDomainEmail(f.tokens[token], 'domain-one', address));
  assert.equal(await count(f, 'memory_identity.revocations'), 0); assert.equal(await count(f, 'memory_identity.email_blocks'), 0);
});

for (const [name, mutate] of [
  ['expired token', async raw => raw.prepare("UPDATE memory_identity.credentials SET expires_at=? WHERE id='k-work'").run(NOW)],
  ['revoked token', async raw => raw.prepare("UPDATE memory_identity.credentials SET revoked_at=? WHERE id='k-work'").run(NOW)],
  ['expired membership', async raw => raw.prepare("UPDATE memory_identity.memberships SET expires_at=? WHERE id='m-work'").run(NOW)],
  ['revoked membership', async raw => raw.prepare("UPDATE memory_identity.memberships SET revoked_at=? WHERE id='m-work'").run(NOW)],
  ['disabled organization', async raw => raw.prepare("UPDATE memory_control.organizations SET disabled_at=? WHERE id='org-one'").run(NOW)],
  ['disabled account', async raw => raw.prepare("UPDATE memory_identity.accounts SET disabled_at=? WHERE id='alice'").run(NOW)],
]) test(`organization access rejects ${name}`, async t => {
  const f = await fixture(t); await mutate(f.raw);
  await denied(() => f.service.authorizeOrganization(f.tokens.key, 'org-one'));
});

test('revocation failure rolls back claim, credentials, pending proof, event and every audit', async t => {
  const f = await fixture(t);
  const p = await startLink(f, 'alice@corp.example');
  const before = await count(f, 'memory_ops.identity_audit_events');
  await f.raw.exec(`CREATE FUNCTION memory_ops.reject_membership_audit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='membership_revoked' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER reject_membership_audit BEFORE INSERT ON memory_ops.identity_audit_events
      FOR EACH ROW EXECUTE FUNCTION memory_ops.reject_membership_audit()`);
  await assert.rejects(() => f.service.unlinkEmail(f.tokens.alice, 'e-work'), causeMatches('injected audit failure'));
  assert.equal((await one(f, "SELECT revoked_at FROM memory_identity.account_emails WHERE id='e-work'")).revoked_at, null);
  assert.equal((await one(f, "SELECT revoked_at FROM memory_identity.credentials WHERE id='k-work'")).revoked_at, null);
  assert.equal((await one(f, 'SELECT invalidated_at FROM memory_identity.email_challenges WHERE id=?', p.id)).invalidated_at, null);
  assert.equal(await count(f, 'memory_identity.revocations'), 0); assert.equal(await count(f, 'memory_ops.identity_audit_events'), before);
  assert.equal((await f.service.authorizeOrganization(f.tokens.key, 'org-one')).membershipId, 'm-work');
});

test('proof consumption failure rolls back claim, use marker, consumption and audit', async t => {
  const f = await fixture(t); const p = await startLink(f);
  const before = await count(f, 'memory_ops.identity_audit_events');
  await f.raw.exec(`CREATE FUNCTION memory_ops.reject_link_audit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='email_verified' THEN RAISE EXCEPTION 'injected link audit failure'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER reject_link_audit BEFORE INSERT ON memory_ops.identity_audit_events
      FOR EACH ROW EXECUTE FUNCTION memory_ops.reject_link_audit()`);
  await assert.rejects(() => f.service.completeEmailLink(f.tokens.alice, p.id, p.proofToken), causeMatches('injected link audit failure'));
  assert.equal(await count(f, 'memory_identity.account_emails'), 4); assert.equal(await count(f, 'memory_identity.email_consumptions'), 0);
  assert.equal((await one(f, 'SELECT used_at FROM memory_identity.email_challenges WHERE id=?', p.id)).used_at, null);
  assert.equal(await count(f, 'memory_ops.identity_audit_events'), before);
});

test('claim identity and derived relationships cannot be rewritten or resurrected', async t => {
  const f = await fixture(t);
  for (const sql of [
    "UPDATE memory_identity.account_emails SET address='changed@corp.example' WHERE id='e-work'",
    "UPDATE memory_identity.account_emails SET account_id='bob' WHERE id='e-work'",
    "UPDATE memory_identity.memberships SET email_id='e-personal' WHERE id='m-work'",
    "UPDATE memory_identity.credentials SET membership_id='m-personal',email_id='e-personal' WHERE id='k-work'",
    "DELETE FROM memory_identity.account_emails WHERE id='e-work'",
  ]) await assert.rejects(() => f.raw.exec(sql));
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  for (const table of ['memory_identity.account_emails', 'memory_identity.memberships', 'memory_identity.credentials'])
    await assert.rejects(() => f.raw.exec(`UPDATE ${table} SET revoked_at=NULL WHERE revoked_at IS NOT NULL`));
  await assert.rejects(() => f.raw.exec("INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role) VALUES ('recreated','org-one','alice','e-work','owner')"));
});

test('audit and revocation records are append-only and contain identifiers, never mailbox or token text', async t => {
  const f = await fixture(t);
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  const audit = JSON.stringify(await f.raw.prepare('SELECT * FROM memory_ops.identity_audit_events').all());
  assert.ok(!audit.includes('@')); assert.ok(!audit.includes(f.tokens.alice));
  for (const table of ['memory_ops.identity_audit_events', 'memory_identity.revocations']) {
    await assert.rejects(() => f.raw.exec(`DELETE FROM ${table}`));
    await assert.rejects(() => f.raw.exec(`UPDATE ${table} SET created_at=created_at+1`));
  }
});

test('schema rejects cross-account membership and malformed credential bindings', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.raw.exec("INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role) VALUES ('bad','org-one','bob','e-work','owner')"));
  await assert.rejects(() => seedCredential(f.raw, {id:'bad-key',accountId:'bob',token:'bad-key-0000000000000000000000000000000000',membershipId:'m-work',emailId:'e-work'}));
  await assert.rejects(() => seedCredential(f.raw, {id:'bad-session',accountId:'alice',token:'bad-session-000000000000000000000000000000',kind:'session',membershipId:'m-work',emailId:'e-work'}));
  assert.equal((await digestToken(f.tokens.alice)).length, 64);
});

test('conflict-path upserts cannot rewrite revoked identities or append-only events', async t => {
  const f = await fixture(t);
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  await assert.rejects(() => f.raw.prepare(`INSERT INTO memory_identity.account_emails
    (id,account_id,address,domain,verified_at) VALUES ('e-work','alice','alice@corp.example','corp.example',?)
    ON CONFLICT (id) DO UPDATE SET address='changed@corp.example'`).run(NOW));
  await assert.rejects(() => f.raw.prepare(`INSERT INTO memory_identity.memberships
    (id,organization_id,account_id,email_id,role) VALUES ('m-work','org-two','alice','e-personal','owner')
    ON CONFLICT (id) DO UPDATE SET email_id='e-personal'`).run());
  const auditId = (await one(f, 'SELECT id FROM memory_ops.identity_audit_events LIMIT 1')).id;
  await assert.rejects(() => f.raw.prepare(`INSERT INTO memory_ops.identity_audit_events
    (id,event_type,created_at) VALUES (?,'email_verified',?)
    ON CONFLICT (id) DO UPDATE SET event_type='email_revoked'`).run(auditId, NOW + 1));
  assert.equal((await one(f, "SELECT revoked_at FROM memory_identity.account_emails WHERE id='e-work'")).revoked_at, NOW);
});

test('domain revocation rolls back its block and every affected row when audit insertion fails', async t => {
  const f = await fixture(t);
  const p = await startLink(f, 'alice@corp.example', f.tokens.bob);
  await f.raw.exec(`CREATE FUNCTION memory_ops.fail_domain_audit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='domain_revocation' THEN RAISE EXCEPTION 'domain audit failure'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER fail_domain_audit BEFORE INSERT ON memory_ops.identity_audit_events
      FOR EACH ROW EXECUTE FUNCTION memory_ops.fail_domain_audit()`);
  await assert.rejects(() => f.service.revokeDomainEmail(f.tokens.admin, 'domain-one', 'alice@corp.example'), causeMatches('domain audit failure'));
  assert.equal(await count(f, 'memory_identity.email_blocks'), 0); assert.equal(await count(f, 'memory_identity.revocations'), 0);
  assert.equal(await count(f, 'memory_ops.identity_audit_events'), 0);
  assert.equal((await one(f, 'SELECT invalidated_at FROM memory_identity.email_challenges WHERE id=?', p.id)).invalidated_at, null);
  assert.equal((await f.service.authorizeOrganization(f.tokens.key, 'org-one')).membershipId, 'm-work');
});

test('revocation cascade applies through explicit service updates', async t => {
  const f = await fixture(t);
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  assert.equal((await one(f, "SELECT revoked_at FROM memory_identity.credentials WHERE id='k-work'")).revoked_at, NOW);
  assert.equal((await one(f, "SELECT revoked_at FROM memory_identity.memberships WHERE id='m-work'")).revoked_at, NOW);
  assert.ok(await count(f, 'memory_ops.identity_audit_events') >= 4);
});

test('expired memberships deny session organization access while the personal account remains available', async t => {
  const f = await fixture(t);
  await f.raw.prepare("UPDATE memory_identity.memberships SET expires_at=? WHERE id='m-work'").run(NOW);
  await denied(() => f.service.authorizeOrganization(f.tokens.alice, 'org-one'));
  assert.equal((await f.service.getAccount(f.tokens.alice)).id, 'alice');
});

test('removing the last email keeps the stable account alive', async t => {
  const f = await fixture(t);
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  await f.service.unlinkEmail(f.tokens.alice, 'e-personal');
  assert.deepEqual(await f.service.getAccount(f.tokens.alice), { id: 'alice', emails: [] });
});

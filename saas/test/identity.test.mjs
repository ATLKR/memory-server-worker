import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityDenied, IdentityInvalid, canonicalEmail, digestToken } from '../src/identity.ts';
import { createFixture, startLink, seedCredential, NOW } from './helpers.mjs';

async function fixture(t) { const f = await createFixture(); t.after(f.close); return f; }
function one(f, sql, ...values) { return f.raw.prepare(sql).get(...values); }
function count(f, table) { return one(f, `SELECT count(*) AS n FROM ${table}`).n; }
const denied = fn => assert.rejects(fn, IdentityDenied);

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
  assert.notEqual(one(f, 'SELECT token_digest FROM email_challenges WHERE id=?', p.id).token_digest, p.proofToken);
  await denied(() => f.service.completeEmailLink(f.tokens.bob, p.id, p.proofToken));
  await denied(() => f.service.completeEmailLink(f.tokens.alice, p.id, 'incorrect-proof-000000000000000000000000000000'));
  const emailId = await f.service.completeEmailLink(f.tokens.alice, p.id, p.proofToken);
  assert.equal(one(f, 'SELECT account_id FROM account_emails WHERE id=?', emailId).account_id, 'alice');
  assert.equal(one(f, 'SELECT used_at FROM email_challenges WHERE id=?', p.id).used_at, NOW);
  await denied(() => f.service.completeEmailLink(f.tokens.alice, p.id, p.proofToken));
  assert.equal(count(f, 'email_consumptions'), 1);
});

test('expiry boundary rejects proof even with fresh session and leaves challenge unconsumed', async t => {
  const f = await fixture(t);
  const p = await startLink(f);
  f.setNow(p.expiresAt);
  f.raw.prepare('UPDATE credentials SET reauthenticated_at=? WHERE id=?').run(p.expiresAt, 's-alice');
  await denied(() => f.service.completeEmailLink(f.tokens.alice, p.id, p.proofToken));
  assert.equal(one(f, 'SELECT used_at FROM email_challenges WHERE id=?', p.id).used_at, null);
});

test('a current address cannot link to a second account', async t => {
  const f = await fixture(t);
  const p = await startLink(f, 'alice@corp.example', f.tokens.bob);
  await denied(() => f.service.completeEmailLink(f.tokens.bob, p.id, p.proofToken));
  assert.equal(count(f, 'account_emails'), 4);
});

test('delivery failure invalidates its challenge', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.service.beginEmailLink(f.tokens.alice, 'new@mail.example', async () => { throw new Error('delivery unavailable'); }), /delivery unavailable/);
  assert.equal(one(f, 'SELECT invalidated_at FROM email_challenges').invalidated_at, NOW);
});

test('sensitive identity mutations require recent interactive reauthentication', async t => {
  const f = await fixture(t);
  for (const reauth of [NOW - 300_001, NOW + 1]) {
    f.raw.prepare('UPDATE credentials SET reauthenticated_at=? WHERE id=?').run(reauth, 's-alice');
    await denied(() => f.service.beginEmailLink(f.tokens.alice, 'new@mail.example', async () => {}));
    await denied(() => f.service.unlinkEmail(f.tokens.alice, 'e-work'));
  }
  assert.equal(count(f, 'revocations'), 0);
});

test('self removal atomically revokes all claim-derived authority and pending proofs only', async t => {
  const f = await fixture(t);
  const pending = await startLink(f, 'alice@corp.example');
  const unrelated = await startLink(f, 'different@mail.example');
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  assert.equal(one(f, "SELECT revoked_at FROM account_emails WHERE id='e-work'").revoked_at, NOW);
  assert.equal(one(f, "SELECT revoked_at FROM memberships WHERE id='m-work'").revoked_at, NOW);
  assert.equal(one(f, "SELECT revoked_at FROM credentials WHERE id='k-work'").revoked_at, NOW);
  assert.equal(one(f, 'SELECT invalidated_at FROM email_challenges WHERE id=?', pending.id).invalidated_at, NOW);
  assert.equal(one(f, 'SELECT invalidated_at FROM email_challenges WHERE id=?', unrelated.id).invalidated_at, null);
  assert.equal((await f.service.getAccount(f.tokens.alice)).emails.length, 1);
  assert.equal((await f.service.authorizeOrganization(f.tokens.alice, 'org-two')).membershipId, 'm-personal');
  await denied(() => f.service.authorizeOrganization(f.tokens.key, 'org-one'));
  await denied(() => f.service.completeEmailLink(f.tokens.alice, pending.id, pending.proofToken));
  assert.ok(count(f, 'audit_events') >= 4);
});

test('self removal rejects another account claim and replay', async t => {
  const f = await fixture(t);
  await denied(() => f.service.unlinkEmail(f.tokens.bob, 'e-work'));
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  await denied(() => f.service.unlinkEmail(f.tokens.alice, 'e-work'));
  assert.equal(count(f, 'revocations'), 1);
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
  assert.equal(one(f, "SELECT address FROM email_blocks WHERE address='alice@corp.example'").address, 'alice@corp.example');
  assert.equal(one(f, 'SELECT invalidated_at FROM email_challenges WHERE id=?', pending.id).invalidated_at, NOW);
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
  ['undelegated admin', () => {}, 'alice', 'bob@corp.example'],
  ['subdomain', () => {}, 'admin', 'bob@sub.corp.example'],
  ['domain suffix', () => {}, 'admin', 'bob@evilcorp.example'],
  ['unverified domain', raw => raw.prepare('UPDATE domains SET verified_until=?').run(NOW), 'admin', 'bob@corp.example'],
  ['revoked domain', raw => raw.prepare('UPDATE domains SET revoked_at=?').run(NOW), 'admin', 'bob@corp.example'],
  ['revoked delegation', raw => raw.prepare('UPDATE domain_managers SET revoked_at=?').run(NOW), 'admin', 'bob@corp.example'],
  ['ordinary member', raw => raw.exec("UPDATE memberships SET role='member' WHERE id='m-admin'"), 'admin', 'bob@corp.example'],
  ['expired membership', raw => raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m-admin'").run(NOW), 'admin', 'bob@corp.example'],
  ['stale reauthentication', raw => raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='s-admin'").run(NOW - 300_001), 'admin', 'bob@corp.example'],
  ['organization credential', () => {}, 'key', 'bob@corp.example'],
]) test(`domain revocation rejects ${name}`, async t => {
  const f = await fixture(t); mutate(f.raw);
  await denied(() => f.service.revokeDomainEmail(f.tokens[token], 'domain-one', address));
  assert.equal(count(f, 'revocations'), 0); assert.equal(count(f, 'email_blocks'), 0);
});

for (const [name, mutate] of [
  ['expired token', raw => raw.prepare("UPDATE credentials SET expires_at=? WHERE id='k-work'").run(NOW)],
  ['revoked token', raw => raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='k-work'").run(NOW)],
  ['expired membership', raw => raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m-work'").run(NOW)],
  ['revoked membership', raw => raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m-work'").run(NOW)],
  ['disabled organization', raw => raw.prepare("UPDATE organizations SET disabled_at=? WHERE id='org-one'").run(NOW)],
  ['disabled account', raw => raw.prepare("UPDATE accounts SET disabled_at=? WHERE id='alice'").run(NOW)],
]) test(`organization access rejects ${name}`, async t => {
  const f = await fixture(t); mutate(f.raw);
  await denied(() => f.service.authorizeOrganization(f.tokens.key, 'org-one'));
});

test('revocation failure rolls back claim, credentials, pending proof, event and every audit', async t => {
  const f = await fixture(t);
  const p = await startLink(f, 'alice@corp.example');
  const before = count(f, 'audit_events');
  f.raw.exec(`CREATE TRIGGER reject_membership_audit BEFORE INSERT ON audit_events
    WHEN NEW.event_type='membership_revoked' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;`);
  await assert.rejects(() => f.service.unlinkEmail(f.tokens.alice, 'e-work'), /injected audit failure/);
  assert.equal(one(f, "SELECT revoked_at FROM account_emails WHERE id='e-work'").revoked_at, null);
  assert.equal(one(f, "SELECT revoked_at FROM credentials WHERE id='k-work'").revoked_at, null);
  assert.equal(one(f, 'SELECT invalidated_at FROM email_challenges WHERE id=?', p.id).invalidated_at, null);
  assert.equal(count(f, 'revocations'), 0); assert.equal(count(f, 'audit_events'), before);
  assert.equal((await f.service.authorizeOrganization(f.tokens.key, 'org-one')).membershipId, 'm-work');
});

test('proof consumption failure rolls back claim, use marker, consumption and audit', async t => {
  const f = await fixture(t); const p = await startLink(f);
  const before = count(f, 'audit_events');
  f.raw.exec(`CREATE TRIGGER reject_link_audit BEFORE INSERT ON audit_events
    WHEN NEW.event_type='email_verified' BEGIN SELECT RAISE(ABORT,'injected link audit failure'); END;`);
  await assert.rejects(() => f.service.completeEmailLink(f.tokens.alice, p.id, p.proofToken), /injected link audit failure/);
  assert.equal(count(f, 'account_emails'), 4); assert.equal(count(f, 'email_consumptions'), 0);
  assert.equal(one(f, 'SELECT used_at FROM email_challenges WHERE id=?', p.id).used_at, null);
  assert.equal(count(f, 'audit_events'), before);
});

test('claim identity and derived relationships cannot be rewritten or resurrected', async t => {
  const f = await fixture(t);
  for (const sql of [
    "UPDATE account_emails SET address='changed@corp.example' WHERE id='e-work'",
    "UPDATE account_emails SET account_id='bob' WHERE id='e-work'",
    "UPDATE memberships SET email_id='e-personal' WHERE id='m-work'",
    "UPDATE credentials SET membership_id='m-personal',email_id='e-personal' WHERE id='k-work'",
    "DELETE FROM account_emails WHERE id='e-work'",
  ]) assert.throws(() => f.raw.exec(sql));
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  for (const table of ['account_emails', 'memberships', 'credentials'])
    assert.throws(() => f.raw.exec(`UPDATE ${table} SET revoked_at=NULL WHERE revoked_at IS NOT NULL`));
  assert.throws(() => f.raw.exec("INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES ('recreated','org-one','alice','e-work','owner')"));
});

test('audit and revocation records are append-only and contain identifiers, never mailbox or token text', async t => {
  const f = await fixture(t);
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  const audit = JSON.stringify(f.raw.prepare('SELECT * FROM audit_events').all());
  assert.ok(!audit.includes('@')); assert.ok(!audit.includes(f.tokens.alice));
  for (const table of ['audit_events', 'revocations']) {
    assert.throws(() => f.raw.exec(`DELETE FROM ${table}`));
    assert.throws(() => f.raw.exec(`UPDATE ${table} SET created_at=created_at+1`));
  }
});

test('schema rejects cross-account membership and malformed credential bindings', async t => {
  const f = await fixture(t);
  assert.throws(() => f.raw.exec("INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES ('bad','org-one','bob','e-work','owner')"));
  await assert.rejects(() => seedCredential(f.raw, {id:'bad-key',accountId:'bob',token:'bad-key-0000000000000000000000000000000000',membershipId:'m-work',emailId:'e-work'}));
  await assert.rejects(() => seedCredential(f.raw, {id:'bad-session',accountId:'alice',token:'bad-session-000000000000000000000000000000',kind:'session',membershipId:'m-work',emailId:'e-work'}));
  assert.equal((await digestToken(f.tokens.alice)).length, 64);
});

test('REPLACE cannot rewrite revoked identities or append-only events with recursive triggers disabled', async t => {
  const f = await fixture(t);
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  f.raw.exec('PRAGMA recursive_triggers=OFF');
  assert.throws(() => f.raw.prepare(`INSERT OR REPLACE INTO account_emails
    (id,account_id,address,domain,verified_at) VALUES ('e-work','alice','alice@corp.example','corp.example',?)`).run(NOW));
  assert.throws(() => f.raw.exec(`INSERT OR REPLACE INTO memberships
    (id,organization_id,account_id,email_id,role) VALUES ('m-work','org-two','alice','e-personal','owner')`));
  const auditId = one(f, 'SELECT id FROM audit_events LIMIT 1').id;
  assert.throws(() => f.raw.prepare(`INSERT OR REPLACE INTO audit_events
    (id,event_type,created_at) VALUES (?,'email_verified',?)`).run(auditId, NOW + 1));
  assert.equal(one(f, "SELECT revoked_at FROM account_emails WHERE id='e-work'").revoked_at, NOW);
});

test('domain revocation rolls back its block and every affected row when audit insertion fails', async t => {
  const f = await fixture(t);
  const p = await startLink(f, 'alice@corp.example', f.tokens.bob);
  f.raw.exec(`CREATE TRIGGER fail_domain_audit BEFORE INSERT ON audit_events
    WHEN NEW.event_type='domain_revocation' BEGIN SELECT RAISE(ABORT,'domain audit failure'); END`);
  await assert.rejects(() => f.service.revokeDomainEmail(f.tokens.admin, 'domain-one', 'alice@corp.example'), /domain audit failure/);
  assert.equal(count(f, 'email_blocks'), 0); assert.equal(count(f, 'revocations'), 0);
  assert.equal(count(f, 'audit_events'), 0);
  assert.equal(one(f, 'SELECT invalidated_at FROM email_challenges WHERE id=?', p.id).invalidated_at, null);
  assert.equal((await f.service.authorizeOrganization(f.tokens.key, 'org-one')).membershipId, 'm-work');
});

test('revocation cascade works without recursive trigger configuration', async t => {
  const f = await fixture(t);
  f.raw.exec('PRAGMA recursive_triggers=OFF');
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  assert.equal(one(f, "SELECT revoked_at FROM credentials WHERE id='k-work'").revoked_at, NOW);
  assert.equal(one(f, "SELECT revoked_at FROM memberships WHERE id='m-work'").revoked_at, NOW);
  assert.ok(count(f, 'audit_events') >= 4);
});

test('expired memberships deny session organization access while the personal account remains available', async t => {
  const f = await fixture(t);
  f.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m-work'").run(NOW);
  await denied(() => f.service.authorizeOrganization(f.tokens.alice, 'org-one'));
  assert.equal((await f.service.getAccount(f.tokens.alice)).id, 'alice');
});

test('removing the last email keeps the stable account alive', async t => {
  const f = await fixture(t);
  await f.service.unlinkEmail(f.tokens.alice, 'e-work');
  await f.service.unlinkEmail(f.tokens.alice, 'e-personal');
  assert.deepEqual(await f.service.getAccount(f.tokens.alice), { id: 'alice', emails: [] });
});

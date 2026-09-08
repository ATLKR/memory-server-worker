import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { IdentityService, digestToken } from '../src/identity.ts';

export const NOW = 1_700_000_000_000;
export const tokens = Object.freeze({
  alice: 'alice-session-00000000000000000000000000000000',
  bob: 'bob-session-0000000000000000000000000000000000',
  admin: 'admin-session-00000000000000000000000000000000',
  key: 'alice-org-key-00000000000000000000000000000000',
});

/** Real SQLite adapter for the same small D1 contract consumed by services. */
export function createDatabase({ memory = false, workspace = false } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  if (memory || workspace) raw.exec(readFileSync(new URL('../memory-schema.sql', import.meta.url), 'utf8'));
  if (workspace) for (const schema of ['product-schema.sql', 'auth-schema.sql', 'hierarchy-schema.sql'])
    raw.exec(readFileSync(new URL(`../${schema}`, import.meta.url), 'utf8'));
  const primaryReads = [];
  const db = {
    prepare(sql) {
      const statement = raw.prepare(sql);
      let values = [];
      return {
        bind(...bound) { values = bound; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values), success: true }; },
        async run() {
          const result = statement.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
    },
    withSession(constraint) {
      if (constraint !== 'first-primary') throw new Error('Primary reads required');
      primaryReads.push(constraint);
      return { prepare: sql => db.prepare(sql) };
    },
  };
  return { raw, db, primaryReads, close: () => raw.close() };
}

export async function seedCredential(raw, {
  id, accountId, token, membershipId = null, emailId = null,
  kind = membershipId ? 'api_key' : 'session', permission = 'write',
  expiresAt = NOW + 3_600_000, reauthenticatedAt = NOW,
}) {
  raw.prepare(`INSERT INTO credentials
    (id,account_id,membership_id,email_id,kind,token_digest,expires_at,reauthenticated_at,permission)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, accountId, membershipId, emailId, kind,
    await digestToken(token), expiresAt, reauthenticatedAt, permission);
}

export async function createFixture(options) {
  const result = createDatabase(options);
  const { raw, db } = result;
  let now = NOW;
  raw.exec(`
    INSERT INTO accounts(id) VALUES ('alice'),('bob'),('admin');
    INSERT INTO account_emails(id,account_id,address,domain,verified_at) VALUES
      ('e-work','alice','alice@corp.example','corp.example',${NOW}),
      ('e-personal','alice','alice@mail.example','mail.example',${NOW}),
      ('e-bob','bob','bob@corp.example','corp.example',${NOW}),
      ('e-admin','admin','admin@corp.example','corp.example',${NOW});
    INSERT INTO organizations(id) VALUES ('org-one'),('org-two');
    INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES
      ('m-work','org-one','alice','e-work','admin'),
      ('m-personal','org-two','alice','e-personal','owner'),
      ('m-admin','org-one','admin','e-admin','admin');
    INSERT INTO domains(id,organization_id,name,verified_until)
      VALUES ('domain-one','org-one','corp.example',${NOW + 3_600_000});
    INSERT INTO domain_managers(domain_id,membership_id) VALUES ('domain-one','m-admin');
  `);
  await seedCredential(raw, { id: 's-alice', accountId: 'alice', token: tokens.alice });
  await seedCredential(raw, { id: 's-bob', accountId: 'bob', token: tokens.bob });
  await seedCredential(raw, { id: 's-admin', accountId: 'admin', token: tokens.admin });
  await seedCredential(raw, { id: 'k-work', accountId: 'alice', token: tokens.key,
    membershipId: 'm-work', emailId: 'e-work' });
  return { ...result, tokens, clock: () => now, setNow: value => { now = value; },
    service: new IdentityService(db, () => now) };
}

export async function startLink(fixture, address = 'new@mail.example', token = tokens.alice) {
  let delivered;
  const id = await fixture.service.beginEmailLink(token, address, async mail => { delivered = mail; });
  return { id, ...delivered };
}

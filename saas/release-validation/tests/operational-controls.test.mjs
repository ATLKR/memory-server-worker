import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { fixture, at } from './db.mjs';
import { admitSignIn } from '../../src/release/enrollment.ts';
import { reserveProvider } from '../../src/release/provider-budget.ts';
import { digest } from '../../src/release/util.ts';
import { embed, Search } from '../../src/release/search.ts';
import { Ingest } from '../../src/release/ingest.ts';
import { Jobs } from '../../src/release/jobs.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { WorkspaceService } from '../../src/workspace.ts';
import { createApplication } from '../../src/app.ts';
import { readSettings, AUTH_ISSUER, PUBLIC_ORIGIN } from '../../src/config.ts';

async function setup(t) {
  let now = at;
  const f = await fixture({ clock: () => now }); t.after(() => f.db.close());
  if (!f.db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='release_provider_budgets'").get())
    f.db.raw.exec(readFileSync(new URL('../../operational-schema.sql', import.meta.url), 'utf8'));
  return { ...f, clock: () => now, advance: value => { now = value; }, env: { DB: f.db, RELEASE_MODE: 'ga', ENROLLMENT_MODE: 'invite', AI_MONTHLY_BUDGET_MICROUSD: '30200' } };
}
const principal = (overrides = {}) => ({ issuer: AUTH_ISSUER, subject: 'new-user', email: 'alice@example.com', emailVerified: true, expiresAt: at + 900000, permission: 'write', ...overrides });
const rejected = code => error => error.code === code;
const totals = db => db.raw.prepare('SELECT coalesce(sum(calls),0) calls,coalesce(sum(reserved_microusd),0) reserved FROM release_provider_budgets').get();
function afterReservation(db, action) {
  const prepare = db.prepare.bind(db); let calls = 0;
  db.prepare = sql => {
    const s = prepare(sql);
    if (sql.startsWith('INSERT INTO release_provider_budgets')) {
      const first = s.first.bind(s); s.first = async () => { const result = await first(); calls++; await action(); return result; };
    }
    return s;
  };
  return () => calls;
}
test('invite gate uses verified canonical mailbox hashes without alias folding', async t => {
  const f = await setup(t), env = { ...f.env, ENROLLMENT_EMAIL_HASHES_JSON: JSON.stringify([await digest('alice+pilot@example.com')]) };
  await admitSignIn(env, principal({ email: ' ALICE+PILOT@EXAMPLE.COM ' }));
  for (const email of ['alice@example.com', 'alice.pilot@example.com', 'not-an-email'])
    await assert.rejects(() => admitSignIn(env, principal({ email })), rejected('invitation_required'));
  await assert.rejects(() => admitSignIn(env, principal({ email: 'alice+pilot@example.com', emailVerified: false })), rejected('invitation_required'));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM provider_identities').get().n, 0, 'Admission itself creates no identity or access');
});
test('exact mapped active identities are grandfathered without trusting a changed token email', async t => {
  const f = await setup(t);
  f.db.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(AUTH_ISSUER, 'existing', 'alice', at);
  await admitSignIn({ ...f.env, ENROLLMENT_EMAIL_HASHES_JSON: 'invalid operator JSON' }, principal({ subject: 'existing', emailVerified: false, email: undefined }));
  await assert.rejects(() => admitSignIn(f.env, principal({ subject: 'existing', issuer: 'https://different.example' })), rejected('invitation_required'));
});
test('a roster entry never admits a disabled mapped account or revives it', async t => {
  const f = await setup(t), p = principal({ subject: 'disabled' });
  f.db.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(p.issuer, p.subject, 'alice', at);
  f.db.raw.prepare('UPDATE accounts SET disabled_at=? WHERE id=?').run(at, 'alice');
  const env = { ...f.env, ENROLLMENT_EMAIL_HASHES_JSON: JSON.stringify([await digest(p.email)]) };
  await assert.rejects(() => admitSignIn(env, p), rejected('invitation_required'));
  assert.equal(f.db.raw.prepare("SELECT disabled_at FROM accounts WHERE id='alice'").get().disabled_at, at);
});
for (const roster of ['{', '{}', '[null]', '[1]', '["A" ]', JSON.stringify(Array(201).fill('a'.repeat(64)))])
  test('malformed enrollment roster fails closed: ' + roster.slice(0, 12), async t => {
    const f = await setup(t);
    await assert.rejects(() => admitSignIn({ ...f.env, ENROLLMENT_EMAIL_HASHES_JSON: roster }, principal()), rejected('enrollment_not_configured'));
  });
test('GA refuses open or missing enrollment mode; pilot retains its explicit compatibility behavior', async t => {
  const f = await setup(t);
  for (const mode of [undefined, 'open', 'typo'])
    await assert.rejects(() => admitSignIn({ ...f.env, ENROLLMENT_MODE: mode }, principal()), rejected('enrollment_not_configured'));
  await admitSignIn({ ...f.env, RELEASE_MODE: 'pilot', ENROLLMENT_MODE: 'open' }, principal());
});
test('signed OAuth signup admission runs before account, Space, or credential creation', async t => {
  const f = await setup(t), keys = await generateKeyPair('RS256'), settings = readSettings({ SSO_CLIENT_ID: 'enrollment-client' });
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), alg: 'RS256', kid: 'enroll', use: 'sig' }] });
  const p = principal({ email: 'new@example.com' });
  const bearer = await new SignJWT({ iss: p.issuer, sub: p.subject, aud: PUBLIC_ORIGIN, client_id: settings.auth.clientId, azp: settings.auth.clientId,
    token_use: 'access', banned: false, jti: 'enrollment-token', iat: at / 1000, exp: (at + 900000) / 1000,
    scope: 'openid profile email memory:read memory:write', email: p.email, emailVerified: true })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'enroll' }).sign(keys.privateKey);
  const env = { ...f.env, ENROLLMENT_EMAIL_HASHES_JSON: '[]' };
  const release = { beforeSignIn: value => admitSignIn(env, value), async signedIn() {}, async publicRoute() { return null; }, async route() { return null; } };
  const app = createApplication(f.db, settings, { clock: f.clock, auth: { jwks }, release });
  const request = () => app(new Request(PUBLIC_ORIGIN + '/v1/spaces', { headers: { authorization: 'Bearer ' + bearer } }));
  const before = ['accounts', 'spaces', 'credentials', 'provider_identities'].map(table => f.db.raw.prepare('SELECT count(*) n FROM ' + table).get().n);
  assert.equal((await request()).status, 401);
  assert.deepEqual(['accounts', 'spaces', 'credentials', 'provider_identities'].map(table => f.db.raw.prepare('SELECT count(*) n FROM ' + table).get().n), before);
  env.ENROLLMENT_EMAIL_HASHES_JSON = JSON.stringify([await digest(p.email)]);
  assert.equal((await request()).status, 200);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM provider_identities WHERE subject=?').get(p.subject).n, 1);
  env.ENROLLMENT_EMAIL_HASHES_JSON = '[]';
  assert.equal((await request()).status, 200, 'Existing admission is not an ongoing ACL');
  f.db.raw.prepare('UPDATE accounts SET disabled_at=? WHERE id=(SELECT account_id FROM provider_identities WHERE subject=?)').run(at, p.subject);
  assert.equal((await request()).status, 401);
});
test('the primary sign-in trigger also catches account disablement after admission', async t => {
  const f = await setup(t), p = principal({ subject: 'disable-during-signin' });
  f.db.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(p.issuer, p.subject, 'alice', at);
  await admitSignIn(f.env, p);
  f.db.raw.prepare("UPDATE accounts SET disabled_at=? WHERE id='alice'").run(at);
  const count = f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n;
  await assert.rejects(() => new WorkspaceService(f.db, f.clock).signIn(p));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n, count);
});
test('provider reservations atomically share one cap across kinds and concurrent callers', async t => {
  const f = await setup(t);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveProvider(f.env, i ? 'embedding' : 'extraction')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'provider_budget_exhausted'));
  assert.deepEqual({ ...totals(f.db) }, { calls: 2, reserved: 30200 });
});
test('provider month changes at the UTC execution-time boundary and retains old reservations', async t => {
  const f = await setup(t), env = { ...f.env, AI_MONTHLY_BUDGET_MICROUSD: '200' };
  f.advance(Date.UTC(2030, 0, 31, 23, 59, 59, 999)); await reserveProvider(env, 'embedding');
  await assert.rejects(() => reserveProvider(env, 'embedding'), rejected('provider_budget_exhausted'));
  f.advance(Date.UTC(2030, 1, 1)); await reserveProvider(env, 'embedding');
  assert.deepEqual(f.db.raw.prepare('SELECT month,reserved_microusd amount FROM release_provider_budgets ORDER BY month').all().map(r => ({ ...r })),
    [{ month: '2030-01', amount: 200 }, { month: '2030-02', amount: 200 }]);
});
for (const budget of [undefined, '', '-1', '1.0', '001', 'NaN', '1000000000', [200], 200])
  test('GA rejects malformed or missing provider budget: ' + JSON.stringify(budget), async t => {
    const f = await setup(t);
    await assert.rejects(() => reserveProvider({ ...f.env, AI_MONTHLY_BUDGET_MICROUSD: budget }, 'embedding'), rejected('provider_budget_not_configured'));
    assert.equal(totals(f.db).calls, 0);
  });
test('zero budget stops provider calls while missing pilot budget preserves local compatibility', async t => {
  const f = await setup(t);
  await assert.rejects(() => reserveProvider({ ...f.env, AI_MONTHLY_BUDGET_MICROUSD: '0' }, 'embedding'), rejected('provider_budget_exhausted'));
  await reserveProvider({ DB: f.db, RELEASE_MODE: 'pilot' }, 'embedding');
  assert.equal(totals(f.db).calls, 0);
});
test('provider retries reserve again after an uncertain failure and never refund it', async t => {
  const f = await setup(t); let calls = 0;
  const env = { ...f.env, AI_MONTHLY_BUDGET_MICROUSD: '400', AI: { async run() { calls++; throw Error('uncertain upstream response'); } } };
  await assert.rejects(() => embed(env, 'first'), /uncertain upstream response/);
  await assert.rejects(() => embed(env, 'retry'), /uncertain upstream response/);
  await assert.rejects(() => embed(env, 'over cap'), rejected('provider_budget_exhausted'));
  assert.equal(calls, 2); assert.deepEqual({ ...totals(f.db) }, { calls: 2, reserved: 400 });
});
test('embedding byte bound rejects multibyte oversize before reservation or provider dispatch', async t => {
  const f = await setup(t); let calls = 0;
  const env = { ...f.env, AI: { async run() { calls++; return { data: [Array(1024).fill(.1)] }; } } };
  await embed(env, '😀'.repeat(2000));
  await assert.rejects(() => embed(env, '😀'.repeat(2001)), rejected('embedding_input_too_large'));
  assert.equal(calls, 1); assert.equal(totals(f.db).reserved, 200);
});
test('reservation database failure stops dispatch and preserves the real database error', async t => {
  const f = await setup(t), original = Error('fixture database unavailable'); let calls = 0;
  const env = { ...f.env, DB: { prepare() { throw original; } }, AI: { async run() { calls++; } } };
  await assert.rejects(() => embed(env, 'secret'), error => error === original); assert.equal(calls, 0);
});
test('search rechecks revocation after the budget await and retries do not buy another embedding', async t => {
  const f = await setup(t); let calls = 0;
  const env = { ...f.env, AI: { async run() { calls++; return { data: [Array(1024).fill(.1)] }; } }, MEMORY_INDEX: { async query() { return { matches: [] }; } } };
  const count = afterReservation(f.db, () => f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at));
  await assert.rejects(() => new Search(env, f.clock).query(f.token, 's1', 'private', 10, 'budget-search'), error => error.status === 403);
  assert.equal(count(), 1); assert.equal(calls, 0);
  // Use the other account for a normal search/replay pair; reservations remain global.
  const search = new Search(env, f.clock);
  await search.query(f.other, 's2', 'public', 10, 'normal'); await search.query(f.other, 's2', 'public', 10, 'normal');
  assert.equal(calls, 1); assert.equal(totals(f.db).calls, 2);
});
test('index jobs recheck the current source after the budget await before disclosing plaintext', async t => {
  const f = await setup(t); let calls = 0;
  const env = { ...f.env, AI: { async run() { calls++; return { data: [Array(1024).fill(.1)] }; } }, MEMORY_INDEX: { async upsert() { calls++; } } };
  const memory = await new MemoryStore(f.db, f.clock).create(f.token, 's1', { body: 'index private text' }, 'index-seed');
  const jobs = new Jobs(env, f.clock), job = await jobs.claim(); assert.ok(job);
  const count = afterReservation(f.db, () => new MemoryStore(f.db, f.clock).remove(f.token, 's1', memory.id, 1, 'during-budget'));
  await assert.rejects(() => jobs.index(job), /index_authority_lost/);
  assert.equal(count(), 1); assert.equal(calls, 0); assert.equal(totals(f.db).reserved, 200);
});
test('ingestion rechecks current authority after the budget await and preserves the reservation', async t => {
  const f = await setup(t); let calls = 0;
  const env = { ...f.env, BACKGROUND_JOBS_ENABLED: 'true', PAYLOAD_KEY: Buffer.alloc(32, 8).toString('base64url'), AI: { async run() { calls++; return { response: { memories: [] } }; } } };
  const ingest = new Ingest(env, f.clock), jobs = new Jobs(env, f.clock); jobs.ingest = job => ingest.process(job);
  await ingest.submit(f.token, 'so', { messages: [{ id: 'm', role: 'user', content: 'private source' }] }, 'ingest-budget');
  const job = await jobs.claim(); assert.ok(job);
  const count = afterReservation(f.db, () => f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m1'").run(at));
  await assert.rejects(() => ingest.process(job), rejected('ingest_authority_expired'));
  assert.equal(count(), 1); assert.equal(calls, 0); assert.equal(totals(f.db).reserved, 30000);
});
test('extraction bounds the source and output before buying provider work', async t => {
  const f = await setup(t), calls = [];
  const env = { ...f.env, BACKGROUND_JOBS_ENABLED: 'true', PAYLOAD_KEY: Buffer.alloc(32, 8).toString('base64url'), AI: { async run(model, input) { calls.push(input); return { response: { memories: [] } }; } } };
  const ingest = new Ingest(env, f.clock), jobs = new Jobs(env, f.clock); jobs.ingest = job => ingest.process(job);
  const messages = Array.from({ length: 3 }, (_, i) => ({ id: 'm' + i, role: 'user', content: 'x'.repeat(7900) }));
  await ingest.submit(f.token, 's1', { messages }, 'valid-extract');
  await assert.rejects(() => ingest.submit(f.token, 's1', { messages: [...messages, { id: 'extra', role: 'user', content: 'x'.repeat(1000) }] }, 'oversize-extract'), rejected('conversation_too_large'));
  await jobs.drain(1); assert.equal(calls.length, 1); assert.equal(calls[0].max_tokens, 3000);
  assert.ok(new TextEncoder().encode(calls[0].messages[1].content).length <= 24000);
  assert.equal(totals(f.db).reserved, 30000);
});

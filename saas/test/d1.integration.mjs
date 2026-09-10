import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parse } from 'jsonc-parser';
import { WorkspaceService } from '../src/workspace.ts';
import { MemoryService } from '../src/memory.ts';
import { Jobs } from '../src/release/jobs.ts';
import { Billing } from '../src/release/billing.ts';
import { createRelease } from '../src/release/extension.ts';
import { digest } from '../src/release/util.ts';
import { applySql } from './apply-sql.mjs';

const config = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'saas-product-integration', modules: true,
  scriptPath: fileURLToPath(new URL('../.local/build/worker.js', import.meta.url)),
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  d1Databases: ['DB'], bindings: config.vars,
  ratelimits: { REQUEST_LIMITER: { namespace_id: '2086090801', simple: { limit: 120, period: 60 } } },
}));
const parser = new DatabaseSync(':memory:');
try {
  const db = await mf.getD1Database('DB');
  // Existing historical rows are fixture data, not newly backdated requests.
  // Keep native SQLite's clock while preserving normal history/index triggers.
  async function historicalTombstone(spaceId, actorId, body, at) {
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO memories(id,space_id,body,revision,created_at,updated_at,actor_credential_id) VALUES(?,?,?,1,?,?,?)').bind(id, spaceId, body, at, at, actorId).run();
    await db.prepare('UPDATE memories SET revision=2,deleted_at=?,updated_at=? WHERE id=?').bind(at, at, id).run();
    return { id, body, revision: 2 };
  }
  for (const file of ['schema.sql', 'memory-schema.sql', 'product-schema.sql', 'auth-schema.sql']) parser.exec(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  for (const row of parser.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').all()) await db.prepare(row.sql).run();
  const baselineLastRow = parser.prepare('SELECT max(rowid) AS id FROM sqlite_master').get().id;
  const workspace = new WorkspaceService(db);
  const principal = subject => ({ issuer: 'https://auth-api.allen.company', subject, email: `${subject}@example.org`, emailVerified: true, permission: 'write', expiresAt: Date.now() + 900000 });
  const owner = await workspace.signIn(principal('owner'));
  const guest = await workspace.signIn(principal('guest'));
  const ownerEmail = await db.prepare('SELECT id FROM account_emails WHERE account_id=?').bind(owner.accountId).first();
  const organization = await workspace.createOrganization(owner.token, { name: 'D1 team', emailId: ownerEmail.id });
  // Apply the forward migration to a populated four-migration D1 database.
  parser.exec(readFileSync(new URL('../migrations/0005_hierarchy-schema.sql', import.meta.url), 'utf8'));
  for (const row of parser.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND rowid>? ORDER BY rowid').all(baselineLastRow)) await db.prepare(row.sql).run();
  assert.equal((await workspace.snapshot(owner.token)).organizations[0].parentId, null);
  const invite = await workspace.createInvite(owner.token, organization.id, { email: 'guest@example.org', role: 'admin' });
  await workspace.acceptInvite(guest.token, invite.token);
  const key = await workspace.issueKey(guest.token, { label: 'D1 integration', organizationId: organization.id, permission: 'write', expiresInDays: 1 });
  const guestSnap = await workspace.snapshot(guest.token);
  const child = await workspace.createOrganization(guest.token, { name: 'Independent child', emailId: guestSnap.account.emails[0].id, parentOrganizationId: organization.id });
  assert.equal((await workspace.snapshot(guest.token)).organizations.find(org => org.id === child.id).parentId, organization.id);
  assert.ok((await workspace.snapshot(owner.token)).organizations.every(org => org.id !== child.id));
  const childKey = await workspace.issueKey(guest.token, { label: 'Independent child key', organizationId: child.id, permission: 'write', expiresInDays: 1 });
  const original = new MemoryService(db);
  const historical = await original.create(key.token, organization.spaceId, { body: 'Before release migration' });
  await original.update(key.token, organization.spaceId, historical.id, { body: 'Preserved populated revision', expectedRevision: 1 });
  await applySql(parser, db, readFileSync(new URL('../migrations/0006_release-schema.sql', import.meta.url), 'utf8'));
  await applySql(parser, db, readFileSync(new URL('../migrations/0007_maintenance-schema.sql', import.meta.url), 'utf8'));
  const checkoutPool = 'org:' + organization.id, checkoutAt = Date.now();
  await db.prepare(`INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,created_at,expires_at)
    VALUES('pre-eight-checkout',?,'price_test','pre-eight',?,?)`).bind(checkoutPool, checkoutAt, checkoutAt + 2100000).run();
  const preEightCheckout = await db.prepare("SELECT * FROM release_checkout_requests WHERE id='pre-eight-checkout'").first();
  await applySql(parser, db, readFileSync(new URL('../migrations/0008_checkout-schema.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await db.prepare("SELECT * FROM release_checkout_requests WHERE id='pre-eight-checkout'").first(),
    { ...preEightCheckout, checkout_attempted: 1 });
  await assert.rejects(() => db.prepare("UPDATE release_checkout_requests SET checkout_attempted=0 WHERE id='pre-eight-checkout'").run(), /immutable/);
  await assert.rejects(() => db.prepare("UPDATE release_checkout_requests SET expires_at=expires_at+1 WHERE id='pre-eight-checkout'").run(), /immutable/);
  await db.prepare(`INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,created_at,expires_at,checkout_attempted)
    VALUES('post-eight-checkout',?,'price_test','post-eight',?,?,0)`).bind(checkoutPool, checkoutAt, checkoutAt + 2100000).run();
  assert.equal((await db.prepare("SELECT checkout_attempted FROM release_checkout_requests WHERE id='post-eight-checkout'").first()).checkout_attempted, 0);
  await db.prepare("UPDATE release_checkout_requests SET expires_at=?,checkout_attempted=1 WHERE id='post-eight-checkout' AND checkout_attempted=0").bind(checkoutAt + 2400000).run();
  await assert.rejects(() => db.prepare("UPDATE release_checkout_requests SET expires_at=expires_at+1 WHERE id='post-eight-checkout'").run(), /immutable/);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 8);
  await db.prepare("INSERT INTO release_vector_refs(memory_id,vector_id,revision) VALUES(?,'pre-nine-retained-ref',1)").bind(historical.id).run();
  const preNineJobs = (await db.prepare('SELECT * FROM release_jobs ORDER BY id').all()).results;
  const preNineRefs = (await db.prepare('SELECT * FROM release_vector_refs ORDER BY vector_id').all()).results;
  await applySql(parser, db, readFileSync(new URL('../migrations/0009_job-progress-schema.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await db.prepare('SELECT * FROM release_jobs ORDER BY id').all()).results,
    preNineJobs.map(job => ({ ...job, next_chunk: 0, cleanup_cursor: '' })));
  assert.deepEqual((await db.prepare('SELECT * FROM release_vector_refs ORDER BY vector_id').all()).results, preNineRefs);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 9);
  const preTenCheckout = (await db.prepare('SELECT * FROM release_checkout_requests ORDER BY id').all()).results;
  const preTenMemberships = (await db.prepare('SELECT * FROM memberships ORDER BY id').all()).results;
  await applySql(parser, db, readFileSync(new URL('../migrations/0010_protocol-schema.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await db.prepare('SELECT * FROM release_checkout_requests ORDER BY id').all()).results, preTenCheckout);
  assert.deepEqual((await db.prepare('SELECT * FROM memberships ORDER BY id').all()).results, preTenMemberships);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_checkout_closures').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_scim_deletions').first()).n, 0);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 10);
  const paginationTables = ['memories', 'memory_versions', 'memory_audit_events', 'release_shares'];
  const beforePagination = new Map();
  for (const table of paginationTables)
    beforePagination.set(table, (await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results);
  await applySql(parser, db, readFileSync(new URL('../migrations/0011_pagination-schema.sql', import.meta.url), 'utf8'));
  for (const table of paginationTables)
    assert.deepEqual((await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results, beforePagination.get(table));
  const paginationIndexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('release_audit_export','release_memories_live_created','release_memories_trash_created','release_shares_recipient_page') ORDER BY name").all()).results.map(row => row.name);
  assert.deepEqual(paginationIndexes, ['release_audit_export', 'release_memories_live_created', 'release_memories_trash_created', 'release_shares_recipient_page']);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 11);
  const lookupTables = ['accounts', 'account_emails', 'organizations', 'memberships', 'credentials', 'memories', 'memory_versions', 'memory_audit_events', 'release_jobs'];
  const beforeLookup = new Map();
  for (const table of lookupTables)
    beforeLookup.set(table, (await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results);
  const beforeLookupCredentials = (await db.prepare('SELECT * FROM active_credentials ORDER BY id').all()).results;
  const beforeLookupFts = (await db.prepare('SELECT memory_id,space_id,body FROM release_fts ORDER BY memory_id').all()).results;
  await applySql(parser, db, readFileSync(new URL('../migrations/0012_lookup-schema.sql', import.meta.url), 'utf8'));
  for (const table of lookupTables)
    assert.deepEqual((await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results, beforeLookup.get(table));
  assert.deepEqual((await db.prepare('SELECT * FROM active_credentials ORDER BY id').all()).results, beforeLookupCredentials);
  assert.deepEqual((await db.prepare('SELECT memory_id,space_id,body FROM release_fts ORDER BY memory_id').all()).results, beforeLookupFts);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_fts f JOIN release_fts_rows r ON r.memory_id=f.memory_id WHERE f.rowid<>r.id').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_fts_rows').first()).n, beforeLookup.get('memories').length);
  const historicalFtsId = await db.prepare('SELECT id FROM release_fts_rows WHERE memory_id=?').bind(historical.id).first();
  await assert.rejects(() => db.prepare('UPDATE release_fts_rows SET memory_id=memory_id WHERE id=?').bind(historicalFtsId.id).run(), /immutable/);
  await assert.rejects(() => db.prepare('DELETE FROM release_fts_rows WHERE id=?').bind(historicalFtsId.id).run(), /retained/);
  await assert.rejects(() => db.prepare('INSERT OR REPLACE INTO release_fts_rows(memory_id) VALUES(?)').bind(historical.id).run(), /already exists/);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 12);
  const keyLookupTables = [...lookupTables, 'workspace_key_issuances', 'workspace_key_metadata', 'workspace_audit_events'];
  const beforeKeyLookup = new Map();
  for (const table of keyLookupTables)
    beforeKeyLookup.set(table, (await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results);
  await applySql(parser, db, readFileSync(new URL('../migrations/0013_key-lookup-schema.sql', import.meta.url), 'utf8'));
  for (const table of keyLookupTables)
    assert.deepEqual((await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results, beforeKeyLookup.get(table));
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 13);
  const indexedFoundationKey = await workspace.issueKey(guest.token, { label: 'Native indexed foundation key', organizationId: organization.id, permission: 'write', expiresInDays: 1 });
  const indexedFoundationBinding = await db.prepare(`SELECT c.membership_id,c.email_id,m.id AS expectedMembership,m.email_id AS expectedEmail
    FROM credentials c JOIN active_memberships m ON m.account_id=c.account_id AND m.organization_id=? WHERE c.id=?`).bind(organization.id, indexedFoundationKey.id).first();
  assert.equal(indexedFoundationBinding.membership_id, indexedFoundationBinding.expectedMembership);
  assert.equal(indexedFoundationBinding.email_id, indexedFoundationBinding.expectedEmail);
  assert.equal((await db.prepare('SELECT label FROM workspace_key_metadata WHERE credential_id=?').bind(indexedFoundationKey.id).first()).label, 'Native indexed foundation key');
  assert.equal((await db.prepare("SELECT count(*) AS n FROM workspace_audit_events WHERE action='key_issued' AND credential_id=?").bind(indexedFoundationKey.id).first()).n, 1);
  // The tenant/queue migration changes derived indexes and adds progress facts.
  // Compare all pre-existing columns so a new bookkeeping column cannot hide
  // an accidental change to source, identity, history or existing job state.
  const tenantQueueTables = [...keyLookupTables, 'release_vector_refs', 'release_fts_rows'];
  const beforeTenantQueue = new Map(), tenantQueueColumns = new Map();
  for (const table of tenantQueueTables) {
    const names = (await db.prepare('PRAGMA table_info(' + table + ')').all()).results.map(column => '"' + column.name + '"').join(',');
    tenantQueueColumns.set(table, names);
    beforeTenantQueue.set(table, (await db.prepare('SELECT ' + names + ' FROM ' + table + ' ORDER BY rowid').all()).results);
  }
  const beforeTenantQueueFts = (await db.prepare('SELECT rowid,memory_id,space_id,body FROM release_fts ORDER BY rowid').all()).results;
  await applySql(parser, db, readFileSync(new URL('../migrations/0014_tenant-queue-schema.sql', import.meta.url), 'utf8'));
  for (const table of tenantQueueTables)
    assert.deepEqual((await db.prepare('SELECT ' + tenantQueueColumns.get(table) + ' FROM ' + table + ' ORDER BY rowid').all()).results, beforeTenantQueue.get(table));
  assert.deepEqual((await db.prepare('SELECT rowid,memory_id,space_id,body FROM release_fts ORDER BY rowid').all()).results, beforeTenantQueueFts);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 14);
  const beforeWorkspaceLookup = new Map();
  for (const table of tenantQueueTables)
    beforeWorkspaceLookup.set(table, (await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results);
  const vectorSweepBeforeLookup = await db.prepare("SELECT * FROM release_maintenance_progress WHERE name='vector_resweep'").first();
  await applySql(parser, db, readFileSync(new URL('../migrations/0015_workspace-lookup-schema.sql', import.meta.url), 'utf8'));
  for (const table of tenantQueueTables)
    assert.deepEqual((await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results, beforeWorkspaceLookup.get(table));
  assert.deepEqual(await db.prepare("SELECT * FROM release_maintenance_progress WHERE name='vector_resweep'").first(), vectorSweepBeforeLookup);
  assert.equal((await db.prepare("SELECT cursor FROM release_maintenance_progress WHERE name='source_erasure'").first()).cursor, '');
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 15);
  const retrievalTables = [...tenantQueueTables, 'release_ingests', 'release_maintenance_progress'];
  const beforeRetrieval = new Map(), retrievalColumns = new Map();
  for (const table of retrievalTables) {
    const names = (await db.prepare('PRAGMA table_info(' + table + ')').all()).results.map(column => '"' + column.name + '"').join(',');
    retrievalColumns.set(table, names);
    beforeRetrieval.set(table, (await db.prepare('SELECT ' + names + ' FROM ' + table + ' ORDER BY rowid').all()).results);
  }
  await applySql(parser, db, readFileSync(new URL('../migrations/0016_retrieval-progress-schema.sql', import.meta.url), 'utf8'));
  for (const table of retrievalTables)
    assert.deepEqual((await db.prepare('SELECT ' + retrievalColumns.get(table) + ' FROM ' + table + ' ORDER BY rowid').all()).results, beforeRetrieval.get(table));
  assert.equal((await db.prepare("SELECT count(*) AS n FROM release_jobs WHERE cleanup_pending<>'[]'").first()).n, 0);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 16);
  const beforeReconciliation = new Map(), reconciliationColumns = new Map();
  for (const table of retrievalTables) {
    const names = (await db.prepare('PRAGMA table_info(' + table + ')').all()).results.map(column => '"' + column.name + '"').join(',');
    reconciliationColumns.set(table, names);
    beforeReconciliation.set(table, (await db.prepare('SELECT ' + names + ' FROM ' + table + ' ORDER BY rowid').all()).results);
  }
  await applySql(parser, db, readFileSync(new URL('../migrations/0017_vector-reconciliation-schema.sql', import.meta.url), 'utf8'));
  for (const table of retrievalTables)
    assert.deepEqual((await db.prepare('SELECT ' + reconciliationColumns.get(table) + ' FROM ' + table + ' ORDER BY rowid').all()).results, beforeReconciliation.get(table));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_jobs WHERE cleanup_retry_at<>0 OR cleanup_retry_delay<>60000').first()).n, 0);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 17);
  const outboundTables = [...retrievalTables, 'release_shares'], beforeOutbound = new Map();
  for (const table of outboundTables)
    beforeOutbound.set(table, (await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results);
  await applySql(parser, db, readFileSync(new URL('../migrations/0018_outbound-share-schema.sql', import.meta.url), 'utf8'));
  for (const table of outboundTables)
    assert.deepEqual((await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results, beforeOutbound.get(table));
  assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='release_shares_space_created'").first()).n, 1);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 18);
  const executionTables = [...new Set([...outboundTables, 'accounts', 'account_emails', 'memberships', 'credentials',
    'domains', 'domain_managers', 'release_reauth_challenges', 'release_checkout_requests'])];
  const beforeExecution = new Map();
  for (const table of executionTables)
    beforeExecution.set(table, (await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results);
  await applySql(parser, db, readFileSync(new URL('../migrations/0019_execution-time-schema.sql', import.meta.url), 'utf8'));
  for (const table of executionTables)
    assert.deepEqual((await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results, beforeExecution.get(table));
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 19);
  // Upgrade existing pending proofs as well as retained identity/source rows.
  // Only the exact account/address proof already covered by a permanent provider
  // block is invalidated; an unrelated account and address remain untouched.
  const blockedUpgradeAddress = 'revoked-upgrade@example.org';
  for (const [challengeId, accountId, address] of [
    ['upgrade-blocked-proof', owner.accountId, blockedUpgradeAddress],
    ['upgrade-other-account-proof', guest.accountId, blockedUpgradeAddress],
    ['upgrade-unblocked-proof', owner.accountId, 'unblocked-upgrade@example.org'],
  ]) await db.prepare('INSERT INTO email_challenges(id,account_id,address,domain,token_digest,expires_at) VALUES(?,?,?,?,?,?)')
    .bind(challengeId, accountId, address, 'example.org', await digest(challengeId), Date.now() + 600000).run();
  await db.prepare('INSERT INTO release_external_email_blocks(account_id,address,created_at) VALUES(?,?,?)')
    .bind(owner.accountId, blockedUpgradeAddress, Date.now()).run();
  const domainUpgradeTables = [...new Set([...executionTables, 'email_challenges', 'release_domain_challenges',
    'release_external_email_blocks', 'release_provider_revocations'])];
  const beforeDomainUpgrade = new Map();
  for (const table of domainUpgradeTables)
    beforeDomainUpgrade.set(table, (await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results);
  const beforeDomainUpgradeAt = Date.now();
  await applySql(parser, db, readFileSync(new URL('../migrations/0020_domain-verification-schema.sql', import.meta.url), 'utf8'));
  const afterDomainUpgradeAt = Date.now();
  for (const table of domainUpgradeTables) {
    const actual = (await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results;
    if (table === 'email_challenges') {
      const changed = actual.find(row => row.id === 'upgrade-blocked-proof');
      assert.ok(changed.invalidated_at >= beforeDomainUpgradeAt && changed.invalidated_at <= afterDomainUpgradeAt);
      assert.deepEqual(actual.map(row => row.id === changed.id ? { ...row, invalidated_at: null } : row), beforeDomainUpgrade.get(table));
    } else assert.deepEqual(actual, beforeDomainUpgrade.get(table));
  }
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 20);
  const beforeDomainRetention = new Map();
  for (const table of [...domainUpgradeTables, 'release_domain_verifications'])
    beforeDomainRetention.set(table, (await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results);
  await applySql(parser, db, readFileSync(new URL('../migrations/0021_domain-retention-schema.sql', import.meta.url), 'utf8'));
  for (const [table, previous] of beforeDomainRetention)
    assert.deepEqual((await db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()).results, previous);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='release_domains_pending_expiry'").first()).n, 1);
  assert.equal((await db.prepare('SELECT version FROM release_meta').first()).version, 21);
  // Exercise recovery through the actual Billing service and native D1, with
  // synthetic provider responses and an injected clock (no external requests).
  let billingAt = checkoutAt, customerCalls = 0, checkoutCalls = 0;
  await db.prepare('UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind=\'session\'').bind(billingAt, owner.accountId).run();
  const billingSpaceId = (await workspace.snapshot(owner.token)).spaces.find(space => space.organizationId === null).id;
  const nativeBilling = new Billing({ DB: db, BACKGROUND_JOBS_ENABLED: 'true', STRIPE_SECRET_KEY: 'synthetic',
    STRIPE_WEBHOOK_SECRET: 'w'.repeat(64), STRIPE_API_VERSION: 'synthetic',
    BILLING_PRICES_JSON: JSON.stringify({ price_test: { plan: 'team', monthlyUnits: 10000, storageBytes: 1048576000 } }),
    fetch: async (url, init) => {
      if (String(url).endsWith('/customers')) {
        if (++customerCalls === 1) return Response.json({ error: 'temporary_failure' }, { status: 503 });
        return Response.json({ id: 'cus_native' });
      }
      checkoutCalls++;
      assert.equal(Number(new URLSearchParams(init.body).get('expires_at')), Math.floor((billingAt + 2100000) / 1000));
      return Response.json({ id: 'cs_native', url: 'https://checkout.stripe.com/c/pay/native' });
    } }, () => billingAt);
  await assert.rejects(() => nativeBilling.checkout(owner.token, billingSpaceId, 'price_test', 'native-recovery'), error => error.status === 502);
  assert.equal((await db.prepare("SELECT checkout_attempted FROM release_checkout_requests WHERE operation_key='native-recovery'").first()).checkout_attempted, 0);
  billingAt += 360000;
  await db.prepare('UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind=\'session\'').bind(billingAt, owner.accountId).run();
  assert.equal((await nativeBilling.checkout(owner.token, billingSpaceId, 'price_test', 'native-recovery')).url, 'https://checkout.stripe.com/c/pay/native');
  assert.equal(checkoutCalls, 1);
  await db.prepare('UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind=\'session\'').bind(Date.now(), owner.accountId).run();
  for (const name of ['release_ingests_expiry', 'release_exports_expiry', 'release_domains_expiry', 'release_reauth_expiry', 'release_mail_budget_day'])
    assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name=?").bind(name).first()).n, 1);
  assert.equal((await db.prepare('SELECT body FROM memories WHERE id=?').bind(historical.id).first()).body, 'Preserved populated revision');
  assert.equal((await db.prepare('SELECT body FROM memory_versions WHERE memory_id=? AND revision=1').bind(historical.id).first()).body, 'Before release migration');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_fts WHERE memory_id=?').bind(historical.id).first()).n, 1);
  const origin = config.vars.PUBLIC_ORIGIN;
  async function request(path, { method = 'GET', data, token = key.token, headers = {} } = {}) {
    return mf.dispatchFetch(origin + path, { method, redirect: 'manual', headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  }
  assert.equal((await request('/')).status, 200);
  const health = await (await request('/health')).json(); assert.equal(health.status, 'ok');
  const base = `/v1/spaces/${organization.spaceId}/memories`;
  const childBase = `/v1/spaces/${child.spaceId}/memories`;
  assert.equal((await request(childBase, { token: owner.token })).status, 403);
  assert.equal((await request(childBase)).status, 403);
  assert.equal((await request(childBase, { method: 'POST', token: childKey.token, data: { body: 'Child-only memory' } })).status, 201);
  const created = await request(base, { method: 'POST', data: { body: '실제 workerd + D1 검증' } });
  assert.equal(created.status, 201); const memory = await created.json();
  const updated = await request(`${base}/${memory.id}`, { method: 'PATCH', data: { body: 'D1 updated', expectedRevision: 1 } });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).revision, 2);
  assert.equal((await request(`${base}/${memory.id}`, { method: 'PATCH', data: { body: 'stale', expectedRevision: 1 } })).status, 409);
  const retryData = { body: 'Idempotent native D1', operationId: 'native-create-1' };
  const first = await (await request(base, { method: 'POST', data: retryData })).json();
  const replay = await (await request(base, { method: 'POST', data: retryData })).json();
  assert.equal(first.id, replay.id); assert.equal(replay.replayed, true);
  assert.equal((await request(base, { method: 'POST', data: { ...retryData, body: 'Changed retry' } })).status, 409);
  const search = await request(`${base}?query=Idempotent`);
  assert.equal(search.status, 200); assert.match(await search.text(), /Idempotent native D1/);
  const removed = await request(`${base}/${first.id}`, { method: 'DELETE', data: { expectedRevision: 1, operationId: 'native-delete-1' } });
  assert.equal(removed.status, 204);
  const restored = await request(`${base}/${first.id}/restore`, { method: 'POST', data: { expectedRevision: 2, operationId: 'native-restore-1' } });
  assert.equal(restored.status, 200); assert.equal((await restored.json()).revision, 3);
  assert.equal((await request('/manage')).status, 200);
  const readiness = await request('/ready'); assert.equal(readiness.status, 503); assert.equal((await readiness.json()).checks.schema, true);
  const mcp = await request('/mcp', { method: 'POST', data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' } });
  assert.equal(mcp.status, 200); assert.match(await mcp.text(), /memory_search/);
  const members = await workspace.listMembers(owner.token, organization.id);
  await workspace.revokeMembership(owner.token, organization.id, members.find(m => m.accountId === guest.accountId).id);
  assert.equal((await request(base)).status, 401);
  assert.equal((await request(childBase, { token: childKey.token })).status, 200);
  assert.equal((await workspace.snapshot(guest.token)).organizations.find(org => org.id === child.id).parentId, null);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM memory_versions').first()).n, 4);
  // A byte limit alone cannot bound an authenticated request whose JSON never
  // finishes. Exercise both bundled readers with real workerd timers: cancelling
  // a native request can reject the pending read instead of resolving as done.
  const spacesBeforeStall = (await db.prepare('SELECT count(*) AS n FROM spaces').first()).n;
  const memoriesBeforeStall = (await db.prepare('SELECT count(*) AS n FROM memories').first()).n;
  await Promise.all(['/v1/spaces', base].map(async path => {
    const stalledRequestAbort = new AbortController();
    let stalledRequestController;
    let stalledRequestWatchdog;
    try {
      const stalledRequest = mf.dispatchFetch(origin + path, {
        method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: new ReadableStream({ start(controller) {
          stalledRequestController = controller;
          controller.enqueue(new TextEncoder().encode('{"name":"never finished'));
        } }), duplex: 'half', signal: stalledRequestAbort.signal,
      });
      const response = await Promise.race([stalledRequest, new Promise((_, reject) => {
        stalledRequestWatchdog = setTimeout(() => {
          stalledRequestAbort.abort(); reject(new Error('Bundled body-reader deadline did not respond: ' + path));
        }, 25000);
      })]);
      assert.equal(response.status, 408, path);
      assert.deepEqual(await response.json(), { error: 'read_timeout' });
    } finally {
      clearTimeout(stalledRequestWatchdog);
      stalledRequestAbort.abort();
      try { stalledRequestController?.close(); } catch { /* The Worker may already have cancelled the stream. */ }
    }
  }));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM spaces').first()).n, spacesBeforeStall);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM memories').first()).n, memoriesBeforeStall);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  const nativePrefix = '가'.repeat(31);
  const nativePrefixMemory = await original.create(childKey.token, child.spaceId, { body: nativePrefix + '나 native prefix boundary' });
  const prefixPersonalSpace = (await workspace.snapshot(owner.token)).spaces.find(space => space.organizationId === null);
  const foreignPrefixMemory = await original.create(owner.token, prefixPersonalSpace.id, { body: (nativePrefix + '나 ').repeat(3) + 'foreign higher density' });
  const nativePrefixSearch = await request(childBase + '?query=' + encodeURIComponent(nativePrefix), { token: childKey.token });
  assert.equal(nativePrefixSearch.status, 200);
  const nativePrefixResults = (await nativePrefixSearch.json()).results;
  assert.deepEqual(nativePrefixResults.map(row => row.id), [nativePrefixMemory.id]);
  assert.ok(nativePrefixResults.every(row => row.id !== foreignPrefixMemory.id));
  const operationsBeforeLongSearch = (await db.prepare('SELECT count(*) AS n FROM release_operations').first()).n;
  const tooLongSearch = await request(childBase + '?query=' + encodeURIComponent(nativePrefix + '가'), { token: childKey.token });
  assert.equal(tooLongSearch.status, 400);
  assert.equal((await tooLongSearch.json()).error, 'search_token_too_long');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_operations').first()).n, operationsBeforeLongSearch);
  const unicodeMemories = [];
  for (const body of ['ＡＢＣ', 'ABC', 'ﬃ', 'ffi', 'cafe\u0301ine', 'cafeteria', 'x\uE000y', 'xylophone', '\uE000project', 'project', 'किताब', 'שָׁלוֹם', 'عَرَبِيّ', 'foo_bar', '₿budget', 'budget', '🫠alpha', 'alpha', 'x🫠y', 'yellow'])
    unicodeMemories.push(await original.create(childKey.token, child.spaceId, { body }));
  for (const memory of unicodeMemories) {
    const response = await request(childBase + '?query=' + encodeURIComponent(memory.body), { token: childKey.token });
    assert.equal(response.status, 200);
    const found = (await response.json()).results;
    assert.ok(found.some(row => row.id === memory.id), 'Identical stored Unicode text must match: ' + JSON.stringify(memory.body));
    assert.ok(found.every(row => !unicodeMemories.some(other => other.id === row.id && other.id !== memory.id)), 'Unicode61 compatibility-distinct words must remain distinct: ' + JSON.stringify(memory.body));
  }
  // Known Unicode punctuation must continue separating OR groups. Keeping all
  // non-ASCII characters in one quoted phrase would silently change this query
  // and would reject valid short groups when their combined length exceeds31.
  const punctuationTargets = unicodeMemories.filter(memory => ['alpha', 'budget'].includes(memory.body));
  for (const query of ['alpha、budget', 'alpha、'.repeat(8) + 'budget']) {
    const response = await request(childBase + '?query=' + encodeURIComponent(query), { token: childKey.token });
    assert.equal(response.status, 200);
    const found = (await response.json()).results;
    assert.ok(punctuationTargets.every(memory => found.some(row => row.id === memory.id)));
    assert.ok(found.every(row => !unicodeMemories.some(memory => memory.id === row.id && !punctuationTargets.includes(memory))));
  }
  const authStart = await request('/auth/login'); assert.equal(authStart.status, 302);
  assert.equal(new URL(authStart.headers.get('location')).origin, 'https://auth-api.allen.company');

  // Exercise the deployed scheduled handler, including native D1 tuple cleanup
  // and the forward indexes. This database and every identity below are synthetic.
  assert.equal(config.vars.BACKGROUND_JOBS_ENABLED, 'false');
  assert.equal(config.vars.AUTO_ERASURE_ENABLED, 'false');
  const maintenanceAt = Date.now(), expiredAt = maintenanceAt - 60000, liveUntil = maintenanceAt + 600000;
  const personalSpace = (await workspace.snapshot(owner.token)).spaces.find(space => space.organizationId === null);
  assert.ok(personalSpace);
  const ownerCredential = await db.prepare("SELECT id FROM credentials WHERE account_id=? AND kind='session' LIMIT 1").bind(owner.accountId).first();
  const retained = await historicalTombstone(personalSpace.id, ownerCredential.id, 'Personal content beyond the restore window', maintenanceAt - 31 * 86400000);
  for (let n = 0; n < 105; n++)
    await db.prepare('INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES(?,?,?,?,?)')
      .bind(`scheduled-expired-${n}`, ownerCredential.id, ownerEmail.id, 'synthetic-proof-digest', expiredAt).run();
  await db.prepare('INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES(?,?,?,?,?)')
    .bind('scheduled-live-proof', ownerCredential.id, ownerEmail.id, 'synthetic-live-digest', liveUntil).run();
  for (const [id, expiry] of [['scheduled-expired-export', expiredAt], ['scheduled-live-export', liveUntil]])
    await db.prepare('INSERT INTO release_export_sessions(id,account_id,space_id,watermark,expires_at,created_at) VALUES(?,?,?,0,?,?)')
      .bind(id, owner.accountId, personalSpace.id, expiry, maintenanceAt - 120000).run();
  await db.prepare('INSERT INTO email_challenges(id,account_id,address,domain,token_digest,expires_at) VALUES(?,?,?,?,?,?)')
    .bind('scheduled-identity-audit', owner.accountId, 'scheduled-audit@example.org', 'example.org', 'd'.repeat(64), expiredAt).run();
  await db.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,available_at,created_at) VALUES('scheduled-source',?,0,'ingest',?,?)")
    .bind(personalSpace.id, expiredAt, expiredAt).run();
  await db.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,ciphertext,proposals,expires_at,created_at) VALUES('scheduled-source',?,?,?,'synthetic-expired-ciphertext','[]',?,?)")
    .bind(owner.accountId, personalSpace.id, ownerCredential.id, expiredAt, expiredAt).run();
  const oldBudgetDay = new Date(maintenanceAt - 2 * 86400000).toISOString().slice(0, 10);
  const futureBudgetDay = new Date(maintenanceAt + 2 * 86400000).toISOString().slice(0, 10);
  for (const day of [oldBudgetDay, futureBudgetDay])
    await db.prepare('INSERT INTO release_mail_budget(account_id,day,quantity) VALUES(?,?,20)').bind(owner.accountId, day).run();
  const preservedTables = ['memories', 'memory_versions', 'memory_audit_events', 'email_challenges', 'email_consumptions', 'release_events', 'release_jobs'];
  const beforeCleanup = new Map();
  for (const table of preservedTables)
    beforeCleanup.set(table, (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results);
  const worker = await mf.getWorker();
  const firstSweep = await worker.scheduled({ cron: config.triggers.crons[0] });
  assert.equal(firstSweep.outcome, 'ok');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_reauth_challenges WHERE expires_at<=?').bind(maintenanceAt).first()).n, 5);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM release_reauth_challenges WHERE id='scheduled-live-proof'").first()).n, 1);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM release_export_sessions WHERE id='scheduled-expired-export'").first()).n, 0);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM release_export_sessions WHERE id='scheduled-live-export'").first()).n, 1);
  assert.deepEqual(await db.prepare("SELECT ciphertext,proposals,state FROM release_ingests WHERE id='scheduled-source'").first(),
    { ciphertext: null, proposals: null, state: 'expired' });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_mail_budget WHERE account_id=? AND day=?').bind(owner.accountId, oldBudgetDay).first()).n, 0);
  assert.equal((await db.prepare('SELECT quantity FROM release_mail_budget WHERE account_id=? AND day=?').bind(owner.accountId, futureBudgetDay).first()).quantity, 20);
  const secondSweep = await worker.scheduled({ cron: config.triggers.crons[0] });
  assert.equal(secondSweep.outcome, 'ok');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_reauth_challenges WHERE expires_at<=?').bind(maintenanceAt).first()).n, 0);
  for (const table of preservedTables)
    assert.deepEqual((await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results, beforeCleanup.get(table), `${table} must survive cleanup unchanged`);
  const heartbeat = await db.prepare("SELECT last_success_at FROM release_heartbeats WHERE name='maintenance'").first();
  assert.ok(heartbeat.last_success_at >= maintenanceAt && heartbeat.last_success_at <= Date.now());
  const afterCleanupReady = await (await request('/ready')).json();
  assert.equal(afterCleanupReady.checks.maintenance, true);
  assert.equal(afterCleanupReady.checks.backgroundJobs, false);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);

  // Management requests use synthetic recently verified sessions. Confirm native
  // D1 counts an idempotent acceptance update and never changes its consent time.
  await db.prepare('UPDATE credentials SET reauthenticated_at=? WHERE id=?').bind(Date.now(), ownerCredential.id).run();
  const shareResponse = await request(`/v1/spaces/${personalSpace.id}/shares`, {
    method: 'POST', token: owner.token, data: { email: 'guest@example.org', days: 7 },
  });
  assert.equal(shareResponse.status, 201); const shared = await shareResponse.json();
  const extraShares = [];
  for (let index = 0; index < 2; index++) {
    const response = await request(`/v1/spaces/${personalSpace.id}/shares`, {
      method: 'POST', token: owner.token, data: { email: 'guest@example.org', days: 7 },
    });
    assert.equal(response.status, 201); extraShares.push(await response.json());
  }
  const invitationIds = [], invitationCursors = new Set();
  let invitationCursor = null;
  do {
    const response = await request('/v1/shares?limit=1' + (invitationCursor ? '&cursor=' + encodeURIComponent(invitationCursor) : ''), { token: guest.token });
    assert.equal(response.status, 200); const page = await response.json();
    assert.equal(page.results.length, 1); invitationIds.push(page.results[0].id);
    invitationCursor = page.nextCursor;
    if (invitationCursor) {
      assert.ok(!invitationCursors.has(invitationCursor)); invitationCursors.add(invitationCursor);
      assert.equal((await request('/v1/shares?cursor=' + encodeURIComponent(invitationCursor), { token: owner.token })).status, 400);
    }
  } while (invitationCursor);
  assert.deepEqual(invitationIds.slice().sort(), [shared.id, ...extraShares.map(row => row.id)].sort());
  const acceptPath = `/v1/shares/${shared.id}/accept`;
  assert.equal((await request(acceptPath, { method: 'POST', token: guest.token, data: {} })).status, 200);
  const consent = await db.prepare('SELECT accepted_at FROM release_shares WHERE id=?').bind(shared.id).first();
  assert.equal((await request(acceptPath, { method: 'POST', token: guest.token, data: {} })).status, 200);
  assert.equal((await db.prepare('SELECT accepted_at FROM release_shares WHERE id=?').bind(shared.id).first()).accepted_at, consent.accepted_at);
  assert.equal((await request(acceptPath, { method: 'POST', token: owner.token, data: {} })).status, 403);
  assert.equal((await request(`/v1/spaces/${personalSpace.id}/shares/${shared.id}`, { method: 'DELETE', token: owner.token })).status, 204);
  assert.equal((await request(acceptPath, { method: 'POST', token: guest.token, data: {} })).status, 403);
  for (const row of extraShares)
    assert.equal((await request(`/v1/spaces/${personalSpace.id}/shares/${row.id}`, { method: 'DELETE', token: owner.token })).status, 204);

  // Discard a successful issuance response, then prove that revoking only a
  // retry does not revoke the original. A later browser session must discover
  // both retained grants and recover the original ID without database access.
  const outboundPath = `/v1/spaces/${personalSpace.id}/shares`;
  const lostShareResponse = await request(outboundPath, { method: 'POST', token: owner.token, data: { email: 'guest@example.org', days: 7 } });
  assert.equal(lostShareResponse.status, 201); await lostShareResponse.body.cancel();
  const retryShareResponse = await request(outboundPath, { method: 'POST', token: owner.token, data: { email: 'guest@example.org', days: 7 } });
  assert.equal(retryShareResponse.status, 201); const retriedShare = await retryShareResponse.json();
  assert.equal((await request(`${outboundPath}/${retriedShare.id}`, { method: 'DELETE', token: owner.token })).status, 204);
  const recipientInvitations = await (await request('/v1/shares', { token: guest.token })).json();
  assert.equal(recipientInvitations.results.length, 1);
  assert.equal((await request(`/v1/shares/${recipientInvitations.results[0].id}/accept`, { method: 'POST', token: guest.token, data: {} })).status, 200);
  const sharedMemoryPath = `/v1/spaces/${personalSpace.id}/memories/${foreignPrefixMemory.id}`;
  assert.equal((await request(sharedMemoryPath, { token: guest.token })).status, 200);
  const laterOwner = await workspace.signIn(principal('owner'));
  assert.equal(laterOwner.accountId, owner.accountId);
  const outboundIds = [], outboundRows = [];
  let outboundCursor = null;
  do {
    const response = await request(outboundPath + '?limit=1' + (outboundCursor ? '&cursor=' + encodeURIComponent(outboundCursor) : ''), { token: laterOwner.token });
    assert.equal(response.status, 200); const page = await response.json();
    assert.equal(page.results.length, 1); outboundRows.push(...page.results); outboundIds.push(page.results[0].id);
    outboundCursor = page.nextCursor;
    if (outboundCursor)
      assert.equal((await request(`/v1/spaces/${organization.spaceId}/shares?cursor=` + encodeURIComponent(outboundCursor), { token: laterOwner.token })).status, 400);
  } while (outboundCursor);
  assert.equal(outboundRows.length, 5); assert.equal(new Set(outboundIds).size, 5);
  assert.deepEqual(outboundRows, outboundRows.slice().sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)));
  const originalShare = outboundRows.find(row => row.revokedAt === null);
  assert.ok(originalShare); assert.equal(originalShare.id, recipientInvitations.results[0].id);
  assert.equal(originalShare.recipientEmail, 'guest@example.org'); assert.ok(originalShare.acceptedAt);
  assert.ok(outboundRows.find(row => row.id === retriedShare.id).revokedAt);
  await db.prepare("UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind='session'").bind(Date.now(), laterOwner.accountId).run();
  assert.equal((await request(`${outboundPath}/${originalShare.id}`, { method: 'DELETE', token: laterOwner.token })).status, 204);
  assert.ok((await (await request(outboundPath, { token: laterOwner.token })).json()).results.every(row => row.revokedAt !== null));
  assert.equal((await request(sharedMemoryPath, { token: guest.token })).status, 403);

  const scimKeyResponse = await request(`/v1/organizations/${organization.id}/scim-keys`, { method: 'POST', token: owner.token, data: {} });
  assert.equal(scimKeyResponse.status, 201); const scimKey = await scimKeyResponse.json();
  const scimPath = `/scim/v2/${organization.id}/Users`;
  const scimCountResponse = await request(scimPath + '?count=0', { token: scimKey.token });
  assert.equal(scimCountResponse.status, 200); assert.match(scimCountResponse.headers.get('content-type'), /^application\/scim\+json/);
  const scimCount = await scimCountResponse.json();
  assert.equal(scimCount.totalResults, 2); assert.equal(scimCount.itemsPerPage, 0); assert.deepEqual(scimCount.Resources, []);
  const ownerMember = members.find(member => member.accountId === owner.accountId);
  const scimDenied = await request(scimPath + '/' + ownerMember.id, {
    method: 'PATCH', token: scimKey.token, headers: { 'content-type': 'application/scim+json; charset=utf-8' },
    data: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] },
  });
  assert.equal(scimDenied.status, 403); assert.match(scimDenied.headers.get('content-type'), /^application\/scim\+json/);
  const scimError = await scimDenied.json();
  assert.equal(scimError.status, '403'); assert.deepEqual(scimError.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
  assert.equal((await db.prepare('SELECT revoked_at FROM memberships WHERE id=?').bind(ownerMember.id).first()).revoked_at, null);
  const scimProjected = await (await request(scimPath + '?attributes=id&startIndex=0&count=500', { token: scimKey.token })).json();
  assert.equal(scimProjected.startIndex, 1); assert.equal(scimProjected.totalResults, 2);
  for (const resource of scimProjected.Resources) assert.deepEqual(Object.keys(resource).sort(), ['id', 'schemas']);
  const scimNegativeCount = await (await request(scimPath + '?count=-1', { token: scimKey.token })).json();
  assert.equal(scimNegativeCount.itemsPerPage, 0); assert.deepEqual(scimNegativeCount.Resources, []);
  const removedScimMember = members.find(member => member.accountId === guest.accountId);
  const qualifiedPatch = await request(scimPath + '/' + removedScimMember.id + '?attributes=id,active', {
    method: 'PATCH', token: scimKey.token, headers: { 'content-type': 'application/scim+json' },
    data: { ScHeMaS: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      oPeRaTiOnS: [{ Op: 'replace', Path: 'urn:ietf:params:scim:schemas:core:2.0:User:active', Value: false }] },
  });
  assert.equal(qualifiedPatch.status, 200);
  assert.deepEqual(await qualifiedPatch.json(), { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: removedScimMember.id, active: false });
  assert.equal((await request(scimPath + '/' + removedScimMember.id, { method: 'DELETE', token: scimKey.token })).status, 204);
  assert.equal((await request(scimPath + '/' + removedScimMember.id, { token: scimKey.token })).status, 404);
  assert.equal((await (await request(scimPath, { token: scimKey.token })).json()).totalResults, 1);
  assert.ok(await db.prepare('SELECT id FROM memberships WHERE id=?').bind(removedScimMember.id).first());
  await assert.rejects(() => db.prepare('DELETE FROM release_scim_deletions WHERE membership_id=?').bind(removedScimMember.id).run(), /immutable/);

  // The production cron keeps provider jobs disabled. Exercise lease SQL against
  // this native D1 database directly, with no provider or outbound API calls.
  await db.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,available_at,created_at) VALUES('native-lease-fixture',?,1,'upsert',0,0)").bind(personalSpace.id).run();
  let leaseAt = Date.now();
  // Enable every candidate kind to cover workerd's compound-SELECT limit.
  const leaseJobs = new Jobs({ DB: db, AI: {}, MEMORY_INDEX: {}, PAYLOAD_KEY: 'A'.repeat(43) }, () => leaseAt);
  leaseJobs.ingest = async () => { throw new Error('Claim must not invoke a provider'); };
  const lease = await leaseJobs.claim(); assert.equal(lease.id, 'native-lease-fixture');
  await leaseJobs.renew(lease); // Same timestamp/value still reports one matched D1 row.
  leaseAt += 30000; await leaseJobs.renew(lease);
  const leaseRow = await db.prepare('SELECT lease_until,lease_token FROM release_jobs WHERE id=?').bind(lease.id).first();
  assert.equal(leaseRow.lease_until, leaseAt + 120000); assert.equal(leaseRow.lease_token, lease.leaseToken);
  await db.prepare("UPDATE release_jobs SET lease_token='replacement-worker' WHERE id=?").bind(lease.id).run();
  await assert.rejects(() => leaseJobs.renew(lease), error => error.message === 'lease_lost');
  assert.equal((await db.prepare('SELECT lease_token FROM release_jobs WHERE id=?').bind(lease.id).first()).lease_token, 'replacement-worker');
  leaseAt = leaseRow.lease_until + 1;
  await assert.rejects(() => leaseJobs.renew({ ...lease, leaseToken: 'replacement-worker' }), error => error.message === 'lease_lost');

  // Confirm the real D1 error envelope maps a competing successor to a conflict,
  // while the winning operation remains replayable without another revision.
  const personalBase = `/v1/spaces/${personalSpace.id}/memories`;
  const predecessor = await (await request(personalBase, { method: 'POST', token: owner.token,
    data: { body: 'Original native fact', operationId: 'native-predecessor' } })).json();
  const successorInput = { body: 'Replacement native fact', supersedesMemoryId: predecessor.id, operationId: 'native-successor' };
  const successorResponse = await request(personalBase, { method: 'POST', token: owner.token, data: successorInput });
  assert.equal(successorResponse.status, 201); const successor = await successorResponse.json();
  const competing = await request(personalBase, { method: 'POST', token: owner.token,
    data: { ...successorInput, body: 'Competing replacement', operationId: 'native-competing-successor' } });
  assert.equal(competing.status, 409); assert.equal((await competing.json()).error, 'revision_conflict');
  const successorReplay = await (await request(personalBase, { method: 'POST', token: owner.token, data: successorInput })).json();
  assert.equal(successorReplay.id, successor.id); assert.equal(successorReplay.replayed, true);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM memories WHERE supersedes_id=?').bind(predecessor.id).first()).n, 1);

  // Organization members can independently issue least-privilege read PATs.
  const reader = await workspace.signIn(principal('reader'));
  const readerInvite = await workspace.createInvite(owner.token, organization.id, { email: 'reader@example.org', role: 'member' });
  await workspace.acceptInvite(reader.token, readerInvite.token);
  await db.prepare("UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind='session'").bind(Date.now(), reader.accountId).run();
  const readerKeyResponse = await request('/v1/keys', { method: 'POST', token: reader.token,
    data: { label: 'Native team reader', organizationId: organization.id, capabilities: ['read'], spaceIds: [organization.spaceId], expiresInDays: 1 } });
  assert.equal(readerKeyResponse.status, 201); const readerKey = await readerKeyResponse.json();
  assert.equal((await request(base, { token: readerKey.token })).status, 200);
  assert.equal((await request(base, { method: 'POST', token: readerKey.token, data: { body: 'Denied native member write' } })).status, 403);
  assert.equal((await request(childBase, { token: readerKey.token })).status, 403);
  assert.equal((await request('/v1/keys/' + encodeURIComponent(readerKey.id), { method: 'DELETE', token: reader.token })).status, 204);
  assert.equal((await request(base, { token: readerKey.token })).status, 401);
  const accountMismatch = await request(personalBase, { method: 'POST', token: owner.token,
    headers: { 'x-memory-account-id': reader.accountId }, data: { body: 'Stale native account draft', operationId: 'native-account-mismatch' } });
  assert.equal(accountMismatch.status, 409); assert.equal((await accountMismatch.json()).error, 'account_mismatch');
  assert.equal((await db.prepare("SELECT count(*) AS n FROM memories WHERE body='Stale native account draft'").first()).n, 0);
  await db.prepare("UPDATE release_jobs SET state='dead' WHERE id='scheduled-source'").run();
  const expiredRetry = await request(`/v1/spaces/${personalSpace.id}/jobs/scheduled-source/retry`, { method: 'POST', token: owner.token });
  assert.equal(expiredRetry.status, 409); assert.equal((await expiredRetry.json()).error, 'job_not_retryable');
  assert.equal((await db.prepare("SELECT state FROM release_jobs WHERE id='scheduled-source'").first()).state, 'dead');
  // Large retained vector histories progress in bounded, lease-fenced slices.
  // Provider calls are synthetic; native D1 executes every cursor/lease update.
  const pageMemoryResponse = await request(personalBase, { method: 'POST', token: owner.token,
    data: { body: 'Native paged vector erasure', operationId: 'native-paged-create' } });
  assert.equal(pageMemoryResponse.status, 201); const pageMemory = await pageMemoryResponse.json();
  assert.equal((await request(`${personalBase}/${pageMemory.id}`, { method: 'DELETE', token: owner.token,
    data: { expectedRevision: 1, operationId: 'native-paged-delete' } })).status, 204);
  assert.equal((await request(`${personalBase}/${pageMemory.id}/erase`, { method: 'POST', token: owner.token,
    data: { expectedRevision: 2, confirmation: pageMemory.id, operationId: 'native-paged-erase' } })).status, 200);
  await db.prepare(`WITH RECURSIVE refs(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM refs WHERE n<1000)
    INSERT INTO release_vector_refs(memory_id,vector_id,revision) SELECT ?,printf('native-ref:%04d',n),1 FROM refs`).bind(pageMemory.id).run();
  const pageJobId = pageMemory.id + ':3';
  let pageAt = Date.now(), pageCalls = 0;
  await db.prepare("UPDATE release_jobs SET available_at=? WHERE state='pending' AND id<>?").bind(pageAt + 86400000, pageJobId).run();
  const pageJobs = new Jobs({ DB: db, MEMORY_INDEX: {
    deleteByIds: async ids => { pageCalls++; assert.ok(ids.length <= 100); return {}; },
    getByIds: async ids => { pageCalls++; assert.ok(ids.length <= 100); return []; },
  } }, () => pageAt);
  await pageJobs.drain(1);
  const partial = await db.prepare('SELECT state,attempt,cleanup_cursor FROM release_jobs WHERE id=?').bind(pageJobId).first();
  assert.equal(partial.state, 'pending'); assert.equal(partial.attempt, 0); assert.ok(partial.cleanup_cursor);
  assert.equal(pageCalls, 20);
  assert.equal((await db.prepare('SELECT vector_erased_at FROM release_erasure_ledger WHERE memory_id=?').bind(pageMemory.id).first()).vector_erased_at, null);
  await db.prepare("UPDATE release_jobs SET state='dead',attempt=5 WHERE id=?").bind(pageJobId).run();
  assert.equal((await request(`/v1/spaces/${personalSpace.id}/jobs/${encodeURIComponent(pageJobId)}/retry`,
    { method: 'POST', token: owner.token })).status, 202);
  assert.equal((await db.prepare('SELECT cleanup_cursor FROM release_jobs WHERE id=?').bind(pageJobId).first()).cleanup_cursor, partial.cleanup_cursor);
  pageAt += 300000; pageCalls = 0;
  await pageJobs.drain(1);
  assert.equal((await db.prepare('SELECT state FROM release_jobs WHERE id=?').bind(pageJobId).first()).state, 'done');
  assert.equal(pageCalls, 2);
  assert.equal((await db.prepare('SELECT vector_erased_at FROM release_erasure_ledger WHERE memory_id=?').bind(pageMemory.id).first()).vector_erased_at, pageAt);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM release_vector_refs WHERE memory_id=?').bind(pageMemory.id).first()).n, 1001);
  // A successfully accepted deletion may not be visible immediately. More than
  // five such pages must continue without spending actual provider failures.
  const delayedVectors = new Set((await db.prepare('SELECT vector_id FROM release_vector_refs WHERE memory_id=?').bind(pageMemory.id).all()).results.map(row => row.vector_id));
  const pendingDeletes = new Map(); let acceptedDeletes = 0, delayedPasses = 0;
  const priorConfirmation = pageAt;
  await db.prepare("UPDATE release_jobs SET state='pending',attempt=2,available_at=?,cleanup_cursor='',cleanup_pending='[]' WHERE id=?").bind(pageAt, pageJobId).run();
  const settleDeletes = () => { for (const [vectorId, visibleAt] of pendingDeletes) if (visibleAt <= pageAt) { delayedVectors.delete(vectorId); pendingDeletes.delete(vectorId); } };
  const delayedJobs = new Jobs({ DB: db, MEMORY_INDEX: {
    deleteByIds: async ids => { acceptedDeletes++; settleDeletes(); for (const vectorId of ids) { assert.ok(!pendingDeletes.has(vectorId), 'Accepted pending pages must not be resubmitted'); pendingDeletes.set(vectorId, pageAt + 1000); } return { mutationId: 'native-delayed-' + acceptedDeletes }; },
    getByIds: async ids => { settleDeletes(); return ids.filter(vectorId => delayedVectors.has(vectorId)).map(id => ({ id })); },
  } }, () => pageAt);
  for (; delayedPasses < 20; delayedPasses++) {
    await delayedJobs.drain(1);
    const progress = await db.prepare('SELECT state,attempt,cleanup_pending FROM release_jobs WHERE id=?').bind(pageJobId).first();
    assert.equal(progress.attempt, progress.state === 'done' ? 3 : 2);
    if (progress.state === 'done') break;
    assert.equal(progress.state, 'pending');
    assert.ok(JSON.parse(progress.cleanup_pending).length > 0);
    assert.equal((await db.prepare('SELECT vector_erased_at FROM release_erasure_ledger WHERE memory_id=?').bind(pageMemory.id).first()).vector_erased_at, priorConfirmation);
    pageAt += 6000;
  }
  assert.ok(delayedPasses > 5 && delayedPasses < 20);
  assert.equal(delayedVectors.size, 0); assert.equal(acceptedDeletes, 11);
  assert.equal((await db.prepare('SELECT vector_erased_at FROM release_erasure_ledger WHERE memory_id=?').bind(pageMemory.id).first()).vector_erased_at, pageAt);
  // An older accepted upsert can land after deletion and before confirmation.
  // A retained pending page must reconcile again after its durable deadline.
  const lateVectorId = 'native-ref:1000', lateVectors = new Set([lateVectorId]);
  let lateDeletes = 0, lateUpsertReleased = false;
  const lastConfirmedAt = pageAt;
  await db.prepare(`UPDATE release_jobs SET state='pending',attempt=2,available_at=?,cleanup_cursor='native-ref:0999',
    cleanup_pending='[]',cleanup_retry_at=0,cleanup_retry_delay=60000 WHERE id=?`).bind(pageAt, pageJobId).run();
  const lateIndex = {
    deleteByIds: async ids => { assert.deepEqual(ids, [lateVectorId]); lateDeletes++; lateVectors.delete(lateVectorId); return { mutationId: 'native-reconcile-' + lateDeletes }; },
    getByIds: async ids => {
      if (lateDeletes === 1 && !lateUpsertReleased) { lateUpsertReleased = true; lateVectors.add(lateVectorId); }
      return ids.filter(id => lateVectors.has(id)).map(id => ({ id }));
    },
  };
  const lateJobs = () => new Jobs({ DB: db, MEMORY_INDEX: lateIndex }, () => pageAt);
  await lateJobs().drain(1);
  const latePending = await db.prepare('SELECT state,attempt,cleanup_cursor,cleanup_retry_at FROM release_jobs WHERE id=?').bind(pageJobId).first();
  assert.equal(latePending.state, 'pending'); assert.equal(latePending.attempt, 2);
  assert.equal(latePending.cleanup_cursor, 'native-ref:0999'); assert.equal(lateDeletes, 1); assert.equal(lateVectors.size, 1);
  assert.ok(latePending.cleanup_retry_at >= pageAt + 60000);
  pageAt = latePending.cleanup_retry_at - 1;
  await lateJobs().drain(1);
  assert.equal(lateDeletes, 1, 'Confirmation must preserve the propagation window across restarts');
  assert.equal((await db.prepare('SELECT vector_erased_at FROM release_erasure_ledger WHERE memory_id=?').bind(pageMemory.id).first()).vector_erased_at, lastConfirmedAt);
  pageAt = latePending.cleanup_retry_at + 5000;
  await lateJobs().drain(1);
  assert.equal(lateDeletes, 2); assert.equal(lateVectors.size, 0);
  const reconciled = await db.prepare('SELECT state,attempt,cleanup_pending,cleanup_retry_at FROM release_jobs WHERE id=?').bind(pageJobId).first();
  assert.equal(reconciled.state, 'done'); assert.equal(reconciled.attempt, 3); assert.equal(reconciled.cleanup_pending, '[]'); assert.equal(reconciled.cleanup_retry_at, 0);
  assert.equal((await db.prepare('SELECT vector_erased_at FROM release_erasure_ledger WHERE memory_id=?').bind(pageMemory.id).first()).vector_erased_at, pageAt);
  // Final disclosure SQL must execute on native D1 too. Interleave independent
  // successful HTTP erasure/cancellation requests just before that snapshot.
  // Keep these new job-producing fixtures after the queue scheduling assertions.
  function disclosureDatabase(marker, beforeSnapshot) {
    let checks = 0, sqlFailure;
    const wrappedDb = {
      withSession() { return this; },
      batch(statements) { return db.batch(statements.map(statement => statement.native?.() ?? statement)); },
      prepare(sql) {
        let statement = db.prepare(sql);
        const wrapped = {
          native: () => statement,
          bind(...values) { statement = statement.bind(...values); return wrapped; },
          all: (...args) => statement.all(...args), run: (...args) => statement.run(...args),
          async first(...args) {
            const final = sql.includes(marker);
            if (final) { checks++; await beforeSnapshot(); }
            try { return await statement.first(...args); }
            catch (error) { if (final) sqlFailure = error; throw error; }
          },
        };
        return wrapped;
      },
    };
    return { db: wrappedDb, verify() { if (sqlFailure) throw sqlFailure; assert.equal(checks, 1); } };
  }
  await db.prepare("UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind='session'").bind(Date.now(), owner.accountId).run();
  for (const kind of ['get', 'list', 'trash', 'search', 'export']) {
    const isolated = await original.createSpace(owner.token, { name: 'Native disclosure ' + kind });
    const firstBody = 'NATIVEDISCLOSURE ' + kind + ' sensitive quote A';
    const secondBody = 'NATIVEDISCLOSURE ' + kind + ' sensitive quote B';
    await original.create(owner.token, isolated.id, { body: firstBody });
    await original.create(owner.token, isolated.id, { body: secondBody });
    const order = kind === 'export' ? 'id' : 'created_at DESC,id';
    const targets = (await db.prepare('SELECT id,body,revision FROM memories WHERE space_id=? ORDER BY ' + order).bind(isolated.id).all()).results;
    const victim = targets[0], survivor = targets[1], memoryPath = `/v1/spaces/${isolated.id}/memories`;
    if (kind === 'trash') {
      for (const target of targets)
        assert.equal((await request(`${memoryPath}/${target.id}`, { method: 'DELETE', token: owner.token,
          data: { expectedRevision: target.revision, operationId: 'native-disclosure-trash-' + target.id } })).status, 204);
    }
    let path = kind === 'get' ? `${memoryPath}/${victim.id}` : kind === 'search' ? memoryPath + '?query=NATIVEDISCLOSURE'
      : memoryPath + '?limit=1' + (kind === 'trash' ? '&deleted=true' : '');
    if (kind === 'export') {
      const started = await request(`/v1/spaces/${isolated.id}/exports`, { method: 'POST', token: owner.token, data: {} });
      assert.equal(started.status, 201); const exportId = (await started.json()).id;
      path = `/v1/spaces/${isolated.id}/exports/${exportId}?limit=1`;
    }
    const intercept = disclosureDatabase(kind === 'export' ? '/* export-disclosure */' : '/* rest-memory-disclosure */', async () => {
      let current = await db.prepare('SELECT revision,deleted_at FROM memories WHERE id=?').bind(victim.id).first();
      if (current.deleted_at === null) {
        assert.equal((await request(`${memoryPath}/${victim.id}`, { method: 'DELETE', token: owner.token,
          data: { expectedRevision: current.revision, operationId: 'native-disclosure-remove-' + victim.id } })).status, 204);
        current = await db.prepare('SELECT revision,deleted_at FROM memories WHERE id=?').bind(victim.id).first();
      }
      const erased = await request(`${memoryPath}/${victim.id}/erase`, { method: 'POST', token: owner.token,
        data: { expectedRevision: current.revision, confirmation: victim.id, operationId: 'native-disclosure-erase-' + victim.id } });
      assert.equal(erased.status, 200);
    });
    const isolatedRelease = createRelease({ DB: intercept.db });
    const response = await isolatedRelease.route(new Request(origin + path), owner.token);
    intercept.verify(); assert.equal(response.status, kind === 'get' ? 404 : 200);
    const responseText = await response.text(); assert.ok(!responseText.includes(victim.body), kind + ' must omit erased plaintext');
    const erasedRow = await db.prepare('SELECT body,erased_at FROM memories WHERE id=?').bind(victim.id).first();
    assert.equal(erasedRow.body, '[erased]'); assert.ok(erasedRow.erased_at);
    if (kind !== 'get') {
      const payload = JSON.parse(responseText);
      assert.ok(payload.results.every(row => row.id !== victim.id));
      if (['list', 'trash', 'export'].includes(kind)) {
        assert.deepEqual(payload.results, []); assert.ok(payload.nextCursor, kind + ' must advance an omitted raw page');
        const next = await request(path + '&cursor=' + encodeURIComponent(payload.nextCursor), { token: owner.token });
        assert.equal(next.status, 200); assert.deepEqual((await next.json()).results.map(row => row.id), [survivor.id]);
      }
    }
  }
  for (const scenario of ['cancelled', 'approved', 'listed-cancelled']) {
    const collection = scenario === 'listed-cancelled', transition = collection ? 'cancelled' : scenario;
    const ingestId = 'native-disclosure-ingest-' + scenario, now = Date.now();
    const quote = 'NATIVE INGEST PRIVATE QUOTATION ' + scenario;
    await db.prepare("INSERT INTO release_jobs(id,space_id,kind,state,available_at,created_at) VALUES(?,?,'ingest','done',?,?)")
      .bind(ingestId, personalSpace.id, now, now).run();
    await db.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,ciphertext,proposals,state,expires_at,created_at) VALUES(?,?,?,?,'synthetic-encrypted-source',?,'review',?,?)")
      .bind(ingestId, owner.accountId, personalSpace.id, ownerCredential.id,
        JSON.stringify([{ body: quote, kind: 'fact', sourceMessageId: 'message1', quote }]), now + 3600000, now).run();
    const path = `/v1/spaces/${personalSpace.id}/ingests/${ingestId}`;
    const intercept = disclosureDatabase(collection ? '/* ingest-list-disclosure */' : '/* ingest-disclosure */', async () => {
      const changed = transition === 'cancelled'
        ? await request(path, { method: 'DELETE', token: owner.token })
        : await request(path + '/approve', { method: 'POST', token: owner.token, data: { selected: [0], operationId: ingestId + '-approve' } });
      assert.equal(changed.status, transition === 'cancelled' ? 204 : 200);
    });
    const currentRelease = createRelease({ DB: intercept.db });
    const response = await currentRelease.route(new Request(origin + (collection ? `/v1/spaces/${personalSpace.id}/ingests` : path)), owner.token);
    intercept.verify(); assert.equal(response.status, 200);
    const responseText = await response.text(), payload = JSON.parse(responseText);
    assert.ok(!responseText.includes(quote));
    if (collection) assert.equal(payload.results.find(row => row.id === ingestId).state, transition);
    else { assert.equal(payload.state, transition); assert.deepEqual(payload.proposals, []); }
    const cleared = await db.prepare('SELECT state,ciphertext,proposals FROM release_ingests WHERE id=?').bind(ingestId).first();
    assert.deepEqual(cleared, { state: transition, ciphertext: null, proposals: null });
  }
  // An old tombstone can remain while automatic erasure is disabled. Native
  // trigger denial must distinguish expiry from a genuine revision conflict,
  // and current retention changes must update the advertised deadline.
  const oldAt = Date.now() - 31 * 86400000;
  const oldSpace = await original.createSpace(owner.token, { name: 'Native retention eligibility' });
  const oldRecord = await historicalTombstone(oldSpace.id, ownerCredential.id, 'Native retained trash source', oldAt);
  const oldPath = `/v1/spaces/${oldSpace.id}/memories`;
  const expiredTrash = await (await request(oldPath + '?deleted=true', { token: owner.token })).json();
  assert.equal(expiredTrash.results[0].restoreUntil, oldAt + 30 * 86400000);
  assert.equal(expiredTrash.results[0].restoreExpired, true);
  const wrongRevision = await request(`${oldPath}/${oldRecord.id}/restore`, { method: 'POST', token: owner.token,
    data: { expectedRevision: 1, operationId: 'native-retention-wrong-revision' } });
  assert.equal(wrongRevision.status, 409); assert.equal((await wrongRevision.json()).error, 'revision_conflict');
  const expiredRestore = await request(`${oldPath}/${oldRecord.id}/restore`, { method: 'POST', token: owner.token,
    data: { expectedRevision: 2, operationId: 'native-retention-expired' } });
  assert.equal(expiredRestore.status, 409); assert.equal((await expiredRestore.json()).error, 'restore_expired');
  assert.equal((await db.prepare("SELECT count(*) AS n FROM release_operations WHERE client_key='native-retention-expired'").first()).n, 0);
  assert.equal((await request(`/v1/spaces/${oldSpace.id}/retention`, { method: 'PUT', token: owner.token, data: { days: 40 } })).status, 200);
  const eligibleTrash = await (await request(oldPath + '?deleted=true', { token: owner.token })).json();
  assert.equal(eligibleTrash.results[0].restoreUntil, oldAt + 40 * 86400000);
  assert.equal(eligibleTrash.results[0].restoreExpired, false);
  const eligibleRestore = await request(`${oldPath}/${oldRecord.id}/restore`, { method: 'POST', token: owner.token,
    data: { expectedRevision: 2, operationId: 'native-retention-eligible' } });
  assert.equal(eligibleRestore.status, 200); assert.equal((await eligibleRestore.json()).body, oldRecord.body);
  // Superseding writes disclose content and therefore exercise create, update
  // and read together: the largest action set emitted by current MCP tools.
  const combinedAuthorityResponse = await request('/mcp', { method: 'POST', token: owner.token,
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    data: { jsonrpc: '2.0', id: 'native-combined-authority', method: 'tools/call', params: { name: 'memory_add', arguments: {
      spaceId: personalSpace.id, body: 'Native combined create update read authority', supersedesMemoryId: successor.id, operationId: 'native-combined-authority',
    } } } });
  assert.equal(combinedAuthorityResponse.status, 200);
  const combinedAuthorityText = await combinedAuthorityResponse.text();
  const combinedAuthorityResult = JSON.parse(combinedAuthorityResponse.headers.get('content-type')?.includes('text/event-stream') ? combinedAuthorityText.split('\n').find(line => line.startsWith('data: ')).slice(6) : combinedAuthorityText);
  assert.equal(combinedAuthorityResult.id, 'native-combined-authority');
  assert.equal(combinedAuthorityResult.result.isError, false);
  assert.equal(JSON.parse(combinedAuthorityResult.result.content[0].text).body, 'Native combined create update read authority');
  // Execute the final MCP authority query on actual D1, including a deadline
  // passing after its snapshot and revocation before that snapshot. The SDK
  // still frames ordinary tool errors for browser/PAT bearers. A bound PAT's
  // revocation must suppress its previously buffered content as well.
  const boundaryMemory = await original.create(owner.token, organization.spaceId, { body: 'native MCP final authority confidential sentinel' });
  const boundaryMembership = await db.prepare('SELECT id,expires_at FROM memberships WHERE account_id=? AND organization_id=? AND revoked_at IS NULL')
    .bind(reader.accountId, organization.id).first();
  assert.ok(boundaryMembership);
  const boundaryPatResponse = await request('/v1/keys', { method: 'POST', token: reader.token,
    data: { label: 'Native response authority reader', organizationId: organization.id, capabilities: ['read'], spaceIds: [organization.spaceId], expiresInDays: 1 } });
  assert.equal(boundaryPatResponse.status, 201); const boundaryPat = await boundaryPatResponse.json();
  for (const boundary of ['expiry', 'revocation']) {
    let boundaryAt = Date.now(), boundaryChecks = 0, boundarySqlFailure;
    const deadlineAt = boundaryAt + 1000;
    if (boundary === 'expiry') await db.prepare('UPDATE memberships SET expires_at=? WHERE id=?').bind(deadlineAt, boundaryMembership.id).run();
    const boundaryDb = {
      withSession() { return this; },
      batch(statements) { return db.batch(statements.map(statement => statement.native?.() ?? statement)); },
      prepare(sql) {
        let statement = db.prepare(sql);
        const wrapped = {
          native: () => statement,
          bind(...values) { statement = statement.bind(...values); return wrapped; },
          all: (...args) => statement.all(...args), run: (...args) => statement.run(...args),
          async first(...args) {
            const finalAuthority = sql.includes('/* mcp-response-authority */');
            if (finalAuthority) {
              boundaryChecks++;
              if (boundary === 'revocation') await db.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').bind(boundaryAt, boundaryMembership.id).run();
            }
            let result;
            try { result = await statement.first(...args); }
            catch (error) { if (finalAuthority) boundarySqlFailure = error; throw error; }
            if (finalAuthority && boundary === 'expiry') boundaryAt = deadlineAt;
            return result;
          },
        };
        return wrapped;
      },
    };
    const boundaryRelease = createRelease({ DB: boundaryDb }, { clock: () => boundaryAt });
    const boundaryResponse = await boundaryRelease.route(new Request('https://memory.allenlabs.org/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'native-' + boundary, method: 'tools/call', params: { name: 'memory_get', arguments: { spaceId: organization.spaceId, memoryId: boundaryMemory.id } } }),
    }), boundary === 'expiry' ? reader.token : boundaryPat.token);
    if (boundarySqlFailure) throw boundarySqlFailure;
    assert.equal(boundaryChecks, 1);
    const boundaryText = await boundaryResponse.text();
    assert.equal(boundaryResponse.status, 200);
    const boundaryResult = JSON.parse(boundaryResponse.headers.get('content-type')?.includes('text/event-stream') ? boundaryText.split('\n').find(line => line.startsWith('data: ')).slice(6) : boundaryText);
    assert.equal(boundaryResult.id, 'native-' + boundary); assert.equal(boundaryResult.result.isError, true);
    assert.ok(!boundaryText.includes(boundaryMemory.body), 'Final authority loss must suppress buffered plaintext');
    if (boundary === 'expiry') await db.prepare('UPDATE memberships SET expires_at=? WHERE id=?').bind(boundaryMembership.expires_at, boundaryMembership.id).run();
  }
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  console.log('PASS bundled Worker on local workerd/D1: populated migrations 5-21 with preserved identity/history, pagination indexes, stable FTS row lookup and indexed foundation key issuance, preserved checkout attempts and customer-failure recovery, bounded vector erasure with durable progress, asynchronous visibility confirmation, durable late-upsert reconciliation and retained identifiers, bounded scheduled cleanup and preserved personal memories/audit/jobs, maintenance heartbeat, lease fencing/renewal, paginated account-bound share invitations, retryable consent, and lost-response outbound grant recovery across browser sessions, SCIM qualified deactivation, deletion history/projection/pagination/owner protection, tenant FTS backfill/Unicode/prefix boundaries and pre-metering query limits, atomic idempotency/supersession conflicts, revisions, trash/restore, independent nested organizations, SSO bootstrap, invitations, scoped member PATs and encoded revocation/retry IDs, account-intent enforcement, terminal-ingest retry refusal, final REST erasure and ingest cancellation/approval disclosure, retained-page cursor progress, retention expiry classification and policy refresh, final MCP response authority and combined action checks, offboarding, readiness and integrity.');
} finally { parser.close(); await mf.dispose(); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fixture, at } from './db.mjs';
import { WorkspaceService } from '../../src/workspace.ts';
import { Admin } from '../../src/release/admin.ts';
import { IdentityService } from '../../src/identity.ts';
import { createSeoulProjectionCapture } from '../../src/release/seoul-projection-capture.ts';
import { createDurableDatabase } from '../../src/durable-sql/client.ts';
import { SqlDatabaseEngine } from '../../src/durable-sql/engine.ts';
import { parseSeoulAuthoritySourceRow, prepareSeoulHeadCandidate } from '../../src/release/seoul-projection-source-codec.ts';
import { createSeoulProjectionPreparer } from '../../src/release/seoul-projection-preparer.ts';
import { signSeoulProjectionRequest, verifySeoulProjectionRequest } from '../../src/release/seoul-projection-auth.ts';
import { verifySeoulHeadReceiptForEvent } from '../../src/release/seoul-projection-head-receipt-codec.ts';
import { createHeadFixture } from '../../test/postgres/seoul-projection-head-fixture.mjs';

const issuer = 'https://auth-api.allen.company', endpoint = 'https://projection.fixture.test/internal/v1/seoul/projections';
const utf8 = new TextEncoder();
const principal = (subject, extra = {}) => ({ issuer, subject, issuedAt: at, expiresAt: at + 900000, permission: 'write', ...extra });
const hash = value => createHash('sha256').update(value).digest('hex');
const rows = (raw, table) => raw.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();

async function central(t, recursive) {
  const f = await fixture(); t.after(() => f.db.close()); const raw = f.db.raw;
  for (const name of ['0026_seoul-projection-schema.sql', '0027_seoul-projection-capture-schema.sql', '0028_seoul-projection-bootstrap-schema.sql', '0029_seoul-projection-preparation-schema.sql'])
    raw.exec(readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
  raw.exec('PRAGMA recursive_triggers=' + recursive);
  const requests = [];
  const storage = { sql: { exec(sql, ...values) {
    const statement = raw.prepare(sql), result = statement.all(...values);
    const readonly = statement.columns().length > 0 && /^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());
    return { rowsWritten: readonly ? 0 : Number(raw.prepare('SELECT changes() AS n').get().n),
      toArray: () => result, [Symbol.iterator]: () => result[Symbol.iterator]() };
  } }, transactionSync(fn) { raw.exec('BEGIN IMMEDIATE'); try { const result = fn(); raw.exec('COMMIT'); return result; }
    catch (error) { raw.exec('ROLLBACK'); throw error; } } };
  const engine = new SqlDatabaseEngine(storage, { objectName: 'sql:staging:control:1' }); engine.initialize();
  raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging', 'control', 'control', 1, 'ready', 'a'.repeat(64), 'b'.repeat(64));
  const db = createDurableDatabase({ async execute(request) { requests.push(request); return engine.execute(request); } },
    { deploymentId: 'staging', databaseId: 'control', kind: 'control', epoch: 1 });
  const capture = createSeoulProjectionCapture(db, 'durable-sql');
  for (const subject of ['alice', 'alias\n😀']) raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer, subject, 'alice', at);
  return { ...f, raw, requests, preparer: createSeoulProjectionPreparer(db, 'durable-sql'), workspace: new WorkspaceService(db, () => at, { identityLifecycle: true }, capture),
    admin: new Admin({ DB: db }, () => at, capture), identity: new IdentityService(db, () => at, capture) };
}
const positive = async f => (await f.db.query(`SELECT jsonb_build_object(
  'accounts',(SELECT jsonb_agg(a) FROM memory_identity.accounts a),
  'identities',(SELECT jsonb_agg(i) FROM memory_identity.provider_identities i),
  'emails',(SELECT jsonb_agg(e) FROM memory_identity.account_emails e),
  'organizations',(SELECT jsonb_agg(o) FROM memory_control.organizations o),
  'memberships',(SELECT jsonb_agg(m) FROM memory_identity.memberships m),
  'credentials',(SELECT jsonb_agg(c) FROM memory_identity.credentials c),
  'spaces',(SELECT jsonb_agg(s) FROM memory_control.spaces s),
  'grants',(SELECT jsonb_agg(g) FROM memory_identity.pat_space_grants g),
  'usage',(SELECT jsonb_agg(u) FROM memory_ops.space_usage u)) AS value`)).rows[0].value;

for (const prepared of [false, true]) for (const recursive of ['ON', 'OFF']) test('actual capture -> canonical source/head -> HMAC -> private SQL/receipt; prepared=' + prepared + ', recursion ' + recursive, async t => {
  const d1 = await central(t, recursive), pg = await createHeadFixture(t), initialPositive = await positive(pg);
  const signedIn = await d1.workspace.signIn(principal('new\n\uE000😀', { emailVerified: true, email: 'new@example.com' }));
  const rootOrganization = await d1.workspace.createOrganization(d1.token, { name: 'Root', emailId: 'e1' });
  const childOrganization = await d1.workspace.createOrganization(d1.token, { name: 'Child', emailId: 'e1', parentOrganizationId: 'org' });
  const personal = await d1.admin.issueKey(d1.token, { label: 'Personal fixture', capabilities: ['read'], spaceIds: ['s1'], expiresInDays: 1 });
  const organization = await d1.admin.issueKey(d1.token, { label: 'Organization fixture', organizationId: 'org', capabilities: ['read', 'create'], spaceIds: ['so'], expiresInDays: 1 });
  await d1.workspace.signIn(principal('alice', { emailVerified: true, email: 'linked@example.com' }));
  await d1.identity.unlinkEmail(d1.token, 'e1');
  const sourceRows = rows(d1.raw, 'release_seoul_authority_changes');
  assert.deepEqual([...new Set(sourceRows.map(row => JSON.parse(row.record_bytes).kind))].sort(),
    ['credential-source', 'email-source', 'membership-source', 'organization-source', 'space-source', 'subject-source']);
  for (const secret of [signedIn.token, personal.token, organization.token, d1.token]) assert.ok(!JSON.stringify(sourceRows).includes(secret));
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(19), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const receipts = [], outcomes = new Set();
  const beforePreparation = preparationInvariants(d1.raw);
  for (const row of sourceRows.slice().reverse()) {
    const source = parseSeoulAuthoritySourceRow(row), candidate = await prepareSeoulHeadCandidate(row);
    assert.deepEqual(candidate.rowGuard, { ...row });
    assert.equal(hash(candidate.sourceCoreBytes), candidate.sourceChangeSha256);
    assert.equal(hash(candidate.eventBytes), candidate.transportPayloadSha256);
    assert.notEqual(candidate.sourceChangeSha256, candidate.transportPayloadSha256);
    let transportBytes = candidate.eventBytes;
    if (prepared) {
      assert.deepEqual(await d1.preparer.prepare(row.revision), { status: 'prepared', revision: row.revision, eventId: row.event_id,
        sourceChangeSha256: candidate.sourceChangeSha256, transportPayloadSha256: candidate.transportPayloadSha256 });
      const persisted = d1.raw.prepare('SELECT payload_bytes,payload_sha256 FROM release_seoul_projection_events WHERE event_id=?').get(row.event_id);
      assert.equal(persisted.payload_bytes, candidate.eventText); assert.equal(persisted.payload_sha256, candidate.transportPayloadSha256);
      // Send bytes read from the persisted transport, including older positive
      // sources prepared after the same stream's newer terminal head.
      transportBytes = utf8.encode(persisted.payload_bytes);
    }
    const headers = await signSeoulProjectionRequest(key, { method: 'POST', url: endpoint, body: transportBytes, timestampMs: at });
    const request = new Request(endpoint, { method: 'POST', headers, body: transportBytes });
    const actualRequestBytes = new Uint8Array(await request.arrayBuffer());
    const verified = await verifySeoulProjectionRequest(key, request, actualRequestBytes, at);
    assert.equal(verified.method, 'POST'); assert.equal(verified.envelope.eventId, source.eventId);
    assert.equal(verified.envelope.head.eventId, source.eventId);
    assert.equal(verified.envelope.head.payloadSha256, candidate.sourceChangeSha256);
    const receiptText = await pg.apply(new TextDecoder().decode(verified.rawBody), verified.transportPayloadSha256);
    const receipt = await verifySeoulHeadReceiptForEvent(utf8.encode(receiptText), transportBytes);
    assert.notEqual(receipt.outcome, 'conflict'); outcomes.add(receipt.outcome);
    const statusUrl = endpoint + '/' + source.eventId + '?payloadSha256=' + candidate.transportPayloadSha256;
    const statusHeaders = await signSeoulProjectionRequest(key, { method: 'GET', url: statusUrl, body: new Uint8Array(), timestampMs: at });
    const statusRequest = new Request(statusUrl, { headers: statusHeaders });
    const status = await verifySeoulProjectionRequest(key, statusRequest, new Uint8Array(await statusRequest.arrayBuffer()), at);
    assert.equal(status.method, 'GET'); assert.equal(await pg.status(status.eventId, status.payloadSha256), receiptText);
    receipts.push({ candidate, receiptText });
  }
  assert.deepEqual([...outcomes].sort(), ['applied', 'head_superseded']);
  const beforeReplay = await pg.state();
  for (const { candidate, receiptText } of receipts) assert.equal(await pg.apply(candidate.eventText, candidate.transportPayloadSha256), receiptText);
  assert.deepEqual(await pg.state(), beforeReplay);
  const tombstones = beforeReplay.identity_projection_tombstones;
  assert.ok(tombstones.some(row => row.kind === 'credential' && row.stream_key === organization.id));
  assert.ok(!tombstones.some(row => row.kind === 'credential' && row.stream_key === personal.id));
  const memberIds = ['m1', ...[rootOrganization.id, childOrganization.id].map(id =>
    d1.raw.prepare('SELECT id FROM memberships WHERE organization_id=? AND account_id=?').get(id, 'alice').id)];
  assert.deepEqual(tombstones.filter(row => row.kind === 'membership').map(row => row.stream_key).sort(), memberIds.slice().sort());
  for (const [kind, id] of [...memberIds.map(id => ['membership', id]), ['credential', organization.id]]) {
    const negative = sourceRows.find(row => row.stream_kind === kind && row.stream_key === id && JSON.parse(row.record_bytes).effect.type === 'entity-negative');
    assert.ok(negative, 'the accepted unlink must capture every actual member/PAT negative');
    const tombstone = tombstones.find(row => row.kind === kind && row.stream_key === id);
    assert.equal(tombstone.source_revision, negative.revision);
    const persisted = beforeReplay.identity_projection_source_heads.find(row => row.source_revision === negative.revision);
    assert.deepEqual(persisted.effect, { type: 'entity-negative', entityKind: kind, entityId: id, state: 'revoked', occurredAtMs: at });
    assert.equal(beforeReplay.identity_projection_heads.find(row => row.kind === kind && row.stream_key === id).source_revision, negative.revision);
  }
  assert.deepEqual(await positive(pg), initialPositive);
  assert.ok(rows(d1.raw, 'release_seoul_authority_heads').every(row => prepared ? row.payload_sha256 !== null : row.payload_sha256 === null));
  assert.equal(rows(d1.raw, 'release_seoul_prepared_sources').length, prepared ? sourceRows.length : 0);
  assert.deepEqual(preparationInvariants(d1.raw), beforePreparation);
  if (prepared) {
    assert.equal(rows(d1.raw, 'release_seoul_projection_deliveries').length, sourceRows.length);
    assert.ok(rows(d1.raw, 'release_seoul_projection_deliveries').every(row => row.state === 'pending' && row.attempts === 0 && row.receipt_bytes === null));
    const before = rows(d1.raw, 'release_seoul_projection_events');
    for (const row of sourceRows) assert.equal((await d1.preparer.prepare(row.revision)).status, 'already_prepared');
    assert.deepEqual(rows(d1.raw, 'release_seoul_projection_events'), before);
  }
  assert.equal(d1.raw.prepare('SELECT state FROM release_seoul_projection_state').get().state, 'backfill-required');
  for (const table of ['release_seoul_capture_attempts', 'release_seoul_capture_scope', 'release_seoul_capture_spaces',
    'release_seoul_bootstrap_attempts', 'release_seoul_bootstrap_scope', 'release_seoul_bootstrap_spaces', 'release_seoul_preparation_stage']) assert.equal(rows(d1.raw, table).length, 0);
  assert.ok(d1.requests.every(request => request.statements.length <= 100 && Buffer.byteLength(JSON.stringify(request)) <= 1048576));
  t.diagnostic(sourceRows.length + ' real captured rows; all six normal bodies; negative-before-old-positive delivery; immutable replay; no positive SQL authority; D1 prepared=' + prepared);
});

const preparationInvariants = raw => Object.fromEntries(['release_seoul_authority_changes', 'release_seoul_projection_state',
  'release_seoul_dirty_spaces', 'release_seoul_targets', 'release_seoul_projection_lock', 'release_seoul_published_snapshots',
  'release_seoul_account_exclusions'].map(table => [table, rows(raw, table)]));

for (const prepared of [false, true]) test('actual excluded bootstrap marker remains a non-authorizing head through the same codecs and SQL; prepared=' + prepared, async t => {
  const d1 = await central(t, 'ON'), pg = await createHeadFixture(t), initialPositive = await positive(pg);
  d1.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run('https://retained.invalid', 'foreign', 'alice', at);
  const created = await d1.workspace.createOrganization(d1.token, { name: 'Excluded central success', emailId: 'e1' });
  assert.ok(d1.raw.prepare('SELECT id FROM organizations WHERE id=?').get(created.id));
  const sourceRows = rows(d1.raw, 'release_seoul_authority_changes'); assert.equal(sourceRows.length, 1);
  const source = parseSeoulAuthoritySourceRow(sourceRows[0]); assert.equal(source.body.kind, 'subject-source-unrepresentable');
  assert.equal(source.sourceCommandId, source.body.captureAttemptId);
  const candidate = await prepareSeoulHeadCandidate(sourceRows[0]);
  const beforePreparation = preparationInvariants(d1.raw);
  if (prepared) {
    assert.equal((await d1.preparer.prepare(source.revision)).status, 'prepared');
    const persisted = d1.raw.prepare('SELECT payload_bytes,payload_sha256 FROM release_seoul_projection_events WHERE event_id=?').get(source.eventId);
    assert.equal(persisted.payload_bytes, candidate.eventText); assert.equal(persisted.payload_sha256, candidate.transportPayloadSha256);
  }
  const receiptText = await pg.apply(candidate.eventText, candidate.transportPayloadSha256);
  const receipt = await verifySeoulHeadReceiptForEvent(utf8.encode(receiptText), candidate.eventBytes);
  assert.equal(receipt.outcome, 'applied'); assert.equal(JSON.parse(candidate.eventText).effect.disposition, 'changed');
  assert.equal(rows(d1.raw, 'release_seoul_account_exclusions').length, 1);
  assert.equal(rows(d1.raw, 'release_seoul_dirty_spaces').length, 0);
  assert.deepEqual(preparationInvariants(d1.raw), beforePreparation);
  assert.deepEqual(await positive(pg), initialPositive);
});

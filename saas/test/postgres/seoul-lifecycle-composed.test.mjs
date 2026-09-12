import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createSeoulApp } from '../../src/postgres/seoul/app.ts';
import { lifecycleRepositoryFixture } from './seoul-lifecycle-repository-fixture.mjs';
import { seoulIngest, seoulSearch } from './seoul-fixture.mjs';

const token = 'synthetic-composed-lifecycle-' + 'a'.repeat(40), digest = createHash('sha256').update(token).digest('hex');
const operation = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
function request(name, args) {
  return new Request('https://seoul-engine.example.test/mcp', { method: 'POST', headers: {
    authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'x-memory-routing': '2', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'composed:one',
    method: 'tools/call', params: { name, arguments: args } }) });
}
async function tool(app, name, args) {
  const response = await app.fetch(request(name, args)); assert.equal(response.status, 200);
  const text = await response.text();
  const body = response.headers.get('content-type').startsWith('text/event-stream')
    ? JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('data:')).slice(5).trim()) : JSON.parse(text);
  assert.equal(body.id, 'composed:one'); const result = body.result;
  return { isError: result.isError === true, value: JSON.parse(result.content[0].text) };
}
async function fixture(t, options = {}) {
  const f = await lifecycleRepositoryFixture(t); await f.grant();
  await f.asOwner(async () => {
    await f.db.query(`INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at)
      VALUES('pat:http','account:a','personal_key',$1,9007199254740991)`, [digest]);
    await f.db.exec(`INSERT INTO memory_identity.pat_space_grants
      (credential_id,account_id,space_id,can_ingest,can_search,can_erase,can_retire,expires_at)
      VALUES('pat:http','account:a','space:a',true,true,true,true,9007199254740991)`);
  });
  const repository = f.make(options), app = createSeoulApp({ repository, enabled: true });
  return { ...f, repository, app };
}

// Actual Hono + MCP SDK + repository + all fixed catalog/role checks + engine
// transactions. The fixture replaces only sockets; it is not live/TLS proof.
test('composed native lifecycle erases source, reconciles metadata and terminates Space/PAT authority', async t => {
  const f = await fixture(t), source = seoulIngest();
  const stored = await tool(f.app, 'memory_ingest', source); assert.equal(stored.isError, false);
  const archiveId = stored.value.archiveId, input = { spaceId: 'space:a', archiveId, expectedRevision: 1, operationId: operation('1') };
  const status = await tool(f.app, 'memory_lifecycle_status', { kind: 'archive', spaceId: 'space:a', archiveId });
  assert.equal(status.value.state, 'stored'); assert.equal(status.value.revision, 1);
  const erased = await tool(f.app, 'memory_archive_erase', input); assert.equal(erased.isError, false);
  assert.equal(erased.value.removedMessages, 2); assert.equal(erased.value.backupCleanup, 'not_confirmed');
  assert.equal(JSON.stringify(erased).includes(source.messages[0].content), false);
  const replay = await tool(f.app, 'memory_archive_erase', input);
  assert.deepEqual(replay.value, { ...erased.value, replayed: true });
  const receipt = await tool(f.app, 'memory_lifecycle_status', { kind: 'operation', spaceId: 'space:a', operationId: operation('1') });
  assert.deepEqual(receipt.value.receipt, erased.value);
  const search = await tool(f.app, 'memory_search', seoulSearch()); assert.equal(search.value.count, 0);
  assert.deepEqual((await tool(f.app, 'memory_ingest', source)).value, { error: 'seoul_archive_erased' });
  const retired = await tool(f.app, 'memory_space_retire', { spaceId: 'space:a', operationId: operation('2') });
  assert.equal(retired.value.state, 'retired'); assert.equal(retired.isError, false);
  assert.deepEqual((await tool(f.app, 'memory_lifecycle_status', { kind: 'archive', spaceId: 'space:a', archiveId })).value,
    { error: 'seoul_space_denied' });
  const revoked = await tool(f.app, 'memory_pat_revoke_self', { operationId: operation('3') });
  assert.equal(revoked.value.state, 'revoked'); assert.equal(revoked.isError, false);
  const denied = await f.app.fetch(request('memory_pat_revoke_self', { operationId: operation('3') }));
  assert.equal(denied.status, 401); assert.deepEqual(await denied.json(), { error: 'seoul_pat_denied' });
  const rows = (await f.db.query(`SELECT operation_id,request_digest,session_id,routing,created_at_ms,authority_expires_at_ms,
    hidden_at,lifecycle_revision,erased_at FROM memory_content.archives WHERE id=$1`, [archiveId])).rows[0];
  for (const field of ['operation_id','request_digest','session_id','routing','created_at_ms','authority_expires_at_ms','hidden_at']) assert.equal(rows[field], null);
  assert.equal(rows.lifecycle_revision, 2); assert.ok(rows.erased_at !== null);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_content.archive_messages')).rows[0].n, 0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.lifecycle_receipts')).rows[0].n, 3);
});
test('committed erasure disclosure expiry returns only an uncertain operation identity', async t => {
  let now = 100, checks = 0, original;
  const f = await fixture(t, { monotonicNow: () => now });
  const stored = await f.repository.ingest(digest, seoulIngest());
  const repository = { ...f.repository, lifecycle: { ...f.repository.lifecycle, async eraseArchive(...args) {
    original = await f.repository.lifecycle.eraseArchive(...args); return original;
  } }, assertDisclosure(result) {
    assert.equal(result, original); if (++checks === 2) now += 30000; f.repository.assertDisclosure(result);
  } };
  const app = createSeoulApp({ repository, enabled: true });
  const response = await app.fetch(request('memory_archive_erase', { spaceId: 'space:a', archiveId: stored.archiveId,
    expectedRevision: 1, operationId: operation('1') }));
  assert.equal(response.status, 503); assert.equal(checks, 2);
  assert.deepEqual(await response.json(), { error: 'operation_outcome_unknown', operationId: operation('1') });
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_content.archive_messages')).rows[0].n, 0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.lifecycle_receipts')).rows[0].n, 1);
});
test('current SQL authority is rechecked after successful Hono preauthentication', async t => {
  const f = await fixture(t), stored = await f.repository.ingest(digest, seoulIngest());
  const repository = { ...f.repository, async preauthenticatePat(...args) {
    await f.repository.preauthenticatePat(...args);
    await f.asOwner(() => f.db.exec("UPDATE memory_identity.pat_space_grants SET can_erase=false WHERE credential_id='pat:http'"));
  } };
  const app = createSeoulApp({ repository, enabled: true });
  const denied = await tool(app, 'memory_archive_erase', { spaceId: 'space:a', archiveId: stored.archiveId,
    expectedRevision: 1, operationId: operation('1') });
  assert.equal(denied.isError, true); assert.deepEqual(denied.value, { error: 'seoul_space_denied' });
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_content.archive_messages')).rows[0].n, 2);
});

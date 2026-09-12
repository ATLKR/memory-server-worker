import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeoulRepository } from '../../src/postgres/seoul/repository.ts';
import { lifecycleExpected, lifecycleTarget, lifecycleRepositoryFixture } from './seoul-lifecycle-repository-fixture.mjs';
import { SEOUL_DIGEST, OTHER_DIGEST, seoulIngest, seoulSearch } from './seoul-fixture.mjs';

const operationId = '11111111-1111-4111-8111-111111111111';
const archiveId = 'arc:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('only explicitly selected schema5 exposes a frozen lifecycle repository', () => {
  const factory = () => assert.fail('constructor opened transport');
  const v4 = createSeoulRepository(lifecycleTarget(), { ...lifecycleExpected(), schemaVersion: 4 }, { clientFactory: factory });
  assert.equal(Object.hasOwn(v4, 'lifecycle'), false);
  const v5 = createSeoulRepository(lifecycleTarget(), lifecycleExpected(), { clientFactory: factory });
  assert.deepEqual(Object.keys(v5.lifecycle).sort(), ['eraseArchive', 'retireSpace', 'revokeSelf', 'status']);
  assert.equal(Object.isFrozen(v5.lifecycle), true);
  for (const schemaVersion of [3, 6, '5']) assert.throws(() => createSeoulRepository(lifecycleTarget(),
    { ...lifecycleExpected(), schemaVersion }, { clientFactory: factory }), { code: 'seoul_unavailable' });
});

async function prepared(t, settings = {}) {
  const f = await lifecycleRepositoryFixture(t); await f.grant();
  const repo = f.make(settings), stored = await repo.ingest(SEOUL_DIGEST, seoulIngest());
  const erase = { spaceId: 'space:a', archiveId: stored.archiveId, expectedRevision: 1, operationId };
  return { ...f, repo, stored, erase };
}
const command = (sql, method) => sql.startsWith(`SELECT ${method === 'eraseArchive' ? 'memory_content.seoul_archive_erase' :
  method === 'retireSpace' ? 'memory_control.seoul_space_retire' : method === 'revokeSelf' ? 'memory_identity.seoul_pat_revoke_self' :
  'memory_ops.seoul_lifecycle_status'}(`);
const mutationInput = (f, method) => method === 'eraseArchive' ? f.erase : method === 'retireSpace'
  ? { spaceId: 'space:a', operationId } : { operationId };
async function emptySpace(t, settings = {}) {
  const f = await lifecycleRepositoryFixture(t); await f.grant(); return { ...f, repo: f.make(settings) };
}
test('version5 executes real erasure, immutable replay and status, and blocks resurrection and foreign authority', async t => {
  const f = await prepared(t), { repo, erase } = f;
  const before = await repo.lifecycle.status(SEOUL_DIGEST, { kind: 'archive', spaceId: erase.spaceId, archiveId: erase.archiveId });
  assert.equal(before.state, 'stored'); assert.equal(before.revision, 1); repo.assertDisclosure(before);
  await assert.rejects(repo.lifecycle.eraseArchive(OTHER_DIGEST, erase), { code: 'seoul_space_denied', outcome: 'rolled_back' });
  await assert.rejects(repo.lifecycle.eraseArchive(SEOUL_DIGEST, { ...erase, expectedRevision: 2 }), { code: 'seoul_revision_conflict', outcome: 'rolled_back' });
  const receipt = await repo.lifecycle.eraseArchive(SEOUL_DIGEST, erase); repo.assertDisclosure(receipt);
  assert.equal(receipt.state, 'primary_erased'); assert.equal(receipt.removedMessages, 2); assert.equal(receipt.backupCleanup, 'not_confirmed');
  assert.deepEqual(await repo.lifecycle.eraseArchive(SEOUL_DIGEST, erase), { ...receipt, replayed: true });
  const status = await repo.lifecycle.status(SEOUL_DIGEST, { kind: 'operation', spaceId: erase.spaceId, operationId });
  assert.deepEqual(status.receipt, receipt); assert.equal(Object.isFrozen(status.receipt), true);
  assert.equal((await repo.search(SEOUL_DIGEST, seoulSearch())).count, 0);
  await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest()), { code: 'seoul_archive_erased', outcome: 'rolled_back' });
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_content.archive_messages')).rows[0].n, 0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.lifecycle_receipts')).rows[0].n, 1);
});
test('retire and self revoke commit their intended terminal authority changes and deny later admissions', async t => {
  const f = await emptySpace(t), repo = f.repo;
  const retired = await repo.lifecycle.retireSpace(SEOUL_DIGEST, { spaceId: 'space:a', operationId });
  repo.assertDisclosure(retired); assert.equal(retired.state, 'retired');
  await assert.rejects(repo.lifecycle.status(SEOUL_DIGEST, { kind: 'operation', spaceId: 'space:a', operationId }), { code: 'seoul_space_denied' });
  const revoked = await repo.lifecycle.revokeSelf(SEOUL_DIGEST, { operationId: '22222222-2222-4222-8222-222222222222' });
  repo.assertDisclosure(revoked); assert.equal(revoked.state, 'revoked');
  await assert.rejects(repo.preauthenticatePat(SEOUL_DIGEST), { code: 'seoul_pat_denied' });
});
test('schema selection cannot downgrade or adopt another installed version before dispatch', async t => {
  const f = await emptySpace(t); f.expected.schemaVersion = 4;
  await assert.rejects(f.make().probe(), { code: 'seoul_unavailable' });
  assert.equal(f.log.some(sql => sql.includes('seoul_pat_check(')), false);
  assert.equal(f.log.includes('COMMIT'), false);
});
test('lifecycle caller inputs are captured before asynchronous connection work', async t => {
  const f = await prepared(t), input = { ...f.erase };
  f.hooks.connect = () => { input.spaceId = 'space:b'; input.operationId = 'private mutated value'; };
  const receipt = await f.repo.lifecycle.eraseArchive(SEOUL_DIGEST, input);
  assert.equal(receipt.spaceId, 'space:a'); assert.equal(receipt.operationId, operationId);
});
test('all lifecycle mutation malformed envelopes roll back before COMMIT', async t => {
  for (const method of ['eraseArchive', 'retireSpace', 'revokeSelf']) {
    await t.test(method, async t => {
      const f = method === 'eraseArchive' ? await prepared(t) : await emptySpace(t); f.log.length = 0;
      f.hooks.after = (query, response) => { if (command(query.text, method)) response.rows[0].value.result.operationId = 'wrong'; return response; };
      await assert.rejects(f.repo.lifecycle[method](SEOUL_DIGEST, mutationInput(f, method)), { code: 'seoul_response_invalid', outcome: 'rolled_back' });
      assert.equal(f.log.includes('COMMIT'), false);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.lifecycle_receipts')).rows[0].n, 0);
    });
  }
});
test('all lifecycle mutations preserve unknown COMMIT without retry and allow metadata reconciliation', async t => {
  for (const method of ['eraseArchive', 'retireSpace', 'revokeSelf']) {
    await t.test(method, async t => {
      const f = method === 'eraseArchive' ? await prepared(t) : await emptySpace(t); f.log.length = 0;
      f.hooks.after = (query, response) => { if (query.text === 'COMMIT') throw new Error('synthetic private diagnostic'); return response; };
      await assert.rejects(f.repo.lifecycle[method](SEOUL_DIGEST, mutationInput(f, method)), { code: 'seoul_write_outcome_unknown', outcome: 'unknown' });
      assert.equal(f.log.filter(sql => command(sql, method)).length, 1);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.lifecycle_receipts')).rows[0].n, 1);
      delete f.hooks.after;
      if (method === 'eraseArchive') assert.equal((await f.repo.lifecycle.status(SEOUL_DIGEST,
        { kind: 'operation', spaceId: 'space:a', operationId })).receipt.state, 'primary_erased');
      else if (method === 'revokeSelf') await assert.rejects(f.repo.preauthenticatePat(SEOUL_DIGEST), { code: 'seoul_pat_denied' });
      else await assert.rejects(f.repo.search(SEOUL_DIGEST, seoulSearch()), { code: 'seoul_space_denied' });
    });
  }
});
test('all lifecycle mutation result identities remain leased through final disclosure and cancellation', async t => {
  for (const method of ['eraseArchive', 'retireSpace', 'revokeSelf']) {
    await t.test(method, async t => {
      let now = 100;
      const f = method === 'eraseArchive' ? await prepared(t, { monotonicNow: () => now }) : await emptySpace(t, { monotonicNow: () => now });
      const controller = new AbortController();
      const result = await f.repo.lifecycle[method](SEOUL_DIGEST, mutationInput(f, method), { signal: controller.signal });
      f.repo.assertDisclosure(result);
      assert.throws(() => f.repo.assertDisclosure({ ...result }), { code: 'seoul_response_invalid' });
      now += 30000;
      assert.throws(() => f.repo.assertDisclosure(result), { code: 'seoul_write_outcome_unknown', outcome: 'committed' });
      now = 101; controller.abort();
      assert.throws(() => f.repo.assertDisclosure(result), { code: 'seoul_write_outcome_unknown', outcome: 'committed' });
    });
  }
});
test('lifecycle admission elapsed during connection cannot commit and status loses its read lease on regression', async t => {
  let now = 100; const f = await prepared(t, { monotonicNow: () => now }); f.log.length = 0;
  f.hooks.connect = () => { now += 30000; };
  await assert.rejects(f.repo.lifecycle.eraseArchive(SEOUL_DIGEST, f.erase), { code: 'seoul_authority_expired', outcome: 'rolled_back' });
  assert.equal(f.log.includes('COMMIT'), false); delete f.hooks.connect;
  const result = await f.repo.lifecycle.status(SEOUL_DIGEST, { kind: 'archive', spaceId: 'space:a', archiveId: f.erase.archiveId });
  f.repo.assertDisclosure(result); now--;
  assert.throws(() => f.repo.assertDisclosure(result), { code: 'seoul_authority_expired', outcome: 'committed' });
});
test('lifecycle strict input rejects unknown targets and accessors before credentials or transport', async () => {
  const repo = createSeoulRepository(lifecycleTarget(), lifecycleExpected(), { clientFactory: () => assert.fail('invalid input opened transport') });
  const inputs = [
    ['eraseArchive', { spaceId: 'space:a', archiveId, expectedRevision: 1, operationId, confirmation: archiveId }],
    ['eraseArchive', { spaceId: 'space:a', archiveId, expectedRevision: 3, operationId }],
    ['retireSpace', { spaceId: 'space:a', operationId: 'private source text' }],
    ['revokeSelf', { operationId, credentialId: 'other' }],
    ['status', { kind: 'archive', spaceId: 'space:a', archiveId, readDrain: true }],
    ['status', { kind: 'operation', spaceId: 'space:a', operationId, archiveId }],
  ];
  for (const [name, input] of inputs) await assert.rejects(repo.lifecycle[name](SEOUL_DIGEST, input), { code: 'seoul_input_invalid' });
  let reads = 0;
  await assert.rejects(repo.lifecycle.revokeSelf(SEOUL_DIGEST, { get operationId() { reads++; return operationId; } }), { code: 'seoul_input_invalid' });
  assert.equal(reads, 0);
});

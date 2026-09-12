import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeoulEraseInput, parseSeoulRetireInput, parseSeoulRevokeSelfInput, parseSeoulLifecycleStatusInput,
  parseSeoulEraseReceipt, parseSeoulRetireReceipt, parseSeoulRevokeSelfReceipt, parseSeoulLifecycleStatusResult } from '../../src/postgres/seoul/lifecycle-codecs.ts';

const archiveId = 'arc:90dac234-ae01-4cbd-b1dc-580db333a240';
const operationId = '31c2ef32-c648-49d7-8f8f-c4f8fd594718';
const input = { spaceId: 'space:one', archiveId, expectedRevision: 1, operationId };
const receipt = { spaceId: input.spaceId, archiveId, operationId, revision: 2, state: 'primary_erased', replayed: false,
  primaryRowsRemoved: true, removedMessages: 2, removedSourceBytes: 20, restoreAllowed: false,
  backupCleanup: 'not_confirmed', physicalMediaCleanup: 'not_confirmed' };
const denied = (fn, code = 'seoul_input_invalid') => assert.throws(fn, error => error.code === code);

test('lifecycle operations have explicit targets and independent UUID operation ids', () => {
  assert.deepEqual(parseSeoulEraseInput(input), input);
  assert.deepEqual(parseSeoulRetireInput({ spaceId: input.spaceId, operationId }), { spaceId: input.spaceId, operationId });
  assert.deepEqual(parseSeoulRevokeSelfInput({ operationId }), { operationId });
  assert.deepEqual(parseSeoulLifecycleStatusInput({ kind: 'archive', spaceId: input.spaceId, archiveId }),
    { kind: 'archive', spaceId: input.spaceId, archiveId });
  assert.deepEqual(parseSeoulLifecycleStatusInput({ kind: 'operation', spaceId: input.spaceId, operationId }),
    { kind: 'operation', spaceId: input.spaceId, operationId });
});

test('invalid revision, sensitive operation text, arbitrary credential selection and extra fields are rejected', () => {
  for (const changed of [{ ...input, expectedRevision: 0 }, { ...input, expectedRevision: 3 },
    { ...input, operationId: 'sensitive free text' }, { ...input, operationId: operationId.toUpperCase() },
    { ...input, archiveId: 'not-an-archive' }, { ...input, confirmation: archiveId }, { ...input, text: 'private transcript' }])
    denied(() => parseSeoulEraseInput(changed));
  denied(() => parseSeoulRevokeSelfInput({ operationId, credentialId: 'somebody-else' }));
  denied(() => parseSeoulLifecycleStatusInput({ kind: 'operation', spaceId: input.spaceId, operationId, archiveId }));
});

test('lifecycle input is snapshotted without invoking an accessor', () => {
  let reads = 0;
  const poisoned = { ...input };
  Object.defineProperty(poisoned, 'spaceId', { enumerable: true, get() { reads++; return input.spaceId; } });
  denied(() => parseSeoulEraseInput(poisoned));
  assert.equal(reads, 0);
  const source = { ...input }, parsed = parseSeoulEraseInput(source);
  source.spaceId = 'space:other';
  assert.equal(parsed.spaceId, input.spaceId);
  assert.equal(Object.isFrozen(parsed), true);
});

test('erasure receipts are target-bound and do not overclaim backup or physical deletion', () => {
  assert.deepEqual(parseSeoulEraseReceipt(receipt, input), receipt);
  for (const changed of [{ ...receipt, spaceId: 'space:other' }, { ...receipt, operationId: '40c2ef32-c648-49d7-8f8f-c4f8fd594718' },
    { ...receipt, restoreAllowed: true }, { ...receipt, backupCleanup: 'complete' }, { ...receipt, physicalMediaCleanup: 'complete' },
    { ...receipt, revision: 1 }, { ...receipt, removedMessages: 501 }, { ...receipt, removedSourceBytes: 1048577 },
    { ...receipt, removedMessages: 0 }, { ...receipt, transcript: 'private text' }])
    denied(() => parseSeoulEraseReceipt(changed, input), 'seoul_response_invalid');
  const terminal = { ...receipt, removedMessages: 0, removedSourceBytes: 0 };
  assert.deepEqual(parseSeoulEraseReceipt(terminal, { ...input, expectedRevision: 2 }), terminal);
  denied(() => parseSeoulEraseReceipt(receipt, { ...input, expectedRevision: 2 }), 'seoul_response_invalid');
});

test('retirement and self-revocation receipts disclose no credential and cannot fabricate replay', () => {
  const retire = { spaceId: input.spaceId, operationId, state: 'retired', replayed: false };
  assert.deepEqual(parseSeoulRetireReceipt(retire, { spaceId: input.spaceId, operationId }), retire);
  denied(() => parseSeoulRetireReceipt({ ...retire, spaceId: 'space:other' }, { spaceId: input.spaceId, operationId }), 'seoul_response_invalid');
  const revoke = { operationId, state: 'revoked', replayed: false };
  assert.deepEqual(parseSeoulRevokeSelfReceipt(revoke, { operationId }), revoke);
  denied(() => parseSeoulRevokeSelfReceipt({ ...revoke, credentialId: 'private' }, { operationId }), 'seoul_response_invalid');
  denied(() => parseSeoulRevokeSelfReceipt({ ...revoke, replayed: true }, { operationId }), 'seoul_response_invalid');
});

test('status is fresh target-bound metadata and cannot contain another Space receipt', () => {
  const query = { kind: 'operation', spaceId: input.spaceId, operationId };
  const result = { ...query, receipt };
  assert.deepEqual(parseSeoulLifecycleStatusResult(result, query), result);
  assert.deepEqual(parseSeoulLifecycleStatusResult({ ...query, receipt: null }, query), { ...query, receipt: null });
  denied(() => parseSeoulLifecycleStatusResult({ ...query, receipt: { ...receipt, spaceId: 'space:other' } }, query), 'seoul_response_invalid');
  const archiveQuery = { kind: 'archive', spaceId: input.spaceId, archiveId };
  assert.deepEqual(parseSeoulLifecycleStatusResult({ ...archiveQuery, revision: 2, state: 'primary_erased' }, archiveQuery),
    { ...archiveQuery, revision: 2, state: 'primary_erased' });
  denied(() => parseSeoulLifecycleStatusResult({ ...archiveQuery, revision: 1, state: 'primary_erased' }, archiveQuery), 'seoul_response_invalid');
  denied(() => parseSeoulLifecycleStatusResult({ ...archiveQuery, revision: 2, state: 'stored' }, archiveQuery), 'seoul_response_invalid');
});

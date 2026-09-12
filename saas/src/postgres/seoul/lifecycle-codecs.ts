import { z } from 'zod';
import { parseSeoulData } from './codecs.ts';
import { SeoulRepositoryError } from './types.ts';
import type { SeoulEraseInput, SeoulEraseReceipt, SeoulRetireInput, SeoulRetireReceipt, SeoulRevokeSelfInput,
  SeoulRevokeSelfReceipt, SeoulLifecycleStatusInput, SeoulLifecycleStatusResult } from './lifecycle-types.ts';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const archiveId = z.string().regex(/^arc:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const operationId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const revision = z.union([z.literal(1), z.literal(2)]);
export const seoulEraseInputSchema = z.strictObject({ spaceId: identifier, archiveId, expectedRevision: revision, operationId });
export const seoulRetireInputSchema = z.strictObject({ spaceId: identifier, operationId });
export const seoulRevokeSelfInputSchema = z.strictObject({ operationId });
export const seoulLifecycleStatusInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('archive'), spaceId: identifier, archiveId }),
  z.strictObject({ kind: z.literal('operation'), spaceId: identifier, operationId }),
]);
const eraseReceiptSchema = z.strictObject({ spaceId: identifier, archiveId, operationId, revision: z.literal(2),
  state: z.literal('primary_erased'), replayed: z.boolean(), primaryRowsRemoved: z.literal(true),
  removedMessages: z.number().int().min(0).max(500), removedSourceBytes: z.number().int().min(0).max(1048576),
  restoreAllowed: z.literal(false), backupCleanup: z.literal('not_confirmed'), physicalMediaCleanup: z.literal('not_confirmed'),
}).refine(value => value.removedMessages !== 0 || value.removedSourceBytes === 0);
const retireReceiptSchema = z.strictObject({ spaceId: identifier, operationId, state: z.literal('retired'), replayed: z.literal(false) });
const revokeReceiptSchema = z.strictObject({ operationId, state: z.literal('revoked'), replayed: z.literal(false) });
const statusResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('archive'), spaceId: identifier, archiveId, revision,
    state: z.enum(['stored', 'primary_erased']),
  }).refine(value => (value.state === 'stored' && value.revision === 1) || (value.state === 'primary_erased' && value.revision === 2)),
  z.strictObject({ kind: z.literal('operation'), spaceId: identifier, operationId, receipt: eraseReceiptSchema.nullable() }),
]);
const invalidResponse = (): never => { throw new SeoulRepositoryError('seoul_response_invalid'); };

export function parseSeoulEraseInput(value: unknown): SeoulEraseInput {
  return Object.freeze(parseSeoulData(seoulEraseInputSchema, value, 'seoul_input_invalid'));
}
export function parseSeoulRetireInput(value: unknown): SeoulRetireInput {
  return Object.freeze(parseSeoulData(seoulRetireInputSchema, value, 'seoul_input_invalid'));
}
export function parseSeoulRevokeSelfInput(value: unknown): SeoulRevokeSelfInput {
  return Object.freeze(parseSeoulData(seoulRevokeSelfInputSchema, value, 'seoul_input_invalid'));
}
export function parseSeoulLifecycleStatusInput(value: unknown): SeoulLifecycleStatusInput {
  return Object.freeze(parseSeoulData(seoulLifecycleStatusInputSchema, value, 'seoul_input_invalid'));
}
export function parseSeoulEraseReceipt(value: unknown, expected: SeoulEraseInput): SeoulEraseReceipt {
  const result = parseSeoulData(eraseReceiptSchema, value, 'seoul_response_invalid');
  if (result.spaceId !== expected.spaceId || result.archiveId !== expected.archiveId || result.operationId !== expected.operationId
    || (expected.expectedRevision === 1 ? result.removedMessages < 1 : result.removedMessages !== 0 || result.removedSourceBytes !== 0)) invalidResponse();
  return Object.freeze(result);
}
export function parseSeoulRetireReceipt(value: unknown, expected: SeoulRetireInput): SeoulRetireReceipt {
  const result = parseSeoulData(retireReceiptSchema, value, 'seoul_response_invalid');
  if (result.spaceId !== expected.spaceId || result.operationId !== expected.operationId) invalidResponse();
  return Object.freeze(result);
}
export function parseSeoulRevokeSelfReceipt(value: unknown, expected: SeoulRevokeSelfInput): SeoulRevokeSelfReceipt {
  const result = parseSeoulData(revokeReceiptSchema, value, 'seoul_response_invalid');
  if (result.operationId !== expected.operationId) invalidResponse();
  return Object.freeze(result);
}
export function parseSeoulLifecycleStatusResult(value: unknown, expected: SeoulLifecycleStatusInput): SeoulLifecycleStatusResult {
  const result = parseSeoulData(statusResultSchema, value, 'seoul_response_invalid');
  if (result.kind !== expected.kind || result.spaceId !== expected.spaceId) invalidResponse();
  if (result.kind === 'archive') {
    if (expected.kind !== 'archive' || result.archiveId !== expected.archiveId) invalidResponse();
  } else {
    if (expected.kind !== 'operation' || result.operationId !== expected.operationId) invalidResponse();
    if (result.receipt) {
      if (result.receipt.spaceId !== expected.spaceId || result.receipt.operationId !== result.operationId) invalidResponse();
      Object.freeze(result.receipt);
    }
  }
  return Object.freeze(result);
}

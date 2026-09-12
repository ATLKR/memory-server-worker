import { z } from 'zod';
import { ingestRoutingInputSchema, searchRoutingInputSchema } from '../../routing/client.ts';
import { resolveSeoulPlacement } from '../../routing/policy.ts';
import { parseSeoulKeywordSearchResult } from '../../routing/capabilities.ts';
import { SeoulRepositoryError } from './types.ts';
import type { SeoulArchiveReceipt, SeoulErrorCode, SeoulIngestInput, SeoulSearchInput, SeoulKeywordSearchResult } from './types.ts';

const utf8 = new TextEncoder();
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const noNul = (text: string) => !text.includes('\0');
export const seoulIngestInputSchema = ingestRoutingInputSchema.extend({ spaceId: identifier })
  .refine(input => input.messages.every(message => noNul(message.content)));
export const seoulSearchInputSchema = searchRoutingInputSchema.extend({
  spaceId: identifier, mode: z.literal('keyword').optional(),
  query: searchRoutingInputSchema.shape.query.refine(noNul),
});
const receiptSchema = z.strictObject({
  spaceId: identifier, operationId: identifier, archiveId: identifier,
  state: z.literal('stored'), extraction: z.literal('none'),
  messageCount: z.number().int().min(1).max(500), sourceBytes: z.number().int().min(0).max(1024 * 1024),
  replayed: z.boolean(),
});
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const envelopeSchema = z.strictObject({
  admission: z.strictObject({ issuedAtMs: epoch, expiresAtMs: epoch })
    .refine(value => value.expiresAtMs > value.issuedAtMs && value.expiresAtMs - value.issuedAtMs <= 30000),
  result: z.unknown(),
});
export type SeoulAdmissionEnvelope = { admission: { issuedAtMs: number; expiresAtMs: number }; result: unknown };
function fail(code: SeoulErrorCode): never { throw new SeoulRepositoryError(code); }

/** Copy only bounded JSON data descriptors. No getters, custom iterators, symbols,
 * hidden fields or caller-owned references can survive an asynchronous boundary. */
function snapshot(input: unknown, code: SeoulErrorCode): unknown {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 16) fail(code);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(code); return value; }
    if (typeof value === 'string') {
      if (!noNul(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail(code);
      bytes += utf8.encode(value).length;
      if (bytes > 2 * 1024 * 1024) fail(code);
      return value;
    }
    if (typeof value !== 'object' || seen.has(value)) fail(code);
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail(code);
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    const out: unknown[] | Record<string, unknown> = array ? [] : {};
    if (array) {
      const length = descriptors.length;
      if (!length || !('value' in length) || length.enumerable || !Number.isInteger(length.value)
        || length.value < 0 || length.value > 10000 || keys.length !== length.value + 1) fail(code);
      for (let index = 0; index < length.value; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(code);
        (out as unknown[]).push(copy(descriptor.value, depth + 1));
      }
    } else {
      for (const key of keys) {
        if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) fail(code);
        bytes += utf8.encode(key).length;
        const descriptor = descriptors[key]!;
        if (!('value' in descriptor) || !descriptor.enumerable) fail(code);
        (out as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
      }
    }
    seen.delete(value);
    return Object.freeze(out);
  }
  try { return copy(input, 0); } catch { fail(code); }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, code: SeoulErrorCode): T {
  const result = schema.safeParse(snapshot(value, code));
  if (!result.success) fail(code);
  return result.data;
}
/** Internal shared boundary for the fixed native lifecycle schemas. */
export { parse as parseSeoulData };
function enforceSeoul(routing: SeoulIngestInput['routing']): void {
  try { resolveSeoulPlacement(routing, [{ route: 'seoul', requiredRegion: 'kr-seoul' }]); }
  catch { fail('seoul_input_invalid'); }
}
export function parseSeoulPatDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('seoul_input_invalid');
  return value;
}
export function parseSeoulIngestInput(value: unknown): SeoulIngestInput {
  const input = parse(seoulIngestInputSchema, value, 'seoul_input_invalid');
  enforceSeoul(input.routing);
  if (utf8.encode(JSON.stringify(input)).length > 2 * 1024 * 1024) fail('seoul_input_invalid');
  return snapshot(input, 'seoul_input_invalid') as SeoulIngestInput;
}
export function parseSeoulSearchInput(value: unknown): SeoulSearchInput & { limit: number; mode: 'keyword' } {
  const input = parse(seoulSearchInputSchema, value, 'seoul_input_invalid');
  enforceSeoul(input.routing);
  return snapshot({ ...input, limit: input.limit ?? 20, mode: 'keyword' }, 'seoul_input_invalid') as SeoulSearchInput & { limit: number; mode: 'keyword' };
}
export function parseSeoulArchiveReceipt(value: unknown, expected: SeoulIngestInput): SeoulArchiveReceipt {
  const receipt = parse(receiptSchema, value, 'seoul_response_invalid');
  const bytes = expected.messages.reduce((sum, message) => sum + utf8.encode(message.content).length, 0);
  if (receipt.spaceId !== expected.spaceId || receipt.operationId !== expected.operationId
    || receipt.messageCount !== expected.messages.length || receipt.sourceBytes !== bytes) fail('seoul_response_invalid');
  return Object.freeze(receipt);
}
export function parseSeoulAdmissionEnvelope(value: unknown): SeoulAdmissionEnvelope {
  return parse(envelopeSchema, value, 'seoul_response_invalid') as SeoulAdmissionEnvelope;
}
export function parseSeoulPatAdmission(value: unknown): void {
  parse(z.strictObject({ authenticated: z.literal(true) }), value, 'seoul_response_invalid');
}
export function parseSeoulSearchResult(value: unknown, expected: SeoulSearchInput): SeoulKeywordSearchResult {
  try {
    const result = parseSeoulKeywordSearchResult(snapshot(value, 'seoul_response_invalid'), expected.spaceId, expected.limit ?? 20);
    if (result.matches.some(match => utf8.encode(match.excerpt).length > 2048)
      || utf8.encode(JSON.stringify(result)).length >= 1024 * 1024) fail('seoul_response_invalid');
    result.matches.forEach(match => Object.freeze(match));
    Object.freeze(result.matches);
    Object.freeze(result);
    return result;
  } catch { fail('seoul_response_invalid'); }
}

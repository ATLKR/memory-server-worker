/** Inert local head-only receipt boundary. A validated receipt proves neither
 * response authentication, source truth, database application nor readiness. */
import { decodeSeoulHeadEvent, encodeSeoulHeadEvent, hashSeoulProjectionTransport } from './seoul-projection-head-codec.ts';
import type { SeoulHead } from './seoul-projection-head-codec.ts';

const MAX_BYTES = 128 * 1024;
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBrand = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
type CurrentHeads = [] | [SeoulHead];
type Disposition =
  | { outcome: 'applied'; reason: 'head_applied' | 'head_already_current'; currentHeads: [SeoulHead] }
  | { outcome: 'head_superseded'; reason: 'newer_head_present'; currentHeads: [SeoulHead] }
  | { outcome: 'conflict'; reason: 'source_identity_conflict'; currentHeads: CurrentHeads };
export type SeoulHeadReceipt = {
  version: 3; kind: 'seoul-projection-receipt'; eventId: string; transportPayloadSha256: string;
  sourceRevision: number; eventKind: 'head'; spaceId: null; snapshotSeq: null; attemptNo: 1;
  leaseExpiresAtMs: null; attemptedAtMs: number;
} & Disposition;

function invalid(): never { throw new Error('seoul_head_receipt_invalid'); }
function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  // Accept real cross-realm/Buffer/subclass byte views without invoking caller
  // getters or iterators; reject proxies and prototype-spoofed wider arrays.
  if (typedArrayBrand.call(value) !== 'Uint8Array') invalid();
  const length = byteLength.call(value) as number;
  if (length === 0 || length > MAX_BYTES) invalid();
  const copy = new Uint8Array(length);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}
function record(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object') invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !expected.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function currentHead(value: unknown): SeoulHead {
  const head = record(value, ['kind', 'key', 'revision', 'eventId', 'payloadSha256']);
  // Reuse the reviewed exact key/opaque subject/source tuple domain. This
  // constructed closed event is internal validation only and is never exposed.
  return decodeSeoulHeadEvent(encodeSeoulHeadEvent({
    version: 3, kind: 'seoul-authority-head', eventId: head.eventId, sourceRevision: head.revision,
    issuer: 'https://auth-api.allen.company', head, effect: { type: 'entity-head', disposition: 'present' },
  })).head;
}
function currentHeads(value: unknown): CurrentHeads {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || length.enumerable || (length.value !== 0 && length.value !== 1)) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length.value + 1 || keys.some(key => key !== 'length' && key !== '0')) invalid();
  if (length.value === 0) return [];
  const item = Object.getOwnPropertyDescriptor(value, '0');
  if (!item || !item.enumerable || !('value' in item)) invalid();
  return [currentHead(item.value)];
}
function disposition(outcome: unknown, reason: unknown, heads: CurrentHeads, sourceRevision: number): Disposition {
  if (outcome === 'applied' && (reason === 'head_applied' || reason === 'head_already_current')) {
    if (heads.length !== 1 || heads[0].revision !== sourceRevision) invalid();
    return { outcome, reason, currentHeads: heads };
  }
  if (outcome === 'head_superseded' && reason === 'newer_head_present') {
    if (heads.length !== 1 || heads[0].revision <= sourceRevision) invalid();
    return { outcome, reason, currentHeads: heads };
  }
  if (outcome === 'conflict' && reason === 'source_identity_conflict') return { outcome, reason, currentHeads: heads };
  invalid();
}
function parse(value: unknown): SeoulHeadReceipt {
  const input = record(value, ['version', 'kind', 'eventId', 'transportPayloadSha256', 'sourceRevision', 'eventKind', 'spaceId', 'snapshotSeq', 'attemptNo', 'outcome', 'reason', 'currentHeads', 'leaseExpiresAtMs', 'attemptedAtMs']);
  if (input.version !== 3 || input.kind !== 'seoul-projection-receipt' || input.eventKind !== 'head'
    || input.spaceId !== null || input.snapshotSeq !== null || input.attemptNo !== 1 || input.leaseExpiresAtMs !== null) invalid();
  const sourceRevision = integer(input.sourceRevision, 1);
  return {
    version: 3, kind: 'seoul-projection-receipt', eventId: uuid(input.eventId), transportPayloadSha256: digest(input.transportPayloadSha256),
    sourceRevision, eventKind: 'head', spaceId: null, snapshotSeq: null, attemptNo: 1,
    ...disposition(input.outcome, input.reason, currentHeads(input.currentHeads), sourceRevision),
    leaseExpiresAtMs: null, attemptedAtMs: integer(input.attemptedAtMs, 0),
  };
}

/** Reconstruct only literal own-data fields in the frozen head SQL wire order. */
export function encodeSeoulHeadReceipt(value: unknown): Uint8Array {
  try {
    const encoded = utf8.encode(JSON.stringify(parse(value)));
    if (encoded.byteLength > MAX_BYTES) invalid();
    return encoded;
  } catch { invalid(); }
}

/** Canonical equality rejects duplicate/escaped-duplicate keys, alternate JSON
 * spellings, order/whitespace changes, BOMs and malformed UTF-8. */
export function decodeSeoulHeadReceipt(bytes: Uint8Array): SeoulHeadReceipt {
  try {
    const input = ownedBytes(bytes), receipt = parse(JSON.parse(strictUtf8.decode(input)));
    const canonical = encodeSeoulHeadReceipt(receipt);
    if (canonical.byteLength !== input.byteLength || canonical.some((byte, index) => byte !== input[index])) invalid();
    return receipt;
  } catch { invalid(); }
}

/** Verify local syntax and exact submitted head-event binding only. This does
 * not authenticate a response or prove SQL applied the observed source/head.
 * Snapshot events/receipts and positive lease/authority results are excluded. */
export async function verifySeoulHeadReceiptForEvent(receiptBytes: Uint8Array, eventBytes: Uint8Array): Promise<SeoulHeadReceipt> {
  try {
    // Own BOTH bounded inputs before the first await, including the one that
    // does not enter the asynchronous committed transport hasher.
    const receiptInput = ownedBytes(receiptBytes), eventInput = ownedBytes(eventBytes);
    const receipt = decodeSeoulHeadReceipt(receiptInput), event = decodeSeoulHeadEvent(eventInput);
    const transportHash = await hashSeoulProjectionTransport(eventInput);
    if (receipt.eventId !== event.eventId || receipt.transportPayloadSha256 !== transportHash || receipt.sourceRevision !== event.sourceRevision) invalid();
    const current = receipt.currentHeads[0], candidate = event.head;
    if (current && (current.kind !== candidate.kind || current.key !== candidate.key)) invalid();
    if (receipt.outcome === 'applied' && (!current || current.revision !== candidate.revision
      || current.eventId !== candidate.eventId || current.payloadSha256 !== candidate.payloadSha256)) invalid();
    if (receipt.outcome === 'head_superseded' && (!current || current.revision <= candidate.revision)) invalid();
    return receipt;
  } catch { throw new Error('seoul_head_receipt_event_mismatch'); }
}

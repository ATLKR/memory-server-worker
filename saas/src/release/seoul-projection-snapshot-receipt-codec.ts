/** Inert snapshot-only receipt boundary. Empty currentHeads is not evidence of
 * missing/current/newer dependencies, complete graph truth, COMMIT or readiness. */
import { decodeSeoulAuthoritySnapshot, type SeoulAuthoritySnapshot } from './seoul-projection-snapshot-codec.ts';
import { hashSeoulProjectionTransport } from './seoul-projection-head-codec.ts';

const RECEIPT_BYTES = 16384, EVENT_BYTES = 131072;
const utf8 = new TextEncoder(), strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const byteBrand = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
type AppliedReason = 'snapshot_applied' | 'empty_snapshot_applied';
type PendingReason = 'dependency_head_missing' | 'dependency_head_behind' | 'provisioning_missing' | 'retained_row_disposition_missing';
type SupersededReason = 'newer_snapshot_present' | 'newer_dependency_present' | 'terminal_identity_denied' | 'lifecycle_denied' | 'target_deselected' | 'lease_expired' | 'lease_issued_in_future' | 'authority_expired';
type ConflictReason = 'snapshot_sequence_conflict' | 'source_identity_conflict' | 'immutable_entity_conflict' | 'provisioning_conflict' | 'retained_row_disposition_conflict';
type Pair = { outcome: 'applied'; reason: AppliedReason } | { outcome: 'dependency_pending'; reason: PendingReason }
  | { outcome: 'snapshot_superseded'; reason: SupersededReason } | { outcome: 'conflict'; reason: ConflictReason };
export type SeoulSnapshotReceipt = {
  version: 3; kind: 'seoul-projection-receipt'; eventId: string; transportPayloadSha256: string;
  sourceRevision: number; eventKind: 'snapshot'; spaceId: string; snapshotSeq: number; attemptNo: number;
  /** Always empty, independent of grants/mappings; never a dependency witness. */
  currentHeads: []; attemptedAtMs: number;
} & ((Extract<Pair, { outcome: 'applied' }> & { leaseExpiresAtMs: number })
  | (Exclude<Pair, { outcome: 'applied' }> & { leaseExpiresAtMs: null }));

function invalid(): never { throw new Error('seoul_snapshot_receipt_invalid'); }
function ownedBytes(value: Uint8Array, maximum: number): Uint8Array<ArrayBuffer> {
  // Internal storage accepts Buffer/subclasses/cross-realm Uint8Arrays while
  // ignoring caller methods/getters. Proxies and spoofed wider brands fail.
  if (byteBrand.call(value) !== 'Uint8Array') invalid();
  const length = byteLength.call(value) as number;
  if (!length || length > maximum) invalid();
  const owned = new Uint8Array(length); Uint8Array.prototype.set.call(owned, value); return owned;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') invalid();
  const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) invalid();
  const expected = ['version', 'kind', 'eventId', 'transportPayloadSha256', 'sourceRevision', 'eventKind', 'spaceId', 'snapshotSeq', 'attemptNo', 'outcome', 'reason', 'currentHeads', 'leaseExpiresAtMs', 'attemptedAtMs'];
  const keys = Reflect.ownKeys(value); if (keys.length !== expected.length) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !expected.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid(); result[key] = descriptor.value;
  }
  return result;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) invalid(); return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid(); return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value;
}
function spaceId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) invalid(); return value;
}
function emptyHeads(value: unknown): [] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || length.enumerable || length.value !== 0) invalid();
  const keys = Reflect.ownKeys(value); if (keys.length !== 1 || keys[0] !== 'length') invalid(); return [];
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(); return value as T;
}
function pair(outcome: unknown, reason: unknown): Pair {
  switch (outcome) {
    case 'applied': return { outcome, reason: choice(reason, ['snapshot_applied', 'empty_snapshot_applied']) };
    case 'dependency_pending': return { outcome, reason: choice(reason, ['dependency_head_missing', 'dependency_head_behind', 'provisioning_missing', 'retained_row_disposition_missing']) };
    case 'snapshot_superseded': return { outcome, reason: choice(reason, ['newer_snapshot_present', 'newer_dependency_present', 'terminal_identity_denied', 'lifecycle_denied', 'target_deselected', 'lease_expired', 'lease_issued_in_future', 'authority_expired']) };
    case 'conflict': return { outcome, reason: choice(reason, ['snapshot_sequence_conflict', 'source_identity_conflict', 'immutable_entity_conflict', 'provisioning_conflict', 'retained_row_disposition_conflict']) };
    default: invalid();
  }
}
function parse(value: unknown): SeoulSnapshotReceipt {
  const x = record(value);
  if (x.version !== 3 || x.kind !== 'seoul-projection-receipt' || x.eventKind !== 'snapshot') invalid();
  const base = { version: 3 as const, kind: 'seoul-projection-receipt' as const, eventId: uuid(x.eventId), transportPayloadSha256: digest(x.transportPayloadSha256),
    sourceRevision: integer(x.sourceRevision, 1), eventKind: 'snapshot' as const, spaceId: spaceId(x.spaceId), snapshotSeq: integer(x.snapshotSeq, 1), attemptNo: integer(x.attemptNo, 1) };
  const disposition = pair(x.outcome, x.reason), currentHeads = emptyHeads(x.currentHeads), attemptedAtMs = integer(x.attemptedAtMs, 0);
  if (disposition.outcome === 'applied') return { ...base, ...disposition, currentHeads, leaseExpiresAtMs: integer(x.leaseExpiresAtMs, 0), attemptedAtMs };
  if (x.leaseExpiresAtMs !== null) invalid();
  return { ...base, ...disposition, currentHeads, leaseExpiresAtMs: null, attemptedAtMs };
}

/** Structural only. Closed ASCII scalar fields, five <=16-digit numbers and
 * literal [] have a maximum below 1024 bytes before serialization. Arbitrary
 * input objects/arrays are never stringified to discover their encoded size. */
export function encodeSeoulSnapshotReceipt(value: unknown): Uint8Array {
  try { const bytes = utf8.encode(JSON.stringify(parse(value))); if (bytes.length > RECEIPT_BYTES) invalid(); return bytes; }
  catch { invalid(); }
}
/** Exact canonical receipt bytes only, independently bounded at 16 KiB. */
export function decodeSeoulSnapshotReceipt(value: Uint8Array): SeoulSnapshotReceipt {
  try {
    const input = ownedBytes(value, RECEIPT_BYTES), receipt = parse(JSON.parse(strictUtf8.decode(input))), canonical = encodeSeoulSnapshotReceipt(receipt);
    if (input.length !== canonical.length || input.some((byte, index) => byte !== canonical[index])) invalid(); return receipt;
  } catch { invalid(); }
}
function submittedSemantics(receipt: SeoulSnapshotReceipt, event: SeoulAuthoritySnapshot): void {
  const decision = receipt.attemptedAtMs, { issuedAtMs, expiresAtMs } = event.lease;
  // Both operands are nonnegative safe integers: differences remain bounded.
  // Do not compute decision+5000 near Number.MAX_SAFE_INTEGER.
  const expired = decision >= expiresAtMs, future = issuedAtMs > decision && issuedAtMs - decision > 5000;
  const liveClock = !expired && !future, positive = event.grants.length > 0;
  const allGrantsLive = event.grants.every(grant => grant.expiresAtMs > decision);
  const livePositive = event.selected && positive && liveClock && allGrantsLive;
  switch (receipt.reason) {
    case 'snapshot_applied':
      if (!livePositive || receipt.leaseExpiresAtMs !== expiresAtMs) invalid(); return;
    case 'empty_snapshot_applied':
      if (positive || !liveClock || receipt.leaseExpiresAtMs !== expiresAtMs) invalid(); return;
    case 'lease_expired': if (!expired) invalid(); return;
    case 'lease_issued_in_future': if (expired || !future) invalid(); return;
    case 'authority_expired': if (!positive || !liveClock || allGrantsLive) invalid(); return;
    // These observations precede the clock stage. The bytes cannot prove an
    // actual sequence reservation/newer sequence/source-history conflict.
    case 'source_identity_conflict': if (!positive) invalid(); return;
    case 'snapshot_sequence_conflict': case 'newer_snapshot_present': return;
    case 'dependency_head_missing': case 'dependency_head_behind': case 'provisioning_missing': case 'retained_row_disposition_missing':
    case 'newer_dependency_present': case 'terminal_identity_denied': case 'lifecycle_denied': case 'target_deselected':
    case 'immutable_entity_conflict': case 'provisioning_conflict': case 'retained_row_disposition_conflict':
      if (!livePositive) invalid(); return;
    default: invalid();
  }
}

/** Verify original canonical event binding and submitted-data implications.
 * Both views are owned before the first await. This authenticates no response
 * channel and proves no regional observation, COMMIT, currentness or readiness.
 * Attempt monotonicity/terminal-once require an external history ledger; stored
 * decision time, not current wall clock, governs this historical receipt. */
export async function verifySeoulSnapshotReceiptForEvent(receiptBytes: Uint8Array, eventBytes: Uint8Array): Promise<SeoulSnapshotReceipt> {
  try {
    const receiptInput = ownedBytes(receiptBytes, RECEIPT_BYTES), eventInput = ownedBytes(eventBytes, EVENT_BYTES);
    const receipt = decodeSeoulSnapshotReceipt(receiptInput), event = decodeSeoulAuthoritySnapshot(eventInput);
    const transportHash = await hashSeoulProjectionTransport(eventInput);
    if (receipt.eventId !== event.eventId || receipt.transportPayloadSha256 !== transportHash || receipt.sourceRevision !== event.sourceRevision
      || receipt.spaceId !== event.spaceId || receipt.snapshotSeq !== event.snapshotSeq) invalid();
    submittedSemantics(receipt, event); return receipt;
  } catch { throw new Error('seoul_snapshot_receipt_event_mismatch'); }
}

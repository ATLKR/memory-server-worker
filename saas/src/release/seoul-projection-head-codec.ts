/** Inert v3 wire boundary. Validation/serialization does not apply authority,
 * prepare source rows, authenticate transport or evaluate regional tombstones. */
const ISSUER = 'https://auth-api.allen.company';
const MAX_BYTES = 128 * 1024;
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBrand = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const streamKinds = ['subject', 'email', 'organization', 'membership', 'credential', 'space', 'target'] as const;

export type SeoulHeadKind = typeof streamKinds[number];
export type SeoulEntityHeadKind = Exclude<SeoulHeadKind, 'subject' | 'email'>;
export type SeoulHead = {
  kind: SeoulHeadKind;
  key: string;
  revision: number;
  /** Immutable source event identity, independent of the outer transport ID. */
  eventId: string;
  /** Finalized source-change SHA-256; never the digest of this envelope. */
  payloadSha256: string;
};
export type SeoulHeadEffect =
  | { type: 'subject-lifecycle'; subject: string; state: 'suspended' | 'resumed' | 'deleted'; occurredAtMs: number }
  | { type: 'email-lifecycle'; subject: string; address: string; state: 'verified' | 'revoked'; occurredAtMs: number }
  | { type: 'entity-negative'; entityKind: 'organization' | 'space'; entityId: string; state: 'disabled'; occurredAtMs: number }
  | { type: 'entity-negative'; entityKind: 'membership' | 'credential'; entityId: string; state: 'revoked'; occurredAtMs: number }
  | { type: 'entity-negative'; entityKind: 'target'; entityId: string; state: 'removed'; occurredAtMs: number }
  | { type: 'entity-head'; disposition: 'present' | 'changed' };
export type SeoulHeadEvent = {
  version: 3;
  kind: 'seoul-authority-head';
  eventId: string;
  sourceRevision: number;
  issuer: typeof ISSUER;
  head: SeoulHead;
  effect: SeoulHeadEffect;
};

function invalid(): never { throw new Error('seoul_head_event_invalid'); }

/** Read descriptors before values so input getters/toJSON never run. A fixed
 * maximum key count also bounds traversal of all three permitted records. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 7) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid();
}
function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    || utf8.encode(value).length > maximum) invalid();
  return value;
}
function subject(value: unknown): string {
  // Match Workspace's opaque 512-code-unit domain; the complete key has a
  // separate UTF-8 bound. Do not normalize or strip embedded control text.
  if (typeof value !== 'string' || value.length > 512 || !value.trim() || value.includes('\0')
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid();
  return value;
}
function identifier(value: unknown): string {
  const result = boundedString(value, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) invalid();
  return result;
}
/** Same ASCII, case-insensitive mailbox policy as identity.canonicalEmail;
 * this boundary requires already-canonical bytes and never rewrites identity. */
function address(value: unknown): string {
  const result = boundedString(value, 254);
  if (result !== result.trim().toLowerCase()) invalid();
  const parts = result.split('@'), local = parts[0] ?? '', domain = parts[1] ?? '';
  if (parts.length !== 2 || local.length > 64
    || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || domain.length > 253 || !domain.includes('.')
    || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid();
  return result;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid();
  return value;
}
function sourceDigest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function streamKey(kind: SeoulHeadKind, value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || utf8.encode(value).length > 2048) invalid();
  if (kind !== 'subject' && kind !== 'email') return identifier(value);
  const prefix = ISSUER + '\n';
  if (!value.startsWith(prefix)) invalid();
  const remainder = value.slice(prefix.length);
  if (kind === 'subject') subject(remainder);
  else {
    // Canonical email forbids newline; its final separator is unambiguous
    // even when the opaque subject contains (or ends with) newlines.
    const separator = remainder.lastIndexOf('\n');
    if (separator < 0) invalid();
    subject(remainder.slice(0, separator));
    address(remainder.slice(separator + 1));
  }
  return value;
}
function head(value: unknown): SeoulHead {
  const input = record(value);
  exact(input, ['kind', 'key', 'revision', 'eventId', 'payloadSha256']);
  if (!streamKinds.includes(input.kind as SeoulHeadKind)) invalid();
  const kind = input.kind as SeoulHeadKind;
  return { kind, key: streamKey(kind, input.key), revision: integer(input.revision, 1), eventId: uuid(input.eventId), payloadSha256: sourceDigest(input.payloadSha256) };
}
function effect(value: unknown, source: SeoulHead): SeoulHeadEffect {
  const input = record(value);
  switch (input.type) {
    case 'entity-head': {
      exact(input, ['type', 'disposition']);
      if (input.disposition !== 'present' && input.disposition !== 'changed') invalid();
      return { type: 'entity-head', disposition: input.disposition };
    }
    case 'subject-lifecycle': {
      exact(input, ['type', 'subject', 'state', 'occurredAtMs']);
      const identity = subject(input.subject);
      if (source.kind !== 'subject' || source.key !== ISSUER + '\n' + identity
        || (input.state !== 'suspended' && input.state !== 'resumed' && input.state !== 'deleted')) invalid();
      return { type: 'subject-lifecycle', subject: identity, state: input.state, occurredAtMs: integer(input.occurredAtMs, 0) };
    }
    case 'email-lifecycle': {
      exact(input, ['type', 'subject', 'address', 'state', 'occurredAtMs']);
      const identity = subject(input.subject), email = address(input.address);
      if (source.kind !== 'email' || source.key !== ISSUER + '\n' + identity + '\n' + email
        || (input.state !== 'verified' && input.state !== 'revoked')) invalid();
      return { type: 'email-lifecycle', subject: identity, address: email, state: input.state, occurredAtMs: integer(input.occurredAtMs, 0) };
    }
    case 'entity-negative': {
      exact(input, ['type', 'entityKind', 'entityId', 'state', 'occurredAtMs']);
      const entityId = identifier(input.entityId), occurredAtMs = integer(input.occurredAtMs, 0);
      if (input.entityKind !== source.kind || entityId !== source.key) invalid();
      if ((input.entityKind === 'organization' || input.entityKind === 'space') && input.state === 'disabled') {
        return { type: 'entity-negative', entityKind: input.entityKind, entityId, state: 'disabled', occurredAtMs };
      }
      if ((input.entityKind === 'membership' || input.entityKind === 'credential') && input.state === 'revoked') {
        return { type: 'entity-negative', entityKind: input.entityKind, entityId, state: 'revoked', occurredAtMs };
      }
      if (input.entityKind === 'target' && input.state === 'removed') {
        return { type: 'entity-negative', entityKind: 'target', entityId, state: 'removed', occurredAtMs };
      }
      invalid();
    }
    default: invalid();
  }
}
function parse(value: unknown): SeoulHeadEvent {
  const input = record(value);
  exact(input, ['version', 'kind', 'eventId', 'sourceRevision', 'issuer', 'head', 'effect']);
  if (input.version !== 3 || input.kind !== 'seoul-authority-head' || input.issuer !== ISSUER) invalid();
  const source = head(input.head), sourceRevision = integer(input.sourceRevision, 1);
  if (source.revision !== sourceRevision) invalid();
  return {
    version: 3, kind: 'seoul-authority-head', eventId: uuid(input.eventId), sourceRevision, issuer: ISSUER,
    head: source, effect: effect(input.effect, source),
  };
}
function transportBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  // Check internal storage, not a spoofable prototype or caller toStringTag.
  // Genuine cross-realm Uint8Arrays, Buffer and subclasses retain this brand;
  // proxies, DataViews and every other typed-array brand are rejected.
  if (typedArrayBrand.call(bytes) !== 'Uint8Array') throw new Error();
  // Read the internal typed-array length, never a caller's shadowing getter.
  const length = byteLength.call(bytes) as number;
  if (length > MAX_BYTES) throw new Error();
  const copy = new Uint8Array(length);
  Uint8Array.prototype.set.call(copy, bytes);
  return copy;
}

/** Reconstruct each closed record in wire key order; never stringify input. */
export function encodeSeoulHeadEvent(value: unknown): Uint8Array {
  try {
    const bytes = utf8.encode(JSON.stringify(parse(value)));
    if (bytes.byteLength > MAX_BYTES) invalid();
    return bytes;
  } catch { invalid(); }
}

/** Exact byte equality rejects duplicate keys (including escaped duplicates),
 * whitespace, alternate number/string escapes, BOMs and reordered fields. */
export function decodeSeoulHeadEvent(bytes: Uint8Array): SeoulHeadEvent {
  try {
    const input = transportBytes(bytes);
    if (input.byteLength === 0) invalid();
    const value = parse(JSON.parse(strictUtf8.decode(input)));
    const canonical = encodeSeoulHeadEvent(value);
    if (canonical.byteLength !== input.byteLength || canonical.some((byte, index) => byte !== input[index])) invalid();
    return value;
  } catch { invalid(); }
}

/** Hash exact transport bytes, including an empty GET body. Does not parse,
 * normalize or replace a source digest. Callers must persist these same bytes. */
export async function hashSeoulProjectionTransport(bytes: Uint8Array): Promise<string> {
  try {
    // Own the selected view before awaiting Web Crypto; include no prefix/suffix.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', transportBytes(bytes)));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { throw new Error('seoul_transport_bytes_invalid'); }
}

import { encodeSeoulHeadEvent, hashSeoulProjectionTransport, type SeoulHeadEffect } from './seoul-projection-head-codec.ts';

/** Pure immutable-source boundary. A valid captured vector does not prove its
 * completeness in D1, current authority, grant eligibility or transport auth. */
const ISSUER = 'https://auth-api.allen.company';
const BODY_BYTES = 128 * 1024, CORE_BYTES = 144 * 1024;
// This source contract covers the implemented 512-key capture scope. Marker
// countLowerBound's 2049 overflow sentinel is not an identity-vector allowance.
const MAX_IDENTITIES = 512;
const utf8 = new TextEncoder(), strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const byteBrand = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const INVALID = Symbol(), UNSUPPORTED = Symbol();
const commands = ['scoped-key-issue', 'self-email-unlink', 'workspace-sign-in', 'organization-create', 'organization-child-create'] as const;
const streamKinds = ['subject', 'email', 'credential', 'membership', 'organization', 'space'] as const;
type StreamKind = typeof streamKinds[number];
type Command = typeof commands[number];
type Origin = { kind: 'command'; commandType: Command; receiptId: string | null };
type Lifecycle = { state: 'absent' } | { state: 'event'; eventId: string; sequence: number; kind: 'account.suspended' | 'account.resumed' | 'account.deleted' | 'email.verified' | 'email.revoked'; occurredAtMs: number };
type Descriptors = { origin: Origin; effect: SeoulHeadEffect };
type ProviderIdentity = { issuer: typeof ISSUER; subject: string; accountId: string; createdAtMs: number };
type Capability = 'create' | 'delete' | 'export' | 'read' | 'update';
type Credential = { version: 3; kind: 'credential-source'; id: string; accountId: string; credentialKind: 'personal_key' | 'api_key'; tokenDigest: string; membershipId: string | null; emailId: string | null; permission: 'read' | 'write'; expiresAtMs: number; revokedAtMs: number | null; policy: { capabilities: Capability[]; spaceIds: string[] | null } | null } & Descriptors;
type Membership = { version: 3; kind: 'membership-source'; id: string; organizationId: string; accountId: string; emailId: string; role: 'owner' | 'admin' | 'member'; expiresAtMs: number; revokedAtMs: number | null } & Descriptors;
type Email = { version: 3; kind: 'email-source'; issuer: typeof ISSUER; subject: string; address: string; accountId: string; liveClaim: { id: string; verifiedAtMs: number } | null; changedClaim: { id: string; verifiedAtMs: number; revokedAtMs: number } | null; addressBlocked: boolean; legacyRevoked: boolean; lifecycle: Lifecycle } & Descriptors;
type Subject = { version: 3; kind: 'subject-source'; issuer: typeof ISSUER; subject: string; accountId: string; accountDisabledAtMs: number | null; providerIdentities: ProviderIdentity[]; lifecycle: Lifecycle; legacyDisabled: boolean } & Descriptors;
type Organization = { version: 3; kind: 'organization-source'; id: string; disabledAtMs: number | null } & Descriptors;
type Space = { version: 3; kind: 'space-source'; id: string; accountId: string | null; organizationId: string | null; securityMode: 'managed'; createdAtMs: number } & Descriptors;
type Marker = { version: 3; kind: 'subject-source-unrepresentable'; issuer: typeof ISSUER; subject: string; accountId: string; reason: 'unmapped' | 'unsupported-mapping' | 'identity-count' | 'identity-bytes' | 'fanout-count' | 'source-bytes' | 'unsupported-state'; countLowerBound: number; byteEstimate: number; captureAttemptId: string };
export type SeoulAuthoritySourceBody = Credential | Membership | Email | Subject | Organization | Space | Marker;
export type SeoulAuthoritySource = {
  version: 3; kind: 'seoul-authority-source'; revision: number; sourceCommandId: string;
  streamKind: StreamKind; streamKey: string; eventId: string; createdAtMs: number; body: SeoulAuthoritySourceBody;
};
/** Exactly the immutable columns; record_bytes is the original canonical JSON
 * TEXT, never a digest, normalized replacement or caller-supplied effect. */
export type SeoulAuthoritySourceRow = {
  revision: number; source_command_id: string; stream_kind: StreamKind; stream_key: string;
  event_id: string; record_bytes: string; created_at: number;
};
export type SeoulHeadCandidate = {
  readonly rowGuard: Readonly<SeoulAuthoritySourceRow>;
  readonly sourceCoreBytes: Uint8Array;
  readonly sourceChangeSha256: string;
  readonly eventBytes: Uint8Array;
  readonly eventText: string;
  readonly transportPayloadSha256: string;
};

function invalid(): never { throw INVALID; }
function unsupported(): never { throw UNSUPPORTED; }
function failure(error: unknown): never { throw new Error(error === UNSUPPORTED ? 'seoul_authority_source_contract_unsupported' : 'seoul_authority_source_invalid'); }
function boundary<T>(action: () => T): T { try { return action(); } catch (error) { return failure(error); } }
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) invalid();
  return value;
}
function literal<T extends string | number>(value: unknown, expected: T): T { if (value !== expected) invalid(); return expected; }
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(); return value as T;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value); }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function identifier(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) invalid(); return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid(); return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value;
}
function subject(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !value.trim() || value.includes('\0')
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid(); return value;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || value !== value.trim().toLowerCase()) invalid();
  const parts = value.split('@'), local = parts[0] ?? '', domain = parts[1] ?? '';
  if (parts.length !== 2 || local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.length > 253 || !domain.includes('.')
    || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid(); return value;
}
function streamKey(kind: StreamKind, value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || utf8.encode(value).length > 2048) invalid();
  if (kind !== 'subject' && kind !== 'email') return identifier(value, kind === 'space' ? 128 : 256);
  const prefix = ISSUER + '\n'; if (!value.startsWith(prefix)) invalid();
  const remainder = value.slice(prefix.length);
  if (kind === 'subject') subject(remainder);
  else { const separator = remainder.lastIndexOf('\n'); if (separator < 0) invalid(); subject(remainder.slice(0, separator)); address(remainder.slice(separator + 1)); }
  return value;
}

/** Incremental exact JSON UTF-8 accounting before any JSON.stringify or encode.
 * Raw strings are bounded first; no giant escaped intermediate is allocated. */
function jsonStringSize(value: string): number {
  if (value.length > CORE_BYTES) invalid();
  let size = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) size += 2;
    else if (code < 32) size += 6;
    else if (code < 128) size++;
    else if (code < 2048) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(); size += 4;
    } else { if (code >= 0xdc00 && code <= 0xdfff) invalid(); size += 3; }
    if (size > CORE_BYTES) invalid();
  }
  return size;
}
function ownRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value); if (keys.length > 16) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > 32) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid(); result[key] = descriptor.value;
  }
  return result;
}
function ownData(value: unknown, budget = { remaining: CORE_BYTES, nodes: 16000 }, depth = 0): unknown {
  if (--budget.nodes < 0 || depth > 8) invalid();
  const charge = (amount: number) => { budget.remaining -= amount; if (budget.remaining < 0) invalid(); };
  if (value === null || typeof value === 'boolean') { charge(value === null ? 4 : value ? 4 : 5); return value; }
  if (typeof value === 'number') { integer(value); charge(String(value).length); return value; }
  if (typeof value === 'string') { charge(jsonStringSize(value)); return value; }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor)) invalid();
    const length = integer(lengthDescriptor.value); if (length > MAX_IDENTITIES) invalid();
    if (Reflect.ownKeys(value).length !== length + 1) invalid();
    charge(2 + Math.max(0, length - 1));
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
      result.push(ownData(descriptor.value, budget, depth + 1));
    }
    return result;
  }
  const input = ownRecord(value), keys = Object.keys(input), result: Record<string, unknown> = Object.create(null);
  charge(2 + Math.max(0, keys.length - 1));
  for (const key of keys) { charge(jsonStringSize(key) + 1); result[key] = ownData(input[key], budget, depth + 1); }
  return result;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>, actual = Object.keys(input);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid(); return input;
}
function list<T>(value: unknown, parse: (value: unknown) => T, maximum: number): T[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum) invalid(); return value.map(parse);
}
function sorted<T>(values: T[], compare: (a: T, b: T) => number): T[] {
  for (let index = 1; index < values.length; index++) if (compare(values[index - 1]!, values[index]!) >= 0) invalid(); return values;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function lifecycle(value: unknown, email: boolean): Lifecycle {
  const input = value as Record<string, unknown>;
  if (input?.state === 'absent') { record(value, ['state']); return { state: 'absent' }; }
  const x = record(value, ['state', 'eventId', 'sequence', 'kind', 'occurredAtMs']);
  return { state: literal(x.state, 'event'), eventId: identifier(x.eventId), sequence: integer(x.sequence, 1),
    kind: choice(x.kind, email ? ['email.verified', 'email.revoked'] : ['account.suspended', 'account.resumed', 'account.deleted']), occurredAtMs: integer(x.occurredAtMs) };
}
function origin(value: unknown): Origin {
  const input = value as Record<string, unknown>;
  if (input?.kind !== 'command') unsupported();
  const x = record(value, ['kind', 'commandType', 'receiptId']);
  if (!commands.includes(x.commandType as Command)) unsupported();
  const commandType = x.commandType as Command, receiptId = nullable(x.receiptId, identifier);
  if ((commandType === 'scoped-key-issue') !== (receiptId === null)) invalid();
  return { kind: 'command', commandType, receiptId };
}
function effect(value: unknown, kind: StreamKind, key: string, command: Command, revokedAtMs: number | null): SeoulHeadEffect {
  if (command === 'self-email-unlink' && (kind === 'credential' || kind === 'membership')) {
    const x = record(value, ['type', 'entityKind', 'entityId', 'state', 'occurredAtMs']);
    if (revokedAtMs === null || x.occurredAtMs !== revokedAtMs) invalid();
    return { type: literal(x.type, 'entity-negative'), entityKind: literal(x.entityKind, kind), entityId: literal(x.entityId, key), state: literal(x.state, 'revoked'), occurredAtMs: integer(x.occurredAtMs) };
  }
  const x = record(value, ['type', 'disposition']);
  return { type: literal(x.type, 'entity-head'), disposition: literal(x.disposition, kind === 'subject' || kind === 'email' ? 'changed' : 'present') };
}

function body(value: unknown, kind: StreamKind, key: string, commandId: string): SeoulAuthoritySourceBody {
  const x = value as Record<string, unknown>;
  if (!x || typeof x !== 'object' || Array.isArray(x)) invalid();
  literal(x.version, 3);
  if (x.kind === 'subject-source-unrepresentable') {
    record(x, ['version', 'kind', 'issuer', 'subject', 'accountId', 'reason', 'countLowerBound', 'byteEstimate', 'captureAttemptId']);
    const identity = subject(x.subject), countLowerBound = integer(x.countLowerBound);
    if (kind !== 'subject' || key !== ISSUER + '\n' + identity || countLowerBound > 2049 || x.captureAttemptId !== commandId) invalid();
    return { version: 3, kind: 'subject-source-unrepresentable', issuer: literal(x.issuer, ISSUER), subject: identity, accountId: identifier(x.accountId),
      reason: choice(x.reason, ['unmapped', 'unsupported-mapping', 'identity-count', 'identity-bytes', 'fanout-count', 'source-bytes', 'unsupported-state']), countLowerBound,
      byteEstimate: integer(x.byteEstimate), captureAttemptId: uuid(x.captureAttemptId) };
  }
  if (!['credential-source', 'membership-source', 'email-source', 'subject-source', 'organization-source', 'space-source'].includes(x.kind as string)) unsupported();
  if (!Object.hasOwn(x, 'origin') || !Object.hasOwn(x, 'effect')) unsupported();
  if (x.kind !== kind + '-source') invalid();
  const capturedOrigin = origin(x.origin), command = capturedOrigin.commandType;
  const matrix: Record<StreamKind, readonly Command[]> = {
    credential: ['scoped-key-issue', 'self-email-unlink'], membership: ['self-email-unlink', 'organization-create', 'organization-child-create'],
    subject: ['workspace-sign-in'], email: ['workspace-sign-in', 'self-email-unlink'], organization: ['organization-create', 'organization-child-create'],
    space: ['workspace-sign-in', 'organization-create', 'organization-child-create'],
  };
  if (!matrix[kind].includes(command)) invalid();
  const descriptors = (revokedAtMs: number | null = null): Descriptors => ({ origin: capturedOrigin, effect: effect(x.effect, kind, key, command, revokedAtMs) });
  const id = () => { const result = identifier(x.id, kind === 'space' ? 128 : 256); if (result !== key) invalid(); return result; };
  switch (kind) {
    case 'credential': {
      record(x, ['version', 'kind', 'id', 'accountId', 'credentialKind', 'tokenDigest', 'membershipId', 'emailId', 'permission', 'expiresAtMs', 'revokedAtMs', 'policy', 'origin', 'effect']);
      const credentialKind = choice(x.credentialKind, ['personal_key', 'api_key']), membershipId = nullable(x.membershipId, identifier), emailId = nullable(x.emailId, identifier), revokedAtMs = nullable(x.revokedAtMs, integer);
      if (credentialKind === 'personal_key' ? membershipId !== null || emailId !== null : membershipId === null || emailId === null) invalid();
      if (command === 'scoped-key-issue' ? revokedAtMs !== null : credentialKind !== 'api_key' || revokedAtMs === null) invalid();
      const policy = nullable(x.policy, value => {
        const p = record(value, ['capabilities', 'spaceIds']);
        return { capabilities: sorted(list(p.capabilities, value => choice<Capability>(value, ['create', 'delete', 'export', 'read', 'update']), 5), compare),
          spaceIds: nullable(p.spaceIds, value => sorted(list(value, value => identifier(value, 128), 50), compare)) };
      });
      return { version: 3, kind: 'credential-source', id: id(), accountId: identifier(x.accountId), credentialKind, tokenDigest: digest(x.tokenDigest), membershipId, emailId,
        permission: choice(x.permission, ['read', 'write']), expiresAtMs: integer(x.expiresAtMs), revokedAtMs, policy, ...descriptors(revokedAtMs) };
    }
    case 'membership': {
      record(x, ['version', 'kind', 'id', 'organizationId', 'accountId', 'emailId', 'role', 'expiresAtMs', 'revokedAtMs', 'origin', 'effect']);
      const revokedAtMs = nullable(x.revokedAtMs, integer); if ((command === 'self-email-unlink') !== (revokedAtMs !== null)) invalid();
      return { version: 3, kind: 'membership-source', id: id(), organizationId: identifier(x.organizationId), accountId: identifier(x.accountId), emailId: identifier(x.emailId),
        role: choice(x.role, ['owner', 'admin', 'member']), expiresAtMs: integer(x.expiresAtMs), revokedAtMs, ...descriptors(revokedAtMs) };
    }
    case 'email': {
      record(x, ['version', 'kind', 'issuer', 'subject', 'address', 'accountId', 'liveClaim', 'changedClaim', 'addressBlocked', 'legacyRevoked', 'lifecycle', 'origin', 'effect']);
      const identity = subject(x.subject), mailbox = address(x.address); if (key !== ISSUER + '\n' + identity + '\n' + mailbox) invalid();
      const liveClaim = nullable(x.liveClaim, value => { const c = record(value, ['id', 'verifiedAtMs']); return { id: identifier(c.id), verifiedAtMs: integer(c.verifiedAtMs) }; });
      const changedClaim = nullable(x.changedClaim, value => { const c = record(value, ['id', 'verifiedAtMs', 'revokedAtMs']); return { id: identifier(c.id), verifiedAtMs: integer(c.verifiedAtMs), revokedAtMs: integer(c.revokedAtMs) }; });
      if (command === 'self-email-unlink' ? liveClaim !== null || changedClaim === null : liveClaim === null || changedClaim !== null) invalid();
      return { version: 3, kind: 'email-source', issuer: literal(x.issuer, ISSUER), subject: identity, address: mailbox, accountId: identifier(x.accountId), liveClaim, changedClaim,
        addressBlocked: bool(x.addressBlocked), legacyRevoked: bool(x.legacyRevoked), lifecycle: lifecycle(x.lifecycle, true), ...descriptors() };
    }
    case 'subject': {
      record(x, ['version', 'kind', 'issuer', 'subject', 'accountId', 'accountDisabledAtMs', 'providerIdentities', 'lifecycle', 'legacyDisabled', 'origin', 'effect']);
      const identity = subject(x.subject), accountId = identifier(x.accountId); if (key !== ISSUER + '\n' + identity) invalid();
      const providerIdentities = sorted(list(x.providerIdentities, value => {
        const p = record(value, ['issuer', 'subject', 'accountId', 'createdAtMs']);
        if (p.accountId !== accountId) invalid();
        return { issuer: literal(p.issuer, ISSUER), subject: subject(p.subject), accountId, createdAtMs: integer(p.createdAtMs) };
      }, MAX_IDENTITIES), (a, b) => compare(a.issuer, b.issuer) || compare(a.subject, b.subject) || compare(a.accountId, b.accountId));
      if (!providerIdentities.some(p => p.subject === identity)) invalid();
      return { version: 3, kind: 'subject-source', issuer: literal(x.issuer, ISSUER), subject: identity, accountId, accountDisabledAtMs: nullable(x.accountDisabledAtMs, integer), providerIdentities,
        lifecycle: lifecycle(x.lifecycle, false), legacyDisabled: bool(x.legacyDisabled), ...descriptors() };
    }
    case 'organization': {
      record(x, ['version', 'kind', 'id', 'disabledAtMs', 'origin', 'effect']);
      if (x.disabledAtMs !== null) invalid();
      return { version: 3, kind: 'organization-source', id: id(), disabledAtMs: null, ...descriptors() };
    }
    case 'space': {
      record(x, ['version', 'kind', 'id', 'accountId', 'organizationId', 'securityMode', 'createdAtMs', 'origin', 'effect']);
      const accountId = nullable(x.accountId, identifier), organizationId = nullable(x.organizationId, identifier);
      if (command === 'workspace-sign-in' ? accountId === null || organizationId !== null : accountId !== null || organizationId === null) invalid();
      return { version: 3, kind: 'space-source', id: id(), accountId, organizationId, securityMode: literal(x.securityMode, 'managed'), createdAtMs: integer(x.createdAtMs), ...descriptors() };
    }
  }
}
function parse(value: unknown): SeoulAuthoritySource {
  const x = record(ownData(value), ['version', 'kind', 'revision', 'sourceCommandId', 'streamKind', 'streamKey', 'eventId', 'createdAtMs', 'body']);
  if (x.streamKind === 'target') unsupported();
  const streamKind = choice(x.streamKind, streamKinds), key = streamKey(streamKind, x.streamKey), sourceCommandId = uuid(x.sourceCommandId);
  const parsedBody = body(x.body, streamKind, key, sourceCommandId);
  // Enforce body independently of the larger core domain before stringify.
  ownData(parsedBody, { remaining: BODY_BYTES, nodes: 16000 });
  return { version: literal(x.version, 3), kind: literal(x.kind, 'seoul-authority-source'), revision: integer(x.revision, 1), sourceCommandId,
    streamKind, streamKey: key, eventId: uuid(x.eventId), createdAtMs: integer(x.createdAtMs), body: parsedBody };
}
function bytes(value: Uint8Array, maximum: number): Uint8Array<ArrayBuffer> {
  // Intrinsic storage supports cross-realm Uint8Array, Buffer and subclasses.
  // Proxies, DataView and prototype-spoofed wider arrays have no such brand.
  if (byteBrand.call(value) !== 'Uint8Array') invalid();
  const length = byteLength.call(value) as number; if (!length || length > maximum) invalid();
  const owned = new Uint8Array(length); Uint8Array.prototype.set.call(owned, value); return owned;
}
function coreBytes(source: SeoulAuthoritySource): Uint8Array<ArrayBuffer> { return utf8.encode(JSON.stringify(source)); }
function parseRow(value: unknown): { source: SeoulAuthoritySource; rowGuard: SeoulAuthoritySourceRow } {
  const x = record(ownRecord(value), ['revision', 'source_command_id', 'stream_kind', 'stream_key', 'event_id', 'record_bytes', 'created_at']);
  if (typeof x.record_bytes !== 'string' || !x.record_bytes.length || x.record_bytes.length > BODY_BYTES || utf8.encode(x.record_bytes).length > BODY_BYTES) invalid();
  const source = parse({ version: 3, kind: 'seoul-authority-source', revision: x.revision, sourceCommandId: x.source_command_id, streamKind: x.stream_kind,
    streamKey: x.stream_key, eventId: x.event_id, createdAtMs: x.created_at, body: JSON.parse(x.record_bytes) });
  if (JSON.stringify(source.body) !== x.record_bytes) invalid();
  return { source, rowGuard: { revision: source.revision, source_command_id: source.sourceCommandId, stream_kind: source.streamKind, stream_key: source.streamKey,
    event_id: source.eventId, record_bytes: x.record_bytes, created_at: source.createdAtMs } };
}

/** Object API reconstructs closed records in canonical order. It never calls
 * caller getters/toJSON; selected byte input is handled only by decode. */
export function encodeSeoulAuthoritySource(value: unknown): Uint8Array { return boundary(() => coreBytes(parse(value))); }

/** Canonical core only. Body TEXT belongs to parseSeoulAuthoritySourceRow.
 * Exact equality rejects duplicate keys, alternate escapes/numbers and BOM. */
export function decodeSeoulAuthoritySource(value: Uint8Array): SeoulAuthoritySource {
  return boundary(() => {
    const owned = bytes(value, CORE_BYTES), source = parse(JSON.parse(strictUtf8.decode(owned))), canonical = coreBytes(source);
    if (owned.length !== canonical.length || owned.some((byte, index) => byte !== canonical[index])) invalid(); return source;
  });
}
export function parseSeoulAuthoritySourceRow(value: unknown): SeoulAuthoritySource { return boundary(() => parseRow(value).source); }

/** All input is copied/validated before the first await. Metadata is frozen;
 * returned arrays are independent owned, mutable views. Persist their exact
 * bytes/hash pair. No DB reads, writes, replay repair or failure persistence. */
export async function prepareSeoulHeadCandidate(value: unknown): Promise<SeoulHeadCandidate> {
  try {
    const { source, rowGuard } = parseRow(value), sourceCoreBytes = coreBytes(source);
    const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', sourceCoreBytes));
    const sourceChangeSha256 = Array.from(digestBytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const effect: SeoulHeadEffect = source.body.kind === 'subject-source-unrepresentable' ? { type: 'entity-head', disposition: 'changed' } : source.body.effect;
    const eventBytes = encodeSeoulHeadEvent({ version: 3, kind: 'seoul-authority-head', eventId: source.eventId, sourceRevision: source.revision, issuer: ISSUER,
      head: { kind: source.streamKind, key: source.streamKey, revision: source.revision, eventId: source.eventId, payloadSha256: sourceChangeSha256 }, effect });
    const eventText = strictUtf8.decode(eventBytes), transportPayloadSha256 = await hashSeoulProjectionTransport(eventBytes);
    return Object.freeze({ rowGuard: Object.freeze(rowGuard), sourceCoreBytes, sourceChangeSha256, eventBytes, eventText, transportPayloadSha256 });
  } catch (error) { return failure(error); }
}

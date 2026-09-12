/** Inert canonical data boundary. This validates the supplied graph only; the
 * trusted stable builder must prove it contains ALL current central mappings.
 * No source preparation, transport authentication, tombstone transition,
 * database-time admission, route selection or authority application occurs. */
import { decodeSeoulHeadEvent, encodeSeoulHeadEvent } from './seoul-projection-head-codec.ts';
import type { SeoulHead, SeoulHeadKind } from './seoul-projection-head-codec.ts';

const ISSUER = 'https://auth-api.allen.company';
const MAX_BYTES = 128 * 1024;
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBrand = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const capabilityNames = ['read', 'create', 'update', 'delete', 'export'] as const;
type Capability = typeof capabilityNames[number];
type Account = { id: string; disabledAtMs: number | null };
type ProviderIdentity = { issuer: typeof ISSUER; subject: string; accountId: string; createdAtMs: number };
type Email = { id: string; accountId: string; address: string; verifiedAtMs: number; revokedAtMs: number | null };
type Membership = { id: string; accountId: string; emailId: string; organizationId: string; role: 'owner' | 'admin' | 'member'; expiresAtMs: number; revokedAtMs: number | null };
type Credential = { id: string; accountId: string; kind: 'personal_key' | 'api_key'; permission: 'read' | 'write'; tokenDigest: string; membershipId: string | null; emailId: string | null; expiresAtMs: number; revokedAtMs: number | null };
type CredentialPolicy = { credentialId: string; capabilities: Capability[]; spaceIds: string[] | null };
type SpacePolicy = { policyVersion: 1; residency: 'kr-seoul'; profile: 'kr-primary-storage'; processingBoundary: 'approved-processors'; dataClass: 'personal'; classificationStatus: 'declared'; sensitivityTags: string[]; placementEpoch: 1 };
type Space = { id: string; accountId: string | null; organizationId: string | null; disabledAtMs: number | null; policy: SpacePolicy };
type Grant = {
  credentialId: string; accountId: string; spaceId: string; provenance: 'owner' | 'organization-member';
  canIngest: boolean; canSearch: boolean; canErase: false; canRetire: false; expiresAtMs: number; revokedAtMs: null;
  heads: { subjects: SeoulHead[]; emails: SeoulHead[] | null; organization: SeoulHead | null; membership: SeoulHead | null; credential: SeoulHead; space: SeoulHead; target: SeoulHead };
};
export type SeoulAuthoritySnapshot = {
  version: 3; kind: 'seoul-authority-snapshot'; eventId: string; sourceRevision: number; snapshotSeq: number;
  issuer: typeof ISSUER; spaceId: string; selected: boolean; accounts: Account[]; providerIdentities: ProviderIdentity[];
  emails: Email[]; organizations: Account[]; memberships: Membership[]; credentials: Credential[];
  credentialPolicies: CredentialPolicy[]; spaces: Space[]; grants: Grant[];
  lease: { issuedAtMs: number; expiresAtMs: number };
};

function invalid(): never { throw new Error('seoul_snapshot_invalid'); }

/** Copy only own enumerable data into inert records. Account for the exact JSON
 * byte size while traversing, before constructing a potentially huge graph.
 * The finite array ceiling cannot exclude any <=128 KiB JSON array. Depth and
 * record-key limits exceed every permitted schema shape and stop cycles. */
function ownData(value: unknown, budget = { bytes: 0 }, depth = 0): unknown {
  const charge = (amount: number): void => { budget.bytes += amount; if (budget.bytes > MAX_BYTES) invalid(); };
  if (depth > 10) invalid();
  if (value === null || typeof value === 'boolean') { charge(value === null ? 4 : value ? 4 : 5); return value; }
  if (typeof value === 'number') { integer(value, 0); charge(String(value).length); return value; }
  if (typeof value === 'string') {
    if (value.length > MAX_BYTES) invalid();
    charge(utf8.encode(JSON.stringify(value)).length); return value;
  }
  if (typeof value !== 'object') invalid();
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) invalid();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor)) invalid();
    const length = integer(lengthDescriptor.value, 0);
    if (length > MAX_BYTES || Reflect.ownKeys(value).length !== length + 1) invalid();
    charge(2 + Math.max(0, length - 1));
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
      result.push(ownData(descriptor.value, budget, depth + 1));
    }
    return result;
  }
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 18) invalid();
  charge(2 + Math.max(0, keys.length - 1));
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > MAX_BYTES) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    charge(utf8.encode(JSON.stringify(key)).length + 1);
    result[key] = ownData(descriptor.value, budget, depth + 1);
  }
  return result;
}
/** All callers receive ownData's inert copy, never the caller's objects. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>, actual = Object.keys(input);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid();
  return input;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) invalid();
  return value;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value); }
function timestamp(value: unknown): number { return integer(value, 0); }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function literal<T extends string | number | boolean | null>(value: unknown, expected: T): T { if (value !== expected) invalid(); return expected; }
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(); return value as T;
}
function identifier(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) invalid();
  return value;
}
function spaceId(value: unknown): string { return identifier(value, 128); }
function subject(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !value.trim() || value.includes('\0')
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid();
  return value;
}
/** Keep identity.canonicalEmail's ASCII mailbox rules without normalizing. */
function address(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || value !== value.trim().toLowerCase()) invalid();
  const parts = value.split('@'), local = parts[0] ?? '', domain = parts[1] ?? '';
  if (parts.length !== 2 || local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || domain.length > 253 || !domain.includes('.')
    || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid(); return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value;
}
function list<T>(value: unknown, parse: (value: unknown) => T, max = MAX_BYTES): T[] {
  if (!Array.isArray(value) || value.length > max) invalid(); return value.map(parse);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sorted<T>(values: T[], order: (a: T, b: T) => number): T[] {
  for (let i = 1; i < values.length; i++) if (order(values[i - 1]!, values[i]!) >= 0) invalid();
  return values;
}
function strings<T extends string>(value: unknown, parse: (value: unknown) => T, max = MAX_BYTES): T[] {
  return sorted(list(value, parse, max), compare);
}
function idRows<T extends { id: string }>(value: unknown, parse: (value: unknown) => T, max = MAX_BYTES): T[] {
  return sorted(list(value, parse, max), (a, b) => compare(a.id, b.id));
}
function credentialRows<T extends { credentialId: string }>(value: unknown, parse: (value: unknown) => T): T[] {
  return sorted(list(value, parse), (a, b) => compare(a.credentialId, b.credentialId));
}
function account(value: unknown): Account {
  const x = record(value, ['id', 'disabledAtMs']);
  return { id: identifier(x.id), disabledAtMs: nullable(x.disabledAtMs, timestamp) };
}
function providerIdentity(value: unknown): ProviderIdentity {
  const x = record(value, ['issuer', 'subject', 'accountId', 'createdAtMs']);
  return { issuer: literal(x.issuer, ISSUER), subject: subject(x.subject), accountId: identifier(x.accountId), createdAtMs: timestamp(x.createdAtMs) };
}
function email(value: unknown): Email {
  const x = record(value, ['id', 'accountId', 'address', 'verifiedAtMs', 'revokedAtMs']);
  return { id: identifier(x.id), accountId: identifier(x.accountId), address: address(x.address), verifiedAtMs: timestamp(x.verifiedAtMs), revokedAtMs: nullable(x.revokedAtMs, timestamp) };
}
function membership(value: unknown): Membership {
  const x = record(value, ['id', 'accountId', 'emailId', 'organizationId', 'role', 'expiresAtMs', 'revokedAtMs']);
  return { id: identifier(x.id), accountId: identifier(x.accountId), emailId: identifier(x.emailId), organizationId: identifier(x.organizationId), role: choice(x.role, ['owner', 'admin', 'member']), expiresAtMs: timestamp(x.expiresAtMs), revokedAtMs: nullable(x.revokedAtMs, timestamp) };
}
function credential(value: unknown): Credential {
  const x = record(value, ['id', 'accountId', 'kind', 'permission', 'tokenDigest', 'membershipId', 'emailId', 'expiresAtMs', 'revokedAtMs']);
  return { id: identifier(x.id), accountId: identifier(x.accountId), kind: choice(x.kind, ['personal_key', 'api_key']), permission: choice(x.permission, ['read', 'write']), tokenDigest: digest(x.tokenDigest), membershipId: nullable(x.membershipId, identifier), emailId: nullable(x.emailId, identifier), expiresAtMs: timestamp(x.expiresAtMs), revokedAtMs: nullable(x.revokedAtMs, timestamp) };
}
function credentialPolicy(value: unknown): CredentialPolicy {
  const x = record(value, ['credentialId', 'capabilities', 'spaceIds']);
  const scope = nullable(x.spaceIds, value => strings(value, spaceId, 50));
  if (scope?.length === 0) invalid();
  return { credentialId: identifier(x.credentialId), capabilities: strings(x.capabilities, value => choice(value, capabilityNames), 5), spaceIds: scope };
}
function spacePolicy(value: unknown): SpacePolicy {
  const x = record(value, ['policyVersion', 'residency', 'profile', 'processingBoundary', 'dataClass', 'classificationStatus', 'sensitivityTags', 'placementEpoch']);
  const tags = strings(x.sensitivityTags, value => choice(value, ['clinical-origin', 'credential', 'government-id', 'health']), 4);
  if (tags.includes('clinical-origin') && !tags.includes('health')) invalid();
  return { policyVersion: literal(x.policyVersion, 1), residency: literal(x.residency, 'kr-seoul'), profile: literal(x.profile, 'kr-primary-storage'), processingBoundary: literal(x.processingBoundary, 'approved-processors'), dataClass: literal(x.dataClass, 'personal'), classificationStatus: literal(x.classificationStatus, 'declared'), sensitivityTags: tags, placementEpoch: literal(x.placementEpoch, 1) };
}
function space(value: unknown): Space {
  const x = record(value, ['id', 'accountId', 'organizationId', 'disabledAtMs', 'policy']);
  return { id: spaceId(x.id), accountId: nullable(x.accountId, identifier), organizationId: nullable(x.organizationId, identifier), disabledAtMs: nullable(x.disabledAtMs, timestamp), policy: spacePolicy(x.policy) };
}
function sourceHead(value: unknown, sourceRevision: number): SeoulHead {
  const x = record(value, ['kind', 'key', 'revision', 'eventId', 'payloadSha256']);
  // The closed head-only envelope reuses the reviewed structural codec. It is
  // never sent, persisted or interpreted as a source/lifecycle event here.
  const result = decodeSeoulHeadEvent(encodeSeoulHeadEvent({
    version: 3, kind: 'seoul-authority-head', eventId: x.eventId, sourceRevision: x.revision,
    issuer: ISSUER, head: x, effect: { type: 'entity-head', disposition: 'present' },
  })).head;
  if (result.revision > sourceRevision) invalid();
  return result;
}
function grant(value: unknown, sourceRevision: number): Grant {
  const x = record(value, ['credentialId', 'accountId', 'spaceId', 'provenance', 'canIngest', 'canSearch', 'canErase', 'canRetire', 'expiresAtMs', 'revokedAtMs', 'heads']);
  const h = record(x.heads, ['subjects', 'emails', 'organization', 'membership', 'credential', 'space', 'target']);
  const one = (value: unknown): SeoulHead => sourceHead(value, sourceRevision);
  const vector = (value: unknown): SeoulHead[] => sorted(list(value, one), (a, b) => compare(a.key, b.key));
  return {
    credentialId: identifier(x.credentialId), accountId: identifier(x.accountId), spaceId: spaceId(x.spaceId), provenance: choice(x.provenance, ['owner', 'organization-member']),
    canIngest: bool(x.canIngest), canSearch: bool(x.canSearch), canErase: literal(x.canErase, false), canRetire: literal(x.canRetire, false), expiresAtMs: timestamp(x.expiresAtMs), revokedAtMs: literal(x.revokedAtMs, null),
    heads: { subjects: vector(h.subjects), emails: nullable(h.emails, vector), organization: nullable(h.organization, one), membership: nullable(h.membership, one), credential: one(h.credential), space: one(h.space), target: one(h.target) },
  };
}
function byId<T extends { id: string }>(values: T[]): Map<string, T> { return new Map(values.map(value => [value.id, value])); }
function requireRow<T>(rows: Map<string, T>, key: string): T { const value = rows.get(key); if (!value) invalid(); return value; }
function sameKeys(actual: readonly string[], expected: Set<string>): void {
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) invalid();
}

function graph(snapshot: SeoulAuthoritySnapshot): void {
  const { accounts, providerIdentities, organizations, credentials, credentialPolicies, grants, lease } = snapshot;
  if (snapshot.spaces.length !== 1) invalid();
  const space = snapshot.spaces[0]!;
  if (space.id !== snapshot.spaceId || (space.accountId === null) === (space.organizationId === null)) invalid();
  const accountRows = byId(accounts), orgRows = byId(organizations), emailRows = byId(snapshot.emails), membershipRows = byId(snapshot.memberships);
  const neededAccounts = new Set<string>(), neededEmails = new Set<string>(), neededMemberships = new Set<string>();
  if (space.accountId !== null) { requireRow(accountRows, space.accountId); neededAccounts.add(space.accountId); }
  if (space.organizationId !== null) requireRow(orgRows, space.organizationId);
  sameKeys(organizations.map(row => row.id), new Set(space.organizationId === null ? [] : [space.organizationId]));

  const identityKeys = new Set<string>(), identitiesByAccount = new Map<string, string[]>();
  for (const identity of providerIdentities) {
    requireRow(accountRows, identity.accountId);
    const key = ISSUER + '\n' + identity.subject;
    if (identityKeys.has(key)) invalid(); identityKeys.add(key);
    const keys = identitiesByAccount.get(identity.accountId) ?? [];
    keys.push(key); identitiesByAccount.set(identity.accountId, keys);
  }
  for (const account of accounts) if (!identitiesByAccount.get(account.id)?.length) invalid();
  if (credentials.length !== credentialPolicies.length || credentials.length !== grants.length) invalid();
  const digests = new Set<string>(), counts = new Map<string, number>(), seenHeads = new Map<string, string>();
  const revisionStreams = new Map<number, string>(), eventStreams = new Map<string, string>();
  const pin = (head: SeoulHead, kind: SeoulHeadKind, key: string): void => {
    if (head.kind !== kind || head.key !== key) invalid();
    const stream = JSON.stringify([kind, key]), tuple = JSON.stringify([head.revision, head.eventId, head.payloadSha256]);
    const previous = seenHeads.get(stream);
    if (previous !== undefined && previous !== tuple) invalid();
    // A global revision and source event each name one immutable source row.
    // Repeated exact stream tuples are allowed; transport IDs are separate.
    const revisionStream = revisionStreams.get(head.revision), eventStream = eventStreams.get(head.eventId);
    if ((revisionStream !== undefined && revisionStream !== stream)
      || (eventStream !== undefined && eventStream !== stream) || head.eventId === snapshot.eventId) invalid();
    seenHeads.set(stream, tuple);
    revisionStreams.set(head.revision, stream); eventStreams.set(head.eventId, stream);
  };
  const vector = (heads: SeoulHead[], kind: 'subject' | 'email', expected: string[]): void => {
    // Email suffixes can change lexical order for prefix-related opaque
    // subjects, so sort complete keys rather than reusing subject order.
    const keys = [...expected].sort(compare);
    if (!keys.length || heads.length !== keys.length) invalid();
    heads.forEach((head, index) => pin(head, kind, keys[index]!));
  };
  for (let index = 0; index < credentials.length; index++) {
    const credential = credentials[index]!, policy = credentialPolicies[index]!, grant = grants[index]!;
    if (policy.credentialId !== credential.id || grant.credentialId !== credential.id
      || grant.accountId !== credential.accountId || grant.spaceId !== space.id) invalid();
    if (digests.has(credential.tokenDigest)) invalid(); digests.add(credential.tokenDigest);
    const count = (counts.get(credential.accountId) ?? 0) + 1;
    if (count > 100) invalid(); counts.set(credential.accountId, count);
    const account = requireRow(accountRows, credential.accountId);
    neededAccounts.add(account.id);
    if (!snapshot.selected || space.disabledAtMs !== null || account.disabledAtMs !== null
      || credential.revokedAtMs !== null || credential.expiresAtMs <= lease.issuedAtMs
      || (policy.spaceIds !== null && !policy.spaceIds.includes(space.id))) invalid();
    const keys = identitiesByAccount.get(account.id)!;
    vector(grant.heads.subjects, 'subject', keys);
    pin(grant.heads.credential, 'credential', credential.id);
    pin(grant.heads.space, 'space', space.id);
    pin(grant.heads.target, 'target', space.id);
    let expiry = credential.expiresAtMs, directWrite = false;
    if (grant.provenance === 'owner') {
      if (credential.kind !== 'personal_key' || credential.membershipId !== null || credential.emailId !== null
        || space.accountId !== credential.accountId || space.organizationId !== null
        || grant.heads.emails !== null || grant.heads.organization !== null || grant.heads.membership !== null) invalid();
      directWrite = true;
    } else {
      if (credential.kind !== 'api_key' || credential.membershipId === null || credential.emailId === null
        || space.accountId !== null || space.organizationId === null || grant.heads.emails === null
        || grant.heads.organization === null || grant.heads.membership === null) invalid();
      const membership = requireRow(membershipRows, credential.membershipId), email = requireRow(emailRows, credential.emailId), organization = requireRow(orgRows, space.organizationId);
      if (membership.accountId !== account.id || email.accountId !== account.id
        || membership.emailId !== email.id || membership.organizationId !== organization.id
        || membership.revokedAtMs !== null || membership.expiresAtMs <= lease.issuedAtMs
        || email.revokedAtMs !== null || email.verifiedAtMs > lease.issuedAtMs || organization.disabledAtMs !== null) invalid();
      neededMemberships.add(membership.id); neededEmails.add(email.id);
      pin(grant.heads.organization, 'organization', organization.id);
      pin(grant.heads.membership, 'membership', membership.id);
      vector(grant.heads.emails, 'email', keys.map(key => key + '\n' + email.address));
      expiry = Math.min(expiry, membership.expiresAtMs);
      directWrite = membership.role === 'owner' || membership.role === 'admin';
    }
    const canSearch = policy.capabilities.includes('read');
    const canIngest = policy.capabilities.includes('create') && credential.permission === 'write' && directWrite;
    if ((!canSearch && !canIngest) || grant.canSearch !== canSearch || grant.canIngest !== canIngest
      || grant.expiresAtMs !== expiry || grant.expiresAtMs <= lease.issuedAtMs) invalid();
  }
  sameKeys(accounts.map(row => row.id), neededAccounts);
  sameKeys(snapshot.emails.map(row => row.id), neededEmails);
  sameKeys(snapshot.memberships.map(row => row.id), neededMemberships);
  // Match existing regional UNIQUE constraints; never deduplicate aliases.
  const addresses = new Set<string>(), membershipTuples = new Set<string>();
  for (const row of snapshot.emails) { if (addresses.has(row.address)) invalid(); addresses.add(row.address); }
  for (const row of snapshot.memberships) {
    const tuple = JSON.stringify([row.organizationId, row.accountId]);
    if (membershipTuples.has(tuple)) invalid(); membershipTuples.add(tuple);
  }
}
function parse(value: unknown): SeoulAuthoritySnapshot {
  const x = record(ownData(value), ['version', 'kind', 'eventId', 'sourceRevision', 'snapshotSeq', 'issuer', 'spaceId', 'selected', 'accounts', 'providerIdentities', 'emails', 'organizations', 'memberships', 'credentials', 'credentialPolicies', 'spaces', 'grants', 'lease']);
  const sourceRevision = integer(x.sourceRevision, 1), lease = record(x.lease, ['issuedAtMs', 'expiresAtMs']);
  const issuedAtMs = timestamp(lease.issuedAtMs), expiresAtMs = timestamp(lease.expiresAtMs);
  if (issuedAtMs > Number.MAX_SAFE_INTEGER - 60000 || expiresAtMs !== issuedAtMs + 60000) invalid();
  const result: SeoulAuthoritySnapshot = {
    version: literal(x.version, 3), kind: literal(x.kind, 'seoul-authority-snapshot'), eventId: uuid(x.eventId), sourceRevision, snapshotSeq: integer(x.snapshotSeq, 1), issuer: literal(x.issuer, ISSUER), spaceId: spaceId(x.spaceId), selected: bool(x.selected),
    accounts: idRows(x.accounts, account, 200),
    providerIdentities: sorted(list(x.providerIdentities, providerIdentity), (a, b) => compare(a.issuer, b.issuer) || compare(a.subject, b.subject) || compare(a.accountId, b.accountId)),
    emails: idRows(x.emails, email, 200), organizations: idRows(x.organizations, account), memberships: idRows(x.memberships, membership, 200), credentials: idRows(x.credentials, credential),
    credentialPolicies: credentialRows(x.credentialPolicies, credentialPolicy), spaces: idRows(x.spaces, space), grants: credentialRows(x.grants, value => grant(value, sourceRevision)), lease: { issuedAtMs, expiresAtMs },
  };
  graph(result); return result;
}
function transportBytes(bytes: Uint8Array): Uint8Array {
  // Internal brand/length bypass shadowed properties and accept genuine
  // Buffer, subclasses and cross-realm views while rejecting spoofed brands.
  if (typedArrayBrand.call(bytes) !== 'Uint8Array') invalid();
  const length = byteLength.call(bytes) as number;
  if (length === 0 || length > MAX_BYTES) invalid();
  const copy = new Uint8Array(length);
  Uint8Array.prototype.set.call(copy, bytes); return copy;
}

/** Reconstruct fixed wire key order. Input row order is validated, never fixed. */
export function encodeSeoulAuthoritySnapshot(value: unknown): Uint8Array {
  try {
    const bytes = utf8.encode(JSON.stringify(parse(value)));
    if (bytes.byteLength > MAX_BYTES) invalid(); return bytes;
  } catch { invalid(); }
}
/** Canonical re-encoding rejects duplicate keys, reordered records, alternate
 * escapes/numbers, whitespace, BOM and every byte outside the selected view. */
export function decodeSeoulAuthoritySnapshot(bytes: Uint8Array): SeoulAuthoritySnapshot {
  try {
    const input = transportBytes(bytes), value = parse(JSON.parse(strictUtf8.decode(input)));
    const canonical = encodeSeoulAuthoritySnapshot(value);
    if (canonical.byteLength !== input.byteLength || canonical.some((byte, index) => byte !== input[index])) invalid();
    return value;
  } catch { invalid(); }
}

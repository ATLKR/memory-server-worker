import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { encodeSeoulAuthoritySnapshot as encode, decodeSeoulAuthoritySnapshot as decode } from '../../src/release/seoul-projection-snapshot-codec.ts';

const issuer = 'https://auth-api.allen.company';
const eventId = 'fedcba98-7654-4321-8fed-cba987654321';
const sourceId = revision => '01234567-89ab-4cde-8fab-' + revision.toString(16).padStart(12, '0');
const digest = '0123456789abcdef'.repeat(4);
const utf8 = new TextEncoder();
const string = bytes => new TextDecoder().decode(bytes);
const clone = value => structuredClone(value);
const head = (kind, key, revision = 1) => ({ kind, key, revision, eventId: sourceId(revision), payloadSha256: digest });
const subjectKey = subject => issuer + '\n' + subject;
const emailKey = (subject, address = 'alice@example.com') => subjectKey(subject) + '\n' + address;
function snapshot(organization = false, role = 'admin') {
  return {
    version: 3, kind: 'seoul-authority-snapshot', eventId, sourceRevision: 7, snapshotSeq: 1, issuer,
    spaceId: 'space:one', selected: true,
    accounts: [{ id: 'account:one', disabledAtMs: null }],
    providerIdentities: [{ issuer, subject: 'alice', accountId: 'account:one', createdAtMs: 0 }],
    emails: organization ? [{ id: 'email:one', accountId: 'account:one', address: 'alice@example.com', verifiedAtMs: 0, revokedAtMs: null }] : [],
    organizations: organization ? [{ id: 'org:one', disabledAtMs: null }] : [],
    memberships: organization ? [{ id: 'membership:one', accountId: 'account:one', emailId: 'email:one', organizationId: 'org:one', role, expiresAtMs: 80000, revokedAtMs: null }] : [],
    credentials: [{ id: 'credential:one', accountId: 'account:one', kind: organization ? 'api_key' : 'personal_key', permission: 'write', tokenDigest: digest, membershipId: organization ? 'membership:one' : null, emailId: organization ? 'email:one' : null, expiresAtMs: 90000, revokedAtMs: null }],
    credentialPolicies: [{ credentialId: 'credential:one', capabilities: ['create', 'read'], spaceIds: null }],
    spaces: [{ id: 'space:one', accountId: organization ? null : 'account:one', organizationId: organization ? 'org:one' : null, disabledAtMs: null, policy: { policyVersion: 1, residency: 'kr-seoul', profile: 'kr-primary-storage', processingBoundary: 'approved-processors', dataClass: 'personal', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 } }],
    grants: [{ credentialId: 'credential:one', accountId: 'account:one', spaceId: 'space:one', provenance: organization ? 'organization-member' : 'owner', canIngest: !organization || role !== 'member', canSearch: true, canErase: false, canRetire: false, expiresAtMs: organization ? 80000 : 90000, revokedAtMs: null, heads: { subjects: [head('subject', subjectKey('alice'))], emails: organization ? [head('email', emailKey('alice'), 2)] : null, organization: organization ? head('organization', 'org:one', 3) : null, membership: organization ? head('membership', 'membership:one', 4) : null, credential: head('credential', 'credential:one', 5), space: head('space', 'space:one', 6), target: head('target', 'space:one', 7) } }],
    lease: { issuedAtMs: 1000, expiresAtMs: 61000 },
  };
}
function roundTrip(value) {
  const bytes = encode(value);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(decode(bytes), value);
  assert.deepEqual(encode(decode(bytes)), bytes);
  return bytes;
}
function invalid(value) {
  assert.throws(() => encode(value), { message: 'seoul_snapshot_invalid' });
}
function invalidBytes(bytes) {
  assert.throws(() => decode(bytes), { message: 'seoul_snapshot_invalid' });
}
function bad(base, mutate) { const value = clone(base); mutate(value); invalid(value); }
function addIdentity(value, subject) {
  value.providerIdentities.push({ issuer, subject, accountId: 'account:one', createdAtMs: 0 });
  value.providerIdentities.sort((a, b) => a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0);
  const subjectRevision = ++value.sourceRevision;
  const emailRevision = value.grants.some(grant => grant.heads.emails !== null) ? ++value.sourceRevision : null;
  for (const grant of value.grants) {
    grant.heads.subjects.push(head('subject', subjectKey(subject), subjectRevision));
    grant.heads.subjects.sort((a, b) => a.key < b.key ? -1 : 1);
    if (grant.heads.emails) {
      grant.heads.emails.push(head('email', emailKey(subject), emailRevision));
      grant.heads.emails.sort((a, b) => a.key < b.key ? -1 : 1);
    }
  }
}
function addCredential(value, index) {
  const id = 'credential:' + String(index).padStart(3, '0');
  const credential = { ...value.credentials[0], id, tokenDigest: index.toString(16).padStart(64, '0') };
  value.credentials.push(credential);
  value.credentialPolicies.push({ ...clone(value.credentialPolicies[0]), credentialId: id });
  const grant = { ...clone(value.grants[0]), credentialId: id };
  grant.heads.credential = head('credential', id, ++value.sourceRevision);
  value.grants.push(grant);
  value.credentials.sort((a, b) => a.id < b.id ? -1 : 1);
  value.credentialPolicies.sort((a, b) => a.credentialId < b.credentialId ? -1 : 1);
  value.grants.sort((a, b) => a.credentialId < b.credentialId ? -1 : 1);
}
function twoAccounts() {
  const value = snapshot(true);
  addCredential(value, 2);
  value.accounts.push({ id: 'account:two', disabledAtMs: null });
  value.providerIdentities.push({ issuer, subject: 'bob', accountId: 'account:two', createdAtMs: 0 });
  value.emails.push({ id: 'email:two', accountId: 'account:two', address: 'bob@example.com', verifiedAtMs: 0, revokedAtMs: null });
  value.memberships.push({ id: 'membership:two', accountId: 'account:two', emailId: 'email:two', organizationId: 'org:one', role: 'member', expiresAtMs: 80000, revokedAtMs: null });
  Object.assign(value.credentials[0], { accountId: 'account:two', membershipId: 'membership:two', emailId: 'email:two' });
  Object.assign(value.grants[0], { accountId: 'account:two', canIngest: false });
  Object.assign(value.grants[0].heads, { subjects: [head('subject', subjectKey('bob'), ++value.sourceRevision)], emails: [head('email', emailKey('bob', 'bob@example.com'), ++value.sourceRevision)], membership: head('membership', 'membership:two', ++value.sourceRevision) });
  return value;
}

// Written independently of the encoder or fixture builder: both directions must
// satisfy these literal bytes, so a mutually incorrect encoder/decoder fails.
const emptyWire = '{"version":3,"kind":"seoul-authority-snapshot","eventId":"fedcba98-7654-4321-8fed-cba987654321","sourceRevision":7,"snapshotSeq":1,"issuer":"https://auth-api.allen.company","spaceId":"space:one","selected":true,"accounts":[{"id":"account:one","disabledAtMs":null}],"providerIdentities":[{"issuer":"https://auth-api.allen.company","subject":"alice","accountId":"account:one","createdAtMs":0}],"emails":[],"organizations":[],"memberships":[],"credentials":[],"credentialPolicies":[],"spaces":[{"id":"space:one","accountId":"account:one","organizationId":null,"disabledAtMs":null,"policy":{"policyVersion":1,"residency":"kr-seoul","profile":"kr-primary-storage","processingBoundary":"approved-processors","dataClass":"personal","classificationStatus":"declared","sensitivityTags":[],"placementEpoch":1}}],"grants":[],"lease":{"issuedAtMs":1000,"expiresAtMs":61000}}';
function emptySnapshot(organization = false) {
  const value = snapshot(organization);
  for (const key of ['emails', 'memberships', 'credentials', 'credentialPolicies', 'grants']) value[key] = [];
  if (organization) { value.accounts = []; value.providerIdentities = []; }
  return value;
}
test('literal canonical wire independently fixes top-level, row and policy field order', () => {
  const value = emptySnapshot();
  assert.equal(string(encode(value)), emptyWire);
  assert.deepEqual(decode(utf8.encode(emptyWire)), value);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value;
  assert.equal(string(encode(reverse(value))), emptyWire);
});
test('personal owner and owner/admin/member organization grants retain exact expected actions and joins', () => {
  roundTrip(snapshot());
  for (const role of ['owner', 'admin', 'member']) roundTrip(snapshot(true, role));
  const value = snapshot(true, 'member');
  assert.equal(decode(roundTrip(value)).grants[0].canIngest, false);
});
test('every populated canonical row has independently specified wire field order', () => {
  const input = snapshot(true);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value;
  // Inspect JSON bytes independently, never use the decoder to establish order.
  const wire = JSON.parse(string(encode(reverse(input))));
  for (const [key, fields] of [
    ['accounts', ['id', 'disabledAtMs']],
    ['providerIdentities', ['issuer', 'subject', 'accountId', 'createdAtMs']],
    ['emails', ['id', 'accountId', 'address', 'verifiedAtMs', 'revokedAtMs']],
    ['organizations', ['id', 'disabledAtMs']],
    ['memberships', ['id', 'accountId', 'emailId', 'organizationId', 'role', 'expiresAtMs', 'revokedAtMs']],
    ['credentials', ['id', 'accountId', 'kind', 'permission', 'tokenDigest', 'membershipId', 'emailId', 'expiresAtMs', 'revokedAtMs']],
    ['credentialPolicies', ['credentialId', 'capabilities', 'spaceIds']],
    ['spaces', ['id', 'accountId', 'organizationId', 'disabledAtMs', 'policy']],
    ['grants', ['credentialId', 'accountId', 'spaceId', 'provenance', 'canIngest', 'canSearch', 'canErase', 'canRetire', 'expiresAtMs', 'revokedAtMs', 'heads']],
  ]) assert.deepEqual(Object.keys(wire[key][0]), fields);
  assert.deepEqual(Object.keys(wire.grants[0].heads), ['subjects', 'emails', 'organization', 'membership', 'credential', 'space', 'target']);
  assert.deepEqual(Object.keys(wire.grants[0].heads.subjects[0]), ['kind', 'key', 'revision', 'eventId', 'payloadSha256']);
  assert.deepEqual(Object.keys(wire.lease), ['issuedAtMs', 'expiresAtMs']);
});
test('zero-grant selected or deselected snapshots preserve precisely the Space owner', () => {
  for (const org of [false, true]) for (const selected of [false, true]) {
    const value = emptySnapshot(org); value.selected = selected; roundTrip(value);
    value.spaces[0].disabledAtMs = 0;
    (org ? value.organizations : value.accounts)[0].disabledAtMs = 0;
    roundTrip(value);
  }
  bad(emptySnapshot(), value => { value.accounts = []; value.providerIdentities = []; });
  bad(emptySnapshot(true), value => { value.organizations = []; });
});
test('opaque multibyte, delimiter and normalization-distinct identities preserve full vectors', () => {
  for (const org of [false, true]) {
    const value = snapshot(org);
    for (const subject of [' Alice ', 'alice\nbob\n', 'e\u0301', 'é', '가'.repeat(512), '😀'.repeat(256), '\nalice\u0001\u007f']) addIdentity(value, subject);
    roundTrip(value);
    const decoded = decode(encode(value));
    assert.equal(decoded.grants[0].heads.subjects.length, 8);
    if (org) assert.equal(decoded.grants[0].heads.emails.length, 8);
  }
});
test('email head ordering sorts the complete key when opaque subjects share prefixes', () => {
  const value = snapshot(true);
  addIdentity(value, 'alice\nA');
  assert.deepEqual(value.grants[0].heads.subjects.map(h => h.key), [subjectKey('alice'), subjectKey('alice\nA')]);
  assert.deepEqual(value.grants[0].heads.emails.map(h => h.key), [emailKey('alice\nA'), emailKey('alice')]);
  roundTrip(value);
  bad(value, x => x.grants[0].heads.emails.reverse());
});
test('missing, duplicate, substituted and unsorted full identity vectors fail closed', () => {
  for (const org of [false, true]) {
    const value = snapshot(org); addIdentity(value, 'bob');
    for (const mutate of [
      x => x.grants[0].heads.subjects.pop(), x => x.grants[0].heads.subjects.reverse(),
      x => x.grants[0].heads.subjects.push(clone(x.grants[0].heads.subjects[1])),
      x => { x.grants[0].heads.subjects[0].key = subjectKey('another'); },
      x => x.providerIdentities.pop(), x => { x.providerIdentities = []; },
      x => x.providerIdentities.reverse(), x => x.providerIdentities.push(clone(x.providerIdentities[1])),
      x => { x.providerIdentities[0].accountId = 'other'; },
      x => { x.providerIdentities[0].issuer = 'https://foreign.example'; },
    ]) bad(value, mutate);
    if (org) for (const mutate of [
      x => { x.grants[0].heads.emails = null; }, x => x.grants[0].heads.emails.pop(),
      x => x.grants[0].heads.emails.reverse(),
      x => { x.grants[0].heads.emails[0].key = emailKey('alice', 'other@example.com'); },
      x => { x.grants[0].heads.emails[0].key = emailKey('another'); },
    ]) bad(value, mutate);
  }
});
test('no unrelated rows or orphan policy/credential may appear in the supplied reachable graph', () => {
  for (const [key, extra] of [
    ['accounts', { id: 'z', disabledAtMs: null }],
    ['providerIdentities', { issuer, subject: 'z', accountId: 'z', createdAtMs: 0 }],
    ['emails', { id: 'z', accountId: 'account:one', address: 'z@example.com', verifiedAtMs: 0, revokedAtMs: null }],
    ['organizations', { id: 'z', disabledAtMs: null }],
    ['memberships', { id: 'z', accountId: 'account:one', emailId: 'email:one', organizationId: 'org:one', role: 'admin', expiresAtMs: 99999, revokedAtMs: null }],
  ]) bad(snapshot(), value => value[key].push(extra));
  for (const key of ['credentials', 'credentialPolicies', 'grants']) bad(snapshot(), value => { value[key] = []; });
  bad(snapshot(), value => value.credentialPolicies.push({ credentialId: 'z', capabilities: ['read'], spaceIds: null }));
  bad(snapshot(), value => { value.credentialPolicies[0].credentialId = 'other'; });
});
test('owner provenance forbids shares, organization scope, session kinds and arbitrary email bindings', () => {
  for (const mutate of [
    x => { x.grants[0].provenance = 'shared-read'; }, x => { x.grants[0].provenance = 'organization-member'; },
    x => { x.credentials[0].kind = 'session'; }, x => { x.credentials[0].kind = 'api_key'; },
    x => { x.credentials[0].emailId = 'email:one'; }, x => { x.credentials[0].membershipId = 'membership:one'; },
    x => { x.grants[0].heads.emails = [head('email', emailKey('alice'))]; },
    x => { x.grants[0].heads.organization = head('organization', 'org:one'); },
    x => { x.grants[0].heads.membership = head('membership', 'membership:one'); },
    x => { x.spaces[0].accountId = 'another'; }, x => { x.grants[0].accountId = 'another'; },
    x => { x.credentials[0].accountId = 'another'; },
  ]) bad(snapshot(), mutate);
});
test('organization credentials require exact account, email, membership and organization tuple', () => {
  for (const [collection, field] of [
    ['credentials', 'accountId'], ['credentials', 'emailId'], ['credentials', 'membershipId'],
    ['memberships', 'accountId'], ['memberships', 'emailId'], ['memberships', 'organizationId'],
    ['emails', 'accountId'], ['grants', 'accountId'], ['spaces', 'organizationId'],
  ]) bad(snapshot(true), x => { x[collection][0][field] = 'other'; });
  for (const mutate of [
    x => { x.grants[0].provenance = 'owner'; }, x => { x.credentials[0].kind = 'personal_key'; },
    x => { x.credentials[0].emailId = null; }, x => { x.credentials[0].membershipId = null; },
    x => { x.grants[0].heads.organization = null; }, x => { x.grants[0].heads.membership = null; },
    x => { x.memberships[0].role = 'superadmin'; },
  ]) bad(snapshot(true), mutate);
});
test('two independently valid represented accounts cannot substitute each other\'s rows or vectors', () => {
  const value = twoAccounts(); roundTrip(value);
  for (const mutate of [
    x => { x.grants[0].heads.subjects = clone(x.grants[1].heads.subjects); },
    x => { x.grants[0].heads.emails = clone(x.grants[1].heads.emails); },
    x => { x.credentials[0].accountId = 'account:one'; },
    x => { x.grants[0].accountId = 'account:one'; },
    x => { x.credentials[0].emailId = 'email:one'; },
    x => { x.credentials[0].membershipId = 'membership:one'; },
    x => { x.memberships[1].accountId = 'account:one'; },
    x => { x.memberships[1].emailId = 'email:one'; },
    x => { x.emails[1].accountId = 'account:one'; },
    x => { x.providerIdentities[1].subject = 'alice'; },
  ]) bad(value, mutate);
});
test('each multirow array rejects unsorted or duplicate IDs instead of repairing them', () => {
  const value = twoAccounts();
  for (const key of ['accounts', 'providerIdentities', 'emails', 'memberships', 'credentials', 'credentialPolicies', 'grants']) {
    bad(value, x => x[key].reverse());
    bad(value, x => x[key].push(clone(x[key][1])));
  }
});
test('ordinary policies derive search/ingest exactly without creating erase, retire or unsupported actions', () => {
  for (const [capabilities, permission, role, search, ingest] of [
    [['read'], 'read', 'admin', true, false],
    [['create'], 'write', 'admin', false, true],
    [['create', 'read'], 'read', 'admin', true, false],
    [['create', 'read'], 'write', 'member', true, false],
    [['create', 'delete', 'export', 'read', 'update'], 'write', 'owner', true, true],
  ]) {
    const value = snapshot(true, role);
    value.credentialPolicies[0].capabilities = capabilities;
    value.credentials[0].permission = permission;
    Object.assign(value.grants[0], { canSearch: search, canIngest: ingest });
    roundTrip(value);
    bad(value, x => { x.grants[0].canSearch = !search; });
    bad(value, x => { x.grants[0].canIngest = !ingest; });
  }
  for (const capabilities of [[], ['update'], ['delete'], ['export'], ['create']]) {
    const value = snapshot(true, 'member'); value.credentialPolicies[0].capabilities = capabilities;
    Object.assign(value.grants[0], { canSearch: false, canIngest: false }); invalid(value);
  }
  for (const key of ['canErase', 'canRetire']) bad(snapshot(), x => { x.grants[0][key] = true; });
  for (const capabilities of [['write'], ['erase'], ['read', 'create'], ['read', 'read']]) bad(snapshot(), x => { x.credentialPolicies[0].capabilities = capabilities; });
});
test('wildcard and exact explicit scopes allow only this Space and enforce lexical unique 50-ID bounds', () => {
  const value = snapshot(); roundTrip(value);
  value.credentialPolicies[0].spaceIds = ['space:one']; roundTrip(value);
  value.credentialPolicies[0].spaceIds = ['space:one', ...Array.from({ length: 49 }, (_, i) => 'z' + String(i).padStart(2, '0'))]; roundTrip(value);
  for (const scope of [[], ['other'], ['space:one', 'space:one'], ['z', 'space:one'], [...value.credentialPolicies[0].spaceIds, 'z50'], ['space:one', 'z'.repeat(129)]]) bad(value, x => { x.credentialPolicies[0].spaceIds = scope; });
});
test('every repeated stream is exact while distinct stream revisions can differ below sourceRevision', () => {
  const value = snapshot(true); addCredential(value, 2); roundTrip(value);
  for (const property of ['revision', 'eventId', 'payloadSha256']) bad(value, x => {
    x.grants[1].heads.space[property] = property === 'revision' ? 5 : property === 'eventId' ? eventId : 'f'.repeat(64);
  });
  for (const key of ['credential', 'space', 'target', 'organization', 'membership']) {
    bad(snapshot(true), x => { x.grants[0].heads[key].key = 'other'; });
    bad(snapshot(true), x => { x.grants[0].heads[key].kind = 'subject'; });
    bad(snapshot(true), x => { x.grants[0].heads[key].revision = 8; });
  }
  bad(snapshot(), x => { x.grants[0].spaceId = 'other'; });
});
for (const [name, mutate] of [
  ['distinct streams sharing a global source revision', x => { x.grants[0].heads.space.revision = x.grants[0].heads.credential.revision; }],
  ['distinct streams sharing a source event ID', x => { x.grants[0].heads.space.eventId = x.grants[0].heads.credential.eventId; }],
  ['outer snapshot reusing a dependency source event ID', x => { x.eventId = x.grants[0].heads.credential.eventId; }],
]) for (const direction of ['encode', 'decode']) test('source identity rejects ' + name + ' through ' + direction, () => {
  const baseline = snapshot();
  // Unique source identities with different revisions 1, 5, 6, 7 are valid.
  roundTrip(baseline);
  const value = clone(baseline); mutate(value);
  if (direction === 'encode') invalid(value);
  else invalidBytes(utf8.encode(JSON.stringify(value)));
});
test('exact stream identities repeat across grants while independent streams may share a source digest', () => {
  const value = snapshot(true); addIdentity(value, 'bob'); addCredential(value, 2);
  for (const key of ['subjects', 'emails', 'organization', 'membership', 'space', 'target']) assert.deepEqual(value.grants[0].heads[key], value.grants[1].heads[key]);
  assert.notEqual(value.grants[0].heads.credential.revision, value.grants[1].heads.credential.revision);
  assert.notEqual(value.grants[0].heads.credential.eventId, value.grants[1].heads.credential.eventId);
  assert.equal(value.grants[0].heads.credential.payloadSha256, value.grants[1].heads.credential.payloadSha256);
  roundTrip(value);
});
test('disabled, deselected, revoked, expired or unverified dependencies cannot yield a grant', () => {
  for (const [collection, field] of [
    ['accounts', 'disabledAtMs'], ['organizations', 'disabledAtMs'], ['spaces', 'disabledAtMs'],
    ['memberships', 'revokedAtMs'], ['emails', 'revokedAtMs'], ['credentials', 'revokedAtMs'], ['grants', 'revokedAtMs'],
  ]) for (const at of [0, 1000, 999999]) bad(snapshot(true), x => { x[collection][0][field] = at; });
  bad(snapshot(), x => { x.selected = false; });
  for (const collection of ['credentials', 'memberships', 'grants']) for (const at of [0, 999, 1000]) bad(snapshot(true), x => { x[collection][0].expiresAtMs = at; });
  bad(snapshot(true), x => { x.emails[0].verifiedAtMs = 1001; });
  for (const at of [79999, 80001, 90000]) bad(snapshot(true), x => { x.grants[0].expiresAtMs = at; });
  bad(snapshot(), x => { x.grants[0].expiresAtMs = 89999; });
  const value = snapshot(true); value.credentials[0].expiresAtMs = 1001; value.grants[0].expiresAtMs = 1001; roundTrip(value);
});
test('Space ownership XOR, exact Seoul policy and sensitivity-tag dependency are closed', () => {
  for (const mutate of [
    x => { x.spaces = []; }, x => x.spaces.push(clone(x.spaces[0])), x => { x.spaceId = 'other'; },
    x => { x.spaces[0].accountId = null; }, x => { x.spaces[0].organizationId = 'org:one'; },
  ]) bad(snapshot(), mutate);
  for (const [key, value] of Object.entries({ policyVersion: 2, residency: 'global', profile: 'other', processingBoundary: 'any', dataClass: 'public', classificationStatus: 'inferred', placementEpoch: 2 })) bad(snapshot(), x => { x.spaces[0].policy[key] = value; });
  const value = snapshot(); value.spaces[0].policy.sensitivityTags = ['clinical-origin', 'credential', 'government-id', 'health']; roundTrip(value);
  for (const tags of [['clinical-origin'], ['health', 'credential'], ['health', 'health'], ['other']]) bad(value, x => { x.spaces[0].policy.sensitivityTags = tags; });
  bad(value, x => { x.spaces[0].policy.retentionDays = 30; });
});
test('canonical identifiers, subjects, addresses, UUID and digests reject ambiguous encodings', () => {
  for (const badId of ['', '-bad', '한', 'bad id', 'a'.repeat(257)]) bad(snapshot(), x => { x.accounts[0].id = badId; });
  for (const subject of ['', ' \n ', 'x\0y', '\ud800', '\udc00', 'a'.repeat(513)]) bad(snapshot(), x => { x.providerIdentities[0].subject = subject; });
  for (const address of ['ALICE@example.com', ' alice@example.com', 'a..b@example.com', 'a@localhost', 'a@-example.com', 'a\nb@example.com', 'é@example.com', 'a'.repeat(65) + '@example.com']) bad(snapshot(true), x => { x.emails[0].address = address; });
  for (const badDigest of ['A'.repeat(64), 'g'.repeat(64), 'f'.repeat(63), 'raw-pat']) bad(snapshot(), x => { x.credentials[0].tokenDigest = badDigest; });
  for (const badUuid of [eventId.toUpperCase(), 'bad', eventId + ' ']) bad(snapshot(), x => { x.eventId = badUuid; });
  for (const [key, value] of [['version', 2], ['kind', 'snapshot'], ['issuer', issuer + '/'], ['selected', 1]]) bad(snapshot(), x => { x[key] = value; });
  bad(snapshot(), x => { x.credentials[0].token = 'private-data'; });
});
test('unique digests, live emails and live organization/account memberships cannot alias distinct IDs', () => {
  const value = snapshot(true); addCredential(value, 2);
  bad(value, x => { x.credentials[1].tokenDigest = x.credentials[0].tokenDigest; });
  const alias = clone(value);
  alias.emails.push({ ...alias.emails[0], id: 'email:two' });
  alias.memberships.push({ ...alias.memberships[0], id: 'membership:two', emailId: 'email:two' });
  Object.assign(alias.credentials[1], { membershipId: 'membership:two', emailId: 'email:two' });
  alias.grants[1].heads.membership = head('membership', 'membership:two', ++alias.sourceRevision);
  invalid(alias);
  alias.emails[1].address = 'bob@example.com'; alias.grants[1].heads.emails = [head('email', emailKey('alice', 'bob@example.com'), ++alias.sourceRevision)];
  invalid(alias);
});
test('numeric and lease boundaries reject negative zero, fractions, overflow and incorrect duration', () => {
  for (const key of ['sourceRevision', 'snapshotSeq']) for (const number of [-0, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) bad(snapshot(), x => { x[key] = number; });
  for (const number of [-0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    bad(snapshot(), x => { x.lease.issuedAtMs = number; });
    bad(snapshot(), x => { x.providerIdentities[0].createdAtMs = number; });
    bad(snapshot(), x => { x.accounts[0].disabledAtMs = number; });
  }
  for (const duration of [0, 59999, 60001]) bad(snapshot(), x => { x.lease.expiresAtMs = x.lease.issuedAtMs + duration; });
  const value = emptySnapshot();
  value.sourceRevision = Number.MAX_SAFE_INTEGER; value.snapshotSeq = Number.MAX_SAFE_INTEGER;
  value.lease = { issuedAtMs: Number.MAX_SAFE_INTEGER - 60000, expiresAtMs: Number.MAX_SAFE_INTEGER }; roundTrip(value);
  value.lease.issuedAtMs++; invalid(value);
  const zero = snapshot(); zero.lease = { issuedAtMs: 0, expiresAtMs: 60000 }; roundTrip(zero);
});
test('records and dense arrays reject hidden data, symbols, accessors and custom serialization without invoking it', () => {
  let invoked = 0;
  const malicious = { get() { invoked++; throw Error('private-data'); } };
  for (const locate of [x => x, x => x.accounts[0], x => x.grants[0].heads, x => x.grants[0].heads.subjects[0], x => x.spaces[0].policy]) {
    for (const descriptor of [{ value: 'private-data', enumerable: false }, { ...malicious, enumerable: true }]) {
      const value = snapshot(); Object.defineProperty(locate(value), 'extra', descriptor); invalid(value);
    }
    const value = snapshot(); locate(value)[Symbol('private-data')] = 'private-data'; invalid(value);
    const serial = snapshot(); locate(serial).toJSON = () => { invoked++; return {}; }; invalid(serial);
  }
  for (const locate of [x => x.accounts, x => x.grants[0].heads.subjects, x => x.credentialPolicies[0].capabilities]) {
    const sparse = snapshot(); delete locate(sparse)[0]; invalid(sparse);
    const accessor = snapshot(); Object.defineProperty(locate(accessor), '0', { ...malicious, enumerable: true }); invalid(accessor);
    const extra = snapshot(); locate(extra).extra = true; invalid(extra);
    const hidden = snapshot(); Object.defineProperty(locate(hidden), 'extra', { value: true }); invalid(hidden);
    const inherited = snapshot(); Object.setPrototypeOf(locate(inherited), null); invalid(inherited);
  }
  const inherited = snapshot(); Object.setPrototypeOf(inherited.accounts[0], { extra: 1 }); invalid(inherited);
  const nullPrototype = snapshot(); Object.setPrototypeOf(nullPrototype, null); Object.setPrototypeOf(nullPrototype.accounts[0], null);
  assert.deepEqual(decode(encode(nullPrototype)), snapshot());
  assert.equal(invoked, 0);
});
test('exact field sets reject omissions and additions at every distinct schema row', () => {
  for (const locate of [x => x, x => x.accounts[0], x => x.providerIdentities[0], x => x.emails[0], x => x.organizations[0], x => x.memberships[0], x => x.credentials[0], x => x.credentialPolicies[0], x => x.spaces[0], x => x.spaces[0].policy, x => x.grants[0], x => x.grants[0].heads, x => x.grants[0].heads.subjects[0], x => x.lease]) {
    const base = snapshot(true);
    for (const key of Object.keys(locate(base))) bad(base, x => { delete locate(x)[key]; });
    bad(base, x => { locate(x).privateData = 'private-data'; });
  }
});
test('decode rejects duplicate keys, unknown fields, BOM, whitespace and alternative JSON syntax', () => {
  for (const text of [
    '', 'null', '[]', '{private-data', ' ' + emptyWire, emptyWire + '\n', '\ufeff' + emptyWire,
    emptyWire.replace('"version":3', '"version":3,"version":3'),
    emptyWire.replace('"version":3', '"version":3,"\\u0076ersion":3'),
    emptyWire.replace('"disabledAtMs":null', '"disabledAtMs":null,"disabledAtMs":null'),
    emptyWire.replace('"version":3', '"version":3.0'), emptyWire.replace('"sourceRevision":7', '"sourceRevision":7e0'),
    emptyWire.replace('"createdAtMs":0', '"createdAtMs":-0'),
    emptyWire.replace('alice', '\\u0061lice'), emptyWire.replace('https://', 'https:\\/\\/'),
    emptyWire.replace('"version":3,"kind":"seoul-authority-snapshot"', '"kind":"seoul-authority-snapshot","version":3'),
    emptyWire.replace('"version":3', '"version":3,"privateData":"secret"'),
  ]) invalidBytes(utf8.encode(text));
  for (const bytes of [[0xff], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) invalidBytes(new Uint8Array(bytes));
});
test('decoder requires intrinsic Uint8Array brand and copies the exact selected view without custom getters', () => {
  let invoked = 0;
  const bytes = utf8.encode(emptyWire);
  Object.defineProperty(bytes, 'byteLength', { get() { invoked++; return 0; } });
  Object.defineProperty(bytes, Symbol.iterator, { value: function* () { invoked++; yield 0; } });
  assert.deepEqual(decode(bytes), emptySnapshot());
  for (const Type of [Int8Array, Uint8ClampedArray, Uint16Array, Float32Array, BigInt64Array]) {
    const fake = new Type(10); Object.setPrototypeOf(fake, Uint8Array.prototype);
    Object.defineProperty(fake, Symbol.toStringTag, { get() { invoked++; return 'Uint8Array'; } }); invalidBytes(fake);
  }
  const proxy = new Proxy(bytes, { get() { invoked++; throw Error('private-data'); }, getPrototypeOf() { invoked++; return Uint8Array.prototype; } });
  const revoked = Proxy.revocable(bytes, {}); revoked.revoke();
  for (const fake of [proxy, revoked.proxy, {}, [], null, emptyWire, new ArrayBuffer(4), new DataView(new ArrayBuffer(4)), Object.create(Uint8Array.prototype)]) invalidBytes(fake);
  const padded = Buffer.concat([Buffer.from([0]), Buffer.from(emptyWire), Buffer.from([0])]);
  assert.deepEqual(decode(padded.subarray(1, -1)), emptySnapshot());
  const foreign = runInNewContext('new Uint8Array([0, ...data, 0]).subarray(1, -1)', { data: Array.from(utf8.encode(emptyWire)) });
  assert.deepEqual(decode(foreign), emptySnapshot());
  class Bytes extends Uint8Array {}
  assert.deepEqual(decode(new Bytes(utf8.encode(emptyWire))), emptySnapshot());
  assert.equal(invoked, 0);
});
test('envelope and defensive collection bounds reject oversized objects and bytes without truncation', () => {
  invalidBytes(new Uint8Array(128 * 1024 + 1));
  const oversized = new Uint8Array(128 * 1024 + 1); Object.defineProperty(oversized, 'byteLength', { value: 1 }); invalidBytes(oversized);
  const value = emptySnapshot();
  value.providerIdentities = Array.from({ length: 400 }, (_, i) => ({ issuer, subject: String(i).padStart(3, '0') + '가'.repeat(509), accountId: 'account:one', createdAtMs: 0 }));
  invalid(value);
  bad(emptySnapshot(), x => { x.accounts = Array.from({ length: 201 }, (_, i) => ({ id: 'a' + String(i).padStart(3, '0'), disabledAtMs: null })); });
  bad(emptySnapshot(), x => { x.emails = new Array(128 * 1024 + 1); });
  const manyCredentials = snapshot();
  for (let i = 1; i <= 100; i++) addCredential(manyCredentials, i);
  invalid(manyCredentials);
  // >200 identities is allowed when the complete owner graph fits the byte bound.
  const manyIdentities = emptySnapshot();
  manyIdentities.providerIdentities = Array.from({ length: 201 }, (_, i) => ({ issuer, subject: 's' + String(i).padStart(3, '0'), accountId: 'account:one', createdAtMs: 0 }));
  roundTrip(manyIdentities);
});
test('100 compact credentials remain representable near the envelope boundary', t => {
  function compact(count) {
    const value = emptySnapshot();
    value.spaceId = 's'; value.sourceRevision = count + 3;
    value.accounts = [{ id: 'a', disabledAtMs: null }];
    value.providerIdentities = [{ issuer, subject: 'u', accountId: 'a', createdAtMs: 0 }];
    Object.assign(value.spaces[0], { id: 's', accountId: 'a' });
    value.lease = { issuedAtMs: 0, expiresAtMs: 60000 };
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const ids = Array.from({ length: count }, (_, index) => index < 62 ? alphabet[index] : '0' + alphabet[index - 62]).sort();
    for (let index = 0; index < count; index++) {
      const id = ids[index];
      value.credentials.push({ id, accountId: 'a', kind: 'personal_key', permission: 'read', tokenDigest: index.toString(16).padStart(64, '0'), membershipId: null, emailId: null, expiresAtMs: 1, revokedAtMs: null });
      value.credentialPolicies.push({ credentialId: id, capabilities: ['read'], spaceIds: null });
      value.grants.push({ credentialId: id, accountId: 'a', spaceId: 's', provenance: 'owner', canIngest: false, canSearch: true, canErase: false, canRetire: false, expiresAtMs: 1, revokedAtMs: null, heads: { subjects: [head('subject', subjectKey('u'), 1)], emails: null, organization: null, membership: null, credential: head('credential', id, index + 4), space: head('space', 's', 2), target: head('target', 's', 3) } });
    }
    return value;
  }
  const allowed = compact(100), denied = compact(101);
  const allowedBytes = utf8.encode(JSON.stringify(allowed)), deniedBytes = utf8.encode(JSON.stringify(denied));
  assert.ok(allowedBytes.length < 128 * 1024, String(allowedBytes.length));
  // Even with all 62 legal one-character IDs and minimal two-character IDs,
  // the 101-key graph exceeds the byte cap; this is not a count-only failure.
  assert.ok(deniedBytes.length > 128 * 1024, String(deniedBytes.length));
  t.diagnostic('canonical bytes: 100 credentials=' + allowedBytes.length + ', 101 credentials=' + deniedBytes.length);
  roundTrip(allowed);
  invalid(denied); invalidBytes(deniedBytes);
});
test('exact 128 KiB canonical envelopes are accepted and one extra valid identity byte is refused', () => {
  const value = emptySnapshot();
  value.providerIdentities = Array.from({ length: 250 }, (_, i) => ({ issuer, subject: 's' + String(i).padStart(3, '0'), accountId: 'account:one', createdAtMs: 0 }));
  let remaining = 128 * 1024 - utf8.encode(JSON.stringify(value)).length;
  for (const identity of value.providerIdentities) {
    const fill = Math.min(508, remaining); identity.subject += 'x'.repeat(fill); remaining -= fill;
  }
  assert.equal(remaining, 0);
  const expected = utf8.encode(JSON.stringify(value));
  assert.equal(expected.length, 128 * 1024);
  assert.deepEqual(encode(value), expected);
  assert.deepEqual(decode(expected), value);
  value.providerIdentities.at(-1).subject += 'x';
  assert.equal(utf8.encode(JSON.stringify(value)).length, 128 * 1024 + 1);
  invalid(value); invalidBytes(utf8.encode(JSON.stringify(value)));
});

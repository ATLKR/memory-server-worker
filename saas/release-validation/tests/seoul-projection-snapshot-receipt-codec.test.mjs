import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { encodeSeoulSnapshotReceipt as encode, decodeSeoulSnapshotReceipt as decode, verifySeoulSnapshotReceiptForEvent as verify } from '../../src/release/seoul-projection-snapshot-receipt-codec.ts';
import { encodeSeoulAuthoritySnapshot as encodeSnapshot } from '../../src/release/seoul-projection-snapshot-codec.ts';
import { encodeSeoulHeadReceipt, decodeSeoulHeadReceipt } from '../../src/release/seoul-projection-head-receipt-codec.ts';
import { encodeSeoulHeadEvent } from '../../src/release/seoul-projection-head-codec.ts';

const issuer = 'https://auth-api.allen.company', eventId = 'fedcba98-7654-4321-8fed-cba987654321';
const sourceId = n => '01234567-89ab-4cde-8fab-' + n.toString(16).padStart(12, '0'), digest = '0123456789abcdef'.repeat(4);
const utf8 = new TextEncoder(), text = bytes => new TextDecoder().decode(bytes), copy = x => structuredClone(x);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const head = (kind, key, revision) => ({ kind, key, revision, eventId: sourceId(revision), payloadSha256: digest });
const pairs = [
 ['applied', 'snapshot_applied'], ['applied', 'empty_snapshot_applied'],
 ['dependency_pending', 'dependency_head_missing'], ['dependency_pending', 'dependency_head_behind'], ['dependency_pending', 'provisioning_missing'], ['dependency_pending', 'retained_row_disposition_missing'],
 ['snapshot_superseded', 'newer_snapshot_present'], ['snapshot_superseded', 'newer_dependency_present'], ['snapshot_superseded', 'terminal_identity_denied'], ['snapshot_superseded', 'lifecycle_denied'], ['snapshot_superseded', 'target_deselected'], ['snapshot_superseded', 'lease_expired'], ['snapshot_superseded', 'lease_issued_in_future'], ['snapshot_superseded', 'authority_expired'],
 ['conflict', 'snapshot_sequence_conflict'], ['conflict', 'source_identity_conflict'], ['conflict', 'immutable_entity_conflict'], ['conflict', 'provisioning_conflict'], ['conflict', 'retained_row_disposition_conflict'],
];
const pair = reason => pairs.find(p => p[1] === reason);
const emptyReasons = ['empty_snapshot_applied', 'newer_snapshot_present', 'lease_expired', 'lease_issued_in_future', 'snapshot_sequence_conflict'];
const livePositiveReasons = ['snapshot_applied', 'dependency_head_missing', 'dependency_head_behind', 'provisioning_missing', 'retained_row_disposition_missing', 'newer_dependency_present', 'terminal_identity_denied', 'lifecycle_denied', 'target_deselected', 'immutable_entity_conflict', 'provisioning_conflict', 'retained_row_disposition_conflict'];
const EMPTY_EVENT = '{"version":3,"kind":"seoul-authority-snapshot","eventId":"fedcba98-7654-4321-8fed-cba987654321","sourceRevision":7,"snapshotSeq":1,"issuer":"https://auth-api.allen.company","spaceId":"space:one","selected":true,"accounts":[{"id":"account:one","disabledAtMs":null}],"providerIdentities":[{"issuer":"https://auth-api.allen.company","subject":"alice","accountId":"account:one","createdAtMs":0}],"emails":[],"organizations":[],"memberships":[],"credentials":[],"credentialPolicies":[],"spaces":[{"id":"space:one","accountId":"account:one","organizationId":null,"disabledAtMs":null,"policy":{"policyVersion":1,"residency":"kr-seoul","profile":"kr-primary-storage","processingBoundary":"approved-processors","dataClass":"personal","classificationStatus":"declared","sensitivityTags":[],"placementEpoch":1}}],"grants":[],"lease":{"issuedAtMs":1000,"expiresAtMs":61000}}';
function snapshot(positive = true, organization = false) {
 const s = JSON.parse(EMPTY_EVENT); if (!positive) return s;
 if (organization) {
  s.emails = [{ id: 'email:one', accountId: 'account:one', address: 'alice@example.com', verifiedAtMs: 0, revokedAtMs: null }];
  s.organizations = [{ id: 'org:one', disabledAtMs: null }]; s.memberships = [{ id: 'membership:one', accountId: 'account:one', emailId: 'email:one', organizationId: 'org:one', role: 'admin', expiresAtMs: 80000, revokedAtMs: null }];
  s.spaces[0].accountId = null; s.spaces[0].organizationId = 'org:one';
 }
 s.credentials = [{ id: 'credential:one', accountId: 'account:one', kind: organization ? 'api_key' : 'personal_key', permission: 'write', tokenDigest: digest, membershipId: organization ? 'membership:one' : null, emailId: organization ? 'email:one' : null, expiresAtMs: 90000, revokedAtMs: null }];
 s.credentialPolicies = [{ credentialId: 'credential:one', capabilities: ['create', 'read'], spaceIds: null }];
 s.grants = [{ credentialId: 'credential:one', accountId: 'account:one', spaceId: 'space:one', provenance: organization ? 'organization-member' : 'owner', canIngest: true, canSearch: true, canErase: false, canRetire: false, expiresAtMs: organization ? 80000 : 90000, revokedAtMs: null,
  heads: { subjects: [head('subject', issuer + '\nalice', 1)], emails: organization ? [head('email', issuer + '\nalice\nalice@example.com', 2)] : null, organization: organization ? head('organization', 'org:one', 3) : null, membership: organization ? head('membership', 'membership:one', 4) : null, credential: head('credential', 'credential:one', 5), space: head('space', 'space:one', 6), target: head('target', 'space:one', 7) } }];
 return s;
}
function receipt(s = snapshot(false), reason = 'empty_snapshot_applied', attemptedAtMs = 1000, eventBytes = encodeSnapshot(s)) {
 const [outcome] = pair(reason);
 return { version: 3, kind: 'seoul-projection-receipt', eventId: s.eventId, transportPayloadSha256: hash(eventBytes), sourceRevision: s.sourceRevision, eventKind: 'snapshot', spaceId: s.spaceId, snapshotSeq: s.snapshotSeq, attemptNo: 1, outcome, reason, currentHeads: [], leaseExpiresAtMs: outcome === 'applied' ? s.lease.expiresAtMs : null, attemptedAtMs };
}
const invalid = action => assert.throws(action, { message: 'seoul_snapshot_receipt_invalid' });
const mismatch = action => assert.rejects(action, { message: 'seoul_snapshot_receipt_event_mismatch' });
async function check(s, reason, attempted, allowed = true) {
 const bytes = encodeSnapshot(s), r = receipt(s, reason, attempted, bytes), response = encode(r);
 if (allowed) assert.deepEqual(await verify(response, bytes), r); else await mismatch(() => verify(response, bytes));
}
function scenario(reason, positive = true) {
 const s = snapshot(positive); let attempted = 1000;
 if (reason === 'lease_expired') attempted = 61000;
 if (reason === 'lease_issued_in_future') { s.lease = { issuedAtMs: 6000, expiresAtMs: 66000 }; attempted = 999; }
 if (reason === 'authority_expired' && positive) { s.credentials[0].expiresAtMs = 5000; s.grants[0].expiresAtMs = 5000; attempted = 5000; }
 return { s, attempted };
}

test('literal independently assembled receipt bytes and full-event SHA bind exact empty snapshot', async () => {
 const s = snapshot(false), r = receipt(s), literal = '{"version":3,"kind":"seoul-projection-receipt","eventId":"fedcba98-7654-4321-8fed-cba987654321","transportPayloadSha256":"fb123b82eded9236e886d86937de04b58bed71fc1188e1a8ae1b691f0544b7eb","sourceRevision":7,"eventKind":"snapshot","spaceId":"space:one","snapshotSeq":1,"attemptNo":1,"outcome":"applied","reason":"empty_snapshot_applied","currentHeads":[],"leaseExpiresAtMs":61000,"attemptedAtMs":1000}';
 assert.equal(hash(EMPTY_EVENT), 'fb123b82eded9236e886d86937de04b58bed71fc1188e1a8ae1b691f0544b7eb');
 assert.equal(hash(literal), 'c9916c717159e0a87d7a31c74eba96a29cdcf82a569e01294a40a271aba2feac');
 assert.equal(text(encodeSnapshot(s)), EMPTY_EVENT); assert.equal(text(encode(r)), literal); assert.deepEqual(decode(utf8.encode(literal)), r);
 assert.deepEqual(await verify(utf8.encode(literal), utf8.encode(EMPTY_EVENT)), r);
 assert.equal(text(encode(Object.fromEntries(Object.entries(r).reverse()))), literal, 'object encoding reconstructs frozen order');
});

for (const [outcome, reason] of pairs) test('closed pair and positive/empty graph semantics: ' + outcome + '/' + reason, async () => {
 const r = receipt(snapshot(false), reason); assert.deepEqual(decode(encode(r)), r);
 for (const wrong of ['applied', 'dependency_pending', 'snapshot_superseded', 'conflict', 'head_superseded']) if (wrong !== outcome) invalid(() => encode({ ...r, outcome: wrong }));
 invalid(() => encode({ ...r, leaseExpiresAtMs: outcome === 'applied' ? null : 61000 }));
 invalid(() => encode({ ...r, currentHeads: [head('space', 'space:one', 6)] }));
 const positive = scenario(reason); await check(positive.s, reason, positive.attempted, reason !== 'empty_snapshot_applied');
 for (const selected of [false, true]) { const empty = scenario(reason, false); empty.s.selected = selected; await check(empty.s, reason, empty.attempted, emptyReasons.includes(reason)); }
});

test('all receipt identities bind to actual event, while attemptNo remains an independent positive counter', async () => {
 const s = snapshot(), event = encodeSnapshot(s), r = receipt(s, 'snapshot_applied');
 for (const patch of [{ eventId: sourceId(999) }, { transportPayloadSha256: '0'.repeat(64) }, { sourceRevision: 8 }, { spaceId: 'space:other' }, { snapshotSeq: 2 }, { leaseExpiresAtMs: 61001 }]) await mismatch(() => verify(encode({ ...r, ...patch }), event));
 for (const attemptNo of [1, 2, 100, 101, Number.MAX_SAFE_INTEGER]) assert.equal((await verify(encode({ ...r, attemptNo }), event)).attemptNo, attemptNo);
 const canonicalButDifferent = copy(s); canonicalButDifferent.providerIdentities[0].createdAtMs = 1;
 await mismatch(() => verify(encode(r), encodeSnapshot(canonicalButDifferent)));
});

test('head receipt/event boundaries remain separate from snapshot receipts/events', async () => {
 const h = head('credential', 'credential:one', 7), event = encodeSeoulHeadEvent({ version: 3, kind: 'seoul-authority-head', eventId, sourceRevision: 7, issuer, head: h, effect: { type: 'entity-head', disposition: 'present' } });
 const headReceipt = { version: 3, kind: 'seoul-projection-receipt', eventId, transportPayloadSha256: hash(event), sourceRevision: 7, eventKind: 'head', spaceId: null, snapshotSeq: null, attemptNo: 1, outcome: 'applied', reason: 'head_applied', currentHeads: [h], leaseExpiresAtMs: null, attemptedAtMs: 1000 };
 const bytes = encodeSeoulHeadReceipt(headReceipt), snap = snapshot(), snapBytes = encodeSnapshot(snap), r = receipt(snap, 'snapshot_applied');
 invalid(() => encode(headReceipt)); invalid(() => decode(bytes)); assert.throws(() => decodeSeoulHeadReceipt(encode(r)), /seoul_head_receipt_invalid/);
 await mismatch(() => verify(bytes, snapBytes)); await mismatch(() => verify(encode({ ...r, transportPayloadSha256: hash(event) }), event));
 for (const reason of ['head_applied', 'head_already_current', 'newer_head_present', 'snapshot_already_current', 'anything']) invalid(() => encode({ ...r, reason }));
});

test('applied and every post-clock positive reason obey exact 0/5000/5001/expiry boundaries', async () => {
 for (const reason of livePositiveReasons) {
  const s = snapshot(); s.lease = { issuedAtMs: 5000, expiresAtMs: 65000 };
  await check(s, reason, 0); s.lease = { issuedAtMs: 5001, expiresAtMs: 65001 }; await check(s, reason, 0, false);
  s.lease = { issuedAtMs: 0, expiresAtMs: 60000 }; await check(s, reason, 0); await check(s, reason, 59999); await check(s, reason, 60000, false); await check(s, reason, 60001, false);
 }
 for (const selected of [false, true]) {
  const s = snapshot(false); s.selected = selected; s.lease = { issuedAtMs: 5000, expiresAtMs: 65000 }; await check(s, 'empty_snapshot_applied', 0);
  s.lease = { issuedAtMs: 5001, expiresAtMs: 65001 }; await check(s, 'empty_snapshot_applied', 0, false);
  await check(s, 'empty_snapshot_applied', 65000); await check(s, 'empty_snapshot_applied', 65001, false);
  s.accounts[0].disabledAtMs = 0; s.spaces[0].disabledAtMs = 0; await check(s, 'empty_snapshot_applied', 65000);
 }
});

test('clock reasons are justified by submitted data and expiry wins over later time predicates', async () => {
 for (const positive of [false, true]) {
  const s = snapshot(positive); s.lease = { issuedAtMs: 5001, expiresAtMs: 65001 };
  await check(s, 'lease_issued_in_future', 0); await check(s, 'lease_issued_in_future', 1, false); await check(s, 'lease_issued_in_future', 65001, false);
  await check(s, 'lease_expired', 65000, false); await check(s, 'lease_expired', 65001); await check(s, 'lease_expired', 65002);
  s.lease = { issuedAtMs: 0, expiresAtMs: 60000 }; await check(s, 'lease_issued_in_future', 0, false); await check(s, 'lease_expired', 0, false);
 }
 const s = snapshot(); s.credentials[0].expiresAtMs = 5000; s.grants[0].expiresAtMs = 5000;
 await check(s, 'authority_expired', 4999, false); await check(s, 'authority_expired', 5000); await check(s, 'authority_expired', 5001); await check(s, 'authority_expired', 61000, false);
});

test('each exact credential/member grant deadline applies; no subset is silently filtered', async () => {
 for (const organization of [false, true]) {
  const s = snapshot(true, organization); const deadline = organization ? s.memberships[0] : s.credentials[0]; deadline.expiresAtMs = 5000; s.grants[0].expiresAtMs = 5000;
  for (const reason of livePositiveReasons) { await check(s, reason, 4999); await check(s, reason, 5000, false); }
  await check(s, 'authority_expired', 5000);
 }
 const s = snapshot(), id = 'credential:two';
 s.credentials.push({ ...s.credentials[0], id, tokenDigest: 'f'.repeat(64), expiresAtMs: 5000 }); s.credentialPolicies.push({ ...copy(s.credentialPolicies[0]), credentialId: id });
 s.grants.push({ ...copy(s.grants[0]), credentialId: id, expiresAtMs: 5000 }); s.grants[1].heads.credential = head('credential', id, 8); s.sourceRevision = 8;
 await check(s, 'authority_expired', 5000); for (const reason of livePositiveReasons) await check(s, reason, 5000, false);
});

test('pre-clock sequence/source observations do not invent currentness or live-clock requirements', async () => {
 for (const positive of [false, true]) for (const reason of ['snapshot_sequence_conflict', 'newer_snapshot_present', 'source_identity_conflict']) {
  const s = snapshot(positive); s.lease = { issuedAtMs: 6000, expiresAtMs: 66000 };
  for (const attempted of [0, 66000, Number.MAX_SAFE_INTEGER]) await check(s, reason, attempted, positive || reason !== 'source_identity_conflict');
 }
});

test('safe integer edge uses bounded differences and original signed expiry', async () => {
 const max = Number.MAX_SAFE_INTEGER, s = snapshot(); s.lease = { issuedAtMs: max - 60000, expiresAtMs: max }; s.sourceRevision = max; s.snapshotSeq = max;
 s.credentials[0].expiresAtMs = max; s.grants[0].expiresAtMs = max;
 await check(s, 'snapshot_applied', max - 65000); await check(s, 'snapshot_applied', max - 65001, false); await check(s, 'lease_issued_in_future', max - 65001);
 await check(s, 'snapshot_applied', max - 1); await check(s, 'snapshot_applied', max, false); await check(s, 'lease_expired', max);
 s.credentials[0].expiresAtMs = max - 1; s.grants[0].expiresAtMs = max - 1; await check(s, 'authority_expired', max - 1);
 await check(s, 'source_identity_conflict', 0);
});

test('full reviewed snapshot validation precedes claims about binding or deadlines', async () => {
 for (const mutate of [s => s.selected = false, s => s.grants[0].expiresAtMs--, s => s.grants[0].heads.credential.eventId = s.eventId, s => s.credentials[0].accountId = 'wrong', s => s.lease.expiresAtMs++, s => s.grants[0].heads.subjects = []]) {
  const s = snapshot(); mutate(s); const bytes = utf8.encode(JSON.stringify(s)), r = receipt(s, 'snapshot_applied', 1000, bytes); await mismatch(() => verify(encode(r), bytes));
 }
});

test('all structural numeric/string domains are closed, safe and sanitized', () => {
 const r = receipt();
 for (const field of ['sourceRevision', 'snapshotSeq', 'attemptNo', 'leaseExpiresAtMs', 'attemptedAtMs']) for (const bad of [-0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) invalid(() => encode({ ...r, [field]: bad }));
 for (const field of ['sourceRevision', 'snapshotSeq', 'attemptNo']) invalid(() => encode({ ...r, [field]: 0 }));
 for (const field of ['eventId', 'transportPayloadSha256']) for (const bad of ['', 'a', 'A'.repeat(field === 'eventId' ? 36 : 64), '\ud800']) invalid(() => encode({ ...r, [field]: bad }));
 for (const spaceId of ['', 'a'.repeat(129), ' space', '가', 'a/b', 'a\n', '\0', '\ud800', '_space']) invalid(() => encode({ ...r, spaceId }));
 for (const spaceId of ['s', 'a'.repeat(128), 'a.b:c_d-0']) assert.equal(decode(encode({ ...r, spaceId })).spaceId, spaceId);
 for (const patch of [{ version: 2 }, { kind: 'receipt' }, { eventKind: 'head' }, { spaceId: null }, { snapshotSeq: null }]) invalid(() => encode({ ...r, ...patch }));
});

test('independent closed-field maximum is small; reject huge input without stringify or element reads', t => {
 let maximum = 0;
 for (const [outcome, reason] of pairs) { const r = { ...receipt(snapshot(false), reason), sourceRevision: Number.MAX_SAFE_INTEGER, snapshotSeq: Number.MAX_SAFE_INTEGER, attemptNo: Number.MAX_SAFE_INTEGER, attemptedAtMs: Number.MAX_SAFE_INTEGER, spaceId: 'x'.repeat(128), leaseExpiresAtMs: outcome === 'applied' ? Number.MAX_SAFE_INTEGER : null }; maximum = Math.max(maximum, encode(r).length); }
 assert.ok(maximum < 1024); t.diagnostic('largest closed receipt fixture bytes: ' + maximum);
 let calls = 0; const stringify = JSON.stringify; JSON.stringify = () => { calls++; throw Error('private'); };
 try { invalid(() => encode({ ...receiptWithoutEncoding(), spaceId: 'x'.repeat(1000000) })); invalid(() => encode({ ...receiptWithoutEncoding(), currentHeads: Array(1000000) })); }
 finally { JSON.stringify = stringify; }
 assert.equal(calls, 0);
});
function receiptWithoutEncoding() { return { version: 3, kind: 'seoul-projection-receipt', eventId, transportPayloadSha256: digest, sourceRevision: 7, eventKind: 'snapshot', spaceId: 's', snapshotSeq: 1, attemptNo: 1, outcome: 'applied', reason: 'empty_snapshot_applied', currentHeads: [], leaseExpiresAtMs: 61000, attemptedAtMs: 1000 }; }

test('strict object/empty-array own descriptors reject getters, symbols, extras and revoked proxies', () => {
 let calls = 0;
 const getter = receipt(); Object.defineProperty(getter, 'reason', { enumerable: true, get() { calls++; return 'empty_snapshot_applied'; } }); invalid(() => encode(getter));
 for (const alter of [r => r.extra = 1, r => r[Symbol()] = 1, r => Object.defineProperty(r, 'hidden', { value: 1 }), r => Object.setPrototypeOf(r, {}), r => r.toJSON = () => { calls++; return {}; }]) { const r = receipt(); alter(r); invalid(() => encode(r)); }
 assert.deepEqual(decode(encode(Object.assign(Object.create(null), receipt()))), receipt());
 const accessor = []; Object.defineProperty(accessor, '0', { enumerable: true, get() { calls++; return {}; } });
 for (const value of [null, {}, Array(1), accessor, Object.assign([], { extra: 1 }), Object.assign([], { [Symbol()]: true }), Object.assign([], { toJSON() { calls++; return []; } }), Object.setPrototypeOf([], {})]) invalid(() => encode({ ...receipt(), currentHeads: value }));
 for (const value of [receipt(), []]) { const p = Proxy.revocable(value, {}); p.revoke(); invalid(() => encode(Array.isArray(value) ? { ...receipt(), currentHeads: p.proxy } : p.proxy)); }
 invalid(() => encode(new Proxy(receipt(), { ownKeys() { throw Error('private'); } })));
 assert.equal(calls, 0);
});

test('canonical equality rejects duplicates, escaped duplicates, alternate spellings and malformed UTF8', () => {
 const raw = text(encode(receipt()));
 for (const value of [raw + '\n', '\ufeff' + raw, raw.replace('"version":3', '"version":3,"version":3'), raw.replace('"version":3', '"version":3,"\\u0076ersion":3'), raw.replace('"snapshotSeq":1', '"snapshotSeq":1.0'), raw.replace('"attemptNo":1', '"attemptNo":1e0'), raw.replace('"attemptedAtMs":1000', '"attemptedAtMs":-0'), raw.replace('space:one', 'space\\u003aone'), JSON.stringify(Object.fromEntries(Object.entries(receipt()).reverse()))]) invalid(() => decode(utf8.encode(value)));
 for (const bytes of [new Uint8Array(), Uint8Array.of(0xff), Uint8Array.of(0xc0, 0xaf), Uint8Array.of(0xed, 0xa0, 0x80)]) invalid(() => decode(bytes));
});

test('a matching hash cannot authorize noncanonical event bytes or malformed receipt bytes', async () => {
 const s = snapshot(false);
 for (const raw of [EMPTY_EVENT + ' ', '\ufeff' + EMPTY_EVENT, EMPTY_EVENT.replace('"version":3', '"version":3,"\\u0076ersion":3'), EMPTY_EVENT.replace('"snapshotSeq":1', '"snapshotSeq":1.0'), EMPTY_EVENT.replace('alice', '\\u0061lice')]) {
  const bytes = utf8.encode(raw), r = receipt(s, 'empty_snapshot_applied', 1000, bytes); await mismatch(() => verify(encode(r), bytes));
 }
 for (const patch of [{ reason: 'private arbitrary reason' }, { eventKind: 'head' }, { currentHeads: [head('space', 'space:one', 1)] }, { extra: 'private' }]) {
  const raw = utf8.encode(JSON.stringify({ ...receipt(s), ...patch })); await mismatch(() => verify(raw, utf8.encode(EMPTY_EVENT)));
 }
});

test('own both selected byte views before await; genuine subclasses/Buffer/cross-realm supported', async () => {
 const s = snapshot(), event = encodeSnapshot(s), r = receipt(s, 'snapshot_applied'), response = encode(r), pending = verify(response, event); response.fill(0); event.fill(0); assert.deepEqual(await pending, r);
 const raw = encode(r), padded = Buffer.concat([Buffer.from('prefix'), Buffer.from(raw), Buffer.from('suffix')]), selected = padded.subarray(6, padded.length - 6); let calls = 0;
 for (const key of ['byteLength', 'buffer', 'byteOffset']) Object.defineProperty(selected, key, { get() { calls++; throw Error('private'); } }); selected[Symbol.iterator] = () => { calls++; throw Error('private'); };
 assert.deepEqual(decode(selected), r); class Bytes extends Uint8Array { slice() { throw Error('private'); } } assert.deepEqual(decode(new Bytes(raw)), r);
 const foreign = runInNewContext('Uint8Array.from(' + JSON.stringify([...raw]) + ')'); assert.deepEqual(decode(foreign), r);
 const canonicalEvent = encodeSnapshot(s), eventPadded = Buffer.concat([Buffer.from('xx'), Buffer.from(canonicalEvent), Buffer.from('yy')]), eventSelected = eventPadded.subarray(2, eventPadded.length - 2);
 Object.defineProperty(eventSelected, 'byteLength', { get() { calls++; throw Error('private'); } }); eventSelected[Symbol.iterator] = () => { calls++; throw Error('private'); };
 assert.deepEqual(await verify(selected, eventSelected), r);
 const foreignEvent = runInNewContext('Uint8Array.from(' + JSON.stringify([...canonicalEvent]) + ')'); assert.deepEqual(await verify(foreign, foreignEvent), r); assert.equal(calls, 0);
 const view = raw.subarray(0); const decoded = decode(view); view.fill(0); assert.deepEqual(decoded, r);
});

test('intrinsic byte brand rejects every proxy/wider/fake/detached/out-of-bounds view', async () => {
 const s = snapshot(), event = encodeSnapshot(s), r = encode(receipt(s, 'snapshot_applied')), wide = new Uint16Array(4); Object.setPrototypeOf(wide, Uint8Array.prototype);
 const detached = new Uint8Array(8); structuredClone(detached.buffer, { transfer: [detached.buffer] });
 const backing = new ArrayBuffer(16, { maxByteLength: 32 }), outside = new Uint8Array(backing, 8, 8); backing.resize(4);
 for (const bytes of [wide, new DataView(new ArrayBuffer(8)), new Proxy(r, {}), Object.create(Uint8Array.prototype), { [Symbol.toStringTag]: 'Uint8Array' }, detached, outside]) {
  invalid(() => decode(bytes)); await mismatch(() => verify(bytes, event)); await mismatch(() => verify(r, bytes));
 }
});

test('receipt16KiB and event128KiB bounds are applied before JSON parsing', async () => {
 const r = encode(receipt()), event = utf8.encode(EMPTY_EVENT), parse = JSON.parse; let calls = 0; JSON.parse = () => { calls++; throw Error('private'); };
 try { invalid(() => decode(new Uint8Array(16385))); await mismatch(() => verify(new Uint8Array(16385), event)); await mismatch(() => verify(r, new Uint8Array(131073))); }
 finally { JSON.parse = parse; }
 assert.equal(calls, 0); invalid(() => decode(new Uint8Array(16384)));
});

function compact(count) {
 const s = snapshot(false); s.spaceId = 's'; s.sourceRevision = count + 3; s.accounts = [{ id: 'a', disabledAtMs: null }]; s.providerIdentities = [{ issuer, subject: 'u', accountId: 'a', createdAtMs: 0 }]; Object.assign(s.spaces[0], { id: 's', accountId: 'a' }); s.lease = { issuedAtMs: 0, expiresAtMs: 60000 };
 const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ids = Array.from({ length: count }, (_, i) => i < 62 ? alphabet[i] : '0' + alphabet[i - 62]).sort();
 for (let i = 0; i < count; i++) { const id = ids[i]; s.credentials.push({ id, accountId: 'a', kind: 'personal_key', permission: 'read', tokenDigest: i.toString(16).padStart(64, '0'), membershipId: null, emailId: null, expiresAtMs: 1, revokedAtMs: null }); s.credentialPolicies.push({ credentialId: id, capabilities: ['read'], spaceIds: null });
  s.grants.push({ credentialId: id, accountId: 'a', spaceId: 's', provenance: 'owner', canIngest: false, canSearch: true, canErase: false, canRetire: false, expiresAtMs: 1, revokedAtMs: null, heads: { subjects: [head('subject', issuer + '\nu', 1)], emails: null, organization: null, membership: null, credential: head('credential', id, i + 4), space: head('space', 's', 2), target: head('target', 's', 3) } }); }
 return s;
}
test('100-credential event stays bounded while receipt carries no graph; no source512-mapping ceiling', async t => {
 const s = compact(100), bytes = encodeSnapshot(s), r = receipt(s, 'snapshot_applied', 0, bytes), response = encode(r);
 assert.equal(s.grants.length, 100); assert.ok(bytes.length <= 131072); assert.ok(JSON.stringify(s.grants.map(g => g.heads.credential)).length > 16384);
 assert.deepEqual(await verify(response, bytes), r); assert.deepEqual(decode(response).currentHeads, []); assert.ok(response.length < 1024); t.diagnostic('100 credentials event bytes=' + bytes.length + ', receipt bytes=' + response.length);
 await check(s, 'authority_expired', 1);
 const empty = snapshot(false); empty.providerIdentities = Array.from({ length: 513 }, (_, i) => ({ issuer, subject: 'u' + String(i).padStart(3, '0'), accountId: 'account:one', createdAtMs: 0 })); await check(empty, 'empty_snapshot_applied', 1000);
});

test('exact128KiB canonical snapshot accepted and one extra valid identity byte refused', async () => {
 const s = snapshot(false); s.providerIdentities = Array.from({ length: 250 }, (_, i) => ({ issuer, subject: 'u' + String(i).padStart(3, '0'), accountId: 'account:one', createdAtMs: 0 }));
 let gap = 131072 - utf8.encode(JSON.stringify(s)).length; for (let i = s.providerIdentities.length - 1; i >= 0 && gap > 0; i--) { const count = Math.min(gap, 512 - s.providerIdentities[i].subject.length); s.providerIdentities[i].subject += 'x'.repeat(count); gap -= count; }
 assert.equal(gap, 0); const bytes = encodeSnapshot(s); assert.equal(bytes.length, 131072); assert.deepEqual(await verify(encode(receipt(s)), bytes), receipt(s));
 const short = s.providerIdentities.find(p => p.subject.length < 512); short.subject += 'x'; const over = utf8.encode(JSON.stringify(s)); assert.equal(over.length, 131073); await mismatch(() => verify(encode(receipt(s, 'empty_snapshot_applied', 1000, over)), over));
});

test('verification uses stored decision time and has no attempt-history/current-clock ledger', async () => {
 const s = snapshot(), event = encodeSnapshot(s), now = Date.now; Date.now = () => Number.MAX_SAFE_INTEGER;
 try {
  for (const [attemptNo, attemptedAtMs, reason] of [[2, 2000, 'dependency_head_missing'], [1, 1000, 'dependency_head_missing'], [3, 3000, 'snapshot_applied'], [4, 4000, 'snapshot_applied']]) {
   const r = { ...receipt(s, reason, attemptedAtMs, event), attemptNo }; assert.deepEqual(await verify(encode(r), event), r);
  }
 } finally { Date.now = now; }
});

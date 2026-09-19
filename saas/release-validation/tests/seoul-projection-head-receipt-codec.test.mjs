import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { encodeSeoulHeadReceipt as encode, decodeSeoulHeadReceipt as decode, verifySeoulHeadReceiptForEvent as verify } from '../../src/release/seoul-projection-head-receipt-codec.ts';
import { encodeSeoulHeadEvent, decodeSeoulHeadEvent, hashSeoulProjectionTransport } from '../../src/release/seoul-projection-head-codec.ts';

const utf8 = new TextEncoder(), text = bytes => new TextDecoder().decode(bytes);
const eventId = 'fedcba98-7654-4321-8fed-cba987654321', sourceId = '01234567-89ab-4cde-8fab-0123456789ab';
const sourceDigest = '0123456789abcdef'.repeat(4);
const transportDigest = 'b520397f27e9ad06c79d073f002fba36dada96a1af6447b7427ce832482c2cc3';
// Independently fixed literals: neither production encoder derives expectations.
const eventWire = '{"version":3,"kind":"seoul-authority-head","eventId":"fedcba98-7654-4321-8fed-cba987654321","sourceRevision":7,"issuer":"https://auth-api.allen.company","head":{"kind":"credential","key":"credential:one","revision":7,"eventId":"01234567-89ab-4cde-8fab-0123456789ab","payloadSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},"effect":{"type":"entity-head","disposition":"present"}}';
const receiptWire = '{"version":3,"kind":"seoul-projection-receipt","eventId":"fedcba98-7654-4321-8fed-cba987654321","transportPayloadSha256":"b520397f27e9ad06c79d073f002fba36dada96a1af6447b7427ce832482c2cc3","sourceRevision":7,"eventKind":"head","spaceId":null,"snapshotSeq":null,"attemptNo":1,"outcome":"applied","reason":"head_applied","currentHeads":[{"kind":"credential","key":"credential:one","revision":7,"eventId":"01234567-89ab-4cde-8fab-0123456789ab","payloadSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}],"leaseExpiresAtMs":null,"attemptedAtMs":1789257600000}';
const current = () => ({ kind: 'credential', key: 'credential:one', revision: 7, eventId: sourceId, payloadSha256: sourceDigest });
function receipt(outcome = 'applied', reason = 'head_applied') {
  return { version: 3, kind: 'seoul-projection-receipt', eventId, transportPayloadSha256: transportDigest, sourceRevision: 7, eventKind: 'head', spaceId: null, snapshotSeq: null, attemptNo: 1, outcome, reason, currentHeads: outcome === 'conflict' ? [] : [{ ...current(), revision: outcome === 'head_superseded' ? 8 : 7 }], leaseExpiresAtMs: null, attemptedAtMs: 1789257600000 };
}
function roundTrip(value) {
  const bytes = encode(value); assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(decode(bytes), value); assert.deepEqual(encode(decode(bytes)), bytes); return bytes;
}
const invalid = value => assert.throws(() => encode(value), { message: 'seoul_head_receipt_invalid' });
const invalidBytes = bytes => assert.throws(() => decode(bytes), { message: 'seoul_head_receipt_invalid' });
const mismatch = (receiptBytes, eventBytes = utf8.encode(eventWire)) => assert.rejects(() => verify(receiptBytes, eventBytes), { message: 'seoul_head_receipt_event_mismatch' });

test('literal receipt fixes all fourteen wire fields and the exact current-head field order', async () => {
  const value = receipt(), reverse = input => Object.fromEntries(Object.entries(input).reverse());
  const shuffled = reverse(value); shuffled.currentHeads = [reverse(value.currentHeads[0])];
  assert.equal(text(roundTrip(shuffled)), receiptWire);
  assert.deepEqual(decode(utf8.encode(receiptWire)), value);
  assert.equal(createHash('sha256').update(eventWire).digest('hex'), transportDigest);
  assert.equal(await hashSeoulProjectionTransport(utf8.encode(eventWire)), transportDigest);
  assert.equal(text(encodeSeoulHeadEvent(decodeSeoulHeadEvent(utf8.encode(eventWire)))), eventWire);
  assert.deepEqual(await verify(utf8.encode(receiptWire), utf8.encode(eventWire)), value);
});

for (const [outcome, reason] of [['applied', 'head_applied'], ['applied', 'head_already_current'], ['head_superseded', 'newer_head_present'], ['conflict', 'source_identity_conflict']]) {
  test('closed ' + outcome + '/' + reason + ' receipt round-trips and binds the submitted event', async () => {
    const value = receipt(outcome, reason);
    assert.deepEqual(await verify(roundTrip(value), utf8.encode(eventWire)), value);
  });
}

test('all unsupported outcome/reason pairs and future snapshot/pending variants are refused', () => {
  for (const outcome of ['applied', 'head_superseded', 'conflict', 'snapshot_superseded', 'dependency_pending', 'pending', '']) {
    for (const reason of ['head_applied', 'head_already_current', 'newer_head_present', 'source_identity_conflict', 'lease_expired', 'dependency_missing', '']) {
      if ((outcome === 'applied' && ['head_applied', 'head_already_current'].includes(reason)) || (outcome === 'head_superseded' && reason === 'newer_head_present') || (outcome === 'conflict' && reason === 'source_identity_conflict')) continue;
      invalid(receipt(outcome, reason));
    }
  }
});

test('literal head-only null fields, attempt number and safe scalar domains are enforced', () => {
  for (const patch of [{ version: 2 }, { kind: 'receipt' }, { eventKind: 'snapshot' }, { spaceId: 'space:one' }, { snapshotSeq: 1 }, { leaseExpiresAtMs: 1789257660000 }, { attemptNo: 0 }, { attemptNo: 2 }, { attemptNo: '1' }]) invalid({ ...receipt(), ...patch });
  for (const value of [-0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    invalid({ ...receipt(), sourceRevision: value }); invalid({ ...receipt(), attemptedAtMs: value });
  }
  invalid({ ...receipt(), sourceRevision: 0 });
  for (const attemptedAtMs of [0, Number.MAX_SAFE_INTEGER]) roundTrip({ ...receipt(), attemptedAtMs });
  const greatest = receipt(); greatest.sourceRevision = greatest.currentHeads[0].revision = Number.MAX_SAFE_INTEGER; roundTrip(greatest);
  for (const eventId of [sourceId.toUpperCase(), sourceId.replaceAll('-', ''), 'x', sourceId + '\n']) invalid({ ...receipt(), eventId });
  for (const transportPayloadSha256 of [sourceDigest.toUpperCase(), 'a'.repeat(63), 'g'.repeat(64), sourceDigest + '\n', null]) invalid({ ...receipt(), transportPayloadSha256 });
});

test('current observations enforce the applied/superseded revision relation but do not invent conflict semantics', async () => {
  invalid({ ...receipt(), currentHeads: [] });
  for (const revision of [6, 8]) invalid({ ...receipt(), currentHeads: [{ ...current(), revision }] });
  const superseded = receipt('head_superseded', 'newer_head_present'); invalid({ ...superseded, currentHeads: [] });
  for (const revision of [6, 7]) invalid({ ...superseded, currentHeads: [{ ...current(), revision }] });
  for (const revision of [6, 7, 8]) {
    const conflict = { ...receipt('conflict', 'source_identity_conflict'), currentHeads: [{ ...current(), revision }] };
    assert.deepEqual(await verify(roundTrip(conflict), utf8.encode(eventWire)), conflict);
  }
});

test('currentHeads is an exact dense zero-or-one array without hidden fields, accessors or iterators', () => {
  let invoked = 0;
  for (const array of [null, {}, [current(), current()], Array(1), Object.assign([], { extra: true })]) invalid({ ...receipt(), currentHeads: array });
  const accessor = [current()]; Object.defineProperty(accessor, '0', { get() { invoked++; throw new Error('private-data'); } }); invalid({ ...receipt(), currentHeads: accessor });
  for (const key of ['toJSON', 'private-data', Symbol.iterator]) {
    const array = [current()]; Object.defineProperty(array, key, { value() { invoked++; return []; } }); invalid({ ...receipt(), currentHeads: array });
  }
  const inherited = [current()]; Object.setPrototypeOf(inherited, { privateField: 'private-data' }); invalid({ ...receipt(), currentHeads: inherited });
  assert.equal(invoked, 0);
});

test('closed receipt/head own-data records reject getters, prototypes, missing and additional fields', () => {
  let invoked = 0;
  for (const locate of [value => value, value => value.currentHeads[0]]) {
    for (const key of Object.keys(locate(receipt()))) { const value = receipt(); delete locate(value)[key]; invalid(value); }
    for (const key of ['unknown', 'toJSON', 'credentials', 'grants', 'constructor', '__proto__', Symbol('private-data')]) {
      const value = receipt(); Object.defineProperty(locate(value), key, { enumerable: true, get() { invoked++; throw new Error('private-data'); } }); invalid(value);
    }
    const value = receipt(); Object.defineProperty(locate(value), 'eventId', { enumerable: true, get() { invoked++; throw new Error('private-data'); } }); invalid(value);
    const hidden = receipt(); Object.defineProperty(locate(hidden), 'private-data', { value: 'private-data' }); invalid(hidden);
    const inherited = receipt(); Object.setPrototypeOf(locate(inherited), { privateField: true }); invalid(inherited);
    const nullPrototype = receipt(); Object.setPrototypeOf(locate(nullPrototype), null); assert.deepEqual(decode(encode(nullPrototype)), receipt());
  }
  for (const value of [null, [], true, 'private-data', new Date(), Object.create(receipt())]) invalid(value);
  assert.equal(invoked, 0);
});

test('current-head validation reuses exact stream keys and opaque subjects from the committed head codec', async () => {
  for (const kind of ['subject', 'email', 'organization', 'membership', 'credential', 'space', 'target']) {
    const subject = '가'.repeat(171) + '\nalice\u0001\u007f';
    const streamKey = kind === 'subject' ? 'https://auth-api.allen.company\n' + subject : kind === 'email' ? 'https://auth-api.allen.company\n' + subject + '\na@example.com' : kind + ':one';
    const candidate = decodeSeoulHeadEvent(utf8.encode(eventWire)); Object.assign(candidate.head, { kind, key: streamKey });
    const eventBytes = encodeSeoulHeadEvent(candidate), value = receipt(); value.currentHeads = [candidate.head]; value.transportPayloadSha256 = createHash('sha256').update(eventBytes).digest('hex');
    assert.deepEqual(await verify(roundTrip(value), eventBytes), value);
  }
  for (const patch of [{ kind: 'share' }, { key: 'credential/one' }, { revision: 0 }, { eventId: 'x' }, { payloadSha256: 'digest_pending' }]) invalid({ ...receipt(), currentHeads: [{ ...current(), ...patch }] });
});

test('event binding refuses unrelated event IDs, source revisions and a source digest substituted for transport hash', async () => {
  for (const patch of [{ eventId: sourceId }, { transportPayloadSha256: sourceDigest }, { transportPayloadSha256: '1'.repeat(64) }]) await mismatch(encode({ ...receipt(), ...patch }));
  const wrongRevision = receipt(); wrongRevision.sourceRevision = wrongRevision.currentHeads[0].revision = 8; await mismatch(encode(wrongRevision));
  const another = decodeSeoulHeadEvent(utf8.encode(eventWire)); another.eventId = sourceId;
  await mismatch(encode(receipt()), encodeSeoulHeadEvent(another));
});

test('applied event binding requires the complete current source tuple, and all observations require the candidate stream', async () => {
  for (const patch of [{ eventId }, { payloadSha256: '1'.repeat(64) }]) await mismatch(encode({ ...receipt(), currentHeads: [{ ...current(), ...patch }] }));
  for (const [outcome, reason] of [['applied', 'head_applied'], ['head_superseded', 'newer_head_present'], ['conflict', 'source_identity_conflict']]) {
    for (const patch of [{ kind: 'space' }, { key: 'credential:other' }]) {
      const value = receipt(outcome, reason); value.currentHeads = [{ ...current(), revision: outcome === 'head_superseded' ? 8 : 7, ...patch }]; await mismatch(encode(value));
    }
  }
});

test('strict decode rejects malformed UTF-8, duplicate/escaped-duplicate keys and noncanonical bytes', async () => {
  for (const wire of ['', 'null', '{private-data', receiptWire + '\n', ' ' + receiptWire, '\ufeff' + receiptWire,
    receiptWire.replace('"version":3', '"version":3,"version":3'), receiptWire.replace('"version":3', '"version":3,"\\u0076ersion":3'),
    receiptWire.replace('"revision":7', '"revision":7,"revision":7'), receiptWire.replace('"version":3', '"version":3.0'),
    receiptWire.replace('"sourceRevision":7', '"sourceRevision":7e0'), receiptWire.replace('credential:one', 'credential:\\u006fne'),
    receiptWire.replace('"version":3,"kind":"seoul-projection-receipt"', '"kind":"seoul-projection-receipt","version":3'),
    receiptWire.replace('"spaceId":null', '"spaceId":"space:one"')]) {
    const bytes = utf8.encode(wire); invalidBytes(bytes); await mismatch(bytes);
  }
  for (const malformed of [[0xff], [0xc3, 0x28], [0xed, 0xa0, 0x80]]) { invalidBytes(new Uint8Array(malformed)); await mismatch(new Uint8Array(malformed)); }
});

test('event binding decodes actual canonical head events and refuses malformed or snapshot inputs', async () => {
  for (const wire of ['', eventWire + '\n', eventWire.replace('"revision":7', '"revision":8'), eventWire.replace('seoul-authority-head', 'seoul-authority-snapshot')]) await mismatch(utf8.encode(receiptWire), utf8.encode(wire));
  const snapshot = '{"version":3,"kind":"seoul-authority-snapshot","eventId":"fedcba98-7654-4321-8fed-cba987654321","sourceRevision":7,"snapshotSeq":1,"issuer":"https://auth-api.allen.company","spaceId":"space:one","selected":false,"accounts":[],"providerIdentities":[],"emails":[],"organizations":[],"memberships":[],"credentials":[],"credentialPolicies":[],"spaces":[],"grants":[],"lease":{"issuedAtMs":0,"expiresAtMs":60000}}';
  const value = receipt('conflict', 'source_identity_conflict'); value.transportPayloadSha256 = createHash('sha256').update(snapshot).digest('hex'); await mismatch(encode(value), utf8.encode(snapshot));
});

test('both submitted byte inputs are owned before the first asynchronous boundary', async () => {
  const receiptBytes = utf8.encode(receiptWire), eventBytes = utf8.encode(eventWire);
  const pending = verify(receiptBytes, eventBytes);
  receiptBytes.fill(0); eventBytes.fill(0);
  assert.deepEqual(await pending, receipt());
  const badReceipt = utf8.encode(receiptWire.replace(transportDigest, '1'.repeat(64))), laterGood = utf8.encode(receiptWire);
  const denied = verify(badReceipt, utf8.encode(eventWire)); badReceipt.set(laterGood);
  await assert.rejects(() => denied, { message: 'seoul_head_receipt_event_mismatch' });
});

test('intrinsic selected views preserve exact bytes, reject false brands and enforce 128 KiB before copying', async () => {
  const invalidViews = [null, [], 'private-data', new ArrayBuffer(1), new Uint16Array(1), new DataView(new ArrayBuffer(1)), new Proxy(utf8.encode(receiptWire), {}), new Uint8Array(128 * 1024 + 1)];
  for (const Type of [Int8Array, Uint8ClampedArray, Uint16Array, Float64Array]) { const fake = new Type(3); Object.setPrototypeOf(fake, Uint8Array.prototype); invalidViews.push(fake); }
  for (const bytes of invalidViews) { invalidBytes(bytes); await mismatch(bytes); await mismatch(utf8.encode(receiptWire), bytes); }
  invalidBytes(new Uint8Array(128 * 1024));
  let invoked = 0;
  const selected = Buffer.concat([Buffer.from([0]), Buffer.from(receiptWire), Buffer.from([0])]).subarray(1, -1);
  for (const name of ['byteLength', 'buffer', 'byteOffset', Symbol.toStringTag, Symbol.iterator]) Object.defineProperty(selected, name, { get() { invoked++; throw new Error('private-data'); } });
  assert.deepEqual(decode(selected), receipt()); assert.deepEqual(await verify(selected, utf8.encode(eventWire)), receipt()); assert.equal(invoked, 0);
  const foreign = runInNewContext('new Uint8Array([0, ...data, 0]).subarray(1, -1)', { data: Array.from(utf8.encode(receiptWire)) });
  assert.deepEqual(decode(foreign), receipt());
});

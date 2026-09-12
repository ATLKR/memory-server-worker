import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import {
  encodeSeoulHeadEvent, decodeSeoulHeadEvent, hashSeoulProjectionTransport,
} from '../../src/release/seoul-projection-head-codec.ts';

const issuer = 'https://auth-api.allen.company';
const sourceId = '01234567-89ab-4cde-8fab-0123456789ab';
const transportId = 'fedcba98-7654-4321-8fed-cba987654321';
const sourceDigest = '0123456789abcdef'.repeat(4);
const utf8 = new TextEncoder();
const string = bytes => new TextDecoder().decode(bytes);
const negativeStates = { organization: 'disabled', membership: 'revoked', credential: 'revoked', space: 'disabled', target: 'removed' };
const keyFor = kind => kind === 'subject' ? issuer + '\n알렌-subject' : kind === 'email' ? issuer + '\n알렌-subject\nalice+work@example.com' : kind + ':one';
function event(kind = 'credential', effect = { type: 'entity-head', disposition: 'present' }) {
  return {
    version: 3, kind: 'seoul-authority-head', eventId: transportId, sourceRevision: 7, issuer,
    head: { kind, key: keyFor(kind), revision: 7, eventId: sourceId, payloadSha256: sourceDigest }, effect,
  };
}
function roundTrip(value) {
  const bytes = encodeSeoulHeadEvent(value);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(decodeSeoulHeadEvent(bytes), value);
  assert.deepEqual(encodeSeoulHeadEvent(decodeSeoulHeadEvent(bytes)), bytes);
  return bytes;
}
function invalid(value) {
  assert.throws(() => encodeSeoulHeadEvent(value), { message: 'seoul_head_event_invalid' });
}
function invalidBytes(bytes) {
  assert.throws(() => decodeSeoulHeadEvent(bytes), { message: 'seoul_head_event_invalid' });
}

test('canonical output uses the fixed v3 wire key order independent of input insertion order', () => {
  const input = event();
  const shuffled = Object.fromEntries(Object.entries(input).reverse());
  shuffled.head = Object.fromEntries(Object.entries(input.head).reverse());
  shuffled.effect = Object.fromEntries(Object.entries(input.effect).reverse());
  const expected = '{"version":3,"kind":"seoul-authority-head","eventId":"fedcba98-7654-4321-8fed-cba987654321","sourceRevision":7,"issuer":"https://auth-api.allen.company","head":{"kind":"credential","key":"credential:one","revision":7,"eventId":"01234567-89ab-4cde-8fab-0123456789ab","payloadSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},"effect":{"type":"entity-head","disposition":"present"}}';
  assert.equal(string(roundTrip(shuffled)), expected);
});

for (const kind of ['subject', 'email', 'organization', 'membership', 'credential', 'space', 'target']) {
  for (const disposition of ['present', 'changed']) {
    test(kind + ' head-only ' + disposition + ' round-trips without positive authority data', () => {
      const value = event(kind, { type: 'entity-head', disposition });
      const decoded = decodeSeoulHeadEvent(roundTrip(value));
      assert.deepEqual(Object.keys(decoded.effect), ['type', 'disposition']);
    });
  }
}
for (const state of ['suspended', 'resumed', 'deleted']) {
  test('subject lifecycle ' + state + ' binds its subject and source head', () => {
    roundTrip(event('subject', { type: 'subject-lifecycle', subject: '알렌-subject', state, occurredAtMs: 1789257600000 }));
  });
}
for (const state of ['verified', 'revoked']) {
  test('email lifecycle ' + state + ' binds its canonical address and subject', () => {
    roundTrip(event('email', { type: 'email-lifecycle', subject: '알렌-subject', address: 'alice+work@example.com', state, occurredAtMs: 0 }));
  });
}
for (const [entityKind, state] of Object.entries(negativeStates)) {
  test(entityKind + ' negative ' + state + ' round-trips its exact stream key', () => {
    roundTrip(event(entityKind, { type: 'entity-negative', entityKind, entityId: keyFor(entityKind), state, occurredAtMs: Number.MAX_SAFE_INTEGER }));
  });
}

test('transport hashing preserves source identity and source digest under a new outer identity', async () => {
  const first = event();
  const second = { ...first, eventId: '11111111-2222-4333-8444-555555555555' };
  const firstBytes = roundTrip(first), secondBytes = roundTrip(second);
  const firstHash = await hashSeoulProjectionTransport(firstBytes), secondHash = await hashSeoulProjectionTransport(secondBytes);
  assert.match(firstHash, /^[a-f0-9]{64}$/);
  assert.notEqual(firstHash, secondHash);
  assert.notEqual(firstHash, sourceDigest);
  assert.deepEqual(decodeSeoulHeadEvent(firstBytes).head, decodeSeoulHeadEvent(secondBytes).head);
  assert.equal(decodeSeoulHeadEvent(secondBytes).head.eventId, sourceId);
  assert.equal(decodeSeoulHeadEvent(secondBytes).head.payloadSha256, sourceDigest);
  assert.equal(await hashSeoulProjectionTransport(utf8.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hashSeoulProjectionTransport(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await hashSeoulProjectionTransport(new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4)), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const changed = firstBytes.slice(); changed[changed.length - 1] ^= 1;
  assert.notEqual(await hashSeoulProjectionTransport(changed), firstHash);
});

test('encoding rejects missing, extra, nested secret, symbol and non-data fields without invoking them', () => {
  let invoked = 0;
  const locations = [value => value, value => value.head, value => value.effect];
  for (const locate of locations) {
    for (const extra of ['unexpected', 'toJSON', 'credential', 'grant', 'lease', 'secret', 'constructor', '__proto__']) {
      const value = event();
      Object.defineProperty(locate(value), extra, { enumerable: true, value: () => { invoked++; return 'private-data'; } });
      invalid(value);
    }
    const symbol = event(); locate(symbol)[Symbol('private-data')] = 'private-data'; invalid(symbol);
    const accessor = event(); const key = Object.keys(locate(accessor))[0];
    Object.defineProperty(locate(accessor), key, { enumerable: true, get() { invoked++; throw new Error('private-data'); } }); invalid(accessor);
    const hidden = event(); Object.defineProperty(locate(hidden), 'private-data', { value: 'private-data' }); invalid(hidden);
    for (const key of Object.keys(locate(event()))) { const missing = event(); delete locate(missing)[key]; invalid(missing); }
  }
  assert.equal(invoked, 0);
});

test('only ordinary or null-prototype own-data records cross the encoding boundary', () => {
  for (const value of [null, [], 'private-data', true, 1, new Date(), Object.create(event())]) invalid(value);
  for (const locate of [value => value, value => value.head, value => value.effect]) {
    const value = event(); Object.setPrototypeOf(locate(value), { privateField: 'private-data' }); invalid(value);
    const plain = event(); Object.setPrototypeOf(locate(plain), null);
    assert.deepEqual(decodeSeoulHeadEvent(encodeSeoulHeadEvent(plain)), event());
  }
  const throwingProxy = new Proxy(event(), { ownKeys() { throw new Error('private-data'); } }); invalid(throwingProxy);
  const cycle = event(); cycle.effect = cycle; invalid(cycle);
});

test('revision and timestamp domains reject fractions, zero revisions, negative zero and unsafe values', () => {
  for (const revision of [0, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7', null]) {
    const value = event(); value.sourceRevision = revision; value.head.revision = revision; invalid(value);
  }
  for (const sourceRevision of [6, 8]) invalid({ ...event(), sourceRevision });
  for (const occurredAtMs of [-0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    invalid(event('subject', { type: 'subject-lifecycle', subject: '알렌-subject', state: 'suspended', occurredAtMs }));
  }
  const highest = event(); highest.sourceRevision = highest.head.revision = Number.MAX_SAFE_INTEGER; roundTrip(highest);
});

test('v3 identities require the pinned issuer, exact kind, lowercase UUIDs and finalized source digests', () => {
  for (const change of [{ version: 2 }, { version: '3' }, { kind: 'seoul-authority-snapshot' }, { issuer: issuer + '/' }, { issuer: 'https://untrusted.example' }]) invalid({ ...event(), ...change });
  for (const badId of [sourceId.toUpperCase(), sourceId.replaceAll('-', ''), '{' + sourceId + '}', 'not-an-id', sourceId + '\n']) {
    invalid({ ...event(), eventId: badId });
    const value = event(); value.head.eventId = badId; invalid(value);
  }
  for (const digest of [null, 'digest_pending', sourceDigest.toUpperCase(), 'a'.repeat(63), 'g'.repeat(64), sourceDigest + '\n']) {
    const value = event(); value.head.payloadSha256 = digest; invalid(value);
  }
});

test('all stream keys are bounded and canonical with unambiguous subject/email separators', () => {
  for (const kind of ['unknown', '', 'Subject']) { const value = event(); value.head.kind = kind; invalid(value); }
  for (const key of ['', ' space', 'space ', 'space/one', 'space\none', 'a'.repeat(257), '\ud800', 'space\0one']) {
    const value = event('space'); value.head.key = key; invalid(value);
  }
  const bounded = event('space'); bounded.head.key = 'a'.repeat(256); roundTrip(bounded);
  for (const subject of ['', ' ', '\n\r\t', 'alice\0bob', '\ud800', '\udc00', 'a'.repeat(513), '가'.repeat(513), '😀'.repeat(257)]) {
    const value = event('subject'); value.head.key = issuer + '\n' + subject; invalid(value);
  }
  const maxSubject = event('subject'); maxSubject.head.key = issuer + '\n' + 'a'.repeat(512); roundTrip(maxSubject);
  for (const key of ['https://wrong.example\nalice', issuer + '/\nalice', issuer + '\n알렌-subject\nALICE@example.com', issuer + '\n알렌-subject\nalice@example.com\nextra']) {
    const value = event(key.includes('@') ? 'email' : 'subject'); value.head.key = key; invalid(value);
  }
  for (const address of ['Alice@example.com', ' alice@example.com', 'alice@example.com ', 'alice', 'a..b@example.com', '.a@example.com', 'a.@example.com', 'a@localhost', 'a@-example.com', 'a@exämple.com', 'a'.repeat(65) + '@example.com', 'a@' + 'b'.repeat(64) + '.com']) {
    const value = event('email'); value.head.key = issuer + '\n알렌-subject\n' + address; invalid(value);
  }
});

test('opaque subject text preserves the accepted multibyte, C0/DEL and code-unit domain', () => {
  const controls = Array.from({ length: 31 }, (_, index) => String.fromCharCode(index + 1)).join('') + '\u007f';
  for (const subject of ['가'.repeat(171), '가'.repeat(512), '😀'.repeat(256), 'alice\nbob', '\nalice\n', 'alice' + controls + 'bob', ' Alice ', 'é', 'e\u0301']) {
    const subjectValue = event('subject', { type: 'subject-lifecycle', subject, state: 'suspended', occurredAtMs: 1 });
    subjectValue.head.key = issuer + '\n' + subject;
    const decodedSubject = decodeSeoulHeadEvent(roundTrip(subjectValue));
    assert.equal(decodedSubject.effect.subject, subject);
    assert.equal(decodedSubject.head.key, issuer + '\n' + subject);
    const emailValue = event('email', { type: 'email-lifecycle', subject, address: 'alice@example.com', state: 'verified', occurredAtMs: 1 });
    emailValue.head.key = issuer + '\n' + subject + '\nalice@example.com';
    const decodedEmail = decodeSeoulHeadEvent(roundTrip(emailValue));
    assert.equal(decodedEmail.effect.subject, subject);
    assert.equal(decodedEmail.head.key, issuer + '\n' + subject + '\nalice@example.com');
    roundTrip({ ...subjectValue, effect: { type: 'entity-head', disposition: 'present' } });
    roundTrip({ ...emailValue, effect: { type: 'entity-head', disposition: 'changed' } });
  }
});

test('opaque subjects cannot collide through trimming, normalization or newline email decomposition', () => {
  const keys = new Set();
  for (const subject of ['alice', ' Alice ', 'Alice', 'alice\nbob', 'alice\nbob\n', 'é', 'e\u0301']) {
    const value = event('email', { type: 'email-lifecycle', subject, address: 'c@example.com', state: 'verified', occurredAtMs: 1 });
    value.head.key = issuer + '\n' + subject + '\nc@example.com';
    const decoded = decodeSeoulHeadEvent(roundTrip(value));
    assert.ok(!keys.has(decoded.head.key)); keys.add(decoded.head.key);
    assert.equal(decoded.effect.subject, subject);
  }
  const value = event('email', { type: 'email-lifecycle', subject: 'alice\nbob', address: 'c@example.com', state: 'verified', occurredAtMs: 1 });
  value.head.key = issuer + '\nalice\nbob\nc@example.com';
  roundTrip(value);
  invalid({ ...value, effect: { ...value.effect, subject: 'alice', address: 'bob\nc@example.com' } });
  invalid({ ...value, effect: { ...value.effect, subject: 'alice' } });
  invalid({ ...value, head: { ...value.head, key: issuer + '\nalice\nc@example.com' } });
  const subjectValue = event('subject', { type: 'subject-lifecycle', subject: 'alice\nbob', state: 'deleted', occurredAtMs: 1 });
  subjectValue.head.key = issuer + '\nalice\nbob'; roundTrip(subjectValue);
  invalid({ ...subjectValue, effect: { ...subjectValue.effect, subject: 'alice' } });
});

test('lifecycle effects must match their stream, canonical subject/address and closed state', () => {
  const subjectEffect = { type: 'subject-lifecycle', subject: '알렌-subject', state: 'resumed', occurredAtMs: 1 };
  const emailEffect = { type: 'email-lifecycle', subject: '알렌-subject', address: 'alice+work@example.com', state: 'verified', occurredAtMs: 1 };
  for (const kind of ['email', 'space']) invalid(event(kind, subjectEffect));
  for (const kind of ['subject', 'credential']) invalid(event(kind, emailEffect));
  invalid(event('subject', { ...subjectEffect, subject: 'another' }));
  invalid(event('subject', { ...subjectEffect, state: 'active' }));
  invalid(event('email', { ...emailEffect, subject: 'another' }));
  invalid(event('email', { ...emailEffect, address: 'another@example.com' }));
  invalid(event('email', { ...emailEffect, address: 'ALICE+WORK@example.com' }));
  invalid(event('email', { ...emailEffect, state: 'resumed' }));
});

test('entity-negative only permits the state and identity for its exact entity stream', () => {
  for (const [kind, state] of Object.entries(negativeStates)) {
    const effect = { type: 'entity-negative', entityKind: kind, entityId: keyFor(kind), state, occurredAtMs: 1 };
    invalid(event(kind, { ...effect, entityId: 'other:one' }));
    invalid(event(kind, { ...effect, entityKind: kind === 'space' ? 'organization' : 'space' }));
    for (const wrongState of ['revoked', 'disabled', 'removed', 'present'].filter(candidate => candidate !== state)) invalid(event(kind, { ...effect, state: wrongState }));
    invalid(event('subject', effect)); invalid(event('email', effect));
  }
});

test('head-only effects are closed and cannot smuggle any authority or contextual transition', () => {
  for (const disposition of ['resumed', 'verified', 'deleted', 'revoked', null]) invalid(event('subject', { type: 'entity-head', disposition }));
  for (const type of ['snapshot', 'subject-resume', '', null]) invalid(event('subject', { type, disposition: 'present' }));
  for (const property of ['entity', 'credentials', 'grants', 'lease', 'secret', 'occurredAtMs', 'state']) invalid(event('subject', { type: 'entity-head', disposition: 'present', [property]: {} }));
  // These are data events only: ordering/tombstone transitions require regional state.
  roundTrip(event('subject', { type: 'subject-lifecycle', subject: '알렌-subject', state: 'deleted', occurredAtMs: 2 }));
  roundTrip(event('subject', { type: 'entity-head', disposition: 'changed' }));
});

test('decode rejects invalid UTF-8, duplicate keys and all noncanonical JSON byte encodings', () => {
  const canonical = string(encodeSeoulHeadEvent(event()));
  for (const raw of [
    '', 'null', '[1]', '{private-data', canonical + '\n', ' ' + canonical,
    canonical.replace('"version":3', '"version":3,"version":3'),
    canonical.replace('"revision":7', '"revision":7,"revision":7'),
    canonical.replace('"disposition":"present"', '"disposition":"present","disposition":"present"'),
    canonical.replace('"version":3', '"version":3.0'), canonical.replace('"sourceRevision":7', '"sourceRevision":7e0'),
    canonical.replace('credential:one', 'credential:\\u006fne'),
    canonical.replace('https://', 'https:\\/\\/'),
    canonical.replace('"version":3,"kind":"seoul-authority-head"', '"kind":"seoul-authority-head","version":3'),
    '\ufeff' + canonical,
  ]) invalidBytes(utf8.encode(raw));
  for (const malformed of [[0xc3, 0x28], [0xff], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0x80], [0xe2, 0x82]]) invalidBytes(new Uint8Array(malformed));
  const corrupted = utf8.encode(canonical); corrupted[canonical.indexOf('credential:one')] = 0xff; invalidBytes(corrupted);
});

test('byte limits apply before decode/hash and UTF-8 input is bounded before serialization', async () => {
  invalidBytes(new Uint8Array(128 * 1024 + 1));
  invalidBytes(new Uint8Array(128 * 1024));
  const tooLarge = event('subject'); tooLarge.head.key = issuer + '\n' + '가'.repeat(128 * 1024); invalid(tooLarge);
  assert.match(await hashSeoulProjectionTransport(new Uint8Array(128 * 1024)), /^[a-f0-9]{64}$/);
  await assert.rejects(() => hashSeoulProjectionTransport(new Uint8Array(128 * 1024 + 1)), { message: 'seoul_transport_bytes_invalid' });
  for (const value of [null, [], 'abc', new ArrayBuffer(3), new Uint16Array(3)]) {
    invalidBytes(value);
    await assert.rejects(() => hashSeoulProjectionTransport(value), { message: 'seoul_transport_bytes_invalid' });
  }
});

test('byte views cannot replace exact transport bytes or bypass bounds through custom properties', async () => {
  let invoked = 0;
  const bytes = utf8.encode('abc');
  Object.defineProperty(bytes, Symbol.iterator, { value: function* () { invoked++; yield 120; } });
  Object.defineProperty(bytes, 'byteLength', { get() { invoked++; return 0; } });
  assert.equal(await hashSeoulProjectionTransport(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const valid = encodeSeoulHeadEvent(event());
  Object.defineProperty(valid, 'byteLength', { get() { invoked++; return 0; } });
  assert.deepEqual(decodeSeoulHeadEvent(valid), event());
  const oversize = new Uint8Array(128 * 1024 + 1);
  Object.defineProperty(oversize, 'byteLength', { value: 1 });
  invalidBytes(oversize);
  await assert.rejects(() => hashSeoulProjectionTransport(oversize), { message: 'seoul_transport_bytes_invalid' });
  assert.equal(invoked, 0);
});

test('transport rejects prototype-spoofed non-Uint8Array brands and proxies without reading caller properties', async () => {
  let invoked = 0;
  for (const Type of [Int8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array]) {
    const fake = new Type(4);
    Object.setPrototypeOf(fake, Uint8Array.prototype);
    Object.defineProperty(fake, Symbol.toStringTag, { get() { invoked++; return 'Uint8Array'; } });
    invalidBytes(fake);
    await assert.rejects(() => hashSeoulProjectionTransport(fake), { message: 'seoul_transport_bytes_invalid' });
  }
  const canonical = encodeSeoulHeadEvent(event());
  for (const Type of [Int8Array, Uint8ClampedArray]) {
    const fake = new Type(canonical);
    Object.setPrototypeOf(fake, Uint8Array.prototype);
    invalidBytes(fake);
  }
  const fakeView = new DataView(new ArrayBuffer(8)); Object.setPrototypeOf(fakeView, Uint8Array.prototype);
  const revoked = Proxy.revocable(canonical, {}); revoked.revoke();
  const proxy = new Proxy(canonical, { get() { invoked++; throw new Error('private-data'); }, getPrototypeOf() { invoked++; return Uint8Array.prototype; } });
  for (const fake of [fakeView, Object.create(Uint8Array.prototype), proxy, revoked.proxy]) {
    invalidBytes(fake);
    await assert.rejects(() => hashSeoulProjectionTransport(fake), { message: 'seoul_transport_bytes_invalid' });
  }
  assert.equal(invoked, 0);
});

test('intrinsic Uint8Array brands preserve exact Buffer, subclass and cross-realm selected views', async () => {
  const expectedHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  class Bytes extends Uint8Array {}
  const foreign = runInNewContext('new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4)');
  assert.equal(foreign instanceof Uint8Array, false);
  const noPrototype = new Uint8Array([97, 98, 99]); Object.setPrototypeOf(noPrototype, null);
  for (const bytes of [Buffer.from([0, 97, 98, 99, 0]).subarray(1, 4), new Bytes([0, 97, 98, 99, 0]).subarray(1, 4), foreign, noPrototype]) {
    assert.equal(await hashSeoulProjectionTransport(bytes), expectedHash);
  }
  const canonical = encodeSeoulHeadEvent(event());
  const prefixed = Buffer.concat([Buffer.from([0]), Buffer.from(canonical), Buffer.from([0])]);
  assert.deepEqual(decodeSeoulHeadEvent(prefixed.subarray(1, -1)), event());
  const foreignEnvelope = runInNewContext('new Uint8Array([0, ...data, 0]).subarray(1, -1)', { data: Array.from(canonical) });
  assert.deepEqual(decodeSeoulHeadEvent(foreignEnvelope), event());
});

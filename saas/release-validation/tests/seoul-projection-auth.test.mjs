import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { signSeoulProjectionRequest as sign, verifySeoulProjectionRequest as verify } from '../../src/release/seoul-projection-auth.ts';
import { encodeSeoulHeadEvent } from '../../src/release/seoul-projection-head-codec.ts';
import { encodeSeoulAuthoritySnapshot } from '../../src/release/seoul-projection-snapshot-codec.ts';

// Public synthetic fixtures only. No environment, provider, filesystem or key store.
const keyBytes = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const utf8 = new TextEncoder(), now = 1789257600000;
const origin = 'https://projection.example';
const path = '/internal/v1/seoul/projections';
const eventId = 'fedcba98-7654-4321-8fed-cba987654321';
const sourceId = '01234567-89ab-4cde-8fab-0123456789ab';
const sourceDigest = '0123456789abcdef'.repeat(4);
const head = { version: 3, kind: 'seoul-authority-head', eventId, sourceRevision: 7, issuer: 'https://auth-api.allen.company', head: { kind: 'credential', key: 'credential:one', revision: 7, eventId: sourceId, payloadSha256: sourceDigest }, effect: { type: 'entity-head', disposition: 'present' } };
const body = encodeSeoulHeadEvent(head);
const getUrl = origin + path + '/' + eventId + '?payloadSha256=' + sourceDigest;
const post = (rawBody = body, extra = {}) => ({ method: 'POST', url: origin + path, body: rawBody, timestampMs: now, ...extra });
const get = (extra = {}) => ({ method: 'GET', url: getUrl, body: new Uint8Array(), timestampMs: now, ...extra });
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
function referenceHeaders(method, url, bytes, timestamp = String(now), id = eventId) {
  const parsed = new URL(url), hash = checksum(bytes);
  const prefix = 'memory-seoul-projection-v1\n' + method + '\n' + parsed.pathname + '\n' + parsed.search.slice(1) + '\n' + timestamp + '\n' + hash + '\n';
  return new Headers({
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    'x-memory-projection-event-id': id, 'x-memory-projection-timestamp': timestamp,
    'x-memory-projection-content-sha256': hash,
    'x-memory-projection-signature': 'v1=' + createHmac('sha256', keyBytes).update(prefix).update(bytes).digest('hex'),
  });
}
const request = (input, headers) => new Request(input.url, { method: input.method, headers });
const denied = operation => assert.rejects(operation, { message: 'seoul_projection_auth_denied' });
const signingInvalid = operation => assert.rejects(operation, { message: 'seoul_projection_signing_invalid' });

test('POST signing exactly matches the fixed v1 bytes and independent HMAC/checksum reference', async () => {
  const canonical = '{"version":3,"kind":"seoul-authority-head","eventId":"fedcba98-7654-4321-8fed-cba987654321","sourceRevision":7,"issuer":"https://auth-api.allen.company","head":{"kind":"credential","key":"credential:one","revision":7,"eventId":"01234567-89ab-4cde-8fab-0123456789ab","payloadSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},"effect":{"type":"entity-head","disposition":"present"}}';
  const expectedHash = createHash('sha256').update(canonical).digest('hex');
  const expectedPrefix = 'memory-seoul-projection-v1\nPOST\n/internal/v1/seoul/projections\n\n1789257600000\n' + expectedHash + '\n';
  const headers = await sign(key, post());
  assert.equal(headers.get('x-memory-projection-signature'), 'v1=' + createHmac('sha256', keyBytes).update(expectedPrefix).update(canonical).digest('hex'));
  assert.equal(headers.get('x-memory-projection-content-sha256'), expectedHash);
  assert.equal(headers.get('x-memory-projection-event-id'), eventId);
  assert.equal(headers.get('x-memory-projection-timestamp'), String(now));
  assert.equal(headers.get('content-type'), 'application/json');
  const result = await verify(key, request(post(), headers), body, now);
  assert.deepEqual(Object.keys(result).sort(), ['envelope', 'eventId', 'method', 'rawBody', 'transportPayloadSha256']);
  assert.deepEqual(result.envelope, head); assert.equal(result.eventId, eventId); assert.equal(result.method, 'POST');
  assert.equal(result.transportPayloadSha256, expectedHash); assert.notEqual(expectedHash, sourceDigest);
  assert.equal(result.envelope.head.payloadSha256, sourceDigest);
  assert.deepEqual(result.rawBody, body); assert.notEqual(result.rawBody.buffer, body.buffer);
});

test('GET signs the exact query/path and empty content hash without binding an origin', async () => {
  const headers = await sign(key, get());
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const expectedPrefix = 'memory-seoul-projection-v1\nGET\n/internal/v1/seoul/projections/fedcba98-7654-4321-8fed-cba987654321\npayloadSha256=' + sourceDigest + '\n1789257600000\n' + emptyHash + '\n';
  assert.equal(headers.get('x-memory-projection-content-sha256'), emptyHash);
  assert.equal(headers.get('x-memory-projection-signature'), 'v1=' + createHmac('sha256', keyBytes).update(expectedPrefix).digest('hex'));
  const result = await verify(key, request(get(), headers), new Uint8Array(), now);
  assert.deepEqual(result, { method: 'GET', eventId, payloadSha256: sourceDigest });
  // Host isolation is the future trusted service configuration, not the frozen MAC.
  assert.deepEqual(await verify(key, request(get({ url: getUrl.replace(origin, 'https://another.example') }), headers), new Uint8Array(), now), result);
});

test('a canonical snapshot is authenticated and decoded through the real snapshot codec', async () => {
  const snapshot = { version: 3, kind: 'seoul-authority-snapshot', eventId, sourceRevision: 7, snapshotSeq: 1, issuer: head.issuer, spaceId: 'space:one', selected: true, accounts: [{ id: 'account:one', disabledAtMs: null }], providerIdentities: [{ issuer: head.issuer, subject: 'alice', accountId: 'account:one', createdAtMs: 0 }], emails: [], organizations: [], memberships: [], credentials: [], credentialPolicies: [], spaces: [{ id: 'space:one', accountId: 'account:one', organizationId: null, disabledAtMs: null, policy: { policyVersion: 1, residency: 'kr-seoul', profile: 'kr-primary-storage', processingBoundary: 'approved-processors', dataClass: 'personal', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 } }], grants: [], lease: { issuedAtMs: 1000, expiresAtMs: 61000 } };
  const bytes = encodeSeoulAuthoritySnapshot(snapshot), input = post(bytes), headers = await sign(key, input);
  const result = await verify(key, request(input, headers), bytes, now);
  assert.deepEqual(result.envelope, snapshot); assert.equal(result.transportPayloadSha256, checksum(bytes));
});

test('POST event-header substitution is denied even though that header is absent from the MAC prefix', async () => {
  const headers = referenceHeaders('POST', origin + path, body, String(now), sourceId);
  await denied(() => verify(key, request(post(), headers), body, now));
  const getHeaders = referenceHeaders('GET', getUrl, new Uint8Array(), String(now), sourceId);
  await denied(() => verify(key, request(get(), getHeaders), new Uint8Array(), now));
});

test('method, signed query/path, body, checksum and signature substitutions fail closed', async () => {
  const headers = referenceHeaders('POST', origin + path, body);
  const changed = body.slice(); changed[20] ^= 1;
  await denied(() => verify(key, request(post(), headers), changed, now));
  for (const [name, value] of [['x-memory-projection-content-sha256', '0'.repeat(64)], ['x-memory-projection-signature', 'v1=' + '0'.repeat(64)], ['x-memory-projection-timestamp', String(now + 1)]]) {
    const substituted = new Headers(headers); substituted.set(name, value);
    await denied(() => verify(key, request(post(), substituted), body, now));
  }
  for (const input of [get(), post(body, { method: 'PUT' }), post(body, { url: origin + path + '/other' })]) await denied(() => verify(key, request(input, headers), body, now));
  const getHeaders = referenceHeaders('GET', getUrl, new Uint8Array());
  for (const url of [getUrl.replace(eventId, sourceId), getUrl.replace(sourceDigest, '1'.repeat(64))]) await denied(() => verify(key, request(get({ url }), getHeaders), new Uint8Array(), now));
});

test('routes require absolute credential-free HTTPS, canonical components and exact query shape', async () => {
  for (const url of [origin + path + '?', origin + path + '?extra=1', origin + path + '/', origin + path + '#', origin + path + '#fragment', origin + path.replace('/v1/', '/%76%31/'), origin + path.replace('/v1/', '/v1%2f'), 'http://projection.example' + path, 'https://user:pass@projection.example' + path, 'https://@projection.example' + path, path, origin + '/internal/../internal/v1/seoul/projections', origin + '\\internal/v1/seoul/projections']) {
    await signingInvalid(() => sign(key, post(body, { url })));
  }
  for (const url of [getUrl + '&extra=1', getUrl + '&payloadSha256=' + sourceDigest, getUrl + '&', getUrl.replace('?payloadSha256=', '?payloadSha256=&extra='), getUrl.replace('?payloadSha256=', '?%70ayloadSha256='), getUrl.replace(eventId, eventId.toUpperCase()), getUrl.replace(sourceDigest, sourceDigest.toUpperCase()), getUrl.replace(eventId, '%66' + eventId.slice(1)), getUrl.replace('payloadSha256=', 'payloadSha256=%30'), getUrl + '#', origin + path + '/' + eventId + '?', getUrl.replace('/' + eventId, '%2f' + eventId)]) {
    await signingInvalid(() => sign(key, get({ url })));
    await denied(() => verify(key, request(get({ url }), referenceHeaders('GET', getUrl, new Uint8Array())), new Uint8Array(), now));
  }
  // URL/Request normalizes dot segments before verification; the signer rejects
  // raw noncanonical spellings, and verification checks the URL Request retains.
});

test('duplicate/missing required headers, noncanonical encodings and POST content types are denied', async () => {
  const initial = referenceHeaders('POST', origin + path, body);
  for (const name of ['x-memory-projection-event-id', 'x-memory-projection-timestamp', 'x-memory-projection-content-sha256', 'x-memory-projection-signature', 'content-type']) {
    const missing = new Headers(initial); missing.delete(name); await denied(() => verify(key, request(post(), missing), body, now));
    const duplicate = new Headers(initial); duplicate.append(name, initial.get(name)); await denied(() => verify(key, request(post(), duplicate), body, now));
  }
  for (const [name, values] of [
    ['x-memory-projection-timestamp', ['01', '-0', '+1', '-1', '1.0', '1e3', '9007199254740992', '1, 1', '']],
    ['x-memory-projection-event-id', [eventId.toUpperCase(), eventId + ', ' + eventId, 'not-an-id']],
    ['x-memory-projection-content-sha256', [sourceDigest.toUpperCase(), 'a'.repeat(63), 'g'.repeat(64)]],
    ['x-memory-projection-signature', ['V1=' + 'a'.repeat(64), 'v1=' + 'A'.repeat(64), 'v1=' + 'a'.repeat(63)]],
    ['content-type', ['application/json; charset=utf-8', 'Application/JSON', 'text/plain', '']],
  ]) for (const value of values) { const headers = new Headers(initial); headers.set(name, value); await denied(() => verify(key, request(post(), headers), body, now)); }
});

test('timestamp freshness is inclusive at both five-minute boundaries and rejects invalid trusted clocks', async () => {
  for (const delta of [-300000, 300000]) {
    const input = post(body, { timestampMs: now + delta }), headers = await sign(key, input);
    assert.equal((await verify(key, request(input, headers), body, now)).eventId, eventId);
  }
  for (const delta of [-300001, 300001]) { const input = post(body, { timestampMs: now + delta }); await denied(async () => verify(key, request(input, await sign(key, input)), body, now)); }
  for (const value of [-0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    await signingInvalid(() => sign(key, post(body, { timestampMs: value })));
    await denied(() => verify(key, request(post(), referenceHeaders('POST', origin + path, body)), body, value));
  }
  for (const timestampMs of [0, Number.MAX_SAFE_INTEGER]) {
    const input = post(body, { timestampMs }); assert.equal((await verify(key, request(input, await sign(key, input)), body, timestampMs)).eventId, eventId);
  }
});

test('GET body and empty/noncanonical/invalid signed POST bytes never produce a verified envelope', async () => {
  await signingInvalid(() => sign(key, get({ body: utf8.encode('x') })));
  await denied(() => verify(key, request(get(), referenceHeaders('GET', getUrl, utf8.encode('x'))), utf8.encode('x'), now));
  for (const bytes of [new Uint8Array(), utf8.encode('{private-data'), utf8.encode('null'), utf8.encode(new TextDecoder().decode(body) + '\n'), utf8.encode(new TextDecoder().decode(body).replace('"version":3', '"version":3,"version":3')), utf8.encode(new TextDecoder().decode(body).replace('"revision":7', '"revision":8')), new Uint8Array([0xff])]) {
    await signingInvalid(() => sign(key, post(bytes)));
    await denied(() => verify(key, request(post(bytes), referenceHeaders('POST', origin + path, bytes)), bytes, now));
  }
});

test('invalid HMAC reaches no JSON parser while a valid HMAC reaches strict envelope decoding', async () => {
  const bytes = utf8.encode('{private-data'), good = referenceHeaders('POST', origin + path, bytes), bad = new Headers(good);
  bad.set('x-memory-projection-signature', 'v1=' + '0'.repeat(64));
  const badRequest = request(post(bytes), bad), goodRequest = request(post(bytes), good);
  const original = JSON.parse; let parsed = 0;
  JSON.parse = function (...args) { parsed++; return original.apply(this, args); };
  try {
    await denied(() => verify(key, badRequest, bytes, now)); assert.equal(parsed, 0);
    await denied(() => verify(key, goodRequest, bytes, now)); assert.ok(parsed > 0);
  } finally { JSON.parse = original; }
});

test('bounds and intrinsic Uint8Array brands reject spoofed views without caller getters or iterators', async () => {
  let invoked = 0;
  const invalidViews = [new Uint8Array(128 * 1024 + 1), null, [], 'abc', new ArrayBuffer(3), new Uint16Array([0x6162]), new DataView(new ArrayBuffer(3)), new Proxy(body, {})];
  for (const Type of [Int8Array, Uint8ClampedArray, Uint16Array, Float64Array]) { const fake = new Type(3); Object.setPrototypeOf(fake, Uint8Array.prototype); invalidViews.push(fake); }
  for (const bytes of invalidViews) {
    await signingInvalid(() => sign(key, post(bytes)));
    await denied(() => verify(key, request(post(), referenceHeaders('POST', origin + path, body)), bytes, now));
  }
  const backing = new Uint8Array(body.length + 2); backing.set(body, 1); const selected = backing.subarray(1, -1);
  for (const name of ['byteLength', 'buffer', 'byteOffset', Symbol.toStringTag, Symbol.iterator]) Object.defineProperty(selected, name, { get() { invoked++; throw new Error('private-data'); } });
  const signed = await sign(key, post(selected));
  assert.equal(signed.get('x-memory-projection-content-sha256'), checksum(body));
  const result = await verify(key, request(post(), signed), selected, now);
  assert.deepEqual(result.rawBody, body); assert.equal(invoked, 0);
  selected[0] = 0; assert.equal(result.rawBody[0], 123);
  const foreign = runInNewContext('new Uint8Array(data)', { data: Array.from(body) });
  assert.equal((await sign(key, post(foreign))).get('x-memory-projection-content-sha256'), checksum(body));
});

test('signing and verification require a secret HMAC-SHA-256 key with the needed usage', async () => {
  const wrongKey = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(9), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const wrongHash = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-384' }, false, ['sign', 'verify']);
  const aes = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const signOnly = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const verifyOnly = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const headers = referenceHeaders('POST', origin + path, body);
  await denied(() => verify(wrongKey, request(post(), headers), body, now));
  for (const candidate of [wrongHash, aes, null, {}]) {
    await signingInvalid(() => sign(candidate, post())); await denied(() => verify(candidate, request(post(), headers), body, now));
  }
  await signingInvalid(() => sign(verifyOnly, post())); await denied(() => verify(signOnly, request(post(), headers), body, now));
  assert.equal((await sign(signOnly, post())).get('x-memory-projection-event-id'), eventId);
  assert.equal((await verify(verifyOnly, request(post(), headers), body, now)).eventId, eventId);
});

test('verification owns supplied raw bytes and never consumes Request.body', async () => {
  const headers = referenceHeaders('POST', origin + path, body);
  const req = new Request(origin + path, { method: 'POST', headers, body: 'different composition bytes' });
  const result = await verify(key, req, body, now);
  assert.deepEqual(result.rawBody, body); assert.equal(req.bodyUsed, false);
  // This deliberate mismatch documents the composition precondition: the future
  // bounded reader MUST pass the bytes actually read from this same Request.
});

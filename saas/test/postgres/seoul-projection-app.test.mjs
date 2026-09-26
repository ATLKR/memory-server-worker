import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSeoulProjectionApp } from '../../src/postgres/seoul/projection-app.ts';
import { signSeoulProjectionRequest } from '../../src/release/seoul-projection-auth.ts';
import { encodeSeoulHeadReceipt } from '../../src/release/seoul-projection-head-receipt-codec.ts';
import { encodeSeoulAuthoritySnapshot } from '../../src/release/seoul-projection-snapshot-codec.ts';
import { encodeSeoulSnapshotReceipt } from '../../src/release/seoul-projection-snapshot-receipt-codec.ts';
import { createHeadFixture, event, wire, uuid, hash } from './seoul-projection-head-fixture.mjs';

const origin = 'https://projection.example.test', base = origin + '/internal/v1/seoul/projections';
const utf8 = new TextEncoder(), text = b => new TextDecoder().decode(b), now = 1000;
const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(17), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const head = event(1), body = utf8.encode(wire(head));
const digest = b => createHash('sha256').update(b).digest('hex');
function headReceipt(e = head, overrides = {}) {
  return text(encodeSeoulHeadReceipt({ version: 3, kind: 'seoul-projection-receipt', eventId: e.eventId,
    transportPayloadSha256: hash(wire(e)), sourceRevision: e.sourceRevision, eventKind: 'head', spaceId: null,
    snapshotSeq: null, attemptNo: 1, outcome: 'applied', reason: 'head_applied', currentHeads: [e.head],
    leaseExpiresAtMs: null, attemptedAtMs: now, ...overrides }));
}
function fixture(store = () => headReceipt(), extra = {}) {
  const calls = [];
  const app = createSeoulProjectionApp({ enabled: true, origin, key, clock: () => now,
    store: async command => { calls.push(command); return store(command); }, ...extra });
  return { app, calls };
}
async function request(raw = body, url = base, method = 'POST', timestampMs = now) {
  const headers = await signSeoulProjectionRequest(key, { method, url, body: raw, timestampMs });
  return new Request(url, { method, headers, ...(method === 'POST' ? { body: raw } : {}) });
}
const statusUrl = (e = head, d = hash(wire(e))) => base + '/' + e.eventId + '?payloadSha256=' + d;
async function responseError(response, status, code) {
  assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: code });
}

test('actual Hono POST returns exact stored receipt and supplies only frozen scalar command', async () => {
  const f = fixture(), response = await f.app.fetch(await request());
  assert.equal(response.status, 200); assert.equal(await response.text(), headReceipt());
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls.length, 1); assert.ok(Object.isFrozen(f.calls[0]));
  assert.deepEqual(f.calls[0], { method: 'POST', eventId: head.eventId, transportPayloadSha256: digest(body), payloadText: text(body) });
});

test('signed GET returns immutable historical receipt with exact id/hash binding', async () => {
  const f = fixture(undefined, { clock: () => 1000000 });
  const response = await f.app.fetch(await request(new Uint8Array(), statusUrl(), 'GET', 1000000));
  assert.equal(response.status, 200); assert.equal(await response.text(), headReceipt());
  assert.deepEqual(f.calls, [{ method: 'GET', eventId: head.eventId, payloadSha256: digest(body) }]);
  assert.ok(Object.isFrozen(f.calls[0]));
});

test('disabled app does not invoke trusted clock or store', async () => {
  const f = fixture(() => assert.fail('store'), { enabled: false, clock: () => assert.fail('clock') });
  await responseError(await f.app.fetch(await request()), 404, 'seoul_projection_not_found');
  assert.equal(f.calls.length, 0);
});

test('construction pins canonical HTTPS origin and copied trusted references', async () => {
  for (const value of ['http://projection.example.test', origin + '/', origin + '/path', origin + '?q=1',
    'https://user:pass@projection.example.test', 'https://PROJECTION.example.test', origin + '#fragment'])
    assert.throws(() => fixture(undefined, { origin: value }), { message: 'seoul_projection_config_invalid' });
  const config = { enabled: true, origin, key, clock: () => now, store: () => headReceipt() };
  const app = createSeoulProjectionApp(config);
  config.enabled = false; config.origin = 'https://other.example.test'; config.clock = () => assert.fail('replaced clock');
  config.store = () => assert.fail('replaced store');
  assert.equal((await app.fetch(await request())).status, 200);
});

for (const name of ['origin', 'method', 'head-method', 'path', 'query', 'signature', 'content-type', 'content-encoding', 'changed-body'])
  test('rejects ' + name + ' before any store call', async () => {
    const f = fixture(); let req = await request(), headers = new Headers(req.headers), url = req.url, method = 'POST', bytes = body;
    if (name === 'origin') url = url.replace('projection.', 'other.');
    if (name === 'method') method = 'PUT';
    if (name === 'head-method') method = 'HEAD';
    if (name === 'path') url += '/';
    if (name === 'query') url += '?extra=1';
    if (name === 'signature') headers.set('x-memory-projection-signature', 'v1=' + '0'.repeat(64));
    if (name === 'content-type') headers.set('content-type', 'application/json; charset=utf-8');
    if (name === 'content-encoding') headers.set('content-encoding', 'gzip');
    if (name === 'changed-body') bytes = utf8.encode(text(body) + ' ');
    req = new Request(url, { method, headers, ...(method === 'HEAD' ? {} : { body: bytes }) });
    const response = await f.app.fetch(req);
    if (method === 'HEAD') {
      assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(await response.text(), '');
    } else await responseError(response, 401, 'seoul_projection_auth_denied');
    assert.equal(f.calls.length, 0);
  });

test('body reader streams bounded same-request bytes and cancels oversize despite small Content-Length', async () => {
  const f = fixture(); let cancelled = false, pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  const req = new Request(base, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1' }, body: stream, duplex: 'half' });
  await responseError(await f.app.fetch(req), 413, 'seoul_projection_request_too_large');
  assert.equal(f.calls.length, 0); assert.ok(cancelled); assert.ok(pulls <= 5);
});

test('chunked exact signed body is read once and false large Content-Length supplies no trusted size fact', async () => {
  const f = fixture(), headers = (await request()).headers; headers.set('content-length', '999999999');
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(body.subarray(0, 7)); controller.enqueue(body.subarray(7, 20)); controller.enqueue(body.subarray(20)); controller.close();
  } });
  const req = new Request(base, { method: 'POST', headers, body: stream, duplex: 'half' });
  assert.equal((await f.app.fetch(req)).status, 200); assert.ok(req.bodyUsed); assert.equal(f.calls.length, 1);
});

test('body read failure is sanitized before store', async () => {
  const f = fixture(), stream = new ReadableStream({ pull(controller) { controller.error(new Error('private raw body failure')); } });
  const req = new Request(base, { method: 'POST', headers: (await request()).headers, body: stream, duplex: 'half' });
  await responseError(await f.app.fetch(req), 401, 'seoul_projection_auth_denied'); assert.equal(f.calls.length, 0);
});

test('exact request byte cap reaches authentication while one extra byte fails the reader', async () => {
  const f = fixture();
  for (const [size, status, error] of [[131072, 401, 'seoul_projection_auth_denied'], [131073, 413, 'seoul_projection_request_too_large']]) {
    const req = new Request(base, { method: 'POST', headers: (await request()).headers, body: new Uint8Array(size) });
    await responseError(await f.app.fetch(req), status, error);
  }
  assert.equal(f.calls.length, 0);
});

test('throwing backend error descriptors are never executed or disclosed', async () => {
  let getterCalls = 0;
  const error = Object.defineProperty(new Error('private'), 'code', { get() { getterCalls++; throw new Error('private getter'); } });
  const f = fixture(() => { throw error; });
  await responseError(await f.app.fetch(await request()), 503, 'seoul_projection_uncertain');
  assert.equal(getterCalls, 0); assert.equal(f.calls.length, 1);
});

for (const [code, status, message] of [['PP001', 400, 'seoul_projection_invalid'], ['PP002', 409, 'seoul_projection_conflict'],
  ['XX999', 503, 'seoul_projection_uncertain'], ['', 503, 'seoul_projection_uncertain']])
  test('store error ' + code + ' maps to fixed transport failure without retries', async () => {
    const f = fixture(() => { throw Object.assign(new Error('private SQL credential/body detail'), { code }); });
    await responseError(await f.app.fetch(await request()), status, message); assert.equal(f.calls.length, 1);
  });

test('only authenticated GET missing status is 404; POST missing status is uncertain', async () => {
  const f = fixture(() => { throw Object.assign(new Error('private detail'), { code: 'PP003' }); });
  await responseError(await f.app.fetch(await request(new Uint8Array(), statusUrl(), 'GET')), 404, 'seoul_projection_not_found');
  await responseError(await f.app.fetch(await request()), 503, 'seoul_projection_uncertain'); assert.equal(f.calls.length, 2);
});

for (const [name, receipt] of [['malformed', 'private data'], ['noncanonical', headReceipt() + ' '], ['oversize', 'x'.repeat(131073)],
  ['not-text', { secret: 'private data' }], ['wrong-event', headReceipt(event(2))],
  ['wrong-source', JSON.stringify({ ...JSON.parse(headReceipt()), sourceRevision: 2 })], ['wrong-hash', headReceipt(head, { transportPayloadSha256: 'a'.repeat(64) })]])
  test('rejects ' + name + ' store receipt after exactly one call', async () => {
    const f = fixture(() => receipt);
    await responseError(await f.app.fetch(await request()), 503, 'seoul_projection_uncertain'); assert.equal(f.calls.length, 1);
  });

test('GET rejects another event or transport hash and never infers absent from malformed receipt', async () => {
  const f = fixture(() => headReceipt(event(2)));
  await responseError(await f.app.fetch(await request(new Uint8Array(), statusUrl(), 'GET')), 503, 'seoul_projection_uncertain');
  const g = fixture(() => headReceipt(head, { transportPayloadSha256: 'a'.repeat(64) }));
  await responseError(await g.app.fetch(await request(new Uint8Array(), statusUrl(), 'GET')), 503, 'seoul_projection_uncertain');
  assert.equal(f.calls.length, 1); assert.equal(g.calls.length, 1);
});

for (const [name, surrogate] of [['high', '\uD800'], ['low', '\uDC00']]) for (const method of ['POST', 'GET'])
  test('raw unpaired ' + name + ' surrogate in stored ' + method + ' receipt cannot be repaired into a successful response', async () => {
    const e = event(1, 'subject', 'https://auth-api.allen.company\n\uFFFD');
    const raw = utf8.encode(wire(e)), stored = headReceipt(e).replaceAll('\uFFFD', surrogate);
    const f = fixture(() => stored);
    const req = method === 'POST' ? await request(raw) : await request(new Uint8Array(), statusUrl(e), 'GET');
    await responseError(await f.app.fetch(req), 503, 'seoul_projection_uncertain'); assert.equal(f.calls.length, 1);
  });

test('snapshot branch validates submitted empty snapshot using a labeled store stub, without SQL authority claim', async () => {
  const s = { version: 3, kind: 'seoul-authority-snapshot', eventId: uuid(90), sourceRevision: 1, snapshotSeq: 1,
    issuer: 'https://auth-api.allen.company', spaceId: 'space:empty', selected: false, accounts: [{ id: 'account:empty', disabledAtMs: null }],
    providerIdentities: [{ issuer: 'https://auth-api.allen.company', subject: 'empty', accountId: 'account:empty', createdAtMs: 0 }], emails: [],
    organizations: [], memberships: [], credentials: [], credentialPolicies: [],
    spaces: [{ id: 'space:empty', accountId: 'account:empty', organizationId: null, disabledAtMs: null,
      policy: { policyVersion: 1, residency: 'kr-seoul', profile: 'kr-primary-storage', processingBoundary: 'approved-processors',
        dataClass: 'personal', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 } }],
    grants: [], lease: { issuedAtMs: 1000, expiresAtMs: 61000 } };
  const raw = encodeSeoulAuthoritySnapshot(s);
  const r = text(encodeSeoulSnapshotReceipt({ version: 3, kind: 'seoul-projection-receipt', eventId: s.eventId,
    transportPayloadSha256: digest(raw), sourceRevision: 1, eventKind: 'snapshot', spaceId: s.spaceId, snapshotSeq: 1, attemptNo: 1,
    outcome: 'applied', reason: 'empty_snapshot_applied', currentHeads: [], leaseExpiresAtMs: 61000, attemptedAtMs: 1000 }));
  const f = fixture(() => r);
  const response = await f.app.fetch(await request(raw)); assert.equal(response.status, 200); assert.equal(await response.text(), r);
  const get = await f.app.fetch(await request(new Uint8Array(), statusUrl(s, digest(raw)), 'GET')); assert.equal(get.status, 200); assert.equal(await get.text(), r);
  const historical = fixture(() => r, { clock: () => 1000000 });
  const expiredGet = await historical.app.fetch(await request(new Uint8Array(), statusUrl(s, digest(raw)), 'GET', 1000000));
  assert.equal(expiredGet.status, 200); assert.equal(await expiredGet.text(), r, 'GET retains an applied historical receipt after its lease expired');
  s.lease = { issuedAtMs: 2000, expiresAtMs: 62000 }; const changed = encodeSeoulAuthoritySnapshot(s);
  await responseError(await f.app.fetch(await request(changed)), 503, 'seoul_projection_uncertain'); assert.equal(f.calls.length, 3);
});

test('actual local head SQL through Hono applies negatives, replays/status exactly and reconciles committed-but-lost response without retry', async t => {
  const db = await createHeadFixture(t), calls = [], app = createSeoulProjectionApp({ enabled: true, origin, key, clock: () => now,
    store: async command => {
      calls.push(command);
      return command.method === 'POST' ? db.apply(command.payloadText, command.transportPayloadSha256) : db.status(command.eventId, command.payloadSha256);
    } });
  const newer = event(7, 'credential', 'pat:one', { type: 'entity-negative', entityKind: 'credential', entityId: 'pat:one', state: 'revoked', occurredAtMs: 555 });
  const bytes = utf8.encode(wire(newer));
  const first = await app.fetch(await request(bytes)); assert.equal(first.status, 200); const retained = await first.text();
  const before = await db.state();
  assert.equal(await (await app.fetch(await request(bytes))).text(), retained);
  assert.equal(await (await app.fetch(await request(new Uint8Array(), statusUrl(newer), 'GET'))).text(), retained);
  assert.deepEqual(await db.state(), before);
  const older = event(6, 'credential', 'pat:one');
  assert.equal((await (await app.fetch(await request(utf8.encode(wire(older))))).json()).outcome, 'head_superseded');
  const collision = { ...newer, effect: { ...newer.effect, occurredAtMs: 556 } };
  await responseError(await app.fetch(await request(utf8.encode(wire(collision)))), 409, 'seoul_projection_conflict');
  const sourceConflict = { ...newer, eventId: uuid(90), head: { ...newer.head, payloadSha256: 'a'.repeat(64) } };
  const conflictReceipt = await app.fetch(await request(utf8.encode(wire(sourceConflict))));
  assert.equal(conflictReceipt.status, 200); assert.equal((await conflictReceipt.json()).reason, 'source_identity_conflict');
  await responseError(await app.fetch(await request(new Uint8Array(), statusUrl(event(99)), 'GET')), 404, 'seoul_projection_not_found');
  const lost = event(8), lostRaw = utf8.encode(wire(lost)); let postCalls = 0;
  const loss = fixture(async command => {
    if (command.method === 'GET') return db.status(command.eventId, command.payloadSha256);
    postCalls++; await db.apply(command.payloadText, command.transportPayloadSha256); throw new Error('response dropped after committed SQL');
  });
  await responseError(await loss.app.fetch(await request(lostRaw)), 503, 'seoul_projection_uncertain'); assert.equal(postCalls, 1);
  const retainedAfterLost = await db.state();
  assert.equal((await loss.app.fetch(await request(new Uint8Array(), statusUrl(lost), 'GET'))).status, 200);
  assert.equal(postCalls, 1); assert.deepEqual(await db.state(), retainedAfterLost);
  assert.equal(calls.length, 7);
});

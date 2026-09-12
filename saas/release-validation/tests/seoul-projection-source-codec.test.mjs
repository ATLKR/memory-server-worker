import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { encodeSeoulAuthoritySource, decodeSeoulAuthoritySource, parseSeoulAuthoritySourceRow, prepareSeoulHeadCandidate } from '../../src/release/seoul-projection-source-codec.ts';
import { decodeSeoulHeadEvent } from '../../src/release/seoul-projection-head-codec.ts';

const ISSUER = 'https://auth-api.allen.company';
const COMMAND = '01234567-89ab-4cde-8fab-0123456789ab';
const EVENT = 'fedcba98-7654-4321-8fed-cba987654321';
const utf8 = new TextEncoder(), text = bytes => new TextDecoder().decode(bytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);
const origin = (commandType, receiptId = 'receipt:one') => ({ kind: 'command', commandType, receiptId });
const head = disposition => ({ type: 'entity-head', disposition });
const negative = kind => ({ type: 'entity-negative', entityKind: kind, entityId: kind + ':one', state: 'revoked', occurredAtMs: 99 });
const identity = subject => ({ issuer: ISSUER, subject, accountId: 'account:one', createdAtMs: 1 });
const bodies = {
  credential: { version: 3, kind: 'credential-source', id: 'credential:one', accountId: 'account:one', credentialKind: 'personal_key', tokenDigest: 'a'.repeat(64), membershipId: null, emailId: null, permission: 'write', expiresAtMs: 1000, revokedAtMs: null, policy: null, origin: origin('scoped-key-issue', null), effect: head('present') },
  membership: { version: 3, kind: 'membership-source', id: 'membership:one', organizationId: 'organization:one', accountId: 'account:one', emailId: 'email:one', role: 'owner', expiresAtMs: 1000, revokedAtMs: null, origin: origin('organization-create'), effect: head('present') },
  email: { version: 3, kind: 'email-source', issuer: ISSUER, subject: 'subject:one', address: 'person@example.com', accountId: 'account:one', liveClaim: { id: 'email:one', verifiedAtMs: 1 }, changedClaim: null, addressBlocked: false, legacyRevoked: false, lifecycle: { state: 'absent' }, origin: origin('workspace-sign-in'), effect: head('changed') },
  subject: { version: 3, kind: 'subject-source', issuer: ISSUER, subject: 'subject:one', accountId: 'account:one', accountDisabledAtMs: null, providerIdentities: [identity('subject:one')], lifecycle: { state: 'absent' }, legacyDisabled: false, origin: origin('workspace-sign-in'), effect: head('changed') },
  organization: { version: 3, kind: 'organization-source', id: 'organization:one', disabledAtMs: null, origin: origin('organization-create'), effect: head('present') },
  space: { version: 3, kind: 'space-source', id: 'space:one', accountId: null, organizationId: 'organization:one', securityMode: 'managed', createdAtMs: 1, origin: origin('organization-create'), effect: head('present') },
  marker: { version: 3, kind: 'subject-source-unrepresentable', issuer: ISSUER, subject: 'subject:one', accountId: 'account:one', reason: 'identity-count', countLowerBound: 513, byteEstimate: 131073, captureAttemptId: COMMAND },
};
function source(body = bodies.credential) {
  const streamKind = body.kind.startsWith('subject-') ? 'subject' : body.kind.replace('-source', '');
  const streamKey = streamKind === 'subject' ? ISSUER + '\n' + body.subject : streamKind === 'email' ? ISSUER + '\n' + body.subject + '\n' + body.address : body.id;
  return { version: 3, kind: 'seoul-authority-source', revision: 7, sourceCommandId: COMMAND, streamKind, streamKey, eventId: EVENT, createdAtMs: 100, body: copy(body) };
}
function row(s = source()) { return { revision: s.revision, source_command_id: s.sourceCommandId, stream_kind: s.streamKind, stream_key: s.streamKey, event_id: s.eventId, record_bytes: JSON.stringify(s.body), created_at: s.createdAtMs }; }
const invalid = action => assert.throws(action, { message: 'seoul_authority_source_invalid' });
const unsupported = action => assert.throws(action, { message: 'seoul_authority_source_contract_unsupported' });
const BODY = '{"version":3,"kind":"credential-source","id":"credential:one","accountId":"account:one","credentialKind":"personal_key","tokenDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","membershipId":null,"emailId":null,"permission":"write","expiresAtMs":1000,"revokedAtMs":null,"policy":null,"origin":{"kind":"command","commandType":"scoped-key-issue","receiptId":null},"effect":{"type":"entity-head","disposition":"present"}}';
const CORE = '{"version":3,"kind":"seoul-authority-source","revision":7,"sourceCommandId":"01234567-89ab-4cde-8fab-0123456789ab","streamKind":"credential","streamKey":"credential:one","eventId":"fedcba98-7654-4321-8fed-cba987654321","createdAtMs":100,"body":' + BODY + '}';
const SOURCE_SHA = 'cbed48e096c63324fa51d1452e1e57f72156f14168606838b61716e58cd6045d';
const TRANSPORT_SHA = 'db87cb55e91e44a5d4eacdb7f2549641cb0247d9b651bd9fa6d2ce3d097e8352';

test('literal canonical body/core/head and independent SHA domains, same event identity', async () => {
  assert.equal(row().record_bytes, BODY);
  assert.equal(text(encodeSeoulAuthoritySource(source())), CORE);
  assert.deepEqual(decodeSeoulAuthoritySource(utf8.encode(CORE)), source());
  assert.deepEqual(parseSeoulAuthoritySourceRow(row()), source());
  const c = await prepareSeoulHeadCandidate(row());
  assert.equal(text(c.sourceCoreBytes), CORE);
  assert.equal(sha(CORE), SOURCE_SHA); assert.equal(c.sourceChangeSha256, SOURCE_SHA);
  const expectedHead = '{"version":3,"kind":"seoul-authority-head","eventId":"fedcba98-7654-4321-8fed-cba987654321","sourceRevision":7,"issuer":"https://auth-api.allen.company","head":{"kind":"credential","key":"credential:one","revision":7,"eventId":"fedcba98-7654-4321-8fed-cba987654321","payloadSha256":"cbed48e096c63324fa51d1452e1e57f72156f14168606838b61716e58cd6045d"},"effect":{"type":"entity-head","disposition":"present"}}';
  assert.equal(c.eventText, expectedHead);
  assert.equal(text(c.eventBytes), expectedHead);
  assert.equal(sha(expectedHead), TRANSPORT_SHA); assert.equal(c.transportPayloadSha256, TRANSPORT_SHA);
  assert.notEqual(c.sourceChangeSha256, c.transportPayloadSha256);
  const event = decodeSeoulHeadEvent(c.eventBytes);
  assert.equal(event.eventId, EVENT); assert.equal(event.head.eventId, EVENT);
  assert.deepEqual(c.rowGuard, row());
});

test('all immutable metadata and captured body/origin/effect affect source hash', async () => {
  const base = source(), hash = (await prepareSeoulHeadCandidate(row(base))).sourceChangeSha256;
  const variants = [s => s.revision++, s => s.createdAtMs++, s => s.sourceCommandId = EVENT, s => s.eventId = COMMAND,
    s => s.body.expiresAtMs++, s => { s.body.id = 'credential:two'; s.streamKey = s.body.id; }];
  for (const change of variants) { const s = copy(base); change(s); assert.notEqual((await prepareSeoulHeadCandidate(row(s))).sourceChangeSha256, hash); }
  const org = source(bodies.organization), child = copy(org); child.body.origin.commandType = 'organization-child-create';
  assert.notEqual(sha(encodeSeoulAuthoritySource(org)), sha(encodeSeoulAuthoritySource(child)));
  child.body.origin.receiptId = 'receipt:two'; assert.notEqual(sha(encodeSeoulAuthoritySource(org)), sha(encodeSeoulAuthoritySource(child)));
  const before = source({ ...bodies.credential, credentialKind: 'api_key', membershipId: 'membership:one', emailId: 'email:one' });
  const after = copy(before); after.body.revokedAtMs = 99; after.body.origin = origin('self-email-unlink'); after.body.effect = negative('credential');
  assert.notEqual(sha(encodeSeoulAuthoritySource(before)), sha(encodeSeoulAuthoritySource(after)));
  const later = copy(after); later.body.revokedAtMs++; later.body.effect.occurredAtMs++;
  assert.notEqual(sha(encodeSeoulAuthoritySource(after)), sha(encodeSeoulAuthoritySource(later)));
});

test('deterministic replay and input/output ownership before first await', async () => {
  const input = row(), expected = copy(input), pending = prepareSeoulHeadCandidate(input);
  input.record_bytes = '{}'; input.revision = 999;
  const first = await pending, second = await prepareSeoulHeadCandidate(expected);
  assert.deepEqual(first, second); assert.deepEqual(first.rowGuard, expected);
  first.eventBytes.fill(0); first.sourceCoreBytes.fill(0);
  assert.equal(text(second.sourceCoreBytes), CORE); assert.equal(sha(second.eventBytes), second.transportPayloadSha256);
  const bytes = utf8.encode(CORE), decoded = decodeSeoulAuthoritySource(bytes); bytes.fill(0);
  assert.deepEqual(decoded, source());
});

const commands = ['scoped-key-issue', 'self-email-unlink', 'workspace-sign-in', 'organization-create', 'organization-child-create', 'invite-accept', 'membership-revoke', 'workspace-key-issue', 'workspace-key-revoke'];
const allowed = { credential: ['scoped-key-issue', 'self-email-unlink', 'membership-revoke', 'workspace-key-issue', 'workspace-key-revoke'], membership: ['self-email-unlink', 'organization-create', 'organization-child-create', 'invite-accept', 'membership-revoke'], email: ['self-email-unlink', 'workspace-sign-in'], subject: ['workspace-sign-in'], organization: ['organization-create', 'organization-child-create'], space: ['workspace-sign-in', 'organization-create', 'organization-child-create'] };
function commandBody(kind, command) {
  const b = copy(bodies[kind]); b.origin = origin(command, command === 'scoped-key-issue' ? null : 'receipt:one');
  if (command === 'self-email-unlink') {
    if (kind === 'credential') Object.assign(b, { credentialKind: 'api_key', membershipId: 'membership:one', emailId: 'email:one' });
    if (kind === 'credential' || kind === 'membership') { b.revokedAtMs = 99; b.effect = negative(kind); }
    if (kind === 'email') { b.liveClaim = null; b.changedClaim = { id: 'email:one', verifiedAtMs: 1, revokedAtMs: 99 }; }
  }
  if (command === 'membership-revoke' || command === 'workspace-key-revoke') {
    if (kind === 'credential' && command === 'membership-revoke') Object.assign(b, { credentialKind: 'api_key', membershipId: 'membership:one', emailId: 'email:one' });
    if (kind === 'credential' || kind === 'membership') { b.revokedAtMs = 99; b.effect = negative(kind); }
  }
  if (command === 'invite-accept' || command === 'workspace-key-issue') b.origin.receiptId = b.id;
  if (kind === 'space' && command === 'workspace-sign-in') { b.accountId = 'account:one'; b.organizationId = null; }
  return b;
}

test('Workspace issuance/acceptance bind actual candidate receipt and only the admitted key effects', () => {
  for (const credentialKind of ['personal_key','api_key']) for (const command of ['workspace-key-issue','workspace-key-revoke']) {
    const b=commandBody('credential',command);Object.assign(b,{credentialKind,membershipId:credentialKind==='api_key'?'membership:one':null,emailId:credentialKind==='api_key'?'email:one':null});
    assert.deepEqual(parseSeoulAuthoritySourceRow(row(source(b))),source(b));
    if(command==='workspace-key-issue'){
      invalid(()=>encodeSeoulAuthoritySource(source({...b,policy:{capabilities:['read'],spaceIds:null}})));
      invalid(()=>encodeSeoulAuthoritySource(source({...b,origin:origin(command,'different-receipt')})));
    }
  }
  const member=commandBody('membership','invite-accept');invalid(()=>encodeSeoulAuthoritySource(source({...member,origin:origin('invite-accept','different-receipt')})));
  const personal=commandBody('credential','membership-revoke');Object.assign(personal,{credentialKind:'personal_key',membershipId:null,emailId:null});invalid(()=>encodeSeoulAuthoritySource(source(personal)));
});
for (const [kind, accepted] of Object.entries(allowed)) {
  test(`${kind}: complete command/effect matrix`, async () => {
    for (const command of commands) {
      const b = commandBody(kind, command), s = source(b);
      if (!accepted.includes(command)) { invalid(() => encodeSeoulAuthoritySource(s)); continue; }
      const bytes = encodeSeoulAuthoritySource(s); assert.deepEqual(decodeSeoulAuthoritySource(bytes), s);
      const c = await prepareSeoulHeadCandidate(row(s)); assert.deepEqual(decodeSeoulHeadEvent(c.eventBytes).effect, b.effect);
      const effects = [head('present'), head('changed'), negative('credential'), negative('membership'), { type: 'subject-lifecycle', subject: b.subject ?? 's', state: 'deleted', occurredAtMs: 99 }];
      for (const effect of effects) { if (JSON.stringify(effect) !== JSON.stringify(b.effect)) invalid(() => encodeSeoulAuthoritySource(source({ ...b, effect }))); }
      invalid(() => encodeSeoulAuthoritySource(source({ ...b, origin: { ...b.origin, receiptId: b.origin.receiptId === null ? 'credential:one' : null } })));
    }
  });
}

test('marker is the sole descriptor-free exception and binds capture attempt', async () => {
  for (const reason of ['unmapped', 'unsupported-mapping', 'identity-count', 'identity-bytes', 'fanout-count', 'source-bytes', 'unsupported-state']) {
    const s = source({ ...bodies.marker, reason }); assert.deepEqual(parseSeoulAuthoritySourceRow(row(s)), s);
    assert.deepEqual(decodeSeoulHeadEvent((await prepareSeoulHeadCandidate(row(s))).eventBytes).effect, head('changed'));
  }
  for (const patch of [{ captureAttemptId: EVENT }, { countLowerBound: 2050 }, { countLowerBound: -0 }, { byteEstimate: -1 }, { reason: 'invented' }, { effect: head('changed') }]) invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.marker, ...patch })));
});

test('reserved contracts and absent normal descriptors fail with fixed unsupported reason', () => {
  for (const kind of ['target-source', 'identity-transition-source', 'backfill-source']) unsupported(() => encodeSeoulAuthoritySource({ ...source(), body: { version: 3, kind } }));
  unsupported(() => encodeSeoulAuthoritySource({ ...source(), streamKind: 'target', streamKey: 'target:one' }));
  for (const b of Object.values(bodies).filter(b => b.origin)) {
    const missing = copy(b); delete missing.origin; delete missing.effect; unsupported(() => encodeSeoulAuthoritySource(source(missing)));
    for (const kind of ['provider-v1', 'provider-v2', 'backfill']) unsupported(() => encodeSeoulAuthoritySource(source({ ...b, origin: { kind } })));
    unsupported(() => encodeSeoulAuthoritySource(source({ ...b, origin: origin('unsupported-command') })));
  }
});

test('complete supplied identity vector: UTF-16 sort, exact account/self, opaque subjects', () => {
  const names = ['A\n\u0001\u001f\u007f', '가'.repeat(171), '\ud800\udc00', '\ue000'];
  const b = copy(bodies.subject); b.subject = names[0]; b.providerIdentities = names.map(identity);
  assert.deepEqual(parseSeoulAuthoritySourceRow(row(source(b))), source(b));
  for (const identities of [[], b.providerIdentities.toReversed(), [...b.providerIdentities, b.providerIdentities.at(-1)], b.providerIdentities.slice(1), [identity(names[0]), { ...identity('B'), accountId: 'other' }]]) invalid(() => encodeSeoulAuthoritySource(source({ ...b, providerIdentities: identities })));
  for (const value of [' ', '\0a', '\ud800', '\udc00', 'a'.repeat(513)]) invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.subject, subject: value, providerIdentities: [identity(value)] })));
  for (const value of ['가'.repeat(512), 'a\n', '\nA\nB', '\ud83d\ude00'.repeat(256)]) {
    const s = source({ ...bodies.subject, subject: value, providerIdentities: [identity(value)] }); assert.deepEqual(decodeSeoulAuthoritySource(encodeSeoulAuthoritySource(s)), s);
  }
});

test('current source contract allows 512 identities and rejects 513 before element traversal', () => {
  const b = copy(bodies.subject); b.subject = '0000'; b.providerIdentities = Array.from({ length: 512 }, (_, index) => identity(String(index).padStart(4, '0')));
  assert.deepEqual(parseSeoulAuthoritySourceRow(row(source(b))), source(b));
  b.providerIdentities.push(identity('0512')); invalid(() => encodeSeoulAuthoritySource(source(b)));
  let calls = 0; const s = source(b); Object.defineProperty(s.body.providerIdentities, '0', { enumerable: true, get() { calls++; return identity('0000'); } });
  invalid(() => encodeSeoulAuthoritySource(s)); assert.equal(calls, 0);
});

test('canonical mailbox/composite binding has no newline collisions', () => {
  for (const subject of ['A\n', 'A\nB', '\u001f\u007f가😀']) {
    const a = source({ ...bodies.email, subject }), b = source({ ...bodies.email, subject: subject + '\n' });
    assert.notDeepEqual(encodeSeoulAuthoritySource(a), encodeSeoulAuthoritySource(b));
    assert.deepEqual(parseSeoulAuthoritySourceRow(row(a)), a);
  }
  for (const address of ['Person@example.com', 'a@localhost', '.a@example.com', 'a..b@example.com', 'a@example..com', 'a@-example.com', 'a\nb@example.com']) invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.email, address })));
  for (const patch of [{ streamKey: 'wrong' }, { streamKind: 'membership' }, { streamKey: ISSUER + '\nother\nperson@example.com' }]) invalid(() => encodeSeoulAuthoritySource({ ...source(bodies.email), ...patch }));
});

test('retained lifecycle/disabled flags remain state and cannot invent publisher effects', async () => {
  for (const kind of ['subject', 'email']) {
    for (const eventKind of kind === 'subject' ? ['account.suspended', 'account.resumed', 'account.deleted'] : ['email.verified', 'email.revoked']) {
      const b = { ...bodies[kind], lifecycle: { state: 'event', eventId: 'legacy:event', sequence: 9, kind: eventKind, occurredAtMs: 3 } };
      const c = await prepareSeoulHeadCandidate(row(source(b))); assert.deepEqual(decodeSeoulHeadEvent(c.eventBytes).effect, head('changed'));
      invalid(() => encodeSeoulAuthoritySource(source({ ...b, lifecycle: { ...b.lifecycle, kind: 'unknown' } })));
    }
  }
  const s = source({ ...bodies.subject, accountDisabledAtMs: 9, legacyDisabled: true }); assert.doesNotThrow(() => encodeSeoulAuthoritySource(s));
});

test('credential policy, exact API/personal bindings and explicit scope are closed', () => {
  for (const policy of [null, { capabilities: ['create', 'delete', 'export', 'read', 'update'], spaceIds: null }, { capabilities: ['read'], spaceIds: Array.from({ length: 50 }, (_, i) => 'space:' + String(i).padStart(2, '0')) }]) assert.doesNotThrow(() => encodeSeoulAuthoritySource(source({ ...bodies.credential, policy })));
  for (const policy of [{ capabilities: [], spaceIds: null }, { capabilities: ['read', 'create'], spaceIds: null }, { capabilities: ['read', 'read'], spaceIds: null }, { capabilities: ['erase'], spaceIds: null }, { capabilities: ['read'], spaceIds: [] }, { capabilities: ['read'], spaceIds: Array.from({ length: 51 }, (_, i) => 's' + i) }, { capabilities: ['read'], spaceIds: ['x'.repeat(129)] }]) invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.credential, policy })));
  for (const patch of [{ credentialKind: 'session' }, { membershipId: 'm' }, { emailId: 'e' }, { credentialKind: 'api_key' }, { tokenDigest: 'A'.repeat(64) }, { permission: 'admin' }, { revokedAtMs: 99 }]) invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.credential, ...patch })));
});

test('claims, membership, negative times, new entity state and Space ownership are exact', () => {
  for (const kind of ['membership', 'credential']) {
    const b = commandBody(kind, 'self-email-unlink');
    for (const effect of [{ ...b.effect, occurredAtMs: 98 }, { ...b.effect, entityId: 'other' }, { ...b.effect, state: 'disabled' }]) invalid(() => encodeSeoulAuthoritySource(source({ ...b, effect })));
    invalid(() => encodeSeoulAuthoritySource(source({ ...b, revokedAtMs: null })));
  }
  for (const patch of [{ liveClaim: null }, { liveClaim: { id: 'e', verifiedAtMs: -0 } }, { changedClaim: { id: 'e', verifiedAtMs: 1, revokedAtMs: 2 } }]) invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.email, ...patch })));
  const unlink = commandBody('email', 'self-email-unlink'); invalid(() => encodeSeoulAuthoritySource(source({ ...unlink, changedClaim: null })));
  for (const patch of [{ role: 'viewer' }, { expiresAtMs: null }, { revokedAtMs: 1 }]) invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.membership, ...patch })));
  invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.organization, disabledAtMs: 1 })));
  for (const patch of [{ accountId: 'a' }, { organizationId: null }, { securityMode: 'encrypted' }, { id: 's'.repeat(129) }]) invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.space, ...patch })));
});

test('all time/ID fields reject unsafe values and negative zero', () => {
  for (const value of [-0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1']) {
    for (const field of ['revision', 'createdAtMs']) invalid(() => encodeSeoulAuthoritySource({ ...source(), [field]: value }));
    for (const field of ['expiresAtMs', 'revokedAtMs']) invalid(() => encodeSeoulAuthoritySource(source({ ...commandBody('credential', 'self-email-unlink'), [field]: value })));
  }
  invalid(() => encodeSeoulAuthoritySource({ ...source(), revision: 0 }));
  for (const field of ['sourceCommandId', 'eventId']) for (const value of ['arbitrary', COMMAND.toUpperCase()]) invalid(() => encodeSeoulAuthoritySource({ ...source(), [field]: value }));
  assert.doesNotThrow(() => encodeSeoulAuthoritySource({ ...source(), revision: Number.MAX_SAFE_INTEGER, createdAtMs: 0 }));
});

test('closed own-data records reject getters, symbols, hidden fields, prototypes and array tricks', () => {
  let calls = 0;
  const getter = source(); Object.defineProperty(getter.body, 'id', { enumerable: true, get() { calls++; return 'credential:one'; } }); invalid(() => encodeSeoulAuthoritySource(getter));
  const toJSON = source(); toJSON.body.toJSON = () => { calls++; return bodies.credential; }; invalid(() => encodeSeoulAuthoritySource(toJSON));
  for (const transform of [x => { x.extra = 1; }, x => { x[Symbol()] = 1; }, x => Object.defineProperty(x, 'hidden', { value: 1 }), x => Object.setPrototypeOf(x, { inherited: 1 })]) { const x = row(); transform(x); invalid(() => parseSeoulAuthoritySourceRow(x)); }
  const r = row(); Object.defineProperty(r, 'record_bytes', { enumerable: true, get() { calls++; return BODY; } }); invalid(() => parseSeoulAuthoritySourceRow(r));
  assert.deepEqual(parseSeoulAuthoritySourceRow(Object.assign(Object.create(null), row())), source());
  for (const array of [Array(1), Object.assign([identity('subject:one')], { extra: true }), Object.assign([identity('subject:one')], { toJSON() { calls++; return []; } })]) { const s = source(bodies.subject); s.body.providerIdentities = array; invalid(() => encodeSeoulAuthoritySource(s)); }
  assert.equal(calls, 0);
});

test('strict JSON refuses alternate spelling, order, duplicates, BOM and malformed UTF-8', () => {
  for (const raw of [CORE + '\n', CORE.replace('"version":3', '"version":3,"version":3'), CORE.replace('"revision":7', '"revision":7.0'), CORE.replace('credential:one', 'credential\\u003aone'), '\ufeff' + CORE, JSON.stringify({ body: bodies.credential, ...source() })]) invalid(() => decodeSeoulAuthoritySource(utf8.encode(raw)));
  for (const raw of [BODY + ' ', BODY.replace('"id":"credential:one"', '"id":"credential:one","id":"credential:one"'), BODY.replace('"version":3', '"version":3.0')]) invalid(() => parseSeoulAuthoritySourceRow({ ...row(), record_bytes: raw }));
  for (const bytes of [new Uint8Array(), Uint8Array.of(0xc0, 0xaf), Uint8Array.of(0xed, 0xa0, 0x80), Uint8Array.of(0xff)]) invalid(() => decodeSeoulAuthoritySource(bytes));
});

test('intrinsic selected byte view accepts cross-realm/Buffer and rejects impersonators without getters', () => {
  const padded = Buffer.from('xx' + CORE + 'yy'), selected = padded.subarray(2, padded.length - 2);
  let calls = 0; Object.defineProperty(selected, 'byteLength', { get() { calls++; return 0; } }); selected[Symbol.iterator] = () => { calls++; throw Error(); };
  assert.deepEqual(decodeSeoulAuthoritySource(selected), source());
  assert.deepEqual(decodeSeoulAuthoritySource(runInNewContext('Uint8Array.from(' + JSON.stringify([...utf8.encode(CORE)]) + ')')), source());
  const wide = new Uint16Array(2); Object.setPrototypeOf(wide, Uint8Array.prototype);
  for (const value of [wide, new DataView(new ArrayBuffer(4)), new Proxy(utf8.encode(CORE), {}), Object.create(Uint8Array.prototype), { [Symbol.toStringTag]: 'Uint8Array' }]) invalid(() => decodeSeoulAuthoritySource(value));
  assert.equal(calls, 0);
});

function exactSizeSubject(target) {
  const b = copy(bodies.subject); b.subject = '0000'; b.providerIdentities = [];
  let i = 0;
  while (true) {
    const id = identity(String(i++).padStart(4, '0') + 'x'.repeat(480));
    b.providerIdentities.push(id);
    if (utf8.encode(JSON.stringify(b)).length > target) { b.providerIdentities.pop(); break; }
  }
  b.providerIdentities.unshift(identity('0000'));
  let length = utf8.encode(JSON.stringify(b)).length;
  // Add a final identity, then tune its bounded subject to hit the byte boundary.
  if (length > target) { b.providerIdentities.pop(); length = utf8.encode(JSON.stringify(b)).length; }
  const tail = identity('zzzz'); b.providerIdentities.push(tail);
  let gap = target - utf8.encode(JSON.stringify(b)).length;
  if (gap < 0) { b.providerIdentities.splice(-2, 1); gap = target - utf8.encode(JSON.stringify(b)).length; }
  // Distribute adjustment through unused subject capacity, preserving sort.
  for (let index = b.providerIdentities.length - 1; index >= 1 && gap > 0; index--) { const p = b.providerIdentities[index], add = Math.min(512 - p.subject.length, gap); p.subject += 'x'.repeat(add); gap -= add; }
  assert.equal(gap, 0); assert.equal(utf8.encode(JSON.stringify(b)).length, target); return b;
}

test('128 KiB exact body fits a larger separately bounded core and hashes; one extra byte fails', async () => {
  const b = exactSizeSubject(128 * 1024), s = source(b), encoded = encodeSeoulAuthoritySource(s);
  assert.ok(encoded.byteLength > 128 * 1024 && encoded.byteLength <= 144 * 1024);
  assert.deepEqual(decodeSeoulAuthoritySource(encoded), s); assert.deepEqual(parseSeoulAuthoritySourceRow(row(s)), s);
  const candidate = await prepareSeoulHeadCandidate(row(s)); assert.equal(candidate.sourceChangeSha256, sha(encoded));
  assert.ok(candidate.eventBytes.byteLength < 128 * 1024); assert.equal(candidate.transportPayloadSha256, sha(candidate.eventBytes));
  const over = exactSizeSubject(128 * 1024 + 1); invalid(() => encodeSeoulAuthoritySource(source(over))); invalid(() => parseSeoulAuthoritySourceRow(row(source(over))));
});

test('oversize inputs reject before getter traversal or JSON materialization', () => {
  let calls = 0; const s = source(bodies.subject); s.body.providerIdentities = Array(2049);
  Object.defineProperty(s.body.providerIdentities, '0', { get() { calls++; return identity('x'); }, enumerable: true }); invalid(() => encodeSeoulAuthoritySource(s));
  const parse = JSON.parse; JSON.parse = () => { calls++; throw Error(); };
  try { invalid(() => decodeSeoulAuthoritySource(new Uint8Array(144 * 1024 + 1))); invalid(() => parseSeoulAuthoritySourceRow({ ...row(), record_bytes: ' '.repeat(128 * 1024 + 1) })); }
  finally { JSON.parse = parse; }
  assert.equal(calls, 0);
});

test('bounded metadata and all nested timestamps reject invalid values through row/core APIs', async () => {
  for (const kind of ['credential', 'membership', 'organization']) {
    assert.doesNotThrow(() => encodeSeoulAuthoritySource(source({ ...bodies[kind], id: 'x'.repeat(256) })));
    invalid(() => encodeSeoulAuthoritySource(source({ ...bodies[kind], id: 'x'.repeat(257) })));
  }
  assert.doesNotThrow(() => encodeSeoulAuthoritySource(source({ ...bodies.space, id: 'x'.repeat(128) })));
  for (const value of [-0, -1, Number.MAX_SAFE_INTEGER + 1, null]) {
    const s = source(bodies.subject); s.body.providerIdentities[0].createdAtMs = value; invalid(() => encodeSeoulAuthoritySource(s));
    const b = { ...bodies.email, lifecycle: { state: 'event', eventId: 'legacy:one', sequence: 1, kind: 'email.revoked', occurredAtMs: value } }; invalid(() => encodeSeoulAuthoritySource(source(b)));
  }
  for (const value of [0, -0, -1, 1.1]) invalid(() => encodeSeoulAuthoritySource(source({ ...bodies.subject, lifecycle: { state: 'event', eventId: 'legacy:one', sequence: value, kind: 'account.resumed', occurredAtMs: 1 } })));
  const bad = row(); bad.created_at = -0; invalid(() => parseSeoulAuthoritySourceRow(bad));
  for (const record_bytes of [utf8.encode(BODY), null, {}, '"not a body"']) await assert.rejects(prepareSeoulHeadCandidate({ ...row(), record_bytes }), { message: 'seoul_authority_source_invalid' });
  const reserved = { ...row(), record_bytes: JSON.stringify({ version: 3, kind: 'identity-transition-source' }) };
  await assert.rejects(prepareSeoulHeadCandidate(reserved), { message: 'seoul_authority_source_contract_unsupported' });
});

function sqliteJSON(value, parameters) {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return "json('" + value + "')";
  // node:sqlite binds JS numbers as REAL; actual captured version/time columns
  // are INTEGER. BigInt fixtures preserve the writers' actual storage class.
  if (typeof value !== 'object') { parameters.push(typeof value === 'number' ? BigInt(value) : value); return '?'; }
  if (Array.isArray(value)) return 'json_array(' + value.map(x => sqliteJSON(x, parameters)).join(',') + ')';
  return 'json_object(' + Object.entries(value).flatMap(([key, v]) => ["'" + key + "'", sqliteJSON(v, parameters)]).join(',') + ')';
}
test('real SQLite json_object/json_set canonical differential for every implemented source class', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const fixtures = Object.entries(allowed).flatMap(([kind, commands]) => commands.map(command => commandBody(kind, command)));
    fixtures.push(copy(bodies.marker));
    for (const subject of ['A' + Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).join('') + '\u007f', '가', '\ud800\udc00', '\ue000', '😀', 'line\u2028\u2029']) {
      fixtures.push({ ...copy(bodies.subject), subject, providerIdentities: [identity(subject)] });
      fixtures.push({ ...copy(bodies.email), subject });
    }
    fixtures.push({ ...copy(bodies.credential), policy: { capabilities: ['create', 'read'], spaceIds: ['s:a', 's:b'] } });
    fixtures.push({ ...copy(bodies.subject), lifecycle: { state: 'event', eventId: 'legacy:account', sequence: 8, kind: 'account.deleted', occurredAtMs: 99 }, legacyDisabled: true, accountDisabledAtMs: 100 });
    fixtures.push({ ...copy(bodies.email), lifecycle: { state: 'event', eventId: 'legacy:email', sequence: 9, kind: 'email.revoked', occurredAtMs: 99 }, legacyRevoked: true, addressBlocked: true });
    for (const body of fixtures) {
      const state = copy(body), parameters = []; delete state.origin; delete state.effect;
      if (body.changedClaim) state.changedClaim = null;
      let expression = sqliteJSON(state, parameters);
      if (body.changedClaim) expression = `json_set(${expression},'$.changedClaim',${sqliteJSON(body.changedClaim, parameters)})`;
      if (body.origin) expression = `json_set(${expression},'$.origin',${sqliteJSON(body.origin, parameters)},'$.effect',${sqliteJSON(body.effect, parameters)})`;
      const captured = database.prepare('SELECT ' + expression + ' AS body').get(...parameters).body;
      assert.equal(captured, JSON.stringify(body));
      assert.deepEqual(parseSeoulAuthoritySourceRow({ ...row(source(body)), record_bytes: captured }), source(body));
    }
  } finally { database.close(); }
});

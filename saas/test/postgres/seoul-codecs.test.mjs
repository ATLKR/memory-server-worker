import test from 'node:test';
import assert from 'node:assert/strict';
import {
  seoulIngestInputSchema, seoulSearchInputSchema, parseSeoulIngestInput, parseSeoulSearchInput,
  parseSeoulArchiveReceipt, parseSeoulAdmissionEnvelope, parseSeoulSearchResult, parseSeoulPatDigest,
} from '../../src/postgres/seoul/codecs.ts';

const routing = { version: 1, classification: 'medical', destination: 'seoul' };
const input = () => ({ spaceId: 'space-1', operationId: 'op-1', routing: { ...routing },
  messages: [{ role: 'user', content: '한글 🩺 e\u0301', timestamp: '2026-09-12T01:02:03.123Z' }], sessionId: 'session-1' });
const receipt = source => ({ spaceId: source.spaceId, operationId: source.operationId, archiveId: 'archive-1',
  state: 'stored', extraction: 'none', messageCount: source.messages.length,
  sourceBytes: source.messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0), replayed: false });
const badInput = fn => assert.throws(fn, { code: 'seoul_input_invalid' });
const badResult = fn => assert.throws(fn, { code: 'seoul_response_invalid' });

test('SDK schemas stay strict objects; native parser preserves text and takes a deeply frozen snapshot', () => {
  assert.ok(seoulIngestInputSchema.shape.messages);
  assert.ok(seoulSearchInputSchema.shape.query);
  const source = input(), parsed = parseSeoulIngestInput(source);
  assert.deepEqual(parsed, source);
  source.messages[0].content = 'changed'; source.routing.classification = 'general';
  assert.equal(parsed.messages[0].content, '한글 🩺 e\u0301');
  assert.equal(parsed.routing.classification, 'medical');
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.messages) && Object.isFrozen(parsed.messages[0]));
});
test('search omission is normalized to literal keyword and bounded default limit', () => {
  assert.deepEqual(parseSeoulSearchInput({ spaceId: 'space-1', routing, query: '%_\\한글' }),
    { spaceId: 'space-1', routing, query: '%_\\한글', limit: 20, mode: 'keyword' });
});
for (const [label, mutate] of [
  ['NUL content', x => { x.messages[0].content = 'a\0b'; }],
  ['unpaired surrogate', x => { x.messages[0].content = '\ud800'; }],
  ['extra target', x => { x.target = 'https://untrusted'; }],
  ['caller payload hash', x => { x.payloadHash = 'a'.repeat(64); }],
  ['extra message key', x => { x.messages[0].unknown = true; }],
  ['empty messages', x => { x.messages = []; }],
  ['501 messages', x => { x.messages = Array.from({ length: 501 }, () => ({ role: 'user', content: '' })); }],
  ['message UTF8 overflow', x => { x.messages[0].content = '한'.repeat(10923); }],
  ['aggregate overflow', x => { x.messages = Array.from({ length: 33 }, () => ({ role: 'user', content: 'x'.repeat(32768) })); }],
  ['timestamp no seconds', x => { x.messages[0].timestamp = '2026-09-12T01:02Z'; }],
  ['Cloudflare downgrade', x => { x.routing.destination = 'agent-memory'; }],
]) test(`native ingest rejects ${label}`, () => { const source = input(); mutate(source); badInput(() => parseSeoulIngestInput(source)); });
test('native bounds count UTF8 bytes and permit the exact maximum', () => {
  const source = input(); source.messages = Array.from({ length: 32 }, () => ({ role: 'user', content: 'x'.repeat(32768) }));
  assert.equal(parseSeoulIngestInput(source).messages.length, 32);
  source.messages = Array.from({ length: 500 }, () => ({ role: 'user', content: '' }));
  assert.equal(parseSeoulIngestInput(source).messages.length, 500);
});
test('native input descriptor validation never invokes hidden/accessor/iterator properties', () => {
  for (const mutate of [
    x => Object.defineProperty(x, 'spaceId', { get() { assert.fail('accessor invoked'); }, enumerable: true }),
    x => Object.defineProperty(x, 'extra', { value: true }),
    x => { x[Symbol('extra')] = true; },
    x => { x.messages[Symbol.iterator] = () => { assert.fail('iterator invoked'); }; },
    x => Object.defineProperty(x.messages, '0', { get() { assert.fail('array accessor invoked'); }, enumerable: true }),
    x => { delete x.messages[0]; },
    x => { x.routing = Object.create({ inherited: true }); },
    x => { x.messages[0].loop = x; },
  ]) { const source = input(); mutate(source); badInput(() => parseSeoulIngestInput(source)); }
});
test('search cannot bypass keyword-only, NUL, scope or exact key rules', () => {
  const base = { spaceId: 'space-1', routing, query: '한글' };
  for (const change of [{ mode: 'semantic' }, { query: 'x\0y' }, { query: '\udfff' }, { query: '' },
    { query: 'x'.repeat(1025) }, { limit: 0 }, { limit: 51 }, { limit: 1.2 }, { target: 'other' },
    { routing: { ...routing, destination: 'agent-memory' } }]) badInput(() => parseSeoulSearchInput({ ...base, ...change }));
});
test('digest accepts only exact lowercase SHA256 hex', () => {
  assert.equal(parseSeoulPatDigest('a'.repeat(64)), 'a'.repeat(64));
  for (const value of ['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null, { digest: 'a'.repeat(64) }]) badInput(() => parseSeoulPatDigest(value));
});
test('archive receipt is metadata-only and bound to actual accepted source bytes and operation', () => {
  const source = parseSeoulIngestInput(input());
  assert.deepEqual(parseSeoulArchiveReceipt(receipt(source), source), receipt(source));
  for (const change of [{ spaceId: 'foreign' }, { operationId: 'other' }, { messageCount: 0 }, { sourceBytes: 1 },
    { content: 'private' }, { state: 'pending' }, { extraction: 'ai' }, { replayed: 'false' }])
    badResult(() => parseSeoulArchiveReceipt({ ...receipt(source), ...change }, source));
});
test('admission envelope has exact numeric safe epochs, strictly positive TTL capped at 30 seconds', () => {
  const value = { admission: { issuedAtMs: 1000, expiresAtMs: 31000 }, result: { authenticated: true } };
  assert.deepEqual(parseSeoulAdmissionEnvelope(value), value);
  for (const admission of [{ issuedAtMs: '1000', expiresAtMs: 2000 }, { issuedAtMs: 1000, expiresAtMs: 1000 },
    { issuedAtMs: -1, expiresAtMs: 1 }, { issuedAtMs: 1000, expiresAtMs: 31001 },
    { issuedAtMs: Number.MAX_SAFE_INTEGER, expiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { issuedAtMs: 1, expiresAtMs: 2, private: 'secret' }]) badResult(() => parseSeoulAdmissionEnvelope({ ...value, admission }));
  badResult(() => parseSeoulAdmissionEnvelope({ ...value, plaintext: 'secret' }));
});
test('native keyword result checks chosen Space, count, revision, UTF8 excerpt and aggregate bounds', () => {
  const request = parseSeoulSearchInput({ spaceId: 'space-1', routing, query: '한글', limit: 2 });
  const value = { spaceId: 'space-1', mode: 'keyword', matches: [{ memoryId: 'm-1', revision: 1, excerpt: '한글' }], count: 1 };
  const parsed = parseSeoulSearchResult(value, request);
  assert.deepEqual(parsed, value);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.matches) && Object.isFrozen(parsed.matches[0]));
  for (const change of [{ spaceId: 'other' }, { mode: 'semantic' }, { count: 2 }, { private: 'secret' },
    { matches: [{ memoryId: 'm-1', revision: 0, excerpt: 'x' }] },
    { matches: [{ memoryId: 'm-1', revision: 1, excerpt: '한'.repeat(683) }] },
    { matches: [{ memoryId: 'm-1', revision: 1, excerpt: 'x\0y' }] }]) badResult(() => parseSeoulSearchResult({ ...value, ...change }, request));
  const hidden = { ...value }; Object.defineProperty(hidden, 'count', { value: 1, enumerable: false });
  badResult(() => parseSeoulSearchResult(hidden, request));
});

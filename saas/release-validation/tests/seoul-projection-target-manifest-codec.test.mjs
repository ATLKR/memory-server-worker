import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import {
  SEOUL_TARGET_MANIFEST_MAX_BYTES, SEOUL_TARGET_SET_MAX_BYTES,
  parseSeoulTargetManifest, encodeSeoulTargetManifest, decodeSeoulTargetManifest, prepareSeoulTargetManifest,
  parseSeoulTargetSet, encodeSeoulTargetSet, decodeSeoulTargetSet, prepareSeoulTargetSet,
} from '../../src/release/seoul-projection-target-manifest-codec.ts';

const ID = '01234567-89ab-4cde-8fab-0123456789ab';
const OTHER_ID = 'fedcba98-7654-4321-8fed-cba987654321';
const manifest = (overrides = {}) => ({ version: 1, manifestId: ID, expectedGeneration: null,
  operatorReference: 'operator:review', spaceIds: ['space:z', 'space:A'], ...overrides });
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const bytes = text => Buffer.byteLength(text, 'utf8');
const invalidManifest = value => assert.throws(() => parseSeoulTargetManifest(value), { message: 'seoul_target_manifest_invalid' });
const invalidSet = value => assert.throws(() => parseSeoulTargetSet(value), { message: 'seoul_target_set_invalid' });
const maxIds = () => Array.from({ length: 1024 }, (_, i) => String(i).padStart(4, '0') + 's'.repeat(124));

test('manifest canonical text owns and orders exactly five fields and ASCII set membership', () => {
  const input = { spaceIds: ['z', 'a_', 'a:', 'a.', 'a-', 'Z', 'A', '0'], operatorReference: 'audit:one',
    expectedGeneration: 17, manifestId: ID, version: 1 };
  const expected = { version: 1, manifestId: ID, expectedGeneration: 17, operatorReference: 'audit:one',
    spaceIds: ['0', 'A', 'Z', 'a-', 'a.', 'a:', 'a_', 'z'] };
  assert.deepEqual(parseSeoulTargetManifest(input), expected);
  assert.equal(encodeSeoulTargetManifest(input), JSON.stringify(expected));
  assert.deepEqual(decodeSeoulTargetManifest(JSON.stringify(expected)), expected);
  assert.deepEqual(input.spaceIds, ['z', 'a_', 'a:', 'a.', 'a-', 'Z', 'A', '0']);
});

test('empty and one-Space sets preserve explicit optional-generation null and safe maximum', () => {
  for (const spaceIds of [[], ['0'], ['a'.repeat(128)]]) {
    for (const expectedGeneration of [null, 1, Number.MAX_SAFE_INTEGER]) {
      const value = manifest({ spaceIds, expectedGeneration });
      assert.deepEqual(decodeSeoulTargetManifest(encodeSeoulTargetManifest(value)), value);
      assert.deepEqual(decodeSeoulTargetSet(encodeSeoulTargetSet(spaceIds)), spaceIds);
    }
  }
  assert.equal(encodeSeoulTargetSet([]), '[]');
});

test('full1024 canonical set and manifest have independent exact maxima above source wire128KiB', async () => {
  const ids = maxIds(), input = manifest({ spaceIds: [...ids].reverse(), expectedGeneration: Number.MAX_SAFE_INTEGER,
    operatorReference: 'a'.repeat(256) });
  const prepared = await prepareSeoulTargetManifest(input);
  assert.equal(SEOUL_TARGET_SET_MAX_BYTES, 134145);
  assert.equal(SEOUL_TARGET_MANIFEST_MAX_BYTES, 134539);
  assert.equal(bytes(prepared.setText), 134145);
  assert.equal(bytes(prepared.manifestText), 134539);
  assert.equal(bytes(JSON.stringify(prepared.manifestText)), 136603);
  assert.ok(bytes(prepared.setText) > 131072);
  assert.deepEqual(prepared.manifest.spaceIds, ids);
  assert.deepEqual(decodeSeoulTargetManifest(prepared.manifestText), prepared.manifest);
  assert.deepEqual(decodeSeoulTargetSet(prepared.setText), ids);
  assert.equal(prepared.manifestSha256, hash('memory:seoul-target-manifest:v1\n' + prepared.manifestText));
  assert.equal(prepared.setSha256, hash('memory:seoul-target-set:v1\n' + prepared.setText));
  invalidSet([...ids, 'another']); invalidManifest(manifest({ spaceIds: [...ids, 'another'] }));
});

test('manifest and set SHA256 domains bind complete canonical identities independently', async () => {
  const a = await prepareSeoulTargetManifest(manifest());
  const b = await prepareSeoulTargetManifest(manifest({ spaceIds: ['space:A', 'space:z'] }));
  assert.deepEqual(a, b);
  assert.deepEqual(await prepareSeoulTargetSet(['space:z', 'space:A']), {
    spaceIds: ['space:A', 'space:z'], setText: '["space:A","space:z"]', setSha256: a.setSha256,
  });
  for (const change of [{ manifestId: OTHER_ID }, { expectedGeneration: 1 }, { operatorReference: 'audit:another' }]) {
    const changed = await prepareSeoulTargetManifest(manifest(change));
    assert.notEqual(changed.manifestSha256, a.manifestSha256);
    assert.equal(changed.setSha256, a.setSha256);
  }
  const changed = await prepareSeoulTargetManifest(manifest({ spaceIds: ['space:A'] }));
  assert.notEqual(changed.manifestSha256, a.manifestSha256);
  assert.notEqual(changed.setSha256, a.setSha256);
  assert.notEqual(a.setSha256, hash(a.setText));
  assert.notEqual(a.manifestSha256, hash(a.manifestText));
  assert.notEqual(a.setSha256, hash('memory:seoul-target-manifest:v1\n' + a.setText));
});

test('manifest parse and async preparation own frozen values before the first await', async () => {
  const input = manifest(), preparedPromise = prepareSeoulTargetManifest(input);
  const parsed = parseSeoulTargetManifest(input);
  input.manifestId = OTHER_ID; input.expectedGeneration = 99; input.operatorReference = 'different';
  input.spaceIds[0] = 'changed'; input.spaceIds.push('extra');
  const prepared = await preparedPromise;
  assert.deepEqual(prepared.manifest, manifest({ spaceIds: ['space:A', 'space:z'] }));
  assert.deepEqual(parsed, prepared.manifest);
  for (const result of [prepared, prepared.manifest, prepared.manifest.spaceIds, parsed, parsed.spaceIds]) assert.ok(Object.isFrozen(result));
  assert.throws(() => prepared.manifest.spaceIds.push('later'), TypeError);
  assert.throws(() => { prepared.manifest.operatorReference = 'later'; }, TypeError);
  assert.deepEqual(Object.keys(prepared), ['manifest', 'manifestText', 'manifestSha256', 'setText', 'setSha256']);
});

test('standalone set parsing and hashing copy and freeze without mutating caller order', async () => {
  const input = ['z', 'A'], promise = prepareSeoulTargetSet(input), parsed = parseSeoulTargetSet(input);
  input[0] = 'modified'; input.push('new');
  const result = await promise;
  assert.deepEqual(parsed, ['A', 'z']); assert.deepEqual(result.spaceIds, parsed);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.spaceIds)); assert.ok(Object.isFrozen(parsed));
  assert.equal(result.setSha256, hash('memory:seoul-target-set:v1\n["A","z"]'));
});

test('closed manifest accepts null-prototype data records and frozen ordinary arrays', () => {
  const value = Object.assign(Object.create(null), manifest({ spaceIds: Object.freeze(['b', 'a']) }));
  assert.deepEqual(parseSeoulTargetManifest(value), manifest({ spaceIds: ['a', 'b'] }));
  assert.deepEqual(parseSeoulTargetSet(Object.freeze(['b', 'a'])), ['a', 'b']);
});

test('manifest rejects wrong scalar domains without coercion', () => {
  for (const version of [undefined, null, false, 0, '1', 2, 1n]) invalidManifest(manifest({ version }));
  for (const manifestId of [undefined, null, 1, '', ID.toUpperCase(), ID + '\n', ID.replace(/-/g, ''), 'a'.repeat(36), new String(ID)]) invalidManifest(manifest({ manifestId }));
  for (const expectedGeneration of [undefined, false, '', '1', 0, -0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, new Number(1)]) invalidManifest(manifest({ expectedGeneration }));
  for (const operatorReference of [undefined, null, false, '', 'a'.repeat(257), 'a\n', 'a\r', ' a', 'a ', '_a', '-a', ':a', '.a', 'a/b', 'a@b', '한글', new String('audit')]) invalidManifest(manifest({ operatorReference }));
});

test('set rejects duplicates rather than deduplicating and enforces complete ASCII128 grammar', () => {
  for (const value of [undefined, null, true, '', '[]', {}, new Set(['a']), new Uint8Array([1])]) { invalidSet(value); invalidManifest(manifest({ spaceIds: value })); }
  for (const value of [undefined, null, false, 1, {}, new String('a'), '', 'a'.repeat(129), '한글', 'é', '\ud800', 'a\u0000', 'a\n', 'a\r', 'a\r\n', 'a\t', ' a', 'a ', '_a', '.a', '-a', ':a', 'a/b', 'a@b', 'a\\b']) {
    invalidSet([value]); invalidManifest(manifest({ spaceIds: [value] }));
  }
  for (const value of [['a', 'a'], ['z', 'A', 'z'], [...maxIds(), '0000' + 's'.repeat(124)]]) { invalidSet(value); invalidManifest(manifest({ spaceIds: value })); }
  assert.deepEqual(parseSeoulTargetSet(['a', 'A']), ['A', 'a']);
});

test('manifest rejects missing, extra, symbol, accessor and non-data record shapes', () => {
  for (const value of [undefined, null, true, 1, [], new Date(), new (class M { constructor() { Object.assign(this, manifest()); } })(), runInNewContext('({version:1})')]) invalidManifest(value);
  for (const key of Object.keys(manifest())) { const value = manifest(); delete value[key]; invalidManifest(value); }
  const extra = manifest(); extra.extra = true; invalidManifest(extra);
  const symbol = manifest(); symbol[Symbol('extra')] = true; invalidManifest(symbol);
  const hidden = manifest(); Object.defineProperty(hidden, 'hidden', { value: 1 }); invalidManifest(hidden);
  for (const key of Object.keys(manifest())) {
    let calls = 0; const value = manifest(); Object.defineProperty(value, key, { enumerable: true, get() { calls++; throw Error('getter ran'); } });
    invalidManifest(value); assert.equal(calls, 0);
    const nonEnumerable = manifest(); Object.defineProperty(nonEnumerable, key, { value: nonEnumerable[key], enumerable: false }); invalidManifest(nonEnumerable);
  }
});

test('set rejects sparse/accessor/extra/prototype arrays without invoking element getters', () => {
  const sparse = new Array(2); sparse[1] = 'a'; invalidSet(sparse);
  let calls = 0; const accessor = ['a']; Object.defineProperty(accessor, '0', { enumerable: true, get() { calls++; return 'a'; } });
  invalidSet(accessor); invalidManifest(manifest({ spaceIds: accessor })); assert.equal(calls, 0);
  const hidden = ['a']; Object.defineProperty(hidden, '0', { value: 'a', enumerable: false }); invalidSet(hidden);
  const extra = ['a']; extra.extra = true; invalidSet(extra);
  const symbol = ['a']; symbol[Symbol('extra')] = true; invalidSet(symbol);
  const custom = ['a']; Object.setPrototypeOf(custom, null); invalidSet(custom);
  invalidSet(new (class A extends Array {})('a'));
  invalidSet(runInNewContext('["a"]'));
  const pair = Proxy.revocable(['a'], {}); pair.revoke(); invalidSet(pair.proxy);
});

test('canonical decoders reject alternate representation, invalid UTF8-domain text and oversize before parse', () => {
  const canonical = encodeSeoulTargetManifest(manifest());
  for (const value of [null, 1, new String(canonical), '\ufeff' + canonical, ' ' + canonical, canonical + '\n',
    canonical.replace('"version":1', '"version":1.0'), canonical.replace('"version":1', '"version":1,"version":1'),
    JSON.stringify(manifest()), canonical.replace('space:A', 'space:\\u0041'), '{', ' '.repeat(134540)]) {
    assert.throws(() => decodeSeoulTargetManifest(value), { message: 'seoul_target_manifest_invalid' });
  }
  for (const value of [null, 1, new String('[]'), '\ufeff[]', ' []', '[]\n', '["z","A"]', '["a","a"]', '["\\u0061"]', '["한글"]', '[' + ' '.repeat(134145) + ']']) {
    assert.throws(() => decodeSeoulTargetSet(value), { message: 'seoul_target_set_invalid' });
  }
});

test('async preparation rejects invalid owned input with the same fixed domain error', async () => {
  await assert.rejects(prepareSeoulTargetManifest(manifest({ spaceIds: ['duplicate', 'duplicate'] })), { message: 'seoul_target_manifest_invalid' });
  await assert.rejects(prepareSeoulTargetSet(['duplicate', 'duplicate']), { message: 'seoul_target_set_invalid' });
});

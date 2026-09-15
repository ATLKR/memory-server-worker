import test from 'node:test';
import assert from 'node:assert/strict';
let util;
try { util = await import('../../src/release/util.ts'); } catch {}
test('canonical request hashing ignores object insertion order', async () => {
  assert.ok(util?.canonical, 'canonical implementation is missing');
  assert.equal(util.canonical({b:2,a:[1,3]}), util.canonical({a:[1,3],b:2}));
});
test('scope policy separates create from delete', () => {
  assert.ok(util?.capabilitiesFromScopes, 'scope mapping implementation is missing');
  assert.deepEqual(util.capabilitiesFromScopes(['memory:read','memory:write']), ['read','create','update']);
});
test('cursor is bound to its resource', () => {
  assert.ok(util?.decodeCursor, 'cursor implementation is missing');
  assert.throws(() => util.decodeCursor(util.encodeCursor('space-a',['42']), 'space-b'));
});

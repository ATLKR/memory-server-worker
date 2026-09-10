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

for (const deadline of [false, true]) test('release rejected pending read '+(deadline ? 'after timeout remains408' : 'before timeout preserves the stream failure'), async t => {
  const failure = new Error('Stream was cancelled.');
  let rejectRead;
  const response = new Response('{}');
  response.body.getReader = () => ({
    read: () => deadline ? new Promise((_, reject) => { rejectRead = reject; }) : Promise.reject(failure),
    cancel: () => { rejectRead?.(failure); return Promise.resolve(); },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = util.readBytes(response).catch(error => error);
  if (deadline) t.mock.timers.tick(10000);
  const error = await pending;
  if (deadline) { assert.equal(error.status, 408); assert.equal(error.code, 'read_timeout'); }
  else assert.equal(error, failure);
});

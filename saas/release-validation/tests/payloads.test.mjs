import { payloadShard, payloadBucket } from './payload-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PayloadStore } from '../../src/release/payloads.ts';
import { canonical, digest } from '../../src/release/util.ts';
import { ftsQuery } from '../../src/release/search.ts';

const content = { body: '₿budget alpha', source: 'source', provenance: { originKind: 'user' } };
const context = { spaceId: 'space-a', memoryId: 'memory-a' };
const config = [{ id: 'one', binding: 'HOT_ONE', mode: 'active' }, { id: 'two', binding: 'HOT_TWO', mode: 'active' }];
function setup(t, overrides = {}) {
  const first = payloadShard(), second = payloadShard(), r2 = payloadBucket(); t.after(() => { first.raw.close(); second.raw.close(); });
  const env = { STORAGE_MODE: 'sharded', STORAGE_SHARDS_JSON: JSON.stringify(config), HOT_ONE: first, HOT_TWO: second, MEMORY_PAYLOADS: r2, ...overrides };
  return { env, first, second, r2, store: new PayloadStore(env), selected: ref => ref.shardId === 'one' ? first : second };
}
const expectCode = code => error => error.code === code;

test('descriptor is pure, deterministic, bounded and selects only configured active physical shards', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'payload-a');
  assert.equal(f.store.enabled, true); assert.deepEqual(f.store.shardIds(), ['one', 'two']);
  assert.deepEqual(await f.store.descriptor(context, { provenance: content.provenance, source: content.source, body: content.body }, 'payload-a'), ref);
  assert.equal(ref.sha256, await digest(canonical(content))); assert.equal(ref.bytes, new TextEncoder().encode(canonical(content)).length);
  assert.equal(f.r2.calls.length, 0); assert.equal(f.first.raw.prepare('SELECT count(*) AS n FROM payloads').get().n, 0);
  const seen = new Set(); for (let n = 0; n < 30; n++) seen.add((await f.store.descriptor({ ...context, spaceId: 'space-' + n }, content, 'payload-' + n)).shardId);
  assert.deepEqual([...seen].sort(), ['one', 'two']);
  const oneSpace = new Set(); for (let n = 0; n < 30; n++) oneSpace.add((await f.store.descriptor(context, content, 'one-space-' + n)).shardId);
  assert.deepEqual([...oneSpace].sort(), ['one', 'two'], 'one Space can grow across physical databases');
  const draining = new PayloadStore({ ...f.env, STORAGE_SHARDS_JSON: JSON.stringify([{ ...config[0], mode: 'draining' }, config[1]]) });
  assert.equal((await draining.descriptor(context, content, 'new')).shardId, 'two'); assert.deepEqual(draining.shardIds(), ['one', 'two']);
});

for (const [name, changes] of [
  ['invalid mode', { STORAGE_MODE: 'other' }], ['invalid JSON', { STORAGE_SHARDS_JSON: '[' }], ['missing R2', { MEMORY_PAYLOADS: undefined }],
  ['no active shard', { STORAGE_SHARDS_JSON: JSON.stringify(config.map(row => ({ ...row, mode: 'draining' }))) }],
  ['duplicate shard', { STORAGE_SHARDS_JSON: JSON.stringify([config[0], config[0]]) }],
  ['prototype binding', { STORAGE_SHARDS_JSON: JSON.stringify([{ id: 'bad', binding: '__proto__', mode: 'active' }]) }],
  ['central binding', { STORAGE_SHARDS_JSON: JSON.stringify([{ id: 'bad', binding: 'DB', mode: 'active' }]) }],
  ['too many shards', { STORAGE_SHARDS_JSON: JSON.stringify(Array.from({ length: 17 }, (_, n) => ({ id: 's' + n, binding: 'D' + n, mode: 'active' }))) }],
]) test('storage configuration rejects ' + name, t => { assert.throws(() => setup(t, changes), expectCode('storage_configuration_invalid')); });

test('inline mode requires no providers and cannot accidentally allocate external payloads', async () => {
  const store = new PayloadStore({}); assert.equal(store.enabled, false); assert.deepEqual(store.shardIds(), []);
  await assert.rejects(() => store.descriptor(context, content, 'payload-a'), expectCode('storage_not_configured'));
});

test('stage verifies both stores, repeats without overwrite, and reads the exact context', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'payload-a');
  await f.store.stage(context, ref, content); const stored = f.r2.objects.get(ref.objectKey), etag = stored.etag;
  await f.store.stage(context, ref, content); assert.equal(f.r2.objects.get(ref.objectKey).etag, etag);
  assert.equal(f.selected(ref).raw.prepare('SELECT count(*) AS n FROM payloads').get().n, 1);
  assert.deepEqual(await f.store.read(context, ref), content);
  await assert.rejects(() => f.store.stage(context, { ...ref, shardId: ref.shardId === 'one' ? 'two' : 'one' }, content), expectCode('payload_context_mismatch'));
  assert.equal(f.r2.objects.get(ref.objectKey).text, canonical(content));
  const wrong = { ...context, memoryId: 'foreign' };
  for (const call of [() => f.store.stage(wrong, ref, content), () => f.store.read(wrong, ref), () => f.store.purge(wrong, ref)])
    await assert.rejects(call, expectCode('payload_context_mismatch'));
  assert.deepEqual(await f.store.read(context, ref), content);
});

test('mismatching immutable object or descriptor never overwrites retained bytes', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'payload-a'); await f.store.stage(context, ref, content);
  const before = f.r2.objects.get(ref.objectKey).text;
  await assert.rejects(() => f.store.stage(context, ref, { ...content, body: 'different' }), expectCode('payload_integrity_error'));
  f.r2.objects.get(ref.objectKey).text = 'corrupt'; f.r2.objects.get(ref.objectKey).size = 7;
  await assert.rejects(() => f.store.stage(context, ref, content), expectCode('payload_integrity_error'));
  assert.equal(f.r2.objects.get(ref.objectKey).text, 'corrupt'); assert.notEqual(before, 'corrupt');
});

test('hot retirement keeps R2 history and blocks a late hot insertion', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'payload-a'); await f.store.stage(context, ref, content);
  await f.store.retireHot(context, ref); await f.store.retireHot(context, ref);
  assert.equal(f.selected(ref).raw.prepare('SELECT count(*) AS n FROM payloads').get().n, 0);
  assert.equal(f.selected(ref).raw.prepare('SELECT count(*) AS n FROM payload_fts').get().n, 0);
  assert.deepEqual(await f.store.read(context, ref), content);
  await assert.rejects(() => f.store.stage(context, ref, content), expectCode('payload_retired'));
  assert.equal(f.r2.objects.get(ref.objectKey).text, canonical(content));
});

test('R2 or shard staging failure remains observable and exact retry recovers partial state', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'payload-a'); f.r2.beforePut = async () => { throw Error('synthetic_R2_down'); };
  await assert.rejects(() => f.store.stage(context, ref, content), /synthetic_R2_down/); assert.equal(f.selected(ref).raw.prepare('SELECT count(*) AS n FROM payloads').get().n, 0);
  f.r2.beforePut = null; const db = f.selected(ref), prepare = db.prepare.bind(db);
  db.prepare = sql => { if (sql.startsWith('INSERT INTO payloads')) throw Error('synthetic_D1_down'); return prepare(sql); };
  await assert.rejects(() => f.store.stage(context, ref, content), /synthetic_D1_down/); assert.equal(f.r2.objects.get(ref.objectKey).text, canonical(content));
  db.prepare = prepare; await f.store.stage(context, ref, content); assert.deepEqual(await f.store.read(context, ref), content);
});

test('purge tombstone prevents a held create-only R2 upload from resurrecting plaintext', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'payload-a'); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  f.r2.beforePut = async (key, value) => { if (value.length) { entered(); await held; } };
  const uploading = f.store.stage(context, ref, content); await started;
  await f.store.purge(context, ref); release(); await assert.rejects(() => uploading, expectCode('payload_purged'));
  assert.equal(f.r2.objects.get(ref.objectKey).size, 0); assert.equal(f.selected(ref).raw.prepare('SELECT count(*) AS n FROM payloads').get().n, 0);
  await f.store.purge(context, ref); await assert.rejects(() => f.store.read(context, ref), expectCode('payload_purged'));
});

test('purge fences a held shard INSERT after R2 upload and preserves terminal tombstones', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'payload-a'), db = f.selected(ref); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const prepare = db.prepare.bind(db); db.prepare = sql => {
    const statement = prepare(sql); if (sql.startsWith('INSERT INTO payloads')) { const run = statement.run.bind(statement); statement.run = async () => { entered(); await held; return run(); }; } return statement;
  };
  const uploading = f.store.stage(context, ref, content); await started; await f.store.purge(context, ref); release();
  await assert.rejects(() => uploading, expectCode('payload_retired')); assert.equal(f.r2.objects.get(ref.objectKey).size, 0);
  assert.equal(db.raw.prepare('SELECT count(*) AS n FROM payloads').get().n, 0);
  assert.throws(() => db.raw.exec('DELETE FROM payload_tombstones'), /payload_tombstone_immutable/);
});

test('cold read detects missing, corrupt and oversized objects without fabricated content', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'payload-a'); await f.store.stage(context, ref, content); await f.store.retireHot(context, ref);
  const saved = f.r2.objects.get(ref.objectKey); f.r2.objects.delete(ref.objectKey);
  await assert.rejects(() => f.store.read(context, ref), expectCode('payload_unavailable'));
  f.r2.objects.set(ref.objectKey, { ...saved, text: saved.text.replace('alpha', 'omega') });
  await assert.rejects(() => f.store.read(context, ref), expectCode('payload_integrity_error'));
  f.r2.objects.set(ref.objectKey, { ...saved, size: 131073 });
  await assert.rejects(() => f.store.read(context, ref), expectCode('payload_integrity_error'));
  let cancelled = false; f.r2.get = async () => ({ ...saved, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(ref.bytes + 1)); }, cancel() { cancelled = true; } }) });
  await assert.rejects(() => f.store.read(context, ref), expectCode('payload_integrity_error')); assert.equal(cancelled, true);
});

test('tenant FTS pages retain staged versions separately and keep cursor context and ordering', async t => {
  const f = setup(t), wanted = [];
  const shardId = (await f.store.descriptor(context, content, 'old-revision')).shardId;
  for (let n = 0; n < 7; n++) {
    const ctx = { ...context, memoryId: 'memory-' + n }, data = { ...content, body: n % 2 ? 'alpha alpha' : 'alpha' }, ref = { ...await f.store.descriptor(ctx, data, 'payload-' + n), shardId };
    await f.store.stage(ctx, ref, data); wanted.push(ref.id);
  }
  const old = await f.store.descriptor(context, content, 'old-revision'); await f.store.stage(context, old, content); wanted.push(old.id);
  const newer = { ...await f.store.descriptor(context, content, 'prepared-revision'), shardId }; await f.store.stage(context, newer, content); wanted.push(newer.id);
  const foreignContext = { ...context, spaceId: 'other-space' }, foreign = { ...await f.store.descriptor(foreignContext, content, 'foreign'), shardId: old.shardId };
  await f.store.stage(foreignContext, foreign, content);
  const expression = ftsQuery('alpha'), ids = []; let after = null, firstCursor;
  const ranked = await f.store.searchPage(old.shardId, context.spaceId, expression, null, 3);
  assert.deepEqual(ranked.results.map(row => row.memoryId), ['memory-1', 'memory-3', 'memory-5']);
  assert.ok(ranked.results.every(row => row.score === 4 / 91), 'ranking uses the same local byte density as inline FTS');
  do { const page = await f.store.searchPage(old.shardId, context.spaceId, expression, after, 2); ids.push(...page.results.map(row => row.payloadId)); after = page.nextCursor; firstCursor ??= after; } while (after);
  assert.deepEqual(ids.slice().sort(), wanted.sort()); assert.equal(new Set(ids).size, ids.length);
  for (const [shardId, spaceId, query] of [[old.shardId, 'other-space', expression], [old.shardId, context.spaceId, ftsQuery('budget')], [old.shardId === 'one' ? 'two' : 'one', context.spaceId, expression]])
    await assert.rejects(() => f.store.searchPage(shardId, spaceId, query, firstCursor, 2), expectCode('invalid_cursor'));
  await assert.rejects(() => f.store.searchPage(old.shardId, context.spaceId, ') OR tenant:tother', null, 2), expectCode('invalid_search_expression'));
});

test('wrong context cannot poison an absent R2 key while a hot payload or tombstone remains', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'context-loss'); await f.store.stage(context, ref, content);
  f.r2.objects.delete(ref.objectKey);
  await assert.rejects(() => f.store.purge({ ...context, memoryId: 'wrong-memory' }, ref), expectCode('payload_context_mismatch'));
  assert.equal(f.r2.objects.has(ref.objectKey), false); assert.deepEqual(await f.store.read(context, ref), content);
  await f.store.retireHot(context, ref);
  await assert.rejects(() => f.store.purge({ ...context, spaceId: 'wrong-space' }, ref), expectCode('payload_context_mismatch'));
  assert.equal(f.r2.objects.has(ref.objectKey), false);
});

test('shard schema rejects ordinary payload edits and preserves generated migration bytes', async t => {
  const f = setup(t), ref = await f.store.descriptor(context, content, 'payload-a'); await f.store.stage(context, ref, content); const db = f.selected(ref);
  for (const sql of ["UPDATE payloads SET content='{}'", 'DELETE FROM payloads', 'INSERT OR REPLACE INTO payloads SELECT * FROM payloads']) assert.throws(() => db.raw.exec(sql), /payload_immutable/);
  const source = readFileSync(new URL('../../shard-schema.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(readFileSync(new URL('../../shard-migrations/0001_payloads.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n'), '-- Generated from shard-schema.sql; independent hot-shard migration 1.\n' + source);
});

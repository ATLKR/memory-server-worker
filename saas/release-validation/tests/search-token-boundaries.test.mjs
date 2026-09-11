import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, at } from './db.mjs';
import { MemoryStore } from '../../src/release/memory.ts';
import { Search, ftsQuery } from '../../src/release/search.ts';
import { unicode61Token } from '../../src/release/unicode61.ts';
import { createRelease } from '../../src/release/extension.ts';

test('frozen category boundaries agree with actual SQLite Unicode61 tokenization', async t => {
  const { db } = await fixture(); t.after(() => db.close());
  db.raw.exec("CREATE VIRTUAL TABLE boundary_text USING fts5(body); CREATE VIRTUAL TABLE boundary_vocab USING fts5vocab(boundary_text,'instance')");
  // The generated table only selects probes. Native SQLite, not the generator,
  // determines whether each scalar contributes an actual indexed token.
  const source = readFileSync(new URL('../../src/release/unicode61.ts', import.meta.url), 'utf8');
  const edges = [...source.matchAll(/0x[0-9a-f]+/g)].map(match => Number(match[0]));
  const points = [...new Set([...edges.flatMap(code => [code - 1, code, code + 1]), 0x20bf, 0x1fae0, 0x1ab0, 0x1c90, 0x1e900, 0x10ffff])]
    .filter(code => code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
  const insert = db.raw.prepare('INSERT INTO boundary_text(rowid,body) VALUES(?,?)');
  db.raw.exec('BEGIN');
  for (const code of points) insert.run(code + 1, String.fromCodePoint(code));
  db.raw.exec('COMMIT');
  const indexed = new Set(db.raw.prepare('SELECT DISTINCT doc FROM boundary_vocab').all().map(row => row.doc - 1));
  assert.ok(points.length > 1800, 'Probe both sides of the full frozen category range table');
  for (const code of points) assert.equal(unicode61Token(code), indexed.has(code), 'U+' + code.toString(16).toUpperCase());
});

for (const [query, distractors] of [
  ['₿budget', ['budget']], ['🫠alpha', ['alpha']], ['x🫠y', ['xylophone', 'yellow']],
  ['a\u061cb', ['apple', 'banana']], ['a\u2e4fb', ['apple', 'banana']],
]) test('REST finds the exact native symbol token without cross-Space or dropped-character hits: ' + query, async t => {
  const { db, token, other } = await fixture(); t.after(() => db.close());
  const store = new MemoryStore(db, () => at), target = await store.create(token, 's1', { body: query }, 'target');
  for (const [index, body] of distractors.entries()) await store.create(token, 's1', { body }, 'distractor-' + index);
  await store.create(other, 's2', { body: query }, 'foreign');
  const release = createRelease({ DB: db, PUBLIC_ORIGIN: 'https://memory.example.com' }, { clock: () => at });
  const response = await release.route(new Request('https://memory.example.com/v1/spaces/s1/memories?query=' + encodeURIComponent(query)), token);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).results.map(row => row.id), [target.id]);
});

test('known Unicode separators retain independent OR groups and per-group length limits', async t => {
  const { db, token, other } = await fixture(); t.after(() => db.close());
  const store = new MemoryStore(db, () => at), alpha = await store.create(token, 's1', { body: 'alpha' }, 'alpha'), beta = await store.create(token, 's1', { body: 'beta' }, 'beta');
  await store.create(other, 's2', { body: 'alpha beta' }, 'foreign');
  const search = new Search({ DB: db }, () => at);
  for (const [index, separator] of ['、', '。', '€', '😀', '\u00a0', '\u2003', '\u2028', '\u3000', '\u180e', '\u200d', '\ufffe', '\uffff'].entries()) {
    const query = 'alpha' + separator + 'beta';
    assert.equal(ftsQuery(query), '"alpha"* OR "beta"*');
    assert.deepEqual((await search.query(token, 's1', query, 50, 'separated-' + index)).results.map(row => row.id).sort(), [alpha.id, beta.id].sort());
  }
  const first = 'a'.repeat(31), second = 'b'.repeat(31);
  assert.equal(ftsQuery(first + '、' + second), '"' + first + '"* OR "' + second + '"*');
  await search.query(token, 's1', first + '、' + second, 10, 'long-separated');
});

test('new native tokens retain raw31 length,20 distinct groups, byte limits and literal operator handling', async t => {
  const { db, token } = await fixture(); t.after(() => db.close()); let calls = 0;
  const search = new Search({ DB: db, AI: { async run() { calls++; } }, MEMORY_INDEX: { async query() { calls++; } } }, () => at);
  for (const character of ['₿', '🫠', '\u061c', '\u2e4f']) {
    assert.equal(ftsQuery(character.repeat(31)), '"' + character.repeat(31) + '"*');
    await assert.rejects(() => search.query(token, 's1', character.repeat(32), 10, 'too-long'), error => error.status === 400 && error.code === 'search_token_too_long');
  }
  await assert.rejects(() => search.query(token, 's1', '🫠 '.repeat(205), 10, 'too-many-bytes'), error => error.status === 400);
  assert.equal(calls, 0); assert.equal(db.raw.prepare('SELECT count(*) AS n FROM release_operations').get().n, 0);
  const groups = Array.from({ length: 21 }, (_, index) => '🫠term' + index);
  assert.equal(ftsQuery(groups[0] + '、' + groups.join(' ')), groups.slice(0, 20).map(group => '"' + group + '"*').join(' OR '));
  const query = '"₿budget" OR (tenant:"s2" NOT 🫠alpha*)';
  assert.equal(ftsQuery(query), '"₿budget"* OR "OR"* OR "tenant"* OR "s2"* OR "NOT"* OR "🫠alpha"*');
});

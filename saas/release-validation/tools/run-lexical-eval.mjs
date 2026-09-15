import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fixture, at } from '../tests/db.mjs';
import { MemoryStore } from '../../src/release/memory.ts';
import { Search } from '../../src/release/search.ts';
import { evaluate } from './evaluate.mjs';

// Synthetic, local, actual retrieval; no network, provider, or production data.
const jsonl = async name => (await readFile(new URL('../eval/' + name, import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
const corpus = await jsonl('corpus.jsonl'), cases = await jsonl('cases.jsonl');
const { db, token, other } = await fixture();
try {
  const store = new MemoryStore(db, () => at), search = new Search({ DB: db }, () => at);
  const ids = new Map(), reverse = new Map();
  // Insert predecessors first so the new current fact uses the real supersession API.
  const ordered = [...corpus.filter(x => x.supersededBy), ...corpus.filter(x => !x.supersededBy)];
  for (const row of ordered) {
    const predecessor = corpus.find(x => x.supersededBy === row.id);
    const owner = row.spaceId === 'eval-private' ? other : token;
    const spaceId = row.spaceId === 'eval-private' ? 's2' : 's1';
    const memory = await store.create(owner, spaceId, { body: row.body, kind: row.kind ?? 'fact',
      provenance: { originKind: 'import', sourceEventId: row.id },
      ...(predecessor ? { supersedesMemoryId: ids.get(predecessor.id) } : {}) }, row.id);
    ids.set(row.id, memory.id); reverse.set(memory.id, row.id);
    if (row.deleted) await store.remove(owner, spaceId, memory.id, memory.revision, 'delete-' + row.id);
  }
  const responses = [];
  for (const c of cases) {
    const start = performance.now();
    const result = await search.query(token, 's1', c.query, 5, 'eval-' + c.id);
    responses.push({ caseId: c.id, results: result.results.map(x => reverse.get(x.id)), latencyMs: performance.now() - start });
  }
  const score = evaluate(cases, responses);
  assert.equal(score.complete, true); assert.equal(score.forbiddenHits, 0); assert.equal(score.staleHits, 0);
  console.log(JSON.stringify({ engine: 'local SQLite FTS5; semantic providers absent', ...score,
    notice: 'Actual synthetic local lexical retrieval. Recall is measured, not a semantic quality claim; latency excludes network.' }, null, 2));
} finally { db.close(); }

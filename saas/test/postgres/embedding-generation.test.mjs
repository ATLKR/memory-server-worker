import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmbeddingGeneration, embeddingGenerationFingerprint, sourceSnapshotFingerprint, assertQueryGeneration, prepareGenerationPromotion } from '../../src/routing/embedding-generation.ts';

const hash = character => character.repeat(64);
const generation = (patch = {}) => ({ version: 1, kind: 'direct', id: 'generation-v2', scopeId: 'space-1', provider: 'workers-ai', model: 'fixture/embedder-v1', revision: 'model-release-2026-09', dimensions: 3, metric: 'cosine', normalization: 'none', chunkerVersion: 'chunker-v2', target: { provider: 'cloudflare-vectorize', region: 'cloudflare', resourceId: 'space-index-v2' }, ...patch });
const record = (patch = {}) => ({ sourceId: 'memory-1', revision: 1, state: 'live', contentHash: hash('a'), chunkCount: 2, ...patch });
const snapshot = (records = [record()], sequence = 10) => ({ version: 1, scopeId: 'space-1', sourceEpoch: 1, sequence, records });
const now = 1789120000000;

async function fixture() {
  const candidate = generation(), fingerprint = await embeddingGenerationFingerprint(candidate), currentSnapshot = snapshot();
  const sourceFingerprint = await sourceSnapshotFingerprint(currentSnapshot);
  const currentGeneration = generation({ id: 'generation-v1', target: { ...candidate.target, resourceId: 'space-index-v1' } });
  const pointer = { scopeId: 'space-1', epoch: 3, generationId: 'generation-v1', fingerprint: await embeddingGenerationFingerprint(currentGeneration) };
  return { mode: 'promote', candidate, requiredRegion: 'cloudflare', expectedPointer: pointer, currentPointer: { ...pointer }, currentGeneration, buildSnapshot: currentSnapshot, currentSnapshot,
    events: [], inventory: [0, 1].map(chunk => ({ sourceId: 'memory-1', revision: 1, contentHash: hash('a'), chunk, fingerprint })),
    evidence: { generationFingerprint: fingerprint, buildSourceFingerprint: sourceFingerprint, sourceFingerprint, reconciledThrough: 10, pendingWrites: 0, pendingDeletes: 0, unknownMutations: 0, observedAtMs: now - 10, retained: true },
    evaluation: { generationFingerprint: fingerprint, sourceFingerprint, passed: true, observedAtMs: now - 10, evidenceId: 'evaluation-v2' },
    authority: { scopeId: 'space-1', epoch: 4, allowed: true, checkedAtMs: now - 1 }, nowMs: now };
}

test('validated descriptors are immutable copies including targets', () => {
  const input = generation(), parsed = parseEmbeddingGeneration(input);
  input.model = 'changed'; input.target.resourceId = 'changed';
  assert.equal(parsed.model, 'fixture/embedder-v1');
  assert.equal(parsed.target.resourceId, 'space-index-v2');
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.target));
});

test('every coordinate and target field participates in a stable generation fingerprint', async () => {
  const initial = generation(), before = await embeddingGenerationFingerprint(initial);
  assert.equal(before, await embeddingGenerationFingerprint({ ...initial, target: { ...initial.target } }));
  for (const change of [{ id: 'generation-v3' }, { scopeId: 'space-2' }, { model: '@cf/another-model' }, { revision: 'release-2' }, { dimensions: 4 }, { metric: 'euclidean' }, { normalization: 'l2' }, { chunkerVersion: 'chunker-v3' }, { target: { ...initial.target, resourceId: 'index-v3' } }]) {
    assert.notEqual(before, await embeddingGenerationFingerprint(generation(change)));
  }
});

test('region/provider mismatches, mutable revision labels and invalid dimensions are rejected', () => {
  for (const change of [{ dimensions: 1537 }, { revision: 'latest' }, { revision: 'main' }, { chunkerVersion: 'current' }, { model: '' }, { metric: 'l1' }, { provider: 'seoul-local' }, { target: { provider: 'cloudflare-vectorize', region: 'kr-seoul', resourceId: 'index' } }, { secret: 'unrecognized' }]) {
    assert.throws(() => parseEmbeddingGeneration(generation(change)), { code: 'embedding_generation_invalid' });
  }
  const seoul = generation({ provider: 'seoul-local', target: { provider: 'seoul-pgvector', region: 'kr-seoul', resourceId: 'seoul-index-v2' }, dimensions: 2000 });
  assert.doesNotThrow(() => parseEmbeddingGeneration(seoul));
  assert.throws(() => parseEmbeddingGeneration({ ...seoul, dimensions: 2001 }), { code: 'embedding_generation_invalid' });
});

test('managed Agent Memory cannot claim caller-controlled embedding coordinates or direct upgrade support', async () => {
  const managed = { version: 1, kind: 'managed-agent-memory', id: 'profile-generation-1', scopeId: 'space-1', modelControl: 'provider-managed', target: { provider: 'cloudflare-agent-memory', region: 'cloudflare', resourceId: 'profile-1' } };
  assert.equal(parseEmbeddingGeneration(managed).modelControl, 'provider-managed');
  assert.throws(() => parseEmbeddingGeneration({ ...managed, model: 'chosen-by-us' }), { code: 'embedding_generation_invalid' });
  await assert.rejects(assertQueryGeneration(managed, { fingerprint: await embeddingGenerationFingerprint(managed), vector: [1, 0, 0] }), { code: 'embedding_model_provider_managed' });
});

test('query requires exact generation, dimensions, finite numbers and appropriate normalization', async () => {
  const direct = generation(), fingerprint = await embeddingGenerationFingerprint(direct);
  await assertQueryGeneration(direct, { fingerprint, vector: [1, 0, 0] });
  for (const query of [{ fingerprint: hash('f'), vector: [1, 0, 0] }, { fingerprint, vector: [1, 0] }, { fingerprint, vector: [NaN, 0, 0] }, { fingerprint, vector: [Infinity, 0, 0] }, { fingerprint, vector: [0, 0, 0] }]) {
    await assert.rejects(assertQueryGeneration(direct, query), { code: 'embedding_query_generation_mismatch' });
  }
  for (const vector of [[1e100, 0, 0], [Number.MIN_VALUE, 0, 0]]) await assert.rejects(assertQueryGeneration(direct, { fingerprint, vector }), { code: 'embedding_query_generation_mismatch' });
  const normalized = generation({ normalization: 'l2' }), normalizedFingerprint = await embeddingGenerationFingerprint(normalized);
  await assertQueryGeneration(normalized, { fingerprint: normalizedFingerprint, vector: [1, 0, 0] });
  await assert.rejects(assertQueryGeneration(normalized, { fingerprint: normalizedFingerprint, vector: [2, 0, 0] }), { code: 'embedding_query_generation_mismatch' });
  await assert.rejects(assertQueryGeneration(direct, { fingerprint: await embeddingGenerationFingerprint(generation({ model: 'different-same-dimensions' })), vector: [1, 0, 0] }), { code: 'embedding_query_generation_mismatch' });
});

test('source fingerprint is canonical but revisions, deletion and scope remain significant', async () => {
  const a = record(), b = record({ sourceId: 'memory-2' });
  assert.equal(await sourceSnapshotFingerprint(snapshot([a, b])), await sourceSnapshotFingerprint(snapshot([b, a])));
  assert.notEqual(await sourceSnapshotFingerprint(snapshot([a])), await sourceSnapshotFingerprint(snapshot([record({ revision: 2 })])));
  await assert.rejects(sourceSnapshotFingerprint(snapshot([a, a])), { code: 'embedding_source_snapshot_invalid' });
});

test('complete coverage produces a frozen CAS plan including source and authority fences', async () => {
  const input = await fixture(), plan = await prepareGenerationPromotion(input);
  assert.deepEqual(plan.expectedPointer, input.currentPointer);
  assert.equal(plan.nextPointer.epoch, 4);
  assert.equal(plan.nextPointer.generationId, 'generation-v2');
  assert.equal(plan.sourceFence.sequence, 10);
  assert.equal(plan.authorityFence.epoch, 4);
  assert.equal(plan.coverage.expectedChunks, 2);
  assert.equal(plan.coverage.observedChunks, 2);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.nextPointer));
});

test('coverage rejects missing, duplicated, stale, foreign and wrong-generation vectors', async () => {
  for (const mutate of [
    input => input.inventory.pop(),
    input => input.inventory.push({ ...input.inventory[0] }),
    input => { input.inventory[0].revision = 2; },
    input => { input.inventory[0].sourceId = 'foreign-source'; },
    input => { input.inventory[0].fingerprint = hash('f'); },
    input => { input.inventory[0].contentHash = hash('e'); },
    input => { input.inventory[0].chunk = 2; },
  ]) {
    const input = await fixture(); mutate(input);
    await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
  }
});

test('reconciles an exact contiguous event sequence before promoting the latest source revision', async () => {
  const input = await fixture(), changed = record({ revision: 2, contentHash: hash('c'), chunkCount: 1 });
  input.currentSnapshot = snapshot([changed], 11);
  input.events = [{ sequence: 11, ...changed }];
  input.inventory = [{ sourceId: changed.sourceId, revision: 2, contentHash: changed.contentHash, chunk: 0, fingerprint: input.evidence.generationFingerprint }];
  input.evidence.reconciledThrough = 11;
  input.evidence.sourceFingerprint = input.evaluation.sourceFingerprint = await sourceSnapshotFingerprint(input.currentSnapshot);
  assert.equal((await prepareGenerationPromotion(input)).coverage.expectedChunks, 1);
  input.events = [];
  await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
});

test('event gaps, incomplete catch-up, forged snapshots and non-increasing revisions fail closed', async () => {
  for (const mutate of [
    input => { input.currentSnapshot = snapshot([record()], 11); },
    input => { input.evidence.reconciledThrough = 9; },
    input => { input.evidence.sourceFingerprint = hash('f'); },
    input => { input.events = [{ sequence: 11, ...record() }]; input.currentSnapshot = snapshot([record()], 11); },
  ]) {
    const input = await fixture(); mutate(input);
    await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
  }
});

test('pending or uncertain writes/deletes and failed/stale evaluation prevent promotion', async () => {
  for (const mutate of [
    input => { input.evidence.pendingWrites = 1; },
    input => { input.evidence.pendingDeletes = 1; },
    input => { input.evidence.unknownMutations = 1; },
    input => { input.evaluation.passed = false; },
    input => { input.evaluation.sourceFingerprint = hash('e'); },
    input => { input.evaluation.generationFingerprint = hash('e'); },
    input => { input.evidence.observedAtMs = now - 60001; },
    input => { input.evaluation.observedAtMs = now + 1; },
  ]) {
    const input = await fixture(); mutate(input);
    await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
  }
});

test('pointer CAS, source epoch and current authority are required even for complete vectors', async () => {
  for (const mutate of [
    input => { input.currentPointer.epoch++; },
    input => { input.currentSnapshot = { ...input.currentSnapshot, sourceEpoch: 2 }; },
    input => { input.authority.allowed = false; },
    input => { input.authority.scopeId = 'another-space'; },
    input => { input.authority.checkedAtMs = now - 60001; },
  ]) {
    const input = await fixture(); mutate(input);
    await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
  }
});

test('rollback requires retained generation with complete current source and erasure reconciliation', async () => {
  const input = await fixture(); input.mode = 'rollback';
  assert.equal((await prepareGenerationPromotion(input)).mode, 'rollback');
  input.evidence.retained = false;
  await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
  input.evidence.retained = true;
  const erased = record({ revision: 2, state: 'erased', contentHash: null, chunkCount: 0 });
  input.currentSnapshot = snapshot([erased], 11); input.events = [{ sequence: 11, ...erased }]; input.evidence.reconciledThrough = 11;
  input.evidence.sourceFingerprint = input.evaluation.sourceFingerprint = await sourceSnapshotFingerprint(input.currentSnapshot);
  await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
  input.inventory = [];
  assert.equal((await prepareGenerationPromotion(input)).coverage.observedChunks, 0);
});

test('a later event cannot resurrect an erased source', async () => {
  const input = await fixture();
  input.buildSnapshot = snapshot([record({ state: 'erased', contentHash: null, chunkCount: 0 })]);
  input.evidence.buildSourceFingerprint = await sourceSnapshotFingerprint(input.buildSnapshot);
  const resurrected = record({ revision: 2 });
  input.currentSnapshot = snapshot([resurrected], 11); input.events = [{ sequence: 11, ...resurrected }];
  input.evidence.reconciledThrough = 11;
  input.evidence.sourceFingerprint = input.evaluation.sourceFingerprint = await sourceSnapshotFingerprint(input.currentSnapshot);
  await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
});

test('model upgrades cannot bypass source-required region or become implicit cross-region migrations', async () => {
  const input = await fixture();
  input.requiredRegion = 'kr-seoul';
  await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
  input.requiredRegion = 'cloudflare';
  input.currentGeneration = generation({ id: 'generation-v1', provider: 'seoul-local', target: { provider: 'seoul-pgvector', region: 'kr-seoul', resourceId: 'seoul-index-v1' } });
  input.currentPointer.fingerprint = input.expectedPointer.fingerprint = await embeddingGenerationFingerprint(input.currentGeneration);
  await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
});

test('fresh generation names cannot overwrite the currently queried physical index', async () => {
  const input = await fixture();
  input.candidate.target.resourceId = input.currentGeneration.target.resourceId;
  const fingerprint = await embeddingGenerationFingerprint(input.candidate);
  input.evidence.generationFingerprint = input.evaluation.generationFingerprint = fingerprint;
  for (const vector of input.inventory) vector.fingerprint = fingerprint;
  await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
});

test('initial build supports an absent active pointer without inventing a previous generation', async () => {
  const input = await fixture();
  input.currentGeneration = null;
  input.currentPointer = input.expectedPointer = { scopeId: 'space-1', epoch: 0, generationId: null, fingerprint: null };
  assert.equal((await prepareGenerationPromotion(input)).nextPointer.epoch, 1);
  input.currentPointer = input.expectedPointer = { scopeId: 'space-1', epoch: Number.MAX_SAFE_INTEGER, generationId: null, fingerprint: null };
  await assert.rejects(prepareGenerationPromotion(input), { code: 'embedding_generation_not_ready' });
});

test('a complete Seoul-local model upgrade stays on an independently identified Seoul pgvector target', async () => {
  const input = await fixture();
  input.requiredRegion = 'kr-seoul';
  input.candidate = generation({ provider: 'seoul-local', model: 'local/e5-v2', target: { provider: 'seoul-pgvector', region: 'kr-seoul', resourceId: 'seoul-index-v2' } });
  input.currentGeneration = generation({ id: 'generation-v1', provider: 'seoul-local', model: 'local/e5-v1', target: { provider: 'seoul-pgvector', region: 'kr-seoul', resourceId: 'seoul-index-v1' } });
  const fingerprint = await embeddingGenerationFingerprint(input.candidate);
  input.evidence.generationFingerprint = input.evaluation.generationFingerprint = fingerprint;
  for (const vector of input.inventory) vector.fingerprint = fingerprint;
  input.currentPointer.fingerprint = input.expectedPointer.fingerprint = await embeddingGenerationFingerprint(input.currentGeneration);
  assert.equal((await prepareGenerationPromotion(input)).nextPointer.fingerprint, fingerprint);
});

test('query validation returns the frozen float32 packet to dispatch despite caller mutation during hashing', async () => {
  const descriptor = generation(), fingerprint = await embeddingGenerationFingerprint(descriptor);
  const query = { fingerprint, vector: [0.1, 0.2, 0.3] };
  const pending = assertQueryGeneration(descriptor, query);
  query.fingerprint = hash('f'); query.vector[0] = Infinity; query.vector.push(4);
  descriptor.model = 'changed-model'; descriptor.target.resourceId = 'changed-target';
  const validated = await pending;
  assert.deepEqual(validated, { fingerprint, vector: [0.1, 0.2, 0.3].map(Math.fround) });
  assert.ok(Object.isFrozen(validated) && Object.isFrozen(validated.vector));
  assert.throws(() => { validated.vector[0] = 9; }, TypeError);
  assert.notEqual(validated.vector, query.vector);
});

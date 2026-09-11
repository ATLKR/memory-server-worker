import { z } from 'zod';

// This module validates trusted service manifests, not credentials or physical residency.
// Registry writes must be insert-only for a generation ID. Targets identify isolated
// physical indexes (or independently fenced generations), never a mutable shared alias.
// Direct targets currently support Vectorize float32 (<=1536 dimensions) and
// Seoul pgvector's indexed vector type (<=2000), not halfvec/bit representations.
// https://developers.cloudflare.com/vectorize/best-practices/create-indexes/
// https://developers.cloudflare.com/vectorize/platform/limits/
// https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes
// Query and document encoders must use the same model and preprocessing:
// https://supabase.com/docs/guides/ai/semantic-search
// Declared model revisions require adapter/deployment verification; this module
// cannot pin provider-managed weights or select Agent Memory's internal model.
const label = z.string().min(1).max(256).regex(/^[A-Za-z0-9@][A-Za-z0-9._:/@+-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = safe.min(1);
const immutableVersion = label.refine(value => !['latest', 'current', 'default', 'stable', 'auto', 'main', 'master', 'head'].includes(value.toLowerCase()));
const targetSchema = z.union([
  z.strictObject({ provider: z.literal('cloudflare-vectorize'), region: z.literal('cloudflare'), resourceId: label }),
  z.strictObject({ provider: z.literal('seoul-pgvector'), region: z.literal('kr-seoul'), resourceId: label }),
]);
const directSchema = z.strictObject({ version: z.literal(1), kind: z.literal('direct'), id: label, scopeId: label,
  provider: z.enum(['workers-ai', 'seoul-local']), model: label, revision: immutableVersion,
  dimensions: positive.max(2000), metric: z.enum(['cosine', 'euclidean', 'dot-product']),
  normalization: z.enum(['none', 'l2']), chunkerVersion: immutableVersion, target: targetSchema,
}).refine(g => g.target.provider === 'cloudflare-vectorize' ? g.provider === 'workers-ai' && g.dimensions <= 1536 : g.provider === 'seoul-local');
const managedSchema = z.strictObject({ version: z.literal(1), kind: z.literal('managed-agent-memory'), id: label, scopeId: label,
  modelControl: z.literal('provider-managed'), target: z.strictObject({ provider: z.literal('cloudflare-agent-memory'), region: z.literal('cloudflare'), resourceId: label }),
});
const generationSchema = z.union([directSchema, managedSchema]);
type GenerationFields = z.infer<typeof generationSchema>;
type DeepReadonly<T> = { readonly [Key in keyof T]: T[Key] extends object ? DeepReadonly<T[Key]> : T[Key] };
export type EmbeddingGeneration = DeepReadonly<GenerationFields>;
function reject(code: string): never { throw Object.assign(new Error(code), { code }); }

export function parseEmbeddingGeneration(input: unknown): EmbeddingGeneration {
  const parsed = generationSchema.safeParse(input);
  if (!parsed.success) reject('embedding_generation_invalid');
  Object.freeze(parsed.data.target);
  return Object.freeze(parsed.data);
}
async function sha256(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function embeddingGenerationFingerprint(input: unknown): Promise<string> {
  const g = parseEmbeddingGeneration(input);
  const prefix = [g.version, g.kind, g.id, g.scopeId, g.target.provider, g.target.region, g.target.resourceId];
  return sha256(g.kind === 'direct' ? [...prefix, g.provider, g.model, g.revision, g.dimensions, g.metric, g.normalization, g.chunkerVersion] : [...prefix, g.modelControl]);
}

export interface ValidatedEmbeddingQuery {
  readonly fingerprint: string;
  readonly vector: readonly number[];
}

/** Query packets must be made by the selected model adapter, never trusted from
 * an HTTP caller. A matching label cannot prove which model actually ran.
 * Callers MUST dispatch the returned frozen packet, not the mutable input. Its
 * float32 coordinates are the exact values validated after generation matching. */
export async function assertQueryGeneration(input: unknown, query: unknown): Promise<ValidatedEmbeddingQuery> {
  const generation = parseEmbeddingGeneration(input);
  if (generation.kind !== 'direct') reject('embedding_model_provider_managed');
  const parsed = z.strictObject({ fingerprint: digest, vector: z.array(z.number().finite()).max(2000) }).safeParse(query);
  if (!parsed.success || parsed.data.fingerprint !== await embeddingGenerationFingerprint(generation) || parsed.data.vector.length !== generation.dimensions) reject('embedding_query_generation_mismatch');
  // Both supported direct targets store single-precision vectors. Validate the
  // stored coordinate space, including overflow and underflow to the zero vector.
  const coordinates = parsed.data.vector.map(value => Math.fround(value));
  if (coordinates.some(value => !Number.isFinite(value))) reject('embedding_query_generation_mismatch');
  const norm = Math.hypot(...coordinates);
  if (!Number.isFinite(norm) || (generation.metric === 'cosine' && norm === 0) || (generation.normalization === 'l2' && Math.abs(norm - 1) > 0.001)) reject('embedding_query_generation_mismatch');
  return Object.freeze({ fingerprint: parsed.data.fingerprint, vector: Object.freeze(coordinates) });
}

const sourceSchema = z.strictObject({ sourceId: label, revision: positive, state: z.enum(['live', 'deleted', 'erased']), contentHash: digest.nullable(), chunkCount: safe.max(10000) })
  .refine(s => s.state === 'live' ? s.contentHash !== null : s.contentHash === null && s.chunkCount === 0);
const snapshotSchema = z.strictObject({ version: z.literal(1), scopeId: label, sourceEpoch: positive, sequence: safe, records: z.array(sourceSchema).max(10000) });
type SourceRecord = z.infer<typeof sourceSchema>;
type SourceSnapshot = z.infer<typeof snapshotSchema>;
function sourceMap(snapshot: SourceSnapshot): Map<string, SourceRecord> {
  const map = new Map<string, SourceRecord>();
  let chunks = 0;
  for (const source of snapshot.records) {
    if (map.has(source.sourceId)) reject('embedding_source_snapshot_invalid');
    map.set(source.sourceId, source);
    chunks += source.chunkCount;
  }
  if (chunks > 100000) reject('embedding_source_snapshot_invalid');
  return map;
}
async function sourceHash(snapshot: SourceSnapshot): Promise<string> {
  const records = [...sourceMap(snapshot).values()].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  return sha256([snapshot.version, snapshot.scopeId, snapshot.sourceEpoch, snapshot.sequence,
    records.map(s => [s.sourceId, s.revision, s.state, s.contentHash, s.chunkCount])]);
}
export async function sourceSnapshotFingerprint(input: unknown): Promise<string> {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) reject('embedding_source_snapshot_invalid');
  return sourceHash(parsed.data);
}

const pointerSchema = z.strictObject({ scopeId: label, epoch: safe, generationId: label.nullable(), fingerprint: digest.nullable() })
  .refine(p => (p.generationId === null) === (p.fingerprint === null));
const eventSchema = z.strictObject({ sequence: positive, sourceId: label, revision: positive, state: z.enum(['live', 'deleted', 'erased']), contentHash: digest.nullable(), chunkCount: safe.max(10000) })
  .refine(s => s.state === 'live' ? s.contentHash !== null : s.contentHash === null && s.chunkCount === 0);
const promotionSchema = z.strictObject({ mode: z.enum(['promote', 'rollback']), candidate: generationSchema, requiredRegion: z.enum(['cloudflare', 'kr-seoul']),
  expectedPointer: pointerSchema, currentPointer: pointerSchema,
  currentGeneration: generationSchema.nullable(), buildSnapshot: snapshotSchema, currentSnapshot: snapshotSchema,
  events: z.array(eventSchema).max(100000),
  inventory: z.array(z.strictObject({ sourceId: label, revision: positive, contentHash: digest, chunk: safe.max(9999), fingerprint: digest })).max(100000),
  evidence: z.strictObject({ generationFingerprint: digest, buildSourceFingerprint: digest, sourceFingerprint: digest, reconciledThrough: safe,
    pendingWrites: safe, pendingDeletes: safe, unknownMutations: safe, observedAtMs: positive, retained: z.boolean() }),
  evaluation: z.strictObject({ generationFingerprint: digest, sourceFingerprint: digest, passed: z.boolean(), observedAtMs: positive, evidenceId: label }),
  authority: z.strictObject({ scopeId: label, epoch: positive, allowed: z.boolean(), checkedAtMs: positive }),
  nowMs: positive, maxEvidenceAgeMs: positive.max(300000).optional(),
});

export interface GenerationPromotionPlan {
  readonly mode: 'promote' | 'rollback';
  readonly expectedPointer: Readonly<z.infer<typeof pointerSchema>>;
  readonly nextPointer: Readonly<z.infer<typeof pointerSchema>>;
  readonly sourceFence: Readonly<{ scopeId: string; sourceEpoch: number; sequence: number; fingerprint: string }>;
  readonly authorityFence: Readonly<{ scopeId: string; epoch: number }>;
  readonly coverage: Readonly<{ expectedChunks: number; observedChunks: number }>;
  readonly evaluationId: string;
}

/** Produces a plan only: it does NOT provision, embed, authorize or switch an index.
 * Callers must obtain complete native inventory and durable operation evidence,
 * then atomically compare BOTH pointers/source fences and current authority before
 * changing the active pointer. Re-check leases/uncertain writes in that transaction.
 * A rollback uses exactly the same current-source and erasure coverage requirements.
 */
export async function prepareGenerationPromotion(input: unknown): Promise<GenerationPromotionPlan> {
  const parsed = promotionSchema.safeParse(input);
  if (!parsed.success) reject('embedding_generation_not_ready');
  const p = parsed.data, g = p.candidate;
  if (g.kind !== 'direct') reject('embedding_model_provider_managed');
  const ready = (condition: unknown): void => { if (!condition) reject('embedding_generation_not_ready'); };
  ready(g.target.region === p.requiredRegion);
  const age = p.maxEvidenceAgeMs ?? 60000;
  const fresh = (at: number) => at <= p.nowMs && p.nowMs - at <= age;
  const fingerprint = await embeddingGenerationFingerprint(g);
  let buildFingerprint: string, currentFingerprint: string;
  let build: Map<string, SourceRecord>, current: Map<string, SourceRecord>;
  try {
    build = sourceMap(p.buildSnapshot); current = sourceMap(p.currentSnapshot);
    buildFingerprint = await sourceHash(p.buildSnapshot); currentFingerprint = await sourceHash(p.currentSnapshot);
  } catch { reject('embedding_generation_not_ready'); }
  ready(p.expectedPointer.scopeId === g.scopeId && p.currentPointer.scopeId === g.scopeId
    && p.expectedPointer.epoch === p.currentPointer.epoch && p.expectedPointer.generationId === p.currentPointer.generationId
    && p.expectedPointer.fingerprint === p.currentPointer.fingerprint && p.currentPointer.epoch < Number.MAX_SAFE_INTEGER
    && p.currentPointer.generationId !== g.id);
  if (p.currentPointer.generationId === null) ready(p.currentGeneration === null);
  else {
    ready(p.currentGeneration !== null);
    const active = p.currentGeneration!;
    ready(active.id === p.currentPointer.generationId && active.scopeId === g.scopeId && await embeddingGenerationFingerprint(active) === p.currentPointer.fingerprint);
    ready(active.target.region === g.target.region);
    ready(active.target.provider !== g.target.provider || active.target.resourceId !== g.target.resourceId);
  }
  ready(p.buildSnapshot.scopeId === g.scopeId && p.currentSnapshot.scopeId === g.scopeId && p.buildSnapshot.sourceEpoch === p.currentSnapshot.sourceEpoch
    && p.buildSnapshot.sequence <= p.currentSnapshot.sequence && p.evidence.reconciledThrough === p.currentSnapshot.sequence
    && p.evidence.buildSourceFingerprint === buildFingerprint && p.evidence.sourceFingerprint === currentFingerprint
    && p.evidence.generationFingerprint === fingerprint && p.evidence.pendingWrites === 0 && p.evidence.pendingDeletes === 0 && p.evidence.unknownMutations === 0
    && fresh(p.evidence.observedAtMs) && (p.mode !== 'rollback' || p.evidence.retained));
  ready(p.evaluation.passed && p.evaluation.generationFingerprint === fingerprint && p.evaluation.sourceFingerprint === currentFingerprint && fresh(p.evaluation.observedAtMs));
  ready(p.authority.allowed && p.authority.scopeId === g.scopeId && fresh(p.authority.checkedAtMs));

  let sequence = p.buildSnapshot.sequence;
  for (const event of p.events) {
    ready(sequence < Number.MAX_SAFE_INTEGER && event.sequence === sequence + 1 && event.sequence <= p.currentSnapshot.sequence);
    const previous = build.get(event.sourceId);
    ready(!previous || (event.revision > previous.revision && (previous.state !== 'erased' || event.state === 'erased')));
    const { sequence: _, ...source } = event;
    build.set(source.sourceId, source);
    sequence = event.sequence;
  }
  ready(sequence === p.currentSnapshot.sequence && build.size === current.size);
  for (const [id, source] of current) {
    const observed = build.get(id);
    ready(observed && observed.revision === source.revision && observed.state === source.state && observed.contentHash === source.contentHash && observed.chunkCount === source.chunkCount);
  }
  const seen = new Set<string>();
  let expectedChunks = 0;
  for (const source of current.values()) expectedChunks += source.state === 'live' ? source.chunkCount : 0;
  for (const vector of p.inventory) {
    const source = current.get(vector.sourceId), key = JSON.stringify([vector.sourceId, vector.chunk]);
    ready(source && source.state === 'live' && source.revision === vector.revision && source.contentHash === vector.contentHash
      && vector.fingerprint === fingerprint && vector.chunk < source.chunkCount && !seen.has(key));
    seen.add(key);
  }
  ready(seen.size === expectedChunks);
  return Object.freeze({ mode: p.mode, expectedPointer: Object.freeze(p.expectedPointer),
    nextPointer: Object.freeze({ scopeId: g.scopeId, epoch: p.currentPointer.epoch + 1, generationId: g.id, fingerprint }),
    sourceFence: Object.freeze({ scopeId: g.scopeId, sourceEpoch: p.currentSnapshot.sourceEpoch, sequence: p.currentSnapshot.sequence, fingerprint: currentFingerprint }),
    authorityFence: Object.freeze({ scopeId: g.scopeId, epoch: p.authority.epoch }),
    coverage: Object.freeze({ expectedChunks, observedChunks: seen.size }), evaluationId: p.evaluation.evidenceId });
}

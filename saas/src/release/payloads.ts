import type { Database } from './types.ts';
import type { PayloadBucket, PayloadContent, PayloadContext, PayloadObject, PayloadPage, PayloadRef, PayloadShard, StorageEnv } from './payload-types.ts';
import { canonical, decodeCursor, digest, enc, encodeCursor, fail, id, integer, one, rows } from './util.ts';

const MAX_BYTES = 131072;
const IO_MS = 20000;
type HotRow = { space_id: string; memory_id: string; content: string; sha256: string; bytes: number };
function context(ctx: PayloadContext): void { id(ctx.spaceId); id(ctx.memoryId); }
function contents(value: PayloadContent): string {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'body,provenance,source'
        || typeof value.body !== 'string' || !(value.source === null || typeof value.source === 'string')
        || !value.provenance || typeof value.provenance !== 'object' || Array.isArray(value.provenance)) fail(503, 'payload_integrity_error');
    const text = canonical(value);
    if (enc.encode(text).length > MAX_BYTES) fail(413, 'payload_too_large');
    return text;
}
async function timed<T>(promise: Promise<T>, end = Date.now() + IO_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('payload_provider_timeout')), Math.max(1, end - Date.now())); })]); }
    finally { if (timer) clearTimeout(timer); }
}

/** Immutable data only. Callers register each planned locator centrally before stage,
 * and verify central publication/authority after hydration, before disclosure. */
export class PayloadStore {
    readonly enabled: boolean;
    private readonly registry: PayloadShard[] = [];
    private readonly bucket?: PayloadBucket;
    private readonly clock: () => number;
    constructor(env: StorageEnv, clock = Date.now) {
        this.clock = clock;
        this.enabled = env.STORAGE_MODE === 'sharded';
        if (env.STORAGE_MODE !== undefined && env.STORAGE_MODE !== 'inline' && env.STORAGE_MODE !== 'sharded') fail(503, 'storage_configuration_invalid');
        this.bucket = env.MEMORY_PAYLOADS;
        if (env.STORAGE_SHARDS_JSON !== undefined) {
            let values: unknown;
            try { values = JSON.parse(env.STORAGE_SHARDS_JSON); } catch { fail(503, 'storage_configuration_invalid'); }
            if (!Array.isArray(values) || values.length === 0 || values.length > 16) fail(503, 'storage_configuration_invalid');
            const bindings = env as unknown as Record<string, unknown>;
            for (const value of values) {
                if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'binding,id,mode'
                    || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.id)
                    || typeof value.binding !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.binding) || value.binding === 'DB'
                    || !['active', 'draining'].includes(value.mode) || !Object.hasOwn(bindings, value.binding)) fail(503, 'storage_configuration_invalid');
                const db = bindings[value.binding] as Database;
                if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function' || typeof db.withSession !== 'function' || db === bindings.DB
                    || this.registry.some(row => row.id === value.id || row.binding === value.binding || row.db === db)) fail(503, 'storage_configuration_invalid');
                this.registry.push({ id: value.id, binding: value.binding, mode: value.mode, db });
            }
            this.registry.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        }
        if ((this.enabled || this.registry.length) && (!this.bucket || typeof this.bucket.head !== 'function' || typeof this.bucket.get !== 'function' || typeof this.bucket.put !== 'function')) fail(503, 'storage_configuration_invalid');
        if (this.enabled && !this.registry.some(row => row.mode === 'active')) fail(503, 'storage_configuration_invalid');
    }
    shardIds(): string[] { return this.registry.map(row => row.id); }
    private shard(shardId: string): PayloadShard { return this.registry.find(row => row.id === shardId) ?? fail(503, 'payload_shard_unavailable'); }
    private reference(ctx: PayloadContext, ref: PayloadRef): PayloadShard {
        context(ctx);
        if (!ref || typeof ref.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(ref.id)
            || ref.objectKey !== 'payload/v1/' + ref.id || !/^[0-9a-f]{64}$/.test(ref.sha256)
            || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_BYTES) fail(503, 'payload_reference_invalid');
        return this.shard(ref.shardId);
    }
    async descriptor(ctx: PayloadContext, content: PayloadContent, payloadId: string): Promise<PayloadRef> {
        if (!this.enabled) fail(503, 'storage_not_configured');
        context(ctx); id(payloadId);
        const text = contents(content), active = this.registry.filter(row => row.mode === 'active');
        const hash = await digest(text), placement = Number.parseInt((await digest(canonical([ctx.spaceId, payloadId]))).slice(0, 8), 16) % active.length;
        return { id: payloadId, shardId: active[placement]!.id, objectKey: 'payload/v1/' + payloadId, sha256: hash, bytes: enc.encode(text).length };
    }
    private metadata(ctx: PayloadContext, ref: PayloadRef, state: 'payload' | 'purged'): Record<string, string> {
        return { payloadId: ref.id, shardId: ref.shardId, spaceId: ctx.spaceId, memoryId: ctx.memoryId, sha256: ref.sha256, state };
    }
    private objectContext(ctx: PayloadContext, ref: PayloadRef, object: PayloadObject): void {
        const meta = object.customMetadata;
        if (!meta || meta.payloadId !== ref.id || meta.shardId !== ref.shardId || meta.spaceId !== ctx.spaceId || meta.memoryId !== ctx.memoryId) fail(503, 'payload_context_mismatch');
        if (meta.sha256 !== ref.sha256 || (meta.state !== 'payload' && meta.state !== 'purged')) fail(503, 'payload_integrity_error');
    }
    private async verifyText(text: string, ref: PayloadRef): Promise<PayloadContent> {
        if (enc.encode(text).length !== ref.bytes || await digest(text) !== ref.sha256) fail(503, 'payload_integrity_error');
        let parsed: PayloadContent;
        try { parsed = JSON.parse(text) as PayloadContent; } catch { return fail(503, 'payload_integrity_error'); }
        if (contents(parsed) !== text) fail(503, 'payload_integrity_error');
        return parsed;
    }
    private async cold(ctx: PayloadContext, ref: PayloadRef, end: number): Promise<PayloadContent> {
        const object = await timed(this.bucket!.get(ref.objectKey), end);
        if (!object) fail(503, 'payload_unavailable');
        try {
            this.objectContext(ctx, ref, object);
            if (object.customMetadata!.state === 'purged') fail(410, 'payload_purged');
            if (object.size !== ref.bytes || object.size > MAX_BYTES || !object.body) fail(503, 'payload_integrity_error');
        } catch (error) { void object.body?.cancel().catch(() => {}); throw error; }
        const reader = object.body!.getReader(), chunks: Uint8Array[] = []; let count = 0;
        try {
            while (true) {
                const { done, value } = await timed(reader.read(), end);
                if (done) break;
                count += value.length;
                if (count > ref.bytes || count > MAX_BYTES) fail(503, 'payload_integrity_error');
                chunks.push(value);
            }
        } catch (error) { void reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        if (count !== ref.bytes) fail(503, 'payload_integrity_error');
        const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail(503, 'payload_integrity_error'); }
        return this.verifyText(text, ref);
    }
    private async hot(ctx: PayloadContext, ref: PayloadRef, db: Database, end: number): Promise<PayloadContent | null> {
        const row = await timed(one<HotRow>(db, 'SELECT space_id,memory_id,content,sha256,bytes FROM payloads WHERE id=?', [ref.id]), end);
        if (!row) return null;
        if (row.space_id !== ctx.spaceId || row.memory_id !== ctx.memoryId) fail(503, 'payload_context_mismatch');
        if (row.sha256 !== ref.sha256 || row.bytes !== ref.bytes) fail(503, 'payload_integrity_error');
        return this.verifyText(row.content, ref);
    }
    async stage(ctx: PayloadContext, ref: PayloadRef, content: PayloadContent): Promise<void> {
        const end = Date.now() + IO_MS, { db } = this.reference(ctx, ref), text = contents(content);
        if (enc.encode(text).length !== ref.bytes || await digest(text) !== ref.sha256) fail(503, 'payload_integrity_error');
        await timed(this.bucket!.put(ref.objectKey, text, { onlyIf: { etagDoesNotMatch: '*' }, sha256: ref.sha256, customMetadata: this.metadata(ctx, ref, 'payload') }), end);
        await this.cold(ctx, ref, end);
        try {
            const result = await timed(db.prepare('INSERT INTO payloads(id,space_id,memory_id,content,sha256,bytes,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM payloads WHERE id=?)')
                .bind(ref.id, ctx.spaceId, ctx.memoryId, text, ref.sha256, ref.bytes, this.clock(), ref.id).run(), end);
            if (!result.success) fail(503, 'database_unavailable');
        } catch (error) { if (error instanceof Error && error.message.includes('payload_retired')) fail(410, 'payload_retired'); throw error; }
        if (!await this.hot(ctx, ref, db, end)) fail(503, 'payload_unavailable');
    }
    async read(ctx: PayloadContext, ref: PayloadRef): Promise<PayloadContent> {
        const end = Date.now() + IO_MS, { db } = this.reference(ctx, ref);
        return await this.hot(ctx, ref, db, end) ?? this.cold(ctx, ref, end);
    }
    async retireHot(ctx: PayloadContext, ref: PayloadRef): Promise<void> {
        return this.retire(ctx, ref, Date.now() + IO_MS);
    }
    private async retire(ctx: PayloadContext, ref: PayloadRef, end: number): Promise<void> {
        const { db } = this.reference(ctx, ref);
        await this.hot(ctx, ref, db, end);
        const result = await timed(db.prepare('INSERT INTO payload_tombstones(id,space_id,memory_id,retired_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM payload_tombstones WHERE id=?)')
            .bind(ref.id, ctx.spaceId, ctx.memoryId, this.clock(), ref.id).run(), end);
        if (!result.success) fail(503, 'database_unavailable');
        const tombstone = await timed(one<{ space_id: string; memory_id: string }>(db, 'SELECT space_id,memory_id FROM payload_tombstones WHERE id=?', [ref.id]), end);
        if (!tombstone || tombstone.space_id !== ctx.spaceId || tombstone.memory_id !== ctx.memoryId) fail(503, 'payload_context_mismatch');
    }
    async purge(ctx: PayloadContext, ref: PayloadRef): Promise<void> {
        const end = Date.now() + IO_MS, { db } = this.reference(ctx, ref);
        await this.hot(ctx, ref, db, end);
        const tombstone = await timed(one<{ space_id: string; memory_id: string }>(db, 'SELECT space_id,memory_id FROM payload_tombstones WHERE id=?', [ref.id]), end);
        if (tombstone && (tombstone.space_id !== ctx.spaceId || tombstone.memory_id !== ctx.memoryId)) fail(503, 'payload_context_mismatch');
        const existing = await timed(this.bucket!.head(ref.objectKey), end);
        if (existing) this.objectContext(ctx, ref, existing);
        if (!existing || existing.customMetadata!.state !== 'purged') {
            // Retain a zero-byte object permanently. A late create-only stage
            // cannot recreate plaintext after this write completes.
            await timed(this.bucket!.put(ref.objectKey, new Uint8Array(), { customMetadata: this.metadata(ctx, ref, 'purged') }), end);
        }
        const confirmed = await timed(this.bucket!.head(ref.objectKey), end);
        if (!confirmed) fail(503, 'payload_unavailable');
        this.objectContext(ctx, ref, confirmed);
        if (confirmed.size !== 0 || confirmed.customMetadata!.state !== 'purged') fail(503, 'payload_integrity_error');
        await this.retire(ctx, ref, end);
    }
    async searchPage(shardId: string, spaceId: string, expression: string, after: unknown, limit: number): Promise<PayloadPage> {
        const { db } = this.shard(shardId); id(spaceId); integer(limit, 1, 100);
        if (expression === '') return { results: [], nextCursor: null };
        if (typeof expression !== 'string' || !/^"(?:[^"]|"")+"\*(?: OR "(?:[^"]|"")+"\*)*$/.test(expression)) fail(400, 'invalid_search_expression');
        const terms = expression.match(/"(?:[^"]|"")+"\*/g)!;
        if (terms.length > 20 || terms.some(term => Array.from(term.slice(1, -2).replaceAll('""', '"')).length > 31)) fail(400, 'invalid_search_expression');
        const resource = canonical(['payload-search', shardId, spaceId, await digest(expression)]);
        let score = Number.MAX_VALUE, memoryId = '', payloadId = '';
        if (after !== null && after !== undefined) {
            const keys = decodeCursor(after, resource);
            if (keys.length !== 3 || typeof keys[0] !== 'number' || !Number.isFinite(keys[0]) || keys[0] < 0 || typeof keys[1] !== 'string' || typeof keys[2] !== 'string') fail(400, 'invalid_cursor');
            score = keys[0]; memoryId = keys[1]; payloadId = keys[2];
        }
        const tenant = 't' + Array.from(enc.encode(spaceId), byte => byte.toString(16).padStart(2, '0')).join('');
        const candidates = await timed(rows<{ payloadId: string; memoryId: string; score: number }>(db, `WITH ranked AS MATERIALIZED (
          SELECT p.id AS payloadId,p.memory_id AS memoryId,
          (length(CAST(highlight(payload_fts,3,'[',']') AS BLOB))-length(CAST(payload_fts.body AS BLOB)))*1.0/(length(CAST(payload_fts.body AS BLOB))+80) AS score
          FROM payload_fts JOIN payloads p ON p.row_id=payload_fts.rowid
          WHERE payload_fts MATCH ? AND p.space_id=?
        ) SELECT payloadId,memoryId,score FROM ranked WHERE score<? OR (score=? AND (memoryId>? OR (memoryId=? AND payloadId>?))) ORDER BY score DESC,memoryId,payloadId LIMIT ?`,
        [`tenant:"${tenant}" AND body:(${expression})`, spaceId, score, score, memoryId, memoryId, payloadId, limit + 1]));
        const results = candidates.slice(0, limit), last = results.at(-1);
        return { results, nextCursor: candidates.length > limit && last ? encodeCursor(resource, [last.score, last.memoryId, last.payloadId]) : null };
    }
}

export type { PayloadRef, PayloadContext, PayloadContent, PayloadPage, StorageEnv } from './payload-types.ts';

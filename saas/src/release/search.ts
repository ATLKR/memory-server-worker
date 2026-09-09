import type { Database, Memory, ReleaseEnv } from './types.ts';
import { authority, params, requireSpace, interactive, recentSql } from './authority.ts';
import { columns, memoryRow, MemoryStore } from './memory.ts';
import { digest, fail, id, integer, object, rows, str, tokenHash, stmt, batch } from './util.ts';
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export function ftsQuery(query: string): string { return [...new Set(query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 20).map(s => '"' + s.replaceAll('"', '""') + '"*').join(' OR '); }
export async function deadline<T>(promise: Promise<T>, ms = 20000): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('provider_timeout')), ms); })]);
}
finally {
    if (timer)
        clearTimeout(timer);
} }
export async function embed(env: ReleaseEnv, text: string): Promise<number[]> {
    if (!env.AI)
        fail(503, 'semantic_not_configured');
    const out = object(await deadline(env.AI!.run(EMBEDDING_MODEL, { text: [text] })));
    const data = out.data;
    if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length !== 1024 || data[0].some(x => typeof x !== 'number' || !Number.isFinite(x)))
        fail(502, 'invalid_embedding');
    return data[0] as number[];
}
export class Search {
    env: ReleaseEnv;
    clock: () => number;
    store: MemoryStore;
    constructor(env: ReleaseEnv, clock: () => number = Date.now) { this.env = env; this.clock = clock; this.store = new MemoryStore(env.DB, clock); }
    async query(token: string, spaceId: string, query: string, limit = 10, operationId = crypto.randomUUID()): Promise<{
        results: (Memory & {
            snippet: string;
            score: number;
        })[];
        mode: string;
        degradedReason: string | null;
    }> {
        id(spaceId);
        str(query, 1024);
        integer(limit, 1, 50);
        const db = this.env.DB, at = this.clock(), hash = await tokenHash(token);
        const operation = await this.store.commit(token, spaceId, 'search', 'read', operationId, { query, limit }, null, null, 1, () => []);
        const expression = ftsQuery(query);
        let lexical: {
            id: string;
            revision: number;
        }[] = [];
        if (expression)
            lexical = await rows(db, `SELECT r.id,r.revision FROM release_fts JOIN memories r ON r.id=release_fts.memory_id JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c
    WHERE release_fts MATCH ? AND s.id=? AND r.deleted_at IS NULL AND r.erased_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM memories successor WHERE successor.supersedes_id=r.id)
    AND ${authority('read')} ORDER BY bm25(release_fts),r.id LIMIT 40`, [expression, spaceId, ...params(hash, at, 'read')]);
        // Retain each revision until D1 identifies the current one. A stale
        // higher-ranked chunk must not hide a later current-revision match.
        const candidates = new Map<string, Map<number, number>>();
        lexical.forEach((row, i) => candidates.set(row.id, new Map([[row.revision, 1 / (60 + i + 1)]])));
        let mode = 'lexical', degradedReason: string | null = null;
        // Retried operation IDs do not purchase another provider call. Return
        // fresh authorized lexical results and make the skipped work explicit.
        // A new operation ID requests a newly metered hybrid search.
        if (operation.replayed)
            degradedReason = 'semantic_skipped_on_replay';
        else if (this.env.AI && this.env.MEMORY_INDEX) {
            try {
                const vector = await embed(this.env, query);
                const result = await deadline(this.env.MEMORY_INDEX.query(vector, { namespace: await digest(spaceId), topK: 40, returnMetadata: 'all' }));
                // An index is only a candidate source. Neither metadata text nor authority is trusted.
                const seen = new Set<string>();
                result.matches.slice(0, 40).forEach((m, i) => {
                    const p = m.metadata;
                    if (!p || typeof p.memoryId !== 'string' || p.memoryId.length > 256 || !Number.isSafeInteger(p.revision))
                        return;
                    const revision = p.revision as number, pair = JSON.stringify([p.memoryId, revision]);
                    if (seen.has(pair))
                        return;
                    seen.add(pair);
                    const revisions = candidates.get(p.memoryId) ?? new Map<number, number>();
                    revisions.set(revision, (revisions.get(revision) ?? 0) + 1 / (60 + i + 1));
                    candidates.set(p.memoryId, revisions);
                });
                mode = 'hybrid';
            }
            catch {
                degradedReason = 'semantic_temporarily_unavailable';
            }
        }
        else
            degradedReason = 'semantic_not_configured';
        // 80 candidate IDs + authorization parameters remain below D1's bind limit.
        const ids = [...candidates.keys()];
        const fresh = this.clock();
        const final = ids.length ? await rows<Omit<Memory, 'provenance'> & {
            provenance: string;
        }>(db, `SELECT ${columns} FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c
   WHERE s.id=? AND r.id IN (${ids.map(() => '?').join(',')}) AND r.deleted_at IS NULL AND r.erased_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM memories successor WHERE successor.supersedes_id=r.id) AND ${authority('read')}`, [spaceId, ...ids, ...params(hash, fresh, 'read')]) : [];
        await requireSpace(db, token, spaceId, 'read', this.clock());
        const results = final.filter(r => candidates.get(r.id)?.has(r.revision)).map(r => ({ ...memoryRow(r), snippet: Array.from(r.body).slice(0, 500).join(''), score: candidates.get(r.id)!.get(r.revision)! })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
        return { results, mode, degradedReason };
    }
    async rebuild(token: string, spaceId: string): Promise<void> {
        const db = this.env.DB, at = this.clock(), hash = await tokenHash(token);
        await interactive(db, token, at, true);
        await requireSpace(db, token, spaceId, 'update', at);
        if (!this.env.AI || !this.env.MEMORY_INDEX)
            fail(503, 'semantic_not_configured');
        if (this.env.BACKGROUND_JOBS_ENABLED !== 'true')
            fail(503, 'background_jobs_disabled');
        // One job per current revision. Resetting a leased job is forbidden; an
        // in-flight revision will finish or become reclaimable through its lease.
        await db.prepare(`INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
   SELECT r.id||':'||r.revision,r.id,s.id,r.revision,CASE WHEN r.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,?,? FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('update')} AND ${recentSql()}
   ON CONFLICT(id) DO UPDATE SET state='pending',attempt=0,available_at=excluded.available_at,last_error=NULL WHERE release_jobs.state<>'leased'`).bind(at, at, id(spaceId), ...params(hash, at, 'update'), at - 300000, at).run();
    }
}

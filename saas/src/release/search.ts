import type { Database, Memory, ReleaseEnv } from './types.ts';
import { sqlNow } from '../sql-clock.ts';
import { authority, params, requireSpace, interactive, recentSql } from './authority.ts';
import { columns, memoryRow, MemoryStore, type MemoryRow } from './memory.ts';
import { PayloadStore } from './payloads.ts';
import { compareLexical, shardedLexical, type LexicalHead } from './payload-search.ts';
import { reserveProvider } from './provider-budget.ts';
import { digest, fail, id, integer, object, rows, str, tokenHash, stmt, batch } from './util.ts';
import { unicode61Token } from './unicode61.ts';
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export function ftsQuery(query: string): string {
    // FTS stores original text. Let unicode61 apply the same case/diacritic
    // rules to both sides; query-only compatibility folding loses exact words.
    // Retain existing mark/underscore groups and every native token character.
    // Modern JS categories alone drop symbols that were unassigned in SQLite's
    // frozen Unicode61 tables. Known punctuation still separates OR groups.
    const groups: string[] = [];
    let group = '';
    for (const character of query) {
        if (/[\p{L}\p{N}\p{M}\p{Co}_]/u.test(character) || unicode61Token(character.codePointAt(0)!)) group += character;
        else if (group) { groups.push(group); group = ''; }
    }
    if (group) groups.push(group);
    const terms = [...new Set(groups)].slice(0, 20);
    if (terms.some(term => Array.from(term).length > 31))
        fail(400, 'search_token_too_long');
    return terms.map(s => '"' + s.replaceAll('"', '""') + '"*').join(' OR ');
}
export async function deadline<T>(promise: Promise<T>, ms = 20000): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('provider_timeout')), ms); })]);
}
finally {
    if (timer)
        clearTimeout(timer);
} }
export async function embed(env: ReleaseEnv, text: string, beforeSend?: () => Promise<void>): Promise<number[]> {
    if (!env.AI)
        fail(503, 'semantic_not_configured');
    if (new TextEncoder().encode(text).length > 8000) fail(413, 'embedding_input_too_large');
    await reserveProvider(env, 'embedding');
    if (beforeSend) await beforeSend();
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
    payloads: PayloadStore;
    constructor(env: ReleaseEnv, clock: () => number = Date.now) { this.env = env; this.clock = clock; this.payloads = new PayloadStore(env, clock); this.store = new MemoryStore(env.DB, clock, this.payloads); }
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
        const expression = ftsQuery(query);
        const db = this.env.DB, hash = await tokenHash(token);
        const operation = await this.store.commit(token, spaceId, 'search', 'read', operationId, { query, limit }, null, null, 1, () => []);
        const at = this.clock(), tenant = 't' + [...new TextEncoder().encode(spaceId)].map(value => value.toString(16).padStart(2, '0')).join('');
        const candidateLimit = Math.max(40, limit);
        let lexical: LexicalHead[] = [];
        if (expression)
            lexical = await rows(db, `/* lexical-candidates */ SELECT r.id,r.revision,
                (length(CAST(highlight(release_fts,2,'[',']') AS BLOB))-length(CAST(release_fts.body AS BLOB)))*1.0
                    /(length(CAST(release_fts.body AS BLOB))+80) AS score
                FROM release_fts JOIN memories r ON r.id=release_fts.memory_id JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c
    WHERE release_fts MATCH ? AND s.id=? AND r.deleted_at IS NULL AND r.erased_at IS NULL
    AND r.payload_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM memories successor WHERE successor.supersedes_id=r.id)
    AND ${authority('read')}
    ORDER BY score DESC,r.id LIMIT ?`,
                [`tenant : "${tenant}" AND body : (${expression})`, spaceId, ...params(hash, at, 'read'), candidateLimit]);
        lexical = [...lexical, ...await shardedLexical(db, this.payloads, hash, spaceId, expression, candidateLimit, this.clock)]
            .sort(compareLexical).slice(0, candidateLimit);
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
                const namespace = await digest(spaceId);
                await requireSpace(db, token, spaceId, 'read', this.clock);
                const vector = await embed(this.env, query, async () => { await requireSpace(db, token, spaceId, 'read', this.clock); });
                await requireSpace(db, token, spaceId, 'read', this.clock);
                const result = await deadline(this.env.MEMORY_INDEX.query(vector, { namespace, topK: candidateLimit, returnMetadata: 'all' }));
                // An index is only a candidate source. Neither metadata text nor authority is trusted.
                const seen = new Set<string>();
                result.matches.slice(0, candidateLimit).forEach((m, i) => {
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
        // At most 100 candidate IDs use one JSON binding, leaving room for the
        // current authorization predicates under D1's SQL parameter limit.
        const ids = [...candidates.keys()];
        const fresh = this.clock();
        const final = ids.length ? await rows<MemoryRow>(db, `SELECT ${columns} FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c
   WHERE s.id=? AND r.id IN (SELECT value FROM json_each(?)) AND r.deleted_at IS NULL AND r.erased_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM memories successor WHERE successor.supersedes_id=r.id) AND ${authority('read')}`, [spaceId, JSON.stringify(ids), ...params(hash, fresh, 'read')]) : [];
        const hydrated = await this.store.hydrateRows(final);
        const allowed = await this.store.confirmRead(hash, spaceId, hydrated, { deleted: false, currentFact: true });
        const results = hydrated.filter(r => allowed.has(r.id) && candidates.get(r.id)?.has(r.revision)).map(r => ({ ...memoryRow(r), snippet: Array.from(r.body).slice(0, 500).join(''), score: candidates.get(r.id)!.get(r.revision)! })).sort(compareLexical).slice(0, limit);
        return { results, mode, degradedReason };
    }
    async rebuild(token: string, spaceId: string): Promise<void> {
        const db = this.env.DB, hash = await tokenHash(token);
        await interactive(db, token, this.clock, true);
        await requireSpace(db, token, spaceId, 'update', this.clock);
        if (!this.env.AI || !this.env.MEMORY_INDEX)
            fail(503, 'semantic_not_configured');
        if (this.env.BACKGROUND_JOBS_ENABLED !== 'true')
            fail(503, 'background_jobs_disabled');
        const at = this.clock();
        // One job per current revision. Resetting a leased job is forbidden; an
        // in-flight revision will finish or become reclaimable through its lease.
        await db.prepare(`INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
   SELECT r.id||':'||r.revision,r.id,s.id,r.revision,CASE WHEN r.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,${sqlNow()},${sqlNow()} FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('update')} AND ${recentSql()}
   ON CONFLICT(id) DO UPDATE SET state='pending',attempt=0,available_at=excluded.available_at,last_error=NULL,next_chunk=0,cleanup_cursor='',cleanup_pending='[]',cleanup_retry_at=0,cleanup_retry_delay=60000,cleanup_only=0 WHERE release_jobs.state<>'leased'`).bind(at, at, id(spaceId), ...params(hash, at, 'update'), at - 300000, at).run();
        await requireSpace(db, token, spaceId, 'update', this.clock);
        await interactive(db, token, this.clock, true);
    }
}

import type { Database } from './types.ts';
import type { PayloadPage } from './payload-types.ts';
import { authority, params } from './authority.ts';
import { fail, rows } from './util.ts';

export interface LexicalHead { id: string; revision: number; score: number }
export interface ShardSearch {
    shardIds(): string[];
    searchPage(shardId: string, spaceId: string, expression: string, after: unknown, limit: number): Promise<PayloadPage>;
}
const PAGE_SIZE = 50;
const MAX_PAGES = 8;
export const compareLexical = (a: LexicalHead, b: LexicalHead): number => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function uniqueLexical(candidates: LexicalHead[], limit: number): LexicalHead[] {
    const unique = new Map<string, LexicalHead>();
    for (const candidate of candidates) {
        const key = JSON.stringify([candidate.id, candidate.revision]), previous = unique.get(key);
        if (!previous || candidate.score > previous.score) unique.set(key, candidate);
    }
    return [...unique.values()].sort(compareLexical).slice(0, limit);
}

/** Candidate storage has no authority. Resolve each bounded page against exact
 * committed central pointers before ranking. Never turn exhausted stale scans
 * into successful but incomplete search results. */
export async function shardedLexical(db: Database, storage: ShardSearch, hash: string, spaceId: string,
    expression: string, limit: number, clock: () => number): Promise<LexicalHead[]> {
    const shards = storage.shardIds(), collected: LexicalHead[] = [];
    if (!expression) return collected;
    for (let offset = 0; offset < shards.length; offset += 4) {
        const group = await Promise.all(shards.slice(offset, offset + 4).map(async shardId => {
            let found: LexicalHead[] = [];
            let cursor: string | null = null;
            for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
                const page = await storage.searchPage(shardId, spaceId, expression, cursor, PAGE_SIZE);
                const current = page.results.length ? await rows<{ id: string; revision: number; payloadId: string }>(db,
                    `SELECT r.id,r.revision,r.payload_id AS payloadId FROM json_each(?) candidate
                        JOIN memories r ON r.id=json_extract(candidate.value,'$.memoryId')
                            AND r.payload_id=json_extract(candidate.value,'$.payloadId')
                        JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c
                        WHERE s.id=? AND r.payload_shard_id=? AND r.deleted_at IS NULL AND r.erased_at IS NULL
                            AND NOT EXISTS(SELECT 1 FROM memories successor WHERE successor.supersedes_id=r.id)
                            AND ${authority('read')}`,
                    [JSON.stringify(page.results), spaceId, shardId, ...params(hash, clock(), 'read')]) : [];
                const authorized = new Map(current.map(row => [row.payloadId, row]));
                for (const candidate of page.results) {
                    const row = authorized.get(candidate.payloadId);
                    if (row && row.id === candidate.memoryId) found.push({ id: row.id, revision: row.revision, score: candidate.score });
                }
                found = uniqueLexical(found, limit);
                if (found.length >= limit || page.nextCursor === null) return found;
                if (page.nextCursor === cursor) fail(503, 'search_scan_exhausted');
                cursor = page.nextCursor;
            }
            return fail(503, 'search_scan_exhausted');
        }));
        collected.push(...group.flat());
    }
    return uniqueLexical(collected, limit);
}

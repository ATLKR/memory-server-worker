import type { Database } from './types.ts';
import { sqlNow } from '../sql-clock.ts';
import { fail, one } from './util.ts';

type Kind = 'current' | 'history';
type Progress = { after_memory_id: string; after_revision: number; generation: number };
interface Archive { archiveOne(memoryId: string, revision: number, target: Kind): Promise<boolean> }
export type BackfillResult = { converted: number; skipped: number; failed: number };
async function within<T>(value: Promise<T>, end: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('payload_backfill_timeout')), Math.max(1, end - Date.now())); })]); }
    finally { if (timer) clearTimeout(timer); }
}

/** Trusted, opt-in legacy conversion. The cursor advances before any external
 * write, so crashes and provider failures cannot pin all later revisions. */
export class LegacyBackfill {
    private readonly env: { DB: Database; STORAGE_BACKFILL_ENABLED?: string };
    private readonly archive: Archive;
    private readonly clock: () => number;
    constructor(env: { DB: Database; STORAGE_BACKFILL_ENABLED?: string }, archive: Archive, clock = Date.now) { this.env = env; this.archive = archive; this.clock = clock; }
    private async step(kind: Kind, result: BackfillResult, end: number): Promise<void> {
        const db = this.env.DB;
        const progress = await within(one<Progress>(db, 'SELECT after_memory_id,after_revision,generation FROM release_payload_backfill_progress WHERE kind=?', [kind]), end);
        if (!progress) fail(503, 'payload_backfill_unavailable');
        const candidate = await within(one<{ memoryId: string; revision: number }>(db, kind === 'current'
            ? `SELECT id AS memoryId,revision FROM memories INDEXED BY release_memories_inline_archive
               WHERE payload_id IS NULL AND erased_at IS NULL AND id>? ORDER BY id LIMIT 1`
            : `SELECT memory_id AS memoryId,revision FROM memory_versions INDEXED BY release_versions_inline_archive
               WHERE payload_id IS NULL AND (memory_id,revision)>(?,?) ORDER BY memory_id,revision LIMIT 1`,
            kind === 'current' ? [progress.after_memory_id] : [progress.after_memory_id, progress.after_revision]), end);
        const claim = await within(db.prepare(`UPDATE release_payload_backfill_progress SET after_memory_id=?,after_revision=?,generation=generation+1,updated_at=${sqlNow()}
          WHERE kind=? AND generation=? RETURNING generation`).bind(candidate?.memoryId ?? '', candidate?.revision ?? 0, this.clock(), kind, progress.generation).first<{ generation: number }>(), end);
        if (!claim || !candidate || Date.now() > end - 20000) return;
        let error: string | null = null;
        try {
            if (await within(this.archive.archiveOne(candidate.memoryId, candidate.revision, kind), end)) result.converted++;
            else result.skipped++;
        } catch { error = 'payload_archive_failure'; result.failed++; }
        // The next worker may already have advanced. An old attempt must not
        // overwrite the newer checkpoint's diagnostic result.
        await within(db.prepare(`UPDATE release_payload_backfill_progress SET last_error=?,last_error_at=?,updated_at=${sqlNow()}
          WHERE kind=? AND generation=?`).bind(error, error ? this.clock() : null, this.clock(), kind, claim.generation).run(), end);
    }
    async run(): Promise<BackfillResult> {
        const result = { converted: 0, skipped: 0, failed: 0 };
        if (this.env.STORAGE_BACKFILL_ENABLED !== 'true') return result;
        const end = Date.now() + 60000;
        await Promise.all((['current', 'history'] as const).map(kind => this.step(kind, result, end)));
        return result;
    }
}

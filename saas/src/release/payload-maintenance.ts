import type { Database } from './types.ts';
import type { PayloadContext, PayloadRef } from './payload-types.ts';
import { sqlNow } from '../sql-clock.ts';
import { canonical, fail, rows, stmt } from './util.ts';

interface CleanupStorage { readonly enabled: boolean; purge(ctx: PayloadContext, ref: PayloadRef): Promise<void>; retireHot(ctx: PayloadContext, ref: PayloadRef): Promise<void> }
type Queue = 'purges' | 'retirements';
type CleanupRow = { payload_id: string; space_id: string; memory_id: string; payload_shard_id: string; payload_object_key: string; payload_sha256: string; payload_bytes: number; attempts: number; available_at: number; created_at: number };
export type PayloadMaintenanceResult = { collected: number; purged: number; retired: number; failed: number; deferred: number };
const table = (queue: Queue) => 'release_payload_' + queue;
const done = (queue: Queue) => queue === 'purges' ? 'purged_at' : 'retired_at';
const unreferenced = (alias: string, history: boolean) => `NOT EXISTS(SELECT 1 FROM memories WHERE payload_id=${alias}.payload_id)${history ? ` AND NOT EXISTS(SELECT 1 FROM memory_versions WHERE payload_id=${alias}.payload_id)` : ''}`;
async function within<T>(value: Promise<T>, end: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('payload_maintenance_timeout')), Math.max(1, end - Date.now())); })]); }
    finally { if (timer) clearTimeout(timer); }
}

/** Durable privacy cleanup is independent of optional indexing/AI jobs.
 * Outbox claims only delay retries; immutable provider tombstones make a late
 * provider completion safe even when its claimant can no longer acknowledge. */
export class PayloadMaintenance {
    private readonly db: Database;
    private readonly storage: CleanupStorage;
    private readonly clock: () => number;
    constructor(env: { DB: Database }, storage: CleanupStorage, clock = Date.now) { this.db = env.DB; this.storage = storage; this.clock = clock; }
    private async collect(end: number): Promise<number> {
        // Each intent contains at most20 stages. Five indexed intent candidates
        // therefore bound one GC transaction to at most100 payload locators.
        const candidates = await within(rows<{ id: string }>(this.db, `SELECT id FROM release_payload_intents INDEXED BY release_payload_intents_expiry
          WHERE published_at IS NULL AND collection_started_at IS NULL AND expires_at<=${sqlNow()} ORDER BY expires_at,id LIMIT 5`, [this.clock()]), end);
        if (!candidates.length) return 0;
        const ids = canonical(candidates.map(row => row.id)), at = this.clock();
        const eligible = `i.id IN (SELECT value FROM json_each(?)) AND i.published_at IS NULL AND i.collection_started_at IS NULL AND i.expires_at<=${sqlNow()}`;
        const result = await within(this.db.batch([
            stmt(this.db, `INSERT INTO release_payload_purges(payload_id,space_id,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,created_at)
              SELECT p.id,i.space_id,p.memory_id,p.payload_shard_id,p.payload_object_key,p.payload_sha256,p.payload_bytes,${sqlNow()}
              FROM release_payload_intents i CROSS JOIN release_payload_stages p ON p.intent_id=i.id WHERE ${eligible} AND p.state IN ('staging','ready')
                AND NOT EXISTS(SELECT 1 FROM memories WHERE payload_id=p.id) AND NOT EXISTS(SELECT 1 FROM memory_versions WHERE payload_id=p.id)
                AND NOT EXISTS(SELECT 1 FROM release_payload_purges old WHERE old.payload_id=p.id) RETURNING payload_id`, [at, ids, at]),
            stmt(this.db, `UPDATE release_payload_stages SET state='purge_pending' WHERE state IN ('staging','ready') AND EXISTS(SELECT 1 FROM release_payload_purges q WHERE q.payload_id=release_payload_stages.id)
              AND intent_id IN (SELECT i.id FROM release_payload_intents i WHERE ${eligible})`, [ids, at]),
            stmt(this.db, `UPDATE release_payload_intents SET collection_started_at=${sqlNow()} WHERE id IN (SELECT value FROM json_each(?))
              AND published_at IS NULL AND collection_started_at IS NULL AND expires_at<=${sqlNow()}
              AND NOT EXISTS(SELECT 1 FROM release_payload_stages p WHERE p.intent_id=release_payload_intents.id AND
                (p.state NOT IN ('purge_pending','purged') OR NOT EXISTS(SELECT 1 FROM release_payload_purges q WHERE q.payload_id=p.id)))`, [at, ids, at]),
        ]), end);
        if (result.some(row => !row.success)) fail(503, 'database_unavailable');
        return result[0]?.results.length ?? 0;
    }
    private async pending(queue: Queue, end: number): Promise<CleanupRow[]> {
        return within(rows<CleanupRow>(this.db, `SELECT * FROM ${table(queue)} INDEXED BY ${table(queue)}_pending
          WHERE ${done(queue)} IS NULL AND available_at<=${sqlNow()} ORDER BY available_at,created_at,payload_id LIMIT 4`, [this.clock()]), end);
    }
    private async item(queue: Queue, candidate: CleanupRow, result: PayloadMaintenanceResult, end: number): Promise<void> {
        const name = table(queue), completed = done(queue), at = this.clock();
        const statements = [];
        if (queue === 'purges') statements.push(stmt(this.db, `UPDATE release_payload_stages SET state='purge_pending'
          WHERE id=? AND state IN ('staging','ready','published') AND EXISTS(SELECT 1 FROM ${name} q WHERE q.payload_id=release_payload_stages.id
            AND q.purged_at IS NULL AND q.available_at<=${sqlNow()} AND ${unreferenced('q', true)})`, [candidate.payload_id, at]));
        statements.push(stmt(this.db, `UPDATE ${name} SET attempts=attempts+1,available_at=${sqlNow()}+60000
          WHERE payload_id=? AND ${completed} IS NULL AND available_at<=${sqlNow()} AND ${unreferenced(name, queue === 'purges')}
            ${queue === 'purges' ? "AND EXISTS(SELECT 1 FROM release_payload_stages p WHERE p.id=release_payload_purges.payload_id AND p.state='purge_pending')" : ''} RETURNING *`, [at, candidate.payload_id, at]));
        const claimed = await within(this.db.batch<CleanupRow>(statements), end);
        if (claimed.some(row => !row.success)) fail(503, 'database_unavailable');
        const row = claimed.at(-1)?.results[0];
        if (!row) {
            // Raw bounded pages may include a still-current retirement. Delay it
            // rather than repeatedly blocking all later due records.
            await within(this.db.prepare(`UPDATE ${name} SET available_at=${sqlNow()}+3600000,last_error='payload_still_referenced'
              WHERE payload_id=? AND ${completed} IS NULL AND available_at<=${sqlNow()} AND NOT (${unreferenced(name, queue === 'purges')})`)
                .bind(this.clock(), candidate.payload_id, this.clock()).run(), end);
            result.deferred++; return;
        }
        if (Date.now() > end - 20000) { result.deferred++; return; }
        const ctx = { spaceId: row.space_id, memoryId: row.memory_id }, ref = { id: row.payload_id, shardId: row.payload_shard_id, objectKey: row.payload_object_key, sha256: row.payload_sha256, bytes: row.payload_bytes };
        try {
            await within(queue === 'purges' ? this.storage.purge(ctx, ref) : this.storage.retireHot(ctx, ref), end);
        } catch {
            const delay = Math.min(3600000, 60000 * 2 ** Math.min(6, row.attempts - 1));
            await within(this.db.prepare(`UPDATE ${name} SET available_at=${sqlNow()}+?,last_error='payload_provider_failure'
              WHERE payload_id=? AND ${completed} IS NULL AND attempts=?`).bind(this.clock(), delay, row.payload_id, row.attempts).run(), end);
            result.failed++; return;
        }
        const acknowledge = [stmt(this.db, `UPDATE ${name} SET ${completed}=${sqlNow()},last_error=NULL
          WHERE payload_id=? AND ${completed} IS NULL AND attempts=? AND ${unreferenced(name, queue === 'purges')} RETURNING payload_id`, [this.clock(), row.payload_id, row.attempts])];
        if (queue === 'purges') acknowledge.push(stmt(this.db, `UPDATE release_payload_stages SET state='purged'
          WHERE id=? AND state='purge_pending' AND EXISTS(SELECT 1 FROM release_payload_purges q WHERE q.payload_id=release_payload_stages.id AND q.purged_at IS NOT NULL AND q.attempts=? AND ${unreferenced('q', true)})`, [row.payload_id, row.attempts]));
        const acknowledged = await within(this.db.batch(acknowledge), end);
        if (acknowledged.some(row => !row.success)) fail(503, 'database_unavailable');
        if (acknowledged[0]?.results.length) { if (queue === 'purges') result.purged++; else result.retired++; }
    }
    async run(): Promise<PayloadMaintenanceResult> {
        const result = { collected: 0, purged: 0, retired: 0, failed: 0, deferred: 0 };
        if (!this.storage.enabled) return result;
        const end = Date.now() + 60000;
        result.collected = await this.collect(end);
        const candidates = (await Promise.all((['purges', 'retirements'] as const).map(async queue => (await this.pending(queue, end)).map(row => ({ queue, row })))))
            .flat().sort((a, b) => a.row.available_at - b.row.available_at || a.row.created_at - b.row.created_at || (a.row.payload_id < b.row.payload_id ? -1 : a.row.payload_id > b.row.payload_id ? 1 : a.queue < b.queue ? -1 : 1)).slice(0, 4);
        for (let offset = 0; offset < candidates.length && Date.now() <= end - 20000; offset += 2)
            await Promise.all(candidates.slice(offset, offset + 2).map(({ queue, row }) => this.item(queue, row, result, end)));
        return result;
    }
}

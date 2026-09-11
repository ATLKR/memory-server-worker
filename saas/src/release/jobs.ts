import type { ReleaseEnv, Memory, Value } from './types.ts';
import { sqlNow } from '../sql-clock.ts';
import { batch, digest, one, payloadKeyId, rows, stmt } from './util.ts';
import { deadline, embed } from './search.ts';
import { columns, erasureStatements, MemoryStore, type MemoryRow } from './memory.ts';
import { PayloadStore } from './payloads.ts';
import { liveAccountSql } from './authority.ts';
// Alias release_jobs, with one current-time binding. Completed review is also
// terminal for extraction, even while the human decision is still pending.
const retryableIngest = `EXISTS(SELECT 1 FROM release_ingests i WHERE i.id=release_jobs.id
    AND i.state='queued' AND i.ciphertext IS NOT NULL AND i.expires_at>${sqlNow()})`;
const WORK_SLICE_MS = 240000;
const INDEX_PROVIDER_CALLS = 20;
const DELETE_RETRY_MS = 60000;
const DELETE_RETRY_MAX_MS = 86400000;
class OwnerSuspended extends Error {}
export type Job = {
    id: string;
    memoryId: string | null;
    spaceId: string;
    revision: number;
    kind: string;
    attempt: number;
    leaseToken: string;
};
export class Jobs {
    env: ReleaseEnv;
    clock: () => number;
    ingest?: (job: Job) => Promise<void>;
    store: MemoryStore;
    constructor(env: ReleaseEnv, clock: () => number = Date.now) { this.env = env; this.clock = clock; this.store = new MemoryStore(env.DB, clock, new PayloadStore(env, clock)); }
    async claim(): Promise<Job | null> {
        const at = this.clock();
        // Retire a bounded indexed page of exhausted leases. Terminal ingests
        // retain done precedence, without filtering an entire backlog first.
        await this.env.DB.prepare(`UPDATE release_jobs
            SET state=CASE WHEN kind='ingest' AND NOT ${retryableIngest} THEN 'done' ELSE 'dead' END,
                lease_token=NULL,lease_until=NULL,
                last_error=CASE WHEN kind='ingest' AND NOT ${retryableIngest} THEN NULL ELSE 'lease_expired_attempts_exhausted' END
            WHERE id IN (SELECT id FROM release_jobs INDEXED BY release_jobs_exhausted_lease WHERE state='leased' AND lease_until<=${sqlNow()} AND attempt>=5
                ORDER BY lease_until,id LIMIT 100)`).bind(at, at, at).run();
        await this.env.DB.prepare(`UPDATE release_jobs SET state='done',lease_token=NULL,lease_until=NULL,last_error=NULL
            WHERE id IN (SELECT candidate.id FROM (
                SELECT id FROM (SELECT id FROM release_jobs INDEXED BY release_jobs_pending_claim WHERE state='pending' AND kind='ingest' AND cleanup_only=0
                    AND available_at<=${sqlNow()} ORDER BY available_at,id LIMIT 100)
                UNION ALL SELECT id FROM (SELECT id FROM release_jobs INDEXED BY release_jobs_leased_claim WHERE state='leased' AND kind='ingest' AND cleanup_only=0
                    AND attempt<5 AND lease_until<=${sqlNow()} ORDER BY lease_until,id LIMIT 100)
            ) candidate WHERE NOT EXISTS(SELECT 1 FROM release_ingests i WHERE i.id=candidate.id
                AND i.state='queued' AND i.ciphertext IS NOT NULL AND i.expires_at>${sqlNow()}))`).bind(at, at, at).run();
        // Each configured kind/state contributes at most one indexed candidate.
        // Scalar IDs in one JSON array avoid workerd's compound-SELECT limit.
        // Fairness follows pending availability or an abandoned lease's expiry;
        // only these at-most-eight candidates participate in the final sort.
        let ingestKeyId: string | null = null;
        if (this.env.AI && this.env.PAYLOAD_KEY && this.ingest) {
            try { ingestKeyId = await payloadKeyId(this.env.PAYLOAD_KEY); }
            catch (error) {
                // An invalid extraction key must not stall deletion or indexing.
                // Leave ingests unclaimed until configuration is repaired.
                const code = (error as { code?: string })?.code;
                if (code !== 'payload_key_invalid' && code !== 'invalid_encoding')
                    throw error;
            }
        }
        // The durable rotation guard must reject an old worker's claim before
        // its undecryptable attempt consumes the new submission's retry budget.
        // Other job kinds keep treating the entire token as an opaque lease.
        const token = (ingestKeyId ? `v2.${ingestKeyId}.` : '') + crypto.randomUUID();
        const branches: string[] = [], values: Value[] = [token, at];
        const include = (kind: 'upsert' | 'delete' | 'ingest', cleanupOnly: number) => {
            branches.push(`(SELECT id FROM release_jobs INDEXED BY release_jobs_pending_claim
                WHERE state='pending' AND kind='${kind}' AND cleanup_only=${cleanupOnly} AND available_at<=${sqlNow()}
                ORDER BY available_at,id LIMIT 1)`);
            branches.push(`(SELECT id FROM release_jobs INDEXED BY release_jobs_leased_claim
                WHERE state='leased' AND kind='${kind}' AND cleanup_only=${cleanupOnly} AND attempt<5 AND lease_until<=${sqlNow()}
                ORDER BY lease_until,id LIMIT 1)`);
            values.push(at, at);
        };
        if (this.env.MEMORY_INDEX) {
            if (this.env.AI)
                include('upsert', 0);
            include('upsert', 1);
            include('delete', 0);
        }
        if (ingestKeyId)
            include('ingest', 0);
        if (!branches.length)
            return null;
        values.push(at);
        return this.env.DB.prepare(`UPDATE release_jobs SET state='leased',lease_token=?,lease_until=${sqlNow()}+120000,attempt=attempt+1
    WHERE id=(SELECT id FROM release_jobs candidate WHERE id IN (SELECT value FROM json_each(json_array(${branches.join(',')})))
      AND (kind<>'ingest' OR EXISTS(SELECT 1 FROM release_ingests i WHERE i.id=candidate.id
        AND i.state='queued' AND i.ciphertext IS NOT NULL AND i.expires_at>${sqlNow()}))
      ORDER BY CASE WHEN state='leased' THEN lease_until ELSE available_at END,id LIMIT 1)
    RETURNING id,memory_id AS memoryId,space_id AS spaceId,revision,kind,attempt,lease_token AS leaseToken`)
            .bind(...values).first<Job>();
    }
    async live(job: Job): Promise<boolean> {
        const current = await one<{ leaseUntil: number }>(this.env.DB, `SELECT lease_until AS leaseUntil FROM release_jobs WHERE id=? AND lease_token=? AND state='leased' AND lease_until>${sqlNow()}`, [job.id, job.leaseToken, this.clock()]);
        return Boolean(current && current.leaseUntil > this.clock());
    }
    async indexable(job: Job): Promise<boolean> {
        // One snapshot fences the lease, revision and tenant immediately before
        // each new provider request. Committed organization content belongs to
        // the organization even after its writer's credential expires.
        const row = await one<{ eligible: number; suspended: number; leaseUntil: number }>(this.env.DB, `SELECT EXISTS(
            SELECT 1 FROM memories r JOIN spaces s ON s.id=r.space_id
            WHERE r.id=j.memory_id AND r.space_id=j.space_id AND r.revision=j.revision
                AND r.deleted_at IS NULL AND r.erased_at IS NULL
                AND (s.account_id IS NULL OR EXISTS(SELECT 1 FROM accounts a WHERE a.id=s.account_id AND ${liveAccountSql('a')}))
                AND (s.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o WHERE o.id=s.organization_id AND o.disabled_at IS NULL))
            ) AS eligible,EXISTS(
                SELECT 1 FROM memories r JOIN spaces s ON s.id=r.space_id JOIN accounts a ON a.id=s.account_id
                JOIN provider_identities p ON p.account_id=a.id JOIN release_identity_lifecycle_state l
                    ON l.issuer=p.issuer AND l.subject=p.subject AND l.address=''
                WHERE r.id=j.memory_id AND r.space_id=j.space_id AND r.revision=j.revision
                    AND r.deleted_at IS NULL AND r.erased_at IS NULL AND a.disabled_at IS NULL AND l.kind='account.suspended'
            ) AS suspended,j.lease_until AS leaseUntil FROM release_jobs j WHERE j.id=? AND j.memory_id=? AND j.space_id=? AND j.revision=?
                AND j.lease_token=? AND j.state='leased' AND j.lease_until>${sqlNow()}`,
            [job.id, job.memoryId, job.spaceId, job.revision, job.leaseToken, this.clock()]);
        if (!row || row.leaseUntil <= this.clock())
            throw Error('lease_lost');
        // Suspension is reversible. Retain unfinished chunks without sending
        // more plaintext or treating a paused owner as a provider failure.
        if (!row.eligible && row.suspended)
            throw new OwnerSuspended('owner_suspended');
        return Boolean(row.eligible);
    }
    async renew(job: Job): Promise<void> {
        const at = this.clock();
        // Extend only a lease this worker still holds. An expired or reclaimed
        // worker must not resume external work under a new owner's lease.
        const result = await this.env.DB.prepare(`UPDATE release_jobs SET lease_until=MAX(lease_until,${sqlNow()}+120000)
            WHERE id=? AND lease_token=? AND state='leased' AND lease_until>${sqlNow()}`)
            .bind(at, job.id, job.leaseToken, at).run();
        if (!result.success || result.meta.changes !== 1 || this.clock() >= at + 120000)
            throw Error('lease_lost');
    }
    async drain(limit = 5): Promise<void> {
        const stopAt = this.clock() + WORK_SLICE_MS;
        for (let i = 0; i < limit && this.clock() < stopAt; i++) {
            const job = await this.claim();
            if (!job)
                return;
            try {
                let complete = true;
                if (job.kind === 'ingest') {
                    if (!this.ingest)
                        throw Error('ingest_not_configured');
                    await this.ingest(job);
                }
                else
                    complete = await this.index(job);
                const now = this.clock();
                // A useful continuation releases its lease without consuming a
                // failure attempt. Earlier failures and durable progress survive.
                const result = complete
                    ? await this.env.DB.prepare(`UPDATE release_jobs SET state='done',available_at=${sqlNow()},lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND lease_token=? AND state='leased' AND lease_until>${sqlNow()}`).bind(now, job.id, job.leaseToken, now).run()
                    : await this.env.DB.prepare(`UPDATE release_jobs SET state='pending',attempt=MAX(attempt-1,0),
                        available_at=CASE WHEN json_array_length(cleanup_pending)>0 THEN ${sqlNow()}+5000 ELSE ${sqlNow()}+1 END,
                        lease_token=NULL,lease_until=NULL,
                        last_error=CASE WHEN json_array_length(cleanup_pending)>0 THEN 'vector_delete_pending' ELSE NULL END
                        WHERE id=? AND lease_token=? AND state='leased' AND lease_until>${sqlNow()}`).bind(now, now, job.id, job.leaseToken, now).run();
                if (!result.success || result.meta.changes !== 1)
                    throw Error('lease_lost');
            }
            catch (error) {
                if (error instanceof OwnerSuspended) {
                    const now = this.clock();
                    await this.env.DB.prepare(`UPDATE release_jobs SET state='pending',attempt=MAX(attempt-1,0),
                        available_at=${sqlNow()}+60000,last_error='owner_suspended',lease_token=NULL,lease_until=NULL
                        WHERE id=? AND lease_token=? AND state='leased' AND lease_until>${sqlNow()}`)
                        .bind(now, job.id, job.leaseToken, now).run();
                    continue;
                }
                const exhausted = job.attempt >= 5;
                const backoff = Math.min(3600000, 1000 * 2 ** job.attempt) + Math.floor(Math.random() * 1000);
                const now = this.clock();
                // Cancellation/expiry during an in-flight call is a terminal
                // decision, not a provider failure to enqueue again.
                await this.env.DB.prepare(`UPDATE release_jobs
                    SET state=CASE WHEN kind='ingest' AND NOT ${retryableIngest} THEN 'done' ELSE ? END,available_at=${sqlNow()}+?,
                        last_error=CASE WHEN kind='ingest' AND NOT ${retryableIngest} THEN NULL ELSE 'provider_or_processing_failure' END,
                        lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND state='leased' AND lease_until>${sqlNow()}`)
                    .bind(now, exhausted ? 'dead' : 'pending', now, backoff, now, job.id, job.leaseToken, now).run();
            }
        }
    }
    async index(job: Job): Promise<boolean> {
        const db = this.env.DB, index = this.env.MEMORY_INDEX;
        if (!index)
            throw Error('index_not_configured');
        const stopAt = this.clock() + WORK_SLICE_MS;
        let providerCalls = 0;
        const canCall = (count: number) => providerCalls + count <= INDEX_PROVIDER_CALLS && this.clock() < stopAt;
        const current = await one<MemoryRow>(db, `SELECT ${columns} FROM memories r WHERE r.id=? AND r.space_id=?`, [job.memoryId, job.spaceId]);
        if (!current || current.revision !== job.revision)
            return true;
        await this.renew(job);
        const progress = await one<{ nextChunk: number; cleanupOnly: number; cleanupCursor: string; cleanupPending: string; cleanupRetryAt: number; cleanupRetryDelay: number }>(db,
            `SELECT next_chunk AS nextChunk,cleanup_cursor AS cleanupCursor,cleanup_pending AS cleanupPending,
                cleanup_retry_at AS cleanupRetryAt,cleanup_retry_delay AS cleanupRetryDelay,cleanup_only AS cleanupOnly FROM release_jobs
                WHERE id=? AND lease_token=? AND state='leased' AND lease_until>${sqlNow()}`, [job.id, job.leaseToken, this.clock()]);
        if (!progress)
            throw Error('lease_lost');
        let pending = JSON.parse(progress.cleanupPending) as string[];
        const checkpoint = async (minimumRetryDelay = 0) => {
            const result = await db.prepare(`UPDATE release_jobs SET next_chunk=?,cleanup_cursor=?,cleanup_pending=?,cleanup_retry_at=${minimumRetryDelay ? `MAX(?,${sqlNow()}+?)` : '?'},cleanup_retry_delay=?
                WHERE id=? AND lease_token=? AND state='leased' AND lease_until>${sqlNow()}`)
                .bind(progress.nextChunk, progress.cleanupCursor, JSON.stringify(pending), progress.cleanupRetryAt,
                    ...(minimumRetryDelay ? [this.clock(), minimumRetryDelay] : []), progress.cleanupRetryDelay,
                    job.id, job.leaseToken, this.clock()).run();
            if (!result.success || result.meta.changes !== 1)
                throw Error('lease_lost');
            if (minimumRetryDelay)
                progress.cleanupRetryAt = Math.max(progress.cleanupRetryAt, this.clock() + minimumRetryDelay);
        };
        const deletePage = async (ids: string[], retry: boolean): Promise<boolean> => {
            if (!canCall(1))
                return false;
            await this.renew(job);
            pending = ids;
            progress.cleanupRetryDelay = retry ? Math.min(DELETE_RETRY_MAX_MS, progress.cleanupRetryDelay * 2) : DELETE_RETRY_MS;
            progress.cleanupRetryAt = this.clock() + progress.cleanupRetryDelay;
            // Reserve the page and next retry BEFORE the uncertain network
            // effect. A crash or timeout must not restart its propagation clock
            // on every invocation. The lease token fences every checkpoint.
            await checkpoint(progress.cleanupRetryDelay);
            if (!canCall(1))
                return false;
            if (!await this.live(job))
                throw Error('lease_lost');
            providerCalls++;
            await deadline(index.deleteByIds(ids));
            return true;
        };
        if (current.deletedAt === null && !progress.cleanupOnly) {
            // Storage awaits precede the existing per-provider revision and
            // lease checks. Never send a placeholder or a stale cached payload.
            const [hydrated] = await this.store.hydrateRows([current]);
            const chars = Array.from(hydrated!.body), chunks: string[] = [];
            for (let offset = 0; offset < chars.length; offset += 1650)
                chunks.push(chars.slice(offset, offset + 1800).join(''));
            const prefix = (await digest(current.id)).slice(0, 36), namespace = await digest(job.spaceId);
            for (let n = progress.nextChunk; n < chunks.length; n++) {
                if (!canCall(2))
                    return false;
                // A full memory may need more than two minutes across many bounded
                // provider calls, so renew between chunks rather than restarting it.
                await this.renew(job);
                // Renewal and the preceding provider call can overlap a mutation.
                // Recheck before sending another cached plaintext chunk to AI.
                if (!await this.indexable(job))
                    return true;
                providerCalls += 2;
                const values = await embed(this.env, chunks[n]!, async () => {
                    if (!await this.indexable(job)) throw Error('index_authority_lost');
                });
                const vectorId = `${prefix}:${current.revision}:${n}`;
                // Record the identifier BEFORE the network side effect. A crashed or timed
                // out upsert remains discoverable by an erasure/reconciliation sweep.
                await db.prepare(`INSERT INTO release_vector_refs(memory_id,vector_id,revision) SELECT ?,?,?
                    WHERE EXISTS(SELECT 1 FROM release_jobs WHERE id=? AND lease_token=? AND state='leased' AND lease_until>${sqlNow()})
                    ON CONFLICT(vector_id) DO NOTHING`).bind(current.id, vectorId, current.revision, job.id, job.leaseToken, this.clock()).run();
                if (!await this.indexable(job))
                    return true;
                await deadline(index.upsert([{ id: vectorId, namespace, values, metadata: { memoryId: current.id, revision: current.revision } }]));
                progress.nextChunk = n + 1;
                await checkpoint();
            }
            // A network upsert may finish after a newer revision was indexed. Never
            // let an older job delete that revision, even if its lease is still live.
            if (!await this.live(job))
                throw Error('lease_lost');
            if (!await one(db, 'SELECT id FROM memories WHERE id=? AND revision=? AND deleted_at IS NULL AND erased_at IS NULL', [current.id, current.revision]))
                return true;
        }
        // Keep identifier-only refs for anti-resurrection sweeps. A durable
        // cursor prevents a retry from repeatedly deleting the oldest pages.
        while (true) {
            // Vectorize accepts deletion before it becomes visible. Confirm the
            // exact page across invocations. A late old upsert can recreate it,
            // so retry deletion only after a durable, increasing grace period.
            // Visibility waits never consume the actual provider-error budget.
            if (pending.length) {
                if (!canCall(1))
                    return false;
                await this.renew(job);
                providerCalls++;
                if ((await deadline(index.getByIds(pending))).length) {
                    // Migration16 pending pages have no known submission time.
                    // Give them the initial grace period rather than guessing.
                    if (!progress.cleanupRetryAt) {
                        progress.cleanupRetryAt = this.clock() + DELETE_RETRY_MS;
                        progress.cleanupRetryDelay = DELETE_RETRY_MS;
                        await checkpoint(DELETE_RETRY_MS);
                        return false;
                    }
                    if (this.clock() < progress.cleanupRetryAt || !await deletePage(pending, true))
                        return false;
                    continue;
                }
                progress.cleanupCursor = pending.at(-1)!;
                pending = [];
                progress.cleanupRetryAt = 0;
                progress.cleanupRetryDelay = DELETE_RETRY_MS;
                await checkpoint();
                continue;
            }
            const refs = await rows<{ vectorId: string }>(db, `SELECT vector_id AS vectorId FROM release_vector_refs
                WHERE memory_id=? AND vector_id>? AND revision${current.deletedAt === null ? '<' : '<='}?
                ORDER BY vector_id LIMIT 101`, [current.id, progress.cleanupCursor, current.revision]);
            if (!refs.length)
                break;
            if (!canCall(2))
                return false;
            const ids = refs.slice(0, 100).map(row => row.vectorId);
            if (!await deletePage(ids, false))
                return false;
        }
        if (!await this.live(job))
            throw Error('lease_lost');
        if (current.erasedAt !== null) {
            const now = this.clock();
            const result = await db.prepare(`UPDATE release_erasure_ledger SET vector_erased_at=${sqlNow()} WHERE memory_id=?
                AND EXISTS(SELECT 1 FROM release_jobs j WHERE j.id=? AND j.lease_token=? AND j.state='leased' AND j.lease_until>${sqlNow()})
                AND EXISTS(SELECT 1 FROM memories r WHERE r.id=release_erasure_ledger.memory_id AND r.revision=? AND r.erased_at IS NOT NULL)`)
                .bind(now, current.id, job.id, job.leaseToken, now, current.revision).run();
            if (!result.success || result.meta.changes !== 1)
                throw Error('lease_lost');
        }
        return true;
    }
    async maintain(): Promise<void> {
        const db = this.env.DB, at = this.clock();
        // Scheduling indexing/cleanup must not implicitly authorize destruction
        // of retained user content. Automatic source erasure is a separate opt-in.
        if (this.env.AUTO_ERASURE_ENABLED === 'true') {
            const progress = await one<{ cursor: string }>(db, "SELECT cursor FROM release_maintenance_progress WHERE name='source_erasure'", []);
            if (!progress)
                throw Error('maintenance_progress_missing');
            const [afterTime, afterId] = progress.cursor ? JSON.parse(progress.cursor) as [number, string] : [0, ''];
            // Policy-dependent expiry cannot be filtered before LIMIT: a long
            // retention backlog could otherwise require scanning every row.
            const candidates = await rows<{
                id: string;
                actor: string;
                deletedAt: number;
            }>(db, `SELECT r.id,r.actor_credential_id AS actor,r.deleted_at AS deletedAt FROM memories r INDEXED BY release_memories_erasure_sweep
                WHERE r.deleted_at IS NOT NULL AND r.erased_at IS NULL AND r.deleted_at>=?
                    AND (r.deleted_at>? OR (r.deleted_at=? AND r.id>?)) ORDER BY r.deleted_at,r.id LIMIT 20`, [afterTime, afterTime, afterTime, afterId]);
            for (const row of candidates)
                await batch(db, erasureStatements(db, row.id, at, row.actor,
                    `r.deleted_at+coalesce((SELECT retention_days FROM release_space_policies WHERE space_id=r.space_id),30)*86400000<=${sqlNow()}
                        AND EXISTS(SELECT 1 FROM release_maintenance_progress WHERE name='source_erasure' AND cursor=?)`, [at, progress.cursor]));
            const last = candidates.at(-1), next = candidates.length === 20 && last ? JSON.stringify([last.deletedAt, last.id]) : '';
            await db.prepare("UPDATE release_maintenance_progress SET cursor=? WHERE name='source_erasure' AND cursor=?").bind(next, progress.cursor).run();
        }
        // Bound every transient cleanup to keep a large backlog from exhausting
        // a scheduled invocation. Identity proofs referenced by immutable audit
        // records are deliberately excluded; authorization checks expiry directly.
        await db.prepare(`UPDATE release_ingests SET ciphertext=NULL,proposals=NULL,state=CASE WHEN state IN ('approved','cancelled') THEN state ELSE 'expired' END
            WHERE id IN (SELECT id FROM release_ingests WHERE expires_at<=${sqlNow()}
                AND (ciphertext IS NOT NULL OR proposals IS NOT NULL OR state IN ('queued','review','failed'))
                ORDER BY expires_at,id LIMIT 100)`).bind(at).run();
        for (const table of ['release_export_sessions', 'release_reauth_challenges'])
            await db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE expires_at<=${sqlNow()} ORDER BY expires_at,id LIMIT 100)`).bind(at).run();
        // Consumed DNS proofs are retained authority history, including legacy
        // proofs and those referenced by immutable verification receipts. The
        // partial index skips that history before choosing a bounded raw page.
        await db.prepare(`DELETE FROM release_domain_challenges WHERE id IN (
            SELECT id FROM release_domain_challenges INDEXED BY release_domains_pending_expiry
            WHERE used_at IS NULL AND expires_at<=${sqlNow()} ORDER BY expires_at,id LIMIT 100)`).bind(at).run();
        await db.prepare(`DELETE FROM release_mail_budget WHERE (account_id,day) IN
            (SELECT account_id,day FROM release_mail_budget WHERE day<? ORDER BY day,account_id LIMIT 100)`).bind(new Date(at).toISOString().slice(0, 10)).run();
        // On done jobs, available_at records the confirmed completion time.
        // Resweep current tombstones and obsolete live-memory references: a late
        // upsert can finish after either deletion or a newer revision's cleanup.
        // Completed upserts only clean references. Older jobs without chunk
        // checkpoints also skip embedding; an explicit rebuild resets progress.
        if (this.env.BACKGROUND_JOBS_ENABLED === 'true' && this.env.MEMORY_INDEX) {
            const progress = await one<{ cursor: string }>(db, "SELECT cursor FROM release_maintenance_progress WHERE name='vector_resweep'", []);
            if (!progress)
                throw Error('maintenance_progress_missing');
            const candidates = await rows<{ id: string }>(db, `SELECT id FROM release_jobs INDEXED BY release_jobs_done_sweep WHERE state='done' AND id>? ORDER BY id LIMIT 100`, [progress.cursor]);
            const next = candidates.length < 100 ? '' : candidates.at(-1)!.id;
            // Raw targets advance even when obsolete or not yet due. Cursor
            // fencing makes overlapping scheduled invocations safe and bounded.
            await batch(db, [stmt(db, `UPDATE release_jobs SET state='pending',attempt=0,available_at=${sqlNow()},
                next_chunk=CASE WHEN kind='upsert' THEN next_chunk ELSE 0 END,
                cleanup_cursor='',cleanup_pending='[]',cleanup_retry_at=0,cleanup_retry_delay=60000,
                cleanup_only=CASE WHEN kind='upsert' THEN 1 ELSE 0 END WHERE id IN (
                SELECT j.id FROM release_jobs j LEFT JOIN release_erasure_ledger e ON e.memory_id=j.memory_id
                JOIN memories m ON m.id=j.memory_id AND m.revision=j.revision
                WHERE j.id IN (SELECT value FROM json_each(?)) AND j.state='done' AND (
                    (j.kind='delete' AND m.deleted_at IS NOT NULL
                        AND (j.available_at<${sqlNow('? + 86400000')}-86400000 OR (m.erased_at IS NOT NULL AND e.vector_erased_at IS NULL)))
                    OR (j.kind='upsert' AND m.deleted_at IS NULL AND m.erased_at IS NULL AND j.available_at<${sqlNow('? + 86400000')}-86400000
                        AND EXISTS(SELECT 1 FROM release_vector_refs v WHERE v.memory_id=m.id AND v.revision<m.revision)))
                ) AND EXISTS(SELECT 1 FROM release_maintenance_progress WHERE name='vector_resweep' AND cursor=?)`,
                [at, JSON.stringify(candidates.map(row => row.id)), at - 86400000, at - 86400000, progress.cursor]),
                stmt(db, "UPDATE release_maintenance_progress SET cursor=? WHERE name='vector_resweep' AND cursor=?", [next, progress.cursor])]);
        }
    }
}

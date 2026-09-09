import type { ReleaseEnv, Memory, Value } from './types.ts';
import { batch, digest, one, rows, stmt } from './util.ts';
import { deadline, embed } from './search.ts';
import { erasureStatements } from './memory.ts';
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
    constructor(env: ReleaseEnv, clock: () => number = Date.now) { this.env = env; this.clock = clock; }
    async claim(): Promise<Job | null> {
        const at = this.clock(), token = crypto.randomUUID();
        return this.env.DB.prepare(`UPDATE release_jobs SET state='leased',lease_token=?,lease_until=?,attempt=attempt+1
    WHERE id=(SELECT id FROM release_jobs WHERE ((state='pending' AND available_at<=?) OR (state='leased' AND lease_until<=?))
      AND (kind<>'upsert' OR ?=1) AND (kind<>'ingest' OR ?=1) AND (kind<>'delete' OR ?=1) ORDER BY available_at,id LIMIT 1)
    RETURNING id,memory_id AS memoryId,space_id AS spaceId,revision,kind,attempt,lease_token AS leaseToken`)
            .bind(token, at + 120000, at, at, this.env.AI && this.env.MEMORY_INDEX ? 1 : 0, this.env.AI && this.env.PAYLOAD_KEY && this.ingest ? 1 : 0, this.env.MEMORY_INDEX ? 1 : 0).first<Job>();
    }
    async live(job: Job): Promise<boolean> { return Boolean(await one(this.env.DB, `SELECT id FROM release_jobs WHERE id=? AND lease_token=? AND state='leased' AND lease_until>?`, [job.id, job.leaseToken, this.clock()])); }
    async renew(job: Job): Promise<void> {
        const at = this.clock();
        // Extend only a lease this worker still holds. An expired or reclaimed
        // worker must not resume external work under a new owner's lease.
        const result = await this.env.DB.prepare(`UPDATE release_jobs SET lease_until=MAX(lease_until,?)
            WHERE id=? AND lease_token=? AND state='leased' AND lease_until>?`)
            .bind(at + 120000, job.id, job.leaseToken, at).run();
        if (!result.success || result.meta.changes !== 1)
            throw Error('lease_lost');
    }
    async drain(limit = 5): Promise<void> {
        for (let i = 0; i < limit; i++) {
            const job = await this.claim();
            if (!job)
                return;
            try {
                if (job.kind === 'ingest') {
                    if (!this.ingest)
                        throw Error('ingest_not_configured');
                    await this.ingest(job);
                }
                else
                    await this.index(job);
                await this.env.DB.prepare(`UPDATE release_jobs SET state='done',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND lease_token=? AND state='leased'`).bind(job.id, job.leaseToken).run();
            }
            catch {
                const exhausted = job.attempt >= 5;
                const backoff = Math.min(3600000, 1000 * 2 ** job.attempt) + Math.floor(Math.random() * 1000);
                await this.env.DB.prepare(`UPDATE release_jobs SET state=?,available_at=?,last_error='provider_or_processing_failure',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND state='leased'`).bind(exhausted ? 'dead' : 'pending', this.clock() + backoff, job.id, job.leaseToken).run();
            }
        }
    }
    async index(job: Job): Promise<void> {
        const db = this.env.DB, index = this.env.MEMORY_INDEX;
        if (!index)
            throw Error('index_not_configured');
        const current = await one<{
            id: string;
            body: string;
            revision: number;
            deletedAt: number | null;
            erasedAt: number | null;
        }>(db, 'SELECT id,body,revision,deleted_at AS deletedAt,erased_at AS erasedAt FROM memories WHERE id=? AND space_id=?', [job.memoryId, job.spaceId]);
        if (!current || current.revision !== job.revision)
            return;
        await this.renew(job);
        if (current.deletedAt !== null) {
            const refs = await rows<{
                vectorId: string;
            }>(db, 'SELECT vector_id AS vectorId FROM release_vector_refs WHERE memory_id=? AND revision<=?', [current.id, current.revision]);
            for (let i = 0; i < refs.length; i += 100) {
                const ids = refs.slice(i, i + 100).map(r => r.vectorId);
                await this.renew(job);
                await deadline(index.deleteByIds(ids));
                if ((await deadline(index.getByIds(ids))).length)
                    throw Error('delete_not_visible_yet');
            }
            // Keep identifier-only refs for subsequent anti-resurrection sweeps.
            if (current.erasedAt !== null)
                await db.prepare('UPDATE release_erasure_ledger SET vector_erased_at=? WHERE memory_id=?').bind(this.clock(), current.id).run();
            return;
        }
        const chars = Array.from(current.body), chunks: string[] = [];
        for (let offset = 0; offset < chars.length; offset += 1650)
            chunks.push(chars.slice(offset, offset + 1800).join(''));
        const prefix = (await digest(current.id)).slice(0, 36), namespace = await digest(job.spaceId);
        for (let n = 0; n < chunks.length; n++) {
            // A full memory may need more than two minutes across many bounded
            // provider calls, so renew between chunks rather than restarting it.
            await this.renew(job);
            const values = await embed(this.env, chunks[n]!);
            const vectorId = `${prefix}:${current.revision}:${n}`;
            const valid = await one(db, 'SELECT id FROM memories WHERE id=? AND revision=? AND deleted_at IS NULL AND erased_at IS NULL', [current.id, current.revision]);
            if (!valid)
                return;
            if (!await this.live(job))
                throw Error('lease_lost');
            // Record the identifier BEFORE the network side effect. A crashed or timed
            // out upsert remains discoverable by an erasure/reconciliation sweep.
            await db.prepare('INSERT INTO release_vector_refs(memory_id,vector_id,revision) VALUES(?,?,?) ON CONFLICT(vector_id) DO NOTHING').bind(current.id, vectorId, current.revision).run();
            await deadline(index.upsert([{ id: vectorId, namespace, values, metadata: { memoryId: current.id, revision: current.revision } }]));
        }
        // A network upsert may finish after a newer revision was indexed. Never
        // let an older job delete that revision, even if its lease is still live.
        if (!await this.live(job))
            throw Error('lease_lost');
        if (!await one(db, 'SELECT id FROM memories WHERE id=? AND revision=? AND deleted_at IS NULL AND erased_at IS NULL', [current.id, current.revision]))
            return;
        const old = await rows<{
            id: string;
        }>(db, 'SELECT vector_id AS id FROM release_vector_refs WHERE memory_id=? AND revision<?', [current.id, current.revision]);
        for (let i = 0; i < old.length; i += 100) {
            await this.renew(job);
            await deadline(index.deleteByIds(old.slice(i, i + 100).map(x => x.id)));
        }
    }
    async maintain(): Promise<void> {
        const db = this.env.DB, at = this.clock();
        // Scheduling indexing/cleanup must not implicitly authorize destruction
        // of retained user content. Automatic source erasure is a separate opt-in.
        if (this.env.AUTO_ERASURE_ENABLED === 'true') {
            const expired = await rows<{
                id: string;
                actor: string;
            }>(db, `SELECT r.id,r.actor_credential_id AS actor FROM memories r LEFT JOIN release_space_policies p ON p.space_id=r.space_id WHERE r.deleted_at IS NOT NULL AND r.erased_at IS NULL AND r.deleted_at+coalesce(p.retention_days,30)*86400000<=? ORDER BY r.deleted_at LIMIT 20`, [at]);
            for (const row of expired)
                await batch(db, erasureStatements(db, row.id, at, row.actor, `r.deleted_at+coalesce((SELECT retention_days FROM release_space_policies WHERE space_id=r.space_id),30)*86400000<=?`, [at]));
        }
        // Bound every transient cleanup to keep a large backlog from exhausting
        // a scheduled invocation. Identity proofs referenced by immutable audit
        // records are deliberately excluded; authorization checks expiry directly.
        await db.prepare(`UPDATE release_ingests SET ciphertext=NULL,proposals=NULL,state=CASE WHEN state IN ('approved','cancelled') THEN state ELSE 'expired' END
            WHERE id IN (SELECT id FROM release_ingests WHERE expires_at<=?
                AND (ciphertext IS NOT NULL OR proposals IS NOT NULL OR state IN ('queued','review','failed'))
                ORDER BY expires_at,id LIMIT 100)`).bind(at).run();
        for (const table of ['release_export_sessions', 'release_domain_challenges', 'release_reauth_challenges'])
            await db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE expires_at<=? ORDER BY expires_at,id LIMIT 100)`).bind(at).run();
        await db.prepare(`DELETE FROM release_mail_budget WHERE (account_id,day) IN
            (SELECT account_id,day FROM release_mail_budget WHERE day<? ORDER BY day,account_id LIMIT 100)`).bind(new Date(at).toISOString().slice(0, 10)).run();
        // A daily sweep also cleans a provider request that completed after a local timeout.
        if (this.env.BACKGROUND_JOBS_ENABLED === 'true' && this.env.MEMORY_INDEX)
            await db.prepare(`UPDATE release_jobs SET state='pending',attempt=0,available_at=? WHERE id IN (
                SELECT j.id FROM release_jobs j JOIN release_erasure_ledger e ON e.memory_id=j.memory_id
                JOIN memories m ON m.id=j.memory_id AND m.revision=j.revision
                WHERE j.kind='delete' AND j.state='done' AND (e.vector_erased_at IS NULL OR e.vector_erased_at<?)
                ORDER BY e.erased_at,j.id LIMIT 100)`).bind(at, at - 86400000).run();
    }
}

import type { Capability, Database, Memory, Provenance, Statement, Value } from './types.ts';
import { SQL_NOW_MS, sqlNow } from '../sql-clock.ts';
import { authority, params, requireSpace, interactive, recentSql, accessExpiry } from './authority.ts';
import { batch, canonical, decodeCursor, digest, encodeCursor, fail, id, integer, object, one, ReleaseError, rows, stmt, str, tokenHash } from './util.ts';
export const columns = `r.id,r.space_id AS spaceId,r.body,r.source,r.revision,r.created_at AS createdAt,r.updated_at AS updatedAt,r.deleted_at AS deletedAt,r.event_time AS eventTime,r.kind,r.provenance,r.supersedes_id AS supersedesMemoryId,r.erased_at AS erasedAt`;
export function memoryRow(row: Omit<Memory, 'provenance'> & {
    provenance: string;
}): Memory { return { ...row, provenance: JSON.parse(row.provenance) as Provenance }; }
export type WriteReceipt = {
    id: string;
    spaceId: string;
    revision: number;
    committedRevision: number | null;
    replayed: boolean;
    representation: 'receipt';
};
export type WriteResult = (Memory & {
    replayed?: boolean;
    committedRevision?: number | null;
}) | WriteReceipt;
export type CreateInput = {
    body: string;
    source?: string | null;
    kind?: string;
    provenance?: Provenance;
    eventTime?: number | null;
    supersedesMemoryId?: string | null;
};
function content(input: CreateInput): Required<CreateInput> {
    object(input);
    str(input.body, 16384);
    const source = input.source === undefined || input.source === null ? null : str(input.source, 2048, true);
    const kind = input.kind ?? 'fact';
    if (!['fact', 'event', 'instruction', 'task'].includes(kind))
        fail(400, 'invalid_memory_kind');
    const p = object(input.provenance ?? { originKind: 'user' });
    if (Object.keys(p).some(k => !['originKind', 'sourceEventId', 'sourceMessageIds', 'extractorVersion'].includes(k)))
        fail(400, 'invalid_provenance');
    if (!['user', 'agent', 'import'].includes(p.originKind as string))
        fail(400, 'invalid_provenance');
    if (p.sourceEventId !== undefined)
        id(p.sourceEventId);
    if (p.extractorVersion !== undefined)
        str(p.extractorVersion, 128);
    if (p.sourceMessageIds !== undefined) {
        if (!Array.isArray(p.sourceMessageIds) || p.sourceMessageIds.length > 100)
            fail(400, 'invalid_provenance');
        (p.sourceMessageIds as unknown[]).forEach(id);
    }
    if (new TextEncoder().encode(canonical(p)).length > 4096)
        fail(400, 'provenance_too_large');
    return { body: input.body, source, kind, provenance: p as unknown as Provenance, eventTime: input.eventTime == null ? null : integer(input.eventTime), supersedesMemoryId: input.supersedesMemoryId == null ? null : id(input.supersedesMemoryId) };
}
export function erasureStatements(db: Database, memoryId: string, at: number, actorId: string, condition = '1', values: Value[] = []): Statement[] {
    return [
        stmt(db, `INSERT INTO release_erasure_permits SELECT r.id,?,${sqlNow()} FROM memories r WHERE r.id=? AND r.deleted_at IS NOT NULL AND r.erased_at IS NULL AND (${condition})`, [actorId, at, memoryId, ...values]),
        stmt(db, `DELETE FROM memory_versions WHERE memory_id=? AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)`, [memoryId, memoryId]),
        stmt(db, `UPDATE memories SET body='[erased]',source=NULL,provenance='{}',event_time=NULL,erased_at=${sqlNow()},updated_at=MAX(updated_at,${sqlNow()}),deleted_at=MAX(updated_at,${sqlNow()}),revision=revision+1,actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)`, [at, at, at, actorId, memoryId, memoryId]),
        stmt(db, `INSERT INTO release_erasure_ledger(memory_id,space_id,erased_at) SELECT id,space_id,erased_at FROM memories WHERE id=? AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)`, [memoryId, memoryId]),
        stmt(db, `INSERT INTO release_events(action,actor_credential_id,resource_id,created_at) SELECT 'memory_erased',actor_credential_id,memory_id,${sqlNow()} FROM release_erasure_permits WHERE memory_id=?`, [at, memoryId]),
        stmt(db, `DELETE FROM release_erasure_permits WHERE memory_id=?`, [memoryId])
    ];
}
export class MemoryStore {
    db: Database;
    clock: () => number;
    constructor(db: Database, clock: () => number = Date.now) { this.db = db; this.clock = clock; }
    async confirmRead(hash: string, spaceId: string, targets: Pick<Memory, 'id' | 'revision'>[], input: { deleted?: boolean; currentFact?: boolean } = {}): Promise<Map<string, { restoreUntil: number | null; restoreExpired: boolean }>> {
        const at = this.clock();
        // Buffered plaintext is returned only if its exact revision is still
        // eligible in the same final snapshot as the caller's current grant.
        // JSON targets bound the indexed work; an empty page still checks ACLs.
        const current = await one<{ expiresAt: number; checkedAt: number; memoryIds: string }>(this.db, `/* rest-memory-disclosure */
            WITH authorized AS MATERIALIZED (
                SELECT s.id AS spaceId,min(c.expires_at,c.membership_expires_at,${accessExpiry('read')}) AS expiresAt,
                    coalesce((SELECT retention_days FROM release_space_policies WHERE space_id=s.id),30) AS retentionDays
                FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('read')}
            ), allowed AS MATERIALIZED (
                SELECT r.id,r.deleted_at+a.retentionDays*86400000 AS restoreUntil FROM json_each(?) target JOIN memories r ON r.id=json_extract(target.value,'$.id')
                    AND r.revision=json_extract(target.value,'$.revision') CROSS JOIN authorized a
                WHERE r.space_id=a.spaceId AND r.erased_at IS NULL
                    ${input.deleted === undefined ? '' : `AND r.deleted_at IS ${input.deleted ? 'NOT ' : ''}NULL`}
                    ${input.currentFact ? 'AND NOT EXISTS(SELECT 1 FROM memories successor WHERE successor.supersedes_id=r.id)' : ''}
            ) SELECT expiresAt,${SQL_NOW_MS} AS checkedAt,(SELECT json_group_array(json_object('id',id,'restoreUntil',restoreUntil)) FROM allowed) AS memoryIds FROM authorized`,
            [spaceId, ...params(hash, at, 'read'), canonical(targets.map(({ id, revision }) => ({ id, revision })))]);
        const returnedAt = Math.max(this.clock(), current?.checkedAt ?? 0);
        if (!current || current.expiresAt <= returnedAt)
            fail(403, 'access_denied');
        return new Map((JSON.parse(current.memoryIds) as { id: string; restoreUntil: number | null }[])
            .map(row => [row.id, { restoreUntil: row.restoreUntil, restoreExpired: row.restoreUntil !== null && row.restoreUntil <= returnedAt }]));
    }
    async get(token: string, spaceId: string, memoryId: string, includeDeleted = false): Promise<Memory> {
        const hash = await tokenHash(token), at = this.clock();
        const row = await one<Omit<Memory, 'provenance'> & {
            provenance: string;
        }>(this.db, `SELECT ${columns} FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c WHERE s.id=? AND r.id=? AND r.erased_at IS NULL ${includeDeleted ? '' : 'AND r.deleted_at IS NULL'} AND ${authority('read')}`, [id(spaceId), id(memoryId), ...params(hash, at, 'read')]);
        if (!row) {
            await requireSpace(this.db, token, spaceId, 'read', this.clock);
            return fail(404, 'memory_not_found');
        }
        const allowed = await this.confirmRead(hash, spaceId, [row], { deleted: includeDeleted ? undefined : false });
        if (!allowed.has(row.id))
            fail(404, 'memory_not_found');
        return { ...memoryRow(row), ...(row.deletedAt !== null ? allowed.get(row.id)! : {}) };
    }
    async commit(token: string, spaceId: string, action: string, cap: Capability, key: string, input: unknown, memoryId: string | null, expectedRevision: number | null, units: number, build: (op: string, actorId: string, at: number) => Statement[], recent = false, additionalCap?: Capability): Promise<{
        id: string;
        replayed: boolean;
        revision: number | null;
    }> {
        id(spaceId);
        str(key, 128);
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
            fail(400, 'invalid_operation_id');
        const hash = await tokenHash(token), actor = await requireSpace(this.db, token, spaceId, cap, this.clock);
        if (additionalCap)
            await requireSpace(this.db, token, spaceId, additionalCap, this.clock);
        if (recent)
            await interactive(this.db, token, this.clock, true);
        const requestHash = await digest(canonical({ action, input, memoryId, expectedRevision }));
        const lookup = () => one<{
            id: string;
            requestHash: string;
            memoryId: string | null;
            revision: number | null;
        }>(this.db, `SELECT id,request_hash AS requestHash,memory_id AS memoryId,committed_revision AS revision FROM release_operations WHERE account_id=? AND space_id=? AND client_key=?`, [actor.accountId, spaceId, key]);
        let existing = await lookup();
        if (!existing) {
            // Hashing, authority reads and receipt lookup can cross an expiry.
            // SQL evaluates admission time after any queue delay. Derive the
            // operation timestamp and quota month in that same statement.
            const op = crypto.randomUUID(), at = this.clock();
            const start = stmt(this.db, `INSERT INTO release_operations(id,account_id,space_id,client_key,request_hash,action,memory_id,expected_revision,committed_revision,actor_credential_id,created_at,period,units)
    SELECT ?,c.account_id,s.id,?,?,?,?,?,?,c.id,${sqlNow()},strftime('%Y-%m',${sqlNow()}/1000,'unixepoch'),? FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority(cap)} ${additionalCap ? 'AND ' + authority(additionalCap) : ''} ${recent ? 'AND ' + recentSql() : ''}`, [op, key, requestHash, action, memoryId, expectedRevision, expectedRevision === null ? 1 : expectedRevision + 1, at, at, units, spaceId, ...params(hash, at, cap), ...(additionalCap ? params(hash, at, additionalCap) : []), ...(recent ? [at - 300000, at] : [])]);
            try {
                await batch(this.db, [start, ...build(op, actor.id, at)]);
            }
            catch (error) {
                // Only a successfully committed matching operation can convert an error to
                // a replay. Quota/database errors without that record are never swallowed.
                existing = await lookup();
                if (!existing) {
                    // The unique successor constraint arbitrates concurrent replacements.
                    // Surface that expected conflict without changing replay handling.
                    if (action === 'create' && error instanceof Error && error.message.includes('UNIQUE constraint failed: memories.supersedes_id'))
                        fail(409, 'revision_conflict');
                    if (action === 'restore' && error instanceof ReleaseError && error.code === 'revision_conflict') {
                        // The trigger remains the atomic admission check. Only a
                        // recognized denial for this unchanged tombstone can be
                        // explained as expired retention; never retry the write.
                        const checkedAt = this.clock();
                        const current = await one<{ expiresAt: number; checkedAt: number; restoreUntil: number | null }>(this.db, `/* restore-denial */
                            WITH authorized AS MATERIALIZED (
                                SELECT s.id AS spaceId,min(c.expires_at,c.membership_expires_at,${accessExpiry('update')}) AS expiresAt,
                                    coalesce((SELECT retention_days FROM release_space_policies WHERE space_id=s.id),30) AS retentionDays
                                FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('update')}
                            ) SELECT expiresAt,${SQL_NOW_MS} AS checkedAt,(SELECT r.deleted_at+a.retentionDays*86400000 FROM memories r
                                WHERE r.id=? AND r.space_id=a.spaceId AND r.revision=? AND r.deleted_at IS NOT NULL AND r.erased_at IS NULL
                            ) AS restoreUntil FROM authorized a`, [spaceId, ...params(hash, checkedAt, 'update'), memoryId, expectedRevision]);
                        const returnedAt = Math.max(this.clock(), current?.checkedAt ?? 0);
                        if (!current || current.expiresAt <= returnedAt)
                            fail(403, 'access_denied');
                        if (current.restoreUntil !== null && current.restoreUntil <= returnedAt)
                            fail(409, 'restore_expired');
                    }
                    throw error;
                }
            }
            if (!existing) {
                existing = await lookup();
                if (!existing)
                    fail(403, 'access_denied');
                await requireSpace(this.db, token, spaceId, cap, this.clock);
                if (additionalCap)
                    await requireSpace(this.db, token, spaceId, additionalCap, this.clock);
                if (recent)
                    await interactive(this.db, token, this.clock, true);
                return { id: existing.memoryId ?? existing.id, revision: existing.revision, replayed: false };
            }
        }
        await requireSpace(this.db, token, spaceId, cap, this.clock);
        if (additionalCap)
            await requireSpace(this.db, token, spaceId, additionalCap, this.clock);
        if (recent)
            await interactive(this.db, token, this.clock, true);
        if (existing.requestHash !== requestHash)
            fail(409, 'idempotency_conflict');
        return { id: existing.memoryId ?? existing.id, revision: existing.revision, replayed: true };
    }
    async create(token: string, spaceId: string, input: CreateInput, key: string): Promise<WriteResult> {
        const value = content(input), memoryId = crypto.randomUUID();
        // Generated IDs must not participate in the idempotency request digest.
        const result = await this.commit(token, spaceId, 'create', 'create', key, value, null, null, 1, (op, actor, at) => [
            stmt(this.db, `UPDATE release_operations SET memory_id=? WHERE id=?`, [memoryId, op]),
            stmt(this.db, `INSERT INTO memories(id,space_id,body,source,revision,created_at,updated_at,actor_credential_id,kind,provenance,event_time,supersedes_id)
    SELECT ?,space_id,?,?,1,created_at,created_at,actor_credential_id,?,?,?,? FROM release_operations WHERE id=?`, [memoryId, value.body, value.source, value.kind, canonical(value.provenance), value.eventTime, value.supersedesMemoryId, op])
        ], false, value.supersedesMemoryId ? 'update' : undefined);
        // Supersession hides the old fact, so it requires both create and update.
        // Return a receipt when read is unavailable or the committed content was
        // subsequently deleted/erased; never turn that into a failed write.
        try {
            return { ...await this.get(token, spaceId, result.id), replayed: result.replayed, committedRevision: result.revision };
        }
        catch (e) {
            if (e && typeof e === 'object' && 'status' in e && (e.status === 403 || e.status === 404)) {
                await requireSpace(this.db, token, spaceId, 'create', this.clock);
                if (value.supersedesMemoryId)
                    await requireSpace(this.db, token, spaceId, 'update', this.clock);
                return { id: result.id, spaceId, revision: result.revision ?? 1, replayed: result.replayed, committedRevision: result.revision, representation: 'receipt' };
            }
            throw e;
        }
    }
    async update(token: string, spaceId: string, memoryId: string, input: {
        body: string;
        source?: string | null;
        expectedRevision: number;
    }, key: string): Promise<WriteResult> {
        id(memoryId);
        str(input.body, 16384);
        integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1);
        const source = input.source === undefined ? undefined : input.source === null ? null : str(input.source, 2048, true);
        const result = await this.commit(token, spaceId, 'update', 'update', key, { body: input.body, source: source ?? null, hasSource: source !== undefined }, memoryId, input.expectedRevision, 1, (op, actor, at) => [
            stmt(this.db, `UPDATE memories SET body=?,source=CASE WHEN ? THEN ? ELSE source END,revision=revision+1,updated_at=MAX(updated_at,(SELECT created_at FROM release_operations WHERE id=?)),actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_operations WHERE id=?)`, [input.body, source === undefined ? 0 : 1, source ?? null, op, actor, memoryId, op])
        ]);
        try {
            return { ...await this.get(token, spaceId, memoryId), committedRevision: result.revision, replayed: result.replayed };
        }
        catch (e) {
            if (e && typeof e === 'object' && 'status' in e && (e.status === 403 || e.status === 404)) {
                await requireSpace(this.db, token, spaceId, 'update', this.clock);
                return { id: memoryId, spaceId, revision: result.revision!, committedRevision: result.revision, replayed: result.replayed, representation: 'receipt' };
            }
            throw e;
        }
    }
    async remove(token: string, spaceId: string, memoryId: string, expectedRevision: number, key: string): Promise<void> {
        id(memoryId);
        integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1);
        await this.commit(token, spaceId, 'delete', 'delete', key, {}, memoryId, expectedRevision, 0, (op, actor, at) => [
            stmt(this.db, `UPDATE memories SET deleted_at=MAX(updated_at,(SELECT created_at FROM release_operations WHERE id=?)),updated_at=MAX(updated_at,(SELECT created_at FROM release_operations WHERE id=?)),revision=revision+1,actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_operations WHERE id=?)`, [op, op, actor, memoryId, op])
        ]);
    }
    async restore(token: string, spaceId: string, memoryId: string, expectedRevision: number, key: string): Promise<WriteResult> {
        id(memoryId);
        integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1);
        const result = await this.commit(token, spaceId, 'restore', 'update', key, {}, memoryId, expectedRevision, 1, (op, actor, at) => [
            stmt(this.db, `UPDATE memories SET deleted_at=NULL,updated_at=MAX(updated_at,(SELECT created_at FROM release_operations WHERE id=?)),revision=revision+1,actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_operations WHERE id=?)`, [op, actor, memoryId, op])
        ]);
        try {
            return { ...await this.get(token, spaceId, memoryId), committedRevision: result.revision, replayed: result.replayed };
        }
        catch (e) {
            if (e && typeof e === 'object' && 'status' in e && (e.status === 403 || e.status === 404)) {
                await requireSpace(this.db, token, spaceId, 'update', this.clock);
                return { id: memoryId, spaceId, revision: result.revision!, committedRevision: result.revision, replayed: result.replayed, representation: 'receipt' };
            }
            throw e;
        }
    }
    async erase(token: string, spaceId: string, memoryId: string, expectedRevision: number, confirmation: string, key: string): Promise<{
        id: string;
        status: string;
    }> {
        id(memoryId);
        integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1);
        if (confirmation !== memoryId)
            fail(400, 'confirmation_required');
        await this.commit(token, spaceId, 'erase', 'delete', key, { confirmation }, memoryId, expectedRevision, 0, (op, actor, at) => erasureStatements(this.db, memoryId, at, actor, 'EXISTS(SELECT 1 FROM release_operations WHERE id=?)', [op]), true);
        return { id: memoryId, status: 'source_erased_index_cleanup_pending' };
    }
    async spaces(token: string, input: {
        limit?: number;
        cursor?: string | null;
    } = {}): Promise<{
        results: Record<string, unknown>[];
        nextCursor: string | null;
    }> {
        const limit = integer(input.limit ?? 50, 1, 100), hash = await tokenHash(token), at = this.clock();
        let time = 0, after = '';
        if (input.cursor) {
            const a = decodeCursor(input.cursor, 'spaces');
            if (a.length !== 2)
                fail(400, 'invalid_cursor');
            time = integer(a[0]);
            after = id(a[1]);
        }
        // Return an empty array for authenticated users with no readable spaces.
        const caller = await one<{ id: string; kind: string; spaceIds: string | null }>(this.db,
            `SELECT c.id,c.kind,p.space_ids AS spaceIds FROM active_credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id
                WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND c.membership_expires_at>${sqlNow()}`, [hash, at, at]);
        if (!caller)
            fail(401, 'authentication_required');
        const scoped = caller.spaceIds !== null && !(caller.kind === 'session' && !caller.id.startsWith('oauth:'));
        const pageAfter = (alias: string) => `${alias}.created_at>=? AND (${alias}.created_at>? OR (${alias}.created_at=? AND ${alias}.id>?))`;
        const bounds = [time, time, time, after, limit + 1];
        const metadata = 'SELECT s.id,s.name,s.organization_id AS organizationId,s.security_mode AS securityMode,s.created_at AS createdAt';
        // Bound raw targets before permission filtering, then advance from the
        // target page even when every grant expired. Explicit PAT scopes avoid
        // enumerating the caller's other Spaces. Organization/share branches
        // may sort the caller's own grants, never unrelated tenants' Spaces.
        const candidateSql = scoped ? `${metadata} FROM json_each(?) selected JOIN spaces s ON s.id=selected.value
                WHERE ${pageAfter('s')} ORDER BY s.created_at,s.id LIMIT ?`
            : `${metadata} FROM (
                SELECT * FROM (SELECT owned.id,owned.created_at AS createdAt FROM active_credentials actor JOIN spaces owned ON owned.account_id=actor.account_id
                    WHERE actor.token_digest=? AND actor.kind IN ('session','personal_key') AND ${pageAfter('owned')}
                    ORDER BY owned.created_at,owned.id LIMIT ?)
                UNION SELECT * FROM (SELECT managed.id,managed.created_at AS createdAt FROM active_credentials actor JOIN active_memberships member ON member.account_id=actor.account_id
                    JOIN spaces managed ON managed.organization_id=member.organization_id
                    WHERE actor.token_digest=?
                        AND ((actor.kind='session' AND actor.membership_id IS NULL) OR (actor.kind='api_key' AND actor.membership_id=member.id))
                        AND ${pageAfter('managed')} ORDER BY managed.created_at,managed.id LIMIT ?)
                UNION SELECT * FROM (SELECT DISTINCT shared.id,shared.created_at AS createdAt FROM active_credentials actor JOIN account_emails recipient ON recipient.account_id=actor.account_id
                    JOIN release_shares sh ON sh.recipient_email_id=recipient.id JOIN spaces shared ON shared.id=sh.space_id
                    WHERE actor.token_digest=? AND actor.kind IN ('session','personal_key') AND recipient.revoked_at IS NULL
                        AND sh.accepted_at IS NOT NULL AND sh.revoked_at IS NULL AND ${pageAfter('shared')}
                    ORDER BY shared.created_at,shared.id LIMIT ?)
            ) candidate JOIN spaces s ON s.id=candidate.id ORDER BY candidate.createdAt,candidate.id LIMIT ?`;
        const all = await rows<{
            id: string;
            createdAt: number;
        } & Record<string, unknown>>(this.db, candidateSql, scoped ? [caller.spaceIds, ...bounds]
            : [hash, ...bounds, hash, ...bounds, hash, ...bounds, limit + 1]);
        const page = all.slice(0, limit), last = page.at(-1), fresh = this.clock();
        // A single current snapshot validates both the credential and every
        // returned Space. JSON keeps a full page below the SQL bind limit.
        const current = await one<{ spaceIds: string; expiresAt: number }>(this.db, `SELECT (
            SELECT json_group_array(json_object('id',s.id,'expiresAt',${accessExpiry('read')})) FROM spaces s WHERE s.id IN (SELECT value FROM json_each(?)) AND ${authority('read')}
          ) AS spaceIds,min(c.expires_at,c.membership_expires_at) AS expiresAt FROM active_credentials c WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND c.membership_expires_at>${sqlNow()}`,
            [canonical(page.map(row => row.id)), ...params(hash, fresh, 'read'), hash, fresh, fresh]);
        const returnedAt = this.clock();
        if (!current || current.expiresAt <= returnedAt)
            fail(401, 'authentication_required');
        const allowed = new Set((JSON.parse(current.spaceIds) as { id: string; expiresAt: number }[]).filter(row => row.expiresAt > returnedAt).map(row => row.id)), results = page.filter(row => allowed.has(row.id));
        return { results, nextCursor: all.length > limit && last ? encodeCursor('spaces', [last.createdAt, last.id]) : null };
    }
    async list(token: string, spaceId: string, input: {
        limit?: number;
        cursor?: string | null;
        deleted?: boolean;
    } = {}): Promise<{
        results: Memory[];
        nextCursor: string | null;
    }> {
        id(spaceId);
        const limit = integer(input.limit ?? 25, 1, 100), at = this.clock(), hash = await tokenHash(token);
        let before = Number.MAX_SAFE_INTEGER, after = '';
        const resource = spaceId + ':' + Boolean(input.deleted);
        if (input.cursor) {
            const a = decodeCursor(input.cursor, resource);
            if (a.length !== 2)
                fail(400, 'invalid_cursor');
            before = integer(a[0]);
            after = id(a[1]);
        }
        await requireSpace(this.db, token, spaceId, 'read', this.clock);
        const all = await rows<Omit<Memory, 'provenance'> & {
            provenance: string;
        }>(this.db, `SELECT ${columns} FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c WHERE s.id=? AND r.erased_at IS NULL AND r.deleted_at IS ${input.deleted ? 'NOT ' : ''}NULL
   ${input.deleted ? '' : 'AND NOT EXISTS(SELECT 1 FROM memories successor WHERE successor.supersedes_id=r.id)'}
   AND r.created_at<=? AND (r.created_at<? OR (r.created_at=? AND r.id>?)) AND ${authority('read')} ORDER BY r.created_at DESC,r.id LIMIT ?`, [spaceId, before, before, before, after, ...params(hash, at, 'read'), limit + 1]);
        const page = all.slice(0, limit), last = page.at(-1);
        const allowed = await this.confirmRead(hash, spaceId, page, { deleted: Boolean(input.deleted), currentFact: !input.deleted });
        const results = page.filter(row => allowed.has(row.id)).map(row => ({ ...memoryRow(row), ...(input.deleted ? allowed.get(row.id)! : {}) }));
        return { results, nextCursor: all.length > limit && last ? encodeCursor(resource, [last.createdAt, last.id]) : null };
    }
    async retention(token: string, spaceId: string, days: number): Promise<void> {
        integer(days, 1, 3650);
        const hash = await tokenHash(token);
        await interactive(this.db, token, this.clock, true);
        const at = this.clock();
        const result = await this.db.prepare(`INSERT INTO release_space_policies(space_id,retention_days) SELECT s.id,? FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('delete')} AND ${recentSql()} ON CONFLICT(space_id) DO UPDATE SET retention_days=excluded.retention_days`).bind(days, id(spaceId), ...params(hash, at, 'delete'), at - 300000, at).run();
        if (!result.success || !result.meta.changes)
            fail(403, 'access_denied');
    }
}

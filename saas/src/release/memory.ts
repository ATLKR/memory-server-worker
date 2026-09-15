import type { Capability, Database, Memory, Provenance, Statement, Value } from './types.ts';
import { authority, params, requireSpace, interactive, recentSql } from './authority.ts';
import { batch, canonical, decodeCursor, digest, encodeCursor, fail, id, integer, month, object, one, rows, stmt, str, tokenHash } from './util.ts';
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
        stmt(db, `INSERT INTO release_erasure_permits SELECT r.id,?,? FROM memories r WHERE r.id=? AND r.deleted_at IS NOT NULL AND r.erased_at IS NULL AND (${condition})`, [actorId, at, memoryId, ...values]),
        stmt(db, `DELETE FROM memory_versions WHERE memory_id=? AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)`, [memoryId, memoryId]),
        stmt(db, `UPDATE memories SET body='[erased]',source=NULL,provenance='{}',event_time=NULL,erased_at=?,updated_at=MAX(updated_at,?),deleted_at=MAX(updated_at,?),revision=revision+1,actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)`, [at, at, at, actorId, memoryId, memoryId]),
        stmt(db, `INSERT INTO release_erasure_ledger(memory_id,space_id,erased_at) SELECT id,space_id,? FROM memories WHERE id=? AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)`, [at, memoryId, memoryId]),
        stmt(db, `INSERT INTO release_events(action,actor_credential_id,resource_id,created_at) SELECT 'memory_erased',actor_credential_id,memory_id,? FROM release_erasure_permits WHERE memory_id=?`, [at, memoryId]),
        stmt(db, `DELETE FROM release_erasure_permits WHERE memory_id=?`, [memoryId])
    ];
}
export class MemoryStore {
    db: Database;
    clock: () => number;
    constructor(db: Database, clock: () => number = Date.now) { this.db = db; this.clock = clock; }
    async get(token: string, spaceId: string, memoryId: string, includeDeleted = false): Promise<Memory> {
        const at = this.clock(), hash = await tokenHash(token);
        const row = await one<Omit<Memory, 'provenance'> & {
            provenance: string;
        }>(this.db, `SELECT ${columns} FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c WHERE s.id=? AND r.id=? AND r.erased_at IS NULL ${includeDeleted ? '' : 'AND r.deleted_at IS NULL'} AND ${authority('read')}`, [id(spaceId), id(memoryId), ...params(hash, at, 'read')]);
        if (!row) {
            await requireSpace(this.db, token, spaceId, 'read', this.clock());
            return fail(404, 'memory_not_found');
        }
        return memoryRow(row);
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
        const at = this.clock(), hash = await tokenHash(token), actor = await requireSpace(this.db, token, spaceId, cap, at);
        if (additionalCap)
            await requireSpace(this.db, token, spaceId, additionalCap, at);
        if (recent)
            await interactive(this.db, token, at, true);
        const requestHash = await digest(canonical({ action, input, memoryId, expectedRevision }));
        const lookup = () => one<{
            id: string;
            requestHash: string;
            memoryId: string | null;
            revision: number | null;
        }>(this.db, `SELECT id,request_hash AS requestHash,memory_id AS memoryId,committed_revision AS revision FROM release_operations WHERE account_id=? AND space_id=? AND client_key=?`, [actor.accountId, spaceId, key]);
        let existing = await lookup();
        if (!existing) {
            const op = crypto.randomUUID();
            const start = stmt(this.db, `INSERT INTO release_operations(id,account_id,space_id,client_key,request_hash,action,memory_id,expected_revision,committed_revision,actor_credential_id,created_at,period,units)
    SELECT ?,c.account_id,s.id,?,?,?,?,?,?,c.id,?,?,? FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority(cap)} ${additionalCap ? 'AND ' + authority(additionalCap) : ''} ${recent ? 'AND ' + recentSql() : ''}`, [op, key, requestHash, action, memoryId, expectedRevision, expectedRevision === null ? 1 : expectedRevision + 1, at, month(at), units, spaceId, ...params(hash, at, cap), ...(additionalCap ? params(hash, at, additionalCap) : []), ...(recent ? [at - 300000, at] : [])]);
            try {
                await batch(this.db, [start, ...build(op, actor.id, at)]);
            }
            catch (error) {
                // Only a successfully committed matching operation can convert an error to
                // a replay. Quota/database errors without that record are never swallowed.
                existing = await lookup();
                if (!existing)
                    throw error;
            }
            if (!existing) {
                existing = await lookup();
                if (!existing)
                    fail(403, 'access_denied');
                await requireSpace(this.db, token, spaceId, cap, this.clock());
                if (additionalCap)
                    await requireSpace(this.db, token, spaceId, additionalCap, this.clock());
                return { id: existing.memoryId ?? existing.id, revision: existing.revision, replayed: false };
            }
        }
        await requireSpace(this.db, token, spaceId, cap, this.clock());
        if (additionalCap)
            await requireSpace(this.db, token, spaceId, additionalCap, this.clock());
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
    SELECT ?,space_id,?,?,1,?,?,actor_credential_id,?,?,?,? FROM release_operations WHERE id=?`, [memoryId, value.body, value.source, at, at, value.kind, canonical(value.provenance), value.eventTime, value.supersedesMemoryId, op])
        ], false, value.supersedesMemoryId ? 'update' : undefined);
        // Supersession hides the old fact, so it requires both create and update.
        // Return a receipt when read is unavailable or the committed content was
        // subsequently deleted/erased; never turn that into a failed write.
        try {
            return { ...await this.get(token, spaceId, result.id), replayed: result.replayed, committedRevision: result.revision };
        }
        catch (e) {
            if (e && typeof e === 'object' && 'status' in e && (e.status === 403 || e.status === 404)) {
                await requireSpace(this.db, token, spaceId, 'create', this.clock());
                if (value.supersedesMemoryId)
                    await requireSpace(this.db, token, spaceId, 'update', this.clock());
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
            stmt(this.db, `UPDATE memories SET body=?,source=CASE WHEN ? THEN ? ELSE source END,revision=revision+1,updated_at=MAX(updated_at,?),actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_operations WHERE id=?)`, [input.body, source === undefined ? 0 : 1, source ?? null, at, actor, memoryId, op])
        ]);
        try {
            return { ...await this.get(token, spaceId, memoryId), committedRevision: result.revision, replayed: result.replayed };
        }
        catch (e) {
            if (e && typeof e === 'object' && 'status' in e && (e.status === 403 || e.status === 404)) {
                await requireSpace(this.db, token, spaceId, 'update', this.clock());
                return { id: memoryId, spaceId, revision: result.revision!, committedRevision: result.revision, replayed: result.replayed, representation: 'receipt' };
            }
            throw e;
        }
    }
    async remove(token: string, spaceId: string, memoryId: string, expectedRevision: number, key: string): Promise<void> {
        id(memoryId);
        integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1);
        await this.commit(token, spaceId, 'delete', 'delete', key, {}, memoryId, expectedRevision, 0, (op, actor, at) => [
            stmt(this.db, `UPDATE memories SET deleted_at=MAX(updated_at,?),updated_at=MAX(updated_at,?),revision=revision+1,actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_operations WHERE id=?)`, [at, at, actor, memoryId, op])
        ]);
    }
    async restore(token: string, spaceId: string, memoryId: string, expectedRevision: number, key: string): Promise<WriteResult> {
        id(memoryId);
        integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1);
        const result = await this.commit(token, spaceId, 'restore', 'update', key, {}, memoryId, expectedRevision, 1, (op, actor, at) => [
            stmt(this.db, `UPDATE memories SET deleted_at=NULL,updated_at=MAX(updated_at,?),revision=revision+1,actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_operations WHERE id=?)`, [at, actor, memoryId, op])
        ]);
        try {
            return { ...await this.get(token, spaceId, memoryId), committedRevision: result.revision, replayed: result.replayed };
        }
        catch (e) {
            if (e && typeof e === 'object' && 'status' in e && (e.status === 403 || e.status === 404)) {
                await requireSpace(this.db, token, spaceId, 'update', this.clock());
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
        const limit = integer(input.limit ?? 50, 1, 100), at = this.clock(), hash = await tokenHash(token);
        let time = 0, after = '';
        if (input.cursor) {
            const a = decodeCursor(input.cursor, 'spaces');
            if (a.length !== 2)
                fail(400, 'invalid_cursor');
            time = integer(a[0]);
            after = id(a[1]);
        }
        // Return an empty array for authenticated users with no readable spaces.
        if (!await one(this.db, 'SELECT id FROM active_credentials WHERE token_digest=? AND expires_at>? AND membership_expires_at>?', [hash, at, at]))
            fail(401, 'authentication_required');
        const all = await rows<{
            id: string;
            createdAt: number;
        } & Record<string, unknown>>(this.db, `SELECT s.id,s.name,s.organization_id AS organizationId,s.security_mode AS securityMode,s.created_at AS createdAt FROM spaces s CROSS JOIN active_credentials c WHERE ${authority('read')} AND (s.created_at>? OR (s.created_at=? AND s.id>?)) ORDER BY s.created_at,s.id LIMIT ?`, [...params(hash, at, 'read'), time, time, after, limit + 1]);
        const results = all.slice(0, limit), last = results.at(-1);
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
        await requireSpace(this.db, token, spaceId, 'read', at);
        const all = await rows<Omit<Memory, 'provenance'> & {
            provenance: string;
        }>(this.db, `SELECT ${columns} FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c WHERE s.id=? AND r.erased_at IS NULL AND r.deleted_at IS ${input.deleted ? 'NOT ' : ''}NULL
   ${input.deleted ? '' : 'AND NOT EXISTS(SELECT 1 FROM memories successor WHERE successor.supersedes_id=r.id)'}
   AND (r.created_at<? OR (r.created_at=? AND r.id>?)) AND ${authority('read')} ORDER BY r.created_at DESC,r.id LIMIT ?`, [spaceId, before, before, after, ...params(hash, at, 'read'), limit + 1]);
        const results = all.slice(0, limit).map(memoryRow), last = results.at(-1);
        await requireSpace(this.db, token, spaceId, 'read', this.clock());
        return { results, nextCursor: all.length > limit && last ? encodeCursor(resource, [last.createdAt, last.id]) : null };
    }
    async retention(token: string, spaceId: string, days: number): Promise<void> {
        integer(days, 1, 3650);
        const at = this.clock(), hash = await tokenHash(token);
        await interactive(this.db, token, at, true);
        const result = await this.db.prepare(`INSERT INTO release_space_policies(space_id,retention_days) SELECT s.id,? FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('delete')} AND ${recentSql()} ON CONFLICT(space_id) DO UPDATE SET retention_days=excluded.retention_days`).bind(days, id(spaceId), ...params(hash, at, 'delete'), at - 300000, at).run();
        if (!result.success || !result.meta.changes)
            fail(403, 'access_denied');
    }
}

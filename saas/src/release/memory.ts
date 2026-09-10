import type { Capability, Database, Memory, Provenance, Statement, Value } from './types.ts';
import { SQL_NOW_MS, sqlNow } from '../sql-clock.ts';
import { authority, params, requireSpace, interactive, recentSql, accessExpiry } from './authority.ts';
import { batch, canonical, decodeCursor, digest, encodeCursor, fail, id, integer, object, one, ReleaseError, rows, stmt, str, tokenHash } from './util.ts';
import { preparePayloads, publishPayloadStatements, type PayloadBackend, type PreparedPayloadItem, type PreparedPayloads, type PreparePayloadInput } from './payload-intents.ts';
export type { PreparedPayloadItem, PreparedPayloads, PreparePayloadInput } from './payload-intents.ts';
export const columns = `r.id,r.space_id AS spaceId,r.body,r.source,r.revision,r.created_at AS createdAt,r.updated_at AS updatedAt,r.deleted_at AS deletedAt,r.event_time AS eventTime,r.kind,r.provenance,r.supersedes_id AS supersedesMemoryId,r.erased_at AS erasedAt,
    r.payload_id AS payloadId,r.payload_shard_id AS payloadShardId,r.payload_object_key AS payloadObjectKey,r.payload_sha256 AS payloadSha256,r.payload_bytes AS payloadBytes,r.logical_bytes AS logicalBytes`;
export type MemoryRow = Omit<Memory, 'provenance'> & { provenance: string; payloadId?: string | null; payloadShardId?: string | null;
    payloadObjectKey?: string | null; payloadSha256?: string | null; payloadBytes?: number | null; logicalBytes?: number | null };
export function memoryRow(row: MemoryRow): Memory {
    return { id: row.id, spaceId: row.spaceId, body: row.body, source: row.source, revision: row.revision,
        createdAt: row.createdAt, updatedAt: row.updatedAt, deletedAt: row.deletedAt, eventTime: row.eventTime,
        kind: row.kind, provenance: JSON.parse(row.provenance) as Provenance, supersedesMemoryId: row.supersedesMemoryId, erasedAt: row.erasedAt,
        ...(row.restoreUntil === undefined ? {} : { restoreUntil: row.restoreUntil }), ...(row.restoreExpired === undefined ? {} : { restoreExpired: row.restoreExpired }) };
}
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
        stmt(db, `INSERT INTO release_payload_purges(payload_id,space_id,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,created_at)
          SELECT p.id,i.space_id,p.memory_id,p.payload_shard_id,p.payload_object_key,p.payload_sha256,p.payload_bytes,${sqlNow()}
          FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id
            JOIN memories target ON target.id=p.memory_id AND target.space_id=i.space_id WHERE p.memory_id=?
            AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)
            AND NOT EXISTS(SELECT 1 FROM release_payload_purges old WHERE old.payload_id=p.id)`, [at, memoryId, memoryId]),
        stmt(db, `DELETE FROM memory_versions WHERE memory_id=? AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)`, [memoryId, memoryId]),
        stmt(db, `UPDATE memories SET body='[erased]',source=NULL,provenance='{}',event_time=NULL,payload_id=NULL,payload_shard_id=NULL,payload_object_key=NULL,payload_sha256=NULL,payload_bytes=NULL,logical_bytes=NULL,erased_at=${sqlNow()},updated_at=MAX(updated_at,${sqlNow()}),deleted_at=MAX(updated_at,${sqlNow()}),revision=revision+1,actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)`, [at, at, at, actorId, memoryId, memoryId]),
        stmt(db, `INSERT INTO release_erasure_ledger(memory_id,space_id,erased_at) SELECT id,space_id,erased_at FROM memories WHERE id=? AND EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=?)`, [memoryId, memoryId]),
        stmt(db, `INSERT INTO release_events(action,actor_credential_id,resource_id,created_at) SELECT 'memory_erased',actor_credential_id,memory_id,${sqlNow()} FROM release_erasure_permits WHERE memory_id=?`, [at, memoryId]),
        stmt(db, `DELETE FROM release_erasure_permits WHERE memory_id=?`, [memoryId])
    ];
}
export class MemoryStore {
    db: Database;
    clock: () => number;
    payloads?: PayloadBackend;
    constructor(db: Database, clock: () => number = Date.now, payloads?: PayloadBackend) { this.db = db; this.clock = clock; this.payloads = payloads; }
    async preparePayloads(token: string, spaceId: string, input: PreparePayloadInput): Promise<PreparedPayloads> {
        if (!this.payloads?.enabled) fail(503, 'payload_storage_unavailable');
        return preparePayloads(this.db, this.clock, this.payloads, token, spaceId, input);
    }
    preparedCreate(operationId: string, item: PreparedPayloadItem, input: CreateInput): Statement {
        const value = content(input), ref = item.ref;
        return stmt(this.db, `INSERT INTO memories(id,space_id,body,source,revision,created_at,updated_at,actor_credential_id,kind,provenance,event_time,supersedes_id,payload_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,logical_bytes)
          SELECT ?,space_id,'[external]',NULL,1,created_at,created_at,actor_credential_id,?,'{}',?,?,?,?,?,?,?,? FROM release_operations WHERE id=?`,
            [item.memoryId, value.kind, value.eventTime, value.supersedesMemoryId, ref.id, ref.shardId, ref.objectKey, ref.sha256, ref.bytes, item.logicalBytes, operationId]);
    }
    async hydrateRows<T extends MemoryRow>(values: T[], input: { omitErased?: boolean } = {}): Promise<T[]> {
        const hydrated: T[] = [];
        for (let offset = 0; offset < values.length; offset += 4) {
            const part = await Promise.all(values.slice(offset, offset + 4).map(async row => {
                if (!row.payloadId) return row;
                if (!this.payloads?.enabled || !row.payloadShardId || !row.payloadObjectKey || !row.payloadSha256 || !row.payloadBytes)
                    fail(503, 'payload_storage_unavailable');
                let value;
                try {
                    value = await this.payloads.read({ spaceId: row.spaceId, memoryId: row.id }, {
                        id: row.payloadId, shardId: row.payloadShardId, objectKey: row.payloadObjectKey, sha256: row.payloadSha256, bytes: row.payloadBytes });
                } catch (error) {
                    // Permanent erasure can finish between the bounded central
                    // page read and external hydration. Omit only that exact,
                    // centrally confirmed erasure; corruption or an unexplained
                    // provider tombstone must still fail. Callers retain their
                    // raw cursor and perform their normal final authority check.
                    if (input.omitErased && error instanceof ReleaseError && error.code === 'payload_purged'
                        && await one(this.db, `/* payload-erasure-race */ SELECT id FROM memories WHERE id=? AND space_id=? AND erased_at IS NOT NULL`, [row.id, row.spaceId]))
                        return null;
                    throw error;
                }
                const encoded = canonical(value);
                if (await digest(encoded) !== row.payloadSha256 || new TextEncoder().encode(encoded).length !== row.payloadBytes)
                    fail(503, 'payload_integrity_failed');
                return { ...row, body: value.body, source: value.source, provenance: canonical(value.provenance) };
            }));
            for (const row of part) if (row !== null) hydrated.push(row);
        }
        return hydrated;
    }
    /** Trusted operator maintenance only; no HTTP route. Storage conversion is
     * independent of the original author's current membership or session. */
    async archiveOne(memoryId: string, revision: number, target: 'current' | 'history' = 'current'): Promise<boolean> {
        id(memoryId); integer(revision, 1);
        if (!['current', 'history'].includes(target)) fail(400, 'invalid_archive_target');
        if (!this.payloads?.enabled) fail(503, 'payload_storage_unavailable');
        const table = target === 'current' ? 'memories' : 'memory_versions', key = target === 'current' ? 'id' : 'memory_id';
        const sourceColumns = target === 'current' ? columns : columns.replace('r.id,', 'r.memory_id AS id,').replace('r.erased_at AS erasedAt', 'NULL AS erasedAt');
        const source = await one<MemoryRow & { accountId: string }>(this.db, `SELECT ${sourceColumns},author.account_id AS accountId
          FROM ${table} r JOIN credentials author ON author.id=r.actor_credential_id
          WHERE r.${key}=? AND r.revision=? AND r.payload_id IS NULL
            AND EXISTS(SELECT 1 FROM memories head WHERE head.id=r.${key} AND head.erased_at IS NULL)`, [memoryId, revision]);
        if (!source) return false;
        const value = { body: source.body, source: source.source, provenance: JSON.parse(source.provenance) as Provenance };
        const bytes = new TextEncoder().encode(source.body).length + new TextEncoder().encode(source.source ?? '').length + new TextEncoder().encode(source.provenance).length;
        const requestHash = await digest(canonical({ target, memoryId, revision, body: source.body, source: source.source, provenance: source.provenance }));
        // The slash namespace cannot collide with a public operation key. A
        // daily attempt bounds recovery from terminal, collected preparations.
        const archiveKey = '/archive/' + target + '/' + memoryId + '/' + revision + '/' + Math.floor(this.clock() / 86400000);
        const find = () => one<{ id: string; requestHash: string; expiresAt: number }>(this.db,
            'SELECT id,request_hash AS requestHash,expires_at AS expiresAt FROM release_payload_intents WHERE account_id=? AND space_id=? AND client_key=?', [source.accountId, source.spaceId, archiveKey]);
        let intent = await find();
        if (!intent) {
            const intentId = crypto.randomUUID(), ref = await this.payloads.descriptor({ spaceId: source.spaceId, memoryId }, value, crypto.randomUUID()), at = this.clock();
            await batch(this.db, [
                stmt(this.db, `INSERT INTO release_payload_intents(id,account_id,space_id,client_key,request_hash,action,memory_id,expected_revision,item_count,reserved_bytes,created_at,expires_at)
                  SELECT ?,?,r.space_id,?,?,'archive',r.${key},r.revision,1,?,${sqlNow()},${sqlNow()}+86400000 FROM ${table} r
                  WHERE r.${key}=? AND r.revision=? AND r.payload_id IS NULL AND r.body=? AND r.source IS ? AND r.provenance=?
                    AND EXISTS(SELECT 1 FROM memories head WHERE head.id=r.${key} AND head.erased_at IS NULL)
                    AND NOT EXISTS(SELECT 1 FROM release_payload_intents old WHERE old.account_id=? AND old.space_id=r.space_id AND old.client_key=?)`,
                    [intentId, source.accountId, archiveKey, requestHash, ref.bytes, at, at, memoryId, revision, source.body, source.source, source.provenance, source.accountId, archiveKey]),
                stmt(this.db, `INSERT INTO release_payload_stages(id,intent_id,ordinal,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,logical_bytes,created_at)
                  SELECT ?,id,0,?,?,?,?,?,?,created_at FROM release_payload_intents WHERE id=?`,
                    [ref.id, memoryId, ref.shardId, ref.objectKey, ref.sha256, ref.bytes, bytes, intentId])
            ]);
            intent = await find();
        }
        if (!intent || intent.requestHash !== requestHash || intent.expiresAt <= this.clock()) return false;
        const stage = await one<{ id: string; shardId: string; objectKey: string; sha256: string; bytes: number; state: string }>(this.db,
            'SELECT id,payload_shard_id AS shardId,payload_object_key AS objectKey,payload_sha256 AS sha256,payload_bytes AS bytes,state FROM release_payload_stages WHERE intent_id=? AND ordinal=0', [intent.id]);
        if (!stage || !['staging', 'ready'].includes(stage.state)) return false;
        const ref = { id: stage.id, shardId: stage.shardId, objectKey: stage.objectKey, sha256: stage.sha256, bytes: stage.bytes };
        if (stage.state === 'staging') {
            await this.payloads.stage({ spaceId: source.spaceId, memoryId }, ref, value);
            await this.db.prepare(`UPDATE release_payload_stages SET state='ready' WHERE id=? AND state='staging'
              AND EXISTS(SELECT 1 FROM release_payload_intents WHERE id=release_payload_stages.intent_id AND expires_at>${sqlNow()})`).bind(ref.id, this.clock()).run();
        }
        const at = this.clock();
        await batch(this.db, [
            stmt(this.db, `INSERT INTO release_payload_archive_permits(payload_id,memory_id,revision,target,created_at)
              SELECT ?,r.${key},r.revision,?,${sqlNow()} FROM ${table} r
              WHERE r.${key}=? AND r.revision=? AND r.payload_id IS NULL AND r.body=? AND r.source IS ? AND r.provenance=?
                AND EXISTS(SELECT 1 FROM memories head WHERE head.id=r.${key} AND head.erased_at IS NULL)
                AND EXISTS(SELECT 1 FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id WHERE p.id=? AND p.state='ready' AND i.expires_at>${sqlNow()})`,
                [ref.id, target, at, memoryId, revision, source.body, source.source, source.provenance, ref.id, at]),
            stmt(this.db, `UPDATE ${table} SET body='[external]',source=NULL,provenance='{}',payload_id=?,payload_shard_id=?,payload_object_key=?,payload_sha256=?,payload_bytes=?,logical_bytes=?
              WHERE ${key}=? AND revision=? AND EXISTS(SELECT 1 FROM release_payload_archive_permits WHERE payload_id=? AND target=?)`,
                [ref.id, ref.shardId, ref.objectKey, ref.sha256, ref.bytes, bytes, memoryId, revision, ref.id, target]),
            stmt(this.db, `UPDATE release_payload_stages SET state='published' WHERE id=? AND state='ready' AND EXISTS(SELECT 1 FROM release_payload_archives WHERE payload_id=?)`, [ref.id, ref.id]),
            stmt(this.db, `UPDATE release_payload_intents SET published_at=${sqlNow()} WHERE id=? AND published_at IS NULL AND EXISTS(SELECT 1 FROM release_payload_archives WHERE payload_id=?)`, [at, intent.id, ref.id]),
            // A historical conversion has no head transition to enqueue hot
            // retirement. Its immutable R2 copy remains available for export.
            ...(target === 'history' ? [stmt(this.db, `INSERT INTO release_payload_retirements(payload_id,space_id,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,created_at)
              SELECT p.id,i.space_id,p.memory_id,p.payload_shard_id,p.payload_object_key,p.payload_sha256,p.payload_bytes,${sqlNow()}
              FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id
              WHERE p.id=? AND p.state='published' AND EXISTS(SELECT 1 FROM release_payload_archives a WHERE a.payload_id=p.id AND a.target='history')
                AND NOT EXISTS(SELECT 1 FROM release_payload_retirements old WHERE old.payload_id=p.id)`, [at, ref.id])] : []),
            stmt(this.db, 'DELETE FROM release_payload_archive_permits WHERE payload_id=?', [ref.id])
        ]);
        return !!await one(this.db, 'SELECT payload_id FROM release_payload_archives WHERE payload_id=?', [ref.id]);
    }
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
        const [hydrated] = await this.hydrateRows([row], { omitErased: true });
        const allowed = await this.confirmRead(hash, spaceId, [row], { deleted: includeDeleted ? undefined : false });
        if (!allowed.has(row.id))
            fail(404, 'memory_not_found');
        return { ...memoryRow(hydrated!), ...(row.deletedAt !== null ? allowed.get(row.id)! : {}) };
    }
    async commit(token: string, spaceId: string, action: string, cap: Capability, key: string, input: unknown, memoryId: string | null, expectedRevision: number | null, units: number, build: (op: string, actorId: string, at: number) => Statement[], recent = false, additionalCap?: Capability, prepared?: PreparedPayloads): Promise<{
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
        if (prepared && (prepared.accountId !== actor.accountId || prepared.spaceId !== spaceId || prepared.key !== key || prepared.requestHash !== requestHash))
            fail(409, 'idempotency_conflict');
        const lookup = () => one<{
            id: string;
            requestHash: string;
            memoryId: string | null;
            revision: number | null;
        }>(this.db, `SELECT id,request_hash AS requestHash,memory_id AS memoryId,committed_revision AS revision FROM release_operations WHERE account_id=? AND space_id=? AND client_key=?`, [actor.accountId, spaceId, key]);
        let existing = await lookup();
        if (!existing && prepared?.committed) fail(503, 'operation_receipt_unavailable');
        if (!existing) {
            // Hashing, authority reads and receipt lookup can cross an expiry.
            // SQL evaluates admission time after any queue delay. Derive the
            // operation timestamp and quota month in that same statement.
            const op = crypto.randomUUID(), at = this.clock();
            const start = stmt(this.db, `INSERT INTO release_operations(id,account_id,space_id,client_key,request_hash,action,memory_id,expected_revision,committed_revision,actor_credential_id,created_at,period,units)
    SELECT ?,c.account_id,s.id,?,?,?,?,?,?,c.id,${sqlNow()},strftime('%Y-%m',${sqlNow()}/1000,'unixepoch'),? FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority(cap)} ${additionalCap ? 'AND ' + authority(additionalCap) : ''} ${recent ? 'AND ' + recentSql() : ''}
      ${prepared?.intentId ? `AND EXISTS(SELECT 1 FROM release_payload_intents i WHERE i.id=? AND i.account_id=c.account_id AND i.space_id=s.id AND i.client_key=? AND i.request_hash=? AND i.expires_at>${sqlNow()} AND i.published_at IS NULL AND i.item_count=(SELECT count(*) FROM release_payload_stages p WHERE p.intent_id=i.id AND p.state='ready'))` : ''}`, [op, key, requestHash, action, memoryId, expectedRevision, expectedRevision === null ? 1 : expectedRevision + 1, at, at, units, spaceId, ...params(hash, at, cap), ...(additionalCap ? params(hash, at, additionalCap) : []), ...(recent ? [at - 300000, at] : []), ...(prepared?.intentId ? [prepared.intentId, key, requestHash, at] : [])]);
            try {
                await batch(this.db, [start, ...build(op, actor.id, at), ...(prepared ? publishPayloadStatements(this.db, prepared, op, { hash, at, cap, recent, additionalCap }) : [])]);
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
        const value = content(input);
        const prepared = this.payloads?.enabled ? await this.preparePayloads(token, spaceId, {
            action: 'create', cap: 'create', key, input: value, memoryId: null, expectedRevision: null,
            additionalCap: value.supersedesMemoryId ? 'update' : undefined,
            items: [{ body: value.body, source: value.source, provenance: value.provenance }]
        }) : undefined;
        const memoryId = prepared?.items[0]?.memoryId ?? crypto.randomUUID();
        // Generated IDs must not participate in the idempotency request digest.
        const result = await this.commit(token, spaceId, 'create', 'create', key, value, null, null, 1, (op, actor, at) => [
            stmt(this.db, `UPDATE release_operations SET memory_id=? WHERE id=?`, [memoryId, op]),
            prepared?.items[0] ? this.preparedCreate(op, prepared.items[0], value) :
                stmt(this.db, `INSERT INTO memories(id,space_id,body,source,revision,created_at,updated_at,actor_credential_id,kind,provenance,event_time,supersedes_id)
    SELECT ?,space_id,?,?,1,created_at,created_at,actor_credential_id,?,?,?,? FROM release_operations WHERE id=?`, [memoryId, value.body, value.source, value.kind, canonical(value.provenance), value.eventTime, value.supersedesMemoryId, op])
        ], false, value.supersedesMemoryId ? 'update' : undefined, prepared);
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
        const requestInput = { body: input.body, source: source ?? null, hasSource: source !== undefined };
        let prepared: PreparedPayloads | undefined;
        if (this.payloads?.enabled) {
            const actor = await requireSpace(this.db, token, spaceId, 'update', this.clock);
            const lookup = () => one(this.db, 'SELECT id FROM release_operations WHERE account_id=? AND space_id=? AND client_key=?', [actor.accountId, spaceId, key]);
            const existing = await lookup();
            let value = { body: input.body, source: source ?? null, provenance: { originKind: 'user' } as Provenance };
            if (!existing) {
                const hash = await tokenHash(token), at = this.clock();
                // Preserving omitted source/provenance is an internal update read;
                // write-only PATs do not acquire a public read capability.
                const old = await one<MemoryRow>(this.db, `SELECT ${columns} FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c
                  WHERE r.id=? AND s.id=? AND r.revision=? AND r.deleted_at IS NULL AND r.erased_at IS NULL AND ${authority('update')}`,
                    [memoryId, spaceId, input.expectedRevision, ...params(hash, at, 'update')]);
                if (!old) {
                    // An identical operation may have committed after lookup.
                    // Existing preparation/commit validates its request digest
                    // and current authority without staging another payload.
                    if (!await lookup()) fail(409, 'revision_conflict');
                } else {
                    try {
                        const [hydrated] = await this.hydrateRows([old]);
                        value = { body: input.body, source: source === undefined ? hydrated!.source : source, provenance: JSON.parse(hydrated!.provenance) as Provenance };
                    } catch (error) {
                        // A concurrent matching update can finish, then erase
                        // the old payload while this internal read is pending.
                        // Preparation and commit validate the receipt's digest
                        // and current authority; no receipt means no recovery.
                        if (!await lookup()) throw error;
                    }
                }
            }
            prepared = await this.preparePayloads(token, spaceId, { action: 'update', cap: 'update', key, input: requestInput,
                memoryId, expectedRevision: input.expectedRevision, items: [{ ...value, memoryId }] });
        }
        const result = await this.commit(token, spaceId, 'update', 'update', key, requestInput, memoryId, input.expectedRevision, 1, (op, actor, at) => {
            const item = prepared?.items[0];
            return [item ? stmt(this.db, `UPDATE memories SET body='[external]',source=NULL,provenance='{}',payload_id=?,payload_shard_id=?,payload_object_key=?,payload_sha256=?,payload_bytes=?,logical_bytes=?,revision=revision+1,updated_at=MAX(updated_at,(SELECT created_at FROM release_operations WHERE id=?)),actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_operations WHERE id=?)`,
                [item.ref.id, item.ref.shardId, item.ref.objectKey, item.ref.sha256, item.ref.bytes, item.logicalBytes, op, actor, memoryId, op]) :
                stmt(this.db, `UPDATE memories SET body=?,source=CASE WHEN ? THEN ? ELSE source END,revision=revision+1,updated_at=MAX(updated_at,(SELECT created_at FROM release_operations WHERE id=?)),actor_credential_id=? WHERE id=? AND EXISTS(SELECT 1 FROM release_operations WHERE id=?)`, [input.body, source === undefined ? 0 : 1, source ?? null, op, actor, memoryId, op])];
        }, false, undefined, prepared);
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
        if (this.payloads?.enabled) {
            str(key, 128);
            if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail(400, 'invalid_operation_id');
            const hash = await tokenHash(token), actor = await requireSpace(this.db, token, spaceId, 'update', this.clock);
            const lookup = () => one(this.db, 'SELECT id FROM release_operations WHERE account_id=? AND space_id=? AND client_key=?', [actor.accountId, spaceId, key]);
            const existing = await lookup();
            if (!existing) {
                const at = this.clock();
                const retained = await one<MemoryRow>(this.db, `SELECT ${columns} FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c
                    WHERE r.id=? AND s.id=? AND r.revision=? AND r.deleted_at IS NOT NULL AND r.erased_at IS NULL AND r.payload_id IS NOT NULL AND ${authority('update')}`,
                    [memoryId, spaceId, expectedRevision, ...params(hash, at, 'update')]);
                if (retained) {
                    try {
                        const [value] = await this.hydrateRows([retained]);
                        const checkedAt = this.clock();
                        const current = await one<{ expiresAt: number; restoreUntil: number; checkedAt: number }>(this.db, `/* restore-projection */
                            SELECT min(c.expires_at,c.membership_expires_at,${accessExpiry('update')}) AS expiresAt,${SQL_NOW_MS} AS checkedAt,
                                r.deleted_at+coalesce((SELECT retention_days FROM release_space_policies WHERE space_id=s.id),30)*86400000 AS restoreUntil
                            FROM memories r JOIN spaces s ON s.id=r.space_id CROSS JOIN active_credentials c
                            WHERE r.id=? AND s.id=? AND r.revision=? AND r.payload_id=? AND r.deleted_at IS NOT NULL AND r.erased_at IS NULL AND ${authority('update')}`,
                            [memoryId, spaceId, expectedRevision, retained.payloadId!, ...params(hash, checkedAt, 'update')]);
                        const returnedAt = Math.max(this.clock(), current?.checkedAt ?? 0);
                        if (current && current.expiresAt <= returnedAt) fail(403, 'access_denied');
                        if (current && current.restoreUntil > returnedAt) {
                            // Recovery retains trash in canonical R2 and rebuilds
                            // only live HOT heads. Recreate the immutable projection
                            // before publication, using create-only storage and its
                            // permanent purge/retirement fences. The restore command
                            // below still admits authority/revision/retention atomically.
                            await this.payloads.stage({ spaceId, memoryId }, { id: retained.payloadId!, shardId: retained.payloadShardId!,
                                objectKey: retained.payloadObjectKey!, sha256: retained.payloadSha256!, bytes: retained.payloadBytes! },
                            { body: value!.body, source: value!.source, provenance: JSON.parse(value!.provenance) as Provenance });
                        }
                    } catch (error) {
                        // A restore completed by a concurrent identical request
                        // may already have been updated or erased. Resolve its
                        // receipt below without recreating its former payload.
                        if (!await lookup()) throw error;
                    }
                }
            }
        }
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
        status: 'access_removed_cleanup_pending';
        accessRemoved: true;
        payloadCleanup: 'not_confirmed';
        indexCleanup: 'not_confirmed';
    }> {
        id(memoryId);
        integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1);
        if (confirmation !== memoryId)
            fail(400, 'confirmation_required');
        await this.commit(token, spaceId, 'erase', 'delete', key, { confirmation }, memoryId, expectedRevision, 0, (op, actor, at) => erasureStatements(this.db, memoryId, at, actor, 'EXISTS(SELECT 1 FROM release_operations WHERE id=?)', [op]), true);
        // This is an acknowledgment of central access removal. R2/hot payload
        // and vector cleanup complete independently; a replay is not a new
        // observation that any physical copy has been removed.
        return { id: memoryId, status: 'access_removed_cleanup_pending', accessRemoved: true,
            payloadCleanup: 'not_confirmed', indexCleanup: 'not_confirmed' };
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
        const hydrated = await this.hydrateRows(page, { omitErased: true });
        const allowed = await this.confirmRead(hash, spaceId, page, { deleted: Boolean(input.deleted), currentFact: !input.deleted });
        const results = hydrated.filter(row => allowed.has(row.id)).map(row => ({ ...memoryRow(row), ...(input.deleted ? allowed.get(row.id)! : {}) }));
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

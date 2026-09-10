import type { Capability, Database, Statement } from './types.ts';
import type { PayloadContent, PayloadContext, PayloadRef } from './payload-types.ts';
import { authority, params, recentSql, requireSpace } from './authority.ts';
import { sqlNow } from '../sql-clock.ts';
import { batch, canonical, digest, fail, id, one, rows, stmt, str, tokenHash } from './util.ts';

export interface PayloadBackend {
    readonly enabled: boolean;
    descriptor(context: PayloadContext, content: PayloadContent, payloadId: string): Promise<PayloadRef>;
    stage(context: PayloadContext, ref: PayloadRef, content: PayloadContent): Promise<void>;
    read(context: PayloadContext, ref: PayloadRef): Promise<PayloadContent>;
}
export type PreparedPayloadItem = { memoryId: string; ref: PayloadRef; logicalBytes: number; ordinal: number };
export type PreparedPayloads = {
    intentId: string | null; accountId: string; spaceId: string; key: string; requestHash: string;
    items: PreparedPayloadItem[]; committed?: { id: string; revision: number | null };
};
export type PreparePayloadInput = {
    action: string; cap: Capability; key: string; input: unknown; memoryId: string | null;
    expectedRevision: number | null; recent?: boolean; additionalCap?: Capability;
    items: (PayloadContent & { memoryId?: string })[];
};
export function operationHash(action: string, input: unknown, memoryId: string | null, expectedRevision: number | null): Promise<string> {
    return digest(canonical({ action, input, memoryId, expectedRevision }));
}
export function logicalBytes(value: PayloadContent): number {
    const encoder = new TextEncoder();
    return encoder.encode(value.body).length + encoder.encode(value.source ?? '').length + encoder.encode(canonical(value.provenance)).length;
}
type Intent = { id: string; requestHash: string; expiresAt: number; itemCount: number };
type Stage = { id: string; memoryId: string; ordinal: number; shardId: string; objectKey: string; sha256: string; bytes: number; logicalBytes: number; state: string };

/** All locators are durable before the first external write. A preparation has
 * no operation receipt, quota charge, public head or permission of its own. */
export async function preparePayloads(db: Database, clock: () => number, storage: PayloadBackend, token: string, spaceId: string, input: PreparePayloadInput): Promise<PreparedPayloads> {
    id(spaceId); str(input.key, 128);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.key)) fail(400, 'invalid_operation_id');
    if (!input.items.length || input.items.length > 20) fail(400, 'invalid_payload_count');
    const contents: PayloadContent[] = input.items.map(value => {
        str(value.body, 16384); if (value.source !== null) str(value.source, 2048, true);
        str(canonical(value.provenance), 4096);
        return { body: value.body, source: value.source, provenance: value.provenance };
    });
    const hash = await tokenHash(token), requestHash = await operationHash(input.action, input.input, input.memoryId, input.expectedRevision);
    const actor = await requireSpace(db, token, spaceId, input.cap, clock);
    const result: PreparedPayloads = { intentId: null, accountId: actor.accountId, spaceId, key: input.key, requestHash, items: [] };
    const lookup = () => one<{ id: string; memoryId: string | null; revision: number | null; requestHash: string }>(db,
        'SELECT id,memory_id AS memoryId,committed_revision AS revision,request_hash AS requestHash FROM release_operations WHERE account_id=? AND space_id=? AND client_key=?', [actor.accountId, spaceId, input.key]);
    const committed = await lookup();
    if (committed) {
        if (committed.requestHash !== requestHash) fail(409, 'idempotency_conflict');
        result.committed = { id: committed.memoryId ?? committed.id, revision: committed.revision };
        return result;
    }
    try {
        const find = () => one<Intent>(db, 'SELECT id,request_hash AS requestHash,expires_at AS expiresAt,item_count AS itemCount FROM release_payload_intents WHERE account_id=? AND space_id=? AND client_key=?', [actor.accountId, spaceId, input.key]);
        let intent = await find();
        if (!intent) {
            const intentId = crypto.randomUUID(), planned = [];
            for (const [ordinal, value] of contents.entries()) {
                const memoryId = input.items[ordinal]!.memoryId ?? crypto.randomUUID(); id(memoryId);
                const ref = await storage.descriptor({ spaceId, memoryId }, value, crypto.randomUUID());
                planned.push({ ordinal, memoryId, ref, logicalBytes: logicalBytes(value) });
            }
            const at = clock();
            const admission = `${authority(input.cap)} ${input.additionalCap ? 'AND ' + authority(input.additionalCap) : ''} ${input.recent ? 'AND ' + recentSql() : ''}`;
            const values = [...params(hash, at, input.cap), ...(input.additionalCap ? params(hash, at, input.additionalCap) : []), ...(input.recent ? [at - 300000, at] : [])];
            try { await batch(db, [
                stmt(db, `INSERT INTO release_payload_intents(id,account_id,space_id,client_key,request_hash,action,memory_id,expected_revision,item_count,reserved_bytes,created_at,expires_at)
                  SELECT ?,c.account_id,s.id,?,?,?,?,?,?,?,${sqlNow()},${sqlNow()}+86400000 FROM spaces s CROSS JOIN active_credentials c
                  WHERE s.id=? AND ${admission} AND NOT EXISTS(SELECT 1 FROM release_payload_intents old WHERE old.account_id=c.account_id AND old.space_id=s.id AND old.client_key=?)`,
                    [intentId, input.key, requestHash, input.action, input.memoryId, input.expectedRevision, contents.length, planned.reduce((n, item) => n + item.ref.bytes, 0), at, at, spaceId, ...values, input.key]),
                stmt(db, `INSERT INTO release_payload_stages(id,intent_id,ordinal,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,logical_bytes,created_at)
                  SELECT json_extract(item.value,'$.ref.id'),i.id,json_extract(item.value,'$.ordinal'),json_extract(item.value,'$.memoryId'),
                    json_extract(item.value,'$.ref.shardId'),json_extract(item.value,'$.ref.objectKey'),json_extract(item.value,'$.ref.sha256'),
                    json_extract(item.value,'$.ref.bytes'),json_extract(item.value,'$.logicalBytes'),i.created_at
                  FROM release_payload_intents i,json_each(?) item WHERE i.id=? AND i.expires_at>${sqlNow()}`,
                    [canonical(planned), intentId, at])
            ]); } catch (error) {
                if (error instanceof Error && error.message.includes('release_payload_budget')) fail(429, 'payload_staging_limit');
                throw error;
            }
            intent = await find();
        }
        if (!intent) fail(403, 'access_denied');
        if (intent.requestHash !== requestHash || intent.itemCount !== contents.length) fail(409, 'idempotency_conflict');
        if (intent.expiresAt <= clock()) fail(409, 'payload_preparation_expired');
        result.intentId = intent.id;
        const stages = await rows<Stage>(db, `SELECT id,memory_id AS memoryId,ordinal,payload_shard_id AS shardId,payload_object_key AS objectKey,
            payload_sha256 AS sha256,payload_bytes AS bytes,logical_bytes AS logicalBytes,state FROM release_payload_stages WHERE intent_id=? ORDER BY ordinal`, [intent.id]);
        if (stages.length !== contents.length) fail(503, 'payload_preparation_incomplete');
        for (const stage of stages) {
            if (!['staging', 'ready', 'published'].includes(stage.state)) fail(409, 'payload_preparation_expired');
            const value = contents[stage.ordinal]!;
            if (await digest(canonical(value)) !== stage.sha256 || logicalBytes(value) !== stage.logicalBytes) fail(409, 'idempotency_conflict');
            const ref = { id: stage.id, shardId: stage.shardId, objectKey: stage.objectKey, sha256: stage.sha256, bytes: stage.bytes };
            if (stage.state === 'staging') {
                await requireSpace(db, token, spaceId, input.cap, clock);
                await storage.stage({ spaceId, memoryId: stage.memoryId }, ref, value);
                const at = clock();
                const changed = await db.prepare(`UPDATE release_payload_stages SET state='ready' WHERE id=? AND state='staging'
                  AND EXISTS(SELECT 1 FROM release_payload_intents i JOIN spaces s ON s.id=i.space_id CROSS JOIN active_credentials c
                    WHERE i.id=release_payload_stages.intent_id AND i.account_id=c.account_id AND i.expires_at>${sqlNow()} AND ${authority(input.cap)}
                      ${input.additionalCap ? 'AND ' + authority(input.additionalCap) : ''} ${input.recent ? 'AND ' + recentSql() : ''})`)
                    .bind(stage.id, at, ...params(hash, at, input.cap), ...(input.additionalCap ? params(hash, at, input.additionalCap) : []), ...(input.recent ? [at - 300000, at] : [])).run();
                if (!changed.success || !changed.meta.changes) {
                    const current = await one<{ state: string }>(db, 'SELECT state FROM release_payload_stages WHERE id=?', [stage.id]);
                    if (!current || !['ready', 'published'].includes(current.state)) fail(403, 'access_denied');
                }
            }
            result.items.push({ memoryId: stage.memoryId, ordinal: stage.ordinal, ref, logicalBytes: stage.logicalBytes });
        }
        return result;
    } catch (error) {
        // Another identical request can commit while this one awaits a payload
        // which later becomes retired or purged. Only its matching immutable
        // receipt can recover that outcome; commit() still rechecks every
        // current capability and any recent-proof requirement before returning.
        const receipt = await lookup();
        if (!receipt) throw error;
        if (receipt.requestHash !== requestHash) fail(409, 'idempotency_conflict');
        return { ...result, items: [], committed: { id: receipt.memoryId ?? receipt.id, revision: receipt.revision } };
    }
}

export function publishPayloadStatements(db: Database, prepared: PreparedPayloads, operationId: string,
    admission: { hash: string; at: number; cap: Capability; recent: boolean; additionalCap?: Capability }): Statement[] {
    if (!prepared.intentId) return [];
    return [
        stmt(db, `UPDATE release_payload_stages SET state='published' WHERE intent_id=? AND state='ready'
          AND EXISTS(SELECT 1 FROM release_operations o JOIN spaces s ON s.id=o.space_id CROSS JOIN active_credentials c
            WHERE o.id=? AND c.id=o.actor_credential_id AND ${authority(admission.cap)}
              ${admission.additionalCap ? 'AND ' + authority(admission.additionalCap) : ''} ${admission.recent ? 'AND ' + recentSql() : ''})`,
            [prepared.intentId, operationId, ...params(admission.hash, admission.at, admission.cap),
                ...(admission.additionalCap ? params(admission.hash, admission.at, admission.additionalCap) : []), ...(admission.recent ? [admission.at - 300000, admission.at] : [])]),
        stmt(db, `UPDATE release_payload_intents SET published_at=(SELECT created_at FROM release_operations WHERE id=?)
          WHERE id=? AND published_at IS NULL AND EXISTS(SELECT 1 FROM release_operations WHERE id=?)`, [operationId, prepared.intentId, operationId])
    ];
}

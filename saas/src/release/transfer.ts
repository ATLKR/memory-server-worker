import type { Database, Memory } from './types.ts';
import { authority, params, requireSpace, interactive, recentSql, INTERACTIVE, shareGrantorAuthority } from './authority.ts';
import { memoryRow } from './memory.ts';
import { decodeCursor, encodeCursor, fail, id, integer, one, rows, str, tokenHash } from './util.ts';
export class Transfers {
    db: Database;
    clock: () => number;
    constructor(db: Database, clock: () => number = Date.now) { this.db = db; this.clock = clock; }
    async startExport(token: string, spaceId: string): Promise<{
        id: string;
        expiresAt: number;
    }> {
        const at = this.clock(), hash = await tokenHash(token), exportId = crypto.randomUUID();
        await requireSpace(this.db, token, spaceId, 'export', at);
        const r = await this.db.prepare(`INSERT INTO release_export_sessions(id,account_id,space_id,watermark,expires_at,created_at)
   SELECT ?,c.account_id,s.id,coalesce((SELECT max(id) FROM memory_audit_events),0),?,? FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('export')}`).bind(exportId, at + 3600000, at, id(spaceId), ...params(hash, at, 'export')).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'access_denied');
        return { id: exportId, expiresAt: at + 3600000 };
    }
    async exportPage(token: string, spaceId: string, exportId: string, cursor?: string | null, limit = 25): Promise<{
        format: string;
        results: Memory[];
        nextCursor: string | null;
        watermark: number;
    }> {
        id(spaceId);
        id(exportId);
        integer(limit, 1, 50);
        const at = this.clock(), hash = await tokenHash(token), actor = await requireSpace(this.db, token, spaceId, 'export', at);
        const session = await one<{
            watermark: number;
        }>(this.db, 'SELECT watermark FROM release_export_sessions WHERE id=? AND account_id=? AND space_id=? AND expires_at>?', [exportId, actor.accountId, spaceId, at]);
        if (!session)
            fail(404, 'export_not_found');
        let after = '';
        if (cursor) {
            const values = decodeCursor(cursor, exportId);
            if (values.length !== 1)
                fail(400, 'invalid_cursor');
            after = id(values[0]);
        }
        const all = await rows<Omit<Memory, 'provenance'> & {
            provenance: string;
        }>(this.db, `WITH target AS (
    SELECT memory_id,max(revision) AS revision FROM memory_audit_events WHERE space_id=? AND id<=? AND memory_id>? GROUP BY memory_id
   ), versions AS (
    SELECT id,space_id,body,source,revision,created_at,updated_at,deleted_at,event_time,kind,provenance,supersedes_id FROM memories
    UNION ALL SELECT memory_id,space_id,body,source,revision,created_at,updated_at,deleted_at,event_time,kind,provenance,supersedes_id FROM memory_versions
   ) SELECT v.id,v.space_id AS spaceId,v.body,v.source,v.revision,v.created_at AS createdAt,v.updated_at AS updatedAt,v.deleted_at AS deletedAt,v.event_time AS eventTime,v.kind,v.provenance,v.supersedes_id AS supersedesMemoryId,NULL AS erasedAt
   FROM target t JOIN versions v ON v.id=t.memory_id AND v.revision=t.revision JOIN memories current ON current.id=v.id AND current.erased_at IS NULL
   JOIN spaces s ON s.id=v.space_id CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('export')} ORDER BY v.id LIMIT ?`, [spaceId, session!.watermark, after, spaceId, ...params(hash, at, 'export'), limit + 1]);
        await requireSpace(this.db, token, spaceId, 'export', this.clock());
        const results = all.slice(0, limit).map(memoryRow), last = results.at(-1);
        return { format: 'memory-export-v1', results, nextCursor: all.length > limit && last ? encodeCursor(exportId, [last.id]) : null, watermark: session!.watermark };
    }
    async share(token: string, spaceId: string, email: string, days = 7): Promise<{
        id: string;
        expiresAt: number;
    }> {
        integer(days, 1, 30);
        str(email, 254);
        const at = this.clock(), hash = await tokenHash(token), shareId = crypto.randomUUID();
        await interactive(this.db, token, at, true);
        await requireSpace(this.db, token, spaceId, 'update', at);
        const r = await this.db.prepare(`INSERT INTO release_shares
            (id,space_id,recipient_email_id,creator_credential_id,expires_at,created_at,creator_membership_id,creator_email_id)
   SELECT ?,s.id,e.id,c.id,?,?,m.id,m.email_id FROM spaces s CROSS JOIN active_credentials c CROSS JOIN account_emails e
   LEFT JOIN active_memberships m ON m.account_id=c.account_id AND m.organization_id=s.organization_id
     AND m.expires_at>? AND m.role IN ('owner','admin')
   WHERE s.id=? AND e.address=? AND e.revoked_at IS NULL AND ${authority('update')} AND ${recentSql()}`)
            .bind(shareId, at + days * 86400000, at, at, id(spaceId), email.trim().toLowerCase(), ...params(hash, at, 'update'), at - 300000, at).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'recipient_or_authority_unavailable');
        return { id: shareId, expiresAt: at + days * 86400000 };
    }
    async invitations(token: string): Promise<Record<string, unknown>[]> {
        const at = this.clock(), hash = await tokenHash(token);
        await interactive(this.db, token, at);
        const invitations = await rows<Record<string, unknown>>(this.db, `SELECT sh.id,sh.space_id AS spaceId,s.name,sh.expires_at AS expiresAt,sh.accepted_at AS acceptedAt
            FROM release_shares sh JOIN spaces s ON s.id=sh.space_id JOIN account_emails e ON e.id=sh.recipient_email_id
            JOIN active_credentials c ON c.account_id=e.account_id
            WHERE c.token_digest=? AND c.expires_at>? AND c.membership_expires_at>? AND ${INTERACTIVE} AND c.permission='write'
                AND e.revoked_at IS NULL AND sh.revoked_at IS NULL AND sh.expires_at>? AND ${shareGrantorAuthority()}`,
            [hash, at, at, at, at]);
        await interactive(this.db, token, this.clock());
        return invitations;
    }
    async accept(token: string, shareId: string): Promise<void> {
        const at = this.clock(), hash = await tokenHash(token);
        await interactive(this.db, token, at);
        const r = await this.db.prepare(`UPDATE release_shares SET accepted_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>? AND accepted_at IS NULL
            AND EXISTS(SELECT 1 FROM account_emails e JOIN active_credentials c ON c.account_id=e.account_id
                WHERE e.id=release_shares.recipient_email_id AND e.revoked_at IS NULL AND c.token_digest=? AND c.expires_at>?
                    AND ${INTERACTIVE} AND c.permission='write')
            AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=release_shares.space_id AND ${shareGrantorAuthority('release_shares')})`)
            .bind(at, id(shareId), at, hash, at, at).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'share_unavailable');
    }
    async revoke(token: string, spaceId: string, shareId: string): Promise<void> {
        const at = this.clock(), hash = await tokenHash(token);
        await interactive(this.db, token, at, true);
        const r = await this.db.prepare(`UPDATE release_shares SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND space_id=? AND EXISTS(SELECT 1 FROM spaces s CROSS JOIN active_credentials c WHERE s.id=release_shares.space_id AND ${authority('update')} AND ${recentSql()})`).bind(at, id(shareId), id(spaceId), ...params(hash, at, 'update'), at - 300000, at).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'access_denied');
    }
}

import type { Database, Memory } from './types.ts';
import { SQL_NOW_MS, sqlNow } from '../sql-clock.ts';
import { authority, params, requireSpace, interactive, recentSql, INTERACTIVE, shareGrantorAuthority, accessExpiry } from './authority.ts';
import { memoryRow } from './memory.ts';
import { decodeCursor, encodeCursor, fail, id, integer, one, rows, str, tokenHash } from './util.ts';
interface OutboundShare {
    id: string;
    spaceId: string;
    recipientEmail: string;
    createdAt: number;
    expiresAt: number;
    acceptedAt: number | null;
    revokedAt: number | null;
}
export class Transfers {
    db: Database;
    clock: () => number;
    constructor(db: Database, clock: () => number = Date.now) { this.db = db; this.clock = clock; }
    async startExport(token: string, spaceId: string): Promise<{
        id: string;
        expiresAt: number;
    }> {
        const hash = await tokenHash(token), exportId = crypto.randomUUID();
        await requireSpace(this.db, token, spaceId, 'export', this.clock);
        const at = this.clock();
        const r = await this.db.prepare(`INSERT INTO release_export_sessions(id,account_id,space_id,watermark,expires_at,created_at)
   SELECT ?,c.account_id,s.id,coalesce((SELECT max(id) FROM memory_audit_events),0),${sqlNow()}+3600000,${sqlNow()} FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('export')}
   RETURNING expires_at AS expiresAt`).bind(exportId, at, at, id(spaceId), ...params(hash, at, 'export')).first<{ expiresAt: number }>();
        if (!r)
            fail(403, 'access_denied');
        return { id: exportId, expiresAt: r.expiresAt };
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
        const hash = await tokenHash(token), actor = await requireSpace(this.db, token, spaceId, 'export', this.clock);
        const at = this.clock();
        const session = await one<{
            watermark: number;
        }>(this.db, `SELECT watermark FROM release_export_sessions WHERE id=? AND account_id=? AND space_id=? AND expires_at>${sqlNow()}`, [exportId, actor.accountId, spaceId, at]);
        if (!session)
            fail(404, 'export_not_found');
        let after = '';
        if (cursor) {
            const values = decodeCursor(cursor, exportId);
            if (values.length !== 1)
                fail(400, 'invalid_cursor');
            after = id(values[0]);
        }
        // Resolve only one page of this Space's snapshot IDs using its audit
        // index, then hydrate those exact revisions. Erasure can omit content
        // without losing the target cursor and skipping later snapshot rows.
        const targets = await rows<{ memoryId: string; revision: number }>(this.db,
            `SELECT memory_id AS memoryId,max(revision) AS revision FROM memory_audit_events
                WHERE space_id=? AND memory_id>? AND id<=? GROUP BY memory_id ORDER BY memory_id LIMIT ?`,
            [spaceId, after, session.watermark, limit + 1]);
        const page = targets.slice(0, limit), last = page.at(-1), fresh = this.clock();
        const all = page.length ? await rows<Omit<Memory, 'provenance'> & {
            provenance: string;
        }>(this.db, `WITH target AS MATERIALIZED (
    SELECT json_extract(value,'$.memoryId') AS memory_id,json_extract(value,'$.revision') AS revision FROM json_each(?)
   ), versions AS (
    SELECT r.id,r.space_id,r.body,r.source,r.revision,r.created_at,r.updated_at,r.deleted_at,r.event_time,r.kind,r.provenance,r.supersedes_id
      FROM target t JOIN memories r ON r.id=t.memory_id AND r.revision=t.revision
    UNION ALL SELECT v.memory_id,v.space_id,v.body,v.source,v.revision,v.created_at,v.updated_at,v.deleted_at,v.event_time,v.kind,v.provenance,v.supersedes_id
      FROM target t JOIN memory_versions v ON v.memory_id=t.memory_id AND v.revision=t.revision
   ) SELECT v.id,v.space_id AS spaceId,v.body,v.source,v.revision,v.created_at AS createdAt,v.updated_at AS updatedAt,v.deleted_at AS deletedAt,v.event_time AS eventTime,v.kind,v.provenance,v.supersedes_id AS supersedesMemoryId,NULL AS erasedAt
   FROM versions v JOIN memories current ON current.id=v.id AND current.erased_at IS NULL
   JOIN spaces s ON s.id=v.space_id CROSS JOIN active_credentials c WHERE s.id=? AND ${authority('export')} ORDER BY v.id`, [JSON.stringify(page), spaceId, ...params(hash, fresh, 'export')]) : [];
        // Session validity and current authority share the final SQL snapshot.
        // Compare expiry facts after its await too, without opening another read
        // boundary after the authorization check.
        const checkedAt = this.clock();
        const current = await one<{
            credentialExpiresAt: number;
            credentialMembershipExpiresAt: number;
            spaceMembershipExpiresAt: number | null;
            exportExpiresAt: number | null;
            checkedAt: number;
            memoryIds: string;
        }>(this.db, `/* export-disclosure */ SELECT c.expires_at AS credentialExpiresAt,c.membership_expires_at AS credentialMembershipExpiresAt,${SQL_NOW_MS} AS checkedAt,
            (SELECT json_group_array(r.id) FROM memories r WHERE r.id IN (SELECT value FROM json_each(?))
                AND r.space_id=s.id AND r.erased_at IS NULL) AS memoryIds,
            CASE WHEN s.organization_id IS NULL THEN 9007199254740991 ELSE
                (SELECT m.expires_at FROM active_memberships m WHERE m.organization_id=s.organization_id AND m.account_id=c.account_id)
            END AS spaceMembershipExpiresAt,x.expires_at AS exportExpiresAt
            FROM spaces s CROSS JOIN active_credentials c LEFT JOIN release_export_sessions x
                ON x.id=? AND x.account_id=c.account_id AND x.space_id=s.id
            WHERE s.id=? AND ${authority('export')}`, [JSON.stringify(all.map(row => row.id)), exportId, spaceId, ...params(hash, checkedAt, 'export')]);
        const returnedAt = Math.max(this.clock(), current?.checkedAt ?? 0);
        if (!current || current.credentialExpiresAt <= returnedAt || current.credentialMembershipExpiresAt <= returnedAt
            || current.spaceMembershipExpiresAt === null || current.spaceMembershipExpiresAt <= returnedAt)
            fail(403, 'access_denied');
        if (current.exportExpiresAt === null || current.exportExpiresAt <= returnedAt)
            fail(404, 'export_not_found');
        const allowed = new Set(JSON.parse(current.memoryIds) as string[]);
        return { format: 'memory-export-v1', results: all.filter(row => allowed.has(row.id)).map(memoryRow), nextCursor: targets.length > limit && last ? encodeCursor(exportId, [last.memoryId]) : null, watermark: session.watermark };
    }
    async share(token: string, spaceId: string, email: string, days = 7): Promise<{
        id: string;
        expiresAt: number;
    }> {
        integer(days, 1, 30);
        str(email, 254);
        const hash = await tokenHash(token), shareId = crypto.randomUUID();
        await interactive(this.db, token, this.clock, true);
        await requireSpace(this.db, token, spaceId, 'update', this.clock);
        const at = this.clock();
        const r = await this.db.prepare(`INSERT INTO release_shares
            (id,space_id,recipient_email_id,creator_credential_id,expires_at,created_at,creator_membership_id,creator_email_id)
   SELECT ?,s.id,e.id,c.id,${sqlNow()}+?,${sqlNow()},m.id,m.email_id FROM spaces s CROSS JOIN active_credentials c CROSS JOIN account_emails e
   LEFT JOIN memberships m ON m.id=(SELECT candidate.id FROM active_memberships candidate
     WHERE candidate.account_id=c.account_id AND candidate.organization_id=s.organization_id
       AND candidate.expires_at>${sqlNow()} AND candidate.role IN ('owner','admin'))
   WHERE s.id=? AND e.address=? AND e.revoked_at IS NULL
     AND EXISTS(SELECT 1 FROM accounts recipient WHERE recipient.id=e.account_id AND recipient.disabled_at IS NULL)
     AND ${authority('update')} AND ${recentSql()} RETURNING expires_at AS expiresAt`)
            .bind(shareId, at, days * 86400000, at, at, id(spaceId), email.trim().toLowerCase(), ...params(hash, at, 'update'), at - 300000, at).first<{ expiresAt: number }>();
        if (!r)
            fail(403, 'recipient_or_authority_unavailable');
        return { id: shareId, expiresAt: r.expiresAt };
    }
    async outbound(token: string, spaceId: string, input: { limit?: number; cursor?: string | null } = {}): Promise<{ results: OutboundShare[]; nextCursor: string | null }> {
        id(spaceId);
        const limit = integer(input.limit ?? 25, 1, 100), hash = await tokenHash(token);
        const actor = await interactive(this.db, token, this.clock), resource = 'outbound-shares:' + JSON.stringify([actor.accountId, spaceId]);
        let after: [number, string] | undefined;
        if (input.cursor) {
            const values = decodeCursor(input.cursor, resource);
            if (values.length !== 2)
                fail(400, 'invalid_cursor');
            after = [integer(values[0]), id(values[1])];
        }
        const at = this.clock();
        // Retained facts are recoverable even when the original browser token,
        // recipient claim, or share has expired/revoked. Current Space managers
        // receive a bounded recent page; no grant is labelled currently active.
        // Keep authority, its deadlines, and the exact returned records in one
        // final primary snapshot, with no later awaited disclosure boundary.
        const current = await one<{ expiresAt: number; shares: string }>(this.db, `/* outbound-share-page */
            WITH authorized AS MATERIALIZED (
                SELECT s.id AS spaceId,min(c.expires_at,c.membership_expires_at,${accessExpiry('update')}) AS expiresAt
                FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND c.account_id=?
                    AND ${authority('update')} AND ${INTERACTIVE} AND c.permission='write'
            ), page AS MATERIALIZED (
                SELECT sh.id,sh.space_id AS spaceId,e.address AS recipientEmail,sh.created_at AS createdAt,
                    sh.expires_at AS expiresAt,sh.accepted_at AS acceptedAt,sh.revoked_at AS revokedAt
                FROM release_shares sh JOIN account_emails e ON e.id=sh.recipient_email_id
                WHERE sh.space_id=(SELECT spaceId FROM authorized)
                    ${after ? 'AND sh.created_at<=? AND (sh.created_at<? OR sh.id<?)' : ''}
                ORDER BY sh.created_at DESC,sh.id DESC LIMIT ?
            ) SELECT expiresAt,(SELECT json_group_array(json_object('id',id,'spaceId',spaceId,'recipientEmail',recipientEmail,
                'createdAt',createdAt,'expiresAt',expiresAt,'acceptedAt',acceptedAt,'revokedAt',revokedAt))
                FROM (SELECT * FROM page ORDER BY createdAt DESC,id DESC)) AS shares FROM authorized`,
            [spaceId, actor.accountId, ...params(hash, at, 'update'), ...(after ? [after[0], after[0], after[1]] : []), limit + 1]);
        if (!current || current.expiresAt <= this.clock())
            fail(403, 'access_denied');
        const all = JSON.parse(current.shares) as OutboundShare[], results = all.slice(0, limit), last = results.at(-1);
        return { results, nextCursor: all.length > limit && last ? encodeCursor(resource, [last.createdAt, last.id]) : null };
    }
    async invitations(token: string, input: { limit?: number; cursor?: string | null } = {}): Promise<{ results: Record<string, unknown>[]; nextCursor: string | null }> {
        const limit = integer(input.limit ?? 25, 1, 100), hash = await tokenHash(token);
        const actor = await interactive(this.db, token, this.clock), resource = 'share-invitations:' + actor.accountId;
        let afterTime = 0, afterId = '';
        if (input.cursor) {
            const values = decodeCursor(input.cursor, resource);
            if (values.length !== 2)
                fail(400, 'invalid_cursor');
            afterTime = integer(values[0]); afterId = id(values[1]);
        }
        // Page raw targets before expiry/grant filtering. Each verified claim
        // contributes at most a page, even when a sender's whole backlog has
        // expired. The cursor advances across omitted targets as well.
        const all = await rows<Record<string, unknown> & { id: string; createdAt: number }>(this.db, `SELECT sh.id,sh.space_id AS spaceId,s.name,sh.expires_at AS expiresAt,sh.accepted_at AS acceptedAt,sh.created_at AS createdAt
            FROM account_emails e JOIN release_shares sh ON sh.id IN (
                SELECT sh.id FROM release_shares sh
                WHERE sh.recipient_email_id=e.id AND sh.revoked_at IS NULL
                    AND sh.created_at>=? AND (sh.created_at>? OR (sh.created_at=? AND sh.id>?))
                ORDER BY sh.created_at,sh.id LIMIT ?)
            JOIN spaces s ON s.id=sh.space_id WHERE e.account_id=? AND e.revoked_at IS NULL
            ORDER BY sh.created_at,sh.id LIMIT ?`,
            [afterTime, afterTime, afterTime, afterId, limit + 1, actor.accountId, limit + 1]);
        const invitations = all.slice(0, limit), last = invitations.at(-1);
        const fresh = this.clock();
        const current = await one<{ shareIds: string; expiresAt: number }>(this.db, `SELECT (
            SELECT json_group_array(json_object('id',sh.id,'expiresAt',min(sh.expires_at,
                CASE WHEN s.organization_id IS NULL THEN 9007199254740991 ELSE
                    (SELECT gm.expires_at FROM active_memberships gm WHERE gm.id=sh.creator_membership_id) END)))
            FROM release_shares sh JOIN spaces s ON s.id=sh.space_id
                JOIN account_emails e ON e.id=sh.recipient_email_id
            WHERE sh.id IN (SELECT value FROM json_each(?)) AND e.account_id=c.account_id
                AND e.revoked_at IS NULL AND sh.revoked_at IS NULL AND sh.expires_at>${sqlNow()} AND ${shareGrantorAuthority()}
          ) AS shareIds,min(c.expires_at,c.membership_expires_at) AS expiresAt FROM active_credentials c WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND c.membership_expires_at>${sqlNow()}
              AND ${INTERACTIVE} AND c.permission='write'`,
            [JSON.stringify(invitations.map(row => row.id)), fresh, fresh, hash, fresh, fresh]);
        const returnedAt = this.clock();
        if (!current || current.expiresAt <= returnedAt)
            fail(403, 'interactive_session_required');
        const allowed = new Set((JSON.parse(current.shareIds) as { id: string; expiresAt: number }[]).filter(row => row.expiresAt > returnedAt).map(row => row.id));
        return { results: invitations.filter(row => allowed.has(row.id)), nextCursor: all.length > limit && last ? encodeCursor(resource, [last.createdAt, last.id]) : null };
    }
    async accept(token: string, shareId: string): Promise<void> {
        const hash = await tokenHash(token);
        await interactive(this.db, token, this.clock);
        const at = this.clock();
        // A lost success response may be retried. Preserve the original consent
        // timestamp while rechecking the recipient and grantor on every attempt.
        const r = await this.db.prepare(`UPDATE release_shares SET accepted_at=coalesce(accepted_at,${sqlNow()}) WHERE id=? AND revoked_at IS NULL AND expires_at>${sqlNow()}
            AND EXISTS(SELECT 1 FROM account_emails e JOIN active_credentials c ON c.account_id=e.account_id
                WHERE e.id=release_shares.recipient_email_id AND e.revoked_at IS NULL AND c.token_digest=? AND c.expires_at>${sqlNow()}
                    AND ${INTERACTIVE} AND c.permission='write')
            AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=release_shares.space_id AND ${shareGrantorAuthority('release_shares')})`)
            .bind(at, id(shareId), at, hash, at, at).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'share_unavailable');
    }
    async revoke(token: string, spaceId: string, shareId: string): Promise<void> {
        const hash = await tokenHash(token);
        await interactive(this.db, token, this.clock, true);
        const at = this.clock();
        const r = await this.db.prepare(`UPDATE release_shares SET revoked_at=coalesce(revoked_at,${sqlNow()}) WHERE id=? AND space_id=? AND EXISTS(SELECT 1 FROM spaces s CROSS JOIN active_credentials c WHERE s.id=release_shares.space_id AND ${authority('update')} AND ${recentSql()})`).bind(at, id(shareId), id(spaceId), ...params(hash, at, 'update'), at - 300000, at).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'access_denied');
    }
}

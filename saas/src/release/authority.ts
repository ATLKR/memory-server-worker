import type { Actor, Capability, Database, Value } from './types.ts';
import { fail, id, one, tokenHash } from './util.ts';
import { SQL_NOW_MS, sqlNow } from '../sql-clock.ts';
export const INTERACTIVE = "c.kind='session' AND c.id NOT LIKE 'oauth:%'";
/** Aliases sh=share, s=source Space. One timestamp binding. The immutable
 * browser credential identifies the grantor account, not the grant's lifetime. */
export function shareGrantorAuthority(share: 'sh' | 'release_shares' = 'sh', expiry: '?' | '0' = '?'): string {
    return `EXISTS(SELECT 1 FROM credentials grantor JOIN accounts grantor_account
        ON grantor_account.id=grantor.account_id AND grantor_account.disabled_at IS NULL
      WHERE grantor.id=${share}.creator_credential_id AND (
        (s.account_id=grantor.account_id AND s.organization_id IS NULL
          AND ${share}.creator_membership_id IS NULL AND ${share}.creator_email_id IS NULL)
        OR (s.organization_id IS NOT NULL AND EXISTS(SELECT 1 FROM active_memberships grantor_member
          WHERE grantor_member.id=${share}.creator_membership_id AND grantor_member.email_id=${share}.creator_email_id
            AND grantor_member.account_id=grantor.account_id AND grantor_member.organization_id=s.organization_id
            AND grantor_member.expires_at>${sqlNow(expiry)} AND grantor_member.role IN ('owner','admin')))))`;
}
/** Aliases c=credential, s=Space. Two timestamp bindings: share and grantor expiry. */
export function acceptedShareAuthority(): string {
    return `EXISTS(SELECT 1 FROM release_shares sh JOIN account_emails e ON e.id=sh.recipient_email_id
      WHERE sh.space_id=s.id AND e.account_id=c.account_id AND e.revoked_at IS NULL
        AND sh.accepted_at IS NOT NULL AND sh.revoked_at IS NULL AND sh.expires_at>${sqlNow()}
        AND ${shareGrantorAuthority()})`;
}
/** Aliases c=active_credentials, s=spaces. Values: hash, then five timestamps. */
export function authority(action: Capability): string {
    const cap = action; // Closed TypeScript union; never constructed from request SQL.
    return `c.token_digest=? AND c.expires_at>${sqlNow()} AND c.membership_expires_at>${sqlNow()}
  AND s.security_mode='managed'
  AND (s.account_id IS NULL OR EXISTS(SELECT 1 FROM accounts owner WHERE owner.id=s.account_id AND owner.disabled_at IS NULL))
  AND (s.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations owner WHERE owner.id=s.organization_id AND owner.disabled_at IS NULL)) AND (
   (${INTERACTIVE} AND ${cap === 'read' ? '1' : "c.permission='write'"})
   OR EXISTS(SELECT 1 FROM release_credential_policies p,json_each(p.capabilities) a WHERE p.credential_id=c.id AND a.value='${cap}'
     AND (p.space_ids IS NULL OR EXISTS(SELECT 1 FROM json_each(p.space_ids) z WHERE z.value=s.id))))
  AND ((s.organization_id IS NULL AND s.account_id=c.account_id AND c.kind IN ('session','personal_key'))
   OR (s.organization_id IS NOT NULL AND EXISTS(SELECT 1 FROM active_memberships m WHERE m.account_id=c.account_id
      AND m.organization_id=s.organization_id AND m.expires_at>${sqlNow()}
      AND ((c.kind='session' AND c.membership_id IS NULL) OR (c.kind='api_key' AND c.membership_id=m.id))
      ${cap === 'read' ? '' : "AND m.role IN ('owner','admin')"}))
   OR (${cap === 'read' ? '1' : '0'} AND c.kind IN ('session','personal_key') AND ${acceptedShareAuthority()}))
  `;
}
// All actions bind sharing timestamps, including the disabled sharing branch.
export function authValues(hash: string, at: number): Value[] { return [hash, at, at, at, at, at]; }
export function params(hash: string, at: number, _action: Capability): Value[] { return authValues(hash, at); }
export function accessExpiry(action: Capability): string {
    // Alternative grants are independent: an accepted share can outlive the
    // recipient's organization membership. Keep the latest usable grant expiry.
    const shared = action === 'read' ? `coalesce((SELECT MAX(min(sh.expires_at,
        CASE WHEN s.organization_id IS NULL THEN 9007199254740991 ELSE
          (SELECT gm.expires_at FROM active_memberships gm WHERE gm.id=sh.creator_membership_id) END))
      FROM release_shares sh JOIN account_emails e ON e.id=sh.recipient_email_id
      WHERE sh.space_id=s.id AND e.account_id=c.account_id AND e.revoked_at IS NULL
        AND c.kind IN ('session','personal_key') AND sh.accepted_at IS NOT NULL AND sh.revoked_at IS NULL
        AND ${shareGrantorAuthority('sh', '0')}),0)` : '0';
    return `max(CASE WHEN s.organization_id IS NULL AND s.account_id=c.account_id
        AND c.kind IN ('session','personal_key') THEN 9007199254740991 ELSE 0 END,
      coalesce((SELECT MAX(m.expires_at) FROM active_memberships m WHERE m.account_id=c.account_id
        AND m.organization_id=s.organization_id AND ((c.kind='session' AND c.membership_id IS NULL)
          OR (c.kind='api_key' AND c.membership_id=m.id))
        ${action === 'read' ? '' : "AND m.role IN ('owner','admin')"}),0),${shared})`;
}
export async function requireSpace(db: Database, token: string, spaceId: string, action: Capability, clock: () => number): Promise<Actor> {
    const hash = await tokenHash(token);
    const at = clock();
    const result = await one<Actor & { credentialExpiresAt: number; membershipExpiresAt: number; grantExpiresAt: number }>(db,
        `SELECT c.id,c.account_id AS accountId,c.kind,c.reauthenticated_at AS reauthenticatedAt,
          c.expires_at AS credentialExpiresAt,c.membership_expires_at AS membershipExpiresAt,${accessExpiry(action)} AS grantExpiresAt
         FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND ${authority(action)}`, [id(spaceId), ...params(hash, at, action)]);
    if (!result || Math.min(result.credentialExpiresAt, result.membershipExpiresAt, result.grantExpiresAt) <= clock())
        return fail(403, 'access_denied');
    return { id: result.id, accountId: result.accountId, kind: result.kind, reauthenticatedAt: result.reauthenticatedAt };
}
export async function interactive(db: Database, token: string, clock: () => number, recent = false): Promise<Actor> {
    const hash = await tokenHash(token);
    const at = clock();
    const result = await one<Actor & { credentialExpiresAt: number; membershipExpiresAt: number }>(db,
        `SELECT c.id,c.account_id AS accountId,c.kind,c.reauthenticated_at AS reauthenticatedAt,
          c.expires_at AS credentialExpiresAt,c.membership_expires_at AS membershipExpiresAt
         FROM active_credentials c WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND c.membership_expires_at>${sqlNow()} AND ${INTERACTIVE} AND c.permission='write' ${recent ? `AND c.reauthenticated_at BETWEEN max(?,${SQL_NOW_MS}-300000) AND ${sqlNow()}` : ''}`, [hash, at, at, ...(recent ? [at - 300000, at] : [])]);
    const checkedAt = clock();
    if (!result || Math.min(result.credentialExpiresAt, result.membershipExpiresAt) <= checkedAt ||
        (recent && (result.reauthenticatedAt === null || result.reauthenticatedAt < checkedAt - 300000 || result.reauthenticatedAt > checkedAt)))
        return fail(403, recent ? 'recent_reauthentication_required' : 'interactive_session_required');
    return { id: result.id, accountId: result.accountId, kind: result.kind, reauthenticatedAt: result.reauthenticatedAt };
}
export function recentSql(): string { return `${INTERACTIVE} AND c.permission='write' AND c.reauthenticated_at BETWEEN max(?,${SQL_NOW_MS}-300000) AND ${sqlNow()}`; }

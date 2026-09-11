import type { Database } from '../release/types.ts';
import { authority, params, accessExpiry, INTERACTIVE, recentSql } from '../release/authority.ts';
import { fail, tokenHash } from '../release/util.ts';
import { sqlNow } from '../sql-clock.ts';
import type { MedicalCloudflareConsentOperation } from './consent.ts';

export interface RoutingAuthority {
  readonly credentialId: string; readonly accountId: string; readonly credentialKind: string;
  readonly organizationId: string; readonly membershipId: string; readonly emailId: string;
  readonly role: 'owner' | 'admin' | 'member'; readonly spaceId: string;
  readonly operation: MedicalCloudflareConsentOperation; readonly authorityExpiresAtMs: number;
}
export interface OrganizationAdminAuthority {
  readonly credentialId: string; readonly accountId: string; readonly membershipId: string;
  readonly organizationId: string; readonly authorityExpiresAtMs: number;
}
export function routingIdentifier(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) fail(400, 'routing_request_invalid');
  return input;
}
export function routingNow(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 60_000) fail(503, 'routing_clock_invalid');
  return now;
}
function liveExpiry(expiry: unknown, clock: () => number): asserts expiry is number {
  if (!Number.isSafeInteger(expiry) || (expiry as number) <= routingNow(clock)) fail(403, 'access_denied');
}

/** Current primary authority, including capability/Space restrictions and the
 * actual owning organization's independent membership. Personal Spaces and
 * outside share recipients do not manufacture organization consent authority.
 * A returned snapshot is not a reusable grant: recheck at provider admission
 * and disclosure. A D1 read cannot atomically fence a separate DO transaction. */
export async function resolveRoutingAuthority(db: Database, token: string, spaceId: string,
  operation: MedicalCloudflareConsentOperation, clock: () => number): Promise<RoutingAuthority> {
  routingIdentifier(spaceId);
  if (!['memory_ingest', 'memory_search'].includes(operation)) fail(400, 'routing_request_invalid');
  const cap = operation === 'memory_ingest' ? 'create' : 'read';
  const hash = await tokenHash(token), now = routingNow(clock);
  const row = await db.withSession('first-primary').prepare(`/* routing-authority */
    SELECT c.id AS credentialId,c.account_id AS accountId,c.kind AS credentialKind,
      s.organization_id AS organizationId,s.id AS spaceId,m.id AS membershipId,m.email_id AS emailId,m.role,
      min(c.expires_at,c.membership_expires_at,m.expires_at,${accessExpiry(cap)}) AS authorityExpiresAtMs
    FROM spaces s CROSS JOIN active_credentials c JOIN active_memberships m
      ON m.account_id=c.account_id AND m.organization_id=s.organization_id
      AND (c.kind<>'api_key' OR c.membership_id=m.id)
    WHERE s.id=? AND m.expires_at>${sqlNow()} AND ${authority(cap)}
      ${cap === 'create' ? "AND m.role IN ('owner','admin')" : ''}
    ORDER BY m.expires_at DESC,m.id LIMIT 1`).bind(spaceId, now, ...params(hash, now, cap))
    .first<Omit<RoutingAuthority, 'operation'>>();
  if (!row) fail(403, 'access_denied');
  liveExpiry(row.authorityExpiresAtMs, clock);
  for (const id of [row.credentialId,row.accountId,row.organizationId,row.membershipId,row.emailId,row.spaceId]) routingIdentifier(id);
  return Object.freeze({ ...row, operation });
}

/** Admin writes pass their exact selected Space list into the same snapshot.
 * No hierarchy traversal, directory role inference, or request actor is used. */
export async function resolveOrganizationAdmin(db: Database, token: string, organizationId: string,
  clock: () => number, options: { recent?: boolean; spaceIds?: readonly string[] } = {}): Promise<OrganizationAdminAuthority> {
  routingIdentifier(organizationId);
  const spaceIds = options.spaceIds ?? [];
  if (spaceIds.length > 1024 || new Set(spaceIds).size !== spaceIds.length) fail(400, 'routing_request_invalid');
  for (const space of spaceIds) routingIdentifier(space);
  const hash = await tokenHash(token), now = routingNow(clock);
  const row = await db.withSession('first-primary').prepare(`/* routing-organization-admin */
    SELECT c.id AS credentialId,c.account_id AS accountId,m.id AS membershipId,m.organization_id AS organizationId,
      min(c.expires_at,c.membership_expires_at,m.expires_at) AS authorityExpiresAtMs,c.reauthenticated_at AS reauthenticatedAt
    FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id
    WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND c.membership_expires_at>${sqlNow()}
      AND ${INTERACTIVE} AND m.organization_id=? AND m.expires_at>${sqlNow()} AND m.role IN ('owner','admin')
      ${options.recent ? 'AND ' + recentSql() : ''}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS(
        SELECT 1 FROM spaces s WHERE s.id=wanted.value AND s.organization_id=m.organization_id AND s.security_mode='managed'))
    ORDER BY m.expires_at DESC,m.id LIMIT 1`)
    .bind(hash,now,now,organizationId,now,...(options.recent ? [now-300000,now] : []),JSON.stringify(spaceIds))
    .first<OrganizationAdminAuthority & { reauthenticatedAt: number | null }>();
  if (!row) fail(403, 'organization_admin_required');
  liveExpiry(row.authorityExpiresAtMs, clock);
  const checkedAt = routingNow(clock);
  if (options.recent && (row.reauthenticatedAt === null || row.reauthenticatedAt < checkedAt-300000 || row.reauthenticatedAt > checkedAt)) fail(403, 'organization_admin_required');
  for (const id of [row.credentialId,row.accountId,row.membershipId,row.organizationId]) routingIdentifier(id);
  const { reauthenticatedAt: _, ...result } = row;
  return Object.freeze(result);
}

import type { Capability, Database } from '../release/types.ts';
import { authority, accessExpiry, params } from '../release/authority.ts';
import { fail, tokenHash } from '../release/util.ts';
import { routingIdentifier, routingNow } from './server-authority.ts';
import type { GeneralAuthority, GeneralOperation, SpaceOwner } from './general-types.ts';

function capability(operation: GeneralOperation): Capability {
  switch (operation) {
    case 'memory_ingest': return 'create';
    case 'memory_search': case 'memory_usage': return 'read';
    case 'memory_clear_space': return 'delete';
    default: return fail(400, 'routing_request_invalid');
  }
}
interface AuthorityRow {
  spaceId: string; ownerAccountId: string | null; ownerOrganizationId: string | null;
  accountId: string; credentialId: string; authorityExpiresAtMs: number;
}

/** Preserve the existing personal, organization and accepted-share ACL exactly.
 * The provider profile belongs to the Space's actual owner, not its caller.
 * This primary snapshot is not a reusable grant or a cross-store transaction:
 * recheck it before provider dispatch and before exposing provider output. */
export async function resolveGeneralRoutingAuthority(db: Database, token: string, spaceId: string,
  operation: GeneralOperation, clock: () => number): Promise<GeneralAuthority> {
  routingIdentifier(spaceId);
  const cap = capability(operation), hash = await tokenHash(token), now = routingNow(clock);
  const row = await db.withSession('first-primary').prepare(`/* general-routing-authority */
    SELECT s.id AS spaceId,s.account_id AS ownerAccountId,s.organization_id AS ownerOrganizationId,
      c.account_id AS accountId,c.id AS credentialId,
      min(c.expires_at,c.membership_expires_at,${accessExpiry(cap)}) AS authorityExpiresAtMs
    FROM spaces s CROSS JOIN active_credentials c
    WHERE s.id=? AND ${authority(cap)}`)
    .bind(spaceId, ...params(hash, now, cap)).first<AuthorityRow>();
  if (!row || !Number.isSafeInteger(row.authorityExpiresAtMs) || row.authorityExpiresAtMs <= routingNow(clock)) fail(403, 'access_denied');
  let owner: SpaceOwner;
  if (row.ownerOrganizationId === null && typeof row.ownerAccountId === 'string') owner = { kind: 'account', id: row.ownerAccountId };
  else if (row.ownerAccountId === null && typeof row.ownerOrganizationId === 'string') owner = { kind: 'organization', id: row.ownerOrganizationId };
  else return fail(503, 'routing_authority_invalid');
  for (const value of [row.spaceId, row.accountId, row.credentialId, owner.id]) routingIdentifier(value);
  if (row.spaceId !== spaceId) fail(503, 'routing_authority_invalid');
  return Object.freeze({ spaceId: row.spaceId, owner: Object.freeze(owner), accountId: row.accountId,
    credentialId: row.credentialId, operation, authorityExpiresAtMs: row.authorityExpiresAtMs });
}

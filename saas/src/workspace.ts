import { sqlNow } from './sql-clock.ts';
import { canonicalEmail, IdentityInvalid } from './identity.ts';
import type { IdentityDatabase, SqlValue } from './identity.ts';
import type { SeoulProjectionCapture } from './release/seoul-projection-capture.ts';

export class WorkspaceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status = 403, code = 'workspace_denied') {
    super(status === 400 ? 'Invalid workspace request' : 'Workspace operation denied');
    this.name = 'WorkspaceError';
    this.status = status;
    this.code = code;
  }
}
export interface WorkspacePrincipal {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  expiresAt: number;
  /** Verified issuer JWT iat, in milliseconds; never copied from public input. */
  issuedAt?: number;
  permission: 'read' | 'write';
}
export interface WorkspaceSnapshot {
  account: { id: string; emails: { id: string; address: string }[] };
  spaces: { id: string; name: string; organizationId: string | null; securityMode: 'managed'; canWrite: boolean }[];
  organizations: { id: string; name: string; role: string; membershipId: string; parentId: string | null }[];
  keys: { id: string; label: string; kind: string; organizationId: string | null;
    permission: string; expiresAt: number; revokedAt: number | null }[];
}

/** Trusted release policy, evaluated inside the same primary workspace snapshot. */
export type WorkspaceSpaceAccess = (hash: string, at: number) => {
  read: string; readValues: SqlValue[]; write: string; writeValues: SqlValue[];
  readExpires?: string; writeExpires?: string;
  additionalCandidates?: string;
};

// OAuth sessions are usable by memory REST/MCP only. A raw external bearer
// must never become an interactive workspace session, even in direct callers.
const INTERACTIVE = "c.kind='session' AND c.id NOT LIKE 'oauth:%'";
const DAY = 86_400_000;
function invalid(): never { throw new WorkspaceError(400, 'invalid_request'); }
function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) invalid();
  return value;
}
function boundedText(value: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || !value.trim()) invalid();
  return value;
}
function name(value: string): string { return boundedText(value, 100).trim(); }
function permission(value: string): 'read' | 'write' {
  if (value !== 'read' && value !== 'write') invalid();
  return value;
}
function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function hashToken(token: string): Promise<string> {
  if (typeof token !== 'string' || token.length < 32 || token.length > 8192 || /\s/.test(token)) invalid();
  const encoded = new TextEncoder().encode(token);
  if (encoded.byteLength > 8192) invalid();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Internal product service. signIn accepts only already verified provider
 * proof. It must never be exposed as a caller-supplied principal HTTP route.
 * Multirow writes use transaction triggers; authorization remains in the
 * mutating statement and is checked again by each command's validation trigger.
 */
export class WorkspaceService {
  private readonly db: IdentityDatabase;
  private readonly clock: () => number;
  private readonly identityLifecycle: boolean;
  private readonly capture?: SeoulProjectionCapture;
  constructor(db: IdentityDatabase, clock: () => number = Date.now, options: { identityLifecycle?: boolean } = {}, capture?: SeoulProjectionCapture) {
    capture?.assertDatabase(db);
    this.capture = capture;
    this.db = db;
    this.clock = clock;
    this.identityLifecycle = options.identityLifecycle === true;
  }
  private now(): number {
    const at = this.clock();
    if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 90 * DAY) invalid();
    return at;
  }
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error instanceof IdentityInvalid) throw new WorkspaceError(error.status, error.code);
      // Database/provider data and driver diagnostics must not escape to HTTP.
      throw new WorkspaceError();
    }
  }
  private async write(sql: string, values: SqlValue[]): Promise<void> {
    const result = await this.db.prepare(sql).bind(...values).run();
    if (!result.success || !Number.isSafeInteger(result.meta.changes) || (result.meta.changes ?? 0) < 1)
      throw new WorkspaceError();
  }

  async signIn(principal: WorkspacePrincipal, externalToken?: string): Promise<{ token: string; accountId: string; expiresAt: number }> {
    return this.safe(async () => {
      if (!principal || typeof principal !== 'object') invalid();
      const issuer = boundedText(principal.issuer, 2048);
      const subject = boundedText(principal.subject, 512);
      const granted = permission(principal.permission);
      if (!Number.isSafeInteger(principal.expiresAt) || principal.expiresAt <= this.now()) invalid();
      if (principal.issuedAt !== undefined && (!Number.isSafeInteger(principal.issuedAt) || principal.issuedAt < 0 || principal.issuedAt > this.now())) invalid();
      const token = externalToken === undefined ? randomToken() : externalToken;
      const digest = await hashToken(token);
      if (externalToken !== undefined) {
        const existing = await this.db.withSession('first-primary').prepare(`
          SELECT c.account_id AS accountId,c.expires_at AS expiresAt,c.revoked_at AS revokedAt,c.kind,
            c.permission,c.id,a.disabled_at AS disabledAt,p.account_id AS mappedAccountId
          FROM credentials c JOIN accounts a ON a.id=c.account_id
          LEFT JOIN provider_identities p ON p.issuer=? AND p.subject=? AND p.account_id=c.account_id
          WHERE c.token_digest=?`).bind(issuer, subject, digest).first<{
            accountId: string; expiresAt: number; revokedAt: number | null; kind: string;
            permission: string; id: string; disabledAt: number | null; mappedAccountId: string | null;
        }>();
        if (existing) {
          const at = this.now();
          if (existing.revokedAt !== null || existing.disabledAt !== null || existing.expiresAt <= at ||
              existing.kind !== 'session' || existing.id !== `oauth:${digest}` ||
              existing.permission !== granted || existing.mappedAccountId !== existing.accountId ||
              existing.expiresAt > principal.expiresAt) throw new WorkspaceError(401, 'unauthorized');
          return { token, accountId: existing.accountId, expiresAt: existing.expiresAt };
        }
      }
      const at = this.now();
      if (principal.expiresAt <= at) invalid();
      const expiresAt = Math.min(principal.expiresAt, at + 900_000);
      let email: { address: string; domain: string } | null = null;
      if (principal.emailVerified === true && principal.email !== undefined) email = canonicalEmail(principal.email);
      const credentialId = externalToken === undefined ? `session:${crypto.randomUUID()}` : `oauth:${digest}`;
      const receiptId = crypto.randomUUID(), newAccountId = crypto.randomUUID(), emailId = crypto.randomUUID(), spaceId = crypto.randomUUID();
      const sql = `INSERT INTO workspace_sign_ins(id,issuer,subject,new_account_id,credential_id,token_digest,
        expires_at,permission,email_id,address,domain,personal_space_id,created_at${this.identityLifecycle ? ',issued_at' : ''})
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?${this.identityLifecycle ? ',?' : ''} WHERE ?>${sqlNow()}`;
      const values = [receiptId, issuer, subject, newAccountId, credentialId,
        digest, expiresAt, granted, emailId, email?.address ?? null, email?.domain ?? null, spaceId, at,
        ...(this.identityLifecycle ? [principal.issuedAt ?? null] : []), expiresAt, at];
      if (this.capture) {
        const result = await this.capture.workspaceBootstrap(this.db, { commandType:'workspace-sign-in', receiptId, issuer, subject, newAccountId, credentialId, emailId, address:email?.address ?? null, spaceId }, sql, values);
        if (!result.success || !Number.isSafeInteger(result.meta.changes) || (result.meta.changes ?? 0) < 1) throw new WorkspaceError();
      } else await this.write(sql, values);
      const created = await this.db.withSession('first-primary').prepare(`
        SELECT c.account_id AS accountId,c.expires_at AS expiresAt FROM active_credentials c
        JOIN provider_identities p ON p.account_id=c.account_id AND p.issuer=? AND p.subject=?
        WHERE c.token_digest=? AND c.kind='session' AND c.expires_at>${sqlNow()} AND c.permission=?`)
        .bind(issuer, subject, digest, this.now(), granted).first<{ accountId: string; expiresAt: number }>();
      if (!created || created.expiresAt <= this.now()) throw new WorkspaceError(401, 'unauthorized');
      return { token, accountId: created.accountId, expiresAt: created.expiresAt };
    });
  }

  async snapshot(token: string, spaceAccess?: WorkspaceSpaceAccess): Promise<WorkspaceSnapshot> {
    return this.safe(async () => {
      const hash = await hashToken(token);
      const at = this.now();
      const membershipExpiry = `max(CASE WHEN s.account_id=c.account_id THEN 9007199254740991 ELSE 0 END,
        coalesce((SELECT MAX(m.expires_at) FROM active_memberships m WHERE m.account_id=c.account_id AND m.organization_id=s.organization_id),0))`;
      const access = spaceAccess?.(hash, at) ?? {
        read: `s.account_id=c.account_id OR EXISTS(SELECT 1 FROM active_memberships m
          WHERE m.account_id=c.account_id AND m.organization_id=s.organization_id AND m.expires_at>${sqlNow()})`,
        readValues: [at],
        write: `c.permission='write' AND (s.account_id=c.account_id OR EXISTS(SELECT 1 FROM active_memberships writer
          WHERE writer.account_id=c.account_id AND writer.organization_id=s.organization_id
            AND writer.expires_at>${sqlNow()} AND writer.role IN ('owner','admin')))`,
        writeValues: [at],
        readExpires: membershipExpiry,
        writeExpires: `CASE WHEN c.permission='write' THEN ${membershipExpiry} ELSE 0 END`,
      };
      // One primary snapshot prevents mixed-tenant/stale joins between separate
      // authorization and data reads. Every correlated collection starts at c.
      const result = await this.db.withSession('first-primary').prepare(`
        SELECT c.account_id AS accountId,c.expires_at AS credentialExpiresAt,
          (SELECT json_group_array(json_object('id',e.id,'address',e.address)) FROM account_emails e
            WHERE e.account_id=c.account_id AND e.revoked_at IS NULL) AS emails,
          (SELECT json_group_array(json_object('id',s.id,'name',s.name,'organizationId',s.organization_id,
            'securityMode',s.security_mode,'canWrite',CASE WHEN ${access.write} THEN 1 ELSE 0 END,
            '_readUntil',${access.readExpires ?? '9007199254740991'},'_writeUntil',${access.writeExpires ?? '9007199254740991'}))
            FROM spaces s WHERE s.id IN (
              SELECT owned.id FROM spaces owned WHERE owned.account_id=c.account_id
              UNION SELECT managed.id FROM active_memberships member
                JOIN spaces managed ON managed.organization_id=member.organization_id
                WHERE member.account_id=c.account_id
              ${access.additionalCandidates ? `UNION ${access.additionalCandidates}` : ''}
            ) AND (${access.read})) AS spaces,
          (SELECT json_group_array(json_object('id',m.organization_id,'name',coalesce(o.name,'Organization'),
            'role',m.role,'membershipId',m.id,'_expiresAt',m.expires_at,
            '_parentExpiresAt',coalesce((SELECT MAX(parent.expires_at) FROM active_memberships parent WHERE parent.account_id=c.account_id AND parent.organization_id=h.parent_organization_id),0),
            'parentId',CASE WHEN EXISTS(
              SELECT 1 FROM active_memberships parent WHERE parent.account_id=c.account_id
                AND parent.organization_id=h.parent_organization_id AND parent.expires_at>${sqlNow()})
              THEN h.parent_organization_id ELSE NULL END)) FROM active_memberships m
            LEFT JOIN workspace_organization_metadata o ON o.organization_id=m.organization_id
            LEFT JOIN organization_hierarchy h ON h.organization_id=m.organization_id
            WHERE m.account_id=c.account_id AND m.expires_at>${sqlNow()}) AS organizations,
          (SELECT json_group_array(json_object('id',k.id,'label',coalesce(meta.label,'API key'),'kind',k.kind,
            'organizationId',km.organization_id,'permission',k.permission,'expiresAt',k.expires_at,'revokedAt',k.revoked_at,
            '_authorityExpiresAt',CASE WHEN k.account_id=c.account_id THEN 9007199254740991 ELSE coalesce((SELECT MAX(admin.expires_at)
              FROM active_memberships admin WHERE admin.account_id=c.account_id AND admin.organization_id=km.organization_id AND admin.role IN ('owner','admin')),0) END))
            FROM credentials k LEFT JOIN workspace_key_metadata meta ON meta.credential_id=k.id
            LEFT JOIN memberships km ON km.id=k.membership_id AND km.account_id=k.account_id AND km.email_id=k.email_id
            WHERE k.id IN (
              SELECT owned.id FROM credentials owned WHERE owned.account_id=c.account_id AND owned.kind IN ('personal_key','api_key')
              UNION SELECT organization_key.id FROM active_memberships admin
                CROSS JOIN memberships member ON member.organization_id=admin.organization_id
                CROSS JOIN credentials organization_key ON organization_key.membership_id=member.id
                  AND organization_key.account_id=member.account_id AND organization_key.email_id=member.email_id
                WHERE admin.account_id=c.account_id AND admin.role IN ('owner','admin') AND organization_key.kind='api_key'
            ) AND k.kind IN ('personal_key','api_key') AND (k.account_id=c.account_id OR EXISTS(
              SELECT 1 FROM active_memberships admin WHERE admin.account_id=c.account_id
                AND admin.organization_id=km.organization_id AND admin.expires_at>${sqlNow()} AND admin.role IN ('owner','admin')))) AS keys
        FROM active_credentials c WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE}`)
        .bind(...access.writeValues, ...access.readValues, at, at, at, hash, at).first<{ accountId: string; credentialExpiresAt: number; emails: string; spaces: string; organizations: string; keys: string }>();
      const checkedAt = this.now();
      if (!result || result.credentialExpiresAt <= checkedAt) throw new WorkspaceError(401, 'unauthorized');
      const spaces: (Omit<WorkspaceSnapshot['spaces'][number], 'canWrite'> & { canWrite: number; _readUntil: number; _writeUntil: number })[] = JSON.parse(result.spaces);
      const organizations: (WorkspaceSnapshot['organizations'][number] & { _expiresAt: number; _parentExpiresAt: number })[] = JSON.parse(result.organizations);
      const keys: (WorkspaceSnapshot['keys'][number] & { _authorityExpiresAt: number })[] = JSON.parse(result.keys);
      return { account: { id: result.accountId, emails: JSON.parse(result.emails) },
        spaces: spaces.flatMap(({ _readUntil, _writeUntil, ...space }) => _readUntil <= checkedAt ? [] : [{ ...space, canWrite: space.canWrite === 1 && _writeUntil > checkedAt }]),
        organizations: organizations.flatMap(({ _expiresAt, _parentExpiresAt, ...org }) => _expiresAt <= checkedAt ? [] : [{ ...org, parentId: _parentExpiresAt > checkedAt ? org.parentId : null }]),
        keys: keys.flatMap(({ _authorityExpiresAt, ...key }) => _authorityExpiresAt <= checkedAt ? [] : [key]) };
    });
  }

  async createOrganization(token: string, input: { name: string; emailId: string; parentOrganizationId?: string }): Promise<{ id: string; name: string; spaceId: string }> {
    return this.safe(async () => {
      const hash = await hashToken(token); const at = this.now();
      const orgName = name(input.name); const emailId = identifier(input.emailId);
      const parentId = input.parentOrganizationId === undefined ? null : identifier(input.parentOrganizationId);
      const id = crypto.randomUUID(); const spaceId = crypto.randomUUID();
      const membershipId = crypto.randomUUID();
      let sql: string, values: SqlValue[];
      if (parentId === null) {
        sql = `INSERT INTO workspace_organization_creations(id,name,actor_credential_id,email_id,membership_id,space_id,created_at)
          SELECT ?,?,c.id,e.id,?,?,? FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id
          WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE} AND e.id=? AND e.revoked_at IS NULL`;
        values = [id, orgName, membershipId, spaceId, at, hash, at, emailId];
      } else {
        // One command atomically creates the child, owner membership, default
        // Space and immutable edge. Parent authority is used only at creation.
        sql = `INSERT INTO workspace_child_organization_creations
          (id,parent_organization_id,name,actor_credential_id,email_id,membership_id,space_id,created_at)
          SELECT ?,m.organization_id,?,c.id,e.id,?,?,? FROM active_credentials c
          JOIN active_memberships m ON m.account_id=c.account_id
          JOIN account_emails e ON e.account_id=c.account_id
          WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE}
            AND m.organization_id=? AND m.expires_at>${sqlNow()} AND m.role IN ('owner','admin')
            AND e.id=? AND e.revoked_at IS NULL`;
        values = [id, orgName, membershipId, spaceId, at, hash, at, parentId, at, emailId];
      }
      if (this.capture) {
        const result = await this.capture.workspaceBootstrap(this.db, { commandType:parentId === null ? 'organization-create' : 'organization-child-create', receiptId:id, emailId, membershipId, spaceId }, sql, values);
        if (!result.success || !Number.isSafeInteger(result.meta.changes) || (result.meta.changes ?? 0) < 1) throw new WorkspaceError();
      } else await this.write(sql, values);
      return { id, name: orgName, spaceId };
    });
  }

  async createInvite(token: string, orgId: string, input: { email: string; role: 'member' | 'admin' }): Promise<{ id: string; token: string; expiresAt: number }> {
    return this.safe(async () => {
      const hash = await hashToken(token);
      const organizationId = identifier(orgId);
      if (input.role !== 'member' && input.role !== 'admin') invalid();
      const { address } = canonicalEmail(input.email);
      const id = crypto.randomUUID(); const proof = randomToken(); const proofHash = await hashToken(proof);
      const at = this.now();
      const expiresAt = at + 3 * DAY;
      await this.write(`INSERT INTO workspace_invitations(id,organization_id,address,role,token_digest,
        creator_membership_id,actor_credential_id,created_at,expires_at)
        SELECT ?,m.organization_id,?,?,?,m.id,c.id,?,? FROM active_credentials c
        JOIN active_memberships m ON m.account_id=c.account_id
        WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE}
          AND m.organization_id=? AND m.expires_at>${sqlNow()} AND m.role IN ('owner','admin')
          AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=?)`,
        [id, address, input.role, proofHash, at, expiresAt, hash, at, organizationId, at, address]);
      return { id, token: proof, expiresAt };
    });
  }

  async acceptInvite(token: string, inviteToken: string): Promise<{ organizationId: string }> {
    return this.safe(async () => {
      const hash = await hashToken(token); const inviteHash = await hashToken(inviteToken); const at = this.now();
      const id = crypto.randomUUID();
      const sql = `INSERT INTO workspace_invitation_acceptances(id,invitation_id,actor_credential_id,email_id,created_at)
        SELECT ?,i.id,c.id,e.id,? FROM workspace_invitations i
        JOIN active_memberships creator ON creator.id=i.creator_membership_id AND creator.organization_id=i.organization_id
        JOIN active_credentials c ON c.token_digest=?
        JOIN account_emails e ON e.account_id=c.account_id AND e.address=i.address
        WHERE i.token_digest=? AND i.accepted_at IS NULL AND i.expires_at>${sqlNow()}
          AND c.expires_at>${sqlNow()} AND ${INTERACTIVE} AND e.revoked_at IS NULL
          AND creator.expires_at>${sqlNow()} AND creator.role IN ('owner','admin')
          AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=i.address)
          AND NOT EXISTS(SELECT 1 FROM memberships existing WHERE existing.organization_id=i.organization_id
            AND existing.account_id=c.account_id AND existing.revoked_at IS NULL)`;
      const values = [id, at, hash, inviteHash, at, at, at];
      if (this.capture) {
        const result = await this.capture.workspaceCommand(this.db, { commandType:'invite-accept', receiptId:id, entityId:id, actorDigest:hash, invitationDigest:inviteHash, commandAt:at }, sql, values);
        if (!result.success || !Number.isSafeInteger(result.meta.changes) || (result.meta.changes ?? 0) < 1) throw new WorkspaceError();
      } else await this.write(sql, values);
      const result = await this.db.withSession('first-primary').prepare(`
        SELECT organization_id AS organizationId FROM memberships WHERE id=?`).bind(id).first<{ organizationId: string }>();
      if (!result) throw new WorkspaceError();
      return { organizationId: result.organizationId };
    });
  }

  async listMembers(token: string, orgId: string): Promise<{ id: string; accountId: string; email: string; role: string; expiresAt: number }[]> {
    return this.safe(async () => {
      const hash = await hashToken(token); const at = this.now(); const organizationId = identifier(orgId);
      const rows = await this.db.withSession('first-primary').prepare(`
        SELECT target.id,target.account_id AS accountId,e.address AS email,target.role,target.expires_at AS expiresAt,
          c.expires_at AS credentialExpiresAt,actor.expires_at AS authorityExpiresAt
        FROM active_credentials c JOIN active_memberships actor ON actor.account_id=c.account_id
        LEFT JOIN memberships target ON target.organization_id=actor.organization_id AND target.expires_at>${sqlNow()} AND target.revoked_at IS NULL
          AND EXISTS(SELECT 1 FROM account_emails te JOIN accounts ta ON ta.id=te.account_id AND ta.disabled_at IS NULL
            WHERE te.id=target.email_id AND te.account_id=target.account_id AND te.revoked_at IS NULL)
        LEFT JOIN account_emails e ON e.id=target.email_id AND e.account_id=target.account_id AND e.revoked_at IS NULL
        WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE}
          AND actor.organization_id=? AND actor.expires_at>${sqlNow()} AND actor.role IN ('owner','admin')
        ORDER BY CASE target.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,e.address,target.id`)
        .bind(at, hash, at, organizationId, at).all<{
          id: string | null; accountId: string; email: string; role: string; expiresAt: number; credentialExpiresAt: number; authorityExpiresAt: number;
        }>();
      // An authorized empty directory has a LEFT JOIN sentinel. No rows means
      // authority failed; never reveal whether a foreign organization exists.
      const checkedAt = this.now();
      if (!rows.success || !rows.results.length || Math.min(rows.results[0]!.credentialExpiresAt, rows.results[0]!.authorityExpiresAt) <= checkedAt) throw new WorkspaceError();
      return rows.results.flatMap(({ credentialExpiresAt, authorityExpiresAt, ...row }) => row.id === null || row.expiresAt <= checkedAt ? [] : [{ ...row, id: row.id }]);
    });
  }

  async revokeMembership(token: string, orgId: string, membershipId: string): Promise<void> {
    return this.safe(async () => {
      const hash = await hashToken(token); const at = this.now();
      const organizationId = identifier(orgId); const targetId = identifier(membershipId);
      const receiptId = crypto.randomUUID();
      const sql = `INSERT INTO workspace_membership_revocations(id,actor_credential_id,organization_id,membership_id,created_at)
        SELECT ?,c.id,actor.organization_id,target.id,? FROM active_credentials c
        JOIN active_memberships actor ON actor.account_id=c.account_id AND actor.organization_id=?
        JOIN memberships target ON target.id=? AND target.organization_id=actor.organization_id
        WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE}
          AND actor.expires_at>${sqlNow()} AND actor.role IN ('owner','admin') AND target.revoked_at IS NULL
          AND (target.role<>'owner' OR (actor.role='owner' AND EXISTS(SELECT 1 FROM active_memberships other
            WHERE other.organization_id=actor.organization_id AND other.role='owner' AND other.expires_at>${sqlNow()} AND other.id<>target.id)))`;
      const values = [receiptId, at, organizationId, targetId, hash, at, at, at];
      if (this.capture) {
        const result = await this.capture.workspaceCommand(this.db, { commandType:'membership-revoke', receiptId, entityId:targetId, actorDigest:hash, organizationId, commandAt:at }, sql, values);
        if (!result.success || !Number.isSafeInteger(result.meta.changes) || (result.meta.changes ?? 0) < 1) throw new WorkspaceError();
      } else await this.write(sql, values);
    });
  }

  async issueKey(token: string, input: { label: string; organizationId?: string; permission: 'read' | 'write'; expiresInDays: number }): Promise<{ id: string; token: string; expiresAt: number }> {
    return this.safe(async () => {
      const hash = await hashToken(token);
      const label = name(input.label); const granted = permission(input.permission);
      const organizationId = input.organizationId === undefined ? null : identifier(input.organizationId);
      if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 90) invalid();
      const id = crypto.randomUUID(); const proof = randomToken(); const proofHash = await hashToken(proof);
      const at = this.now(); const expiresAt = at + input.expiresInDays * DAY;
      const sql = `INSERT INTO workspace_key_issuances(id,actor_credential_id,organization_id,label,permission,token_digest,created_at,expires_at)
        SELECT ?,c.id,?,?,?,?,?,? FROM active_credentials c
        WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE}
          AND (?='read' OR c.permission='write')
          AND (? IS NULL OR EXISTS(SELECT 1 FROM active_memberships m
            WHERE m.account_id=c.account_id AND m.organization_id=? AND m.expires_at>${sqlNow()}
              AND (?='read' OR m.role IN ('owner','admin'))))`;
      const values = [id, organizationId, label, granted, proofHash, at, expiresAt, hash, at, granted, organizationId, organizationId, at, granted];
      if (this.capture) {
        const result = await this.capture.workspaceCommand(this.db, { commandType:'workspace-key-issue', receiptId:id, entityId:id, actorDigest:hash, organizationId, commandAt:at }, sql, values);
        if (!result.success || !Number.isSafeInteger(result.meta.changes) || (result.meta.changes ?? 0) < 1) throw new WorkspaceError();
      } else await this.write(sql, values);
      return { id, token: proof, expiresAt };
    });
  }

  async revokeKey(token: string, keyId: string): Promise<void> {
    return this.safe(async () => {
      const hash = await hashToken(token); const at = this.now(); const id = identifier(keyId);
      const receiptId = crypto.randomUUID();
      const sql = `INSERT INTO workspace_key_revocations(id,actor_credential_id,credential_id,created_at)
        SELECT ?,c.id,target.id,? FROM active_credentials c JOIN credentials target ON target.id=?
        LEFT JOIN memberships target_member ON target_member.id=target.membership_id
        WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE}
          AND target.kind IN ('personal_key','api_key') AND target.revoked_at IS NULL
          AND (target.account_id=c.account_id OR EXISTS(SELECT 1 FROM active_memberships actor
            WHERE actor.account_id=c.account_id AND actor.organization_id=target_member.organization_id
              AND actor.expires_at>${sqlNow()} AND actor.role IN ('owner','admin')))`;
      const values = [receiptId, at, id, hash, at, at];
      if (this.capture) {
        const result = await this.capture.workspaceCommand(this.db, { commandType:'workspace-key-revoke', receiptId, entityId:id, actorDigest:hash, commandAt:at }, sql, values);
        if (!result.success || !Number.isSafeInteger(result.meta.changes) || (result.meta.changes ?? 0) < 1) throw new WorkspaceError();
      } else await this.write(sql, values);
    });
  }
}

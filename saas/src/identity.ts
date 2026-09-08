/**
 * Internal identity service. No public HTTP routes or central-auth changes.
 * D1 is a storage adapter, not the identity model. Use fresh primary reads for
 * every authorization; never authorize from a JWT email/membership snapshot.
 */
export type SqlValue = string | number | null;
export interface PreparedStatement {
  bind(...values: SqlValue[]): PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ success: boolean; meta: { changes?: number } }>;
}
export interface IdentityDatabase {
  prepare(sql: string): PreparedStatement;
  withSession(constraint: 'first-primary'): { prepare(sql: string): PreparedStatement };
}
export interface EmailDelivery {
  address: string;
  challengeId: string;
  proofToken: string;
  expiresAt: number;
}
export interface Account {
  id: string;
  emails: { id: string; address: string }[];
}
export interface OrganizationAuthorization {
  accountId: string;
  membershipId: string;
  organizationId: string;
  role: 'owner' | 'admin' | 'member';
}
export class IdentityDenied extends Error {
  constructor() { super('Identity operation denied'); this.name = 'IdentityDenied'; }
}

/** Deliberate v1 policy: ASCII, case-insensitive mailboxes; no plus/dot folding. */
export function canonicalEmail(input: string): { address: string; domain: string } {
  if (typeof input !== 'string') throw new IdentityDenied();
  const address = input.trim().toLowerCase();
  const parts = address.split('@');
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  if (address.length > 254 || parts.length !== 2 || local.length > 64 ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      domain.length > 253 || !domain.includes('.') ||
      !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new IdentityDenied();
  }
  return { address, domain };
}

/** Only digests enter the database. Tokens must contain >=256 bits of entropy. */
export async function digestToken(token: string): Promise<string> {
  if (typeof token !== 'string' || token.length < 32 || token.length > 8192 || /\s/.test(token)) throw new IdentityDenied();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function randomProof(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new IdentityDenied();
  return value;
}

const RECENT_SESSION = `c.kind='session' AND c.membership_id IS NULL AND c.reauthenticated_at BETWEEN ? AND ?`;
const REAUTH_WINDOW_MS = 5 * 60 * 1000;

export class IdentityService {
  private readonly db: IdentityDatabase;
  private readonly clock: () => number;
  constructor(db: IdentityDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }
  private now(): number {
    const at = this.clock();
    if (!Number.isSafeInteger(at) || at < 0) throw new IdentityDenied();
    return at;
  }
  private async write(sql: string, values: SqlValue[]): Promise<void> {
    // Authorization predicates are INSIDE the mutating SQL, not a stale read
    // followed by an unconditional update. SQL errors also propagate closed.
    const r = await this.db.prepare(sql).bind(...values).run();
    // Adapter change counts may include trigger side effects. A zero-row
    // conditional insert always means the authority/proof predicate failed.
    if (!r.success || !Number.isSafeInteger(r.meta.changes) || (r.meta.changes ?? 0) < 1) throw new IdentityDenied();
  }

  async getAccount(token: string): Promise<Account> {
    const hash = await digestToken(token);
    const at = this.now();
    const r = await this.db.withSession('first-primary').prepare(`
      SELECT c.account_id AS accountId,e.id AS emailId,e.address
      FROM active_credentials c LEFT JOIN account_emails e
        ON e.account_id=c.account_id AND e.revoked_at IS NULL
      WHERE c.token_digest=? AND c.expires_at>? AND c.kind='session' AND c.membership_id IS NULL`).bind(hash, at)
      .all<{ accountId: string; emailId: string | null; address: string | null }>();
    if (!r.success || !r.results.length) throw new IdentityDenied();
    return { id: r.results[0]!.accountId, emails: r.results.flatMap(row =>
      row.emailId && row.address ? [{ id: row.emailId, address: row.address }] : []) };
  }

  async authorizeOrganization(token: string, organizationId: string): Promise<OrganizationAuthorization> {
    const hash = await digestToken(token);
    const at = this.now();
    const r = await this.db.withSession('first-primary').prepare(`
      SELECT c.account_id AS accountId,m.id AS membershipId,m.organization_id AS organizationId,m.role
      FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id
      WHERE c.token_digest=? AND c.expires_at>? AND m.expires_at>? AND m.organization_id=?
        AND ((c.kind='session' AND c.membership_id IS NULL) OR (c.kind='api_key' AND c.membership_id=m.id))`)
      .bind(hash, at, at, identifier(organizationId)).first<OrganizationAuthorization>();
    if (!r) throw new IdentityDenied();
    return r;
  }

  /**
   * `deliver` is an injected trusted SERVER mail sender. Do not return its
   * payload to the caller or log it. This method returns only the challenge ID.
   * A recent interactive reauthentication is enforced here; rate limiting and
   * real delivery remain launch gates. Never refresh reauthenticated_at merely
   * because a token is refreshed or used.
   */
  async beginEmailLink(token: string, email: string, deliver: (mail: EmailDelivery) => Promise<void>): Promise<string> {
    const hash = await digestToken(token);
    const { address, domain } = canonicalEmail(email);
    const id = crypto.randomUUID();
    const proofToken = randomProof();
    const proofHash = await digestToken(proofToken);
    const at = this.now();
    const expiresAt = at + 10 * 60 * 1000;
    await this.write(`INSERT INTO email_challenges(id,account_id,address,domain,token_digest,expires_at)
      SELECT ?,c.account_id,?,?,?,? FROM active_credentials c
      WHERE c.token_digest=? AND c.expires_at>? AND ${RECENT_SESSION}
        AND NOT EXISTS (SELECT 1 FROM email_blocks b WHERE b.address=?)`,
      [id, address, domain, proofHash, expiresAt, hash, at, at - REAUTH_WINDOW_MS, at, address]);
    try {
      await deliver({ address, challengeId: id, proofToken, expiresAt });
    } catch (error) {
      await this.db.prepare('UPDATE email_challenges SET invalidated_at=? WHERE id=? AND used_at IS NULL').bind(this.now(), id).run();
      throw error;
    }
    return id;
  }

  async completeEmailLink(token: string, challengeId: string, proofToken: string): Promise<string> {
    const hash = await digestToken(token);
    const proofHash = await digestToken(proofToken);
    const id = crypto.randomUUID();
    const at = this.now();
    await this.write(`INSERT INTO email_consumptions(id,challenge_id,actor_credential_id,created_at)
      SELECT ?,p.id,c.id,? FROM email_challenges p JOIN active_credentials c ON c.account_id=p.account_id
      WHERE c.token_digest=? AND c.expires_at>? AND ${RECENT_SESSION}
        AND p.id=? AND p.token_digest=? AND p.expires_at>? AND p.used_at IS NULL AND p.invalidated_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM email_blocks b WHERE b.address=p.address)
        AND NOT EXISTS (SELECT 1 FROM account_emails e WHERE e.address=p.address AND e.revoked_at IS NULL)`,
      [id, at, hash, at, at - REAUTH_WINDOW_MS, at, identifier(challengeId), proofHash, at]);
    return id;
  }

  async unlinkEmail(token: string, emailId: string): Promise<void> {
    const hash = await digestToken(token);
    const at = this.now();
    await this.write(`INSERT INTO revocations(id,kind,actor_credential_id,email_id,created_at)
      SELECT ?,'self',c.id,e.id,? FROM active_credentials c
      JOIN account_emails e ON e.account_id=c.account_id
      WHERE c.token_digest=? AND c.expires_at>? AND ${RECENT_SESSION}
        AND e.id=? AND e.revoked_at IS NULL`,
      [crypto.randomUUID(), at, hash, at, at - REAUTH_WINDOW_MS, at, identifier(emailId)]);
  }

  /**
   * Revokes a service email claim, NOT the provider mailbox or personal account.
   * Exact verified domain + explicit active domain-manager delegation required.
   * May remove the last owner: recovery must not be a revocation bypass.
   */
  async revokeDomainEmail(token: string, domainId: string, email: string): Promise<void> {
    const hash = await digestToken(token);
    const { address, domain } = canonicalEmail(email);
    const at = this.now();
    await this.write(`INSERT INTO revocations(id,kind,actor_credential_id,domain_id,address,created_at)
      SELECT ?,'domain',c.id,d.id,?,? FROM active_credentials c
      JOIN active_memberships m ON m.account_id=c.account_id
      JOIN domain_managers g ON g.membership_id=m.id AND g.revoked_at IS NULL
      JOIN domains d ON d.id=g.domain_id AND d.organization_id=m.organization_id
      WHERE c.token_digest=? AND c.expires_at>? AND d.id=? AND d.name=?
        AND d.revoked_at IS NULL AND d.verified_until>?
        AND m.expires_at>? AND m.role IN ('owner','admin') AND ${RECENT_SESSION}`,
      [crypto.randomUUID(), address, at, hash, at, identifier(domainId), domain, at, at, at - REAUTH_WINDOW_MS, at]);
  }
}

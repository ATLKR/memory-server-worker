import { z } from 'zod';
import { assertMedicalCloudflareConsent, cloudflareMedicalConsentSchema, medicalCloudflareConsentReferenceSchema,
  parseCloudflareMedicalConsent, revokeCloudflareMedicalConsent } from './consent.ts';
import type { CloudflareMedicalConsent } from './consent.ts';
import type { LedgerActorInput, LedgerAuthorityInput, LedgerConsumeInput, LedgerFinalizeInput, LedgerGrantInput,
  LedgerIssueInput, LedgerOrganizationInput, LedgerReceipt, LedgerRevokeInput, LedgerStorage, LedgerTicket,
  LedgerTicketInput, RoutingLedgerStub } from './ledger-types.ts';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000 - 60_000);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const organizationSchema = z.strictObject({ organizationId: identifier });
const actorFields = { organizationId: identifier, accountId: identifier, credentialId: identifier, spaceId: identifier,
  operation: z.enum(['memory_ingest', 'memory_search']), requestId: identifier };
const authorityFields = { ...actorFields, authorityExpiresAtMs: timestamp };
const grantSchema = z.strictObject({ organizationId: identifier, approvedBy: identifier, expectedVersion: version,
  grant: z.strictObject({ spaceScope: cloudflareMedicalConsentSchema.shape.spaceScope, scopes: cloudflareMedicalConsentSchema.shape.scopes,
    validFromMs: cloudflareMedicalConsentSchema.shape.validFromMs, expiresAtMs: cloudflareMedicalConsentSchema.shape.expiresAtMs,
    evidenceRef: cloudflareMedicalConsentSchema.shape.evidenceRef }) });
const revokeSchema = z.strictObject({ organizationId: identifier, approvedBy: identifier, expectedVersion: version });
const issueSchema = z.strictObject({ ...authorityFields, reference: medicalCloudflareConsentReferenceSchema.optional() });
const consumeSchema = z.strictObject({ ...authorityFields, receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  reference: medicalCloudflareConsentReferenceSchema, payloadHash: z.string().regex(/^[0-9a-f]{64}$/), operationId: identifier });
const finalizeSchema = z.strictObject({ ...actorFields, ticketId: identifier, state: z.enum(['accepted', 'unknown', 'read_failed']) });
const ticketSchema = z.strictObject({ ...authorityFields, ticketId: identifier, phase: z.enum(['dispatch', 'disclose']) });

const status: Readonly<Record<string, number>> = Object.freeze({
  routing_ledger_input_invalid: 400, routing_ledger_organization_mismatch: 403, routing_ledger_version_conflict: 409,
  routing_ledger_capacity_exceeded: 429, routing_ledger_receipt_invalid: 403, routing_ledger_operation_conflict: 409,
  routing_ledger_ticket_unavailable: 403, routing_ledger_transition_invalid: 409, routing_ledger_authority_expired: 403,
  routing_consent_unavailable: 403, routing_consent_scope_denied: 403, routing_consent_reference_mismatch: 403,
  routing_consent_context_invalid: 400, routing_consent_transition_invalid: 409,
});
export class RoutingLedgerError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: keyof typeof status) { super(code); this.name = 'RoutingLedgerError'; this.code = code; this.status = status[code] ?? 503; }
}
function reject(code: string): never { throw new RoutingLedgerError(code); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) reject('routing_ledger_input_invalid');
  return result.data;
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomReceipt(): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
const schema = `
CREATE TABLE IF NOT EXISTS ledger_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), organization_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL CHECK(schema_version=1));
CREATE TABLE IF NOT EXISTS ledger_current(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version>0), record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE IF NOT EXISTS ledger_audit(version INTEGER PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('grant','revoke')), actor_id TEXT NOT NULL, at_ms INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE IF NOT EXISTS ledger_receipts(hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, credential_id TEXT NOT NULL, space_id TEXT NOT NULL,
 operation TEXT NOT NULL, request_id TEXT NOT NULL, consent_id TEXT NOT NULL, consent_version INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL, consumed_at_ms INTEGER);
CREATE INDEX IF NOT EXISTS ledger_receipts_expiry ON ledger_receipts(expires_at_ms);
CREATE INDEX IF NOT EXISTS ledger_receipts_actor ON ledger_receipts(account_id,consumed_at_ms,expires_at_ms);
CREATE TABLE IF NOT EXISTS ledger_operations(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, credential_id TEXT NOT NULL, space_id TEXT NOT NULL,
 operation TEXT NOT NULL, operation_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 consent_id TEXT NOT NULL, consent_version INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('admitted','accepted','unknown','read_failed')),
 created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, period TEXT NOT NULL,
 UNIQUE(space_id,operation_id));
CREATE INDEX IF NOT EXISTS ledger_operations_period ON ledger_operations(period);
CREATE TRIGGER IF NOT EXISTS ledger_identity_no_update BEFORE UPDATE ON ledger_identity BEGIN SELECT RAISE(ABORT,'routing_ledger_organization_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS ledger_identity_no_delete BEFORE DELETE ON ledger_identity BEGIN SELECT RAISE(ABORT,'routing_ledger_organization_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS ledger_audit_no_update BEFORE UPDATE ON ledger_audit BEGIN SELECT RAISE(ABORT,'routing_ledger_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS ledger_audit_no_delete BEFORE DELETE ON ledger_audit BEGIN SELECT RAISE(ABORT,'routing_ledger_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS ledger_operations_no_delete BEFORE DELETE ON ledger_operations BEGIN SELECT RAISE(ABORT,'routing_ledger_transition_invalid'); END;
`;
type ReceiptRow = Record<string, string | number | null> & {
  hash: string; account_id: string; credential_id: string; space_id: string; operation: string; request_id: string;
  consent_id: string; consent_version: number; expires_at_ms: number; consumed_at_ms: number | null;
};
type TicketRow = Record<string, string | number | null> & {
  id: string; account_id: string; credential_id: string; space_id: string; operation: LedgerTicket['operation']; operation_id: string;
  request_id: string; payload_hash: string; consent_id: string; consent_version: number; state: LedgerTicket['state'];
  created_at_ms: number; updated_at_ms: number; expires_at_ms: number;
};

/** Private per-organization metadata only. No SQL/RPC method accepts raw content.
 * All SQL groups and cursor consumption are synchronous. Hashing happens before
 * the transaction; current server time/consent is re-read after hashing.
 * An external D1 credential check and this ledger are separate linearization
 * points. Callers must authenticate/revalidate themselves and check AbortSignal
 * before provider dispatch. A receipt is not a cached identity grant.
 */
export class ConsentLedger implements RoutingLedgerStub {
  private readonly storage: LedgerStorage;
  private readonly now: () => number;
  private readonly objectName?: string;
  constructor(storage: LedgerStorage, options: { now?: () => number; objectName?: string } = {}) {
    this.storage = storage; this.now = options.now ?? Date.now; this.objectName = options.objectName;
  }
  initialize(): void { this.storage.transactionSync(() => { this.storage.sql.exec(schema).toArray(); }); }
  private clock(): number { return parse(timestamp, this.now()); }
  private organization(organizationId: string): void {
    if (this.objectName !== undefined && this.objectName !== `organization:${organizationId}`) reject('routing_ledger_organization_mismatch');
    this.storage.sql.exec('INSERT INTO ledger_identity(singleton,organization_id,schema_version) VALUES(1,?,1) ON CONFLICT(singleton) DO NOTHING', organizationId).toArray();
    const row = this.storage.sql.exec<{ organization_id: string; schema_version: number }>('SELECT organization_id,schema_version FROM ledger_identity WHERE singleton=1').toArray()[0];
    if (!row || row.organization_id !== organizationId || row.schema_version !== 1) reject('routing_ledger_organization_mismatch');
  }
  private current(): CloudflareMedicalConsent | null {
    const row = this.storage.sql.exec<{ record: string }>('SELECT record FROM ledger_current WHERE singleton=1').toArray()[0];
    return row ? parseCloudflareMedicalConsent(JSON.parse(row.record)) : null;
  }
  private authority(input: LedgerAuthorityInput, now: number): void {
    if (input.authorityExpiresAtMs <= now) reject('routing_ledger_authority_expired');
  }
  private consent(input: LedgerAuthorityInput, now: number, reference?: { consentId: string; version: number }) {
    this.authority(input, now);
    try { return assertMedicalCloudflareConsent({ organizationId: input.organizationId, accountId: input.accountId, spaceId: input.spaceId,
      membership: { organizationId: input.organizationId, accountId: input.accountId, status: 'active' }, spaceAuthorized: true,
      operation: input.operation, record: this.current(), now, ...(reference ? { reference } : {}) }); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (Object.hasOwn(status, code)) throw new RoutingLedgerError(code);
      throw error;
    }
  }
  private save(record: CloudflareMedicalConsent, actor: string, action: 'grant' | 'revoke', now: number): void {
    const json = JSON.stringify(record);
    this.storage.sql.exec('INSERT INTO ledger_current(singleton,version,record) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,record=excluded.record', record.version, json).toArray();
    this.storage.sql.exec('INSERT INTO ledger_audit(version,action,actor_id,at_ms,record) VALUES(?,?,?,?,?)', record.version, action, actor, now, json).toArray();
  }
  async get(input: LedgerOrganizationInput): Promise<CloudflareMedicalConsent | null> {
    const value = parse(organizationSchema, input);
    return this.storage.transactionSync(() => { this.organization(value.organizationId); return this.current(); });
  }
  async grant(input: LedgerGrantInput): Promise<CloudflareMedicalConsent> {
    const value = parse(grantSchema, input);
    return this.storage.transactionSync(() => {
      this.organization(value.organizationId);
      const now = this.clock(), previous = this.current();
      if ((previous?.version ?? 0) !== value.expectedVersion) reject('routing_ledger_version_conflict');
      const record = parseCloudflareMedicalConsent({ ...value.grant, id: previous?.status === 'granted' ? previous.id : crypto.randomUUID(),
        version: value.expectedVersion + 1, organizationId: value.organizationId, provider: 'cloudflare-agent-memory', classification: 'medical',
        status: 'granted', approvedBy: value.approvedBy });
      this.save(record, value.approvedBy, 'grant', now); return record;
    });
  }
  async revoke(input: LedgerRevokeInput): Promise<CloudflareMedicalConsent> {
    const value = parse(revokeSchema, input);
    return this.storage.transactionSync(() => {
      this.organization(value.organizationId);
      const now = this.clock(), previous = this.current();
      if (!previous || previous.version !== value.expectedVersion) reject('routing_ledger_version_conflict');
      if (previous.status === 'revoked') return previous;
      const record = revokeCloudflareMedicalConsent(previous, { now, expectedVersion: value.expectedVersion });
      this.save(record, value.approvedBy, 'revoke', now); return record;
    });
  }
  async issue(input: LedgerIssueInput): Promise<LedgerReceipt> {
    const value = parse(issueSchema, input), receipt = randomReceipt(), hash = await digest(receipt);
    return this.storage.transactionSync(() => {
      this.organization(value.organizationId);
      const now = this.clock(), permit = this.consent(value, now, value.reference);
      this.storage.sql.exec('DELETE FROM ledger_receipts WHERE expires_at_ms<=?', now).toArray();
      const actor = this.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ledger_receipts WHERE account_id=? AND consumed_at_ms IS NULL', value.accountId).toArray()[0]!.n;
      const all = this.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ledger_receipts').toArray()[0]!.n;
      if (actor >= 100 || all >= 10000) reject('routing_ledger_capacity_exceeded');
      const expiresAtMs = Math.min(now + 60000, permit.validUntilMs, value.authorityExpiresAtMs);
      this.storage.sql.exec('INSERT INTO ledger_receipts(hash,account_id,credential_id,space_id,operation,request_id,consent_id,consent_version,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?)',
        hash, value.accountId, value.credentialId, value.spaceId, value.operation, value.requestId, permit.consentId, permit.version, expiresAtMs).toArray();
      return Object.freeze({ version: 1, allowed: true, requestId: value.requestId, spaceId: value.spaceId,
        consentId: permit.consentId, consentVersion: permit.version, operation: value.operation, expiresAtMs, receipt });
    });
  }
  private bound(row: ReceiptRow | TicketRow, value: LedgerActorInput): boolean {
    return row.account_id === value.accountId && row.credential_id === value.credentialId && row.space_id === value.spaceId
      && row.operation === value.operation && row.request_id === value.requestId;
  }
  private ticket(row: TicketRow, organizationId: string, dispatch = false): LedgerTicket {
    return Object.freeze({ id: row.id, organizationId, accountId: row.account_id, credentialId: row.credential_id, spaceId: row.space_id,
      operation: row.operation, operationId: row.operation_id, requestId: row.request_id, state: row.state,
      consentId: row.consent_id, consentVersion: row.consent_version, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms,
      expiresAtMs: row.expires_at_ms, dispatch });
  }
  async consume(input: LedgerConsumeInput): Promise<LedgerTicket> {
    const value = parse(consumeSchema, input), hash = await digest(value.receipt);
    return this.storage.transactionSync(() => {
      this.organization(value.organizationId);
      const now = this.clock(), permit = this.consent(value, now, value.reference);
      const receipt = this.storage.sql.exec<ReceiptRow>('SELECT * FROM ledger_receipts WHERE hash=?', hash).toArray()[0];
      if (!receipt || !this.bound(receipt, value) || receipt.consumed_at_ms !== null || receipt.expires_at_ms <= now
        || receipt.consent_id !== permit.consentId || receipt.consent_version !== permit.version) reject('routing_ledger_receipt_invalid');
      const existing = this.storage.sql.exec<TicketRow>('SELECT * FROM ledger_operations WHERE space_id=? AND operation_id=?', value.spaceId, value.operationId).toArray()[0];
      if (existing && (existing.payload_hash !== value.payloadHash || existing.account_id !== value.accountId
        || existing.credential_id !== value.credentialId || existing.operation !== value.operation)) reject('routing_ledger_operation_conflict');
      if (!existing) {
        const period = new Date(now).toISOString().slice(0, 7);
        if (this.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ledger_operations WHERE period=?', period).toArray()[0]!.n >= 10000) reject('routing_ledger_capacity_exceeded');
        const id = crypto.randomUUID(), expires = Math.min(receipt.expires_at_ms, permit.validUntilMs, value.authorityExpiresAtMs);
        this.storage.sql.exec(`INSERT INTO ledger_operations(id,account_id,credential_id,space_id,operation,operation_id,request_id,payload_hash,
          consent_id,consent_version,state,created_at_ms,updated_at_ms,expires_at_ms,period) VALUES(?,?,?,?,?,?,?,?,?,?,'admitted',?,?,?,?)`,
          id, value.accountId, value.credentialId, value.spaceId, value.operation, value.operationId, value.requestId, value.payloadHash,
          permit.consentId, permit.version, now, now, expires, period).toArray();
      }
      this.storage.sql.exec('UPDATE ledger_receipts SET consumed_at_ms=? WHERE hash=?', now, hash).toArray();
      const row = existing ?? this.storage.sql.exec<TicketRow>('SELECT * FROM ledger_operations WHERE space_id=? AND operation_id=?', value.spaceId, value.operationId).toArray()[0]!;
      return this.ticket(row, value.organizationId, !existing);
    });
  }
  private loadTicket(value: LedgerActorInput & { ticketId: string }): TicketRow {
    const row = this.storage.sql.exec<TicketRow>('SELECT * FROM ledger_operations WHERE id=?', value.ticketId).toArray()[0];
    if (!row || !this.bound(row, value)) reject('routing_ledger_ticket_unavailable');
    return row;
  }
  async finalize(input: LedgerFinalizeInput): Promise<LedgerTicket> {
    const value = parse(finalizeSchema, input);
    return this.storage.transactionSync(() => {
      this.organization(value.organizationId);
      const now = this.clock(), row = this.loadTicket(value);
      if (value.state === 'read_failed' && row.operation !== 'memory_search') reject('routing_ledger_transition_invalid');
      if (row.state === value.state) return this.ticket(row, value.organizationId);
      if (row.state !== 'admitted') reject('routing_ledger_transition_invalid');
      this.storage.sql.exec('UPDATE ledger_operations SET state=?,updated_at_ms=? WHERE id=?', value.state, now, row.id).toArray();
      return this.ticket({ ...row, state: value.state, updated_at_ms: now }, value.organizationId);
    });
  }
  async checkTicket(input: LedgerTicketInput): Promise<LedgerTicket> {
    const value = parse(ticketSchema, input);
    return this.storage.transactionSync(() => {
      this.organization(value.organizationId);
      const now = this.clock(), row = this.loadTicket(value);
      this.consent(value, now, { consentId: row.consent_id, version: row.consent_version });
      if (row.expires_at_ms <= now || row.state !== (value.phase === 'dispatch' ? 'admitted' : 'accepted')) reject('routing_ledger_ticket_unavailable');
      return this.ticket(row, value.organizationId);
    });
  }
}

import { z } from 'zod';
import type { GeneralActor, GeneralAdmitInput, GeneralCheckInput, GeneralFinalizeInput, GeneralIdentity,
  GeneralRetireInput, GeneralRetirement, GeneralSpaceStub, GeneralTicket, GeneralUsage, LedgerStorage } from './general-types.ts';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
// Bound dates to four-digit UTC years so monthly accounting has one canonical key.
const timestamp = z.number().int().min(0).max(253_402_300_739_999);
const identitySchema = z.strictObject({ spaceId: identifier,
  owner: z.strictObject({ kind: z.enum(['account', 'organization']), id: identifier }),
  provider: z.strictObject({ accountId: identifier, namespace: identifier }) });
const actorSchema = z.strictObject({ accountId: identifier, credentialId: identifier });
const operationSchema = z.enum(['memory_ingest', 'memory_search']);
const usageSchema = z.strictObject({ inputBytes: z.number().int().min(0).max(2 * 1024 * 1024),
  messageCount: z.number().int().min(0).max(500) });
const stateSchema = z.enum(['accepted', 'unknown', 'read_failed', 'not_dispatched']);
const operationFields = { identity: identitySchema, actor: actorSchema, operationId: identifier,
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/), authorityExpiresAtMs: timestamp };
const admitSchema = z.strictObject({ ...operationFields, operation: operationSchema, usage: usageSchema }).refine(value =>
  value.operation === 'memory_search' ? value.usage.messageCount === 0 : value.usage.messageCount > 0);
const retireSchema = z.strictObject(operationFields);
const checkSchema = z.strictObject({ identity: identitySchema, actor: actorSchema, ticketId: identifier,
  authorityExpiresAtMs: timestamp, phase: z.enum(['dispatch', 'disclose']) });
const finalizeSchema = z.strictObject({ identity: identitySchema, actor: actorSchema, ticketId: identifier, state: stateSchema });
const usageInputSchema = z.strictObject({ identity: identitySchema });
const pendingSchema = z.strictObject({ identity: identitySchema, limit: z.number().int().min(1).max(100) });
const finishRetirementSchema = z.strictObject({ identity: identitySchema, retirementId: identifier,
  state: z.enum(['acknowledged', 'unknown']) });
const statuses = Object.freeze({ routing_space_input_invalid: 400, routing_space_identity_mismatch: 403,
  routing_space_authority_expired: 403, routing_space_operation_conflict: 409, routing_space_ticket_unavailable: 403,
  routing_space_transition_invalid: 409, routing_space_capacity_exceeded: 429, routing_space_retirement_unavailable: 404,
  routing_space_retirement_inflight: 409 });
export class GeneralSpaceLedgerError extends Error {
  readonly code: keyof typeof statuses;
  readonly status: number;
  constructor(code: keyof typeof statuses) { super(code); this.name = 'GeneralSpaceLedgerError'; this.code = code; this.status = statuses[code]; }
}
function reject(code: keyof typeof statuses): never { throw new GeneralSpaceLedgerError(code); }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) reject('routing_space_input_invalid');
  return result.data;
}
const schema = `
CREATE TABLE IF NOT EXISTS general_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), space_id TEXT NOT NULL,
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('account','organization')), owner_id TEXT NOT NULL,
 provider_account_id TEXT NOT NULL, provider_namespace TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1));
CREATE TABLE IF NOT EXISTS general_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL CHECK(generation>0));
CREATE TABLE IF NOT EXISTS general_operations(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, credential_id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('memory_ingest','memory_search')), operation_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0), state TEXT NOT NULL CHECK(state IN ('admitted','accepted','unknown','read_failed','not_dispatched')),
 created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, period TEXT NOT NULL,
 input_bytes INTEGER NOT NULL CHECK(input_bytes>=0 AND input_bytes<=2097152), message_count INTEGER NOT NULL CHECK(message_count>=0 AND message_count<=500));
CREATE INDEX IF NOT EXISTS general_operations_period ON general_operations(period);
CREATE INDEX IF NOT EXISTS general_operations_generation_state ON general_operations(generation,operation,state);
CREATE TABLE IF NOT EXISTS general_retirements(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, credential_id TEXT NOT NULL,
 operation_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, generation INTEGER NOT NULL UNIQUE CHECK(generation>0),
 next_generation INTEGER NOT NULL CHECK(next_generation=generation+1), state TEXT NOT NULL CHECK(state IN ('pending','acknowledged','unknown')),
 created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, period TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS general_retirements_pending ON general_retirements(state,generation);
CREATE INDEX IF NOT EXISTS general_retirements_period ON general_retirements(period);
CREATE TABLE IF NOT EXISTS general_reconciliation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 cursor_generation INTEGER NOT NULL CHECK(cursor_generation BETWEEN 0 AND 1000));
CREATE TRIGGER IF NOT EXISTS general_reconciliation_cursor_insert BEFORE INSERT ON general_reconciliation
 WHEN NEW.cursor_generation<>0 AND NOT EXISTS(SELECT 1 FROM general_retirements WHERE generation=NEW.cursor_generation)
 BEGIN SELECT RAISE(ABORT,'routing_space_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS general_reconciliation_cursor_update BEFORE UPDATE ON general_reconciliation
 WHEN NEW.singleton<>OLD.singleton OR (NEW.cursor_generation<>0 AND NOT EXISTS(SELECT 1 FROM general_retirements WHERE generation=NEW.cursor_generation))
 BEGIN SELECT RAISE(ABORT,'routing_space_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS general_reconciliation_no_delete BEFORE DELETE ON general_reconciliation
 BEGIN SELECT RAISE(ABORT,'routing_space_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS general_identity_no_update BEFORE UPDATE ON general_identity BEGIN SELECT RAISE(ABORT,'routing_space_identity_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS general_identity_no_delete BEFORE DELETE ON general_identity BEGIN SELECT RAISE(ABORT,'routing_space_identity_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS general_generation_monotonic BEFORE UPDATE ON general_generation
 WHEN NEW.singleton<>OLD.singleton OR NEW.generation<>OLD.generation+1 BEGIN SELECT RAISE(ABORT,'routing_space_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS general_generation_no_delete BEFORE DELETE ON general_generation BEGIN SELECT RAISE(ABORT,'routing_space_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS general_operations_no_delete BEFORE DELETE ON general_operations BEGIN SELECT RAISE(ABORT,'routing_space_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS general_operations_transition BEFORE UPDATE ON general_operations
 WHEN OLD.state<>'admitted' OR NEW.state='admitted' OR (NEW.state='read_failed' AND OLD.operation<>'memory_search')
 OR NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.credential_id<>OLD.credential_id OR NEW.operation<>OLD.operation
 OR NEW.operation_id<>OLD.operation_id OR NEW.payload_hash<>OLD.payload_hash OR NEW.generation<>OLD.generation
 OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.expires_at_ms<>OLD.expires_at_ms OR NEW.period<>OLD.period
 OR NEW.input_bytes<>OLD.input_bytes OR NEW.message_count<>OLD.message_count
 BEGIN SELECT RAISE(ABORT,'routing_space_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS general_retirements_no_delete BEFORE DELETE ON general_retirements BEGIN SELECT RAISE(ABORT,'routing_space_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS general_retirements_transition BEFORE UPDATE ON general_retirements
 WHEN OLD.state='acknowledged' OR NEW.state='pending' OR NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.credential_id<>OLD.credential_id
 OR NEW.operation_id<>OLD.operation_id OR NEW.payload_hash<>OLD.payload_hash OR NEW.generation<>OLD.generation
 OR NEW.next_generation<>OLD.next_generation OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.period<>OLD.period
 BEGIN SELECT RAISE(ABORT,'routing_space_transition_invalid'); END;
`;
type SqlRow = Record<string, string | number | null>;
type TicketRow = SqlRow & { id: string; account_id: string; credential_id: string; operation: GeneralTicket['operation'];
  operation_id: string; payload_hash: string; generation: number; state: GeneralTicket['state'];
  created_at_ms: number; expires_at_ms: number; input_bytes: number; message_count: number };
type RetirementRow = SqlRow & { id: string; account_id: string; credential_id: string; operation_id: string; payload_hash: string;
  generation: number; next_generation: number; state: GeneralRetirement['state']; created_at_ms: number };

/** Private metadata only. Every related SQL read and write executes in one
 * synchronous transaction. A dispatch flag is issued once; neither a check nor
 * replay authorizes another provider request. Current external ACL remains the
 * caller's responsibility before I/O and disclosure, independently of this DO.
 */
export class GeneralSpaceLedger implements GeneralSpaceStub {
  private readonly storage: LedgerStorage;
  private readonly now: () => number;
  private readonly objectName?: string;
  constructor(storage: LedgerStorage, options: { now?: () => number; objectName?: string } = {}) {
    this.storage = storage; this.now = options.now ?? Date.now; this.objectName = options.objectName;
  }
  initialize(): void { this.storage.transactionSync(() => { this.storage.sql.exec(schema).toArray(); }); }
  private clock(): number { return parse(timestamp, this.now()); }
  private bind(identity: GeneralIdentity): number {
    if (this.objectName !== undefined && this.objectName !== `space:${identity.spaceId}`) reject('routing_space_identity_mismatch');
    this.storage.sql.exec(`INSERT INTO general_identity(singleton,space_id,owner_kind,owner_id,provider_account_id,provider_namespace,schema_version)
      VALUES(1,?,?,?,?,?,1) ON CONFLICT(singleton) DO NOTHING`, identity.spaceId, identity.owner.kind, identity.owner.id,
      identity.provider.accountId, identity.provider.namespace).toArray();
    const row = this.storage.sql.exec('SELECT * FROM general_identity WHERE singleton=1').toArray()[0];
    if (!row || row.space_id !== identity.spaceId || row.owner_kind !== identity.owner.kind || row.owner_id !== identity.owner.id
      || row.provider_account_id !== identity.provider.accountId || row.provider_namespace !== identity.provider.namespace || row.schema_version !== 1) {
      reject('routing_space_identity_mismatch');
    }
    this.storage.sql.exec('INSERT INTO general_generation(singleton,generation) VALUES(1,1) ON CONFLICT(singleton) DO NOTHING').toArray();
    return this.storage.sql.exec<{ generation: number }>('SELECT generation FROM general_generation WHERE singleton=1').toArray()[0]!.generation;
  }
  private authority(expires: number, now: number): void { if (expires <= now) reject('routing_space_authority_expired'); }
  private operation(operationId: string): TicketRow | undefined {
    return this.storage.sql.exec<TicketRow>('SELECT * FROM general_operations WHERE operation_id=?', operationId).toArray()[0];
  }
  private retirement(operationId: string): RetirementRow | undefined {
    return this.storage.sql.exec<RetirementRow>('SELECT * FROM general_retirements WHERE operation_id=?', operationId).toArray()[0];
  }
  private sameActor(row: { account_id: string; credential_id: string }, actor: GeneralActor): boolean {
    return row.account_id === actor.accountId && row.credential_id === actor.credentialId;
  }
  private ticket(row: TicketRow, dispatch = false): GeneralTicket {
    return Object.freeze({ id: row.id, operationId: row.operation_id, operation: row.operation, generation: row.generation,
      state: row.state, createdAtMs: row.created_at_ms, expiresAtMs: row.expires_at_ms, dispatch });
  }
  private retired(row: RetirementRow, dispatch = false): GeneralRetirement {
    return Object.freeze({ id: row.id, generation: row.generation, nextGeneration: row.next_generation,
      createdAtMs: row.created_at_ms, state: row.state, dispatch, logicallyHidden: true, physicalPurgeVerified: false });
  }
  async admit(input: GeneralAdmitInput): Promise<GeneralTicket> {
    const value = parse(admitSchema, input);
    return this.storage.transactionSync(() => {
      const now = this.clock(); this.authority(value.authorityExpiresAtMs, now);
      const generation = this.bind(value.identity), existing = this.operation(value.operationId);
      if (this.retirement(value.operationId)) reject('routing_space_operation_conflict');
      if (existing) {
        if (!this.sameActor(existing, value.actor) || existing.operation !== value.operation || existing.payload_hash !== value.payloadHash
          || existing.input_bytes !== value.usage.inputBytes || existing.message_count !== value.usage.messageCount) reject('routing_space_operation_conflict');
        return this.ticket(existing);
      }
      const month = new Date(now).toISOString().slice(0, 7);
      const total = this.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM general_operations').toArray()[0]!.n;
      const monthly = this.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM general_operations WHERE period=?', month).toArray()[0]!.n;
      if (total >= 100000 || monthly >= 10000) reject('routing_space_capacity_exceeded');
      // Do not create new provider data once no future retirement record can
      // be retained. Existing replays and deletion reconciliation remain usable.
      if (value.operation === 'memory_ingest'
        && this.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM general_retirements').toArray()[0]!.n >= 1000) {
        reject('routing_space_capacity_exceeded');
      }
      const id = crypto.randomUUID(), expires = Math.min(now + 60000, value.authorityExpiresAtMs);
      this.storage.sql.exec(`INSERT INTO general_operations(id,account_id,credential_id,operation,operation_id,payload_hash,generation,state,
        created_at_ms,updated_at_ms,expires_at_ms,period,input_bytes,message_count) VALUES(?,?,?,?,?,?,?,'admitted',?,?,?,?,?,?)`,
        id, value.actor.accountId, value.actor.credentialId, value.operation, value.operationId, value.payloadHash, generation,
        now, now, expires, month, value.usage.inputBytes, value.usage.messageCount).toArray();
      return this.ticket(this.operation(value.operationId)!, true);
    });
  }
  private loadTicket(id: string, actor: GeneralActor): TicketRow {
    const row = this.storage.sql.exec<TicketRow>('SELECT * FROM general_operations WHERE id=?', id).toArray()[0];
    if (!row || !this.sameActor(row, actor)) reject('routing_space_ticket_unavailable');
    return row;
  }
  async check(input: GeneralCheckInput): Promise<void> {
    const value = parse(checkSchema, input);
    this.storage.transactionSync(() => {
      const now = this.clock(); this.authority(value.authorityExpiresAtMs, now);
      const generation = this.bind(value.identity), row = this.loadTicket(value.ticketId, value.actor);
      if (row.generation !== generation || row.expires_at_ms <= now
        || row.state !== (value.phase === 'dispatch' ? 'admitted' : 'accepted')) reject('routing_space_ticket_unavailable');
    });
  }
  async finalize(input: GeneralFinalizeInput): Promise<void> {
    const value = parse(finalizeSchema, input);
    this.storage.transactionSync(() => {
      this.bind(value.identity);
      const now = this.clock(), row = this.loadTicket(value.ticketId, value.actor);
      if (value.state === 'read_failed' && row.operation !== 'memory_search') reject('routing_space_transition_invalid');
      if (row.state === value.state) return;
      if (row.state !== 'admitted') reject('routing_space_transition_invalid');
      this.storage.sql.exec('UPDATE general_operations SET state=?,updated_at_ms=? WHERE id=?', value.state, now, row.id).toArray();
    });
  }
  async retire(input: GeneralRetireInput): Promise<GeneralRetirement> {
    const value = parse(retireSchema, input);
    return this.storage.transactionSync(() => {
      const now = this.clock(); this.authority(value.authorityExpiresAtMs, now);
      const generation = this.bind(value.identity), existing = this.retirement(value.operationId);
      if (this.operation(value.operationId)) reject('routing_space_operation_conflict');
      if (existing) {
        if (!this.sameActor(existing, value.actor) || existing.payload_hash !== value.payloadHash) reject('routing_space_operation_conflict');
        return this.retired(existing);
      }
      // Privacy retirement has a separate capacity reserve; admission/billing
      // exhaustion must not prevent logical hiding and provider deletion.
      if (this.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM general_retirements').toArray()[0]!.n >= 1000
        || generation >= Number.MAX_SAFE_INTEGER) reject('routing_space_capacity_exceeded');
      const id = crypto.randomUUID(), month = new Date(now).toISOString().slice(0, 7);
      this.storage.sql.exec(`INSERT INTO general_retirements(id,account_id,credential_id,operation_id,payload_hash,generation,next_generation,state,
        created_at_ms,updated_at_ms,period) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`, id, value.actor.accountId,
        value.actor.credentialId, value.operationId, value.payloadHash, generation, generation + 1, now, now, month).toArray();
      this.storage.sql.exec('UPDATE general_generation SET generation=generation+1 WHERE singleton=1').toArray();
      return this.retired(this.retirement(value.operationId)!, true);
    });
  }
  async pending(input: { identity: GeneralIdentity; limit: number }): Promise<GeneralRetirement[]> {
    const value = parse(pendingSchema, input);
    return this.storage.transactionSync(() => {
      this.bind(value.identity);
      this.storage.sql.exec('INSERT INTO general_reconciliation(singleton,cursor_generation) VALUES(1,0) ON CONFLICT(singleton) DO NOTHING').toArray();
      const cursor = this.storage.sql.exec<{ cursor_generation: number }>('SELECT cursor_generation FROM general_reconciliation WHERE singleton=1').toArray()[0]!.cursor_generation;
      // A permanently failing prefix must not starve later retirement targets.
      // Selection and cursor advancement are atomic, while provider outcomes stay
      // unchanged. Wrap only through the original cursor to avoid duplicates.
      const rows = this.storage.sql.exec<RetirementRow>(
        "SELECT * FROM general_retirements WHERE state IN ('pending','unknown') AND generation>? ORDER BY generation LIMIT ?", cursor, value.limit).toArray();
      if (rows.length < value.limit) rows.push(...this.storage.sql.exec<RetirementRow>(
        "SELECT * FROM general_retirements WHERE state IN ('pending','unknown') AND generation<=? ORDER BY generation LIMIT ?", cursor, value.limit - rows.length).toArray());
      if (rows.length) this.storage.sql.exec('UPDATE general_reconciliation SET cursor_generation=? WHERE singleton=1', rows[rows.length - 1]!.generation).toArray();
      return rows.map(row => this.retired(row));
    });
  }
  async finishRetirement(input: { identity: GeneralIdentity; retirementId: string; state: 'acknowledged' | 'unknown' }): Promise<void> {
    const value = parse(finishRetirementSchema, input);
    this.storage.transactionSync(() => {
      this.bind(value.identity);
      const now = this.clock(), row = this.storage.sql.exec<RetirementRow>('SELECT * FROM general_retirements WHERE id=?', value.retirementId).toArray()[0];
      if (!row) reject('routing_space_retirement_unavailable');
      if (row.state === value.state) return;
      if (row.state === 'acknowledged') reject('routing_space_transition_invalid');
      // A concurrent ingest can finish after an earlier delete request. Keep
      // the outbox open until the caller has journaled its outcome and a fresh
      // reconciliation delete can follow it. Expiry is not completion proof.
      // Provider-side asynchronous extraction is separate: even acknowledgement
      // never attests physical purge or final completion of provider queues.
      if (value.state === 'acknowledged' && this.storage.sql.exec<{ n: number }>(
        "SELECT count(*) AS n FROM general_operations WHERE generation=? AND operation='memory_ingest' AND state='admitted'", row.generation).toArray()[0]!.n > 0) {
        reject('routing_space_retirement_inflight');
      }
      this.storage.sql.exec('UPDATE general_retirements SET state=?,updated_at_ms=? WHERE id=?', value.state, now, row.id).toArray();
    });
  }
  async usage(input: { identity: GeneralIdentity }): Promise<GeneralUsage> {
    const value = parse(usageInputSchema, input);
    return this.storage.transactionSync(() => {
      const generation = this.bind(value.identity), month = new Date(this.clock()).toISOString().slice(0, 7);
      const counts = this.storage.sql.exec<Record<string, number>>(`SELECT count(*) AS admissions,
        coalesce(sum(operation='memory_ingest'),0) AS ingestRequests,
        coalesce(sum(CASE WHEN operation='memory_ingest' THEN input_bytes ELSE 0 END),0) AS inputBytes,
        coalesce(sum(message_count),0) AS messages, coalesce(sum(operation='memory_search'),0) AS searchRequests,
        coalesce(sum(CASE WHEN operation='memory_search' THEN input_bytes ELSE 0 END),0) AS queryBytes,
        coalesce(sum(state='accepted'),0) AS accepted, coalesce(sum(state='unknown'),0) AS unknown,
        coalesce(sum(state='read_failed'),0) AS readFailed, coalesce(sum(state='not_dispatched'),0) AS notDispatched
        FROM general_operations WHERE period=?`, month).toArray()[0]!;
      const clearRequests = this.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM general_retirements WHERE period=?', month).toArray()[0]!.n;
      const pendingRetirements = this.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM general_retirements WHERE state IN ('pending','unknown')").toArray()[0]!.n;
      return Object.freeze({ month, generation, admissions: counts.admissions!, ingestRequests: counts.ingestRequests!, inputBytes: counts.inputBytes!,
        messages: counts.messages!, searchRequests: counts.searchRequests!, queryBytes: counts.queryBytes!, accepted: counts.accepted!,
        unknown: counts.unknown!, readFailed: counts.readFailed!, notDispatched: counts.notDispatched!, clearRequests, pendingRetirements });
    });
  }
}

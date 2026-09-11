import { z } from 'zod';
import type { GeneralState, LedgerStorage, RoutingBudgetPolicy, RoutingBudgetReservation, RoutingBudgetReserve,
  RoutingBudgetStub, RoutingBudgetUsage } from './general-types.ts';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000 - 60_000);
const rate = z.number().int().min(1).max(50_000_000);
const policySchema = z.strictObject({ version: z.literal(1), revision: identifier, validUntilMs: timestamp,
  maxMonthlyRequests: z.number().int().min(1).max(100_000),
  maxMonthlyInputBytes: z.number().int().min(1).max(1_000_000_000),
  maxMonthlyReservedMicroUsd: rate, ingestBaseMicroUsd: rate, ingestMicroUsdPerKiB: rate,
  searchBaseMicroUsd: rate, searchMicroUsdPerKiB: rate, pricingBasis: z.literal('operator-upper-bound') });
const identitySchema = z.strictObject({ budgetId: identifier });
const reserveSchema = z.strictObject({ budgetId: identifier, reservationId: identifier, spaceId: identifier,
  operation: z.enum(['memory_ingest', 'memory_search']), payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  usage: z.strictObject({ inputBytes: z.number().int().min(0).max(1_000_000_000), messageCount: z.number().int().min(0).max(500) }),
  authorityExpiresAtMs: timestamp, policy: policySchema }).refine(value => value.operation === 'memory_search'
    ? value.usage.messageCount === 0 && value.usage.inputBytes > 0 : value.usage.messageCount > 0);
const finalizeSchema = z.strictObject({ budgetId: identifier, reservationId: identifier,
  state: z.enum(['accepted', 'unknown', 'read_failed', 'not_dispatched']) });
const statuses = Object.freeze({ routing_budget_input_invalid: 400, routing_budget_identity_mismatch: 403,
  routing_budget_authority_expired: 403, routing_budget_policy_expired: 503, routing_budget_policy_conflict: 409,
  routing_budget_reservation_conflict: 409, routing_budget_exhausted: 429, routing_budget_capacity_exceeded: 429,
  routing_budget_reservation_unavailable: 403, routing_budget_transition_invalid: 409 });
type ErrorCode = keyof typeof statuses;
export class RoutingBudgetError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode) { super(code); this.name = 'RoutingBudgetError'; this.code = code; this.status = statuses[code]; }
}
function reject(code: ErrorCode): never { throw new RoutingBudgetError(code); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) reject('routing_budget_input_invalid');
  return result.data;
}
/** Structural validation is shared with configuration parsing. reserve() checks
 * current policy expiry again after hashing, inside its admission transaction. */
export function parseRoutingBudgetPolicy(value: unknown): RoutingBudgetPolicy { return parse(policySchema, value); }
function canonicalPolicy(value: RoutingBudgetPolicy): string {
  return JSON.stringify({ version: value.version, revision: value.revision, validUntilMs: value.validUntilMs,
    maxMonthlyRequests: value.maxMonthlyRequests, maxMonthlyInputBytes: value.maxMonthlyInputBytes,
    maxMonthlyReservedMicroUsd: value.maxMonthlyReservedMicroUsd, ingestBaseMicroUsd: value.ingestBaseMicroUsd,
    ingestMicroUsdPerKiB: value.ingestMicroUsdPerKiB, searchBaseMicroUsd: value.searchBaseMicroUsd,
    searchMicroUsdPerKiB: value.searchMicroUsdPerKiB, pricingBasis: value.pricingBasis });
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
function monthAt(now: number): string {
  // Removing the day also handles the expanded ISO years allowed by Date.
  return new Date(now).toISOString().split('T', 1)[0]!.slice(0, -3);
}
const schema = `
CREATE TABLE IF NOT EXISTS budget_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 budget_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL CHECK(schema_version=1));
CREATE TABLE IF NOT EXISTS budget_capacity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 total_reservations INTEGER NOT NULL CHECK(total_reservations BETWEEN 0 AND 1000000));
INSERT INTO budget_capacity(singleton,total_reservations) VALUES(1,0) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS budget_months(month TEXT PRIMARY KEY, policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
 policy_record TEXT NOT NULL CHECK(json_valid(policy_record)), created_at_ms INTEGER NOT NULL,
 requests INTEGER NOT NULL DEFAULT 0 CHECK(requests BETWEEN 0 AND 100000),
 input_bytes INTEGER NOT NULL DEFAULT 0 CHECK(input_bytes BETWEEN 0 AND 1000000000),
 reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK(reserved_micro_usd BETWEEN 0 AND 50000000),
 accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted>=0), unknown INTEGER NOT NULL DEFAULT 0 CHECK(unknown>=0),
 read_failed INTEGER NOT NULL DEFAULT 0 CHECK(read_failed>=0), not_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(not_dispatched>=0),
 CHECK(accepted+unknown+read_failed+not_dispatched<=requests));
CREATE TABLE IF NOT EXISTS budget_reservations(reservation_id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('memory_ingest','memory_search')), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 input_bytes INTEGER NOT NULL CHECK(input_bytes BETWEEN 0 AND 1000000000), message_count INTEGER NOT NULL CHECK(message_count BETWEEN 0 AND 500),
 month TEXT NOT NULL REFERENCES budget_months(month), policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
 reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd BETWEEN 1 AND 50000000), created_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('admitted','accepted','unknown','read_failed','not_dispatched')),
 CHECK((operation='memory_ingest' AND message_count>0 AND state!='read_failed') OR
   (operation='memory_search' AND message_count=0 AND input_bytes>0)),
 CHECK(expires_at_ms>created_at_ms AND expires_at_ms<=created_at_ms+60000));
CREATE TRIGGER IF NOT EXISTS budget_identity_no_update BEFORE UPDATE ON budget_identity
 BEGIN SELECT RAISE(ABORT,'routing_budget_identity_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS budget_identity_no_delete BEFORE DELETE ON budget_identity
 BEGIN SELECT RAISE(ABORT,'routing_budget_identity_mismatch'); END;
CREATE TRIGGER IF NOT EXISTS budget_capacity_no_decrease BEFORE UPDATE ON budget_capacity
 WHEN NEW.total_reservations<OLD.total_reservations OR NEW.singleton!=OLD.singleton
 BEGIN SELECT RAISE(ABORT,'routing_budget_capacity_exceeded'); END;
CREATE TRIGGER IF NOT EXISTS budget_capacity_no_delete BEFORE DELETE ON budget_capacity
 BEGIN SELECT RAISE(ABORT,'routing_budget_capacity_exceeded'); END;
CREATE TRIGGER IF NOT EXISTS budget_months_policy_immutable BEFORE UPDATE OF month,policy_hash,policy_record,created_at_ms ON budget_months
 BEGIN SELECT RAISE(ABORT,'routing_budget_policy_conflict'); END;
CREATE TRIGGER IF NOT EXISTS budget_months_no_delete BEFORE DELETE ON budget_months
 BEGIN SELECT RAISE(ABORT,'routing_budget_policy_conflict'); END;
CREATE TRIGGER IF NOT EXISTS budget_reservations_capacity BEFORE INSERT ON budget_reservations
 WHEN (SELECT total_reservations FROM budget_capacity WHERE singleton=1)>=1000000
 BEGIN SELECT RAISE(ABORT,'routing_budget_capacity_exceeded'); END;
CREATE TRIGGER IF NOT EXISTS budget_reservations_count AFTER INSERT ON budget_reservations
 BEGIN UPDATE budget_capacity SET total_reservations=total_reservations+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS budget_reservations_no_delete BEFORE DELETE ON budget_reservations
 BEGIN SELECT RAISE(ABORT,'routing_budget_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS budget_reservations_metadata_immutable BEFORE UPDATE OF reservation_id,space_id,operation,payload_hash,
 input_bytes,message_count,month,policy_hash,reserved_micro_usd,created_at_ms,expires_at_ms ON budget_reservations
 BEGIN SELECT RAISE(ABORT,'routing_budget_reservation_conflict'); END;
CREATE TRIGGER IF NOT EXISTS budget_reservations_terminal BEFORE UPDATE OF state ON budget_reservations
 WHEN OLD.state!='admitted' AND NEW.state!=OLD.state
 BEGIN SELECT RAISE(ABORT,'routing_budget_transition_invalid'); END;
`;
type SqlRow = Record<string, string | number | null>;
type MonthRow = SqlRow & { month: string; policy_hash: string; requests: number; input_bytes: number;
  reserved_micro_usd: number; accepted: number; unknown: number; read_failed: number; not_dispatched: number };
type ReservationRow = SqlRow & { reservation_id: string; space_id: string; operation: RoutingBudgetReserve['operation'];
  payload_hash: string; input_bytes: number; message_count: number; month: string; policy_hash: string;
  reserved_micro_usd: number; expires_at_ms: number; state: GeneralState };

/** One coordination object covers a deployment's admitted provider work across
 * Spaces. Only immutable metadata and conservative monetary reservations are
 * persisted: these are not measured provider bills or a total-cloud-cost cap.
 * Unknown, failed and undispatched reservations are never refunded. The permanent
 * reservation IDs prevent retry/recharge across months; exhaustion requires an
 * explicit service migration, never deletion or rotation of these tombstones.
 * All accounting groups run synchronously in one SQLite transaction. */
export class RoutingBudgetLedger implements RoutingBudgetStub {
  private readonly storage: LedgerStorage;
  private readonly now: () => number;
  private readonly objectName?: string;
  constructor(storage: LedgerStorage, options: { now?: () => number; objectName?: string } = {}) {
    this.storage = storage; this.now = options.now ?? Date.now; this.objectName = options.objectName;
  }
  initialize(): void { this.storage.transactionSync(() => { this.storage.sql.exec(schema).toArray(); }); }
  private clock(): number { return parse(timestamp, this.now()); }
  private identity(budgetId: string): void {
    if (this.objectName !== undefined && this.objectName !== `budget:${budgetId}`) reject('routing_budget_identity_mismatch');
    this.storage.sql.exec('INSERT INTO budget_identity(singleton,budget_id,schema_version) VALUES(1,?,1) ON CONFLICT(singleton) DO NOTHING', budgetId).toArray();
    const row = this.storage.sql.exec<SqlRow & { budget_id: string; schema_version: number }>('SELECT budget_id,schema_version FROM budget_identity WHERE singleton=1').toArray()[0];
    if (!row || row.budget_id !== budgetId || row.schema_version !== 1) reject('routing_budget_identity_mismatch');
  }
  private month(month: string): MonthRow | undefined {
    return this.storage.sql.exec<MonthRow>('SELECT * FROM budget_months WHERE month=?', month).toArray()[0];
  }
  private reservation(reservationId: string): ReservationRow | undefined {
    return this.storage.sql.exec<ReservationRow>('SELECT * FROM budget_reservations WHERE reservation_id=?', reservationId).toArray()[0];
  }
  private result(row: ReservationRow, replayed: boolean): RoutingBudgetReservation {
    return Object.freeze({ reservationId: row.reservation_id, month: row.month, reservedMicroUsd: row.reserved_micro_usd,
      expiresAtMs: row.expires_at_ms, replayed });
  }
  async reserve(input: RoutingBudgetReserve): Promise<RoutingBudgetReservation> {
    const value = parse(reserveSchema, input), record = canonicalPolicy(value.policy), hash = await digest(record);
    return this.storage.transactionSync(() => {
      this.identity(value.budgetId);
      const now = this.clock(), policy = value.policy;
      if (value.authorityExpiresAtMs <= now) reject('routing_budget_authority_expired');
      if (policy.validUntilMs <= now) reject('routing_budget_policy_expired');
      const existing = this.reservation(value.reservationId);
      if (existing) {
        if (existing.policy_hash !== hash || this.month(existing.month)?.policy_hash !== hash) reject('routing_budget_policy_conflict');
        if (existing.space_id !== value.spaceId || existing.operation !== value.operation || existing.payload_hash !== value.payloadHash
          || existing.input_bytes !== value.usage.inputBytes || existing.message_count !== value.usage.messageCount) reject('routing_budget_reservation_conflict');
        // This may be expired or belong to an earlier month. It does not grant
        // dispatch permission, renew a deadline or touch current-month policy.
        return this.result(existing, true);
      }
      const total = this.storage.sql.exec<SqlRow & { total_reservations: number }>('SELECT total_reservations FROM budget_capacity WHERE singleton=1').toArray()[0];
      if (!total || total.total_reservations >= 1_000_000) reject('routing_budget_capacity_exceeded');
      const month = monthAt(now), current = this.month(month);
      if (current && current.policy_hash !== hash) reject('routing_budget_policy_conflict');
      const ingest = value.operation === 'memory_ingest';
      const base = ingest ? policy.ingestBaseMicroUsd : policy.searchBaseMicroUsd;
      const perKiB = ingest ? policy.ingestMicroUsdPerKiB : policy.searchMicroUsdPerKiB;
      const cost = base + Math.ceil(value.usage.inputBytes / 1024) * perKiB;
      const requests = (current?.requests ?? 0) + 1, bytes = (current?.input_bytes ?? 0) + value.usage.inputBytes;
      const reserved = (current?.reserved_micro_usd ?? 0) + cost;
      if (![cost, requests, bytes, reserved].every(Number.isSafeInteger)) reject('routing_budget_input_invalid');
      if (requests > policy.maxMonthlyRequests || bytes > policy.maxMonthlyInputBytes || reserved > policy.maxMonthlyReservedMicroUsd) reject('routing_budget_exhausted');
      if (!current) this.storage.sql.exec('INSERT INTO budget_months(month,policy_hash,policy_record,created_at_ms) VALUES(?,?,?,?)', month, hash, record, now).toArray();
      this.storage.sql.exec('UPDATE budget_months SET requests=?,input_bytes=?,reserved_micro_usd=? WHERE month=?', requests, bytes, reserved, month).toArray();
      const expires = Math.min(now + 60_000, value.authorityExpiresAtMs, policy.validUntilMs);
      this.storage.sql.exec(`INSERT INTO budget_reservations(reservation_id,space_id,operation,payload_hash,input_bytes,message_count,
        month,policy_hash,reserved_micro_usd,created_at_ms,expires_at_ms,updated_at_ms,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'admitted')`,
        value.reservationId, value.spaceId, value.operation, value.payloadHash, value.usage.inputBytes, value.usage.messageCount,
        month, hash, cost, now, expires, now).toArray();
      return this.result(this.reservation(value.reservationId)!, false);
    });
  }
  async finalize(input: Parameters<RoutingBudgetStub['finalize']>[0]): Promise<void> {
    const value = parse(finalizeSchema, input);
    this.storage.transactionSync(() => {
      this.identity(value.budgetId);
      const row = this.reservation(value.reservationId);
      if (!row) reject('routing_budget_reservation_unavailable');
      if (value.state === 'read_failed' && row.operation !== 'memory_search') reject('routing_budget_transition_invalid');
      if (row.state === value.state) return;
      if (row.state !== 'admitted') reject('routing_budget_transition_invalid');
      const now = this.clock();
      const column = { accepted: 'accepted', unknown: 'unknown', read_failed: 'read_failed', not_dispatched: 'not_dispatched' }[value.state];
      this.storage.sql.exec('UPDATE budget_reservations SET state=?,updated_at_ms=? WHERE reservation_id=?', value.state, now, value.reservationId).toArray();
      // The column is selected from a fixed enum; no caller text is SQL syntax.
      this.storage.sql.exec(`UPDATE budget_months SET ${column}=${column}+1 WHERE month=?`, row.month).toArray();
    });
  }
  async usage(input: Parameters<RoutingBudgetStub['usage']>[0]): Promise<RoutingBudgetUsage> {
    const value = parse(identitySchema, input);
    return this.storage.transactionSync(() => {
      this.identity(value.budgetId);
      const month = monthAt(this.clock()), row = this.month(month);
      return Object.freeze({ month, requests: row?.requests ?? 0, inputBytes: row?.input_bytes ?? 0,
        reservedMicroUsd: row?.reserved_micro_usd ?? 0, accepted: row?.accepted ?? 0, unknown: row?.unknown ?? 0,
        readFailed: row?.read_failed ?? 0, notDispatched: row?.not_dispatched ?? 0, billingVerified: false });
    });
  }
}

import type { LedgerStorage } from './ledger-types.ts';
export type { LedgerStorage };

export type GeneralOperation = 'memory_ingest' | 'memory_search' | 'memory_clear_space' | 'memory_usage';
export type GeneralBillableOperation = Extract<GeneralOperation, 'memory_ingest' | 'memory_search'>;
export interface SpaceOwner { kind: 'account' | 'organization'; id: string }
export interface GeneralAuthority {
  spaceId: string; owner: SpaceOwner; accountId: string; credentialId: string;
  operation: GeneralOperation; authorityExpiresAtMs: number;
}
export interface GeneralIdentity {
  spaceId: string; owner: SpaceOwner;
  provider: { accountId: string; namespace: string };
}
export interface GeneralActor { accountId: string; credentialId: string }
export interface GeneralUsageInput { inputBytes: number; messageCount: number }
export type GeneralState = 'admitted' | 'accepted' | 'unknown' | 'read_failed' | 'not_dispatched';
export interface GeneralAdmitInput {
  identity: GeneralIdentity; actor: GeneralActor; operation: GeneralBillableOperation;
  operationId: string; payloadHash: string; usage: GeneralUsageInput; authorityExpiresAtMs: number;
}
export interface GeneralTicket {
  id: string; operationId: string; operation: GeneralBillableOperation; generation: number;
  state: GeneralState; createdAtMs: number; expiresAtMs: number; dispatch: boolean;
}
export interface GeneralCheckInput {
  identity: GeneralIdentity; actor: GeneralActor; ticketId: string;
  authorityExpiresAtMs: number; phase: 'dispatch' | 'disclose';
}
export interface GeneralFinalizeInput {
  identity: GeneralIdentity; actor: GeneralActor; ticketId: string;
  state: Exclude<GeneralState, 'admitted'>;
}
export interface GeneralRetireInput {
  identity: GeneralIdentity; actor: GeneralActor; operationId: string;
  payloadHash: string; authorityExpiresAtMs: number;
}
export interface GeneralRetirement {
  id: string; generation: number; nextGeneration: number; createdAtMs: number;
  state: 'pending' | 'acknowledged' | 'unknown'; dispatch: boolean;
  logicallyHidden: true; physicalPurgeVerified: false;
}
export interface GeneralUsage {
  month: string; generation: number; admissions: number;
  ingestRequests: number; inputBytes: number; messages: number;
  searchRequests: number; queryBytes: number;
  accepted: number; unknown: number; readFailed: number; notDispatched: number;
  clearRequests: number; pendingRetirements: number;
}
export interface GeneralSpaceStub {
  admit(input: GeneralAdmitInput): Promise<GeneralTicket>;
  check(input: GeneralCheckInput): Promise<void>;
  finalize(input: GeneralFinalizeInput): Promise<void>;
  retire(input: GeneralRetireInput): Promise<GeneralRetirement>;
  pending(input: { identity: GeneralIdentity; limit: number }): Promise<GeneralRetirement[]>;
  finishRetirement(input: { identity: GeneralIdentity; retirementId: string; state: 'acknowledged' | 'unknown' }): Promise<void>;
  usage(input: { identity: GeneralIdentity }): Promise<GeneralUsage>;
}
export interface GeneralSpaceNamespace { getByName(name: string): GeneralSpaceStub }

/** Trusted deployment policy, never request data. Monetary reservations are a
 * conservative application budget, not an assertion of actual provider billing. */
export interface RoutingBudgetPolicy {
  version: 1; revision: string; validUntilMs: number;
  maxMonthlyRequests: number; maxMonthlyInputBytes: number; maxMonthlyReservedMicroUsd: number;
  ingestBaseMicroUsd: number; ingestMicroUsdPerKiB: number;
  searchBaseMicroUsd: number; searchMicroUsdPerKiB: number;
  pricingBasis: 'operator-upper-bound';
}
export interface RoutingBudgetReserve {
  budgetId: string; reservationId: string; spaceId: string; operation: GeneralBillableOperation;
  payloadHash: string; usage: GeneralUsageInput; authorityExpiresAtMs: number; policy: RoutingBudgetPolicy;
}
export interface RoutingBudgetReservation {
  reservationId: string; month: string; reservedMicroUsd: number;
  expiresAtMs: number; replayed: boolean;
}
export interface RoutingBudgetUsage {
  month: string; requests: number; inputBytes: number; reservedMicroUsd: number;
  accepted: number; unknown: number; readFailed: number; notDispatched: number;
  billingVerified: false;
}
export interface RoutingBudgetStub {
  reserve(input: RoutingBudgetReserve): Promise<RoutingBudgetReservation>;
  finalize(input: { budgetId: string; reservationId: string; state: Exclude<GeneralState, 'admitted'> }): Promise<void>;
  usage(input: { budgetId: string }): Promise<RoutingBudgetUsage>;
}
export interface RoutingBudgetNamespace { getByName(name: string): RoutingBudgetStub }

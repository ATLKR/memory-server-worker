import type { CloudflareMedicalConsent, MedicalCloudflareConsentOperation, MedicalCloudflareConsentReference } from './consent.ts';

export interface LedgerOrganizationInput { organizationId: string }
export interface LedgerGrantInput extends LedgerOrganizationInput {
  approvedBy: string;
  expectedVersion: number;
  grant: Pick<CloudflareMedicalConsent, 'spaceScope' | 'scopes' | 'validFromMs' | 'expiresAtMs' | 'evidenceRef'>;
}
export interface LedgerRevokeInput extends LedgerOrganizationInput { approvedBy: string; expectedVersion: number }
/** Service-created from fresh credential, organization membership and Space ACL
 * checks. The DO cannot make those external checks atomic with its own writes. */
export interface LedgerActorInput extends LedgerOrganizationInput {
  accountId: string; credentialId: string; spaceId: string;
  operation: MedicalCloudflareConsentOperation; requestId: string;
}
export interface LedgerAuthorityInput extends LedgerActorInput { authorityExpiresAtMs: number }
export interface LedgerIssueInput extends LedgerAuthorityInput { reference?: MedicalCloudflareConsentReference }
export interface LedgerReceipt {
  version: 1; allowed: true; requestId: string; spaceId: string;
  consentId: string; consentVersion: number; operation: MedicalCloudflareConsentOperation;
  expiresAtMs: number; receipt: string;
}
export interface LedgerConsumeInput extends LedgerAuthorityInput {
  receipt: string; reference: MedicalCloudflareConsentReference; payloadHash: string; operationId: string;
}
export type LedgerTicketState = 'admitted' | 'accepted' | 'unknown' | 'read_failed';
export interface LedgerTicket extends LedgerActorInput {
  id: string; operationId: string; state: LedgerTicketState; consentId: string; consentVersion: number;
  createdAtMs: number; updatedAtMs: number; expiresAtMs: number;
  /** Only consume's first admission can return true. Never infer permission to
   * retry a provider call from an admitted/unknown ticket or a later check. */
  dispatch: boolean;
}
export interface LedgerFinalizeInput extends LedgerActorInput {
  ticketId: string; state: Exclude<LedgerTicketState, 'admitted'>;
}
export interface LedgerTicketInput extends LedgerAuthorityInput {
  ticketId: string; phase: 'dispatch' | 'disclose';
}
export interface RoutingLedgerStub {
  get(input: LedgerOrganizationInput): Promise<CloudflareMedicalConsent | null>;
  grant(input: LedgerGrantInput): Promise<CloudflareMedicalConsent>;
  revoke(input: LedgerRevokeInput): Promise<CloudflareMedicalConsent>;
  issue(input: LedgerIssueInput): Promise<LedgerReceipt>;
  consume(input: LedgerConsumeInput): Promise<LedgerTicket>;
  finalize(input: LedgerFinalizeInput): Promise<LedgerTicket>;
  checkTicket(input: LedgerTicketInput): Promise<LedgerTicket>;
}
export interface RoutingLedger { getByName(name: string): RoutingLedgerStub }
export type LedgerSqlValue = string | number | null;
export interface LedgerStorage {
  sql: { exec<T extends Record<string, LedgerSqlValue> = Record<string, LedgerSqlValue>>(query: string, ...bindings: LedgerSqlValue[]): { toArray(): T[] } };
  transactionSync<T>(callback: () => T): T;
}

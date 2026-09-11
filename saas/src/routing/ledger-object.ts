import { DurableObject } from 'cloudflare:workers';
import { ConsentLedger } from './ledger.ts';
import type { LedgerConsumeInput, LedgerFinalizeInput, LedgerGrantInput, LedgerIssueInput, LedgerOrganizationInput,
  LedgerRevokeInput, LedgerTicketInput, RoutingLedgerStub } from './ledger-types.ts';

/** Bound only to trusted service code. Methods accept authenticated metadata,
 * never bearer tokens, evidence documents, messages or search text. */
export class OrganizationConsentLedger extends DurableObject implements RoutingLedgerStub {
  protected readonly ledger: ConsentLedger;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ledger = new ConsentLedger(ctx.storage, { objectName: ctx.id.name });
    ctx.blockConcurrencyWhile(async () => { this.ledger.initialize(); });
  }
  get(input: LedgerOrganizationInput) { return this.ledger.get(input); }
  grant(input: LedgerGrantInput) { return this.ledger.grant(input); }
  revoke(input: LedgerRevokeInput) { return this.ledger.revoke(input); }
  issue(input: LedgerIssueInput) { return this.ledger.issue(input); }
  consume(input: LedgerConsumeInput) { return this.ledger.consume(input); }
  finalize(input: LedgerFinalizeInput) { return this.ledger.finalize(input); }
  checkTicket(input: LedgerTicketInput) { return this.ledger.checkTicket(input); }
}

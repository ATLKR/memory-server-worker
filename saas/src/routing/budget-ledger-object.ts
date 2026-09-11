import { DurableObject } from 'cloudflare:workers';
import { RoutingBudgetLedger } from './budget-ledger.ts';
import type { RoutingBudgetReserve, RoutingBudgetStub } from './general-types.ts';

/** A private deployment-wide admission boundary. Binding callers supply trusted
 * metadata after the Space ledger has admitted a stable operation ticket. */
export class AgentMemoryBudgetLedger extends DurableObject implements RoutingBudgetStub {
  protected readonly ledger: RoutingBudgetLedger;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Random IDs must not bypass the deployment-wide named accounting object.
    this.ledger = new RoutingBudgetLedger(ctx.storage, { objectName: ctx.id.name ?? '' });
    ctx.blockConcurrencyWhile(async () => { this.ledger.initialize(); });
  }
  reserve(input: RoutingBudgetReserve) { return this.ledger.reserve(input); }
  finalize(input: Parameters<RoutingBudgetStub['finalize']>[0]) { return this.ledger.finalize(input); }
  usage(input: Parameters<RoutingBudgetStub['usage']>[0]) { return this.ledger.usage(input); }
}

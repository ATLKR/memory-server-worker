import { DurableObject } from 'cloudflare:workers';
import { GeneralSpaceLedger } from './general-ledger.ts';
import type { GeneralAdmitInput, GeneralCheckInput, GeneralFinalizeInput, GeneralIdentity, GeneralRetireInput, GeneralSpaceStub } from './general-types.ts';

/** Service-only RPC metadata. A nameless/random DO identity is deliberately
 * rejected because all callers must use the deterministic space:<id> name. */
export class AgentMemorySpaceLedger extends DurableObject implements GeneralSpaceStub {
  protected readonly ledger: GeneralSpaceLedger;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ledger = new GeneralSpaceLedger(ctx.storage, { objectName: ctx.id.name ?? '' });
    ctx.blockConcurrencyWhile(async () => { this.ledger.initialize(); });
  }
  admit(input: GeneralAdmitInput) { return this.ledger.admit(input); }
  check(input: GeneralCheckInput) { return this.ledger.check(input); }
  finalize(input: GeneralFinalizeInput) { return this.ledger.finalize(input); }
  retire(input: GeneralRetireInput) { return this.ledger.retire(input); }
  pending(input: { identity: GeneralIdentity; limit: number }) { return this.ledger.pending(input); }
  finishRetirement(input: { identity: GeneralIdentity; retirementId: string; state: 'acknowledged' | 'unknown' }) { return this.ledger.finishRetirement(input); }
  usage(input: { identity: GeneralIdentity }) { return this.ledger.usage(input); }
}

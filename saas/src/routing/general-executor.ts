import { z } from 'zod';
import type { AgentMemoryHttp } from '../agent-memory/http.ts';
import { canonical, digest } from '../release/util.ts';
import { routingToolSchemas } from './client.ts';
import { resolveMemoryRoute } from './policy.ts';
import { parseRoutingBudgetPolicy } from './budget-ledger.ts';
import type { GeneralAuthority, GeneralIdentity, GeneralOperation, GeneralSpaceStub, GeneralState, GeneralTicket,
  GeneralRetirement, RoutingBudgetPolicy, RoutingBudgetReservation, RoutingBudgetStub } from './general-types.ts';

const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const spaces=z.array(identifier).max(1024).refine(v=>new Set(v).size===v.length);
const providerIdentity=z.strictObject({accountId:z.string().regex(/^[a-f0-9]{32}$/),namespace:z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)});
const schemas={
  memory_ingest:routingToolSchemas.memory_ingest.extend({spaceId:identifier}),
  memory_search:routingToolSchemas.memory_search.extend({spaceId:identifier}),
  memory_clear_space:routingToolSchemas.memory_clear_space.extend({spaceId:identifier}),
  memory_usage:routingToolSchemas.memory_usage.extend({spaceId:identifier}),
} as const;
const requestSchema=z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('memory_ingest'),arguments:schemas.memory_ingest}),
  z.strictObject({operation:z.literal('memory_search'),arguments:schemas.memory_search}),
  z.strictObject({operation:z.literal('memory_clear_space'),arguments:schemas.memory_clear_space}),
  z.strictObject({operation:z.literal('memory_usage'),arguments:schemas.memory_usage}),
]);
const encoder=new TextEncoder();
export interface GeneralExecutorPorts {
  clock:()=>number; allowedSpaceIds:readonly string[]; seoulSpaceIds:readonly string[];
  providerIdentity:GeneralIdentity['provider'];
  authority:(token:string,spaceId:string,operation:GeneralOperation)=>Promise<GeneralAuthority>;
  ledger:(spaceId:string)=>GeneralSpaceStub;
  budgetId:string; budgetPolicy:RoutingBudgetPolicy; budget:RoutingBudgetStub;
  provider:Pick<AgentMemoryHttp,'ingest'|'recall'|'deleteProfile'>;
}
export interface GeneralResult {ok:boolean;body:Record<string,unknown>}
function reject(code:string):never {throw new Error(code);}
function safeCode(error:unknown):string {
  const candidate=error instanceof Error?(error as Error&{code?:unknown}).code??error.message:null;
  return typeof candidate==='string'&&/^(?:routing_[a-z_]+|access_denied|space_access_denied|authentication_required|agent_memory_[a-z_]+)$/.test(candidate)
    ?candidate:'routing_operation_failed';
}
export const generalProfile=async(identity:GeneralIdentity,generation:number):Promise<string>=>
  'general-'+await digest(canonical(['general-profile-v1',identity,generation]));

/** Server-only execution boundary shared by REST and MCP. Ledgers contain no
 * messages, queries, answers or credentials; all identifiers are server-scoped. */
export function createGeneralExecutor(ports:GeneralExecutorPorts) {
  const allowed=new Set(spaces.parse([...ports.allowedSpaceIds])),seoul=new Set(spaces.parse([...ports.seoulSpaceIds]));
  const provider=Object.freeze(providerIdentity.parse(ports.providerIdentity));
  const budgetId=identifier.parse(ports.budgetId),budgetPolicy=Object.freeze(parseRoutingBudgetPolicy(ports.budgetPolicy));
  const {clock,authority,ledger,budget}=ports;
  return async(operation:GeneralOperation,args:unknown,token:string,options:{signal?:AbortSignal}={}):Promise<GeneralResult>=>{
    let ticket:GeneralTicket|undefined,identity:GeneralIdentity|undefined,first:GeneralAuthority|undefined,stub:GeneralSpaceStub|undefined;
    let reservation:RoutingBudgetReservation|undefined,retirement:GeneralRetirement|undefined;
    let reservationId:string|undefined,budgetAttempted=false;
    let retirementProviderAcknowledged=false,retirementCleanupPending=true;
    let dispatched=false,recorded=false,terminal:Exclude<GeneralState,'admitted'>='not_dispatched',operationId:string|undefined;
    const signal=options.signal;
    const check=()=>{if(signal?.aborted)reject('routing_request_aborted');};
    const admissionDeadline=(authorityExpiresAtMs=first!.authorityExpiresAtMs)=>Math.min(ticket!.expiresAtMs,
      authorityExpiresAtMs,reservation?.expiresAtMs??Number.MAX_SAFE_INTEGER,budgetPolicy.validUntilMs);
    const checkAdmission=(authorityExpiresAtMs?:number)=>{
      check();if(admissionDeadline(authorityExpiresAtMs)<=clock())reject('routing_authority_expired');
    };
    const finalize=async()=>{
      if(!ticket||!stub||!first||!identity||!ticket.dispatch)return;
      // Attempt both independent outcome records even if either service fails.
      const results=await Promise.allSettled([
        Promise.resolve().then(()=>stub!.finalize({identity:identity!,actor:{accountId:first!.accountId,credentialId:first!.credentialId},ticketId:ticket!.id,state:terminal})),
        // A reserve RPC can commit without returning its receipt. The stable ID
        // still permits a known no-egress outcome, without another reservation
        // attempt or a refund. A missing/unavailable reservation is independent
        // of the Space journal and cannot prevent its terminal write.
        ...(budgetAttempted&&reservationId&&!reservation?.replayed?
          [Promise.resolve().then(()=>budget.finalize({budgetId,reservationId:reservationId!,state:terminal}))]:[]),
      ]);
      if(results.some(v=>v.status==='rejected'))reject('routing_outcome_recording_failed');
      recorded=true;
    };
    try {
      check();if(!Object.hasOwn(routingToolSchemas,operation))reject('routing_request_invalid');
      const parsed=requestSchema.safeParse({operation,arguments:args});
      if(!parsed.success)reject('routing_request_invalid');
      // Zod copied the full input before the first await; caller mutation cannot
      // substitute content while authority/budget calls are in progress.
      const {operation:kind,arguments:input}=parsed.data;
      if(kind==='memory_search'&&input.mode!==undefined)reject('routing_search_mode_unavailable');
      const plan=resolveMemoryRoute(input.routing,seoul.has(input.spaceId)?[{route:'seoul'}]:[]);
      if(plan.route!=='agent-memory'||input.routing.classification!=='general'||input.routing.medicalCloudflareConsent
        ||!allowed.has(input.spaceId))reject('routing_space_not_enabled');
      first=await authority(token,input.spaceId,operation);check();
      if(first.spaceId!==input.spaceId||first.operation!==operation||first.authorityExpiresAtMs<=clock())reject('routing_authority_expired');
      identity={spaceId:first.spaceId,owner:{...first.owner},provider};
      const actor={accountId:first.accountId,credentialId:first.credentialId};
      const refresh=async()=>{
        check();const current=await authority(token,input.spaceId,operation);check();
        if(current.spaceId!==first!.spaceId||current.operation!==operation||current.accountId!==first!.accountId
          ||current.credentialId!==first!.credentialId||canonical(current.owner)!==canonical(first!.owner)
          ||current.authorityExpiresAtMs<=clock())reject('routing_authority_changed');
        return current;
      };
      stub=ledger(input.spaceId);
      if(kind==='memory_usage') {
        const usage=await stub.usage({identity});check();await refresh();
        return {ok:true,body:{spaceId:input.spaceId,usage,billingVerified:false}};
      }
      operationId=kind==='memory_ingest'||kind==='memory_clear_space'?input.operationId:crypto.randomUUID();
      const payloadHash=await digest(canonical({operation,input}));check();
      if(kind==='memory_clear_space') {
        retirement=await stub.retire({identity,actor,operationId,payloadHash,authorityExpiresAtMs:first.authorityExpiresAtMs});
        retirementProviderAcknowledged=retirement.state==='acknowledged';
        retirementCleanupPending=!retirementProviderAcknowledged;check();
        if(retirement.dispatch) {
          try {
            const current=await refresh();
            const profile=await generalProfile(identity,retirement.generation);check();
            const deadlineMs=Math.min(current.authorityExpiresAtMs,clock()+15000);
            if(deadlineMs<=clock())reject('routing_authority_expired');
            dispatched=true;
            await ports.provider.deleteProfile(profile,{signal,deadlineMs});
            retirementProviderAcknowledged=true;
            await stub.finishRetirement({identity,retirementId:retirement.id,state:'acknowledged'});
            retirementCleanupPending=false;
          } catch {
            if(dispatched)try{await stub.finishRetirement({identity,retirementId:retirement.id,state:'unknown'});}
            catch{/* An unavailable journal or concurrent ACK leaves cleanup conservatively pending. */}
          }
        }
        await refresh();
        return {ok:true,body:{operationId,state:'retired',generation:retirement.nextGeneration,replayed:!retirement.dispatch,
          logicallyHidden:true,providerDispatched:dispatched,providerAcknowledged:retirementProviderAcknowledged,
          cleanupPending:retirementCleanupPending,physicalPurgeVerified:false}};
      }
      const usage=kind==='memory_ingest'?{inputBytes:input.messages.reduce((n,m)=>n+encoder.encode(m.content).length,0),messageCount:input.messages.length}
        :{inputBytes:encoder.encode(input.query).length,messageCount:0};
      ticket=await stub.admit({identity,actor,operation:kind,operationId,payloadHash,usage,authorityExpiresAtMs:first.authorityExpiresAtMs});check();
      if(!ticket.dispatch) {
        await refresh();return {ok:ticket.state==='accepted',body:{operationId,state:ticket.state==='admitted'?'unknown':ticket.state,
          replayed:true,providerDispatched:false}};
      }
      checkAdmission();
      reservationId=await digest(canonical(['general-budget-v1',identity,ticket.id]));checkAdmission();
      budgetAttempted=true;
      reservation=await budget.reserve({budgetId,reservationId,spaceId:input.spaceId,operation:kind,payloadHash,usage,
        authorityExpiresAtMs:Math.min(first.authorityExpiresAtMs,ticket.expiresAtMs),policy:budgetPolicy});check();
      if(reservation.replayed||reservation.reservationId!==reservationId||reservation.expiresAtMs<=clock())reject('routing_budget_reservation_invalid');
      checkAdmission();
      const profile=await generalProfile(identity,ticket.generation);checkAdmission();
      const session=kind==='memory_ingest'&&input.sessionId?input.sessionId:'op-'+(await digest(operationId)).slice(0,48);
      checkAdmission();const current=await refresh();checkAdmission(current.authorityExpiresAtMs);
      await stub.check({identity,actor,ticketId:ticket.id,phase:'dispatch',authorityExpiresAtMs:current.authorityExpiresAtMs});checkAdmission(current.authorityExpiresAtMs);
      const deadlineMs=Math.min(admissionDeadline(current.authorityExpiresAtMs),clock()+15000);
      if(deadlineMs<=clock())reject('routing_authority_expired');
      let output:Record<string,unknown>;
      dispatched=true;terminal=operation==='memory_ingest'?'unknown':'read_failed';
      if(kind==='memory_ingest') {
        await ports.provider.ingest(profile,input.messages,session,{signal,deadlineMs});
        output={operationId,state:'accepted',sessionId:session,processing:'asynchronous'};
      } else {
        const found=await ports.provider.recall(profile,input.query,{thinkingLevel:'low',responseLength:'short'},{signal,deadlineMs});
        output={operationId,state:'accepted',answer:found.answer,candidates:found.candidates.slice(0,input.limit??20),count:found.count};
      }
      // Record a known provider acknowledgement even when its completion or
      // journal RPC arrives after cancellation/expiry, but never disclose then.
      terminal='accepted';await finalize();checkAdmission(current.authorityExpiresAtMs);
      if(encoder.encode(JSON.stringify(output)).length>400000)reject('routing_response_too_large');
      const disclose=await refresh();checkAdmission(disclose.authorityExpiresAtMs);
      await stub.check({identity,actor,ticketId:ticket.id,phase:'disclose',authorityExpiresAtMs:disclose.authorityExpiresAtMs});
      // The DO snapshot may have been valid before a delayed RPC response. No
      // await may occur between this final local expiry check and disclosure.
      checkAdmission(disclose.authorityExpiresAtMs);
      return {ok:true,body:output};
    } catch(error) {
      if(!recorded)try{await finalize();}catch{/* Durable admitted/unknown records retain the charge and block replay. */}
      return {ok:false,body:{error:safeCode(error),...(operationId?{operationId}:{}),state:retirement?'retired':terminal,
        ...(retirement?{logicallyHidden:true,providerAcknowledged:retirementProviderAcknowledged,
          cleanupPending:retirementCleanupPending,physicalPurgeVerified:false}:{}),providerDispatched:dispatched}};
    }
  };
}

/** Operator-owned reconciliation, never a client capability or retry permission.
 * This only retries deletion of immutable retired profiles; it cannot revive data.
 * Abandoned admitted ingests are not treated as complete merely because their
 * ticket expired. They still require proven outcome recovery before GA can claim
 * deletion completion; this worker cannot resolve that uncertainty by guessing. */
export async function reconcileGeneralRetirements(identity:GeneralIdentity,ledger:GeneralSpaceStub,
  provider:Pick<AgentMemoryHttp,'deleteProfile'>,options:{signal?:AbortSignal;clock?:()=>number}={}):Promise<{acknowledged:number;pending:number;physicalPurgeVerified:false}> {
  const clock=options.clock??Date.now,signal=options.signal;
  if(signal?.aborted)reject('routing_request_aborted');
  const rows=await ledger.pending({identity,limit:10});
  let acknowledged=0,pending=rows.length;
  for(const row of rows) {
    if(signal?.aborted)break;
    let dispatched=false;
    try {
      const deadlineMs=clock()+15000;
      const check=()=>{if(signal?.aborted)reject('routing_request_aborted');if(clock()>=deadlineMs)reject('routing_request_timeout');};
      check();const profile=await generalProfile(identity,row.generation);check();
      dispatched=true;await provider.deleteProfile(profile,{signal,deadlineMs});
      // Cancellation must not discard an observed provider outcome. Journal this
      // attempted row, then let the next loop boundary leave other rows alone.
      await ledger.finishRetirement({identity,retirementId:row.id,state:'acknowledged'});acknowledged++;pending--;
    } catch {
      if(dispatched)try{await ledger.finishRetirement({identity,retirementId:row.id,state:'unknown'});}
      catch{/* A concurrent acknowledgement or unavailable journal keeps this result conservatively pending. */}
    }
  }
  return {acknowledged,pending,physicalPurgeVerified:false};
}

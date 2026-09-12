import { z } from 'zod';
import type { ReleaseEnv } from '../release/types.ts';
import { body, canonical, digest, fail, json } from '../release/util.ts';
import { createAgentMemoryHttp } from '../agent-memory/http.ts';
import type { AgentMemoryHttp } from '../agent-memory/http.ts';
import { ingestRoutingInputSchema, searchRoutingInputSchema } from './client.ts';
import { medicalCloudflareConsentReferenceSchema } from './consent.ts';
import type { MedicalCloudflareConsentOperation } from './consent.ts';
import type { LedgerAuthorityInput, LedgerTicket, RoutingLedgerStub } from './ledger-types.ts';
import { resolveMemoryRoute } from './policy.ts';
import { resolveRoutingAuthority } from './server-authority.ts';
import { routingLedgerRequestId, routingRequestIdSchema } from './rpc-id.ts';
import type { RoutingRequestId } from './rpc-id.ts';
import { parseRoutingBudgetPolicy } from './budget-ledger.ts';
import type { RoutingBudgetPolicy, RoutingBudgetReservation, RoutingBudgetStub } from './general-types.ts';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const metadata = z.record(z.string(),z.unknown()).refine(value=>{
  try{return new TextEncoder().encode(JSON.stringify(value)).length<=8192;}catch{return false;}
});
const envelope = z.strictObject({jsonrpc:z.literal('2.0'),id:routingRequestIdSchema,method:z.literal('tools/call'),
  params:z.strictObject({name:z.enum(['memory_ingest','memory_search']),arguments:z.unknown(),_meta:metadata.optional()})});
const ingestArgs = ingestRoutingInputSchema.extend({spaceId:identifier});
const searchArgs = searchRoutingInputSchema.extend({spaceId:identifier});
const spaceList = z.array(identifier).max(1024).refine(values=>new Set(values).size===values.length);
const reservationSchema = z.strictObject({reservationId:identifier,month:z.string().regex(/^(?:\d{4}|[+-]\d{6})-(?:0[1-9]|1[0-2])$/),
  reservedMicroUsd:z.number().int().min(1).max(50_000_000),expiresAtMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),replayed:z.boolean()});
type Authority = Omit<LedgerAuthorityInput,'requestId'>;

/** Server-only ports. They must never come from tool arguments or client headers. */
export interface RoutedMcpPorts {
  clock:()=>number;
  allowedMedicalSpaceIds:readonly string[];
  seoulSpaceIds:readonly string[];
  authority:(token:string,spaceId:string,operation:MedicalCloudflareConsentOperation)=>Promise<Authority>;
  ledger:(organizationId:string)=>RoutingLedgerStub;
  provider:Pick<AgentMemoryHttp,'ingest'|'recall'>;
  budgetId:string;
  budgetPolicy:RoutingBudgetPolicy;
  budget:RoutingBudgetStub;
}
function safeCode(error:unknown):string {
  const candidate=error instanceof Error ? (error as Error&{code?:unknown}).code ?? error.message : null;
  return typeof candidate==='string' && /^(?:routing_[a-z_]+|access_denied|space_access_denied|authentication_required|agent_memory_[a-z_]+)$/.test(candidate)
    ? candidate : 'routing_operation_failed';
}
const response=(requestId:RoutingRequestId,value:unknown,isError=false)=>json({jsonrpc:'2.0',id:requestId,result:{
  content:[{type:'text',text:JSON.stringify(value)}],...(isError?{isError:true}:{})}});

/** Explicitly admitted organization medical Spaces retain independent consent
 * checks and share the deployment admission budget. Protocol availability does
 * not replace the separate GA acceptance and regional deployment gates. */
export function createRoutedMcpHandler(ports:RoutedMcpPorts) {
  const allowed=new Set(spaceList.parse([...ports.allowedMedicalSpaceIds]));
  const seoul=new Set(spaceList.parse([...ports.seoulSpaceIds]));
  const {clock,authority,ledger,provider}=ports;
  let budgetId:string,budgetPolicy:RoutingBudgetPolicy;
  try {
    budgetId=identifier.parse(ports.budgetId);budgetPolicy=Object.freeze(parseRoutingBudgetPolicy(ports.budgetPolicy));
    if(!ports.budget||typeof ports.budget.reserve!=='function'||typeof ports.budget.finalize!=='function')throw new Error();
  } catch {return fail(503,'routing_configuration_invalid');}
  const budget=ports.budget;
  return async(request:Request,token:string):Promise<Response>=>{
    const parsed=envelope.safeParse(await body(request,undefined,2*1024*1024));
    if(!parsed.success) fail(400,'routing_request_invalid');
    const {id:requestId,params}=parsed.data;
    let admitted:LedgerTicket|undefined,dispatched=false,accepted=false,recorded=false,readFailed=false;
    let operationId:string|undefined;
    let reservationId:string|undefined,reservation:RoutingBudgetReservation|undefined,budgetAttempted=false;
    try {
      const checkAbort=()=>{if(request.signal.aborted)fail(499,'routing_request_aborted');};
      checkAbort();
      const parsedInput=(params.name==='memory_ingest'?ingestArgs:searchArgs).safeParse(params.arguments);
      if(!parsedInput.success) fail(400,'routing_request_invalid');
      const input=parsedInput.data;
      if('query' in input&&input.mode!==undefined)fail(400,'routing_search_mode_unavailable');
      const plan=resolveMemoryRoute(input.routing,seoul.has(input.spaceId)?[{route:'seoul'}]:[]);
      if(plan.route!=='agent-memory'||input.routing.classification!=='medical'||!allowed.has(input.spaceId))
        fail(403,'routing_space_not_enabled');
      const reference=medicalCloudflareConsentReferenceSchema.safeParse(input.routing.medicalCloudflareConsent);
      if(!reference.success)fail(403,'routing_consent_reference_required');
      const receipt=request.headers.get('x-memory-consent-receipt');
      if(!receipt||!/^[A-Za-z0-9_-]{1,4096}$/.test(receipt))fail(403,'routing_consent_receipt_required');
      const ledgerRequestId=await routingLedgerRequestId(requestId);checkAbort();
      const first=await authority(token,input.spaceId,params.name); checkAbort();
      const trusted:LedgerAuthorityInput={organizationId:first.organizationId,accountId:first.accountId,
        credentialId:first.credentialId,spaceId:input.spaceId,operation:params.name,requestId:ledgerRequestId,authorityExpiresAtMs:first.authorityExpiresAtMs};
      const {authorityExpiresAtMs:_,...ticketActor}=trusted;
      if(first.spaceId!==input.spaceId||first.operation!==params.name||first.authorityExpiresAtMs<=clock())fail(403,'routing_authority_expired');
      const stub=ledger(first.organizationId);
      // The same operation may refresh its receipt, but cannot change content,
      // source session, Space, classification, or consent reference on replay.
      // JSON-RPC IDs are reusable in a new MCP session. A fresh read receipt
      // admits a fresh search, while ingest retains its explicit idempotency key.
      operationId='operationId' in input ? input.operationId : crypto.randomUUID();
      const payloadHash=await digest(canonical({operation:params.name,input})); checkAbort();
      admitted=await stub.consume({...trusted,reference:reference.data,receipt,payloadHash,operationId}); checkAbort();
      if(!admitted.dispatch) return response(requestId,{operationId,state:admitted.state==='admitted'?'unknown':admitted.state,
        replayed:true,providerDispatched:false},admitted.state!=='accepted');
      // A consent ticket has exactly one provider admission across callers and
      // retries. Its deployment-wide reservation survives uncertain outcomes.
      reservationId='medical-'+await digest(canonical(['medical-budget-v1',trusted.organizationId,trusted.spaceId,admitted.id]));checkAbort();
      const usage='messages' in input?{inputBytes:input.messages.reduce((sum,message)=>sum+new TextEncoder().encode(message.content).length,0),messageCount:input.messages.length}
        :{inputBytes:new TextEncoder().encode(input.query).length,messageCount:0};
      const reservationAuthority=Math.min(trusted.authorityExpiresAtMs,admitted.expiresAtMs);
      budgetAttempted=true;
      const reserved=reservationSchema.safeParse(await budget.reserve({budgetId,reservationId,spaceId:trusted.spaceId,operation:params.name,
        payloadHash,usage,authorityExpiresAtMs:reservationAuthority,policy:budgetPolicy}));
      if(!reserved.success||reserved.data.reservationId!==reservationId
        ||reserved.data.expiresAtMs>Math.min(reservationAuthority,budgetPolicy.validUntilMs,clock()+60000)
        ||reserved.data.reservedMicroUsd>budgetPolicy.maxMonthlyReservedMicroUsd)fail(503,'routing_budget_response_invalid');
      reservation=reserved.data;checkAbort();
      if(reservation.replayed)fail(403,'routing_budget_reservation_replayed');
      const checkBudget=()=>{if(reservation!.expiresAtMs<=clock())fail(403,'routing_budget_authority_expired');};
      checkBudget();
      const finalize=async(state:'accepted'|'unknown'|'read_failed')=>{
        // Either journal may be temporarily unavailable. Attempt both outcomes
        // even when the other write fails; neither path refunds reservations.
        const outcomes=await Promise.allSettled([
          Promise.resolve().then(()=>stub.finalize({...ticketActor,ticketId:admitted!.id,state})),
          Promise.resolve().then(()=>budget.finalize({budgetId,reservationId:reservationId!,state})),
        ]);
        if(outcomes.some(outcome=>outcome.status==='rejected'))fail(503,'routing_outcome_recording_failed');
      };
      const refresh=async():Promise<LedgerAuthorityInput>=>{
        checkAbort();const current=await authority(token,input.spaceId,params.name);checkAbort();
        if(current.organizationId!==trusted.organizationId||current.accountId!==trusted.accountId||current.credentialId!==trusted.credentialId
          ||current.spaceId!==trusted.spaceId||current.operation!==trusted.operation||current.authorityExpiresAtMs<=clock())fail(403,'routing_authority_changed');
        return {...trusted,authorityExpiresAtMs:current.authorityExpiresAtMs};
      };
      // Profiles are isolated by owner organization, Space and consent identity.
      // A newly granted identity cannot silently search a revoked identity's data.
      const profile='medical-'+await digest(canonical(['medical-profile-v1',trusted.organizationId,trusted.spaceId,admitted.consentId]));
      const session='sessionId' in input && input.sessionId ? input.sessionId : 'op-'+(await digest(operationId)).slice(0,48);
      const dispatchAuthority=await refresh();
      await stub.checkTicket({...dispatchAuthority,ticketId:admitted.id,phase:'dispatch'});checkAbort();checkBudget();
      const deadlineMs=Math.min(admitted.expiresAtMs,dispatchAuthority.authorityExpiresAtMs,reservation.expiresAtMs,clock()+15_000);
      if(deadlineMs<=clock())fail(403,'routing_authority_expired');
      let output:unknown;
      try {
        dispatched=true;
        if('messages' in input) {
          await provider.ingest(profile,input.messages,session,{signal:request.signal,deadlineMs});
          output={operationId,state:'accepted',sessionId:session,processing:'asynchronous'};
        } else {
          const found=await provider.recall(profile,input.query,{thinkingLevel:'low',responseLength:'short'},
            {signal:request.signal,deadlineMs});
          output={state:'accepted',answer:found.answer,candidates:found.candidates.slice(0,input.limit??20),count:found.count};
        }
        accepted=true;
      } catch(error) {
        // Persist a conservative terminal outcome even when the incoming request
        // has gone away. A remote write error never grants permission to retry.
        await finalize(params.name==='memory_ingest'?'unknown':'read_failed');
        readFailed=params.name==='memory_search';
        throw error;
      }
      await finalize('accepted');
      recorded=true;
      const encoded=JSON.stringify({jsonrpc:'2.0',id:requestId,result:{content:[{type:'text',text:JSON.stringify(output)}]}});
      if(new TextEncoder().encode(encoded).length>900_000)fail(502,'routing_response_too_large');
      const discloseAuthority=await refresh();
      await stub.checkTicket({...discloseAuthority,ticketId:admitted.id,phase:'disclose'});checkAbort();checkBudget();
      // A fresh grant can be shorter than the initial ticket and reservation.
      // The DO checked it before its RPC response arrived; fence that latency
      // synchronously here, with no await before returning the encoded output.
      if(Math.min(discloseAuthority.authorityExpiresAtMs,admitted.expiresAtMs,reservation.expiresAtMs)<=clock())
        fail(403,'routing_authority_expired');
      return new Response(encoded,{headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
    } catch(error) {
      if(budgetAttempted&&reservationId&&!dispatched&&!reservation?.replayed){
        // reserve() may have committed despite an unavailable response. Record
        // the known no-egress outcome if possible, without issuing another reserve.
        try{await budget.finalize({budgetId,reservationId,state:'not_dispatched'});}catch{/* Preserve the original error and conservative reservation. */}
      }
      return response(requestId,{error:safeCode(error),...(operationId?{operationId}:{}),
        state:accepted&&recorded?'accepted':readFailed?'read_failed':dispatched?'unknown':admitted?'admitted':'not_dispatched'},true);
    }
  };
}

function configuredSpaces(raw:string|undefined,required:boolean):string[] {
  try {return spaceList.parse(raw===undefined?(required?null:[]):JSON.parse(raw));}
  catch {return fail(503,'routing_configuration_invalid');}
}
/** Called after the base application authenticates SSO/PAT or the CSRF-checked
 * interactive session. The bearer here is already a service credential token. */
export async function routedMcp(request:Request,token:string,env:ReleaseEnv,clock:()=>number=Date.now):Promise<Response|null> {
  if(new URL(request.url).pathname!=='/mcp'||!request.headers.has('x-memory-consent-receipt'))return null;
  if(request.method!=='POST')fail(405,'routing_method_not_allowed');
  if(env.MEMORY_ROUTING_ENABLED!=='true'||!env.MEMORY_CONSENT_LEDGER||!env.MEMORY_AGENT_MEMORY_TOKEN
    ||!env.MEMORY_AGENT_MEMORY_ACCOUNT_ID||!env.MEMORY_AGENT_MEMORY_NAMESPACE||!env.MEMORY_AGENT_MEMORY_BUDGET
    ||!env.MEMORY_ROUTING_BUDGET_ID||!env.MEMORY_ROUTING_BUDGET_POLICY_JSON)fail(503,'routing_runtime_unavailable');
  const namespace=env.MEMORY_CONSENT_LEDGER;
  let budgetId:string,budgetPolicy:RoutingBudgetPolicy;
  try{budgetId=identifier.parse(env.MEMORY_ROUTING_BUDGET_ID);budgetPolicy=parseRoutingBudgetPolicy(JSON.parse(env.MEMORY_ROUTING_BUDGET_POLICY_JSON));}
  catch{return fail(503,'routing_configuration_invalid');}
  return createRoutedMcpHandler({clock,allowedMedicalSpaceIds:configuredSpaces(env.MEMORY_ROUTING_MEDICAL_SPACES_JSON,true),
    seoulSpaceIds:configuredSpaces(env.MEMORY_ROUTING_SEOUL_SPACES_JSON,false),
    authority:(token,spaceId,operation)=>resolveRoutingAuthority(env.DB,token,spaceId,operation,clock),
    ledger:organizationId=>namespace.getByName('organization:'+organizationId),
    budgetId,budgetPolicy,budget:env.MEMORY_AGENT_MEMORY_BUDGET.getByName('budget:'+budgetId),
    provider:createAgentMemoryHttp({accountId:env.MEMORY_AGENT_MEMORY_ACCOUNT_ID,namespace:env.MEMORY_AGENT_MEMORY_NAMESPACE,
      token:env.MEMORY_AGENT_MEMORY_TOKEN,fetch:env.fetch,maxResponseBytes:512*1024,maxRequestBytes:2*1024*1024}),
  })(request,token);
}

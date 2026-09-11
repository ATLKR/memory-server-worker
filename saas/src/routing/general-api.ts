import { z } from 'zod';
import type { ReleaseEnv } from '../release/types.ts';
import { body, fail, json } from '../release/util.ts';
import { pathIdentifier, requireMethod } from '../api.ts';
import { createAgentMemoryHttp } from '../agent-memory/http.ts';
import { createGeneralExecutor } from './general-executor.ts';
import { resolveGeneralRoutingAuthority } from './general-authority.ts';
import { parseRoutingBudgetPolicy } from './budget-ledger.ts';
import { routingRequestIdSchema } from './rpc-id.ts';
import { routingNow } from './server-authority.ts';
import type { GeneralOperation } from './general-types.ts';
import { generalMcpControl } from './general-protocol.ts';

const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const spaces=z.array(identifier).max(1024).refine(v=>new Set(v).size===v.length);
const generalCheckSchema=z.strictObject({version:z.literal(1),requestId:routingRequestIdSchema,
  operation:z.enum(['memory_ingest','memory_search'])});
const generalSpaceCheckSchema=generalCheckSchema.extend({spaceId:identifier});
const envelope=z.strictObject({jsonrpc:z.literal('2.0'),id:routingRequestIdSchema,method:z.literal('tools/call'),
  params:z.strictObject({name:z.enum(['memory_ingest','memory_search','memory_clear_space','memory_usage']),arguments:z.unknown(),
    _meta:z.record(z.string(),z.unknown()).refine(v=>new TextEncoder().encode(JSON.stringify(v)).length<=8192).optional()})});
function spaceList(raw:string|undefined,required=false):string[] {
  try{return spaces.parse(raw===undefined?(required?null:[]):JSON.parse(raw));}catch{return fail(503,'routing_configuration_invalid');}
}
export function requireRoutingProvider(env:ReleaseEnv,kind:'general'|'medical',spaceId?:string,clock:()=>number=Date.now,allowExpiredBudget=false) {
  if((kind==='general'?(env.MEMORY_GENERAL_ROUTING_ENABLED!=='true'||!env.MEMORY_AGENT_MEMORY_SPACES)
    :(env.MEMORY_ROUTING_ENABLED!=='true'||!env.MEMORY_CONSENT_LEDGER))||!env.MEMORY_AGENT_MEMORY_BUDGET
    ||!env.MEMORY_AGENT_MEMORY_TOKEN||!env.MEMORY_AGENT_MEMORY_ACCOUNT_ID||!env.MEMORY_AGENT_MEMORY_NAMESPACE)
    fail(503,'routing_runtime_unavailable');
  let budgetPolicy,budgetId:string;
  try {
    budgetId=identifier.parse(env.MEMORY_ROUTING_BUDGET_ID);
    budgetPolicy=parseRoutingBudgetPolicy(JSON.parse(env.MEMORY_ROUTING_BUDGET_POLICY_JSON??''));
    if(!/^[a-f0-9]{32}$/.test(env.MEMORY_AGENT_MEMORY_ACCOUNT_ID)||!/^[A-Za-z0-9_-]{1,32}$/.test(env.MEMORY_AGENT_MEMORY_NAMESPACE)
      ||(!allowExpiredBudget&&budgetPolicy.validUntilMs<=clock()))throw new Error('invalid');
    // Construction validates the same credential/transport contract as actual
    // dispatch and performs no network request. Do not advertise invalid config.
    createAgentMemoryHttp({accountId:env.MEMORY_AGENT_MEMORY_ACCOUNT_ID,namespace:env.MEMORY_AGENT_MEMORY_NAMESPACE,
      token:env.MEMORY_AGENT_MEMORY_TOKEN,fetch:env.fetch,maxResponseBytes:512*1024,maxRequestBytes:2*1024*1024});
  }catch{return fail(503,'routing_configuration_invalid');}
  const allowedSpaceIds=spaceList(kind==='general'?env.MEMORY_ROUTING_GENERAL_SPACES_JSON:env.MEMORY_ROUTING_MEDICAL_SPACES_JSON,true);
  const seoulSpaceIds=spaceList(env.MEMORY_ROUTING_SEOUL_SPACES_JSON);
  if(spaceId&&(!allowedSpaceIds.includes(spaceId)||seoulSpaceIds.includes(spaceId)))fail(403,'routing_space_not_enabled');
  return {allowedSpaceIds,seoulSpaceIds,budgetId,budgetPolicy};
}
/** Protocol availability only. /ready remains the independent GA acceptance gate. */
export function routingDiscovery(env:ReleaseEnv,clock:()=>number=Date.now) {
  let ready=false;
  for(const kind of ['general','medical'] as const)try{
    const config=requireRoutingProvider(env,kind,undefined,clock);
    if(config.allowedSpaceIds.some(id=>!config.seoulSpaceIds.includes(id)))ready=true;
  }catch{/* Configuration failure cannot advertise a content destination. */}
  return {version:1,protocol:'memory-routing-v1',target:{route:'agent-memory',storage:'cloudflare-agent-memory',
    vector:'managed-agent-memory',region:'cloudflare',ready}};
}
/** Metadata permission for this exact Space and operation before a client sends
 * plaintext. This is neither a durable grant nor residency/consent attestation:
 * dispatch still resolves fresh authority and its current routing policy. */
export async function checkGeneralRoute(env:ReleaseEnv,token:string,input:unknown,clock:()=>number=Date.now) {
  const parsed=generalSpaceCheckSchema.safeParse(input);
  if(!parsed.success)fail(400,'routing_request_invalid');
  const request=parsed.data,startedAt=routingNow(clock);
  const {budgetPolicy}=requireRoutingProvider(env,'general',request.spaceId,clock);
  const authority=await resolveGeneralRoutingAuthority(env.DB,token,request.spaceId,request.operation,clock);
  const expiresAtMs=Math.min(startedAt+60000,authority.authorityExpiresAtMs,budgetPolicy.validUntilMs);
  // Do not publish a check whose policy or authority expired during the last
  // primary read, including the interval after the resolver's own expiry check.
  if(expiresAtMs<=routingNow(clock))fail(403,'routing_preflight_expired');
  return {version:1 as const,allowed:true as const,requestId:request.requestId,spaceId:request.spaceId,
    operation:request.operation,route:'agent-memory' as const,issuedAtMs:startedAt,expiresAtMs};
}
function errorStatus(code:unknown):number {
  if(code==='routing_request_invalid')return 400;
  if(typeof code==='string'&&/(?:exhausted|capacity)/.test(code))return 429;
  if(typeof code==='string'&&/(?:denied|expired|changed|not_enabled|retired)/.test(code))return 403;
  if(typeof code==='string'&&/conflict/.test(code))return 409;
  return 503;
}
export function createGeneralApi(env:ReleaseEnv,options:{clock?:()=>number;executor?:ReturnType<typeof createGeneralExecutor>}={}) {
  const clock=options.clock??Date.now;
  return async(request:Request,token:string):Promise<Response|null>=>{
    const url=new URL(request.url),isMcp=url.pathname==='/mcp'&&request.headers.has('x-memory-routing');
    const rest=/^\/v1\/spaces\/([^/]+)\/agent-memory\/(ingest|search|clear|usage|check)$/.exec(url.pathname);
    if(!isMcp&&!rest)return null;
    if(url.search)fail(400,'routing_request_invalid');
    if(isMcp&&request.headers.get('x-memory-routing')!=='1')fail(400,'routing_protocol_invalid');
    requireMethod(request,rest?.[2]==='usage'?'GET':'POST');
    if(rest?.[2]==='check') {
      const parsed=generalCheckSchema.safeParse(await body(request,undefined,8192));
      if(!parsed.success)fail(400,'routing_request_invalid');
      const result=await checkGeneralRoute(env,token,{...parsed.data,spaceId:pathIdentifier(rest[1]!)},clock);
      if(request.signal.aborted)fail(499,'routing_request_aborted');
      if(result.expiresAtMs<=routingNow(clock))fail(403,'routing_preflight_expired');
      return json(result);
    }
    const incoming=isMcp?await body(request,undefined,2*1024*1024):undefined;
    if(isMcp) {
      const control=await generalMcpControl(request,incoming,{title:env.PRODUCT_NAME,
        check:async(spaceId,operation,requestId)=>{
          const result=await checkGeneralRoute(env,token,{spaceId,operation,requestId,version:1},clock);
          if(request.signal.aborted)fail(499,'routing_request_aborted');
          if(result.expiresAtMs<=routingNow(clock))fail(403,'routing_preflight_expired');
          return result;
        }});
      if(control)return control;
    }
    const parsed=isMcp?envelope.safeParse(incoming):undefined;
    if(parsed&&!parsed.success)fail(400,'routing_request_invalid');
    const rpc=parsed?.data;
    const maintenance=rest?.[2]==='clear'||rest?.[2]==='usage'||rpc?.params.name==='memory_clear_space'||rpc?.params.name==='memory_usage';
    const config=requireRoutingProvider(env,'general',undefined,clock,maintenance);
    const execute=options.executor??createGeneralExecutor({...config,clock,
      providerIdentity:{accountId:env.MEMORY_AGENT_MEMORY_ACCOUNT_ID!,namespace:env.MEMORY_AGENT_MEMORY_NAMESPACE!},
      ledger:spaceId=>env.MEMORY_AGENT_MEMORY_SPACES!.getByName('space:'+spaceId),
      budget:env.MEMORY_AGENT_MEMORY_BUDGET!.getByName('budget:'+config.budgetId),
      authority:(token,spaceId,operation)=>resolveGeneralRoutingAuthority(env.DB,token,spaceId,operation,clock),
      provider:createAgentMemoryHttp({accountId:env.MEMORY_AGENT_MEMORY_ACCOUNT_ID!,namespace:env.MEMORY_AGENT_MEMORY_NAMESPACE!,
        token:env.MEMORY_AGENT_MEMORY_TOKEN!,fetch:env.fetch,maxResponseBytes:512*1024,maxRequestBytes:2*1024*1024}),
    });
    if(isMcp) {
      const {id,params}=rpc!,result=await execute(params.name,params.arguments,token,{signal:request.signal});
      return json({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result.body)}],...(result.ok?{}:{isError:true})}});
    }
    const names:Record<string,GeneralOperation>={ingest:'memory_ingest',search:'memory_search',clear:'memory_clear_space',usage:'memory_usage'};
    const name=names[rest![2]!]!;
    const input=name==='memory_usage'?{routing:{version:1,classification:'general'}}:await body(request,undefined,2*1024*1024);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.hasOwn(input,'spaceId'))fail(400,'routing_request_invalid');
    const result=await execute(name,{...input,spaceId:pathIdentifier(rest![1]!)},token,{signal:request.signal});
    return json(result.body,result.ok?200:errorStatus(result.body.error));
  };
}

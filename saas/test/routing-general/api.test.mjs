import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeneralApi, routingDiscovery, requireRoutingProvider, checkGeneralRoute } from '../../src/routing/general-api.ts';
import { fixture, at } from '../../release-validation/tests/db.mjs';
import { createRoutingClient } from '../../src/routing/client.ts';

const policy={version:1,revision:'test-v1',validUntilMs:Date.now()+60000,maxMonthlyRequests:100,
  maxMonthlyInputBytes:1000000,maxMonthlyReservedMicroUsd:1000000,ingestBaseMicroUsd:100,
  ingestMicroUsdPerKiB:10,searchBaseMicroUsd:100,searchMicroUsdPerKiB:10,pricingBasis:'operator-upper-bound'};
const configured={MEMORY_GENERAL_ROUTING_ENABLED:'true',MEMORY_AGENT_MEMORY_SPACES:{getByName(){}},
  MEMORY_AGENT_MEMORY_BUDGET:{getByName(){}},MEMORY_ROUTING_GENERAL_SPACES_JSON:'["space"]',
  MEMORY_ROUTING_BUDGET_ID:'budget',MEMORY_ROUTING_BUDGET_POLICY_JSON:JSON.stringify(policy),
  MEMORY_AGENT_MEMORY_ACCOUNT_ID:'a'.repeat(32),MEMORY_AGENT_MEMORY_NAMESPACE:'test',MEMORY_AGENT_MEMORY_TOKEN:'synthetic'};
test('discovery is fail closed for absent bindings, expired policy and overlapping Seoul locks',()=>{
  assert.equal(routingDiscovery({}).target.ready,false);assert.equal(routingDiscovery(configured).target.ready,true);
  assert.equal(routingDiscovery({...configured,MEMORY_AGENT_MEMORY_BUDGET:undefined}).target.ready,false);
  assert.equal(routingDiscovery({...configured,MEMORY_ROUTING_BUDGET_POLICY_JSON:JSON.stringify({...policy,validUntilMs:1})}).target.ready,false);
  assert.equal(routingDiscovery({...configured,MEMORY_ROUTING_SEOUL_SPACES_JSON:'["space"]'}).target.ready,false);
  for(const token of ['bad token','x'.repeat(4097),'비밀','\ninvalid'])
    assert.equal(routingDiscovery({...configured,MEMORY_AGENT_MEMORY_TOKEN:token}).target.ready,false);
});
test('medical preflight separately requires active runtime, budget and Space allowlist',()=>{
  assert.throws(()=>requireRoutingProvider(configured,'medical','space'),/routing_runtime_unavailable/);
  const medical={...configured,MEMORY_ROUTING_ENABLED:'true',MEMORY_CONSENT_LEDGER:{},MEMORY_ROUTING_MEDICAL_SPACES_JSON:'["space"]'};
  assert.doesNotThrow(()=>requireRoutingProvider(medical,'medical','space'));
  assert.throws(()=>requireRoutingProvider(medical,'medical','another'),/routing_space_not_enabled/);
});
test('new protocol is explicit and never intercepts ordinary legacy MCP calls',async()=>{
  const route=createGeneralApi({});assert.equal(await route(new Request('https://memory.test/mcp',{method:'POST'}),'token'),null);
  await assert.rejects(()=>route(new Request('https://memory.test/mcp',{method:'POST',headers:{'x-memory-routing':'2'}}),'token'),/routing_protocol_invalid/);
});
test('REST and MCP share executor input and preserve exact authenticated token',async()=>{
  const calls=[];const route=createGeneralApi(configured,{executor:async(...args)=>{calls.push(args);return {ok:true,body:{state:'accepted'}};}});
  const input={routing:{version:1,classification:'general'},operationId:'operation',messages:[{role:'user',content:'synthetic'}]};
  const rest=await route(new Request('https://memory.test/v1/spaces/space/agent-memory/ingest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}),'pat');
  assert.equal(rest.status,200);assert.equal(rest.headers.get('cache-control'),'no-store');
  const mcp=await route(new Request('https://memory.test/mcp',{method:'POST',headers:{'content-type':'application/json','x-memory-routing':'1'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'memory_ingest',arguments:{...input,spaceId:'space'}}})}),'pat');
  assert.equal((await mcp.json()).id,7);assert.deepEqual(calls[0].slice(0,3),calls[1].slice(0,3));
});
test('REST cannot override its URL Space or pass queries; usage is read-only GET',async()=>{
  let calls=0;const route=createGeneralApi(configured,{executor:async()=>{calls++;return {ok:true,body:{}};}});
  await assert.rejects(()=>route(new Request('https://memory.test/v1/spaces/space/agent-memory/ingest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({spaceId:'other'})}),'pat'),/routing_request_invalid/);
  await assert.rejects(()=>route(new Request('https://memory.test/v1/spaces/space/agent-memory/usage?query=secret'),'pat'),/routing_request_invalid/);
  assert.equal((await route(new Request('https://memory.test/v1/spaces/space/agent-memory/usage'),'pat')).status,200);assert.equal(calls,1);
});
test('expired spend policy cannot prevent explicit privacy clear or usage inspection',async()=>{
  const env={...configured,MEMORY_ROUTING_BUDGET_POLICY_JSON:JSON.stringify({...policy,validUntilMs:1})};
  const route=createGeneralApi(env,{executor:async()=>({ok:true,body:{logicallyHidden:true}})});
  const r=await route(new Request('https://memory.test/v1/spaces/space/agent-memory/clear',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({routing:{version:1,classification:'general'},operationId:'clear',scope:'all-general-memory-in-space'})}),'pat');
  assert.equal(r.status,200);
  assert.equal((await route(new Request('https://memory.test/v1/spaces/space/agent-memory/usage'),'pat')).status,200);
});

async function checkFixture(t) {
  let now=at;const f=await fixture({clock:()=>now});t.after(()=>f.db.close());
  let touched=0;const namespace={getByName(){touched++;throw Error('preflight cannot use a ledger');}};
  const env={...configured,DB:f.db,MEMORY_AGENT_MEMORY_SPACES:namespace,MEMORY_AGENT_MEMORY_BUDGET:namespace,
    MEMORY_ROUTING_GENERAL_SPACES_JSON:'["s1","so"]',MEMORY_ROUTING_BUDGET_POLICY_JSON:JSON.stringify({...policy,validUntilMs:at+120000}),
    fetch:async()=>{touched++;throw Error('preflight cannot call a provider');}};
  return {...f,env,clock:()=>now,setNow:value=>{now=value;},touched:()=>touched};
}
const checkInput={version:1,requestId:'check-1',operation:'memory_ingest'};
function checkRequest(input=checkInput,space='s1') {
  return new Request('https://memory.test/v1/spaces/'+space+'/agent-memory/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
}
test('metadata-only general check uses current exact-Space PAT ACL without provider or ledger writes',async t=>{
  const f=await checkFixture(t),route=createGeneralApi(f.env,{clock:f.clock});
  const response=await route(checkRequest(),f.key);
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{...checkInput,allowed:true,spaceId:'s1',route:'agent-memory',issuedAtMs:at,expiresAtMs:at+60000});
  assert.deepEqual(await checkGeneralRoute(f.env,f.key,{...checkInput,spaceId:'s1',requestId:7},f.clock),
    {...checkInput,requestId:7,allowed:true,spaceId:'s1',route:'agent-memory',issuedAtMs:at,expiresAtMs:at+60000});
  await assert.rejects(()=>route(checkRequest(checkInput,'so'),f.key),{status:403,code:'access_denied'});
  f.db.raw.prepare("UPDATE release_credential_policies SET capabilities='[\"read\"]' WHERE credential_id='key:alice'").run();
  await assert.rejects(()=>route(checkRequest(),f.key),{status:403,code:'access_denied'});
  assert.equal((await route(checkRequest({...checkInput,operation:'memory_search'}),f.key)).status,200);
  f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='key:alice'").run(at);
  await assert.rejects(()=>route(checkRequest({...checkInput,operation:'memory_search'}),f.key),{status:403,code:'access_denied'});
  assert.equal(f.touched(),0);
});
test('general check rejects content, overrides, unsupported operations and disabled runtime',async t=>{
  const f=await checkFixture(t),route=createGeneralApi(f.env,{clock:f.clock});
  for(const extra of [{messages:[]},{query:'private'},{routing:{classification:'general'}},{spaceId:'so'},{version:2},
    {operation:'memory_clear_space'},{operation:'memory_usage'},{requestId:null}])
    await assert.rejects(()=>route(checkRequest({...checkInput,...extra}),f.key),{status:400});
  await assert.rejects(()=>createGeneralApi({...f.env,MEMORY_GENERAL_ROUTING_ENABLED:'false'},{clock:f.clock})(checkRequest(),f.key),{status:503});
  assert.equal(f.touched(),0);
});
test('general check expiry is bounded by current authority and spend policy after the last await',async t=>{
  const f=await checkFixture(t),input={...checkInput,spaceId:'s1'};
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='key:alice'").run(at+45000);
  assert.equal((await checkGeneralRoute(f.env,f.key,input,f.clock)).expiresAtMs,at+45000);
  f.env.MEMORY_ROUTING_BUDGET_POLICY_JSON=JSON.stringify({...policy,validUntilMs:at+20000});
  assert.equal((await checkGeneralRoute(f.env,f.key,input,f.clock)).expiresAtMs,at+20000);
  let reads=0;const clock=()=>++reads<=4?at:at+20000;
  await assert.rejects(()=>checkGeneralRoute(f.env,f.key,input,clock),{status:403,code:'routing_preflight_expired'});
  f.setNow(NaN);await assert.rejects(()=>checkGeneralRoute(f.env,f.key,input,f.clock),{status:503,code:'routing_clock_invalid'});
});
test('a globally ready different Space cannot receive client plaintext for a server Seoul-locked target',async t=>{
  const f=await checkFixture(t);f.env.MEMORY_ROUTING_SEOUL_SPACES_JSON='["s1"]';
  assert.equal(routingDiscovery(f.env,f.clock).target.ready,true);
  const calls=[],route=createGeneralApi(f.env,{clock:f.clock});
  const client=createRoutingClient({targets:{'agent-memory':{origin:'https://memory.test',spaceId:'s1'}},
    credential:async()=>({kind:'pat',token:f.key}),fetch:async(url,init)=>{
      calls.push({url:String(url),init});
      if(init.method==='GET')return Response.json(routingDiscovery(f.env,f.clock));
      try{return await route(new Request(url,init),f.key);}catch(error){return Response.json({error:error.code},{status:error.status});}
    }});
  for(const operation of ['memory_ingest','memory_search']) {
    const content=operation==='memory_ingest'?{operationId:'private-operation',messages:[{role:'user',content:'SEOUL-ONLY-RAW'}]}:{query:'SEOUL-ONLY-RAW'};
    await assert.rejects(()=>client.call(operation,{routing:{version:1,classification:'general'},...content}),{code:'routing_preflight_unavailable'});
  }
  assert.equal(calls.length,4);assert.equal(calls.filter(c=>c.url.endsWith('/mcp')).length,0);
  assert.equal(JSON.stringify(calls).includes('SEOUL-ONLY-RAW'),false);
  for(const call of calls.filter(c=>c.init.method==='POST'))assert.deepEqual(Object.keys(JSON.parse(call.init.body)).sort(),['operation','requestId','version']);
  assert.equal(f.touched(),0);
});

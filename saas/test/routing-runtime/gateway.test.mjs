import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutedMcpHandler, routedMcp } from '../../src/routing/server-mcp.ts';

const now = Date.now(), origin = 'https://memory.example.test';
const reference = {consentId:'consent-a',version:1};
const budgetPolicy = {version:1,revision:'synthetic-v1',validUntilMs:now+3600000,maxMonthlyRequests:100,
  maxMonthlyInputBytes:1000000,maxMonthlyReservedMicroUsd:1000000,ingestBaseMicroUsd:10,ingestMicroUsdPerKiB:1,
  searchBaseMicroUsd:20,searchMicroUsdPerKiB:1,pricingBasis:'operator-upper-bound'};
function fixture(overrides = {}) {
  const events = [], providerCalls = [], reservations = [], budgetOutcomes = [];
  const auth = {organizationId:'org-a',accountId:'account-a',credentialId:'credential-a',spaceId:'space-a',
    operation:'memory_ingest',authorityExpiresAtMs:now+60_000};
  const ticket = {id:'ticket-a',operationId:'operation-a',requestId:'request-a',state:'admitted',consentId:'consent-a',consentVersion:1,
    expiresAtMs:now+60_000,dispatch:true,...auth};
  const ledger = {
    async consume(input) {events.push('consume'); assert.equal(input.receipt,'opaque-receipt'); return {...ticket,...input};},
    async checkTicket(input) {events.push(input.phase); return {...ticket,state:input.phase==='disclose'?'accepted':'admitted',dispatch:false};},
    async finalize(input) {events.push('finalize:'+input.state); return {...ticket,state:input.state,dispatch:false};},
    ...overrides.ledger,
  };
  const provider = {
    async ingest(...args) {events.push('ingest');providerCalls.push(args);},
    async recall(...args) {events.push('recall');providerCalls.push(args);return {answer:'Synthetic answer',count:1,candidates:[]};},
    ...overrides.provider,
  };
  const budget = {
    async reserve(input) {events.push('reserve');reservations.push(input);return {reservationId:input.reservationId,
      month:new Date(now).toISOString().slice(0,7),reservedMicroUsd:input.operation==='memory_ingest'?11:21,
      expiresAtMs:Math.min(now+60_000,input.authorityExpiresAtMs,input.policy.validUntilMs),replayed:false};},
    async finalize(input) {events.push('budget:'+input.state);budgetOutcomes.push(input);},
    async usage(){throw new Error('not used');},
    ...overrides.budget,
  };
  const handler = createRoutedMcpHandler({
    clock:()=>now, allowedMedicalSpaceIds:['space-a'], seoulSpaceIds:[],
    async authority(_token,spaceId,operation) {events.push('authority');return {...auth,spaceId,operation};},
    ledger:()=>ledger, provider, budgetId:'synthetic-medical',budgetPolicy,budget,...overrides.ports,
  });
  const request = (args={}, name='memory_ingest', options={}) => new Request(origin+'/mcp', {
    method:'POST',headers:{'content-type':'application/json','x-memory-consent-receipt':'opaque-receipt'},
    body:JSON.stringify({jsonrpc:'2.0',id:'request-a',method:'tools/call',params:{name,arguments:{
      spaceId:'space-a',routing:{version:1,classification:'medical',destination:'agent-memory',medicalCloudflareConsent:reference},
      ...(name==='memory_ingest'?{operationId:'operation-a',messages:[{role:'user',content:'Synthetic content.'}]}:{query:'Synthetic question?'}),...args}}}),...options,
  });
  return {handler,request,events,providerCalls,ticket,reservations,budgetOutcomes};
}
const result = async response => (await response.json()).result;

test('medical ingress rechecks authority and consent at dispatch and disclosure, with durable admission first', async () => {
  const f=fixture(); const response=await f.handler(f.request(),'opaque-token');
  assert.equal(response.status,200);
  assert.equal((await result(response)).isError,undefined);
  assert.deepEqual(f.events,['authority','consume','reserve','authority','dispatch','ingest','finalize:accepted','budget:accepted','authority','disclose']);
  assert.equal(f.providerCalls.length,1);
  assert.match(f.providerCalls[0][0],/^medical-[a-f0-9]{64}$/);
  assert.deepEqual(f.providerCalls[0][1],[{role:'user',content:'Synthetic content.'}]);
  assert.deepEqual(f.reservations[0].usage,{inputBytes:18,messageCount:1});
  assert.match(f.reservations[0].reservationId,/^medical-[a-f0-9]{64}$/);
});

test('a provider timeout persists unknown and reports no retry permission', async () => {
  const f=fixture({provider:{async ingest(){throw Object.assign(new Error('never expose raw provider error'),{outcome:'unknown'});}}});
  const response=await f.handler(f.request(),'opaque-token'); const body=await result(response);
  assert.equal(body.isError,true);assert.match(body.content[0].text,/unknown/);
  assert.doesNotMatch(body.content[0].text,/raw provider/);assert.ok(f.events.includes('finalize:unknown'));
});

test('failed recall reports the persisted read failure without claiming an uncertain write', async () => {
  const f=fixture({provider:{async recall(){throw Object.assign(new Error('sanitized'),{outcome:'read_failed'});}}});
  const body=await result(await f.handler(f.request({},'memory_search'),'opaque-token'));
  assert.equal(body.isError,true);assert.equal(JSON.parse(body.content[0].text).state,'read_failed');
  assert.ok(f.events.includes('finalize:read_failed'));
});

test('admitted or unknown replay never calls the provider twice', async () => {
  for(const state of ['admitted','unknown','accepted']) {
    const f=fixture({ledger:{async consume(input){return {id:'ticket-a',state,dispatch:false,operationId:input.operationId};}}});
    const body=await result(await f.handler(f.request(),'opaque-token'));
    assert.equal(f.providerCalls.length,0);assert.match(body.content[0].text,new RegExp(state==='admitted'?'unknown':state));
    assert.equal(f.reservations.length,0);assert.equal(f.budgetOutcomes.length,0);
  }
});

test('hard Seoul restrictions win over medical consent, without consuming or dispatching', async () => {
  const f=fixture({ports:{seoulSpaceIds:['space-a']}});
  const body=await result(await f.handler(f.request(),'opaque-token'));
  assert.equal(body.isError,true);assert.equal(f.providerCalls.length,0);assert.ok(!f.events.includes('consume'));
});

test('standing selector without the current resolved reference is rejected before provider egress', async () => {
  const f=fixture();const body=await result(await f.handler(f.request({routing:{version:1,classification:'medical',medicalCloudflareConsent:{mode:'organization'}}}),'opaque-token'));
  assert.equal(body.isError,true);assert.equal(f.providerCalls.length,0);
});

test('consent revocation during recall suppresses content while retaining accepted provider outcome', async () => {
  const f=fixture({ledger:{async checkTicket(input){if(input.phase==='disclose')throw Object.assign(new Error('routing_consent_unavailable'),{code:'routing_consent_unavailable'});return {};}}});
  const body=await result(await f.handler(f.request({},'memory_search'),'opaque-token'));
  assert.equal(body.isError,true);assert.doesNotMatch(JSON.stringify(body),/Synthetic answer/);assert.ok(f.events.includes('finalize:accepted'));
});

test('expired authority between receipt admission and provider dispatch prevents egress', async () => {
  let count=0;const f=fixture({ports:{async authority(_token,spaceId,operation){if(++count>1)throw Object.assign(new Error('access_denied'),{code:'access_denied'});return {organizationId:'org-a',accountId:'account-a',credentialId:'credential-a',spaceId,operation,authorityExpiresAtMs:now+60_000};}}});
  const body=await result(await f.handler(f.request(),'opaque-token'));
  assert.equal(body.isError,true);assert.equal(f.providerCalls.length,0);
});

test('invalid raw message and unapproved Spaces cannot bypass server constraints', async () => {
  for(const args of [{messages:[{role:'assistant',content:'x'.repeat(32769)}]},{spaceId:'unapproved-space'},{extra:true},
    {routing:{version:1,classification:'region-locked',destination:'agent-memory',medicalCloudflareConsent:reference}}]) {
    const f=fixture();const body=await result(await f.handler(f.request(args),'opaque-token'));
    assert.equal(body.isError,true);assert.equal(f.providerCalls.length,0);
  }
});

test('provider-invalid names, Unicode and timestamps never consume the receipt or dispatch',async()=>{
  const invalid=[...['.','..','a\nb','a\u007fb','\ud800'].map(sessionId=>({sessionId})),
    {messages:[{role:'user',content:'\ud800'}]},
    ...['0000-01-01T00:00:00Z','2026-09-11T00:00Z','2026-09-11T00:00:00.1234567890Z'].map(timestamp=>({messages:[{role:'user',content:'valid',timestamp}]}))];
  for(const args of invalid){
    const f=fixture();const body=await result(await f.handler(f.request(args),'opaque-token'));
    assert.equal(body.isError,true);assert.equal(JSON.parse(body.content[0].text).state,'not_dispatched');
    assert.equal(f.events.includes('consume'),false,JSON.stringify(args));assert.equal(f.providerCalls.length,0);
  }
  const f=fixture();const body=await result(await f.handler(f.request({query:'\udc00'},'memory_search'),'opaque-token'));
  assert.equal(body.isError,true);assert.equal(f.events.includes('consume'),false);
});

test('routed MCP echoes valid numeric and arbitrary string request IDs', async () => {
  for(const id of [0,1,-1,Number.MAX_SAFE_INTEGER,'','request with spaces','요청 1','rpc-number:1']) {
    const f=fixture(),wire=await f.request().json();wire.id=id;
    const request=f.request({},'memory_ingest',{body:JSON.stringify(wire)});
    const response=await f.handler(request,'opaque-token');
    const body=await response.json();
    assert.equal(body.id,id);assert.equal(body.result.isError,undefined);assert.equal(f.providerCalls.length,1);
  }
});

test('standard request metadata does not enter the ledger, payload hash or provider call', async () => {
  const consumed=[];
  const f=fixture({ledger:{async consume(input){consumed.push(input);return {...f.ticket,...input};}}});
  const plain=await f.handler(f.request(),'opaque-token');assert.equal((await plain.json()).result.isError,undefined);
  const wire=await f.request().json();wire.params._meta={progressToken:'progress-1',organizationId:'forged-org',spaceId:'forged-space',note:'metadata-only-marker'};
  const response=await f.handler(f.request({},'memory_ingest',{body:JSON.stringify(wire)}),'opaque-token');
  assert.equal((await response.json()).result.isError,undefined);
  assert.deepEqual(consumed[1],consumed[0]);
  assert.equal(JSON.stringify(consumed).includes('metadata-only-marker'),false);
  assert.equal(JSON.stringify(f.providerCalls).includes('metadata-only-marker'),false);
});

test('invalid request IDs and oversized or non-object metadata never reach admission', async () => {
  for(const change of [{id:null},{id:1.5},{id:Number.MAX_SAFE_INTEGER+1},{id:'x'.repeat(129)},
    {metadata:null},{metadata:[]},{metadata:{note:'x'.repeat(8192)}}]) {
    const f=fixture(),wire=await f.request().json();
    if('id' in change)wire.id=change.id;else wire.params._meta=change.metadata;
    await assert.rejects(f.handler(f.request({},'memory_ingest',{body:JSON.stringify(wire)}),'opaque-token'),{status:400});
    assert.equal(f.events.length,0);assert.equal(f.providerCalls.length,0);
  }
});

test('budget exhaustion after consent admission prevents provider work without a reservation retry',async()=>{
  let attempts=0;
  const f=fixture({budget:{async reserve(){attempts++;throw Object.assign(new Error('routing_budget_exhausted'),{code:'routing_budget_exhausted'});}}});
  const body=await result(await f.handler(f.request(),'opaque-token'));
  assert.equal(body.isError,true);assert.match(body.content[0].text,/routing_budget_exhausted/);
  assert.equal(attempts,1);assert.equal(f.providerCalls.length,0);
  assert.equal(f.budgetOutcomes[0].state,'not_dispatched');
});

test('medical reservations meter UTF-8 content bytes and query bytes without retaining raw input',async()=>{
  for(const [name,args,expected] of [['memory_ingest',{messages:[{role:'user',content:'한글🙂'}]},{inputBytes:10,messageCount:1}],
    ['memory_search',{query:'질문?'},{inputBytes:7,messageCount:0}]]){
    const f=fixture();const body=await result(await f.handler(f.request(args,name),'opaque-token'));
    assert.equal(body.isError,undefined);assert.deepEqual(f.reservations[0].usage,expected);
    assert.doesNotMatch(JSON.stringify(f.reservations),/한글|질문|opaque-token|opaque-receipt/);
  }
});

test('expired or replayed budget reservations never grant another provider dispatch',async()=>{
  for(const replayed of [false,true]){
    const f=fixture({budget:{async reserve(input){return {reservationId:input.reservationId,month:new Date(now).toISOString().slice(0,7),
      reservedMicroUsd:11,expiresAtMs:replayed?now+60_000:now,replayed};}}});
    const body=await result(await f.handler(f.request(),'opaque-token'));
    assert.equal(body.isError,true);assert.equal(f.providerCalls.length,0);
    if(replayed)assert.equal(f.budgetOutcomes.length,0);
  }
});

test('provider deadline is capped by the budget reservation expiry',async()=>{
  const f=fixture({budget:{async reserve(input){return {reservationId:input.reservationId,month:new Date(now).toISOString().slice(0,7),
    reservedMicroUsd:11,expiresAtMs:now+1000,replayed:false};}}});
  assert.equal((await result(await f.handler(f.request(),'opaque-token'))).isError,undefined);
  assert.equal(f.providerCalls[0][3].deadlineMs,now+1000);
});

test('provider outcomes are recorded in the budget even if the consent outcome write fails',async()=>{
  for(const operation of ['memory_ingest','memory_search']){
    const f=fixture({ledger:{async finalize(){throw new Error('injected consent outage');}},
      provider:operation==='memory_ingest'?{async ingest(){throw new Error('write timeout');}}:{async recall(){throw new Error('read failure');}}});
    const body=await result(await f.handler(f.request({},operation),'opaque-token'));
    assert.equal(body.isError,true);
    assert.equal(f.budgetOutcomes[0].state,operation==='memory_ingest'?'unknown':'read_failed');
  }
});

test('an acknowledged provider operation with an unavailable budget journal does not disclose output',async()=>{
  const f=fixture({budget:{async finalize(){throw new Error('secret infrastructure diagnostic');}}});
  const body=await result(await f.handler(f.request({},'memory_search'),'opaque-token'));
  assert.equal(body.isError,true);assert.doesNotMatch(JSON.stringify(body),/Synthetic answer|secret infrastructure/);
  assert.ok(f.events.includes('finalize:accepted'));
});

test('medical runtime configuration requires a valid deployment budget before admitting requests',()=>{
  for(const ports of [{budget:undefined},{budgetId:'../invalid'},{budgetPolicy:undefined},{budgetPolicy:{...budgetPolicy,maxMonthlyReservedMicroUsd:50000001}}])
    assert.throws(()=>fixture({ports}),{status:503,code:'routing_configuration_invalid'});
});

test('request cancellation during reservation records no egress and never retries admission',async()=>{
  const controller=new AbortController();let attempts=0;
  const f=fixture({budget:{async reserve(input){attempts++;controller.abort();return {reservationId:input.reservationId,
    month:new Date(now).toISOString().slice(0,7),reservedMicroUsd:11,expiresAtMs:now+60000,replayed:false};}}});
  const body=await result(await f.handler(f.request({},'memory_ingest',{signal:controller.signal}),'opaque-token'));
  assert.equal(body.isError,true);assert.match(body.content[0].text,/routing_request_aborted/);
  assert.equal(attempts,1);assert.equal(f.providerCalls.length,0);assert.equal(f.budgetOutcomes[0].state,'not_dispatched');
});

test('a reservation expiring during final authority checks cannot reach the provider',async()=>{
  let clock=now,authorizations=0;
  const f=fixture({ports:{clock:()=>clock,async authority(_token,spaceId,operation){if(++authorizations===2)clock=now+60000;
    return {organizationId:'org-a',accountId:'account-a',credentialId:'credential-a',spaceId,operation,authorityExpiresAtMs:now+120000};}}});
  const body=await result(await f.handler(f.request(),'opaque-token'));
  assert.equal(body.isError,true);assert.equal(f.providerCalls.length,0);assert.equal(f.budgetOutcomes[0].state,'not_dispatched');
});

test('a provider response arriving after the reservation deadline is never disclosed',async()=>{
  let clock=now;
  const f=fixture({ports:{clock:()=>clock},budget:{async reserve(input){return {reservationId:input.reservationId,
    month:new Date(now).toISOString().slice(0,7),reservedMicroUsd:21,expiresAtMs:now+1000,replayed:false};}},
    provider:{async recall(){clock=now+1001;return {answer:'late-secret-answer',count:0,candidates:[]};}}});
  const body=await result(await f.handler(f.request({},'memory_search'),'opaque-token'));
  assert.equal(body.isError,true);assert.doesNotMatch(JSON.stringify(body),/late-secret-answer/);
  assert.equal(f.budgetOutcomes[0].state,'accepted');
});

test('fresh disclosure authority expiring during the final ledger response cannot expose medical output',async()=>{
  let clock=now,authorizations=0;
  const f=fixture({ports:{clock:()=>clock,async authority(_token,spaceId,operation){
    return {organizationId:'org-a',accountId:'account-a',credentialId:'credential-a',spaceId,operation,
      authorityExpiresAtMs:++authorizations===3?now+100:now+60000};
  }},ledger:{async checkTicket(input){
    // The DO validated the new short authority before its RPC response arrived.
    if(input.phase==='disclose')clock=now+101;
    return {};
  }},provider:{async recall(){return {answer:'expired-medical-disclosure-marker',count:0,candidates:[]};}}});
  const body=await result(await f.handler(f.request({},'memory_search'),'opaque-token'));
  assert.equal(body.isError,true);
  assert.doesNotMatch(JSON.stringify(body),/expired-medical-disclosure-marker/);
  assert.equal(JSON.parse(body.content[0].text).error,'routing_authority_expired');
  assert.equal(f.budgetOutcomes[0].state,'accepted');
  assert.ok(f.events.includes('finalize:accepted'));
});

test('malformed or mismatched budget receipts fail closed before provider dispatch',async()=>{
  for(const change of [{reservationId:'wrong-ticket'},{reservedMicroUsd:0},{reservedMicroUsd:1000001},{expiresAtMs:now+60001},{unexpected:'raw-data'}]){
    const f=fixture({budget:{async reserve(input){return {reservationId:input.reservationId,month:new Date(now).toISOString().slice(0,7),
      reservedMicroUsd:11,expiresAtMs:now+60000,replayed:false,...change};}}});
    const body=await result(await f.handler(f.request(),'opaque-token'));
    assert.equal(body.isError,true);assert.equal(f.providerCalls.length,0);
    assert.equal(f.budgetOutcomes[0].state,'not_dispatched');
  }
});

test('missing deployed budget binding keeps the medical provider route unavailable',async()=>{
  const f=fixture();
  await assert.rejects(routedMcp(f.request(),'opaque-token',{MEMORY_ROUTING_ENABLED:'true',MEMORY_CONSENT_LEDGER:{},
    MEMORY_AGENT_MEMORY_TOKEN:'synthetic-only',MEMORY_AGENT_MEMORY_ACCOUNT_ID:'a'.repeat(32),MEMORY_AGENT_MEMORY_NAMESPACE:'synthetic'}),
    {status:503,code:'routing_runtime_unavailable'});
  assert.equal(f.providerCalls.length,0);
});

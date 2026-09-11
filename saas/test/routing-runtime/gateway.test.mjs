import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutedMcpHandler } from '../../src/routing/server-mcp.ts';

const now = Date.now(), origin = 'https://memory.example.test';
const reference = {consentId:'consent-a',version:1};
function fixture(overrides = {}) {
  const events = [], providerCalls = [];
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
  const handler = createRoutedMcpHandler({
    clock:()=>now, allowedMedicalSpaceIds:['space-a'], seoulSpaceIds:[],
    async authority(_token,spaceId,operation) {events.push('authority');return {...auth,spaceId,operation};},
    ledger:()=>ledger, provider, ...overrides.ports,
  });
  const request = (args={}, name='memory_ingest', options={}) => new Request(origin+'/mcp', {
    method:'POST',headers:{'content-type':'application/json','x-memory-consent-receipt':'opaque-receipt'},
    body:JSON.stringify({jsonrpc:'2.0',id:'request-a',method:'tools/call',params:{name,arguments:{
      spaceId:'space-a',routing:{version:1,classification:'medical',destination:'agent-memory',medicalCloudflareConsent:reference},
      ...(name==='memory_ingest'?{operationId:'operation-a',messages:[{role:'user',content:'Synthetic content.'}]}:{query:'Synthetic question?'}),...args}}}),...options,
  });
  return {handler,request,events,providerCalls,ticket};
}
const result = async response => (await response.json()).result;

test('medical ingress rechecks authority and consent at dispatch and disclosure, with durable admission first', async () => {
  const f=fixture(); const response=await f.handler(f.request(),'opaque-token');
  assert.equal(response.status,200);
  assert.equal((await result(response)).isError,undefined);
  assert.deepEqual(f.events,['authority','consume','authority','dispatch','ingest','finalize:accepted','authority','disclose']);
  assert.equal(f.providerCalls.length,1);
  assert.match(f.providerCalls[0][0],/^medical-[a-f0-9]{64}$/);
  assert.deepEqual(f.providerCalls[0][1],[{role:'user',content:'Synthetic content.'}]);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createRoutingClient } from '../../src/routing/client.ts';
import { resolveSeoulPlacement } from '../../src/routing/policy.ts';
import { assertSeoulRoutingCapability } from '../../src/routing/capabilities.ts';

const origin='https://seoul.example.test';
const routing={version:1,classification:'medical'};
const placement={version:2,route:'seoul',storage:'postgres',requiredRegion:'kr-seoul'};
const target={route:'seoul',storage:'postgres',region:'kr-seoul',ready:true,
  capabilities:{ingest:true,search:{keyword:true,semantic:false}}};
const manifest=()=>({version:2,protocol:'memory-routing-v2',target:structuredClone(target)});
const payload=()=>({spaceId:'seoul-space',mode:'keyword',matches:[{memoryId:'memory-1',revision:2,excerpt:'서울 keyword 원문'}],count:1});
const search={routing,query:'서울 keyword'};
const ingest={routing,operationId:'operation-1',messages:[{role:'user',content:'서울 keyword 원문'}]};

// The Hono service is a protocol fixture with a synthetic credential, not a
// PostgreSQL/SSO implementation or evidence that a provider route is serving.
function fixture(options={}) {
  const calls=[],credentials=[],accepted=[];
  const app=new Hono();
  app.get('/.well-known/memory-routing-v2',async c=>{
    await options.discovery?.();
    return c.json(options.manifest??manifest());
  });
  app.post('/mcp',async c=>{
    assert.equal(c.req.header('x-memory-routing'),'2');
    assert.equal(c.req.header('authorization'),'Bearer synthetic-seoul-token');
    const rpc=await c.req.json();accepted.push(rpc.params.arguments);
    if(options.rejectAtUse)return c.json({jsonrpc:'2.0',id:rpc.id,result:{isError:true,content:[{type:'text',text:'private denial'}]}});
    const value=rpc.params.name==='memory_search'?(options.payload??payload()):{accepted:true};
    const result=options.result??{content:[{type:'text',text:JSON.stringify(value)}]};
    return c.json({jsonrpc:'2.0',id:rpc.id,result});
  });
  const config={targets:{seoul:{origin,spaceId:'seoul-space',protocol:'memory-routing-v2'}},
    credential:async value=>{credentials.push(value);await options.credential?.();return {kind:'pat',token:'synthetic-seoul-token'};},
    fetch:async(url,init)=>{calls.push({url:String(url),init});return app.request(url,init);},
    ...(options.config??{})};
  return {client:createRoutingClient(config),calls,credentials,accepted};
}

test('opt-in Seoul v2 admits keyword and raw ingest without a vector claim through Hono',async()=>{
  const f=fixture();assert.deepEqual(f.client.plan(routing),placement);
  const result=await f.client.call('memory_search',search);
  assert.deepEqual(result.routing,placement);assert.deepEqual(JSON.parse(result.result.content[0].text),payload());
  assert.deepEqual(result.result.structuredContent,payload());
  assert.deepEqual(f.accepted[0],{...search,mode:'keyword',routing:{...routing,destination:'seoul',requiredRegion:'kr-seoul'},spaceId:'seoul-space'});
  assert.equal(f.calls[0].url,origin+'/.well-known/memory-routing-v2');
  assert.equal(f.calls[0].init.body,undefined);assert.equal(new Headers(f.calls[0].init.headers).has('authorization'),false);
  assert.deepEqual(f.credentials,[{route:'seoul',origin}]);
  await f.client.call('memory_ingest',ingest);
  assert.deepEqual(f.accepted[1].messages,ingest.messages);assert.equal(Object.hasOwn(f.accepted[1],'mode'),false);
});

test('semantic requests fail locally with no discovery, credential or content even if advertised',async()=>{
  const value=manifest();value.target.capabilities.search.semantic=true;
  const f=fixture({manifest:value});
  await assert.rejects(f.client.call('memory_search',{...search,mode:'semantic'}),{code:'routing_search_mode_unavailable'});
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.credentials,[]);assert.deepEqual(f.accepted,[]);
});

for(const [label,change] of [
  ['unready',m=>{m.target.ready=false;}],
  ['wrong region',m=>{m.target.region='cloudflare';}],
  ['wrong storage',m=>{m.target.storage='cloudflare-agent-memory';}],
  ['wrong route',m=>{m.target.route='agent-memory';}],
  ['wrong protocol',m=>{m.protocol='memory-routing-v1';}],
  ['wrong version',m=>{m.version=1;}],
  ['legacy vector extra',m=>{m.target.vector='pgvector';}],
  ['extra capability',m=>{m.target.capabilities.embed=true;}],
  ['missing capability',m=>{delete m.target.capabilities.search;}],
  ['semantic readiness claim',m=>{m.target.capabilities.search.semantic=true;}],
  ['disabled keyword',m=>{m.target.capabilities.search.keyword=false;}],
])test('v2 '+label+' cannot upload query or fall back',async()=>{
  const m=manifest();change(m);const f=fixture({manifest:m});
  await assert.rejects(f.client.call('memory_search',search),{code:label==='disabled keyword'?'routing_search_mode_unavailable':'routing_target_unavailable'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,origin+'/.well-known/memory-routing-v2');
  assert.deepEqual(f.credentials,[]);assert.deepEqual(f.accepted,[]);
});

test('ingest and keyword admission are independent and foundation-only is closed',async()=>{
  const m=manifest();m.target.capabilities.ingest=false;
  const f=fixture({manifest:m});await f.client.call('memory_search',search);
  const before=f.credentials.length;
  await assert.rejects(f.client.call('memory_ingest',ingest),{code:'routing_target_unavailable'});
  assert.equal(f.credentials.length,before);assert.equal(f.accepted.length,1);
  const empty=manifest();empty.target.ready=false;empty.target.capabilities={ingest:false,search:{keyword:false,semantic:false}};
  const foundation=fixture({manifest:empty});
  await assert.rejects(foundation.client.call('memory_ingest',ingest),{code:'routing_target_unavailable'});
  assert.equal(foundation.credentials.length,0);
});

for(const [label,change] of [
  ['wrong Space',p=>{p.spaceId='different-space';}],['missing Space',p=>{delete p.spaceId;}],
  ['missing mode',p=>{delete p.mode;}],['semantic mode',p=>{p.mode='semantic';}],
  ['missing id',p=>{delete p.matches[0].memoryId;}],['invalid revision',p=>{p.matches[0].revision=0;}],
  ['unsafe revision',p=>{p.matches[0].revision=Number.MAX_SAFE_INTEGER+1;}],
  ['unbounded excerpt',p=>{p.matches[0].excerpt='가'.repeat(10923);}],
  ['malformed Unicode',p=>{p.matches[0].excerpt='\ud800';}],
  ['wrong count',p=>{p.count=2;}],['synthesized answer',p=>{p.answer='invented';}],
  ['duplicate source',p=>{p.matches.push({...p.matches[0]});p.count=2;}],
])test('v2 response rejects '+label+' before disclosure',async()=>{
  const value=payload();change(value);const f=fixture({payload:value});
  await assert.rejects(f.client.call('memory_search',search),{code:'routing_response_invalid'});
});

test('v2 validates requested limit and rejects multiple or unstructured result blocks',async()=>{
  const p=payload();p.matches.push({memoryId:'memory-2',revision:1,excerpt:'second'});p.count=2;
  await assert.rejects(fixture({payload:p}).client.call('memory_search',{...search,limit:1}),{code:'routing_response_invalid'});
  for(const result of [{content:[{type:'text',text:'unstructured'}]},
    {content:[{type:'text',text:JSON.stringify(payload())},{type:'text',text:'extra'}]}]) {
    await assert.rejects(fixture({result}).client.call('memory_search',search),{code:'routing_response_invalid'});
  }
});

test('v2 snapshots mode, query and target before discovery and credential awaits',async()=>{
  const args=structuredClone(search);let f;
  f=fixture({discovery(){args.mode='semantic';args.query='swapped';},credential(){args.routing.destination='agent-memory';}});
  await f.client.call('memory_search',args);
  assert.equal(f.accepted[0].mode,'keyword');assert.equal(f.accepted[0].query,'서울 keyword');
  assert.equal(f.accepted[0].routing.destination,'seoul');assert.ok(f.calls.every(c=>new URL(c.url).origin===origin));
});

test('v2 preserves use-time server rejection without raw diagnostic disclosure',async()=>{
  await assert.rejects(fixture({rejectAtUse:true}).client.call('memory_search',search),{code:'routing_upstream_rejected'});
});

test('explicit modes on v1 are not stripped or forwarded to legacy providers',async()=>{
  for(const route of ['seoul','agent-memory'])for(const mode of ['keyword','semantic']) {
    let called=0;const client=createRoutingClient({targets:{[route]:{origin,spaceId:'space'}},
      credential:async()=>{called++;throw new Error();},fetch:async()=>{called++;throw new Error();}});
    await assert.rejects(client.call('memory_search',{routing:{version:1,classification:route==='seoul'?'medical':'general'},query:'private',mode}),{code:'routing_search_mode_unavailable'});
    assert.equal(called,0);
  }
});

test('endpoint protocol configuration is closed and Cloudflare cannot opt into Seoul v2',()=>{
  for(const targets of [{seoul:{origin,spaceId:'space',protocol:'automatic'}},
    {'agent-memory':{origin,spaceId:'space',protocol:'memory-routing-v2'}}]) {
    assert.throws(()=>createRoutingClient({targets,credential:async()=>{throw new Error();}}),{code:'routing_configuration_invalid'});
  }
});

test('v2 never dispatches after a timed-out or aborted discovery',async()=>{
  for(const reason of ['timeout','abort']) {
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const controller=new AbortController();
    const f=fixture({discovery:()=>gate,config:{timeoutMs:reason==='timeout'?10:1000}});
    const pending=f.client.call('memory_search',search,{signal:controller.signal});
    if(reason==='abort')controller.abort();
    await assert.rejects(pending,{code:reason==='timeout'?'routing_request_timeout':'routing_request_aborted'});
    release();await new Promise(resolve=>setTimeout(resolve,5));
    assert.deepEqual(f.credentials,[]);assert.deepEqual(f.accepted,[]);
  }
});

test('v2 refuses a capability that changes after discovery without disclosing its diagnostic',async()=>{
  const f=fixture({rejectAtUse:true});
  await assert.rejects(f.client.call('memory_ingest',ingest),{code:'routing_write_outcome_unknown'});
  assert.equal(f.accepted.length,1);assert.equal(f.calls.length,2);
});

test('v2 placement cannot erase inherited Seoul restrictions or use a forged regional plan',()=>{
  assert.deepEqual(resolveSeoulPlacement({version:1,classification:'general'},[{route:'seoul'}]),placement);
  assert.throws(()=>resolveSeoulPlacement({version:1,classification:'general'}),{code:'routing_target_unavailable'});
  assert.throws(()=>resolveSeoulPlacement({version:1,classification:'general',destination:'agent-memory'},[{route:'seoul'}]),{code:'routing_downgrade_denied'});
  for(const plan of [{...placement,requiredRegion:null},{...placement,storage:'cloudflare-agent-memory'},
    {...placement,vector:'pgvector'},{...placement,version:1}]) {
    assert.throws(()=>assertSeoulRoutingCapability(plan,manifest(),'memory_ingest'),{code:'routing_plan_invalid'});
  }
  const value=resolveSeoulPlacement({version:1,classification:'uncertain'});assert.equal(Object.isFrozen(value),true);
});

test('v2 structured output is rebuilt from validated text instead of copying an upstream claim',async()=>{
  const f=fixture({result:{content:[{type:'text',text:JSON.stringify(payload())}],
    structuredContent:{spaceId:'foreign',mode:'semantic',answer:'unvalidated'}}});
  const response=await f.client.call('memory_search',{...search,mode:'keyword'});
  assert.deepEqual(response.result.structuredContent,payload());
  assert.doesNotMatch(JSON.stringify(response),/foreign|unvalidated/);
});

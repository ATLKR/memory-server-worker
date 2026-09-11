import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DB } from '../../release-validation/tests/db.mjs';
import { digest } from '../../src/release/util.ts';

const origin='https://memory.example.test',account='a'.repeat(32);
const ownerSession='synthetic-owner-'+'s'.repeat(40),pat='synthetic-personal-'+'p'.repeat(40),readerSession='synthetic-reader-'+'r'.repeat(40);
const policy={version:1,revision:'native-general-v1',validUntilMs:Date.now()+600000,maxMonthlyRequests:6,
  maxMonthlyInputBytes:1000000,maxMonthlyReservedMicroUsd:1000000,ingestBaseMicroUsd:10,ingestMicroUsdPerKiB:1,
  searchBaseMicroUsd:20,searchMicroUsdPerKiB:1,pricingBasis:'operator-upper-bound'};
const {outputFiles}=await build({stdin:{contents:`
import {createApplication} from './src/app.ts';
import {createRelease} from './src/release/extension.ts';
import {readSettings} from './src/config.ts';
export {AgentMemorySpaceLedger} from './src/routing/general-ledger-object.ts';
export {AgentMemoryBudgetLedger} from './src/routing/budget-ledger-object.ts';
export default {async fetch(request,env){
  const runtime={...env,PUBLIC_ORIGIN:'${origin}',SSO_CLIENT_ID:'synthetic-client',REQUEST_LIMITER:{limit:async()=>({success:true})},
    MEMORY_GENERAL_ROUTING_ENABLED:'true',MEMORY_ROUTING_GENERAL_SPACES_JSON:'["space","other-space"]',
    MEMORY_ROUTING_SEOUL_SPACES_JSON:'[]',MEMORY_AGENT_MEMORY_ACCOUNT_ID:'${account}',
    MEMORY_AGENT_MEMORY_NAMESPACE:'synthetic-general',MEMORY_AGENT_MEMORY_TOKEN:'synthetic-provider-token',
    MEMORY_ROUTING_BUDGET_ID:'native-general',MEMORY_ROUTING_BUDGET_POLICY_JSON:${JSON.stringify(JSON.stringify(policy))}};
  const path=new URL(request.url).pathname;
  if(path==='/fixture-budget')return Response.json(await env.MEMORY_AGENT_MEMORY_BUDGET.getByName('budget:native-general').usage({budgetId:'native-general'}));
  if(path==='/fixture-disabled-discovery'){
    runtime.MEMORY_GENERAL_ROUTING_ENABLED='false';
    request=new Request('${origin}/.well-known/memory-routing');
  }
  return createApplication(env.DB,readSettings(runtime),{release:createRelease(runtime)})(request);
}};`,resolveDir:fileURLToPath(new URL('../../',import.meta.url)),sourcefile:'general-native-stack.mjs'},
  bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});

test('native general REST and MCP retain Space authority, admission budget and generation erasure boundaries', {timeout:45000},async t=>{
  const providerCalls=[];let db;
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],
    script:outputFiles[0].text,d1Databases:['DB'],durableObjects:{
      MEMORY_AGENT_MEMORY_SPACES:{className:'AgentMemorySpaceLedger',useSQLite:true},
      MEMORY_AGENT_MEMORY_BUDGET:{className:'AgentMemoryBudgetLedger',useSQLite:true}},
    outboundService:async request=>{
      const url=new URL(request.url);
      assert.equal(url.origin,'https://api.cloudflare.com');
      assert.ok(url.pathname.startsWith(`/client/v4/accounts/${account}/agent-memory/namespaces/synthetic-general/profiles/`));
      const matched=/\/profiles\/(general-[a-f0-9]{64})(\/(?:ingest|recall))?$/.exec(url.pathname);
      assert.ok(matched,'Provider target must be one server-derived general profile');
      const body=request.method==='POST'?await request.json():null;
      providerCalls.push({method:request.method,profile:matched[1],operation:matched[2]??'delete',body});
      if(body?.query==='provider-failure')return Response.json({success:false,result:null,errors:[{code:10000}],messages:[]},{status:503});
      let result=null;
      if(matched[2]==='/recall'){
        if(body.query==='revoke-shared-reader')await db.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:bob'").bind(Date.now()).run();
        result={answer:body.query==='revoke-shared-reader'?'must-not-leak-after-revocation':'Synthetic general answer',count:0,candidates:[]};
      }
      return Response.json({success:true,result,errors:[],messages:[]});
    }}));
  t.after(()=>mf.dispose());
  db=await mf.getD1Database('DB');
  const schema=new DB(()=>Date.now());schema.migrate();
  try{
    const statements=schema.raw.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      AND tbl_name NOT IN(SELECT name FROM pragma_table_list WHERE type='shadow') ORDER BY rowid`).all();
    for(let offset=0;offset<statements.length;offset+=50)await db.batch(statements.slice(offset,offset+50).map(({sql})=>db.prepare(sql)));
  }finally{schema.close();}
  const now=Date.now();
  await db.batch([
    db.prepare("INSERT INTO accounts(id) VALUES('alice'),('bob')"),
    db.prepare("INSERT INTO account_emails VALUES('alice-email','alice','alice@example.test','example.test',?,NULL),('bob-email','bob','bob@example.test','example.test',?,NULL)").bind(now,now),
    db.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission) VALUES('session:alice','alice','session',?,?,?,'write')").bind(await digest(ownerSession),now+600000,now),
    db.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission) VALUES('session:bob','bob','session',?,?,?,'write')").bind(await digest(readerSession),now+600000,now),
    db.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,permission) VALUES('pat:alice','alice','personal_key',?,?,'write')").bind(await digest(pat),now+600000),
    db.prepare("INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES('pat:alice','[\"read\",\"create\",\"delete\"]','[\"space\"]')"),
    db.prepare("INSERT INTO spaces VALUES('space','General personal','alice',NULL,'managed',?,'session:alice'),('other-space','Other personal','alice',NULL,'managed',?,'session:alice')").bind(now,now),
    db.prepare("INSERT INTO release_shares(id,space_id,recipient_email_id,creator_credential_id,expires_at,created_at) VALUES('share-reader','space','bob-email','session:alice',?,?)").bind(now+600000,now),
    db.prepare("UPDATE release_shares SET accepted_at=? WHERE id='share-reader'").bind(now),
  ]);
  const call=(path,method='GET',input,token=pat,headers={})=>mf.dispatchFetch(origin+path,{method,
    headers:{authorization:'Bearer '+token,...(input===undefined?{}:{'content-type':'application/json'}),...headers},
    ...(input===undefined?{}:{body:JSON.stringify(input)})});
  const parse=async response=>{const raw=await response.text();let body;try{
    if(response.headers.get('content-type')?.startsWith('text/event-stream')) {
      const events=[...raw.matchAll(/^data: (.+)$/gm)];assert.equal(events.length,1);body=JSON.parse(events[0][1]);
    }else body=JSON.parse(raw);
  }catch{assert.fail('Expected JSON or single MCP event response: '+raw);}return {response,body,raw};};
  const rest=(operation,input,token=pat,space='space')=>call(`/v1/spaces/${space}/agent-memory/${operation}`,operation==='usage'?'GET':'POST',input,token).then(parse);
  const routing={version:1,classification:'general',destination:'agent-memory'};
  const ingest={routing,operationId:'general-ingest-1',messages:[{role:'user',content:'Synthetic ordinary memory.'}]};
  const mcp=async(name,input,token=pat)=>{
    const outer=await parse(await call('/mcp','POST',{jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:{spaceId:'space',...input}}},token,{'x-memory-routing':'1',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'}));
    const tool=outer.body.result;
    return {...outer,tool,value:tool?.content?.[0]?.text?JSON.parse(tool.content[0].text):undefined};
  };
  const discovery=await parse(await call('/.well-known/memory-routing'));
  assert.equal(discovery.response.status,200,discovery.raw);assert.equal(discovery.body.target.ready,true);
  assert.equal(discovery.body.target.route,'agent-memory');
  const disabled=await parse(await call('/fixture-disabled-discovery'));
  assert.equal(disabled.body.target.ready,false,disabled.raw);

  const protocolHeaders={'x-memory-routing':'1',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
  const initialized=await parse(await call('/mcp','POST',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'native',version:'1'}}},pat,protocolHeaders));
  assert.equal(initialized.body.result.protocolVersion,'2025-11-25');
  assert.equal((await call('/mcp','POST',{jsonrpc:'2.0',method:'notifications/initialized'},pat,protocolHeaders)).status,202);
  const list=await parse(await call('/mcp','POST',{jsonrpc:'2.0',id:2,method:'tools/list'},pat,protocolHeaders));
  assert.equal(list.body.result.tools[0].name,'memory_route_check');
  const allowed=await mcp('memory_route_check',{operation:'memory_ingest'});
  assert.equal(allowed.value.allowed,true);assert.equal(allowed.value.spaceId,'space');assert.equal(providerCalls.length,0);
  const denied=await mcp('memory_route_check',{spaceId:'other-space',operation:'memory_ingest'});
  assert.equal(denied.tool.isError,true);assert.equal(providerCalls.length,0);

  const wrong=await rest('ingest',ingest,pat,'other-space');
  assert.equal(wrong.response.ok,false,wrong.raw);assert.equal(providerCalls.length,0);
  const written=await rest('ingest',ingest);
  assert.equal(written.response.ok,true,written.raw);assert.equal(written.body.state,'accepted');
  assert.equal(providerCalls.length,1);const firstProfile=providerCalls[0].profile;
  const replay=await mcp('memory_ingest',ingest);
  assert.equal(replay.tool.isError,undefined,replay.raw);assert.equal(replay.value.replayed,true);
  assert.equal(providerCalls.length,1);assert.equal((await parse(await call('/fixture-budget'))).body.requests,1);

  const found=await mcp('memory_search',{routing,query:'owner-query'});
  assert.equal(found.tool.isError,undefined,found.raw);assert.equal(found.value.answer,'Synthetic general answer');
  assert.equal(providerCalls[1].profile,firstProfile);
  const shared=await rest('search',{routing,query:'shared-query'},readerSession);
  assert.equal(shared.response.ok,true,shared.raw);assert.equal(shared.body.answer,'Synthetic general answer');
  assert.equal(providerCalls[2].profile,firstProfile);
  const sharedWrite=await rest('ingest',{...ingest,operationId:'shared-denied'},readerSession);
  assert.equal(sharedWrite.response.ok,false,sharedWrite.raw);assert.equal(providerCalls.length,3);

  const failed=await rest('search',{routing,query:'provider-failure'});
  assert.equal(failed.response.ok,false,failed.raw);assert.equal(failed.body.state,'read_failed');
  const revoked=await mcp('memory_search',{routing,query:'revoke-shared-reader'},readerSession);
  assert.equal(revoked.tool.isError,true,revoked.raw);assert.doesNotMatch(revoked.raw,/must-not-leak-after-revocation/);
  assert.equal(providerCalls.length,5);

  const clearInput={routing,operationId:'general-clear-1',scope:'all-general-memory-in-space'};
  const cleared=await rest('clear',clearInput);
  assert.equal(cleared.response.ok,true,cleared.raw);assert.equal(cleared.body.logicallyHidden,true);
  assert.equal(cleared.body.providerAcknowledged,true);assert.equal(cleared.body.physicalPurgeVerified,false);assert.equal(cleared.body.generation,2);
  assert.equal(providerCalls[5].method,'DELETE');assert.equal(providerCalls[5].profile,firstProfile);
  const next=await rest('ingest',{...ingest,operationId:'general-ingest-2'});
  assert.equal(next.response.ok,true,next.raw);assert.notEqual(providerCalls[6].profile,firstProfile);
  const secondProfile=providerCalls[6].profile;
  const clearReplay=await rest('clear',clearInput);
  assert.equal(clearReplay.response.ok,true,clearReplay.raw);assert.equal(clearReplay.body.replayed,true);assert.equal(providerCalls.length,7);

  const capped=await rest('ingest',{...ingest,operationId:'general-ingest-capped'});
  assert.equal(capped.response.ok,false,capped.raw);assert.equal(capped.body.error,'routing_budget_exhausted');
  assert.equal(capped.body.providerDispatched,false);assert.equal(providerCalls.length,7);
  const budget=await parse(await call('/fixture-budget'));
  assert.equal(budget.body.requests,6);assert.equal(budget.body.accepted,5);assert.equal(budget.body.readFailed,1);
  assert.equal(budget.body.reservedMicroUsd,106);assert.equal(budget.body.billingVerified,false);
  const clearedAtCap=await rest('clear',{...clearInput,operationId:'general-clear-2'});
  assert.equal(clearedAtCap.response.ok,true,clearedAtCap.raw);assert.equal(clearedAtCap.body.generation,3);
  assert.equal(providerCalls[7].method,'DELETE');assert.equal(providerCalls[7].profile,secondProfile);
  const usage=await rest('usage');
  assert.equal(usage.response.ok,true,usage.raw);assert.equal(usage.body.usage.generation,3);assert.equal(usage.body.usage.clearRequests,2);
  assert.equal(usage.body.billingVerified,false);
  assert.equal((await parse(await call('/fixture-budget'))).body.requests,6);
});

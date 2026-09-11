import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DB } from '../../release-validation/tests/db.mjs';
import { digest } from '../../src/release/util.ts';

const origin='https://memory.example.test',account='a'.repeat(32),token='synthetic-session-'+'s'.repeat(40);
const budgetPolicy={version:1,revision:'native-v1',validUntilMs:Date.now()+600000,maxMonthlyRequests:2,
  maxMonthlyInputBytes:1000000,maxMonthlyReservedMicroUsd:1000000,ingestBaseMicroUsd:10,ingestMicroUsdPerKiB:1,
  searchBaseMicroUsd:20,searchMicroUsdPerKiB:1,pricingBasis:'operator-upper-bound'};
const {outputFiles}=await build({stdin:{contents:`
import {createApplication} from './src/app.ts';
import {createRelease} from './src/release/extension.ts';
import {readSettings} from './src/config.ts';
import {OrganizationConsentLedger} from './src/routing/ledger-object.ts';
import {AgentMemoryBudgetLedger} from './src/routing/budget-ledger-object.ts';
export {AgentMemoryBudgetLedger};
export class TestLedger extends OrganizationConsentLedger {
  inspect(){return this.ctx.storage.sql.exec('SELECT state,operation,operation_id FROM ledger_operations').toArray();}
}
export default {async fetch(request,env){
  if(new URL(request.url).pathname==='/fixture-ledger')return Response.json(await env.MEMORY_CONSENT_LEDGER.getByName('organization:org').inspect());
  if(new URL(request.url).pathname==='/fixture-budget')return Response.json(await env.MEMORY_AGENT_MEMORY_BUDGET.getByName('budget:native-budget').usage({budgetId:'native-budget'}));
  const runtime={...env,PUBLIC_ORIGIN:'${origin}',SSO_CLIENT_ID:'synthetic-client',REQUEST_LIMITER:{limit:async()=>({success:true})},
    MEMORY_ROUTING_ENABLED:'true',MEMORY_ROUTING_MEDICAL_SPACES_JSON:'["space"]',MEMORY_AGENT_MEMORY_ACCOUNT_ID:'${account}',
    MEMORY_AGENT_MEMORY_NAMESPACE:'synthetic-stack',MEMORY_AGENT_MEMORY_TOKEN:'synthetic-provider-token',
    MEMORY_ROUTING_BUDGET_ID:'native-budget',MEMORY_ROUTING_BUDGET_POLICY_JSON:${JSON.stringify(JSON.stringify(budgetPolicy))}};
  return createApplication(env.DB,readSettings(runtime),{release:createRelease(runtime)})(request);
}};`,resolveDir:fileURLToPath(new URL('../../',import.meta.url)),sourcefile:'routing-stack.mjs'},
  bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});

test('native authenticated API, SQLite DO receipt, routed MCP and HTTP provider compose end to end', {timeout:30000},async t=>{
  const calls=[];let failIngest=false;
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],
    script:outputFiles[0].text,d1Databases:['DB'],durableObjects:{MEMORY_CONSENT_LEDGER:{className:'TestLedger',useSQLite:true},
      MEMORY_AGENT_MEMORY_BUDGET:{className:'AgentMemoryBudgetLedger',useSQLite:true}},
    outboundService:async request=>{
      assert.ok(request.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${account}/agent-memory/namespaces/synthetic-stack/profiles/medical-`));
      calls.push({path:new URL(request.url).pathname,body:await request.json()});
      if(failIngest)return Response.json({success:false,errors:[{code:10000}],messages:[],result:null},{status:503});
      return Response.json({success:true,errors:[],messages:[],result:null});
    }}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB'),schema=new DB(()=>Date.now());schema.migrate();
  try{
    // Native D1 applies the actual final schema, not a simplified mock schema.
    const statements=schema.raw.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      AND tbl_name NOT IN(SELECT name FROM pragma_table_list WHERE type='shadow') ORDER BY rowid`).all();
    for(let offset=0;offset<statements.length;offset+=50)await db.batch(statements.slice(offset,offset+50).map(({sql})=>db.prepare(sql)));
  }finally{schema.close();}
  const now=Date.now();
  await db.batch([
    db.prepare("INSERT INTO accounts(id) VALUES('actor')"),db.prepare("INSERT INTO organizations(id) VALUES('org')"),
    db.prepare("INSERT INTO account_emails VALUES('email','actor','synthetic@example.test','example.test',?,NULL)").bind(now),
    db.prepare("INSERT INTO memberships VALUES('membership','org','actor','email','owner',?,NULL)").bind(now+600_000),
    db.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission) VALUES('session:actor','actor','session',?,?,?,'write')").bind(await digest(token),now+600_000,now),
    db.prepare("INSERT INTO spaces VALUES('space','Synthetic',NULL,'org','managed',?,'session:actor')").bind(now),
  ]);
  const call=(path,method='GET',input,headers={})=>mf.dispatchFetch(origin+path,{method,
    headers:{authorization:'Bearer '+token,...(input?{'content-type':'application/json'}:{}),...headers},...(input?{body:JSON.stringify(input)}:{})});
  const admin='/v1/organizations/org/medical-cloudflare-consent';
  const granted=await call(admin,'PUT',{expectedVersion:0,grant:{spaceScope:{kind:'spaces',spaceIds:['space']},
    scopes:['ingest','storage','extraction','embedding','recall'],validFromMs:now,evidenceRef:'synthetic-fixture'}});
  assert.equal(granted.status,200,await granted.clone().text());
  const consent=await granted.json();
  const receipt=async requestId=>{
    const checked=await call('/v1/routing/consent/check','POST',{version:1,requestId,spaceId:'space',operation:'memory_ingest',consent:{mode:'organization'}});
    assert.equal(checked.status,200,await checked.clone().text());return checked.json();
  };
  const ingest=async(requestId,operationId)=>{
    const permit=await receipt(requestId);
    const response=await call('/mcp','POST',{jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:'memory_ingest',arguments:{
      routing:{version:1,classification:'medical',destination:'agent-memory',medicalCloudflareConsent:{consentId:permit.consentId,version:permit.consentVersion}},
      spaceId:'space',operationId,messages:[{role:'system',content:'Synthetic fixture only.'},{role:'user',content:'A fictional clock is purple.'}],
    }}},{'x-memory-consent-receipt':permit.receipt});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  const accepted=await ingest('request-1','operation-1');
  assert.equal(accepted.result.isError,undefined,JSON.stringify(accepted));
  assert.equal(JSON.parse(accepted.result.content[0].text).state,'accepted');
  assert.equal(calls.length,1);assert.equal(calls[0].body.messages.length,2);
  const replay=await ingest('request-2','operation-1');
  assert.equal(JSON.parse(replay.result.content[0].text).replayed,true);assert.equal(calls.length,1);
  failIngest=true;
  const unknown=await ingest('request-3','operation-2');
  assert.equal(unknown.result.isError,true);assert.equal(JSON.parse(unknown.result.content[0].text).state,'unknown');
  const again=await ingest('request-4','operation-2');
  assert.equal(JSON.parse(again.result.content[0].text).state,'unknown');assert.equal(calls.length,2);
  assert.deepEqual((await (await call('/fixture-ledger')).json()).map(row=>row.state),['accepted','unknown']);
  const usage=await (await call('/fixture-budget')).json();
  assert.equal(usage.requests,2);assert.equal(usage.accepted,1);assert.equal(usage.unknown,1);
  assert.equal(usage.reservedMicroUsd,22);assert.equal(usage.billingVerified,false);
  const exhausted=await ingest('request-budget','operation-budget');
  assert.equal(exhausted.result.isError,true);assert.match(exhausted.result.content[0].text,/routing_budget_exhausted/);
  assert.equal(calls.length,2);assert.equal((await (await call('/fixture-budget')).json()).requests,2);
  const stale=await receipt('request-stale');
  assert.equal((await call(admin,'DELETE',{expectedVersion:consent.version})).status,200);
  const denied=await call('/mcp','POST',{jsonrpc:'2.0',id:'request-stale',method:'tools/call',params:{name:'memory_ingest',arguments:{
    routing:{version:1,classification:'medical',medicalCloudflareConsent:{consentId:stale.consentId,version:stale.consentVersion}},spaceId:'space',operationId:'operation-stale',messages:[{role:'user',content:'Must not leave.'}]}}},{'x-memory-consent-receipt':stale.receipt});
  assert.equal((await denied.json()).result.isError,true);assert.equal(calls.length,2);
});

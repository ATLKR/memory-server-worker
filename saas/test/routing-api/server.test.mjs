import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { fixture, at } from '../../release-validation/tests/db.mjs';
import { createApplication } from '../../src/app.ts';
import { createRelease } from '../../src/release/extension.ts';
import { readSettings, PUBLIC_ORIGIN, AUTH_ISSUER } from '../../src/config.ts';
import { digest } from '../../src/release/util.ts';
import { resolveRoutingAuthority } from '../../src/routing/server-authority.ts';
import { createRoutingApi } from '../../src/routing/server-api.ts';
import { createRoutedMcpHandler } from '../../src/routing/server-mcp.ts';
import { WorkspaceService } from '../../src/workspace.ts';
import { Transfers } from '../../src/release/transfer.ts';
import { requireSpace } from '../../src/release/authority.ts';
import { DatabaseSync } from 'node:sqlite';
import { ConsentLedger } from '../../src/routing/ledger.ts';

const adminPath = '/v1/organizations/org/medical-cloudflare-consent';
const checkPath = '/v1/routing/consent/check';
const grant = { spaceScope: { kind: 'spaces', spaceIds: ['so'] }, scopes: ['ingest','storage','extraction','embedding','recall'], validFromMs: at, evidenceRef: 'approved-contract' };
const check = { version: 1, requestId: 'request-1', spaceId: 'so', operation: 'memory_ingest', consent: { mode: 'organization' } };

test('medical managed recall rejects explicit modes before consuming authority or consent',async()=>{
  for(const mode of ['keyword','semantic']) {
    let touched=0;
    const forbidden=()=>{touched++;throw new Error('unexpected port');};
    const handler=createRoutedMcpHandler({clock:()=>at,allowedMedicalSpaceIds:['so'],seoulSpaceIds:[],
      authority:forbidden,ledger:forbidden,provider:{ingest:forbidden,recall:forbidden},budgetId:'test-budget',
      budgetPolicy:{version:1,revision:'test-v1',validUntilMs:at+600000,maxMonthlyRequests:100,
        maxMonthlyInputBytes:1000000,maxMonthlyReservedMicroUsd:1000000,ingestBaseMicroUsd:10,ingestMicroUsdPerKiB:1,
        searchBaseMicroUsd:10,searchMicroUsdPerKiB:1,pricingBasis:'operator-upper-bound'},
      budget:{reserve:forbidden,finalize:forbidden,usage:forbidden}});
    const response=await handler(new Request('https://memory.test/mcp',{method:'POST',headers:{'content-type':'application/json','x-memory-consent-receipt':'synthetic-receipt'},
      body:JSON.stringify({jsonrpc:'2.0',id:'search-mode',method:'tools/call',params:{name:'memory_search',arguments:{
        spaceId:'so',query:'private query',mode,routing:{version:1,classification:'medical',medicalCloudflareConsent:{consentId:'consent',version:1}}}}})}),'synthetic-token');
    const result=await response.json();assert.equal(result.result.isError,true);
    assert.equal(JSON.parse(result.result.content[0].text).error,'routing_search_mode_unavailable');assert.equal(touched,0);
  }
});
async function setup(t, options = {}) {
  let now = at;
  const f = await fixture({ clock: () => now }); t.after(() => f.db.close());
  const calls = [];
  let record = { id: 'consent-org', version: 1, organizationId: 'org', provider: 'cloudflare-agent-memory', classification: 'medical', ...grant, status: 'granted', approvedBy: 'alice' };
  const stub = {
    async get(input) { calls.push(['get', input]); await options.beforeReturn?.('get', f); return record; },
    async grant(input) { calls.push(['grant', input]); record = { ...record, ...input.grant, version: input.expectedVersion+1, approvedBy: input.approvedBy }; await options.beforeReturn?.('grant', f); return record; },
    async revoke(input) { calls.push(['revoke', input]); record = { ...record, version: input.expectedVersion+1, status: 'revoked', revokedAtMs: now }; return record; },
    async issue(input) { calls.push(['issue', input]); await options.beforeReturn?.('issue', f); return { version: 1, allowed: true, requestId: input.requestId, spaceId: input.spaceId, consentId: record.id, consentVersion: record.version, operation: input.operation, expiresAtMs: Math.min(now+60000,input.authorityExpiresAtMs), receipt: 'opaque-scoped-receipt' }; },
  };
  const env = { DB: f.db, PUBLIC_ORIGIN, SSO_CLIENT_ID: 'test-client', REQUEST_LIMITER: { limit: async () => ({ success: true }) },
    ...(options.noLedger ? {} : { MEMORY_CONSENT_LEDGER: { getByName(name) { assert.equal(name, 'organization:org'); return stub; } } }) };
  const api = createRoutingApi(env, { clock: () => now });
  const app = createApplication(f.db, readSettings(env), { clock: () => now, auth: options.auth,
    release: createRelease(env, { clock: () => now }) });
  const request = (path, method = 'GET', data, token = f.token, headers = {}) => app(new Request(PUBLIC_ORIGIN+path, { method,
    headers: { authorization: 'Bearer '+token, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: typeof data === 'string' ? data : JSON.stringify(data) }) }));
  return { ...f, env, api, app, calls, request, clock: () => now, setNow(value) { now = value; } };
}
async function orgKey(f, { token = 'd'.repeat(64), capabilities = ['read','create'], spaces = ['so'] } = {}) {
  f.db.raw.prepare('INSERT INTO credentials(id,account_id,kind,membership_id,email_id,token_digest,expires_at,permission) VALUES(?,?,?,?,?,?,?,?)')
    .run('org-key','alice','api_key','m1','e1',await digest(token),at+800000,'write');
  f.db.raw.prepare('INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES(?,?,?)').run('org-key', JSON.stringify(capabilities), JSON.stringify(spaces));
  return token;
}

test('current exact org authority returns native credential, membership and minimum expiry', async t => {
  const f = await setup(t); const token = await orgKey(f);
  f.db.raw.prepare('UPDATE memberships SET expires_at=? WHERE id=?').run(at+30000,'m1');
  const actor = await resolveRoutingAuthority(f.db, token, 'so', 'memory_ingest', f.clock);
  assert.equal(actor.credentialId, 'org-key'); assert.equal(actor.accountId, 'alice');
  assert.equal(actor.organizationId, 'org'); assert.equal(actor.membershipId, 'm1');
  assert.equal(actor.spaceId, 'so'); assert.equal(actor.authorityExpiresAtMs, at+30000);
});

test('authenticated check sends server authority only and preserves the client receipt contract', async t => {
  const f = await setup(t); const token = await orgKey(f);
  const response = await f.request(checkPath,'POST',check,token);
  assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
  const receipt = await response.json(); assert.equal(receipt.requestId,check.requestId); assert.equal(receipt.spaceId,'so');
  assert.equal(receipt.consentVersion,1); assert.equal(receipt.allowed,true);
  assert.deepEqual(f.calls[0],[ 'issue', { organizationId:'org', accountId:'alice', credentialId:'org-key', spaceId:'so',
    operation:'memory_ingest', requestId:'request-1', authorityExpiresAtMs:at+800000 } ]);
});

for (const mode of ['wrong-space','read-only','revoked-key','revoked-member','revoked-email','disabled-account','expired']) test('check rejects '+mode+' before ledger issue',async t=>{
  const f=await setup(t); const token=await orgKey(f,{...(mode==='wrong-space'?{spaces:['s1']}:{}),...(mode==='read-only'?{capabilities:['read']}: {})});
  if(mode==='revoked-key')f.db.raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(at,'org-key');
  if(mode==='revoked-member')f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at,'m1');
  if(mode==='revoked-email')f.db.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE id=?').run(at,'e1');
  if(mode==='disabled-account')f.db.raw.prepare('UPDATE accounts SET disabled_at=? WHERE id=?').run(at,'alice');
  if(mode==='expired')f.setNow(at+900000);
  assert.ok([401,403].includes((await f.request(checkPath,'POST',check,token)).status));assert.equal(f.calls.length,0);
});

test('member may check recall but cannot admit ingestion; personal Space cannot invent an organization',async t=>{
  const f=await setup(t);
  assert.equal((await f.request(checkPath,'POST',{...check,operation:'memory_search'},f.other)).status,200);
  assert.equal((await f.request(checkPath,'POST',check,f.other)).status,403);
  assert.equal((await f.request(checkPath,'POST',{...check,spaceId:'s1'})).status,403);
  assert.equal(f.calls.length,1);
});

test('admin GET needs interactive authority; writes additionally need recent reauthentication',async t=>{
  const f=await setup(t);const key=await orgKey(f);
  assert.equal((await f.request(adminPath)).status,200);
  for(const token of [f.other,key,f.key])assert.equal((await f.request(adminPath,'GET',undefined,token)).status,403);
  f.db.raw.prepare('UPDATE credentials SET reauthenticated_at=NULL WHERE id=?').run('session:alice');
  assert.equal((await f.request(adminPath)).status,200);
  assert.equal((await f.request(adminPath,'PUT',{expectedVersion:1,grant})).status,403);
});

test('grant and revoke use current admin identity and exact org-owned Space scopes',async t=>{
  const f=await setup(t);
  assert.equal((await f.request(adminPath,'PUT',{expectedVersion:1,grant})).status,200);
  assert.equal(f.calls[0][1].approvedBy,'alice');assert.equal(f.calls[0][1].organizationId,'org');
  assert.equal((await f.request(adminPath,'DELETE',{expectedVersion:2})).status,200);
  for(const spaceIds of [['s1'],['so','s2'],['missing']])assert.equal((await f.request(adminPath,'PUT',{expectedVersion:3,grant:{...grant,spaceScope:{kind:'spaces',spaceIds}}})).status,403);
  assert.equal(f.calls.length,2);
});

test('post-ledger revocation prevents disclosing a usable receipt or admin record',async t=>{
  for(const method of ['issue','get']){
    const f=await setup(t,{beforeReturn:async(name,f)=>{if(name===method)f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at,'m1');}});
    const response=method==='issue'?await f.request(checkPath,'POST',check):await f.request(adminPath);
    assert.equal(response.status,403);const raw=await response.text();assert.equal(raw.includes('opaque-scoped-receipt'),false);assert.equal(raw.includes('approved-contract'),false);
  }
});

test('missing ledger is unavailable and malformed methods/content never reach a ledger',async t=>{
  const absent=await setup(t,{noLedger:true});assert.equal((await absent.request(checkPath,'POST',check)).status,503);
  const f=await setup(t);
  for(const [path,method,data,headers,status] of [[checkPath,'GET',undefined,{},405],[adminPath,'POST',{}, {},405],
    [checkPath,'POST',{...check,organizationId:'other'}, {},400],[checkPath,'POST',{...check,messages:['private']},{},400],
    [checkPath,'POST','{}',{'content-type':'text/plain'},415],[checkPath+'?extra=1','POST',check,{},400],
    [adminPath,'PUT',{expectedVersion:1,grant,approvedBy:'forged'},{},400],[checkPath,'POST','x'.repeat(8193),{},413]]){
    assert.equal((await f.request(path,method,data,f.token,headers)).status,status);
  }
  assert.equal(f.calls.length,0);
  assert.equal(await f.api(new Request(PUBLIC_ORIGIN+'/unrelated'),f.token),null);
});

test('real signed SSO reaches only the exact consent check path and cannot administer consent',async t=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const f=await setup(t,{auth:{jwks:async()=>publicKey}});
  f.db.raw.prepare('INSERT INTO provider_identities(issuer,subject,account_id,created_at) VALUES(?,?,?,?)').run(AUTH_ISSUER,'alice-subject','alice',at);
  const jwt=await new SignJWT({token_use:'access',client_id:'agent-client',azp:'agent-client',scope:'memory:read memory:write memory:delete'})
    .setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(AUTH_ISSUER).setAudience(PUBLIC_ORIGIN).setSubject('alice-subject').setJti('signed-api')
    .setIssuedAt(at/1000).setExpirationTime(at/1000+600).sign(privateKey);
  assert.equal((await f.request(checkPath,'POST',check,jwt)).status,200);
  assert.match(f.calls[0][1].credentialId,/^oauth:/);
  assert.equal((await f.request(adminPath,'GET',undefined,jwt)).status,403);
  assert.equal((await f.request(checkPath+'/other','POST',check,jwt)).status,403);
});

test('parent administration cannot grant consent for a child with independent revoked membership',async t=>{
  const f=await setup(t),workspace=new WorkspaceService(f.db,f.clock);
  const child=await workspace.createOrganization(f.token,{name:'Child',emailId:'e1',parentOrganizationId:'org'});
  f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE organization_id=?').run(at,child.id);
  assert.equal((await f.request('/v1/organizations/'+child.id+'/medical-cloudflare-consent')).status,403);
  assert.equal((await f.request(checkPath,'POST',{...check,spaceId:child.spaceId})).status,403);
  assert.equal((await f.request(adminPath,'PUT',{expectedVersion:1,grant:{...grant,spaceScope:{kind:'spaces',spaceIds:[child.spaceId]}}})).status,403);
  assert.equal(f.calls.length,0);
});

test('an actual accepted read share does not fabricate recipient organization membership',async t=>{
  const f=await setup(t),transfers=new Transfers(f.db,f.clock);
  const share=await transfers.share(f.token,'so','bob@example.com');await transfers.accept(f.other,share.id);
  f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at,'m2');
  await requireSpace(f.db,f.other,'so','read',f.clock);
  assert.equal((await f.request(checkPath,'POST',{...check,operation:'memory_search'},f.other)).status,403);
  assert.equal(f.calls.length,0);
});

test('authority expires after the primary query returns without issuing a receipt',async t=>{
  const f=await setup(t),original=f.db.prepare.bind(f.db);
  f.db.prepare=sql=>{const query=original(sql);if(sql.includes('/* routing-authority */')){
    const first=query.first;query.first=async()=>{const row=await first();f.setNow(at+900000);return row;};
  }return query;};
  await assert.rejects(resolveRoutingAuthority(f.db,f.token,'so','memory_ingest',f.clock),{status:403});
  assert.equal(f.calls.length,0);
});

test('committed admin write followed by lost authority is explicitly an unknown write outcome',async t=>{
  const f=await setup(t,{beforeReturn:async(name,f)=>{if(name==='grant')f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at,'m1');}});
  const response=await f.request(adminPath,'PUT',{expectedVersion:1,grant});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'routing_consent_write_outcome_unknown'});
  assert.equal(f.calls.length,1);
});

test('cookie consent administration keeps origin and selected-account protections',async t=>{
  const f=await setup(t),headers={'cookie':'__Host-memory_session='+f.token,'content-type':'application/json'};
  const request=extra=>f.app(new Request(PUBLIC_ORIGIN+adminPath,{method:'PUT',headers:{...headers,...extra},body:JSON.stringify({expectedVersion:1,grant})}));
  assert.equal((await request({})).status,403);
  assert.equal((await request({origin:PUBLIC_ORIGIN,'x-memory-account-id':'bob'})).status,409);
  assert.equal(f.calls.length,0);
});

test('native SQLite authority and actual ledger core complete grant, issue, CAS conflict and revoke',async t=>{
  const f=await setup(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const storage={sql:{exec(sql,...values){if(!values.length&&sql.includes(';')){db.exec(sql);return{toArray:()=>[]};}return{toArray:()=>db.prepare(sql).all(...values)};}},
    transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const ledger=new ConsentLedger(storage,{now:f.clock,objectName:'organization:org'});ledger.initialize();
  f.env.MEMORY_CONSENT_LEDGER={getByName(name){assert.equal(name,'organization:org');return ledger;}};
  assert.equal(await (await f.request(adminPath)).json(),null);
  const saved=await f.request(adminPath,'PUT',{expectedVersion:0,grant});assert.equal(saved.status,200);
  assert.equal((await saved.json()).version,1);
  const issued=await f.request(checkPath,'POST',check);assert.equal(issued.status,200);assert.match((await issued.json()).receipt,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.request(adminPath,'PUT',{expectedVersion:0,grant})).status,409);
  const revoked=await f.request(adminPath,'DELETE',{expectedVersion:1});assert.equal(revoked.status,200);assert.equal((await revoked.json()).version,2);
  assert.equal((await f.request(checkPath,'POST',check)).status,403);
  assert.equal(db.prepare('SELECT count(*) n FROM ledger_audit').get().n,2);
});

test('ledger diagnostics are sanitized and unavailable routed MCP never falls into legacy handlers',async t=>{
  const f=await setup(t);f.env.MEMORY_CONSENT_LEDGER={getByName(){return{get:async()=>{throw Error('PRIVATE-LEDGER-DIAGNOSTIC');}};}};
  const response=await f.request(adminPath);assert.equal(response.status,503);assert.equal((await response.text()).includes('PRIVATE-LEDGER'),false);
  const mcp=await f.request('/mcp','POST',{jsonrpc:'2.0',id:'rpc-1',method:'tools/call',params:{name:'memory_ingest',arguments:{}}},f.token,{'x-memory-consent-receipt':'unavailable'});
  assert.equal(mcp.status,503);assert.deepEqual(await mcp.json(),{error:'routing_runtime_unavailable'});
});

test('routing version validation precedes both medical and general MCP dispatch',async t=>{
  const f=await setup(t);
  const payload={jsonrpc:'2.0',id:'protocol-check',method:'tools/call',params:{name:'memory_ingest',arguments:{}}};
  for(const receipt of [false,true])for(const version of ['', '2', '01', '1, 1']){
    const headers={'x-memory-routing':version,...(receipt?{'x-memory-consent-receipt':'synthetic-receipt'}:{})};
    const response=await f.request('/mcp','POST',payload,f.token,headers);
    assert.equal(response.status,400);
    assert.deepEqual(await response.json(),{error:'routing_protocol_invalid'});
  }
  // Historical receipt-only clients still select the medical handler, whose
  // disabled runtime must not fall through to the legacy MCP implementation.
  const legacy=await f.request('/mcp','POST',payload,f.token,{'x-memory-consent-receipt':'synthetic-receipt'});
  assert.equal(legacy.status,503);assert.deepEqual(await legacy.json(),{error:'routing_runtime_unavailable'});
  assert.equal(f.calls.length,0);
});

test('medical and general routed MCP reject URL query data before any backend selection',async t=>{
  const f=await setup(t);
  const payload={jsonrpc:'2.0',id:'query-check',method:'tools/call',params:{name:'memory_search',arguments:{}}};
  for(const headers of [{'x-memory-routing':'1'},{'x-memory-consent-receipt':'synthetic-receipt'},
    {'x-memory-routing':'1','x-memory-consent-receipt':'synthetic-receipt'}]){
    const response=await f.request('/mcp?query=synthetic-query-marker','POST',payload,f.token,headers);
    assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'routing_request_invalid'});
  }
  assert.equal(f.calls.length,0);
});

test('consent and MCP share collision-safe request IDs while fresh search receipts get fresh results',async t=>{
  const f=await setup(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const storage={sql:{exec(sql,...values){if(!values.length&&sql.includes(';')){db.exec(sql);return{toArray:()=>[]};}return{toArray:()=>db.prepare(sql).all(...values)};}},
    transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const ledger=new ConsentLedger(storage,{now:f.clock,objectName:'organization:org'});ledger.initialize();
  f.env.MEMORY_CONSENT_LEDGER={getByName:()=>ledger};
  assert.equal((await f.request(adminPath,'PUT',{expectedVersion:0,grant})).status,200);
  let recalls=0;
  const handler=createRoutedMcpHandler({clock:f.clock,allowedMedicalSpaceIds:['so'],seoulSpaceIds:[],ledger:()=>ledger,
    budgetId:'api-test',budgetPolicy:{version:1,revision:'api-v1',validUntilMs:f.clock()+600000,maxMonthlyRequests:100,
      maxMonthlyInputBytes:1000000,maxMonthlyReservedMicroUsd:1000000,ingestBaseMicroUsd:10,ingestMicroUsdPerKiB:1,
      searchBaseMicroUsd:10,searchMicroUsdPerKiB:1,pricingBasis:'operator-upper-bound'},
    budget:{async reserve(input){return {reservationId:input.reservationId,month:'2026-09',reservedMicroUsd:11,
      expiresAtMs:Math.min(input.authorityExpiresAtMs,f.clock()+60000),replayed:false};},async finalize(){},async usage(){return {}; }},
    authority:(token,spaceId,operation)=>resolveRoutingAuthority(f.db,token,spaceId,operation,f.clock),
    provider:{async ingest(){},async recall(){return{answer:'Result '+(++recalls),count:0,candidates:[]};}}});
  const issue=async requestId=>{
    const response=await f.request(checkPath,'POST',{...check,requestId,operation:'memory_search'});
    assert.equal(response.status,200,await response.clone().text());
    const receipt=await response.json();assert.equal(receipt.requestId,requestId);return receipt;
  };
  const recall=async(requestId,permit)=>handler(new Request(PUBLIC_ORIGIN+'/mcp',{method:'POST',
    headers:{'content-type':'application/json','x-memory-consent-receipt':permit.receipt},
    body:JSON.stringify({jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:'memory_search',_meta:{progressToken:1},arguments:{
      spaceId:'so',query:'Synthetic question',routing:{version:1,classification:'medical',medicalCloudflareConsent:{consentId:permit.consentId,version:permit.consentVersion}}}}})}),f.token);
  const wireIds=[0,1,'1','rpc-number:1','request with spaces','','rpc-text:'+'a'.repeat(64),'요청 1','\ud800','�'];
  for(const requestId of wireIds){
    const permit=await issue(requestId),response=await recall(requestId,permit),value=await response.json();
    assert.equal(value.id,requestId);assert.equal(value.result.isError,undefined,JSON.stringify(value));
    assert.equal(JSON.parse(value.result.content[0].text).answer,'Result '+recalls);
  }
  const keys=db.prepare('SELECT request_id FROM ledger_operations').all().map(row=>row.request_id);
  assert.equal(new Set(keys).size,wireIds.length);for(const key of keys)assert.match(key,/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  const permit=await issue(1),wrong=await recall('1',permit);
  assert.equal((await wrong.json()).result.isError,true);assert.equal(recalls,wireIds.length);
  const first=await recall(1,permit);assert.equal((await first.json()).result.isError,undefined);
  const replay=await recall(1,permit);assert.equal((await replay.json()).result.isError,true);assert.equal(recalls,wireIds.length+1);
  const fresh=await recall(1,await issue(1)),value=await fresh.json();
  assert.equal(value.id,1);assert.equal(value.result.isError,undefined);assert.equal(JSON.parse(value.result.content[0].text).answer,'Result '+(wireIds.length+2));
});

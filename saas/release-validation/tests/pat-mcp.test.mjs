import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, SignJWT} from 'jose';
import {DB, at} from './db.mjs';
import {createApplication} from '../../src/app.ts';
import {createRelease} from '../../src/release/extension.ts';
import {AUTH_ISSUER, PUBLIC_ORIGIN, SERVICE_ID, readSettings} from '../../src/config.ts';
import {SESSION_COOKIE} from '../../src/auth.ts';

const {privateKey,publicKey}=await generateKeyPair('RS256');
async function signedToken({scope='openid email memory:read memory:write memory:delete',client='browser-client',azp=client,audience=PUBLIC_ORIGIN,subject='pat-owner'}={}){
  return new SignJWT({token_use:'access',client_id:client,azp,scope,email:'owner@corp.example',emailVerified:true})
    .setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(AUTH_ISSUER).setAudience(audience).setSubject(subject)
    .setJti(crypto.randomUUID()).setIssuedAt(at/1000).setExpirationTime(at/1000+900).sign(privateKey);
}
async function fixture(t){
  const db=new DB();db.migrate();t.after(()=>db.close());let now=at,delivered;
  const browserToken=await signedToken();
  const env={DB:db,PUBLIC_ORIGIN,SSO_CLIENT_ID:'browser-client',REQUEST_LIMITER:{limit:async()=>({success:true})},
    MAIL_FROM:'memory@example.org',EMAIL:{send:async message=>{delivered=message;return {messageId:'synthetic-reauth-mail'};}}};
  const release=createRelease(env,{clock:()=>now});
  const app=createApplication(db,readSettings(env),{clock:()=>now,release,auth:{jwks:async()=>publicKey,fetch:async(url,init)=>{
    assert.equal(String(url),AUTH_ISSUER+'/oauth/token');
    assert.equal(init.method,'POST');assert.ok(new URLSearchParams(init.body).get('code_verifier'));
    return Response.json({access_token:browserToken,token_type:'Bearer'});
  }}});
  async function request(path,{method='GET',data,token,cookie,headers={}}={}){
    return app(new Request(PUBLIC_ORIGIN+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(cookie?{cookie}:{}),
      ...(data!==undefined?{'content-type':'application/json'}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})}));
  }
  // Exercise the original verified OAuth/PKCE callback, then the actual email
  // proof endpoints. No database reauthentication shortcut issues these PATs.
  const login=await request('/auth/login');assert.equal(login.status,302);
  const authorization=new URL(login.headers.get('location'));
  assert.equal(authorization.origin,AUTH_ISSUER);assert.equal(authorization.searchParams.get('resource'),PUBLIC_ORIGIN);
  const callback=await request('/auth/callback?'+new URLSearchParams({code:'synthetic-code',state:authorization.searchParams.get('state'),iss:AUTH_ISSUER}),
    {cookie:login.headers.get('set-cookie').split(';')[0]});
  assert.equal(callback.status,303);
  const cookie=callback.headers.getSetCookie().find(value=>value.startsWith(SESSION_COOKIE+'=')).split(';')[0];
  const browser=(path,{method='GET',data}={})=>request(path,{method,data,cookie,headers:{origin:PUBLIC_ORIGIN}});
  const snapshotResponse=await browser('/v1/workspace');assert.equal(snapshotResponse.status,200);
  const snapshot=await snapshotResponse.json(),spaceIds=[snapshot.spaces[0].id];
  for(const name of ['Second selected repository','Excluded repository']){
    const response=await browser('/v1/spaces',{method:'POST',data:{name,securityMode:'managed'}});
    assert.equal(response.status,201);spaceIds.push((await response.json()).id);
  }
  const records=[];
  for(const [index,spaceId] of spaceIds.entries()){
    const response=await browser(`/v1/spaces/${spaceId}/memories`,{method:'POST',data:{body:'Private repository '+index,operationId:'seed-'+index}});
    assert.equal(response.status,201);records.push(await response.json());
  }
  const challengeResponse=await browser('/v1/account/reauth',{method:'POST',data:{emailId:snapshot.account.emails[0].id}});
  assert.equal(challengeResponse.status,202);const challenge=await challengeResponse.json();
  assert.equal(delivered.to,'owner@corp.example');
  const proof=delivered.text.match(/Proof: ([A-Za-z0-9_-]+)/)[1];
  const verified=await browser('/v1/account/reauth/complete',{method:'POST',data:{challengeId:challenge.id,proof}});
  assert.equal(verified.status,200);
  async function issue(capabilities,selected=spaceIds.slice(0,2)){
    const response=await browser('/v1/keys',{method:'POST',data:{label:'Selected repositories PAT',capabilities,spaceIds:selected,expiresInDays:1}});
    assert.equal(response.status,201);const pat=await response.json();
    assert.deepEqual(pat.capabilities,capabilities);assert.deepEqual(pat.spaceIds,selected);
    return pat;
  }
  let rpcId=0;
  async function rpc(token,method,params={}){
    const response=await request('/mcp',{method:'POST',token,data:{jsonrpc:'2.0',id:++rpcId,method,params},headers:{accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'}});
    const text=await response.text();assert.equal(response.status,200,text);
    const value=JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')?text.split('\n').find(line=>line.startsWith('data: ')).slice(6):text);
    assert.equal(value.error,undefined);return value.result;
  }
  async function tool(token,name,args={}){
    const result=await rpc(token,'tools/call',{name,arguments:args});
    return {failed:result.isError===true,value:JSON.parse(result.content[0].text)};
  }
  return {db,request,browser,cookie,snapshot,spaceIds,records,issue,rpc,tool,setNow:value=>{now=value;}};
}
function permitted(result){assert.equal(result.failed,false,JSON.stringify(result.value));return result.value;}
function denied(result){assert.equal(result.failed,true);assert.equal(result.value.status,403);assert.equal(result.value.error,'access_denied');}
async function scopeDenied(f,token,name,args,scope){
 const response=await f.request('/mcp',{method:'POST',token,data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},headers:{accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'}});
 assert.equal(response.status,403);assert.match(response.headers.get('www-authenticate'),/error="insufficient_scope"/);assert.ok(response.headers.get('www-authenticate').includes(scope));
}

test('MCP advertises memory_add replacement effects that supersession actually performs',async t=>{
  const f=await fixture(t),pat=await f.issue(['read','create','update']);
  const advertised=(await f.rpc(pat.token,'tools/list')).tools.find(tool=>tool.name==='memory_add');
  const replacement=permitted(await f.tool(pat.token,'memory_add',{spaceId:f.spaceIds[0],body:'Replacement fact',
    supersedesMemoryId:f.records[0].id,operationId:'annotation-supersession'}));
  const current=permitted(await f.tool(pat.token,'memory_list',{spaceId:f.spaceIds[0]}));
  assert.ok(current.results.some(row=>row.id===replacement.id));
  assert.ok(current.results.every(row=>row.id!==f.records[0].id),'Supersession removes the prior fact from normal listings');
  assert.equal(advertised.annotations.readOnlyHint,false);
  assert.equal(advertised.annotations.destructiveHint,true,'A tool capable of replacement cannot advertise additive-only effects');
});

test('PAT MCP permits read/create in selected Spaces only and never grants management',async t=>{
  const f=await fixture(t),pat=await f.issue(['read','create']);
  const initialized=await f.rpc(pat.token,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'PAT connector',version:'1'}});
  assert.equal(initialized.serverInfo.name,SERVICE_ID);
  assert.ok((await f.rpc(pat.token,'tools/list')).tools.some(tool=>tool.name==='memory_add'));
  const listed=permitted(await f.tool(pat.token,'memory_spaces'));
  assert.deepEqual(listed.results.map(space=>space.id).sort(),f.spaceIds.slice(0,2).sort());
  for(const index of [0,1]){
    assert.equal(permitted(await f.tool(pat.token,'memory_get',{spaceId:f.spaceIds[index],memoryId:f.records[index].id})).body,'Private repository '+index);
    const created=permitted(await f.tool(pat.token,'memory_add',{spaceId:f.spaceIds[index],body:'PAT added '+index,operationId:'pat-create-'+index}));
    assert.equal(created.body,'PAT added '+index);
    assert.ok(permitted(await f.tool(pat.token,'memory_list',{spaceId:f.spaceIds[index]})).results.some(record=>record.id===created.id));
  }
  const excluded=f.spaceIds[2];
  for(const [name,args] of [
    ['memory_get',{spaceId:excluded,memoryId:f.records[2].id}],['memory_list',{spaceId:excluded}],
    ['memory_search',{spaceId:excluded,query:'Private'}],['memory_add',{spaceId:excluded,body:'Forbidden',operationId:'cross-space'}],
    ['memory_update',{spaceId:f.spaceIds[0],memoryId:f.records[0].id,body:'Forbidden update',expectedRevision:1,operationId:'no-update'}],
    ['memory_delete',{spaceId:f.spaceIds[0],memoryId:f.records[0].id,expectedRevision:1,operationId:'no-delete'}],
  ])denied(await f.tool(pat.token,name,args));
  for(const [path,method,data] of [
    ['/v1/workspace','GET'],['/v1/release/config','GET'],
    ['/v1/keys','POST',{label:'Escalation',capabilities:['read'],spaceIds:[excluded],expiresInDays:1}],
    ['/v1/spaces','POST',{name:'Forbidden repository'}],
    ['/v1/organizations','POST',{name:'Forbidden organization',emailId:f.snapshot.account.emails[0].id}],
    ['/v1/account/reauth','POST',{emailId:f.snapshot.account.emails[0].id}],
  ])assert.ok([401,403].includes((await f.request(path,{method,data,token:pat.token})).status),path);
  const original=await(await f.browser(`/v1/spaces/${f.spaceIds[0]}/memories/${f.records[0].id}`)).json();
  assert.equal(original.body,'Private repository 0');assert.equal(original.revision,1);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_operations WHERE client_key IN (?,?,?)').get('cross-space','no-update','no-delete').n,0);
});

test('create-only PAT MCP returns receipts without disclosing memory or other Spaces',async t=>{
  const f=await fixture(t),pat=await f.issue(['create'],[f.spaceIds[0]]);
  const created=permitted(await f.tool(pat.token,'memory_add',{spaceId:f.spaceIds[0],body:'Append without read',operationId:'append'}));
  assert.equal(created.representation,'receipt');assert.equal(created.revision,1);assert.ok(!('body' in created));
  assert.deepEqual(permitted(await f.tool(pat.token,'memory_spaces')).results,[]);
  denied(await f.tool(pat.token,'memory_get',{spaceId:f.spaceIds[0],memoryId:created.id}));
  denied(await f.tool(pat.token,'memory_list',{spaceId:f.spaceIds[0]}));
  denied(await f.tool(pat.token,'memory_add',{spaceId:f.spaceIds[1],body:'Outside selection',operationId:'wrong-space'}));
});

test('read-only PAT MCP denies writes, survives browser expiry, and stops on revocation or PAT expiry',async t=>{
  const f=await fixture(t),revoked=await f.issue(['read'],[f.spaceIds[0]]),expiring=await f.issue(['read'],[f.spaceIds[0]]);
  denied(await f.tool(revoked.token,'memory_add',{spaceId:f.spaceIds[0],body:'No writes',operationId:'reader-write'}));
  assert.equal((await f.browser('/v1/keys/'+revoked.id,{method:'DELETE'})).status,204);
  const stopped=await f.request('/mcp',{method:'POST',token:revoked.token,data:{jsonrpc:'2.0',id:1,method:'tools/list'}});
  assert.equal(stopped.status,401);assert.match(stopped.headers.get('www-authenticate'),/oauth-protected-resource/);
  f.setNow(at+900001);
  assert.equal(permitted(await f.tool(expiring.token,'memory_get',{spaceId:f.spaceIds[0],memoryId:f.records[0].id})).body,'Private repository 0');
  f.setNow(expiring.expiresAt);
  assert.equal((await f.request('/mcp',{method:'POST',token:expiring.token,data:{jsonrpc:'2.0',id:2,method:'tools/list'}})).status,401);
});

test('real signed OAuth remains an MCP alternative with verified scopes and no management authority',async t=>{
  const f=await fixture(t),oauth=await signedToken({client:'plugin-oauth-client'});
  const spaces=permitted(await f.tool(oauth,'memory_spaces'));
  assert.deepEqual(spaces.results.map(space=>space.id).sort(),[...f.spaceIds].sort());
  const created=permitted(await f.tool(oauth,'memory_add',{spaceId:f.spaceIds[0],body:'OAuth plugin memory',operationId:'oauth-create'}));
  assert.equal(permitted(await f.tool(oauth,'memory_get',{spaceId:f.spaceIds[0],memoryId:created.id})).body,'OAuth plugin memory');
  const readOnly=await signedToken({client:'read-only-plugin',scope:'memory:read'});
  await scopeDenied(f,readOnly,'memory_add',{spaceId:f.spaceIds[0],body:'Scope escalation',operationId:'oauth-read-only'},'memory:write');
  for(const path of ['/v1/workspace','/v1/release/config'])assert.equal((await f.request(path,{token:oauth})).status,403);
  assert.equal((await f.request('/v1/keys',{method:'POST',token:oauth,data:{label:'Escalation',capabilities:['read'],expiresInDays:1}})).status,403);
  const wrongAudience=await signedToken({client:'plugin-oauth-client',audience:'https://other.example'});
  assert.equal((await f.request('/mcp',{method:'POST',token:wrongAudience,data:{jsonrpc:'2.0',id:1,method:'tools/list'}})).status,401);
  const mismatchedClient=await signedToken({client:'plugin-oauth-client',azp:'different-client'});
  assert.equal((await f.request('/mcp',{method:'POST',token:mismatchedClient,data:{jsonrpc:'2.0',id:4,method:'tools/list'}})).status,401);
  const parts=oauth.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  assert.equal((await f.request('/mcp',{method:'POST',token:parts.join('.'),data:{jsonrpc:'2.0',id:2,method:'tools/list'}})).status,401);
  assert.equal((await f.request('/mcp',{method:'POST',cookie:f.cookie,data:{jsonrpc:'2.0',id:3,method:'tools/list'}})).status,401);
});

test('partial OAuth scopes preserve permitted MCP writes without granting delete or Space management',async t=>{
  const f=await fixture(t),writer=await signedToken({client:'write-without-delete',scope:'memory:read memory:write'});
  const created=permitted(await f.tool(writer,'memory_add',{spaceId:f.spaceIds[0],body:'Scoped writer',operationId:'partial-create'}));
  const updated=permitted(await f.tool(writer,'memory_update',{spaceId:f.spaceIds[0],memoryId:created.id,body:'Scoped update',expectedRevision:1,operationId:'partial-update'}));
  assert.equal(updated.body,'Scoped update');assert.equal(updated.revision,2);
  await scopeDenied(f,writer,'memory_delete',{spaceId:f.spaceIds[0],memoryId:created.id,expectedRevision:2,operationId:'partial-delete-denied'},'memory:delete');
  const deleter=await signedToken({client:'delete-without-write',scope:'memory:read memory:delete'});
  await scopeDenied(f,deleter,'memory_add',{spaceId:f.spaceIds[0],body:'No create',operationId:'delete-create-denied'},'memory:write');
  await scopeDenied(f,deleter,'memory_update',{spaceId:f.spaceIds[0],memoryId:created.id,body:'No update',expectedRevision:2,operationId:'delete-update-denied'},'memory:write');
  permitted(await f.tool(deleter,'memory_delete',{spaceId:f.spaceIds[0],memoryId:created.id,expectedRevision:2,operationId:'partial-delete'}));
  const orgResponse=await f.browser('/v1/organizations',{method:'POST',data:{name:'Owner organization',emailId:f.snapshot.account.emails[0].id}});
  assert.equal(orgResponse.status,201);const org=await orgResponse.json();
  const count=f.db.raw.prepare('SELECT count(*) n FROM spaces').get().n;
  for(const token of [writer,deleter,await signedToken({client:'full-memory-grant'})]){
    for(const data of [{name:'Unauthorized personal Space'},{name:'Unauthorized organization Space',organizationId:org.id}]){
      assert.equal((await f.request('/v1/spaces',{method:'POST',token,data})).status,403);
    }
  }
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM spaces').get().n,count);
});

test('organization PATs retain exact Space and membership boundaries across hierarchy and role changes',async t=>{
  const f=await fixture(t),emailId=f.snapshot.account.emails[0].id;
  async function organization(name,parentOrganizationId){
    const response=await f.browser('/v1/organizations',{method:'POST',data:{name,emailId,...(parentOrganizationId?{parentOrganizationId}:{})}});
    assert.equal(response.status,201);return response.json();
  }
  const parent=await organization('Parent'),child=await organization('Child',parent.id);
  const secondResponse=await f.browser('/v1/spaces',{method:'POST',data:{name:'Second parent Space',organizationId:parent.id}});
  assert.equal(secondResponse.status,201);const second=await secondResponse.json();
  async function issue(spaceIds){
    const response=await f.browser('/v1/keys',{method:'POST',data:{label:'Organization connector',organizationId:parent.id,capabilities:['read','create'],expiresInDays:1,...(spaceIds?{spaceIds}:{})}});
    assert.equal(response.status,201);return response.json();
  }
  const selected=await issue([parent.spaceId]),all=await issue();
  assert.deepEqual(permitted(await f.tool(selected.token,'memory_spaces')).results.map(space=>space.id),[parent.spaceId]);
  assert.deepEqual(permitted(await f.tool(all.token,'memory_spaces')).results.map(space=>space.id).sort(),[parent.spaceId,second.id].sort());
  for(const spaceId of [second.id,child.spaceId,f.spaceIds[0]])denied(await f.tool(selected.token,'memory_add',{spaceId,body:'Out of scope',operationId:'outside-'+spaceId}));
  for(const spaceId of [child.spaceId,f.spaceIds[0]])denied(await f.tool(all.token,'memory_list',{spaceId}));
  const created=permitted(await f.tool(selected.token,'memory_add',{spaceId:parent.spaceId,body:'Organization memory',operationId:'org-create'}));
  const membership=f.db.raw.prepare('SELECT membership_id AS id FROM credentials WHERE id=?').get(selected.id);
  f.db.raw.prepare("UPDATE memberships SET role='member' WHERE id=?").run(membership.id);
  assert.equal(permitted(await f.tool(selected.token,'memory_get',{spaceId:parent.spaceId,memoryId:created.id})).body,'Organization memory');
  denied(await f.tool(selected.token,'memory_add',{spaceId:parent.spaceId,body:'Demoted writer',operationId:'demoted-create'}));
  // A still-active child membership must not keep the parent-bound PAT alive.
  f.db.raw.prepare('UPDATE memberships SET expires_at=? WHERE id=?').run(at,membership.id);
  assert.equal((await f.request('/mcp',{method:'POST',token:selected.token,data:{jsonrpc:'2.0',id:1,method:'tools/list'}})).status,401);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM active_memberships WHERE organization_id=? AND expires_at>?').get(child.id,at).n,1);
});

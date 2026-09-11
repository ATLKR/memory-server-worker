import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {fixture,DB,at} from './db.mjs';
import {Admin} from '../../src/release/admin.ts';
import {createRelease} from '../../src/release/extension.ts';
import {createApplication} from '../../src/app.ts';
import {WorkspaceService} from '../../src/workspace.ts';
import {AUTH_ISSUER,PUBLIC_ORIGIN,readSettings} from '../../src/config.ts';
import {digest,hmac} from '../../src/release/util.ts';
import {interactive,requireSpace} from '../../src/release/authority.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {IdentityService} from '../../src/identity.ts';

function afterDigest(t,callback){const original=crypto.subtle.digest;crypto.subtle.digest=async function(algorithm,data){const result=await original.call(this,algorithm,data);callback(new TextDecoder().decode(data));return result;};t.after(()=>{crypto.subtle.digest=original;});}
function afterRead(db,fragment,callback){const prepare=db.prepare.bind(db);db.prepare=sql=>{const statement=prepare(sql),first=statement.first.bind(statement);statement.first=async()=>{const result=await first();if(sql.includes(fragment))callback();return result;};return statement;};}
function afterAll(db,fragment,callback){const prepare=db.prepare.bind(db);db.prepare=sql=>{const statement=prepare(sql),all=statement.all.bind(statement);statement.all=async()=>{const result=await all();if(sql.includes(fragment))callback();return result;};return statement;};}
for(const expiry of ['session','member','proof'])test('SCIM key revoke rechecks '+expiry+' expiry after token hashing',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;
 const env={DB:f.db,REQUEST_LIMITER:{limit:async()=>({success:true})}},admin=new Admin(env,()=>now),key=await admin.issueScimKey(f.token,'org'),release=createRelease(env,{clock:()=>now});
 if(expiry==='session')f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+100);
 if(expiry==='member')f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+100);
 if(expiry==='proof')f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-299900);
 let hashes=0;afterDigest(t,value=>{if(value===f.token&&++hashes===2)now=at+200;});
 const response=await release.route(new Request(PUBLIC_ORIGIN+'/v1/organizations/org/scim-keys/'+key.id,{method:'DELETE'}),f.token);
 assert.equal(response.status,403);assert.equal(f.db.raw.prepare('SELECT revoked_at FROM release_scim_keys WHERE id=?').get(key.id).revoked_at,null);
});

for(const member of ['Active','ACTIVE','active'])test('SCIM pathless deactivation accepts '+member,async t=>{
 const f=await fixture();t.after(()=>f.db.close());const env={DB:f.db,REQUEST_LIMITER:{limit:async()=>({success:true})}},admin=new Admin(env,()=>at),key=await admin.issueScimKey(f.token,'org');
 const response=await createRelease(env,{clock:()=>at}).publicRoute(new Request(PUBLIC_ORIGIN+'/scim/v2/org/Users/m2',{method:'PATCH',headers:{authorization:'Bearer '+key.token,'content-type':'application/scim+json'},body:JSON.stringify({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',value:{[member]:false}}]})}));
 assert.equal(response.status,204);assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,at);
});
for(const value of [{active:false,Active:true},{active:false,Active:false},{Active:false,userName:'changed'}, {ACTIVE:true}])test('SCIM pathless deactivation rejects unsupported or duplicate attributes '+JSON.stringify(value),async t=>{
 const f=await fixture();t.after(()=>f.db.close());const admin=new Admin({DB:f.db},()=>at),key=await admin.issueScimKey(f.token,'org');
 await assert.rejects(()=>admin.scim(new Request(PUBLIC_ORIGIN+'/scim/v2/org/Users/m2',{method:'PATCH',headers:{authorization:'Bearer '+key.token,'content-type':'application/scim+json'},body:JSON.stringify({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',value}]})}),'org','m2'),e=>e.status===400);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,null);
});

for(const external of [false,true])test('workspace sign-in rejects principal expiry during hashing; external='+external,async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;const service=new WorkspaceService(f.db,()=>now),before=f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n;
 afterDigest(t,()=>{now=at+200;});
 await assert.rejects(()=>service.signIn({issuer:AUTH_ISSUER,subject:'expired-new',permission:'read',expiresAt:at+100},external?'external-opaque-token-01234567890123456789':undefined));
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n,before);
});

test('verified OAuth policy insertion checks expiry after token hashing',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;
 const token='header.'+btoa(JSON.stringify({scope:'memory:read'})).replaceAll('=','')+'.signature',hash=await digest(token);
 f.db.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,permission) VALUES(?,'alice','session',?,?,'read')").run('oauth:'+hash,hash,at+100);
 const release=createRelease({DB:f.db,REQUEST_LIMITER:{limit:async()=>({success:true})}},{clock:()=>now});
 afterDigest(t,()=>{now=at+200;});
 await release.signedIn({}, {token,accountId:'alice',expiresAt:at+100},true);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_credential_policies WHERE credential_id=? AND verified_oauth=1').get('oauth:'+hash).n,0);
});

const keys=await generateKeyPair('RS256');
async function oauthFixture(t,scope){const db=new DB();db.migrate();t.after(()=>db.close());
 let now=at;
 const token=await new SignJWT({token_use:'access',scope,client_id:'agent-client',azp:'agent-client'}).setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(AUTH_ISSUER).setAudience(PUBLIC_ORIGIN).setSubject('oauth-r8').setJti(crypto.randomUUID()).setIssuedAt(at/1000).setExpirationTime(at/1000+900).sign(keys.privateKey);
 const env={DB:db,SSO_CLIENT_ID:'browser-client',PUBLIC_ORIGIN,REQUEST_LIMITER:{limit:async()=>({success:true})}},release=createRelease(env,{clock:()=>now}),app=createApplication(db,readSettings(env),{clock:()=>now,auth:{jwks:async()=>keys.publicKey},release});
 await app(new Request(PUBLIC_ORIGIN+'/v1/spaces',{headers:{authorization:'Bearer '+token}}));
 const space=db.raw.prepare("SELECT id FROM spaces WHERE account_id=(SELECT account_id FROM provider_identities WHERE subject='oauth-r8')").get().id;
 const call=(name,args,version='2025-11-25')=>app(new Request(PUBLIC_ORIGIN+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':version,...(version==='2026-07-28'?{'mcp-method':'tools/call','mcp-name':name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,...(version==='2026-07-28'?{_meta:{'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientInfo':{name:'r8-review',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}:{})}})}));
 return {db,token,space,call,setNow:value=>{now=value;}};}
for(const [scope,name,args,required] of [
 ['memory:read','memory_add',{body:'denied',operationId:'scope'},'memory:write'],
 ['memory:read memory:write','memory_delete',{memoryId:'missing',expectedRevision:1,operationId:'scope'},'memory:delete'],
 ['memory:read memory:delete','memory_update',{memoryId:'missing',body:'denied',expectedRevision:1,operationId:'scope'},'memory:write'],
])test('MCP OAuth scope challenge '+name,async t=>{const f=await oauthFixture(t,scope),response=await f.call(name,{spaceId:f.space,...args});
 assert.equal(response.status,403);assert.match(response.headers.get('www-authenticate'),/Bearer.*error="insufficient_scope"/);assert.ok(response.headers.get('www-authenticate').includes(required));assert.ok(response.headers.get('www-authenticate').includes(PUBLIC_ORIGIN+'/.well-known/oauth-protected-resource'));
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_operations').get().n,0);
});
test('MCP OAuth with sufficient scopes keeps Space ACL denial as an ordinary tool error',async t=>{const f=await oauthFixture(t,'memory:read memory:write'),response=await f.call('memory_add',{spaceId:'foreign',body:'denied',operationId:'acl'});
 assert.equal(response.status,200);assert.equal(response.headers.get('www-authenticate'),null);assert.match(await response.text(),/access_denied/);
});
for(const scope of ['memory:read','memory:read memory:write'])test('modern MCP keeps scope challenge and SDK result handling: '+scope,async t=>{
 const f=await oauthFixture(t,scope),response=await f.call('memory_add',{spaceId:f.space,body:'modern',operationId:'modern'},'2026-07-28');
 assert.equal(response.status,scope.includes('write')?200:403);if(scope.includes('write')){assert.equal(response.headers.get('www-authenticate'),null);assert.equal((await response.json()).result.isError,false);}
});
test('MCP leaves malformed arguments and unknown tools to the SDK',async t=>{
 const f=await oauthFixture(t,'memory:read');
 for(const [name,args] of [['memory_add',{spaceId:f.space,body:42,operationId:'bad'}],['unknown_tool',{}]]){
  const response=await f.call(name,args);assert.equal(response.status,200);assert.equal(response.headers.get('www-authenticate'),null);assert.match(await response.text(),/error|isError/);
 }
});
test('MCP checks OAuth expiry after its capability snapshot',async t=>{
 const f=await oauthFixture(t,'memory:read');f.db.raw.prepare('UPDATE credentials SET expires_at=? WHERE token_digest=?').run(at+100,await digest(f.token));
 afterRead(f.db,'SELECT p.capabilities',()=>f.setNow(at+200));
 const response=await f.call('memory_add',{spaceId:f.space,body:'expired',operationId:'expiry'});
 assert.equal(response.status,401);assert.doesNotMatch(response.headers.get('www-authenticate'),/insufficient_scope/);
});

for(const boundary of ['credential','organization','recent proof','admin membership','SCIM key','SCIM membership'])test('authority rejects '+boundary+' expiry during its final SQL read',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;const admin=new Admin({DB:f.db},()=>now),key=await admin.issueScimKey(f.token,'org');
 if(boundary==='credential')f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+100);
 if(['organization','admin membership','SCIM membership'].includes(boundary))f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+100);
 if(boundary==='recent proof')f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-299900);
 const fragment=boundary.startsWith('SCIM')?'SELECT k.id':boundary==='admin membership'?'SELECT c.account_id AS accountId,m.id':'SELECT c.id,c.account_id AS accountId';
 afterRead(f.db,fragment,()=>{now=boundary==='SCIM key'?key.expiresAt+1:at+200;});
 const operation=boundary.startsWith('SCIM')?()=>admin.scimAuthority(key.token,'org'):boundary==='admin membership'?()=>admin.orgAdmin(f.token,'org'):boundary==='recent proof'?()=>interactive(f.db,f.token,()=>now,true):()=>requireSpace(f.db,f.token,boundary==='organization'?'so':'s1','read',()=>now);
 await assert.rejects(operation,error=>[401,403].includes(error.status));
});

for(const until of [200,600])test('final Space read uses independent accepted-share expiry after membership expiry; elapsed='+until,async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;const transfers=new Transfers(f.db,()=>now),share=await transfers.share(f.token,'so','bob@example.com',1);await transfers.accept(f.other,share.id);
 f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at+100);
 f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+500);
 afterRead(f.db,'SELECT c.id,c.account_id AS accountId',()=>{now=at+until;});
 const operation=()=>requireSpace(f.db,f.other,'so','read',()=>now);
 if(until===200)assert.equal((await operation()).accountId,'bob');else await assert.rejects(operation,error=>error.status===403);
});

for(const operation of ['identity account','identity organization','workspace snapshot','workspace members'])test(operation+' checks expiry after its final data query',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;const identity=new IdentityService(f.db,()=>now),workspace=new WorkspaceService(f.db,()=>now);
 f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+100);
 const advance=()=>{now=at+200;};
 if(operation==='identity account')afterAll(f.db,'SELECT c.account_id AS accountId',advance);
 if(operation==='identity organization')afterRead(f.db,'SELECT c.account_id AS accountId',advance);
 if(operation==='workspace snapshot')afterRead(f.db,'SELECT c.account_id AS accountId',advance);
 if(operation==='workspace members')afterAll(f.db,'SELECT target.id',advance);
 await assert.rejects(()=>operation==='identity account'?identity.getAccount(f.token):operation==='identity organization'?identity.authorizeOrganization(f.token,'org'):operation==='workspace snapshot'?workspace.snapshot(f.token):workspace.listMembers(f.token,'org'));
});
for(const until of [200,600])test('workspace snapshot filters elapsed org grants while preserving an independent share; elapsed='+until,async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;const transfers=new Transfers(f.db,()=>now),share=await transfers.share(f.token,'so','bob@example.com',1);await transfers.accept(f.other,share.id);
 f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at+100);f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+500);
 const release=createRelease({DB:f.db,REQUEST_LIMITER:{limit:async()=>({success:true})}},{clock:()=>now});
 afterRead(f.db,'SELECT c.account_id AS accountId',()=>{now=at+until;});
 const snapshot=await new WorkspaceService(f.db,()=>now).snapshot(f.other,release.workspaceSpaceAccess);
 assert.deepEqual(snapshot.organizations,[]);assert.equal(snapshot.spaces.some(space=>space.id==='so'),until===200);
 assert.equal(JSON.stringify(snapshot).includes('ExpiresAt'),false);
});

for(const operation of ['admin key','member directory'])test(operation+' query avoids global active-membership materialization',async t=>{
 const f=await fixture();t.after(()=>f.db.close());const prepare=f.db.prepare.bind(f.db);let details=[];
 f.db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...args)=>{if(operation==='admin key'?sql.startsWith('INSERT INTO credentials('):sql.includes('SELECT target.id'))details=f.db.raw.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>row.detail);return bind(...args);};return statement;};
 if(operation==='admin key')await new Admin({DB:f.db},()=>at).issueKey(f.token,{label:'plan',capabilities:['read'],organizationId:'org',expiresInDays:1});
 else await new WorkspaceService(f.db,()=>at).listMembers(f.token,'org');
 assert.ok(details.length);assert.equal(details.some(detail=>/MATERIALIZE active_memberships/.test(detail)),false,details.join('\n'));
});

for(const boundary of ['HMAC','body hash','receipt read'])test('identity webhook rejects timestamp expiry during '+boundary,async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;const secret='test-only-secret'.repeat(4),admin=new Admin({DB:f.db,IDENTITY_WEBHOOK_SECRET:secret},()=>now);
 const raw=JSON.stringify({id:'expired-webhook',issuer:AUTH_ISSUER,subject:'pending-user',type:'account.disabled'}),timestamp=String(at/1000-299),signature=await hmac(secret,timestamp+'.'+raw);
 if(boundary==='HMAC'){const original=crypto.subtle.sign;crypto.subtle.sign=async function(...args){const result=await original.apply(this,args);now=at+2000;return result;};t.after(()=>{crypto.subtle.sign=original;});}
 if(boundary==='body hash')afterDigest(t,()=>{now=at+2000;});
 if(boundary==='receipt read')afterRead(f.db,"SELECT body_hash AS hash FROM release_webhook_events WHERE provider='identity'",()=>{now=at+2000;});
 await assert.rejects(()=>admin.identityWebhook(new Request(PUBLIC_ORIGIN+'/webhooks/identity',{method:'POST',body:raw,headers:{'x-memory-timestamp':timestamp,'x-memory-signature':signature}})),error=>error.status===401);
 assert.equal(f.db.raw.prepare("SELECT count(*) n FROM release_webhook_events WHERE event_id='expired-webhook'").get().n,0);
 assert.equal(f.db.raw.prepare("SELECT count(*) n FROM release_provider_revocations WHERE subject='pending-user'").get().n,0);
});

test('mail checks authority after its budget write before sending',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at,sent=0;
 f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+100);
 const prepare=f.db.prepare.bind(f.db);f.db.prepare=sql=>{const statement=prepare(sql),run=statement.run.bind(statement);statement.run=async()=>{const result=await run();if(sql.startsWith('INSERT INTO release_mail_budget'))now=at+200;return result;};return statement;};
 const admin=new Admin({DB:f.db,MAIL_FROM:'memory@example.com',EMAIL:{send:async()=>{sent++;return{messageId:'synthetic'};}}},()=>now);
 await assert.rejects(()=>admin.mail(f.token,'alice@example.com','proof','private proof','test'),error=>error.status===403);
 assert.equal(sent,0);
});

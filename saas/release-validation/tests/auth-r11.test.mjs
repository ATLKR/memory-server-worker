import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {Admin} from '../../src/release/admin.ts';
import {createRelease} from '../../src/release/extension.ts';
import {IdentityService} from '../../src/identity.ts';
import {createApplication} from '../../src/app.ts';
import {createMemoryApi} from '../../src/api.ts';
import {readSettings,PUBLIC_ORIGIN} from '../../src/config.ts';
const patchSchema='urn:ietf:params:scim:api:messages:2.0:PatchOp';
function after(db,match,callback,method='run'){const prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql),original=s[method].bind(s);s[method]=async()=>{const result=await original();if(match(sql))callback();return result;};return s;};}
function request(path,method='POST',data,token){return new Request(PUBLIC_ORIGIN+path,{method,headers:{...(data===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});}
for(const kind of ['reauth','email_link'])for(const change of ['recipient','proof','expiry'])test('mail rejects obsolete '+kind+' '+change+' after budget reservation',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at,sent=0;
 after(f.db,sql=>sql.includes('INSERT INTO release_mail_budget'),()=>{
  if(change==='expiry')now=at+600001;
  else if(change==='proof')f.db.raw.exec(kind==='reauth'?'UPDATE release_reauth_challenges SET used_at=1':'UPDATE email_challenges SET invalidated_at=1');
  else if(kind==='reauth')f.db.raw.exec("UPDATE account_emails SET revoked_at=1 WHERE id='e1'");
  else f.db.raw.exec("INSERT INTO release_external_email_blocks(account_id,address,created_at) VALUES('alice','new@example.com',1)");
 });
 const env={DB:f.db,MAIL_FROM:'memory@example.com',EMAIL:{send:async()=>{sent++;return {messageId:'test'};}}},release=createRelease(env,{clock:()=>now,identity:new IdentityService(f.db,()=>now)});
 const response=await release.route(request(kind==='reauth'?'/v1/account/reauth':'/v1/account/emails','POST',kind==='reauth'?{emailId:'e1'}:{email:'new@example.com'}),f.token);
 assert.equal(response.status,403);assert.equal(sent,0);
});
for(const permission of [['write'],{toString:'write'},null,1,true])test('PAT rejects non-string permission '+JSON.stringify(permission),async t=>{
 const f=await fixture();t.after(()=>f.db.close());const before=f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n;
 const response=await createRelease({DB:f.db},{clock:()=>at}).route(request('/v1/keys','POST',{label:'test',permission,expiresInDays:1}),f.token);
 assert.equal(response.status,400);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n,before);
});
for(const input of [{Operations:[{op:'replace',path:'active',value:false}]},{schemas:[patchSchema],Operations:[{op:['replace'],path:'active',value:false}]},{schemas:[patchSchema],Operations:[{op:{toString:'replace'},path:'active',value:false}]}])test('SCIM rejects malformed envelope before mutation '+JSON.stringify(input),async t=>{
 const f=await fixture();t.after(()=>f.db.close());const key=await new Admin({DB:f.db},()=>at).issueScimKey(f.token,'org');
 const response=await createRelease({DB:f.db,REQUEST_LIMITER:{limit:async()=>({success:true})}},{clock:()=>at}).publicRoute(request('/scim/v2/org/Users/m2','PATCH',input,key.token));
 assert.equal(response.status,400);assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,null);
});
const routes=[['/','GET'],['/health','GET'],['/assets/app.js','GET'],['/assets/app.css','GET'],['/.well-known/oauth-protected-resource','GET'],['/.well-known/oauth-protected-resource/mcp','GET'],['/auth/login','GET'],['/auth/callback','GET'],['/auth/logout','POST'],['/v1/spaces','GET, POST'],['/v1/workspace','GET'],['/v1/organizations','POST'],['/v1/organizations/org/invites','POST'],['/v1/organizations/org/members','GET'],['/v1/invitations/accept','POST'],['/v1/organizations/org/memberships/m2','DELETE'],['/v1/keys','POST'],['/v1/keys/key:alice','DELETE'],['/mcp','POST']];
const releaseRoutes=[['/manage','GET'],['/assets/release.js','GET'],['/assets/release.css','GET'],['/ready','GET'],['/webhooks/identity','POST'],['/webhooks/stripe','POST'],['/v1/spaces/s1/memories','GET, POST'],['/v1/spaces/s1/memories/m','GET, PATCH, DELETE'],['/v1/spaces/s1/memories/m/restore','POST'],['/v1/spaces/s1/memories/m/erase','POST'],['/v1/spaces/s1/usage','GET'],['/v1/spaces/s1/billing/checkout','POST'],['/v1/spaces/s1/billing/portal','POST'],['/v1/spaces/s1/retention','PUT'],['/v1/spaces/s1/exports','POST'],['/v1/spaces/s1/exports/e','GET'],['/v1/spaces/s1/shares','GET, POST'],['/v1/spaces/s1/shares/share','DELETE'],['/v1/spaces/s1/ingests','GET, POST'],['/v1/spaces/s1/ingests/i','GET, DELETE'],['/v1/spaces/s1/ingests/i/approve','POST'],['/v1/spaces/s1/index/rebuild','POST'],['/v1/spaces/s1/jobs','GET'],['/v1/spaces/s1/jobs/j/retry','POST'],['/v1/release/config','GET'],['/v1/account/reauth','POST'],['/v1/account/reauth/complete','POST'],['/v1/account/emails','GET, POST'],['/v1/account/emails/verify','POST'],['/v1/account/emails/e1','DELETE'],['/v1/organizations/org/domains','POST'],['/v1/domains/verify','POST'],['/v1/domains/d/delegates','POST'],['/v1/domains/d/emails/revoke','POST'],['/v1/organizations/org/scim-keys','POST'],['/v1/organizations/org/scim-keys/key','DELETE'],['/v1/shares','GET'],['/v1/shares/share/accept','POST']];
for(const enabled of [false,true])test('recognized '+(enabled?'release':'foundation')+' routes return 405 with Allow; unknown routes remain 404',async t=>{
 const f=await fixture();t.after(()=>f.db.close());const env={DB:f.db,SSO_CLIENT_ID:'browser',REQUEST_LIMITER:{limit:async()=>({success:true})}},app=createApplication(f.db,readSettings(env),{clock:()=>at,...(enabled?{release:createRelease(env,{clock:()=>at})}:{})});
 for(const [path,allow] of [...routes,...(enabled?releaseRoutes:[['/v1/spaces/s1/memories','GET, POST'],['/v1/spaces/s1/memories/m','GET, PATCH, DELETE']])]){
  const response=await app(request(path,'OPTIONS',undefined,f.token));assert.equal(response.status,405,path);assert.deepEqual(response.headers.get('allow')?.split(/,\s*/).sort(),allow.split(/,\s*/).sort(),path);
 }
 for(const path of ['/unknown','/v1/unknown','/v1/spaces/s1/unknown','/webhooks/unknown','/scim/v2/org/unknown'])assert.equal((await app(request(path,'OPTIONS',undefined,f.token))).status,404,path);
});
test('SCIM method errors include supported methods without mutating resources',async t=>{
 const f=await fixture();t.after(()=>f.db.close());const key=await new Admin({DB:f.db},()=>at).issueScimKey(f.token,'org'),release=createRelease({DB:f.db,REQUEST_LIMITER:{limit:async()=>({success:true})}},{clock:()=>at});
 for(const [path,allow] of [['/scim/v2/org/Users','GET'],['/scim/v2/org/Users/m2','GET, PATCH, DELETE']]){const response=await release.publicRoute(request(path,'POST',{},key.token));assert.equal(response.status,405);assert.equal(response.headers.get('allow'),allow);assert.equal((await response.json()).schemas[0],'urn:ietf:params:scim:api:messages:2.0:Error');}
});
test('isolated memory API method errors include Allow',async t=>{const f=await fixture();t.after(()=>f.db.close());const api=createMemoryApi(f.db,()=>at);for(const [path,allow] of [['/health','GET'],['/v1/spaces','POST'],['/v1/spaces/s1/memories','GET, POST'],['/v1/spaces/s1/memories/m','GET, PATCH, DELETE']]){const response=await api(request(path,'OPTIONS',undefined,f.token));assert.equal(response.status,405);assert.equal(response.headers.get('allow'),allow);}});

for(const [path,data,table] of [['/v1/keys',{label:'null caps',capabilities:null,expiresInDays:1},'credentials'],['/v1/spaces/s1/shares',{email:'bob@example.com',days:null},'release_shares'],['/v1/spaces/s1/memories',{body:'null operation identifier',operationId:null},'memories']])test('explicit null is not an omitted optional input: '+path,async t=>{
 const f=await fixture();t.after(()=>f.db.close());const before=f.db.raw.prepare('SELECT count(*) n FROM '+table).get().n,response=await createRelease({DB:f.db},{clock:()=>at}).route(request(path,'POST',data),f.token);
 assert.equal(response.status,400);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM '+table).get().n,before);
});
for(const kind of ['reauth','email_link'])for(const boundary of ['session','proof','recent'])test('mail compares '+kind+' '+boundary+' expiry after its final query',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at,sent=0;
 after(f.db,sql=>sql.includes('INSERT INTO release_mail_budget'),()=>{if(boundary==='session')f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+100);if(boundary==='recent')f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-299900);});
 after(f.db,sql=>sql.includes('min(c.expires_at,c.membership_expires_at,p.expires_at)'),()=>{now=at+(boundary==='proof'?600001:200);},'first');
 const env={DB:f.db,MAIL_FROM:'memory@example.com',EMAIL:{send:async()=>{sent++;return {messageId:'test'};}}},release=createRelease(env,{clock:()=>now,identity:new IdentityService(f.db,()=>now)});
 const response=await release.route(request(kind==='reauth'?'/v1/account/reauth':'/v1/account/emails','POST',kind==='reauth'?{emailId:'e1'}:{email:'new@example.com'}),f.token);
 const allowed=kind==='reauth'&&boundary==='recent';assert.equal(response.status,allowed?202:403);assert.equal(sent,allowed?1:0);
});
test('email-link destination cannot become claimed while reserving delivery budget',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let sent=0;after(f.db,sql=>sql.includes('INSERT INTO release_mail_budget'),()=>f.db.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,NULL)').run('taken','bob','new@example.com','example.com',at));
 const env={DB:f.db,MAIL_FROM:'memory@example.com',EMAIL:{send:async()=>{sent++;return {messageId:'test'};}}},release=createRelease(env,{clock:()=>at,identity:new IdentityService(f.db,()=>at)});
 const response=await release.route(request('/v1/account/emails','POST',{email:'new@example.com'}),f.token);assert.equal(response.status,403);assert.equal(sent,0);
});
test('domain revocation during the mail budget invalidates the proof without dispatch or cleanup failure',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let sent=0;
 f.db.raw.prepare('INSERT INTO domains VALUES(?,?,?,?,NULL)').run('domain','org','example.com',at+86400000);f.db.raw.exec("INSERT INTO domain_managers VALUES('domain','m1',NULL)");
 after(f.db,sql=>sql.includes('INSERT INTO release_mail_budget'),()=>f.db.raw.prepare("INSERT INTO revocations(id,kind,actor_credential_id,domain_id,address,created_at) VALUES('blocked','domain','session:alice','domain','new@example.com',?)").run(at));
 const env={DB:f.db,MAIL_FROM:'memory@example.com',EMAIL:{send:async()=>{sent++;return {messageId:'test'};}}},release=createRelease(env,{clock:()=>at,identity:new IdentityService(f.db,()=>at)});
 const response=await release.route(request('/v1/account/emails','POST',{email:'new@example.com'}),f.token);assert.equal(response.status,403);assert.equal(sent,0);assert.equal(f.db.raw.prepare('SELECT invalidated_at FROM email_challenges').get().invalidated_at,at);
});
for(const name of [['_memory-verification.example.com.'],{toString:'_memory-verification.example.com.'}])test('DNS proof answer requires a string owner name '+JSON.stringify(name),async t=>{
 const f=await fixture();t.after(()=>f.db.close());let proof;const admin=new Admin({DB:f.db,fetch:async()=>Response.json({Status:0,Answer:[{name,type:16,data:JSON.stringify(proof)}]})},()=>at),challenge=await admin.beginDomain(f.token,'org','example.com');proof=challenge.value;
 await assert.rejects(()=>admin.verifyDomain(f.token,challenge.id),e=>e.status===409&&e.code==='dns_proof_missing');assert.equal(f.db.raw.prepare('SELECT count(*) n FROM domains').get().n,0);
});

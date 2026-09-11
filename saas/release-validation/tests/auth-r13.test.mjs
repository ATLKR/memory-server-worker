import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {Admin} from '../../src/release/admin.ts';
import {createRelease} from '../../src/release/extension.ts';
import {createApplication} from '../../src/app.ts';
import {IdentityService,canonicalEmail} from '../../src/identity.ts';
import {readSettings,PUBLIC_ORIGIN} from '../../src/config.ts';
import {hmac} from '../../src/release/util.ts';
const schema='urn:ietf:params:scim:api:messages:2.0:PatchOp';
async function setup(t){const f=await fixture();t.after(()=>f.db.close());let sent=0;const env={DB:f.db,SSO_CLIENT_ID:'browser',REQUEST_LIMITER:{limit:async()=>({success:true})},MAIL_FROM:'memory@example.com',EMAIL:{send:async()=>{sent++;return {messageId:'test'};}}},identity=new IdentityService(f.db,()=>at),release=createRelease(env,{clock:()=>at,identity}),app=createApplication(f.db,readSettings(env),{clock:()=>at,release});
 const request=(path,data,token=f.token,method='POST')=>app(new Request(PUBLIC_ORIGIN+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:typeof data==='string'?data:JSON.stringify(data)}));return {...f,app,request,sent:()=>sent,identity};}
for(const [schemas,operations,op,path,value] of [['schemas','operations','op','path','value'],['Schemas','Operations','Op','Path','Value'],['SCHEMAS','OPERATIONS','OP','PATH','VALUE'],['sChEmAs','oPeRaTiOnS','oP','pAtH','vAlUe']])for(const mode of ['qualified','pathless'])test('SCIM accepts case-equivalent '+operations+'/'+op+' '+mode,async t=>{
 const f=await setup(t),key=await new Admin({DB:f.db},()=>at).issueScimKey(f.token,'org'),data={[schemas]:[schema],[operations]:[{[op]:'RePlAcE',...(mode==='qualified'?{[path]:'urn:ietf:params:scim:schemas:core:2.0:User:ACTIVE',[value]:false}:{[value]:{AcTiVe:false}})}]};
 const response=await f.request('/scim/v2/org/Users/m2?attributes=id,active',data,key.token,'PATCH');assert.equal(response.status,200);assert.deepEqual(await response.json(),{schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],id:'m2',active:false});assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,at);
});
for(const data of [
 {schemas:[schema],Schemas:[schema],Operations:[{op:'replace',path:'active',value:false}]},
 {schemas:[schema],Operations:[{op:'replace',Op:'replace',path:'active',value:false}]},
 {schemas:[schema],Operations:[{op:'replace',Path:'active',path:'userName',value:false}]},
 {schemas:[schema],Operations:[{op:'replace',path:'active',value:false,Value:true}]},
 {schemas:[schema],Operations:[{op:'replace',value:{active:false,Active:false}}]},
 {SCHEMAS:[schema],OPERATIONS:[{OP:'replace',PATH:'active',VALUE:false,OTHER:true}]},
 {SCHEMAS:[schema],OPERATIONS:[{OP:'replace',VALUE:{ACTIVE:false,USERNAME:'changed'}}]},
 {SCHEMAS:[schema],OPERATIONS:[{OP:'replace',PATH:'active',VALUE:false}],OTHER:true},
 '{"schemas":["'+schema+'"],"Operations":[{"op":"remove","op":"replace","path":"active","value":false}]}',
 '{"schemas":["'+schema+'"],"Operations":[{"op":"remove","\\u006fp":"replace","path":"active","value":false}]}',
])test('SCIM rejects duplicate or unsupported attributes before mutation '+JSON.stringify(data),async t=>{
 const f=await setup(t),key=await new Admin({DB:f.db},()=>at).issueScimKey(f.token,'org'),response=await f.request('/scim/v2/org/Users/m2',data,key.token,'PATCH');assert.equal(response.status,400);assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,null);
});
for(const email of ['not-an-email','.start@example.com','two..dots@example.com','local@-example.com','local@example..com','é@example.com','x'.repeat(65)+'@example.com'])for(const path of ['/v1/organizations/org/invites','/v1/account/emails','/v1/domains/domain/emails/revoke','/v1/spaces/s1/shares'])test('malformed email gives400 '+path+' '+email,async t=>{
 const f=await setup(t),response=await f.request(path,{email,...(path.endsWith('/invites')?{role:'member'}:{})});assert.equal(response.status,400);assert.equal(f.sent(),0);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM email_challenges').get().n,0);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM workspace_invitations').get().n,0);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM revocations').get().n,0);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,0);
});
test('valid address normalization keeps plus/dot distinctions and authority/proof failures remain403',async t=>{
 const f=await setup(t);assert.deepEqual(canonicalEmail(' Alice.Tag+keep@EXAMPLE.COM '),{address:'alice.tag+keep@example.com',domain:'example.com'});
 const invite=await f.request('/v1/organizations/org/invites',{email:' New.Tag+keep@EXAMPLE.COM ',role:'member'});assert.equal(invite.status,201);assert.equal(f.db.raw.prepare('SELECT address FROM workspace_invitations').get().address,'new.tag+keep@example.com');
 assert.equal((await f.request('/v1/organizations/org/invites',{email:'valid@example.com',role:'member'},f.other)).status,403);
 f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-300001);assert.equal((await f.request('/v1/account/emails',{email:'valid@example.com'})).status,403);assert.equal(f.sent(),0);
});
test('SCIM accepts escaped case-equivalent attribute names without changing their values',async t=>{
 const f=await setup(t),key=await new Admin({DB:f.db},()=>at).issueScimKey(f.token,'org'),data='{"\\u0053chemas":["'+schema+'"],"operations":[{"\\u004fp":"replace","Path":"active","Value":false}]}';
 assert.equal((await f.request('/scim/v2/org/Users/m2',data,key.token,'PATCH')).status,204);assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,at);
});
test('case-equivalent SCIM requests still enforce owner protection',async t=>{
 const f=await setup(t),key=await new Admin({DB:f.db},()=>at).issueScimKey(f.token,'org');assert.equal((await f.request('/scim/v2/org/Users/m1',{SCHEMAS:[schema],OPERATIONS:[{OP:'replace',VALUE:{ACTIVE:false}}]},key.token,'PATCH')).status,403);assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m1'").get().revoked_at,null);
});
test('share-route email validation preserves normalization and current authority/proof checks',async t=>{
 const f=await setup(t);const response=await f.request('/v1/spaces/s1/shares',{email:' BOB@EXAMPLE.COM '});assert.equal(response.status,201);assert.equal(f.db.raw.prepare('SELECT recipient_email_id FROM release_shares').get().recipient_email_id,'e2');
 assert.equal((await f.request('/v1/spaces/s1/shares',{email:'valid-but-unverified@example.com'})).status,403);
 assert.equal((await f.request('/v1/spaces/s1/shares',{email:'bob@example.com'},f.key)).status,403);
 f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-300001);assert.equal((await f.request('/v1/spaces/s1/shares',{email:'bob@example.com'})).status,403);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,1);
});
for(const email of ['.start@example.com','local@example..com','x'.repeat(65)+'@example.com'])test('signed email-revocation payload uses the same mailbox validation: '+email,async t=>{
 const f=await setup(t),secret='s'.repeat(64),admin=new Admin({DB:f.db,IDENTITY_WEBHOOK_SECRET:secret},()=>at),raw=JSON.stringify({id:'malformed',issuer:'https://auth-api.allen.company',subject:'alice',type:'email.revoked',email}),timestamp=String(at/1000);
 await assert.rejects(async()=>admin.identityWebhook(new Request(PUBLIC_ORIGIN+'/webhooks/identity',{method:'POST',body:raw,headers:{'x-memory-timestamp':timestamp,'x-memory-signature':await hmac(secret,timestamp+'.'+raw)}})),e=>e.status===400&&e.code==='invalid_email');assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_webhook_events').get().n,0);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_provider_revocations').get().n,0);
});

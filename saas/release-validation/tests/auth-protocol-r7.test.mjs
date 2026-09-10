import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { WorkspaceService } from '../../src/workspace.ts';
import { Admin } from '../../src/release/admin.ts';
import { Billing } from '../../src/release/billing.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { createRelease } from '../../src/release/extension.ts';

async function setup(t){
 const f=await fixture();t.after(()=>f.db.close());let now=at;
 const clock=()=>now,advance=value=>{now=value;},env={DB:f.db,REQUEST_LIMITER:{limit:async()=>({success:true})}};
 const admin=new Admin(env,clock),workspace=new WorkspaceService(f.db,clock),store=new MemoryStore(f.db,clock);
 const afterDigest=callback=>{const original=crypto.subtle.digest;crypto.subtle.digest=async function(algorithm,data){const result=await original.call(this,algorithm,data);callback(new TextDecoder().decode(data));return result;};t.after(()=>{crypto.subtle.digest=original;});};
 return {...f,clock,advance,afterDigest,env,admin,workspace,store};
}
const denied=operation=>assert.rejects(operation,error=>[401,403].includes(error.status));
async function scim(f){const key=await f.admin.issueScimKey(f.token,'org'),release=createRelease(f.env,{clock:f.clock});return (path='',init={})=>release.publicRoute(new Request('https://memory.allenlabs.org/scim/v2/org/Users'+path,{...init,headers:{authorization:'Bearer '+key.token,...init.headers}}));}
const patch=path=>({method:'PATCH',headers:{'content-type':'application/scim+json'},body:JSON.stringify({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path,value:false}]})});

for(const operation of ['invitation','foundation key'])test(operation+' proof hashing cannot cross the creator session expiry',async t=>{
 const f=await setup(t);f.afterDigest(value=>{if(value!==f.token)f.advance(at+900001);});
 if(operation==='invitation'){
  await denied(()=>f.workspace.createInvite(f.token,'org',{email:'recipient@example.com',role:'admin'}));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM workspace_invitations').get().n,0);
 }else{
  await denied(()=>f.workspace.issueKey(f.token,{label:'expired',permission:'write',organizationId:'org',expiresInDays:1}));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM workspace_key_issuances').get().n,0);
 }
});

test('memory read samples time after its asynchronous token hash',async t=>{
 const f=await setup(t),memory=await f.store.create(f.token,'s1',{body:'protected'},'seed');let hashes=0;
 // The final disclosure snapshot reuses this hash instead of hashing again.
 f.afterDigest(value=>{if(value===f.token&&++hashes===1)f.advance(at+900001);});
 await denied(()=>f.store.get(f.token,'s1',memory.id));
 assert.ok(hashes>=1,'The asynchronous credential hash boundary must be exercised');
});

for(const expiry of ['credential','recent proof'])test('final interactive authority samples '+expiry+' time after its asynchronous hash',async t=>{
 const f=await setup(t);let hashes=0;
 f.afterDigest(value=>{if(value===f.token&&++hashes===3)f.advance(at+(expiry==='credential'?900001:300001));});
 await denied(()=>f.admin.issueKey(f.token,{label:'valid-at-creation',capabilities:['read'],expiresInDays:1}));
});

test('SCIM accepts qualified active paths and returns requested PATCH attributes',async t=>{
 const f=await setup(t),request=await scim(f);
 const response=await request('/m2?attributes=id,active',patch('urn:ietf:params:scim:schemas:core:2.0:User:active'));
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],id:'m2',active:false});
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,at);
});

test('SCIM PATCH responds with selected attributes for the unqualified path',async t=>{
 const f=await setup(t),request=await scim(f),response=await request('/m2?attributes=id,active',patch('active'));
 assert.equal(response.status,200);assert.equal((await response.json()).active,false);
});

test('SCIM PATCH validates projections before mutation and supports response exclusions',async t=>{
 const f=await setup(t),request=await scim(f);
 assert.equal((await request('/m2?attributes=id&excludedAttributes=active',patch('active'))).status,400);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,null);
 const response=await request('/m2?excludedAttributes=userName',patch('URN:IETF:PARAMS:SCIM:SCHEMAS:CORE:2.0:USER:ACTIVE'));
 assert.equal(response.status,200);assert.deepEqual(Object.keys(await response.json()).sort(),['active','id','schemas']);
 const repeated=await request('/m2?attributes=active',patch('active'));assert.equal(repeated.status,200);assert.equal((await repeated.json()).active,false);
});

test('qualified SCIM deactivation keeps exact schema and final-owner restrictions',async t=>{
 const f=await setup(t),request=await scim(f);
 assert.equal((await request('/m2',patch('urn:example:User:active'))).status,400);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,null);
 assert.equal((await request('/m1',patch('urn:ietf:params:scim:schemas:core:2.0:User:active'))).status,403);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m1'").get().revoked_at,null);
});

test('SCIM PATCH can return its authorized self-deactivation result after its key is revoked',async t=>{
 const f=await setup(t);f.db.raw.exec("UPDATE memberships SET role='owner' WHERE id='m2'");const request=await scim(f);
 const response=await request('/m1?attributes=id,active',patch('active'));
 assert.equal(response.status,200);assert.equal((await response.json()).active,false);
 assert.equal((await request('/m2')).status,401);
});

test('SCIM rejoin exposes one new resource and never revives the removed resource or PAT',async t=>{
 const f=await setup(t),request=await scim(f),memory=await f.store.create(f.token,'so',{body:'organization secret'},'seed');
 const oldKey=await f.admin.issueKey(f.other,{label:'old member',organizationId:'org',capabilities:['read'],expiresInDays:1});
 await f.workspace.revokeMembership(f.token,'org','m2');
 const invitation=await f.workspace.createInvite(f.token,'org',{email:'bob@example.com',role:'member'});
 await f.workspace.acceptInvite(f.other,invitation.token);
 const latest=f.db.raw.prepare("SELECT id FROM memberships WHERE account_id='bob' AND revoked_at IS NULL").get().id;
 const response=await request(),listed=await response.json();
 assert.equal(listed.totalResults,2);assert.equal(listed.Resources.filter(value=>value.userName==='bob@example.com').length,1);
 assert.equal(listed.Resources.find(value=>value.userName==='bob@example.com').id,latest);
 await denied(()=>f.store.get(oldKey.token,'so',memory.id));
 assert.equal((await request('/m2')).status,404);assert.equal((await request('/m2',patch('active'))).status,404);
 await f.workspace.revokeMembership(f.token,'org',latest);
 const inactive=(await(await request()).json()).Resources.filter(value=>value.userName==='bob@example.com');
 assert.equal(inactive.length,1);assert.equal(inactive[0].id,latest);assert.equal(inactive[0].active,false);
 assert.equal((await request('/'+latest,{method:'DELETE'})).status,204);
 assert.equal((await request('/m2')).status,404);
 assert.equal((await(await request()).json()).Resources.some(value=>value.userName==='bob@example.com'),false);
 assert.equal(f.db.raw.prepare("SELECT count(*) n FROM memberships WHERE account_id='bob'").get().n,2);
});

test('DNS proof accepts case-equivalent answer names',async t=>{
 const f=await setup(t),challenge=await f.admin.beginDomain(f.token,'org','example.net');
 f.admin.fetcher=async()=>Response.json({Status:0,Answer:[{name:challenge.name.toUpperCase()+'.',type:16,data:JSON.stringify(challenge.value)}]});
 assert.equal((await f.admin.verifyDomain(f.token,challenge.id)).name,'example.net');
});

test('lost Checkout replay persists provider evidence but does not return an expired URL',async t=>{
 const f=await setup(t);let calls=0,originalBody,originalKey;
 const billing=new Billing({...f.env,BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async(url,init)=>{
  if(String(url).endsWith('/customers'))return Response.json({id:'cus_test'});
  if(++calls===1){originalBody=init.body;originalKey=init.headers['idempotency-key'];throw new Error('lost response');}
  assert.equal(init.body,originalBody);assert.equal(init.headers['idempotency-key'],originalKey);
  f.advance(at+2101000);return Response.json({id:'cs_lost',url:'https://checkout.stripe.com/c/pay/lost'});
 }},f.clock);
 await assert.rejects(()=>billing.checkout(f.token,'s1','price_test','lost'));
 f.advance(at+2099000);f.db.raw.prepare("UPDATE credentials SET expires_at=?,reauthenticated_at=? WHERE id='session:alice'").run(at+3000000,at+2099000);
 await assert.rejects(()=>billing.checkout(f.token,'s1','price_test','lost'),error=>error.code==='checkout_expired');
 const row=f.db.raw.prepare('SELECT session_id,checkout_attempted,expires_at FROM release_checkout_requests').get();
 assert.equal(row.session_id,'cs_lost');assert.equal(row.checkout_attempted,1);assert.equal(row.expires_at,at+2100000);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {createFixture,NOW,tokens} from '../../test/helpers.mjs';
import {MemoryService,MemoryDenied} from '../../src/memory.ts';
import {Billing} from '../../src/release/billing.ts';
import {Admin} from '../../src/release/admin.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {hmac} from '../../src/release/util.ts';
import {IdentityService} from '../../src/identity.ts';
import {createRelease} from '../../src/release/extension.ts';

function afterQuery(db,match,callback,method='first'){const prepare=db.prepare.bind(db);db.prepare=sql=>{const statement=prepare(sql),read=statement[method].bind(statement);statement[method]=async()=>{const result=await read();if(match(sql))callback();return result;};return statement;};}
function billingEnv(db,fetch){return {DB:db,BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch};}

for(const boundary of ['credential','membership'])for(const operation of ['get','create readback','update readback','Space readback','Spaces','list','search'])test('foundation '+operation+' checks final '+boundary+' expiry',async t=>{
 const f=await createFixture({memory:true});t.after(()=>f.close());let now=NOW;const service=new MemoryService(f.db,()=>now),space=await service.createSpace(tokens.alice,{name:'Team',organizationId:'org-one'}),personal=await service.createSpace(tokens.alice,{name:'Personal'}),memory=await service.create(tokens.alice,space.id,{body:'Foundation private content'});
 if(boundary==='credential')f.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='s-alice'").run(NOW+100);else f.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m-work'").run(NOW+100);
 afterQuery(f.db,sql=>sql.includes('SELECT ')&&sql.includes('active_credentials'),()=>{now=NOW+200;},['Spaces','list','search'].includes(operation)?'all':'first');
 const invoke=()=>operation==='get'?service.get(tokens.alice,space.id,memory.id):operation==='create readback'?service.create(tokens.alice,space.id,{body:'new'}):operation==='update readback'?service.update(tokens.alice,space.id,memory.id,{body:'updated',expectedRevision:1}):operation==='Space readback'?service.createSpace(tokens.alice,{name:'New',organizationId:'org-one'}):operation==='Spaces'?service.listSpaces(tokens.alice):operation==='list'?service.list(tokens.alice,space.id):service.search(tokens.alice,space.id,{query:'private'});
 if(operation==='Spaces'&&boundary==='membership')assert.deepEqual(await invoke(),[personal]);else await assert.rejects(invoke,MemoryDenied);
});
for(const boundary of ['credential','membership'])test('billing usage checks final '+boundary+' expiry',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;
 f.db.raw.prepare(boundary==='credential'?"UPDATE credentials SET expires_at=? WHERE id='session:alice'":"UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+100);
 afterQuery(f.db,sql=>sql.includes('AS usedUnits'),()=>{now=at+200;});
 await assert.rejects(()=>new Billing({DB:f.db},()=>now).usage(f.token,boundary==='credential'?'s1':'so'),error=>error.status===403);
});
for(const boundary of ['session revocation','membership revocation','recent proof'])test('portal rechecks '+boundary+' after customer lookup before provider',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at,calls=0;
 f.db.raw.prepare("UPDATE release_pools SET customer_id='cus_test' WHERE id='org:org'").run();
 if(boundary==='recent proof')f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-299900);
 afterQuery(f.db,sql=>sql.includes('SELECT p.customer_id AS customerId'),()=>{if(boundary==='session revocation')f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at);else if(boundary==='membership revocation')f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m1'").run(at);else now=at+200;});
 const billing=new Billing(billingEnv(f.db,async()=>{calls++;return Response.json({url:'https://billing.stripe.com/p/session/test'});}),()=>now);
 await assert.rejects(()=>billing.portal(f.token,'so'),error=>error.status===403);assert.equal(calls,0);
});
for(const operation of ['checkout','customer','portal'])test(operation+' checks recent proof after final Space authority read before provider',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at,calls=0,armed=false;
 if(operation!=='customer')f.db.raw.prepare("UPDATE release_pools SET customer_id='cus_test' WHERE id='account:alice'").run();
 f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-299900);
 afterQuery(f.db,sql=>operation==='checkout'?sql.includes('checkout_attempted AS checkoutAttempted'):operation==='portal'?sql.includes('SELECT p.customer_id AS customerId'):sql.includes('FROM release_checkout_requests WHERE pool_id=?'),()=>{armed=true;});
 afterQuery(f.db,sql=>sql.includes('AS grantExpiresAt'),()=>{if(armed)now=at+200;});
 const billing=new Billing(billingEnv(f.db,async url=>{calls++;return Response.json(String(url).endsWith('/customers')?{id:'cus_test'}:String(url).endsWith('/billing_portal/sessions')?{url:'https://billing.stripe.com/p/session/test'}:{id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});}),()=>now);
 await assert.rejects(()=>operation==='portal'?billing.portal(f.token,'s1'):billing.checkout(f.token,'s1','price_test','proof'),error=>error.status===403);assert.equal(calls,0);
});
for(const location of ['member data','final caller read'])for(const detail of [false,true])test('SCIM active recalculates target expiry at '+location+'; detail='+detail,async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;const admin=new Admin({DB:f.db},()=>now),key=await admin.issueScimKey(f.token,'org');
 f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at+100);let dataRead=false;
 afterQuery(f.db,sql=>sql.includes('SELECT m.id,e.address AS userName'),()=>{dataRead=true;if(location==='member data')now=at+200;},'all');
 afterQuery(f.db,sql=>sql.includes('SELECT k.id'),()=>{if(dataRead&&location==='final caller read')now=at+200;});
 const response=await admin.scim(new Request('https://memory.allenlabs.org/scim/v2/org/Users'+(detail?'/m2':'')+'?attributes=id,active',{headers:{authorization:'Bearer '+key.token}}),'org',detail?'m2':undefined),body=await response.json();
 const member=detail?body:body.Resources.find(item=>item.id==='m2');assert.deepEqual(member,{schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],id:'m2',active:false});
});

for(const elapsed of [200,600])test('billing usage preserves independent shares only while their grantor authority remains live: '+elapsed,async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;const transfers=new Transfers(f.db,()=>now),share=await transfers.share(f.token,'so','bob@example.com',1);await transfers.accept(f.other,share.id);
 f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at+100);f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+500);
 afterQuery(f.db,sql=>sql.includes('AS usedUnits'),()=>{now=at+elapsed;});const billing=new Billing({DB:f.db},()=>now);
 if(elapsed===600)await assert.rejects(()=>billing.usage(f.other,'so'),error=>error.status===403);else {const value=await billing.usage(f.other,'so');assert.equal(value.id,'org:org');assert.equal(JSON.stringify(value).includes('ExpiresAt'),false);}
});
for(const boundary of ['HMAC','body hash','receipt read'])test('billing webhook rejects timestamp expiry during '+boundary,async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at;const secret='w'.repeat(64),billing=new Billing({DB:f.db,STRIPE_WEBHOOK_SECRET:secret},()=>now),timestamp=String(at/1000-299),raw=JSON.stringify({id:'evt_expired',type:'customer.subscription.updated',data:{object:{id:'sub_test'}}}),signature=await hmac(secret,timestamp+'.'+raw);
 if(boundary==='HMAC'){const original=crypto.subtle.sign;crypto.subtle.sign=async function(...args){const result=await original.apply(this,args);now=at+2000;return result;};t.after(()=>{crypto.subtle.sign=original;});}
 if(boundary==='body hash'){const original=crypto.subtle.digest;crypto.subtle.digest=async function(...args){const result=await original.apply(this,args);now=at+2000;return result;};t.after(()=>{crypto.subtle.digest=original;});}
 if(boundary==='receipt read')afterQuery(f.db,sql=>sql.includes("WHERE provider='stripe'"),()=>{now=at+2000;});
 await assert.rejects(()=>billing.webhook(new Request('https://memory.allenlabs.org/webhooks/stripe',{method:'POST',body:raw,headers:{'stripe-signature':'t='+timestamp+',v1='+signature}})),error=>error.status===401);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_billing_events').get().n,0);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_webhook_events').get().n,0);
});
for(const boundary of ['lease claim','job read'])test('billing reconciliation stops before provider when lease expires during '+boundary,async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at,calls=0;f.db.raw.prepare('INSERT INTO release_billing_events(id,subscription_id,available_at,created_at) VALUES(?,?,?,?)').run('evt_pending','sub_test',at,at);
 afterQuery(f.db,sql=>boundary==='lease claim'?sql.includes('UPDATE release_billing_lock SET token='):sql.includes('AS subscriptionId')&&sql.includes('release_billing_events'),()=>{now=at+120001;});
 await new Billing(billingEnv(f.db,async()=>{calls++;return Response.json({id:'sub_test'});}),()=>now).drain(1);assert.equal(calls,0);assert.equal(f.db.raw.prepare("SELECT attempt FROM release_billing_events WHERE id='evt_pending'").get().attempt,0);
});
for(const boundary of ['session','recent proof'])for(const location of ['challenge write','final snapshot'])test('foundation email delivery rechecks '+boundary+' at '+location,async t=>{
 const f=await createFixture();t.after(()=>f.close());let now=NOW,sent=0;if(boundary==='session')f.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='s-alice'").run(NOW+100);else f.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='s-alice'").run(NOW-299900);
 afterQuery(f.db,sql=>location==='challenge write'?sql.includes('INSERT INTO email_challenges'):sql.includes('FROM email_challenges p JOIN active_credentials c'),()=>{now=NOW+200;},location==='challenge write'?'run':'first');
 await assert.rejects(()=>new IdentityService(f.db,()=>now).beginEmailLink(tokens.alice,'fresh@example.com',async()=>{sent++;}));assert.equal(sent,0);
 assert.ok(f.raw.prepare('SELECT invalidated_at FROM email_challenges').get().invalidated_at);
});
for(const boundary of ['session','membership','recent proof','challenge'])test('domain DNS lookup waits for current '+boundary+' authority',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at,calls=0;const admin=new Admin({DB:f.db,fetch:async()=>{calls++;return Response.json({Status:0,Answer:[]});}},()=>now),challenge=await admin.beginDomain(f.token,'org','example.com');
 if(boundary==='session')f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+100);
 if(boundary==='membership')f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+100);
 if(boundary==='recent proof')f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-299900);
 if(boundary==='challenge')f.db.raw.prepare('UPDATE release_domain_challenges SET expires_at=? WHERE id=?').run(at+100,challenge.id);
 afterQuery(f.db,sql=>sql.includes('SELECT organization_id AS organizationId,domain,proof'),()=>{now=at+200;});
 await assert.rejects(()=>admin.verifyDomain(f.token,challenge.id));assert.equal(calls,0);
});

test('email-link delivery keeps its recent-proof requirement through the mail budget await',async t=>{
 const f=await fixture();t.after(()=>f.db.close());let now=at,sent=0;f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-299900);
 afterQuery(f.db,sql=>sql.includes('INSERT INTO release_mail_budget'),()=>{now=at+200;},'run');
 const env={DB:f.db,MAIL_FROM:'memory@example.com',EMAIL:{send:async()=>{sent++;return {messageId:'synthetic'};}}};
 const release=createRelease(env,{clock:()=>now,identity:new IdentityService(f.db,()=>now)});
 const response=await release.route(new Request('https://memory.allenlabs.org/v1/account/emails',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com'})}),f.token);
 assert.equal(response.status,403);assert.equal(sent,0);assert.ok(f.db.raw.prepare('SELECT invalidated_at FROM email_challenges').get().invalidated_at);
});

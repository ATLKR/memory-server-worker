import test from 'node:test';import assert from 'node:assert/strict';import {fixture,at} from './db.mjs';import {hmac} from '../../src/release/util.ts';
import {createRelease} from '../../src/release/extension.ts';
import {readSettings} from '../../src/config.ts';
let Billing;try{({Billing}=await import('../../src/release/billing.ts'));}catch{}
for(const phase of ['cached','provider'])for(const change of ['membership','recent proof'])test('checkout rechecks '+change+' before returning a '+phase+' URL',async t=>{
 const {db,token}=await fixture();t.after(()=>db.close());let now=at,armed=false;
 const invalidate=()=>{if(change==='membership')db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(now,'m1');else now+=300001;};
 const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async(url)=>{
  if(String(url).endsWith('/customers'))return Response.json({id:'cus_test'});
  if(armed&&phase==='provider')invalidate();
  return Response.json({id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});
 }};
 const billing=new Billing(env,()=>now);
 if(phase==='cached'){
  await billing.checkout(token,'so','price_test','revalidate');
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('FROM release_checkout_requests WHERE pool_id=?')){const first=statement.first.bind(statement);statement.first=async()=>{const result=await first();invalidate();return result;};}return statement;};
 }
 armed=true;
 await assert.rejects(()=>billing.checkout(token,'so','price_test','revalidate'),e=>e.status===403);
});
test('billing portal requires recent proof after awaiting the provider',async t=>{
 const {db,token}=await fixture();t.after(()=>db.close());let now=at;
 db.raw.prepare("UPDATE release_pools SET customer_id='cus_test' WHERE id='account:alice'").run();
 const billing=new Billing({DB:db,BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async()=>{now+=300001;return Response.json({url:'https://billing.stripe.com/p/session/test'});}},()=>now);
 await assert.rejects(()=>billing.portal(token,'s1'),e=>e.status===403&&e.code==='recent_reauthentication_required');
});
for(const origin of [undefined,'https://custom-memory.example.com'])test('billing redirects use the configured origin including its default: '+origin,async t=>{
 const {db,token}=await fixture();t.after(()=>db.close());const forms=[];
 const env={DB:db,PUBLIC_ORIGIN:origin,BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async(url,init)=>{
  if(String(url).endsWith('/customers'))return Response.json({id:'cus_test'});
  forms.push(new URLSearchParams(init.body));
  return Response.json(String(url).endsWith('/billing_portal/sessions')?{url:'https://billing.stripe.com/p/session/test'}:{id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});
 }};
 const billing=new Billing(env,()=>at);await billing.checkout(token,'s1','price_test','redirect-origin');await billing.portal(token,'s1');
 const expected=readSettings(env).origin;
 assert.equal(forms[0].get('success_url'),expected+'/manage?billing=success');
 assert.equal(forms[0].get('cancel_url'),expected+'/manage?billing=cancel');
 assert.equal(forms[1].get('return_url'),expected+'/manage');
});
for(const [name,changes] of [
 ['missing API key',{STRIPE_SECRET_KEY:undefined}],
 ['blank API key',{STRIPE_SECRET_KEY:' '}],
 ['missing webhook key',{STRIPE_WEBHOOK_SECRET:undefined}],
 ['unusable webhook key',{STRIPE_WEBHOOK_SECRET:'too_short'}],
 ['missing API version',{STRIPE_API_VERSION:undefined}],
 ['blank API version',{STRIPE_API_VERSION:' '}],
 ['missing prices',{BILLING_PRICES_JSON:undefined}],
 ['empty prices',{BILLING_PRICES_JSON:'{}'}],
 ['malformed prices',{BILLING_PRICES_JSON:'{'}],
 ['invalid price plan',{BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:0,storageBytes:1000}})}],
 ['paused processing',{BACKGROUND_JOBS_ENABLED:'false'}],
 ['explicit paid billing disabled',{PAID_BILLING_ENABLED:'false'}],
 ['metered GA profile',{GA_PROFILE:'managed-ai-metered',PAID_BILLING_ENABLED:'false'}],
 ['complete configuration',{}]
])test('billing config and API availability agree while GA readiness treats paid billing separately: '+name,async t=>{
 const {db,token}=await fixture();t.after(()=>db.close());const calls=[];
 const env={DB:db,PUBLIC_ORIGIN:'https://memory.allenlabs.org',BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),REQUEST_LIMITER:{limit:async()=>({success:true})},fetch:async(url)=>{calls.push(String(url));return Response.json(String(url).endsWith('/customers')?{id:'cus_test'}:String(url).endsWith('/billing_portal/sessions')?{url:'https://billing.stripe.com/p/session/test'}:{id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});},...changes};
 const release=createRelease(env,{clock:()=>at}),billing=new Billing(env,()=>at),enabled=name==='complete configuration';
 const config=await release.route(new Request(env.PUBLIC_ORIGIN+'/v1/release/config'),token);
 assert.equal(config.status,200);assert.equal((await config.json()).features.billing,enabled);
 assert.equal(billing.configuration().available,enabled);
 const readiness=await release.publicRoute(new Request(env.PUBLIC_ORIGIN+'/ready'));
 const readinessResult=await readiness.json();
 assert.equal(readinessResult.checks.paidBillingDisabled,env.PAID_BILLING_ENABLED==='false');
 assert.equal(Object.hasOwn(readinessResult.checks,'billing'),false);
 assert.equal(readinessResult.ready,false);
 if(enabled){
  assert.equal((await billing.checkout(token,'s1','price_test','availability')).url,'https://checkout.stripe.com/c/pay/test');
  assert.equal((await billing.portal(token,'s1')).url,'https://billing.stripe.com/p/session/test');
  assert.equal(calls.length,3);
 }else{
  await assert.rejects(()=>billing.checkout(token,'s1','price_test','availability'),e=>e.status===503);
  assert.equal(db.raw.prepare('SELECT count(*) AS n FROM release_checkout_requests').get().n,0);
  assert.equal(db.raw.prepare("SELECT customer_id FROM release_pools WHERE id='account:alice'").get().customer_id,null);
  db.raw.prepare("UPDATE release_pools SET customer_id='cus_test' WHERE id='account:alice'").run();
  await assert.rejects(()=>billing.portal(token,'s1'),e=>e.status===503);
  assert.deepEqual(calls,[]);
 }
});
for(const enabled of [undefined,'false'])test('billing checkout and portal reject disabled processing before provider calls: '+enabled,async t=>{
 const {db,token}=await fixture();t.after(()=>db.close());let calls=0;
 const env={DB:db,PUBLIC_ORIGIN:'https://memory.allenlabs.org',BACKGROUND_JOBS_ENABLED:enabled,STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async(url)=>{calls++;return Response.json(String(url).endsWith('/customers')?{id:'cus_test'}:{id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});}};
 const billing=new Billing(env,()=>at);
 await assert.rejects(()=>billing.checkout(token,'s1','price_test','disabled-checkout'),e=>e.status===503&&e.code==='billing_processing_disabled');
 db.raw.prepare('UPDATE release_pools SET customer_id=? WHERE id=?').run('cus_test','account:alice');
 await assert.rejects(()=>billing.portal(token,'s1'),e=>e.status===503&&e.code==='billing_processing_disabled');
 assert.equal(calls,0);
 assert.equal(db.raw.prepare('SELECT count(*) AS n FROM release_checkout_requests').get().n,0);
 const raw=JSON.stringify({id:'evt_while_paused',type:'customer.subscription.updated',data:{object:{id:'sub_test'}}}),timestamp=String(at/1000);
 const request=()=>new Request(env.PUBLIC_ORIGIN+'/webhooks/stripe',{method:'POST',body:raw,headers:{'stripe-signature':'t='+timestamp+',v1='+signature}});
 const signature=await hmac(env.STRIPE_WEBHOOK_SECRET,timestamp+'.'+raw);
 assert.equal((await billing.webhook(request())).status,200);
 assert.equal((await billing.webhook(request())).status,200);
 assert.equal(db.raw.prepare("SELECT count(*) AS n FROM release_billing_events WHERE state='pending'").get().n,1);
});
for(const name of ['checkout-idempotent','bad-plan','bad-webhook','current-subscription','cancelled-subscription','duplicate-event','lease-fencing'])test('billing '+name,async()=>{
 assert.ok(Billing,'billing implementation missing');const {db,token}=await fixture();let calls=0,status='active';let requestId='';const secret='w'.repeat(64);
 const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',PUBLIC_ORIGIN:'https://memory.example.com',STRIPE_SECRET_KEY:'sk_test_synthetic',STRIPE_WEBHOOK_SECRET:secret,STRIPE_API_VERSION:'2025-06-30.basil',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:50000,storageBytes:1048576000}}),fetch:async(url,init)=>{calls++;if(String(url).endsWith('/checkout/sessions')){requestId=new URLSearchParams(init.body).get('subscription_data[metadata][memory_request_id]');return Response.json({id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});}if(String(url).endsWith('/customers'))return Response.json({id:'cus_test'});if(name==='lease-fencing')db.raw.exec("UPDATE release_billing_lock SET token='other' WHERE id=1");return Response.json({id:'sub_test',status,customer:'cus_test',metadata:{memory_request_id:requestId},items:{data:[{price:{id:'price_test'},quantity:1}]}});}};
 const billing=new Billing(env,()=>at);try{
 if(name==='bad-plan'){await assert.rejects(()=>billing.checkout(token,'s1','price_attacker','checkout'),e=>e.status===400);return;}
 const checkout=await billing.checkout(token,'s1','price_test','checkout');assert.equal(checkout.url,'https://checkout.stripe.com/c/pay/test');
 if(name==='checkout-idempotent'){const n=calls;assert.equal((await billing.checkout(token,'s1','price_test','checkout')).url,checkout.url);assert.equal(calls,n);return;}
 const raw=JSON.stringify({id:'evt_test',type:'customer.subscription.updated',data:{object:{id:'sub_test'}}}),t=String(at/1000),signature=await hmac(secret,t+'.'+raw);const event=()=>new Request('https://memory.example.com/webhooks/stripe',{method:'POST',body:raw,headers:{'stripe-signature':'t='+t+',v1='+(name==='bad-webhook'?'bad':signature)}});
 if(name==='bad-webhook'){await assert.rejects(()=>billing.webhook(event()),e=>e.status===401);return;}await billing.webhook(event());if(name==='duplicate-event')await billing.webhook(event());if(name==='cancelled-subscription')status='canceled';await billing.drain();const pool=db.raw.prepare("SELECT * FROM release_pools WHERE id='account:alice'").get();
 if(name==='lease-fencing'){assert.equal(pool.plan,'free');return;}assert.equal(pool.plan,name==='cancelled-subscription'?'free':'team');if(name==='duplicate-event')assert.equal(db.raw.prepare('SELECT count(*) n FROM release_billing_events').get().n,1);
 }finally{db.close();}
});
test('billing periodic reconciliation repairs missing subscription webhooks',async()=>{
 const {db}=await fixture();try{
  db.raw.exec(`UPDATE release_pools SET customer_id='cus_test',subscription_id='sub_test',plan='team',updated_at=${at-7200000} WHERE id='account:alice'`);
  const env={DB:db,STRIPE_SECRET_KEY:'sk_test_synthetic',STRIPE_API_VERSION:'2025-06-30.basil',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:50,storageBytes:104857600}}),fetch:async()=>Response.json({id:'sub_test',customer:'cus_test',status:'canceled',metadata:{},items:{data:[{price:{id:'price_test'},quantity:1}]}})};
  const b=new Billing(env,()=>at);assert.equal(typeof b.reconcile,'function');await b.reconcile();await b.reconcile();assert.equal(db.raw.prepare("SELECT count(*) n FROM release_billing_events WHERE state='pending'").get().n,1);
  await b.drain();assert.equal(db.raw.prepare("SELECT plan FROM release_pools WHERE id='account:alice'").get().plan,'free');
 }finally{db.close();}
});

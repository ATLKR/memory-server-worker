import test from 'node:test';import assert from 'node:assert/strict';import {fixture,at} from './db.mjs';import {hmac} from '../../src/release/util.ts';
let Billing;try{({Billing}=await import('../../src/release/billing.ts'));}catch{}
for(const name of ['checkout-idempotent','bad-plan','bad-webhook','current-subscription','cancelled-subscription','duplicate-event','lease-fencing'])test('billing '+name,async()=>{
 assert.ok(Billing,'billing implementation missing');const {db,token}=await fixture();let calls=0,status='active';let requestId='';const secret='w'.repeat(64);
 const env={DB:db,PUBLIC_ORIGIN:'https://memory.example.com',STRIPE_SECRET_KEY:'sk_test_synthetic',STRIPE_WEBHOOK_SECRET:secret,STRIPE_API_VERSION:'2025-06-30.basil',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:50000,storageBytes:1048576000}}),fetch:async(url,init)=>{calls++;if(String(url).endsWith('/checkout/sessions')){requestId=new URLSearchParams(init.body).get('subscription_data[metadata][memory_request_id]');return Response.json({id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});}if(String(url).endsWith('/customers'))return Response.json({id:'cus_test'});if(name==='lease-fencing')db.raw.exec("UPDATE release_billing_lock SET token='other' WHERE id=1");return Response.json({id:'sub_test',status,customer:'cus_test',metadata:{memory_request_id:requestId},items:{data:[{price:{id:'price_test'},quantity:1}]}});}};
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

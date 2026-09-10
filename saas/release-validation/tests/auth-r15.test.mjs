import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {readSettings,PUBLIC_ORIGIN,AUTH_ISSUER} from '../../src/config.ts';
import {createRelease} from '../../src/release/extension.ts';
import {createApplication} from '../../src/app.ts';
import worker from '../../src/worker.ts';
import {hmac} from '../../src/release/util.ts';

for(const email of ['support!desk@example.com', "A!#$%&'*+-/=?^_`{|}~Z@Example.COM", 'Support.Tag+Desk@EXAMPLE.COM'])test('support mailbox validation preserves valid configured spelling: '+email,async t=>{
 const {db}=await fixture();t.after(()=>db.close());
 const env={DB:db,PRODUCT_SUPPORT_EMAIL:email,REQUEST_LIMITER:{limit:async()=>({success:true})}};
 assert.equal(readSettings(env).brand.supportEmail,email);
 const response=await worker.fetch(new Request(PUBLIC_ORIGIN+'/health'),env);
 assert.equal(response.status,200);
});
for(const email of ['support@example..com','.support@example.com','support.@example.com','support..desk@example.com','x'.repeat(65)+'@example.com','support@-example.com','support@example-.com','support@'+'x'.repeat(64)+'.com','support@例子.com',' support@example.com','support@example.com ','support@example.com\n'])test('invalid support mailbox is rejected before use: '+email,()=>{
 assert.throws(()=>readSettings({PRODUCT_SUPPORT_EMAIL:email}),/Invalid/);
});

const secret='local-test-webhook-secret-'.repeat(3);
async function setup(t,provider){
 const {db}=await fixture();t.after(()=>db.close());let calls=0;
 const env={DB:db,IDENTITY_WEBHOOK_SECRET:secret,STRIPE_WEBHOOK_SECRET:secret,REQUEST_LIMITER:{limit:async()=>({success:true})},fetch:async()=>{calls++;throw Error('Unexpected provider request');}};
 const app=createApplication(db,readSettings(env),{clock:()=>at,release:createRelease(env,{clock:()=>at})});
 const event=provider==='identity'?{id:'evt_local',issuer:AUTH_ISSUER,subject:'local-account',type:'account.disabled'}:{id:'evt_local',type:'customer.subscription.updated',data:{object:{id:'sub_local'}}};
 const request=async(raw,signatureValid=true,extra={})=>{
  const timestamp=String(at/1000),signature=signatureValid?await hmac(secret,timestamp+'.'+(typeof raw==='string'?raw:'')):'wrong';
  const headers=provider==='identity'?{'x-memory-timestamp':timestamp,'x-memory-signature':signature}:{'stripe-signature':'t='+timestamp+',v1='+signature};
  return app(new Request(PUBLIC_ORIGIN+'/webhooks/'+provider,{method:'POST',headers:{...headers,...extra},body:raw,...(raw instanceof ReadableStream?{duplex:'half'}:{})}));
 };
 const untouched=()=>{for(const table of ['release_webhook_events','release_billing_events','release_provider_revocations'])assert.equal(db.raw.prepare('SELECT count(*) n FROM '+table).get().n,0);assert.equal(db.raw.prepare('SELECT count(*) n FROM accounts WHERE disabled_at IS NOT NULL').get().n,0);assert.equal(calls,0);};
 return {db,request,event,untouched,calls:()=>calls};
}
for(const provider of ['identity','stripe']){
 for(const [label,raw,code] of [
  ['unfinished JSON','{','invalid_json'],['empty JSON','','invalid_json'],['trailing JSON','{} {}','invalid_json'],
  ['invalid UTF-8',new Uint8Array([0xff]),'invalid_json'],['truncated UTF-8',new Uint8Array([0xc3]),'invalid_json'],
  ['non-object JSON','null','invalid_object'],['array JSON','[]','invalid_object']
 ])test(provider+' webhook returns400 for '+label+' without a receipt',async t=>{
  const f=await setup(t,provider),response=await f.request(raw);
  assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:code});f.untouched();
 });
 test(provider+' webhook checks signatures before JSON syntax',async t=>{
  const f=await setup(t,provider),response=await f.request('{',false);
  assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'invalid_signature'});f.untouched();
 });
 test(provider+' webhook keeps oversized bodies413',async t=>{
  const f=await setup(t,provider),raw='x'.repeat((provider==='identity'?65536:262144)+1),response=await f.request(raw);
  assert.equal(response.status,413);assert.deepEqual(await response.json(),{error:'payload_too_large'});f.untouched();
 });
 for(const failure of ['database','request stream'])test(provider+' webhook does not relabel '+failure+' exceptions as input errors',async t=>{
  const f=await setup(t,provider);
  if(failure==='database')f.db.prepare=()=>{throw new SyntaxError('synthetic database failure');};
  const raw=failure==='database'?JSON.stringify(f.event):new ReadableStream({start(controller){controller.error(new Error('synthetic stream failure'));}});
  const response=await f.request(raw);
  assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'internal_error'});f.untouched();
 });
 test(provider+' webhook preserves signed valid events and replay receipts',async t=>{
  const f=await setup(t,provider),raw=JSON.stringify({...f.event,description:'Local UTF-8 확인'});
  assert.equal((await f.request(raw)).status,200);
  const replay=await f.request(raw);assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_webhook_events').get().n,1);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM '+(provider==='identity'?'release_provider_revocations':'release_billing_events')).get().n,1);
  assert.equal(f.calls(),0);
 });
}

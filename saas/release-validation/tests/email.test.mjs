import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { Admin } from '../../src/release/admin.ts';
import { createRelease } from '../../src/release/extension.ts';
import { IdentityService } from '../../src/identity.ts';
import { readSettings } from '../../src/config.ts';

for (const brand of ['기'.repeat(30), '기'.repeat(80), 'Memory: Test', 'Memory 관리 화면', "$& $` $' $$ 기억"]) test('configured literal brand supports reauthentication and email linking: ' + brand, async t => {
 const {db,token}=await fixture();t.after(()=>db.close());const delivered=[];
 const env={DB:db,PRODUCT_NAME:brand,MAIL_FROM:'memory@allenlabs.org',EMAIL:{send:async message=>{delivered.push(message);return {messageId:'cf-brand-proof'};}}};
 assert.equal(readSettings(env).brand.name,env.PRODUCT_NAME);
 const admin=new Admin(env,()=>at),identity=new IdentityService(db,()=>at);
 const challenge=await admin.startReauth(token,'e1');
 assert.equal(delivered[0].subject,env.PRODUCT_NAME+': 추가 본인 확인');
 assert.ok(delivered[0].text.startsWith('본인이 요청한 경우에만 '+brand+' 관리 화면에 아래 증명을 입력하세요.'));
 await admin.completeReauth(token,challenge.id,delivered[0].text.match(/Proof: ([A-Za-z0-9_-]+)/)[1]);
 const release=createRelease(env,{clock:()=>at,identity});
 const response=await release.route(new Request(readSettings(env).origin+'/v1/account/emails',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'brand-test@example.com'})}),token);
 assert.equal(response.status,202);
 assert.equal(delivered[1].subject,env.PRODUCT_NAME+' 이메일 확인');
 assert.ok(delivered[1].text.endsWith('이 코드는 '+brand+' 관리 콘솔에서 직접 입력하세요.'));
 const {challengeId}=await response.json();
 await identity.completeEmailLink(token,challengeId,delivered[1].text.match(/Proof: ([A-Za-z0-9_-]+)/)[1]);
 assert.ok((await identity.getAccount(token)).emails.some(e=>e.address==='brand-test@example.com'));
});

test('a mistyped email proof does not turn a valid session into an authentication failure',async()=>{
 const {db,token}=await fixture();let delivered;
 try{
  const admin=new Admin({DB:db,MAIL_FROM:'memory@allenlabs.org',EMAIL:{send:async message=>{delivered=message;return {messageId:'cf-test'};}}},()=>at);
  const challenge=await admin.startReauth(token,'e1');
  await assert.rejects(()=>admin.completeReauth(token,challenge.id,'123456'),e=>e.status===403&&e.code==='reauthentication_failed');
  const proof=delivered.text.match(/Proof: ([A-Za-z0-9_-]+)/)[1];
  await admin.completeReauth(token,challenge.id,proof);
 }finally{db.close();}
});
test('Cloudflare EMAIL binding sends proof mail and proof remains session-bound and single-use',async()=>{
 const {db,token,other}=await fixture();let sent;
 try {
 const admin=new Admin({DB:db,PRODUCT_NAME:'Future Brand',MAIL_FROM:'memory@allenlabs.org',EMAIL:{send:async message=>{sent=message;return {messageId:'cf-test-message'};}}},()=>at);
 db.raw.exec("UPDATE credentials SET reauthenticated_at=NULL WHERE id='session:alice'");
 const challenge=await admin.startReauth(token,'e1');
 assert.equal(sent.from,'memory@allenlabs.org');assert.equal(sent.to,'alice@example.com');assert.equal(sent.html,undefined);
 assert.match(sent.subject,/^Future Brand:/);assert.match(sent.text,/Future Brand 관리 화면/);
 const proof=sent.text.match(/Proof: ([A-Za-z0-9_-]+)/)[1];
 assert.equal(JSON.stringify(challenge).includes(proof),false);
 await assert.rejects(()=>admin.completeReauth(other,challenge.id,proof),e=>e.status===403);
 await admin.completeReauth(token,challenge.id,proof);
 await assert.rejects(()=>admin.completeReauth(token,challenge.id,proof),e=>e.status===403);
 }finally{db.close();}
});
test('Cloudflare mail failure destroys the challenge and does not expose provider diagnostics',async()=>{
 const {db,token}=await fixture();try{
 const admin=new Admin({DB:db,MAIL_FROM:'noreply@memory.allenlabs.org',EMAIL:{send:async()=>{throw Error('sensitive recipient and provider detail');}}},()=>at);
 await assert.rejects(()=>admin.startReauth(token,'e1'),e=>e.code==='mail_delivery_failed'&&!e.message.includes('sensitive'));
 assert.equal(db.raw.prepare('SELECT count(*) AS n FROM release_reauth_challenges').get().n,0);
 }finally{db.close();}
});
test('Cloudflare mail timeout destroys the challenge without retrying the uncertain send',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {db,token}=await fixture();let calls=0;const deliveryStarted=Promise.withResolvers();
 try{
 const admin=new Admin({DB:db,MAIL_FROM:'noreply@memory.allenlabs.org',EMAIL:{send:async()=>{calls++;deliveryStarted.resolve();return new Promise(()=>{});}}},()=>at);
 const pending=admin.startReauth(token,'e1');const denied=assert.rejects(pending,e=>e.code==='mail_delivery_timeout');
 // Crypto and database setup can outlast any fixed number of event-loop turns.
 // Advance the mocked deadline only after the provider call actually starts.
 await Promise.race([deliveryStarted.promise,denied]);
 assert.equal(calls,1);t.mock.timers.tick(10001);await denied;
 assert.equal(calls,1);assert.equal(db.raw.prepare('SELECT count(*) AS n FROM release_reauth_challenges').get().n,0);
 }finally{db.close();}
});
test('Cloudflare mail retains account daily budget and fails closed without EMAIL',async()=>{
 const {db,token}=await fixture();let calls=0;try{
 const admin=new Admin({DB:db,MAIL_FROM:'noreply@memory.allenlabs.org',EMAIL:{send:async()=>{calls++;return {messageId:'cf-test'};}}},()=>at);
 db.raw.prepare('INSERT INTO release_mail_budget(account_id,day,quantity) VALUES(?,?,?)').run('alice',new Date(at).toISOString().slice(0,10),20);
 await assert.rejects(()=>admin.startReauth(token,'e1'),e=>e.code==='daily_email_limit');assert.equal(calls,0);
 const missing=new Admin({DB:db,MAIL_FROM:'noreply@memory.allenlabs.org'},()=>at);
 await assert.rejects(()=>missing.startReauth(token,'e1'),e=>e.code==='mail_not_configured');
 assert.equal(db.raw.prepare('SELECT count(*) AS n FROM release_reauth_challenges').get().n,0);
 }finally{db.close();}
});
test('Cloudflare mail binding controls readiness and failed email linking leaves no usable proof',async()=>{
 const {db,token}=await fixture();let attempted;try{
 const env={DB:db,PUBLIC_ORIGIN:'https://memory.example.com',MAIL_FROM:'noreply@memory.allenlabs.org',EMAIL:{send:async message=>{attempted=message;throw Error('provider detail');}},REQUEST_LIMITER:{limit:async()=>({success:true})}};
 const identity=new IdentityService(db,()=>at),extension=createRelease(env,{clock:()=>at,identity});
 const ready=await (await extension.publicRoute(new Request(env.PUBLIC_ORIGIN+'/ready'))).json();
 assert.equal(ready.checks.mail,true);
 const response=await extension.route(new Request(env.PUBLIC_ORIGIN+'/v1/account/emails',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'new@example.com'})}),token);
 assert.equal(response.status,502);
 assert.equal((await response.json()).error,'mail_delivery_failed');
 const challenge=db.raw.prepare('SELECT id,invalidated_at FROM email_challenges WHERE address=?').get('new@example.com');
 assert.equal(challenge.invalidated_at,at);
 await assert.rejects(()=>identity.completeEmailLink(token,challenge.id,attempted.text.match(/Proof: ([A-Za-z0-9_-]+)/)[1]));
 const unavailable=createRelease({...env,EMAIL:undefined},{clock:()=>at});
 assert.equal((await(await unavailable.publicRoute(new Request(env.PUBLIC_ORIGIN+'/ready'))).json()).checks.mail,false);
 }finally{db.close();}
});

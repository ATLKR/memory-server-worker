import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Jobs} from '../../src/release/jobs.ts';
import {Ingest} from '../../src/release/ingest.ts';
import {createRelease} from '../../src/release/extension.ts';

const environment=db=>({DB:db,PUBLIC_ORIGIN:'https://memory.example.com',REQUEST_LIMITER:{limit:async()=>({success:true})}});
const req=(path,method='GET',body)=>new Request('https://memory.example.com'+path,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});

test('unconfigured vector deletes remain pending without burning retry attempts',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),m=await store.create(token,'s1',{body:'kept'},'create');await store.remove(token,'s1',m.id,1,'delete');
  await new Jobs(environment(db),()=>at).drain();
  const row=db.raw.prepare("SELECT state,attempt,last_error FROM release_jobs WHERE kind='delete'").get();
  assert.equal(row.state,'pending');assert.equal(row.attempt,0);assert.equal(row.last_error,null);
 }finally{db.close();}
});

test('unavailable rebuild and paused extraction reject before creating work',async()=>{
 const {db,token}=await fixture();try{
  const env=environment(db),release=createRelease(env,{clock:()=>at});
  const response=await release.route(req('/v1/spaces/s1/index/rebuild','POST',{}),token);
  assert.equal(response.status,503);assert.equal((await response.json()).error,'semantic_not_configured');
  const configured={...env,AI:{run:async()=>{throw Error('must not run');}},PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url')};
  await assert.rejects(()=>new Ingest(configured,()=>at).submit(token,'s1',{messages:[{id:'u1',role:'user',content:'private'}]},'paused'),e=>e.code==='background_jobs_disabled');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_jobs').get().n,0);
 }finally{db.close();}
});

for(const enabled of [undefined,'false','true'])test('scheduled provider work requires explicit enablement: '+enabled,async()=>{
 const {db,token}=await fixture();let calls=0,billingCalls=0;try{
  const store=new MemoryStore(db,()=>at);await store.create(token,'s1',{body:'current memory'},'create');
  db.raw.prepare("INSERT INTO release_billing_events(id,subscription_id,available_at,created_at) VALUES('queued-billing','sub_synthetic',?,?)").run(at,at);
  const env={...environment(db),...(enabled===undefined?{}:{BACKGROUND_JOBS_ENABLED:enabled}),AI:{run:async()=>{calls++;return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{upsert:async()=>{},deleteByIds:async()=>{},getByIds:async()=>[]},STRIPE_SECRET_KEY:'synthetic-only',STRIPE_API_VERSION:'2026-01-01',fetch:async()=>{billingCalls++;return new Response('{}',{status:503});}};
  await createRelease(env,{clock:()=>at}).scheduled();
  assert.equal(calls,enabled==='true'?1:0);
  assert.equal(billingCalls,enabled==='true'?1:0);
  assert.equal(db.raw.prepare("SELECT last_success_at FROM release_heartbeats WHERE name='maintenance'").get().last_success_at,at);
 }finally{db.close();}
});

test('maintenance bounds temporary cleanup, preserves live proofs and retained memories',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),m=await store.create(token,'s1',{body:'retained memory'},'create');await store.remove(token,'s1',m.id,1,'delete');
  const insert=db.raw.prepare("INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES(?,'session:alice','e1','digest',?)");
  for(let n=0;n<105;n++)insert.run('expired-'+n,at-1);
  insert.run('current',at+1);
  db.raw.prepare("INSERT INTO email_challenges(id,account_id,address,domain,token_digest,expires_at) VALUES('identity-audit','alice','added@example.com','example.com',?,?)").run('d'.repeat(64),at-1);
  db.raw.prepare("INSERT INTO release_export_sessions VALUES('expired-export','alice','s1',0,?,?)").run(at-1,at-1000);
  db.raw.prepare("INSERT INTO release_mail_budget VALUES('alice','2026-09-07',20)").run();
  db.raw.prepare("INSERT INTO release_mail_budget VALUES('alice','2026-09-08',20)").run();
  const jobs=new Jobs(environment(db),()=>at);await jobs.maintain();
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_reauth_challenges WHERE expires_at<=?').get(at).n,5);
  assert.ok(db.raw.prepare("SELECT id FROM release_reauth_challenges WHERE id='current'").get());
  assert.ok(db.raw.prepare("SELECT id FROM email_challenges WHERE id='identity-audit'").get());
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_export_sessions').get().n,0);
  assert.deepEqual(db.raw.prepare('SELECT day,quantity FROM release_mail_budget').all().map(x=>({...x})),[{day:'2026-09-08',quantity:20}]);
  await jobs.maintain();assert.equal(db.raw.prepare('SELECT count(*) n FROM release_reauth_challenges WHERE expires_at<=?').get(at).n,0);
  assert.equal(db.raw.prepare('SELECT body FROM memories WHERE id=?').get(m.id).body,'retained memory');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM memory_versions').get().n,1);
 }finally{db.close();}
});

test('configuration and ingest lists describe disabled automation and expiry truthfully',async()=>{
 const {db,token}=await fixture();try{
  db.raw.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,state,available_at,created_at) VALUES('expired','s1',0,'ingest','done',?,?)").run(at,at);
  db.raw.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,state,proposals,expires_at,created_at) VALUES('expired','alice','s1','session:alice','review','[]',?,?)").run(at-1,at-1000);
  const release=createRelease(environment(db),{clock:()=>at});
  const config=await(await release.route(req('/v1/release/config'),token)).json();
  assert.equal(config.features.backgroundJobs,false);assert.equal(config.policy.automaticErasure,false);
  const list=await(await release.route(req('/v1/spaces/s1/ingests'),token)).json();assert.equal(list.results[0].state,'expired');
 }finally{db.close();}
});

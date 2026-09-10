import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {Ingest} from '../../src/release/ingest.ts';
import {Jobs} from '../../src/release/jobs.ts';
import {MemoryStore} from '../../src/release/memory.ts';

async function approvals(t) {
 const f=await fixture();t.after(()=>f.db.close());
 const env={DB:f.db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),
  AI:{async run(){return{response:{memories:[{body:'Private fact',kind:'fact',sourceMessageId:'u1',quote:'Private fact'}]}};}}};
 const ingest=new Ingest(env,()=>at),jobs=new Jobs(env,()=>at);jobs.ingest=job=>ingest.process(job);
 const input={messages:[{id:'u1',role:'user',content:'Private fact'}]};
 const a=await ingest.submit(f.token,'s1',input,'submit-a'),b=await ingest.submit(f.token,'s1',input,'submit-b');
 await jobs.drain(2);
 const approvedA=await ingest.approve(f.token,'s1',a.id,[0],'approve-a'),approvedB=await ingest.approve(f.token,'s1',b.id,[0],'approve-b');
 return{...f,ingest,a,b,approvedA,approvedB};
}

test('approved ingestion still rejects an operation key bound to another request',async t=>{
 const f=await approvals(t);
 await assert.rejects(()=>f.ingest.approve(f.token,'s1',f.b.id,[0],'approve-a'),error=>error.status===409&&error.code==='idempotency_conflict');
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories').get().n,2);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_operations').get().n,4);
 const replay=await f.ingest.approve(f.token,'s1',f.b.id,[0],'approve-b');
 assert.equal(replay.replayed,true);assert.deepEqual(replay.memories,f.approvedB.memories);
});

test('an unused approval-replay key receives a zero-cost persistent receipt',async t=>{
 const f=await approvals(t),before=f.db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get().n;
 const replay=await f.ingest.approve(f.token,'s1',f.b.id,[0],'approve-new');
 assert.equal(replay.replayed,true);assert.deepEqual(replay.memories,f.approvedB.memories);
 await assert.rejects(()=>new MemoryStore(f.db,()=>at).create(f.token,'s1',{body:'different request'},'approve-new'),error=>error.status===409);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories').get().n,2);
 assert.equal(f.db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get().n,before);
 assert.equal(f.db.raw.prepare("SELECT units FROM release_operations WHERE client_key='approve-new'").get().units,0);
});

test('approval receipt lookup rechecks current human authority',async t=>{
 const f=await approvals(t);let changed=false;const prepare=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{
  const statement=prepare(sql);
  if(sql.startsWith('SELECT id,request_hash AS requestHash')){
   const first=statement.first.bind(statement);statement.first=async()=>{const result=await first();if(!changed){changed=true;f.db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'");}return result;};
  }return statement;
 };
 await assert.rejects(()=>f.ingest.approve(f.token,'s1',f.b.id,[0],'approve-b'),error=>error.status===403);
 assert.equal(changed,true);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories').get().n,2);
});

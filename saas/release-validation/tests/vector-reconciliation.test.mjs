import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Jobs} from '../../src/release/jobs.ts';
import {Search} from '../../src/release/search.ts';
import {DB} from './db.mjs';

// kind='erase' leaves a real erasure_ledger row whose vector_erased_at stamp is
// written on cleanup completion; kind='delete' stops at soft-delete so the job
// can reach 'done' without touching the ledger.
async function tombstone(db,token,count=1,kind='erase'){
 const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'private'},'create');
 (await db.raw.exec("UPDATE release_jobs SET state='done'"));await store.remove(token,'s1',memory.id,1,'delete');
 const revision=kind==='erase'?3:2;
 if(kind==='erase'){(await db.raw.exec("UPDATE release_jobs SET state='done'"));await store.erase(token,'s1',memory.id,2,memory.id,'erase');}
 const ids=Array.from({length:count},(_,n)=>'vector-'+String(n).padStart(4,'0'));
 for(const id of ids)(await db.raw.prepare('INSERT INTO release_vector_refs VALUES(?,?,1)').run(memory.id,id));
 return{memory,jobId:memory.id+':'+revision,ids};
}

for(const transition of ['erase','soft-delete','revision'])test('pending cleanup reconciles a late old upsert after '+transition,async t=>{
 // erasure_ledger's completion trigger (0008) only rejects rewriting an
 // already-stamped vector_erased_at; the NULL->value stamp jobs.ts writes on
 // cleanup completion is permitted — verified against the live PG schema.
 const {db,token}=await fixture();let now=at,releaseUpsert,startedUpsert,work;
 const started=new Promise(resolve=>{startedUpsert=resolve;}),vectors=new Map();let deletes=0,checks=0;
 try{
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:{async run(){return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{
   async upsert(values){if(values[0].metadata.revision===1){startedUpsert();await new Promise(resolve=>{releaseUpsert=resolve;});}values.forEach(v=>vectors.set(v.id,v));},
   async deleteByIds(ids){deletes++;ids.forEach(id=>vectors.delete(id));if(deletes===1){releaseUpsert();await work;}},
   async getByIds(ids){checks++;return ids.filter(id=>vectors.has(id)).map(id=>({id}));},
  }};
  const store=new MemoryStore(db,()=>now),jobs=new Jobs(env,()=>now),memory=await store.create(token,'s1',{body:'old private source'},'create');
  work=jobs.drain(1);await started;
  let revision=2;
  if(transition==='revision')await store.update(token,'s1',memory.id,{body:'new current source',expectedRevision:1},'update');
  else {await store.remove(token,'s1',memory.id,1,'delete');if(transition==='erase'){await store.erase(token,'s1',memory.id,2,memory.id,'erase');revision=3;}}
  const jobId=memory.id+':'+revision;
  (await db.raw.prepare('UPDATE release_jobs SET attempt=2 WHERE id=?').run(jobId));
  await jobs.drain(5);
  assert.ok([...vectors.values()].some(v=>v.metadata.revision===1));
  assert.equal((await db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId)).state,'pending');
  for(let tick=0;tick<16;tick++){now+=5000;await new Jobs(env,()=>now).drain(5);}
  const row=(await db.raw.prepare('SELECT state,attempt FROM release_jobs WHERE id=?').get(jobId));
  assert.equal(row.state,'done','A late upsert must not leave its cleanup page waiting forever');
  assert.equal(row.attempt,3,'Visibility waits preserve the two prior failures');
  assert.equal(deletes,2);assert.ok(checks>5);
  assert.equal([...vectors.values()].filter(v=>v.metadata.revision===1).length,0);
  if(transition==='revision')assert.equal([...vectors.values()].filter(v=>v.metadata.revision===2).length,1,'Current vectors are preserved');
  if(transition==='erase')assert.notEqual((await db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger WHERE memory_id=?').get(memory.id)).vector_erased_at,null);
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_vector_refs WHERE memory_id=?').get(memory.id)).n,transition==='revision'?2:1);
 }finally{releaseUpsert?.();if(work)await work;db.close();}
});

test('slow ordinary propagation gets increasing quiet windows and preserves prior actual failures',async()=>{
 const {db,token}=await fixture();let now=at,absentAt=Infinity;const deletes=[];try{
  const {jobId}=await tombstone(db,token,1,'delete');(await db.raw.prepare('UPDATE release_jobs SET attempt=2 WHERE id=?').run(jobId));
  const env={DB:db,MEMORY_INDEX:{async deleteByIds(){deletes.push(now-at);absentAt=now+180000;},async getByIds(ids){return now<absentAt?ids.map(id=>({id})):[];}}};
  let calls=0;
  for(;calls<80;calls++){
   await new Jobs(env,()=>now).drain(5);
   const row=(await db.raw.prepare('SELECT state,attempt FROM release_jobs WHERE id=?').get(jobId));
   assert.equal(row.attempt,row.state==='done'?3:2);
   if(row.state==='done')break;
   assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_erasure_ledger WHERE vector_erased_at IS NOT NULL').get()).n,0);
   now+=5000;
  }
  assert.ok(calls>60);assert.ok(calls<80);assert.deepEqual(deletes,[0,60000,180000]);
  assert.equal(now-at,360000);assert.equal((await db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId)).state,'done');
 }finally{db.close();}
});

test('retry interval is durable, capped at a day, and ordinary polling never spends failure attempts',async()=>{
 const {db,token}=await fixture();let now=at,deletes=0;try{
  const {jobId}=await tombstone(db,token),env={DB:db,MEMORY_INDEX:{async deleteByIds(){deletes++;},async getByIds(ids){return ids.map(id=>({id}));}}};
  await new Jobs(env,()=>now).drain(1);
  let previous=at,expectedDelay=60000;
  for(let n=0;n<13;n++){
   const before=(await db.raw.prepare('SELECT cleanup_retry_at,cleanup_retry_delay FROM release_jobs WHERE id=?').get(jobId));
   assert.equal(before.cleanup_retry_delay,expectedDelay);assert.equal(before.cleanup_retry_at,previous+expectedDelay);
   now=before.cleanup_retry_at-1;await new Jobs(env,()=>now).drain(1);assert.equal(deletes,n+1);
   // A confirmation was just scheduled; pass its5s availability as well.
   now+=5000;await new Jobs(env,()=>now).drain(1);assert.equal(deletes,n+2);
   assert.equal((await db.raw.prepare('SELECT attempt FROM release_jobs WHERE id=?').get(jobId)).attempt,0);
   previous=now;expectedDelay=Math.min(86400000,expectedDelay*2);
  }
  assert.equal(expectedDelay,86400000);assert.equal((await db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger').get()).vector_erased_at,null);
 }finally{db.close();}
});

test('migration16 pending pages get a fresh grace period without discarding their checkpoint',async()=>{
 const db=new DB();(await db.migrate());try{
  // The PG lineage was born with the additive cleanup columns; a checkpointed
  // row keeps its metadata and the retry fields carry the migration16 defaults.
  (await db.raw.exec("INSERT INTO release_jobs(id,revision,kind,available_at,created_at,cleanup_cursor,cleanup_pending) VALUES('old',1,'delete',1,1,'prior-page','[\"old-vector\"]')"));
  const row=(await db.raw.prepare('SELECT * FROM release_jobs').get());
  assert.equal(row.cleanup_cursor,'prior-page');assert.deepEqual(row.cleanup_pending,['old-vector']);
  assert.equal(row.cleanup_retry_at,0);assert.equal(row.cleanup_retry_delay,60000);
 }finally{db.close();}
 const {db:live,token}=await fixture();let now=at,deletes=0;try{
  const {jobId,ids}=await tombstone(live,token,1,'delete');(await live.raw.prepare('UPDATE release_jobs SET cleanup_pending=? WHERE id=?').run(JSON.stringify(ids),jobId));
  const env={DB:live,MEMORY_INDEX:{async deleteByIds(){deletes++;},async getByIds(page){return deletes?[]:page.map(id=>({id}));}}};
  await new Jobs(env,()=>now).drain(1);assert.equal(deletes,0);assert.equal((await live.raw.prepare('SELECT cleanup_retry_at FROM release_jobs WHERE id=?').get(jobId)).cleanup_retry_at,at+60000);
  now+=60000;await new Jobs(env,()=>now).drain(1);assert.equal(deletes,1);assert.equal((await live.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId)).state,'done');
 }finally{live.close();}
});

for(const interruption of ['checkpoint-response-lost','lease-replaced','lease-expired'])test('pre-delete checkpoint survives '+interruption+' without stale provider work',async()=>{
 const {db,token}=await fixture();let now=at,deletes=0,armed=true;try{
  const {jobId,ids}=await tombstone(db,token,1,'delete'),prepare=db.prepare.bind(db),env={DB:db,MEMORY_INDEX:{async deleteByIds(){deletes++;},async getByIds(page){return deletes?[]:page.map(id=>({id}));}}};
  db.prepare= sql=>{const statement=prepare(sql),run=statement.run.bind(statement);statement.run=async()=>{
   const result=await run();if(armed&&sql.includes('SET next_chunk=')&&sql.includes('cleanup_retry_at=')){
    armed=false;
    if(interruption==='checkpoint-response-lost')throw Error('lost checkpoint response');
    if(interruption==='lease-expired')now+=120001;
    else (await db.raw.prepare("UPDATE release_jobs SET lease_token='replacement',cleanup_pending='[\"later-page\"]',cleanup_retry_at=?,cleanup_retry_delay=120000 WHERE id=?").run(now+120000,jobId));
   }return result;
  };return statement;};
  await new Jobs(env,()=>now).drain(1);assert.equal(armed,false,'The persisted pre-delete checkpoint boundary must be exercised');assert.equal(deletes,0);
  const row=(await db.raw.prepare('SELECT state,cleanup_pending,cleanup_retry_at,cleanup_retry_delay FROM release_jobs WHERE id=?').get(jobId));
  if(interruption==='lease-replaced'){
   assert.equal(row.state,'leased');assert.deepEqual(row.cleanup_pending,['later-page']);assert.equal(row.cleanup_retry_delay,120000);
  }else{
   assert.deepEqual(row.cleanup_pending,ids);assert.equal(row.cleanup_retry_at,at+60000);
   if(interruption==='checkpoint-response-lost'){now+=5000;await new Jobs(env,()=>now).drain(1);assert.equal(deletes,0);}
   now=Math.max(now,at+60000,(await db.raw.prepare('SELECT available_at FROM release_jobs WHERE id=?').get(jobId)).available_at);await new Jobs(env,()=>now).drain(1);assert.equal(deletes,1);
   assert.equal((await db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId)).state,'done');
  }
 }finally{db.close();}
});

test('confirmed page, daily sweep, and explicit rebuild reset retry timing but preserve leased progress',async()=>{
 const {db,token}=await fixture();let now=at;try{
  const {jobId}=await tombstone(db,token,1,'delete'),env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:{},MEMORY_INDEX:{async deleteByIds(){},async getByIds(){return[];}}};
  await new Jobs(env,()=>now).drain(1);
  let row=(await db.raw.prepare('SELECT cleanup_pending,cleanup_retry_at,cleanup_retry_delay FROM release_jobs WHERE id=?').get(jobId));assert.deepEqual({...row},{cleanup_pending:[],cleanup_retry_at:0,cleanup_retry_delay:60000});
  (await db.raw.prepare('UPDATE release_jobs SET cleanup_retry_at=?,cleanup_retry_delay=120000 WHERE id=?').run(at+1000,jobId));
  now+=86400001;await new Jobs(env,()=>now).maintain();assert.equal((await db.raw.prepare('SELECT cleanup_retry_at FROM release_jobs WHERE id=?').get(jobId)).cleanup_retry_at,0);
  now=at;(await db.raw.prepare("UPDATE release_jobs SET state='leased',lease_token='other',lease_until=?,cleanup_retry_at=?,cleanup_retry_delay=120000 WHERE id=?").run(at+1000,at+60000,jobId));
  await new Search(env,()=>now).rebuild(token,'s1');assert.equal((await db.raw.prepare('SELECT cleanup_retry_at FROM release_jobs WHERE id=?').get(jobId)).cleanup_retry_at,at+60000);
  (await db.raw.prepare("UPDATE release_jobs SET state='pending' WHERE id=?").run(jobId));await new Search(env,()=>now).rebuild(token,'s1');
  row=(await db.raw.prepare('SELECT cleanup_retry_at,cleanup_retry_delay FROM release_jobs WHERE id=?').get(jobId));assert.deepEqual({...row},{cleanup_retry_at:0,cleanup_retry_delay:60000});
 }finally{db.close();}
});

test('reconciliation spans multiple bounded pages without restarting confirmed history',async()=>{
 const {db,token}=await fixture();let now=at,calls=0;try{
  const {jobId,ids}=await tombstone(db,token,1050,'delete'),vectors=new Set(ids),pages=[];
  const env={DB:db,MEMORY_INDEX:{async deleteByIds(page){calls++;pages.push([...page]);page.forEach(id=>vectors.delete(id));if(pages.length===1)vectors.add(page[0]);},async getByIds(page){calls++;return page.filter(id=>vectors.has(id)).map(id=>({id}));}}};
  await new Jobs(env,()=>now).drain(1);assert.equal(calls,2);
  now+=60000;calls=0;await new Jobs(env,()=>now).drain(1);assert.equal(calls,19);assert.equal((await db.raw.prepare('SELECT cleanup_cursor FROM release_jobs WHERE id=?').get(jobId)).cleanup_cursor,ids[899]);
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_erasure_ledger WHERE vector_erased_at IS NOT NULL').get()).n,0);
  now+=5000;calls=0;await new Jobs(env,()=>now).drain(1);assert.equal(calls,4);assert.equal(vectors.size,0);
  assert.equal((await db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId)).state,'done');assert.equal(pages.length,12);
  assert.deepEqual(pages[0],pages[1]);assert.equal(new Set(pages.slice(2).flat()).size,950);assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_vector_refs').get()).n,1050);
 }finally{db.close();}
});

test('a lost delete response is resolved by absence without replaying the uncertain mutation',async()=>{
 const {db,token}=await fixture();let now=at,deletes=0;try{
  const {jobId}=await tombstone(db,token,1,'delete'),env={DB:db,MEMORY_INDEX:{async deleteByIds(){deletes++;throw Error('response lost after successful deletion');},async getByIds(){return[];}}};
  await new Jobs(env,()=>now).drain(1);let row=(await db.raw.prepare('SELECT state,attempt,available_at,cleanup_pending FROM release_jobs WHERE id=?').get(jobId));
  assert.equal(row.state,'pending');assert.equal(row.attempt,1);assert.notDeepEqual(row.cleanup_pending,[]);assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_erasure_ledger WHERE vector_erased_at IS NOT NULL').get()).n,0);
  now=row.available_at;await new Jobs(env,()=>now).drain(1);row=(await db.raw.prepare('SELECT state,attempt FROM release_jobs WHERE id=?').get(jobId));assert.equal(row.state,'done');assert.equal(row.attempt,2);assert.equal(deletes,1);
 }finally{db.close();}
});

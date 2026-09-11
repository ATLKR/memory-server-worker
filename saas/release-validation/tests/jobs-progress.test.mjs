import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Jobs} from '../../src/release/jobs.ts';
import {Search} from '../../src/release/search.ts';

function providers(db,clock,advance) {
 const vectors=new Set(),deleted=[],embedded=[];
 const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:{async run(_model,input){embedded.push(input.text[0]);advance(19000);return{data:[Array(1024).fill(.1)]};}},
  MEMORY_INDEX:{async upsert(values){advance(19000);values.forEach(v=>vectors.add(v.id));},async deleteByIds(ids){advance(19000);deleted.push(...ids);ids.forEach(id=>vectors.delete(id));},async getByIds(ids){advance(19000);return ids.filter(id=>vectors.has(id)).map(id=>({id}));}}};
 return{env,vectors,deleted,embedded,jobs:new Jobs(env,clock)};
}
async function finish(jobs,db,advance,id) {
 for(let n=0;n<10;n++){
  if(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(id).state==='done')return;
  advance(60000);await jobs.drain(5);
 }
 assert.fail('Bounded job failed to finish across scheduled invocations');
}

test('erasure checkpoints bounded pages and daily sweeps restart with retained identifiers',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'x'.repeat(16000)},'create');
  const p=providers(db,()=>now,ms=>{now+=ms;});
  for(let revision=1;revision<=250;revision++){
   if(revision>1)await store.update(token,'s1',memory.id,{body:'x'.repeat(16000),expectedRevision:revision-1},'update-'+revision);
   for(let chunk=0;chunk<10;chunk++){
    const vectorId='historical:'+String(revision).padStart(3,'0')+':'+chunk;
    db.raw.prepare('INSERT INTO release_vector_refs VALUES(?,?,?)').run(memory.id,vectorId,revision);p.vectors.add(vectorId);
   }
  }
  await store.remove(token,'s1',memory.id,250,'delete');db.raw.exec("UPDATE release_jobs SET state='done'");
  await store.erase(token,'s1',memory.id,251,memory.id,'erase');
  const jobId=memory.id+':252';await p.jobs.drain(5);
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId).state,'pending','A large cleanup must yield before the scheduled deadline');
  assert.ok(now-at<520000);assert.equal(db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger').get().vector_erased_at,null);
  assert.equal(db.raw.prepare('SELECT attempt FROM release_jobs WHERE id=?').get(jobId).attempt,0,'Useful continuation must not consume a failure');
  assert.ok(db.raw.prepare('SELECT cleanup_cursor FROM release_jobs WHERE id=?').get(jobId).cleanup_cursor);
  await finish(p.jobs,db,ms=>{now+=ms;},jobId);
  assert.equal(p.vectors.size,0);assert.equal(p.deleted.length,2500);assert.equal(new Set(p.deleted).size,2500);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_vector_refs').get().n,2500);
  const completedAt=db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger').get().vector_erased_at;
  p.vectors.add('historical:001:0');now+=86400001;
  // Each maintenance pass advances over at most 100 raw done jobs, including
  // obsolete revisions, so this 252-revision history needs several passes.
  for(let pass=0;pass<3;pass++)await p.jobs.maintain();
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId).state,'pending');
  assert.equal(db.raw.prepare('SELECT cleanup_cursor FROM release_jobs WHERE id=?').get(jobId).cleanup_cursor,'');
  await finish(p.jobs,db,ms=>{now+=ms;},jobId);assert.equal(p.vectors.size,0);
  assert.ok(db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger').get().vector_erased_at>completedAt);
 }finally{db.close();}
});

test('upsert resumes completed chunks and rebuild restarts their progress',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  const memory=await new MemoryStore(db,()=>at).create(token,'s1',{body:'x'.repeat(16000)},'create'),jobId=memory.id+':1';
  const p=providers(db,()=>now,ms=>{now+=ms;});await p.jobs.drain(5);
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId).state,'pending');
  assert.equal(db.raw.prepare('SELECT next_chunk FROM release_jobs WHERE id=?').get(jobId).next_chunk,7);
  await finish(p.jobs,db,ms=>{now+=ms;},jobId);assert.equal(p.embedded.length,10);assert.equal(p.vectors.size,10);
  await new Search(p.env,()=>at).rebuild(token,'s1');
  assert.equal(db.raw.prepare('SELECT next_chunk FROM release_jobs WHERE id=?').get(jobId).next_chunk,0);
  await finish(p.jobs,db,ms=>{now+=ms;},jobId);assert.equal(p.embedded.length,20);
 }finally{db.close();}
});

test('fast cleanup has a provider-call cap and retains earlier failure attempts when yielding',async()=>{
 const {db,token}=await fixture();
 try {
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'private'},'create');
  await store.remove(token,'s1',memory.id,1,'delete');db.raw.exec("UPDATE release_jobs SET state='done'");
  await store.erase(token,'s1',memory.id,2,memory.id,'erase');const jobId=memory.id+':3';
  for(let n=0;n<1100;n++)db.raw.prepare('INSERT INTO release_vector_refs VALUES(?,?,1)').run(memory.id,'vector-'+String(n).padStart(4,'0'));
  db.raw.prepare('UPDATE release_jobs SET attempt=2 WHERE id=?').run(jobId);
  let calls=0;const jobs=new Jobs({DB:db,MEMORY_INDEX:{async deleteByIds(){calls++;},async getByIds(){calls++;return[];}}},()=>at);
  await jobs.drain(1);assert.equal(calls,20);
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId).state,'pending');
  assert.equal(db.raw.prepare('SELECT attempt FROM release_jobs WHERE id=?').get(jobId).attempt,2);
 }finally{db.close();}
});

for(const failure of ['provider','replaced-lease'])test('cleanup checkpoint survives '+failure+' after an earlier confirmed page',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'private'},'create');
  await store.remove(token,'s1',memory.id,1,'delete');db.raw.exec("UPDATE release_jobs SET state='done'");
  await store.erase(token,'s1',memory.id,2,memory.id,'erase');const jobId=memory.id+':3';
  for(let n=0;n<250;n++)db.raw.prepare('INSERT INTO release_vector_refs VALUES(?,?,1)').run(memory.id,'vector-'+String(n).padStart(4,'0'));
  let pages=0,fail=true;const deleted=[];
  const jobs=new Jobs({DB:db,MEMORY_INDEX:{async deleteByIds(ids){deleted.push(ids[0]);},async getByIds(){
   if(++pages===2&&fail){
    if(failure==='provider')throw Error('provider unavailable');
    db.raw.prepare("UPDATE release_jobs SET lease_token='replacement-worker' WHERE id=?").run(jobId);
   }return[];
  }}},()=>now);
  await jobs.drain(1);
  const row=db.raw.prepare('SELECT state,attempt,cleanup_cursor,lease_token FROM release_jobs WHERE id=?').get(jobId);
  assert.equal(row.cleanup_cursor,'vector-0099','Only the confirmed page under the same lease may advance');
  assert.equal(row.state,failure==='provider'?'pending':'leased');assert.equal(row.attempt,1);
  if(failure==='replaced-lease')assert.equal(row.lease_token,'replacement-worker');
  fail=false;now+=120001;await jobs.drain(1);
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId).state,'done');
  assert.deepEqual(deleted,['vector-0000','vector-0100','vector-0200'],'A previously accepted page resumes confirmation without resubmitting its deletion');
 }finally{db.close();}
});

test('scheduled drain stops claiming more jobs after its wall-clock budget',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  const store=new MemoryStore(db,()=>at);
  for(let n=0;n<5;n++)await store.create(token,'s1',{body:'x'.repeat(3300)},'create-'+n);
  const p=providers(db,()=>now,ms=>{now+=ms;});await p.jobs.drain(5);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='done'").get().n,4);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='pending' AND attempt=0").get().n,1);
  assert.equal(now-at,304000);
 }finally{db.close();}
});

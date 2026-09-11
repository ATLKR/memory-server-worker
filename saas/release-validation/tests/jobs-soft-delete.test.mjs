import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Jobs} from '../../src/release/jobs.ts';

test('daily soft-delete cleanup removes an upsert that finished after deletion',async()=>{
 const {db,token}=await fixture();let now=at,releaseUpsert,upsertStarted,work;
 const started=new Promise(resolve=>{upsertStarted=resolve;}),vectors=new Map();
 try {
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AUTO_ERASURE_ENABLED:'false',AI:{async run(){return{data:[Array(1024).fill(.1)]};}},
   MEMORY_INDEX:{async upsert(values){upsertStarted();await new Promise(resolve=>{releaseUpsert=resolve;});values.forEach(v=>vectors.set(v.id,v));},async deleteByIds(ids){ids.forEach(id=>vectors.delete(id));},async getByIds(ids){return ids.filter(id=>vectors.has(id)).map(id=>({id}));}}};
  const store=new MemoryStore(db,()=>now),jobs=new Jobs(env,()=>now),memory=await store.create(token,'s1',{body:'retained private source'},'create');
  work=jobs.drain(1);await started;
  await store.remove(token,'s1',memory.id,1,'delete');await jobs.drain(1);
  releaseUpsert();await work;assert.equal(vectors.size,1,'The delayed provider request recreates its old vector');
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='done'").get().n,2);
  now+=3*86400000;await jobs.maintain();await jobs.drain(5);assert.equal(vectors.size,0);
  const current=db.raw.prepare('SELECT body,deleted_at,erased_at FROM memories').get();
  assert.equal(current.body,'retained private source');assert.notEqual(current.deleted_at,null);assert.equal(current.erased_at,null);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM memory_versions').get().n,1);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_vector_refs').get().n,1);
 }finally{releaseUpsert?.();if(work)await work;db.close();}
});

test('soft-delete sweep waits a day from confirmed completion and preserves active leases',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  const store=new MemoryStore(db,()=>now),memory=await store.create(token,'s1',{body:'retained'},'create');
  await store.remove(token,'s1',memory.id,1,'delete');
  const jobs=new Jobs({DB:db,BACKGROUND_JOBS_ENABLED:'true',MEMORY_INDEX:{}},()=>now);
  now+=5000;await jobs.drain(1);const jobId=memory.id+':2';
  now=at+86400000+4000;await jobs.maintain();assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId).state,'done');
  now+=1001;await jobs.maintain();assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId).state,'pending');
  const lease=await jobs.claim();db.raw.prepare('UPDATE release_jobs SET cleanup_cursor=? WHERE id=?').run('confirmed-page',jobId);
  now+=86400000;await jobs.maintain();
  const row=db.raw.prepare('SELECT state,lease_token,cleanup_cursor FROM release_jobs WHERE id=?').get(jobId);
  assert.deepEqual({...row},{state:'leased',lease_token:lease.leaseToken,cleanup_cursor:'confirmed-page'});
 }finally{db.close();}
});

test('soft-delete sweep is bounded and excludes memories that were restored',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  const store=new MemoryStore(db,()=>now),memories=[];
  for(let n=0;n<106;n++){
   const memory=await store.create(token,'s1',{body:'retained'},'create-'+n);memories.push(memory);
   await store.remove(token,'s1',memory.id,1,'delete-'+n);
  }
  const jobs=new Jobs({DB:db,BACKGROUND_JOBS_ENABLED:'true',MEMORY_INDEX:{}},()=>now);await jobs.drain(200);
  await store.restore(token,'s1',memories[0].id,2,'restore');
  now+=86400001;await jobs.maintain();
  const firstCount=db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE kind='delete' AND state='pending'").get().n;
  assert.ok(firstCount>=99&&firstCount<=100,'The raw page contains at most one restored memory');
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(memories[0].id+':2').state,'done');
  await jobs.maintain();assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE kind='delete' AND state='pending'").get().n,105);
 }finally{db.close();}
});

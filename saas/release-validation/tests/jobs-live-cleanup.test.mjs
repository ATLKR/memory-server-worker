import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Jobs} from '../../src/release/jobs.ts';

test('daily live-memory cleanup removes delayed old upserts without re-embedding current chunks',async()=>{
 const {db,token}=await fixture();let now=at,releaseOld,oldStarted,work,embeddings=0;
 const started=new Promise(resolve=>{oldStarted=resolve;}),vectors=new Map();
 try {
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:{async run(){embeddings++;return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{
   async upsert(values){if(values[0].metadata.revision===1){oldStarted();await new Promise(resolve=>{releaseOld=resolve;});}values.forEach(v=>vectors.set(v.id,v));},
   async deleteByIds(ids){ids.forEach(id=>vectors.delete(id));},async getByIds(ids){return ids.filter(id=>vectors.has(id)).map(id=>({id}));}
  }};
  const store=new MemoryStore(db,()=>now),jobs=new Jobs(env,()=>now),memory=await store.create(token,'s1',{body:'Old content'},'create');
  work=jobs.drain(1);await started;await store.update(token,'s1',memory.id,{body:'Current content',expectedRevision:1},'update');await jobs.drain(1);
  releaseOld();await work;assert.deepEqual([...vectors.values()].map(v=>v.metadata.revision).sort(),[1,2]);assert.equal(embeddings,2);
  for(let day=0;day<3;day++){now+=86400001;await jobs.maintain();await jobs.drain(5);}
  assert.deepEqual([...vectors.values()].map(v=>v.metadata.revision),[2]);assert.equal(embeddings,2);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_vector_refs').get().n,2);
 }finally{releaseOld?.();if(work)await work;db.close();}
});

test('large live cleanup resumes bounded pages with no AI binding and preserves the current revision',async()=>{
 const {db,token}=await fixture();let now=at,calls=0;const vectors=new Set();
 try {
  const store=new MemoryStore(db,()=>now),memory=await store.create(token,'s1',{body:'x'.repeat(16000)},'create');
  for(let revision=1;revision<=111;revision++){
   if(revision>1)await store.update(token,'s1',memory.id,{body:'x'.repeat(16000),expectedRevision:revision-1},'update-'+revision);
   for(let chunk=0;chunk<10;chunk++){const id=String(revision).padStart(3,'0')+':'+chunk;vectors.add(id);db.raw.prepare('INSERT INTO release_vector_refs VALUES(?,?,?)').run(memory.id,id,revision);}
  }
  // Completed jobs created before durable checkpoints retain next_chunk=0.
  db.raw.prepare("UPDATE release_jobs SET state='done',available_at=?,next_chunk=0").run(now);
  const jobs=new Jobs({DB:db,BACKGROUND_JOBS_ENABLED:'true',MEMORY_INDEX:{async deleteByIds(ids){calls++;ids.forEach(id=>vectors.delete(id));},async getByIds(ids){calls++;return ids.filter(id=>vectors.has(id)).map(id=>({id}));}}},()=>now);
  now+=86400001;await jobs.maintain();await jobs.drain(1);
  const jobId=memory.id+':111',partial=db.raw.prepare('SELECT state,attempt,next_chunk,cleanup_cursor FROM release_jobs WHERE id=?').get(jobId);
  assert.equal(calls,20);assert.equal(partial.state,'pending');assert.equal(partial.attempt,0);assert.equal(partial.next_chunk,10);assert.ok(partial.cleanup_cursor);
  now++;await jobs.drain(1);assert.equal(calls,22);assert.equal(vectors.size,10);assert.ok([...vectors].every(id=>id.startsWith('111:')));
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId).state,'done');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_vector_refs').get().n,1110);
 }finally{db.close();}
});

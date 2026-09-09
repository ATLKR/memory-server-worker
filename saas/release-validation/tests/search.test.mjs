import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';import {MemoryStore} from '../../src/release/memory.ts';
let Search,Jobs;try{({Search}=await import('../../src/release/search.ts'));({Jobs}=await import('../../src/release/jobs.ts'));}catch{}
for(const name of ['lexical','cross-space-vector','stale-vector','revoked-during-search','outbox-retry','index-rebuild','erasure-index'])test(name,async()=>{
 assert.ok(Search&&Jobs,'search/outbox implementation missing');const {db,token,other}=await fixture();
 const store=new MemoryStore(db,()=>at);let now=at;let vectors=new Map();let failUpsert=false;
 const ai={run:async()=>({data:[Array(1024).fill(0.1)]})};
 const index={query:async()=>({matches:[...vectors.values()].map(x=>({id:x.id,score:1,metadata:x.metadata}))}),upsert:async vs=>{if(failUpsert)throw Error('offline');vs.forEach(v=>vectors.set(v.id,v));},deleteByIds:async ids=>ids.forEach(i=>vectors.delete(i)),getByIds:async ids=>ids.filter(i=>vectors.has(i)).map(id=>({id}))};
 const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:ai,MEMORY_INDEX:index};const search=new Search(env,()=>now);const jobs=new Jobs(env,()=>now);
 try{const m=await store.create(token,'s1',{body:'alpha beta memory'},'add');
 if(name==='lexical'){const r=await search.query(token,'s1','alpha',10,'search');assert.equal(r.results[0].id,m.id);}
 if(name==='cross-space-vector'){const otherM=await store.create(other,'s2',{body:'classified'},'other-add');vectors.set('foreign',{id:'foreign',metadata:{memoryId:otherM.id,revision:1}});const r=await search.query(token,'s1','unmatched',10,'search');assert.equal(r.results.length,0);}
 if(name==='stale-vector'){vectors.set('stale',{id:'stale',metadata:{memoryId:m.id,revision:1}});await store.update(token,'s1',m.id,{body:'gamma',expectedRevision:1},'update');const r=await search.query(token,'s1','unmatched',10,'search');assert.equal(r.results.length,0);}
 if(name==='revoked-during-search'){index.query=async()=>{db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'");return {matches:[{id:'v',score:1,metadata:{memoryId:m.id,revision:1}}]};};await assert.rejects(()=>search.query(token,'s1','alpha',10,'search'),e=>e.status===403);}
 if(name==='outbox-retry'){failUpsert=true;await jobs.drain(1);assert.equal(db.raw.prepare('SELECT state FROM release_jobs').get().state,'pending');failUpsert=false;now+=120000;await jobs.drain(1);assert.equal(db.raw.prepare('SELECT state FROM release_jobs').get().state,'done');assert.ok(vectors.size>0);}
 if(name==='index-rebuild'){await jobs.drain(1);vectors.clear();await search.rebuild(token,'s1');await jobs.drain(5);assert.ok(vectors.size>0);}
 if(name==='erasure-index'){await jobs.drain(1);await store.remove(token,'s1',m.id,1,'delete');await store.erase(token,'s1',m.id,2,m.id,'erase');await jobs.drain(10);assert.equal(vectors.size,0);assert.ok(db.raw.prepare('SELECT vector_erased_at v FROM release_erasure_ledger').get().v);}
 }finally{db.close();}
});
test('hybrid ranking counts a memory once despite multiple matching chunks',async()=>{
 const {db,token}=await fixture();try{const store=new MemoryStore(db,()=>at),a=await store.create(token,'s1',{body:'first'},'first'),b=await store.create(token,'s1',{body:'second'},'second');
 const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:{run:async()=>({data:[Array(1024).fill(0.1)]})},MEMORY_INDEX:{query:async()=>({matches:[a,b,b,b].map((m,i)=>({id:'v'+i,score:1,metadata:{memoryId:m.id,revision:1}}))})}};
 const r=await new Search(env,()=>at).query(token,'s1','notlexical',10,'semantic-once');assert.equal(r.results[0].id,a.id);
 }finally{db.close();}
});

test('replayed search meters once and never repeats external provider work',async()=>{
 const {db,token}=await fixture();let embeddings=0,queries=0;
 try {
  const store=new MemoryStore(db,()=>at);const memory=await store.create(token,'s1',{body:'alpha fact'},'create');
  const search=new Search({DB:db,AI:{run:async()=>{embeddings++;return {data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{query:async()=>{queries++;return {matches:[]};}}},()=>at);
  const first=await search.query(token,'s1','alpha',10,'search-once');assert.equal(first.mode,'hybrid');
  for(let n=0;n<3;n++){
   const replay=await search.query(token,'s1','alpha',10,'search-once');assert.equal(embeddings,1);assert.equal(queries,1);
   assert.equal(replay.mode,'lexical');assert.equal(replay.degradedReason,'semantic_skipped_on_replay');assert.equal(replay.results[0].id,memory.id);
  }
  assert.equal(db.raw.prepare("SELECT sum(units) n FROM release_usage_events WHERE operation_id IN (SELECT id FROM release_operations WHERE action='search')").get().n,1);
  await assert.rejects(()=>search.query(token,'s1','different',10,'search-once'),e=>e.status===409);
  db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'");
  await assert.rejects(()=>search.query(token,'s1','alpha',10,'search-once'),e=>e.status===403);assert.equal(embeddings,1);
 } finally {db.close();}
});

test('a delayed older upsert cannot delete a newer revision vector',async()=>{
 const {db,token}=await fixture();let releaseOld,started;const oldStarted=new Promise(resolve=>{started=resolve;});const vectors=new Map();let oldWork;
 try {
  const index={async upsert(values){if(values[0].metadata.revision===1){started();await new Promise(resolve=>{releaseOld=resolve;});}for(const value of values)vectors.set(value.id,value);},async deleteByIds(ids){ids.forEach(id=>vectors.delete(id));},async getByIds(ids){return ids.flatMap(id=>vectors.has(id)?[vectors.get(id)]:[]);},async query(){return {matches:[...vectors.values()].map(value=>({...value,score:1}))};}};
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:{run:async()=>({data:[Array(1024).fill(.1)]})},MEMORY_INDEX:index};const jobs=new Jobs(env,()=>at),store=new MemoryStore(db,()=>at);
  const memory=await store.create(token,'s1',{body:'First revision'},'first');oldWork=jobs.index(await jobs.claim());await oldStarted;
  await store.update(token,'s1',memory.id,{body:'Newer revision',expectedRevision:1},'second');await jobs.index(await jobs.claim());
  assert.deepEqual([...vectors.values()].map(value=>value.metadata.revision),[2]);releaseOld();await oldWork;
  assert.ok([...vectors.values()].some(value=>value.metadata.revision===2),'Older work deleted the newer revision');
  const results=await new Search(env,()=>at).query(token,'s1','notlexical',10,'search');assert.equal(results.results[0]?.revision,2);
 } finally {releaseOld?.();if(oldWork)await oldWork;db.close();}
});

test('stale higher-ranked chunks cannot conceal a matching current vector revision',async()=>{
 const {db,token}=await fixture();
 try {
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'Old fact'},'create');
  await store.update(token,'s1',memory.id,{body:'Current fact',expectedRevision:1},'update');
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:{run:async()=>({data:[Array(1024).fill(.1)]})},MEMORY_INDEX:{query:async()=>({matches:[1,1,2,2,999].map((revision,index)=>({id:'vector-'+index,score:1,metadata:{memoryId:memory.id,revision}}))})}};
  const result=await new Search(env,()=>at).query(token,'s1','notlexical',10,'search');
  assert.equal(result.results.length,1);assert.equal(result.results[0].revision,2);assert.equal(result.results[0].score,1/63);
 } finally {db.close();}
});

test('a deletion job cannot remove vectors created by a concurrent restore',async()=>{
 const {db,token}=await fixture();const vectors=new Map();
 try {
  const index={async upsert(values){values.forEach(value=>vectors.set(value.id,value));},async deleteByIds(ids){ids.forEach(id=>vectors.delete(id));},async getByIds(ids){return ids.flatMap(id=>vectors.has(id)?[vectors.get(id)]:[]);}};
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:{run:async()=>({data:[Array(1024).fill(.1)]})},MEMORY_INDEX:index};const jobs=new Jobs(env,()=>at),store=new MemoryStore(db,()=>at);
  const memory=await store.create(token,'s1',{body:'Restorable'},'create');await jobs.drain(1);await store.remove(token,'s1',memory.id,1,'delete');const deletion=await jobs.claim();
  const prepare=db.prepare.bind(db);let restored=false;
  db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('SELECT vector_id AS vectorId')){const all=statement.all.bind(statement);statement.all=async()=>{if(!restored){restored=true;await store.restore(token,'s1',memory.id,2,'restore');await jobs.index(await jobs.claim());}return all();};}return statement;};
  await jobs.index(deletion);
  assert.equal(restored,true);assert.ok([...vectors.values()].some(value=>value.metadata.revision===3));
 } finally {db.close();}
});

for(const flag of [undefined,'false','true']) test('automatic memory erasure requires explicit opt-in: '+String(flag),async()=>{
 const {db,token}=await fixture();
 try {
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'Retained original'},'create');await store.remove(token,'s1',memory.id,1,'delete');
  db.raw.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,available_at,created_at) VALUES('transient','s1',0,'ingest',?,?)").run(at,at);
  db.raw.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,ciphertext,proposals,expires_at,created_at) VALUES('transient','alice','s1','session:alice','encrypted-temporary','[]',?,?)").run(at+1,at);
  db.raw.prepare("INSERT INTO release_export_sessions(id,account_id,space_id,watermark,expires_at,created_at) VALUES('export','alice','s1',0,?,?)").run(at+1,at);
  await new Jobs({DB:db,...(flag===undefined?{}:{AUTO_ERASURE_ENABLED:flag})},()=>at+31*86400000).maintain();
  const current=db.raw.prepare('SELECT body,erased_at FROM memories WHERE id=?').get(memory.id);
  assert.equal(current.body,flag==='true'?'[erased]':'Retained original');assert.equal(current.erased_at!==null,flag==='true');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM memory_versions WHERE memory_id=?').get(memory.id).n,flag==='true'?0:1);
  const transient=db.raw.prepare("SELECT ciphertext,proposals,state FROM release_ingests WHERE id='transient'").get();assert.equal(transient.ciphertext,null);assert.equal(transient.proposals,null);assert.equal(transient.state,'expired');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_export_sessions').get().n,0);
 } finally {db.close();}
});

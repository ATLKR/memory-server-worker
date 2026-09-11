import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,at,DB} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Search} from '../../src/release/search.ts';
import {Jobs} from '../../src/release/jobs.ts';
import {Ingest} from '../../src/release/ingest.ts';
import {createRelease} from '../../src/release/extension.ts';

async function setup(){const f=await fixture();if(f.db.raw.prepare('SELECT version FROM release_meta').get().version<16)f.db.raw.exec(readFileSync(new URL('../../retrieval-progress-schema.sql',import.meta.url),'utf8'));return f;}
function capture(db){const queries=[],prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql),bind=s.bind.bind(s);s.bind=(...values)=>{queries.push({sql,values});return bind(...values);};return s;};return queries;}
const plan=(db,q)=>db.raw.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.values).map(r=>r.detail).join('\n');
async function tombstone(db,token,count=600){
 const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'private'},'create');
 await store.remove(token,'s1',memory.id,1,'delete');db.raw.exec("UPDATE release_jobs SET state='done'");await store.erase(token,'s1',memory.id,2,memory.id,'erase');
 const ids=Array.from({length:count},(_,n)=>'vector-'+String(n).padStart(4,'0'));for(const id of ids)db.raw.prepare('INSERT INTO release_vector_refs VALUES(?,?,1)').run(memory.id,id);
 return{memory,jobId:memory.id+':3',ids};
}

test('asynchronous successful deletion of six pages preserves failure history and eventually confirms erasure',async()=>{
 const {db,token}=await setup();let now=at;try{
  const {jobId,ids}=await tombstone(db,token),vectors=new Set(ids),accepted=new Map();let deletes=0,checks=0;
  db.raw.prepare('UPDATE release_jobs SET attempt=2 WHERE id=?').run(jobId);
  const index={async deleteByIds(page){deletes++;for(const id of page)accepted.set(id,now+1000);},async getByIds(page){checks++;for(const [id,visibleAt] of accepted)if(visibleAt<=now){vectors.delete(id);accepted.delete(id);}return page.filter(id=>vectors.has(id)).map(id=>({id}));}};
  for(let invocation=0;invocation<8;invocation++){
   // A new worker object proves pending requests survive invocation boundaries.
   await new Jobs({DB:db,MEMORY_INDEX:index},()=>now).drain(5);
   const row=db.raw.prepare('SELECT state,attempt,available_at,last_error FROM release_jobs WHERE id=?').get(jobId);
   assert.notEqual(row.state,'dead');assert.equal(row.attempt,row.state==='done'?3:2,'Visibility waits must retain, not clear or consume, earlier failures');
   if(row.state==='done')break;
   assert.equal(row.last_error,'vector_delete_pending');assert.equal(row.available_at,now+5000);
   assert.equal(db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger').get().vector_erased_at,null);
   now+=5000;
  }
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(jobId).state,'done');assert.equal(vectors.size,0);assert.equal(deletes,6,'Accepted pages must not be resubmitted while awaiting visibility');assert.equal(checks,12);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_vector_refs').get().n,600);assert.notEqual(db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger').get().vector_erased_at,null);
 }finally{db.close();}
});

for(const failing of ['delete','confirm'])test('actual '+failing+' provider errors still exhaust five attempts and keep erasure incomplete',async()=>{
 const {db,token}=await setup();let now=at,calls=0,deletes=0;try{
  const {jobId}=await tombstone(db,token,1),index={async deleteByIds(){deletes++;if(failing==='delete'){calls++;throw Error('network unavailable');}},async getByIds(ids){if(failing==='delete')return ids.map(id=>({id}));calls++;throw Error('network unavailable');}};
  const jobs=new Jobs({DB:db,MEMORY_INDEX:index},()=>now);
  for(let n=0;n<5;n++){await jobs.drain(1);now=Math.max(now+60000,db.raw.prepare('SELECT cleanup_retry_at FROM release_jobs WHERE id=?').get(jobId).cleanup_retry_at);}
  const row=db.raw.prepare('SELECT state,attempt,last_error FROM release_jobs WHERE id=?').get(jobId);assert.deepEqual({...row},{state:'dead',attempt:5,last_error:'provider_or_processing_failure'});assert.equal(calls,5);assert.equal(deletes,failing==='delete'?5:1);
  await jobs.drain(5);assert.equal(calls,5);assert.equal(db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger').get().vector_erased_at,null);
 }finally{db.close();}
});

test('accepted deletion that remains visible stays observable and never resubmits or confirms early',async()=>{
 const {db,token}=await setup();let now=at,deletes=0;try{
  const {jobId}=await tombstone(db,token,1),jobs=new Jobs({DB:db,MEMORY_INDEX:{async deleteByIds(){deletes++;},async getByIds(ids){return ids.map(id=>({id}));}}},()=>now);
  for(let n=0;n<8;n++){await jobs.drain(5);now+=5000;}
  const row=db.raw.prepare('SELECT state,attempt,last_error,cleanup_cursor,cleanup_pending FROM release_jobs WHERE id=?').get(jobId);
  assert.equal(row.state,'pending');assert.equal(row.attempt,0);assert.equal(row.last_error,'vector_delete_pending');assert.equal(row.cleanup_cursor,'');assert.equal(JSON.parse(row.cleanup_pending).length,1);assert.equal(deletes,1);
  assert.equal(db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger').get().vector_erased_at,null);
 }finally{db.close();}
});

for(const body of ['ＡＢＣ','ﬃ','한글','Café'])test('identical Unicode query finds its original stored '+body+' token',async()=>{
 const {db,token}=await setup();try{
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body},'unicode');
  await store.create(token,'s1',{body:'ABC ffi unrelated ASCII'},'ascii');
  const result=await new Search({DB:db},()=>at).query(token,'s1',body,10,'search');assert.ok(result.results.some(r=>r.id===memory.id));
  if(body==='ＡＢＣ'||body==='ﬃ')assert.deepEqual(result.results.map(r=>r.id),[memory.id]);
  assert.equal(db.raw.prepare('SELECT body FROM release_fts WHERE memory_id=?').get(memory.id).body,body,'Source and derived text remain unchanged');
 }finally{db.close();}
});

test('operational lists seek the caller Space and account in display order',async()=>{
 const {db,token}=await setup();try{
  const insertJob=db.raw.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,available_at,created_at) VALUES(?,?,0,'ingest',?,?)"),insertIngest=db.raw.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,ciphertext,expires_at,created_at) VALUES(?,?,?,?,'source',?,?)");
  for(const [prefix,account,space,count] of [['foreign','bob','s2',1000],['local','alice','s1',110]])for(let n=0;n<count;n++){const id=prefix+'-'+String(n).padStart(4,'0');insertJob.run(id,space,at,at+n);insertIngest.run(id,account,space,'session:'+account,at+900000,at+n);}
  const queries=capture(db),release=createRelease({DB:db,PUBLIC_ORIGIN:'https://memory.example.test'},{clock:()=>at});
  const get=async tail=>{const response=await release.route(new Request('https://memory.example.test/v1/spaces/s1/'+tail),token);assert.equal(response.status,200);return(await response.json()).results;};
  const ingests=await get('ingests'),jobs=await get('jobs');assert.equal(ingests.length,50);assert.equal(jobs.length,100);assert.ok([...ingests,...jobs].every(r=>r.id.startsWith('local-')));assert.equal(ingests[0].id,'local-0109');assert.equal(jobs[0].id,'local-0109');
  const old=new DB();old.migrate(15);try{
   const indexes=['release_ingests_account_space_created','release_jobs_space_created'];
   for(const name of indexes)assert.equal(old.raw.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(name),undefined,'Index is absent before migration16');
   // Current authority SQL needs the current schema. Preserve the historical
   // index comparison by removing only the two migration16 indexes afterwards.
   for(const source of ['retrieval-progress','vector-reconciliation','outbound-share','execution-time','domain-verification','domain-retention','payload','operational','lifecycle','queue-episode'])old.raw.exec(readFileSync(new URL('../../'+source+'-schema.sql',import.meta.url),'utf8'));
   for(const name of indexes)old.raw.exec('DROP INDEX '+name);
   for(const q of queries.filter(q=>q.sql.includes('ORDER BY i.created_at')||q.sql.includes('ORDER BY created_at DESC,id'))){assert.match(plan(old,q),/SCAN (?:i|release_jobs)\b/);assert.doesNotMatch(plan(db,q),/SCAN (?:i|release_jobs)\b|TEMP B-TREE/);assert.match(plan(db,q),/release_(?:ingests_account_space_created|jobs_space_created)/);}
  }finally{old.close();}
 }finally{db.close();}
});

test('rebuild visits only its Space and preserves a leased current job',async()=>{
 const {db,token,other}=await setup();try{
  const store=new MemoryStore(db,()=>at),live=await store.create(token,'s1',{body:'live'},'live'),deleted=await store.create(token,'s1',{body:'deleted'},'deleted');await store.remove(token,'s1',deleted.id,1,'remove');
  const foreign=await store.create(other,'s2',{body:'foreign'},'foreign');db.raw.exec("UPDATE release_jobs SET state='done'");
  db.raw.prepare("UPDATE release_jobs SET state='leased',lease_token='other-worker',lease_until=?,cleanup_pending='[\"leased-vector\"]' WHERE id=?").run(at+1000,live.id+':1');
  db.raw.prepare("UPDATE release_jobs SET cleanup_pending='[\"stalled-vector\"]' WHERE id=?").run(deleted.id+':2');
  const queries=capture(db);await new Search({DB:db,BACKGROUND_JOBS_ENABLED:'true',AI:{},MEMORY_INDEX:{}},()=>at).rebuild(token,'s1');
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(live.id+':1').state,'leased');assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(deleted.id+':2').state,'pending');assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(foreign.id+':1').state,'done');
  assert.equal(db.raw.prepare('SELECT cleanup_pending FROM release_jobs WHERE id=?').get(live.id+':1').cleanup_pending,'["leased-vector"]');
  assert.equal(db.raw.prepare('SELECT cleanup_pending FROM release_jobs WHERE id=?').get(deleted.id+':2').cleanup_pending,'[]','Explicit rebuild may resubmit a stalled unleased request');
  const q=queries.find(q=>q.sql.startsWith('INSERT INTO release_jobs'));assert.ok(q);assert.match(plan(db,q),/SEARCH r USING .*release_memories_space_all.*space_id=\?/);assert.doesNotMatch(plan(db,q),/SCAN r\b/);
 }finally{db.close();}
});

for(const role of [['user'],{toString:null}])test('ingestion rejects a non-string role without reserving usage: '+JSON.stringify(role),async()=>{
 const {db,token}=await setup();try{
  const ingest=new Ingest({DB:db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{}},()=>at);
  await assert.rejects(()=>ingest.submit(token,'s1',{messages:[{id:'m',role,content:'private'}]},'submit'),e=>e.status===400&&e.code==='invalid_messages');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_operations').get().n,0);
 }finally{db.close();}
});

for(const kind of [['fact'],{toString:null}])test('extraction rejects a non-string provider kind before creating review proposals: '+JSON.stringify(kind),async()=>{
 const {db,token}=await setup();try{
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){return{response:{memories:[{body:'private',kind,sourceMessageId:'m',quote:'private'}]}};}}};
  const ingest=new Ingest(env,()=>at),jobs=new Jobs(env,()=>at);jobs.ingest=j=>ingest.process(j);
  const submission=await ingest.submit(token,'s1',{messages:[{id:'m',role:'user',content:'private'}]},'submit');
  await assert.rejects(async()=>ingest.process(await jobs.claim()),e=>e.status===502&&e.code==='invalid_extraction');
  assert.equal(db.raw.prepare('SELECT proposals FROM release_ingests WHERE id=?').get(submission.id).proposals,null);
 }finally{db.close();}
});

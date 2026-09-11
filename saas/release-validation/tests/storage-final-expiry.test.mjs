import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {Ingest} from '../../src/release/ingest.ts';
import {Jobs} from '../../src/release/jobs.ts';

function afterFirst(db,match,change){const prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql);if(match(sql)){const first=s.first.bind(s);s.first=async()=>{const result=await first();change(result);return result;};}return s;};}

for(const expiry of ['credential','membership','lease','ingest'])test('ingest discloses no source when '+expiry+' expires during the final authorized read',async()=>{
 const {db,token}=await fixture();let now=at,calls=0,reads=0;
 try{
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){calls++;return{response:{memories:[]}};}}};
  const ingest=new Ingest(env,()=>now),jobs=new Jobs(env,()=>now);jobs.ingest=job=>ingest.process(job);
  const request=await ingest.submit(token,expiry==='membership'?'so':'s1',{messages:[{id:'m',role:'user',content:'Private conversation'}]},'submit'),job=await jobs.claim();
  if(expiry==='credential')db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+1);
  if(expiry==='membership')db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+1);
  if(expiry==='lease')db.raw.prepare('UPDATE release_jobs SET lease_until=? WHERE id=?').run(at+1,request.id);
  if(expiry==='ingest')db.raw.prepare('UPDATE release_ingests SET expires_at=? WHERE id=?').run(at+1,request.id);
  afterFirst(db,sql=>sql.startsWith('SELECT i.ciphertext'),()=>{if(++reads===2)now=at+2;});
  await assert.rejects(()=>ingest.process(job),error=>error.status===403);assert.equal(reads,2);assert.equal(calls,0);
 }finally{db.close();}
});

for(const stage of ['embedding','upsert'])test('indexing starts no '+stage+' after the final eligibility read crosses lease expiry',async()=>{
 const {db,token}=await fixture();let now=at;const calls=[];
 try{
  const memory=await new MemoryStore(db,()=>now).create(token,'s1',{body:'Index source'},'create');
  const env={DB:db,AI:{async run(){calls.push('embedding');return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async upsert(){calls.push('upsert');}}};
  const jobs=new Jobs(env,()=>now),job=await jobs.claim();
  afterFirst(db,sql=>sql.startsWith('SELECT EXISTS('),()=>{if(stage==='embedding'||calls.includes('embedding'))now=db.raw.prepare('SELECT lease_until FROM release_jobs WHERE id=?').get(job.id).lease_until+1;});
  await assert.rejects(()=>jobs.index(job),/lease_lost/);assert.deepEqual(calls,stage==='embedding'?[]:['embedding']);
  assert.equal(db.raw.prepare('SELECT revision FROM memories WHERE id=?').get(memory.id).revision,1);
 }finally{db.close();}
});

for(const stage of ['delete','confirm'])test('vector cleanup starts no '+stage+' call after lease expiry',async()=>{
 const {db,token}=await fixture();let now=at;const calls=[];
 try{
  const store=new MemoryStore(db,()=>now),memory=await store.create(token,'s1',{body:'Index source'},'create');await store.remove(token,'s1',memory.id,1,'delete');
  db.raw.prepare("UPDATE release_jobs SET state='done' WHERE revision=1").run();db.raw.prepare('INSERT INTO release_vector_refs VALUES(?,?,1)').run(memory.id,'old-vector');
  const env={DB:db,MEMORY_INDEX:{async deleteByIds(){calls.push('delete');if(stage==='confirm')now=db.raw.prepare('SELECT lease_until FROM release_jobs WHERE id=?').get(memory.id+':2').lease_until+1;},async getByIds(){calls.push('confirm');return[];}}};
  const jobs=new Jobs(env,()=>now),job=await jobs.claim();
  if(stage==='delete'){let renewals=0;const prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('UPDATE release_jobs SET lease_until=MAX')){const run=s.run.bind(s);s.run=async()=>{const result=await run();if(++renewals===2)now=db.raw.prepare('SELECT lease_until FROM release_jobs WHERE id=?').get(job.id).lease_until+1;return result;};}return s;};}
  await assert.rejects(()=>jobs.index(job),/lease_lost/);assert.deepEqual(calls,stage==='delete'?[]:['delete']);
 }finally{db.close();}
});

for(const expiry of ['credential','membership'])test('Space listing filters '+expiry+' expiry crossed during its final snapshot',async()=>{
 const {db,token}=await fixture();let now=at;
 try{
  db.raw.prepare(expiry==='credential'?"UPDATE credentials SET expires_at=? WHERE id='session:alice'":"UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+1);
  afterFirst(db,sql=>sql.includes('AS spaceIds'),()=>{now=at+2;});
  if(expiry==='credential')await assert.rejects(()=>new MemoryStore(db,()=>now).spaces(token),error=>error.status===401);
  else {const page=await new MemoryStore(db,()=>now).spaces(token);assert.deepEqual(page.results.map(row=>row.id),['s1']);}
 }finally{db.close();}
});

for(const expiry of ['credential','grantor','share'])test('invitation listing filters '+expiry+' expiry crossed during its final snapshot',async()=>{
 const {db,token,other}=await fixture();let now=at;
 try{
  const transfers=new Transfers(db,()=>now),share=await transfers.share(token,'so','bob@example.com',1);
  db.raw.prepare('UPDATE credentials SET expires_at=?').run(at+2*86400000);
  if(expiry==='credential')db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:bob'").run(at+1);
  if(expiry==='grantor')db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+1);
  afterFirst(db,sql=>sql.includes('AS shareIds'),()=>{now=expiry==='share'?share.expiresAt+1:at+2;});
  if(expiry==='credential')await assert.rejects(()=>transfers.invitations(other),error=>error.status===403);
  else assert.deepEqual((await transfers.invitations(other)).results,[]);
 }finally{db.close();}
});

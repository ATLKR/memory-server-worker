import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Search} from '../../src/release/search.ts';
import {Jobs} from '../../src/release/jobs.ts';
import {Ingest} from '../../src/release/ingest.ts';
import {Transfers} from '../../src/release/transfer.ts';

function afterRows(db,prefix,mutate) {
 const prepare=db.prepare.bind(db);let changed=false;
 db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith(prefix)){
  const all=statement.all.bind(statement);statement.all=async()=>{const result=await all();if(!changed){changed=true;await mutate();}return result;};
 }return statement;};
 return()=>changed;
}

for(const change of ['credential','expiry','account','membership','share'])test('Space listing withholds metadata after '+change+' authority loss',async()=>{
 const {db,token,other}=await fixture();
 try {
  const transfers=new Transfers(db,()=>at);let caller=token,shared;
  if(change==='share'){shared=await transfers.share(token,'s1','bob@example.com');await transfers.accept(other,shared.id);caller=other;}
  const changed=afterRows(db,'SELECT s.id,s.name',()=>{
   if(change==='credential')db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'");
   if(change==='expiry')db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);
   if(change==='account')db.raw.exec("UPDATE accounts SET disabled_at=1 WHERE id='alice'");
   if(change==='membership')db.raw.exec("UPDATE memberships SET revoked_at=1 WHERE id='m1'");
   if(change==='share')db.raw.prepare('UPDATE release_shares SET revoked_at=1 WHERE id=?').run(shared.id);
  });
  const listing=()=>new MemoryStore(db,()=>at).spaces(caller);
  if(['credential','expiry','account'].includes(change))await assert.rejects(listing,error=>[401,403].includes(error.status));
  else {const result=await listing();assert.ok(!result.results.some(row=>row.id===(change==='membership'?'so':'s1')));assert.ok(result.results.length);}
  assert.equal(changed(),true);
 }finally{db.close();}
});

for(const boundary of ['before-embedding','before-index'])for(const change of ['credential','account','organization'])test('search prevents provider work after '+change+' loss '+boundary,async()=>{
 const {db,token}=await fixture();const sent=[];
 try {
  const mutate=()=>db.raw.exec(change==='credential'?"UPDATE credentials SET revoked_at=1 WHERE id='session:alice'":change==='account'?"UPDATE accounts SET disabled_at=1 WHERE id='alice'":"UPDATE organizations SET disabled_at=1 WHERE id='org'");
  if(boundary==='before-embedding')afterRows(db,'/* lexical-candidates */',mutate);
  const env={DB:db,AI:{async run(){sent.push('embedding');if(boundary==='before-index')mutate();return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async query(){sent.push('index');return{matches:[]};}}};
  await assert.rejects(()=>new Search(env,()=>at).query(token,change==='organization'?'so':'s1','private query',10,'search'),error=>error.status===403);
  assert.deepEqual(sent,boundary==='before-embedding'?[]:['embedding']);
 }finally{db.close();}
});

for(const state of ['cancelled','expired','review','approved'])for(const boundary of ['before-claim','during-provider'])test('terminal '+state+' ingest stops automatic retries '+boundary,async()=>{
 const {db,token}=await fixture();let now=at,calls=0,ingestId;
 try {
  const terminal=()=>{if(state==='expired')now=at+86400001;else db.raw.prepare('UPDATE release_ingests SET state=?,ciphertext=NULL WHERE id=?').run(state,ingestId);};
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){calls++;terminal();throw Error('provider result arrived after terminal decision');}}};
  const ingest=new Ingest(env,()=>now),jobs=new Jobs(env,()=>now);jobs.ingest=job=>ingest.process(job);
  ingestId=(await ingest.submit(token,'s1',{messages:[{id:'msg1',role:'user',content:'Private source'}]},'submit')).id;
  if(boundary==='before-claim')terminal();
  for(let n=0;n<3;n++){await jobs.drain(1);now+=100000;}
  assert.equal(calls,boundary==='before-claim'?0:1);
  assert.deepEqual({...db.raw.prepare('SELECT state,attempt,last_error FROM release_jobs WHERE id=?').get(ingestId)},{state:'done',attempt:boundary==='before-claim'?0:1,last_error:null});
 }finally{db.close();}
});

for(const change of ['share','grantor-membership'])test('invitations withhold source Space metadata after '+change+' loss',async()=>{
 const {db,token,other}=await fixture();
 try {
  const transfers=new Transfers(db,()=>at),share=await transfers.share(token,'so','bob@example.com');
  const changed=afterRows(db,'SELECT sh.id,sh.space_id AS spaceId',()=>{
   if(change==='share')db.raw.prepare('UPDATE release_shares SET revoked_at=1 WHERE id=?').run(share.id);
   else db.raw.exec("UPDATE memberships SET revoked_at=1 WHERE id='m1'");
  });
  assert.deepEqual((await transfers.invitations(other)).results,[]);assert.equal(changed(),true);
 }finally{db.close();}
});

test('sharing to a disabled recipient returns the expected unavailable response',async()=>{
 const {db,token}=await fixture();
 try {
  db.raw.exec("UPDATE accounts SET disabled_at=1 WHERE id='bob'");
  await assert.rejects(()=>new Transfers(db,()=>at).share(token,'s1','bob@example.com'),error=>error.status===403&&error.code==='recipient_or_authority_unavailable');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,0);
 }finally{db.close();}
});

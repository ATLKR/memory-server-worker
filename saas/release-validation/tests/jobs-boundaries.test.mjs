import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Jobs} from '../../src/release/jobs.ts';

for(const boundary of ['before-embedding','before-upsert'])for(const owner of ['account','organization'])test('disabled '+owner+' prevents new provider work '+boundary,async()=>{
 const {db,token}=await fixture();const sent=[];
 try {
  const spaceId=owner==='account'?'s1':'so',store=new MemoryStore(db,()=>at);
  await store.create(token,spaceId,{body:'Private tenant content'},'create');
  const disable=()=>db.raw.exec(owner==='account'?"UPDATE accounts SET disabled_at=1 WHERE id='alice'":"UPDATE organizations SET disabled_at=1 WHERE id='org'");
  const env={DB:db,AI:{async run(){sent.push('embedding');return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async upsert(){sent.push('upsert');},async deleteByIds(){},async getByIds(){return[];}}};
  if(boundary==='before-embedding')disable();
  else {
   const prepare=db.prepare.bind(db);
   db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('INSERT INTO release_vector_refs')){const run=statement.run.bind(statement);statement.run=async()=>{const result=await run();disable();return result;};}return statement;};
  }
  await new Jobs(env,()=>at).drain(1);
  assert.deepEqual(sent,boundary==='before-embedding'?[]:['embedding']);
 }finally{db.close();}
});

for(const change of ['update','delete','erase','lease-expired','lease-replaced'])test('new vector upsert is fenced after '+change+' during reference persistence',async()=>{
 const {db,token}=await fixture();let now=at,upserts=0,changed=false;
 try {
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'Original private content'},'create');
  const env={DB:db,AI:{async run(){return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async upsert(){upserts++;},async deleteByIds(){},async getByIds(){return[];}}};
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('INSERT INTO release_vector_refs')){const run=statement.run.bind(statement);statement.run=async()=>{
   const result=await run();if(!changed){changed=true;
    if(change==='update')await store.update(token,'s1',memory.id,{body:'New current content',expectedRevision:1},'update');
    else if(change==='lease-expired')now+=120001;
    else if(change==='lease-replaced')db.raw.prepare('UPDATE release_jobs SET lease_token=? WHERE memory_id=?').run('replacement-owner',memory.id);
    else {await store.remove(token,'s1',memory.id,1,'delete');if(change==='erase')await store.erase(token,'s1',memory.id,2,memory.id,'erase');}
   }return result;
  };}return statement;};
  await new Jobs(env,()=>now).drain(1);
  assert.equal(changed,true);assert.equal(upserts,0,'No new provider request may receive the old vector');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_vector_refs WHERE memory_id=?').get(memory.id).n,1,'Identifier-only reference remains available for cleanup');
  if(change==='lease-expired'){
   assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE memory_id=?').get(memory.id).state,'leased','An expired owner cannot release its lease');
   const recovered=await new Jobs(env,()=>now).claim();assert.equal(recovered.memoryId,memory.id);assert.equal(recovered.attempt,2,'A new claim can recover abandoned work');
  }
 }finally{db.close();}
});

for(const change of ['logout','expiry','membership-revocation'])test('canonical organization indexing survives writer '+change,async()=>{
 const {db,token}=await fixture();let upserts=0;
 try {
  await new MemoryStore(db,()=>at).create(token,'so',{body:'Organization-owned fact'},'create');
  if(change==='logout')db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'");
  else if(change==='expiry')db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);
  else db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m1'").run(at);
  const env={DB:db,AI:{async run(){return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async upsert(){upserts++;},async deleteByIds(){},async getByIds(){return[];}}};
  await new Jobs(env,()=>at).drain(1);assert.equal(upserts,1);
 }finally{db.close();}
});

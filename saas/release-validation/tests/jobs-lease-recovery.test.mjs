import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {Jobs} from '../../src/release/jobs.ts';

function enqueue(db,id,kind='upsert') {
 db.raw.prepare('INSERT INTO release_jobs(id,space_id,revision,kind,available_at,created_at) VALUES(?,\'s1\',0,?,?,?)').run(id,kind,at,at);
 if(kind==='ingest')db.raw.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,ciphertext,expires_at,created_at) VALUES(?,'alice','s1','session:alice','encrypted',?,?)").run(id,at+86400000,at);
}
function worker(db,clock) {
 const jobs=new Jobs({DB:db,AI:{},MEMORY_INDEX:{},PAYLOAD_KEY:Buffer.alloc(32,7).toString('base64url')},clock);
 jobs.ingest=async()=>{};
 return jobs;
}

for(const kind of ['upsert','delete','ingest'])test(kind+' lease recovery stops after five abandoned attempts',async()=>{
 const {db}=await fixture();let now=at;
 try {
  enqueue(db,'abandoned',kind);const jobs=worker(db,()=>now);
  for(let attempt=1;attempt<=5;attempt++){
   const claimed=await jobs.claim();assert.equal(claimed.id,'abandoned');assert.equal(claimed.attempt,attempt);
   assert.equal(await jobs.claim(),null,'The current worker must keep its live lease');
   now+=120001;
  }
  assert.equal(await jobs.claim(),null,'An exhausted crash must not start attempt six');
  const failed=db.raw.prepare('SELECT state,attempt,last_error,lease_token,lease_until FROM release_jobs WHERE id=?').get('abandoned');
  assert.deepEqual({...failed},{state:'dead',attempt:5,last_error:'lease_expired_attempts_exhausted',lease_token:null,lease_until:null});
  db.raw.prepare("UPDATE release_jobs SET state='pending',attempt=0,available_at=?,last_error=NULL WHERE id='abandoned'").run(now);
  assert.equal((await jobs.claim()).attempt,1,'An explicit retry may start a new retry budget');
 }finally{db.close();}
});

test('exhausted lease cleanup is bounded and does not block later eligible work',async()=>{
 const {db}=await fixture();
 try {
  for(let n=0;n<105;n++)enqueue(db,'abandoned-'+String(n).padStart(3,'0'));
  db.raw.prepare("UPDATE release_jobs SET state='leased',attempt=5,lease_token='lost-worker',lease_until=?").run(at);
  enqueue(db,'ready');
  const jobs=worker(db,()=>at);
  assert.equal((await jobs.claim()).id,'ready');
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='dead'").get().n,100);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='leased' AND attempt=5").get().n,5);
  assert.equal(await jobs.claim(),null);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='dead'").get().n,105);
 }finally{db.close();}
});

for(const state of ['cancelled','review','approved','expired'])test('terminal '+state+' ingest wins over exhausted lease failure',async()=>{
 const {db}=await fixture();
 try {
  enqueue(db,'terminal','ingest');
  db.raw.prepare("UPDATE release_jobs SET state='leased',attempt=5,lease_token='lost-worker',lease_until=? WHERE id='terminal'").run(at);
  db.raw.prepare('UPDATE release_ingests SET state=? WHERE id=?').run(state,'terminal');
  assert.equal(await worker(db,()=>at).claim(),null);
  assert.deepEqual({...db.raw.prepare("SELECT state,attempt,last_error,lease_token,lease_until FROM release_jobs WHERE id='terminal'").get()},
   {state:'done',attempt:5,last_error:null,lease_token:null,lease_until:null});
 }finally{db.close();}
});

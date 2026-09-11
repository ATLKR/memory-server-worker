import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {Jobs} from '../../src/release/jobs.ts';
import {Ingest} from '../../src/release/ingest.ts';
import {createRelease} from '../../src/release/extension.ts';

for(const state of ['cancelled','missing','approved','other-account','revoked-before-update'])test('ingest cancellation returns a truthful authorized result for '+state,async()=>{
 const {db,token,other}=await fixture();
 try{
  const env={DB:db,PUBLIC_ORIGIN:'https://memory.example.com',BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){return{response:{memories:[{body:'Fact',kind:'fact',sourceMessageId:'u1',quote:'private source'}]}};}}};
  const ingest=new Ingest(env,()=>at),release=createRelease(env,{clock:()=>at}),jobs=new Jobs(env,()=>at);jobs.ingest=job=>ingest.process(job);
  const started=await ingest.submit(token,'s1',{messages:[{id:'u1',role:'user',content:'private source'}]},'cancel-check');
  const request=id=>new Request('https://memory.example.com/v1/spaces/s1/ingests/'+id,{method:'DELETE'});
  if(state==='approved'){await jobs.drain(1);await ingest.approve(token,'s1',started.id,[0],'approval');}
  if(state==='cancelled')assert.equal((await release.route(request(started.id),token)).status,204);
  if(state==='revoked-before-update'){
   const prepare=db.prepare.bind(db);
   db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE release_ingests SET ciphertext=NULL')){const run=statement.run.bind(statement);statement.run=async()=>{db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at);return run();};}return statement;};
  }
  const response=await release.route(request(state==='missing'?'not-found':started.id),state==='other-account'?other:token);
  assert.equal(response.status,state==='cancelled'?204:state==='missing'?404:state==='approved'?409:403);
  const current=db.raw.prepare('SELECT state,ciphertext FROM release_ingests WHERE id=?').get(started.id);
  assert.equal(current.state,state==='approved'?'approved':state==='cancelled'?'cancelled':'queued');
  assert.equal(db.raw.prepare('SELECT count(*) AS n FROM memories').get().n,state==='approved'?1:0);
 }finally{db.close();}
});

test('exhausted ingestion exposes failed status and manual retry returns it to queued',async()=>{
 const {db,token}=await fixture();let now=at,unavailable=true;
 try {
  const env={DB:db,PUBLIC_ORIGIN:'https://memory.example.com',REQUEST_LIMITER:{async limit(){return{success:true};}},BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){if(unavailable)throw Error('offline');return{response:{memories:[{body:'Reviewed fact',kind:'fact',sourceMessageId:'msg1',quote:'private fact'}]}};}}};
  const ingest=new Ingest(env,()=>now),jobs=new Jobs(env,()=>now),release=createRelease(env,{clock:()=>now});jobs.ingest=job=>ingest.process(job);
  const source={messages:[{id:'msg1',role:'user',content:'A private fact'}]},started=await ingest.submit(token,'s1',source,'submit');
  for(let n=0;n<5;n++){await jobs.drain(1);now+=100000;}
  const list=async()=>{const response=await release.route(new Request('https://memory.example.com/v1/spaces/s1/ingests'),token);assert.equal(response.status,200);return(await response.json()).results[0];};
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(started.id).state,'dead');
  assert.equal((await ingest.get(token,'s1',started.id)).state,'failed');assert.equal((await list()).state,'failed');
  assert.deepEqual((await ingest.get(token,'s1',started.id)).proposals,[]);
  db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(now);
  const retried=await release.route(new Request('https://memory.example.com/v1/spaces/s1/jobs/'+started.id+'/retry',{method:'POST'}),token);assert.equal(retried.status,202);
  assert.equal((await ingest.get(token,'s1',started.id)).state,'queued');assert.equal((await list()).state,'queued');
  unavailable=false;await jobs.drain(1);
  assert.equal((await ingest.get(token,'s1',started.id)).state,'review');assert.equal((await list()).state,'review');
 }finally{db.close();}
});

for(const terminal of ['cancelled','expired'])test('failed ingestion can become '+terminal+' without exposing retained source',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  const env={DB:db,PUBLIC_ORIGIN:'https://memory.example.com',REQUEST_LIMITER:{async limit(){return{success:true};}},BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){throw Error('offline');}}};
  const ingest=new Ingest(env,()=>now),jobs=new Jobs(env,()=>now),release=createRelease(env,{clock:()=>now});jobs.ingest=job=>ingest.process(job);
  const started=await ingest.submit(token,'s1',{messages:[{id:'msg1',role:'user',content:'Private retained source'}]},'submit');
  for(let n=0;n<5;n++){await jobs.drain(1);now+=100000;}
  if(terminal==='cancelled'){
   const cancelled=await release.route(new Request('https://memory.example.com/v1/spaces/s1/ingests/'+started.id,{method:'DELETE'}),token);assert.equal(cancelled.status,204);
   assert.equal(db.raw.prepare('SELECT ciphertext FROM release_ingests WHERE id=?').get(started.id).ciphertext,null);
  }else {
   db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+172800000);now=at+86400001;
  }
  const response=await ingest.get(token,'s1',started.id);assert.equal(response.state,terminal);assert.deepEqual(response.proposals,[]);assert.ok(!JSON.stringify(response).includes('Private retained source'));
  const list=await release.route(new Request('https://memory.example.com/v1/spaces/s1/ingests'),token);assert.equal((await list.json()).results[0].state,terminal);
 }finally{db.close();}
});

for(const state of ['queued','review','failed','approved','cancelled','expired'])test('create-only ingest submission replay reports current '+state+' without source access',async()=>{
 const {db,token,key}=await fixture();let now=at;
 try {
  db.raw.exec("UPDATE release_credential_policies SET capabilities='[\"create\"]' WHERE credential_id='key:alice'");
  db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id IN ('session:alice','key:alice')").run(at+172800000);
  const env={DB:db,PUBLIC_ORIGIN:'https://memory.example.com',REQUEST_LIMITER:{async limit(){return{success:true};}},BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){if(state==='failed')throw Error('offline');return{response:{memories:[{body:'Private extracted fact',kind:'fact',sourceMessageId:'msg1',quote:'private source'}]}};}}};
  const ingest=new Ingest(env,()=>now),jobs=new Jobs(env,()=>now),release=createRelease(env,{clock:()=>now});jobs.ingest=job=>ingest.process(job);
  const input={messages:[{id:'msg1',role:'user',content:'A private source'}]},started=await ingest.submit(key,'s1',input,'submit');
  if(['review','approved'].includes(state))await jobs.drain(1);
  if(state==='approved')await ingest.approve(token,'s1',started.id,[0],'approve');
  if(state==='failed')for(let n=0;n<5;n++){await jobs.drain(1);now+=100000;}
  if(state==='cancelled')assert.equal((await release.route(new Request('https://memory.example.com/v1/spaces/s1/ingests/'+started.id,{method:'DELETE'}),token)).status,204);
  if(state==='expired')now=at+86400001;
  const units=db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get().n;
  assert.deepEqual(await ingest.submit(key,'s1',input,'submit'),{id:started.id,state,replayed:true});
  assert.equal(db.raw.prepare('SELECT sum(units) n FROM release_usage_events').get().n,units);
  await assert.rejects(()=>ingest.get(key,'s1',started.id),error=>error.status===403);
  now=at+86400001;
  const expiredState=['approved','cancelled'].includes(state)?state:'expired';
  assert.equal((await ingest.submit(key,'s1',input,'submit')).state,expiredState);
  assert.equal((await ingest.get(token,'s1',started.id)).state,expiredState);
  const list=await release.route(new Request('https://memory.example.com/v1/spaces/s1/ingests'),token);
  assert.equal((await list.json()).results[0].state,expiredState);
 }finally{db.close();}
});

for(const kind of ['upsert','delete'])test('manual retry still accepts a dead '+kind+' indexing job',async()=>{
 const {db,token}=await fixture();
 try {
  db.raw.prepare('INSERT INTO release_jobs(id,space_id,revision,kind,state,attempt,available_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run('index-job','s1',1,kind,'dead',5,at,at);
  const release=createRelease({DB:db,PUBLIC_ORIGIN:'https://memory.example.com',REQUEST_LIMITER:{async limit(){return{success:true};}}},{clock:()=>at});
  const response=await release.route(new Request('https://memory.example.com/v1/spaces/s1/jobs/index-job/retry',{method:'POST'}),token);
  assert.equal(response.status,202);assert.deepEqual(await response.json(),{queued:true});
  assert.deepEqual({...db.raw.prepare("SELECT state,attempt FROM release_jobs WHERE id='index-job'").get()},{state:'pending',attempt:0});
 }finally{db.close();}
});

for(const terminal of ['cancelled','expired','missing-source','cancelled-during-retry'])test('dead ingestion retry rejects '+terminal+' source atomically',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+172800000);
  const env={DB:db,PUBLIC_ORIGIN:'https://memory.example.com',REQUEST_LIMITER:{async limit(){return{success:true};}},BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){throw Error('offline');}}};
  const ingest=new Ingest(env,()=>now),jobs=new Jobs(env,()=>now),release=createRelease(env,{clock:()=>now});jobs.ingest=job=>ingest.process(job);
  const started=await ingest.submit(token,'s1',{messages:[{id:'msg1',role:'user',content:'Private source'}]},'submit');
  for(let n=0;n<5;n++){await jobs.drain(1);now+=100000;}
  const cancel=()=>db.raw.prepare("UPDATE release_ingests SET state='cancelled',ciphertext=NULL,proposals=NULL WHERE id=?").run(started.id);
  if(terminal==='cancelled')cancel();
  if(terminal==='expired')now=at+86400001;
  if(terminal==='missing-source')db.raw.prepare('UPDATE release_ingests SET ciphertext=NULL WHERE id=?').run(started.id);
  if(terminal==='cancelled-during-retry'){
   const prepare=db.prepare.bind(db);
   db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith("UPDATE release_jobs SET state='pending',attempt=0")){const run=statement.run.bind(statement);statement.run=async()=>{cancel();return run();};}return statement;};
  }
  db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(now);
  const response=await release.route(new Request('https://memory.example.com/v1/spaces/s1/jobs/'+started.id+'/retry',{method:'POST'}),token);
  assert.equal(response.status,409);assert.equal((await response.json()).error,'job_not_retryable');
  assert.deepEqual({...db.raw.prepare('SELECT state,attempt FROM release_jobs WHERE id=?').get(started.id)},{state:'dead',attempt:5});
 }finally{db.close();}
});

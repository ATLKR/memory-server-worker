import test from 'node:test';import assert from 'node:assert/strict';import {fixture,at} from './db.mjs';import {Jobs} from '../../src/release/jobs.ts';
import {digest} from '../../src/release/util.ts';
let Ingest;try{({Ingest}=await import('../../src/release/ingest.ts'));}catch{}
for(const name of ['encrypted-source','extract-review','approval-retry','fabricated-evidence','revoked-actor','expiry'])test('ingest '+name,async()=>{
 assert.ok(Ingest,'ingest implementation missing');const {db,token}=await fixture();let time=at;const env={DB:db,PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){return {response:{memories:[{body:'연구 프로젝트를 진행한다.',kind:'fact',sourceMessageId:'msg1',quote:name==='fabricated-evidence'?'없는 문장':'연구 프로젝트'}]}};}}};const pipeline=new Ingest(env,()=>time),jobs=new Jobs(env,()=>time);jobs.ingest=j=>pipeline.process(j);
 try{const input={messages:[{id:'msg1',role:'user',content:'나는 연구 프로젝트를 진행한다.'}]};const started=await pipeline.submit(token,'s1',input,'ingest-one');
 if(name==='encrypted-source'){const row=db.raw.prepare('SELECT ciphertext FROM release_ingests').get();assert.ok(!row.ciphertext.includes('연구'));assert.equal((await pipeline.submit(token,'s1',input,'ingest-one')).id,started.id);return;}
 if(name==='revoked-actor')db.raw.exec("UPDATE credentials SET revoked_at="+at+" WHERE id='session:alice'");
 if(name==='expiry')time=at+86400001;
 await jobs.drain(1);
 if(['fabricated-evidence','revoked-actor','expiry'].includes(name)){assert.notEqual(db.raw.prepare('SELECT state FROM release_ingests').get().state,'review');assert.equal(db.raw.prepare('SELECT count(*) n FROM memories').get().n,0);return;}
 const result=await pipeline.get(token,'s1',started.id);assert.equal(result.state,'review');assert.equal(db.raw.prepare('SELECT count(*) n FROM memories').get().n,0);
 const approved=await pipeline.approve(token,'s1',started.id,[0],'approval-one');assert.equal(approved.memories.length,1);assert.equal(db.raw.prepare('SELECT ciphertext FROM release_ingests').get().ciphertext,null);
 if(name==='approval-retry'){await pipeline.approve(token,'s1',started.id,[0],'approval-one');assert.equal(db.raw.prepare('SELECT count(*) n FROM memories').get().n,1);await assert.rejects(()=>pipeline.approve(token,'s1',started.id,[],'approval-two'),e=>e.status===409);}
 }finally{db.close();}
});

for(const phase of ['queued','source-read','provider']) test('organization ingest revocation is fenced at '+phase,async()=>{
 const {db,token,other}=await fixture();let calls=0;
 try {
  const key='d'.repeat(64);
  db.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission) VALUES('org-ingest-key','alice','m1','e1','api_key',?,?,'write')").run(await digest(key),at+900000);
  db.raw.exec("INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES('org-ingest-key','[\"read\",\"create\"]','[\"so\"]')");
  const revoke=()=>db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at,'m1');
  const env={DB:db,PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){calls++;if(phase==='provider')revoke();return {response:{memories:[{body:'Sensitive fact',kind:'fact',sourceMessageId:'u1',quote:'private source'}]}};}}};
  const ingest=new Ingest(env,()=>at),jobs=new Jobs(env,()=>at);jobs.ingest=job=>ingest.process(job);
  const submitted=await ingest.submit(key,'so',{messages:[{id:'u1',role:'user',content:'private source'}]},'ingest');
  if(phase==='queued')revoke();
  if(phase==='source-read'){
   const prepare=db.prepare.bind(db);let revoked=false;
   db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('SELECT i.ciphertext')){const first=statement.first.bind(statement);statement.first=async()=>{const row=await first();if(!revoked){revoked=true;revoke();}return row;};}return statement;};
  }
  await jobs.drain(1);
  assert.equal(calls,phase==='provider'?1:0,'Revoked source must not be sent to AI');
  const row=db.raw.prepare('SELECT ciphertext,proposals,state FROM release_ingests WHERE id=?').get(submitted.id);
  assert.equal(row.proposals,null);assert.notEqual(row.state,'review');assert.ok(!row.ciphertext.includes('private source'));
  assert.equal(db.raw.prepare('SELECT count(*) n FROM memories').get().n,0);
  await assert.rejects(()=>ingest.get(token,'so',submitted.id),e=>e.status===403);
  await assert.rejects(()=>ingest.get(other,'so',submitted.id),e=>e.status===404);
 } finally {db.close();}
});
test('expired extraction quotes are hidden even when cleanup cron is delayed',async()=>{
 const {db,token}=await fixture();try{db.raw.exec(`UPDATE credentials SET expires_at=${at+172800000} WHERE id='session:alice'`);db.raw.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,state,available_at,created_at) VALUES('expired-ingest','s1',0,'ingest','done',?,?)").run(at,at);db.raw.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,proposals,state,expires_at,created_at) VALUES('expired-ingest','alice','s1','session:alice',?,'review',?,?)").run(JSON.stringify([{body:'private',quote:'expired source',sourceMessageId:'u1',kind:'fact'}]),at+86400000,at);
 const response=await new Ingest({DB:db},()=>at+86400001).get(token,'s1','expired-ingest');assert.equal(response.state,'expired');assert.deepEqual(response.proposals,[]);
 }finally{db.close();}
});

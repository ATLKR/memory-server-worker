import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {Ingest} from '../../src/release/ingest.ts';
import {Jobs} from '../../src/release/jobs.ts';
import {digest} from '../../src/release/util.ts';

async function reviewable(t,spaceId='so') {
 const f=await fixture();t.after(()=>f.db.close());
 const env={DB:f.db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){return{response:{memories:[{body:'Private fact',kind:'fact',sourceMessageId:'msg1',quote:'Private fact'}]}};}}};
 const ingest=new Ingest(env,()=>at),jobs=new Jobs(env,()=>at);jobs.ingest=job=>ingest.process(job);
 const submitted=await ingest.submit(f.token,spaceId,{messages:[{id:'msg1',role:'user',content:'Private fact'}]},'submit');
 await jobs.drain(1);
 return {...f,ingest,spaceId,ingestId:submitted.id};
}

function afterRead(db,boundary,mutate) {
 const prepare=db.prepare.bind(db);let changed=false;
 const prefix=boundary==='approved-replay'?'SELECT state,proposals,approval_hash':'SELECT result_ids AS resultIds';
 db.prepare=sql=>{
  const statement=prepare(sql);
  if(sql.startsWith(prefix)) {
   const first=statement.first.bind(statement);
   statement.first=async()=>{const row=await first();if(!changed){changed=true;await mutate();}return row;};
  }
  return statement;
 };
 return ()=>changed;
}

for(const boundary of ['approved-replay','committed-result'])for(const change of ['credential','membership','role','expiry'])test('ingest approval denies '+change+' authority loss after '+boundary+' read',async t=>{
 const f=await reviewable(t);
 if(boundary==='approved-replay')await f.ingest.approve(f.token,f.spaceId,f.ingestId,[0],'approve');
 const mutations={
  credential:"UPDATE credentials SET revoked_at=1 WHERE id='session:alice'",
  membership:"UPDATE memberships SET revoked_at=1 WHERE id='m1'",
  role:"UPDATE memberships SET role='member' WHERE id='m1'",
  expiry:"UPDATE credentials SET expires_at="+at+" WHERE id='session:alice'",
 };
 const changed=afterRead(f.db,boundary,()=>f.db.raw.exec(mutations[change]));
 await assert.rejects(()=>f.ingest.approve(f.token,f.spaceId,f.ingestId,[0],'approve'),error=>error.status===403);
 assert.equal(changed(),true);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories').get().n,1,'Already committed memory must remain committed');
 assert.equal(f.db.raw.prepare("SELECT count(*) n FROM release_operations WHERE action='approve_ingest'").get().n,1);
});

test('overlapping same-key ingest approvals distinguish committed and replayed receipts',async t=>{
 const f=await reviewable(t);let winner;
 const changed=afterRead(f.db,'approved-replay',async()=>{winner=await f.ingest.approve(f.token,f.spaceId,f.ingestId,[0],'approve');});
 const replay=await f.ingest.approve(f.token,f.spaceId,f.ingestId,[0],'approve');
 assert.equal(changed(),true);assert.equal(winner.replayed,false);assert.equal(replay.replayed,true);
 assert.deepEqual(replay.memories,winner.memories);assert.equal(replay.memories.length,1);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories').get().n,1);
 assert.equal(f.db.raw.prepare("SELECT sum(units) n FROM release_usage_events WHERE operation_id IN (SELECT id FROM release_operations WHERE action='approve_ingest')").get().n,1);
});

test('ingest approval and replay accept a current same-account session after original writer logout',async t=>{
 const f=await reviewable(t);
 const replacement='d'.repeat(64);
 f.db.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,permission) VALUES('session:replacement','alice','session',?,?,'write')").run(await digest(replacement),at+900000);
 f.db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'");
 const first=await f.ingest.approve(replacement,f.spaceId,f.ingestId,[0],'approve');
 const replay=await f.ingest.approve(replacement,f.spaceId,f.ingestId,[0],'approve');
 assert.equal(first.replayed,false);assert.equal(replay.replayed,true);assert.deepEqual(replay.memories,first.memories);
 assert.equal(f.db.raw.prepare('SELECT actor_credential_id FROM memories').get().actor_credential_id,'session:replacement');
 await assert.rejects(()=>f.ingest.approve(f.other,f.spaceId,f.ingestId,[0],'approve'),error=>error.status===403);
 await assert.rejects(()=>f.ingest.approve(f.key,f.spaceId,f.ingestId,[0],'approve'),error=>error.status===403);
});

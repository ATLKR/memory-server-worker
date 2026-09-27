import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at,DB} from './db.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {WorkspaceService} from '../../src/workspace.ts';
import {sqliteClock} from '../../dev/sqlite-clock.mjs';
import {MemoryService} from '../../src/memory.ts';
let MemoryStore;try{({MemoryStore}=await import('../../src/release/memory.ts'));}catch{}
const input={body:'사용자 선호: 짧은 설명',provenance:{originKind:'user'}};
test('memory implementation exists',()=>assert.ok(MemoryStore,'MemoryStore is missing'));
for(const scenario of ['idempotent','conflict','isolation','scope','revision','quota','purge','restore','supersession','pagination']) test(scenario,async()=>{
 assert.ok(MemoryStore,'MemoryStore is missing'); const {db,token,other,key}=await fixture(); const store=new MemoryStore(db,()=>at);
 try{
 const first=await store.create(token,'s1',input,'op-1');
 if(scenario==='idempotent'){const second=await store.create(token,'s1',input,'op-1');assert.equal(second.id,first.id);assert.equal((await db.raw.prepare('SELECT count(*) n FROM memories').get()).n,1);}
 if(scenario==='conflict')await assert.rejects(()=>store.create(token,'s1',{...input,body:'different'},'op-1'),e=>e.code==='idempotency_conflict');
 if(scenario==='isolation')await assert.rejects(()=>store.get(other,'s1',first.id),e=>e.status===403);
 if(scenario==='scope'){await store.create(key,'s1',input,'key-op');await assert.rejects(()=>store.remove(key,'s1',first.id,1,'key-delete'),e=>e.status===403);}
 if(scenario==='revision'){await store.update(token,'s1',first.id,{body:'new',expectedRevision:1},'op-2');await assert.rejects(()=>store.update(token,'s1',first.id,{body:'stale',expectedRevision:1},'op-3'),e=>e.status===409);assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n,2);}
 if(scenario==='quota'){(await db.raw.exec("UPDATE release_pools SET monthly_units=1 WHERE id='account:alice'"));await assert.rejects(()=>store.create(token,'s1',input,'over-limit'),e=>e.status===429);assert.equal((await db.raw.prepare('SELECT count(*) n FROM memories').get()).n,1);}
 if(scenario==='purge'){await store.remove(token,'s1',first.id,1,'delete');await store.erase(token,'s1',first.id,2,first.id,'erase');assert.equal((await db.raw.prepare('SELECT body FROM memories').get()).body,'[erased]');assert.equal((await db.raw.prepare('SELECT count(*) n FROM memory_versions').get()).n,0);await assert.rejects(()=>store.get(token,'s1',first.id),e=>e.status===404);}
 if(scenario==='restore'){await store.remove(token,'s1',first.id,1,'delete');const restored=await store.restore(token,'s1',first.id,2,'restore');assert.equal(restored.revision,3);assert.equal(restored.deletedAt,null);}
 if(scenario==='supersession'){const latest=await store.create(token,'s1',{body:'new fact',supersedesMemoryId:first.id},'replace');const list=await store.list(token,'s1');assert.deepEqual(list.results.map(x=>x.id),[latest.id]);}
 if(scenario==='pagination'){for(let i=0;i<105;i++)(await db.raw.prepare(`INSERT INTO memory_control.spaces(id,owner_account_id,organization_id,deployment_id,data_policy,source_byte_limit,message_limit,name,security_mode,created_at_ms,actor_credential_id) VALUES(?, 'alice',NULL,'memory-sg',(SELECT data_policy FROM memory_control.spaces WHERE id='s1'),67108864,100000,?,'managed',?,'session:alice')`).run('extra-'+i,'Extra',at));let cursor,ids=[];do{const page=await store.spaces(token,{limit:50,cursor});ids.push(...page.results.map(x=>x.id));cursor=page.nextCursor;}while(cursor);assert.equal(new Set(ids).size,107);}
 }finally{db.close();}
});

async function productionFixture() {
 // The PostgreSQL lineage has no staged foundation→release upgrade; an account
 // signed in through the workspace command path exercises the same authority
 // rows the release store reads.
 const db=new DB();await db.migrate();
 const workspace=new WorkspaceService(db,()=>at);
 const session=await workspace.signIn({issuer:'https://issuer.example',subject:'release-review',email:'review@example.com',emailVerified:true,expiresAt:at+900000,permission:'write'});
 const spaceId=(await db.raw.prepare('SELECT id FROM memory_control.spaces WHERE owner_account_id=?').get(session.accountId)).id;
 const key=await workspace.issueKey(session.token,{label:'Append only',permission:'write',expiresInDays:1});
 (await db.raw.prepare("INSERT INTO memory_identity.credential_policies(credential_id,capabilities,space_ids) VALUES(?,'[\"create\"]'::jsonb,?::jsonb)").run(key.id,JSON.stringify([spaceId])));
 return {db,token:session.token,key,spaceId};
}

for(const race of [false,true]) test('supersession requires update authority'+(race?' in the mutating SQL':' on previously written foundation data'),async()=>{
 const {db,token,key,spaceId}=await productionFixture();
 try {
  const store=new MemoryStore(db,()=>at),inline=new MemoryService(db,()=>at),original=await inline.create(token,spaceId,{body:'Keep this fact'});
  const actor=(await db.raw.prepare('SELECT actor_credential_id,owner_account_id FROM memory_control.spaces WHERE id=?').get(spaceId));
  (await db.raw.prepare("INSERT INTO memory_ops.release_operations(id,account_id,space_id,client_key,request_hash,action,memory_id,actor_credential_id,created_at,period,units) VALUES('original',?,?,'original','fixture','create',?,?,?,'2026-09',1)").run(actor.owner_account_id,spaceId,original.id,actor.actor_credential_id,at));
  assert.deepEqual((await inline.list(token,spaceId)).results.map(row=>row.id),[original.id]);
  if(race){
   // Credential policies are immutable on this lineage; the mid-flight
   // authority loss is a credential revocation evaluated inside the batch.
   const runBatch=db.batch.bind(db);db.batch=async statements=>{(await db.raw.prepare("UPDATE memory_identity.credentials SET revoked_at=? WHERE id=?").run(at+1,key.id));const result=await runBatch(statements);(await db.raw.prepare("UPDATE memory_identity.credentials SET revoked_at=NULL WHERE id=?").run(key.id));return result;};
  }
  await assert.rejects(()=>store.create(key.token,spaceId,{body:'Replace without authority',supersedesMemoryId:original.id},'replace'),e=>e.status===403);
  assert.deepEqual((await inline.list(token,spaceId)).results.map(row=>row.id),[original.id]);
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM memory_ops.release_operations').get()).n,1);
  assert.equal((await db.raw.prepare('SELECT sum(units) n FROM memory_ops.usage_counters').get()).n,1);
 } finally {db.close();}
});

for(const action of ['create','update','restore']) test('committed '+action+' replay returns a receipt after deletion or erasure',async()=>{
 const {db,token}=await fixture();
 try {
  const store=new MemoryStore(db,()=>at),first=await store.create(token,'s1',{body:'Original'},'create');let revision=1;
  const replay=action==='create'?()=>store.create(token,'s1',{body:'Original'},'create'):
   action==='update'?()=>store.update(token,'s1',first.id,{body:'Changed',expectedRevision:1},'update'):
   ()=>store.restore(token,'s1',first.id,2,'restore');
  if(action==='update'){await replay();revision=2;}
  if(action==='restore'){await store.remove(token,'s1',first.id,1,'first-delete');await replay();revision=3;}
  await store.remove(token,'s1',first.id,revision,'delete');
  const count=(await db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n;
  for(const erased of [false,true]){
   if(erased)await store.erase(token,'s1',first.id,revision+1,first.id,'erase');
   const result=await replay();
   assert.equal(result.representation,'receipt');assert.equal(result.replayed,true);assert.equal(result.committedRevision,revision);assert.equal(result.id,first.id);assert.ok(!('body' in result));
   assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n,count+Number(erased));
  }
  (await db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'"));
  await assert.rejects(replay,e=>e.status===403);
 } finally {db.close();}
});

for(const race of [false,true])test('superseding an already replaced memory returns a conflict'+(race?' during commit':''),async()=>{
 const {db,token}=await fixture();
 try {
  const store=new MemoryStore(db,()=>at),original=await store.create(token,'s1',{body:'Original fact'},'original');
  const replacement={body:'Replacement fact',supersedesMemoryId:original.id};let winner;
  if(race){
   const runBatch=db.batch.bind(db);
   db.batch=async statements=>{db.batch=runBatch;winner=await store.create(token,'s1',replacement,'winner');return runBatch(statements);};
  }else winner=await store.create(token,'s1',replacement,'winner');
  await assert.rejects(()=>store.create(token,'s1',{body:'Competing fact',supersedesMemoryId:original.id},'contender'),error=>error.status===409&&error.code==='revision_conflict');
  assert.deepEqual((await store.list(token,'s1')).results.map(row=>row.id),[winner.id]);
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n,2);
  assert.equal((await db.raw.prepare('SELECT sum(units) n FROM release_usage_counters').get()).n,2);
  const replay=await store.create(token,'s1',replacement,'winner');assert.equal(replay.id,winner.id);assert.equal(replay.replayed,true);assert.equal(replay.committedRevision,1);
  await assert.rejects(()=>store.create(token,'s1',{...replacement,body:'Different fact'},'winner'),error=>error.status===409&&error.code==='idempotency_conflict');
  await store.remove(token,'s1',winner.id,1,'delete-winner');
  const receipt=await store.create(token,'s1',replacement,'winner');assert.equal(receipt.representation,'receipt');assert.equal(receipt.id,winner.id);assert.equal(receipt.replayed,true);
 }finally{db.close();}
});

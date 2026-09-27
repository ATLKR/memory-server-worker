import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {payloadBucket,payloadShard} from './payload-fixture.mjs';
import {PayloadStore} from '../../src/release/payloads.ts';
import {MemoryStore} from '../../src/release/memory.ts';
import {ReleaseError} from '../../src/release/util.ts';

async function setup(t){
 const f=await fixture();t.after(()=>f.db.close());
 // The retired D1 guards evaluated unixepoch('subsec') through the injected
 // test clock; migration 0009 kept raw clock_timestamp() calls, so re-apply
 // those bodies on the memory_control.now_ms() seam the fixture replaces
 // (the two are the same function in production).
 for(const{d}of await f.db.raw.prepare(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='memory_content' AND p.proname IN ('payload_stage_admission','payload_intent_transition','payload_stage_publish','payload_archive_permit_validate','payload_retire_old')`).all())
  await f.db.raw.exec(d.replaceAll('floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint','memory_control.now_ms()'));
 // The retired driver preserved written alias case; PostgreSQL folds the one
 // unquoted alias in the service column list, so re-quote it at the boundary.
 const prepare=f.db.prepare.bind(f.db);f.db.prepare=sql=>prepare(sql.replaceAll('AS payloadSha256','AS "payloadSha256"'));
 const hot=payloadShard();t.after(()=>hot.raw.close());
 const env={DB:f.db,STORAGE_MODE:'sharded',STORAGE_SHARDS_JSON:JSON.stringify([{id:'hot',binding:'HOT',mode:'active'}]),HOT:hot,MEMORY_PAYLOADS:payloadBucket()};
 const payloads=new PayloadStore(env,()=>at),store=new MemoryStore(f.db,()=>at,payloads);
 const concurrentPayloads=new PayloadStore(env,()=>at),concurrent=new MemoryStore(f.db,()=>at,concurrentPayloads);
 return {...f,payloads,store,concurrentPayloads,concurrent};
}
async function interceptOnce(object,method,run){const original=object[method].bind(object);let once=false;object[method]=async(...args)=>{if(!once){once=true;await run(...args);}return original(...args);};}
function ref(row){return {id:row.payload_id,shardId:row.payload_shard_id,objectKey:row.payload_object_key,sha256:row.payload_sha256,bytes:row.payload_bytes};}
for(const boundary of ['retired','purged','revoked'])test('overlapping create resolves matching receipt after delayed staging: '+boundary,async t=>{
 const f=await setup(t),input={body:'original concurrent payload'};let committed;
 interceptOnce(f.concurrentPayloads,'stage',async(ctx,reference)=>{
  committed=await f.store.create(f.token,'s1',input,'same-create');
  if(boundary==='purged'){
   await f.store.remove(f.token,'s1',committed.id,1,'delete');await f.store.erase(f.token,'s1',committed.id,2,committed.id,'erase');await f.payloads.purge(ctx,reference);
  }else{
   await f.store.update(f.token,'s1',committed.id,{body:'newer body',expectedRevision:1},'update');await f.payloads.retireHot(ctx,reference);
   if(boundary==='revoked')(await f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at));
  }
 });
 const operation=f.concurrent.create(f.token,'s1',input,'same-create');
 if(boundary==='revoked')await assert.rejects(operation,error=>error.status===403);
 else{const replay=await operation;assert.equal(replay.id,committed.id);assert.equal(replay.replayed,true);assert.equal(replay.committedRevision,1);if(boundary==='retired')assert.equal(replay.body,'newer body');else{assert.equal(replay.representation,'receipt');assert.equal('body'in replay,false);}}
 assert.equal((await f.db.raw.prepare("SELECT count(*) n FROM release_operations WHERE client_key='same-create'").get()).n,1);
});
test('a storage failure without a matching receipt remains a failure and does not charge',async t=>{
 const f=await setup(t);f.concurrentPayloads.stage=async()=>{throw new ReleaseError(503,'injected_storage_failure');};
 await assert.rejects(()=>f.concurrent.create(f.token,'s1',{body:'uncommitted'},'no-receipt'),error=>error.code==='injected_storage_failure');
 assert.equal((await f.db.raw.prepare("SELECT count(*) n FROM release_operations WHERE client_key='no-receipt'").get()).n,0);
});
for(const operation of ['update','restore'])for(const boundary of ['hydration-purged','stage-retired','revoked'])test(operation+' resolves a receipt committed during old-payload work: '+boundary,async t=>{
 const f=await setup(t),created=await f.store.create(f.token,'s1',{body:'oldbody',source:'retainedsource'},'create');
 if(operation==='restore')await f.store.remove(f.token,'s1',created.id,1,'delete');
 const expected=operation==='restore'?2:1,key='same-'+operation;
 const invoke=store=>operation==='restore'?store.restore(f.token,'s1',created.id,expected,key):store.update(f.token,'s1',created.id,{body:'updatedbody',expectedRevision:expected},key);
 const original=(await f.db.raw.prepare('SELECT * FROM memories WHERE id=?').get(created.id));let committed;
 interceptOnce(f.concurrentPayloads,boundary==='stage-retired'?'stage':'read',async(ctx,reference)=>{
  committed=await invoke(f.store);
  if(boundary==='stage-retired'){
   const next=await f.store.update(f.token,'s1',created.id,{body:'successor',expectedRevision:committed.revision},'successor');
   await f.payloads.retireHot(ctx,reference);assert.ok(next.revision>committed.revision);
  }else{
   await f.store.remove(f.token,'s1',created.id,committed.revision,'later-delete');
   await f.store.erase(f.token,'s1',created.id,committed.revision+1,created.id,'later-erase');
   await f.payloads.purge({spaceId:'s1',memoryId:created.id},ref(original));
   if(boundary==='revoked')(await f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at));
  }
 });
 if(boundary==='revoked')await assert.rejects(()=>invoke(f.concurrent),error=>error.status===403);
 else{const replay=await invoke(f.concurrent);assert.equal(replay.replayed,true);assert.equal(replay.committedRevision,expected+1);if(boundary==='hydration-purged'){assert.equal(replay.representation,'receipt');assert.equal('body'in replay,false);}else assert.equal(replay.body,'successor');}
 assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_operations WHERE client_key=?').get(key)).n,1);
});

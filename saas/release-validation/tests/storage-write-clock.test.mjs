import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Search} from '../../src/release/search.ts';
import {Transfers} from '../../src/release/transfer.ts';

function advanceAfterRead(db,predicate,advance) {
 const prepare=db.prepare.bind(db);let changed=false;
 db.prepare=sql=>{
  const statement=prepare(sql);
  if(predicate(sql)){
   const first=statement.first.bind(statement);
   statement.first=async()=>{const result=await first();if(!changed){changed=true;advance();}return result;};
  }return statement;
 };
 return()=>changed;
}
const operationLookup=sql=>sql.startsWith('SELECT id,request_hash AS requestHash');
const credentialRead=sql=>sql.startsWith('SELECT c.id,c.account_id AS accountId');

for(const action of ['create','update','delete','restore','erase','supersede','search'])for(const expiry of ['credential','membership'])test(action+' commits nothing when '+expiry+' expires during operation lookup',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  const store=new MemoryStore(db,()=>now),space=expiry==='membership'?'so':'s1';
  const memory=await store.create(token,space,{body:'original'},'original');
  if(['restore','erase'].includes(action))await store.remove(token,space,memory.id,1,'original-delete');
  db.raw.prepare(expiry==='membership'?"UPDATE memberships SET expires_at=? WHERE id='m1'":"UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+1);
  const before=JSON.stringify(db.raw.prepare('SELECT * FROM memories').all()),count=db.raw.prepare('SELECT count(*) n FROM release_operations').get().n;
  const changed=advanceAfterRead(db,operationLookup,()=>{now+=2;});
  const actions={
   create:()=>store.create(token,space,{body:'new'},'late'),
   update:()=>store.update(token,space,memory.id,{body:'changed',expectedRevision:1},'late'),
   delete:()=>store.remove(token,space,memory.id,1,'late'),
   restore:()=>store.restore(token,space,memory.id,2,'late'),
   erase:()=>store.erase(token,space,memory.id,2,memory.id,'late'),
   supersede:()=>store.create(token,space,{body:'replacement',supersedesMemoryId:memory.id},'late'),
   search:()=>new Search({DB:db},()=>now).query(token,space,'original',10,'late'),
  };
  await assert.rejects(actions[action],error=>error.status===403);assert.equal(changed(),true);
  assert.equal(JSON.stringify(db.raw.prepare('SELECT * FROM memories').all()),before);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_operations').get().n,count,'A denied write must not add an operation or usage charge');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_usage_events').get().n,count);
 }finally{db.close();}
});

for(const replay of [false,true])test('erasure '+(replay?'replay':'write')+' requires recent proof after operation lookup',async()=>{
 const {db,token}=await fixture();let now=at;
 try {
  const store=new MemoryStore(db,()=>now),memory=await store.create(token,'s1',{body:'retained source'},'create');
  await store.remove(token,'s1',memory.id,1,'delete');
  if(replay)await store.erase(token,'s1',memory.id,2,memory.id,'erase');
  db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-299999);
  const changed=advanceAfterRead(db,operationLookup,()=>{now+=2;});
  await assert.rejects(()=>store.erase(token,'s1',memory.id,2,memory.id,'erase'),error=>error.status===403);
  assert.equal(changed(),true);
  assert.equal(db.raw.prepare('SELECT erased_at FROM memories').get().erased_at!==null,replay);
 }finally{db.close();}
});

for(const action of ['retention','rebuild','export','share','revoke','accept'])test(action+' rejects expired authority immediately before its mutation',async()=>{
 const {db,token,other}=await fixture();let now=at;
 try {
  const store=new MemoryStore(db,()=>now),transfers=new Transfers(db,()=>now),memory=await store.create(token,'s1',{body:'source'},'create');
  const share=await transfers.share(token,'s1','bob@example.com');
  db.raw.exec("UPDATE release_jobs SET state='done'");
  const actor=action==='accept'?'session:bob':'session:alice';
  db.raw.prepare('UPDATE credentials SET expires_at=? WHERE id=?').run(at+1,actor);
  const changed=advanceAfterRead(db,credentialRead,()=>{now+=2;});
  const actions={
   retention:()=>store.retention(token,'s1',90),
   rebuild:()=>new Search({DB:db,AI:{},MEMORY_INDEX:{},BACKGROUND_JOBS_ENABLED:'true'},()=>now).rebuild(token,'s1'),
   export:()=>transfers.startExport(token,'s1'),
   share:()=>transfers.share(token,'s1','bob@example.com'),
   revoke:()=>transfers.revoke(token,'s1',share.id),
   accept:()=>transfers.accept(other,share.id),
  };
  await assert.rejects(actions[action],error=>error.status===403);assert.equal(changed(),true);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_space_policies').get().n,0);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_export_sessions').get().n,0);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,1);
  assert.deepEqual({...db.raw.prepare('SELECT accepted_at,revoked_at FROM release_shares').get()},{accepted_at:null,revoked_at:null});
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE memory_id=?').get(memory.id).state,'done');
 }finally{db.close();}
});

test('export page checks its session expiry after asynchronous token hashing',async()=>{
 const {db,token}=await fixture();let now=at;const original=crypto.subtle.digest;
 try {
  db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+86400000);
  const transfers=new Transfers(db,()=>now),session=await transfers.startExport(token,'s1');let advanced=false;
  crypto.subtle.digest=async function(...args){const result=await original.apply(this,args);if(!advanced){advanced=true;now=session.expiresAt+1;}return result;};
  await assert.rejects(()=>transfers.exportPage(token,'s1',session.id),error=>error.status===404&&error.code==='export_not_found');
  assert.equal(advanced,true);
 }finally{crypto.subtle.digest=original;db.close();}
});

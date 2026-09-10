import test from 'node:test';
import assert from 'node:assert/strict';
import { DB,at } from './db.mjs';
import { suspendedOwnerFixture,sharesRejectSuspendedOwner,queuedProvidersRejectSuspendedPersonalOwner,bufferedMcpRejectsSuspendedOwner } from './suspended-owner-scenarios.mjs';

for(const timing of ['before-index','before-embedding','after-embedding'])test('suspended indexing resumes without losing progress or consuming failure attempts: '+timing,async t=>{
 let now=at;const db=new DB(()=>now);db.migrate();t.after(()=>db.close());const f=await suspendedOwnerFixture(db,()=>now);
 if(timing==='before-index')await f.deliver('account.suspended');
 else if(timing==='before-embedding'){
  const original=f.jobs.indexable.bind(f.jobs);let checked=0;
  f.jobs.indexable=async job=>{if(job.memoryId===f.personalMemory.id&&++checked===2)await f.deliver('account.suspended');return original(job);};
 }else{
  const run=f.jobs.env.AI.run;let injected=false;
  f.jobs.env.AI.run=async(model,input)=>{const result=await run(model,input);if(!injected&&input.text.join(' ').includes('suspendedprivateword')){injected=true;await f.deliver('account.suspended');}return result;};
 }
 await f.jobs.drain(5);
 const read=()=>db.prepare('SELECT state,attempt,next_chunk,last_error,available_at,queued_at FROM release_jobs WHERE memory_id=? AND revision=1').bind(f.personalMemory.id).first();
 const first=await read();assert.equal(first.state,'pending');assert.equal(first.attempt,0);assert.equal(first.next_chunk,0);assert.equal(first.last_error,'owner_suspended');assert.ok(first.available_at>=now+60000);
 const before=f.calls.filter(c=>c.kind==='embedding'&&c.text.join(' ').includes('suspendedprivateword')).length;
 for(let i=0;i<7;i++){now+=61000;await f.jobs.drain(5);const current=await read();assert.equal(current.state,'pending');assert.equal(current.attempt,0);assert.equal(current.queued_at,first.queued_at);}
 assert.equal(f.calls.filter(c=>c.kind==='embedding'&&c.text.join(' ').includes('suspendedprivateword')).length,before);
 assert.ok(!f.calls.some(c=>c.kind==='upsert'&&c.values.some(v=>v.metadata.memoryId===f.personalMemory.id)));
 await f.deliver('account.resumed');now+=61000;await f.jobs.drain(5);
 assert.equal((await read()).state,'done');assert.equal((await read()).next_chunk,1);
 assert.ok(f.calls.some(c=>c.kind==='upsert'&&c.values.some(v=>v.metadata.memoryId===f.personalMemory.id)));
});

for(const scenario of [sharesRejectSuspendedOwner,queuedProvidersRejectSuspendedPersonalOwner,bufferedMcpRejectsSuspendedOwner])test(scenario.name,async t=>{
 const db=new DB();db.migrate();t.after(()=>db.close());await scenario(await suspendedOwnerFixture(db,()=>at));
});
test('explicit resume re-enables retained outgoing personal shares without restoring old credentials',async t=>{
 let now=at;const db=new DB(()=>now);db.migrate();t.after(()=>db.close());const f=await suspendedOwnerFixture(db,()=>now);
 await f.deliver('account.suspended');await assert.rejects(()=>f.store.get(f.users.carol.token,f.personal,f.personalMemory.id),error=>error.status===403);
 now+=1000;await f.deliver('account.resumed');now+=1000;
 assert.equal((await f.store.get(f.users.carol.token,f.personal,f.personalMemory.id)).body,f.personalMemory.body);
 await f.transfer.accept(f.users.bob.token,f.pending.id);
 for(const token of [f.users.alice.token,f.oldKey.token])await assert.rejects(()=>f.store.get(token,f.personal,f.personalMemory.id),error=>error.status===403);
 const fresh=await f.workspace.signIn({issuer:'https://auth-api.allen.company',subject:'alice',email:'alice@example.com',emailVerified:true,issuedAt:now,expiresAt:now+900000,permission:'write'});
 assert.equal((await f.store.get(fresh.token,f.personal,f.personalMemory.id)).body,f.personalMemory.body);
 await assert.rejects(()=>f.store.get(fresh.token,f.organization.spaceId,f.organizationMemory.id),error=>error.status===403);
});

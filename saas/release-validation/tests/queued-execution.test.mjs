import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Search} from '../../src/release/search.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {Ingest} from '../../src/release/ingest.ts';
import {Jobs} from '../../src/release/jobs.ts';

const day=86400000;
async function setup(t){let now=at;const clock=()=>now,f=await fixture({clock});t.after(()=>f.db.close());return {...f,clock,advance:value=>{now=value;},store:new MemoryStore(f.db,clock),transfers:new Transfers(f.db,clock)};}
function queued(db,match,advance){const prepare=db.prepare.bind(db);let touched=false;db.prepare=sql=>{const statement=prepare(sql);if(match(sql))for(const method of ['first','all','run']){const call=statement[method].bind(statement);statement[method]=async()=>{if(!touched){touched=true;advance();}return call();};}return statement;};return()=>touched;}
function queuedBatch(db,advance){const batch=db.batch.bind(db);let touched=false;db.batch=async statements=>{if(!touched){touched=true;advance();}return batch(statements);};return()=>touched;}
const saved=db=>JSON.stringify(['memories','memory_versions','release_operations','release_usage_events','release_jobs'].map(table=>db.raw.prepare('SELECT * FROM '+table).all()));
function providers(f){const calls=[];return {calls,env:{DB:f.db,AI:{async run(){calls.push('embedding');return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async upsert(){calls.push('upsert');},async deleteByIds(){calls.push('delete');},async getByIds(){calls.push('confirm');return[];}}}};}

for(const action of ['create','update','delete','restore','erase','supersede','search','ingest'])for(const expiry of ['credential','membership'])test('queued '+action+' admits no mutation after '+expiry+' expiry',async t=>{
 const f=await setup(t),space=expiry==='membership'?'so':'s1',memory=await f.store.create(f.token,space,{body:'Original secret'},'seed');
 if(['restore','erase'].includes(action))await f.store.remove(f.token,space,memory.id,1,'delete');
 f.db.raw.prepare(expiry==='credential'?"UPDATE credentials SET expires_at=? WHERE id='session:alice'":"UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+1);
 const before=saved(f.db),touched=queuedBatch(f.db,()=>f.advance(at+2));
 const operations={create:()=>f.store.create(f.token,space,{body:'Late secret'},'late'),update:()=>f.store.update(f.token,space,memory.id,{body:'Late secret',expectedRevision:1},'late'),delete:()=>f.store.remove(f.token,space,memory.id,1,'late'),restore:()=>f.store.restore(f.token,space,memory.id,2,'late'),erase:()=>f.store.erase(f.token,space,memory.id,2,memory.id,'late'),supersede:()=>f.store.create(f.token,space,{body:'Replacement',supersedesMemoryId:memory.id},'late'),search:()=>new Search({DB:f.db},f.clock).query(f.token,space,'Original',10,'late'),ingest:()=>new Ingest({DB:f.db,AI:{},PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),BACKGROUND_JOBS_ENABLED:'true'},f.clock).submit(f.token,space,{messages:[{id:'m',role:'user',content:'Late secret'}]},'late')};
 await assert.rejects(operations[action],e=>e.status===403);assert.equal(touched(),true);assert.equal(saved(f.db),before,'No content, history, operation, charge, or job may commit');
});

for(const action of ['erase','retention','rebuild','share','revoke'])test('queued '+action+' enforces recent proof at SQL execution',async t=>{
 const f=await setup(t),memory=await f.store.create(f.token,'s1',{body:'Retained secret'},'seed'),share=await f.transfers.share(f.token,'s1','bob@example.com');await f.store.remove(f.token,'s1',memory.id,1,'delete');
 f.advance(at+299999);const before=saved(f.db),touched=action==='erase'?queuedBatch(f.db,()=>f.advance(at+300001)):queued(f.db,sql=>/^(INSERT INTO release_space_policies|INSERT INTO release_jobs\(|INSERT INTO release_shares|UPDATE release_shares SET revoked_at)/.test(sql),()=>f.advance(at+300001));
 const operations={erase:()=>f.store.erase(f.token,'s1',memory.id,2,memory.id,'erase'),retention:()=>f.store.retention(f.token,'s1',1),rebuild:()=>new Search({DB:f.db,AI:{},MEMORY_INDEX:{},BACKGROUND_JOBS_ENABLED:'true'},f.clock).rebuild(f.token,'s1'),share:()=>f.transfers.share(f.token,'s1','bob@example.com'),revoke:()=>f.transfers.revoke(f.token,'s1',share.id)};
 await assert.rejects(operations[action],e=>e.status===403);assert.equal(touched(),true);assert.equal(saved(f.db),before);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_space_policies').get().n,0);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,1);assert.equal(f.db.raw.prepare('SELECT revoked_at FROM release_shares').get().revoked_at,null);
});

for(const action of ['export','share','accept','revoke','retention','rebuild'])test('queued direct '+action+' rejects an expired credential',async t=>{
 const f=await setup(t),memory=await f.store.create(f.token,'s1',{body:'Original'},'seed'),share=await f.transfers.share(f.token,'s1','bob@example.com');
 f.db.raw.prepare('UPDATE credentials SET expires_at=? WHERE id=?').run(at+1,action==='accept'?'session:bob':'session:alice');
 const before=saved(f.db),touched=queued(f.db,sql=>/^(INSERT INTO release_export_sessions|INSERT INTO release_shares|UPDATE release_shares SET |INSERT INTO release_space_policies|INSERT INTO release_jobs\()/.test(sql),()=>f.advance(at+2));
 const operations={export:()=>f.transfers.startExport(f.token,'s1'),share:()=>f.transfers.share(f.token,'s1','bob@example.com'),accept:()=>f.transfers.accept(f.other,share.id),revoke:()=>f.transfers.revoke(f.token,'s1',share.id),retention:()=>f.store.retention(f.token,'s1',7),rebuild:()=>new Search({DB:f.db,AI:{},MEMORY_INDEX:{},BACKGROUND_JOBS_ENABLED:'true'},f.clock).rebuild(f.token,'s1')};
 await assert.rejects(operations[action],e=>e.status===403);assert.equal(touched(),true);assert.equal(saved(f.db),before);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_export_sessions').get().n,0);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,1);assert.equal(f.db.raw.prepare('SELECT accepted_at FROM release_shares').get().accepted_at,null);
});

test('a restore queued across its exact retention deadline stays deleted',async t=>{
 const f=await setup(t),memory=await f.store.create(f.token,'s1',{body:'Retained secret'},'seed');await f.store.remove(f.token,'s1',memory.id,1,'delete');f.db.raw.prepare('UPDATE credentials SET expires_at=?').run(at+40*day);f.advance(at+30*day-1);
 const before=saved(f.db),touched=queuedBatch(f.db,()=>f.advance(at+30*day+1));await assert.rejects(()=>f.store.restore(f.token,'s1',memory.id,2,'restore'),e=>e.code==='restore_expired');assert.equal(touched(),true);assert.equal(saved(f.db),before);
});

test('queued admission charges its actual month and gives memory and ingestion their admitted timestamps',async t=>{
 const f=await setup(t),boundary=Date.UTC(2026,9,1);f.db.raw.prepare('UPDATE credentials SET expires_at=?').run(boundary+40*day);f.advance(boundary-1);
 const touched=queuedBatch(f.db,()=>f.advance(boundary+1)),memory=await f.store.create(f.token,'s1',{body:'October memory'},'october');assert.equal(touched(),true);assert.equal(memory.createdAt,boundary+1);
 const operation=f.db.raw.prepare("SELECT created_at,period FROM release_operations WHERE client_key='october'").get();assert.deepEqual({...operation},{created_at:boundary+1,period:'2026-10'});assert.equal(f.db.raw.prepare('SELECT period FROM release_usage_events').get().period,'2026-10');
 const env={DB:f.db,AI:{},PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),BACKGROUND_JOBS_ENABLED:'true'},ingest=await new Ingest(env,f.clock).submit(f.token,'s1',{messages:[{id:'m',role:'user',content:'October source'}]},'ingest');
 assert.deepEqual({...f.db.raw.prepare('SELECT created_at,expires_at FROM release_ingests WHERE id=?').get(ingest.id)},{created_at:boundary+1,expires_at:boundary+1+day});
});

for(const action of ['export','share'])test('queued '+action+' returns its persisted execution-time expiry',async t=>{
 const f=await setup(t),touched=queued(f.db,sql=>sql.startsWith(action==='export'?'INSERT INTO release_export_sessions':'INSERT INTO release_shares'),()=>f.advance(at+500));
 const result=await(action==='export'?f.transfers.startExport(f.token,'s1'):f.transfers.share(f.token,'s1','bob@example.com'));
 assert.equal(touched(),true);assert.equal(result.expiresAt,at+500+(action==='export'?3600000:7*day));
 const row=f.db.raw.prepare('SELECT created_at,expires_at FROM '+(action==='export'?'release_export_sessions':'release_shares')+' WHERE id=?').get(result.id);assert.equal(row.created_at,at+500);assert.equal(row.expires_at,result.expiresAt);
});

for(const boundary of ['batch','approval-statement'])test('ingest approval queued past expiry rolls back at '+boundary,async t=>{
 const f=await setup(t);f.db.raw.prepare('UPDATE credentials SET expires_at=?').run(at+40*day);
 const env={DB:f.db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){return{response:{memories:[{body:'Review secret',kind:'fact',sourceMessageId:'m',quote:'Review secret'}]}};}}},ingest=new Ingest(env,f.clock),jobs=new Jobs(env,f.clock);jobs.ingest=j=>ingest.process(j);
 const submission=await ingest.submit(f.token,'s1',{messages:[{id:'m',role:'user',content:'Review secret'}]},'submit');await jobs.drain(1);f.advance(at+day-1);const before=saved(f.db);
 const touched=boundary==='batch'?queuedBatch(f.db,()=>f.advance(at+day+1)):queued(f.db,sql=>sql.startsWith('INSERT INTO release_ingest_approvals'),()=>f.advance(at+day+1));
 await assert.rejects(()=>ingest.approve(f.token,'s1',submission.id,[0],'approve'),e=>e.status===409);assert.equal(touched(),true);assert.equal(saved(f.db),before);assert.equal(f.db.raw.prepare('SELECT state FROM release_ingests WHERE id=?').get(submission.id).state,'review');
});

test('a queued renewal cannot revive its expired lease or start provider work',async t=>{
 const f=await setup(t),p=providers(f);await f.store.create(f.token,'s1',{body:'Private queued chunk'},'seed');const jobs=new Jobs(p.env,f.clock),job=await jobs.claim();f.advance(at+119999);
 const touched=queued(f.db,sql=>sql.startsWith('UPDATE release_jobs SET lease_until=MAX'),()=>f.advance(at+120001));await assert.rejects(()=>jobs.index(job),/lease_lost/);assert.equal(touched(),true);assert.deepEqual(p.calls,[]);assert.equal(f.db.raw.prepare('SELECT lease_until FROM release_jobs WHERE id=?').get(job.id).lease_until,at+120000);
});

for(const outcome of ['complete','yield','failure'])test('queued job '+outcome+' cannot mutate state after losing its lease',async t=>{
 const f=await setup(t),p=providers(f);await f.store.create(f.token,'s1',{body:'Queued job'},'seed');const jobs=new Jobs(p.env,f.clock);jobs.index=async()=>{if(outcome==='failure')throw Error('provider failure');return outcome==='complete';};
 const touched=queued(f.db,sql=>outcome==='complete'?sql.startsWith("UPDATE release_jobs SET state='done',available_at="):outcome==='yield'?sql.startsWith("UPDATE release_jobs SET state='pending',attempt=MAX"):sql.includes("SET state=CASE WHEN kind='ingest' AND NOT")&&sql.includes('provider_or_processing_failure'),()=>f.advance(at+120001));
 await jobs.drain(1);assert.equal(touched(),true);const row=f.db.raw.prepare('SELECT state,attempt,lease_until FROM release_jobs').get();assert.deepEqual({...row},{state:'leased',attempt:1,lease_until:at+120000});
 const recovered=await jobs.claim();assert.equal(recovered.attempt,2,'Only a new claim may recover the abandoned lease');
});

for(const boundary of ['checkpoint','ledger'])test('queued '+boundary+' cannot persist expired-owner progress',async t=>{
 const f=await setup(t),p=providers(f),memory=await f.store.create(f.token,'s1',{body:'Private chunk'},'seed');
 if(boundary==='ledger'){await f.store.remove(f.token,'s1',memory.id,1,'delete');await f.store.erase(f.token,'s1',memory.id,2,memory.id,'erase');f.db.raw.prepare("UPDATE release_jobs SET state='done' WHERE revision<3").run();}
 const jobs=new Jobs(p.env,f.clock),job=await jobs.claim(),touched=queued(f.db,sql=>sql.startsWith(boundary==='checkpoint'?'UPDATE release_jobs SET next_chunk=':'UPDATE release_erasure_ledger SET vector_erased_at='),()=>f.advance(f.db.raw.prepare('SELECT lease_until FROM release_jobs WHERE id=?').get(job.id).lease_until+1));
 await assert.rejects(()=>jobs.index(job),/lease_lost/);assert.equal(touched(),true);assert.equal(f.db.raw.prepare('SELECT next_chunk FROM release_jobs WHERE id=?').get(job.id).next_chunk,0);if(boundary==='ledger')assert.equal(f.db.raw.prepare('SELECT vector_erased_at FROM release_erasure_ledger WHERE memory_id=?').get(memory.id).vector_erased_at,null);
});

for(const deadline of ['ingest','lease','credential','membership'])test('queued extraction result cannot persist after '+deadline+' expiry',async t=>{
 const f=await setup(t),env={DB:f.db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){return{response:{memories:[{body:'Review secret',kind:'fact',sourceMessageId:'m',quote:'Review secret'}]}};}}},ingest=new Ingest(env,f.clock),jobs=new Jobs(env,f.clock);jobs.ingest=j=>ingest.process(j);
 const submission=await ingest.submit(f.token,'so',{messages:[{id:'m',role:'user',content:'Review secret'}]},'submit'),job=await jobs.claim();
 const touched=queued(f.db,sql=>sql.startsWith('UPDATE release_ingests SET proposals='),()=>{const expiry=at+1;if(deadline==='ingest')f.db.raw.prepare('UPDATE release_ingests SET expires_at=? WHERE id=?').run(expiry,submission.id);if(deadline==='lease')f.db.raw.prepare('UPDATE release_jobs SET lease_until=? WHERE id=?').run(expiry,job.id);if(deadline==='credential')f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(expiry);if(deadline==='membership')f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(expiry);f.advance(expiry+1);});
 await assert.rejects(()=>ingest.process(job),e=>e.code==='ingest_authority_expired');assert.equal(touched(),true);assert.deepEqual({...f.db.raw.prepare('SELECT state,proposals FROM release_ingests WHERE id=?').get(submission.id)},{state:'queued',proposals:null});
});

test('a queued pre-delete checkpoint preserves the provider propagation grace period',async t=>{
 const f=await setup(t),memory=await f.store.create(f.token,'s1',{body:'Removed vector'},'seed');await f.store.remove(f.token,'s1',memory.id,1,'delete');await f.store.erase(f.token,'s1',memory.id,2,memory.id,'erase');
 f.db.raw.prepare("UPDATE release_jobs SET state='done' WHERE revision<3").run();f.db.raw.prepare('INSERT INTO release_vector_refs(memory_id,vector_id,revision) VALUES(?,?,1)').run(memory.id,'old-vector');
 let deletes=0;const env={DB:f.db,MEMORY_INDEX:{async deleteByIds(){deletes++;},async getByIds(){return[{id:'old-vector'}];}}};
 const touched=queued(f.db,sql=>sql.startsWith('UPDATE release_jobs SET next_chunk='),()=>f.advance(at+90000));
 await new Jobs(env,f.clock).drain(1);assert.equal(touched(),true);assert.equal(deletes,1,'A successful queued checkpoint must not immediately resubmit the accepted delete');
 const row=f.db.raw.prepare('SELECT state,attempt,cleanup_retry_at FROM release_jobs WHERE revision=3').get();assert.deepEqual({...row},{state:'pending',attempt:0,cleanup_retry_at:at+150000});
});

test('restore expiry metadata and denial honor database time when the application clock is behind',async t=>{
 const f=await setup(t),memory=await f.store.create(f.token,'s1',{body:'Retained secret'},'seed');await f.store.remove(f.token,'s1',memory.id,1,'delete');f.db.raw.prepare('UPDATE credentials SET expires_at=?').run(at+40*day);f.db.setClock(()=>at+31*day);
 const row=(await f.store.list(f.token,'s1',{deleted:true})).results[0];assert.equal(row.restoreUntil,at+30*day);assert.equal(row.restoreExpired,true);
 await assert.rejects(()=>f.store.restore(f.token,'s1',memory.id,2,'restore'),e=>e.code==='restore_expired');assert.equal(f.db.raw.prepare('SELECT revision FROM memories WHERE id=?').get(memory.id).revision,2);
});

test('a queued vector reference insert cannot write or upsert under an expired lease',async t=>{
 const f=await setup(t),p=providers(f);await f.store.create(f.token,'s1',{body:'Private chunk'},'seed');const jobs=new Jobs(p.env,f.clock),job=await jobs.claim();
 const touched=queued(f.db,sql=>sql.startsWith('INSERT INTO release_vector_refs'),()=>f.advance(f.db.raw.prepare('SELECT lease_until FROM release_jobs WHERE id=?').get(job.id).lease_until+1));
 await assert.rejects(()=>jobs.index(job),/lease_lost/);assert.equal(touched(),true);assert.deepEqual(p.calls,['embedding']);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_vector_refs').get().n,0);
});

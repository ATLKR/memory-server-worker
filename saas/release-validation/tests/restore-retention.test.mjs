import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {createRelease} from '../../src/release/extension.ts';

const day=86400000;
async function setup(t,space='s1'){
 const f=await fixture();t.after(()=>f.db.close());let now=at;
 f.db.raw.prepare('UPDATE credentials SET expires_at=?').run(at+4000*day);
 const clock=()=>now,store=new MemoryStore(f.db,clock),release=createRelease({DB:f.db,PUBLIC_ORIGIN:'https://memory.example.test',AUTO_ERASURE_ENABLED:'false'},{clock});
 const memory=await store.create(f.token,space,{body:'Retained private memory'},'create');await store.remove(f.token,space,memory.id,1,'delete');
 const request=(path,method='GET',data)=>release.route(new Request('https://memory.example.test'+path,{method,headers:{...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})}),f.token);
 return {...f,store,memory,request,clock,advance:value=>{now=value;}};
}

test('expired retained trash reports its restore cutoff and controlled HTTP restore error',async t=>{
 const f=await setup(t);f.advance(at+31*day);
 const listing=await f.request('/v1/spaces/s1/memories?deleted=true');assert.equal(listing.status,200);const page=await listing.json();
 assert.equal(page.results[0].restoreUntil,at+30*day);assert.equal(page.results[0].restoreExpired,true);
 const response=await f.request('/v1/spaces/s1/memories/'+f.memory.id+'/restore','POST',{expectedRevision:2,operationId:'restore'});
 assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'restore_expired'});
 assert.equal(f.db.raw.prepare('SELECT revision FROM memories WHERE id=?').get(f.memory.id).revision,2);
 assert.equal(f.db.raw.prepare("SELECT count(*) n FROM release_operations WHERE client_key='restore'").get().n,0);
});

for(const days of [1,60])test('trash metadata reads the current changed '+days+'-day policy in its final snapshot',async t=>{
 const f=await setup(t);f.advance(at+31*day);let touched=false;const prepare=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('/* rest-memory-disclosure */')){const first=statement.first.bind(statement);statement.first=async()=>{
  touched=true;f.db.raw.prepare('INSERT INTO release_space_policies VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET retention_days=excluded.retention_days').run('s1',days);return first();
 };}return statement;};
 const row=(await f.store.list(f.token,'s1',{deleted:true})).results[0];assert.equal(touched,true);assert.equal(row.restoreUntil,at+days*day);assert.equal(row.restoreExpired,days===1);
 if(days===60)assert.equal((await f.store.restore(f.token,'s1',f.memory.id,2,'restore')).revision,3);
 else await assert.rejects(()=>f.store.restore(f.token,'s1',f.memory.id,2,'restore'),e=>e.code==='restore_expired');
});

test('trash metadata compares its retention deadline after the final awaited read',async t=>{
 const f=await setup(t);f.advance(at+30*day-1);let touched=false;const prepare=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('/* rest-memory-disclosure */')){const first=statement.first.bind(statement);statement.first=async()=>{const row=await first();touched=true;f.advance(at+30*day);return row;};}return statement;};
 const row=await f.store.get(f.token,'s1',f.memory.id,true);assert.equal(touched,true);assert.equal(row.restoreUntil,at+30*day);assert.equal(row.restoreExpired,true);
});

test('a policy shortened after the trash page is still enforced by the atomic restore trigger',async t=>{
 const f=await setup(t);f.advance(at+2*day);assert.equal((await f.store.list(f.token,'s1',{deleted:true})).results[0].restoreExpired,false);
 let touched=false;const batch=f.db.batch.bind(f.db);f.db.batch=async statements=>{touched=true;f.db.raw.exec("INSERT INTO release_space_policies VALUES('s1',1)");return batch(statements);};
 await assert.rejects(()=>f.store.restore(f.token,'s1',f.memory.id,2,'restore'),e=>e.code==='restore_expired');assert.equal(touched,true);
 assert.equal(f.db.raw.prepare('SELECT revision FROM memories WHERE id=?').get(f.memory.id).revision,2);
 assert.equal(f.db.raw.prepare("SELECT count(*) n FROM release_operations WHERE client_key='restore'").get().n,0);
});

for(const state of ['wrong-revision','live','erased','other-Space'])test('expired restore classification preserves '+state+' conflicts',async t=>{
 const f=await setup(t);
 if(state==='live')await f.store.restore(f.token,'s1',f.memory.id,2,'initial-restore');
 if(state==='erased')await f.store.erase(f.token,'s1',f.memory.id,2,f.memory.id,'erase');
 f.advance(at+31*day);
 const revision=state==='wrong-revision'?1:state==='live'||state==='erased'?3:2;
 await assert.rejects(()=>f.store.restore(f.token,state==='other-Space'?'so':'s1',f.memory.id,revision,'restore'),e=>e.code==='revision_conflict');
});

test('restoration replay retains its original write receipt after a later deletion expires',async t=>{
 const f=await setup(t);await f.store.restore(f.token,'s1',f.memory.id,2,'restore');await f.store.remove(f.token,'s1',f.memory.id,3,'delete-again');f.advance(at+31*day);
 const replay=await f.store.restore(f.token,'s1',f.memory.id,2,'restore');assert.equal(replay.replayed,true);assert.equal(replay.representation,'receipt');assert.equal(replay.committedRevision,3);
 assert.equal(f.db.raw.prepare('SELECT revision FROM memories WHERE id=?').get(f.memory.id).revision,4);
});

test('retention metadata grants no write capability and expired diagnostics require update authority',async t=>{
 const f=await setup(t);f.advance(at+31*day);
 f.db.raw.exec("UPDATE release_credential_policies SET capabilities='[\"read\"]' WHERE credential_id='key:alice'");
 assert.equal((await f.store.list(f.key,'s1',{deleted:true})).results[0].restoreExpired,true);
 await assert.rejects(()=>f.store.restore(f.key,'s1',f.memory.id,2,'restore'),e=>e.code==='access_denied');
 f.db.raw.exec("UPDATE release_credential_policies SET capabilities='[\"update\"]' WHERE credential_id='key:alice'");
 await assert.rejects(()=>f.store.restore(f.key,'s1',f.memory.id,2,'restore'),e=>e.code==='restore_expired');
});

for(const change of ['credential-revocation','credential-expiry','membership-expiry'])test('restore denial validates '+change+' at its final snapshot',async t=>{
 const f=await setup(t,'so');f.advance(at+31*day);let touched=false;const prepare=f.db.prepare.bind(f.db);
 if(change==='credential-expiry')f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(f.clock()+1);
 if(change==='membership-expiry')f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(f.clock()+1);
 f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('/* restore-denial */')){const first=statement.first.bind(statement);statement.first=async()=>{
  touched=true;if(change==='credential-revocation')f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(f.clock());const result=await first();if(change!=='credential-revocation')f.advance(f.clock()+2);return result;
 };}return statement;};
 await assert.rejects(()=>f.store.restore(f.token,'so',f.memory.id,2,'restore'),e=>e.code==='access_denied');assert.equal(touched,true);
});

for(const failure of ['transaction','classification'])test('restore '+failure+' database failures are not mislabeled as expiry',async t=>{
 const f=await setup(t);f.advance(at+31*day);let touched=false;
 if(failure==='transaction')f.db.batch=async()=>{touched=true;throw Error('database unavailable');};
 else {const prepare=f.db.prepare.bind(f.db);f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('/* restore-denial */'))statement.first=async()=>{touched=true;throw Error('database unavailable');};return statement;};}
 const response=await f.request('/v1/spaces/s1/memories/'+f.memory.id+'/restore','POST',{expectedRevision:2,operationId:'restore'});
 assert.equal(touched,true);assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'internal_error'});
});

test('restore denial resolves its exact tombstone and retention policy through indexes',async t=>{
 const f=await setup(t);f.advance(at+31*day);const prepare=f.db.prepare.bind(f.db),plans=[];
 f.db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);let values=[];statement.bind=(...args)=>{values=args;bind(...args);return statement;};
  if(sql.includes('/* restore-denial */')){const first=statement.first.bind(statement);statement.first=async()=>{plans.push(f.db.raw.prepare('EXPLAIN QUERY PLAN '+sql).all(...values).map(row=>row.detail).join('\n'));return first();};}return statement;};
 await assert.rejects(()=>f.store.restore(f.token,'s1',f.memory.id,2,'restore'),e=>e.code==='restore_expired');assert.equal(plans.length,1);
 assert.match(plans[0],/SEARCH r USING INDEX sqlite_autoindex_memories_1 \(id=\?\)/,plans[0]);
 assert.match(plans[0],/SEARCH release_space_policies USING INDEX sqlite_autoindex_release_space_policies_1 \(space_id=\?\)/,plans[0]);
});

for(const offset of [-1,0])test('restore uses the exact retention cutoff offset '+offset,async t=>{
 const f=await setup(t);f.advance(at+30*day+offset);
 const row=(await f.store.list(f.token,'s1',{deleted:true})).results[0];assert.equal(row.restoreExpired,offset===0);
 if(offset===0)await assert.rejects(()=>f.store.restore(f.token,'s1',f.memory.id,2,'restore'),e=>e.status===409&&e.code==='restore_expired');
 else assert.equal((await f.store.restore(f.token,'s1',f.memory.id,2,'restore')).revision,3);
});

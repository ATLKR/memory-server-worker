import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Search} from '../../src/release/search.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {createRelease} from '../../src/release/extension.ts';

function capture(db) {
 const queries=[],prepare=db.prepare.bind(db);
 db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement),all=statement.all.bind(statement);let values=[];
  statement.bind=(...args)=>{values=args;bind(...args);return statement;};
  statement.all=async()=>{const result=await all();queries.push({sql,values,count:result.results.length});return result;};return statement;
 };return queries;
}
test('lexical search fills an accepted fifty-result request',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at);for(let n=0;n<51;n++)await store.create(token,'s1',{body:'matching keyword '+n},'create-'+n);
  const result=await new Search({DB:db},()=>at).query(token,'s1','matching',50,'search');
  assert.equal(result.results.length,50);assert.equal(result.mode,'lexical');
 }finally{db.close();}
});

for(const deleted of [false,true])test((deleted?'trash':'live')+' memory pages use their creation-time index without sorting the Space',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at);for(let n=0;n<20;n++){
   const memory=await store.create(token,'s1',{body:'memory '+n},'create-'+n);if(deleted)await store.remove(token,'s1',memory.id,1,'delete-'+n);
  }
  const queries=capture(db),first=await store.list(token,'s1',{limit:1,deleted}),second=await store.list(token,'s1',{limit:1,deleted,cursor:first.nextCursor});
  assert.notEqual(first.results[0].id,second.results[0].id);
  for(const query of queries.filter(q=>q.sql.includes('ORDER BY r.created_at DESC,r.id'))){
   const plan=db.raw.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.values).map(row=>row.detail).join('\n');
   assert.ok(!plan.includes('TEMP B-TREE FOR ORDER BY'),plan);
  }
 }finally{db.close();}
});

test('export target lookup is indexed by Space and pages hydrate only their snapshot IDs',async()=>{
 const {db,token,other}=await fixture();try{
  const store=new MemoryStore(db,()=>at),transfer=new Transfers(db,()=>at),memories=[];
  for(let n=0;n<8;n++)memories.push(await store.create(token,'s1',{body:'snapshot '+n},'create-'+n));
  const foreign=await store.create(other,'s2',{body:'foreign'},'foreign');
  for(let n=0;n<1000;n++)db.raw.prepare("INSERT INTO memory_audit_events(action,space_id,memory_id,revision,actor_credential_id,created_at) VALUES('memory_updated','s2',?,1,'session:bob',?)").run(foreign.id,at);
  const session=await transfer.startExport(token,'s1');await store.update(token,'s1',memories[0].id,{body:'later',expectedRevision:1},'update');
  const queries=capture(db),seen=[];let cursor;
  do{const page=await transfer.exportPage(token,'s1',session.id,cursor,1);seen.push(...page.results);cursor=page.nextCursor;}while(cursor);
  assert.equal(seen.length,8);assert.equal(new Set(seen.map(x=>x.id)).size,8);assert.ok(seen.every(x=>x.body.startsWith('snapshot')));
  const targetQueries=queries.filter(q=>q.sql.includes('memory_audit_events'));assert.ok(targetQueries.length>=8);
  for(const query of targetQueries){
   const plan=db.raw.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.values).map(row=>row.detail).join('\n');
   assert.match(plan,/SEARCH .*memory_audit_events.*space_id=\?/);assert.ok(query.count<=2);
  }
 }finally{db.close();}
});

test('share invitation pages are bounded, stable, and bound to the recipient account',async()=>{
 const {db,token,other}=await fixture();try{
  const transfers=new Transfers(db,()=>at);for(let n=0;n<61;n++)await transfers.share(token,'s1','bob@example.com');
  const release=createRelease({DB:db,PUBLIC_ORIGIN:'https://memory.example.com',REQUEST_LIMITER:{limit:async()=>({success:true})}},{clock:()=>at});
  const get=(suffix='',credential=other)=>release.route(new Request('https://memory.example.com/v1/shares'+suffix),credential);
  const first=await(await get()).json();assert.equal(first.results.length,25);assert.ok(first.nextCursor);
  const seen=[...first.results];let cursor=first.nextCursor;
  do{const page=await(await get('?limit=25&cursor='+encodeURIComponent(cursor))).json();assert.ok(page.results.length<=25);seen.push(...page.results);cursor=page.nextCursor;}while(cursor);
  assert.equal(seen.length,61);assert.equal(new Set(seen.map(x=>x.id)).size,61);
  assert.deepEqual(seen.map(x=>x.id),seen.map(x=>x.id).sort());assert.ok(seen.every(x=>x.createdAt===at));
  assert.equal((await get('?cursor='+encodeURIComponent(first.nextCursor),token)).status,400);
  assert.equal((await get('?limit=101')).status,400);
 }finally{db.close();}
});

test('invitation cursor advances across a bounded expired or unauthorized page',async()=>{
 const {db,token,other}=await fixture();let now=at;try{
  db.raw.prepare('UPDATE credentials SET expires_at=?').run(at+7*86400000);
  const transfers=new Transfers(db,()=>now);
  for(let n=0;n<3;n++)await transfers.share(token,'s1','bob@example.com',1);
  now++;for(let n=0;n<3;n++)await transfers.share(token,'so','bob@example.com');
  now+=86400000;db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(now);
  const visible=await transfers.share(token,'s1','bob@example.com');
  db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(now);
  await transfers.share(token,'s1','alice@example.com');
  const first=await transfers.invitations(other,{limit:3});
  assert.deepEqual(first.results,[]);assert.ok(first.nextCursor,'Expired targets must still advance the cursor');
  const second=await transfers.invitations(other,{limit:3,cursor:first.nextCursor});
  assert.deepEqual(second.results,[]);assert.ok(second.nextCursor,'Expired grantor targets must still advance the cursor');
  const third=await transfers.invitations(other,{limit:3,cursor:second.nextCursor});
  assert.deepEqual(third.results.map(row=>row.id),[visible.id]);assert.equal(third.nextCursor,null);
 }finally{db.close();}
});

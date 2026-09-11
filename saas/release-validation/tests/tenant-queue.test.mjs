import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Search,ftsQuery} from '../../src/release/search.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {Jobs} from '../../src/release/jobs.ts';

function capture(db){const queries=[],prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql),bind=s.bind.bind(s);let values=[];s.bind=(...v)=>{values=v;bind(...v);return s;};for(const method of ['first','all','run']){const execute=s[method].bind(s);s[method]=async()=>{const result=await execute();queries.push({sql,values,count:result?.results?.length});return result;};}return s;};return queries;}
const plan=(db,q)=>db.raw.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.values).map(r=>r.detail).join('\n');
function job(db,id,kind='upsert',state='pending',ready=at,attempt=0,cleanup=0){db.raw.prepare(`INSERT INTO release_jobs(id,space_id,revision,kind,state,available_at,created_at,attempt,lease_token,lease_until,cleanup_only)
 VALUES(?,'s1',1,?,?,?,?,?,?,?,?)`).run(id,kind,state,ready,at,attempt,state==='leased'?'old':null,state==='leased'?ready:null,cleanup);}

test('Space pages use account-bound indexes and explicit PAT scopes bypass other Spaces',async()=>{
 const {db,token,key}=await fixture();try{
  const insert=db.raw.prepare("INSERT INTO spaces VALUES(?,?,'bob',NULL,'managed',?,'session:bob')");
  for(let n=0;n<1000;n++)insert.run('foreign-'+n,'Foreign',at);
  const store=new MemoryStore(db,()=>at),queries=capture(db),page=await store.spaces(token,{limit:1});assert.ok(page.nextCursor);
  const q=queries.find(q=>q.sql.includes('owned.created_at'));assert.ok(q);assert.equal(q.count,2);
  const detail=plan(db,q);assert.match(detail,/SEARCH owned USING .*release_spaces_account_created/);assert.match(detail,/SEARCH managed USING .*release_spaces_organization_created/);
  assert.doesNotMatch(detail,/SCAN (owned|managed|shared|spaces)\b/);
  const second=await store.spaces(token,{limit:1,cursor:page.nextCursor});assert.deepEqual([...page.results,...second.results].map(r=>r.id),['s1','so']);
  queries.length=0;assert.deepEqual((await store.spaces(key)).results.map(r=>r.id),['s1']);
  const scoped=queries.find(q=>q.sql.includes('FROM json_each(?) selected'));assert.ok(scoped);assert.doesNotMatch(scoped.sql,/owned|active_memberships member/);
  assert.match(plan(db,scoped),/SEARCH s USING INDEX sqlite_autoindex_spaces_1/);
 }finally{db.close();}
});

test('duplicate shares cannot truncate Space pagination before later shared Spaces',async()=>{
 const {db,token,other}=await fixture();try{
  db.raw.exec("UPDATE memberships SET revoked_at=1 WHERE id='m2'");
  db.raw.exec(`INSERT INTO spaces VALUES('sz','Later','alice',NULL,'managed',${at},'session:alice')`);
  const transfers=new Transfers(db,()=>at);for(let n=0;n<5;n++){const sh=await transfers.share(token,'so','bob@example.com');await transfers.accept(other,sh.id);}
  const team=await transfers.share(token,'sz','bob@example.com');await transfers.accept(other,team.id);
  const store=new MemoryStore(db,()=>at),seen=[];let cursor;
  do{const page=await store.spaces(other,{limit:1,cursor});seen.push(...page.results.map(r=>r.id));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(seen,['s2','so','sz']);
 }finally{db.close();}
});

test('Space raw-page cursor advances over expired grants to later personal Spaces',async()=>{
 const {db,token}=await fixture();try{
  db.raw.exec(`UPDATE memberships SET expires_at=${at} WHERE id='m1'; INSERT INTO spaces VALUES('sz','Later','alice',NULL,'managed',${at+1},'session:alice')`);
  const store=new MemoryStore(db,()=>at),first=await store.spaces(token,{limit:1}),second=await store.spaces(token,{limit:1,cursor:first.nextCursor});
  assert.deepEqual(first.results.map(r=>r.id),['s1']);assert.deepEqual(second.results,[]);assert.ok(second.nextCursor);
  assert.deepEqual((await store.spaces(token,{limit:1,cursor:second.nextCursor})).results.map(r=>r.id),['sz']);
 }finally{db.close();}
});

test('all supported Unicode prefix lengths are indexed and longer processed terms fail before metering',async()=>{
 const {db,token}=await fixture();let calls=0;try{
  const schema=db.raw.prepare("SELECT sql FROM sqlite_master WHERE name='release_fts'").get().sql;
  assert.match(schema,/prefix='1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31'/);
  const body='한'.repeat(32),store=new MemoryStore(db,()=>at);await store.create(token,'s1',{body},'create');
  const search=new Search({DB:db,AI:{async run(){calls++;return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async query(){calls++;return{matches:[]};}}},()=>at);
  assert.equal((await search.query(token,'s1','한'.repeat(31),10,'supported')).results.length,1);
  const before=db.raw.prepare('SELECT count(*) n FROM release_operations').get().n,providerCalls=calls;
  for(const query of ['a'.repeat(32),'한'.repeat(32),'Ａ'.repeat(32)])await assert.rejects(()=>search.query(token,'s1',query,10,'invalid-'+query),e=>e.status===400&&e.code==='search_token_too_long');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_operations').get().n,before);assert.equal(calls,providerCalls);
  assert.equal(ftsQuery('ＡＢＣ'),'"ＡＢＣ"*','The stored and queried token must share unicode61 transformations');
 }finally{db.close();}
});

test('lexical scope is exact, applies to the whole body OR group and contributes no match rank',async()=>{
 const {db,token,other}=await fixture();try{
  const store=new MemoryStore(db,()=>at),local=await store.create(token,'s1',{body:'alpha alpha'},'local');
  await store.create(other,'s2',{body:'beta beta alpha'},'foreign');
  const search=new Search({DB:db},()=>at),queries=capture(db),result=await search.query(token,'s1','alpha beta',10,'search');
  assert.deepEqual(result.results.map(r=>r.id),[local.id]);
  const lexical=queries.find(q=>q.sql.startsWith('/* lexical-candidates */'));assert.ok(lexical);
  assert.equal(lexical.values[0],'tenant : "t7331" AND body : ("alpha"* OR "beta"*)');assert.doesNotMatch(lexical.sql,/bm25\(|ORDER BY rank/);
  assert.equal((await search.query(token,'s1','t7331',10,'tenant-term')).results.length,0);
  assert.equal(db.raw.prepare('SELECT tenant FROM release_fts WHERE memory_id=?').get(local.id).tenant,'t7331');
 }finally{db.close();}
});

test('claim branches seek configured kinds by pending time or lease expiry and sort only their union',async()=>{
 const {db}=await fixture();try{
  for(let n=0;n<1000;n++)job(db,'backlog-'+n,'upsert','pending',at-10);
  job(db,'expired','delete','leased',at-30,1);job(db,'pending','delete','pending',at-20);
  const queries=capture(db),jobs=new Jobs({DB:db,MEMORY_INDEX:{}},()=>at);
  assert.equal((await jobs.claim()).id,'expired');assert.equal((await jobs.claim()).id,'pending');assert.equal(await jobs.claim(),null,'Unconfigured embedding jobs do not block or get claimed');
  const q=queries.find(q=>q.sql.includes('RETURNING id,memory_id'));const detail=plan(db,q);
  assert.match(detail,/SEARCH release_jobs USING (?:COVERING )?INDEX release_jobs_pending_claim/);assert.match(detail,/SEARCH release_jobs USING INDEX release_jobs_leased_claim/);
  assert.equal((detail.match(/TEMP B-TREE FOR ORDER BY/g)??[]).length,1,detail);
  for(const cleanup of queries.filter(q=>q.sql.startsWith('UPDATE release_jobs')&&!q.sql.includes('RETURNING'))){assert.doesNotMatch(plan(db,cleanup),/SCAN release_jobs\b/);}
 }finally{db.close();}
});

test('claim retires only100 exhausted leases per pass without blocking later eligible work',async()=>{
 const {db}=await fixture();try{
  for(let n=0;n<201;n++)job(db,'exhausted-'+String(n).padStart(3,'0'),'upsert','leased',at-100,5);
  job(db,'cleanup','upsert','pending',at,0,1);
  const jobs=new Jobs({DB:db,MEMORY_INDEX:{}},()=>at);assert.equal((await jobs.claim()).id,'cleanup');
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='dead' AND last_error='lease_expired_attempts_exhausted'").get().n,100);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='leased' AND attempt=5").get().n,101);
  await jobs.claim();await jobs.claim();assert.equal(db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='dead'").get().n,201);
 }finally{db.close();}
});

test('maintenance advances through obsolete done jobs using a bounded indexed raw page',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'retained'},'create');await store.remove(token,'s1',memory.id,1,'delete');
  db.raw.exec("UPDATE release_jobs SET state='done',available_at=0");
  for(let n=0;n<201;n++)job(db,'!obsolete-'+String(n).padStart(3,'0'),'upsert','done',0);
  const jobs=new Jobs({DB:db,BACKGROUND_JOBS_ENABLED:'true',MEMORY_INDEX:{}},()=>at),queries=capture(db);
  await jobs.maintain();assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(memory.id+':2').state,'done');
  assert.equal(db.raw.prepare("SELECT cursor FROM release_maintenance_progress WHERE name='vector_resweep'").get().cursor,'!obsolete-099');
  await jobs.maintain();await jobs.maintain();assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(memory.id+':2').state,'pending');
  const pages=queries.filter(q=>q.sql.startsWith('SELECT id FROM release_jobs INDEXED BY release_jobs_done_sweep'));assert.deepEqual(pages.map(q=>q.count),[100,100,3]);
  for(const q of pages){assert.match(plan(db,q),/SEARCH release_jobs USING (?:COVERING )?INDEX release_jobs_done_sweep/);assert.doesNotMatch(plan(db,q),/TEMP B-TREE/);}
 }finally{db.close();}
});

test('automatic erasure examines bounded raw tombstone pages and eventually reaches a due policy',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at);await store.retention(token,'s1',3650);await store.retention(token,'so',1);
  for(let n=0;n<21;n++){const m=await store.create(token,'s1',{body:'retained'},'keep-'+n);await store.remove(token,'s1',m.id,1,'delete-'+n);}
  const due=await store.create(token,'so',{body:'expired'},'due');await store.remove(token,'so',due.id,1,'delete-due');
  const jobs=new Jobs({DB:db,AUTO_ERASURE_ENABLED:'true'},()=>at+86400001),queries=capture(db);
  await jobs.maintain();await jobs.maintain();
  assert.notEqual(db.raw.prepare('SELECT erased_at FROM memories WHERE id=?').get(due.id).erased_at,null);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM memories WHERE space_id='s1' AND erased_at IS NULL").get().n,21);
  const pages=queries.filter(q=>q.sql.includes('FROM memories r')&&q.sql.includes('ORDER BY r.deleted_at'));
  assert.equal(pages.length,2);assert.ok(pages.every(q=>q.count<=20));assert.ok(pages[0].count===20,'Non-due raw tombstones count toward the page bound');
  for(const q of pages){assert.match(plan(db,q),/SEARCH r USING INDEX release_memories_erasure_sweep/);assert.doesNotMatch(plan(db,q),/TEMP B-TREE/);}
  assert.ok(queries.some(q=>q.sql.includes("name='source_erasure'")),'A durable cursor advances over non-due policies');
 }finally{db.close();}
});

test('overlapping maintenance cannot advance or mutate targets under a replaced cursor',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'retained'},'create');await store.remove(token,'s1',memory.id,1,'delete');
  db.raw.exec("UPDATE release_jobs SET state='done',available_at=0");
  const original=db.batch.bind(db);db.batch=async statements=>{
   db.raw.exec("UPDATE release_maintenance_progress SET cursor='other-worker-progress' WHERE name='vector_resweep'");
   return original(statements);
  };
  await new Jobs({DB:db,BACKGROUND_JOBS_ENABLED:'true',MEMORY_INDEX:{}},()=>at).maintain();
  assert.equal(db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(memory.id+':2').state,'done');
  assert.equal(db.raw.prepare("SELECT cursor FROM release_maintenance_progress WHERE name='vector_resweep'").get().cursor,'other-worker-progress');
 }finally{db.close();}
});

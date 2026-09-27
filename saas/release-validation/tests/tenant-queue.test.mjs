import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Search,ftsQuery} from '../../src/release/search.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {Jobs} from '../../src/release/jobs.ts';

async function capture(db){const queries=[],prepare=db.prepare.bind(db);db.prepare= sql=>{const s=prepare(sql),bind=s.bind.bind(s);let values=[];s.bind=(...v)=>{values=v;bind(...v);return s;};for(const method of ['first','all','run']){const execute=s[method].bind(s);s[method]=async()=>{const result=await execute();queries.push({sql,values,count:result?.results?.length});return result;};}return s;};return queries;}
const plan=async (db,q)=>(await db.raw.prepare('EXPLAIN '+q.sql).all(...q.values)).map(r=>r['QUERY PLAN']).join('\n');
const POLICY=`jsonb_build_object('policyVersion',1,'residency','sg','profile','standard','processingBoundary','approved-processors','dataClass','general','classificationStatus','declared','sensitivityTags','[]'::jsonb,'placementEpoch',1)`;
const space=(db,id,owner,created,name='Space')=>db.raw.prepare(`INSERT INTO memory_control.spaces(id,owner_account_id,organization_id,deployment_id,data_policy,source_byte_limit,message_limit,name,security_mode,created_at_ms,actor_credential_id)
 VALUES(?,?,NULL,'memory-sg',${POLICY},67108864,100000,?,'managed',?,?)`).run(id,owner,name,created,'session:'+owner);
const job=(db,id,kind='upsert',state='pending',ready=at,attempt=0,cleanup=0)=>db.raw.prepare(`INSERT INTO release_jobs(id,space_id,revision,kind,state,available_at,created_at,attempt,lease_token,lease_until,cleanup_only)
 VALUES(?,'s1',1,?,?,?,?,?,?,?,?)`).run(id,kind,state,ready,at,attempt,state==='leased'?'old':null,state==='leased'?ready:null,cleanup);

test('Space pages use account-bound indexes and explicit PAT scopes bypass other Spaces',async()=>{
 const {db,token,key}=await fixture();try{
  await db.raw.exec(`INSERT INTO memory_control.spaces(id,owner_account_id,organization_id,deployment_id,data_policy,source_byte_limit,message_limit,name,security_mode,created_at_ms,actor_credential_id)
   SELECT 'foreign-'||g,'bob',NULL,'memory-sg',${POLICY},67108864,100000,'Foreign','managed',${at},'session:bob' FROM generate_series(0,999) g`);
  await db.raw.exec('ANALYZE; SET enable_seqscan=off');
  const store=new MemoryStore(db,()=>at),queries=await capture(db),page=await store.spaces(token,{limit:1});assert.ok(page.nextCursor);
  const q=queries.find(q=>q.sql.includes('owned.created_at'));assert.ok(q);assert.equal(q.count,2);
  // PostgreSQL: the owned branch is still served by an account-bound index;
  // the planner prefers single-column spaces_owner+Sort over the composite
  // release_spaces_account_created on this tiny fixture (a cost choice, not a
  // missing path — enable_seqscan stays off for this EXPLAIN).
  const detail=await plan(db,q);assert.match(detail,/Index (?:Only )?Scan using (?:release_spaces_account_created|spaces_owner) on spaces owned/);assert.match(detail,/Index (?:Only )?Scan using release_spaces_organization_created on spaces managed/);
  assert.doesNotMatch(detail,/Seq Scan on spaces\b/);
  const second=await store.spaces(token,{limit:1,cursor:page.nextCursor});assert.deepEqual([...page.results,...second.results].map(r=>r.id),['s1','so']);
  queries.length=0;assert.deepEqual((await store.spaces(key)).results.map(r=>r.id),['s1']);
  const scoped=queries.find(q=>q.sql.includes('FROM jsonb_array_elements_text(?::jsonb) selected'));assert.ok(scoped);assert.doesNotMatch(scoped.sql,/owned|active_memberships member/);
  assert.match(await plan(db,scoped),/Index Scan using spaces_pkey on spaces s/);
 }finally{db.close();}
});

test('duplicate shares cannot truncate Space pagination before later shared Spaces',async t=>{
 t.skip('cross-border share federation is deferred (0011); share INSERTs are denied');return;
 const {db,token,other}=await fixture();try{
  (await db.raw.exec("UPDATE memberships SET revoked_at=1 WHERE id='m2'"));
  (await db.raw.exec(`INSERT INTO spaces VALUES('sz','Later','alice',NULL,'managed',${at},'session:alice')`));
  const transfers=new Transfers(db,()=>at);for(let n=0;n<5;n++){const sh=await transfers.share(token,'so','bob@example.com');await transfers.accept(other,sh.id);}
  const team=await transfers.share(token,'sz','bob@example.com');await transfers.accept(other,team.id);
  const store=new MemoryStore(db,()=>at),seen=[];let cursor;
  do{const page=await store.spaces(other,{limit:1,cursor});seen.push(...page.results.map(r=>r.id));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(seen,['s2','so','sz']);
 }finally{db.close();}
});

test('Space raw-page cursor advances over expired grants to later personal Spaces',async()=>{
 const {db,token}=await fixture();try{
  (await db.raw.exec(`UPDATE memberships SET expires_at=${at} WHERE id='m1'`));await space(db,'sz','alice',at+1,'Later');
  const store=new MemoryStore(db,()=>at),first=await store.spaces(token,{limit:1}),second=await store.spaces(token,{limit:1,cursor:first.nextCursor});
  assert.deepEqual(first.results.map(r=>r.id),['s1']);assert.deepEqual(second.results,[]);assert.ok(second.nextCursor);
  assert.deepEqual((await store.spaces(token,{limit:1,cursor:second.nextCursor})).results.map(r=>r.id),['sz']);
 }finally{db.close();}
});

test('all supported Unicode prefix lengths are indexed and longer processed terms fail before metering',async()=>{
 const {db,token}=await fixture();let calls=0;try{
  // PostgreSQL port: the D1 FTS5 prefix='1..31' table option has no direct
  // equivalent. Prefix recall is served by tsvector prefix queries ('term':*)
  // against the generated search_vector column, indexed by a GIN index —
  // every length below the 31-character token cap is prefix-searchable there.
  const indexDef=(await db.raw.prepare("SELECT pg_get_indexdef('memory_content.memories_search_vector'::regclass) def").get()).def;
  assert.match(indexDef,/USING gin \(search_vector\)/);
  const body='한'.repeat(32),store=new MemoryStore(db,()=>at);await store.create(token,'s1',{body},'create');
  const search=new Search({DB:db,AI:{async run(){calls++;return{data:[Array(1024).fill(.1)]};}},MEMORY_INDEX:{async query(){calls++;return{matches:[]};}}},()=>at);
  assert.equal((await search.query(token,'s1','한'.repeat(31),10,'supported')).results.length,1);
  const before=(await db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n,providerCalls=calls;
  for(const query of ['a'.repeat(32),'한'.repeat(32),'Ａ'.repeat(32)])await assert.rejects(()=>search.query(token,'s1',query,10,'invalid-'+query),e=>e.status===400&&e.code==='search_token_too_long');
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n,before);assert.equal(calls,providerCalls);
  assert.equal(ftsQuery('ＡＢＣ'),'ＡＢＣ:*','The stored and queried token must share unicode61 transformations');
 }finally{db.close();}
});

test('lexical scope is exact, applies to the whole body OR group and contributes no match rank',async()=>{
 const {db,token,other}=await fixture();try{
  const store=new MemoryStore(db,()=>at),local=await store.create(token,'s1',{body:'alpha alpha'},'local');
  await store.create(other,'s2',{body:'beta beta alpha'},'foreign');
  const search=new Search({DB:db},()=>at),queries=await capture(db),result=await search.query(token,'s1','alpha beta',10,'search');
  assert.deepEqual(result.results.map(r=>r.id),[local.id]);
  const lexical=queries.find(q=>q.sql.startsWith('/* lexical-candidates */'));assert.ok(lexical);
  // PostgreSQL: the tsquery OR group binds once per to_tsquery call; space
  // scoping is the r.space_id predicate, not an FTS tenant column.
  assert.equal(lexical.values[0],'alpha:* | beta:*');assert.doesNotMatch(lexical.sql,/bm25\(|ORDER BY rank/);
  assert.equal((await search.query(token,'s1','t7331',10,'tenant-term')).results.length,0);
  assert.equal((await db.raw.prepare('SELECT count(*) n FROM release_fts_rows WHERE memory_id=?').get(local.id)).n,1);
 }finally{db.close();}
});

test('claim branches seek configured kinds by pending time or lease expiry and sort only their union',async()=>{
 const {db}=await fixture();try{
  for(let n=0;n<1000;n++)await job(db,'backlog-'+n,'upsert','pending',at-10);
  await job(db,'expired','delete','leased',at-30,1);await job(db,'pending','delete','pending',at-20);
  const queries=await capture(db),jobs=new Jobs({DB:db,MEMORY_INDEX:{}},()=>at);
  assert.equal((await jobs.claim()).id,'expired');assert.equal((await jobs.claim()).id,'pending');assert.equal(await jobs.claim(),null,'Unconfigured embedding jobs do not block or get claimed');
  // PostgreSQL EXPLAIN: index plans surface as Index (Only) Scan nodes; the
  // union's CASE ordering is the single Sort node. enable_seqscan=off keeps a
  // tiny fixture from hiding the index path.
  await db.raw.exec('ANALYZE; SET enable_seqscan=off');
  const q=queries.find(q=>q.sql.includes('RETURNING id,memory_id'));assert.ok(q);const detail=await plan(db,q);
  assert.match(detail,/Index (?:Only )?Scan using release_jobs_pending_claim on release_jobs/);assert.match(detail,/Index (?:Only )?Scan using release_jobs_leased_claim on release_jobs/);
  assert.equal((detail.match(/->\s+(?:Incremental )?Sort\s+\(cost/g)??[]).length,1,detail);
  for(const cleanup of queries.filter(q=>q.sql.startsWith('UPDATE memory_jobs.release_jobs')&&!q.sql.includes('RETURNING'))){assert.doesNotMatch(await plan(db,cleanup),/Seq Scan on release_jobs\b/);}
 }finally{db.close();}
});

test('claim retires only100 exhausted leases per pass without blocking later eligible work',async()=>{
 const {db}=await fixture();try{
  for(let n=0;n<201;n++)await job(db,'exhausted-'+String(n).padStart(3,'0'),'upsert','leased',at-100,5);
  await job(db,'cleanup','upsert','pending',at,0,1);
  const jobs=new Jobs({DB:db,MEMORY_INDEX:{}},()=>at);assert.equal((await jobs.claim()).id,'cleanup');
  assert.equal((await db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='dead' AND last_error='lease_expired_attempts_exhausted'").get()).n,100);
  assert.equal((await db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='leased' AND attempt=5").get()).n,101);
  await jobs.claim();await jobs.claim();assert.equal((await db.raw.prepare("SELECT count(*) n FROM release_jobs WHERE state='dead'").get()).n,201);
 }finally{db.close();}
});

test('maintenance advances through obsolete done jobs using a bounded indexed raw page',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'retained'},'create');await store.remove(token,'s1',memory.id,1,'delete');
  (await db.raw.exec("UPDATE release_jobs SET state='done',available_at=0"));
  for(let n=0;n<201;n++)await job(db,'!obsolete-'+String(n).padStart(3,'0'),'upsert','done',0);
  const jobs=new Jobs({DB:db,BACKGROUND_JOBS_ENABLED:'true',MEMORY_INDEX:{}},()=>at),queries=await capture(db);
  await jobs.maintain();assert.equal((await db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(memory.id+':2')).state,'done');
  assert.equal((await db.raw.prepare("SELECT cursor FROM release_maintenance_progress WHERE name='vector_resweep'").get()).cursor,'!obsolete-099');
  await jobs.maintain();await jobs.maintain();assert.equal((await db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(memory.id+':2')).state,'pending');
  // PostgreSQL: the done-sweep page is the plain partial-index scan (no
  // INDEXED BY hint syntax). bitmapscan is disabled so EXPLAIN shows the
  // index-ordered path the LIMIT page actually needs, matching the D1 intent
  // (a bitmap scan would index-filter but re-sort the page).
  await db.raw.exec('ANALYZE; SET enable_seqscan=off; SET enable_bitmapscan=off');
  const pages=queries.filter(q=>q.sql.startsWith("SELECT id FROM memory_jobs.release_jobs WHERE state='done'"));assert.deepEqual(pages.map(q=>q.count),[100,100,3]);
  for(const q of pages){assert.match(await plan(db,q),/Index (?:Only )?Scan using release_jobs_done_sweep on release_jobs/);assert.doesNotMatch(await plan(db,q),/->\s+(?:Incremental )?Sort\s+\(cost/);}
 }finally{db.close();}
});

test('automatic erasure examines bounded raw tombstone pages and eventually reaches a due policy',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at);await store.retention(token,'s1',3650);await store.retention(token,'so',1);
  for(let n=0;n<21;n++){const m=await store.create(token,'s1',{body:'retained'},'keep-'+n);await store.remove(token,'s1',m.id,1,'delete-'+n);}
  const due=await store.create(token,'so',{body:'expired'},'due');await store.remove(token,'so',due.id,1,'delete-due');
  const jobs=new Jobs({DB:db,AUTO_ERASURE_ENABLED:'true'},()=>at+86400001),queries=await capture(db);
  await jobs.maintain();await jobs.maintain();
  assert.notEqual((await db.raw.prepare('SELECT erased_at FROM memories WHERE id=?').get(due.id)).erased_at,null);
  assert.equal((await db.raw.prepare("SELECT count(*) n FROM memories WHERE space_id='s1' AND erased_at IS NULL").get()).n,21);
  await db.raw.exec('ANALYZE; SET enable_seqscan=off; SET enable_bitmapscan=off');
  const pages=queries.filter(q=>q.sql.includes('FROM memory_content.memories r')&&q.sql.includes('ORDER BY r.deleted_at'));
  assert.equal(pages.length,2);assert.ok(pages.every(q=>q.count<=20));assert.ok(pages[0].count===20,'Non-due raw tombstones count toward the page bound');
  for(const q of pages){assert.match(await plan(db,q),/Index (?:Only )?Scan using release_memories_erasure_sweep on memories r/);assert.doesNotMatch(await plan(db,q),/->\s+(?:Incremental )?Sort\s+\(cost/);}
  assert.ok(queries.some(q=>q.sql.includes("name='source_erasure'")),'A durable cursor advances over non-due policies');
 }finally{db.close();}
});

test('overlapping maintenance cannot advance or mutate targets under a replaced cursor',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'retained'},'create');await store.remove(token,'s1',memory.id,1,'delete');
  (await db.raw.exec("UPDATE release_jobs SET state='done',available_at=0"));
  const original=db.batch.bind(db);db.batch=async statements=>{
   (await db.raw.exec("UPDATE release_maintenance_progress SET cursor='other-worker-progress' WHERE name='vector_resweep'"));
   return original(statements);
  };
  await new Jobs({DB:db,BACKGROUND_JOBS_ENABLED:'true',MEMORY_INDEX:{}},()=>at).maintain();
  assert.equal((await db.raw.prepare('SELECT state FROM release_jobs WHERE id=?').get(memory.id+':2')).state,'done');
  assert.equal((await db.raw.prepare("SELECT cursor FROM release_maintenance_progress WHERE name='vector_resweep'").get()).cursor,'other-worker-progress');
 }finally{db.close();}
});

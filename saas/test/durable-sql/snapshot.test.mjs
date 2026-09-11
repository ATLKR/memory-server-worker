import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { SnapshotImporter, snapshotCanonical, validateSnapshotPlan } from '../../src/durable-sql/snapshot.ts';

const identity={deploymentId:'snapshot-test',databaseId:'control',kind:'control',epoch:1};
const name='sql:snapshot-test:control:1', now=Date.now();
const keys=generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64url');
const hash=value=>createHash('sha256').update(snapshotCanonical(value)).digest('hex');
function grant(plan, at=now){const value={planHash:hash(plan),notBeforeMs:at-1000,expiresAtMs:at+60000};return {...value,signature:sign(null,Buffer.from(snapshotCanonical(value)),keys.privateKey).toString('base64url')};}
function fixture(){
 const raw=new DatabaseSync(':memory:');raw.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE durable_sql_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),deployment_id TEXT NOT NULL,database_id TEXT NOT NULL,kind TEXT NOT NULL,epoch INTEGER NOT NULL,status TEXT NOT NULL,schema_hash TEXT NOT NULL,snapshot_hash TEXT NOT NULL);`);
 const storage={sql:{exec(sql,...values){const s=raw.prepare(sql);const rows=s.all(...values);return {toArray:()=>rows};}},transactionSync(fn){raw.exec('SAVEPOINT test_import');try{const r=fn();raw.exec('RELEASE test_import');return r;}catch(e){raw.exec('ROLLBACK TO test_import; RELEASE test_import');throw e;}}};
 const importer=new SnapshotImporter(storage,{objectName:name,publicKey,clock:()=>now});importer.initialize();
 return {raw,storage,importer};
}
function sample(){
 const schema=[
  {type:'table',name:'parents',tableName:'parents',sql:'CREATE TABLE parents(id TEXT PRIMARY KEY)'},
  {type:'table',name:'history',tableName:'history',sql:'CREATE TABLE history(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES parents(id),at_ms INTEGER NOT NULL)'},
  {type:'table',name:'counter',tableName:'counter',sql:'CREATE TABLE counter(id INTEGER PRIMARY KEY,n INTEGER NOT NULL)'},
  {type:'trigger',name:'historical_denied',tableName:'history',sql:"CREATE TRIGGER historical_denied BEFORE INSERT ON history WHEN NEW.at_ms<100000 BEGIN SELECT RAISE(ABORT,'old command replayed'); END"},
  {type:'trigger',name:'history_counter',tableName:'history',sql:'CREATE TRIGGER history_counter AFTER INSERT ON history BEGIN UPDATE counter SET n=n+1 WHERE id=1; END'}
 ];
 const data=[{table:'history',columns:['id','parent_id','at_ms'],rows:[['h1','p1',1]]},{table:'parents',columns:['id'],rows:[['p1']]},{table:'counter',columns:['id','n'],rows:[[1,7]]}];
 const chunks=data.map((d,index)=>({index,table:d.table,start:0,rowCount:d.rows.length,hash:hash(d.rows)}));
 const tables=data.map(d=>({name:d.table,columns:d.columns,rowCount:d.rows.length}));
 const plan={version:1,identity,schema,tables,chunks,schemaHash:hash(schema),snapshotHash:hash({tables,chunks}),sourceRevision:'a'.repeat(40),sourceFrozenAtMs:now-1000};
 return {plan,data,grant:grant(plan)};
}

test('snapshot manifest refuses FTS modes whose searchable index cannot be reconstructed from visible rows',()=>{
 for(const suffix of ["content=''", "content='records'", 'content = records']){
  const {plan}=sample();
  plan.schema.push({type:'table',name:'search',tableName:'search',sql:`CREATE VIRTUAL TABLE search USING fts5(body,${suffix})`});
  plan.tables.push({name:'search',columns:['rowid','body'],rowCount:0});
  assert.throws(()=>validateSnapshotPlan(plan,name),/snapshot_manifest/);
 }
});

test('sealed snapshot restores historical rows without replaying live triggers and preserves deferred foreign keys',async()=>{
 const f=fixture(),s=sample();try{
  await f.importer.begin(s.plan,s.grant);
  for(let index=0;index<s.data.length;index++)await f.importer.append({planHash:hash(s.plan),index,rows:s.data[index].rows},s.grant);
  assert.equal(f.raw.prepare('SELECT status FROM durable_sql_state').get().status,'importing');
  const result=await f.importer.seal({planHash:hash(s.plan)},s.grant);
  assert.equal(result.ready,true);assert.equal(result.rows,3);
  assert.equal(f.raw.prepare('SELECT n FROM counter').get().n,7);
  assert.equal(f.raw.prepare('SELECT at_ms FROM history').get().at_ms,1);
  assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.throws(()=>f.raw.prepare('INSERT INTO history VALUES(?,?,?)').run('h2','p1',1),/old command replayed/);
  f.raw.prepare('INSERT INTO history VALUES(?,?,?)').run('h2','p1',100000);
  assert.equal(f.raw.prepare('SELECT n FROM counter').get().n,8);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_import_rows').get().n,0);
  await assert.rejects(()=>f.importer.append({planHash:hash(s.plan),index:0,rows:s.data[0].rows},s.grant),/snapshot_closed/);
  assert.equal((await f.importer.seal({planHash:hash(s.plan)},s.grant)).ready,true);
 }finally{f.raw.close();}
});

test('bad signature, expired grant and wrong named object cannot initialize an import',async()=>{
 const f=fixture(),s=sample();try{
  await assert.rejects(()=>f.importer.begin(s.plan,{...s.grant,signature:'A'.repeat(86)}),/snapshot_authorization/);
  await assert.rejects(()=>f.importer.begin(s.plan,grant(s.plan,now-120000)),/snapshot_authorization/);
  const wrong=new SnapshotImporter(f.storage,{objectName:'sql:snapshot-test:other:1',publicKey,clock:()=>now});
  await assert.rejects(()=>wrong.begin(s.plan,s.grant),/snapshot_identity/);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_state').get().n,0);
 }finally{f.raw.close();}
});

test('exact chunk retry is idempotent; mismatched/reordered/incomplete input is rejected',async()=>{
 const f=fixture(),s=sample();try{
  await f.importer.begin(s.plan,s.grant);await f.importer.begin(s.plan,s.grant);
  await assert.rejects(()=>f.importer.append({planHash:hash(s.plan),index:1,rows:s.data[1].rows},s.grant),/snapshot_chunk_order/);
  await f.importer.append({planHash:hash(s.plan),index:0,rows:s.data[0].rows},s.grant);
  assert.equal((await f.importer.append({planHash:hash(s.plan),index:0,rows:s.data[0].rows},s.grant)).replayed,true);
  await assert.rejects(()=>f.importer.append({planHash:hash(s.plan),index:0,rows:[['changed','p1',1]]},s.grant),/snapshot_chunk_hash/);
  await assert.rejects(()=>f.importer.seal({planHash:hash(s.plan)},s.grant),/snapshot_incomplete/);
  assert.equal(f.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='history'").get().n,0);
 }finally{f.raw.close();}
});

test('failed foreign-key verification rolls back schema creation and remains unserved',async()=>{
 const f=fixture(),s=sample();s.data[0].rows[0][1]='missing';s.plan.chunks[0].hash=hash(s.data[0].rows);s.plan.snapshotHash=hash({tables:s.plan.tables,chunks:s.plan.chunks});s.grant=grant(s.plan);
 try{
  await f.importer.begin(s.plan,s.grant);
  for(let index=0;index<s.data.length;index++)await f.importer.append({planHash:hash(s.plan),index,rows:s.data[index].rows},s.grant);
  await assert.rejects(()=>f.importer.seal({planHash:hash(s.plan)},s.grant),/snapshot_foreign_keys/);
  assert.equal(f.raw.prepare('SELECT status FROM durable_sql_state').get().status,'importing');
  assert.equal(f.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='history'").get().n,0);
 }finally{f.raw.close();}
});

test('reserved schema identifiers and incorrect declared row totals fail before import mutation',async()=>{
 for(const mutate of [s=>{s.plan.schema[0].name='durable_sql_state';},s=>{s.plan.tables[0].rowCount=2;}]){
  const f=fixture(),s=sample();mutate(s);s.plan.schemaHash=hash(s.plan.schema);s.plan.snapshotHash=hash({tables:s.plan.tables,chunks:s.plan.chunks});s.grant=grant(s.plan);
  try{await assert.rejects(()=>f.importer.begin(s.plan,s.grant),/snapshot_manifest/);assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_state').get().n,0);}finally{f.raw.close();}
 }
});

test('nonempty target is rejected even when its names resemble wildcard metadata prefixes',async()=>{
 for(const name of ['abcf_orphan','durableXsqlYorphan','sqlitexorphan','durable_sql_unknown']){
  const f=fixture(),s=sample();f.raw.exec(`CREATE TABLE ${name}(id TEXT)`);
  try{await assert.rejects(()=>f.importer.begin(s.plan,s.grant),/snapshot_target_not_empty/);assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_state').get().n,0);}finally{f.raw.close();}
 }
});

test('abandon removes pending plaintext, leaves a failed identity, and cannot erase a sealed database',async()=>{
 const f=fixture(),s=sample();try{
  await f.importer.begin(s.plan,s.grant);
  await f.importer.append({planHash:hash(s.plan),index:0,rows:s.data[0].rows},s.grant);
  assert.equal((await f.importer.abandon({planHash:hash(s.plan)},s.grant)).abandoned,true);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_import_rows').get().n,0);
  assert.equal(f.raw.prepare('SELECT status FROM durable_sql_state').get().status,'failed');
  await assert.rejects(()=>f.importer.append({planHash:hash(s.plan),index:0,rows:s.data[0].rows},s.grant),/snapshot_closed/);
  await assert.rejects(()=>f.importer.seal({planHash:hash(s.plan)},s.grant),/snapshot_closed/);
  assert.equal((await f.importer.abandon({planHash:hash(s.plan)},s.grant)).abandoned,true);
 }finally{f.raw.close();}
 const f2=fixture(),s2=sample();try{
  await f2.importer.begin(s2.plan,s2.grant);
  for(let index=0;index<s2.data.length;index++)await f2.importer.append({planHash:hash(s2.plan),index,rows:s2.data[index].rows},s2.grant);
  await f2.importer.seal({planHash:hash(s2.plan)},s2.grant);
  await assert.rejects(()=>f2.importer.abandon({planHash:hash(s2.plan)},s2.grant),/snapshot_closed/);
  assert.equal(f2.raw.prepare('SELECT n FROM counter').get().n,7);
 }finally{f2.raw.close();}
});

test('rowid alias is preserved when a declared INTEGER PRIMARY KEY uses a different name',async()=>{
 const f=fixture(),s=sample();
 s.plan.tables[2].columns.unshift('rowid');s.data[2].rows[0].unshift(1);s.plan.chunks[2].hash=hash(s.data[2].rows);
 s.plan.snapshotHash=hash({tables:s.plan.tables,chunks:s.plan.chunks});s.grant=grant(s.plan);
 try{
  await f.importer.begin(s.plan,s.grant);
  for(let index=0;index<s.data.length;index++)await f.importer.append({planHash:hash(s.plan),index,rows:s.data[index].rows},s.grant);
  assert.equal((await f.importer.seal({planHash:hash(s.plan)},s.grant)).ready,true);
  assert.equal(f.raw.prepare('SELECT rowid AS original_rowid FROM counter').get().original_rowid,1);
 }finally{f.raw.close();}
});

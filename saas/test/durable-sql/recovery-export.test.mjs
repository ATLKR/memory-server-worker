import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash,generateKeyPairSync,sign } from 'node:crypto';
import { snapshotCanonical,validateSnapshotPlan } from '../../src/durable-sql/snapshot.ts';
import { SqlDatabaseEngine } from '../../src/durable-sql/engine.ts';
import { SnapshotImporter } from '../../src/durable-sql/snapshot.ts';
import { SqlRecoveryController } from '../../src/durable-sql/recovery.ts';
const module=await import('../../src/durable-sql/recovery-export.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const identity={deploymentId:'recovery-export',databaseId:'control',kind:'control',epoch:1},objectName='sql:recovery-export:control:1';
const hash=value=>createHash('sha256').update(snapshotCanonical(value)).digest('hex');
const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64url');
function authorize(action,input){const v={domain:'memory-sql-recovery-v1',action,identity:input.identity,runId:input.runId,requestHash:hash(input),notBeforeMs:99900,expiresAtMs:101000};return {...v,signature:sign(null,Buffer.from(snapshotCanonical(v)),keys.privateKey).toString('base64url')};}
function fixture(){
 const raw=new DatabaseSync(':memory:');let inTransaction=false,reads=0;
 const storage={sql:{exec(sql,...values){reads++;const rows=raw.prepare(sql).all(...values);return {toArray:()=>rows,rowsWritten:/^(INSERT|UPDATE|DELETE)/i.test(sql)?1:0,[Symbol.iterator]:()=>rows[Symbol.iterator]()};}},transactionSync(fn){assert.equal(inTransaction,false);inTransaction=true;raw.exec('SAVEPOINT recovery_export');try{const result=fn();raw.exec('RELEASE recovery_export');return result;}catch(error){raw.exec('ROLLBACK TO recovery_export;RELEASE recovery_export');throw error;}finally{inTransaction=false;}}};
 const engine=new SqlDatabaseEngine(storage,{objectName});engine.initialize();const importer=new SnapshotImporter(storage,{objectName,publicKey});importer.initialize();
 raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run(identity.deploymentId,identity.databaseId,identity.kind,identity.epoch,'ready','a'.repeat(64),'b'.repeat(64));
 raw.prepare('INSERT INTO durable_sql_import VALUES(1,?,?,0,0,1)').run('c'.repeat(64),'{}');
 const recovery=new SqlRecoveryController({storage,objectName,publicKey,clock:()=>100000});
 const freeze={version:1,identity,runId:'d'.repeat(24),sourceRevision:'e'.repeat(40)};
 const receipt={...freeze,freezeRequestHash:hash(freeze),frozenAtMs:100000,importPlanHash:'c'.repeat(64)};
 return {raw,storage,engine,recovery,freeze,receipt,get reads(){return reads;}};
}
function collect(f){assert.equal(typeof module.collectRecoverySnapshot,'function','current frozen catalog exporter must exist');return f.storage.transactionSync(()=>module.collectRecoverySnapshot(f.storage,f.receipt));}

test('current export preserves rowids, NULL, FTS, empty tables, triggers and retained sequence gaps',async()=>{
 const f=fixture();try{
  f.raw.exec("CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT);CREATE TABLE empty_table(id TEXT);CREATE TABLE history(id INTEGER,value TEXT);CREATE VIRTUAL TABLE search USING fts5(value);CREATE TRIGGER record_history AFTER UPDATE ON records BEGIN INSERT INTO history VALUES(NEW.id,NEW.value); END;INSERT INTO records VALUES(-7,NULL),(90,'retired');DELETE FROM records WHERE id=90;UPDATE records SET value='현재 alpha';INSERT INTO search(rowid,value) VALUES(-9,'현재 alpha');CREATE TABLE __cf_kv(id INTEGER PRIMARY KEY AUTOINCREMENT);INSERT INTO __cf_kv VALUES(200)");
  const collected=collect(f),before=f.reads,result=await module.finalizeRecoverySnapshot(collected);
  assert.equal(f.reads,before,'asynchronous hashes must not read storage');validateSnapshotPlan(result.plan,objectName);
  assert.ok(!result.plan.tables.some(table=>/^(durable_sql_|_cf_)/.test(table.name)));
  assert.equal(result.plan.tables.find(table=>table.name==='empty_table').rowCount,0);
  const rows=table=>collected.chunks.filter(chunk=>chunk.table===table).flatMap(chunk=>chunk.rows);
  assert.deepEqual(rows('records'),[[-7,-7,'현재 alpha']]);assert.deepEqual(rows('search'),[[-9,'현재 alpha']]);assert.deepEqual(rows('history'),[[1,-7,'현재 alpha']]);
  assert.deepEqual(rows('sqlite_sequence'),[[1,'records',90]]);
  assert.equal(result.summary.planHash,hash(result.plan));assert.equal(result.summary.rowCount,4);
  assert.equal(result.summary.sourceFrozenAtMs,100000);assert.notEqual(result.plan.snapshotHash,'b'.repeat(64));
  for(const descriptor of result.plan.chunks){const actual=f.storage.transactionSync(()=>module.readCollectedChunk(f.storage,result.plan,descriptor.index));assert.deepEqual(actual,collected.chunks[descriptor.index].rows);assert.equal(hash(actual),descriptor.hash);}
 }finally{f.raw.close();}
});

test('sequence part starts count retained rows despite interleaved provider sequence rows',async()=>{
 const f=fixture();try{
  f.raw.exec("CREATE TABLE __cf_kv(id INTEGER PRIMARY KEY AUTOINCREMENT);INSERT INTO __cf_kv VALUES(9);CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT);INSERT INTO records VALUES(70);DELETE FROM records");
  const c=collect(f),{plan}=await module.finalizeRecoverySnapshot(c),i=plan.chunks.findIndex(chunk=>chunk.table==='sqlite_sequence');
  assert.deepEqual(f.storage.transactionSync(()=>module.readCollectedChunk(f.storage,plan,i)),[[2,'records',70]]);
 }finally{f.raw.close();}
});

test('ambiguous FTS shadow names fail closed instead of dropping unrelated application rows',()=>{
 const f=fixture();try{
  f.raw.exec("CREATE TABLE search_docsize(value TEXT);INSERT INTO search_docsize VALUES('retained application row');CREATE VIRTUAL TABLE search USING fts5(value,columnsize=0)");
  assert.throws(()=>collect(f),/recovery_source_changed/);
 }finally{f.raw.close();}
});

test('an exact shadow-definition spoof remains unsupported when FTS disables that shadow storage',()=>{
 for(const option of ['columnsize=0',"columnsize='0'",'columnsize="0"']){
  const f=fixture();try{
   f.raw.exec("CREATE TABLE 'search_docsize'(id INTEGER PRIMARY KEY, sz BLOB);INSERT INTO search_docsize VALUES(1,'application history');CREATE VIRTUAL TABLE search USING fts5(value,"+option+")");
   assert.throws(()=>collect(f),/recovery_source_changed/);
  }finally{f.raw.close();}
 }
});

test('D1-like table names are retained application data in a Durable SQL source',async()=>{
 const f=fixture();try{
  f.raw.exec("CREATE TABLE d1_migrations(value TEXT);CREATE TABLE _cf_metadata(value TEXT);CREATE TABLE _cf_kv(value TEXT);INSERT INTO d1_migrations VALUES('one');INSERT INTO _cf_metadata VALUES('two');INSERT INTO _cf_kv VALUES('three')");
  const c=collect(f);
  for(const [name,value] of [['d1_migrations','one'],['_cf_metadata','two'],['_cf_kv','three']])assert.deepEqual(c.chunks.find(chunk=>chunk.table===name)?.rows,[[1,value]],name);
 }finally{f.raw.close();}
});

test('export refuses unsupported values, rowid aliases, virtual schemas, unknown metadata and capacity excess',()=>{
 for(const ddl of ["CREATE TABLE records(value BLOB);INSERT INTO records VALUES(x'00')",'CREATE TABLE records(rowid TEXT)',"CREATE VIRTUAL TABLE records USING fts5(value,content='')",'CREATE TABLE records(id INTEGER PRIMARY KEY) WITHOUT ROWID','CREATE TABLE records(value);CREATE TABLE durable_sql_unknown(value)',"CREATE TABLE records(value);INSERT INTO records VALUES('"+'x'.repeat(524288)+"')"]){
  const f=fixture();try{f.raw.exec(ddl);assert.equal(typeof module.collectRecoverySnapshot,'function');assert.throws(()=>collect(f),/recovery_capacity|recovery_source_changed|recovery_metadata_invalid/);}finally{f.raw.close();}
 }
});

test('prepared manifest and chunks are exact, bounded and require the active frozen cut',async()=>{
 const f=fixture();try{
  f.raw.exec("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO records VALUES(1,'old')");
  const r=await f.recovery.freezeRecovery(f.freeze,authorize('freeze',f.freeze)),scope={identity,runId:r.runId,freezeRequestHash:r.freezeRequestHash};
  assert.equal(typeof f.recovery.prepareRecoveryExport,'function','bounded recovery export RPC must exist');
  const summary=await f.recovery.prepareRecoveryExport(scope,authorize('prepare-export',scope));
  assert.deepEqual(await f.recovery.prepareRecoveryExport(scope,authorize('prepare-export',scope)),summary);
  const mi={...scope,planHash:summary.planHash,pageIndex:0},page=await f.recovery.readRecoveryManifest(mi,authorize('manifest-page',mi));
  const data=Buffer.from(page.data,'base64url');assert.equal(data.length,page.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),page.sha256);
  const plan=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));assert.equal(hash(plan),summary.planHash);
  const ci={...scope,planHash:summary.planHash,index:0},chunk=await f.recovery.readRecoveryChunk(ci,authorize('chunk',ci));assert.deepEqual(chunk.rows,[[1,1,'old']]);assert.equal(hash(chunk.rows),chunk.hash);
  for(const bad of [{...ci,index:1},{...ci,planHash:'0'.repeat(64)}])await assert.rejects(f.recovery.readRecoveryChunk(bad,authorize('chunk',bad)),/recovery_part/);
  const release={...scope,expectedPlanHash:summary.planHash,decision:'backup-verified',evidenceHash:'f'.repeat(64)};await f.recovery.releaseRecovery(release,authorize('release',release));
  await assert.rejects(f.recovery.readRecoveryChunk(ci,authorize('chunk',ci)),/recovery_closed/);
  await assert.rejects(f.recovery.prepareRecoveryExport(scope,authorize('prepare-export',scope)),/recovery_closed/);
 }finally{f.raw.close();}
});

test('release during prepare or chunk hash never returns a closed cut or overwrites retained summary',async()=>{
 for(const method of ['prepareRecoveryExport','readRecoveryChunk']){
  const f=fixture(),original=crypto.subtle.digest.bind(crypto.subtle);let resume;try{
   f.raw.exec("CREATE TABLE records(value TEXT);INSERT INTO records VALUES('original')");
   const r=await f.recovery.freezeRecovery(f.freeze,authorize('freeze',f.freeze)),scope={identity,runId:r.runId,freezeRequestHash:r.freezeRequestHash};
   assert.equal(typeof f.recovery.prepareRecoveryExport,'function');
   const summary=method==='readRecoveryChunk'?await f.recovery.prepareRecoveryExport(scope,authorize('prepare-export',scope)):null;
   const input=summary?{...scope,planHash:summary.planHash,index:0}:scope;let started,hold=true;
   const waiting=new Promise(resolve=>started=resolve);
   crypto.subtle.digest=async(...args)=>{const result=await original(...args);if(hold&&Buffer.from(args[1]).toString().startsWith('[[')){hold=false;started();await new Promise(resolve=>resume=resolve);}return result;};
   const pending=f.recovery[method](input,authorize(summary?'chunk':'prepare-export',input));await waiting;
   const release={...scope,expectedPlanHash:summary?.planHash??null,decision:'operator-abort',evidenceHash:'f'.repeat(64)};
   await f.recovery.releaseRecovery(release,authorize('release',release));resume();await assert.rejects(pending,/recovery_closed/);
   const status=await f.recovery.recoveryStatus(scope,authorize('status',scope));assert.equal(status.state,'released');assert.deepEqual(status.exportSummary,summary);
   assert.equal(f.raw.prepare('SELECT plan_json FROM durable_sql_recovery_runs').get().plan_json,null);
  }finally{crypto.subtle.digest=original;resume?.();f.raw.close();}
 }
});

test('concurrent same-run prepare pins one identical plan and customer rows remain only in their application table',async()=>{
 const f=fixture();try{
  f.raw.exec("CREATE TABLE records(value TEXT);INSERT INTO records VALUES('synthetic row-only sentinel')");
  const receipt=await f.recovery.freezeRecovery(f.freeze,authorize('freeze',f.freeze)),scope={identity,runId:receipt.runId,freezeRequestHash:receipt.freezeRequestHash};
  const [first,second]=await Promise.all([f.recovery.prepareRecoveryExport(scope,authorize('prepare-export',scope)),f.recovery.prepareRecoveryExport(scope,authorize('prepare-export',scope))]);
  assert.deepEqual(first,second);
  const metadata=f.raw.prepare('SELECT * FROM durable_sql_recovery_runs').all();
  assert.ok(!snapshotCanonical(metadata).includes('synthetic row-only sentinel'));
  const input={...scope,planHash:first.planHash,index:0};
  assert.deepEqual((await f.recovery.readRecoveryChunk(input,authorize('chunk',input))).rows,[[1,'synthetic row-only sentinel']]);
 }finally{f.raw.close();}
});

test('changed current rows fail their pinned chunk hash and a second prepare cannot replace stored proof',async()=>{
 const f=fixture();try{
  f.raw.exec("CREATE TABLE records(value TEXT);INSERT INTO records VALUES('original')");
  const receipt=await f.recovery.freezeRecovery(f.freeze,authorize('freeze',f.freeze)),scope={identity,runId:receipt.runId,freezeRequestHash:receipt.freezeRequestHash};
  const summary=await f.recovery.prepareRecoveryExport(scope,authorize('prepare-export',scope));
  // Deliberate out-of-band corruption bypasses the normal engine freeze guard.
  f.raw.exec("UPDATE records SET value='changed'");
  const input={...scope,planHash:summary.planHash,index:0};
  await assert.rejects(f.recovery.readRecoveryChunk(input,authorize('chunk',input)),/recovery_source_changed/);
  await assert.rejects(f.recovery.prepareRecoveryExport(scope,authorize('prepare-export',scope)),/recovery_source_changed/);
  assert.deepEqual((await f.recovery.recoveryStatus(scope,authorize('status',scope))).exportSummary,summary);
 }finally{f.raw.close();}
});

test('row and aggregate byte limits reject before retaining an export plan',async()=>{
 for(const ddl of [
  'CREATE TABLE records(value);WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100001) INSERT INTO records SELECT x FROM n',
  "CREATE TABLE records(value);WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<17000) INSERT INTO records SELECT replace(hex(zeroblob(512)),'0','x') FROM n"
 ]){
  const f=fixture();try{
   f.raw.exec(ddl);const receipt=await f.recovery.freezeRecovery(f.freeze,authorize('freeze',f.freeze)),scope={identity,runId:receipt.runId,freezeRequestHash:receipt.freezeRequestHash};
   await assert.rejects(f.recovery.prepareRecoveryExport(scope,authorize('prepare-export',scope)),/recovery_capacity/);
   const state=await f.recovery.recoveryStatus(scope,authorize('status',scope));assert.equal(state.state,'frozen');assert.equal(state.exportSummary,null);
   assert.equal(f.raw.prepare('SELECT plan_json FROM durable_sql_recovery_runs').get().plan_json,null);
  }finally{f.raw.close();}
 }
});

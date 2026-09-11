import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqlDatabaseEngine } from '../../src/durable-sql/engine.ts';
import { generateKeyPairSync,sign,createHash } from 'node:crypto';
import { SnapshotImporter,snapshotCanonical } from '../../src/durable-sql/snapshot.ts';

const recoveryModule=await import('../../src/durable-sql/recovery.ts').catch(()=>({}));
const keys=generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({format:'der',type:'spki'}).toString('base64url');
const hash=value=>createHash('sha256').update(snapshotCanonical(value)).digest('hex');
const signGrant=(action,input,now=100000,extra={})=>{const payload={domain:'memory-sql-recovery-v1',action,identity:input.identity,runId:input.runId,requestHash:hash(input),notBeforeMs:now-100,expiresAtMs:now+1000,...extra};return {...payload,signature:sign(null,Buffer.from(snapshotCanonical(payload)),keys.privateKey).toString('base64url')};};
const freezeInput=()=>({version:1,identity:{...identity},runId:'c'.repeat(24),sourceRevision:'d'.repeat(40)});
function controller(f,options={}){
 assert.equal(typeof recoveryModule.SqlRecoveryController,'function','signed recovery controller must exist');
 return new recoveryModule.SqlRecoveryController({storage:f.storage,objectName,publicKey,clock:()=>100000,...options});
}
function setup(){const f=storageFixture();const importer=new SnapshotImporter(f.storage,{objectName,publicKey});importer.initialize();f.raw.prepare('INSERT INTO durable_sql_import VALUES(1,?,?,0,0,1)').run('e'.repeat(64),'{}');const c=controller(f);c.initialize();return {...f,controller:c,get calls(){return f.calls;}};}
const scopeOf=r=>({identity:r.identity,runId:r.runId,freezeRequestHash:r.freezeRequestHash});

const identity={deploymentId:'recovery-test',databaseId:'control',kind:'control',epoch:1};
const objectName='sql:recovery-test:control:1';
function storageFixture(){
 const raw=new DatabaseSync(':memory:');let calls=[];
 const storage={sql:{exec(sql,...values){calls.push(sql);const statement=raw.prepare(sql),rows=statement.all(...values);return {toArray:()=>rows,rowsWritten:/^(INSERT|UPDATE|DELETE)/i.test(sql)?1:0,[Symbol.iterator]:()=>rows[Symbol.iterator]()};}},transactionSync(fn){raw.exec('SAVEPOINT recovery_test');try{const result=fn();raw.exec('RELEASE recovery_test');return result;}catch(error){raw.exec('ROLLBACK TO recovery_test; RELEASE recovery_test');throw error;}}};
 const engine=new SqlDatabaseEngine(storage,{objectName});engine.initialize();
 raw.exec("INSERT INTO durable_sql_state VALUES(1,'recovery-test','control','control',1,'ready','"+'a'.repeat(64)+"','"+'b'.repeat(64)+"');CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO items VALUES(1,'before')");
 return {raw,storage,engine,get calls(){return calls;},reset(){calls=[];}};
}
test('ordinary execution denies an inconsistent persisted recovery lock before application SQL',()=>{
 const f=storageFixture();try{
  f.raw.exec('CREATE TABLE IF NOT EXISTS durable_sql_recovery_active(singleton INTEGER PRIMARY KEY,run_id TEXT NOT NULL)');
  f.raw.prepare('INSERT INTO durable_sql_recovery_active VALUES(1,?)').run('c'.repeat(24));f.reset();
  assert.throws(()=>f.engine.execute({identity,statements:[{sql:"UPDATE items SET value='after'",values:[],mode:'run'},{sql:'SELECT * FROM items',values:[],mode:'all'}]}),/recovery_metadata_invalid|durable_sql_frozen/);
  assert.equal(f.raw.prepare('SELECT value FROM items').get().value,'before');
  assert.equal(f.calls.some(sql=>/^(UPDATE items|SELECT \* FROM items)/.test(sql)),false);
 }finally{f.raw.close();}
});

test('signed freeze retains prior whole batch and blocks every subsequent read/write until explicit release',async()=>{
 const f=setup();try{
  const input=freezeInput(),grant=signGrant('freeze',input);
  f.engine.execute({identity,statements:[{sql:"UPDATE items SET value='committed'",values:[],mode:'run'},{sql:"INSERT INTO items VALUES(2,'second')",values:[],mode:'run'}]});
  const receipt=await f.controller.freezeRecovery(input,grant),scope=scopeOf(receipt);
  assert.equal(receipt.frozenAtMs,100000);assert.equal(receipt.importPlanHash,'e'.repeat(64));
  assert.deepEqual(await controller(f,{clock:()=>100100}).freezeRecovery(input,grant),receipt);
  for(const sql of ['SELECT 1',"UPDATE items SET value='denied'"]){f.reset();assert.throws(()=>f.engine.execute({identity,statements:[{sql,values:[],mode:'all'}]}),/durable_sql_frozen/);assert.ok(!f.calls.includes(sql));}
  assert.deepEqual(f.raw.prepare('SELECT * FROM items ORDER BY id').all().map(x=>({...x})),[{id:1,value:'committed'},{id:2,value:'second'}]);
  const restarted=controller(f,{clock:()=>110000});
  assert.equal((await restarted.recoveryStatus(scope,signGrant('status',scope,110000))).state,'frozen');
  const release={...scope,expectedPlanHash:null,decision:'operator-abort',evidenceHash:'f'.repeat(64)};
  const released=await restarted.releaseRecovery(release,signGrant('release',release,110000));
  assert.equal(released.releasedAtMs,110000);
  assert.equal(f.engine.execute({identity,statements:[{sql:'SELECT count(*) AS n FROM items',values:[],mode:'all'}]})[0].results[0].n,2);
  await assert.rejects(restarted.freezeRecovery(input,signGrant('freeze',input,110000)),/recovery_closed/);
  assert.equal((await restarted.recoveryStatus(scope,signGrant('status',scope,110000))).state,'released');
 }finally{f.raw.close();}
});

test('invalid request or authorization fails before any source SQL',async()=>{
 const f=setup();try{
  const input=freezeInput();
  const bad=[
   [input,{...signGrant('freeze',input),extra:true}],
   [{...input,extra:true},signGrant('freeze',input)],
   [{...input,sourceRevision:'bad'},signGrant('freeze',input)],
   [input,signGrant('status',input)],
   [input,signGrant('freeze',input,100000,{domain:'memory-sql-import-v1'})],
   [input,signGrant('freeze',input,100000,{runId:'b'.repeat(24)})],
   [input,signGrant('freeze',input,100000,{identity:{...identity,kind:'hot'}})],
   [input,signGrant('freeze',input,100000,{requestHash:'0'.repeat(64)})],
   [input,signGrant('freeze',input,100000,{notBeforeMs:100001})],
   [input,signGrant('freeze',input,100000,{expiresAtMs:100000})],
   [input,signGrant('freeze',input,100000,{expiresAtMs:1900001})],
   [input,{...signGrant('freeze',input),signature:'A'.repeat(86)}],
   [input,{...signGrant('freeze',input),signature:signGrant('freeze',input).signature+'='}],
   [{...input,runId:'1'.repeat(24)},signGrant('freeze',input)]
  ];
  for(const [body,grant] of bad){f.reset();await assert.rejects(f.controller.freezeRecovery(body,grant),/recovery_input|recovery_authorization/);assert.deepEqual(f.calls,[]);}
  for(const key of ['',publicKey+'=',generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).toString('base64url')]){
   const c=controller(f,{publicKey:key});f.reset();await assert.rejects(c.freezeRecovery(input,signGrant('freeze',input)),/recovery_authorization/);assert.deepEqual(f.calls,[]);
  }
 }finally{f.raw.close();}
});

test('same run scope and release evidence are exact; old release replay never clears a later lock',async()=>{
 const f=setup();try{
  const input=freezeInput(),r=await f.controller.freezeRecovery(input,signGrant('freeze',input)),scope=scopeOf(r);
  const second={...input,runId:'a'.repeat(24)};
  await assert.rejects(f.controller.freezeRecovery(second,signGrant('freeze',second)),/recovery_conflict/);
  const badScope={...scope,freezeRequestHash:'0'.repeat(64)};
  await assert.rejects(f.controller.recoveryStatus(badScope,signGrant('status',badScope)),/recovery_conflict/);
  const release={...scope,expectedPlanHash:null,decision:'operator-abort',evidenceHash:'f'.repeat(64)};
  const wrong={...release,decision:'backup-verified'};
  await assert.rejects(f.controller.releaseRecovery(wrong,signGrant('release',wrong)),/recovery_conflict/);
  const receipt=await f.controller.releaseRecovery(release,signGrant('release',release));
  await f.controller.freezeRecovery(second,signGrant('freeze',second));
  assert.deepEqual(await f.controller.releaseRecovery(release,signGrant('release',release)),receipt);
  await assert.rejects(f.controller.recoveryStatus(scope,signGrant('status',scope)),/recovery_conflict/);
  const changed={...release,evidenceHash:'0'.repeat(64)};
  await assert.rejects(f.controller.releaseRecovery(changed,signGrant('release',changed)),/recovery_conflict/);
  assert.throws(()=>f.engine.execute({identity,statements:[{sql:'SELECT 1',values:[],mode:'all'}]}),/durable_sql_frozen/);
 }finally{f.raw.close();}
});

test('nested identity rejects symbol, hidden extra keys and accessors without invoking them or reading SQL',async()=>{
 const f=setup();try{
  for(const descriptor of ['symbol','hidden','getter']){
   let invoked=false;const input=freezeInput(),grant=signGrant('freeze',input);
   if(descriptor==='symbol')input.identity[Symbol('extra')]=true;
   else if(descriptor==='hidden')Object.defineProperty(input.identity,'extra',{value:true});
   else Object.defineProperty(input.identity,'deploymentId',{get(){invoked=true;return identity.deploymentId;}});
   f.reset();await assert.rejects(f.controller.freezeRecovery(input,grant),/recovery_input/);assert.equal(invoked,false);assert.deepEqual(f.calls,[]);
  }
 }finally{f.raw.close();}
});

test('absent status requires sealed exact identity and no conflicting active run',async()=>{
 const f=setup();try{
  const input=freezeInput(),scope={identity,runId:input.runId,freezeRequestHash:hash(input)};
  assert.equal((await f.controller.recoveryStatus(scope,signGrant('status',scope))).state,'absent');
  const wrong={...input,identity:{...identity,epoch:2}};
  await assert.rejects(f.controller.freezeRecovery(wrong,signGrant('freeze',wrong)),/recovery_identity/);
  for(const status of ['importing','failed']){f.raw.prepare('UPDATE durable_sql_state SET status=?').run(status);await assert.rejects(f.controller.recoveryStatus(scope,signGrant('status',scope)),/recovery_not_ready/);}
  f.raw.exec('DELETE FROM durable_sql_state');await assert.rejects(f.controller.freezeRecovery(input,signGrant('freeze',input)),/recovery_not_ready/);
 }finally{f.raw.close();}
});

test('deferred authorization can freeze after early absent status, but cannot commit after its expiry barrier',async()=>{
 for(const expired of [false,true]){
  const f=setup();let now=100000;const c=controller(f,{clock:()=>now});
  const original=crypto.subtle.verify.bind(crypto.subtle);let resume,started;
  const waiting=new Promise(resolve=>started=resolve);let hold=true;
  crypto.subtle.verify=async(...args)=>{const result=await original(...args);if(hold){hold=false;started();await new Promise(resolve=>resume=resolve);}return result;};
  try{
   const input=freezeInput(),scope={identity,runId:input.runId,freezeRequestHash:hash(input)},pending=c.freezeRecovery(input,signGrant('freeze',input));
   await waiting;
   if(expired)now=101000;
   const statusGrant=signGrant('status',scope,now,expired?{notBeforeMs:101000}:{});
   assert.equal((await c.recoveryStatus(scope,statusGrant)).state,'absent');
   resume();
   if(expired){await assert.rejects(pending,/recovery_authorization/);assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_recovery_runs').get().n,0);assert.equal(f.engine.execute({identity,statements:[{sql:'SELECT 1 AS n',values:[],mode:'all'}]})[0].results[0].n,1);}
   else{await pending;assert.equal((await c.recoveryStatus(scope,statusGrant)).state,'frozen');}
  }finally{crypto.subtle.verify=original;resume?.();f.raw.close();}
 }
});

test('every import mutator rejects an active recovery lock without changing sealed source metadata',async()=>{
 const f=setup();try{
  const input=freezeInput();await f.controller.freezeRecovery(input,signGrant('freeze',input));
  const importer=new SnapshotImporter(f.storage,{objectName,publicKey,clock:()=>100000});
  const plan={version:1,identity,schema:[{type:'table',name:'items',tableName:'items',sql:'CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT)'}],tables:[{name:'items',columns:['rowid','id','value'],rowCount:0}],chunks:[],sourceRevision:'d'.repeat(40),sourceFrozenAtMs:100000};
  plan.schemaHash=hash(plan.schema);plan.snapshotHash=hash({tables:plan.tables,chunks:plan.chunks});
  const payload={planHash:hash(plan),notBeforeMs:99900,expiresAtMs:101000};const grant={...payload,signature:sign(null,Buffer.from(snapshotCanonical(payload)),keys.privateKey).toString('base64url')};
  for(const [method,body] of [['begin',plan],['append',{planHash:payload.planHash,index:0,rows:[[1,1,'value']]}],['seal',{planHash:payload.planHash}],['abandon',{planHash:payload.planHash}]]){
   await assert.rejects(importer[method](body,grant),/durable_sql_frozen/);
  }
  assert.equal(f.raw.prepare('SELECT status FROM durable_sql_state').get().status,'ready');
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_recovery_active').get().n,1);
 }finally{f.raw.close();}
});

test('initialized recovery metadata permits signed blank-target import and rejects malformed catalog additions',async()=>{
 const f=storageFixture();try{
  f.raw.exec('DROP TABLE items;DELETE FROM durable_sql_state');
  const importer=new SnapshotImporter(f.storage,{objectName,publicKey,clock:()=>100000});importer.initialize();controller(f).initialize();
  const plan={version:1,identity,schema:[{type:'table',name:'restored',tableName:'restored',sql:'CREATE TABLE restored(id INTEGER PRIMARY KEY)'}],tables:[{name:'restored',columns:['rowid','id'],rowCount:0}],chunks:[],sourceRevision:'d'.repeat(40),sourceFrozenAtMs:100000};
  plan.schemaHash=hash(plan.schema);plan.snapshotHash=hash({tables:plan.tables,chunks:plan.chunks});
  const payload={planHash:hash(plan),notBeforeMs:99900,expiresAtMs:101000};const grant={...payload,signature:sign(null,Buffer.from(snapshotCanonical(payload)),keys.privateKey).toString('base64url')};
  await importer.begin(plan,grant);assert.equal((await importer.seal({planHash:payload.planHash},grant)).ready,true);
 }finally{f.raw.close();}
 for(const ddl of ['CREATE TABLE durable_sql_recovery_unknown(x)','CREATE INDEX forged ON durable_sql_recovery_runs(freeze_request_hash)','CREATE VIEW durable_sql_recovery_view AS SELECT 1','CREATE TRIGGER forged AFTER INSERT ON durable_sql_recovery_runs BEGIN SELECT 1; END']){
  const f=setup();try{f.raw.exec(ddl);assert.throws(()=>controller(f).initialize(),/recovery_metadata_invalid/);}finally{f.raw.close();}
 }
});

test('freeze rechecks expiry inside its transaction after asynchronous authorization has already succeeded',async()=>{
 const f=setup();let now=100000;const transaction=f.storage.transactionSync.bind(f.storage),c=controller(f,{clock:()=>now});
 try{
  f.storage.transactionSync=fn=>{now=101000;return transaction(fn);};
  const input=freezeInput();await assert.rejects(c.freezeRecovery(input,signGrant('freeze',input)),/recovery_authorization/);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_recovery_runs').get().n,0);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_recovery_active').get().n,0);
  const scope={identity,runId:input.runId,freezeRequestHash:hash(input)};
  assert.equal((await c.recoveryStatus(scope,signGrant('status',scope,101000,{notBeforeMs:101000}))).state,'absent');
  assert.equal(f.engine.execute({identity,statements:[{sql:'SELECT 1 AS n',values:[],mode:'all'}]})[0].results[0].n,1);
 }finally{f.storage.transactionSync=transaction;f.raw.close();}
});

test('caller mutations after the first await cannot change the authenticated request or grant',async()=>{
 const f=setup(),original=crypto.subtle.digest.bind(crypto.subtle);let resume,started,hold=true;
 const waiting=new Promise(resolve=>started=resolve);
 crypto.subtle.digest=async(...args)=>{const result=await original(...args);if(hold){hold=false;started();await new Promise(resolve=>resume=resolve);}return result;};
 try{
  const input=freezeInput(),expected=structuredClone(input),grant=signGrant('freeze',input),pending=f.controller.freezeRecovery(input,grant);
  await waiting;input.identity.epoch=99;input.runId='f'.repeat(24);grant.expiresAtMs=1;grant.identity.deploymentId='mutated';resume();
  const receipt=await pending;assert.deepEqual(receipt.identity,expected.identity);assert.equal(receipt.runId,expected.runId);assert.equal(receipt.freezeRequestHash,hash(expected));
 }finally{crypto.subtle.digest=original;resume?.();f.raw.close();}
});

test('128 retained runs are never automatically deleted or reopened to admit another freeze',async()=>{
 const f=setup();try{
  for(let index=0;index<128;index++){
   const input={...freezeInput(),runId:index.toString(16).padStart(24,'0')};
   const receipt=await f.controller.freezeRecovery(input,signGrant('freeze',input));
   const release={...scopeOf(receipt),expectedPlanHash:null,decision:'operator-abort',evidenceHash:'f'.repeat(64)};
   await f.controller.releaseRecovery(release,signGrant('release',release));
  }
  const input=freezeInput();await assert.rejects(f.controller.freezeRecovery(input,signGrant('freeze',input)),/recovery_capacity/);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_recovery_runs').get().n,128);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_recovery_active').get().n,0);
  assert.equal(f.engine.execute({identity,statements:[{sql:'SELECT 1 AS n',values:[],mode:'all'}]})[0].results[0].n,1);
 }finally{f.raw.close();}
});

test('malformed lock relationships and receipt metadata never appear unlocked',async()=>{
 for(const sql of ["DELETE FROM durable_sql_recovery_active","UPDATE durable_sql_recovery_active SET run_id='"+'1'.repeat(24)+"'","UPDATE durable_sql_recovery_runs SET receipt_json='{}'","UPDATE durable_sql_recovery_runs SET released_at_ms=100000","UPDATE durable_sql_recovery_runs SET plan_json='{}'"]){
  const f=setup();try{
   const input=freezeInput(),receipt=await f.controller.freezeRecovery(input,signGrant('freeze',input));f.raw.exec(sql);f.reset();
   assert.throws(()=>f.engine.execute({identity,statements:[{sql:"UPDATE items SET value='denied'",values:[],mode:'run'}]}),/recovery_metadata_invalid/);
   await assert.rejects(f.controller.recoveryStatus(scopeOf(receipt),signGrant('status',scopeOf(receipt))),/recovery_metadata_invalid/);
   assert.equal(f.raw.prepare('SELECT value FROM items').get().value,'before');
  }finally{f.raw.close();}
 }
});

test('backward clock movement cannot acknowledge a release that invalidates retained freeze metadata',async()=>{
 const f=setup();try{
  const input=freezeInput(),receipt=await f.controller.freezeRecovery(input,signGrant('freeze',input)),scope=scopeOf(receipt);
  const release={...scope,expectedPlanHash:null,decision:'operator-abort',evidenceHash:'f'.repeat(64)};
  await assert.rejects(controller(f,{clock:()=>99999}).releaseRecovery(release,signGrant('release',release,99999)),/recovery_authorization/);
  assert.equal((await f.controller.recoveryStatus(scope,signGrant('status',scope))).state,'frozen');
  assert.equal(f.raw.prepare('SELECT released_at_ms FROM durable_sql_recovery_runs').get().released_at_ms,null);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM durable_sql_recovery_active').get().n,1);
 }finally{f.raw.close();}
});

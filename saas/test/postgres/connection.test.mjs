import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, defaults as pgDefaults } from 'pg';
import { serialize } from 'pg-protocol';
import * as mod from '../../src/postgres/connection.ts';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; };
const target = () => ({ region:'sg', provider:'neon', host:'ep-memory.ap-southeast-1.aws.neon.tech', port:5432, database:'memory', user:'memory_runtime', password:'test-secret-only', expectedRole:'memory_runtime', deploymentId:'memory-sg-test', applicationSchemas:['memory_control','memory_identity','memory_content'], connectionMode:'direct', connectTimeoutMs:100, queryTimeoutMs:100, statementTimeoutMs:80, operationTimeoutMs:500, cleanupTimeoutMs:100 });
const role = overrides => ({ role:'memory_runtime', sessionRole:'memory_runtime', database:'memory', superuser:false, createRole:false, createDatabase:false, bypassRls:false, replication:false, databaseOwner:false, schemaOwner:false, dangerousMembership:false, ...overrides });
function harness({query, connect, end, roleOverrides, metadata}={}) {
 const calls=[]; let ended=0, made=0, received;
 const client={async connect(){calls.push('CONNECT');return connect?.();},async end(){ended++;calls.push('END');return end?.();},on(){return this;},async query(config){
  calls.push(config.text);
  if(config.text.includes('pg_roles'))return {rows:[role(roleOverrides)],rowCount:1};
  if(config.text.includes('set_config'))return {rows:[{}],rowCount:1};
  return query ? query(config) : {rows:[],rowCount:0};
 }};
 function boundary(config={}){assert.equal(typeof mod.createPostgresConnection,'function','connection boundary must be implemented');return mod.createPostgresConnection({...target(),...config},{clientFactory:options=>{made++;received=options;return client;},verifyDeployment:async()=>metadata??{region:'sg',deploymentId:'memory-sg-test'}});}
 return {boundary,calls,get ended(){return ended;},get made(){return made;},get received(){return received;}};
}
test('rejects incomplete, mismatched-region and privileged targets before opening a socket',async()=>{
 for(const config of [{region:'kr-seoul'},{host:'ep-memory.us-east-1.aws.neon.tech'},{user:'postgres',expectedRole:'postgres'},{user:'memory_owner',expectedRole:'memory_owner'},{password:''},{port:6543},{ssl:{rejectUnauthorized:false}},{host:'localhost'},{operationTimeoutMs:Infinity}]){
  const h=harness();assert.throws(()=>h.boundary(config),e=>e.code==='postgres_target_invalid');assert.equal(h.made,0);
 }
});
test('uses explicit native TLS configuration and closes after a result without guessing affected rows',async()=>{
 const h=harness({query:async c=>({rows:[{count:'9007199254740993'}],rowCount:c.text==='SELECT count(*) FROM items'?1:0})});
 const result=await h.boundary().withConnection(db=>db.query('SELECT count(*) FROM items'));
 assert.equal(result.rows[0].count,'9007199254740993');assert.equal(result.rowCount,1);assert.equal(h.ended,1);
 assert.deepEqual(h.received.ssl,{rejectUnauthorized:true,servername:'ep-memory.ap-southeast-1.aws.neon.tech'});
 assert.equal(h.received.connectionString,undefined);assert.equal(h.received.user,'memory_runtime');assert.ok(h.received.connectionTimeoutMillis>0);assert.ok(h.received.query_timeout>0);
});
test('role and deployment verification fail before application SQL and always close',async()=>{
 for(const variant of [{roleOverrides:{superuser:true}},{roleOverrides:{schemaOwner:true}},{roleOverrides:{role:'memory_migrator'}},{roleOverrides:{sessionRole:'memory_migrator'}},{roleOverrides:{createRole:true}},{roleOverrides:{databaseOwner:true}},{metadata:{region:'kr-seoul',deploymentId:'memory-sg-test'}},{metadata:{region:'sg',deploymentId:'another-deployment'}}]){
  const h=harness(variant);await assert.rejects(h.boundary().withConnection(db=>db.query('SELECT sensitive')),e=>['postgres_role_denied','postgres_deployment_mismatch'].includes(e.code));assert.ok(!h.calls.includes('SELECT sensitive'));assert.equal(h.ended,1);
 }
});
test('a transaction commits exactly once on its single verified client',async()=>{
 const h=harness();const got=await h.boundary().transaction(async db=>{await db.query('UPDATE item SET value=$1',[7]);return 7;});
 assert.equal(got,7);assert.equal(h.made,1);assert.equal(h.ended,1);
 assert.deepEqual(h.calls.filter(c=>['BEGIN','COMMIT','ROLLBACK','UPDATE item SET value=$1'].includes(c)),['BEGIN','UPDATE item SET value=$1','COMMIT']);
});
test('a rejected statement rolls back and redacts driver secrets',async()=>{
 const h=harness({query:async c=>{if(c.text.startsWith('INSERT'))throw Object.assign(new Error('postgresql://secret@example/payload'),{code:'23505'});return {rows:[],rowCount:null};}});
 await assert.rejects(h.boundary().transaction(db=>db.query('INSERT INTO item VALUES($1)',[1])),e=>e.code==='postgres_query_failed'&&e.sqlState==='23505'&&e.outcome==='rolled_back'&&!JSON.stringify(e).includes('secret')&&!e.message.includes('postgresql'));
 assert.ok(h.calls.includes('ROLLBACK'));assert.ok(!h.calls.includes('COMMIT'));assert.equal(h.ended,1);
});
test('unknown COMMIT is not retried or described as rolled back',async()=>{
 const h=harness({query:async c=>{if(c.text==='COMMIT')throw new Error('lost response secret');return {rows:[],rowCount:0};}});
 await assert.rejects(h.boundary().transaction(db=>db.query('UPDATE item SET value=1')),e=>e.code==='postgres_commit_unknown'&&e.outcome==='unknown');
 assert.equal(h.calls.filter(c=>c==='COMMIT').length,1);assert.ok(!h.calls.includes('ROLLBACK'));assert.equal(h.ended,1);
});
test('aborting while user work waits prevents a late statement and COMMIT',async()=>{
 const pending=deferred(),h=harness(),controller=new AbortController();let escaped,late;
 const run=h.boundary().transaction(async db=>{escaped=db;await pending.promise;late=db.query('INSERT INTO item VALUES(9)').catch(e=>e);return 9;},{signal:controller.signal});
 while(!escaped)await sleep(1);controller.abort();await assert.rejects(run,e=>e.code==='postgres_aborted');pending.resolve();await sleep(10);
 assert.equal((await late).code,'postgres_connection_closed');assert.ok(!h.calls.includes('COMMIT'));assert.ok(!h.calls.includes('INSERT INTO item VALUES(9)'));assert.equal(h.ended,1);
});
test('a timed out query ends the connection and cannot later commit',async()=>{
 const pending=deferred(),h=harness({query:c=>c.text.startsWith('UPDATE')?pending.promise:Promise.resolve({rows:[],rowCount:0})});
 await assert.rejects(h.boundary({queryTimeoutMs:20}).transaction(db=>db.query('UPDATE slow SET value=1')),e=>e.code==='postgres_deadline');
 pending.resolve({rows:[],rowCount:1});await sleep(5);assert.ok(!h.calls.includes('COMMIT'));assert.equal(h.ended,1);
});
test('connect timeout is bounded and closes a late successful socket',async()=>{
 const pending=deferred(),h=harness({connect:()=>pending.promise});const started=Date.now();
 await assert.rejects(h.boundary({connectTimeoutMs:20}).withConnection(()=>assert.fail('callback')),e=>e.code==='postgres_deadline');
 assert.ok(Date.now()-started<400);pending.resolve();await sleep(10);assert.ok(h.ended>=1);assert.ok(!h.calls.some(c=>c.includes('pg_roles')));
});
test('a pre-aborted operation creates no client and a retained session cannot be reused',async()=>{
 const h=harness(),controller=new AbortController();controller.abort();await assert.rejects(h.boundary().transaction(()=>0,{signal:controller.signal}),e=>e.code==='postgres_aborted');assert.equal(h.made,0);
 let saved;await h.boundary().withConnection(db=>{saved=db;return 1;});await assert.rejects(saved.query('SELECT secret'),e=>e.code==='postgres_connection_closed');
});
test('parallel callback queries and transaction-control SQL cannot escape the boundary',async()=>{
 const pending=deferred(),h=harness({query:c=>c.text==='SELECT slow'?pending.promise:Promise.resolve({rows:[],rowCount:0})});
 await h.boundary().transaction(async db=>{for(const sql of ['COMMIT','/* x */ COMMIT','ROLLBACK','SET ROLE postgres','DO $$ BEGIN COMMIT; END $$'])await assert.rejects(db.query(sql),e=>e.code==='postgres_transaction_control_denied');
  const first=db.query('SELECT slow');await assert.rejects(db.query('SELECT other'),e=>e.code==='postgres_concurrent_query');pending.resolve({rows:[],rowCount:0});await first;
 });assert.ok(!h.calls.includes('SELECT other'));
});
test('a callback returning with unawaited SQL never commits',async()=>{
 const pending=deferred(),h=harness({query:c=>c.text.startsWith('INSERT')?pending.promise:Promise.resolve({rows:[],rowCount:0})});
 await assert.rejects(h.boundary().transaction(db=>{void db.query('INSERT INTO slow VALUES(1)').catch(()=>{});return 1;}),e=>e.code==='postgres_pending_query');
 pending.resolve({rows:[],rowCount:1});assert.ok(!h.calls.includes('COMMIT'));assert.equal(h.ended,1);
});
test('cleanup failure cannot report successful commit as a failed unknown write',async()=>{
 const h=harness({end:async()=>{throw new Error('secret connection string');}});
 await assert.rejects(h.boundary().transaction(()=>1),e=>e.code==='postgres_cleanup_failed'&&e.outcome==='committed'&&!e.message.includes('secret'));
});
test('numeric conversion is explicit and rejects unsafe integer values and row counts',async()=>{
 assert.equal(typeof mod.asSafeInteger,'function');assert.equal(mod.asSafeInteger('9007199254740991'),9007199254740991);assert.equal(mod.asSafeInteger('-5'),-5);
 for(const v of ['9007199254740993',9007199254740992,'1.5',null,NaN])assert.throws(()=>mod.asSafeInteger(v),e=>e.code==='postgres_numeric_unsafe');
 for(const result of [{rows:[],rowCount:9007199254740992},{rows:[{value:9007199254740992}],rowCount:1},{rows:[],rowCount:undefined}]){
  const h=harness({query:async()=>result});await assert.rejects(h.boundary().withConnection(db=>db.query('SELECT unsafe')),e=>['postgres_numeric_unsafe','postgres_result_invalid'].includes(e.code));
 }
});
test('catching a failed statement cannot commit or report success for an aborted transaction',async()=>{
 const h=harness({query:async c=>{if(c.text==='INSERT INTO bad VALUES(1)')throw Object.assign(new Error('constraint'),{code:'23505'});return {rows:[],rowCount:0};}});
 await assert.rejects(h.boundary().transaction(async db=>{await db.query('INSERT INTO bad VALUES(1)').catch(()=>{});return 'incorrect success';}),e=>e.code==='postgres_transaction_failed'&&e.outcome==='rolled_back');
 assert.ok(!h.calls.includes('COMMIT'));assert.ok(h.calls.includes('ROLLBACK'));
});
test('Seoul direct, session pooler and transaction pooler retain an explicit verified regional target',async()=>{
 for(const config of [
  {host:'db.abcdefghijklmnopqrst.supabase.co',port:5432,user:'memory_runtime',connectionMode:'direct'},
  {host:'aws-0-ap-northeast-2.pooler.supabase.com',port:5432,user:'memory_runtime.abcdefghijklmnopqrst',connectionMode:'session-pooler'},
  {host:'aws-0-ap-northeast-2.pooler.supabase.com',port:6543,user:'memory_runtime.abcdefghijklmnopqrst',connectionMode:'transaction-pooler'}]){
  const h=harness({metadata:{region:'kr-seoul',deploymentId:'memory-sg-test'}});
  await h.boundary({...config,region:'kr-seoul',provider:'supabase',ssl:{rejectUnauthorized:true,ca:'-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----'}}).withConnection(()=>1);
  assert.equal(h.received.host,config.host);assert.equal(h.received.ssl.rejectUnauthorized,true);assert.equal(h.received.ssl.servername,config.host);assert.ok(h.received.ssl.ca.includes('BEGIN CERTIFICATE'));assert.equal(h.ended,1);
 }
 const h=harness();await h.boundary({host:'ep-memory-pooler.ap-southeast-1.aws.neon.tech',connectionMode:'transaction-pooler'}).withConnection(()=>1);
 assert.throws(()=>h.boundary({connectionMode:'session-pooler'}),e=>e.code==='postgres_target_invalid');
});
test('abort after COMMIT dispatch yields unknown without a second commit or rollback',async()=>{
 const pending=deferred(),controller=new AbortController(),h=harness({query:c=>c.text==='COMMIT'?pending.promise:Promise.resolve({rows:[],rowCount:0})});
 const run=h.boundary().transaction(()=>1,{signal:controller.signal});while(!h.calls.includes('COMMIT'))await sleep(1);controller.abort();
 await assert.rejects(run,e=>e.code==='postgres_commit_unknown'&&e.outcome==='unknown');pending.resolve({rows:[],rowCount:null});await sleep(5);
 assert.equal(h.calls.filter(c=>c==='COMMIT').length,1);assert.ok(!h.calls.includes('ROLLBACK'));assert.equal(h.ended,1);
});
test('hung cleanup is bounded and never reports success',async()=>{
 const h=harness({end:()=>new Promise(()=>{})});const started=Date.now();
 await assert.rejects(h.boundary({cleanupTimeoutMs:20}).withConnection(()=>1),e=>e.code==='postgres_cleanup_failed');assert.ok(Date.now()-started<400);
});
test('native numeric parsers retain exact scalar and array text without changing pg globals',async()=>{
 const h=harness();await h.boundary().withConnection(()=>1);
 for(const [oid,text] of [[20,'9007199254740993'],[1700,'1.00000000000000000000001'],[1016,'{9007199254740993}'],[1231,'{1.00000000000000000000001}']])assert.equal(h.received.types.getTypeParser(oid,'text')(text),text);
});
test('actual pg startup excludes untracked pooler parameters and ambient PGOPTIONS',async()=>{
 const previous=process.env.PGOPTIONS,replication=process.env.PGREPLICATION,originalDefaults={...pgDefaults};process.env.PGOPTIONS='-c search_path=public,pg_catalog';process.env.PGREPLICATION='database';
 Object.assign(pgDefaults,{statement_timeout:123,lock_timeout:456,idle_in_transaction_session_timeout:789,options:'-c statement_timeout=0'});
 try {
  for(const changes of [{},{host:'ep-memory-pooler.ap-southeast-1.aws.neon.tech',connectionMode:'transaction-pooler'},
   {region:'kr-seoul',provider:'supabase',host:'aws-0-ap-northeast-2.pooler.supabase.com',port:5432,user:'memory_runtime.abcdefghijklmnopqrst',connectionMode:'session-pooler'},
   {region:'kr-seoul',provider:'supabase',host:'aws-0-ap-northeast-2.pooler.supabase.com',port:6543,user:'memory_runtime.abcdefghijklmnopqrst',connectionMode:'transaction-pooler'}]){
   const h=harness({metadata:{region:changes.region??'sg',deploymentId:'memory-sg-test'}});await h.boundary(changes).withConnection(()=>1);assert.equal(typeof mod.createNativePgClient,'function');
   const native=mod.createNativePgClient(h.received);assert.ok(native instanceof Client);
   assert.deepEqual(Client.prototype.getStartupConf.call(native),{user:changes.user??'memory_runtime',database:'memory',application_name:'memory-postgres-runtime'});
   const fields=serialize.startup(Client.prototype.getStartupConf.call(native)).subarray(8).toString('utf8').split('\0');const packet={};
   for(let i=0;i+1<fields.length&&fields[i];i+=2)packet[fields[i]]=fields[i+1];
   assert.deepEqual(packet,{user:changes.user??'memory_runtime',database:'memory',application_name:'memory-postgres-runtime',client_encoding:'UTF8'});
   assert.equal(native.connectionParameters.query_timeout,h.received.query_timeout);assert.equal(native.connectionParameters.ssl.rejectUnauthorized,true);await native.end();
  }
 } finally {
  if(previous===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=previous;
  if(replication===undefined)delete process.env.PGREPLICATION;else process.env.PGREPLICATION=replication;
  Object.assign(pgDefaults,originalDefaults);
  for(const key of ['statement_timeout','lock_timeout','idle_in_transaction_session_timeout','options'])if(!Object.hasOwn(originalDefaults,key))delete pgDefaults[key];
 }
});
test('default connection entry uses the guarded native startup before any transport connect',async()=>{
 const original={connect:Client.prototype.connect,query:Client.prototype.query,end:Client.prototype.end};let connected=0,closed=0;
 Client.prototype.connect=async function(){connected++;assert.deepEqual(this.getStartupConf(),{user:'memory_runtime',database:'memory',application_name:'memory-postgres-runtime'});};
 Client.prototype.query=async function(c){return c.text.includes('pg_roles')?{rows:[role()],rowCount:1}:{rows:[],rowCount:0};};
 Client.prototype.end=async function(){closed++;};
 const options=process.env.PGOPTIONS;process.env.PGOPTIONS='-c search_path=public,pg_catalog';
 try {const c=mod.createPostgresConnection({...target(),host:'ep-memory-pooler.ap-southeast-1.aws.neon.tech',connectionMode:'transaction-pooler'},{verifyDeployment:async()=>({region:'sg',deploymentId:'memory-sg-test'})});assert.equal(await c.transaction(()=>7),7);assert.equal(connected,1);assert.equal(closed,1);}
 finally {Object.assign(Client.prototype,original);if(options===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=options;}
});
test('transaction-pooler attestation and all timeout state stay inside one actual transaction',async()=>{
 let inTransaction=false,closed=0;const effects=[];
 const connection=mod.createPostgresConnection({...target(),host:'ep-memory-pooler.ap-southeast-1.aws.neon.tech',connectionMode:'transaction-pooler'},{
  clientFactory:()=>({on(){return this;},async connect(){},async end(){closed++;},async query(c){
   if(c.text==='BEGIN'){inTransaction=true;effects.push('BEGIN');return {rows:[],rowCount:null};}
   if(c.text==='COMMIT'||c.text==='ROLLBACK'){assert.equal(inTransaction,true);inTransaction=false;effects.push(c.text);return {rows:[],rowCount:null};}
   assert.equal(inTransaction,true,'pooler could switch backend outside BEGIN');
   if(c.text.includes('set_config')){assert.equal(c.values[1],true,'session state must not survive the transaction');assert.ok(Number(c.values[0])>0);return {rows:[{}],rowCount:1};}
   if(c.text.includes('pg_roles'))return {rows:[role()],rowCount:1};
   effects.push(c.text);return {rows:[],rowCount:1};
  }}),verifyDeployment:async session=>{await session.query('SELECT deployment_metadata');return {region:'sg',deploymentId:'memory-sg-test'};}
 });
 await connection.withConnection(db=>db.query('UPDATE regional_row SET value=1'));
 assert.deepEqual(effects,['BEGIN','SELECT deployment_metadata','UPDATE regional_row SET value=1','COMMIT']);assert.equal(closed,1);
});

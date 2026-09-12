import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Client, defaults as pgDefaults } from 'pg';
import { serialize } from 'pg-protocol';
import * as mod from '../../src/postgres/connection.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(value => { resolve=value; }); return {promise,resolve}; };
const bareConnectionString='postgresql://worker_proxy:proxy-secret@proxy.seoul.hyperdrive.local:5432/memory';
const binding = () => ({
  connectionString:bareConnectionString+'?sslmode=disable',
  host:'proxy.seoul.hyperdrive.local',port:5432,user:'worker_proxy',password:'proxy-secret',database:'memory',
});
const target = overrides => ({transport:'hyperdrive',region:'kr-seoul',provider:'supabase',database:'memory',
  expectedRole:'memory_seoul_runtime',deploymentId:'memory-seoul-hd',applicationSchemas:['memory_control','memory_content'],
  hyperdrive:binding(),connectTimeoutMs:100,queryTimeoutMs:100,statementTimeoutMs:80,operationTimeoutMs:500,cleanupTimeoutMs:100,...overrides});
const role = overrides => ({role:'memory_seoul_runtime',sessionRole:'memory_seoul_runtime',database:'memory',superuser:false,
  createRole:false,createDatabase:false,bypassRls:false,replication:false,databaseOwner:false,schemaOwner:false,dangerousMembership:false,...overrides});

function harness({roleOverrides,query,connect,end,targetOverrides}={}) {
  const calls=[];let made=0,closed=0,received;
  const client={on(){return this;},async connect(){calls.push('CONNECT');return connect?.();},async end(){closed++;calls.push('END');return end?.();},
    async query(config){calls.push(config.text);if(config.text.includes('pg_roles'))return {rows:[role(roleOverrides)],rowCount:1};
      if(config.text.includes('set_config'))return {rows:[{}],rowCount:1};return query?.(config)??{rows:[],rowCount:0};}};
  const connection=()=>mod.createPostgresConnection(target(targetOverrides),{clientFactory:plan=>{made++;received=plan;return client;},
    verifyDeployment:async()=>({region:'kr-seoul',deploymentId:'memory-seoul-hd'})});
  return {connection,calls,get made(){return made;},get closed(){return closed;},get received(){return received;}};
}

test('Hyperdrive snapshots one strict binding and exposes a truthful driver plan',async()=>{
  const supplied=binding(),h=harness({targetOverrides:{hyperdrive:supplied}}),connection=h.connection();
  supplied.connectionString='postgresql://mutated:mutated@changed.test:9999/changed';supplied.host='changed.test';supplied.port=9999;
  supplied.user='mutated';supplied.password='mutated';supplied.database='changed';
  await connection.withConnection(db=>db.query('SELECT value FROM memory_content.items'));
  assert.equal(h.made,1);assert.equal(h.closed,1);
  assert.deepEqual(h.received.startup,{host:'proxy.seoul.hyperdrive.local',port:5432,user:'worker_proxy',database:'memory',applicationName:'memory-postgres-runtime'});
  assert.equal(h.received.transport,'hyperdrive');
  assert.equal(h.received.config.connectionString,bareConnectionString+'?sslmode=disable');
  assert.equal(h.received.config.ssl,undefined);assert.equal(h.received.config.host,undefined);assert.equal(h.received.config.user,undefined);
  assert.deepEqual(h.calls.filter(value=>['BEGIN','COMMIT','ROLLBACK','SELECT value FROM memory_content.items'].includes(value)),
    ['BEGIN','SELECT value FROM memory_content.items','COMMIT']);
});

test('Hyperdrive rejects malformed, contradictory, mixed and URL-option bindings before a client exists',()=>{
  const cases=[
    {hyperdrive:{...binding(),database:'other'}},
    {hyperdrive:{...binding(),host:'other.test'}},
    {hyperdrive:{...binding(),user:'other'}},
    {hyperdrive:{...binding(),password:'other'}},
    {hyperdrive:{...binding(),port:6543}},
    {hyperdrive:{...binding(),connectionString:bareConnectionString+'?options=unsafe'}},
    {hyperdrive:{...binding(),connectionString:bareConnectionString+'?sslmode=require'}},
    {hyperdrive:{...binding(),connectionString:bareConnectionString+'?sslmode=disable&sslmode=disable'}},
    {hyperdrive:{...binding(),connectionString:bareConnectionString+'?%73slmode=disable'}},
    {hyperdrive:{...binding(),connectionString:bareConnectionString}},
    {hyperdrive:{...binding(),connectionString:binding().connectionString+'#fragment'}},
    {hyperdrive:{...binding(),connectionString:'postgresql://worker_proxy:proxy-secret@proxy.seoul.hyperdrive.local/memory'}},
    {hyperdrive:{...binding(),unexpected:'value'}},
    {host:'db.abcdefghijklmnopqrst.supabase.co'},
    {provider:'neon'}, {region:'sg'},
  ];
  for(const changes of cases){const h=harness({targetOverrides:changes});assert.throws(()=>h.connection(),error=>error.code==='postgres_target_invalid');assert.equal(h.made,0);}
  let reads=0;const accessor=target();Object.defineProperty(accessor,'expectedRole',{get(){reads++;throw Error('private target getter');}});
  assert.throws(()=>mod.createPostgresConnection(accessor,{verifyDeployment:async()=>({region:'kr-seoul',deploymentId:'memory-seoul-hd'})}),
    error=>error.code==='postgres_target_invalid');assert.equal(reads,0);
  const mixedLegacy={region:'sg',provider:'neon',host:'ep-memory.ap-southeast-1.aws.neon.tech',port:5432,database:'memory',
    user:'memory_runtime',password:'native-secret',expectedRole:'memory_runtime',deploymentId:'memory-sg-test',
    applicationSchemas:['memory_control'],connectionMode:'direct',hyperdrive:binding()};
  assert.throws(()=>mod.createPostgresConnection(mixedLegacy,{verifyDeployment:async()=>({region:'sg',deploymentId:'memory-sg-test'})}),
    error=>error.code==='postgres_target_invalid');
});

test('proxy startup identity is separate from origin role and database attestation',async()=>{
  const allowed=harness();await allowed.connection().withConnection(()=>1);assert.equal(allowed.received.startup.user,'worker_proxy');
  for(const roleOverrides of [{role:'worker_proxy'},{sessionRole:'worker_proxy'},{database:'proxy'}]){
    const denied=harness({roleOverrides});await assert.rejects(denied.connection().withConnection(()=>1),error=>error.code==='postgres_role_denied');
    assert.equal(denied.closed,1);
  }
});

test('actual pg Hyperdrive startup honors the frozen proxy URL and strips ambient startup GUCs',async()=>{
  const previous=process.env.PGOPTIONS,replication=process.env.PGREPLICATION,sslmode=process.env.PGSSLMODE,
    sslnegotiation=process.env.PGSSLNEGOTIATION,defaults={...pgDefaults};
  process.env.PGOPTIONS='-c search_path=public,pg_catalog';process.env.PGREPLICATION='database';process.env.PGSSLMODE='require';process.env.PGSSLNEGOTIATION='direct';
  Object.assign(pgDefaults,{statement_timeout:123,lock_timeout:456,idle_in_transaction_session_timeout:789,options:'-c statement_timeout=0'});
  try {
    const h=harness();await h.connection().withConnection(()=>1);
    assert.equal(typeof mod.createPgClient,'function');const client=mod.createPgClient(h.received);assert.ok(client instanceof Client);
    assert.equal(client.connectionParameters.host,'proxy.seoul.hyperdrive.local');assert.equal(client.connectionParameters.port,5432);
    assert.equal(client.connectionParameters.user,'worker_proxy');assert.equal(client.connectionParameters.database,'memory');
    assert.deepEqual(Client.prototype.getStartupConf.call(client),{user:'worker_proxy',database:'memory',application_name:'memory-postgres-runtime'});
    const fields=serialize.startup(Client.prototype.getStartupConf.call(client)).subarray(8).toString('utf8').split('\0'),packet={};
    for(let index=0;index+1<fields.length&&fields[index];index+=2)packet[fields[index]]=fields[index+1];
    assert.deepEqual(packet,{user:'worker_proxy',database:'memory',application_name:'memory-postgres-runtime',client_encoding:'UTF8'});
    assert.equal(client.connectionParameters.options,'');assert.equal(client.connectionParameters.statement_timeout,0);
    assert.equal(client.connectionParameters.lock_timeout,0);assert.equal(client.connectionParameters.idle_in_transaction_session_timeout,0);
    assert.equal(client.connectionParameters.replication,0);assert.equal(client.connectionParameters.ssl,false);
    assert.equal(client.connectionParameters.sslnegotiation,'postgres');await client.end();
  } finally {
    if(previous===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=previous;
    if(replication===undefined)delete process.env.PGREPLICATION;else process.env.PGREPLICATION=replication;
    if(sslmode===undefined)delete process.env.PGSSLMODE;else process.env.PGSSLMODE=sslmode;
    if(sslnegotiation===undefined)delete process.env.PGSSLNEGOTIATION;else process.env.PGSSLNEGOTIATION=sslnegotiation;
    Object.assign(pgDefaults,defaults);
    for(const key of ['statement_timeout','lock_timeout','idle_in_transaction_session_timeout','options'])if(!Object.hasOwn(defaults,key))delete pgDefaults[key];
  }
});

test('the pg adapter rejects mixed or startup-overriding driver plans',async()=>{
  const h=harness();await h.connection().withConnection(()=>1);const plan=h.received;
  for(const changed of [
    {...plan,transport:'native'},
    {...plan,config:{...plan.config,options:'-c search_path=public'}},
    {...plan,startup:{...plan.startup,unexpected:'value'}},
  ])assert.throws(()=>mod.createPgClient(changed),error=>error.code==='postgres_driver_contract');
});

test('Hyperdrive transaction failure rolls back once and lost COMMIT remains unknown without retry',async()=>{
  const failed=harness({query:async config=>{if(config.text.startsWith('UPDATE'))throw Object.assign(new Error('private proxy secret'),{code:'23505'});return {rows:[],rowCount:0};}});
  await assert.rejects(failed.connection().transaction(db=>db.query('UPDATE item SET value=1')),error=>error.code==='postgres_query_failed'&&error.sqlState==='23505'&&error.outcome==='rolled_back'&&!error.message.includes('secret'));
  assert.equal(failed.calls.filter(value=>value==='ROLLBACK').length,1);assert.ok(!failed.calls.includes('COMMIT'));
  const unknown=harness({query:async config=>{if(config.text==='COMMIT')throw new Error('lost proxy response');return {rows:[],rowCount:0};}});
  await assert.rejects(unknown.connection().transaction(db=>db.query('UPDATE item SET value=2')),error=>error.code==='postgres_commit_unknown'&&error.outcome==='unknown');
  assert.equal(unknown.calls.filter(value=>value==='COMMIT').length,1);assert.ok(!unknown.calls.includes('ROLLBACK'));assert.equal(unknown.made,1);
});

test('Hyperdrive deadlines close one client and never dispatch a late COMMIT',async()=>{
  const pending=deferred(),h=harness({targetOverrides:{queryTimeoutMs:20},query:config=>config.text.startsWith('UPDATE')?pending.promise:Promise.resolve({rows:[],rowCount:0})});
  await assert.rejects(h.connection().transaction(db=>db.query('UPDATE slow SET value=1')),error=>error.code==='postgres_deadline');
  pending.resolve({rows:[],rowCount:1});await sleep(5);assert.equal(h.made,1);assert.equal(h.closed,1);assert.ok(!h.calls.includes('COMMIT'));
});

test('serving migrations remain within Hyperdrive locking capabilities',async()=>{
  const names=['0004_seoul_pat_archive.sql','0005_seoul_archive_lifecycle.sql'];
  const sources=await Promise.all(names.map(name=>readFile(new URL(`../../postgres/migrations/${name}`,import.meta.url),'utf8')));
  for(const source of sources)assert.doesNotMatch(source,/pg_(?:try_)?advisory/i);
  assert.match(sources[0],/FOR\s+(?:NO\s+KEY\s+)?UPDATE/i);assert.match(sources[1],/DEFERRABLE\s+INITIALLY\s+DEFERRED/i);
});

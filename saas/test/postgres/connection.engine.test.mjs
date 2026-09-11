import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresConnection, asSafeInteger } from '../../src/postgres/connection.ts';

// PGlite supplies the native PostgreSQL executor/catalog. Only socket/TLS setup
// is replaced; provider TLS, independent-client concurrency and cancellation
// still require the separately gated actual-provider acceptance suite.
async function fixture(t) {
 const db=new PGlite();await db.waitReady;t.after(()=>db.close());
 await db.exec(`CREATE ROLE memory_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 CREATE SCHEMA memory_control; CREATE SCHEMA memory_content;
 CREATE TABLE memory_control.deployment_identity(singleton integer PRIMARY KEY CHECK(singleton=1), storage_region text NOT NULL, deployment_id text NOT NULL);
 INSERT INTO memory_control.deployment_identity VALUES(1,'sg','memory-sg-native');
 CREATE TABLE memory_content.items(id integer PRIMARY KEY, value bigint NOT NULL);
 GRANT USAGE ON SCHEMA memory_control,memory_content TO memory_runtime;
 GRANT SELECT ON memory_control.deployment_identity TO memory_runtime;
 GRANT SELECT,INSERT,UPDATE,DELETE ON memory_content.items TO memory_runtime;`);
 let clients=0,closed=0;
 const connection=createPostgresConnection({region:'sg',provider:'neon',host:'ep-native.ap-southeast-1.aws.neon.tech',port:5432,database:'postgres',user:'memory_runtime',password:'fixture-only',expectedRole:'memory_runtime',deploymentId:'memory-sg-native',applicationSchemas:['memory_control','memory_content'],connectionMode:'direct',operationTimeoutMs:10000}, {
  clientFactory:()=>{clients++;return {on(){return this;},async connect(){await db.exec('SET SESSION AUTHORIZATION memory_runtime');},async query({text,values}){const r=await db.query(text,values);return {rows:r.rows,rowCount:r.affectedRows??null};},async end(){closed++;await db.exec('ROLLBACK; RESET SESSION AUTHORIZATION');}};},
  verifyDeployment:async session=>{const r=await session.query('SELECT storage_region AS region,deployment_id AS "deploymentId" FROM memory_control.deployment_identity WHERE singleton=1');assert.equal(r.rows.length,1);return r.rows[0];}
 });
 return {db,connection,get clients(){return clients;},get closed(){return closed;}};
}
test('native PostgreSQL transaction publishes all mutations and preserves bigint precision',async t=>{
 const f=await fixture(t);
 await f.connection.transaction(async tx=>{const inserted=await tx.query('INSERT INTO memory_content.items VALUES($1,$2)',[1,'9007199254740993']);assert.equal(inserted.rowCount,1);const updated=await tx.query('UPDATE memory_content.items SET value=$1 WHERE id=$2',['9007199254740995',1]);assert.equal(updated.rowCount,1);});
 const row=(await f.db.query('SELECT value::text FROM memory_content.items')).rows[0];assert.equal(row.value,'9007199254740995');assert.throws(()=>asSafeInteger(row.value));assert.equal(f.clients,1);assert.equal(f.closed,1);
});
test('native PostgreSQL rejects partial transaction publication after a constraint failure',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.connection.transaction(async tx=>{await tx.query('INSERT INTO memory_content.items VALUES(1,10)');await tx.query('INSERT INTO memory_content.items VALUES(1,20)');}),e=>e.sqlState==='23505'&&e.outcome==='rolled_back');
 assert.deepEqual((await f.db.query('SELECT * FROM memory_content.items')).rows,[]);assert.equal(f.closed,1);
});
test('native PostgreSQL application-owner membership is denied before callback',async t=>{
 const f=await fixture(t);await f.db.exec('GRANT postgres TO memory_runtime');let ran=false;
 await assert.rejects(f.connection.withConnection(()=>{ran=true;}),e=>e.code==='postgres_role_denied');assert.equal(ran,false);assert.equal(f.closed,1);
});
test('native deployment metadata mismatch blocks every application mutation',async t=>{
 const f=await fixture(t);await f.db.exec("UPDATE memory_control.deployment_identity SET storage_region='kr-seoul'");
 await assert.rejects(f.connection.transaction(tx=>tx.query('INSERT INTO memory_content.items VALUES(1,1)')),e=>e.code==='postgres_deployment_mismatch');assert.deepEqual((await f.db.query('SELECT * FROM memory_content.items')).rows,[]);
});
test('native runtime CREATE privilege in an application schema is denied even without owned objects',async t=>{
 const f=await fixture(t);await f.db.exec('GRANT CREATE ON SCHEMA memory_content TO memory_runtime');let ran=false;
 await assert.rejects(f.connection.withConnection(()=>{ran=true;}),e=>e.code==='postgres_role_denied');assert.equal(ran,false);
});
test('native extended query rejects multi-statement transaction escape and preserves rollback',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.connection.transaction(tx=>tx.query('INSERT INTO memory_content.items VALUES(1,1); COMMIT')),e=>e.code==='postgres_query_failed');
 assert.deepEqual((await f.db.query('SELECT * FROM memory_content.items')).rows,[]);
});
test('native inherited BYPASSRLS capability is denied even when the login itself lacks it',async t=>{
 const f=await fixture(t);await f.db.exec('CREATE ROLE dangerous_capability NOLOGIN BYPASSRLS; GRANT dangerous_capability TO memory_runtime');let ran=false;
 await assert.rejects(f.connection.withConnection(()=>{ran=true;}),e=>e.code==='postgres_role_denied');assert.equal(ran,false);
});
test('native server search path and deadlines apply locally and do not leak beyond COMMIT',async t=>{
 const f=await fixture(t);const sql="SELECT current_setting('search_path') AS path,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle";
 const before=(await f.db.query(sql)).rows[0];let inside;
 await f.connection.withConnection(async tx=>{inside=(await tx.query(sql)).rows[0];});
 assert.equal(inside.path,'pg_catalog');for(const key of ['statement','lock','idle'])assert.notEqual(inside[key],'0');
 assert.deepEqual((await f.db.query(sql)).rows[0],before);
});

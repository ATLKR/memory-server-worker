import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildWriteFence, verifyWriteFence, fenceRemovalStatements } from '../../src/durable-sql/fence.ts';
const runId='a'.repeat(24),hash='b'.repeat(64);
function catalog(raw){return raw.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all();}
function fixture(){const raw=new DatabaseSync(':memory:');raw.exec("CREATE TABLE parent(id TEXT PRIMARY KEY,n INTEGER); CREATE TABLE audit(id TEXT PRIMARY KEY); CREATE TRIGGER parent_audit AFTER INSERT ON parent BEGIN INSERT INTO audit VALUES(NEW.id); END;");return raw;}
test('complete fence rejects all ordinary writes, including old trigger-driven commands, while allowing reads',async()=>{
 const raw=fixture();try{
  raw.prepare('INSERT INTO parent VALUES(?,?)').run('old',1);
  const source=catalog(raw),plan=await buildWriteFence({runId,sourceSchemaHash:hash,schema:source});
  assert.equal(plan.triggers.length,6);
  for(const trigger of plan.triggers)raw.exec(trigger.sql);
  assert.equal((await verifyWriteFence(plan,catalog(raw))).complete,true);
  for(const sql of ["INSERT INTO parent VALUES('new',2)","UPDATE parent SET n=2",'DELETE FROM parent',"INSERT INTO audit VALUES('new')"])
   assert.throws(()=>raw.exec(sql),/memory_sql_cutover_frozen/);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM audit').get().n,1);
  for(const sql of await fenceRemovalStatements(plan,catalog(raw)))raw.exec(sql);
  raw.exec("INSERT INTO parent VALUES('new',2)");assert.equal(raw.prepare('SELECT count(*) AS n FROM audit').get().n,2);
 }finally{raw.close();}
});
test('partial fencing is recorded and only exact owned definitions may be removed',async()=>{
 const raw=fixture();try{
  const plan=await buildWriteFence({runId,sourceSchemaHash:hash,schema:catalog(raw)});
  raw.exec(plan.triggers[0].sql);
  assert.equal((await verifyWriteFence(plan,catalog(raw))).complete,false);
  assert.equal((await fenceRemovalStatements(plan,catalog(raw))).length,1);
  raw.exec('DROP TRIGGER '+plan.triggers[0].name);
  raw.exec(`CREATE TRIGGER ${plan.triggers[0].name} BEFORE INSERT ON parent BEGIN SELECT 1; END`);
  await assert.rejects(()=>verifyWriteFence(plan,catalog(raw)),/fence_definition_mismatch/);
  await assert.rejects(()=>fenceRemovalStatements(plan,catalog(raw)),/fence_definition_mismatch/);
 }finally{raw.close();}
});
test('unexpected schema drift, reserved names and duplicate table definitions are rejected',async()=>{
 const raw=fixture();try{
  const source=catalog(raw),plan=await buildWriteFence({runId,sourceSchemaHash:hash,schema:source});
  raw.exec('CREATE TABLE intruder(id INTEGER)');
  await assert.rejects(()=>verifyWriteFence(plan,catalog(raw)),/fence_source_changed/);
  await assert.rejects(()=>buildWriteFence({runId:'../oops',sourceSchemaHash:hash,schema:source}),/fence_input/);
  await assert.rejects(()=>buildWriteFence({runId,sourceSchemaHash:hash,schema:[...source,source[0]]}),/fence_input/);
 }finally{raw.close();}
});

test('fence verification accounts for installed trigger objects above the source schema limit',async()=>{
 const raw=fixture();try{
  for(let index=0;index<198;index++)raw.exec(`CREATE VIEW view_${index} AS SELECT id FROM parent`);
  for(let index=0;index<100;index++)raw.exec(`CREATE TABLE record_${index}(id INTEGER)`);
  const source=catalog(raw),plan=await buildWriteFence({runId,sourceSchemaHash:hash,schema:source});
  for(const trigger of plan.triggers)raw.exec(trigger.sql);
  assert.ok(catalog(raw).length>600);assert.equal((await verifyWriteFence(plan,catalog(raw))).complete,true);
  assert.equal((await fenceRemovalStatements(plan,catalog(raw))).length,306);
 }finally{raw.close();}
});

test('fence source digest is computed from copied definitions and cannot be forged',async()=>{
 const raw=fixture();try{
  const input={runId,schema:catalog(raw)};
  const pending=buildWriteFence(input);input.runId='c'.repeat(24);input.schema[0].sql='changed';
  const plan=await pending;assert.equal(plan.runId,runId);assert.notEqual(plan.source[0].sql,'changed');
  await assert.rejects(()=>verifyWriteFence({...plan,sourceSchemaHash:'0'.repeat(64)},catalog(raw)),/fence_input/);
 }finally{raw.close();}
});

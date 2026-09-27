import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHeadFixture,uuid,ISSUER} from './seoul-projection-head-fixture.mjs';
import {SEOUL_POLICY} from './seoul-fixture.mjs';

export const provisionTable='memory_ops.identity_projection_space_provisioning';
export const dispositionTable='memory_identity.identity_projection_retained_dispositions';
export const common=n=>({approval_id:uuid(n),approval_reference:'review:local',deployment_singleton:1,
  deployment_id:'memory-seoul',storage_region:'kr-seoul',processing_policy_id:'kr-primary-storage-v1',deployment_created_at_ms:1});
export const provision=(n=1,space='space:a')=>({...common(n),space_id:space,data_policy:structuredClone(SEOUL_POLICY),source_byte_limit:1048576,message_limit:1000});
export const retained={
  account:{id:'account:a',disabled_at:null},organization:{id:'org:a',disabled_at:null},
  provider_identity:{issuer:ISSUER,subject:'alice',account_id:'account:a',created_at:1},
  email:{id:'email:a',account_id:'account:a',address:'a@example.test',domain:'example.test',verified_at:1,revoked_at:null},
  membership:{id:'member:a',organization_id:'org:a',account_id:'account:a',email_id:'email:a',role:'owner',expires_at:9007199254740991,revoked_at:null},
  credential:{id:'pat:org',account_id:'account:a',membership_id:'member:a',email_id:'email:a',kind:'api_key',token_digest:'c'.repeat(64),expires_at:9007199254740991,reauthenticated_at:11,revoked_at:null,permission:'write'},
  space:{id:'space:a',owner_account_id:'account:a',organization_id:null,deployment_id:'memory-seoul',data_policy:structuredClone(SEOUL_POLICY),disabled_at:null,source_byte_limit:1048576,message_limit:1000},
  legacy_grant:{credential_id:'pat:a',account_id:'account:a',space_id:'space:a',can_ingest:true,can_search:true,expires_at:9007199254740991,revoked_at:null,can_erase:true,can_retire:true}
};
export const disposition=(kind,n=100)=>({...common(n),entity_kind:kind,entity_id:retained[kind].id??null,
  issuer:kind==='provider_identity'?ISSUER:null,subject:kind==='provider_identity'?'alice':null,
  credential_id:kind==='legacy_grant'?'pat:a':null,space_id:kind==='legacy_grant'?'space:a':null,
  disposition:'adopt_exact_binding',retained_basis:structuredClone(retained[kind]),authorized_binding:structuredClone(retained[kind])});
export const insertQuery=(table,value)=>{
  assert.ok([provisionTable,dispositionTable].includes(table));
  const columns=Object.keys(value);for(const key of columns)assert.match(key,/^[a-z_]+$/);
  return [`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING approval_id`,Object.values(value)];
};
export async function createProvisioningFixture(t,{seed=true,install=true}={}) {
  const f=await createHeadFixture(t,{seed});
  // Include the reviewed pure validator in unchanged-function/ACL observations.
  const validation=await readFile(new URL('../../postgres/projection-v3/snapshot-validation.sql',import.meta.url),'utf8');
  await f.asRole('fixture_provisioner',db=>db.exec(validation));
  // Test-only SET edge; product SQL must leave these existing edges unchanged.
  await f.db.exec('CREATE ROLE setup_test_login LOGIN NOINHERIT; GRANT memory_owner TO setup_test_login WITH INHERIT FALSE,SET TRUE,ADMIN FALSE');
  const owner=fn=>f.asRole('setup_test_login',async db=>{await db.exec('SET ROLE memory_owner');return fn(db);});
  if(seed)await owner(db=>db.exec(`INSERT INTO memory_identity.provider_identities VALUES('${ISSUER}','alice','account:a',1);
    UPDATE memory_identity.credentials SET reauthenticated_at=11 WHERE id='pat:org';
    UPDATE memory_identity.pat_space_grants SET can_erase=true,can_retire=true WHERE credential_id='pat:a';
    UPDATE memory_ops.space_usage SET source_bytes=100,message_count=3,retained_source_bytes=80,retained_message_count=2 WHERE space_id='space:a'`));
  const installFoundation=async()=>{
    const sql=await readFile(new URL('../../postgres/projection-v3/provisioning-foundation.sql',import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    assert.notEqual(sql,null,'inactive protected provisioning SQL foundation must exist');
    await owner(db=>db.exec(sql));
  };
  const insert=(table,value)=>owner(db=>db.query(...insertQuery(table,value)));
  if(install)await installFoundation();
  return {...f,owner,insert,installFoundation};
}

// Capture identities first, so later comparisons cover every old object without
// mistaking the intentionally new tables/functions for mutation of old ones.
export async function oldSurface(db) {
  const tables=(await db.query("SELECT c.oid::int AS oid,n.nspname||'.'||c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_%' AND c.relkind='r' AND c.relname NOT IN('identity_projection_space_provisioning','identity_projection_retained_dispositions') ORDER BY 2")).rows;
  const functions=(await db.query("SELECT p.oid::int AS oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'memory_%' ORDER BY p.oid")).rows.map(r=>r.oid);
  const triggerIds=(await db.query('SELECT oid::int AS oid FROM pg_catalog.pg_trigger WHERE tgrelid=ANY($1::oid[]) ORDER BY oid',[tables.map(r=>r.oid)])).rows.map(r=>r.oid);
  const observe=async()=>({
    rows:await Promise.all(tables.map(async r=>[r.name,(await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) AS rows FROM ${r.name} x`)).rows[0].rows])),
    tables:(await db.query('SELECT c.oid,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE oid=ANY($1::oid[]) ORDER BY oid',[tables.map(r=>r.oid)])).rows,
    columns:(await db.query('SELECT attrelid,attname,attacl::text FROM pg_catalog.pg_attribute WHERE attrelid=ANY($1::oid[]) AND attnum>0 ORDER BY attrelid,attnum',[tables.map(r=>r.oid)])).rows,
    functions:(await db.query('SELECT p.oid,p.proowner,p.proacl::text,p.proconfig,p.prosrc,p.prosecdef FROM pg_catalog.pg_proc p WHERE oid=ANY($1::oid[]) ORDER BY oid',[functions])).rows,
    policies:(await db.query('SELECT to_jsonb(p) AS value FROM pg_catalog.pg_policy p WHERE polrelid=ANY($1::oid[]) ORDER BY oid',[tables.map(r=>r.oid)])).rows,
    triggers:(await db.query('SELECT oid,pg_catalog.pg_get_triggerdef(oid) AS definition FROM pg_catalog.pg_trigger WHERE oid=ANY($1::oid[]) ORDER BY oid',[triggerIds])).rows,
    defaults:(await db.query('SELECT to_jsonb(d) AS value FROM pg_catalog.pg_default_acl d ORDER BY oid')).rows,
    edges:(await db.query('SELECT to_jsonb(m) AS value FROM pg_catalog.pg_auth_members m ORDER BY oid')).rows,
    schemas:(await db.query("SELECT nspname,nspowner,nspacl::text FROM pg_catalog.pg_namespace WHERE nspname LIKE 'memory_%' ORDER BY nspname")).rows,
    roles:(await db.query("SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname LIKE 'memory_%' OR rolname LIKE '%test_login' ORDER BY rolname")).rows
  });
  observe.tableIds=tables.map(r=>r.oid);observe.triggerIds=triggerIds;return observe;
}

export async function assertOnlyExpectedParentFkTriggers(db,observe) {
  const fks=(await db.query(`SELECT c.oid::int AS oid,c.conrelid::regclass::text AS child,c.confrelid::regclass::text AS parent,
    pg_get_constraintdef(c.oid) AS definition,c.convalidated,c.condeferrable,c.confupdtype,c.confdeltype
    FROM pg_catalog.pg_constraint c WHERE c.conrelid IN($1::regclass,$2::regclass) AND c.contype='f' ORDER BY child`,[provisionTable,dispositionTable])).rows;
  assert.equal(fks.length,2);
  for(const fk of fks)assert.deepEqual({...fk,oid:0},{oid:0,child:fk.child,parent:'memory_control.deployment_identity',
    definition:'FOREIGN KEY (deployment_singleton) REFERENCES memory_control.deployment_identity(singleton)',convalidated:true,condeferrable:false,confupdtype:'a',confdeltype:'a'});
  assert.deepEqual(fks.map(f=>f.child),[dispositionTable,provisionTable]);
  const added=(await db.query(`SELECT t.oid::int AS oid,t.tgconstraint::int AS constraint_id,t.tgrelid::regclass::text AS parent,
    t.tgname,t.tgisinternal,t.tgenabled,p.proname,pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=ANY($1::oid[]) AND NOT(t.oid=ANY($2::oid[])) ORDER BY t.oid`,[observe.tableIds,observe.triggerIds])).rows;
  assert.equal(added.length,4);
  for(const fk of fks){
    const pair=added.filter(t=>t.constraint_id===fk.oid);assert.equal(pair.length,2);
    assert.deepEqual(pair.map(t=>t.proname).sort(),['RI_FKey_noaction_del','RI_FKey_noaction_upd']);
    for(const row of pair){assert.equal(row.parent,fk.parent);assert.equal(row.tgisinternal,true);assert.equal(row.tgenabled,'O');assert.match(row.tgname,/^RI_ConstraintTrigger_a_[0-9]+$/);
      const event=row.proname.endsWith('_del')?'DELETE':'UPDATE';
      assert.equal(row.definition,`CREATE CONSTRAINT TRIGGER "${row.tgname}" AFTER ${event} ON memory_control.deployment_identity FROM ${fk.child} NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "${row.proname}"()`);
    }
  }
}

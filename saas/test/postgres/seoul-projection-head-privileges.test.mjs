import test from 'node:test';
import assert from 'node:assert/strict';
import {createHeadFixture,event,wire,tables} from './seoul-projection-head-fixture.mjs';
import {verifySeoulServingPrivileges} from '../../src/postgres/seoul/privileges.ts';

const catalogue=async db=>{
  const queries={
    roles:`SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname LIKE 'memory_projection_%' ORDER BY rolname`,
    edges:`SELECT pg_catalog.pg_get_userbyid(roleid) AS role,pg_catalog.pg_get_userbyid(member) AS member,pg_catalog.pg_get_userbyid(grantor) AS grantor,inherit_option,set_option,admin_option FROM pg_catalog.pg_auth_members WHERE roleid IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname LIKE 'memory_projection_%') OR member IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname LIKE 'memory_projection_%') ORDER BY 1,2,3`,
    tables:`SELECT c.relname,pg_catalog.pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text FROM pg_catalog.pg_class c WHERE c.relname LIKE 'identity_projection_%' AND c.relkind='r' ORDER BY 1`,
    columns:`SELECT c.relname,a.attname,a.attacl::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE c.relname LIKE 'identity_projection_%' AND a.attacl IS NOT NULL ORDER BY 1,2`,
    functions:`SELECT n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,pg_catalog.pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,p.proacl::text,pg_catalog.pg_get_function_result(p.oid) AS result,p.prosrc FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.proname LIKE 'seoul_projection_%' ORDER BY 1,2,3`,
    policies:`SELECT c.relname,p.polname,p.polcmd,ARRAY(SELECT pg_catalog.pg_get_userbyid(x) FROM unnest(p.polroles) x) AS roles,pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expr,pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expr FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid WHERE c.relname LIKE 'identity_projection_%' ORDER BY 1,2`,
    triggers:`SELECT c.relname,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid) AS definition FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE c.relname LIKE 'identity_projection_%' AND NOT t.tgisinternal ORDER BY 1,2`,
    defaults:`SELECT pg_catalog.pg_get_userbyid(defaclrole) AS role,defaclnamespace,defaclobjtype,defaclacl::text FROM pg_catalog.pg_default_acl WHERE defaclrole IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname LIKE 'memory_projection_%') ORDER BY 1,2,3`,
    schemas:`SELECT nspname,nspacl::text FROM pg_catalog.pg_namespace WHERE nspname LIKE 'memory_%' ORDER BY 1`
  };
  const result={};for(const [key,sql] of Object.entries(queries))result[key]=(await db.query(sql)).rows;return result;
};

test('reserved role collisions roll back draft setup and keep the existing schema5 catalogue intact',async t=>{
  for(const role of ['memory_projection_owner','memory_projection_caller']) await t.test(role,async st=>{
    const f=await createHeadFixture(st,{install:false});
    await f.db.exec('CREATE ROLE '+role+' NOLOGIN');
    await assert.rejects(f.installDraft(),{message:'memory_projection_reserved_role_exists'});
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM pg_catalog.pg_class WHERE relname LIKE 'identity_projection_%'")).rows[0].n,0);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname LIKE 'memory_projection_%'")).rows[0].n,1);
    await f.asRuntime(()=>verifySeoulServingPrivileges({query:(...args)=>f.db.query(...args)},f.runtimeRole,5));
  });
});

test('draft installation preserves populated schema5 rows, functions, table ACLs and creator edges',async t=>{
  const f=await createHeadFixture(t,{seed:true,install:false});
  const oldTables=(await f.db.query("SELECT c.oid::int AS oid,n.nspname||'.'||c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_%' AND c.relkind='r' ORDER BY 2")).rows;
  const oldFunctions=(await f.db.query("SELECT p.oid::int AS oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'memory_%' ORDER BY p.oid")).rows.map(r=>r.oid);
  const snapshot=async()=>({
    rows:await Promise.all(oldTables.map(async r=>[r.name,(await f.db.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) AS rows FROM ${r.name} x`)).rows[0].rows])),
    tables:(await f.db.query('SELECT c.oid,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE oid=ANY($1::oid[]) ORDER BY oid',[oldTables.map(r=>r.oid)])).rows,
    columns:(await f.db.query('SELECT attrelid,attname,attacl::text FROM pg_catalog.pg_attribute WHERE attrelid=ANY($1::oid[]) AND attnum>0 ORDER BY attrelid,attnum',[oldTables.map(r=>r.oid)])).rows,
    functions:(await f.db.query('SELECT p.oid,p.proowner,p.proacl::text,p.proconfig,p.prosrc FROM pg_catalog.pg_proc p WHERE oid=ANY($1::oid[]) ORDER BY oid',[oldFunctions])).rows,
    defaults:(await f.db.query("SELECT to_jsonb(d) AS value FROM pg_catalog.pg_default_acl d WHERE defaclrole IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN('memory_owner','memory_commands','memory_lifecycle')) ORDER BY oid")).rows,
    edges:(await f.db.query("SELECT to_jsonb(m) AS value FROM pg_catalog.pg_auth_members m WHERE roleid IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN('memory_owner','memory_commands','memory_lifecycle','memory_runtime','memory_background')) ORDER BY oid")).rows,
    policies:(await f.db.query('SELECT to_jsonb(p) AS value FROM pg_catalog.pg_policy p WHERE polrelid=ANY($1::oid[]) ORDER BY oid',[oldTables.map(r=>r.oid)])).rows,
    triggers:(await f.db.query('SELECT pg_catalog.pg_get_triggerdef(oid) AS definition FROM pg_catalog.pg_trigger WHERE tgrelid=ANY($1::oid[]) ORDER BY oid',[oldTables.map(r=>r.oid)])).rows
  });
  const before=await snapshot();await f.installDraft();assert.deepEqual(await snapshot(),before);
});

test('the real caller can only execute apply/status under forced RLS and cannot assume privileged owners',async t=>{
  const f=await createHeadFixture(t,{seed:true});
  assert.equal(JSON.parse(await f.apply(wire(event(1)))).outcome,'applied');
  for(const role of ['projection_test_login','memory_projection_caller','memory_seoul_runtime','memory_runtime','memory_background','memory_commands','memory_lifecycle','anon','authenticated']) {
    for(const name of [...tables.map(x=>'memory_ops.'+x),'memory_identity.accounts','memory_identity.credentials','memory_control.spaces','memory_content.archive_messages']) {
      if(!['projection_test_login','memory_projection_caller'].includes(role)&&!name.includes('identity_projection_'))continue;
      for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) {
        const yes=(await f.db.query('SELECT pg_catalog.has_table_privilege($1,$2,$3) AS yes',[role,name,privilege])).rows[0].yes;
        assert.equal(yes,false,role+' '+privilege+' '+name);
      }
    }
  }
  for(const role of ['projection_test_login','memory_projection_caller']) {
    for(const target of ['memory_projection_owner','memory_owner','memory_commands','memory_lifecycle'])
      await assert.rejects(f.asRole(role,db=>db.exec('SET ROLE '+target)),{code:'42501'});
    await assert.rejects(f.asRole(role,db=>db.exec('SELECT * FROM memory_ops.identity_projection_events')),{code:'42501'});
    await assert.rejects(f.asRole(role,db=>db.exec('INSERT INTO memory_ops.identity_projection_events SELECT * FROM memory_ops.identity_projection_events WHERE false')),{code:'42501'});
    await assert.rejects(f.asRole(role,db=>db.exec('UPDATE memory_ops.identity_projection_events SET payload_text=payload_text')),{code:'42501'});
    await assert.rejects(f.asRole(role,db=>db.exec('DELETE FROM memory_identity.credentials')),{code:'42501'});
    await assert.rejects(f.asRole(role,db=>db.exec('TRUNCATE memory_ops.identity_projection_events')),{code:'42501'});
    await assert.rejects(f.asRole(role,db=>db.exec('CREATE TABLE memory_ops.forbidden(id integer)')),{code:'42501'});
    await assert.rejects(f.asRole(role,db=>db.query('SELECT memory_identity.seoul_projection_head_canonical($1::jsonb)',[event(2)])),{code:'42501'});
  }
  for(const role of ['projection_test_login','memory_runtime','memory_background','memory_commands','memory_lifecycle','anon','authenticated'])
    await assert.rejects(f.asRole(role,db=>db.query('SELECT memory_identity.seoul_projection_apply($1,$2)',[wire(event(2)),'a'.repeat(64)])),{code:'42501'});
  await assert.rejects(f.asRuntime(()=>verifySeoulServingPrivileges({query:(...args)=>f.db.query(...args)},f.runtimeRole,5)),{code:'seoul_serving_privileges_denied'});
  assert.equal((await f.db.query('SELECT max(version) AS v FROM memory_control.schema_migrations')).rows[0].v,5);
});

test('exact catalogue exposes only bounded owner privileges and detects actual role/ACL/RLS/code drift',async t=>{
  const f=await createHeadFixture(t),initial=await catalogue(f.db);
  assert.deepEqual(initial.roles,['memory_projection_caller','memory_projection_owner'].map(rolname=>({rolname,rolcanlogin:false,rolinherit:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false})));
  assert.deepEqual(initial.tables.map(r=>({name:r.relname,owner:r.owner,rls:r.relrowsecurity,force:r.relforcerowsecurity})),[...tables].sort().map(name=>({name,owner:'memory_owner',rls:true,force:true})));
  for(const edge of initial.edges) {
    if(edge.member==='projection_test_login')assert.deepEqual(edge,{role:'memory_projection_caller',member:'projection_test_login',grantor:'postgres',inherit_option:false,set_option:true,admin_option:false});
    else {assert.equal(edge.member,'fixture_provisioner');assert.equal(edge.set_option,false);assert.equal(edge.inherit_option,false);
      assert.equal(edge.admin_option,edge.grantor==='postgres');assert.ok(['postgres','fixture_provisioner'].includes(edge.grantor));}
  }
  assert.equal(initial.edges.length,5);
  assert.deepEqual(initial.functions.map(r=>[r.nspname+'.'+r.proname,r.result,r.owner,r.prosecdef,r.proconfig]),[
    ['memory_identity.seoul_projection_apply','text','memory_projection_owner',true,['search_path=pg_catalog']],
    ['memory_identity.seoul_projection_head_canonical','text','memory_projection_owner',false,['search_path=pg_catalog']],
    ['memory_ops.seoul_projection_monotonic_guard','trigger','memory_projection_owner',false,['search_path=pg_catalog']],
    ['memory_ops.seoul_projection_status','text','memory_projection_owner',true,['search_path=pg_catalog']]]);
  assert.deepEqual(initial.columns.map(r=>[r.relname,r.attname]),[
    ['identity_projection_fence','id'],['identity_projection_heads','source_revision'],
    ['identity_projection_lifecycle','occurred_at_ms'],['identity_projection_lifecycle','source_revision'],['identity_projection_lifecycle','state']]);
  for(const table of tables) {
    const privileges=(await f.db.query(`SELECT privilege_type FROM pg_catalog.aclexplode((SELECT relacl FROM pg_catalog.pg_class WHERE relname=$1)) WHERE grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='memory_projection_owner') ORDER BY 1`,[table])).rows.map(r=>r.privilege_type);
    assert.deepEqual(privileges,table==='identity_projection_fence'?['SELECT']:['INSERT','SELECT']);
    assert.equal(initial.policies.filter(r=>r.relname===table&&r.polname==='migration_owner').length,1);
    assert.ok(initial.policies.some(r=>r.relname===table&&r.polcmd==='r'&&r.roles.join()==='memory_projection_owner'));
    assert.equal(initial.triggers.filter(r=>r.relname===table).length,3);
  }
  for(const fn of initial.functions)assert.doesNotMatch(fn.proacl,/(?:\{|,)=X\//,fn.proname+' PUBLIC execute');
  const execute=(await f.db.query(`SELECT p.proname,pg_catalog.pg_get_userbyid(a.grantee) AS grantee,a.is_grantable
    FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
    WHERE p.proname LIKE 'seoul_projection_%' ORDER BY 1,2`)).rows;
  assert.deepEqual(execute,[
    {proname:'seoul_projection_apply',grantee:'memory_projection_caller',is_grantable:false},
    {proname:'seoul_projection_apply',grantee:'memory_projection_owner',is_grantable:false},
    {proname:'seoul_projection_head_canonical',grantee:'memory_projection_owner',is_grantable:false},
    {proname:'seoul_projection_monotonic_guard',grantee:'memory_projection_owner',is_grantable:false},
    {proname:'seoul_projection_status',grantee:'memory_projection_caller',is_grantable:false},
    {proname:'seoul_projection_status',grantee:'memory_projection_owner',is_grantable:false}]);
  assert.equal(initial.defaults.length,1);assert.equal(initial.defaults[0].role,'memory_projection_owner');assert.equal(initial.defaults[0].defaclobjtype,'f');
  const drift=[
    ['owner login','ALTER ROLE memory_projection_owner LOGIN'],['owner bypass','ALTER ROLE memory_projection_owner BYPASSRLS'],
    ['owner membership','GRANT memory_projection_owner TO memory_projection_caller WITH SET TRUE'],
    ['indirect owner path','CREATE ROLE projection_bridge; GRANT memory_projection_owner TO projection_bridge; GRANT projection_bridge TO memory_projection_caller'],
    ['table select','GRANT SELECT ON memory_ops.identity_projection_events TO memory_projection_caller'],
    ['column update','GRANT UPDATE(payload_text) ON memory_ops.identity_projection_events TO memory_projection_caller'],
    ['PUBLIC execute','GRANT EXECUTE ON FUNCTION memory_ops.seoul_projection_status(text,text) TO PUBLIC'],
    ['default execute','ALTER DEFAULT PRIVILEGES FOR ROLE memory_projection_owner GRANT EXECUTE ON FUNCTIONS TO PUBLIC'],
    ['RLS force','ALTER TABLE memory_ops.identity_projection_heads NO FORCE ROW LEVEL SECURITY'],
    ['missing policy','DROP POLICY projection_owner_select ON memory_ops.identity_projection_heads'],
    ['missing trigger','DROP TRIGGER no_update ON memory_ops.identity_projection_events'],
    ['search path','ALTER FUNCTION memory_identity.seoul_projection_apply(text,text) SET search_path=public'],
    ['wrong function owner','ALTER FUNCTION memory_ops.seoul_projection_status(text,text) OWNER TO memory_owner'],
    ['extra overload',"CREATE FUNCTION memory_identity.seoul_projection_apply(jsonb,text) RETURNS text LANGUAGE sql AS 'SELECT NULL::text'"],
    ['schema create','GRANT CREATE ON SCHEMA memory_ops TO memory_projection_caller']
  ];
  for(const [name,sql] of drift)await t.test(name,async()=>{
    await f.db.exec('BEGIN');
    try {await f.db.exec(sql);assert.notDeepEqual(await catalogue(f.db),initial);}finally{await f.db.exec('ROLLBACK');}
    assert.deepEqual(await catalogue(f.db),initial);
  });
});

test('the definer cannot insert events when its forced-RLS policy is missing',async t=>{
  const f=await createHeadFixture(t),before=await f.state();
  await f.db.exec('DROP POLICY projection_owner_insert ON memory_ops.identity_projection_events');
  await assert.rejects(f.apply(wire(event(1))),{code:'42501'});
  assert.deepEqual(await f.state(),before);
});

test('immutable event/receipt/source/terminal rows and monotonic heads reject privileged invalid transitions',async t=>{
  const f=await createHeadFixture(t);await f.apply(wire(event(2,undefined,undefined,{type:'subject-lifecycle',subject:'alice',state:'deleted',occurredAtMs:2})));
  for(const table of tables) {
    await assert.rejects(f.asOwner(db=>db.exec('DELETE FROM memory_ops.'+table)),{message:'memory_immutable_record'});
    await assert.rejects(f.asOwner(db=>db.exec('TRUNCATE memory_ops.'+table+' CASCADE')),{message:'memory_immutable_record'});
  }
  for(const table of ['identity_projection_events','identity_projection_receipts','identity_projection_source_heads'])
    await assert.rejects(f.asOwner(db=>db.exec('UPDATE memory_ops.'+table+' SET '+(table==='identity_projection_events'?'received_at_ms=received_at_ms':table==='identity_projection_receipts'?'receipt_text=receipt_text':'effect=effect'))),{message:'memory_immutable_record'});
  await assert.rejects(f.asOwner(db=>db.exec('UPDATE memory_ops.identity_projection_heads SET source_revision=source_revision')),{message:'memory_immutable_record'});
});

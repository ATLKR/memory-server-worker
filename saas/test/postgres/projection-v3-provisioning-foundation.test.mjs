import test from 'node:test';
import assert from 'node:assert/strict';
import {createProvisioningFixture,provision,disposition,retained,provisionTable,dispositionTable,insertQuery,oldSurface,assertOnlyExpectedParentFkTriggers} from './projection-v3-provisioning-fixture.mjs';
import {uuid,ISSUER,event,wire} from './seoul-projection-head-fixture.mjs';

const invalid={code:'PP004',message:'seoul_projection_setup_invalid'};
const conflict={code:'PP005',message:'seoul_projection_setup_conflict'};
async function rejects(operation,expected=invalid){await assert.rejects(operation,error=>{assert.equal(error.code,expected.code);assert.equal(error.message,expected.message);assert.ok(error.detail===undefined||error.detail==='');assert.ok(error.hint===undefined||error.hint==='');return true;});}
const rows=async(f,table)=>(await f.db.query(`SELECT to_jsonb(x) AS value FROM ${table} x ORDER BY approval_id`)).rows.map(r=>r.value);

test('empty installation preserves preexisting objects and adds only the two FKs four parent triggers',async t=>{
  const f=await createProvisioningFixture(t,{seed:false,install:false}),observe=await oldSurface(f.db),before=await observe();
  await f.installFoundation();assert.deepEqual(await observe(),before);
  await assertOnlyExpectedParentFkTriggers(f.db,observe);
  assert.deepEqual(await rows(f,provisionTable),[]);assert.deepEqual(await rows(f,dispositionTable),[]);
  await rejects(f.insert(provisionTable,provision()),conflict);
  await f.owner(db=>db.exec("INSERT INTO memory_control.deployment_identity VALUES(1,'memory-seoul','kr-seoul','kr-primary-storage-v1',1)"));
  await f.insert(provisionTable,provision());
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_control.spaces')).rows[0].n,0);
  assert.equal((await f.db.query('SELECT max(version)::int AS n FROM memory_control.schema_migrations')).rows[0].n,5);
  t.diagnostic('Local PostgreSQL '+(await f.db.query('SELECT version() AS v')).rows[0].v+'; no provider/TCP claim');
});

test('populated installation and all eight explicit dispositions preserve old rows, guards, functions and ACLs',async t=>{
  const f=await createProvisioningFixture(t,{install:false}),observe=await oldSurface(f.db),before=await observe();
  await f.installFoundation();assert.deepEqual(await observe(),before);
  await assertOnlyExpectedParentFkTriggers(f.db,observe);
  await f.insert(provisionTable,provision());
  for(const [index,kind] of Object.keys(retained).entries())await f.insert(dispositionTable,disposition(kind,index+100));
  assert.equal((await rows(f,dispositionTable)).length,8);assert.deepEqual(await observe(),before);
  assert.equal(JSON.parse(await f.apply(wire(event(1)))).outcome,'applied');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_control.spaces')).rows[0].n,4);
});

test('database audit stamps cannot be supplied and exact duplicate cannot refresh them',async t=>{
  const f=await createProvisioningFixture(t),p={...provision(),approved_at_ms:0,approved_by_session:'forged_session'};
  await f.insert(provisionTable,p);const before=await rows(f,provisionTable);
  assert.ok(before[0].approved_at_ms>0);assert.equal(before[0].approved_by_session,'setup_test_login');
  await rejects(f.insert(provisionTable,p),conflict);assert.deepEqual(await rows(f,provisionTable),before);
  const next=provision(2);await rejects(f.insert(provisionTable,next),conflict);
  await rejects(f.insert(provisionTable,provision(1,'space:future')),conflict);
});

test('exact deployment policy and retained quotas reject drift without changing source rows',async t=>{
  const f=await createProvisioningFixture(t),observe=await oldSurface(f.db),before=await observe();
  const variants=[p=>p.deployment_id='elsewhere',p=>p.storage_region='sg',p=>p.processing_policy_id='elsewhere',p=>p.deployment_created_at_ms=2,p=>p.data_policy.sensitivityTags=['health'],p=>p.source_byte_limit=1,p=>p.message_limit=2];
  for(const mutate of variants){const p=provision();mutate(p);await rejects(f.insert(provisionTable,p),conflict);}
  assert.deepEqual(await observe(),before);assert.deepEqual(await rows(f,provisionTable),[]);
});

test('closed policy, scalar, locator and size domains reject malformed explicit records',async t=>{
  const f=await createProvisioningFixture(t);
  const variants=[p=>p.data_policy.extra=true,p=>delete p.data_policy.profile,p=>p.data_policy.policyVersion='1',p=>p.data_policy.placementEpoch=2,
    p=>p.data_policy.sensitivityTags=['health','clinical-origin'],p=>p.data_policy.sensitivityTags=['health','health'],p=>p.data_policy.sensitivityTags=['clinical-origin'],
    p=>p.data_policy.sensitivityTags=['unsupported'],p=>p.data_policy.sensitivityTags={},p=>p.data_policy=null,p=>p.data_policy.extra='x'.repeat(131073),
    p=>p.source_byte_limit=-1,p=>p.source_byte_limit=67108865,p=>p.message_limit=0,p=>p.message_limit=100001,p=>p.space_id='bad space',p=>p.space_id='x'.repeat(129),p=>p.space_id=null,
    p=>p.deployment_singleton=2,p=>p.approval_id=null,p=>p.approval_reference=null];
  for(const mutate of variants){const p=provision(1,'space:future');mutate(p);await rejects(f.insert(provisionTable,p));}
  const dVariants=[d=>d.entity_kind='archive',d=>d.disposition='allow',d=>d.issuer=ISSUER,d=>d.credential_id='pat:a',d=>d.entity_id=null,
    d=>d.retained_basis.extra=1,d=>delete d.authorized_binding.disabled_at,d=>d.retained_basis.id=1,d=>d.authorized_binding.disabled_at=false,d=>d.authorized_binding.id='bad id',
    d=>d.retained_basis.extra='x'.repeat(131073),d=>d.retained_basis=[],d=>d.authorized_binding=null];
  for(const mutate of dVariants){const d=disposition('account');mutate(d);await rejects(f.insert(dispositionTable,d));}
});

test('finite quota boundaries and exact supported tag combinations need no positive Space',async t=>{
  const f=await createProvisioningFixture(t);let n=1;
  for(const [bytes,messages,tags] of [[0,1,[]],[67108864,100000,['clinical-origin','credential','government-id','health']]]){
    const p=provision(n++,'space:future'+n);p.source_byte_limit=bytes;p.message_limit=messages;p.data_policy.sensitivityTags=tags;
    await f.insert(provisionTable,p);
  }
  assert.equal((await rows(f,provisionTable)).length,2);
});

test('basis mismatch and immutable target substitution fail without adopting matching IDs',async t=>{
  const f=await createProvisioningFixture(t);await f.insert(provisionTable,provision());
  for(const [index,kind] of Object.keys(retained).entries()){
    const d=disposition(kind,index+100);const field=kind==='provider_identity'?'created_at':kind==='legacy_grant'?'account_id':kind==='credential'?'token_digest':kind==='email'?'verified_at':'id';
    d.authorized_binding[field]=field==='created_at'||field==='verified_at'?2:field==='token_digest'?'d'.repeat(64):'different';
    await rejects(f.insert(dispositionTable,d),conflict);
  }
  const d=disposition('membership');d.retained_basis.role='member';await rejects(f.insert(dispositionTable,d),conflict);
  const absent=disposition('account');absent.entity_id='account:absent';absent.retained_basis.id=absent.authorized_binding.id=absent.entity_id;
  await rejects(f.insert(dispositionTable,absent),conflict);
  assert.deepEqual(await rows(f,dispositionTable),[]);
});

test('explicit first-adoption mutable targets are stored only and preserve privileged regional fields',async t=>{
  const f=await createProvisioningFixture(t),observe=await oldSurface(f.db),before=await observe();
  for(const [kind,field,value] of [['credential','reauthenticated_at',12],['legacy_grant','can_erase',false],['legacy_grant','can_retire',false]]){
    const d=disposition(kind,20);d.authorized_binding[field]=value;await rejects(f.insert(dispositionTable,d),conflict);
  }
  const m=disposition('membership',1);m.authorized_binding.role='member';m.authorized_binding.expires_at=50;
  const c=disposition('credential',2);c.authorized_binding.permission='read';c.authorized_binding.expires_at=60;
  const g=disposition('legacy_grant',3);g.authorized_binding.can_ingest=false;g.authorized_binding.expires_at=70;
  for(const d of [m,c,g])await f.insert(dispositionTable,d);
  assert.deepEqual(await observe(),before);
});

test('all negative states and unsupported session/composite bindings are unadoptable',async t=>{
  const f=await createProvisioningFixture(t);
  for(const kind of ['account','organization','email','membership','credential','space','legacy_grant']){
    const d=disposition(kind);const field=['account','organization','space'].includes(kind)?'disabled_at':'revoked_at';
    d.retained_basis[field]=d.authorized_binding[field]=1;await rejects(f.insert(dispositionTable,d));
  }
  for(const mutate of [d=>d.authorized_binding.kind='session',d=>d.authorized_binding.membership_id=null,d=>d.authorized_binding.permission='admin',d=>d.authorized_binding.expires_at=1.5,d=>d.authorized_binding.expires_at=9007199254740992]){
    const d=disposition('credential');mutate(d);await rejects(f.insert(dispositionTable,d));
  }
  await f.owner(db=>db.exec("UPDATE memory_identity.accounts SET disabled_at=5 WHERE id='account:a'"));
  await rejects(f.insert(dispositionTable,disposition('account')),conflict);
});

test('retained Space requires exact provisioning and existing usage without resetting any counter',async t=>{
  const f=await createProvisioningFixture(t);
  await rejects(f.insert(dispositionTable,disposition('space')),conflict);
  await f.insert(provisionTable,provision());await f.insert(dispositionTable,disposition('space'));
  assert.deepEqual((await f.db.query("SELECT source_bytes::int,message_count,retained_source_bytes::int,retained_message_count FROM memory_ops.space_usage WHERE space_id='space:a'")).rows[0],
    {source_bytes:100,message_count:3,retained_source_bytes:80,retained_message_count:2});
  await f.owner(db=>db.query("INSERT INTO memory_control.spaces SELECT 'space:no-usage',owner_account_id,organization_id,deployment_id,data_policy,disabled_at,source_byte_limit,message_limit FROM memory_control.spaces WHERE id='space:a'"));
  await f.insert(provisionTable,provision(2,'space:no-usage'));
  const d=disposition('space',3);d.entity_id=d.retained_basis.id=d.authorized_binding.id='space:no-usage';
  await rejects(f.insert(dispositionTable,d),conflict);
});

test('a Space created after approval under another deployment cannot obtain a disposition',async t=>{
  const f=await createProvisioningFixture(t);await f.insert(provisionTable,provision(1,'space:late'));
  await f.owner(db=>db.exec(`INSERT INTO memory_control.spaces SELECT 'space:late',owner_account_id,organization_id,'foreign-deployment',data_policy,disabled_at,source_byte_limit,message_limit FROM memory_control.spaces WHERE id='space:a';
    INSERT INTO memory_ops.space_usage(space_id) VALUES('space:late')`));
  const d=disposition('space',2);d.entity_id=d.retained_basis.id=d.authorized_binding.id='space:late';
  d.retained_basis.deployment_id=d.authorized_binding.deployment_id='foreign-deployment';
  await rejects(f.insert(dispositionTable,d),conflict);assert.deepEqual(await rows(f,dispositionTable),[]);
});

test('account needs an existing canonical-issuer mapping and email rules never normalize legacy rows',async t=>{
  const f=await createProvisioningFixture(t);
  const d=disposition('account');d.entity_id=d.retained_basis.id=d.authorized_binding.id='account:b';
  await rejects(f.insert(dispositionTable,d),conflict);
  await f.owner(db=>db.exec("INSERT INTO memory_identity.provider_identities VALUES('https://foreign.invalid','bob','account:b',1)"));
  await rejects(f.insert(dispositionTable,d),conflict);
  for(const address of ['a..b@example.test','a@-example.test','a@exam_ple.test','a\nb@example.test']){
    const e=disposition('email');e.retained_basis.address=e.authorized_binding.address=address;await rejects(f.insert(dispositionTable,e));
  }
  const e=disposition('email');e.authorized_binding.domain='wrong.test';await rejects(f.insert(dispositionTable,e));
  const domain='b'.repeat(63)+'.'+'c'.repeat(63)+'.'+'d'.repeat(61),address='a'.repeat(64)+'@'+domain;
  assert.equal(address.length,254);
  await f.owner(db=>db.query('INSERT INTO memory_identity.account_emails(id,account_id,address,domain,verified_at) VALUES($1,$2,$3,$4,1)',['email:max','account:a',address,domain]));
  const max=disposition('email',2);max.entity_id=max.retained_basis.id=max.authorized_binding.id='email:max';
  for(const value of [max.retained_basis,max.authorized_binding]){value.address=address;value.domain=domain;}
  await f.insert(dispositionTable,max);
});

test('provider composite keys preserve maximum opaque subjects and distinguish delimiters',async t=>{
  const f=await createProvisioningFixture(t);let n=1;
  const subjects=['한'.repeat(512),'😀'.repeat(256),'a\nb','a\u0001b','a\\nb','\uE000','😀'];
  for(const subject of subjects){
    await f.owner(db=>db.query('INSERT INTO memory_identity.provider_identities VALUES($1,$2,$3,1)',[ISSUER,subject,'account:a']));
    const d=disposition('provider_identity',n++);d.subject=d.retained_basis.subject=d.authorized_binding.subject=subject;
    await f.insert(dispositionTable,d);await rejects(f.insert(dispositionTable,{...d,approval_id:uuid(100+n)}),conflict);
  }
  assert.deepEqual((await rows(f,dispositionTable)).map(r=>r.subject).sort(),[...subjects].sort());
  for(const subject of ['😀'.repeat(257),'a'.repeat(513),'\uFEFF\t\u2028']){
    const d=disposition('provider_identity',90);d.subject=d.retained_basis.subject=d.authorized_binding.subject=subject;await rejects(f.insert(dispositionTable,d));
  }
});

test('single-row statements reject zero/multiple rows and late failure rolls back the whole transaction',async t=>{
  const f=await createProvisioningFixture(t);
  await rejects(f.owner(db=>db.exec(`INSERT INTO ${provisionTable} SELECT * FROM ${provisionTable} WHERE false`)));
  const p=provision(1,'space:new-a'),[sql,values]=insertQuery(provisionTable,p),columns=Object.keys(p),second=Object.values(provision(2,'space:new-b'));
  const multi=sql.replace(' RETURNING approval_id',',('+columns.map((_,i)=>'$'+(values.length+i+1)).join(',')+')');
  await rejects(f.owner(db=>db.query(multi,[...values,...second])));assert.deepEqual(await rows(f,provisionTable),[]);
  await rejects(f.owner(async db=>{await db.exec('BEGIN');await db.query(...insertQuery(provisionTable,p));await db.query(...insertQuery(provisionTable,provision(3,'space:new-a')));await db.exec('COMMIT');}),conflict);
  assert.deepEqual(await rows(f,provisionTable),[]);
  await rejects(f.owner(db=>db.exec(`INSERT INTO ${dispositionTable} SELECT * FROM ${dispositionTable} WHERE false`)));
});

test('statement guards reject owner no-op and hidden-row UPDATE DELETE TRUNCATE',async t=>{
  const f=await createProvisioningFixture(t);
  for(const table of [provisionTable,dispositionTable])for(const sql of [`UPDATE ${table} SET approval_id=approval_id WHERE false`,`DELETE FROM ${table} WHERE false`,`TRUNCATE ${table}`]){
    await rejects(f.owner(db=>db.exec(sql)),{code:'55000',message:'memory_immutable_record'});
  }
  await f.insert(provisionTable,provision());
  await rejects(f.owner(db=>db.exec(`UPDATE ${provisionTable} SET approval_reference=approval_reference`)),{code:'55000',message:'memory_immutable_record'});
  assert.equal((await rows(f,provisionTable)).length,1);
});

test('projector receives only decision column SELECT and every other capability stays closed',async t=>{
  const f=await createProvisioningFixture(t);await f.insert(provisionTable,provision());
  const denied=['projection_test_login','memory_projection_caller','memory_seoul_runtime','memory_runtime','memory_background','memory_commands','memory_lifecycle','anon','authenticated'];
  for(const table of [provisionTable,dispositionTable]){
    for(const role of [...denied,'memory_projection_owner'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
      assert.equal((await f.db.query('SELECT has_table_privilege($1,$2,$3) AS yes',[role,table,privilege])).rows[0].yes,false,role+' '+privilege);
    const columns=(await f.db.query('SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=$1::regclass AND attnum>0 ORDER BY attnum',[table])).rows.map(r=>r.attname);
    for(const column of columns){
      const allowed=!['approval_reference','approved_at_ms','approved_by_session'].includes(column);
      assert.equal((await f.db.query('SELECT has_column_privilege($1,$2,$3,$4) AS yes',['memory_projection_owner',table,column,'SELECT'])).rows[0].yes,allowed,column);
      for(const role of denied)assert.equal((await f.db.query('SELECT has_column_privilege($1,$2,$3,$4) AS yes',[role,table,column,'SELECT'])).rows[0].yes,false,role+' '+column);
    }
    await f.asRole('memory_projection_owner',db=>db.query(`SELECT approval_id FROM ${table}`));
    for(const sql of [`SELECT * FROM ${table}`,`SELECT approved_at_ms FROM ${table}`,`SELECT approval_id FROM ${table} FOR SHARE`,`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`])
      await assert.rejects(f.asRole('memory_projection_owner',db=>db.exec(sql)),{code:'42501'});
    for(const role of denied)await assert.rejects(f.asRole(role,db=>db.query(`SELECT approval_id FROM ${table}`)),{code:'42501'});
  }
  const functions=(await f.db.query("SELECT p.oid::int AS oid,p.proname,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner FROM pg_catalog.pg_proc p WHERE p.proname LIKE 'projection_v3_setup_%' ORDER BY p.proname")).rows;
  assert.ok(functions.length>=3);
  for(const fn of functions){assert.equal(fn.owner,'memory_owner');assert.equal(fn.prosecdef,false);assert.deepEqual(fn.proconfig,['search_path=pg_catalog']);
    for(const role of [...denied,'memory_projection_owner'])assert.equal((await f.db.query('SELECT has_function_privilege($1,$2::oid,$3) AS yes',[role,fn.oid,'EXECUTE'])).rows[0].yes,false,role+' '+fn.proname);
  }
  const policies=(await f.db.query(`SELECT c.relname,p.polcmd,ARRAY(SELECT pg_get_userbyid(r) FROM unnest(p.polroles) r) AS roles
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid WHERE p.polrelid IN($1::regclass,$2::regclass) ORDER BY c.relname,p.polcmd,p.polname`,[provisionTable,dispositionTable])).rows;
  assert.equal(policies.length,6);assert.ok(policies.every(p=>p.polcmd==='r'||p.polcmd==='a'&&p.roles.join()==='memory_owner'));
});

test('insert takes real fence row lock before retained-row reads and rejects inherited-only owner context',async t=>{
  const f=await createProvisioningFixture(t);
  await f.owner(async db=>{await db.exec('BEGIN');await db.query(...insertQuery(provisionTable,provision()));
    const locks=(await db.query("SELECT mode,granted FROM pg_catalog.pg_locks WHERE relation='memory_ops.identity_projection_fence'::regclass ORDER BY mode")).rows;
    assert.ok(locks.some(r=>r.mode==='RowShareLock'&&r.granted));await db.exec('ROLLBACK');});
  await f.db.exec('CREATE ROLE setup_inherit_test LOGIN INHERIT; GRANT memory_owner TO setup_inherit_test WITH INHERIT TRUE,SET FALSE');
  await rejects(f.asRole('setup_inherit_test',db=>db.query(...insertQuery(provisionTable,provision()))),invalid);
  // Remove only the test fixture's read policy inside a rollback-only test:
  // a missing fence is detected before any full-basis conflict can be observed.
  await f.db.exec('BEGIN');
  try{await f.db.exec('DROP POLICY migration_owner ON memory_ops.identity_projection_fence');
    await rejects(f.owner(db=>db.query(...insertQuery(dispositionTable,disposition('account')))),conflict);
  }finally{await f.db.exec('ROLLBACK');}
});

test('retained-row RLS observes the fence lock before the first account read',async t=>{
  const f=await createProvisioningFixture(t);
  // Disposable observer only. No policy/function is part of product SQL.
  await f.owner(db=>db.exec(`CREATE FUNCTION memory_identity.fixture_setup_fence_seen() RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $observer$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE relation='memory_ops.identity_projection_fence'::regclass AND mode='RowShareLock' AND granted AND pid=pg_catalog.pg_backend_pid()) THEN
        RAISE EXCEPTION 'fixture_fence_missing_before_read';
      END IF;
      RETURN true;
    END $observer$;
    CREATE POLICY fixture_setup_fence_read ON memory_identity.accounts AS RESTRICTIVE FOR SELECT TO memory_owner USING(memory_identity.fixture_setup_fence_seen())`));
  await f.insert(dispositionTable,disposition('account'));
  assert.equal((await rows(f,dispositionTable)).length,1);
});

test('retained API-role defaults grant no capability on new setup tables or helpers',async t=>{
  const f=await createProvisioningFixture(t,{install:false});
  await f.owner(db=>db.exec(`ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner IN SCHEMA memory_ops,memory_identity GRANT ALL ON TABLES TO anon,authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner IN SCHEMA memory_ops,memory_identity GRANT EXECUTE ON FUNCTIONS TO anon,authenticated`));
  const observe=await oldSurface(f.db),before=await observe();await f.installFoundation();
  assert.deepEqual(await observe(),before);await assertOnlyExpectedParentFkTriggers(f.db,observe);
  const functions=['memory_identity.projection_v3_setup_valid(jsonb,text)','memory_identity.projection_v3_setup_insert_row()',
    'memory_ops.projection_v3_setup_insert_fence()','memory_ops.projection_v3_setup_insert_count()'];
  const actual=[],expected=[];
  for(const role of ['anon','authenticated']){
    for(const table of [provisionTable,dispositionTable]){
      for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
        const yes=(await f.db.query('SELECT has_table_privilege($1,$2,$3) AS yes',[role,table,privilege])).rows[0].yes;
        actual.push([role,table,privilege,yes]);expected.push([role,table,privilege,false]);
      }
      const columns=(await f.db.query('SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=$1::regclass AND attnum>0 ORDER BY attnum',[table])).rows.map(r=>r.attname);
      for(const column of columns)for(const privilege of ['SELECT','INSERT','UPDATE','REFERENCES']){
        const yes=(await f.db.query('SELECT has_column_privilege($1,$2,$3,$4) AS yes',[role,table,column,privilege])).rows[0].yes;
        actual.push([role,table,column,privilege,yes]);expected.push([role,table,column,privilege,false]);
      }
    }
    for(const fn of functions){
      const yes=(await f.db.query('SELECT has_function_privilege($1,$2,$3) AS yes',[role,fn,'EXECUTE'])).rows[0].yes;
      actual.push([role,fn,'EXECUTE',yes]);expected.push([role,fn,'EXECUTE',false]);
    }
  }
  assert.deepEqual(actual,expected);
  await f.insert(provisionTable,provision());await f.insert(dispositionTable,disposition('account'));
  assert.deepEqual(await observe(),before);
});

test('absent optional API roles are not created or required by setup installation',async t=>{
  const f=await createProvisioningFixture(t,{install:false});
  await f.db.exec('DROP ROLE anon; DROP ROLE authenticated');
  const observe=await oldSurface(f.db),before=await observe();await f.installFoundation();
  assert.deepEqual(await observe(),before);await assertOnlyExpectedParentFkTriggers(f.db,observe);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname IN('anon','authenticated')")).rows[0].n,0);
});

test('arbitrary retained default grantees including runtime and inherited quoted roles gain no setup capability',async t=>{
  const f=await createProvisioningFixture(t,{install:false});
  const quotedRole='setup_acl "quoted_test_login';
  await f.db.exec(`CREATE ROLE "setup_acl ""quoted_test_login" NOLOGIN;
    GRANT "setup_acl ""quoted_test_login" TO projection_test_login WITH INHERIT TRUE,SET FALSE`);
  await f.owner(db=>db.exec(`ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner GRANT ALL ON TABLES TO memory_seoul_runtime WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner GRANT EXECUTE ON FUNCTIONS TO memory_seoul_runtime WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner IN SCHEMA memory_ops,memory_identity GRANT ALL ON TABLES TO "setup_acl ""quoted_test_login" WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner IN SCHEMA memory_ops,memory_identity GRANT EXECUTE ON FUNCTIONS TO "setup_acl ""quoted_test_login" WITH GRANT OPTION`));
  const observe=await oldSurface(f.db),before=await observe();await f.installFoundation();
  assert.deepEqual(await observe(),before);await assertOnlyExpectedParentFkTriggers(f.db,observe);
  const functions=['memory_identity.projection_v3_setup_valid(jsonb,text)','memory_identity.projection_v3_setup_insert_row()',
    'memory_ops.projection_v3_setup_insert_fence()','memory_ops.projection_v3_setup_insert_count()'];
  // Exact ACL checks also cover privileges added by the installed PostgreSQL
  // version (for example MAINTAIN), instead of assuming seven table privileges.
  const relationAcl=(await f.db.query(`SELECT c.relname,a.grantee,a.privilege_type,a.is_grantable
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    WHERE c.oid IN($1::regclass,$2::regclass) AND a.grantee<>c.relowner`,[provisionTable,dispositionTable])).rows;
  const functionAcl=(await f.db.query(`SELECT p.proname,a.grantee,a.privilege_type,a.is_grantable
    FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.oid IN($1::regprocedure,$2::regprocedure,$3::regprocedure,$4::regprocedure) AND a.grantee<>p.proowner`,functions)).rows;
  assert.deepEqual({relationAcl,functionAcl},{relationAcl:[],functionAcl:[]});
  const columns=(await f.db.query(`SELECT c.relname,c.oid::text AS relation,att.attname,a.grantee::regrole::text AS role,a.privilege_type,a.is_grantable
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute att ON att.attrelid=c.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
    WHERE c.oid IN($1::regclass,$2::regclass) AND att.attnum>0 ORDER BY c.relname,att.attnum`,[provisionTable,dispositionTable])).rows;
  assert.ok(columns.length>0);
  for(const column of columns){
    assert.equal(column.role,'memory_projection_owner');assert.equal(column.privilege_type,'SELECT');assert.equal(column.is_grantable,false);
    assert.ok(!['approval_reference','approved_at_ms','approved_by_session'].includes(column.attname));
  }
  for(const role of ['memory_seoul_runtime',quotedRole,'projection_test_login']){
    for(const table of [provisionTable,dispositionTable]){
      assert.equal((await f.db.query("SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') AS yes",[role,table])).rows[0].yes,false);
      if(role===quotedRole){
        // The shared asRole fixture intentionally accepts simple names only.
        await f.db.exec('SET ROLE "setup_acl ""quoted_test_login"');
        try{await assert.rejects(f.db.query(`SELECT approval_id FROM ${table}`),{code:'42501'});}
        finally{await f.db.exec('RESET ROLE');}
      }else await assert.rejects(f.asRole(role,db=>db.query(`SELECT approval_id FROM ${table}`)),{code:'42501'});
    }
    for(const fn of functions)assert.equal((await f.db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS yes",[role,fn])).rows[0].yes,false);
  }
  await f.insert(provisionTable,provision());await f.insert(dispositionTable,disposition('account'));
  assert.deepEqual(await observe(),before);
});

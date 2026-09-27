import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServingFixture,denied,spaceDenied,expired,unavailable,DISPATCHER,servingTables} from './seoul-projection-serving-authorizer-fixture.mjs';
import {createMaterializationFixture} from './seoul-projection-snapshot-materialization-fixture.mjs';
import {createDispatchFixture} from './seoul-projection-snapshot-dispatch-fixture.mjs';
import {seoulIngest,seoulSearch} from './seoul-fixture.mjs';
import {head,emptySnapshot} from './seoul-projection-snapshot-validation-fixture.mjs';
import {event as headEvent,wire as headWire,hash} from './seoul-projection-head-fixture.mjs';

const DIGEST='0123456789abcdef'.repeat(4), ORG_DIGEST=DIGEST;
const input=(space='space:one',overrides={})=>seoulIngest({spaceId:space,...overrides});
const searchInput=(space='space:one',overrides={})=>seoulSearch({spaceId:space,...overrides});
const erase=(space,archiveId='arc:00000000-0000-4000-8000-000000000000')=>({spaceId:space,archiveId,expectedRevision:1,operationId:'11111111-1111-4111-8111-111111111111'});
const status=space=>({kind:'archive',spaceId:space,archiveId:'arc:00000000-0000-4000-8000-000000000000'});
const ownerMutate=(f,sql,params)=>f.asRole('postgres',async db=>{
  // Immutable projected state is fixture-mutated only to simulate elapsed
  // time and deployment drift; the trigger bypass never reaches callers.
  await db.exec("SET session_replication_role='replica'");
  try{return await db.query(sql,params);}finally{await db.exec("SET session_replication_role='origin'");}
});
const check=(f,digest)=>f.call('seoul_pat_check',digest);
const ingest=(f,digest,i)=>f.call('seoul_archive_ingest',digest,i);
const search=(f,digest,i)=>f.call('seoul_keyword_search',digest,i);

test('serving authorizer install requires the dispatch draft',async t=>{
  const f=await createMaterializationFixture(t);
  const sql=await readFile(new URL('../../postgres/projection-v3/serving-authorizer.sql',import.meta.url),'utf8');
  await f.db.exec('GRANT memory_lifecycle TO fixture_provisioner WITH INHERIT FALSE,SET TRUE,ADMIN FALSE');
  await assert.rejects(f.asRole('fixture_provisioner',db=>db.exec(sql)),unavailable);
});

test('serving authorizer install requires lifecycle SET rights',async t=>{
  const f=await createDispatchFixture(t);
  const sql=await readFile(new URL('../../postgres/projection-v3/serving-authorizer.sql',import.meta.url),'utf8');
  await assert.rejects(f.asRole('fixture_provisioner',db=>db.exec(sql)),unavailable);
});

test('serving authorizer install rejects rerun and prior dispatcher role',async t=>{
  const f=await createServingFixture(t);
  await assert.rejects(f.installAuthorizer(),unavailable);
  const rerun=await createDispatchFixture(t);
  await rerun.db.exec(`GRANT memory_lifecycle TO fixture_provisioner WITH INHERIT FALSE,SET TRUE,ADMIN FALSE;
    CREATE ROLE memory_projection_dispatcher LOGIN NOINHERIT;`);
  const sql=await readFile(new URL('../../postgres/projection-v3/serving-authorizer.sql',import.meta.url),'utf8');
  await assert.rejects(rerun.asRole('fixture_provisioner',db=>db.exec(sql)),unavailable);
});

test('unprojected credential and Space fail closed under the projected authorizer',async t=>{
  const f=await createServingFixture(t);
  // The seeded 'a'... digest owns space:a through schema5 rows only.
  await assert.rejects(check(f,'a'.repeat(64)),denied);
  await assert.rejects(ingest(f,'a'.repeat(64),input('space:a')),spaceDenied);
  await assert.rejects(search(f,'a'.repeat(64),searchInput('space:a')),spaceDenied);
});

test('projected personal PAT admits check, ingest and search',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate();await f.serve(p);
  const admission=await check(f,DIGEST);
  assert.equal(admission.result.authenticated,true);
  assert.ok(admission.admission.expiresAtMs-admission.admission.issuedAtMs<=30000);
  assert.ok(!('spaceId' in admission.admission)&&!('spaceId' in admission.result)&&!('grants' in admission.admission));
  const stored=await ingest(f,DIGEST,input());
  assert.equal(stored.result.state,'stored');
  const found=await search(f,DIGEST,searchInput());
  assert.ok(found.result);
});

test('check qualifies through any live grant and hides all but generic admission',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate();await f.serve(p);
  // A second grant on a never-projected Space does not help or hurt the check.
  await f.migrationOwner(async db=>db.query(
    `INSERT INTO memory_identity.pat_space_grants(credential_id,account_id,space_id,can_ingest,can_search,expires_at)
     VALUES('credential:one','account:one','space:a',true,true,9007199254740991)`));
  const admission=await check(f,DIGEST);
  assert.equal(admission.result.authenticated,true);
  assert.ok(admission.admission.expiresAtMs<=admission.admission.issuedAtMs+30000);
});

test('a newer dependency head makes the projected grant stale and denies',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate();await f.serve(p);
  await check(f,DIGEST);
  // The credential head advances past the revision recorded for the grant.
  await f.applyHead(head('credential','credential:one',50000));
  await assert.rejects(ingest(f,DIGEST,input()),spaceDenied);
  await assert.rejects(check(f,DIGEST),denied);
});

test('a deselected generation denies every projected action',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate();await f.serve(p);
  const drop=emptySnapshot();drop.eventId='00008100-0000-4000-8000-000000008100';drop.snapshotSeq=2;
  drop.spaceId='space:one';drop.spaces[0].id='space:one';drop.selected=false;
  const now=await f.now();drop.lease={issuedAtMs:now,expiresAtMs:now+60000};
  const receipt=await f.dispatch(drop);
  await assert.rejects(ingest(f,DIGEST,input()),spaceDenied);
  await assert.rejects(search(f,DIGEST,searchInput()),spaceDenied);
  await assert.rejects(check(f,DIGEST),denied);
});

test('expired lease denies the named action and the unscoped check',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate();await f.serve(p);
  await ownerMutate(f,'UPDATE memory_ops.identity_projection_snapshot_generations SET lease_issued_at_ms=lease_issued_at_ms-120000,lease_expires_at_ms=lease_expires_at_ms-120000 WHERE space_id=$1',['space:one']);
  await assert.rejects(ingest(f,DIGEST,input()),expired);
  await assert.rejects(check(f,DIGEST),denied);
});

test('legacy and projected grant drift fails closed',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate();await f.serve(p);
  await ownerMutate(f,'UPDATE memory_identity.pat_space_grants SET can_search=false WHERE credential_id=$1 AND space_id=$2',['credential:one','space:one']);
  await assert.rejects(ingest(f,DIGEST,input()),spaceDenied);
  await assert.rejects(search(f,DIGEST,searchInput()),spaceDenied);
});

test('erase, retire and status never authorize through projected grants',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate();await f.serve(p);
  await assert.rejects(f.call('seoul_archive_erase',DIGEST,erase('space:one')),spaceDenied);
  await assert.rejects(f.call('seoul_space_retire',DIGEST,{spaceId:'space:one',operationId:'22222222-2222-4222-8222-222222222222'}),spaceDenied);
  await assert.rejects(f.call('seoul_lifecycle_status',DIGEST,status('space:one')),spaceDenied);
});

test('revoke self stays credential-scoped and removes all admission',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate();await f.serve(p);
  await check(f,DIGEST);
  const revoked=await f.call('seoul_pat_revoke_self',DIGEST,{operationId:'33333333-3333-4333-8333-333333333333'});
  assert.equal(revoked.result.state,'revoked');
  await assert.rejects(check(f,DIGEST),denied);
  await assert.rejects(ingest(f,DIGEST,input()),denied);
});

test('the projected lease caps the check admission below thirty seconds',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate({offset:-40000});await f.serve(p);
  const admission=await check(f,DIGEST);
  assert.equal(admission.result.authenticated,true);
  const now=await f.now();
  assert.ok(admission.admission.expiresAtMs<=now+20000&&admission.admission.expiresAtMs<admission.admission.issuedAtMs+30000);
});

test('projected organization api_key admits through member grant',async t=>{
  const f=await createServingFixture(t);
  const p=await f.candidate({organization:true});await f.serve(p);
  const admission=await check(f,ORG_DIGEST);
  assert.equal(admission.result.authenticated,true);
  const stored=await ingest(f,ORG_DIGEST,input());
  assert.equal(stored.result.state,'stored');
});

test('dispatcher login carries only the caller SET edge and no table access',async t=>{
  const f=await createServingFixture(t);
  const role=(await f.db.query(`SELECT rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname=$1`,[DISPATCHER])).rows[0];
  assert.deepEqual(role,{rolcanlogin:true,rolinherit:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});
  await f.asDispatcher(async db=>{
    // Caller path still works through the dispatcher login.
    const raw=headWire(headEvent(99999,'subject','https://auth-api.allen.company\ncarol'));
    const receipt=(await db.query('SELECT memory_identity.seoul_projection_apply($1::text,$2::text) AS receipt',[raw,hash(raw)])).rows[0].receipt;
    assert.ok(receipt);
    await assert.rejects(db.query('SELECT * FROM memory_identity.identity_projection_grants'),{code:'42501'});
    await assert.rejects(db.exec('SET ROLE memory_projection_owner'),{code:'42501'});
  });
});

test('the serving runtime cannot read the projection tables directly',async t=>{
  const f=await createServingFixture(t);
  for(const table of servingTables)
    await assert.rejects(f.asRuntime(db=>db.query(`SELECT * FROM ${table}`)),{code:'42501'});
});

test('the lifecycle role receives exactly the reviewed projection surface',async t=>{
  const f=await createServingFixture(t);
  for(const table of servingTables){
    const policies=(await f.db.query(`SELECT polname,polcmd::text,ARRAY(SELECT pg_get_userbyid(x) FROM unnest(polroles) x) AS roles
      FROM pg_policy WHERE polrelid=$1::regclass AND 'memory_lifecycle'::regrole=ANY(polroles)`,[table])).rows;
    assert.deepEqual(policies,[{polname:'projection_serving_select',polcmd:'r',roles:['memory_lifecycle']}]);
    const acl=(await f.db.query(`SELECT a.privilege_type,a.is_grantable FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid=$1::regclass AND a.grantee='memory_lifecycle'::regrole`,[table])).rows;
    assert.deepEqual(acl,[{privilege_type:'SELECT',is_grantable:false}]);
  }
  const extra=(await f.db.query(`SELECT n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' AS name
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.proname='projection_v3_serving_bound'`)).rows;
  assert.deepEqual(extra,[{name:'memory_identity.projection_v3_serving_bound(text, text, text, text, text, text, text, text)'}]);
  // The authorizer keeps its exact EXECUTE surface: lifecycle owner plus commands.
  const acl=(await f.db.query(`SELECT a.grantee::regrole::text AS grantee,a.privilege_type FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='memory_identity.seoul_action_authority(text,text,text,uuid)'::regprocedure ORDER BY 1`)).rows;
  assert.deepEqual(acl,[{grantee:'memory_commands',privilege_type:'EXECUTE'},{grantee:'memory_lifecycle',privilege_type:'EXECUTE'}]);
});

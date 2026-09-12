import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';

export const SEOUL_RUNTIME='memory_seoul_runtime';
export const SEOUL_DIGEST='a'.repeat(64), OTHER_DIGEST='b'.repeat(64), ORG_DIGEST='c'.repeat(64);
export const SEOUL_POLICY={policyVersion:1,residency:'kr-seoul',profile:'kr-primary-storage',processingBoundary:'approved-processors',
  dataClass:'personal',classificationStatus:'declared',sensitivityTags:[],placementEpoch:1};
export const SEOUL_ROUTING={version:1,classification:'medical',destination:'seoul',requiredRegion:'kr-seoul'};
export const seoulIngest=(overrides={})=>({spaceId:'space:a',operationId:'operation:one',routing:SEOUL_ROUTING,
  messages:[{role:'user',content:'  서울 café 가나다 %_\\ KEYWORD\n',timestamp:'2026-09-12T10:00:00.123456789+09:00'},
    {role:'assistant',content:''}],sessionId:'세션😀',...overrides});
export const seoulSearch=(overrides={})=>({spaceId:'space:a',routing:SEOUL_ROUTING,query:'서울',mode:'keyword',...overrides});
export async function createSeoulFixture(t,{seed=true,Engine=PGlite}={}) {
  const db=new Engine();await db.waitReady;t.after(()=>db.close());
  const initial=(await db.query("SELECT current_database() AS name,current_user AS role,current_setting('server_version_num') AS version")).rows[0];
  const database=initial.name,restore='SET SESSION AUTHORIZATION "'+initial.role.replaceAll('"','""')+'"';
  const quoted='"'+database.replaceAll('"','""')+'"';
  await db.exec('CREATE ROLE fixture_provisioner LOGIN CREATEROLE');
  if(database==='template1'&&initial.version==='170005') {
    // This embedded PG17 build cannot update template1's ACL. Inherit only the
    // fixture bootstrap's ownership; SUPERUSER itself is never inherited.
    await db.exec('GRANT "'+initial.role.replaceAll('"','""')+'" TO fixture_provisioner WITH SET FALSE, INHERIT TRUE, ADMIN FALSE');
  } else await db.exec(`GRANT CREATE ON DATABASE ${quoted} TO fixture_provisioner`);
  await db.exec(`
    GRANT pg_read_all_data TO fixture_provisioner;
    SET SESSION AUTHORIZATION fixture_provisioner;
    SET createrole_self_grant='set, inherit';`);
  assert.deepEqual((await db.query("SELECT current_user AS role,rolsuper,rolcreaterole FROM pg_catalog.pg_roles WHERE rolname=current_user")).rows,
    [{role:'fixture_provisioner',rolsuper:false,rolcreaterole:true}]);
  const directory=new URL('../../postgres/migrations/',import.meta.url);
  for(const name of ['0001_private_namespaces.sql','0002_deployment_identity.sql','0003_identity_foundation.sql']) {
    await db.exec(await readFile(new URL(name,directory),'utf8'));
  }
  await db.exec(await readFile(new URL('0004_seoul_pat_archive.sql',directory),'utf8'));
  await db.exec(`RESET ROLE; ${restore};
    CREATE ROLE memory_seoul_runtime LOGIN INHERIT;
    GRANT memory_runtime TO memory_seoul_runtime WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;`);
  const asOwner=async fn=>{await db.exec('SET ROLE memory_owner');try{return await fn(db);}finally{await db.exec('ROLLBACK');await db.exec('RESET ROLE');}};
  const asRuntime=async fn=>{await db.exec('SET SESSION AUTHORIZATION memory_seoul_runtime');try{return await fn(db);}finally{await db.exec('ROLLBACK');await db.exec(restore);}};
  const seedRows=async()=>asOwner(async()=>{
    await db.exec(`INSERT INTO memory_control.deployment_identity VALUES(1,'memory-seoul','kr-seoul','kr-primary-storage-v1',1);
      INSERT INTO memory_identity.accounts(id) VALUES('account:a'),('account:b');
      INSERT INTO memory_control.organizations(id) VALUES('org:a'),('org:b');
      INSERT INTO memory_identity.account_emails(id,account_id,address,domain,verified_at)
        VALUES('email:a','account:a','a@example.test','example.test',1);
      INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role)
        VALUES('member:a','org:a','account:a','email:a','owner');
      INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at)
        VALUES('pat:a','account:a','personal_key',repeat('a',64),9007199254740991),('pat:b','account:b','personal_key',repeat('b',64),9007199254740991);
      INSERT INTO memory_identity.credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at)
        VALUES('pat:org','account:a','member:a','email:a','api_key',repeat('c',64),9007199254740991);`);
    {
      for(const [id,owner,org] of [['space:a','account:a',null],['space:b','account:b',null],['space:org',null,'org:a'],['space:foreign',null,'org:b']]) {
        await db.query('INSERT INTO memory_control.spaces(id,owner_account_id,organization_id,deployment_id,data_policy,source_byte_limit,message_limit) VALUES($1,$2,$3,$4,$5,1048576,1000)',[id,owner,org,'memory-seoul',SEOUL_POLICY]);
        await db.query('INSERT INTO memory_ops.space_usage(space_id) VALUES($1)',[id]);
      }
      await db.exec(`INSERT INTO memory_identity.pat_space_grants(credential_id,account_id,space_id,can_ingest,can_search,expires_at)
        VALUES('pat:a','account:a','space:a',true,true,9007199254740991),('pat:b','account:b','space:b',true,true,9007199254740991),
        ('pat:org','account:a','space:org',true,true,9007199254740991);`);
    }
  });
  if(seed)await seedRows();
  const call=async(name,digest,input)=>asRuntime(async()=>{
    if(!['seoul_pat_check','seoul_archive_ingest','seoul_keyword_search'].includes(name))throw new Error('Unknown fixture command');
    const schema=name==='seoul_pat_check'?'memory_identity':'memory_content';
    const values=input===undefined?[digest]:[digest,input];
    return (await db.query(`SELECT ${schema}.${name}($1${input===undefined?'':',$2::jsonb'}) AS value`,values)).rows[0].value;
  });
  return {db,asOwner,asRuntime,call,seed:seedRows,runtimeRole:SEOUL_RUNTIME};
}

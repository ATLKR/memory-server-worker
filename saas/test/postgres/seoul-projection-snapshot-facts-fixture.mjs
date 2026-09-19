import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createSnapshotFixture,snapshot,emptySnapshot,addIdentity,addCredential,twoAccounts,head,subjectKey,issuer} from './seoul-projection-snapshot-validation-fixture.mjs';
import {encodeSeoulAuthoritySnapshot} from '../../src/release/seoul-projection-snapshot-codec.ts';

export {snapshot,emptySnapshot,addIdentity,addCredential,twoAccounts,head,subjectKey,issuer};
export const functionName='memory_identity.projection_v3_snapshot_fact(jsonb,text,text)';
export const wire=value=>Buffer.from(encodeSeoulAuthoritySnapshot(value)).toString('utf8');
export const invalid=error=>error.code==='PP001'&&error.message==='seoul_projection_input_invalid'&&!error.detail&&!error.hint;
export async function createFactsFixture(t,{install=true}={}) {
  const f=await createSnapshotFixture(t);
  // Existing explicit installer capabilities, established BEFORE observations.
  await f.db.exec('GRANT memory_owner,memory_projection_owner TO fixture_provisioner WITH INHERIT FALSE,SET TRUE,ADMIN FALSE');
  const owner=fn=>f.asRole('postgres',async db=>{await db.exec('SET ROLE memory_projection_owner');return fn(db);});
  const installFacts=async()=>{
    const sql=await readFile(new URL('../../postgres/projection-v3/snapshot-facts.sql',import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    assert.notEqual(sql,null,'pure snapshot facts SQL must exist');
    return f.asRole('fixture_provisioner',db=>db.exec(sql));
  };
  // Deliberate narrow JSONB invocation for local checks; no raw acceptance claim.
  const local=(value,kind,key)=>owner(async db=>(await db.query('SELECT memory_identity.projection_v3_snapshot_fact($1::jsonb,$2::text,$3::text) AS fact',[value===undefined?null:JSON.stringify(value),kind,key])).rows[0].fact);
  const fromRaw=(raw,kind,key)=>owner(async db=>{
    // canonical(text) itself parses; its returned text is parsed here once for
    // the caller-owned value. There is no claim of one total JSON parse.
    const validated=(await db.query('SELECT memory_identity.projection_v3_snapshot_canonical($1::text) AS raw',[raw])).rows[0].raw;
    return (await db.query('SELECT memory_identity.projection_v3_snapshot_fact($1::jsonb,$2::text,$3::text) AS fact',[validated,kind,key])).rows[0].fact;
  });
  const extract=(value,kind,key)=>fromRaw(wire(value),kind,key);
  if(install)await installFacts();return {...f,owner,installFacts,local,fromRaw,extract};
}

export function expected(org=false) {
  const account={id:'account:one',disabledAtMs:null};
  const credential={id:'credential:one',accountId:'account:one',kind:org?'api_key':'personal_key',permission:'write',tokenDigest:'0123456789abcdef'.repeat(4),membershipId:org?'membership:one':null,emailId:org?'email:one':null,expiresAtMs:90000,revokedAtMs:null};
  return {
    subject:{account,providerIdentities:[{issuer,subject:'alice',accountId:'account:one',createdAtMs:0}]},
    email:{email:{id:'email:one',accountId:'account:one',address:'alice@example.com',verifiedAtMs:0,revokedAtMs:null}},
    organization:{organization:{id:'org:one',disabledAtMs:null}},
    membership:{membership:{id:'membership:one',accountId:'account:one',emailId:'email:one',organizationId:'org:one',role:'admin',expiresAtMs:80000,revokedAtMs:null}},
    credential:{credential,credentialPolicy:{credentialId:'credential:one',capabilities:['create','read'],spaceIds:null}},
    space:{space:{id:'space:one',accountId:org?null:'account:one',organizationId:org?'org:one':null,disabledAtMs:null,policy:{policyVersion:1,residency:'kr-seoul',profile:'kr-primary-storage',processingBoundary:'approved-processors',dataClass:'personal',classificationStatus:'declared',sensitivityTags:[],placementEpoch:1}}}
  };
}
export const keys={subject:subjectKey('alice'),email:subjectKey('alice')+'\nalice@example.com',organization:'org:one',membership:'membership:one',credential:'credential:one',space:'space:one'};

export function otherSpace(value,id='space:two') {
  const p=structuredClone(value);p.spaceId=id;p.spaces[0].id=id;p.snapshotSeq=92;p.sourceRevision+=100;p.lease={issuedAtMs:2000,expiresAtMs:62000};
  for(const g of p.grants){g.spaceId=id;g.heads.space={...g.heads.space,key:id};g.heads.target={...g.heads.target,key:id};}
  return p;
}

export async function surface(db) {
  const query=async sql=>(await db.query(sql)).rows;
  const tables=await query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname LIKE 'memory_%' ORDER BY 1,2");
  const rows={};for(const {schemaname,tablename} of tables)rows[schemaname+'.'+tablename]=(await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]') AS rows FROM ${schemaname}.${tablename} x`)).rows[0].rows;
  return {rows,
    classes:await query("SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_%' ORDER BY c.oid"),
    columns:await query("SELECT a.* FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_%' ORDER BY a.attrelid,a.attnum"),
    functions:await query("SELECT p.oid,p.proowner,p.proacl::text,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'memory_%' AND p.proname<>'projection_v3_snapshot_fact' ORDER BY p.oid"),
    triggers:await query("SELECT t.* FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_%' ORDER BY t.oid"),
    policies:await query('SELECT * FROM pg_policy ORDER BY oid'),defaults:await query('SELECT * FROM pg_default_acl ORDER BY oid'),
    members:await query('SELECT * FROM pg_auth_members ORDER BY oid'),roles:await query('SELECT * FROM pg_roles ORDER BY oid'),
    schemas:await query("SELECT * FROM pg_namespace WHERE nspname LIKE 'memory_%' ORDER BY oid")};
}

export function largeSubjectSnapshot(){
  let p=snapshot(),last=p;
  // Largest valid fixture in this deterministic family, not a universal optimum.
  for(let i=0;i<512;i++){
    const candidate=structuredClone(p);addIdentity(candidate,'p'+String(i).padStart(3,'0')+'x'.repeat(508));
    try{wire(candidate);}catch{break;}last=candidate;p=candidate;
  }return last;
}

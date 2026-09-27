import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createLedgerFixture,encode,hash,uuid} from './seoul-projection-snapshot-ledger-fixture.mjs';
import {snapshot,emptySnapshot,head,addIdentity,addCredential,subjectKey,issuer} from './seoul-projection-snapshot-validation-fixture.mjs';
import {wire as headWire} from './seoul-projection-head-fixture.mjs';
import {verifySeoulSnapshotReceiptForEvent} from '../../src/release/seoul-projection-snapshot-receipt-codec.ts';
export {encode,hash,uuid,snapshot,emptySnapshot,head,addIdentity,addCredential,subjectKey,issuer};
export const unavailable=e=>e.code==='PP004'&&e.message==='seoul_projection_unavailable';
export const tables={generations:'memory_ops.identity_projection_snapshot_generations',state:'memory_ops.identity_projection_space_state',grants:'memory_identity.identity_projection_grants',heads:'memory_identity.identity_projection_grant_heads',facts:'memory_identity.identity_projection_source_facts',current:'memory_identity.identity_projection_mutable_fact_current',entities:'memory_identity.identity_projection_entities',providers:'memory_identity.identity_projection_provider_entities',legacy:'memory_identity.identity_projection_legacy_grant_entities'};
export const functions=['memory_identity.projection_v3_snapshot_materialize(text,text)','memory_identity.projection_v3_snapshot_classify(uuid)','memory_identity.projection_v3_snapshot_materialization_assert(uuid,bigint)','memory_ops.projection_v3_materialization_insert_fence()','memory_identity.projection_v3_materialization_row()','memory_identity.projection_v3_materialization_pointer()','memory_identity.projection_v3_materialization_receipt()','memory_identity.projection_v3_materialization_complete()','memory_identity.projection_v3_snapshot_plan(uuid)'];
export const allReasons={conflict:['snapshot_sequence_conflict','source_identity_conflict','immutable_entity_conflict','provisioning_conflict','retained_row_disposition_conflict'],snapshot_superseded:['newer_snapshot_present','lease_expired','lease_issued_in_future','authority_expired','terminal_identity_denied','lifecycle_denied','target_deselected','newer_dependency_present'],dependency_pending:['dependency_head_missing','dependency_head_behind','provisioning_missing','retained_row_disposition_missing'],applied:['snapshot_applied','empty_snapshot_applied']};
export const dependencies=p=>[...new Map(p.grants.flatMap(g=>[...g.heads.subjects,...g.heads.emails??[],g.heads.organization,g.heads.membership,g.heads.credential,g.heads.space,g.heads.target].filter(Boolean)).map(h=>[h.revision,h])).values()].sort((a,b)=>a.revision-b.revision);
export async function createMaterializationFixture(t,{install=true}={}){
 const f=await createLedgerFixture(t);let transport=400000;
 const owner=fn=>f.asRole('postgres',async db=>{await db.exec('SET ROLE memory_owner');return fn(db);});
 for(const file of ['provisioning-foundation.sql','snapshot-facts.sql']){
  const sql=await readFile(new URL('../../postgres/projection-v3/'+file,import.meta.url),'utf8');
  await f.asRole('fixture_provisioner',async db=>{if(file==='provisioning-foundation.sql')await db.exec('SET ROLE memory_owner');return db.exec(sql);});
 }
 const installMaterialization=async()=>{
  const sql=await readFile(new URL('../../postgres/projection-v3/snapshot-materialization.sql',import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  assert.notEqual(sql,null,'complete snapshot materialization SQL must exist');return f.asRole('fixture_provisioner',db=>db.exec(sql));
 };
 const candidate=async({organization=false,empty=false,id=800,seq=1,space='space:one',offset=0,grantOffset=120000}={})=>{
  const p=empty?emptySnapshot(organization):snapshot(organization),now=await f.now();p.eventId=uuid(id);p.snapshotSeq=seq;p.spaceId=space;p.spaces[0].id=space;p.lease={issuedAtMs:now+offset,expiresAtMs:now+offset+60000};
  for(const c of p.credentials)c.expiresAtMs=now+grantOffset;
  for(const m of p.memberships)m.expiresAtMs=now+grantOffset;
  for(const g of p.grants){g.spaceId=space;g.expiresAtMs=now+grantOffset;g.heads.space.key=space;g.heads.target.key=space;}
  return p;
 };
 const applyHead=async(h,effect={type:'entity-head',disposition:'present'})=>f.apply(headWire({version:3,kind:'seoul-authority-head',eventId:uuid(transport++),sourceRevision:h.revision,issuer,head:h,effect}));
 const receive=async(p,{omit=[],effects={}}={})=>{for(const h of dependencies(p))if(!omit.includes(h.kind))await applyHead(h,effects[h.kind]??{type:'entity-head',disposition:'present'});};
 const provision=async(p,{id=9000,sourceByteLimit=1048576,messageLimit=1000}={})=>owner(db=>db.query(`INSERT INTO memory_ops.identity_projection_space_provisioning(space_id,approval_id,approval_reference,deployment_singleton,deployment_id,storage_region,processing_policy_id,deployment_created_at_ms,data_policy,source_byte_limit,message_limit) SELECT $1,$2,'fixture:approved',singleton,deployment_id,storage_region,processing_policy_id,created_at_ms,$3,$4,$5 FROM memory_control.deployment_identity WHERE singleton=1 RETURNING approval_id`,[p.spaceId,uuid(id),p.spaces[0].policy,sourceByteLimit,messageLimit]));
 const ready=async(p,options)=>{await receive(p);if(p.grants.length)await provision(p,options);};
 const retain=async(p,{reauthenticatedAt=123,canErase=true,canRetire=true,usage=[3000000,2000,1000000,1000]}={})=>owner(async db=>{
  for(const a of p.accounts)await db.query('INSERT INTO memory_identity.accounts(id,disabled_at) VALUES($1,NULL)',[a.id]);
  for(const o of p.organizations)await db.query('INSERT INTO memory_control.organizations(id,disabled_at) VALUES($1,NULL)',[o.id]);
  for(const v of p.providerIdentities)await db.query('INSERT INTO memory_identity.provider_identities(issuer,subject,account_id,created_at) VALUES($1,$2,$3,$4)',[v.issuer,v.subject,v.accountId,v.createdAtMs]);
  for(const v of p.emails)await db.query('INSERT INTO memory_identity.account_emails(id,account_id,address,domain,verified_at,revoked_at) VALUES($1,$2,$3,$4,$5,NULL)',[v.id,v.accountId,v.address,v.address.split('@')[1],v.verifiedAtMs]);
  for(const v of p.memberships)await db.query('INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,NULL)',[v.id,v.organizationId,v.accountId,v.emailId,v.role,v.expiresAtMs]);
  for(const v of p.credentials)await db.query('INSERT INTO memory_identity.credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,reauthenticated_at,revoked_at,permission) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)',[v.id,v.accountId,v.membershipId,v.emailId,v.kind,v.tokenDigest,v.expiresAtMs,reauthenticatedAt,v.permission]);
  for(const v of p.spaces)await db.query('INSERT INTO memory_control.spaces(id,owner_account_id,organization_id,deployment_id,data_policy,disabled_at,source_byte_limit,message_limit) SELECT $1,$2,$3,deployment_id,$4,NULL,1048576,1000 FROM memory_control.deployment_identity WHERE singleton=1',[v.id,v.accountId,v.organizationId,v.policy]);
  for(const v of p.grants)await db.query('INSERT INTO memory_identity.pat_space_grants(credential_id,account_id,space_id,can_ingest,can_search,expires_at,revoked_at,can_erase,can_retire) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8)',[v.credentialId,v.accountId,v.spaceId,v.canIngest,v.canSearch,v.expiresAtMs,canErase,canRetire]);
  for(const v of p.spaces)await db.query('INSERT INTO memory_ops.space_usage(space_id,source_bytes,message_count,retained_source_bytes,retained_message_count) VALUES($1,$2,$3,$4,$5)',[v.id,...usage]);
 });
 const approveRetained=async(p,{change=()=>{}}={})=>{
  const locators=[...p.accounts.map(v=>['account','memory_identity.accounts','id',v.id]),...p.organizations.map(v=>['organization','memory_control.organizations','id',v.id]),
   ...p.providerIdentities.map(v=>['provider_identity','memory_identity.provider_identities','subject',v.subject]),...p.emails.map(v=>['email','memory_identity.account_emails','id',v.id]),
   ...p.memberships.map(v=>['membership','memory_identity.memberships','id',v.id]),...p.credentials.map(v=>['credential','memory_identity.credentials','id',v.id]),
   ...p.spaces.map(v=>['space','memory_control.spaces','id',v.id]),...p.grants.map(v=>['legacy_grant','memory_identity.pat_space_grants','credential_id',v.credentialId])];
  let approval=10000;
  for(const[kind,table,col,id]of locators){
   const basis=(await f.db.query(`SELECT to_jsonb(x) AS value FROM ${table} x WHERE ${col}=$1`,[id])).rows[0].value,target=structuredClone(basis);change(kind,target);
   await owner(db=>db.query(`INSERT INTO memory_identity.identity_projection_retained_dispositions(approval_id,approval_reference,deployment_singleton,deployment_id,storage_region,processing_policy_id,deployment_created_at_ms,entity_kind,entity_id,issuer,subject,credential_id,space_id,disposition,retained_basis,authorized_binding) SELECT $1,'fixture:retained',singleton,deployment_id,storage_region,processing_policy_id,created_at_ms,$2,$3,$4,$5,$6,$7,'adopt_exact_binding',$8,$9 FROM memory_control.deployment_identity WHERE singleton=1`,[uuid(approval++),kind,['provider_identity','legacy_grant'].includes(kind)?null:id,kind==='provider_identity'?basis.issuer:null,kind==='provider_identity'?basis.subject:null,kind==='legacy_grant'?basis.credential_id:null,kind==='legacy_grant'?basis.space_id:null,basis,target]));
  }
 };
 const materialize=async p=>{
  const raw=typeof p==='string'?p:encode(p),receipt=await f.owner(async db=>(await db.query('SELECT memory_identity.projection_v3_snapshot_materialize($1,$2) AS receipt',[raw,hash(raw)])).rows[0].receipt);
  await verifySeoulSnapshotReceiptForEvent(new TextEncoder().encode(receipt),new TextEncoder().encode(raw));return JSON.parse(receipt);
 };
 const state=async()=>Object.fromEntries(await Promise.all(Object.entries(tables).map(async([k,table])=>[k,(await f.db.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]') AS rows FROM ${table} x`)).rows[0].rows])));
 const dump=async()=>({ledger:await f.ledger(),positive:await f.positive(),materialization:await state()});
 if(install)await installMaterialization();return {...f,migrationOwner:owner,installMaterialization,candidate,applyHead,receive,provision,ready,retain,approveRetained,materialize,materializationState:state,dump};
}

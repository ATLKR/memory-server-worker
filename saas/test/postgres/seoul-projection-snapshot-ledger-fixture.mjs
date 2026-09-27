import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createSnapshotFixture,snapshot,emptySnapshot} from './seoul-projection-snapshot-validation-fixture.mjs';
import {hash,uuid} from './seoul-projection-head-fixture.mjs';
import {encodeSeoulAuthoritySnapshot} from '../../src/release/seoul-projection-snapshot-codec.ts';
import {verifySeoulSnapshotReceiptForEvent} from '../../src/release/seoul-projection-snapshot-receipt-codec.ts';

export {hash,uuid};
export const encode=value=>new TextDecoder().decode(encodeSeoulAuthoritySnapshot(value));
export const beginSQL='SELECT * FROM memory_ops.projection_v3_snapshot_ledger_begin($1::text,$2::text)';
export const appendSQL='SELECT memory_ops.projection_v3_snapshot_ledger_append($1::uuid,$2::text,$3::bigint,$4::text,$5::text) AS receipt';
export const reservation='memory_ops.identity_projection_snapshot_reservations';
export async function createLedgerFixture(t,{install=true}={}) {
  const f=await createSnapshotFixture(t);
  // Explicit test installer authority, established before preservation snapshots.
  await f.db.exec('GRANT memory_owner,memory_projection_owner TO fixture_provisioner WITH INHERIT FALSE,SET TRUE,ADMIN FALSE');
  const owner=fn=>f.asRole('postgres',async db=>{await db.exec('SET ROLE memory_projection_owner');return fn(db);});
  const installLedger=async()=>{
    const sql=await readFile(new URL('../../postgres/projection-v3/snapshot-ledger.sql',import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    assert.notEqual(sql,null,'inactive snapshot ledger SQL must exist');
    return f.asRole('fixture_provisioner',db=>db.exec(sql));
  };
  const now=async()=>Number((await f.db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS t')).rows[0].t);
  const candidate=async({empty=false,id=800,seq=1,offset=0,grantOffset=120000}={})=>{
    const p=empty?emptySnapshot():snapshot();p.eventId=uuid(id);p.snapshotSeq=seq;
    const at=await now();p.lease={issuedAtMs:at+offset,expiresAtMs:at+offset+60000};
    for(const c of p.credentials)c.expiresAtMs=at+Math.max(grantOffset,offset+1);
    for(const g of p.grants)g.expiresAtMs=at+Math.max(grantOffset,offset+1);
    return p;
  };
  const begin=(db,raw,digest=hash(raw))=>db.query(beginSQL,[raw,digest]).then(x=>x.rows[0]);
  const append=(db,id,digest,attempt,outcome,reason)=>db.query(appendSQL,[id,digest,attempt,outcome,reason]).then(x=>x.rows[0].receipt);
  const decide=async(value,outcome='dependency_pending',reason='dependency_head_missing')=>{
    const raw=typeof value==='string'?value:encode(value),digest=hash(raw);
    return owner(async db=>{await db.exec('BEGIN');const b=await begin(db,raw,digest);
      const receipt=b.replay_receipt_text??await append(db,b.transport_event_id,digest,b.next_attempt_no,outcome,reason);
      await db.exec('COMMIT');await verifySeoulSnapshotReceiptForEvent(new TextEncoder().encode(receipt),new TextEncoder().encode(raw));return receipt;});
  };
  const ledger=async()=>(await f.db.query(`SELECT jsonb_build_object(
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY transport_event_id),'[]') FROM memory_ops.identity_projection_events x),
    'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY transport_event_id,attempt_no),'[]') FROM memory_ops.identity_projection_receipts x),
    'reservations',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY space_id,snapshot_seq),'[]') FROM ${reservation} x)) AS value`)).rows[0].value;
  const positive=async()=>(await f.db.query(`SELECT jsonb_build_object(
    'accounts',(SELECT jsonb_agg(x) FROM memory_identity.accounts x),'providers',(SELECT jsonb_agg(x) FROM memory_identity.provider_identities x),
    'emails',(SELECT jsonb_agg(x) FROM memory_identity.account_emails x),'orgs',(SELECT jsonb_agg(x) FROM memory_control.organizations x),
    'memberships',(SELECT jsonb_agg(x) FROM memory_identity.memberships x),'credentials',(SELECT jsonb_agg(x) FROM memory_identity.credentials x),
    'spaces',(SELECT jsonb_agg(x) FROM memory_control.spaces x),'grants',(SELECT jsonb_agg(x) FROM memory_identity.pat_space_grants x),
    'usage',(SELECT jsonb_agg(x) FROM memory_ops.space_usage x)) AS value`)).rows[0].value;
  if(install)await installLedger();
  return {...f,owner,installLedger,now,candidate,begin,append,decide,ledger,positive};
}

export async function retainedSurface(db) {
  const relationIds=(await db.query("SELECT c.oid::int AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_%' AND c.relkind='r' ORDER BY c.oid")).rows.map(x=>x.oid);
  const procIds=(await db.query("SELECT p.oid::int AS oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'memory_%' AND p.oid NOT IN('memory_identity.seoul_projection_apply(text,text)'::regprocedure,'memory_ops.seoul_projection_status(text,text)'::regprocedure) ORDER BY p.oid")).rows.map(x=>x.oid);
  const triggerIds=(await db.query('SELECT oid::int AS oid FROM pg_trigger WHERE tgrelid=ANY($1::oid[]) ORDER BY oid',[relationIds])).rows.map(x=>x.oid);
  const observe=async()=>({
    relations:(await db.query('SELECT oid,relowner,relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=ANY($1::oid[]) ORDER BY oid',[relationIds])).rows,
    functions:(await db.query('SELECT oid,prosrc,proacl::text,proowner,proconfig,prosecdef FROM pg_proc WHERE oid=ANY($1::oid[]) ORDER BY oid',[procIds])).rows,
    triggers:(await db.query('SELECT oid,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE oid=ANY($1::oid[]) ORDER BY oid',[triggerIds])).rows,
    defaults:(await db.query('SELECT to_jsonb(x) AS value FROM pg_default_acl x ORDER BY oid')).rows,
    edges:(await db.query('SELECT to_jsonb(x) AS value FROM pg_auth_members x ORDER BY oid')).rows,
    schemas:(await db.query("SELECT oid,nspacl::text FROM pg_namespace WHERE nspname LIKE 'memory_%' ORDER BY oid")).rows,
    policies:(await db.query('SELECT to_jsonb(x) AS value FROM pg_policy x WHERE polrelid=ANY($1::oid[]) ORDER BY oid',[relationIds])).rows
  });return {observe,relationIds,triggerIds};
}

export async function assertLedgerAddedTriggers(db,{relationIds,triggerIds}) {
  const rows=(await db.query(`SELECT t.oid::int,t.tgrelid::regclass::text AS relation,t.tgname,t.tgconstraint::int AS constraint_id,t.tgisinternal,t.tgenabled,
    t.tgdeferrable,t.tginitdeferred,p.proname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=ANY($1::oid[]) AND NOT(t.oid=ANY($2::oid[])) ORDER BY t.tgrelid,t.tgname`,[relationIds,triggerIds])).rows;
  const fk=(await db.query(`SELECT oid::int,conrelid::regclass::text AS child,confrelid::regclass::text AS parent,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conname='projection_reservations_event_fk' AND conrelid=$1::regclass`,[reservation])).rows[0];
  assert.deepEqual({...fk,oid:0},{oid:0,child:reservation,parent:'memory_ops.identity_projection_events',definition:'FOREIGN KEY (transport_event_id, space_id, snapshot_seq) REFERENCES memory_ops.identity_projection_events(transport_event_id, space_id, snapshot_seq)'});
  const allowed={identity_projection_events:{ledger_insert_fence:'projection_v3_ledger_insert_fence',ledger_event_insert:'projection_v3_ledger_event_insert',ledger_no_mutation:'reject_mutation',ledger_complete:'projection_v3_ledger_complete'},
    identity_projection_receipts:{ledger_insert_fence:'projection_v3_ledger_insert_fence',ledger_receipt_insert:'projection_v3_ledger_receipt_insert',ledger_no_mutation:'reject_mutation',ledger_complete:'projection_v3_ledger_complete'},
    identity_projection_source_heads:{ledger_insert_fence:'projection_v3_ledger_insert_fence',ledger_source_insert:'projection_v3_ledger_source_insert'}};
  assert.equal(rows.length,12);let fkCount=0;
  for(const row of rows){assert.equal(row.tgenabled,'O');if(row.tgisinternal){assert.equal(row.constraint_id,fk.oid);assert.equal(row.relation,fk.parent);assert.ok(['RI_FKey_noaction_del','RI_FKey_noaction_upd'].includes(row.proname));fkCount++;}
    else{assert.equal(allowed[row.relation.split('.')[1]]?.[row.tgname],row.proname);assert.equal(row.tgdeferrable,row.tgname==='ledger_complete');assert.equal(row.tginitdeferred,row.tgname==='ledger_complete');}}
  assert.equal(fkCount,2);
}

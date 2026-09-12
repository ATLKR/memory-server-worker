import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleFixture,ERASE_OPERATION,RETIRE_OPERATION,REVOKE_OPERATION } from './seoul-lifecycle-fixture.mjs';
import { SEOUL_DIGEST,OTHER_DIGEST,ORG_DIGEST,seoulIngest,seoulSearch } from './seoul-fixture.mjs';

const erase=(archiveId,overrides={})=>({spaceId:'space:a',archiveId,expectedRevision:1,operationId:ERASE_OPERATION,...overrides});
const status=archiveId=>({kind:'archive',spaceId:'space:a',archiveId});
const rows=async(f,sql,values=[])=>(await f.db.query(sql,values)).rows;

test('migration adds explicit lifecycle authority without promoting existing ingest grants',async t=>{
  const f=await createLifecycleFixture(t);
  assert.equal((await rows(f,"SELECT max(version) AS version FROM memory_control.schema_migrations"))[0].version,5);
  assert.deepEqual(await rows(f,'SELECT can_erase,can_retire FROM memory_identity.pat_space_grants'),Array(3).fill({can_erase:false,can_retire:false}));
  const archived=await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest());
  await assert.rejects(f.call('seoul_archive_erase',SEOUL_DIGEST,erase(archived.result.archiveId)),{code:'PA003'});
});

test('erase deletes source rows, scrubs archive and meter metadata, retains cumulative quantity once',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  const input=seoulIngest(),stored=await f.call('seoul_archive_ingest',SEOUL_DIGEST,input),id=stored.result.archiveId;
  await f.asOwner(()=>f.db.query('UPDATE memory_content.archives SET hidden_at=1 WHERE id=$1',[id]));
  assert.deepEqual((await f.call('seoul_lifecycle_status',SEOUL_DIGEST,status(id))).result,{kind:'archive',spaceId:'space:a',archiveId:id,revision:1,state:'stored'});
  const result=await f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id));
  assert.deepEqual(result.result,{spaceId:'space:a',archiveId:id,operationId:ERASE_OPERATION,revision:2,state:'primary_erased',replayed:false,
    primaryRowsRemoved:true,removedMessages:2,removedSourceBytes:stored.result.sourceBytes,restoreAllowed:false,backupCleanup:'not_confirmed',physicalMediaCleanup:'not_confirmed'});
  assert.ok(result.admission.expiresAtMs>result.admission.issuedAtMs);
  assert.deepEqual(await rows(f,'SELECT operation_id,request_digest,session_id,routing,created_at_ms,authority_expires_at_ms,hidden_at FROM memory_content.archives WHERE id=$1',[id]),
    [{operation_id:null,request_digest:null,session_id:null,routing:null,created_at_ms:null,authority_expires_at_ms:null,hidden_at:null}]);
  assert.deepEqual(await rows(f,'SELECT operation_id,created_at_ms FROM memory_ops.meter_events'),[{operation_id:null,created_at_ms:null}]);
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_content.archive_messages'))[0].n,0);
  const usage=await rows(f,"SELECT source_bytes::int,message_count,retained_source_bytes::int,retained_message_count FROM memory_ops.space_usage WHERE space_id='space:a'");
  assert.deepEqual(usage,[{source_bytes:stored.result.sourceBytes,message_count:2,retained_source_bytes:0,retained_message_count:0}]);
  assert.equal((await f.call('seoul_keyword_search',SEOUL_DIGEST,seoulSearch())).result.count,0);
  assert.deepEqual((await f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id))).result,{...result.result,replayed:true});
  assert.deepEqual(await rows(f,"SELECT source_bytes::int,message_count,retained_source_bytes::int,retained_message_count FROM memory_ops.space_usage WHERE space_id='space:a'"),usage);
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_ops.lifecycle_receipts'))[0].n,1);
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,input),{code:'PA008'});
});

test('retire refuses remaining source and self revoke has no caller-selected credential target',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  const stored=await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest());
  const retire={spaceId:'space:a',operationId:RETIRE_OPERATION};
  await assert.rejects(f.call('seoul_space_retire',SEOUL_DIGEST,retire),{code:'PA005'});
  await f.call('seoul_archive_erase',SEOUL_DIGEST,erase(stored.result.archiveId));
  assert.deepEqual((await f.call('seoul_space_retire',SEOUL_DIGEST,retire)).result,{spaceId:'space:a',operationId:RETIRE_OPERATION,state:'retired',replayed:false});
  await assert.rejects(f.call('seoul_lifecycle_status',SEOUL_DIGEST,status(stored.result.archiveId)),{code:'PA003'});
  await assert.rejects(f.call('seoul_pat_revoke_self',SEOUL_DIGEST,{operationId:REVOKE_OPERATION,credentialId:'pat:b'}),{code:'PA001'});
  assert.deepEqual((await f.call('seoul_pat_revoke_self',SEOUL_DIGEST,{operationId:REVOKE_OPERATION})).result,{operationId:REVOKE_OPERATION,state:'revoked',replayed:false});
  await assert.rejects(f.call('seoul_pat_check',SEOUL_DIGEST),{code:'PA002'});
  assert.deepEqual((await f.call('seoul_pat_check',OTHER_DIGEST)).result,{authenticated:true});
});

test('archive identifier grammar preserves existing UUID-shaped ids and input validation is exact',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  const id='arc:00000000-0000-0000-0000-000000000001';
  await assert.rejects(f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id)),{code:'PA003'});
  for(const input of [null,[],{},erase(id,{expectedRevision:null}),erase(id,{expectedRevision:1.5}),erase(id,{expectedRevision:3}),
    erase(id,{operationId:'user-sensitive-text'}),erase(id,{operationId:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}),
    erase(id,{confirmation:id}),erase(id,{archiveId:null}),erase(id,{spaceId:null})]) {
    await assert.rejects(f.call('seoul_archive_erase',SEOUL_DIGEST,input),{code:'PA001'});
  }
  for(const input of [null,{kind:'archive',spaceId:'space:a'},{...status(id),unexpected:true},{kind:'retire',spaceId:'space:a',operationId:RETIRE_OPERATION}]) {
    await assert.rejects(f.call('seoul_lifecycle_status',SEOUL_DIGEST,input),{code:'PA001'});
  }
});

test('erased operation preserves original actor binding and new terminal operations do not decrement twice',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();const input=seoulIngest();
  const id=(await f.call('seoul_archive_ingest',SEOUL_DIGEST,input)).result.archiveId;
  await f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id));
  await f.asOwner(()=>f.db.exec(`INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at)
    VALUES('pat:second','account:a','personal_key',repeat('d',64),9007199254740991);
    INSERT INTO memory_identity.pat_space_grants(credential_id,account_id,space_id,can_ingest,can_search,can_erase,can_retire,expires_at)
    VALUES('pat:second','account:a','space:a',true,true,true,true,9007199254740991)`));
  await assert.rejects(f.call('seoul_archive_ingest','d'.repeat(64),input),{code:'PA005'});
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({messages:[{role:'user',content:'changed'}]})),{code:'PA008'});
  await assert.rejects(f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id,{operationId:RETIRE_OPERATION})),{code:'PA009'});
  const terminal=(await f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id,{expectedRevision:2,operationId:RETIRE_OPERATION}))).result;
  assert.equal(terminal.removedMessages,0);assert.equal(terminal.removedSourceBytes,0);
  assert.deepEqual((await f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id,{expectedRevision:2,operationId:RETIRE_OPERATION}))).result,{...terminal,replayed:true});
  await assert.rejects(f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id,{expectedRevision:2})),{code:'PA005'});
  const operation={kind:'operation',spaceId:'space:a',operationId:ERASE_OPERATION};
  assert.equal((await f.call('seoul_lifecycle_status',SEOUL_DIGEST,operation)).result.receipt.archiveId,id);
  assert.equal((await f.call('seoul_lifecycle_status','d'.repeat(64),operation)).result.receipt,null);
  await assert.rejects(f.call('seoul_lifecycle_status',OTHER_DIGEST,operation),{code:'PA003'});
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.pat_space_grants SET revoked_at=1 WHERE credential_id='pat:a'"));
  await assert.rejects(f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id)),{code:'PA003'});
  assert.deepEqual(await rows(f,"SELECT retained_source_bytes::int,retained_message_count FROM memory_ops.space_usage WHERE space_id='space:a'"),
    [{retained_source_bytes:0,retained_message_count:0}]);
});

test('cleanup-only capabilities require exact personal or owner/admin organization authority',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  const id=(await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest())).result.archiveId;
  const org=(await f.call('seoul_archive_ingest',ORG_DIGEST,seoulIngest({spaceId:'space:org'}))).result.archiveId;
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.pat_space_grants SET can_search=false,can_ingest=false"));
  assert.equal((await f.call('seoul_lifecycle_status',SEOUL_DIGEST,status(id))).result.revision,1);
  await assert.rejects(f.call('seoul_keyword_search',SEOUL_DIGEST,seoulSearch()),{code:'PA003'});
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.credentials SET permission='read' WHERE id='pat:a'"));
  await assert.rejects(f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id)),{code:'PA003'});
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.credentials SET permission='write' WHERE id='pat:a'; UPDATE memory_identity.memberships SET role='member' WHERE id='member:a'"));
  await assert.rejects(f.call('seoul_archive_erase',ORG_DIGEST,erase(org,{spaceId:'space:org'})),{code:'PA003'});
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.memberships SET role='admin' WHERE id='member:a'"));
  assert.equal((await f.call('seoul_archive_erase',ORG_DIGEST,erase(org,{spaceId:'space:org'}))).result.state,'primary_erased');
  assert.equal((await f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id))).result.state,'primary_erased');
});

test('runtime has execute-only boundaries and active erasure cannot use owner marker updates or direct delete',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest());
  await f.asRuntime(async()=>{
    for(const sql of ["SELECT * FROM memory_content.archives","DELETE FROM memory_content.archive_messages",
      "UPDATE memory_identity.credentials SET revoked_at=1","SELECT memory_identity.seoul_action_authority(repeat('a',64),'space:a','erase')",
      "SET ROLE memory_lifecycle"])await assert.rejects(f.db.exec(sql),{code:'42501'});
  });
  await f.asOwner(async()=>{
    await assert.rejects(f.db.exec('UPDATE memory_content.archives SET erased_at=1'),{code:'PA005'});
    await assert.rejects(f.db.exec('DELETE FROM memory_content.archive_messages'),{code:'PA005'});
    await assert.rejects(f.db.exec('UPDATE memory_ops.meter_events SET operation_id=NULL,created_at_ms=NULL'),{code:'PA005'});
    await assert.rejects(f.db.exec('TRUNCATE memory_content.archive_messages CASCADE'),{code:'55000'});
  });
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_content.archive_messages'))[0].n,2);
});

test('failure after source deletion rolls back receipt, archive, meters and retained counters',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  const id=(await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest())).result.archiveId;
  await f.asOwner(()=>f.db.exec(`CREATE FUNCTION memory_ops.fixture_fail_scrub() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE='PA006',MESSAGE='synthetic_failure'; END $$;
    CREATE TRIGGER zz_fixture_fail_scrub BEFORE UPDATE ON memory_ops.meter_events FOR EACH ROW EXECUTE FUNCTION memory_ops.fixture_fail_scrub()`));
  await assert.rejects(f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id)),{code:'PA006'});
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_content.archive_messages'))[0].n,2);
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_ops.lifecycle_receipts'))[0].n,0);
  assert.equal((await rows(f,'SELECT lifecycle_revision FROM memory_content.archives'))[0].lifecycle_revision,1);
  assert.equal((await rows(f,"SELECT retained_message_count FROM memory_ops.space_usage WHERE space_id='space:a'"))[0].retained_message_count,2);
  assert.equal((await rows(f,'SELECT operation_id FROM memory_ops.meter_events'))[0].operation_id,'operation:one');
});

test('deferred COMMIT rejects expired erase and retire/self-revoke authorities without partial changes',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  const id=(await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest())).result.archiveId;
  for(const [entry,input,table,condition] of [
    ['memory_content.seoul_archive_erase',erase(id),'memory_identity.pat_space_grants',"credential_id='pat:a'"],
    ['memory_control.seoul_space_retire',{spaceId:'space:b',operationId:RETIRE_OPERATION},'memory_identity.credentials',"id='pat:b'"],
    ['memory_identity.seoul_pat_revoke_self',{operationId:REVOKE_OPERATION},'memory_identity.credentials',"id='pat:a'"],
  ]) {
    const digest=input.spaceId==='space:b'?OTHER_DIGEST:SEOUL_DIGEST;
    await f.asOwner(()=>f.db.exec(`UPDATE ${table} SET expires_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+1000 WHERE ${condition}`));
    await f.asRuntime(async()=>{
      await f.db.exec('BEGIN');
      await f.db.query(`SELECT ${entry}($1,$2::jsonb)`,[digest,input]);
      await f.db.exec('SELECT pg_sleep(1.05)');
      await assert.rejects(f.db.exec('COMMIT'),{code:'PA007'});
    });
    await f.asOwner(()=>f.db.exec(`UPDATE ${table} SET expires_at=9007199254740991 WHERE ${condition}`));
  }
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_ops.lifecycle_receipts'))[0].n,0);
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_content.archive_messages'))[0].n,2);
  assert.deepEqual(await rows(f,"SELECT disabled_at FROM memory_control.spaces WHERE id='space:b'"),[{disabled_at:null}]);
  assert.deepEqual(await rows(f,"SELECT revoked_at FROM memory_identity.credentials WHERE id='pat:a'"),[{revoked_at:null}]);
});

test('migration backfills physically retained hidden source and refuses old marker-only erased rows',async t=>{
  const f=await createLifecycleFixture(t,{install:false});
  const stored=await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest());
  await f.asOwner(()=>f.db.exec('UPDATE memory_content.archives SET hidden_at=1'));
  assert.equal(await f.install(),true);
  assert.deepEqual(await rows(f,"SELECT retained_source_bytes::int,retained_message_count FROM memory_ops.space_usage WHERE space_id='space:a'"),
    [{retained_source_bytes:stored.result.sourceBytes,retained_message_count:2}]);
  const old=await createLifecycleFixture(t,{install:false});
  await old.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest());
  await old.asOwner(()=>old.db.exec('UPDATE memory_content.archives SET erased_at=1'));
  await assert.rejects(old.install(),{code:'PA005'});
  assert.equal((await rows(old,"SELECT max(version) AS version FROM memory_control.schema_migrations"))[0].version,4);
  assert.equal((await rows(old,"SELECT count(*)::int AS n FROM pg_roles WHERE rolname='memory_lifecycle'"))[0].n,0);
  assert.equal((await rows(old,'SELECT count(*)::int AS n FROM memory_content.archive_messages'))[0].n,2);
});

test('receipt insertion collision is a stable operation conflict and leaves every primary row intact',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  const id=(await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest())).result.archiveId;
  // Single-engine fault injection at the receipt insertion boundary. This is a
  // real PK collision, not evidence of independent TCP transaction scheduling.
  await f.asOwner(()=>f.db.exec(`CREATE FUNCTION memory_ops.fixture_receipt_collision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN IF pg_trigger_depth()=1 THEN INSERT INTO memory_ops.lifecycle_receipts SELECT NEW.*; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fixture_receipt_collision BEFORE INSERT ON memory_ops.lifecycle_receipts FOR EACH ROW EXECUTE FUNCTION memory_ops.fixture_receipt_collision()`));
  await assert.rejects(f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id)),{code:'PA005'});
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_ops.lifecycle_receipts'))[0].n,0);
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_content.archive_messages'))[0].n,2);
});

test('fresh authority rejects expired grants, revoked proof and foreign organization despite explicit erase flag',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  const id=(await f.call('seoul_archive_ingest',ORG_DIGEST,seoulIngest({spaceId:'space:org'}))).result.archiveId;
  const input=erase(id,{spaceId:'space:org'});
  await f.asOwner(()=>f.db.exec(`INSERT INTO memory_identity.pat_space_grants(credential_id,account_id,space_id,can_ingest,can_search,can_erase,can_retire,expires_at)
    VALUES('pat:org','account:a','space:foreign',false,false,true,true,9007199254740991)`));
  await assert.rejects(f.call('seoul_archive_erase',ORG_DIGEST,erase(id,{spaceId:'space:foreign'})),{code:'PA003'});
  await assert.rejects(f.call('seoul_space_retire',ORG_DIGEST,{spaceId:'space:foreign',operationId:RETIRE_OPERATION}),{code:'PA003'});
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.pat_space_grants SET expires_at=1 WHERE credential_id='pat:org' AND space_id='space:org'"));
  await assert.rejects(f.call('seoul_archive_erase',ORG_DIGEST,input),{code:'PA007'});
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.pat_space_grants SET expires_at=9007199254740991 WHERE credential_id='pat:org'; UPDATE memory_identity.account_emails SET revoked_at=1 WHERE id='email:a'"));
  await assert.rejects(f.call('seoul_archive_erase',ORG_DIGEST,input),{code:'PA002'});
  assert.equal((await rows(f,'SELECT count(*)::int AS n FROM memory_content.archive_messages'))[0].n,2);
});

test('erase never refunds cumulative quota, and terminal status cannot expose another action',async t=>{
  const f=await createLifecycleFixture(t);await f.grant();
  await f.asOwner(()=>f.db.exec("UPDATE memory_control.spaces SET source_byte_limit=0,message_limit=1 WHERE id='space:a'"));
  const input=seoulIngest({messages:[{role:'user',content:''}]}),id=(await f.call('seoul_archive_ingest',SEOUL_DIGEST,input)).result.archiveId;
  const result=(await f.call('seoul_archive_erase',SEOUL_DIGEST,erase(id))).result;
  assert.equal(result.removedSourceBytes,0);assert.equal(result.removedMessages,1);
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,{...input,operationId:'another'}),{code:'PA006'});
  assert.deepEqual(await rows(f,'SELECT source_bytes::int,message_count FROM memory_ops.meter_events'),[{source_bytes:0,message_count:1}]);
  const resultBytes=JSON.stringify(await rows(f,'SELECT to_jsonb(r) AS receipt FROM memory_ops.lifecycle_receipts r'));
  for(const field of ['session_id','routing','content_digest','read_drain_after_ms','inFlightReads'])assert.equal(resultBytes.includes(field),false);
  await f.call('seoul_space_retire',OTHER_DIGEST,{spaceId:'space:b',operationId:RETIRE_OPERATION});
  assert.equal((await f.call('seoul_lifecycle_status',SEOUL_DIGEST,{kind:'operation',spaceId:'space:a',operationId:RETIRE_OPERATION})).result.receipt,null);
  await assert.rejects(f.call('seoul_space_retire',OTHER_DIGEST,{spaceId:'space:b',operationId:RETIRE_OPERATION}),{code:'PA003'});
});

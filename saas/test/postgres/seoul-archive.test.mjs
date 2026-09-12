import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSeoulFixture,SEOUL_DIGEST,OTHER_DIGEST,ORG_DIGEST,SEOUL_POLICY,seoulIngest,seoulSearch } from './seoul-fixture.mjs';

test('runtime PAT commands archive original bytes once and return stable literal source matches',async t=>{
  const f=await createSeoulFixture(t);
  const checked=await f.call('seoul_pat_check',SEOUL_DIGEST);assert.deepEqual(checked.result,{authenticated:true});
  const input=seoulIngest();const stored=await f.call('seoul_archive_ingest',SEOUL_DIGEST,input);
  assert.equal(stored.result.state,'stored');assert.equal(stored.result.extraction,'none');assert.equal(stored.result.messageCount,2);
  assert.equal(stored.result.sourceBytes,Buffer.byteLength(input.messages[0].content));assert.equal(stored.result.replayed,false);
  assert.ok(stored.admission.expiresAtMs>stored.admission.issuedAtMs);assert.ok(stored.admission.expiresAtMs-stored.admission.issuedAtMs<=30000);
  const replay=await f.call('seoul_archive_ingest',SEOUL_DIGEST,input);assert.deepEqual(replay.result,{...stored.result,replayed:true});
  const result=await f.call('seoul_keyword_search',SEOUL_DIGEST,seoulSearch());
  assert.equal(result.result.spaceId,'space:a');assert.equal(result.result.mode,'keyword');assert.equal(result.result.count,1);
  assert.equal(result.result.matches[0].revision,1);assert.equal(result.result.matches[0].excerpt,input.messages[0].content);
  const rows=await f.asOwner(()=>f.db.query('SELECT content,original_timestamp FROM memory_content.archive_messages ORDER BY message_index'));
  assert.deepEqual(rows.rows,input.messages.map(m=>({content:m.content,original_timestamp:m.timestamp??null})));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.meter_events')).rows[0].n,1);
});

test('different PAT Space and changed operation body cannot cross or rewrite the archived operation',async t=>{
  const f=await createSeoulFixture(t);await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest());
  await assert.rejects(f.call('seoul_keyword_search',OTHER_DIGEST,seoulSearch()),{message:'seoul_space_denied'});
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({messages:[{role:'user',content:'changed'}]})),{message:'seoul_operation_conflict'});
});

test('literal Korean, NFC and ASCII-folded search treats wildcards and punctuation as data',async t=>{
  const f=await createSeoulFixture(t);await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest());
  for(const query of ['서울','keyword','cafe\u0301','%_\\'])assert.equal((await f.call('seoul_keyword_search',SEOUL_DIGEST,seoulSearch({query}))).result.count,1);
  for(const query of ['서울시','.*','__','%missing'])assert.equal((await f.call('seoul_keyword_search',SEOUL_DIGEST,seoulSearch({query}))).result.count,0);
});

test('source-byte and empty-message quotas roll back every operation component atomically',async t=>{
  const f=await createSeoulFixture(t);
  await f.asOwner(()=>f.db.exec("UPDATE memory_control.spaces SET source_byte_limit=3,message_limit=2 WHERE id='space:a'"));
  await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({messages:[{role:'user',content:'가'},{role:'user',content:''}]}));
  for(const content of ['', 'a'])await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({operationId:'second',messages:[{role:'user',content}]})),{message:'seoul_quota_exceeded'});
  assert.deepEqual((await f.db.query('SELECT source_bytes::int,message_count FROM memory_ops.space_usage WHERE space_id=$1',['space:a'])).rows,[{source_bytes:3,message_count:2}]);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_content.archives')).rows[0].n,1);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.meter_events')).rows[0].n,1);
});

test('each quota dimension independently rejects an otherwise admissible operation',async t=>{
  const f=await createSeoulFixture(t);
  await f.asOwner(()=>f.db.exec("UPDATE memory_control.spaces SET source_byte_limit=3,message_limit=10 WHERE id='space:a'; UPDATE memory_control.spaces SET source_byte_limit=100,message_limit=2 WHERE id='space:b'"));
  await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({messages:[{role:'user',content:'가'}]}));
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({operationId:'bytes-only',messages:[{role:'user',content:'a'}]})),{code:'PA006'});
  await f.call('seoul_archive_ingest',OTHER_DIGEST,seoulIngest({spaceId:'space:b',messages:[{role:'user',content:''},{role:'user',content:''}]}));
  await assert.rejects(f.call('seoul_archive_ingest',OTHER_DIGEST,seoulIngest({spaceId:'space:b',operationId:'messages-only',messages:[{role:'user',content:''}]})),{code:'PA006'});
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.meter_events')).rows[0].n,2);
});

test('organization authority has exact membership ownership and capability ceilings; personal PAT ignores email revocation',async t=>{
  const f=await createSeoulFixture(t),orgInput=seoulIngest({spaceId:'space:org'});
  await f.call('seoul_archive_ingest',ORG_DIGEST,orgInput);
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.memberships SET role='member' WHERE id='member:a'"));
  assert.equal((await f.call('seoul_keyword_search',ORG_DIGEST,seoulSearch({spaceId:'space:org'}))).result.count,1);
  await assert.rejects(f.call('seoul_archive_ingest',ORG_DIGEST,orgInput),{code:'PA003'});
  await f.asOwner(()=>f.db.exec("INSERT INTO memory_identity.pat_space_grants VALUES('pat:org','account:a','space:foreign',true,true,9007199254740991,NULL)"));
  await assert.rejects(f.call('seoul_keyword_search',ORG_DIGEST,seoulSearch({spaceId:'space:foreign'})),{code:'PA003'});
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.credentials SET permission='read' WHERE id='pat:a'"));
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest()),{code:'PA003'});
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.account_emails SET revoked_at=1 WHERE id='email:a'"));
  assert.deepEqual((await f.call('seoul_pat_check',SEOUL_DIGEST)).result,{authenticated:true});
  await assert.rejects(f.call('seoul_pat_check',ORG_DIGEST),{code:'PA002'});
});

test('replay needs current grant and original actor, and hidden archives never appear in search',async t=>{
  const f=await createSeoulFixture(t),input=seoulIngest();await f.call('seoul_archive_ingest',SEOUL_DIGEST,input);
  await f.asOwner(()=>f.db.exec("INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at) VALUES('pat:second','account:a','personal_key',repeat('d',64),9007199254740991); INSERT INTO memory_identity.pat_space_grants VALUES('pat:second','account:a','space:a',true,true,9007199254740991,NULL)"));
  await assert.rejects(f.call('seoul_archive_ingest','d'.repeat(64),input),{code:'PA005'});
  await f.asOwner(()=>f.db.exec('UPDATE memory_content.archives SET hidden_at=1'));
  assert.equal((await f.call('seoul_keyword_search',SEOUL_DIGEST,seoulSearch())).result.count,0);
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.pat_space_grants SET revoked_at=1 WHERE credential_id='pat:a'"));
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,input),{code:'PA003'});
});

test('direct SQL validates JSON types, message byte budgets and keyword-only inputs',async t=>{
  const f=await createSeoulFixture(t);
  for(const bad of [null,[],{},seoulIngest({spaceId:null}),seoulIngest({messages:null}),seoulIngest({operationId:7}),
    seoulIngest({sessionId:null}),seoulIngest({sessionId:'\u0001'}),seoulIngest({messages:[{role:null,content:'x'}]}),
    seoulIngest({messages:[{role:'user',content:null}]}),seoulIngest({messages:[{role:'user',content:'가'.repeat(10923)}]}),
    seoulIngest({messages:Array.from({length:33},()=>({role:'user',content:'x'.repeat(32768)}))}),
    seoulIngest({messages:Array.from({length:501},()=>({role:'user',content:''}))}),
    seoulIngest({messages:[{role:'user',content:'x',timestamp:'2026-02-30T12:00:00Z'}]}),
    seoulIngest({routing:{version:1,classification:'medical',destination:'agent-memory'}})]) {
    await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,bad),{code:'PA001'});
  }
  for(const bad of [seoulSearch({mode:'semantic'}),seoulSearch({mode:null}),seoulSearch({query:null}),
    seoulSearch({limit:'invalid'}),seoulSearch({limit:1.5}),seoulSearch({limit:51}),seoulSearch({unexpected:true})]) {
    await assert.rejects(f.call('seoul_keyword_search',SEOUL_DIGEST,bad),{code:'PA001'});
  }
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({messages:[{role:'user',content:'\u0000'}]})),{code:'22P05'});
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_content.archives')).rows[0].n,0);
});

test('null or strict-processing Space policies cannot pass three-valued SQL comparisons',async t=>{
  const f=await createSeoulFixture(t);
  for(const [key,value] of [['residency',null],['profile',null],['processingBoundary',null],['classificationStatus',null],['dataClass',null],
    ['processingBoundary','kr-seoul'],['sensitivityTags',['health','health']]]) {
    const id='policy:'+key+':'+(value===null?'null':'other');
    await f.asOwner(async()=>{
      await f.db.query('INSERT INTO memory_control.spaces(id,owner_account_id,deployment_id,data_policy,source_byte_limit,message_limit) VALUES($1,$2,$3,$4,100,10)',[id,'account:a','memory-seoul',{...SEOUL_POLICY,[key]:value}]);
      await f.db.query('INSERT INTO memory_identity.pat_space_grants VALUES($1,$2,$3,true,true,9007199254740991,NULL)',['pat:a','account:a',id]);
    });
    await assert.rejects(f.call('seoul_keyword_search',SEOUL_DIGEST,seoulSearch({spaceId:id})),{code:'PA004'});
  }
});

test('deferred expiry fence runs as its private executor at COMMIT and removes all write residue',async t=>{
  const f=await createSeoulFixture(t);
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.credentials SET expires_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+1000 WHERE id='pat:a'"));
  await f.asRuntime(async()=>{
    await f.db.exec('BEGIN');
    const result=await f.db.query('SELECT memory_content.seoul_archive_ingest($1,$2::jsonb) AS value',[SEOUL_DIGEST,seoulIngest()]);
    assert.equal(result.rows[0].value.result.state,'stored');
    await f.db.exec('SELECT pg_sleep(1.1)');
    await assert.rejects(f.db.exec('COMMIT'),{code:'PA007'});
  });
  for(const table of ['memory_content.archives','memory_content.archive_messages','memory_ops.meter_events']) {
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);
  }
  assert.deepEqual((await f.db.query("SELECT source_bytes::int,message_count FROM memory_ops.space_usage WHERE space_id='space:a'")).rows,[{source_bytes:0,message_count:0}]);
});

test('runtime cannot read tables or call helpers; accidental grants remain denied by forced RLS',async t=>{
  const f=await createSeoulFixture(t);await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest());
  await f.asRuntime(async()=>{
    await assert.rejects(f.db.query('SELECT * FROM memory_content.archive_messages'),{code:'42501'});
    await assert.rejects(f.db.query('SELECT memory_identity.seoul_pat_authority($1,$2,false)',[SEOUL_DIGEST,'space:a']),{code:'42501'});
    await assert.rejects(f.db.query('SELECT memory_content.seoul_archive_commit_fence()'),{code:'42501'});
  });
  await f.asOwner(()=>f.db.exec('GRANT SELECT ON memory_content.archive_messages TO memory_runtime'));
  await f.asRuntime(async()=>assert.deepEqual((await f.db.query('SELECT * FROM memory_content.archive_messages')).rows,[]));
  await f.asOwner(()=>assert.rejects(f.db.exec('UPDATE memory_ops.meter_events SET source_bytes=0'),{code:'55000'}));
});

test('SQL rejects normalized-away timestamp values and a future organization email proof',async t=>{
  const f=await createSeoulFixture(t);
  for(const timestamp of ['2026-09-12T24:00:00Z','2026-09-12T12:00:60Z']) {
    await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({messages:[{role:'user',content:'x',timestamp}]})),{code:'PA001'});
  }
  await f.asOwner(()=>f.db.exec(`INSERT INTO memory_identity.account_emails(id,account_id,address,domain,verified_at)
    VALUES('email:future','account:b','future@example.test','example.test',9007199254740991);
    INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role)
    VALUES('member:future','org:a','account:b','email:future','owner');
    INSERT INTO memory_identity.credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at)
    VALUES('pat:future','account:b','member:future','email:future','api_key',repeat('e',64),9007199254740991)`));
  await assert.rejects(f.call('seoul_pat_check','e'.repeat(64)),{code:'PA002'});
});

test('SQL session ID limit matches UTF-16 units while preserving accepted Unicode',async t=>{
  const f=await createSeoulFixture(t);
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({sessionId:'😀'.repeat(33)})),{code:'PA001'});
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({sessionId:'a'.repeat(63)+'😀'})),{code:'PA001'});
  const sessionId='😀'.repeat(32);
  await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({sessionId}));
  assert.deepEqual((await f.db.query('SELECT session_id FROM memory_content.archives')).rows,[{session_id:sessionId}]);
});

test('expired credential, grant and organization membership plus disabled accounts cannot admit operations',async t=>{
  const f=await createSeoulFixture(t);
  for(const [table,id,column,digest,command,args] of [
    ['memory_identity.credentials','pat:a','id',SEOUL_DIGEST,'seoul_pat_check',undefined],
    ['memory_identity.pat_space_grants','pat:a','credential_id',SEOUL_DIGEST,'seoul_keyword_search',seoulSearch()],
    ['memory_identity.memberships','member:a','id',ORG_DIGEST,'seoul_pat_check',undefined],
  ]) {
    await f.asOwner(()=>f.db.query(`UPDATE ${table} SET expires_at=1 WHERE ${column}=$1`,[id]));
    await assert.rejects(f.call(command,digest,args),{code:'PA007'});
    await f.asOwner(()=>f.db.query(`UPDATE ${table} SET expires_at=9007199254740991 WHERE ${column}=$1`,[id]));
  }
  await f.asOwner(()=>f.db.exec("UPDATE memory_control.organizations SET disabled_at=1 WHERE id='org:a'"));
  await assert.rejects(f.call('seoul_pat_check',ORG_DIGEST),{code:'PA002'});
  await f.asOwner(()=>f.db.exec("UPDATE memory_identity.accounts SET disabled_at=1 WHERE id='account:a'"));
  await assert.rejects(f.call('seoul_pat_check',SEOUL_DIGEST),{code:'PA002'});
  await assert.rejects(f.call('seoul_pat_check','missing'),{code:'PA002'});
});

test('mid-message insertion failure rolls back archive, messages, quota and event together',async t=>{
  const f=await createSeoulFixture(t);
  await f.asOwner(()=>f.db.exec(`CREATE FUNCTION memory_content.fixture_abort_second() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
    BEGIN IF NEW.message_index=1 THEN RAISE EXCEPTION USING ERRCODE='PA009',MESSAGE='synthetic_failure'; END IF;RETURN NEW;END $$;
    CREATE TRIGGER fixture_abort_second BEFORE INSERT ON memory_content.archive_messages FOR EACH ROW EXECUTE FUNCTION memory_content.fixture_abort_second()`));
  await assert.rejects(f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest()),{code:'PA009'});
  for(const table of ['memory_content.archives','memory_content.archive_messages','memory_ops.meter_events'])assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);
  assert.deepEqual((await f.db.query("SELECT source_bytes::int,message_count FROM memory_ops.space_usage WHERE space_id='space:a'")).rows,[{source_bytes:0,message_count:0}]);
});

test('large multilingual source keeps exact hashes while result clipping obeys byte and limit bounds',async t=>{
  const f=await createSeoulFixture(t),content='😀'.repeat(8192),messages=Array.from({length:4},()=>({role:'user',content}));
  await f.call('seoul_archive_ingest',SEOUL_DIGEST,seoulIngest({messages}));
  const result=(await f.call('seoul_keyword_search',SEOUL_DIGEST,seoulSearch({query:'😀',limit:2}))).result;
  assert.equal(result.count,2);assert.ok(result.matches.every(m=>Buffer.byteLength(m.excerpt)<=2048&&content.startsWith(m.excerpt)));
  const second=(await f.call('seoul_keyword_search',SEOUL_DIGEST,seoulSearch({query:'😀',limit:2}))).result;
  assert.deepEqual(second,result);
  const rows=(await f.db.query('SELECT source_bytes,content_digest FROM memory_content.archive_messages')).rows;
  assert.deepEqual(rows,Array.from({length:4},()=>({source_bytes:32768,content_digest:createHash('sha256').update(content).digest('hex')})));
});

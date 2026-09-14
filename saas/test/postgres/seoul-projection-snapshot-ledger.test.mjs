import test from 'node:test';
import assert from 'node:assert/strict';
import {createLedgerFixture,encode,hash,uuid,reservation,beginSQL,appendSQL,retainedSurface,assertLedgerAddedTriggers} from './seoul-projection-snapshot-ledger-fixture.mjs';
import {boundarySnapshot} from './seoul-projection-snapshot-validation-fixture.mjs';
import {event,wire} from './seoul-projection-head-fixture.mjs';
import {verifySeoulHeadReceiptForEvent} from '../../src/release/seoul-projection-head-receipt-codec.ts';

const bad=code=>error=>{assert.equal(error.code,code);assert.equal(error.detail,undefined);assert.equal(error.hint,undefined);return true;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('implicit table row types do not inherit owner default type ACLs',async t=>{
  const f=await createLedgerFixture(t,{install:false});
  await f.db.exec(`CREATE ROLE ledger_type_reader NOLOGIN;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner GRANT USAGE ON TYPES TO ledger_type_reader WITH GRANT OPTION;
    SET ROLE memory_owner; CREATE TABLE memory_ops.ledger_type_probe(id integer); RESET ROLE`);
  const row=(await f.db.query("SELECT t.typtype,t.typacl::text,c.relowner=t.typowner AS same_owner FROM pg_class c JOIN pg_type t ON t.oid=c.reltype WHERE c.oid='memory_ops.ledger_type_probe'::regclass")).rows[0];
  assert.deepEqual(row,{typtype:'c',typacl:null,same_owner:true});
});

test('begin-only autocommit and forced immediate completeness roll back every new ledger row',async t=>{
  const f=await createLedgerFixture(t),raw=encode(await f.candidate()),before=await f.ledger();
  await assert.rejects(f.owner(db=>f.begin(db,raw)),bad('PP004'));assert.deepEqual(await f.ledger(),before);
  await assert.rejects(f.owner(async db=>{await db.exec('BEGIN; SET CONSTRAINTS ALL IMMEDIATE');await f.begin(db,raw);await db.exec('COMMIT');}),bad('PP004'));
  assert.deepEqual(await f.ledger(),before);
});

test('pending attempts append contiguously and terminal replay/status keep exact immutable bytes',async t=>{
  const f=await createLedgerFixture(t),p=await f.candidate(),raw=encode(p),positive=await f.positive();
  const a=JSON.parse(await f.decide(p)),b=JSON.parse(await f.decide(p,'dependency_pending','provisioning_missing'));
  const terminal=await f.decide(p,'applied','snapshot_applied'),c=JSON.parse(terminal);
  assert.deepEqual([a.attemptNo,b.attemptNo,c.attemptNo],[1,2,3]);assert.equal(c.leaseExpiresAtMs,p.lease.expiresAtMs);assert.deepEqual(c.currentHeads,[]);
  assert.equal(await f.status(p.eventId,hash(raw)),terminal);assert.equal(await f.decide(p),terminal);
  const before=await f.ledger();
  await assert.rejects(f.owner(db=>f.append(db,p.eventId,hash(raw),4,'dependency_pending','dependency_head_missing')),bad('PP004'));
  assert.deepEqual(await f.ledger(),before);assert.deepEqual(await f.positive(),positive);
});

test('losing event keeps its own terminal receipt without replacing or recycling reservation',async t=>{
  const f=await createLedgerFixture(t),winner=await f.candidate(),loser=await f.candidate({id:801});
  await f.decide(winner);const winnerText=await f.status(winner.eventId,hash(encode(winner)));
  await assert.rejects(f.decide(loser),bad('PP004'));
  const text=await f.decide(loser,'conflict','snapshot_sequence_conflict');assert.equal(JSON.parse(text).attemptNo,1);
  assert.equal(await f.status(winner.eventId,hash(encode(winner))),winnerText);
  assert.equal(await f.status(loser.eventId,hash(encode(loser))),text);
  assert.deepEqual((await f.db.query(`SELECT transport_event_id FROM ${reservation}`)).rows,[{transport_event_id:winner.eventId}]);
});

test('malformed snapshot/hash fails before persistence even when UUID is occupied',async t=>{
  const f=await createLedgerFixture(t),p=await f.candidate(),raw=encode(p);await f.decide(p);const saved=await f.ledger();
  for(const input of [null,'',' '+raw,raw+'\n',raw.replace('"version":3','"version":3.0'),raw.replace('"version":3','"version":3,"version":3'),'{private-secret','x'.repeat(131073)])
    await assert.rejects(f.owner(db=>f.begin(db,input,input===null?'a'.repeat(64):hash(input))),bad('PP001'));
  for(const digest of [null,'A'.repeat(64),'1'.repeat(63),'1'.repeat(64)])await assert.rejects(f.owner(db=>f.begin(db,raw,digest)),bad('PP001'));
  const other=structuredClone(p);other.snapshotSeq++;
  await assert.rejects(f.owner(db=>f.begin(db,encode(other))),bad('PP002'));assert.deepEqual(await f.ledger(),saved);
});

test('source UUID first prevents positive and empty outer snapshots before event insertion',async t=>{
  const f=await createLedgerFixture(t),h=event(41);await f.apply(wire(h));
  for(const empty of [false,true]){const p=await f.candidate({empty});p.eventId=h.head.eventId;
    await assert.rejects(f.owner(db=>f.begin(db,encode(p))),bad('PP002'));}
  assert.equal((await f.ledger()).events.length,1);assert.equal((await f.ledger()).reservations.length,0);
});

test('snapshot UUID first makes a distinct head transport a stored source conflict without negative side effects',async t=>{
  const f=await createLedgerFixture(t),p=await f.candidate({empty:true});await f.decide(p,'applied','empty_snapshot_applied');
  const before=await f.state(),h=event(61,'credential','credential:terminal',{type:'entity-negative',entityKind:'credential',entityId:'credential:terminal',state:'revoked',occurredAtMs:1});
  h.head.eventId=p.eventId;const raw=wire(h),text=await f.apply(raw),r=await verifySeoulHeadReceiptForEvent(new TextEncoder().encode(text),new TextEncoder().encode(raw));
  assert.equal(r.reason,'source_identity_conflict');const after=await f.state();
  for(const name of ['identity_projection_source_heads','identity_projection_heads','identity_projection_lifecycle','identity_projection_tombstones'])assert.deepEqual(after[name],before[name]);
  h.eventId=p.eventId;await assert.rejects(f.apply(wire(h)),bad('PP002'));
});

test('dependency snapshot UUID forces source conflict below sequence-conflict precedence',async t=>{
  const f=await createLedgerFixture(t),first=await f.candidate({empty:true,id:802,seq:4});await f.decide(first,'applied','empty_snapshot_applied');
  const p=await f.candidate({id:803});p.grants[0].heads.subjects[0].eventId=first.eventId;
  await assert.rejects(f.decide(p),bad('PP004'));assert.equal(JSON.parse(await f.decide(p,'conflict','source_identity_conflict')).reason,'source_identity_conflict');
  const loser=structuredClone(p);loser.eventId=uuid(804);assert.equal(JSON.parse(await f.decide(loser,'conflict','snapshot_sequence_conflict')).reason,'snapshot_sequence_conflict');
});

test('stale/gapped attempt and wrong binding fail without mutating pending history',async t=>{
  const f=await createLedgerFixture(t),p=await f.candidate();await f.decide(p);const saved=await f.ledger(),digest=hash(encode(p));
  for(const attempt of [1,3])await assert.rejects(f.owner(db=>f.append(db,p.eventId,digest,attempt,'dependency_pending','dependency_head_missing')),bad('PP004'));
  await assert.rejects(f.owner(db=>f.append(db,p.eventId,'a'.repeat(64),2,'dependency_pending','dependency_head_missing')),bad('PP004'));
  for(const attempt of [null,0,-1,'9007199254740992'])await assert.rejects(f.owner(db=>f.append(db,p.eventId,digest,attempt,'dependency_pending','dependency_head_missing')),bad('PP001'));
  assert.deepEqual(await f.ledger(),saved);
});

test('all nineteen declared snapshot pairs use canonical derived fields and DB-observed time',async t=>{
  const f=await createLedgerFixture(t);let id=900;
  const pairs=[['applied','snapshot_applied'],['applied','empty_snapshot_applied'],
    ...['dependency_head_missing','dependency_head_behind','provisioning_missing','retained_row_disposition_missing'].map(r=>['dependency_pending',r]),
    ...['newer_snapshot_present','newer_dependency_present','terminal_identity_denied','lifecycle_denied','target_deselected','lease_expired','lease_issued_in_future','authority_expired'].map(r=>['snapshot_superseded',r]),
    ...['snapshot_sequence_conflict','source_identity_conflict','immutable_entity_conflict','provisioning_conflict','retained_row_disposition_conflict'].map(r=>['conflict',r])];
  assert.equal(pairs.length,19);
  for(const [outcome,reason] of pairs){const p=await f.candidate({empty:reason==='empty_snapshot_applied',id:++id,seq:id,
      offset:reason==='lease_expired'?-60001:reason==='lease_issued_in_future'?10000:reason==='authority_expired'?-10000:0,grantOffset:reason==='authority_expired'?-1:120000});
    if(reason==='snapshot_sequence_conflict'){const win=structuredClone(p);win.eventId=uuid(++id);await f.decide(win);}
    const before=await f.now(),r=JSON.parse(await f.decide(p,outcome,reason)),after=await f.now();
    assert.equal(r.reason,reason);assert.equal(r.outcome,outcome);assert.ok(r.attemptedAtMs>=before&&r.attemptedAtMs<=after);assert.equal(r.spaceId,p.spaceId);assert.equal(r.sourceRevision,p.sourceRevision);assert.deepEqual(r.currentHeads,[]);
  }
});

test('empty graphs and expired/future grants cannot acquire contradictory declared outcomes',async t=>{
  const f=await createLedgerFixture(t);let id=1000;
  for(const [options,outcome,reason] of [[{empty:true},'applied','snapshot_applied'],[{empty:true},'dependency_pending','provisioning_missing'],
    [{empty:true},'conflict','source_identity_conflict'],[{},'applied','empty_snapshot_applied'],[{},'snapshot_superseded','lease_expired'],
    [{offset:-60001},'snapshot_superseded','lease_issued_in_future'],[{offset:10000},'dependency_pending','dependency_head_missing'],
    [{offset:-10000,grantOffset:-1},'applied','snapshot_applied'],[{},'conflict','snapshot_sequence_conflict']]){
    const p=await f.candidate({...options,id:++id,seq:id});await assert.rejects(f.decide(p,outcome,reason),bad('PP004'));
  }
  assert.equal((await f.ledger()).events.length,0);
});

test('applied receipt expiry observed by deferred check rolls back event/reservation and returns no historical success',async t=>{
  const f=await createLedgerFixture(t),p=await f.candidate({empty:true}),at=await f.now();p.lease={issuedAtMs:at-58500,expiresAtMs:at+1500};
  await assert.rejects(f.owner(async db=>{await db.exec('BEGIN');const raw=encode(p),b=await f.begin(db,raw);
    await f.append(db,p.eventId,hash(raw),b.next_attempt_no,'applied','empty_snapshot_applied');await sleep(1700);await db.exec('COMMIT');}),bad('PP004'));
  assert.equal((await f.ledger()).events.length,0);
});

test('committed terminal replay and exact status stay historical after signed expiry',async t=>{
  const f=await createLedgerFixture(t),p=await f.candidate({empty:true}),at=await f.now();p.lease={issuedAtMs:at-58500,expiresAtMs:at+1500};
  const receipt=await f.decide(p,'applied','empty_snapshot_applied');await sleep(1700);
  const saved=await f.ledger();assert.equal(await f.decide(p),receipt);assert.equal(await f.status(p.eventId,hash(encode(p))),receipt);assert.deepEqual(await f.ledger(),saved);
});

test('actual caller can read snapshot status but cannot dispatch snapshots or execute internal helpers',async t=>{
  const f=await createLedgerFixture(t),p=await f.candidate(),receipt=await f.decide(p),raw=encode(p),saved=await f.ledger();
  assert.equal(await f.status(p.eventId,hash(raw)),receipt);await assert.rejects(f.apply(raw),bad('PP001'));
  await assert.rejects(f.asRole('projection_test_login',db=>db.query(beginSQL,[raw,hash(raw)]),true),error=>{assert.equal(error.code,'42501');return true;});
  await assert.rejects(f.asRole('projection_test_login',db=>db.query(appendSQL,[p.eventId,hash(raw),2,'applied','snapshot_applied']),true),error=>{assert.equal(error.code,'42501');return true;});
  for(const [id,digest] of [[p.eventId,'a'.repeat(64)],[uuid(9999),hash(raw)],['INVALID',hash(raw)]])await assert.rejects(f.status(id,digest),bad('PP003'));
  assert.deepEqual(await f.ledger(),saved);
});

test('extended head entry commits under the real outer caller and preserves retained receipt bytes',async t=>{
  const f=await createLedgerFixture(t,{install:false}),raw=wire(event(21)),old=await f.apply(raw);await f.installLedger();
  assert.equal(await f.apply(raw),old);assert.equal(await f.status(event(21).eventId,hash(raw)),old);
  const positive=await f.positive();
  for(const h of [event(23),event(22),{...event(23),eventId:uuid(24)},{...event(23),eventId:uuid(25),effect:{type:'entity-head',disposition:'changed'}}]){
    const input=wire(h),r=await f.apply(input);await verifySeoulHeadReceiptForEvent(new TextEncoder().encode(r),new TextEncoder().encode(input));assert.equal(await f.status(h.eventId,hash(input)),r);
  }
  assert.deepEqual(await f.positive(),positive);
});

test('direct snapshot receipt text and namespace-alias inserts cannot bypass typed guards',async t=>{
  const f=await createLedgerFixture(t),p=await f.candidate(),raw=encode(p);
  await assert.rejects(f.owner(async db=>{await db.exec('BEGIN');await f.begin(db,raw);
    await db.query('INSERT INTO memory_ops.identity_projection_receipts VALUES($1,1,$2,$3,$4)',[p.eventId,'dependency_pending','dependency_head_missing','{}']);await db.exec('COMMIT');}),bad('PP004'));
  assert.equal((await f.ledger()).events.length,0);await f.decide(p);
  await assert.rejects(f.owner(db=>db.query(`INSERT INTO memory_ops.identity_projection_source_heads VALUES(999,$1,'credential','new:key',$2,'{"type":"entity-head","disposition":"present"}')`,[p.eventId,'a'.repeat(64)])),bad('PP004'));
  const saved=await f.ledger();
  for(const table of ['identity_projection_events','identity_projection_receipts','identity_projection_snapshot_reservations'])for(const operation of ['UPDATE','DELETE']){
    const sql=operation==='UPDATE'?`UPDATE memory_ops.${table} SET transport_event_id=transport_event_id WHERE false`:`DELETE FROM memory_ops.${table} WHERE false`;
    await assert.rejects(f.db.exec(sql),error=>{assert.equal(error.code,'55000');return true;});
  }
  // List the complete FK group so PostgreSQL reaches the product statement
  // guard instead of rejecting a lone parent TRUNCATE earlier with 0A000.
  await assert.rejects(f.db.exec('TRUNCATE memory_ops.identity_projection_events,memory_ops.identity_projection_receipts,memory_ops.identity_projection_snapshot_reservations'),error=>{assert.equal(error.code,'55000');return true;});
  assert.deepEqual(await f.ledger(),saved);
});

test('repeatable-read snapshot begin fails before writes',async t=>{
  const f=await createLedgerFixture(t),raw=encode(await f.candidate());
  await assert.rejects(f.owner(async db=>{await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ');await f.begin(db,raw);await db.exec('COMMIT');}),bad('PP004'));
  assert.equal((await f.ledger()).events.length,0);
});

test('new-object ACL closure removes arbitrary retained defaults without altering old ACLs or roles',async t=>{
  const f=await createLedgerFixture(t,{install:false});
  await f.db.exec(`CREATE ROLE ledger_arbitrary NOLOGIN;
    GRANT ledger_arbitrary TO memory_seoul_runtime WITH INHERIT TRUE,SET FALSE,ADMIN FALSE;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner GRANT ALL ON TABLES TO ledger_arbitrary WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_projection_owner GRANT EXECUTE ON FUNCTIONS TO ledger_arbitrary WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner IN SCHEMA memory_ops GRANT ALL ON TABLES TO anon,authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_projection_owner IN SCHEMA memory_ops GRANT EXECUTE ON FUNCTIONS TO anon,authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner GRANT USAGE ON TYPES TO ledger_arbitrary WITH GRANT OPTION`);
  const surface=await retainedSurface(f.db),{observe}=surface,saved=await observe();await f.installLedger();assert.deepEqual(await observe(),saved);await assertLedgerAddedTriggers(f.db,surface);
  for(const role of ['anon','authenticated','ledger_arbitrary','memory_seoul_runtime','memory_projection_caller','memory_runtime','memory_commands','memory_lifecycle','memory_background']){
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])assert.equal((await f.db.query('SELECT has_table_privilege($1,$2,$3) AS value',[role,reservation,privilege])).rows[0].value,false);
    const grants=(await f.db.query("SELECT p.oid::regprocedure::text AS signature,has_function_privilege($1,p.oid,'EXECUTE') AS value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='memory_ops' AND (p.proname LIKE 'projection_v3_ledger_%' OR p.proname LIKE 'projection_v3_snapshot_ledger_%')",[role])).rows;
    assert.ok(grants.length>=9);assert.ok(grants.every(x=>!x.value));
  }
  assert.equal((await f.db.query("SELECT t.typacl::text FROM pg_class c JOIN pg_type t ON t.oid=c.reltype WHERE c.oid=$1::regclass",[reservation])).rows[0].typacl,null);
});

test('unexpected old object ACL causes fixed installation failure without cleanup',async t=>{
  const f=await createLedgerFixture(t,{install:false});await f.db.exec('CREATE ROLE ledger_old_reader NOLOGIN; GRANT SELECT ON memory_ops.identity_projection_events TO ledger_old_reader');
  const {observe}=await retainedSurface(f.db),saved=await observe();await assert.rejects(f.installLedger(),bad('PP004'));assert.deepEqual(await observe(),saved);
  assert.equal((await f.db.query("SELECT to_regclass('memory_ops.identity_projection_snapshot_reservations') AS value")).rows[0].value,null);
});

test('direct head applied receipt cannot claim a missing current source through SQL null logic',async t=>{
  const f=await createLedgerFixture(t),h=event(70),raw=wire(h),at=await f.now();
  const fake=JSON.stringify({version:3,kind:'seoul-projection-receipt',eventId:h.eventId,transportPayloadSha256:hash(raw),sourceRevision:70,eventKind:'head',spaceId:null,snapshotSeq:null,attemptNo:1,outcome:'applied',reason:'head_applied',currentHeads:[],leaseExpiresAtMs:null,attemptedAtMs:at});
  await assert.rejects(f.owner(async db=>{await db.exec('BEGIN');
    await db.query('INSERT INTO memory_ops.identity_projection_events(transport_event_id,transport_payload_sha256,payload_text,source_revision,received_at_ms,event_kind) VALUES($1,$2,$3,70,$4,\'head\')',[h.eventId,hash(raw),raw,at]);
    await db.query('INSERT INTO memory_ops.identity_projection_receipts VALUES($1,1,\'applied\',\'head_applied\',$2)',[h.eventId,fake]);await db.exec('COMMIT');}),bad('PP004'));
  assert.equal((await f.ledger()).events.length,0);
});

test('existing CREATE privilege is rejected instead of silently revoked by installation',async t=>{
  const f=await createLedgerFixture(t,{install:false});await f.db.exec('GRANT CREATE ON SCHEMA memory_ops TO memory_projection_owner');
  const {observe}=await retainedSurface(f.db),saved=await observe();await assert.rejects(f.installLedger(),bad('PP004'));assert.deepEqual(await observe(),saved);
});

test('unexpected restrictive ledger policy is rejected before it can hide retained events',async t=>{
  const f=await createLedgerFixture(t,{install:false});await f.db.exec('CREATE POLICY ledger_hidden ON memory_ops.identity_projection_events AS RESTRICTIVE FOR SELECT TO memory_projection_owner USING(false)');
  const {observe}=await retainedSurface(f.db),saved=await observe();await assert.rejects(f.installLedger(),bad('PP004'));assert.deepEqual(await observe(),saved);
});

test('safe-counter exhaustion is unavailable in a labeled privileged corruption fixture',async t=>{
  const f=await createLedgerFixture(t),p=await f.candidate();await f.decide(p);
  // Deliberate invalid history, not a claim of MAX_SAFE prior real attempts.
  await f.db.exec(`ALTER TABLE memory_ops.identity_projection_receipts DISABLE TRIGGER USER;
    UPDATE memory_ops.identity_projection_receipts SET attempt_no=9007199254740991;
    ALTER TABLE memory_ops.identity_projection_receipts ENABLE TRIGGER USER`);
  const saved=await f.ledger();await assert.rejects(f.owner(db=>f.begin(db,encode(p))),bad('PP004'));
  await assert.rejects(f.owner(db=>f.append(db,p.eventId,hash(encode(p)),9007199254740991,'dependency_pending','dependency_head_missing')),bad('PP004'));assert.deepEqual(await f.ledger(),saved);
});

test('full 128KiB canonical event stays bounded while its structural pre-clock receipt stays small',async t=>{
  const f=await createLedgerFixture(t),raw=encode(boundarySnapshot());assert.equal(Buffer.byteLength(raw),131072);
  // Declared newer-sequence fixture; no actual regional generation is claimed.
  const receipt=await f.decide(raw,'snapshot_superseded','newer_snapshot_present');assert.ok(Buffer.byteLength(receipt)<1024);assert.equal(await f.status(JSON.parse(raw).eventId,hash(raw)),receipt);
});

test('retained defaults cannot remove the intended owner ability to execute new helpers',async t=>{
  const f=await createLedgerFixture(t,{install:false});await f.db.exec('ALTER DEFAULT PRIVILEGES FOR ROLE memory_projection_owner REVOKE EXECUTE ON FUNCTIONS FROM memory_projection_owner');
  const surface=await retainedSurface(f.db),before=await surface.observe();await f.installLedger();assert.deepEqual(await surface.observe(),before);
  const p=await f.candidate();assert.equal(JSON.parse(await f.decide(p)).outcome,'dependency_pending');
});

test('unexpected retained membership path into the code owner aborts without changing role edges',async t=>{
  const f=await createLedgerFixture(t,{install:false});await f.db.exec('CREATE ROLE ledger_owner_path NOLOGIN; GRANT memory_projection_owner TO ledger_owner_path WITH INHERIT TRUE,SET FALSE,ADMIN FALSE');
  const surface=await retainedSurface(f.db),before=await surface.observe();await assert.rejects(f.installLedger(),bad('PP004'));assert.deepEqual(await surface.observe(),before);
});

test('unexpected BYPASSRLS on the existing code owner aborts installation',async t=>{
  const f=await createLedgerFixture(t,{install:false});await f.db.exec('ALTER ROLE memory_projection_owner BYPASSRLS');
  await assert.rejects(f.installLedger(),bad('PP004'));assert.equal((await f.db.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='memory_projection_owner'")).rows[0].rolbypassrls,true);
});

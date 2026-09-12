import test from 'node:test';
import assert from 'node:assert/strict';
import {createHeadFixture,event,wire,hash,uuid,ISSUER,tables} from './seoul-projection-head-fixture.mjs';

// Independent wire literal; neither the SQL serializer nor the TS encoder builds this expectation.
const raw='{"version":3,"kind":"seoul-authority-head","eventId":"00000001-0000-4000-8000-000000000000","sourceRevision":1,"issuer":"https://auth-api.allen.company","head":{"kind":"subject","key":"https://auth-api.allen.company\\nalice","revision":1,"eventId":"000186a1-0000-4000-8000-000000000000","payloadSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"effect":{"type":"entity-head","disposition":"present"}}';
const invalid={message:'seoul_projection_input_invalid'};

test('canonical head receipt binds exact transport bytes and replay/status retain its original bytes',async t=>{
  const f=await createHeadFixture(t);
  assert.equal(wire(event(1)),raw);
  const before=(await f.db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS t')).rows[0].t;
  const receipt=await f.apply(raw),value=JSON.parse(receipt);
  assert.equal(receipt,'{"version":3,"kind":"seoul-projection-receipt","eventId":"00000001-0000-4000-8000-000000000000","transportPayloadSha256":"'+hash(raw)+'","sourceRevision":1,"eventKind":"head","spaceId":null,"snapshotSeq":null,"attemptNo":1,"outcome":"applied","reason":"head_applied","currentHeads":[{"kind":"subject","key":"https://auth-api.allen.company\\nalice","revision":1,"eventId":"000186a1-0000-4000-8000-000000000000","payloadSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"leaseExpiresAtMs":null,"attemptedAtMs":'+value.attemptedAtMs+'}');
  assert.ok(Number.isSafeInteger(value.attemptedAtMs)&&value.attemptedAtMs>=Number(before));
  assert.notEqual(value.transportPayloadSha256,value.currentHeads[0].payloadSha256);
  const saved=await f.state();
  assert.equal(await f.apply(raw),receipt);
  assert.equal(await f.status(uuid(1),hash(raw)),receipt);
  await assert.rejects(f.status(uuid(1),'a'.repeat(64)),{message:'seoul_projection_receipt_absent'});
  await assert.rejects(f.status(uuid(99),hash(raw)),{message:'seoul_projection_receipt_absent'});
  await assert.rejects(f.status('0000000A-0000-4000-8000-000000000000',hash(raw)),{message:'seoul_projection_receipt_absent'});
  await assert.rejects(f.apply(raw.replace('"present"','"changed"')),{message:'seoul_projection_event_conflict'});
  assert.deepEqual(await f.state(),saved);
});

test('malformed or noncanonical wire fails before any persistence and never leaks input diagnostics',async t=>{
  const f=await createHeadFixture(t),saved=await f.state();
  const candidate=event(1);
  const malformed=[null,'','sensitive-input{','[]','null','true',' '+raw,raw+'\n','\ufeff'+raw,
    raw.replace('"version":3','"version":3,"version":3'),raw.replace('"version":3','"version":3.0'),
    raw.replace('"sourceRevision":1','"sourceRevision":1e0'),raw.replace('"revision":1','"revision":-0'),
    raw.replace('alice','\\u0061lice'),JSON.stringify({...candidate,unknown:1}),
    JSON.stringify({...candidate,version:'3'}),JSON.stringify({...candidate,kind:'seoul-authority-snapshot'}),
    JSON.stringify({...candidate,head:{...candidate.head,revision:2}}),
    JSON.stringify({...candidate,head:{...candidate.head,payloadSha256:'C'.repeat(64)}}),
    JSON.stringify({...candidate,effect:{type:'subject-lifecycle',subject:'other',state:'suspended',occurredAtMs:1}}),
    JSON.stringify({...candidate,effect:{type:'entity-negative',entityKind:'subject',entityId:'alice',state:'disabled',occurredAtMs:1}}),
    JSON.stringify({...candidate,effect:{type:'entity-head',disposition:'present',extra:false}}),
    raw.replace('"version":3,"kind":"seoul-authority-head"','"kind":"seoul-authority-head","version":3'),
    raw.replace('alice','x'.repeat(131072))];
  for(const input of malformed.filter(v=>v!==raw)) await assert.rejects(f.apply(input,input===null?'a'.repeat(64):hash(input)),error=>{
    assert.equal(error.message,invalid.message);assert.equal(error.detail,undefined);assert.equal(error.hint,undefined);return true;
  });
  for(const digest of [null,'A'.repeat(64),'a'.repeat(63),'a'.repeat(64)])await assert.rejects(f.apply(raw,digest),invalid);
  assert.deepEqual(await f.state(),saved);
});

test('SQL canonicalization matches opaque Unicode subjects and rejects exactly JS blank/UTF16 bounds',async t=>{
  const f=await createHeadFixture(t);let next=1;
  const whitespace='\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  const valid=['a','"\\/\b\f\n\r\t','a'+String.fromCharCode(...Array.from({length:31},(_,i)=>i+1))+'\u007f',
    '\u0085','\u200b','\u180e','\ufeffx\ufeff','한국어😀\u2028\u2029','a\nb\n','😀'.repeat(256),'a'.repeat(512),whitespace+'x'];
  for(const subject of valid) {
    for(const email of [false,true]) {
      const n=next++,key=ISSUER+'\n'+subject+(email?'\na@example.test':''),kind=email?'email':'subject';
      const effect=email?{type:'email-lifecycle',subject,address:'a@example.test',state:'verified',occurredAtMs:0}
        :{type:'subject-lifecycle',subject,state:'resumed',occurredAtMs:9007199254740991};
      const input=wire(event(n,kind,key,effect)),receipt=JSON.parse(await f.apply(input));
      assert.equal(receipt.outcome,'applied');assert.equal(receipt.currentHeads[0].key,key);
    }
  }
  for(const subject of ['',whitespace,'😀'.repeat(256)+'a','a'.repeat(513),'x\0','\ud800','\udc00']) {
    const candidate=event(next++,'subject',ISSUER+'\n'+subject);
    assert.throws(()=>wire(candidate));await assert.rejects(f.apply(JSON.stringify(candidate)),invalid);
  }
  for(const address of ['A@example.test','a..b@example.test','a@-example.test','a@example','a@example..test','a@éxample.test','a'.repeat(65)+'@example.test']) {
    const candidate=event(next++,'email',ISSUER+'\ns\n'+address);
    assert.throws(()=>wire(candidate));await assert.rejects(f.apply(JSON.stringify(candidate)),invalid);
  }
});

test('source identity binding is global, exact re-delivery is harmless, and old heads cannot regress',async t=>{
  const f=await createHeadFixture(t),first=event(10);await f.apply(wire(first));
  assert.equal(JSON.parse(await f.apply(wire({...first,eventId:uuid(11)}))).reason,'head_already_current');
  const newer=event(20);await f.apply(wire(newer));
  const older=event(5);const oldReceipt=JSON.parse(await f.apply(wire(older)));
  assert.equal(oldReceipt.outcome,'head_superseded');assert.equal(oldReceipt.currentHeads[0].revision,20);
  const sourceConflict={...event(10,'credential','pat:other'),eventId:uuid(30)};
  const conflict=JSON.parse(await f.apply(wire(sourceConflict)));
  assert.equal(conflict.outcome,'conflict');assert.equal(conflict.reason,'source_identity_conflict');assert.deepEqual(conflict.currentHeads,[]);
  const reusedId=event(31,'credential','pat:other');reusedId.head.eventId=first.head.eventId;
  assert.equal(JSON.parse(await f.apply(wire(reusedId))).outcome,'conflict');
  const changedEffect={...first,eventId:uuid(32),effect:{type:'entity-head',disposition:'changed'}};
  assert.equal(JSON.parse(await f.apply(wire(changedEffect))).outcome,'conflict');
  const rows=(await f.db.query('SELECT source_revision FROM memory_ops.identity_projection_source_heads ORDER BY source_revision')).rows;
  assert.deepEqual(rows.map(r=>Number(r.source_revision)),[5,10,20]);
});

test('pre-mapping lifecycle, late irreversible evidence and target history never materialize positive rows',async t=>{
  const f=await createHeadFixture(t,{seed:true});
  const positive=async()=>(await f.db.query(`SELECT jsonb_build_object('accounts',(SELECT jsonb_agg(a) FROM memory_identity.accounts a),
    'organizations',(SELECT jsonb_agg(o) FROM memory_control.organizations o),'identities',(SELECT jsonb_agg(p) FROM memory_identity.provider_identities p),
    'emails',(SELECT jsonb_agg(e) FROM memory_identity.account_emails e),'memberships',(SELECT jsonb_agg(m) FROM memory_identity.memberships m),
    'credentials',(SELECT jsonb_agg(c) FROM memory_identity.credentials c),'spaces',(SELECT jsonb_agg(s) FROM memory_control.spaces s),
    'grants',(SELECT jsonb_agg(g) FROM memory_identity.pat_space_grants g),'usage',(SELECT jsonb_agg(u) FROM memory_ops.space_usage u)) AS value`)).rows[0].value;
  const saved=await positive(),subject='absent\nidentity';
  const life=(revision,state)=>event(revision,'subject',ISSUER+'\n'+subject,{type:'subject-lifecycle',subject,state,occurredAtMs:revision});
  await f.apply(wire(life(20,'resumed')));await f.apply(wire(life(10,'deleted')));await f.apply(wire(life(30,'resumed')));
  await f.apply(wire(event(40,'subject',ISSUER+'\n'+subject)));
  await f.apply(wire(event(50,'email',ISSUER+'\n'+subject+'\na@example.test',{type:'email-lifecycle',subject,address:'a@example.test',state:'verified',occurredAtMs:50})));
  await f.apply(wire(event(45,'email',ISSUER+'\n'+subject+'\na@example.test',{type:'email-lifecycle',subject,address:'a@example.test',state:'revoked',occurredAtMs:45})));
  let n=100;
  for(const [kind,state] of [['organization','disabled'],['space','disabled'],['membership','revoked'],['credential','revoked'],['target','removed']]) {
    const key=kind+':absent';await f.apply(wire(event(n+2,kind,key)));
    await f.apply(wire(event(n,kind,key,{type:'entity-negative',entityKind:kind,entityId:key,state,occurredAtMs:0})));
    await f.apply(wire(event(n+3,kind,key,{type:'entity-head',disposition:'changed'})));n+=10;
  }
  assert.deepEqual((await f.db.query('SELECT kind FROM memory_ops.identity_projection_tombstones ORDER BY kind')).rows.map(r=>r.kind),
    ['credential','membership','organization','space','subject']);
  assert.deepEqual((await f.db.query('SELECT kind,state FROM memory_ops.identity_projection_lifecycle ORDER BY kind')).rows,
    [{kind:'email',state:'verified'},{kind:'subject',state:'resumed'}]);
  assert.deepEqual(await positive(),saved);
  const newRelations=(await f.db.query("SELECT relname FROM pg_catalog.pg_class WHERE relname LIKE 'identity_projection_%' AND relkind='r' ORDER BY relname")).rows.map(r=>r.relname);
  assert.deepEqual(newRelations,[...tables].sort());
});

test('a late receipt failure rolls back transport/source/head/lifecycle/tombstone together',async t=>{
  const f=await createHeadFixture(t),saved=await f.state();
  await f.db.exec(`CREATE FUNCTION public.fail_projection_receipt() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='fixture_late_failure'; END $f$;
    CREATE TRIGGER fixture_late_failure BEFORE INSERT ON memory_ops.identity_projection_receipts
    FOR EACH ROW EXECUTE FUNCTION public.fail_projection_receipt()`);
  const subject='not-mapped',input=wire(event(1,'subject',ISSUER+'\n'+subject,{type:'subject-lifecycle',subject,state:'deleted',occurredAtMs:1}));
  await assert.rejects(f.apply(input),{message:'fixture_late_failure'});
  assert.deepEqual(await f.state(),saved);
  await f.db.exec('DROP TRIGGER fixture_late_failure ON memory_ops.identity_projection_receipts');
  assert.equal(JSON.parse(await f.apply(input)).outcome,'applied');
});

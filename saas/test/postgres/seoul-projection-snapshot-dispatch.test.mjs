import test from 'node:test';
import assert from 'node:assert/strict';
import {createDispatchFixture,encode,hash,uuid,invalid,conflict,absent} from './seoul-projection-snapshot-dispatch-fixture.mjs';
import {createLedgerFixture} from './seoul-projection-snapshot-ledger-fixture.mjs';
import {verifySeoulSnapshotReceiptForEvent} from '../../src/release/seoul-projection-snapshot-receipt-codec.ts';
import {unavailable,dependencies} from './seoul-projection-snapshot-materialization-fixture.mjs';

test('dispatch install requires the materialization draft and refuses a rerun',async t=>{
 const f=await createDispatchFixture(t,{install:false});
 const apply=(await f.db.query("SELECT prosrc FROM pg_proc WHERE oid='memory_identity.seoul_projection_apply(text,text)'::regprocedure")).rows[0];
 assert.equal(apply.prosrc.includes('seoul-authority-snapshot'),false);
 await f.installDispatch();
 const routed=(await f.db.query("SELECT proowner::regrole::text AS owner,prosecdef,proacl::text FROM pg_proc WHERE oid='memory_identity.seoul_projection_apply(text,text)'::regprocedure")).rows[0];
 assert.deepEqual(routed,{owner:'memory_projection_owner',prosecdef:true,proacl:'{memory_projection_owner=X/memory_projection_owner,memory_projection_caller=X/memory_projection_owner}'});
 await assert.rejects(f.installDispatch(),unavailable);
});

test('dispatch install rejects an inheriting caller membership edge',async t=>{
 const f=await createDispatchFixture(t,{install:false});
 await f.asRole('postgres',db=>db.exec('CREATE ROLE projection_sneak LOGIN NOINHERIT; GRANT memory_projection_caller TO projection_sneak WITH INHERIT TRUE,SET FALSE,ADMIN FALSE'));
 await assert.rejects(f.installDispatch(),unavailable);
});

test('dispatch install rejects an ADMIN-capable caller membership edge',async t=>{
 const f=await createDispatchFixture(t,{install:false});
 await f.asRole('postgres',db=>db.exec('CREATE ROLE projection_deputy LOGIN NOINHERIT; GRANT memory_projection_caller TO projection_deputy WITH INHERIT FALSE,SET TRUE,ADMIN TRUE'));
 await assert.rejects(f.installDispatch(),unavailable);
});

test('dispatch install without the B2 draft fails before any change',async t=>{
 const f=await createLedgerFixture(t);
 const sql=(await import('node:fs/promises')).readFile(new URL('../../postgres/projection-v3/snapshot-dispatch.sql',import.meta.url),'utf8');
 const before=await f.ledger();
 await assert.rejects(f.asRole('fixture_provisioner',async db=>db.exec(await sql)),unavailable);
 assert.deepEqual(await f.ledger(),before);
 const apply=(await f.db.query("SELECT prosrc FROM pg_proc WHERE oid='memory_identity.seoul_projection_apply(text,text)'::regprocedure")).rows[0];
 assert.equal(apply.prosrc.includes('seoul-authority-snapshot'),false);
});

for(const organization of [false,true])test('dispatch applies a complete snapshot through the caller entry; organization='+organization,async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate({organization});await f.ready(p);
 const raw=encode(p),receiptText=await f.dispatch(p),receipt=JSON.parse(receiptText);
 assert.equal(receipt.outcome,'applied');assert.equal(receipt.reason,'snapshot_applied');
 assert.equal(receipt.eventKind,'snapshot');assert.equal(receipt.eventId,p.eventId);
 assert.equal(receipt.spaceId,p.spaceId);assert.equal(receipt.snapshotSeq,1);assert.equal(receipt.attemptNo,1);
 assert.equal(receipt.transportPayloadSha256,hash(raw));assert.equal(receipt.leaseExpiresAtMs,p.lease.expiresAtMs);
 await verifySeoulSnapshotReceiptForEvent(new TextEncoder().encode(receiptText),new TextEncoder().encode(raw));
 const state=await f.materializationState();
 assert.equal(state.generations.length,1);assert.equal(state.state[0].current_sequence,1);assert.equal(state.grants.length,1);
 // Exact-byte replay returns the stored receipt without another attempt.
 assert.equal(await f.dispatch(raw),receiptText);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.identity_projection_receipts WHERE transport_event_id=$1',[p.eventId])).rows[0].n,1);
});

test('dispatch keeps a pending snapshot replayable and applies the same bytes after heads land',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();
 const raw=encode(p);
 let receipt=JSON.parse(await f.dispatch(raw));
 assert.equal(receipt.outcome,'dependency_pending');assert.equal(receipt.reason,'dependency_head_missing');assert.equal(receipt.attemptNo,1);
 await f.receive(p);await f.provision(p);
 receipt=JSON.parse(await f.dispatch(raw));
 assert.equal(receipt.outcome,'applied');assert.equal(receipt.reason,'snapshot_applied');assert.equal(receipt.attemptNo,2);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.identity_projection_receipts WHERE transport_event_id=$1',[p.eventId])).rows[0].n,2);
});

test('dispatch rejects changed bytes under an occupied snapshot transport identity',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();await f.ready(p);
 await f.dispatch(p);
 const tampered=structuredClone(p);tampered.sourceRevision+=1;
 await assert.rejects(f.dispatch(tampered),conflict);
});

test('dispatch rejects malformed snapshot bytes, hashes and canonical form',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();await f.ready(p);
 const raw=encode(p);
 await assert.rejects(f.asRole('projection_test_login',db=>db.query('SELECT memory_identity.seoul_projection_apply($1::text,$2::text)',[raw,'0'.repeat(64)]),true),invalid);
 const spaced=raw.replace(':',': ');
 await assert.rejects(f.asRole('projection_test_login',db=>db.query('SELECT memory_identity.seoul_projection_apply($1::text,$2::text)',[spaced,hash(spaced)]),true),invalid);
 await assert.rejects(f.asRole('projection_test_login',db=>db.query('SELECT memory_identity.seoul_projection_apply($1::text,$2::text)',['{"kind":"seoul-authority-snapshot"',hash('{"kind":"seoul-authority-snapshot"')]),true),invalid);
});

test('dispatch still routes head envelopes to the unchanged head path',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();
 await f.applyHead(dependencies(p)[0]);
 const events=await f.ledger();
 assert.equal(events.events.length,1);assert.equal(events.events[0].event_kind,'head');
 assert.equal(events.receipts[0].outcome,'applied');assert.equal(events.receipts[0].reason,'head_applied');
});

test('dispatch reports status for a snapshot event through the caller status entry',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();await f.ready(p);
 const raw=encode(p),receiptText=await f.dispatch(raw);
 assert.equal(await f.status(p.eventId,hash(raw)),receiptText);
 await assert.rejects(f.status(uuid(999),hash(raw)),absent);
});

test('dispatch status returns the latest pending attempt for an incomplete snapshot',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();
 const raw=encode(p),receiptText=await f.dispatch(raw);
 assert.equal(JSON.parse(receiptText).reason,'dependency_head_missing');
 assert.equal(await f.status(p.eventId,hash(raw)),receiptText);
});

test('dispatch cannot reuse a retained source event identity for a snapshot',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();
 const h=dependencies(p)[0];await f.applyHead(h);
 // Rebind the snapshot's outer eventId to the applied head's source event UUID:
 // the canonical validator rejects the collision as malformed before the ledger
 // persists any event row.
 const raw=encode(p).replace('"eventId":"'+p.eventId+'"','"eventId":"'+h.eventId+'"');
 await assert.rejects(f.asRole('projection_test_login',db=>db.query('SELECT memory_identity.seoul_projection_apply($1::text,$2::text) AS receipt',[raw,hash(raw)]),true),invalid);
 assert.equal((await f.ledger()).events.length,1);
});

test('dispatch rejects a snapshot envelope whose kind is not the exact string',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();
 const raw=encode(p);
 for(const mutant of [raw.replace('"seoul-authority-snapshot"','123'),raw.replace('"seoul-authority-snapshot"','"seoul-authority-head"')])
  await assert.rejects(f.asRole('projection_test_login',db=>db.query('SELECT memory_identity.seoul_projection_apply($1::text,$2::text)',[mutant,hash(mutant)]),true),invalid);
});

test('dispatch losing sequence candidate records its own conflict receipt',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();await f.ready(p);
 await f.dispatch(p);
 const loser=structuredClone(p);loser.eventId=uuid(801);
 const receipt=JSON.parse(await f.dispatch(loser));
 assert.equal(receipt.outcome,'conflict');assert.equal(receipt.reason,'snapshot_sequence_conflict');assert.equal(receipt.eventId,loser.eventId);
});

test('caller cannot invoke the owner materializer or read projection tables directly',async t=>{
 const f=await createDispatchFixture(t),p=await f.candidate();const raw=encode(p);
 await assert.rejects(f.asRole('projection_test_login',db=>db.query('SELECT memory_identity.projection_v3_snapshot_materialize($1::text,$2::text)',[raw,hash(raw)]),true),e=>e.code==='42501');
 await assert.rejects(f.asRole('projection_test_login',db=>db.query('SELECT count(*) FROM memory_ops.identity_projection_events'),true),e=>e.code==='42501');
 await assert.rejects(f.asRole('projection_test_login',db=>db.query('SELECT count(*) FROM memory_identity.identity_projection_grants'),true),e=>e.code==='42501');
});

test('dispatch exposes no new function, table, policy or role surface',async t=>{
 const f=await createDispatchFixture(t,{install:false});
 const inventory=async()=>({
  functions:(await f.db.query("SELECT p.oid::regprocedure::text AS signature,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS src,proowner::regrole::text AS owner,prosecdef,proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'memory_%' ORDER BY 1")).rows,
  tables:(await f.db.query("SELECT c.oid::regclass::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_%' AND c.relkind IN('r','S') ORDER BY 1")).rows,
  policies:(await f.db.query('SELECT polrelid::regclass::text AS relation,polname,polcmd,(SELECT array_agg(r.rolname ORDER BY r.rolname) FROM pg_roles r WHERE r.oid=ANY(q.polroles)) AS roles FROM pg_policy q ORDER BY 1,2')).rows,
  roles:(await f.db.query('SELECT rolname FROM pg_roles ORDER BY 1')).rows,
 });
 const before=await inventory();await f.installDispatch();const after=await inventory();
 assert.deepEqual(after.tables,before.tables);assert.deepEqual(after.policies,before.policies);assert.deepEqual(after.roles,before.roles);
 assert.deepEqual(after.functions.filter(x=>x.signature!=='memory_identity.seoul_projection_apply(text,text)'),before.functions.filter(x=>x.signature!=='memory_identity.seoul_projection_apply(text,text)'));
 const applyAfter=after.functions.find(x=>x.signature==='memory_identity.seoul_projection_apply(text,text)');
 assert.equal(applyAfter.owner,'memory_projection_owner');assert.equal(applyAfter.prosecdef,true);
 assert.equal(applyAfter.proacl,'{memory_projection_owner=X/memory_projection_owner,memory_projection_caller=X/memory_projection_owner}');
 const callerExec=(await f.db.query("SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,aclexplode(p.proacl) a WHERE n.nspname LIKE 'memory_%' AND a.grantee='memory_projection_caller'::regrole ORDER BY 1")).rows.map(r=>r.signature);
 assert.deepEqual(callerExec,['memory_identity.seoul_projection_apply(text,text)','memory_ops.seoul_projection_status(text,text)']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterializationFixture,tables,functions,allReasons,dependencies,encode,hash,uuid,issuer,head,addIdentity,unavailable} from './seoul-projection-snapshot-materialization-fixture.mjs';

test('B2 install exact nine-table and private-function inventory',async t=>{
 const f=await createMaterializationFixture(t);
 const actual=(await f.db.query('SELECT c.oid::regclass::text AS name,c.relowner::regrole::text AS owner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.oid=ANY($1::regclass[]) ORDER BY name',[Object.values(tables)])).rows;
 assert.deepEqual(actual,Object.values(tables).sort().map(name=>({name,owner:'memory_owner',relrowsecurity:true,relforcerowsecurity:true})));
 for(const name of functions){const meta=(await f.db.query('SELECT proowner::regrole::text AS owner,provolatile,prosecdef,proconfig,proacl::text FROM pg_proc WHERE oid=$1::regprocedure',[name])).rows[0];assert.deepEqual(meta,{owner:'memory_projection_owner',provolatile:'v',prosecdef:/materialization_(receipt|complete)\(/.test(name),proconfig:['search_path=pg_catalog'],proacl:'{memory_projection_owner=X/memory_projection_owner}'});}
 assert.equal(Object.values(allReasons).flat().length,19);
 for(const name of functions){const oid=(await f.db.query('SELECT $1::regprocedure::oid AS oid',[name])).rows[0].oid;assert.equal((await f.asRole('projection_test_login',db=>db.query('SELECT has_function_privilege(current_user,$1::oid,\'EXECUTE\') AS allowed',[oid]))).rows[0].allowed,false);}
});

for(const organization of [false,true])test('B2 apply actual complete positive creation organization='+organization,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate({organization});await f.ready(p);const receipt=await f.materialize(p);
 assert.equal(receipt.outcome,'applied');assert.equal(receipt.reason,'snapshot_applied');assert.equal(receipt.attemptNo,1);assert.deepEqual(receipt.currentHeads,[]);assert.equal(receipt.leaseExpiresAtMs,p.lease.expiresAtMs);
 const state=await f.materializationState();assert.equal(state.generations.length,1);assert.equal(state.state[0].current_sequence,1);assert.equal(state.grants.length,1);assert.equal(state.heads.length,organization?7:4);assert.equal(state.facts.length,organization?6:3);assert.equal(state.current.length,organization?2:1);assert.equal(state.entities.length,organization?6:3);assert.equal(state.providers.length,1);assert.equal(state.legacy.length,1);
 assert.deepEqual((await f.db.query('SELECT space_id,source_bytes,message_count,retained_source_bytes,retained_message_count FROM memory_ops.space_usage WHERE space_id=$1',[p.spaceId])).rows,[{space_id:p.spaceId,source_bytes:0,message_count:0,retained_source_bytes:0,retained_message_count:0}]);
 assert.equal((await f.db.query('SELECT reauthenticated_at FROM memory_identity.credentials WHERE id=$1',[p.credentials[0].id])).rows[0].reauthenticated_at,null);
 assert.equal(state.grants[0].can_erase,false);assert.equal(state.grants[0].can_retire,false);assert.deepEqual(state.grants[0].credential_policy,p.credentialPolicies[0]);
 const before=await f.dump();assert.deepEqual(await f.materialize(p),receipt);assert.deepEqual(await f.dump(),before);assert.equal(JSON.parse(await f.status(p.eventId,hash(encode(p)))).reason,'snapshot_applied');
});

test('B2 apply empty creates only zero generation and pointer without positive requirements',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate({empty:true}),positive=await f.positive();const receipt=await f.materialize(p);
 assert.equal(receipt.reason,'empty_snapshot_applied');assert.deepEqual(await f.positive(),positive);const state=await f.materializationState();assert.equal(state.generations.length,1);assert.equal(state.generations[0].grant_count,0);assert.equal(state.generations[0].provisioning_approval_id,null);assert.equal(state.state.length,1);for(const key of ['grants','heads','facts','current','entities','providers','legacy'])assert.deepEqual(state[key],[]);
});

test('B2 reasons pending progress uses actual prerequisites and immutable attempts',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();let receipt=await f.materialize(p);assert.equal(receipt.reason,'dependency_head_missing');assert.equal(receipt.attemptNo,1);
 await f.receive(p);receipt=await f.materialize(p);assert.equal(receipt.reason,'provisioning_missing');assert.equal(receipt.attemptNo,2);
 await f.provision(p);receipt=await f.materialize(p);assert.equal(receipt.reason,'snapshot_applied');assert.equal(receipt.attemptNo,3);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.identity_projection_receipts WHERE transport_event_id=$1',[p.eventId])).rows[0].n,3);
});

for(const [reason,options]of [['lease_expired',{offset:-60001}],['lease_issued_in_future',{offset:60000}],['authority_expired',{offset:-1000,grantOffset:-1}]])test('B2 reasons '+reason+' precedes absent positive prerequisites',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate(options),before=await f.positive(),r=await f.materialize(p);assert.equal(r.outcome,'snapshot_superseded');assert.equal(r.reason,reason);assert.deepEqual(await f.positive(),before);assert.ok(Object.values(await f.materializationState()).every(a=>a.length===0));
});

test('B2 reasons sequence conflict precedes source absence and retains both event receipts',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();assert.equal((await f.materialize(p)).reason,'dependency_head_missing');const loser=structuredClone(p);loser.eventId=uuid(801);assert.equal((await f.materialize(loser)).reason,'snapshot_sequence_conflict');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.identity_projection_snapshot_reservations')).rows[0].n,1);
});

test('B2 reasons exact source revision and UUID locators beat lower missing prerequisites',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate(),h=dependencies(p)[0];await f.applyHead({...h,key:issuer+'\nother'});const r=await f.materialize(p);assert.equal(r.reason,'source_identity_conflict');assert.equal(r.outcome,'conflict');
});

test('B2 guards bare synthetic A outcomes fail real completion and roll back ledger',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);const raw=encode(p),before=await f.dump();
 for(const [outcome,reason]of [['dependency_pending','dependency_head_missing'],['conflict','immutable_entity_conflict'],['applied','snapshot_applied']]){
  await assert.rejects(f.owner(async db=>{await db.exec('BEGIN');const b=await f.begin(db,raw);await f.append(db,b.transport_event_id,hash(raw),b.next_attempt_no,outcome,reason);await db.exec('COMMIT');}),unavailable);assert.deepEqual(await f.dump(),before);
 }
});

test('B2 install any prior A snapshot history rejects without creating B tables',async t=>{
 const f=await createMaterializationFixture(t,{install:false}),p=await f.candidate();await f.decide(p,'dependency_pending','dependency_head_missing');const before=await f.ledger();await assert.rejects(f.installMaterialization(),unavailable);assert.deepEqual(await f.ledger(),before);for(const table of Object.values(tables))assert.equal((await f.db.query('SELECT to_regclass($1) AS oid',[table])).rows[0].oid,null);
});

for(const [label,sql] of [
 ['missing command key UPDATE','REVOKE UPDATE(id) ON memory_identity.accounts FROM memory_commands'],
 ['missing lifecycle SELECT','REVOKE SELECT ON memory_identity.credentials FROM memory_lifecycle'],
 ['missing setup decision SELECT','REVOKE SELECT(authorized_binding) ON memory_identity.identity_projection_retained_dispositions FROM memory_projection_owner'],
 ['extra setup audit SELECT','GRANT SELECT(approval_reference) ON memory_ops.identity_projection_space_provisioning TO memory_projection_owner'],
 ['extra setup helper EXECUTE','GRANT EXECUTE ON FUNCTION memory_identity.projection_v3_setup_valid(jsonb,text) TO memory_projection_owner'],
 ['wrong B1 volatility','ALTER FUNCTION memory_identity.projection_v3_snapshot_fact(jsonb,text,text) VOLATILE'],
 ['wrong A security mode','ALTER FUNCTION memory_ops.projection_v3_snapshot_ledger_begin(text,text) SECURITY DEFINER'],
 ['missing old schema USAGE','REVOKE USAGE ON SCHEMA memory_control FROM memory_lifecycle'],
 ['extra old schema CREATE','GRANT CREATE ON SCHEMA memory_control TO memory_projection_caller'],
 ['extra old relation reader','GRANT SELECT ON memory_identity.provider_identities TO memory_projection_caller'],
 ['changed setup policy','ALTER POLICY setup_projection_select ON memory_ops.identity_projection_space_provisioning USING(false)']
 ,['missing source history SELECT','REVOKE SELECT ON memory_ops.identity_projection_source_heads FROM memory_projection_owner']
 ,['missing head pointer UPDATE','REVOKE UPDATE(source_revision) ON memory_ops.identity_projection_heads FROM memory_projection_owner']
 ,['changed head policy','ALTER POLICY projection_owner_select ON memory_ops.identity_projection_heads USING(false)']
])test('B2 install drift '+label,async t=>{
 const f=await createMaterializationFixture(t,{install:false});await f.asRole('postgres',db=>db.exec(sql));
 await assert.rejects(()=>f.installMaterialization(),unavailable);
 assert.equal((await f.db.query("SELECT to_regclass('memory_ops.identity_projection_snapshot_generations') AS value")).rows[0].value,null);
});

test('B2 install deployment RLS and old schema ACL preservation',async t=>{
 const f=await createMaterializationFixture(t,{install:false});
 const query="SELECT nspname,nspowner::regrole::text,nspacl::text FROM pg_namespace WHERE nspname LIKE 'memory_%' ORDER BY nspname";
 const before=(await f.db.query(query)).rows;await f.installMaterialization();const after=(await f.db.query(query)).rows;
 assert.deepEqual(after,before.map(row=>row.nspname==='memory_control'?{...row,nspacl:row.nspacl.replace(/}$/,',memory_projection_owner=U/memory_owner}')}:row));
 assert.deepEqual((await f.db.query("SELECT relrowsecurity,relforcerowsecurity,(SELECT count(*)::integer FROM pg_policy WHERE polrelid=c.oid) AS policies FROM pg_class c WHERE oid='memory_control.deployment_identity'::regclass")).rows,[{relrowsecurity:false,relforcerowsecurity:false,policies:0}]);
 const acl=(await f.db.query("SELECT attname,attacl::text FROM pg_attribute WHERE attrelid='memory_control.deployment_identity'::regclass AND attnum>0 ORDER BY attnum")).rows;
 assert.equal(acl.length,5);for(const row of acl)assert.equal(row.attacl,'{memory_projection_owner=r/memory_owner}');
});

for(const reason of ['dependency_head_behind','newer_dependency_present','terminal_identity_denied','lifecycle_denied','target_deselected'])test('B2 reasons actual regional '+reason,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();
 await f.receive(p,{omit:reason==='dependency_head_behind'?['credential']:[]});await f.provision(p);
 if(reason==='dependency_head_behind')await f.applyHead(head('credential','credential:one',4));
 if(reason==='newer_dependency_present')await f.applyHead(head('credential','credential:one',8));
 if(['terminal_identity_denied','lifecycle_denied'].includes(reason))await f.applyHead(head('subject',issuer+'\nalice',8),{type:'subject-lifecycle',subject:'alice',state:reason==='terminal_identity_denied'?'deleted':'suspended',occurredAtMs:await f.now()});
 if(reason==='target_deselected')await f.applyHead(head('target',p.spaceId,8),{type:'entity-negative',entityKind:'target',entityId:p.spaceId,state:'removed',occurredAtMs:await f.now()});
 const receipt=await f.materialize(p);assert.equal(receipt.reason,reason);assert.equal(receipt.outcome,reason==='dependency_head_behind'?'dependency_pending':'snapshot_superseded');assert.equal((await f.materializationState()).generations.length,0);
});

for(const reason of ['retained_row_disposition_missing','retained_row_disposition_conflict','immutable_entity_conflict','provisioning_conflict'])test('B2 reasons actual retained '+reason,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.retain(p);await f.ready(p);
 if(reason==='retained_row_disposition_conflict')await f.approveRetained(p,{change(kind,row){if(kind==='credential')row.permission='read';}});
 if(reason==='immutable_entity_conflict')p.providerIdentities[0].createdAtMs=1;
 if(reason==='provisioning_conflict')await f.asRole('postgres',db=>db.exec("UPDATE memory_control.spaces SET message_limit=999 WHERE id='space:one'"));
 const receipt=await f.materialize(p);assert.equal(receipt.reason,reason);assert.equal(receipt.outcome,reason.endsWith('_missing')?'dependency_pending':'conflict');
});

test('B2 reasons a higher successful empty generation supersedes while higher reservation alone does not',async t=>{
 const f=await createMaterializationFixture(t),higher=await f.candidate({id:801,seq:2,empty:true});assert.equal((await f.materialize(higher)).reason,'empty_snapshot_applied');
 const lower=await f.candidate();assert.equal((await f.materialize(lower)).reason,'newer_snapshot_present');
});

for(const organization of [false,true])test('B2 preserve complete retained adoption organization='+organization,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate({organization});await f.retain(p);await f.ready(p);await f.approveRetained(p);const before=await f.positive();
 assert.equal((await f.materialize(p)).outcome,'applied');assert.deepEqual(await f.positive(),before);
 const state=await f.materializationState();for(const key of ['entities','providers','legacy'])for(const row of state[key]){assert.equal(row.origin,'retained_adoption');assert.ok(row.disposition_approval_id);}
 assert.equal(state.grants[0].can_erase,false);assert.equal(state.grants[0].can_retire,false);
});

test('B2 preserve later global credential source across Spaces and current regional values',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.retain(p);await f.ready(p);await f.approveRetained(p);await f.materialize(p);
 const first=await f.materializationState();
 await f.asRole('postgres',db=>db.exec("UPDATE memory_identity.credentials SET reauthenticated_at=456 WHERE id='credential:one'; UPDATE memory_identity.pat_space_grants SET can_erase=false WHERE credential_id='credential:one'"));
 const q=structuredClone(p);q.eventId=uuid(802);q.snapshotSeq=1;q.spaceId='space:two';q.spaces[0].id=q.spaceId;q.sourceRevision=10;q.credentials[0].permission='read';q.credentials[0].expiresAtMs+=1000;q.credentialPolicies[0].capabilities=['read'];
 q.grants[0].spaceId=q.spaceId;q.grants[0].canIngest=false;q.grants[0].expiresAtMs+=1000;q.grants[0].heads.credential=head('credential','credential:one',8);q.grants[0].heads.space=head('space',q.spaceId,9);q.grants[0].heads.target=head('target',q.spaceId,10);
 await f.receive(q);await f.provision(q,{id:9001});assert.equal((await f.materialize(q)).outcome,'applied');
 const after=await f.materializationState();assert.deepEqual(after.entities.find(v=>v.entity_kind==='credential'),first.entities.find(v=>v.entity_kind==='credential'));assert.equal(after.current[0].source_revision,8);
 assert.deepEqual(after.generations.find(v=>v.space_id===p.spaceId),first.generations[0]);assert.deepEqual(after.grants.find(v=>v.space_id===p.spaceId),first.grants[0]);
 assert.equal((await f.db.query("SELECT reauthenticated_at FROM memory_identity.credentials WHERE id='credential:one'")).rows[0].reauthenticated_at,456);
 const old=structuredClone(p);old.eventId=uuid(803);old.snapshotSeq=2;assert.equal((await f.materialize(old)).reason,'newer_dependency_present');
});

for(const table of ['memory_identity.accounts','memory_control.organizations','memory_identity.provider_identities','memory_identity.account_emails','memory_identity.memberships',
 'memory_identity.credentials','memory_control.spaces','memory_identity.pat_space_grants','memory_ops.space_usage',...Object.values(tables)])test('B2 guards actual worker rollback after '+table,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate({organization:true});await f.ready(p);const before=await f.dump();
 await f.asRole('postgres',db=>db.exec(`CREATE FUNCTION public.b2_fail_stage() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION USING ERRCODE='PZ901',MESSAGE='b2_injected_stage'; END$$; CREATE TRIGGER z_b2_fail AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.b2_fail_stage()`));
 await assert.rejects(()=>f.materialize(p),e=>e.code==='PZ901');assert.deepEqual(await f.dump(),before);
});

for(const [label,sql]of [
 ['missing current pointer',"ALTER TABLE memory_identity.identity_projection_mutable_fact_current DISABLE TRIGGER USER; DELETE FROM memory_identity.identity_projection_mutable_fact_current WHERE kind='credential'; ALTER TABLE memory_identity.identity_projection_mutable_fact_current ENABLE TRIGGER USER"],
 ['missing account provenance',"ALTER TABLE memory_identity.identity_projection_entities DISABLE TRIGGER USER; DELETE FROM memory_identity.identity_projection_entities WHERE entity_kind='account'; ALTER TABLE memory_identity.identity_projection_entities ENABLE TRIGGER USER"],
 ['missing provider provenance',"ALTER TABLE memory_identity.identity_projection_provider_entities DISABLE TRIGGER USER; DELETE FROM memory_identity.identity_projection_provider_entities; ALTER TABLE memory_identity.identity_projection_provider_entities ENABLE TRIGGER USER"]
])test('B2 preserve internal evidence '+label+' is unavailable',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);await f.asRole('postgres',db=>db.exec(sql));
 const q=structuredClone(p);q.eventId=uuid(804);q.snapshotSeq=2;const before=await f.dump();await assert.rejects(()=>f.materialize(q),unavailable);assert.deepEqual(await f.dump(),before);
});

test('B2 preserve equal source unequal fact conflicts before missing disposition',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);
 const q=structuredClone(p);q.eventId=uuid(805);q.snapshotSeq=2;q.credentials[0].expiresAtMs+=1;q.grants[0].expiresAtMs+=1;
 assert.equal((await f.materialize(q)).reason,'immutable_entity_conflict');
});

test('B2 guards statement no-op mutations and strict pointer advancement',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);const before=await f.dump();
 for(const[key,table]of Object.entries(tables)){
  await assert.rejects(()=>f.owner(db=>db.exec(`DELETE FROM ${table} WHERE false`)),e=>['55000','42501'].includes(e.code));
  if(!['state','current'].includes(key))await assert.rejects(()=>f.owner(db=>db.exec(`UPDATE ${table} SET ${key==='generations'?'grant_count=grant_count':key==='grants'?'can_ingest=can_ingest':key==='heads'||key==='facts'?'source_revision=source_revision':key==='entities'?'origin=origin':key==='providers'?'created_at=created_at':'origin=origin'} WHERE false`)),e=>['55000','42501'].includes(e.code));
 }
 await assert.rejects(()=>f.owner(db=>db.exec("UPDATE memory_ops.identity_projection_space_state SET current_sequence=current_sequence WHERE space_id='space:one'")),unavailable);
 await assert.rejects(()=>f.owner(db=>db.exec("UPDATE memory_identity.identity_projection_mutable_fact_current SET source_revision=source_revision WHERE kind='credential'")),unavailable);
 assert.deepEqual(await f.dump(),before);
});

test('B2 guards incomplete child cannot force completion before its generation and receipt',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);const before=await f.dump();
 await assert.rejects(()=>f.owner(async db=>{await db.exec('BEGIN');await f.begin(db,encode(p));await db.query('INSERT INTO memory_identity.identity_projection_source_facts(source_revision,first_snapshot_event_id) VALUES(1,$1)',[p.eventId]);await db.exec('SET CONSTRAINTS memory_identity.materialization_complete IMMEDIATE');}),unavailable);
 assert.deepEqual(await f.dump(),before);
});

test('B2 guards final actual assertion rejects late credential mutation after receipt',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);const before=await f.dump();
 await f.asRole('postgres',db=>db.exec("CREATE FUNCTION public.b2_late_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.outcome='applied' THEN UPDATE memory_identity.credentials SET permission='read' WHERE id='credential:one'; END IF; RETURN NULL; END$$; CREATE TRIGGER z_b2_late AFTER INSERT ON memory_ops.identity_projection_receipts FOR EACH ROW EXECUTE FUNCTION public.b2_late_change()"));
 await assert.rejects(()=>f.materialize(p),unavailable);assert.deepEqual(await f.dump(),before);
});

for(const change of [false,true])test('B2 guards deferred actual assertion after effective-role restoration change='+change,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);const before=await f.dump();
 const run=()=>f.owner(async db=>{await db.exec('BEGIN');const receipt=(await db.query('SELECT memory_identity.projection_v3_snapshot_materialize($1,$2) AS value',[encode(p),hash(encode(p))])).rows[0].value;
  if(change)await db.exec("UPDATE memory_identity.credentials SET permission='read' WHERE id='credential:one'");await db.exec('SET ROLE memory_projection_caller; COMMIT');return JSON.parse(receipt);});
 if(change){await assert.rejects(run,unavailable);assert.deepEqual(await f.dump(),before);}else assert.equal((await run()).outcome,'applied');
});

test('B2 guards deferred expiry rolls back checked worker result before COMMIT',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate({offset:-57000});await f.ready(p);const before=await f.dump();
 await assert.rejects(()=>f.owner(async db=>{await db.exec('BEGIN');const receipt=JSON.parse((await db.query('SELECT memory_identity.projection_v3_snapshot_materialize($1,$2) AS value',[encode(p),hash(encode(p))])).rows[0].value);assert.equal(receipt.outcome,'applied');
  await db.query('SELECT pg_sleep(greatest(0,($1-floor(extract(epoch FROM clock_timestamp())*1000))/1000.0)+0.02)',[p.lease.expiresAtMs]);await db.exec('SET ROLE memory_projection_caller; COMMIT');}),unavailable);
 assert.deepEqual(await f.dump(),before);
});

test('B2 guards final exact dependency set rejects an extra received head',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.applyHead(head('credential','credential:extra',8));const before=await f.dump();
 await f.asRole('postgres',db=>db.exec("CREATE FUNCTION public.b2_extra_head() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.outcome='applied' THEN INSERT INTO memory_identity.identity_projection_grant_heads(space_id,snapshot_seq,credential_id,kind,stream_key,source_revision) VALUES('space:one',1,'credential:one','credential','credential:extra',8); END IF; RETURN NULL; END$$; CREATE TRIGGER z_b2_extra AFTER INSERT ON memory_ops.identity_projection_receipts FOR EACH ROW EXECUTE FUNCTION public.b2_extra_head()"));
 await assert.rejects(()=>f.materialize(p),unavailable);assert.deepEqual(await f.dump(),before);
});

test('B2 bounded shared aliases extract one account grain and instrument actual calls',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();for(let i=0;i<80;i++)addIdentity(p,'s'+String(i).padStart(3,'0')+'x'.repeat(480));
 assert.ok(Buffer.byteLength(encode(p))>100000);assert.ok(Buffer.byteLength(encode(p))<=131072);await f.ready(p);await f.materialize(p);
 await f.asRole('postgres',db=>db.exec(`CREATE TABLE public.b2_calls(kind text NOT NULL); GRANT SELECT,INSERT ON public.b2_calls TO memory_projection_owner;
 ALTER FUNCTION memory_identity.projection_v3_snapshot_canonical(text) RENAME TO b2_canonical_original;
 ALTER FUNCTION memory_identity.projection_v3_snapshot_fact(jsonb,text,text) RENAME TO b2_fact_original;
 CREATE FUNCTION memory_identity.projection_v3_snapshot_canonical(text) RETURNS text LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$BEGIN INSERT INTO public.b2_calls VALUES('canonical'); RETURN memory_identity.b2_canonical_original($1); END$$;
 CREATE FUNCTION memory_identity.projection_v3_snapshot_fact(jsonb,text,text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$BEGIN INSERT INTO public.b2_calls VALUES('fact'); RETURN memory_identity.b2_fact_original($1,$2,$3); END$$;
 ALTER FUNCTION memory_identity.projection_v3_snapshot_canonical(text) OWNER TO memory_projection_owner; ALTER FUNCTION memory_identity.projection_v3_snapshot_fact(jsonb,text,text) OWNER TO memory_projection_owner;`));
 const plan=(await f.owner(db=>db.query('SELECT memory_identity.projection_v3_snapshot_plan($1) AS value',[p.eventId]))).rows[0].value;
 assert.equal(Object.keys(plan.grains).length,3);assert.equal(plan.grains['subject:account:one'].providerIdentities.length,81);
 assert.deepEqual((await f.db.query('SELECT kind,count(*)::integer AS n FROM public.b2_calls GROUP BY kind ORDER BY kind')).rows,[{kind:'canonical',n:1},{kind:'fact',n:3}]);
 assert.equal(plan.metrics.validations,1);assert.equal(plan.metrics.bodyLoads,1);assert.equal(plan.metrics.grainExtractions,3);
 const sizes={wireBytes:Buffer.byteLength(encode(p)),planJsonBytes:Buffer.byteLength(JSON.stringify(plan)),...plan.metrics};console.log('B2 bounded aliases '+JSON.stringify(sizes));
});

test('B2 bounded prior credential policies are reduced to scalar comparisons',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();p.credentialPolicies[0].spaceIds=[p.spaceId,...Array.from({length:49},(_,i)=>'old-scope-'+String(i).padStart(2,'0')+'x'.repeat(110))].sort();
 await f.ready(p);await f.materialize(p);const q=structuredClone(p);q.eventId=uuid(820);q.snapshotSeq=2;q.sourceRevision=8;q.credentials[0].permission='read';q.credentialPolicies[0]={credentialId:q.credentials[0].id,capabilities:['read'],spaceIds:null};q.grants[0].canIngest=false;q.grants[0].heads.credential=head('credential','credential:one',8);await f.receive(q);
 const plan=await f.owner(async db=>{await db.exec('BEGIN');await f.begin(db,encode(q));const result=(await db.query('SELECT memory_identity.projection_v3_snapshot_plan($1) AS value',[q.eventId])).rows[0].value;await db.exec('ROLLBACK');return result;});
 assert.equal(JSON.stringify(plan).includes('old-scope-'),false);assert.deepEqual(Object.keys(plan.currentComparisons['credential:credential:one']).sort(),['actualMatchesCurrent','candidateOrder','firstSnapshotEventId','sourceRevision']);
 assert.equal(plan.currentComparisons['credential:credential:one'].actualMatchesCurrent,true);assert.equal(plan.metrics.bodyLoads,2);assert.equal(plan.metrics.validations,2);assert.equal(plan.metrics.grainExtractions,6);
 assert.equal((await f.materialize(q)).outcome,'applied');console.log('B2 bounded prior '+JSON.stringify({priorWireBytes:Buffer.byteLength(encode(p)),candidateWireBytes:Buffer.byteLength(encode(q)),planJsonBytes:Buffer.byteLength(JSON.stringify(plan)),...plan.metrics}));
});

test('B2 bounded incompatible retained Space policy stays out of returned plan',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate(),retained=structuredClone(p);retained.spaces[0].policy={unboundedLegacy:'z'.repeat(300000)};await f.retain(retained);await f.receive(p);
 const receipt=await f.materialize(p);assert.equal(receipt.reason,'immutable_entity_conflict');
 const plan=(await f.owner(db=>db.query('SELECT memory_identity.projection_v3_snapshot_plan($1) AS value',[p.eventId]))).rows[0].value;
 assert.equal(plan.rows.find(v=>v.kind==='space').actual.data_policy,null);assert.equal(JSON.stringify(plan).includes('unboundedLegacy'),false);assert.ok(Buffer.byteLength(JSON.stringify(plan))<30000);
});

for(const advance of [false,true])test('B2 preserve provider addition requires every subject fact advance='+advance,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);const q=structuredClone(p);q.eventId=uuid(830);q.snapshotSeq=2;addIdentity(q,'bob');
 if(advance){q.grants[0].heads.subjects[0]=head('subject',issuer+'\nalice',++q.sourceRevision);}
 await f.receive(q);const receipt=await f.materialize(q);assert.equal(receipt.reason,advance?'snapshot_applied':'immutable_entity_conflict');
 assert.equal((await f.db.query("SELECT count(*)::integer AS n FROM memory_identity.provider_identities WHERE account_id='account:one'")).rows[0].n,advance?2:1);
});

for(const foreign of [false,true])test('B2 preserve complete provider set rejects extra issuer foreign='+foreign,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.retain(p);await f.ready(p);
 await f.migrationOwner(db=>db.query('INSERT INTO memory_identity.provider_identities(issuer,subject,account_id,created_at) VALUES($1,$2,$3,0)',[foreign?'https://foreign.example':issuer,'extra','account:one']));
 assert.equal((await f.materialize(p)).reason,'immutable_entity_conflict');
});

test('B2 reasons real negative timestamp alone is denial with structural ties retained',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.retain(p);await f.ready(p);await f.approveRetained(p);
 await f.asRole('postgres',db=>db.exec("UPDATE memory_identity.credentials SET revoked_at=1 WHERE id='credential:one'"));
 assert.equal((await f.materialize(p)).reason,'terminal_identity_denied');
 const q=structuredClone(p);q.eventId=uuid(840);q.snapshotSeq=2;q.credentials[0].tokenDigest='a'.repeat(64);assert.equal((await f.materialize(q)).reason,'immutable_entity_conflict');
});

test('B2 install hostile quoted defaults close only new ACLs and preserve old functions and triggers',async t=>{
 const f=await createMaterializationFixture(t,{install:false});
 await f.asRole('postgres',db=>db.exec(`CREATE ROLE "B2 quoted"" role" NOLOGIN NOINHERIT;
 ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner IN SCHEMA memory_identity,memory_ops GRANT SELECT,INSERT ON TABLES TO "B2 quoted"" role" WITH GRANT OPTION;
 ALTER DEFAULT PRIVILEGES FOR ROLE memory_projection_owner IN SCHEMA memory_identity,memory_ops GRANT EXECUTE ON FUNCTIONS TO "B2 quoted"" role" WITH GRANT OPTION;
 ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner IN SCHEMA memory_identity,memory_ops GRANT USAGE ON TYPES TO "B2 quoted"" role";`));
 const oldFunctions=(await f.db.query("SELECT p.oid,p.proowner,p.proacl::text,p.prosrc,p.prosecdef,p.provolatile,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'memory_%' ORDER BY p.oid")).rows;
 const oldTriggers=(await f.db.query("SELECT t.oid,t.tgrelid,pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_%' ORDER BY t.oid")).rows;
 const defaults=(await f.db.query('SELECT to_jsonb(x) AS value FROM pg_default_acl x ORDER BY oid')).rows,roles=(await f.db.query('SELECT to_jsonb(x) AS value FROM pg_auth_members x ORDER BY oid')).rows;
 await f.installMaterialization();
 assert.deepEqual((await f.db.query('SELECT p.oid,p.proowner,p.proacl::text,p.prosrc,p.prosecdef,p.provolatile,p.proconfig FROM pg_proc p WHERE p.oid=ANY($1::oid[]) ORDER BY p.oid',[oldFunctions.map(v=>v.oid)])).rows,oldFunctions);
 assert.deepEqual((await f.db.query('SELECT t.oid,t.tgrelid,pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE t.oid=ANY($1::oid[]) ORDER BY t.oid',[oldTriggers.map(v=>v.oid)])).rows,oldTriggers);
 assert.deepEqual((await f.db.query('SELECT to_jsonb(x) AS value FROM pg_default_acl x ORDER BY oid')).rows,defaults);assert.deepEqual((await f.db.query('SELECT to_jsonb(x) AS value FROM pg_auth_members x ORDER BY oid')).rows,roles);
 for(const table of Object.values(tables))assert.equal((await f.db.query("SELECT has_table_privilege($1,$2,'SELECT') AS allowed",['B2 quoted" role',table])).rows[0].allowed,false);
 for(const name of functions)assert.equal((await f.db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",['B2 quoted" role',name])).rows[0].allowed,false);
 const added=(await f.db.query("SELECT t.tgname,t.tgrelid::regclass::text AS parent,t.tgisinternal,p.proname,con.conname,con.conrelid::regclass::text AS child,con.confrelid::regclass::text AS expected_parent,con.confdeltype,con.confupdtype FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid LEFT JOIN pg_constraint con ON con.oid=t.tgconstraint WHERE t.tgrelid=ANY($1::oid[]) AND NOT(t.oid=ANY($2::oid[])) ORDER BY t.oid",[[...new Set(oldTriggers.map(v=>v.tgrelid))],oldTriggers.map(v=>v.oid)])).rows;
 const foreignKeys={materialization_generations_reservation_fk:[tables.generations,'memory_ops.identity_projection_snapshot_reservations'],materialization_generations_provision_fk:[tables.generations,'memory_ops.identity_projection_space_provisioning'],
  materialization_grants_credential_fk:[tables.grants,'memory_identity.credentials'],materialization_grants_legacy_fk:[tables.grants,'memory_identity.pat_space_grants'],materialization_grant_heads_source_fk:[tables.heads,'memory_ops.identity_projection_source_heads'],
  materialization_source_facts_source_fk:[tables.facts,'memory_ops.identity_projection_source_heads'],materialization_source_facts_event_fk:[tables.facts,'memory_ops.identity_projection_events'],materialization_mutable_current_source_fk:[tables.current,'memory_ops.identity_projection_source_heads'],
  materialization_entities_event_fk:[tables.entities,'memory_ops.identity_projection_events'],materialization_entities_approval_fk:[tables.entities,'memory_identity.identity_projection_retained_dispositions'],
  materialization_provider_entities_provider_fk:[tables.providers,'memory_identity.provider_identities'],materialization_provider_entities_event_fk:[tables.providers,'memory_ops.identity_projection_events'],materialization_provider_entities_approval_fk:[tables.providers,'memory_identity.identity_projection_retained_dispositions'],
  materialization_legacy_entities_legacy_fk:[tables.legacy,'memory_identity.pat_space_grants'],materialization_legacy_entities_credential_fk:[tables.legacy,'memory_identity.credentials'],materialization_legacy_entities_event_fk:[tables.legacy,'memory_ops.identity_projection_events'],materialization_legacy_entities_approval_fk:[tables.legacy,'memory_identity.identity_projection_retained_dispositions']};
 const seen=new Map();for(const row of added){if(row.tgisinternal){assert.deepEqual([row.child,row.parent],foreignKeys[row.conname]);assert.equal(row.parent,row.expected_parent);assert.equal(row.confdeltype,'a');assert.equal(row.confupdtype,'a');assert.ok(['RI_FKey_noaction_del','RI_FKey_noaction_upd'].includes(row.proname));seen.set(row.conname,(seen.get(row.conname)??0)+1);}else{assert.equal(row.parent,'memory_ops.identity_projection_receipts');assert.ok(['materialization_receipt_observed','materialization_receipt_complete'].includes(row.tgname));}}
 assert.deepEqual(Object.fromEntries([...seen].sort()),Object.fromEntries(Object.keys(foreignKeys).sort().map(name=>[name,2])));assert.equal(added.filter(v=>!v.tgisinternal).length,2);
});

test('B2 preserve later membership source changes only role and expiry',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate({organization:true});await f.retain(p);await f.ready(p);await f.approveRetained(p);await f.materialize(p);const before=await f.materializationState();
 const q=structuredClone(p);q.eventId=uuid(850);q.snapshotSeq=2;q.sourceRevision=8;q.memberships[0].role='member';q.memberships[0].expiresAtMs-=1000;q.grants[0].canIngest=false;q.grants[0].expiresAtMs-=1000;q.grants[0].heads.membership=head('membership','membership:one',8);await f.receive(q);
 assert.equal((await f.materialize(q)).outcome,'applied');const after=await f.materializationState();assert.deepEqual(after.entities.find(v=>v.entity_kind==='membership'),before.entities.find(v=>v.entity_kind==='membership'));
 assert.equal(after.current.find(v=>v.kind==='membership').source_revision,8);assert.equal((await f.db.query("SELECT role FROM memory_identity.memberships WHERE id='membership:one'")).rows[0].role,'member');
 const stale=structuredClone(p);stale.eventId=uuid(851);stale.snapshotSeq=3;assert.equal((await f.materialize(stale)).reason,'newer_dependency_present');
});

test('B2 guards provider provenance cannot borrow an older same-account snapshot',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);const before=await f.dump();
 await assert.rejects(()=>f.owner(async db=>{await db.exec('BEGIN');await db.query('INSERT INTO memory_identity.provider_identities(issuer,subject,account_id,created_at) VALUES($1,$2,$3,0)',[issuer,'unsigned-provider','account:one']);
  await db.query("INSERT INTO memory_identity.identity_projection_provider_entities(issuer,subject,account_id,created_at,origin,first_snapshot_event_id,disposition_approval_id,first_binding) VALUES($1,$2,$3,0,'creation',$4,NULL,$5)",[issuer,'unsigned-provider','account:one',p.eventId,{issuer,subject:'unsigned-provider',account_id:'account:one',created_at:0}]);await db.exec('COMMIT');}),unavailable);
 assert.deepEqual(await f.dump(),before);
});

test('B2 bounded actual indexed lookups with five thousand unrelated source streams',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);
 await f.owner(db=>db.exec(`INSERT INTO memory_ops.identity_projection_source_heads(source_revision,source_event_id,kind,stream_key,source_sha256,effect)
 SELECT n,('00000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,'credential','unrelated:'||n,repeat('a',64),'{"type":"entity-head","disposition":"present"}'::jsonb FROM generate_series(1000,5999) n;
 INSERT INTO memory_ops.identity_projection_heads(kind,stream_key,source_revision) SELECT kind,stream_key,source_revision FROM memory_ops.identity_projection_source_heads WHERE source_revision BETWEEN 1000 AND 5999;`));
 await f.asRole('postgres',db=>db.exec('ANALYZE memory_ops.identity_projection_source_heads; ANALYZE memory_ops.identity_projection_heads; ANALYZE memory_identity.provider_identities'));
 const cases=[['source revision','SELECT * FROM memory_ops.identity_projection_source_heads WHERE source_revision=5','identity_projection_source_heads_pkey'],
  ['source UUID',`SELECT * FROM memory_ops.identity_projection_source_heads WHERE source_event_id='${p.grants[0].heads.credential.eventId}'`,'identity_projection_source_heads_source_event_id_key'],
  ['current stream',"SELECT * FROM memory_ops.identity_projection_heads WHERE kind='credential' AND stream_key='credential:one'",'identity_projection_heads_pkey']];
 for(const[label,sql,index]of cases){const plan=(await f.owner(db=>db.query('EXPLAIN (FORMAT JSON) '+sql))).rows[0]['QUERY PLAN'];const text=JSON.stringify(plan);assert.ok(text.includes(index),label+': '+text);console.log('B2 index '+label+' '+text);}
 const plan=(await f.owner(db=>db.query('SELECT memory_identity.projection_v3_snapshot_plan($1) AS value',[p.eventId]))).rows[0].value;assert.equal(plan.metrics.bodyLoads,1);assert.equal(plan.metrics.grainExtractions,3);
});

test('B2 reasons explicit lifecycle survives generic heads and target removal is reversible',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.applyHead(head('subject',issuer+'\nalice',8),{type:'subject-lifecycle',subject:'alice',state:'suspended',occurredAtMs:await f.now()});await f.applyHead(head('subject',issuer+'\nalice',9));
 const q=structuredClone(p);q.eventId=uuid(860);q.sourceRevision=9;q.grants[0].heads.subjects=[head('subject',issuer+'\nalice',9)];assert.equal((await f.materialize(q)).reason,'lifecycle_denied');
 await f.applyHead(head('subject',issuer+'\nalice',10),{type:'subject-lifecycle',subject:'alice',state:'resumed',occurredAtMs:await f.now()});await f.applyHead(head('target',p.spaceId,11),{type:'entity-negative',entityKind:'target',entityId:p.spaceId,state:'removed',occurredAtMs:await f.now()});
 const removed=structuredClone(p);removed.eventId=uuid(861);removed.snapshotSeq=2;removed.sourceRevision=11;removed.grants[0].heads.subjects=[head('subject',issuer+'\nalice',10)];removed.grants[0].heads.target=head('target',p.spaceId,11);assert.equal((await f.materialize(removed)).reason,'target_deselected');
 await f.applyHead(head('target',p.spaceId,12));const restored=structuredClone(removed);restored.eventId=uuid(862);restored.snapshotSeq=3;restored.sourceRevision=12;restored.grants[0].heads.target=head('target',p.spaceId,12);assert.equal((await f.materialize(restored)).outcome,'applied');
});

test('B2 preserve empty omission does not revoke and later same-fact reappearance applies',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);const positive=await f.positive();
 const empty=await f.candidate({empty:true,id:870,seq:2});assert.equal((await f.materialize(empty)).reason,'empty_snapshot_applied');assert.deepEqual(await f.positive(),positive);
 const again=structuredClone(p);again.eventId=uuid(871);again.snapshotSeq=3;assert.equal((await f.materialize(again)).outcome,'applied');assert.deepEqual(await f.positive(),positive);
});

for(const [outcome,reason,empty]of [['conflict','immutable_entity_conflict',false],['snapshot_superseded','newer_snapshot_present',false],['applied','snapshot_applied',false],['applied','empty_snapshot_applied',true]])test('B2 install rejects prior A '+reason+' history',async t=>{
 const f=await createMaterializationFixture(t,{install:false}),p=await f.candidate({empty});await f.decide(p,outcome,reason);const before=await f.ledger();await assert.rejects(()=>f.installMaterialization(),unavailable);assert.deepEqual(await f.ledger(),before);
});

for(const table of ['memory_identity.memberships','memory_identity.credentials','memory_identity.pat_space_grants'])test('B2 guards actual worker rollback after permitted UPDATE '+table,async t=>{
 const organization=table==='memory_identity.memberships',f=await createMaterializationFixture(t),p=await f.candidate({organization});await f.ready(p);await f.materialize(p);
 const q=structuredClone(p);q.eventId=uuid(880);q.snapshotSeq=2;q.sourceRevision=8;q.grants[0].canIngest=false;
 if(organization){q.memberships[0].role='member';q.grants[0].heads.membership=head('membership','membership:one',8);}else{q.credentials[0].permission='read';q.credentialPolicies[0].capabilities=['read'];q.grants[0].heads.credential=head('credential','credential:one',8);}
 await f.receive(q);const before=await f.dump();await f.asRole('postgres',db=>db.exec(`CREATE FUNCTION public.b2_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION USING ERRCODE='PZ902',MESSAGE='b2_injected_update'; END$$; CREATE TRIGGER z_b2_fail_update AFTER UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.b2_fail_update()`));
 await assert.rejects(()=>f.materialize(q),e=>e.code==='PZ902');assert.deepEqual(await f.dump(),before);
});

test('B2 guards new usage must remain four exact zeros after INSERT triggers',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);const before=await f.dump();
 await f.asRole('postgres',db=>db.exec("CREATE FUNCTION public.b2_mutate_new_usage() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.source_bytes:=1; NEW.message_count:=1; RETURN NEW; END$$; CREATE TRIGGER b2_mutate_new_usage BEFORE INSERT ON memory_ops.space_usage FOR EACH ROW EXECUTE FUNCTION public.b2_mutate_new_usage()"));
 await assert.rejects(()=>f.materialize(p),unavailable);assert.deepEqual(await f.dump(),before);
});

for(const retained of [false,true])test('B2 guards usage preservation survives later receipt trigger retained='+retained,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();if(retained)await f.retain(p);await f.ready(p);if(retained)await f.approveRetained(p);const before=await f.dump();
 await f.asRole('postgres',db=>db.exec("CREATE FUNCTION public.b2_late_usage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$BEGIN IF NEW.outcome='applied' THEN UPDATE memory_ops.space_usage SET source_bytes=source_bytes+1,message_count=message_count+1 WHERE space_id='space:one'; END IF; RETURN NULL; END$$; CREATE TRIGGER z_b2_late_usage AFTER INSERT ON memory_ops.identity_projection_receipts FOR EACH ROW EXECUTE FUNCTION public.b2_late_usage()"));
 await assert.rejects(()=>f.materialize(p),unavailable);assert.deepEqual(await f.dump(),before);
});

test('B2 guards deferred assertion requires new-Space zero usage after role restoration',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);const before=await f.dump();
 await assert.rejects(()=>f.owner(async db=>{await db.exec('BEGIN');await db.query('SELECT memory_identity.projection_v3_snapshot_materialize($1,$2)',[encode(p),hash(encode(p))]);
  await db.exec("RESET ROLE; UPDATE memory_ops.space_usage SET source_bytes=1,message_count=1 WHERE space_id='space:one'; SET ROLE memory_projection_caller; COMMIT");}),unavailable);assert.deepEqual(await f.dump(),before);
});

for(const retained of [false,true])for(const field of ['reauthenticated_at','can_erase','can_retire'])test('B2 guards late preservation '+field+' retained='+retained,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();if(retained)await f.retain(p);await f.ready(p);if(retained)await f.approveRetained(p);const before=await f.dump();
 const credential=field==='reauthenticated_at',table=credential?'memory_identity.credentials':'memory_identity.pat_space_grants',allowedField=credential?'permission':'can_search';
 const where=credential?"id='credential:one'":"credential_id='credential:one' AND space_id='space:one'",rewrite=credential?'NEW.reauthenticated_at:=987654;':`NEW.${field}:=NOT NEW.${field};`;
 assert.equal((await f.db.query("SELECT has_column_privilege('memory_projection_owner',$1,$2,'UPDATE') AS allowed",[table,field])).rows[0].allowed,false);
 await f.asRole('postgres',db=>db.exec(`CREATE FUNCTION public.b2_preservation_rewrite() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN ${rewrite} RETURN NEW; END$$;
 CREATE TRIGGER b2_preservation_rewrite BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.b2_preservation_rewrite();
 CREATE FUNCTION public.b2_late_preservation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN IF NEW.outcome='applied' THEN UPDATE ${table} SET ${allowedField}=${allowedField} WHERE ${where}; END IF; RETURN NULL; END$$;
 CREATE TRIGGER z_b2_late_preservation AFTER INSERT ON memory_ops.identity_projection_receipts FOR EACH ROW EXECUTE FUNCTION public.b2_late_preservation();`));
 let failure,receipt;try{receipt=await f.materialize(p);}catch(error){failure=error;}
 if(!failure)console.log(JSON.stringify({field,retained,unexpectedReceipt:receipt.reason,before,after:await f.dump()}));
 assert.ok(failure&&unavailable(failure),'Late '+field+' must reject with PP004; got '+(failure?.code??receipt?.reason));assert.deepEqual(await f.dump(),before);
});

for(const field of ['reauthenticated_at','can_erase','can_retire'])test('B2 guards deferred creation preservation '+field+' after role restoration',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);const before=await f.dump();
 const credential=field==='reauthenticated_at',table=credential?'memory_identity.credentials':'memory_identity.pat_space_grants';
 const where=credential?"id='credential:one'":"credential_id='credential:one' AND space_id='space:one'",value=credential?'987654':'true';
 await assert.rejects(()=>f.owner(async db=>{await db.exec('BEGIN');await db.query('SELECT memory_identity.projection_v3_snapshot_materialize($1,$2)',[encode(p),hash(encode(p))]);
  await db.exec(`RESET ROLE; UPDATE ${table} SET ${field}=${value} WHERE ${where}; SET ROLE memory_projection_caller; COMMIT`);}),unavailable);assert.deepEqual(await f.dump(),before);
});

test('B2 guards completed generation rejects an extra valid head in a later transaction',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);assert.equal((await f.materialize(p)).reason,'snapshot_applied');
 await f.applyHead(head('credential','credential:unsigned',8));const before=await f.dump();
 await assert.rejects(()=>f.owner(async db=>{await db.exec("BEGIN; INSERT INTO memory_identity.identity_projection_grant_heads(space_id,snapshot_seq,credential_id,kind,stream_key,source_revision) VALUES('space:one',1,'credential:one','credential','credential:unsigned',8); COMMIT");}),unavailable);
 assert.deepEqual(await f.dump(),before);
});

test('B2 guards completed generation rejects an extra valid grant in a later transaction',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);assert.equal((await f.materialize(p)).reason,'snapshot_applied');
 await f.owner(db=>db.exec("INSERT INTO memory_identity.credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,reauthenticated_at,revoked_at,permission) SELECT 'credential:unsigned',account_id,membership_id,email_id,kind,repeat('f',64),expires_at,reauthenticated_at,revoked_at,permission FROM memory_identity.credentials WHERE id='credential:one'; INSERT INTO memory_identity.pat_space_grants(credential_id,account_id,space_id,can_ingest,can_search,expires_at,revoked_at,can_erase,can_retire) SELECT 'credential:unsigned',account_id,space_id,can_ingest,can_search,expires_at,revoked_at,can_erase,can_retire FROM memory_identity.pat_space_grants WHERE credential_id='credential:one'"));const before=await f.dump();
 const insert="INSERT INTO memory_identity.identity_projection_grants(space_id,snapshot_seq,credential_id,account_id,provenance,credential_policy,can_ingest,can_search,can_erase,can_retire,expires_at_ms,revoked_at_ms) SELECT space_id,snapshot_seq,'credential:unsigned',account_id,provenance,jsonb_set(credential_policy,'{credentialId}',to_jsonb('credential:unsigned'::text)),can_ingest,can_search,can_erase,can_retire,expires_at_ms,revoked_at_ms FROM memory_identity.identity_projection_grants WHERE credential_id='credential:one'";
 // This disposable rollback proves ordinary FK/CHECK validity; only the named B2 row seal is disabled.
 await f.asRole('postgres',async db=>{await db.exec('BEGIN; ALTER TABLE memory_identity.identity_projection_grants DISABLE TRIGGER materialization_row; SET ROLE memory_projection_owner');
  assert.equal((await db.exec(insert))[0].affectedRows,1);await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM memory_identity.identity_projection_grants WHERE credential_id='credential:unsigned'")).rows[0].n,1);
  await db.exec('RESET ROLE; ROLLBACK');});assert.deepEqual(await f.dump(),before);
 assert.equal((await f.db.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='memory_identity.identity_projection_grants'::regclass AND tgname='materialization_row'")).rows[0].tgenabled,'O');
 await assert.rejects(()=>f.owner(db=>db.exec('BEGIN; '+insert+'; COMMIT')),unavailable);
 assert.deepEqual(await f.dump(),before);
});

for(const table of Object.values(tables))test('B2 guards completed event cannot repair removed materialization row '+table,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);assert.equal((await f.materialize(p)).reason,'snapshot_applied');
 const row=(await f.db.query(`SELECT to_jsonb(x) AS row FROM ${table} x ORDER BY to_jsonb(x)::text LIMIT 1`)).rows[0].row;
 // Privileged fixture corruption supplies an otherwise exact missing child, not a supported owner mutation.
 await f.asRole('postgres',async db=>{await db.exec(`ALTER TABLE ${table} DISABLE TRIGGER ALL`);try{assert.equal((await db.query(`DELETE FROM ${table} x WHERE to_jsonb(x)=$1`,[row])).affectedRows,1);}finally{await db.exec(`ALTER TABLE ${table} ENABLE TRIGGER ALL`);}});
 const before=await f.dump();await assert.rejects(()=>f.owner(async db=>{await db.exec('BEGIN');await db.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1)`,[row]);await db.exec('COMMIT');}),unavailable);
 assert.deepEqual(await f.dump(),before);
});

test('B2 guards completed event allows only existing equal mutable-current INSERT conflict without mutation',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);const before=await f.dump();
 const result=await f.owner(db=>db.exec("INSERT INTO memory_identity.identity_projection_mutable_fact_current(kind,entity_id,source_revision) SELECT kind,entity_id,source_revision FROM memory_identity.identity_projection_mutable_fact_current ON CONFLICT(kind,entity_id) DO UPDATE SET source_revision=EXCLUDED.source_revision WHERE memory_identity.identity_projection_mutable_fact_current.source_revision<EXCLUDED.source_revision"));
 assert.equal(result[0].affectedRows,0);assert.deepEqual(await f.dump(),before);
});

test('B2 preserve creation defaults do not overwrite legitimate regional values in later generations',async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);
 await f.asRole('postgres',db=>db.exec("UPDATE memory_identity.credentials SET reauthenticated_at=456 WHERE id='credential:one'; UPDATE memory_identity.pat_space_grants SET can_erase=true,can_retire=true WHERE credential_id='credential:one'; UPDATE memory_ops.space_usage SET source_bytes=3000000,message_count=2000 WHERE space_id='space:one'"));
 const before=await f.positive(),q=structuredClone(p);q.eventId=uuid(801);q.snapshotSeq=2;
 assert.equal((await f.materialize(q)).reason,'snapshot_applied');assert.deepEqual(await f.positive(),before);
});

for(const kind of ['state','current'])test('B2 guards completed event cannot repair a regressed pointer by UPDATE '+kind,async t=>{
 const f=await createMaterializationFixture(t),p=await f.candidate();await f.ready(p);await f.materialize(p);
 const first=(await f.materializationState())[kind][0],q=structuredClone(p);q.eventId=uuid(801);q.snapshotSeq=2;q.sourceRevision=8;q.grants[0].heads.credential=head('credential','credential:one',8);
 await f.receive(q);await f.materialize(q);const latest=(await f.materializationState())[kind][0],table=tables[kind],column=kind==='state'?'current_sequence':'source_revision';assert.ok(latest[column]>first[column]);
 await f.asRole('postgres',async db=>{await db.exec(`ALTER TABLE ${table} DISABLE TRIGGER ALL`);try{await db.query(`UPDATE ${table} SET ${column}=$1`,[first[column]]);}finally{await db.exec(`ALTER TABLE ${table} ENABLE TRIGGER ALL`);}});
 const before=await f.dump();await assert.rejects(()=>f.owner(db=>db.query(`UPDATE ${table} SET ${column}=$1`,[latest[column]])),unavailable);assert.deepEqual(await f.dump(),before);
});

for(const role of ['memory_projection_owner','memory_projection_caller'])for(const indirect of [false,true])for(const mode of ['SET','INHERIT','ADMIN'])test('B2 install outgoing role drift '+role+' indirect='+indirect+' option='+mode,async t=>{
 const f=await createMaterializationFixture(t,{install:false});
 const options=`INHERIT ${mode==='INHERIT'},SET ${mode==='SET'},ADMIN ${mode==='ADMIN'}`;
 await f.asRole('postgres',db=>db.exec(indirect?`CREATE ROLE b2_outgoing_bridge NOLOGIN NOINHERIT; GRANT memory_lifecycle TO b2_outgoing_bridge WITH ${options}; GRANT b2_outgoing_bridge TO ${role} WITH ${options}`:`GRANT ${role==='memory_projection_owner'?'memory_lifecycle':'memory_commands'} TO ${role} WITH ${options}`));
 const catalog=async()=>({members:(await f.db.query('SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),\'[]\') AS rows FROM pg_auth_members x')).rows[0].rows,
  defaults:(await f.db.query('SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),\'[]\') AS rows FROM pg_default_acl x')).rows[0].rows,
  roles:(await f.db.query('SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles ORDER BY oid')).rows});
 const before=await catalog();await assert.rejects(()=>f.installMaterialization(),unavailable);assert.deepEqual(await catalog(),before);
 for(const table of Object.values(tables))assert.equal((await f.db.query('SELECT to_regclass($1) AS oid',[table])).rows[0].oid,null);
});

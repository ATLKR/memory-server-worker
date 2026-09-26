import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {fixture,at} from './db-sqlite.mjs';
import {WorkspaceService} from '../../src/workspace.ts';
import {Admin} from '../../src/release/admin.ts';
import {createSeoulProjectionCapture} from '../../src/release/seoul-projection-capture.ts';
import {createSeoulProjectionPreparer} from '../../src/release/seoul-projection-preparer.ts';
import {createSeoulProjectionTargetWriter} from '../../src/release/seoul-projection-target-writer.ts';
import {createSeoulProjectionSnapshotStore} from '../../src/release/seoul-projection-snapshot-store.ts';
import {decodeSeoulAuthoritySnapshot} from '../../src/release/seoul-projection-snapshot-codec.ts';
import {createDurableDatabase} from '../../src/deprecated-durable-sql/client.ts';
import {SqlDatabaseEngine} from '../../src/deprecated-durable-sql/engine.ts';
import {digest} from '../../src/release/util.ts';

const issuer='https://auth-api.allen.company';
const source=new URL('../../seoul-projection-publication-schema.sql',import.meta.url);
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const principal=(subject,extra={})=>({issuer,subject,issuedAt:at,expiresAt:at+900000,permission:'write',...extra});
const target=(spaceId,selected,expectedRevision=null,n=900)=>({commandId:uuid(n),spaceId,expectedRevision,selected,operatorReference:'release-validation'});
const rows=async (f,table)=>(await f.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
const pending=f=>rows(f,'release_seoul_authority_heads').filter(h=>h.payload_sha256===null);

async function prepareAll(f){
 for(const r of (await f.raw.prepare('SELECT revision FROM release_seoul_authority_changes ORDER BY revision').all())){
  const result=await f.preparer.prepare(r.revision);
  assert.ok(result.status==='prepared'||result.status==='already_prepared','prepare '+r.revision+': '+JSON.stringify(result));
 }
 assert.equal(pending(f).length,0,'heads remain pending');
}
async function applyTarget(f,spaceId,selected=true,expectedRevision=null,n=900){
 const result=await f.writer.setTarget(target(spaceId,selected,expectedRevision,n));
 assert.ok(result.status==='committed'||result.status==='already_committed','setTarget: '+JSON.stringify(result));
}
async function signInCarol(f){
 const result=await f.workspace.signIn(principal('carol',{emailVerified:true,email:'carol@example.com'}));
 (await f.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE account_id=? AND kind='session'").run(at,result.accountId));
 const space=(await f.raw.prepare('SELECT id FROM spaces WHERE account_id=?').get(result.accountId)).id;
 const emailId=(await f.raw.prepare("SELECT id FROM account_emails WHERE account_id=? AND address='carol@example.com'").get(result.accountId)).id;
 return {...result,space,emailId};
}
async function personalSpace(f){
 const carol=await signInCarol(f);await applyTarget(f,carol.space);
 const key=await f.admin.issueKey(carol.token,{label:'Seoul key',capabilities:['read','create'],spaceIds:[carol.space],expiresInDays:1});
 await prepareAll(f);return{carol,key};
}
async function orgSpace(f){
 const carol=await signInCarol(f);
 const org=await f.workspace.createOrganization(carol.token,{name:'Seoul org',emailId:carol.emailId});
 await applyTarget(f,org.spaceId);
 const k1=await f.admin.issueKey(carol.token,{label:'first',organizationId:org.id,capabilities:['read','create'],spaceIds:[org.spaceId],expiresInDays:1});
 const k2=await f.admin.issueKey(carol.token,{label:'second',organizationId:org.id,capabilities:['read'],spaceIds:[org.spaceId],expiresInDays:1});
 await prepareAll(f);
 const membership=(await f.raw.prepare('SELECT * FROM memberships WHERE organization_id=?').get(org.id));
 return{carol,org,membership,k1,k2};
}
async function clean(f){
 assert.equal(rows(f,'release_seoul_snapshot_stage').length,0,'snapshot stage retained');
 assert.deepEqual((await f.raw.prepare('PRAGMA foreign_key_check').all()),[],'foreign key check');
}

async function setup(t,{recursive='ON',migrations='0036'}={}){
 const f=await fixture();t.after(()=>f.db.close());f.raw=f.db.raw;
 const last=Number(migrations);
 const files=readdirSync(new URL('../../migrations/',import.meta.url)).filter(n=>{const v=Number(n.slice(0,4));return v>=26&&v<=last;}).sort();
 for(const file of files)(await f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8')));
 assert.equal((await f.raw.prepare('SELECT version FROM release_meta').get()).version,last);
 if(last>=36){const migration=readFileSync(new URL('../../migrations/0036_seoul-projection-publication-schema.sql',import.meta.url),'utf8');
  assert.equal(migration,'-- Forward SaaS migration 36: seoul-projection-publication-schema.sql\n'+readFileSync(source,'utf8'));}
 (await f.raw.exec('PRAGMA recursive_triggers='+recursive));
 f.calls=[];f.interceptor=null;
 const storage={sql:{exec(sql,...values){const statement=(await f.raw.prepare(sql)),result=statement.all(...values),readonly=statement.columns().length>0&&/^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());return {rowsWritten:readonly?0:Number((await f.raw.prepare('SELECT changes() n').get()).n),toArray:()=>result,[Symbol.iterator]:()=>result[Symbol.iterator]()};}},transactionSync(fn){(await f.raw.exec('BEGIN IMMEDIATE'));try{const result=fn();(await f.raw.exec('COMMIT'));return result;}catch(e){(await f.raw.exec('ROLLBACK'));throw e;}}};
 const engine=new SqlDatabaseEngine(storage,{objectName:'sql:staging:control:1'});engine.initialize();
 (await f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging','control','control',1,'ready','a'.repeat(64),'b'.repeat(64)));
 f.adapter=createDurableDatabase({async execute(request){f.calls.push(request);
  const intercepted=f.interceptor&&request.statements.some(s=>s.sql.includes(f.interceptor.match))?f.interceptor:null;
  if(intercepted&&intercepted.action==='fail-before'){f.interceptor=null;throw new Error('injected adapter loss');}
  let result;try{result=await engine.execute(request);}catch(e){f.engineError=e.message;throw e;}
  if(intercepted&&intercepted.action==='mutate'){f.interceptor=null;try{intercepted.fn();}catch(e){f.interceptorError=e;throw e;}}
  if(intercepted&&intercepted.action==='fail-after'){f.interceptor=null;throw new Error('injected adapter loss');}
  return result;}},{deploymentId:'staging',databaseId:'control',kind:'control',epoch:1});
 f.capture=createSeoulProjectionCapture(f.adapter,'durable-sql');
 f.workspace=new WorkspaceService(f.adapter,()=>at,{identityLifecycle:true},f.capture);
 f.admin=new Admin({DB:f.adapter,PUBLIC_ORIGIN:'https://memory.example.com'},()=>at,f.capture);
 f.preparer=createSeoulProjectionPreparer(f.adapter,'durable-sql');
 f.writer=createSeoulProjectionTargetWriter(f.adapter,'durable-sql');
 f.store=createSeoulProjectionSnapshotStore(f.adapter,'durable-sql');
 return f;
}

test('publication migration installs the stage schema at version 36',async t=>{
 const f=await setup(t);assert.ok(existsSync(source),'publication schema source must exist');
 for(const table of ['release_seoul_snapshot_stage'])assert.ok((await f.raw.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table)),table);
 clean(f);
});

test('snapshot store construction refuses missing or unsupported adapters',async t=>{
 const f=await setup(t);
 assert.throws(()=>createSeoulProjectionSnapshotStore({prepare(){},withSession(){}},'native-d1'),/snapshot_store_adapter/);
 assert.throws(()=>createSeoulProjectionSnapshotStore(f.adapter,'non-atomic-fixture'),/snapshot_store_adapter/);
 assert.throws(()=>createSeoulProjectionSnapshotStore(null,'durable-sql'),/snapshot_store_adapter/);
 clean(f);
});

test('publish input is strictly validated before any database work',async t=>{
 const f=await setup(t);
 for(const value of [undefined,null,42,'s1',{},[],{spaceId:''},{spaceId:null},{spaceId:42},{spaceId:'-bad'},{spaceId:'x'.repeat(129)},{spaceId:'bad space'},{spaceId:'s1',extra:1}])
  assert.equal((await f.store.publish(value)).status,'invalid_input',JSON.stringify(value));
 clean(f);
});

test('publish reports schema_missing before the publication migration',async t=>{
 const f=await setup(t,{migrations:'0035'});
 assert.equal((await f.store.publish({spaceId:'s1'})).status,'schema_missing');
});

test('publish reports retained snapshot staging before space checks',async t=>{
 const f=await setup(t);
 const carol=await signInCarol(f);
 const revision=(await f.raw.prepare('SELECT dirty_revision FROM release_seoul_dirty_spaces WHERE space_id=?').get(carol.space)).dirty_revision;
 (await f.raw.prepare("INSERT INTO release_seoul_snapshot_stage(token,space_id,eligible,payload_bytes,source_revision,snapshot_seq,issued_at,expires_at,payload_sha256,event_id,fence_token,claimed_at,lock_expires_at,target_revision,target_selected) VALUES(?,'s1',0,'{}',?,1,0,60000,?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',0,15000,1,1)").run(uuid(88),revision,'d'.repeat(64),uuid(88)));
 assert.equal((await f.store.publish({spaceId:'s1'})).status,'staging_retained');
});

test('publish reports space_missing for an absent Space',async t=>{
 const f=await setup(t);assert.equal((await f.store.publish({spaceId:'absent-space'})).status,'space_missing');clean(f);
});

test('publish reports not_dirty for a managed Space with no captured revision',async t=>{
 const f=await setup(t);assert.equal((await f.store.publish({spaceId:'s1'})).status,'not_dirty');clean(f);
});

for(const recursive of ['ON','OFF'])test('a dirty Space with unprepared authority heads reports heads_pending without claiming the fence; recursion '+recursive,async t=>{
 const f=await setup(t,{recursive}),carol=await signInCarol(f);
 assert.ok(pending(f).length>0);
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'heads_pending');
 assert.equal(rows(f,'release_seoul_projection_lock').length,0,'pending heads must not claim the fence');
 assert.equal(rows(f,'release_seoul_projection_events').length,0);
 clean(f);
});

test('a grant credential stream without an authority head reports dependency_missing',async t=>{
 const f=await setup(t),carol=await signInCarol(f);await applyTarget(f,carol.space);await prepareAll(f);
 (await f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission) VALUES('key:uncaptured',?,NULL,NULL,'personal_key',?,?,'write')").run(carol.accountId,'c'.repeat(64),at+900000));
 (await f.raw.prepare("INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES('key:uncaptured','[\"read\",\"create\"]',?)").run(JSON.stringify([carol.space])));
 assert.equal((await f.store.publish({spaceId:carol.space})).status,'dependency_missing');
 assert.equal(rows(f,'release_seoul_projection_events').filter(e=>e.event_kind==='snapshot').length,0);clean(f);
});

test('an excluded grant account refuses publication entirely',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 (await f.raw.prepare("INSERT INTO release_seoul_account_exclusions(account_id,reason,capture_attempt_id,count_lower_bound,byte_estimate,captured_at) VALUES(?,'unsupported-state',?,1,0,?)").run(carol.accountId,uuid(77),at));
 assert.equal((await f.store.publish({spaceId:carol.space})).status,'account_excluded');clean(f);
});

test('a held projection fence rejects a second claim until it expires',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 const dirty=(await f.raw.prepare('SELECT dirty_revision FROM release_seoul_dirty_spaces WHERE space_id=?').get(carol.space));
 (await f.raw.prepare('INSERT INTO release_seoul_projection_lock(space_id,fence_token,claimed_revision,claimed_at,expires_at) VALUES(?,?,?,?,?)').run(carol.space,'a'.repeat(32),dirty.dirty_revision,at,at+15000));
 assert.equal((await f.store.publish({spaceId:carol.space})).status,'fence_held');
 (await f.db.setClock(()=>at+15001));
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'published');assert.equal(result.snapshotSeq,1);
 assert.equal((await f.raw.prepare('SELECT fence_token FROM release_seoul_projection_lock WHERE space_id=?').get(carol.space)).fence_token.length,32);clean(f);
});

for(const recursive of ['ON','OFF'])test('personal Space publishes the canonical v3 snapshot atomically; recursion '+recursive,async t=>{
 const f=await setup(t,{recursive}),{carol,key}=await personalSpace(f);
 const dirty=(await f.raw.prepare('SELECT dirty_revision FROM release_seoul_dirty_spaces WHERE space_id=?').get(carol.space));
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'published');assert.equal(result.snapshotSeq,1);assert.equal(result.sourceRevision,dirty.dirty_revision);
 const event=(await f.raw.prepare('SELECT * FROM release_seoul_projection_events WHERE event_id=?').get(result.eventId));
 assert.equal(event.event_kind,'snapshot');assert.equal(event.space_id,carol.space);assert.equal(event.snapshot_seq,1);
 assert.equal(event.stream_kind,null);assert.equal(event.stream_key,null);assert.equal(event.source_sha256,null);
 assert.equal(event.issued_at,result.issuedAtMs);assert.equal(event.expires_at,result.issuedAtMs+60000);
 assert.equal(event.payload_sha256,result.payloadSha256);assert.equal(await digest(event.payload_bytes),result.payloadSha256);
 const published=(await f.raw.prepare('SELECT * FROM release_seoul_published_snapshots WHERE space_id=?').get(carol.space));
 assert.equal(published.snapshot_seq,1);assert.equal(published.event_id,result.eventId);assert.equal(published.payload_sha256,result.payloadSha256);
 assert.ok((await f.raw.prepare('SELECT event_id FROM release_seoul_projection_deliveries WHERE event_id=?').get(result.eventId)));
 assert.equal((await f.raw.prepare('SELECT captured_revision FROM release_seoul_dirty_spaces WHERE space_id=?').get(carol.space)).captured_revision,result.sourceRevision);
 const snapshot=decodeSeoulAuthoritySnapshot(new TextEncoder().encode(event.payload_bytes));
 assert.equal(snapshot.version,3);assert.equal(snapshot.kind,'seoul-authority-snapshot');assert.equal(snapshot.eventId,result.eventId);
 assert.equal(snapshot.spaceId,carol.space);assert.equal(snapshot.selected,true);assert.equal(snapshot.snapshotSeq,1);assert.equal(snapshot.sourceRevision,result.sourceRevision);
 assert.deepEqual(snapshot.lease,{issuedAtMs:result.issuedAtMs,expiresAtMs:result.issuedAtMs+60000});
 assert.deepEqual(snapshot.accounts,[{id:carol.accountId,disabledAtMs:null}]);
 assert.deepEqual(snapshot.providerIdentities,[{issuer,subject:'carol',accountId:carol.accountId,createdAtMs:at}]);
 assert.deepEqual(snapshot.organizations,[]);assert.deepEqual(snapshot.emails,[]);assert.deepEqual(snapshot.memberships,[]);
 assert.equal(snapshot.credentials.length,1);const cred=snapshot.credentials[0];
 assert.equal(cred.id,key.id);assert.equal(cred.accountId,carol.accountId);assert.equal(cred.kind,'personal_key');assert.equal(cred.permission,'write');
 assert.equal(cred.membershipId,null);assert.equal(cred.emailId,null);assert.equal(cred.expiresAtMs,key.expiresAt);assert.equal(cred.revokedAtMs,null);
 assert.equal(cred.tokenDigest,(await f.raw.prepare('SELECT token_digest FROM credentials WHERE id=?').get(key.id)).token_digest);
 assert.deepEqual(snapshot.credentialPolicies,[{credentialId:key.id,capabilities:['create','read'],spaceIds:[carol.space]}]);
 assert.deepEqual(snapshot.spaces,[{id:carol.space,accountId:carol.accountId,organizationId:null,disabledAtMs:null,policy:{policyVersion:1,residency:'kr-seoul',profile:'kr-primary-storage',processingBoundary:'approved-processors',dataClass:'personal',classificationStatus:'declared',sensitivityTags:[],placementEpoch:1}}]);
 assert.equal(snapshot.grants.length,1);const grant=snapshot.grants[0];
 assert.equal(grant.credentialId,key.id);assert.equal(grant.accountId,carol.accountId);assert.equal(grant.spaceId,carol.space);
 assert.equal(grant.provenance,'owner');assert.equal(grant.canIngest,true);assert.equal(grant.canSearch,true);assert.equal(grant.canErase,false);assert.equal(grant.canRetire,false);
 assert.equal(grant.expiresAtMs,key.expiresAt);assert.equal(grant.revokedAtMs,null);
 assert.equal(grant.heads.subjects.length,1);assert.equal(grant.heads.subjects[0].kind,'subject');assert.equal(grant.heads.subjects[0].key,issuer+'\ncarol');
 assert.equal(grant.heads.credential.kind,'credential');assert.equal(grant.heads.credential.key,key.id);
 assert.equal(grant.heads.space.kind,'space');assert.equal(grant.heads.space.key,carol.space);
 assert.equal(grant.heads.target.kind,'target');assert.equal(grant.heads.target.key,carol.space);
 assert.equal(grant.heads.emails,null);assert.equal(grant.heads.organization,null);assert.equal(grant.heads.membership,null);
 for(const h of [...grant.heads.subjects,grant.heads.credential,grant.heads.space,grant.heads.target]){assert.match(h.payloadSha256,/^[0-9a-f]{64}$/);assert.match(h.eventId,/^[a-f0-9-]{36}$/);assert.ok(h.revision>=1);}
 assert.ok(!JSON.stringify(event.payload_bytes).includes(key.token),'raw token must never appear in a snapshot');
 clean(f);
});

for(const recursive of ['ON','OFF'])test('organization Space publishes shared membership/email once for two api keys; recursion '+recursive,async t=>{
 const f=await setup(t,{recursive}),{carol,org,membership,k1,k2}=await orgSpace(f);
 const result=await f.store.publish({spaceId:org.spaceId});
 assert.equal(result.status,'published');assert.equal(result.snapshotSeq,1);
 const event=(await f.raw.prepare('SELECT * FROM release_seoul_projection_events WHERE event_id=?').get(result.eventId));
 const snapshot=decodeSeoulAuthoritySnapshot(new TextEncoder().encode(event.payload_bytes));
 assert.deepEqual(snapshot.organizations,[{id:org.id,disabledAtMs:null}]);
 assert.deepEqual(snapshot.emails.map(e=>e.id),[carol.emailId]);
 assert.equal(snapshot.emails[0].accountId,carol.accountId);assert.equal(snapshot.emails[0].address,'carol@example.com');
 assert.deepEqual(snapshot.memberships.map(m=>m.id),[membership.id]);
 assert.equal(snapshot.memberships[0].accountId,carol.accountId);assert.equal(snapshot.memberships[0].organizationId,org.id);assert.equal(snapshot.memberships[0].role,'owner');
 assert.deepEqual(snapshot.credentials.map(c=>c.id),[k1.id,k2.id].sort());
 assert.equal(snapshot.grants.length,2);
 for(const grant of snapshot.grants){
  assert.equal(grant.provenance,'organization-member');assert.equal(grant.accountId,carol.accountId);assert.equal(grant.spaceId,org.spaceId);
  assert.equal(grant.heads.membership.key,membership.id);assert.equal(grant.heads.organization.key,org.id);
  assert.equal(grant.heads.emails.length,1);assert.equal(grant.heads.emails[0].kind,'email');assert.equal(grant.heads.emails[0].key,issuer+'\ncarol\ncarol@example.com');
  assert.equal(grant.heads.subjects.length,1);assert.equal(grant.heads.subjects[0].key,issuer+'\ncarol');
 }
 const one=snapshot.grants.find(g=>g.credentialId===k1.id),two=snapshot.grants.find(g=>g.credentialId===k2.id);
 assert.equal(one.canIngest,true);assert.equal(one.canSearch,true);assert.equal(two.canIngest,false);assert.equal(two.canSearch,true);
 const expiry=Math.min(k1.expiresAt,membership.expires_at);assert.equal(one.expiresAtMs,expiry);assert.equal(two.expiresAtMs,Math.min(k2.expiresAt,membership.expires_at));
 clean(f);
});

test('a repeat publish after fence expiry advances the sequence at the same source revision',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 const first=await f.store.publish({spaceId:carol.space});assert.equal(first.status,'published');assert.equal(first.snapshotSeq,1);
 (await f.db.setClock(()=>at+16000));
 const second=await f.store.publish({spaceId:carol.space});
 assert.equal(second.status,'published');assert.equal(second.snapshotSeq,2);assert.equal(second.sourceRevision,first.sourceRevision);assert.notEqual(second.eventId,first.eventId);
 const published=(await f.raw.prepare('SELECT * FROM release_seoul_published_snapshots WHERE space_id=?').get(carol.space));
 assert.equal(published.snapshot_seq,2);assert.equal(published.event_id,second.eventId);
 const events=rows(f,'release_seoul_projection_events').filter(e=>e.event_kind==='snapshot'&&e.space_id===carol.space).sort((a,b)=>a.snapshot_seq-b.snapshot_seq);
 assert.deepEqual(events.map(e=>e.event_id),[first.eventId,second.eventId]);
 clean(f);
});

test('a deselected Space publishes a selected:false snapshot with no grants',async t=>{
 const f=await setup(t),{carol,key}=await personalSpace(f);
 const first=await f.store.publish({spaceId:carol.space});assert.equal(first.status,'published');
 (await f.db.setClock(()=>at+16000));
 const current=(await f.raw.prepare('SELECT revision FROM release_seoul_targets WHERE space_id=?').get(carol.space)).revision;
 await applyTarget(f,carol.space,false,current,901);await prepareAll(f);
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'published');assert.equal(result.snapshotSeq,2);
 const event=(await f.raw.prepare('SELECT * FROM release_seoul_projection_events WHERE event_id=?').get(result.eventId));
 const snapshot=decodeSeoulAuthoritySnapshot(new TextEncoder().encode(event.payload_bytes));
 assert.equal(snapshot.selected,false);assert.equal(snapshot.snapshotSeq,2);assert.deepEqual(snapshot.grants,[]);
 assert.deepEqual(snapshot.credentials,[]);assert.deepEqual(snapshot.credentialPolicies,[]);
 clean(f);
});

test('a dirty advance between claim and publish refuses the snapshot as stale',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 f.interceptor={match:'INSERT INTO release_seoul_projection_lock',action:'mutate',fn:async ()=>{
  (await f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('injected:stale','target','other-space',?, ?,?)").run(uuid(991),'{}',at+1));
  const revision=(await f.raw.prepare('SELECT max(revision) n FROM release_seoul_authority_changes').get()).n;
  (await f.raw.prepare('UPDATE release_seoul_dirty_spaces SET dirty_revision=? WHERE space_id=?').run(revision,carol.space));
 }};
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'stale');
 assert.equal(rows(f,'release_seoul_projection_events').filter(e=>e.event_kind==='snapshot').length,0);
 assert.equal(rows(f,'release_seoul_published_snapshots').length,0);
 assert.equal(rows(f,'release_seoul_snapshot_stage').length,0);
});

test('a pending authority head appearing after claim blocks publication as heads_pending',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 f.interceptor={match:'INSERT INTO release_seoul_projection_lock',action:'mutate',fn:async ()=>{
  (await f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('injected:pending','subject','other',?,?,?)").run(uuid(995),'{}',at+1));
 }};
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'heads_pending');
 assert.equal(rows(f,'release_seoul_projection_events').filter(e=>e.event_kind==='snapshot').length,0);
 assert.equal(rows(f,'release_seoul_published_snapshots').length,0);
});

test('a competing published sequence between claim and publish reports sequence_conflict',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 const revision=(await f.raw.prepare('SELECT dirty_revision FROM release_seoul_dirty_spaces WHERE space_id=?').get(carol.space)).dirty_revision;
 f.interceptor={match:'release_credential_policies',action:'mutate',fn:async ()=>{
  const eid=uuid(777),dg='f'.repeat(64);
  (await f.raw.prepare("INSERT INTO release_seoul_projection_events(event_id,source_revision,event_kind,stream_kind,stream_key,source_sha256,space_id,snapshot_seq,issued_at,expires_at,payload_bytes,payload_sha256) VALUES(?,?,'snapshot',NULL,NULL,NULL,?,1,?,?,?,?)").run(eid,revision,carol.space,at,at+60000,'{}',dg));
  (await f.raw.prepare('INSERT INTO release_seoul_projection_deliveries(event_id) VALUES(?)').run(eid));
  (await f.raw.prepare('INSERT INTO release_seoul_published_snapshots(space_id,snapshot_seq,event_id,payload_sha256) VALUES(?,1,?,?)').run(carol.space,eid,dg));
 }};
 f.calls.length=0;
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'sequence_conflict',JSON.stringify({error:String(f.interceptorError),engineError:String(f.engineError)}));
 assert.equal((await f.raw.prepare('SELECT count(*) n FROM release_seoul_projection_events WHERE space_id=? AND event_kind=?').get(carol.space,'snapshot')).n,1);
});

test('a competing snapshot event without a sequence row is reported as stale not published',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 const revision=(await f.raw.prepare('SELECT dirty_revision FROM release_seoul_dirty_spaces WHERE space_id=?').get(carol.space)).dirty_revision;
 f.interceptor={match:'INSERT INTO release_seoul_projection_lock',action:'mutate',fn:async ()=>{
  (await f.raw.prepare("INSERT INTO release_seoul_projection_events(event_id,source_revision,event_kind,stream_kind,stream_key,source_sha256,space_id,snapshot_seq,issued_at,expires_at,payload_bytes,payload_sha256) VALUES(?,?,'snapshot',NULL,NULL,NULL,?,1,?,?,?,?)").run(uuid(778),revision,carol.space,at,at+60000,'{}','e'.repeat(64)));
 }};
 assert.equal((await f.store.publish({spaceId:carol.space})).status,'stale');
 assert.equal(rows(f,'release_seoul_published_snapshots').length,0);
});

test('an account excluded between build and publish is refused, never published',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 f.interceptor={match:'release_seoul_authority_heads h LEFT JOIN',action:'mutate',fn:async ()=>{
  (await f.raw.prepare("INSERT INTO release_seoul_account_exclusions(account_id,reason,capture_attempt_id,count_lower_bound,byte_estimate,captured_at) VALUES(?,'unsupported-state',?,1,0,?)").run(carol.accountId,uuid(77),at));
 }};
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'account_excluded',JSON.stringify({error:String(f.interceptorError),engineError:String(f.engineError)}));
 assert.equal(rows(f,'release_seoul_projection_events').filter(e=>e.event_kind==='snapshot').length,0);
 clean(f);
});

test('an account disabled between build and publish cannot publish a stale positive grant',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 f.interceptor={match:'release_seoul_authority_heads h LEFT JOIN',action:'mutate',fn:async ()=>{
  (await f.raw.prepare('UPDATE accounts SET disabled_at=? WHERE id=?').run(at,carol.accountId));
 }};
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'uncertain',JSON.stringify({error:String(f.interceptorError),engineError:String(f.engineError)}));
 assert.equal(rows(f,'release_seoul_projection_events').filter(e=>e.event_kind==='snapshot').length,0);
 (await f.db.setClock(()=>at+16000));
 const retry=await f.store.publish({spaceId:carol.space});
 assert.equal(retry.status,'published');
 const event=(await f.raw.prepare('SELECT payload_bytes FROM release_seoul_projection_events WHERE event_id=?').get(retry.eventId));
 assert.deepEqual(decodeSeoulAuthoritySnapshot(new TextEncoder().encode(event.payload_bytes)).grants,[]);
 clean(f);
});

test('injected stage residue rolls the whole publish batch back and reports staging_retained',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 f.interceptor={match:'INSERT INTO release_seoul_projection_lock',action:'mutate',fn:async ()=>{
  (await f.raw.prepare("INSERT INTO release_seoul_snapshot_stage(token,space_id,eligible,payload_bytes,source_revision,snapshot_seq,issued_at,expires_at,payload_sha256,event_id,fence_token,claimed_at,lock_expires_at,target_revision,target_selected) VALUES(?,?,0,'{}',?,1,0,60000,?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',0,15000,1,1)").run(uuid(90),carol.space,(await f.raw.prepare('SELECT dirty_revision FROM release_seoul_dirty_spaces WHERE space_id=?').get(carol.space)).dirty_revision,'d'.repeat(64),uuid(89)));
 }};
 assert.equal((await f.store.publish({spaceId:carol.space})).status,'staging_retained');
 assert.equal(rows(f,'release_seoul_projection_events').filter(e=>e.event_kind==='snapshot').length,0);
 assert.equal(rows(f,'release_seoul_published_snapshots').length,0);
});

test('a lost claim acknowledgement reads back the committed fence and still publishes',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 f.interceptor={match:'INSERT INTO release_seoul_projection_lock',action:'fail-after'};
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'published');assert.equal(result.snapshotSeq,1);clean(f);
});

test('a lost publish acknowledgement still reports the committed snapshot',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 f.interceptor={match:'INSERT INTO release_seoul_snapshot_stage',action:'fail-after'};
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'published');assert.equal(result.snapshotSeq,1);
 const event=(await f.raw.prepare('SELECT * FROM release_seoul_projection_events WHERE event_id=?').get(result.eventId));
 assert.equal(event.event_kind,'snapshot');clean(f);
});

test('a publish batch that never commits reports uncertain and persists nothing',async t=>{
 const f=await setup(t),{carol}=await personalSpace(f);
 f.interceptor={match:'INSERT INTO release_seoul_snapshot_stage',action:'fail-before'};
 const result=await f.store.publish({spaceId:carol.space});
 assert.equal(result.status,'uncertain');
 assert.equal(rows(f,'release_seoul_projection_events').filter(e=>e.event_kind==='snapshot').length,0);
 assert.equal(rows(f,'release_seoul_published_snapshots').length,0);
 assert.equal(rows(f,'release_seoul_projection_deliveries').filter(d=>rows(f,'release_seoul_projection_events').some(e=>e.event_id===d.event_id&&e.event_kind==='snapshot')).length,0);
});

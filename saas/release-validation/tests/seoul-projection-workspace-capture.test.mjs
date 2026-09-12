import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fixture,at} from './db.mjs';
import {WorkspaceService,WorkspaceError} from '../../src/workspace.ts';
import {createSeoulProjectionCapture} from '../../src/release/seoul-projection-capture.ts';
import {parseSeoulAuthoritySourceRow} from '../../src/release/seoul-projection-source-codec.ts';
import {createDurableDatabase} from '../../src/durable-sql/client.ts';
import {SqlDatabaseEngine} from '../../src/durable-sql/engine.ts';

const issuer='https://auth-api.allen.company';
const rows=(f,table)=>f.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();
const sources=f=>rows(f,'release_seoul_authority_changes').filter(r=>r.source_command_id!=='setup-target');
const bodies=f=>sources(f).map(r=>parseSeoulAuthoritySourceRow(r).body);
const stage=['release_seoul_workspace_scope','release_seoul_workspace_spaces','release_seoul_workspace_attempts'];
function clean(f){for(const table of stage)assert.equal(rows(f,table).length,0,table);for(const r of f.calls)if(r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_workspace_attempts'))){assert.ok(r.statements.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(r))<=1048576);}assert.equal(f.raw.prepare('SELECT state FROM release_seoul_projection_state').get().state,'backfill-required');}
async function setup(t,recursive='ON',mapBob=true){
 const f=await fixture();t.after(()=>f.db.close());f.raw=f.db.raw;
 for(const file of ['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql','0028_seoul-projection-bootstrap-schema.sql','0029_seoul-projection-preparation-schema.sql'])f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,29);const schema=new URL('../../seoul-projection-workspace-schema.sql',import.meta.url);assert.ok(existsSync(schema),'new additive workspace schema must exist');
 const migration=readFileSync(new URL('../../migrations/0030_seoul-projection-workspace-schema.sql',import.meta.url),'utf8');assert.equal(migration,'-- Forward SaaS migration 30: seoul-projection-workspace-schema.sql\n'+readFileSync(schema,'utf8'));f.raw.exec(migration);assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,30);f.raw.exec('PRAGMA recursive_triggers='+recursive);
 const storage={sql:{exec(sql,...values){const s=f.raw.prepare(sql),r=s.all(...values),readonly=s.columns().length>0&&/^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());return {rowsWritten:readonly?0:Number(f.raw.prepare('SELECT changes() n').get().n),toArray:()=>r,[Symbol.iterator]:()=>r[Symbol.iterator]()};}},transactionSync(fn){f.raw.exec('BEGIN IMMEDIATE');try{const r=fn();f.raw.exec('COMMIT');return r;}catch(e){f.raw.exec('ROLLBACK');throw e;}}};
 const engine=new SqlDatabaseEngine(storage,{objectName:'sql:staging:control:1'});engine.initialize();f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging','control','control',1,'ready','a'.repeat(64),'b'.repeat(64));f.calls=[];
 f.adapter=createDurableDatabase({async execute(request){f.calls.push(request);return engine.execute(request);}},{deploymentId:'staging',databaseId:'control',kind:'control',epoch:1});f.capture=createSeoulProjectionCapture(f.adapter,'durable-sql');f.workspace=new WorkspaceService(f.adapter,()=>at,{identityLifecycle:true},f.capture);f.bare=new WorkspaceService(f.adapter,()=>at,{identityLifecycle:true});
 for(const account of mapBob?['alice','bob']:['alice'])f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,account,account,at);
 for(const id of ['s1','s2','so']){f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('setup-target','target',?,?, '{}',?)").run(id,crypto.randomUUID(),at);f.raw.prepare('INSERT INTO release_seoul_targets SELECT ?,1,max(revision) FROM release_seoul_authority_changes').run(id);}
 return f;
}
function api(f,id,n=1,policy=true){f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission) VALUES(?,'bob','m2','e2','api_key',?,?,'read')").run(id,n.toString(16).padStart(64,'0'),at+900000);if(policy)f.raw.prepare("INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES(?,'[\"read\"]',NULL)").run(id);}
async function invitation(f){f.raw.exec("UPDATE memberships SET revoked_at="+(at-1)+" WHERE id='m2'");return f.workspace.createInvite(f.token,'org',{email:'bob@example.com',role:'member'});}
function assertOrigin(f,command,receiptTable){const core=bodies(f);assert.ok(core.length);for(const body of core){assert.equal(body.origin.commandType,command);assert.ok(f.raw.prepare('SELECT id FROM '+receiptTable+' WHERE id=?').get(body.origin.receiptId));}return core;}

for(const recursive of ['ON','OFF'])test('invite acceptance captures only new exact membership and original result; recursion '+recursive,async t=>{
 const f=await setup(t,recursive),invite=await invitation(f);assert.equal(sources(f).length,0);assert.deepEqual(await f.workspace.acceptInvite(f.other,invite.token),{organizationId:'org'});
 const [body]=assertOrigin(f,'invite-accept','workspace_invitation_acceptances');assert.equal(sources(f).length,1);assert.equal(body.kind,'membership-source');assert.equal(body.accountId,'bob');assert.equal(body.id,body.origin.receiptId);assert.deepEqual(body.effect,{type:'entity-head',disposition:'present'});assert.deepEqual(rows(f,'release_seoul_dirty_spaces').map(r=>r.space_id),['so']);assert.ok(!JSON.stringify(sources(f)).includes(invite.token));clean(f);
 const before=sources(f);await assert.rejects(f.workspace.acceptInvite(f.other,invite.token),WorkspaceError);assert.deepEqual(sources(f),before);clean(f);
});

for(const recursive of ['ON','OFF'])test('another account admin revokes exact member and all API children, never personal key; recursion '+recursive,async t=>{
 const f=await setup(t,recursive);api(f,'api:one',1);api(f,'api:two',2);const personal=await f.bare.issueKey(f.other,{label:'Personal',permission:'read',expiresInDays:1});assert.equal(await f.workspace.revokeMembership(f.token,'org','m2'),undefined);
 const core=assertOrigin(f,'membership-revoke','workspace_membership_revocations');assert.deepEqual(core.map(b=>b.id).sort(),['api:one','api:two','m2']);assert.ok(core.every(b=>b.accountId==='bob'&&b.revokedAtMs===at&&b.effect.occurredAtMs===at));assert.equal(f.raw.prepare('SELECT revoked_at FROM credentials WHERE id=?').get(personal.id).revoked_at,null);assert.deepEqual(rows(f,'release_seoul_dirty_spaces').map(r=>r.space_id),['so']);clean(f);
 const before=sources(f);await assert.rejects(f.workspace.revokeMembership(f.token,'org','m2'),WorkspaceError);assert.deepEqual(sources(f),before);clean(f);
});

for(const recursive of ['ON','OFF'])for(const org of [false,true])test('legacy Workspace '+(org?'API':'personal')+' issue retains policy null, receipt and PAT response; recursion '+recursive,async t=>{
 const f=await setup(t,recursive);const key=await f.workspace.issueKey(f.token,{label:'Legacy',permission:'read',expiresInDays:2,...(org?{organizationId:'org'}:{})});assert.deepEqual(Object.keys(key),['id','token','expiresAt']);assert.equal(key.expiresAt,at+2*86400000);const [body]=assertOrigin(f,'workspace-key-issue','workspace_key_issuances');assert.equal(sources(f).length,1);assert.equal(body.id,key.id);assert.equal(body.origin.receiptId,key.id);assert.equal(body.credentialKind,org?'api_key':'personal_key');assert.equal(body.policy,null);assert.equal(f.raw.prepare('SELECT count(*) n FROM release_credential_policies WHERE credential_id=?').get(key.id).n,0);assert.ok(!JSON.stringify(sources(f)).includes(key.token));assert.deepEqual(rows(f,'release_seoul_dirty_spaces').map(r=>r.space_id),[org?'so':'s1']);clean(f);
});

for(const recursive of ['ON','OFF'])test('admin API revoke uses target account and personal self revoke preserves exact policy; recursion '+recursive,async t=>{
 const f=await setup(t,recursive);api(f,'api:target');await f.workspace.revokeKey(f.token,'api:target');let core=assertOrigin(f,'workspace-key-revoke','workspace_key_revocations');assert.equal(core[0].accountId,'bob');assert.equal(core[0].effect.entityId,'api:target');assert.deepEqual(rows(f,'release_seoul_dirty_spaces').map(r=>r.space_id),['so']);
 await f.workspace.revokeKey(f.token,'key:alice');core=bodies(f);assert.equal(core[1].credentialKind,'personal_key');assert.deepEqual(core[1].policy,{capabilities:['create','read'],spaceIds:['s1']});assert.equal(core[1].effect.occurredAtMs,at);const before=sources(f);await assert.rejects(f.workspace.revokeKey(f.token,'api:target'),WorkspaceError);assert.deepEqual(sources(f),before);clean(f);
});

test('denied last owner, foreign scope, noninteractive actor and write-time expiry never create capture work',async t=>{
 const f=await setup(t);api(f,'api:target');await assert.rejects(f.workspace.revokeMembership(f.token,'org','m1'),WorkspaceError);await assert.rejects(f.workspace.revokeMembership(f.other,'org','m1'),WorkspaceError);await assert.rejects(f.workspace.revokeKey(f.other,'key:alice'),WorkspaceError);await assert.rejects(f.workspace.issueKey(f.key,{label:'Denied',permission:'read',expiresInDays:1}),WorkspaceError);
 const original=f.capture.workspaceCommand.bind(f.capture);f.capture.workspaceCommand=(...args)=>{f.db.setClock(()=>at+1000000);return original(...args);};await assert.rejects(f.workspace.issueKey(f.token,{label:'Expired',permission:'read',expiresInDays:1}),WorkspaceError);assert.equal(sources(f).length,0);assert.equal(rows(f,'release_seoul_account_exclusions').length,0);clean(f);
});

for(const recursive of ['ON','OFF'])for(const command of ['invite','member','issue','revoke'])test('late '+command+' failure rolls back original command, cascades, audit and capture; recursion '+recursive,async t=>{
 const f=await setup(t,recursive);api(f,'api:target');const invite=command==='invite'?await invitation(f):null;
 const tables=['credentials','memberships','workspace_invitations','workspace_invitation_acceptances','workspace_membership_revocations','workspace_key_issuances','workspace_key_revocations','workspace_key_metadata','workspace_audit_events','audit_events','release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_dirty_spaces','release_seoul_account_exclusions'];const before=new Map(tables.map(table=>[table,rows(f,table)]));
 f.raw.exec("CREATE TRIGGER workspace_capture_late BEFORE DELETE ON release_seoul_workspace_attempts BEGIN SELECT RAISE(ABORT,'workspace capture late'); END");
 const act=command==='invite'?()=>f.workspace.acceptInvite(f.other,invite.token):command==='member'?()=>f.workspace.revokeMembership(f.token,'org','m2'):command==='issue'?()=>f.workspace.issueKey(f.token,{label:'Rollback',permission:'read',expiresInDays:1}):()=>f.workspace.revokeKey(f.token,'api:target');
 await assert.rejects(act,WorkspaceError);for(const table of tables)assert.deepEqual(rows(f,table),before.get(table),table);clean(f);
});

for(const reason of ['foreign','unmapped','credentials','bytes','spaces','space-id'])test('valid target revoke preserves central success with complete exclusion for '+reason,async t=>{
 const f=await setup(t,'ON',reason!=='unmapped');api(f,'api:target');if(reason==='foreign')f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run('https://foreign.example','foreign','bob',at);
 if(reason==='credentials')for(let n=2;n<=513;n++)api(f,'api:'+n,n);
 if(reason==='bytes')f.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run(JSON.stringify(Array(30000).fill('read')),'api:target');
 if(reason==='spaces')for(let n=0;n<513;n++)f.raw.prepare("INSERT INTO spaces VALUES(?,'Retained',NULL,'org','managed',?,'session:alice')").run('raw:'+n,at);
 if(reason==='space-id')f.raw.prepare("INSERT INTO spaces VALUES(?,'Retained',NULL,'org','managed',?,'session:alice')").run('s'.repeat(129),at);
 await f.workspace.revokeMembership(f.token,'org','m2');assert.equal(f.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,at);assert.deepEqual(rows(f,'release_seoul_account_exclusions').map(r=>r.account_id),['bob']);assert.ok(bodies(f).every(b=>b.kind==='subject-source-unrepresentable'&&b.accountId==='bob'));assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

test('raw exact-organization Space and membership-key discovery use bounded indexed plans',async t=>{
 const f=await setup(t);api(f,'api:target');await f.workspace.revokeMembership(f.token,'org','m2');const request=f.calls.find(r=>r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_workspace_attempts')));
 const probe=request.statements.find(s=>s.sql.includes('SET space_count='));const plan=f.raw.prepare('EXPLAIN QUERY PLAN '+probe.sql).all(...probe.values).map(r=>r.detail);assert.ok(plan.some(r=>r.includes('release_spaces_organization_created')),JSON.stringify(plan));assert.ok(!plan.some(r=>r.includes('MERGE (UNION)')||r.includes('UNION USING TEMP')||r.includes('ORDER BY')),JSON.stringify(plan));
 const keys=request.statements.find(s=>s.sql.includes('SET credential_count=')),keyPlan=f.raw.prepare('EXPLAIN QUERY PLAN '+keys.sql).all(...keys.values).map(r=>r.detail);assert.ok(keyPlan.some(r=>r.includes('release_seoul_workspace_live_credentials')&&r.includes('revoked_at=?')),JSON.stringify(keyPlan));clean(f);
});

test('new staging never reuses an unexpected retained attempt after a zero-row scope',async t=>{
 const f=await setup(t);f.raw.exec("INSERT INTO release_seoul_workspace_attempts(id,command_kind,receipt_id,entity_id) VALUES('00000000-0000-4000-8000-000000000001','workspace-key-revoke','stale','missing')");const before=rows(f,'release_seoul_workspace_attempts');await assert.rejects(f.workspace.revokeKey(f.token,'missing'),WorkspaceError);assert.deepEqual(rows(f,'release_seoul_workspace_attempts'),before);assert.equal(sources(f).length,0);
});

test('actual ordered 0030 preserves populated 0029 tables, objects and source history',async t=>{
 const f=await fixture();t.after(()=>f.db.close());f.raw=f.db.raw;for(const file of ['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql','0028_seoul-projection-bootstrap-schema.sql','0029_seoul-projection-preparation-schema.sql'])f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('retained','credential','old','00000000-0000-4000-8000-000000000001','{}',?)").run(at);f.raw.prepare("INSERT INTO release_seoul_account_exclusions VALUES('bob','unmapped','00000000-0000-4000-8000-000000000002',0,0,?)").run(at);
 const snapshot=table=>f.raw.prepare('SELECT * FROM '+table).all().map(r=>JSON.stringify(r)).sort();const objects=f.raw.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();const before=new Map(objects.filter(o=>o.type==='table'&&o.name!=='release_meta').map(o=>[o.name,snapshot(o.name)]));
 f.raw.exec(readFileSync(new URL('../../migrations/0030_seoul-projection-workspace-schema.sql',import.meta.url),'utf8'));for(const [table,data] of before)assert.deepEqual(snapshot(table),data,table);for(const object of objects)assert.deepEqual(f.raw.prepare('SELECT name,type,sql FROM sqlite_master WHERE name=?').get(object.name),object);assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,30);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('unsupported target policy and retained mailbox never poison accepted key revocation',async t=>{
 for(const reason of ['policy-count','policy-id','mailbox']){
  const f=await setup(t);api(f,'api:target');if(reason==='policy-count')f.raw.prepare('UPDATE release_credential_policies SET space_ids=? WHERE credential_id=?').run(JSON.stringify(Array.from({length:51},(_,i)=>'s:'+i)),'api:target');if(reason==='policy-id')f.raw.prepare('UPDATE release_credential_policies SET space_ids=? WHERE credential_id=?').run(JSON.stringify(['s'.repeat(129)]),'api:target');
  if(reason==='mailbox'){f.raw.prepare("INSERT INTO account_emails VALUES('retained:e','bob',?,'example.com',?,NULL)").run('a\nb@example.com',at);f.raw.exec("INSERT INTO organizations(id) VALUES('retained:org'); INSERT INTO memberships VALUES('retained:m','retained:org','bob','retained:e','member',9007199254740991,NULL)");f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission) VALUES('retained:k','bob','retained:m','retained:e','api_key',?,?,'read')").run('f'.repeat(64),at+900000);}
  const target=reason==='mailbox'?'retained:k':'api:target';await f.workspace.revokeKey(f.other,target);assert.equal(f.raw.prepare('SELECT revoked_at FROM credentials WHERE id=?').get(target).revoked_at,at);assert.deepEqual(rows(f,'release_seoul_account_exclusions').map(r=>r.account_id),['bob']);assert.deepEqual(bodies(f).map(b=>b.kind),['subject-source-unrepresentable']);clean(f);
 }
});

test('large revoked child history is neither recaptured nor counted as effective fanout',async t=>{
 const f=await setup(t);for(let n=1;n<=600;n++)api(f,'old:'+n,n,false);f.raw.exec("UPDATE credentials SET revoked_at="+(at-1)+" WHERE membership_id='m2'");api(f,'api:live',601);
 await f.workspace.revokeMembership(f.token,'org','m2');assert.deepEqual(bodies(f).map(b=>b.id).sort(),['api:live','m2']);assert.equal(rows(f,'release_seoul_account_exclusions').length,0);assert.equal(f.raw.prepare("SELECT count(*) n FROM credentials WHERE membership_id='m2' AND revoked_at=?").get(at-1).n,600);clean(f);
});

for(const command of ['invite','issue','revoke'])test('unsupported mapping exclusion uses the actual '+command+' target and preserves response',async t=>{
 const f=await setup(t);const target=command==='issue'?'alice':'bob';f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run('https://retained.example','opaque',target,at);
 if(command==='invite'){const invite=await invitation(f);assert.deepEqual(await f.workspace.acceptInvite(f.other,invite.token),{organizationId:'org'});}
 if(command==='issue'){const key=await f.workspace.issueKey(f.token,{label:'Retained',permission:'read',expiresInDays:1});assert.ok(f.raw.prepare('SELECT id FROM credentials WHERE id=?').get(key.id));}
 if(command==='revoke'){api(f,'api:target');await f.workspace.revokeKey(f.token,'api:target');assert.equal(f.raw.prepare("SELECT revoked_at FROM credentials WHERE id='api:target'").get().revoked_at,at);}
 assert.deepEqual(rows(f,'release_seoul_account_exclusions').map(r=>r.account_id),[target]);assert.deepEqual(bodies(f).map(b=>b.accountId),[target]);assert.ok(bodies(f).every(b=>b.kind==='subject-source-unrepresentable'));assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

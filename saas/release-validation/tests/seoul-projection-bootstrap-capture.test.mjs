import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fixture,at} from './db.mjs';
import {WorkspaceService,WorkspaceError} from '../../src/workspace.ts';
import {createSeoulProjectionCapture} from '../../src/release/seoul-projection-capture.ts';
import {createDurableDatabase} from '../../src/durable-sql/client.ts';
import {SqlDatabaseEngine} from '../../src/durable-sql/engine.ts';
import {encodeSeoulAuthoritySnapshot} from '../../src/release/seoul-projection-snapshot-codec.ts';

const issuer='https://auth-api.allen.company';
const schema=new URL('../../seoul-projection-bootstrap-schema.sql',import.meta.url);
const rows=(f,table)=>f.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();
const sources=f=>rows(f,'release_seoul_authority_changes');
const bodies=f=>sources(f).map(r=>JSON.parse(r.record_bytes));
const principal=(subject,extra={})=>({issuer,subject,issuedAt:at,expiresAt:at+900000,permission:'write',...extra});
function clean(f){for(const table of ['release_seoul_bootstrap_attempts','release_seoul_bootstrap_scope','release_seoul_bootstrap_spaces'])assert.equal(rows(f,table).length,0,table);for(const request of f.calls)if(request.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_bootstrap_attempts'))){assert.ok(request.statements.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(request))<=1048576);}}
function verifyCodecIdentityOrder(providerIdentities){
 const value={version:3,kind:'seoul-authority-snapshot',eventId:'00000000-0000-4000-8000-000000000009',sourceRevision:1,snapshotSeq:1,issuer,spaceId:'s1',selected:true,accounts:[{id:'alice',disabledAtMs:null}],providerIdentities,emails:[],organizations:[],memberships:[],credentials:[],credentialPolicies:[],spaces:[{id:'s1',accountId:'alice',organizationId:null,disabledAtMs:null,policy:{policyVersion:1,residency:'kr-seoul',profile:'kr-primary-storage',processingBoundary:'approved-processors',dataClass:'personal',classificationStatus:'declared',sensitivityTags:[],placementEpoch:1}}],grants:[],lease:{issuedAtMs:at,expiresAtMs:at+60000}};
 assert.ok(encodeSeoulAuthoritySnapshot(value).length);assert.throws(()=>encodeSeoulAuthoritySnapshot({...value,providerIdentities:providerIdentities.slice().reverse()}),/seoul_snapshot_invalid/);
}
async function setup(t,recursive='ON'){
 const f=await fixture();t.after(()=>f.db.close());f.raw=f.db.raw;
 for(const file of ['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql'])f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 assert.ok(existsSync(schema),'additive bootstrap staging schema must exist');const migration=readFileSync(new URL('../../migrations/0028_seoul-projection-bootstrap-schema.sql',import.meta.url),'utf8');assert.equal(migration,'-- Forward SaaS migration 28: seoul-projection-bootstrap-schema.sql\n'+readFileSync(schema,'utf8'));f.raw.exec(migration);assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,28);f.raw.exec('PRAGMA recursive_triggers='+recursive);
 const calls=[];const storage={sql:{exec(sql,...values){const statement=f.raw.prepare(sql),result=statement.all(...values),readonly=statement.columns().length>0&&/^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());return {rowsWritten:readonly?0:Number(f.raw.prepare('SELECT changes() n').get().n),toArray:()=>result,[Symbol.iterator]:()=>result[Symbol.iterator]()};}},transactionSync(fn){f.raw.exec('BEGIN IMMEDIATE');try{const r=fn();f.raw.exec('COMMIT');return r;}catch(e){f.raw.exec('ROLLBACK');throw e;}}};
 const engine=new SqlDatabaseEngine(storage,{objectName:'sql:staging:control:1'});engine.initialize();f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging','control','control',1,'ready','a'.repeat(64),'b'.repeat(64));
 f.adapter=createDurableDatabase({async execute(request){calls.push(request);return engine.execute(request);}},{deploymentId:'staging',databaseId:'control',kind:'control',epoch:1});f.capture=createSeoulProjectionCapture(f.adapter,'durable-sql');f.workspace=new WorkspaceService(f.adapter,()=>at,{identityLifecycle:true},f.capture);f.calls=calls;
 f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,'alice','alice',at);
 return f;
}

for(const recursive of ['ON','OFF'])for(const mode of ['absent','blocked','already-claimed','created'])test('first sign-in captures exact bootstrap and optional email '+mode+'; recursion '+recursive,async t=>{
 const f=await setup(t,recursive),address=mode==='already-claimed'?'bob@example.com':'new@example.com';
 if(mode==='blocked'){f.raw.exec("INSERT INTO domains VALUES('blocked-domain','org','example.com',9007199254740991,NULL); INSERT INTO domain_managers VALUES('blocked-domain','m1',NULL); INSERT INTO revocations(id,kind,actor_credential_id,domain_id,address,created_at) VALUES('block-receipt','domain','session:alice','blocked-domain','new@example.com',"+at+")");}
 const result=await f.workspace.signIn(principal('new\nsubject',mode==='absent'?{}:{emailVerified:true,email:address}));assert.equal(typeof result.token,'string');assert.equal(result.expiresAt,at+900000);
 const core=bodies(f);assert.deepEqual(core.map(r=>r.kind).sort(),mode==='created'?['email-source','space-source','subject-source']:['space-source','subject-source']);
 const subject=core.find(r=>r.kind==='subject-source');assert.equal(subject.accountId,result.accountId);assert.deepEqual(subject.providerIdentities,[{issuer,subject:'new\nsubject',accountId:result.accountId,createdAtMs:at}]);assert.deepEqual(subject.effect,{type:'entity-head',disposition:'changed'});assert.equal(subject.origin.commandType,'workspace-sign-in');assert.ok(f.raw.prepare('SELECT id FROM workspace_sign_ins WHERE id=?').get(subject.origin.receiptId));
 const space=core.find(r=>r.kind==='space-source');assert.equal(space.accountId,result.accountId);assert.deepEqual(space.effect,{type:'entity-head',disposition:'present'});assert.equal(rows(f,'release_seoul_dirty_spaces').find(r=>r.space_id===space.id).dirty_revision,Math.max(...sources(f).map(r=>r.revision)));
 assert.ok(core.every(r=>!JSON.stringify(r).includes(result.token)));assert.ok(core.every(r=>Object.keys(r).slice(-2).join(',')==='origin,effect'));assert.ok(rows(f,'release_seoul_authority_heads').every(r=>r.payload_sha256===null));clean(f);
 const request=f.calls.find(r=>r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_bootstrap_attempts')));assert.ok(request.statements.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(request))<=1048576);assert.equal(f.raw.prepare('SELECT state FROM release_seoul_projection_state').get().state,'backfill-required');
});

test('repeat sign-in and OAuth early-return create no projection revisions for session-only work',async t=>{
 const f=await setup(t);await f.workspace.signIn(principal('repeat'));const before=sources(f);await f.workspace.signIn(principal('repeat'));assert.deepEqual(sources(f),before);clean(f);
 const external='oauth-private-token-'.repeat(4);const first=await f.workspace.signIn(principal('external'),external),after=sources(f);const batches=f.calls.filter(r=>r.statements.some(s=>s.sql.includes('bootstrap_attempts'))).length;assert.deepEqual(await f.workspace.signIn(principal('external'),external),first);assert.deepEqual(sources(f),after);assert.equal(f.calls.filter(r=>r.statements.some(s=>s.sql.includes('bootstrap_attempts'))).length,batches);assert.ok(!JSON.stringify(sources(f)).includes(external));
});

for(const recursive of ['ON','OFF'])test('retained linked subjects use one complete JS UTF16-sorted set and all claim email keys; recursion '+recursive,async t=>{
 const f=await setup(t,recursive),subjects=['alice','a\nopaque','\uE000','😀'];for(const subject of subjects.slice(1))f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,subject,'alice',at);
 f.raw.exec('CREATE TABLE bootstrap_observed(before_bytes TEXT,after_bytes TEXT); CREATE TRIGGER bootstrap_observe BEFORE DELETE ON release_seoul_bootstrap_scope WHEN OLD.stream_kind=\'subject\' BEGIN INSERT INTO bootstrap_observed VALUES(OLD.before_bytes,OLD.after_bytes); END');
 const result=await f.workspace.signIn(principal('alice',{emailVerified:true,email:'linked@example.com'}));assert.equal(result.accountId,'alice');assert.deepEqual(bodies(f).map(r=>r.kind),subjects.map(()=> 'email-source'));assert.deepEqual(bodies(f).map(r=>r.subject).sort(),subjects.slice().sort());
 for(const row of rows(f,'bootstrap_observed'))for(const text of [row.before_bytes,row.after_bytes]){const list=JSON.parse(text).providerIdentities;assert.deepEqual(list.map(p=>p.subject),subjects.slice().sort());verifyCodecIdentityOrder(list);}assert.equal(rows(f,'bootstrap_observed').length,subjects.length);clean(f);
});

test('retained lifecycle state copied by a new mapping has generic command effect',async t=>{
 const f=await setup(t);f.raw.prepare("INSERT INTO release_webhook_events VALUES('identity','retained-resume',?,?)").run('c'.repeat(64),at);f.raw.prepare("INSERT INTO release_identity_lifecycle_events VALUES('retained-resume',?,'resumed-subject',1,'account.resumed','',?,?,?,?)").run(issuer,at-1,at,at,'c'.repeat(64));
 await f.workspace.signIn(principal('resumed-subject'));const subject=bodies(f).find(r=>r.kind==='subject-source');assert.equal(subject.lifecycle.eventId,'retained-resume');assert.deepEqual(subject.effect,{type:'entity-head',disposition:'changed'});assert.equal(subject.origin.kind,'command');clean(f);
});

for(const recursive of ['ON','OFF'])for(const child of [false,true])test('organization '+(child?'child':'root')+' captures original result and exact new entities; recursion '+recursive,async t=>{
 const f=await setup(t,recursive);const result=await f.workspace.createOrganization(f.token,{name:'New organization',emailId:'e1',...(child?{parentOrganizationId:'org'}:{})});assert.deepEqual(Object.keys(result),['id','name','spaceId']);assert.equal(result.name,'New organization');const core=bodies(f);assert.deepEqual(core.map(r=>r.kind).sort(),['membership-source','organization-source','space-source']);assert.ok(core.every(r=>r.origin.receiptId===result.id&&r.origin.commandType===(child?'organization-child-create':'organization-create')));assert.ok(core.every(r=>r.effect.type==='entity-head'&&r.effect.disposition==='present'));assert.ok(!sources(f).some(r=>r.stream_key==='org'));assert.equal(core.find(r=>r.kind==='space-source').id,result.spaceId);assert.equal(core.find(r=>r.kind==='membership-source').accountId,'alice');assert.equal(rows(f,'organization_hierarchy').filter(r=>r.organization_id===result.id).length,child?1:0);clean(f);
});

test('wrong creator claim, invalid parent authority and write-time sign-in expiry produce no sources',async t=>{
 const f=await setup(t);await assert.rejects(f.workspace.createOrganization(f.token,{name:'Denied',emailId:'e2'}),WorkspaceError);await assert.rejects(f.workspace.createOrganization(f.other,{name:'Denied child',emailId:'e2',parentOrganizationId:'org'}),WorkspaceError);assert.equal(sources(f).length,0);clean(f);
 const original=f.capture.workspaceBootstrap.bind(f.capture);f.capture.workspaceBootstrap=(...args)=>{f.db.setClock(()=>at+1000000);return original(...args);};await assert.rejects(f.workspace.signIn(principal('expired')),WorkspaceError);assert.equal(sources(f).length,0);assert.equal(rows(f,'release_seoul_account_exclusions').length,0);clean(f);
});

for(const recursive of ['ON','OFF'])test('late bootstrap failure rolls back original sign-in and child hierarchy with all capture rows; recursion '+recursive,async t=>{
 const f=await setup(t,recursive);const tables=['accounts','provider_identities','credentials','account_emails','organizations','memberships','spaces','workspace_sign_ins','workspace_organization_creations','workspace_child_organization_creations','organization_hierarchy','workspace_audit_events','release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_dirty_spaces'];const before=new Map(tables.map(table=>[table,rows(f,table)]));f.raw.exec("CREATE TRIGGER bootstrap_late_failure BEFORE DELETE ON release_seoul_bootstrap_attempts BEGIN SELECT RAISE(ABORT,'bootstrap_late_failure'); END");
 await assert.rejects(f.workspace.signIn(principal('rollback',{emailVerified:true,email:'rollback@example.com'})),WorkspaceError);for(const table of tables)assert.deepEqual(rows(f,table),before.get(table),table);clean(f);await assert.rejects(f.workspace.createOrganization(f.token,{name:'Rollback',emailId:'e1',parentOrganizationId:'org'}),WorkspaceError);for(const table of tables)assert.deepEqual(rows(f,table),before.get(table),table);clean(f);
});

test('complete identity array repetition overflow excludes a successful claim without partial normal sources',async t=>{
 const f=await setup(t);const identities=['alice',...Array.from({length:79},(_,n)=>'linked:'+String(n).padStart(3,'0')+'x'.repeat(20))];for(const subject of identities.slice(1))f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,subject,'alice',at);assert.ok(Buffer.byteLength(JSON.stringify(identities.map(subject=>({issuer,subject,accountId:'alice',createdAtMs:at}))))<131072);
 const result=await f.workspace.signIn(principal('alice',{emailVerified:true,email:'overflow@example.com'}));assert.equal(result.accountId,'alice');assert.ok(f.raw.prepare("SELECT id FROM account_emails WHERE address='overflow@example.com'").get());assert.deepEqual(bodies(f).map(r=>r.kind),['subject-source-unrepresentable']);assert.equal(rows(f,'release_seoul_account_exclusions').length,1);assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);clean(f);
 const before=sources(f);await f.workspace.signIn(principal('alice'));assert.deepEqual(sources(f),before);clean(f);
});

test('existing foreign candidate Space cannot be classified as newly created bootstrap authority',async t=>{
 const f=await setup(t);const original=f.capture.workspaceBootstrap.bind(f.capture);let candidate;f.capture.workspaceBootstrap=(database,scope,...args)=>{candidate=scope.spaceId;f.raw.prepare("INSERT INTO spaces VALUES(?,?,'bob',NULL,'managed',?,'session:bob')").run(candidate,'Foreign candidate',at);return original(database,scope,...args);};
 await f.workspace.signIn(principal('alice',{emailVerified:true,email:'new-claim@example.com'}));assert.ok(!sources(f).some(r=>r.stream_key===candidate));assert.ok(!rows(f,'release_seoul_dirty_spaces').some(r=>r.space_id===candidate));assert.deepEqual(bodies(f).map(r=>r.kind),['email-source']);clean(f);
});

test('raw Space discovery streams its bounded union and deduplicates retained claim dependencies',async t=>{
 const f=await setup(t);for(let n=0;n<2;n++){f.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,NULL)').run('historical-email:'+n,'alice','old@example.com','example.com',at-100);f.raw.prepare('INSERT INTO memberships VALUES(?,?,?,?,?,?,?)').run('historical-member:'+n,'org','alice','historical-email:'+n,'member',at+10000,at-50);f.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE id=?').run(at-50,'historical-email:'+n);}
 f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('setup-target','target','so','00000000-0000-4000-8000-000000000001','{}',?)").run(at);f.raw.exec("INSERT INTO release_seoul_targets SELECT 'so',1,max(revision) FROM release_seoul_authority_changes");
 await f.workspace.signIn(principal('alice',{emailVerified:true,email:'old@example.com'}));assert.deepEqual(rows(f,'release_seoul_dirty_spaces').map(r=>r.space_id),['so']);clean(f);
 const request=f.calls.find(r=>r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_bootstrap_attempts')));const probe=request.statements.find(s=>s.sql.includes('SET space_count='));const plan=f.raw.prepare('EXPLAIN QUERY PLAN '+probe.sql).all(...probe.values).map(r=>r.detail);assert.ok(!plan.some(line=>line.includes('UNION USING TEMP B-TREE')||line.includes('MERGE (UNION)')||line.includes('ORDER BY')),JSON.stringify(plan));assert.ok(plan.some(line=>line.includes('spaces_account')||line.includes('release_spaces_account_created')),JSON.stringify(plan));
});

test('unsupported retained account and foreign first mapping preserve central bootstrap without partial source state',async t=>{
 const f=await setup(t);f.raw.prepare('INSERT INTO accounts(id) VALUES(?)').run('retained account');f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,'retained','retained account',at);
 const retained=await f.workspace.signIn(principal('retained'));assert.equal(retained.accountId,'retained account');assert.equal(rows(f,'release_seoul_account_exclusions')[0].account_id,'retained account');assert.equal(sources(f).length,0);clean(f);
 const foreign=await f.workspace.signIn(principal('foreign',{issuer:'https://retained.example'}));assert.ok(f.raw.prepare('SELECT id FROM accounts WHERE id=?').get(foreign.accountId));assert.equal(rows(f,'release_seoul_account_exclusions').length,2);assert.equal(sources(f).length,0);clean(f);
});

for(const oversized of [false,true])test('raw unselected Space '+(oversized?'ID bytes':'count')+' excludes successful bootstrap before staging',async t=>{
 const f=await setup(t);const count=oversized?1:513;for(let n=0;n<count;n++)f.raw.prepare("INSERT INTO spaces VALUES(?,'Retained','alice',NULL,'managed',?,'session:alice')").run(oversized?'s'.repeat(129):'raw:'+n,at);
 const result=await f.workspace.signIn(principal('alice',{emailVerified:true,email:'space-bound@example.com'}));assert.equal(result.accountId,'alice');assert.ok(f.raw.prepare("SELECT id FROM account_emails WHERE address='space-bound@example.com'").get());assert.deepEqual(bodies(f).map(r=>r.kind),['subject-source-unrepresentable']);assert.equal(rows(f,'release_seoul_account_exclusions')[0].reason,oversized?'unsupported-state':'fanout-count');assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

test('additive migration preserves 0027 source/exclusion rows and refuses unexpected staging without deletion',async t=>{
 const f=await fixture();t.after(()=>f.db.close());f.raw=f.db.raw;for(const file of ['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql'])f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('retained-source','credential','retained','00000000-0000-4000-8000-000000000002','{}',?)").run(at);f.raw.prepare("INSERT INTO release_seoul_account_exclusions VALUES('alice','unmapped','00000000-0000-4000-8000-000000000003',0,0,?)").run(at);const beforeSources=sources(f),beforeExclusions=rows(f,'release_seoul_account_exclusions'),priorTable=f.raw.prepare("SELECT sql FROM sqlite_master WHERE name='release_seoul_capture_attempts'").get().sql;
 f.raw.exec(readFileSync(new URL('../../migrations/0028_seoul-projection-bootstrap-schema.sql',import.meta.url),'utf8'));assert.deepEqual(sources(f),beforeSources);assert.deepEqual(rows(f,'release_seoul_account_exclusions'),beforeExclusions);assert.equal(f.raw.prepare("SELECT sql FROM sqlite_master WHERE name='release_seoul_capture_attempts'").get().sql,priorTable);assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,28);
 f.raw.exec("INSERT INTO release_seoul_bootstrap_attempts(id,command_kind,receipt_id,email_id,space_id) VALUES('00000000-0000-4000-8000-000000000004','workspace-sign-in','receipt','email','space')");const retained=rows(f,'release_seoul_bootstrap_attempts');assert.throws(()=>f.raw.exec("INSERT INTO release_seoul_bootstrap_attempts(id,command_kind,receipt_id,email_id,space_id) VALUES('00000000-0000-4000-8000-000000000005','workspace-sign-in','receipt2','email2','space2')"),/staging is not empty/);assert.deepEqual(rows(f,'release_seoul_bootstrap_attempts'),retained);assert.deepEqual(sources(f),beforeSources);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});

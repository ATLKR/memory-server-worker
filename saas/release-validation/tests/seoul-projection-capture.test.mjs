import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fixture,at} from './db.mjs';
import {Admin} from '../../src/release/admin.ts';
import {IdentityService,IdentityDenied,canonicalEmail} from '../../src/identity.ts';
import {createDurableDatabase} from '../../src/durable-sql/client.ts';
import {SqlDatabaseEngine} from '../../src/durable-sql/engine.ts';
import {Transfers} from '../../src/release/transfer.ts';
const implementation=await import('../../src/release/seoul-projection-capture.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const issuer='https://auth-api.allen.company';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source=new URL('../../seoul-projection-capture-schema.sql',import.meta.url);
const list=(f,table)=>f.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();
const captured=f=>list(f,'release_seoul_authority_changes').filter(r=>!r.source_command_id.startsWith('target:'));
const bodies=f=>captured(f).map(r=>JSON.parse(r.record_bytes));
function clean(f){for(const table of ['release_seoul_capture_attempts','release_seoul_capture_scope','release_seoul_capture_spaces'])assert.equal(list(f,table).length,0,table);}
function select(f,spaceId,n){f.raw.prepare('INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?)').run('target:'+spaceId,'target',spaceId,uuid(n),'{}',at);const revision=f.raw.prepare('SELECT max(revision) revision FROM release_seoul_authority_changes').get().revision;f.raw.prepare('INSERT INTO release_seoul_targets VALUES(?,?,?)').run(spaceId,1,revision);}
async function setup(t,{recursive='ON',subjects=['zeta','alpha\nopaque'],selected=['s1','s2','so']}={}){
 const f=await fixture();t.after(()=>f.db.close());f.raw=f.db.raw;
 f.raw.exec(readFileSync(new URL('../../migrations/0026_seoul-projection-schema.sql',import.meta.url),'utf8'));
 assert.ok(existsSync(source),'inactive source-capture schema must exist');const migration=readFileSync(new URL('../../migrations/0027_seoul-projection-capture-schema.sql',import.meta.url),'utf8');assert.equal(migration,'-- Forward SaaS migration 27: seoul-projection-capture-schema.sql\n'+readFileSync(source,'utf8'));f.raw.exec(migration);assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,27);
 for(const subject of subjects)f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,subject,'alice',at);
 f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,'bob','bob',at);
 selected.forEach((s,i)=>select(f,s,700+i));f.raw.exec('PRAGMA recursive_triggers='+recursive);
 const calls=[];
 const storage={sql:{exec(sql,...values){const statement=f.raw.prepare(sql),result=statement.all(...values);const readonly=statement.columns().length>0&&/^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());return {rowsWritten:readonly?0:Number(f.raw.prepare('SELECT changes() n').get().n),toArray:()=>result,[Symbol.iterator]:()=>result[Symbol.iterator]()};}},transactionSync(fn){f.raw.exec('BEGIN IMMEDIATE');try{const result=fn();f.raw.exec('COMMIT');return result;}catch(e){f.raw.exec('ROLLBACK');throw e;}}};
 const engine=new SqlDatabaseEngine(storage,{objectName:'sql:staging:control:1'});engine.initialize();
 const identity={deploymentId:'staging',databaseId:'control',kind:'control',epoch:1};
 f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging','control','control',1,'ready','a'.repeat(64),'b'.repeat(64));
 f.adapter=createDurableDatabase({async execute(request){calls.push(request);return engine.execute(request);}},identity);
 assert.equal(typeof implementation.createSeoulProjectionCapture,'function','trusted source capture must be implemented');
 f.capture=implementation.createSeoulProjectionCapture(f.adapter,'durable-sql');f.calls=calls;
 f.admin=new Admin({DB:f.adapter},()=>at,f.capture);f.identity=new IdentityService(f.adapter,()=>at,f.capture);
 return f;
}

for(const recursive of ['ON','OFF'])test('scoped key capture stores final canonical policy atomically with no raw tokens; recursion '+recursive,async t=>{
 const f=await setup(t,{recursive});
 const key=await f.admin.issueKey(f.token,{label:'private label',organizationId:'org',capabilities:['read','create'],spaceIds:['so'],expiresInDays:1});
 const records=captured(f);assert.equal(records.length,1);const body=JSON.parse(records[0].record_bytes);
 assert.deepEqual(Object.keys(body),['version','kind','id','accountId','credentialKind','tokenDigest','membershipId','emailId','permission','expiresAtMs','revokedAtMs','policy']);
 assert.equal(body.kind,'credential-source');assert.equal(body.id,key.id);assert.equal(body.credentialKind,'api_key');assert.equal(body.emailId,'e1');assert.equal(body.membershipId,'m1');
 assert.deepEqual(body.policy,{capabilities:['create','read'],spaceIds:['so']});assert.equal(body.expiresAtMs,key.expiresAt);
 assert.equal(body.tokenDigest,f.raw.prepare('SELECT token_digest FROM credentials WHERE id=?').get(key.id).token_digest);
 const allSources=JSON.stringify(list(f,'release_seoul_authority_changes'));for(const secret of [key.token,f.token,'private label'])assert.ok(!allSources.includes(secret));
 assert.deepEqual(list(f,'release_seoul_dirty_spaces').map(r=>r.space_id),['so']);assert.equal(list(f,'release_seoul_authority_heads').find(r=>r.stream_key===key.id).payload_sha256,null);clean(f);
 const batch=f.calls.find(call=>call.statements.some(s=>s.sql.includes('release_seoul_capture_attempts')));assert.ok(batch.statements.length<100);assert.ok(Buffer.byteLength(JSON.stringify(batch))<1024*1024);assert.ok(batch.statements.every(s=>!s.sql.includes('RETURNING')));
 assert.equal(f.raw.prepare('SELECT state FROM release_seoul_projection_state').get().state,'backfill-required');
});

for(const recursive of ['ON','OFF'])test('self unlink captures exact two-subject email and member/PAT cascades without personal effects; recursion '+recursive,async t=>{
 const f=await setup(t,{recursive});
 const orgKey=await new Admin({DB:f.adapter},()=>at).issueKey(f.token,{label:'org',organizationId:'org',capabilities:['read','create'],expiresInDays:1});
 const oldKey='old-revoked-key';f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,revoked_at) VALUES(?,'alice','m1','e1','api_key',?,?,?)").run(oldKey,'d'.repeat(64),at+10000,at-1);
 f.raw.prepare('INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES(?,?,NULL)').run(oldKey,'["read","create"]');
 f.raw.exec(`CREATE TRIGGER capture_test_policy_order AFTER INSERT ON revocations BEGIN UPDATE release_credential_policies SET capabilities='["create","read"]' WHERE credential_id='old-revoked-key'; END`);
 await f.identity.unlinkEmail(f.token,'e1');const records=captured(f),core=bodies(f);
 assert.deepEqual(records.map(r=>r.stream_kind).sort(),['credential','email','email','membership']);
 assert.deepEqual(core.filter(r=>r.kind==='email-source').map(r=>r.subject).sort(),['alpha\nopaque','zeta']);
 for(const email of core.filter(r=>r.kind==='email-source')){assert.equal(email.liveClaim,null);assert.deepEqual(email.changedClaim,{id:'e1',verifiedAtMs:at,revokedAtMs:at});assert.deepEqual(email.lifecycle,{state:'absent'});assert.equal(email.legacyRevoked,false);}
 assert.deepEqual(records.filter(r=>r.stream_kind==='email').map(r=>r.stream_key).sort(),[issuer+'\nalpha\nopaque\nalice@example.com',issuer+'\nzeta\nalice@example.com']);
 assert.equal(core.find(r=>r.kind==='credential-source').id,orgKey.id);assert.equal(core.find(r=>r.kind==='credential-source').revokedAtMs,at);assert.equal(core.find(r=>r.kind==='membership-source').revokedAtMs,at);
 assert.equal(f.raw.prepare("SELECT revoked_at FROM credentials WHERE id='key:alice'").get().revoked_at,null);assert.deepEqual(list(f,'release_seoul_dirty_spaces').map(r=>r.space_id),['so']);
 assert.equal(new Set(records.map(r=>r.source_command_id)).size,1);assert.equal(new Set(records.map(r=>r.event_id)).size,records.length);clean(f);
 const before=captured(f);await assert.rejects(f.identity.unlinkEmail(f.token,'e1'),IdentityDenied);assert.deepEqual(captured(f),before);clean(f);
});

test('denied key issuance and unauthorized existing-email scope create no source, exclusion or dirty work',async t=>{
 const f=await setup(t);await assert.rejects(f.identity.unlinkEmail(f.token,'e2'),IdentityDenied);assert.equal(captured(f).length,0);assert.equal(list(f,'release_seoul_account_exclusions').length,0);assert.equal(list(f,'release_seoul_dirty_spaces').length,0);clean(f);
 const prior=f.capture.issueKeyStatements.bind(f.capture);f.capture.issueKeyStatements=(...args)=>{const statements=prior(...args);f.db.setClock(()=>at+1000000);return statements;};
 await assert.rejects(f.admin.issueKey(f.token,{label:'expired at write',capabilities:['read'],expiresInDays:1}),e=>e.status===403);
 assert.equal(captured(f).length,0);assert.equal(list(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

test('late capture SQL failure rolls back real key and email commands, source heads, dirty work and staging',async t=>{
 const f=await setup(t);const tables=['credentials','release_credential_policies','release_events','account_emails','memberships','revocations','release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_dirty_spaces'];const before=new Map(tables.map(table=>[table,list(f,table)]));
 f.raw.exec("CREATE TRIGGER capture_late_failure BEFORE DELETE ON release_seoul_capture_attempts BEGIN SELECT RAISE(ABORT,'capture_late_failure'); END");
 await assert.rejects(f.admin.issueKey(f.token,{label:'rollback',capabilities:['read'],expiresInDays:1}),/capture_late_failure/);
 for(const table of tables)assert.deepEqual(list(f,table),before.get(table),table);clean(f);
 await assert.rejects(f.identity.unlinkEmail(f.token,'e1'),/capture_late_failure/);for(const table of tables)assert.deepEqual(list(f,table),before.get(table),table);clean(f);
});

for(const mode of ['foreign','unmapped','identity-bytes','fanout'])test('valid unlink preserves central acceptance with explicit bounded exclusion for '+mode,async t=>{
 const subjects=mode==='unmapped'?[]:mode==='identity-bytes'?Array.from({length:280},(_,n)=>String(n).padStart(4,'0')+'x'.repeat(500)):['anchor'];
 const f=await setup(t,{subjects});if(mode==='foreign')f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run('https://retained.example','foreign','alice',at);
 if(mode==='identity-bytes')assert.ok(Buffer.byteLength(JSON.stringify(subjects))>131072);
 if(mode==='fanout')for(let n=0;n<513;n++)f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,revoked_at) VALUES(?,'alice','m1','e1','api_key',?,?,?)").run('historic:'+n,n.toString(16).padStart(64,'0'),at+1000,at-1);
 await f.identity.unlinkEmail(f.token,'e1');assert.equal(f.raw.prepare("SELECT revoked_at FROM account_emails WHERE id='e1'").get().revoked_at,at);
 const exclusions=list(f,'release_seoul_account_exclusions');assert.equal(exclusions.length,1);assert.equal(exclusions[0].account_id,'alice');
 const core=bodies(f);assert.equal(core.length,mode==='unmapped'?0:1);if(core.length){assert.equal(core[0].kind,'subject-source-unrepresentable');assert.equal(core[0].accountId,'alice');assert.equal(core[0].captureAttemptId,exclusions[0].capture_attempt_id);assert.ok(Buffer.byteLength(JSON.stringify(core[0]))<4096);}
 assert.equal(list(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

test('foreign retained mapping excludes a successful new key without returning its token in projection state',async t=>{
 const f=await setup(t);f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run('https://retained.example','foreign','alice',at);
 const key=await f.admin.issueKey(f.token,{label:'still accepted',capabilities:['read'],expiresInDays:1});assert.ok(f.raw.prepare('SELECT id FROM credentials WHERE id=?').get(key.id));
 assert.equal(list(f,'release_seoul_account_exclusions').length,1);assert.deepEqual(bodies(f).map(r=>r.kind),['subject-source-unrepresentable']);assert.ok(!JSON.stringify(bodies(f)).includes(key.token));clean(f);
});

test('capture construction refuses missing/unsupported adapters and mismatched service database before mutation',async t=>{
 const f=await setup(t);assert.throws(()=>implementation.createSeoulProjectionCapture({prepare(){},withSession(){}},'native-d1'),/capture_adapter/);
 assert.throws(()=>implementation.createSeoulProjectionCapture({prepare(){},withSession(){},batch:async statements=>Promise.all(statements.map(s=>s.run()))},'non-atomic-fixture'),/capture_adapter/);
 assert.throws(()=>new IdentityService(f.db,()=>at,f.capture),/capture_database/);assert.throws(()=>new Admin({DB:f.db},()=>at,f.capture),/capture_database/);assert.equal(captured(f).length,0);
});

test('personal wildcard scope dirties owned selected Spaces; share-only issuance never dirties recipient or shared Spaces',async t=>{
 const f=await setup(t);const transfer=new Transfers(f.adapter,()=>at),share=await transfer.share(f.other,'s2','alice@example.com',7);await transfer.accept(f.token,share.id);
 const shared=await f.admin.issueKey(f.token,{label:'shared only',capabilities:['read'],spaceIds:['s2'],expiresInDays:1});assert.equal(bodies(f).find(r=>r.id===shared.id).credentialKind,'personal_key');assert.equal(list(f,'release_seoul_dirty_spaces').length,0);
 const owned=await f.admin.issueKey(f.token,{label:'owned wildcard',capabilities:['read'],expiresInDays:1});assert.deepEqual(bodies(f).find(r=>r.id===owned.id).policy,{capabilities:['read'],spaceIds:null});assert.deepEqual(list(f,'release_seoul_dirty_spaces').map(r=>r.space_id),['s1']);clean(f);
});

for(const capabilities of ['[{"retained":"object"}]','["unknown-capability"]'])test('malformed retained policy excludes the full accepted cascade before canonical JSON: '+capabilities,async t=>{
 const f=await setup(t);const key=await new Admin({DB:f.adapter},()=>at).issueKey(f.token,{label:'retained',organizationId:'org',capabilities:['read'],expiresInDays:1});f.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run(capabilities,key.id);
 await f.identity.unlinkEmail(f.token,'e1');assert.equal(f.raw.prepare('SELECT revoked_at FROM credentials WHERE id=?').get(key.id).revoked_at,at);assert.deepEqual(bodies(f).map(r=>r.kind),['subject-source-unrepresentable']);assert.equal(list(f,'release_seoul_account_exclusions')[0].reason,'unsupported-state');assert.equal(list(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

test('a missing retained PAT policy stays explicitly null and never becomes an implicit broad policy',async t=>{
 const f=await setup(t);f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at) VALUES('missing-policy','alice','m1','e1','api_key',?,?)").run('f'.repeat(64),at+1000);
 await f.identity.unlinkEmail(f.token,'e1');assert.equal(bodies(f).find(r=>r.id==='missing-policy').policy,null);clean(f);
});

for(const subject of ['😀'.repeat(257),'\u00a0\u2003'])test('unsupported retained opaque subject excludes rather than silently filtering '+subject.length+' UTF16 units',async t=>{
 const f=await setup(t,{subjects:['anchor',subject]});await f.identity.unlinkEmail(f.token,'e1');assert.equal(list(f,'release_seoul_account_exclusions')[0].reason,'unsupported-mapping');assert.deepEqual(bodies(f).map(r=>r.kind),['subject-source-unrepresentable']);clean(f);
});

test('raw candidate Space overflow excludes successful central mutation even when almost all candidates are unselected',async t=>{
 const f=await setup(t);for(let n=0;n<513;n++)f.raw.prepare("INSERT INTO spaces VALUES(?,?,'alice',NULL,'managed',?,'session:alice')").run('unselected:'+n,'unselected',at);
 const key=await f.admin.issueKey(f.token,{label:'accepted beyond projection scope',capabilities:['read'],expiresInDays:1});assert.ok(f.raw.prepare('SELECT id FROM credentials WHERE id=?').get(key.id));assert.equal(list(f,'release_seoul_account_exclusions')[0]?.reason,'fanout-count');assert.deepEqual(bodies(f).map(r=>r.kind),['subject-source-unrepresentable']);assert.equal(list(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

test('oversized retained candidate Space ID excludes before copying even when the Space is unselected',async t=>{
 const f=await setup(t);f.raw.prepare("INSERT INTO spaces VALUES(?,?,'alice',NULL,'managed',?,'session:alice')").run('unselected:'+ 'x'.repeat(131072),'retained',at);
 const key=await f.admin.issueKey(f.token,{label:'valid central command',capabilities:['read'],expiresInDays:1});assert.ok(f.raw.prepare('SELECT id FROM credentials WHERE id=?').get(key.id));assert.equal(list(f,'release_seoul_account_exclusions')[0]?.reason,'unsupported-state');assert.deepEqual(bodies(f).map(r=>r.kind),['subject-source-unrepresentable']);assert.equal(list(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

for(const recursive of ['ON','OFF'])for(const mode of ['newline','2306-byte-key'])test('retained mailbox '+mode+' preserves accepted unlink via exact exclusion; recursion '+recursive,async t=>{
 const subject=mode==='newline'?'anchor':'한'.repeat(512),address=mode==='newline'?'a\nb@example.com':'가'.repeat(242)+'@example.com';
 const f=await setup(t,{recursive,subjects:[subject]});assert.throws(()=>canonicalEmail(address));if(mode==='2306-byte-key')assert.equal(Buffer.byteLength(issuer+'\n'+subject+'\n'+address),2306);
 f.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,NULL)').run('retained-email','alice',address,'example.com',at);
 f.raw.exec("INSERT INTO organizations(id) VALUES('retained-org'); INSERT INTO memberships VALUES('retained-member','retained-org','alice','retained-email','member',9007199254740991,NULL)");
 f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at) VALUES('retained-key','alice','retained-member','retained-email','api_key',?,?)").run('e'.repeat(64),at+10000);
 await f.identity.unlinkEmail(f.token,'retained-email');for(const [table,id] of [['account_emails','retained-email'],['memberships','retained-member'],['credentials','retained-key']])assert.equal(f.raw.prepare('SELECT revoked_at FROM '+table+' WHERE id=?').get(id).revoked_at,at);
 assert.equal(list(f,'release_seoul_account_exclusions')[0]?.reason,'unsupported-state');assert.deepEqual(bodies(f).map(r=>r.kind),['subject-source-unrepresentable']);assert.equal(bodies(f)[0].subject,subject);assert.equal(list(f,'release_seoul_dirty_spaces').length,0);assert.ok(captured(f).every(r=>Buffer.byteLength(r.stream_key)<=2048));assert.ok(!captured(f).some(r=>r.record_bytes.includes(address)));clean(f);
});

for(const recursive of ['ON','OFF'])test('maximum valid canonical mailbox and 512-unit opaque subject remain representable; recursion '+recursive,async t=>{
 const subject='한'.repeat(511)+'\n',domain='b'.repeat(63)+'.'+'c'.repeat(63)+'.'+'d'.repeat(61),address='a'.repeat(64)+'@'+domain;
 assert.equal(subject.length,512);assert.equal(address.length,254);assert.equal(canonicalEmail(address).address,address);const f=await setup(t,{recursive,subjects:[subject]});
 f.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,NULL)').run('maximum-email','alice',address,domain,at);await f.identity.unlinkEmail(f.token,'maximum-email');
 assert.equal(f.raw.prepare("SELECT revoked_at FROM account_emails WHERE id='maximum-email'").get().revoked_at,at);assert.equal(list(f,'release_seoul_account_exclusions').length,0);assert.deepEqual(bodies(f).map(r=>r.kind),['email-source']);assert.equal(bodies(f)[0].subject,subject);assert.equal(bodies(f)[0].address,address);assert.equal(captured(f)[0].stream_key,issuer+'\n'+subject+'\n'+address);assert.ok(Buffer.byteLength(captured(f)[0].stream_key)<=2048);clean(f);
});

test('capture mailbox validation agrees with existing canonicalEmail local and domain rules without rewriting retained addresses',async t=>{
 const addresses=['.a@example.com','a.@example.com','a..b@example.com','a'.repeat(65)+'@example.com','a@x.-y.com','a@x.y-.com','a@x..com','a@'+'x'.repeat(64)+'.com',"a!#$%&'*+/=?^_`{|}~-.b@a-b.c"];
 for(const address of addresses){let valid=false;try{valid=canonicalEmail(address).address===address;}catch{}const f=await setup(t,{subjects:['anchor']});f.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,NULL)').run('rule-email','alice',address,address.slice(address.indexOf('@')+1),at);await f.identity.unlinkEmail(f.token,'rule-email');assert.equal(f.raw.prepare("SELECT revoked_at FROM account_emails WHERE id='rule-email'").get().revoked_at,at);assert.equal(list(f,'release_seoul_account_exclusions').length,valid?0:1,address);assert.deepEqual(bodies(f).map(r=>r.kind),[valid?'email-source':'subject-source-unrepresentable'],address);if(valid)assert.equal(bodies(f)[0].address,address);clean(f);}
});

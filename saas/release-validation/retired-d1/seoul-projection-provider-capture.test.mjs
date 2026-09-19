import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fixture,at} from './db-sqlite.mjs';
import {Admin} from '../../src/release/admin.ts';
import {WorkspaceService} from '../../src/workspace.ts';
import {receiveLifecycle,applyVerifiedLifecycle} from '../../src/release/lifecycle.ts';
import {createSeoulProjectionCapture} from '../../src/release/seoul-projection-capture.ts';
import {parseSeoulAuthoritySourceRow} from '../../src/release/seoul-projection-source-codec.ts';
import {createSeoulProjectionPreparer} from '../../src/release/seoul-projection-preparer.ts';
import {decodeSeoulHeadEvent} from '../../src/release/seoul-projection-head-codec.ts';
import {createDurableDatabase} from '../../src/durable-sql/client.ts';
import {SqlDatabaseEngine} from '../../src/durable-sql/engine.ts';
import {hmac} from '../../src/release/util.ts';

const issuer='https://auth-api.allen.company',secret='synthetic-provider-capture-only-123456789';
const kinds=['account.suspended','account.resumed','account.deleted','email.revoked','email.verified'];
for(const recursive of ['ON','OFF'])for(const mode of ['webhook','verified-pair'])test('captured dirty revision survives later V2 '+mode+'; '+recursive,async t=>{
 const f=await setup(t,recursive),prior=(await f.raw.prepare('SELECT max(revision) n FROM release_seoul_authority_changes').get()).n;for(const space of ['s1','so'])(await f.raw.prepare('INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision,captured_revision) VALUES(?,?,?)').run(space,prior,prior));
 if(mode==='webhook')await f.deliver(f.event(1,'account.resumed'));else await f.verified([f.event(1,'account.resumed'),f.event(2,'email.verified')]);
 const latest=Math.max(...sources(f).map(r=>r.revision));assert.ok(latest>prior);for(const space of ['s1','so']){const actual=(await f.raw.prepare('SELECT * FROM release_seoul_dirty_spaces WHERE space_id=?').get(space));assert.equal(actual.dirty_revision,latest);assert.equal(actual.captured_revision,prior);}clean(f);
});
const rows=async (f,table)=>(await f.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
const sources=f=>rows(f,'release_seoul_authority_changes').filter(r=>r.source_command_id!=='setup-target');
const bodies=f=>sources(f).map(r=>parseSeoulAuthoritySourceRow(r).body);
const stages=['release_seoul_provider_scope','release_seoul_provider_spaces','release_seoul_provider_identities','release_seoul_provider_attempts','release_seoul_provider_operations'];
async function clean(f){for(const table of stages)assert.equal(rows(f,table).length,0,table);for(const r of f.calls)if(r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_provider_operations'))){assert.ok(r.statements.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(r))<=1048576);}assert.equal((await f.raw.prepare('SELECT state FROM release_seoul_projection_state').get()).state,'backfill-required');assert.deepEqual((await f.raw.prepare('PRAGMA foreign_key_check').all()),[]);}
async function setup(t,recursive='ON',mapped=true){
 let now=at;const f=await fixture({clock:()=>now});t.after(()=>f.db.close());f.raw=f.db.raw;f.clock=()=>now;f.advance=ms=>{now+=ms;};
 for(const file of ['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql','0028_seoul-projection-bootstrap-schema.sql','0029_seoul-projection-preparation-schema.sql','0030_seoul-projection-workspace-schema.sql'])(await f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8')));
 assert.equal((await f.raw.prepare('SELECT version FROM release_meta').get()).version,30);const schema=new URL('../../seoul-projection-provider-schema.sql',import.meta.url);assert.ok(existsSync(schema),'additive provider schema must exist');const migration=readFileSync(new URL('../../migrations/0031_seoul-projection-provider-schema.sql',import.meta.url),'utf8');assert.equal(migration,'-- Forward SaaS migration 31: seoul-projection-provider-schema.sql\n'+readFileSync(schema,'utf8'));(await f.raw.exec(migration));assert.equal((await f.raw.prepare('SELECT version FROM release_meta').get()).version,31);
 for(const file of ['0032_seoul-projection-command-schema.sql','0033_seoul-projection-provider-v1-schema.sql','0034_seoul-projection-target-schema.sql'])(await f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8')));
 assert.equal((await f.raw.prepare('SELECT version FROM release_meta').get()).version,34);assert.deepEqual((await f.raw.prepare('PRAGMA foreign_key_check').all()),[]);(await f.raw.exec('PRAGMA recursive_triggers='+recursive));
 const storage={sql:{exec(sql,...values){const s=(await f.raw.prepare(sql)),r=s.all(...values),readonly=s.columns().length>0&&/^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());return {rowsWritten:readonly?0:Number((await f.raw.prepare('SELECT changes() n').get()).n),toArray:()=>r,[Symbol.iterator]:()=>r[Symbol.iterator]()};}},transactionSync(fn){(await f.raw.exec('BEGIN IMMEDIATE'));try{const r=fn();(await f.raw.exec('COMMIT'));return r;}catch(e){(await f.raw.exec('ROLLBACK'));throw e;}}};
 const engine=new SqlDatabaseEngine(storage,{objectName:'sql:staging:control:1'});engine.initialize();(await f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging','control','control',1,'ready','a'.repeat(64),'b'.repeat(64)));f.calls=[];
 f.adapter=createDurableDatabase({async execute(request){f.calls.push(request);return engine.execute(request);}},{deploymentId:'staging',databaseId:'control',kind:'control',epoch:1});f.capture=createSeoulProjectionCapture(f.adapter,'durable-sql');f.admin=new Admin({DB:f.adapter,IDENTITY_WEBHOOK_SECRET:secret},f.clock,f.capture);f.workspace=new WorkspaceService(f.adapter,f.clock,{identityLifecycle:true});
 if(mapped)for(const subject of ['alice','alias\n\uE000'])(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,subject,'alice',at-200000));
 (await f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission) VALUES('api:alice','alice','m1','e1','api_key',?,?,'write')").run('1'.repeat(64),at+900000));(await f.raw.exec("INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES('api:alice','[\"read\"]',NULL)"));
 for(const id of ['s1','s2','so']){(await f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('setup-target','target',?,?, '{}',?)").run(id,crypto.randomUUID(),at));(await f.raw.prepare('INSERT INTO release_seoul_targets SELECT ?,1,max(revision) FROM release_seoul_authority_changes').run(id));}
 f.event=(sequence,type,subject='alice')=>({version:2,id:'publisher:'+sequence,sequence,issuer,subject,type,occurredAt:now-123000,email:type.startsWith('email.')?'alice@example.com':null});
 f.deliver=value=>receiveLifecycle(f.adapter,f.clock,value,JSON.stringify(value),f.clock(),f.capture);
 f.verified=events=>applyVerifiedLifecycle(f.adapter,f.clock,{issuer,subject:events[0].subject,issuedAt:f.clock()-1000,expiresAt:f.clock()+100000,email:'alice@example.com',emailVerified:true,identityLifecycle:events.map(v=>JSON.stringify(v))},f.capture);
 return f;
}

for(const recursion of ['ON','OFF'])for(const kind of kinds)test('actual V2 '+kind+' captures exact direct/derived state and distinct times; recursion '+recursion,async t=>{
 const f=await setup(t,recursion),event=f.event(1,kind);assert.deepEqual(await (await f.deliver(event)).json(),{received:true});const core=bodies(f),direct=core.find(b=>b.subject==='alice'&&b.kind===(kind.startsWith('account.')?'subject-source':'email-source'));
 assert.deepEqual(direct.origin,{kind:'provider-v2',eventId:event.id,eventType:kind,sequence:1,occurredAtMs:event.occurredAt});assert.equal(direct.effect.occurredAtMs,event.occurredAt);assert.equal(direct.lifecycle.eventId,event.id);assert.equal(direct.lifecycle.occurredAtMs,event.occurredAt);
 for(const b of core.filter(b=>b.kind==='credential-source'||b.kind==='membership-source')){assert.equal(b.revokedAtMs,at);assert.equal(b.effect.occurredAtMs,at);assert.equal(b.origin.occurredAtMs,event.occurredAt);assert.notEqual(b.effect.occurredAtMs,b.origin.occurredAtMs);}
 assert.equal(core.some(b=>b.id==='key:alice'),kind.startsWith('account.'));assert.ok(core.some(b=>b.id==='api:alice'));assert.ok(!core.some(b=>b.credentialKind==='session'));
 for(const b of core.filter(b=>b.kind==='email-source'&&(kind.startsWith('account.')||b.subject!=='alice'))){assert.deepEqual(b.effect,{type:'entity-head',disposition:'changed'});assert.equal(b.changedClaim.revokedAtMs,at);}
 if(kind==='account.deleted'){const alias=core.find(b=>b.kind==='subject-source'&&b.subject!=='alice');assert.equal(alias.accountDisabledAtMs,at);assert.deepEqual(alias.effect,{type:'entity-head',disposition:'changed'});}
 assert.ok(!rows(f,'release_seoul_dirty_spaces').some(r=>r.space_id==='s2'));assert.equal(rows(f,'release_seoul_provider_groups').length,1);assert.ok(rows(f,'release_seoul_authority_heads').filter(h=>h.stream_kind!=='target').every(h=>h.payload_sha256===null));assert.ok(!JSON.stringify(sources(f)).includes(f.token));assert.ok(!JSON.stringify(sources(f)).includes(JSON.stringify(event)));clean(f);
});

for(const kind of kinds)test('unmapped '+kind+' retains only exact minimal lifecycle transition',async t=>{
 const f=await setup(t,'ON',false),event=f.event(1,kind);await f.deliver(event);const [body]=bodies(f);assert.equal(sources(f).length,1);assert.equal(body.kind,'identity-transition-source');assert.equal(body.address,kind.startsWith('email.')?'alice@example.com':null);assert.equal(body.effect.occurredAtMs,event.occurredAt);assert.equal(rows(f,'release_seoul_account_exclusions').length,0);assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

test('stale, exact replay, reused sequence and changed hash preserve original response and no new capture',async t=>{
 const f=await setup(t),latest=f.event(20,'account.resumed');await f.deliver(latest);const before=sources(f),groups=rows(f,'release_seoul_provider_groups');assert.deepEqual(await (await f.deliver(latest)).json(),{received:true,replayed:true});
 assert.deepEqual(await (await f.deliver(f.event(19,'account.suspended'))).json(),{received:true});assert.deepEqual(sources(f),before);assert.deepEqual(rows(f,'release_seoul_provider_groups'),groups);
 await assert.rejects(f.deliver({...latest,type:'account.deleted'}),e=>e.status===409);await assert.rejects(f.deliver({...latest,id:'different'}),e=>e.status===409);assert.deepEqual(sources(f),before);clean(f);
});

test('actual Admin V2 signature path forwards optional capture; expired signature and late proof create no source',async t=>{
 const f=await setup(t),event=f.event(1,'email.revoked'),raw=JSON.stringify(event),timestamp=String(Math.floor(at/1000));const request=new Request('https://memory.allenlabs.org/webhooks/identity',{method:'POST',headers:{'x-memory-timestamp':timestamp,'x-memory-signature':await hmac(secret,timestamp+'.'+raw)},body:raw});assert.equal((await f.admin.identityWebhook(request)).status,200);assert.ok(sources(f).length);clean(f);
 const before=sources(f);await assert.rejects(receiveLifecycle(f.adapter,f.clock,f.event(2,'account.resumed'),JSON.stringify(f.event(2,'account.resumed')),at-300001,f.capture),e=>e.status===401);
 const original=f.capture.providerStatements.bind(f.capture);f.capture.providerStatements=async (...args)=>{(await f.db.setClock(()=>at+1000000));return original(...args);};await assert.rejects(f.verified([f.event(3,'account.resumed')]),e=>e.status===401);assert.deepEqual(sources(f),before);clean(f);
});

for(const recursion of ['ON','OFF'])test('two ordered JWT triplets preserve repeated email transitions in one atomic operation; recursion '+recursion,async t=>{
 const f=await setup(t,recursion),account=f.event(10,'account.resumed'),email=f.event(11,'email.verified');assert.equal(await f.verified([account,email]),undefined);
 const groups=rows(f,'release_seoul_provider_groups');assert.equal(groups.length,2);assert.equal(groups[0].outer_operation_id,groups[1].outer_operation_id);assert.deepEqual(groups.map(g=>g.ordinal),[0,1]);assert.deepEqual(groups.map(g=>g.publisher_event_id),[account.id,email.id]);assert.notEqual(groups[0].sub_attempt_id,groups[1].sub_attempt_id);
 const repeated=sources(f).filter(r=>r.stream_kind==='email'&&r.stream_key===issuer+'\nalice\nalice@example.com');assert.equal(repeated.length,2);assert.deepEqual(repeated.map(r=>r.source_command_id),groups.map(g=>g.sub_attempt_id));assert.equal(JSON.parse(repeated[0].record_bytes).effect.type,'entity-head');assert.equal(JSON.parse(repeated[1].record_bytes).effect.type,'email-lifecycle');assert.equal(bodies(f).filter(b=>b.id==='m1').length,1);clean(f);
});

for(const recursion of ['ON','OFF'])test('late second primitive failure rolls back whole verified operation and all grouping; recursion '+recursion,async t=>{
 const f=await setup(t,recursion);const tables=['accounts','credentials','account_emails','memberships','audit_events','release_identity_lifecycle_jwt_proofs','release_webhook_events','release_identity_lifecycle_events','release_identity_lifecycle_state','release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_dirty_spaces','release_seoul_account_exclusions','release_seoul_provider_groups'];const before=new Map(tables.map(table=>[table,rows(f,table)]));
 (await f.raw.exec("CREATE TRIGGER fail_second_group BEFORE INSERT ON release_seoul_provider_groups WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'second primitive failure'); END"));
 await assert.rejects(f.verified([f.event(10,'account.resumed'),f.event(11,'email.verified')]));for(const [table,value]of before)assert.deepEqual(rows(f,table),value,table);clean(f);
});

test('terminal deletion never resumes and older negative preparation leaves the newer head intact',async t=>{
 const f=await setup(t);await f.deliver(f.event(1,'account.suspended'));const negative=sources(f).find(r=>r.stream_kind==='subject'&&r.stream_key===issuer+'\nalice');f.advance(2000);await f.deliver(f.event(2,'account.resumed'));const latest=(await f.raw.prepare("SELECT * FROM release_seoul_authority_heads WHERE stream_kind='subject' AND stream_key=?").get(issuer+'\nalice'));
 const preparer=createSeoulProjectionPreparer(f.adapter,'durable-sql');assert.equal((await preparer.prepare(negative.revision)).status,'prepared');assert.equal((await preparer.prepare(negative.revision)).status,'already_prepared');const prepared=(await f.raw.prepare('SELECT payload_bytes FROM release_seoul_projection_events WHERE event_id=?').get(negative.event_id));assert.equal(decodeSeoulHeadEvent(new TextEncoder().encode(prepared.payload_bytes)).effect.state,'suspended');assert.deepEqual((await f.raw.prepare("SELECT * FROM release_seoul_authority_heads WHERE stream_kind='subject' AND stream_key=?").get(issuer+'\nalice')),latest);
 await f.deliver(f.event(3,'account.deleted'));const after=sources(f);await f.deliver(f.event(4,'account.resumed'));assert.deepEqual(sources(f),after);await assert.rejects(f.workspace.signIn({issuer,subject:'alice',issuedAt:f.clock(),expiresAt:f.clock()+900000,permission:'read'}));assert.deepEqual(sources(f),after);clean(f);
});

for(const reason of ['identities','product','policy-bytes','spaces','mailbox','foreign'])test('accepted provider transition remains minimal under complete account exclusion: '+reason,async t=>{
 const f=await setup(t);if(reason==='identities'||reason==='product')for(let n=0;n<(reason==='identities'?513:80);n++)(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,'retained:'+n+'x'.repeat(30),'alice',at));
 if(reason==='policy-bytes')(await f.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run(JSON.stringify(Array(30000).fill('read')),'api:alice'));
 if(reason==='spaces')for(let n=0;n<513;n++)(await f.raw.prepare("INSERT INTO spaces VALUES(?,'Retained','alice',NULL,'managed',?,'session:alice')").run('raw:'+n,at));
 if(reason==='mailbox')(await f.raw.prepare("INSERT INTO account_emails VALUES('bad','alice',?,'example.com',?,NULL)").run('a\nb@example.com',at));
 if(reason==='foreign')(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run('https://retained.example','opaque','alice',at));
 const event=f.event(1,'account.resumed');await f.deliver(event);assert.equal((await f.raw.prepare("SELECT revoked_at FROM credentials WHERE id='key:alice'").get()).revoked_at,at);const core=bodies(f);assert.ok(core.some(b=>b.kind==='identity-transition-source'&&b.origin.eventId===event.id));assert.ok(core.every(b=>['identity-transition-source','subject-source-unrepresentable'].includes(b.kind)));assert.deepEqual(rows(f,'release_seoul_account_exclusions').map(r=>r.account_id),['alice']);assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

test('real additive 0031 preserves every populated 0030 table and prior schema object',async t=>{
 const f=await fixture();t.after(()=>f.db.close());const db=f.db.raw;
 for(const name of ['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql','0028_seoul-projection-bootstrap-schema.sql','0029_seoul-projection-preparation-schema.sql','0030_seoul-projection-workspace-schema.sql'])db.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
 db.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('retained','credential','old','00000000-0000-4000-8000-000000000001','{}',?)").run(at);db.prepare("INSERT INTO release_seoul_account_exclusions VALUES('bob','unmapped','00000000-0000-4000-8000-000000000002',0,0,?)").run(at);
 const objects=db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),snapshot=table=>db.prepare('SELECT * FROM '+table).all().map(r=>JSON.stringify(r)).sort();const before=new Map(objects.filter(o=>o.type==='table'&&o.name!=='release_meta').map(o=>[o.name,snapshot(o.name)]));
 db.exec(readFileSync(new URL('../../migrations/0031_seoul-projection-provider-schema.sql',import.meta.url),'utf8'));for(const [table,data]of before)assert.deepEqual(snapshot(table),data,table);for(const object of objects)assert.deepEqual(db.prepare('SELECT name,type,sql FROM sqlite_master WHERE name=?').get(object.name),object);assert.equal(db.prepare('SELECT version FROM release_meta').get().version,31);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('unexpected retained stage rejects even unmapped no-eligibility mutation; mismatched database cannot write',async t=>{
 const f=await setup(t,'ON',false);await assert.rejects(receiveLifecycle(f.db,f.clock,f.event(1,'account.resumed'),JSON.stringify(f.event(1,'account.resumed')),at,f.capture),/database_mismatch/);assert.equal(rows(f,'release_identity_lifecycle_events').length,0);
 (await f.raw.prepare("INSERT INTO release_seoul_provider_operations(id,account_wide,address,event_count) VALUES(?,1,'',1)").run(crypto.randomUUID()));const before=rows(f,'release_seoul_provider_operations');await assert.rejects(f.deliver(f.event(1,'account.resumed')),/staging is not empty/);assert.deepEqual(rows(f,'release_seoul_provider_operations'),before);assert.equal(rows(f,'release_webhook_events').length,0);assert.equal(sources(f).length,0);
});

test('two-event planner has bounded requests and indexed full-history and streaming Space probes',async t=>{
 const f=await setup(t);await f.verified([f.event(1,'account.resumed'),f.event(2,'email.verified')]);const request=f.calls.find(r=>r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_provider_operations')));assert.ok(request);
 t.diagnostic(JSON.stringify({statements:request.statements.length,requestBytes:Buffer.byteLength(JSON.stringify(request)),largestStatement:Math.max(...request.statements.map(s=>Buffer.byteLength(s.sql))),sourceBytes:sources(f).reduce((n,r)=>n+Buffer.byteLength(r.record_bytes),0)}));
 const explain=async piece=>{const q=request.statements.find(s=>s.sql.includes(piece));assert.ok(q,piece);return (await f.raw.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.values)).map(r=>r.detail);};
 const history=explain('SET membership_count=');assert.ok(history.some(r=>r.includes('release_seoul_provider_membership_scope')&&r.includes('account_id=?')),JSON.stringify(history));assert.ok(history.some(r=>r.includes('release_seoul_provider_credential_scope')&&r.includes('account_id=?')),JSON.stringify(history));
 const spaces=explain('SET space_count=');assert.ok(spaces.some(r=>r.includes('release_spaces_organization_created')),JSON.stringify(spaces));assert.ok(!spaces.some(r=>r.includes('MERGE (UNION)')||r.includes('UNION USING TEMP')||r.includes('ORDER BY')),JSON.stringify(spaces));clean(f);
});

for(const reason of ['claims','memberships','credentials','huge-space-id','claim-product','policy-unsupported'])test('bounded retained superset excludes before normal JSON: '+reason,async t=>{
 const f=await setup(t);
 if(reason==='claims')for(let n=0;n<513;n++)(await f.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,?)').run('old:e'+n,'alice','old'+n+'@example.com','example.com',at-20,at-10));
 if(reason==='memberships')for(let n=0;n<513;n++)(await f.raw.prepare("INSERT INTO memberships VALUES(?,'org','alice','e1','member',9007199254740991,?)").run('old:m'+n,at-10));
 if(reason==='credentials')for(let n=0;n<513;n++)(await f.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,revoked_at,permission) VALUES(?,'alice','personal_key',?,?,?,'read')").run('old:k'+n,(n+100).toString(16).padStart(64,'0'),at+900000,at-10));
 if(reason==='huge-space-id')(await f.raw.prepare("INSERT INTO spaces VALUES(?,'Retained','alice',NULL,'managed',?,'session:alice')").run('x'.repeat(10000),at));
 if(reason==='claim-product'){for(let n=0;n<18;n++)(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,'p'+n,'alice',at));for(let n=0;n<30;n++)(await f.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,NULL)').run('e:'+n,'alice','a'+n+'@example.com','example.com',at));}
 if(reason==='policy-unsupported')(await f.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run('["admin"]','api:alice'));
 await f.verified([f.event(1,'account.resumed'),f.event(2,'email.verified')]);assert.ok(bodies(f).every(b=>['identity-transition-source','subject-source-unrepresentable'].includes(b.kind)));assert.equal(bodies(f).filter(b=>b.kind==='identity-transition-source').length,2);assert.equal(rows(f,'release_seoul_account_exclusions').length,1);assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);assert.equal((await f.raw.prepare("SELECT revoked_at FROM credentials WHERE id='key:alice'").get()).revoked_at,at);clean(f);
});

test('opaque JS-unit sorting and full canonical email key preserve every exact mapped alias',async t=>{
 const f=await setup(t),opaque='x'.repeat(512),mailbox='a'.repeat(64)+'@'+'b'.repeat(63)+'.'+'c'.repeat(63)+'.'+'d'.repeat(61);assert.equal(mailbox.length,254);
 for(const s of [opaque,'\ud800\udc00','\uE000'])(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,s,'alice',at));
 (await f.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,NULL)').run('max:e','alice',mailbox,mailbox.split('@')[1],at));
 await f.deliver({...f.event(1,'email.revoked',opaque),email:mailbox});const email=bodies(f).filter(b=>b.kind==='email-source');assert.equal(email.length,5);assert.ok(email.every(b=>b.address===mailbox));assert.equal(email.find(b=>b.subject===opaque).effect.type,'email-lifecycle');
 f.advance(1);await f.deliver(f.event(2,'account.deleted'));const subject=bodies(f).find(b=>b.kind==='subject-source'&&b.subject==='alice');assert.deepEqual(subject.providerIdentities.map(p=>p.subject),['alice','alias\n\uE000',opaque,'\ud800\udc00','\uE000'].sort());assert.equal(rows(f,'release_seoul_account_exclusions').length,0);clean(f);
});

test('unsupported original surrogate subject never becomes a fabricated normal or minimal identity',async t=>{
 const f=await setup(t,'ON',false),subject='opaque\uD800';(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,subject,'alice',at));await f.deliver(f.event(1,'account.resumed',subject));assert.equal((await f.raw.prepare("SELECT revoked_at FROM credentials WHERE id='key:alice'").get()).revoked_at,at);
 assert.ok(bodies(f).every(b=>b.kind==='subject-source-unrepresentable'));assert.equal(rows(f,'release_seoul_account_exclusions').length,1);assert.equal(rows(f,'release_seoul_provider_groups').length,1);assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

test('reverse JWT order uses real intermediate state and grouping history rejects update/delete/replacement',async t=>{
 const f=await setup(t);await f.verified([f.event(1,'email.revoked'),f.event(2,'account.resumed')]);const core=bodies(f);assert.equal(core.filter(b=>b.kind==='email-source'&&b.subject==='alice').length,1);assert.equal(core.filter(b=>b.kind==='membership-source').length,1);assert.equal(core.filter(b=>b.kind==='credential-source'&&b.id==='api:alice').length,1);assert.equal(core.filter(b=>b.id==='key:alice').length,1);
 const groups=rows(f,'release_seoul_provider_groups');assert.equal(groups.length,2);await assert.rejects(async()=>(await f.raw.exec("UPDATE release_seoul_provider_groups SET ordinal=ordinal")),/immutable/);await assert.rejects(async()=>(await f.raw.exec('DELETE FROM release_seoul_provider_groups')),/retained/);const g=groups[0];await assert.rejects(async()=>(await f.raw.prepare('INSERT OR REPLACE INTO release_seoul_provider_groups VALUES(?,?,?,?)').run(g.outer_operation_id,g.ordinal,g.sub_attempt_id,g.publisher_event_id)),/fresh accepted/);assert.deepEqual(rows(f,'release_seoul_provider_groups'),groups);clean(f);
});

test('late source failure and database-expired HMAC preserve original rollback and error mapping',async t=>{
 const f=await setup(t);(await f.raw.exec("CREATE TRIGGER late_provider_source BEFORE INSERT ON release_seoul_authority_changes WHEN NEW.stream_kind='subject' BEGIN SELECT RAISE(ABORT,'late provider source'); END"));await assert.rejects(f.deliver(f.event(1,'account.resumed')),/late provider source/);assert.equal(rows(f,'release_webhook_events').length,0);assert.equal(rows(f,'release_seoul_provider_groups').length,0);assert.equal((await f.raw.prepare("SELECT revoked_at FROM credentials WHERE id='key:alice'").get()).revoked_at,null);clean(f);
 (await f.db.setClock(()=>at+300001));await assert.rejects(f.deliver(f.event(2,'account.resumed')),e=>e.status===401);assert.equal(rows(f,'release_identity_lifecycle_events').length,0);clean(f);
});

test('verified lifecycle commits before a separate denied sign-in, including an unmapped negative',async t=>{
 const f=await setup(t,'ON',false);await f.verified([f.event(1,'account.suspended','never-mapped')]);const before=sources(f),groups=rows(f,'release_seoul_provider_groups');assert.equal(bodies(f)[0].kind,'identity-transition-source');
 await assert.rejects(f.workspace.signIn({issuer,subject:'never-mapped',issuedAt:at,expiresAt:at+900000,permission:'read'}));assert.deepEqual(sources(f),before);assert.deepEqual(rows(f,'release_seoul_provider_groups'),groups);assert.equal((await f.raw.prepare('SELECT account_id FROM provider_identities WHERE issuer=? AND subject=?').get(issuer,'never-mapped')),undefined);clean(f);
});

test('new stale receipt in a two-triplet operation does not claim an accepted-advancement grouping',async t=>{
 const f=await setup(t);await f.deliver(f.event(20,'account.resumed'));const oldGroups=rows(f,'release_seoul_provider_groups');await f.verified([f.event(19,'account.suspended'),f.event(21,'email.verified')]);
 const groups=rows(f,'release_seoul_provider_groups');assert.equal(groups.length,oldGroups.length+1);assert.equal(groups.at(-1).ordinal,1);assert.equal(groups.at(-1).publisher_event_id,'publisher:21');assert.ok((await f.raw.prepare('SELECT id FROM release_identity_lifecycle_events WHERE id=?').get('publisher:19')));assert.ok(!bodies(f).some(b=>b.origin?.eventId==='publisher:19'));clean(f);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,at} from './db-sqlite.mjs';
import {Admin} from '../../src/release/admin.ts';
import {createSeoulProjectionCapture} from '../../src/release/seoul-projection-capture.ts';
import {parseSeoulAuthoritySourceRow} from '../../src/release/seoul-projection-source-codec.ts';
import {createDurableDatabase} from '../../src/deprecated-durable-sql/client.ts';
import {SqlDatabaseEngine} from '../../src/deprecated-durable-sql/engine.ts';
import {hmac} from '../../src/release/util.ts';
import {createSeoulProjectionPreparer} from '../../src/release/seoul-projection-preparer.ts';
import {signSeoulProjectionRequest,verifySeoulProjectionRequest} from '../../src/release/seoul-projection-auth.ts';
import {verifySeoulHeadReceiptForEvent} from '../../src/release/seoul-projection-head-receipt-codec.ts';
import {createHeadFixture} from '../../test/postgres/seoul-projection-head-fixture.mjs';

const issuer='https://auth-api.allen.company',secret='synthetic-v1-capture-only-123456789';
const rows=async (f,table)=>(await f.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
const sources=f=>rows(f,'release_seoul_authority_changes').filter(r=>r.source_command_id!=='setup-target');
const bodies=f=>sources(f).map(r=>parseSeoulAuthoritySourceRow(r).body);
const stages=['scope','spaces','identities','attempts'].map(s=>'release_seoul_provider_v1_'+s);
async function clean(f){for(const table of stages)assert.equal(rows(f,table).length,0,table);for(const r of f.calls)if(r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_provider_v1_attempts'))){assert.ok(r.statements.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(r))<=1048576);}assert.equal((await f.raw.prepare('SELECT state FROM release_seoul_projection_state').get()).state,'backfill-required');assert.deepEqual((await f.raw.prepare('PRAGMA foreign_key_check').all()),[]);}
async function setup(t,recursive='ON',mapped=true){
 let now=at;const f=await fixture({clock:()=>now});t.after(()=>f.db.close());f.raw=f.db.raw;f.clock=()=>now;f.advance=ms=>{now+=ms;};
 for(const file of ['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql','0028_seoul-projection-bootstrap-schema.sql','0029_seoul-projection-preparation-schema.sql','0030_seoul-projection-workspace-schema.sql','0031_seoul-projection-provider-schema.sql','0032_seoul-projection-command-schema.sql'])(await f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8')));
 const schema=readFileSync(new URL('../../seoul-projection-provider-v1-schema.sql',import.meta.url),'utf8'),migration=readFileSync(new URL('../../migrations/0033_seoul-projection-provider-v1-schema.sql',import.meta.url),'utf8');assert.equal(migration,'-- Forward SaaS migration 33: seoul-projection-provider-v1-schema.sql\n'+schema);(await f.raw.exec(migration));assert.equal((await f.raw.prepare('SELECT version FROM release_meta').get()).version,33);
 (await f.raw.exec(readFileSync(new URL('../../migrations/0034_seoul-projection-target-schema.sql',import.meta.url),'utf8')));assert.equal((await f.raw.prepare('SELECT version FROM release_meta').get()).version,34);assert.deepEqual((await f.raw.prepare('PRAGMA foreign_key_check').all()),[]);(await f.raw.exec('PRAGMA recursive_triggers='+recursive));
 const storage={sql:{exec(sql,...values){const s=(await f.raw.prepare(sql)),r=s.all(...values),readonly=s.columns().length>0&&/^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());return {rowsWritten:readonly?0:Number((await f.raw.prepare('SELECT changes() n').get()).n),toArray:()=>r,[Symbol.iterator]:()=>r[Symbol.iterator]()};}},transactionSync(fn){(await f.raw.exec('BEGIN IMMEDIATE'));try{const r=fn();(await f.raw.exec('COMMIT'));return r;}catch(e){(await f.raw.exec('ROLLBACK'));throw e;}}};
 const engine=new SqlDatabaseEngine(storage,{objectName:'sql:staging:control:1'});engine.initialize();(await f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging','control','control',1,'ready','a'.repeat(64),'b'.repeat(64)));f.calls=[];
 f.adapter=createDurableDatabase({async execute(request){f.calls.push(request);await f.beforeExecute?.(request);const result=engine.execute(request);await f.afterExecute?.(request,result);return result;}},{deploymentId:'staging',databaseId:'control',kind:'control',epoch:1});f.capture=createSeoulProjectionCapture(f.adapter,'durable-sql');f.admin=new Admin({DB:f.adapter,IDENTITY_WEBHOOK_SECRET:secret},f.clock,f.capture);
 if(mapped)for(const subject of ['alice','alias\n\uE000'])(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,subject,'alice',at-200000));
 (await f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission) VALUES('api:alice','alice','m1','e1','api_key',?,?,'write')").run('1'.repeat(64),at+900000));(await f.raw.exec("INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES('api:alice','[\"read\"]',NULL)"));
 for(const id of ['s1','s2','so']){(await f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('setup-target','target',?,?, '{}',?)").run(id,crypto.randomUUID(),at));(await f.raw.prepare('INSERT INTO release_seoul_targets SELECT ?,1,max(revision) FROM release_seoul_authority_changes').run(id));}
 f.event=(id,type,subject='alice')=>({id:'v1:'+id,issuer,subject,type,...(type==='email.revoked'?{email:'alice@example.com'}:{})});
 f.request=async(value,timestamp=String(Math.floor(f.clock()/1000)),signature)=>{const raw=JSON.stringify(value);return new Request('https://memory.allenlabs.org/webhooks/identity',{method:'POST',headers:{'x-memory-timestamp':timestamp,'x-memory-signature':signature??await hmac(secret,timestamp+'.'+raw)},body:raw});};
 f.deliver=async value=>f.admin.identityWebhook(await f.request(value));return f;
}

for(const recursive of ['ON','OFF'])for(const type of ['account.disabled','email.revoked'])for(const version of [undefined,1])test('actual signed V1 '+type+' version '+version+'; '+recursive,async t=>{
 const f=await setup(t,recursive),event={...f.event('new',type),...(version===1?{version}: {})},children=new Map(['account_emails','memberships','credentials'].map(table=>[table,rows(f,table)]));assert.deepEqual(await (await f.deliver(event)).json(),{received:true});const core=bodies(f),direct=core.find(b=>b.subject==='alice'),alias=core.find(b=>b.subject!=='alice'&&b.subject);
 assert.deepEqual(direct.origin,{kind:'provider-v1',eventId:event.id,eventType:type,storedRevocationAtMs:at});assert.equal(direct.effect.type,type==='account.disabled'?'subject-lifecycle':'email-lifecycle');assert.equal(direct.effect.state,type==='account.disabled'?'deleted':'revoked');assert.equal(direct.effect.occurredAtMs,at);assert.deepEqual(alias.effect,{type:'entity-head',disposition:'changed'});
 if(type==='account.disabled'){assert.equal(core.length,2);assert.ok(core.every(b=>b.kind==='subject-source'));for(const [table,before]of children)assert.deepEqual(rows(f,table),before,table);assert.equal(direct.accountDisabledAtMs,at);}else{assert.equal(core.length,4);for(const b of core.filter(b=>b.id)){assert.equal(b.revokedAtMs,at);assert.equal(b.effect.occurredAtMs,at);}assert.equal(direct.changedClaim.id,'e1');}
 assert.ok(rows(f,'release_seoul_dirty_spaces').some(r=>r.space_id==='so'));assert.ok(!rows(f,'release_seoul_dirty_spaces').some(r=>r.space_id==='s2'));clean(f);
});

for(const type of ['account.disabled','email.revoked'])test('old permanent V1 row uses exact retained time and audit-only later receipt never renews '+type,async t=>{
 const f=await setup(t),old=at-123456;(await f.raw.prepare('INSERT INTO release_provider_revocations VALUES(?,?,?,?,?)').run(issuer,'alice',type,type==='email.revoked'?'alice@example.com':'',old));await f.deliver(f.event('old',type));const core=bodies(f);assert.ok(core.length);assert.ok(core.every(b=>b.origin.storedRevocationAtMs===old));assert.equal(core.find(b=>b.subject==='alice').effect.occurredAtMs,old);const before=sources(f),dirty=rows(f,'release_seoul_dirty_spaces'),heads=rows(f,'release_seoul_authority_heads');f.advance(2000);await f.deliver(f.event('audit',type));assert.deepEqual(sources(f),before);assert.deepEqual(rows(f,'release_seoul_dirty_spaces'),dirty);assert.deepEqual(rows(f,'release_seoul_authority_heads'),heads);clean(f);
});

test('block-only email aliases change only effective shared facts including globally masked block',async t=>{
 const f=await setup(t);await f.deliver({...f.event('block','email.revoked'),email:'absent@example.com'});const first=bodies(f);assert.equal(first.length,2);assert.ok(first.every(b=>b.liveClaim===null&&b.changedClaim===null&&b.addressBlocked));
 (await f.raw.prepare("INSERT INTO domains VALUES('domain','org','example.com',?,NULL)").run(at+900000));(await f.raw.exec("INSERT INTO domain_managers VALUES('domain','m1',NULL)"));(await f.raw.prepare("INSERT INTO revocations VALUES('masked-receipt','domain','session:alice',NULL,'domain','masked@example.com',?)").run(at));await f.deliver({...f.event('masked','email.revoked'),email:'masked@example.com'});const second=bodies(f).slice(first.length);assert.equal(second.length,1);assert.equal(second[0].subject,'alice');clean(f);
});

for(const type of ['account.disabled','email.revoked'])test('unmapped direct V1 negative is minimal '+type,async t=>{const f=await setup(t,'ON',false);await f.deliver(f.event('unmapped',type));const core=bodies(f);assert.equal(core.length,1);assert.equal(core[0].kind,'identity-transition-source');assert.equal(rows(f,'release_seoul_account_exclusions').length,0);clean(f);});

for(const type of ['account.disabled','email.revoked'])test('alias own legacy tombstone and unrelated V2 state never select direct effect '+type,async t=>{
 const f=await setup(t),alias='alias\n\uE000',address=type==='email.revoked'?'alice@example.com':'';
 (await f.raw.prepare('INSERT INTO release_provider_revocations VALUES(?,?,?,?,?)').run(issuer,alias,type,address,at-98765));await f.deliver(f.event('legacy-alias',type));const b=bodies(f).find(b=>b.subject===alias);assert.deepEqual(b.effect,{type:'entity-head',disposition:'changed'});assert.equal(b.origin.storedRevocationAtMs,at);assert.equal(type==='account.disabled'?b.legacyDisabled:b.legacyRevoked,true);clean(f);
});

test('valid stored aliases keep UTF-16 sort and public V1 rejects more than512 UTF-8 bytes',async t=>{
 const f=await setup(t),aliases=['가'.repeat(200),'😀'.repeat(256),'\uD800\uDC00','\uE000','direct\nopaque'];for(const subject of aliases)(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,subject,'alice',at));
 await assert.rejects(f.deliver(f.event('too-long','account.disabled','가'.repeat(171))),e=>e.status===400);assert.equal(rows(f,'release_webhook_events').length,0);
 await f.deliver(f.event('opaque','account.disabled','direct\nopaque'));const core=bodies(f);assert.equal(core.length,7);assert.equal(core.find(b=>b.subject==='direct\nopaque').effect.type,'subject-lifecycle');assert.ok(core.filter(b=>b.subject!=='direct\nopaque').every(b=>b.effect.type==='entity-head'));assert.deepEqual(core[0].providerIdentities.map(p=>p.subject),['alice','alias\n\uE000',...aliases].sort());clean(f);
});

for(const tail of ['\uD800','\uDC00'])for(const type of ['account.disabled','email.revoked'])test('original unpaired '+tail.charCodeAt(0)+' never becomes a provider transition '+type,async t=>{
 const f=await setup(t,'ON',false),subject='original'+tail;(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,subject,'alice',at));await f.deliver(f.event('surrogate',type,subject));const core=bodies(f);assert.equal(core.length,1);assert.equal(core[0].kind,'subject-source-unrepresentable');assert.deepEqual(rows(f,'release_seoul_account_exclusions').map(r=>r.account_id),['alice']);assert.equal(rows(f,'release_webhook_events').length,1);assert.equal(rows(f,'release_provider_revocations').length,1);clean(f);
});

for(const type of ['account.disabled','email.revoked'])test('retained invalid time records only an actual affected account marker '+type,async t=>{
 const f=await setup(t);(await f.raw.prepare('INSERT INTO release_provider_revocations VALUES(?,?,?,?,?)').run(issuer,'alice',type,type==='email.revoked'?'alice@example.com':'',-1));await f.deliver(f.event('bad-time',type));assert.ok(bodies(f).every(b=>b.kind==='subject-source-unrepresentable'));assert.equal(bodies(f).length,1);const before=sources(f);await f.deliver(f.event('bad-time-audit',type));assert.deepEqual(sources(f),before);clean(f);
});

for(const type of ['account.disabled','email.revoked'])test('audit-only unsupported representation creates no exclusion '+type,async t=>{
 const f=await setup(t),email='absent@example.com';(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run('https://unsupported.example','alias','alice',at));(await f.raw.prepare('INSERT INTO release_provider_revocations VALUES(?,?,?,?,?)').run(issuer,'alice',type,type==='email.revoked'?email:'',at-1));
 if(type==='account.disabled')(await f.raw.prepare("UPDATE accounts SET disabled_at=? WHERE id='alice'").run(at-1));else (await f.raw.prepare("INSERT INTO release_external_email_blocks VALUES('alice',?,?)").run(email,at-1));
 await f.deliver({...f.event('audit-excluded',type),...(type==='email.revoked'?{email}:{})});assert.equal(sources(f).length,0);assert.equal(rows(f,'release_seoul_account_exclusions').length,0);clean(f);
});

for(const type of ['account.disabled','email.revoked'])test('first mapping after preflight is resolved in the actual batch '+type,async t=>{
 const f=await setup(t,'ON',false);f.beforeExecute=async r=>{if(!r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_provider_v1_attempts')))return;f.beforeExecute=null;(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,'alice','alice',at));};await f.deliver(f.event('mapping-race',type));assert.ok(bodies(f).some(b=>b.accountId==='alice'));assert.ok(!bodies(f).some(b=>b.kind==='identity-transition-source'));clean(f);
});

for(const conflicting of [false,true])test('same event winner between preflight and batch keeps original catch semantics conflict='+conflicting,async t=>{
 const f=await setup(t),event=f.event('same-event','account.disabled'),bare=new Admin({DB:f.adapter,IDENTITY_WEBHOOK_SECRET:secret},f.clock);
 f.beforeExecute=async r=>{if(!r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_provider_v1_attempts')))return;f.beforeExecute=null;await bare.identityWebhook(await f.request(conflicting?{...event,subject:'other'}:event));};
 if(conflicting)await assert.rejects(f.deliver(event),e=>e.status===409);else assert.deepEqual(await (await f.deliver(event)).json(),{received:true});assert.equal(sources(f).length,0);assert.equal(rows(f,'release_webhook_events').length,1);clean(f);
});

test('lost batch acknowledgement reads actual receipt and exact replay does not recapture',async t=>{
 const f=await setup(t),event=f.event('lost-ack','email.revoked');f.afterExecute=async r=>{if(!r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_provider_v1_attempts')))return;f.afterExecute=null;throw Error('synthetic lost acknowledgement');};assert.deepEqual(await (await f.deliver(event)).json(),{received:true});const before=sources(f);assert.ok(before.length);assert.deepEqual(await (await f.deliver(event)).json(),{received:true,replayed:true});assert.deepEqual(sources(f),before);await assert.rejects(f.deliver({...event,email:'different@example.com'}),e=>e.status===409);clean(f);
});

test('bad HMAC, application expiry, write-clock expiry and ignored receipt keep original denial',async t=>{
 const f=await setup(t),event=f.event('denied','account.disabled');await assert.rejects(f.admin.identityWebhook(await f.request(event,undefined,'bad')),e=>e.status===401);await assert.rejects(f.admin.identityWebhook(await f.request(event,String(Math.floor(at/1000)-301))),e=>e.status===401);
 (await f.db.setClock(()=>at+300001));await assert.rejects(f.deliver(event),e=>e.status===401);(await f.db.setClock(f.clock));(await f.raw.exec("CREATE TRIGGER ignore_v1_receipt BEFORE INSERT ON release_webhook_events BEGIN SELECT RAISE(IGNORE); END"));await assert.rejects(f.deliver(event),e=>e.status===401);assert.equal(rows(f,'release_webhook_events').length,0);assert.equal(rows(f,'release_provider_revocations').length,0);assert.equal(sources(f).length,0);clean(f);
});

for(const recursive of ['ON','OFF'])for(const type of ['account.disabled','email.revoked'])test('V1 preserves current captured revision including in-batch progress '+type+'; '+recursive,async t=>{
 const f=await setup(t,recursive),prior=(await f.raw.prepare('SELECT max(revision) n FROM release_seoul_authority_changes').get()).n;(await f.raw.prepare("INSERT INTO release_seoul_dirty_spaces VALUES('so',?,1)").run(prior));(await f.raw.exec(`CREATE TRIGGER advance_captured AFTER INSERT ON release_seoul_authority_changes WHEN NEW.source_command_id<>'setup-target' BEGIN UPDATE release_seoul_dirty_spaces SET captured_revision=${prior} WHERE space_id='so'; END`));await f.deliver(f.event('captured',type));const dirty=(await f.raw.prepare("SELECT * FROM release_seoul_dirty_spaces WHERE space_id='so'").get());assert.equal(dirty.captured_revision,prior);assert.equal(dirty.dirty_revision,Math.max(...sources(f).map(r=>r.revision)));assert.ok(dirty.dirty_revision>prior);clean(f);
});

for(const reason of ['identities','combined-keys','vector-product','identity-bytes','policy-bytes','policy-state','spaces','space-id','foreign'])test('complete account representation excluded before normal JSON: '+reason,async t=>{
 const f=await setup(t),type=reason.startsWith('policy')?'email.revoked':'account.disabled';
 if(['identities','combined-keys','vector-product','identity-bytes'].includes(reason)){const count=reason==='identities'?513:reason==='combined-keys'?256:reason==='vector-product'?80:100;for(let n=0;n<count;n++)(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,'alias:'+n+'x'.repeat(reason==='identity-bytes'?450:30),'alice',at));}
 if(reason==='policy-bytes')(await f.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run(JSON.stringify(Array(30000).fill('read')),'api:alice'));if(reason==='policy-state')(await f.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run('["admin"]','api:alice'));
 if(reason==='spaces')for(let n=0;n<513;n++)(await f.raw.prepare("INSERT INTO spaces VALUES(?,'Raw','alice',NULL,'managed',?,'session:alice')").run('raw:'+n,at));if(reason==='space-id')(await f.raw.prepare("INSERT INTO spaces VALUES(?,'Raw','alice',NULL,'managed',?,'session:alice')").run('x'.repeat(129),at));if(reason==='foreign')(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run('https://other.example','alias','alice',at));
 await f.deliver(f.event('bounded',type));const core=bodies(f);assert.ok(core.every(b=>['identity-transition-source','subject-source-unrepresentable'].includes(b.kind)));assert.equal(core.filter(b=>b.kind==='identity-transition-source').length,1);assert.deepEqual(rows(f,'release_seoul_account_exclusions').map(r=>r.account_id),['alice']);assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);clean(f);
});

for(const type of ['account.disabled','email.revoked'])test('irrelevant revoked claim and credential history never excludes '+type,async t=>{
 const f=await setup(t);for(let n=0;n<600;n++){(await f.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,?)').run('old:e'+n,'alice','old'+n+'@example.com','example.com',at-20,at-10));(await f.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,revoked_at,permission) VALUES(?,'alice','personal_key',?,?,?,'read')").run('old:k'+n,(n+100).toString(16).padStart(64,'0'),at+900000,at-10));}
 await f.deliver(f.event('history',type));assert.equal(rows(f,'release_seoul_account_exclusions').length,0);assert.ok(bodies(f).length);assert.ok(!bodies(f).some(b=>b.id?.startsWith('old:')));clean(f);
});

for(const recursive of ['ON','OFF'])for(const phase of ['source','head','dirty','scope-cleanup','spaces-cleanup','identities-cleanup','attempt-cleanup'])test('late '+phase+' rolls back original receipt, permanent row, cascades and capture; '+recursive,async t=>{
 const f=await setup(t,recursive),tables=['accounts','account_emails','memberships','credentials','audit_events','release_webhook_events','release_provider_revocations','release_external_email_blocks','release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_dirty_spaces','release_seoul_account_exclusions'],before=new Map(tables.map(table=>[table,rows(f,table)])),target=phase==='source'?'release_seoul_authority_changes':phase==='head'?'release_seoul_authority_heads':phase==='dirty'?'release_seoul_dirty_spaces':'release_seoul_provider_v1_'+(phase==='attempt-cleanup'?'attempts':phase.replace('-cleanup',''));
 (await f.raw.exec(`CREATE TRIGGER fail_v1_late BEFORE ${phase.endsWith('cleanup')?'DELETE':'INSERT'} ON ${target} BEGIN SELECT RAISE(ABORT,'late V1 failure'); END`));await assert.rejects(f.deliver(f.event('rollback','email.revoked')),/late V1 failure/);for(const [table,data]of before)assert.deepEqual(rows(f,table),data,table);clean(f);
});

test('fresh staging guard runs even unmapped, and same database identity is mandatory',async t=>{
 const f=await setup(t,'ON',false);assert.throws(()=>new Admin({DB:f.db,IDENTITY_WEBHOOK_SECRET:secret},f.clock,f.capture),/database_mismatch/);
 (await f.raw.prepare("INSERT INTO release_seoul_provider_v1_attempts(id,publisher_event_id,body_hash,issuer,subject,address,event_type,key_supported) VALUES(?,?,?,?,?,'','account.disabled',1)").run(crypto.randomUUID(),'stale','a'.repeat(64),issuer,'stale'));const before=rows(f,stages.at(-1));await assert.rejects(f.deliver(f.event('stage','account.disabled')),/staging is not empty/);assert.deepEqual(rows(f,stages.at(-1)),before);assert.equal(rows(f,'release_webhook_events').length,0);
});

for(const type of ['account.disabled','email.revoked'])test('bounded SQL plan and source/request sizes '+type,async t=>{
 const f=await setup(t);await f.deliver(f.event('plan',type));const request=f.calls.find(r=>r.statements.some(s=>s.sql.includes('INSERT INTO release_seoul_provider_v1_attempts'))),explain=async piece=>{const q=request.statements.find(s=>s.sql.includes(piece));assert.ok(q,piece);return (await f.raw.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.values)).map(r=>r.detail);};
 const children=explain('SET membership_count=');assert.ok(children.some(r=>r.includes(type==='account.disabled'?'release_seoul_provider_membership_scope':'release_seoul_command_live_memberships')),JSON.stringify(children));if(type==='email.revoked')assert.ok(children.some(r=>r.includes('release_seoul_command_live_email_credentials')),JSON.stringify(children));const spaces=explain('SET space_count=');assert.ok(spaces.some(r=>r.includes('release_spaces_organization_created')),JSON.stringify(spaces));
 if(type==='account.disabled'){const probes=request.statements.slice(2,request.statements.findIndex(s=>s.sql.includes('before_bytes=CASE')));assert.ok(!probes.some(s=>s.sql.includes('FROM credentials')||s.sql.includes('FROM account_emails')),probes.map(s=>s.sql).join('\n'));}
 t.diagnostic(JSON.stringify({type,statements:request.statements.length,requestBytes:Buffer.byteLength(JSON.stringify(request)),largestStatement:Math.max(...request.statements.map(s=>Buffer.byteLength(s.sql))),sourceBytes:sources(f).reduce((n,r)=>n+Buffer.byteLength(r.record_bytes),0),largestSource:Math.max(...sources(f).map(r=>Buffer.byteLength(r.record_bytes)))}));clean(f);
});

test('a new exact account tombstone still emits direct deletion when a nonempty legacy address already denies',async t=>{
 const f=await setup(t);(await f.raw.prepare('INSERT INTO release_provider_revocations VALUES(?,?,?,?,?)').run(issuer,'alice','account.disabled','retained@example.com',at-123));(await f.raw.prepare("UPDATE accounts SET disabled_at=? WHERE id='alice'").run(at-321));await f.deliver(f.event('exact-tuple','account.disabled'));const core=bodies(f);assert.equal(core.length,1);assert.equal(core[0].subject,'alice');assert.equal(core[0].effect.type,'subject-lifecycle');assert.equal(core[0].effect.occurredAtMs,at);const before=sources(f);await f.deliver(f.event('exact-audit','account.disabled'));assert.deepEqual(sources(f),before);clean(f);
});

for(const type of ['account.disabled','email.revoked'])test('direct and alias V2 history stays independent of current V1 receipt and stored time '+type,async t=>{
 const f=await setup(t,'ON',false),bare=new Admin({DB:f.adapter,IDENTITY_WEBHOOK_SECRET:secret},f.clock),subjects=['alice','alias\n\uE000'];for(const [i,subject]of subjects.entries()){const old={version:2,id:'old:v2:'+i,sequence:i+1,issuer,subject,type:type==='account.disabled'?'account.resumed':'email.verified',occurredAt:at-30000-i,email:type==='email.revoked'?'alice@example.com':null};await bare.identityWebhook(await f.request(old));(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,subject,'alice',at-10000));}
 // The second alias was unmapped when its V2 event applied; the first mapping
 // remains unrelated to that exact publisher subject until the insert above.
 (await f.raw.prepare('INSERT INTO release_provider_revocations VALUES(?,?,?,?,?)').run(issuer,'alice',type,type==='email.revoked'?'alice@example.com':'',at-22222));f.advance(1000);await f.deliver(f.event('with-v2',type));const core=bodies(f).filter(b=>b.subject);assert.equal(core.length,2);for(const b of core){assert.equal(b.lifecycle.eventId,'old:v2:'+subjects.indexOf(b.subject));assert.equal(b.origin.eventId,'v1:with-v2');assert.equal(b.origin.storedRevocationAtMs,at-22222);assert.equal(b.effect.type,b.subject==='alice'?(type==='account.disabled'?'subject-lifecycle':'email-lifecycle'):'entity-head');}clean(f);
});

test('email revoked history is filtered before live membership/API sentinels',async t=>{
 const f=await setup(t);for(let n=0;n<600;n++){(await f.raw.prepare("INSERT INTO memberships VALUES(?,'org','alice','e1','member',?,?)").run('old:m'+n,at+900000,at-10));(await f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,revoked_at,permission) VALUES(?,'alice','m1','e1','api_key',?,?,?,'read')").run('old:api'+n,(n+5000).toString(16).padStart(64,'0'),at+900000,at-10));}
 await f.deliver(f.event('live-only','email.revoked'));assert.equal(rows(f,'release_seoul_account_exclusions').length,0);assert.equal(bodies(f).length,4);assert.ok(!bodies(f).some(b=>b.id?.startsWith('old:')));clean(f);
});

for(const recursive of ['ON','OFF'])for(const type of ['account.disabled','email.revoked'])for(const stage of ['tombstone','physical'])test('ignored original '+stage+' preserves central success and emits only representable evidence '+type+'; '+recursive,async t=>{
 const f=await setup(t,recursive,false);(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(issuer,'alice','alice',at));if(stage==='tombstone')(await f.raw.exec("CREATE TRIGGER ignore_v1_tombstone BEFORE INSERT ON release_provider_revocations BEGIN SELECT RAISE(IGNORE); END"));else if(type==='account.disabled')(await f.raw.exec("CREATE TRIGGER ignore_v1_disable BEFORE UPDATE ON accounts BEGIN SELECT RAISE(IGNORE); END"));else (await f.raw.exec("CREATE TRIGGER ignore_v1_claim BEFORE UPDATE ON account_emails BEGIN SELECT RAISE(IGNORE); END"));
 assert.deepEqual(await (await f.deliver(f.event('ignored',type))).json(),{received:true});const core=bodies(f);assert.equal(core.length,stage==='physical'&&type==='email.revoked'?2:1);assert.ok(core.every(b=>['subject-source-unrepresentable','identity-transition-source'].includes(b.kind)));assert.equal(core.filter(b=>b.kind==='identity-transition-source').length,stage==='tombstone'?0:1);assert.deepEqual(rows(f,'release_seoul_account_exclusions').map(r=>r.account_id),['alice']);assert.equal(rows(f,'release_seoul_dirty_spaces').length,0);assert.equal(rows(f,'release_provider_revocations').length,stage==='tombstone'?0:1);
 if(stage==='tombstone'){assert.ok(!core.some(b=>b.origin));assert.equal(type==='account.disabled'?(await f.raw.prepare("SELECT disabled_at n FROM accounts WHERE id='alice'").get()).n:(await f.raw.prepare("SELECT revoked_at n FROM account_emails WHERE id='e1'").get()).n,at);}else{assert.equal(core.find(b=>b.kind==='identity-transition-source').origin.storedRevocationAtMs,at);assert.equal(type==='account.disabled'?(await f.raw.prepare("SELECT disabled_at n FROM accounts WHERE id='alice'").get()).n:(await f.raw.prepare("SELECT revoked_at n FROM account_emails WHERE id='e1'").get()).n,null);}
 const before=sources(f),excluded=rows(f,'release_seoul_account_exclusions');assert.deepEqual(await (await f.deliver(f.event('ignored-audit',type))).json(),{received:true});assert.deepEqual(sources(f),before);assert.deepEqual(rows(f,'release_seoul_account_exclusions'),excluded);assert.equal(rows(f,'release_webhook_events').length,2);clean(f);
});

test('real additive0033 preserves all populated0032 tables and prior schema objects',async t=>{
 const f=await fixture();t.after(()=>f.db.close());const db=f.db.raw;for(const name of ['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql','0028_seoul-projection-bootstrap-schema.sql','0029_seoul-projection-preparation-schema.sql','0030_seoul-projection-workspace-schema.sql','0031_seoul-projection-provider-schema.sql','0032_seoul-projection-command-schema.sql'])db.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
 db.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES('retained','credential','old','00000000-0000-4000-8000-000000000001','{}',?)").run(at);db.prepare("INSERT INTO release_seoul_account_exclusions VALUES('bob','unmapped','00000000-0000-4000-8000-000000000002',0,0,?)").run(at);
 const objects=db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),snapshot=table=>db.prepare('SELECT * FROM '+table).all().map(r=>JSON.stringify(r)).sort(),before=new Map(objects.filter(o=>o.type==='table'&&o.name!=='release_meta').map(o=>[o.name,snapshot(o.name)]));
 db.exec(readFileSync(new URL('../../migrations/0033_seoul-projection-provider-v1-schema.sql',import.meta.url),'utf8'));for(const [table,data]of before)assert.deepEqual(snapshot(table),data,table);for(const object of objects)assert.deepEqual(db.prepare('SELECT name,type,sql FROM sqlite_master WHERE name=?').get(object.name),object);assert.equal(db.prepare('SELECT version FROM release_meta').get().version,33);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

for(const reason of ['live-members','live-api','email-spaces','old-members'])test('complete indexed dependent scope excludes overflow '+reason,async t=>{
 const f=await setup(t);for(let n=0;n<513;n++){
  if(reason==='live-members'){(await f.raw.prepare('INSERT INTO organizations(id) VALUES(?)').run('o:'+n));(await f.raw.prepare("INSERT INTO memberships VALUES(?,?,'alice','e1','member',?,NULL)").run('m:'+n,'o:'+n,at+900000));}
  if(reason==='live-api')(await f.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission) VALUES(?,'alice','m1','e1','api_key',?,?,'read')").run('api:'+n,(n+1000).toString(16).padStart(64,'0'),at+900000));
  if(reason==='email-spaces')(await f.raw.prepare("INSERT INTO spaces VALUES(?,'Raw',NULL,'org','managed',?,'session:alice')").run('raw:'+n,at));
  if(reason==='old-members')(await f.raw.prepare("INSERT INTO memberships VALUES(?,'org','alice','e1','member',?,?)").run('old:m'+n,at+900000,at-1));
 }
 await f.deliver(f.event('live-bound',reason==='old-members'?'account.disabled':'email.revoked'));const core=bodies(f);assert.ok(core.every(b=>['subject-source-unrepresentable','identity-transition-source'].includes(b.kind)));assert.equal(core.filter(b=>b.kind==='identity-transition-source').length,1);assert.deepEqual(rows(f,'release_seoul_account_exclusions').map(r=>r.account_id),['alice']);clean(f);
});

for(const recursive of ['ON','OFF'])test('exclusion insert failure rolls back central mutation and minimal negative; '+recursive,async t=>{
 const f=await setup(t,recursive);(await f.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run('https://foreign.example','alias','alice',at));(await f.raw.exec("CREATE TRIGGER fail_v1_exclusion BEFORE INSERT ON release_seoul_account_exclusions BEGIN SELECT RAISE(ABORT,'exclusion failed'); END"));const before=new Map(['accounts','account_emails','memberships','credentials','audit_events'].map(table=>[table,rows(f,table)]));await assert.rejects(f.deliver(f.event('exclude-fail','email.revoked')),/exclusion failed/);for(const [table,data]of before)assert.deepEqual(rows(f,table),data,table);assert.equal(rows(f,'release_webhook_events').length,0);assert.equal(rows(f,'release_provider_revocations').length,0);assert.equal(sources(f).length,0);clean(f);
});

for(const recursive of ['ON','OFF'])for(const type of ['account.disabled','email.revoked'])test('ignored final V1 attempt cleanup aborts before commit '+type+'; '+recursive,async t=>{
 const f=await setup(t,recursive),tables=['accounts','account_emails','memberships','credentials','audit_events','release_webhook_events','release_provider_revocations','release_external_email_blocks','release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_dirty_spaces','release_seoul_account_exclusions',...stages],before=new Map(tables.map(table=>[table,rows(f,table)]));
 (await f.raw.exec("CREATE TRIGGER ignore_v1_final_cleanup BEFORE DELETE ON release_seoul_provider_v1_attempts BEGIN SELECT RAISE(IGNORE); END"));
 await assert.rejects(f.deliver(f.event('ignored-final-cleanup',type)),/integer overflow/);
 for(const [table,data]of before)assert.deepEqual(rows(f,table),data,table);
 clean(f);
});

test('actual V1 normal and minimal negatives prepare, sign, apply and replay without positive PG changes',async t=>{
 const f=await setup(t),pg=await createHeadFixture(t);await f.deliver(f.event('pg-email','email.revoked'));f.advance(1000);await f.deliver(f.event('pg-account','account.disabled'));await f.deliver(f.event('pg-unmapped','account.disabled','never-mapped'));
 const positive=async()=> (await pg.db.query(`SELECT jsonb_build_object('accounts',(SELECT jsonb_agg(a) FROM memory_identity.accounts a),'credentials',(SELECT jsonb_agg(c) FROM memory_identity.credentials c),'spaces',(SELECT jsonb_agg(s) FROM memory_control.spaces s),'grants',(SELECT jsonb_agg(g) FROM memory_identity.pat_space_grants g),'usage',(SELECT jsonb_agg(u) FROM memory_ops.space_usage u)) value`)).rows[0].value;
 const before=await positive(),preparer=createSeoulProjectionPreparer(f.adapter,'durable-sql'),key=await crypto.subtle.importKey('raw',new Uint8Array(32).fill(43),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']),endpoint='https://v1.fixture.test/internal/v1/seoul/projections',utf8=new TextEncoder();
 for(const row of sources(f).slice().reverse()){
  assert.equal((await preparer.prepare(row.revision)).status,'prepared');const event=(await f.raw.prepare('SELECT payload_bytes,payload_sha256 FROM release_seoul_projection_events WHERE event_id=?').get(row.event_id)),body=utf8.encode(event.payload_bytes),headers=await signSeoulProjectionRequest(key,{method:'POST',url:endpoint,body,timestampMs:at}),request=new Request(endpoint,{method:'POST',headers,body}),actual=new Uint8Array(await request.arrayBuffer()),verified=await verifySeoulProjectionRequest(key,request,actual,at),receiptText=await pg.apply(new TextDecoder().decode(verified.rawBody),verified.transportPayloadSha256),receipt=await verifySeoulHeadReceiptForEvent(utf8.encode(receiptText),body);
  assert.equal(receipt.outcome,'applied');assert.equal(receipt.sourceRevision,row.revision);assert.equal(await pg.status(row.event_id,event.payload_sha256),receiptText);const state=await pg.state();assert.equal(await pg.apply(event.payload_bytes,event.payload_sha256),receiptText);assert.deepEqual(await pg.state(),state);assert.equal((await f.raw.prepare('SELECT state FROM release_seoul_projection_deliveries WHERE event_id=?').get(row.event_id)).state,'pending');
 }
 const terminal=(await pg.db.query('SELECT kind,stream_key FROM memory_ops.identity_projection_tombstones ORDER BY kind,stream_key')).rows;assert.deepEqual(terminal,[{kind:'credential',stream_key:'api:alice'},{kind:'membership',stream_key:'m1'},{kind:'subject',stream_key:issuer+'\nalice'},{kind:'subject',stream_key:issuer+'\nnever-mapped'}]);assert.deepEqual(await positive(),before);clean(f);
});

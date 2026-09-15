import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fixture,at} from './db.mjs';
import {createDurableDatabase} from '../../src/durable-sql/client.ts';
import {SqlDatabaseEngine} from '../../src/durable-sql/engine.ts';
import {createSeoulProjectionPreparer} from '../../src/release/seoul-projection-preparer.ts';
import {prepareSeoulHeadCandidate} from '../../src/release/seoul-projection-source-codec.ts';

const schema=new URL('../../seoul-projection-target-schema.sql',import.meta.url),migration=new URL('../../migrations/0034_seoul-projection-target-schema.sql',import.meta.url),moduleUrl=new URL('../../src/release/seoul-projection-target-writer.ts',import.meta.url);
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const command=(n,expectedRevision=null,selected=true,spaceId='s1')=>({commandId:uuid(n),spaceId,expectedRevision,selected,operatorReference:'fixture:operator'});
const tableNames=['release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_targets','release_seoul_target_receipts','release_seoul_dirty_spaces','release_seoul_prepared_sources','release_seoul_projection_events','release_seoul_projection_deliveries','release_seoul_projection_lock','release_seoul_published_snapshots','release_seoul_target_attempt'];
const rows=(f,name)=>f.raw.prepare('SELECT * FROM '+name+' ORDER BY rowid').all().map(r=>({...r}));
const snapshot=f=>Object.fromEntries(tableNames.map(n=>[n,rows(f,n)]));
const oldMigrations=['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql','0028_seoul-projection-bootstrap-schema.sql','0029_seoul-projection-preparation-schema.sql','0030_seoul-projection-workspace-schema.sql','0031_seoul-projection-provider-schema.sql','0032_seoul-projection-command-schema.sql','0033_seoul-projection-provider-v1-schema.sql'];
async function setup(t,recursive='ON',install=true,mode='durable-sql'){
 let now=at;const f=await fixture({clock:()=>now});t.after(()=>f.db.close());f.raw=f.db.raw;f.advance=ms=>{now+=ms;};
 for(const file of oldMigrations)f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,33);f.raw.exec('PRAGMA recursive_triggers='+recursive);f.calls=[];f.batches=0;f.reads=0;
 if(!install)return f;
 assert.ok(existsSync(schema),'target schema file exists');assert.equal(readFileSync(migration,'utf8'),'-- Forward SaaS migration 34: seoul-projection-target-schema.sql\n'+readFileSync(schema,'utf8'));f.raw.exec(readFileSync(migration,'utf8'));assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,34);
 f.raw.exec(readFileSync(new URL('../../migrations/0035_seoul-projection-target-manifest-schema.sql',import.meta.url),'utf8'));assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,35);
 const storage={sql:{exec(sql,...values){const statement=f.raw.prepare(sql),result=statement.all(...values),readonly=statement.columns().length>0&&/^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());return {rowsWritten:readonly?0:Number(f.raw.prepare('SELECT changes() n').get().n),toArray:()=>result,[Symbol.iterator]:()=>result[Symbol.iterator]()};}},transactionSync(fn){f.raw.exec('BEGIN IMMEDIATE');try{const r=fn();f.raw.exec('COMMIT');return r;}catch(e){f.raw.exec('ROLLBACK');throw e;}}};
 f.engine=new SqlDatabaseEngine(storage,{objectName:'sql:staging:control:1'});f.engine.initialize();f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging','control','control',1,'ready','a'.repeat(64),'b'.repeat(64));
 const identity={deploymentId:'staging',databaseId:'control',kind:'control',epoch:1};
 const execute=async request=>{f.calls.push(structuredClone(request));const batch=request.statements.length>1;if(batch){f.batches++;await f.beforeBatch?.(request);}else{f.reads++;await f.beforeRead?.(request);}const result=mode==='durable-sql'?f.engine.execute(request):storage.transactionSync(()=>request.statements.map(s=>{const q=f.raw.prepare(s.sql),r=q.all(...s.values);return {success:true,results:r,meta:{changes:0}};}));f.maximumResponseBytes=Math.max(f.maximumResponseBytes??0,Buffer.byteLength(JSON.stringify(result)));if(batch)await f.afterCommit?.(request,result);else await f.afterRead?.(request,result);return result;};
 const owned=new WeakMap();function prepare(sql,values=[]){const statement={bind(...parameters){return prepare(sql,parameters);},async first(){return (await execute({identity,statements:[{sql,values,mode:'first'}]}))[0].results[0]??null;},async all(){return (await execute({identity,statements:[{sql,values,mode:'all'}]}))[0];},async run(){return this.all();}};owned.set(statement,{sql,values,mode:'all'});return statement;}
 f.adapter=mode==='durable-sql'?createDurableDatabase({execute},identity):{prepare,batch(statements){return execute({identity,statements:statements.map(s=>owned.get(s))});},withSession(){return {prepare};}};assert.ok(existsSync(moduleUrl),'target writer module exists');const {createSeoulProjectionTargetWriter}=await import(moduleUrl);f.writer=createSeoulProjectionTargetWriter(f.adapter,mode);return f;
}
function clean(f){assert.deepEqual(rows(f,'release_seoul_target_attempt'),[]);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(f.raw.prepare('SELECT state FROM release_seoul_projection_state').get().state,'backfill-required');}
const sourceByEvent=(f,event)=>({...f.raw.prepare('SELECT revision,source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at FROM release_seoul_authority_changes WHERE event_id=?').get(event)});

test('additive0034 preserves populated0033 rows and every previous schema object',async t=>{
 const f=await setup(t,'ON',false),objects=f.raw.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),before=new Map(objects.filter(o=>o.type==='table'&&!o.name.startsWith('release_fts')).map(o=>[o.name,rows(f,o.name)]));
 assert.ok(existsSync(schema),'target schema file exists');assert.equal(readFileSync(migration,'utf8'),'-- Forward SaaS migration 34: seoul-projection-target-schema.sql\n'+readFileSync(schema,'utf8'));f.raw.exec(readFileSync(migration,'utf8'));
 for(const [name,data]of before)if(name!=='release_meta')assert.deepEqual(rows(f,name),data,name);for(const object of objects)assert.deepEqual(f.raw.prepare('SELECT name,type,sql FROM sqlite_master WHERE name=?').get(object.name),object,object.name);
 assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,34);clean(f);
});

test('strict owned commands and unsupported factories make zero database calls',async()=>{
 assert.ok(existsSync(moduleUrl),'target writer module exists');const {createSeoulProjectionTargetWriter}=await import(moduleUrl);let calls=0;const db={prepare(){calls++;throw Error();},batch(){calls++;throw Error();},withSession(){calls++;throw Error();}};
 for(const adapter of [null,'other'])assert.throws(()=>createSeoulProjectionTargetWriter(db,adapter),/seoul_target_writer_adapter_unsupported/);const writer=createSeoulProjectionTargetWriter(db,'durable-sql');let invoked=0;
 const accessor=Object.defineProperty({...command(1)},'spaceId',{enumerable:true,get(){invoked++;return 's1';}});
 for(const input of [null,[],{},accessor,{...command(1),extra:1},{...command(1),expectedRevision:-0},{...command(1),expectedRevision:0},{...command(1),expectedRevision:Number.MAX_SAFE_INTEGER+1},{...command(1),selected:1},{...command(1),spaceId:'s'.repeat(129)},{...command(1),operatorReference:'x'.repeat(257)},{...command(1),operatorReference:' with space'},{...command(1),commandId:uuid(1).toUpperCase().replace('00000000','ABCDEF00')}])assert.deepEqual(await writer.setTarget(input),{status:'invalid_command'});
 assert.equal(calls,0);assert.equal(invoked,0);
});

for(const recursive of ['ON','OFF'])for(const selected of [true,false])for(const mode of ['durable-sql','native-d1'])test(`first explicit target ${selected} records exact source/receipt/head/dirty; ${recursive}, ${mode}`,async t=>{
 const f=await setup(t,recursive,true,mode),input=command(1,null,selected),result=await f.writer.setTarget(input);assert.equal(result.status,'committed');assert.deepEqual(result.receipt,{...input,outcome:'changed',resultingRevision:1,resultingEventId:result.receipt.resultingEventId,decidedAtMs:at});
 const source=sourceByEvent(f,result.receipt.resultingEventId),body=JSON.parse(source.record_bytes);assert.equal(source.created_at,at);assert.equal(source.source_command_id,input.commandId);assert.equal(body.changedAtMs,at);assert.equal(body.selected,selected);assert.deepEqual(body.effect,selected?{type:'entity-head',disposition:'changed'}:{type:'entity-negative',entityKind:'target',entityId:'s1',state:'removed',occurredAtMs:at});
 assert.deepEqual(rows(f,'release_seoul_targets'),[{space_id:'s1',selected:Number(selected),revision:1}]);assert.deepEqual(rows(f,'release_seoul_dirty_spaces'),[{space_id:'s1',dirty_revision:1,captured_revision:0}]);assert.equal(rows(f,'release_seoul_authority_heads')[0].payload_sha256,null);assert.equal(f.batches,1);clean(f);
 const before=snapshot(f);assert.deepEqual(await f.writer.setTarget(input),{status:'already_committed',receipt:result.receipt});assert.deepEqual(snapshot(f),before);assert.equal(f.batches,1);
});

for(const recursive of ['ON','OFF'])test('removal/reselection, unchanged audit and historical replay preserve authorship; '+recursive,async t=>{
 const f=await setup(t,recursive),first=await f.writer.setTarget(command(1));assert.equal(first.status,'committed');f.advance(1000);const unchanged=await f.writer.setTarget(command(2,1));assert.equal(unchanged.status,'committed');assert.equal(unchanged.receipt.outcome,'unchanged');assert.equal(unchanged.receipt.resultingRevision,1);assert.equal(unchanged.receipt.resultingEventId,first.receipt.resultingEventId);assert.equal(unchanged.receipt.decidedAtMs,at+1000);assert.equal(rows(f,'release_seoul_authority_changes').length,1);
 const removed=await f.writer.setTarget(command(3,1,false));assert.equal(removed.receipt.resultingRevision,2);const selected=await f.writer.setTarget(command(4,2,true));assert.equal(selected.receipt.resultingRevision,3);const before=snapshot(f);assert.deepEqual(await f.writer.setTarget(command(1)),{status:'already_committed',receipt:first.receipt});assert.deepEqual(await f.writer.setTarget(command(2,1)),{status:'already_committed',receipt:unchanged.receipt});assert.deepEqual(snapshot(f),before);clean(f);
});

test('conflicting command fields and stale desired-same revisions do not write',async t=>{
 const f=await setup(t),input=command(1);await f.writer.setTarget(input);const before=snapshot(f);
 for(const patch of [{spaceId:'s2'},{selected:false},{expectedRevision:1},{operatorReference:'other:operator'}])assert.deepEqual(await f.writer.setTarget({...input,...patch}),{status:'command_conflict'});
 assert.deepEqual(await f.writer.setTarget(command(2,null,true)),{status:'stale_revision'});assert.deepEqual(snapshot(f),before);assert.equal(f.batches,1);
});

test('missing Space and orphan current target source are fixed nonmutating failures',async t=>{
 const f=await setup(t);assert.deepEqual(await f.writer.setTarget(command(1,null,true,'absent')),{status:'target_missing'});
 f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,'target','s1',?,'{}',?)").run(uuid(88),uuid(89),at);const before=snapshot(f);assert.deepEqual(await f.writer.setTarget(command(2)),{status:'target_state_invalid'});assert.deepEqual(snapshot(f),before);assert.equal(f.batches,0);
});

for(const recursive of ['ON','OFF'])test('matching race and stale competing selection use exact one-attempt outcomes; '+recursive,async t=>{
 const f=await setup(t,recursive);let winner;f.beforeBatch=async()=>{f.beforeBatch=undefined;winner=await f.writer.setTarget(command(1));};const result=await f.writer.setTarget(command(1));assert.equal(result.status,'already_committed');assert.deepEqual(result.receipt,winner.receipt);assert.equal(rows(f,'release_seoul_authority_changes').length,1);assert.equal(f.batches,2);clean(f);
 f.beforeBatch=async()=>{f.beforeBatch=undefined;await f.writer.setTarget(command(3,1,false));};const loser=await f.writer.setTarget(command(2,1,true));assert.deepEqual(loser,{status:'stale_revision'});assert.equal(rows(f,'release_seoul_target_receipts').length,2);clean(f);
});

for(const recursive of ['ON','OFF'])test('commit then lost acknowledgement uses one clean historical readback and no retry; '+recursive,async t=>{
 const f=await setup(t,recursive);f.afterCommit=()=>{throw Error('lost acknowledgement');};const result=await f.writer.setTarget(command(1));assert.equal(result.status,'already_committed');assert.equal(f.batches,1);assert.equal(f.reads,2);assert.equal(rows(f,'release_seoul_authority_changes').length,1);clean(f);
});

for(const recursive of ['ON','OFF'])for(const action of ['ABORT','IGNORE'])for(const [name,trigger]of [['stage','BEFORE INSERT ON release_seoul_target_attempt'],['source','BEFORE INSERT ON release_seoul_authority_changes'],['receipt','BEFORE INSERT ON release_seoul_target_receipts'],['target','BEFORE INSERT ON release_seoul_targets'],['dirty','BEFORE INSERT ON release_seoul_dirty_spaces'],['cleanup','BEFORE DELETE ON release_seoul_target_attempt']])test(`consumed target completion rolls back ${action} ${name}; ${recursive}`,async t=>{
 const f=await setup(t,recursive),before=snapshot(f);f.raw.exec(`CREATE TRIGGER injected_target_failure ${trigger} BEGIN SELECT RAISE(${action}${action==='ABORT'?",'synthetic target failure'":''}); END`);assert.deepEqual(await f.writer.setTarget(command(1)),{status:'uncertain'});assert.deepEqual(snapshot(f),before);assert.equal(f.batches,1);clean(f);
});

for(const recursive of ['ON','OFF'])test('retained operation always precedes historical replay and rejects same/foreign replacements; '+recursive,async t=>{
 const f=await setup(t,recursive),input=command(1);await f.writer.setTarget(input);const request=f.calls.find(r=>r.statements.length===10),first=request.statements[0];f.engine.execute({...request,statements:[first]});const before=snapshot(f),batches=f.batches;
 assert.deepEqual(await f.writer.setTarget(input),{status:'staging_retained'});assert.deepEqual(await f.writer.setTarget(command(2)),{status:'staging_retained'});assert.equal(f.batches,batches);
 for(const foreign of [false,true]){const changed=structuredClone(request);if(foreign)changed.statements[0].values[0]=uuid(900);assert.throws(()=>f.engine.execute(changed),/staging/);changed.statements[0].sql=changed.statements[0].sql.replace('INSERT INTO','INSERT OR REPLACE INTO');assert.throws(()=>f.engine.execute(changed),/staging/);}
 assert.throws(()=>f.raw.exec('UPDATE release_seoul_target_attempt SET eligible=eligible'),/immutable/);assert.deepEqual(snapshot(f),before);
});

for(const recursive of ['ON','OFF'])test('ambiguous acknowledgement with retained operation cannot claim historical completion; '+recursive,async t=>{
 const f=await setup(t,recursive);f.afterCommit=request=>{f.engine.execute({...request,statements:[request.statements[0]]});throw Error('lost acknowledgement with residue');};assert.deepEqual(await f.writer.setTarget(command(1)),{status:'uncertain'});assert.equal(f.batches,1);assert.equal(f.reads,2);assert.equal(rows(f,'release_seoul_target_receipts').length,1);assert.equal(rows(f,'release_seoul_target_attempt').length,1);
});

for(const recursive of ['ON','OFF'])test('raced matching receipt with corrupted canonical source never supplies historical proof; '+recursive,async t=>{
 const f=await setup(t,recursive);let retained;f.beforeBatch=async()=>{f.beforeBatch=undefined;await f.writer.setTarget(command(1));f.raw.exec("DROP TRIGGER release_seoul_change_no_update; UPDATE release_seoul_authority_changes SET record_bytes='{}' WHERE revision=1");retained=snapshot(f);};assert.deepEqual(await f.writer.setTarget(command(1)),{status:'target_state_invalid'});assert.deepEqual(snapshot(f),retained);clean(f);
});

test('unchanged receipt replay requires its original changed lineage but never a current head',async t=>{
 const f=await setup(t);await f.writer.setTarget(command(1));const unchanged=await f.writer.setTarget(command(2,1));await f.writer.setTarget(command(3,1,false));assert.equal((await f.writer.setTarget(command(2,1))).status,'already_committed');f.raw.exec('DROP TRIGGER release_seoul_target_receipt_retained');f.raw.prepare('DELETE FROM release_seoul_target_receipts WHERE command_id=?').run(uuid(1));const before=snapshot(f);assert.deepEqual(await f.writer.setTarget(command(2,1)),{status:'target_state_invalid'});assert.deepEqual(snapshot(f),before);assert.equal(unchanged.receipt.resultingRevision,1);
});

test('raced unchanged historical completion rechecks its original source after staging',async t=>{
 const f=await setup(t);await f.writer.setTarget(command(100));let before;f.beforeBatch=async()=>{f.beforeBatch=undefined;await f.writer.setTarget(command(1,1,true));f.raw.exec("DROP TRIGGER release_seoul_change_no_update; CREATE TRIGGER corrupt_raced_original AFTER INSERT ON release_seoul_target_attempt WHEN NEW.command_id='"+uuid(1)+"' AND NEW.decision='already_committed' BEGIN UPDATE release_seoul_authority_changes SET record_bytes='{}' WHERE revision=1; END");before=snapshot(f);};
 const result=await f.writer.setTarget(command(1,1,true));assert.equal(result.status,'already_committed','rollback permits the one clean exact historical readback');assert.deepEqual(snapshot(f),before,'corruption after witness must roll back before historical readback');clean(f);
});

test('malformed present target source is bounded and neither changed nor unchanged can adopt it',async t=>{
 const f=await setup(t);await f.writer.setTarget(command(1));f.raw.exec('DROP TRIGGER release_seoul_change_no_update');f.raw.prepare('UPDATE release_seoul_authority_changes SET record_bytes=? WHERE revision=1').run('x'.repeat(120000));const before=snapshot(f);f.afterRead=(_request,result)=>{assert.ok(Buffer.byteLength(JSON.stringify(result))<4096,'invalid stored body is not copied into observation');};for(const selected of [true,false])assert.deepEqual(await f.writer.setTarget(command(2,1,selected)),{status:'target_state_invalid'});assert.deepEqual(snapshot(f),before);
});

for(const recursive of ['ON','OFF'])test('changed dirty INSERT preserves actual captured advancement after its witness; '+recursive,async t=>{
 const f=await setup(t,recursive);await f.writer.setTarget(command(1));f.raw.exec("CREATE TRIGGER advance_capture AFTER INSERT ON release_seoul_target_attempt WHEN NEW.command_id='"+uuid(2)+"' BEGIN UPDATE release_seoul_dirty_spaces SET captured_revision=dirty_revision WHERE space_id='s1'; END");const result=await f.writer.setTarget(command(2,1,false));assert.equal(result.status,'committed');assert.deepEqual(rows(f,'release_seoul_dirty_spaces'),[{space_id:'s1',dirty_revision:2,captured_revision:1}]);clean(f);
});

for(const recursive of ['ON','OFF'])for(const mode of ['unchanged','ineligible'])test(`nonmutating ${mode} completion rejects an in-batch dirty alteration; ${recursive}`,async t=>{
 const f=await setup(t,recursive);await f.writer.setTarget(command(1));let before=snapshot(f);
 if(mode==='ineligible')f.beforeBatch=async()=>{f.beforeBatch=undefined;await f.writer.setTarget(command(3,1,false));before=snapshot(f);};
 f.raw.exec("CREATE TRIGGER unexpected_capture AFTER INSERT ON release_seoul_target_attempt WHEN NEW.command_id='"+uuid(2)+"' BEGIN UPDATE release_seoul_dirty_spaces SET captured_revision=dirty_revision WHERE space_id='s1'; END");assert.deepEqual(await f.writer.setTarget(command(2,1,true)),{status:'uncertain'});assert.deepEqual(snapshot(f),before);clean(f);
});

for(const recursive of ['ON','OFF'])test('ineligible orphan race preserves actual command source and rejects an extra scoped source; '+recursive,async t=>{
 const f=await setup(t,recursive);let retained;f.beforeBatch=()=>{f.beforeBatch=undefined;f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,'target','s2',?,'{}',?)").run(uuid(1),uuid(90),at);retained=snapshot(f);};assert.deepEqual(await f.writer.setTarget(command(1)),{status:'target_state_invalid'});assert.deepEqual(snapshot(f),retained);clean(f);
 const other=await setup(t,recursive);let before;other.beforeBatch=()=>{other.beforeBatch=undefined;other.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,'target','s2',?,'{}',?)").run(uuid(1),uuid(90),at);before=snapshot(other);};other.raw.exec("CREATE TRIGGER unexpected_scoped_source AFTER INSERT ON release_seoul_target_attempt BEGIN INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(NEW.command_id,'target',NEW.space_id,'"+uuid(91)+"','{}',NEW.decided_at); END");assert.deepEqual(await other.writer.setTarget(command(1)),{status:'uncertain'});assert.deepEqual(snapshot(other),before);clean(other);
});

for(const recursive of ['ON','OFF'])for(const action of ['ABORT','IGNORE'])for(const relation of ['targets','dirty_spaces'])test(`existing target change rolls back ${action} ${relation} UPDATE; ${recursive}`,async t=>{
 const f=await setup(t,recursive);await f.writer.setTarget(command(1));const before=snapshot(f);f.raw.exec(`CREATE TRIGGER ignored_existing_update BEFORE UPDATE ON release_seoul_${relation} BEGIN SELECT RAISE(${action}${action==='ABORT'?",'synthetic existing failure'":''}); END`);assert.deepEqual(await f.writer.setTarget(command(2,1,false)),{status:'uncertain'});assert.deepEqual(snapshot(f),before);clean(f);
});

for(const recursive of ['ON','OFF'])for(const selected of [true,false])test(`benign exact digest finalization between read and target ${selected} batch is preserved; ${recursive}`,async t=>{
 const f=await setup(t,recursive);await f.writer.setTarget(command(1));const preparer=createSeoulProjectionPreparer(f.adapter,'durable-sql');let prepared;f.beforeBatch=async()=>{f.beforeBatch=undefined;prepared=await preparer.prepare(1);assert.equal(prepared.status,'prepared');};const result=await f.writer.setTarget(command(2,1,selected));assert.equal(result.status,'committed');const head=rows(f,'release_seoul_authority_heads')[0];if(selected){assert.equal(head.payload_sha256,prepared.sourceChangeSha256);assert.equal(head.revision,1);assert.deepEqual(rows(f,'release_seoul_dirty_spaces'),[{space_id:'s1',dirty_revision:1,captured_revision:0}]);}else{assert.equal(head.payload_sha256,null);assert.equal(head.revision,2);}assert.equal(rows(f,'release_seoul_projection_events').length,1);assert.equal(rows(f,'release_seoul_projection_deliveries').length,1);clean(f);
});

test('wrong prepared hashes fail current planning while immutable historical replay remains valid',async t=>{
 const f=await setup(t);const first=await f.writer.setTarget(command(1)),source=sourceByEvent(f,first.receipt.resultingEventId),candidate=await prepareSeoulHeadCandidate(source);f.raw.exec('BEGIN IMMEDIATE');f.raw.prepare('INSERT INTO release_seoul_prepared_sources VALUES(?,?,?,?)').run(1,source.event_id,'f'.repeat(64),'e'.repeat(64));f.raw.prepare("INSERT INTO release_seoul_projection_events(event_id,source_revision,event_kind,stream_kind,stream_key,source_sha256,space_id,snapshot_seq,issued_at,expires_at,payload_bytes,payload_sha256) VALUES(?,1,'head','target','s1',?,NULL,NULL,NULL,NULL,?,?)").run(source.event_id,'f'.repeat(64),candidate.eventText,'e'.repeat(64));f.raw.prepare('INSERT INTO release_seoul_projection_deliveries(event_id) VALUES(?)').run(source.event_id);f.raw.prepare('UPDATE release_seoul_authority_heads SET payload_sha256=? WHERE revision=1').run('f'.repeat(64));f.raw.exec('COMMIT');const before=snapshot(f);assert.deepEqual(await f.writer.setTarget(command(2,1,false)),{status:'target_state_invalid'});assert.deepEqual(await f.writer.setTarget(command(1)),{status:'already_committed',receipt:first.receipt});assert.deepEqual(snapshot(f),before);
});

test('same UUID conflicting race and first insertion race stay fixed ineligible observations',async t=>{
 for(const conflict of [true,false]){const f=await setup(t);let before;f.beforeBatch=async()=>{f.beforeBatch=undefined;await f.writer.setTarget(command(conflict?1:2,null,false));before=snapshot(f);};assert.deepEqual(await f.writer.setTarget(command(1)),{status:conflict?'command_conflict':'stale_revision'});assert.deepEqual(snapshot(f),before);clean(f);}
});

test('actual DB decision time and owned input survive mutations between read and batch',async t=>{
 const f=await setup(t),input=command(1);f.afterRead=()=>{input.selected=false;input.spaceId='s2';input.commandId=uuid(2);};f.beforeBatch=()=>f.advance(9876);const result=await f.writer.setTarget(input);assert.equal(result.status,'committed');assert.equal(result.receipt.commandId,uuid(1));assert.equal(result.receipt.spaceId,'s1');assert.equal(result.receipt.selected,true);assert.equal(result.receipt.decidedAtMs,at+9876);assert.equal(rows(f,'release_seoul_authority_changes')[0].created_at,at+9876);clean(f);
});

test('source counter exhaustion and head/snapshot UUID collisions cannot accept partial receipts',async t=>{
 const exhausted=await setup(t);exhausted.raw.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('release_seoul_authority_changes',?)").run(Number.MAX_SAFE_INTEGER);const old=snapshot(exhausted);assert.deepEqual(await exhausted.writer.setTarget(command(1)),{status:'uncertain'});assert.deepEqual(snapshot(exhausted),old);assert.equal(exhausted.raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='release_seoul_authority_changes'").get().seq,Number.MAX_SAFE_INTEGER);
 for(const snapshotCollision of [false,true]){const f=await setup(t),first=await f.writer.setTarget(command(10,null,true,'s2'));let collision=first.receipt.resultingEventId;if(snapshotCollision){await createSeoulProjectionPreparer(f.adapter,'durable-sql').prepare(1);collision=uuid(89);f.raw.prepare("INSERT INTO release_seoul_projection_events(event_id,source_revision,event_kind,stream_kind,stream_key,source_sha256,space_id,snapshot_seq,issued_at,expires_at,payload_bytes,payload_sha256) VALUES(?,1,'snapshot',NULL,NULL,NULL,'s2',1,?,?,'{}',?)").run(collision,at,at+60000,'a'.repeat(64));}const before=snapshot(f),sequence=[uuid(90),collision],mock=t.mock.method(crypto,'randomUUID',()=>sequence.shift());assert.deepEqual(await f.writer.setTarget(command(1)),{status:'uncertain'});mock.mock.restore();assert.deepEqual(snapshot(f),before);clean(f);}
});

test('unknown absent, malformed readback and corrupted committed response never retry',async t=>{
 for(const mode of ['absent','read-error','corrupt-response']){const f=await setup(t);if(mode==='corrupt-response')f.afterCommit=(_request,result)=>{result[7].results[0].receipt_bytes='{}';};else{f.beforeBatch=()=>{throw Error('unknown batch');};if(mode==='read-error')f.beforeRead=()=>{if(f.reads===2)throw Error('unknown readback');};}const result=await f.writer.setTarget(command(1));assert.equal(result.status,mode==='corrupt-response'?'already_committed':'uncertain');assert.equal(f.batches,1);assert.equal(f.reads,2);clean(f);}
});

test('a contradictory native intermediate batch result is reconciled by one exact historical readback',async t=>{
 const f=await setup(t,'ON',true,'native-d1');f.afterCommit=(_request,result)=>{result[2].success=false;};const result=await f.writer.setTarget(command(1));assert.equal(result.status,'already_committed');assert.equal(f.batches,1);assert.equal(f.reads,2);clean(f);
});

for(const recursive of ['ON','OFF'])test('receipt occupied UUID, immutable input and exact staged-source guards reject direct writes; '+recursive,async t=>{
 const f=await setup(t,recursive);await f.writer.setTarget(command(1));const r=rows(f,'release_seoul_target_receipts')[0],before=snapshot(f),values=Object.values(r);
 assert.throws(()=>f.raw.prepare('INSERT OR REPLACE INTO release_seoul_target_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(...values),/occupied/);assert.throws(()=>f.raw.exec('UPDATE release_seoul_target_receipts SET selected=selected'),/immutable/);assert.throws(()=>f.raw.exec('DELETE FROM release_seoul_target_receipts'),/retained/);
 assert.throws(()=>f.raw.prepare('INSERT INTO release_seoul_target_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(uuid(2),r.space_id,r.resulting_revision,0,r.operator_reference,'unchanged',r.resulting_revision,r.resulting_event_id,at),/staged source/);assert.deepEqual(snapshot(f),before);
});

test('native-D1-shaped adapter and maximum input keep bounded indexed ten-statement writes',async t=>{
 const f=await setup(t,'OFF',true,'native-d1'),space='s'.repeat(128);f.raw.prepare("INSERT INTO spaces SELECT ?,'Maximum Space',account_id,organization_id,security_mode,created_at,actor_credential_id FROM spaces WHERE id='s1'").run(space);const result=await f.writer.setTarget({...command(1,null,true,space),operatorReference:'o'.repeat(256)});assert.equal(result.status,'committed');const request=f.calls.find(r=>r.statements.length===10);assert.ok(request);assert.ok(request.statements.every(s=>s.values.length<=100&&Buffer.byteLength(s.sql)<=100000));assert.ok(Buffer.byteLength(JSON.stringify({statements:request.statements}))+4096<=1048576);assert.ok(Buffer.byteLength(rows(f,'release_seoul_authority_changes')[0].record_bytes)<1024);
 for(let i=0;i<150;i++)f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,'target',?,?,'{}',?)").run(uuid(1000+i),'unrelated:'+i,uuid(2000+i),at);
 const before=f.calls.length;await f.writer.setTarget({...command(2,1,true,space),operatorReference:'o'.repeat(256)});const removed=await f.writer.setTarget({...command(3,1,false,space),operatorReference:'o'.repeat(256)});assert.equal(removed.status,'committed');assert.equal((await f.writer.setTarget({...command(4,removed.receipt.resultingRevision,false,space),operatorReference:'o'.repeat(256)})).status,'committed');const relevant=f.calls.slice(before);for(const execution of relevant)for(const statement of execution.statements){const plan=f.raw.prepare('EXPLAIN QUERY PLAN '+statement.sql).all(...statement.values).map(r=>r.detail).join('\n');assert.doesNotMatch(plan,/SCAN (?:c|original|release_seoul_authority_changes|release_seoul_target_receipts)(?:\s|$)/,'writer joins bind indexed identities');}clean(f);
 const batches=f.calls.filter(r=>r.statements.length>1),statements=batches.flatMap(r=>r.statements);t.diagnostic('Target measured bounds '+JSON.stringify({statements:Math.max(...batches.map(r=>r.statements.length)),parametersPerStatement:Math.max(...statements.map(s=>s.values.length)),sqlBytesPerStatement:Math.max(...statements.map(s=>Buffer.byteLength(s.sql))),sqlBytesPerBatch:Math.max(...batches.map(r=>r.statements.reduce((n,s)=>n+Buffer.byteLength(s.sql),0))),serializedRequestBytes:Math.max(...batches.map(r=>Buffer.byteLength(JSON.stringify(r)))),policyBytesWithReserve:Math.max(...batches.map(r=>Buffer.byteLength(JSON.stringify({statements:r.statements}))+4096)),sourceBodyBytes:Math.max(...rows(f,'release_seoul_authority_changes').map(r=>Buffer.byteLength(r.record_bytes))),responseBytes:f.maximumResponseBytes,unrelatedSources:150}));
});

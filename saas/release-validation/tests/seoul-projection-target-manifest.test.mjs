import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fixture,at} from './db.mjs';
import {createDurableDatabase} from '../../src/durable-sql/client.ts';
import {SqlDatabaseEngine} from '../../src/durable-sql/engine.ts';
import {createSeoulProjectionPreparer} from '../../src/release/seoul-projection-preparer.ts';
import {prepareSeoulHeadCandidate} from '../../src/release/seoul-projection-source-codec.ts';

const schema=new URL('../../seoul-projection-target-manifest-schema.sql',import.meta.url),migration=new URL('../../migrations/0035_seoul-projection-target-manifest-schema.sql',import.meta.url),moduleUrl=new URL('../../src/release/seoul-projection-target-writer.ts',import.meta.url);
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const command=(n,expectedRevision=null,selected=true,spaceId='s1')=>({commandId:uuid(n),spaceId,expectedRevision,selected,operatorReference:'fixture:operator'});
const tableNames=['release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_targets','release_seoul_target_receipts','release_seoul_dirty_spaces','release_seoul_prepared_sources','release_seoul_projection_events','release_seoul_projection_deliveries','release_seoul_projection_lock','release_seoul_published_snapshots','release_seoul_target_attempt'];
const rows=(f,name)=>f.raw.prepare('SELECT * FROM '+name+' ORDER BY rowid').all().map(r=>({...r}));
const snapshot=f=>Object.fromEntries(tableNames.map(n=>[n,rows(f,n)]));
const oldMigrations=['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql','0028_seoul-projection-bootstrap-schema.sql','0029_seoul-projection-preparation-schema.sql','0030_seoul-projection-workspace-schema.sql','0031_seoul-projection-provider-schema.sql','0032_seoul-projection-command-schema.sql','0033_seoul-projection-provider-v1-schema.sql','0034_seoul-projection-target-schema.sql'];
async function setup(t,recursive='ON',install=true,mode='durable-sql'){
 let now=at;const f=await fixture({clock:()=>now});t.after(()=>f.db.close());f.raw=f.db.raw;f.advance=ms=>{now+=ms;};
 for(const file of oldMigrations)f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,34);f.raw.exec('PRAGMA recursive_triggers='+recursive);f.calls=[];f.batches=0;f.reads=0;
 if(!install)return f;
 assert.ok(existsSync(schema),'target schema file exists');assert.equal(readFileSync(migration,'utf8'),'-- Forward SaaS migration 35: seoul-projection-target-manifest-schema.sql\n'+readFileSync(schema,'utf8'));f.raw.exec(readFileSync(migration,'utf8'));assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,35);
 const storage={sql:{exec(sql,...values){const statement=f.raw.prepare(sql),result=statement.all(...values),readonly=statement.columns().length>0&&/^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());return {rowsWritten:readonly?0:Number(f.raw.prepare('SELECT changes() n').get().n),toArray:()=>result,[Symbol.iterator]:()=>result[Symbol.iterator]()};}},transactionSync(fn){f.raw.exec('BEGIN IMMEDIATE');try{const r=fn();f.raw.exec('COMMIT');return r;}catch(e){f.raw.exec('ROLLBACK');throw e;}}};
 f.engine=new SqlDatabaseEngine(storage,{objectName:'sql:staging:control:1'});f.engine.initialize();f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging','control','control',1,'ready','a'.repeat(64),'b'.repeat(64));
 const identity={deploymentId:'staging',databaseId:'control',kind:'control',epoch:1};
 const execute=async request=>{f.calls.push(structuredClone(request));const batch=request.statements.length>1;if(batch){f.batches++;await f.beforeBatch?.(request);}else{f.reads++;await f.beforeRead?.(request);}const result=mode==='durable-sql'?f.engine.execute(request):storage.transactionSync(()=>request.statements.map(s=>{const q=f.raw.prepare(s.sql),r=q.all(...s.values);return {success:true,results:r,meta:{changes:0}};}));f.maximumResponseBytes=Math.max(f.maximumResponseBytes??0,Buffer.byteLength(JSON.stringify(result)));if(batch)await f.afterCommit?.(request,result);else await f.afterRead?.(request,result);return result;};
 const owned=new WeakMap();function prepare(sql,values=[]){const statement={bind(...parameters){return prepare(sql,parameters);},async first(){return (await execute({identity,statements:[{sql,values,mode:'first'}]}))[0].results[0]??null;},async all(){return (await execute({identity,statements:[{sql,values,mode:'all'}]}))[0];},async run(){return this.all();}};owned.set(statement,{sql,values,mode:'all'});return statement;}
 f.adapter=mode==='durable-sql'?createDurableDatabase({execute},identity):{prepare,batch(statements){return execute({identity,statements:statements.map(s=>owned.get(s))});},withSession(){return {prepare};}};assert.ok(existsSync(moduleUrl),'target writer module exists');const {createSeoulProjectionTargetWriter}=await import(moduleUrl);f.writer=createSeoulProjectionTargetWriter(f.adapter,mode);return f;
}
function clean(f){assert.deepEqual(rows(f,'release_seoul_target_manifest_attempt'),[]);assert.deepEqual(rows(f,'release_seoul_target_attempt'),[]);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(f.raw.prepare('SELECT state FROM release_seoul_projection_state').get().state,'backfill-required');}
const sourceByEvent=(f,event)=>({...f.raw.prepare('SELECT revision,source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at FROM release_seoul_authority_changes WHERE event_id=?').get(event)});


const manifestTables=['manifests','manifest_members','manifest_control','manifest_pages','manifest_steps','manifest_seals','manifest_completions','manifest_cancellations','manifest_attempt'].map(s=>'release_seoul_target_'+s);
const manifest=(n,spaceIds=[],expectedGeneration=null)=>({version:1,manifestId:uuid(n),expectedGeneration,operatorReference:'fixture:operator',spaceIds});
const ref=(n,generation=1)=>({manifestId:uuid(n),generation});
async function coordinator(f,mode='durable-sql'){const {createSeoulProjectionTargetManifest}=await import('../../src/release/seoul-projection-target-manifest.ts');return createSeoulProjectionTargetManifest(f.adapter,mode);}

test('additive0035 preserves all34 objects and rows and creates exactly nine inert manifest tables',async t=>{
 const f=await setup(t,'ON',false),objects=f.raw.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),before=new Map(objects.filter(o=>o.type==='table'&&!o.name.startsWith('release_fts')).map(o=>[o.name,rows(f,o.name)]));
 assert.ok(existsSync(schema),'manifest schema exists');assert.equal(readFileSync(migration,'utf8'),'-- Forward SaaS migration 35: seoul-projection-target-manifest-schema.sql\n'+readFileSync(schema,'utf8'));f.raw.exec(readFileSync(migration,'utf8'));
 for(const [name,data]of before)if(name!=='release_meta')assert.deepEqual(rows(f,name),data,name);for(const object of objects)assert.deepEqual(f.raw.prepare('SELECT name,type,sql FROM sqlite_master WHERE name=?').get(object.name),object,object.name);
 assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,35);for(const name of manifestTables)assert.ok(f.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
 assert.deepEqual(rows(f,'release_seoul_target_manifest_control'),[{singleton:1,current_generation:null}]);assert.deepEqual(rows(f,'release_seoul_targets'),[]);clean(f);
});

for(const mode of ['native-d1','durable-sql'])for(const recursive of ['ON','OFF'])test('publication owns exact manifest, preserves replay and uses predecessor CAS; '+mode+' '+recursive,async t=>{
 const f=await setup(t,recursive,true,mode),m=await coordinator(f,mode),input=manifest(100,['s2','s1']);const first=await m.publish(input);assert.equal(first.status,'published');assert.equal(first.generation,1);
 assert.deepEqual(rows(f,'release_seoul_target_manifest_members').map(r=>[r.space_id,r.ordinal]),[['s1',1],['s2',2]]);assert.deepEqual(await m.publish(manifest(100,['s1','s2'])),{...first,status:'already_published'});
 assert.equal((await m.publish(manifest(101,['s1']))).status,'generation_conflict');assert.equal((await m.publish(manifest(100,['s1']))).status,'manifest_conflict');assert.equal((await m.publish(manifest(101,['s1'],1))).generation,2);assert.equal((await m.readManifest(ref(100))).currentStatus,'superseded');clean(f);
});

test('full1024 publication preserves canonical request domain without source event cap',async t=>{
 const f=await setup(t),m=await coordinator(f),ids=Array.from({length:1024},(_,i)=>'s'+String(i).padStart(4,'0')+'x'.repeat(123));const result=await m.publish({...manifest(100,ids),operatorReference:'a'.repeat(256)});assert.equal(result.status,'published');assert.equal(rows(f,'release_seoul_target_manifest_members').length,1024);assert.ok(f.calls.filter(c=>c.statements.length>1).every(c=>Buffer.byteLength(JSON.stringify(c))+4096<1048576));assert.equal(rows(f,'release_seoul_authority_changes').length,0);t.diagnostic('Full1024 publication '+JSON.stringify({requestBytes:Math.max(...f.calls.map(c=>Buffer.byteLength(JSON.stringify(c)))),responseBytes:f.maximumResponseBytes,sqlBytes:Math.max(...f.calls.flatMap(c=>c.statements.map(s=>Buffer.byteLength(s.sql)))),parameters:Math.max(...f.calls.flatMap(c=>c.statements.map(s=>s.values.length))),statements:Math.max(...f.calls.map(c=>c.statements.length))}));clean(f);
});

test('empty manifest inventories two empty phases and can complete with exact empty configuration',async t=>{
 const f=await setup(t),m=await coordinator(f);await m.publish(manifest(100));for(const phase of ['desired','omitted']){const page=await m.readPlanningPage({...ref(100),phase,afterSpaceId:null});assert.equal(page.status,'planning_page');assert.deepEqual(page.steps,[]);assert.equal((await m.appendPlanningPage({...ref(100),phase,pageNo:1,afterSpaceId:null,steps:[]})).status,'page_recorded');}
 assert.equal((await m.seal(ref(100))).status,'sealed');assert.equal((await m.verifyPage({...ref(100),pageNo:1,afterSpaceId:null})).status,'page_verified');assert.equal((await m.complete(ref(100))).status,'completed');assert.equal((await m.observeAgreement({...ref(100),configuredSpaceIds:[]})).status,'agreed');assert.equal((await m.observeAgreement({...ref(100),configuredSpaceIds:['s1']})).status,'configuration_mismatch');clean(f);
});

test('cancellation preserves current generation and causes fail-closed agreement and future phases',async t=>{
 const f=await setup(t),m=await coordinator(f);await m.publish(manifest(100));const input={...ref(100),cancellationId:uuid(101),operatorReference:'fixture:cancel'};assert.equal((await m.cancel(input)).status,'cancelled');assert.equal((await m.cancel(input)).status,'already_cancelled');assert.equal((await m.readManifest(ref(100))).currentStatus,'cancelled');assert.equal((await m.seal(ref(100))).status,'cancelled');assert.equal((await m.observeAgreement({...ref(100),configuredSpaceIds:[]})).status,'cancelled');assert.equal((await m.publish(manifest(102,[],1))).generation,2);clean(f);
});

test('publication unknown acknowledgement reads history once without automatic retry',async t=>{
 const f=await setup(t),m=await coordinator(f);f.afterCommit=()=>{throw Error('lost ack');};const result=await m.publish(manifest(100));assert.equal(result.status,'already_published');assert.equal(f.batches,1);clean(f);
});

async function inventory(m,n,generation=1){for(const phase of ['desired','omitted']){let afterSpaceId=null,pageNo=1;for(;;){const page=await m.readPlanningPage({...ref(n,generation),phase,afterSpaceId});assert.equal(page.status,'planning_page');const result=await m.appendPlanningPage({...ref(n,generation),phase,pageNo,afterSpaceId,steps:page.steps.map((s,i)=>({...s,commandId:uuid(n*10000+(phase==='desired'?0:5000)+pageNo*32+i)}))});assert.equal(result.status,'page_recorded');if(result.terminal)break;afterSpaceId=page.steps.at(-1).spaceId;pageNo++;}}assert.equal((await m.seal(ref(n,generation))).status,'sealed');}
for(const mode of ['native-d1','durable-sql'])for(const recursive of ['ON','OFF'])test('guarded13 applies desired and actual omissions then proves exact current selection; '+mode+' '+recursive,async t=>{
 const f=await setup(t,recursive,true,mode);assert.equal((await f.writer.setTarget(command(1,null,true,'s2'))).status,'committed');const m=await coordinator(f,mode);await m.publish(manifest(100,['s1']));assert.equal((await f.writer.setTarget(command(2))).status,'manifest_controlled');await inventory(m,100);
 for(const spaceId of ['s1','s2']){const result=await f.writer.setManifestStep({...ref(100),spaceId});assert.equal(result.status,'committed');assert.equal(result.receipt.selected,spaceId==='s1');assert.equal((await f.writer.setManifestStep({...ref(100),spaceId})).status,'already_committed');}
 assert.equal(f.calls.filter(c=>c.statements.length===13).length,2);assert.equal((await m.verifyPage({...ref(100),pageNo:1,afterSpaceId:null})).status,'page_verified');assert.equal((await m.complete(ref(100))).status,'completed');assert.equal((await m.observeAgreement({...ref(100),configuredSpaceIds:['s1']})).status,'agreed');assert.deepEqual(rows(f,'release_seoul_targets').map(r=>[r.space_id,r.selected]),[['s2',0],['s1',1]]);clean(f);
});

test('all coordinator inputs are closed and owned before any database call',async()=>{
 const {createSeoulProjectionTargetManifest}=await import('../../src/release/seoul-projection-target-manifest.ts'),{createSeoulProjectionTargetWriter}=await import('../../src/release/seoul-projection-target-writer.ts');let calls=0,invoked=0;const db={prepare(){calls++;throw Error();},batch(){calls++;throw Error();},withSession(){calls++;throw Error();}},m=createSeoulProjectionTargetManifest(db,'native-d1'),w=createSeoulProjectionTargetWriter(db,'native-d1');const inputs={publish:manifest(100),readManifest:ref(100),readPlanningPage:{...ref(100),phase:'desired',afterSpaceId:null},appendPlanningPage:{...ref(100),phase:'desired',pageNo:1,afterSpaceId:null,steps:[]},seal:ref(100),cancel:{...ref(100),cancellationId:uuid(199),operatorReference:'cancel:test'},readSteps:{...ref(100),afterSpaceId:null},verifyPage:{...ref(100),pageNo:1,afterSpaceId:null},complete:ref(100),observeAgreement:{...ref(100),configuredSpaceIds:[]}};
 for(const [name,input]of Object.entries(inputs)){const accessor=Object.defineProperty({...input},'manifestId',{enumerable:true,get(){invoked++;return uuid(100);}});for(const value of [null,[],{...input,extra:true},accessor,Object.assign(Object.create({}),input)])assert.equal((await m[name](value)).status,'invalid_input');}
 for(const value of [{...ref(100),generation:-0,spaceId:'s1'},{...ref(100),spaceId:'s1',selected:true},{...ref(100),spaceId:'s1\n'}])assert.equal((await w.setManifestStep(value)).status,'invalid_input');assert.equal(calls,0);assert.equal(invoked,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,at} from './db.mjs';
import {createDurableDatabase} from '../../src/durable-sql/client.ts';
import {SqlDatabaseEngine} from '../../src/durable-sql/engine.ts';
import {createSeoulProjectionTargetWriter} from '../../src/release/seoul-projection-target-writer.ts';
import {createSeoulProjectionPreparer} from '../../src/release/seoul-projection-preparer.ts';
import {prepareSeoulHeadCandidate,parseSeoulAuthoritySourceRow} from '../../src/release/seoul-projection-source-codec.ts';
import {signSeoulProjectionRequest,verifySeoulProjectionRequest} from '../../src/release/seoul-projection-auth.ts';
import {verifySeoulHeadReceiptForEvent} from '../../src/release/seoul-projection-head-receipt-codec.ts';
import {createHeadFixture} from '../../test/postgres/seoul-projection-head-fixture.mjs';

const utf8=new TextEncoder(),uuid=n=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0');
const endpoint='https://target.fixture.test/internal/v1/seoul/projections';
async function central(t,recursive){
 const f=await fixture();t.after(()=>f.db.close());f.raw=f.db.raw;
 for(const file of ['0026_seoul-projection-schema.sql','0027_seoul-projection-capture-schema.sql','0028_seoul-projection-bootstrap-schema.sql','0029_seoul-projection-preparation-schema.sql','0030_seoul-projection-workspace-schema.sql','0031_seoul-projection-provider-schema.sql','0032_seoul-projection-command-schema.sql','0033_seoul-projection-provider-v1-schema.sql','0034_seoul-projection-target-schema.sql'])f.raw.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 assert.equal(f.raw.prepare('SELECT version FROM release_meta').get().version,34);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);f.raw.exec('PRAGMA recursive_triggers='+recursive);
 const storage={sql:{exec(sql,...values){const s=f.raw.prepare(sql),r=s.all(...values),readonly=s.columns().length>0&&/^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());return {rowsWritten:readonly?0:Number(f.raw.prepare('SELECT changes() n').get().n),toArray:()=>r,[Symbol.iterator]:()=>r[Symbol.iterator]()};}},transactionSync(fn){f.raw.exec('BEGIN IMMEDIATE');try{const r=fn();f.raw.exec('COMMIT');return r;}catch(e){f.raw.exec('ROLLBACK');throw e;}}};
 const engine=new SqlDatabaseEngine(storage,{objectName:'sql:staging:control:1'});engine.initialize();f.raw.prepare('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)').run('staging','control','control',1,'ready','a'.repeat(64),'b'.repeat(64));f.adapter=createDurableDatabase({async execute(request){return engine.execute(request);}},{deploymentId:'staging',databaseId:'control',kind:'control',epoch:1});f.writer=createSeoulProjectionTargetWriter(f.adapter,'durable-sql');f.preparer=createSeoulProjectionPreparer(f.adapter,'durable-sql');return f;
}
const positive=async pg=>(await pg.db.query(`SELECT jsonb_build_object(
 'accounts',(SELECT jsonb_agg(a) FROM memory_identity.accounts a),
 'providers',(SELECT jsonb_agg(p) FROM memory_identity.provider_identities p),
 'emails',(SELECT jsonb_agg(e) FROM memory_identity.account_emails e),
 'organizations',(SELECT jsonb_agg(o) FROM memory_control.organizations o),
 'memberships',(SELECT jsonb_agg(m) FROM memory_identity.memberships m),
 'credentials',(SELECT jsonb_agg(c) FROM memory_identity.credentials c),
 'spaces',(SELECT jsonb_agg(s) FROM memory_control.spaces s),
 'grants',(SELECT jsonb_agg(g) FROM memory_identity.pat_space_grants g),
 'usage',(SELECT jsonb_agg(u) FROM memory_ops.space_usage u)) value`)).rows[0].value;

for(const recursive of ['ON','OFF'])for(const reversed of [false,true])test(`persisted target writer/preparer/HMAC/SQL receipts preserve identity negatives; reversed=${reversed}, recursion ${recursive}`,async t=>{
 const f=await central(t,recursive),pg=await createHeadFixture(t),initial=await positive(pg),key=await crypto.subtle.importKey('raw',new Uint8Array(32).fill(71),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 const negative={version:3,kind:'credential-source',id:'unrelated:credential',accountId:'alice',credentialKind:'api_key',tokenDigest:'a'.repeat(64),membershipId:'m1',emailId:'e1',permission:'write',expiresAtMs:at+900000,revokedAtMs:at,policy:null,origin:{kind:'command',commandType:'self-email-unlink',receiptId:'fixture:unlink'},effect:{type:'entity-negative',entityKind:'credential',entityId:'unrelated:credential',state:'revoked',occurredAtMs:at}};
 f.raw.prepare("INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,'credential','unrelated:credential',?,?,?)").run(uuid(100),uuid(101),JSON.stringify(negative),at);
 const commands=[],receipts=[];let expectedRevision=null;
 for(const [i,selected]of [true,false,true].entries()){const command={commandId:uuid(i+1),spaceId:'s1',expectedRevision,selected,operatorReference:'fixture:operator'};commands.push(command);const result=await f.writer.setTarget(command);assert.equal(result.status,'committed');assert.equal(result.receipt.outcome,'changed');expectedRevision=result.receipt.resultingRevision;receipts.push(result.receipt);}
 const sourceRows=f.raw.prepare('SELECT revision,source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at FROM release_seoul_authority_changes ORDER BY revision').all();assert.equal(sourceRows.length,4);
 const deliveries=[];
 for(const row of sourceRows){const source=parseSeoulAuthoritySourceRow(row),candidate=await prepareSeoulHeadCandidate(row);assert.equal((await f.preparer.prepare(row.revision)).status,'prepared');const persisted=f.raw.prepare('SELECT payload_bytes,payload_sha256 FROM release_seoul_projection_events WHERE event_id=?').get(row.event_id);assert.equal(persisted.payload_bytes,candidate.eventText);assert.equal(persisted.payload_sha256,candidate.transportPayloadSha256);assert.notEqual(candidate.sourceChangeSha256,candidate.transportPayloadSha256);deliveries.push({source,candidate,bytes:utf8.encode(persisted.payload_bytes)});}
 const send=async entry=>{const headers=await signSeoulProjectionRequest(key,{method:'POST',url:endpoint,body:entry.bytes,timestampMs:at}),request=new Request(endpoint,{method:'POST',headers,body:entry.bytes}),raw=new Uint8Array(await request.arrayBuffer()),verified=await verifySeoulProjectionRequest(key,request,raw,at);assert.equal(verified.method,'POST');assert.equal(verified.envelope.eventId,entry.source.eventId);const text=await pg.apply(new TextDecoder().decode(verified.rawBody),verified.transportPayloadSha256),receipt=await verifySeoulHeadReceiptForEvent(utf8.encode(text),entry.bytes);const url=endpoint+'/'+entry.source.eventId+'?payloadSha256='+entry.candidate.transportPayloadSha256,statusHeaders=await signSeoulProjectionRequest(key,{method:'GET',url,body:new Uint8Array(),timestampMs:at}),statusRequest=new Request(url,{headers:statusHeaders}),status=await verifySeoulProjectionRequest(key,statusRequest,new Uint8Array(),at);assert.equal(status.method,'GET');assert.equal(await pg.status(status.eventId,status.payloadSha256),text);return {text,receipt};};
 await send(deliveries[0]);const tombstones=(await pg.state()).identity_projection_tombstones;assert.equal(tombstones.length,1);assert.equal(tombstones[0].stream_key,'unrelated:credential');
 const ordered=deliveries.slice(1);if(reversed)ordered.reverse();const applied=[];for(const entry of ordered){const result=await send(entry);assert.equal(result.receipt.outcome,reversed&&entry.source.revision<4?'head_superseded':'applied');applied.push({entry,...result});}
 const final=await pg.state();assert.deepEqual(final.identity_projection_tombstones,tombstones);assert.ok(!final.identity_projection_tombstones.some(r=>r.kind==='target'));const target=final.identity_projection_heads.find(r=>r.kind==='target'&&r.stream_key==='s1');assert.equal(target.source_revision,4);assert.equal(final.identity_projection_source_heads.find(r=>r.source_revision===target.source_revision).source_event_id,sourceRows[3].event_id);assert.deepEqual(await positive(pg),initial);
 for(const {entry,text}of applied)assert.equal(await pg.apply(new TextDecoder().decode(entry.bytes),entry.candidate.transportPayloadSha256),text);assert.deepEqual(await pg.state(),final);
 const centralBefore=f.raw.prepare('SELECT * FROM release_seoul_authority_changes ORDER BY revision').all();for(const [i,command]of commands.entries())assert.deepEqual(await f.writer.setTarget(command),{status:'already_committed',receipt:receipts[i]});assert.deepEqual(f.raw.prepare('SELECT * FROM release_seoul_authority_changes ORDER BY revision').all(),centralBefore);assert.deepEqual(f.raw.prepare('SELECT * FROM release_seoul_target_attempt').all(),[]);assert.deepEqual(f.raw.prepare('SELECT * FROM release_seoul_target_preparation_stage').all(),[]);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { applySql } from './apply-sql.mjs';
import { suspendedOwnerFixture,sharesRejectSuspendedOwner,queuedProvidersRejectSuspendedPersonalOwner,bufferedMcpRejectsSuspendedOwner } from '../release-validation/tests/suspended-owner-scenarios.mjs';

test('native D1 applies lifecycle owner state to shared disclosure and provider work',{timeout:180000},async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:'suspended-owner-native',modules:true,compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],
  script:'export default {fetch(){return new Response("synthetic native owner fixture");}}',d1Databases:['DB'],outboundService:()=>new Response('Outbound disabled',{status:503})}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB'),parser=new DatabaseSync(':memory:');
 try{for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort())await applySql(parser,db,readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));}finally{parser.close();}
 const f=await suspendedOwnerFixture(db,Date.now);
 await t.test('signed suspension denies accepted/pending shares and preserves independent organization',()=>sharesRejectSuspendedOwner(f));
 await t.test('queued personal content is never newly sent to providers',()=>queuedProvidersRejectSuspendedPersonalOwner(f));
 await f.deliver('account.resumed');
 await t.test('explicit resume permits retained outgoing grant, but not old owner credentials',async()=>{
  assert.equal((await f.store.get(f.users.carol.token,f.personal,f.personalMemory.id)).body,f.personalMemory.body);
  await f.transfer.accept(f.users.bob.token,f.pending.id);
  for(const token of [f.users.alice.token,f.oldKey.token])await assert.rejects(()=>f.store.get(token,f.personal,f.personalMemory.id),error=>error.status===403);
 });
 await t.test('resumed owner completes indexing retained across suspension',async()=>{
  // Advance only this synthetic job's scheduling time; authority still uses
  // native D1 execution time and the signed lifecycle event above.
  await db.prepare('UPDATE release_jobs SET available_at=0 WHERE memory_id=? AND state=\'pending\'').bind(f.personalMemory.id).run();
  await f.jobs.drain(5);
  const job=await db.prepare('SELECT state,next_chunk FROM release_jobs WHERE memory_id=? AND revision=1').bind(f.personalMemory.id).first();
  assert.equal(job.state,'done');assert.equal(job.next_chunk,1);
  assert.ok(f.calls.some(call=>call.kind==='upsert'&&call.values.some(value=>value.metadata.memoryId===f.personalMemory.id)));
 });
 await t.test('the final buffered MCP SQL suppresses a concurrent suspension',()=>bufferedMcpRejectsSuspendedOwner(f));
 await t.test('three-action organization MCP admission remains within native SQL limits',async()=>{
  const response=await f.request('/mcp',f.users.bob.token,{jsonrpc:'2.0',id:32,method:'tools/call',params:{name:'memory_add',arguments:{spaceId:f.organization.spaceId,body:'Independent current organization successor',supersedesMemoryId:f.organizationMemory.id,operationId:'native-three-actions'}}});
  const text=await response.text();assert.equal(response.status,200,text);
  const envelope=JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')?text.split('\n').find(line=>line.startsWith('data: ')).slice(6):text);
  assert.notEqual(envelope.result.isError,true,text);assert.ok(text.includes('Independent current organization successor'));
 });
});

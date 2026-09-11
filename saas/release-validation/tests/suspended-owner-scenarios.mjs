import assert from 'node:assert/strict';
import { WorkspaceService } from '../../src/workspace.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { Transfers } from '../../src/release/transfer.ts';
import { Jobs } from '../../src/release/jobs.ts';
import { Admin } from '../../src/release/admin.ts';
import { Search } from '../../src/release/search.ts';
import { createRelease } from '../../src/release/extension.ts';
import { createApplication } from '../../src/app.ts';
import { readSettings } from '../../src/config.ts';
import { hmac } from '../../src/release/util.ts';

const issuer='https://auth-api.allen.company',origin='https://memory.allenlabs.org',secret='synthetic-suspended-owner-'.repeat(2);
const denied=error=>error.status===403;
function httpRequest(db,clock,defaultToken) {
 const release=createRelease({DB:db,PUBLIC_ORIGIN:origin},{clock}),app=createApplication(db,readSettings({PUBLIC_ORIGIN:origin}),{clock,release});
 return(path,token=defaultToken,data)=>app(new Request(origin+path,{method:data?'POST':'GET',headers:{authorization:'Bearer '+token,...(data?{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'}:{})},...(data?{body:JSON.stringify(data)}:{})}));
}
export async function suspendedOwnerFixture(db,clock) {
 const workspace=new WorkspaceService(db,clock,{identityLifecycle:true}),users={};
 for(const subject of ['alice','bob','carol']) users[subject]=await workspace.signIn({issuer,subject,email:subject+'@example.com',emailVerified:true,issuedAt:clock(),expiresAt:clock()+900000,permission:'write'});
 await db.prepare("UPDATE credentials SET reauthenticated_at=? WHERE kind='session'").bind(clock()).run();
 const snap=await workspace.snapshot(users.alice.token), personal=snap.spaces.find(s=>s.organizationId===null).id;
 const organization=await workspace.createOrganization(users.alice.token,{name:'Independent organization',emailId:snap.account.emails[0].id});
 const invite=await workspace.createInvite(users.alice.token,organization.id,{email:'bob@example.com',role:'admin'});
 await workspace.acceptInvite(users.bob.token,invite.token);
 const store=new MemoryStore(db,clock),transfer=new Transfers(db,clock),admin=new Admin({DB:db,IDENTITY_WEBHOOK_SECRET:secret},clock);
 const personalMemory=await store.create(users.alice.token,personal,{body:'suspendedprivateword confidential personal body'},'personal-content');
 const organizationMemory=await store.create(users.alice.token,organization.spaceId,{body:'activeorganizationword retained organization body'},'organization-content');
 const accepted=await transfer.share(users.alice.token,personal,'carol@example.com');await transfer.accept(users.carol.token,accepted.id);
 const pending=await transfer.share(users.alice.token,personal,'bob@example.com');
 const independent=await transfer.share(users.bob.token,organization.spaceId,'carol@example.com');await transfer.accept(users.carol.token,independent.id);
 const reader=await admin.issueKey(users.carol.token,{label:'Independent reader',capabilities:['read'],spaceIds:[personal],expiresInDays:1});
 const oldKey=await admin.issueKey(users.alice.token,{label:'Old owner key',capabilities:['read'],spaceIds:[personal],expiresInDays:1});
 let sequence=0;const deliver=async type=>{const raw=JSON.stringify({version:2,id:'owner-event-'+(++sequence),sequence,issuer,subject:'alice',type,occurredAt:clock(),email:null}),timestamp=String(Math.floor(clock()/1000));
  const response=await admin.identityWebhook(new Request(origin+'/webhooks/identity',{method:'POST',headers:{'x-memory-timestamp':timestamp,'x-memory-signature':await hmac(secret,timestamp+'.'+raw)},body:raw}));assert.equal(response.status,200);};
 const calls=[];const env={DB:db,PUBLIC_ORIGIN:origin,AI:{run:async(_model,input)=>{calls.push({kind:'embedding',text:input.text});return{data:[Array(1024).fill(0.1)]};}},MEMORY_INDEX:{upsert:async values=>{calls.push({kind:'upsert',values});},deleteByIds:async()=>{},getByIds:async()=>[]}};
 const jobs=new Jobs(env,clock),search=new Search({DB:db},clock),request=httpRequest(db,clock,users.carol.token);
 return {db,clock,workspace,users,personal,organization,store,transfer,personalMemory,organizationMemory,accepted,pending,independent,reader,oldKey,deliver,calls,jobs,search,request};
}

export async function sharesRejectSuspendedOwner(f) {
 assert.equal((await f.store.get(f.users.carol.token,f.personal,f.personalMemory.id)).body,f.personalMemory.body);
 await f.deliver('account.suspended');
 assert.equal((await f.db.prepare('SELECT disabled_at FROM accounts WHERE id=?').bind(f.users.alice.accountId).first()).disabled_at,null);
 for(const token of [f.users.alice.token,f.oldKey.token,f.users.carol.token,f.reader.token])await assert.rejects(()=>f.store.get(token,f.personal,f.personalMemory.id),denied);
 await assert.rejects(()=>f.transfer.accept(f.users.bob.token,f.pending.id),denied);
 assert.equal((await f.db.prepare('SELECT accepted_at FROM release_shares WHERE id=?').bind(f.pending.id).first()).accepted_at,null);
 assert.ok(!(await f.transfer.invitations(f.users.bob.token)).results.some(row=>row.id===f.pending.id));
 assert.ok(!(await f.store.spaces(f.users.carol.token)).results.some(row=>row.id===f.personal));
 const workspaceResponse=await f.request('/v1/workspace');assert.equal(workspaceResponse.status,200);
 assert.ok(!(await workspaceResponse.json()).spaces.some(row=>row.id===f.personal));
 await assert.rejects(()=>f.search.query(f.users.carol.token,f.personal,'suspendedprivateword'),denied);
 assert.equal((await f.request('/v1/spaces/'+f.personal+'/memories/'+f.personalMemory.id)).status,403);
 assert.equal((await f.store.get(f.users.bob.token,f.organization.spaceId,f.organizationMemory.id)).body,f.organizationMemory.body);
 assert.equal((await f.store.get(f.users.carol.token,f.organization.spaceId,f.organizationMemory.id)).body,f.organizationMemory.body);
}

export async function queuedProvidersRejectSuspendedPersonalOwner(f) {
 await f.deliver('account.suspended');await f.jobs.drain(5);
 assert.ok(f.calls.some(call=>call.kind==='embedding'&&call.text.join(' ').includes('activeorganizationword')),'organization indexing stays independent of its suspended writer');
 assert.ok(!f.calls.some(call=>call.kind==='embedding'&&call.text.join(' ').includes('suspendedprivateword')),'suspended personal source never reaches AI');
 assert.ok(!f.calls.some(call=>call.kind==='upsert'&&call.values.some(value=>value.metadata.memoryId===f.personalMemory.id)),'suspended personal source never reaches Vectorize');
 const pending=await f.db.prepare('SELECT state,attempt,next_chunk,last_error,available_at FROM release_jobs WHERE memory_id=? AND revision=1').bind(f.personalMemory.id).first();
 assert.equal(pending.state,'pending');assert.equal(pending.attempt,0);assert.equal(pending.next_chunk,0);assert.equal(pending.last_error,'owner_suspended');assert.ok(pending.available_at>f.clock());
}

export async function bufferedMcpRejectsSuspendedOwner(f) {
 let injected=false;
 const intercept=(sql,statement)=>!sql.includes('/* mcp-response-authority */')?statement:new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values)=>intercept(sql,target.bind(...values));
  if(key==='first')return async(...args)=>{if(!injected){injected=true;await f.deliver('account.suspended');}return target.first(...args);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 // Native D1 bindings are RPC proxies: use a transparent wrapper instead of
 // assigning properties to the binding or assuming bind() returns itself.
 const wrap=target=>({prepare:sql=>intercept(sql,target.prepare(sql)),batch:statements=>target.batch(statements),withSession:(...args)=>wrap(target.withSession?target.withSession(...args):target)});
 const request=httpRequest(wrap(f.db),f.clock,f.reader.token);
 {
  const response=await request('/mcp',f.reader.token,{jsonrpc:'2.0',id:31,method:'tools/call',params:{name:'memory_get',arguments:{spaceId:f.personal,memoryId:f.personalMemory.id}}});
  const text=await response.text();assert.equal(response.status,200,text);assert.equal(injected,true,text);assert.ok(!text.includes('suspendedprivateword'));
  const envelope=JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')?text.split('\n').find(line=>line.startsWith('data: ')).slice(6):text);
  assert.equal(envelope.id,31);assert.equal(envelope.result.isError,true);
 }
}

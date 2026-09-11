import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {fixture,at} from './db.mjs';
import {createApplication} from '../../src/app.ts';
import {createRelease} from '../../src/release/extension.ts';
import {readSettings,AUTH_ISSUER,PUBLIC_ORIGIN} from '../../src/config.ts';
import {MemoryStore} from '../../src/release/memory.ts';
import {MemoryService} from '../../src/memory.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {Admin} from '../../src/release/admin.ts';
import {toolResponse,captureToolResponse} from '../../src/mcp-auth.ts';
import {memoryResponseAuthority} from '../../src/memory.ts';
const signing=await generateKeyPair('RS256');
const boundary=sql=>sql.includes('/* mcp-response-authority */');
function inject(db,callback,after=false){const prepare=db.prepare.bind(db);let count=0;db.prepare=sql=>{const s=prepare(sql),first=s.first.bind(s);s.first=async()=>{if(boundary(sql)&&!after){count++;await callback();}const r=await first();if(boundary(sql)&&after){count++;await callback();}return r;};return s;};return ()=>count;}
async function setup(t,release=true){const f=await fixture();t.after(()=>f.db.close());let now=at;
 f.db.raw.prepare('INSERT INTO provider_identities VALUES(?,?,?,?)').run(AUTH_ISSUER,'r12','bob',at);
 const oauth=await new SignJWT({token_use:'access',client_id:'agent',azp:'agent',scope:'memory:read memory:write memory:delete'}).setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(AUTH_ISSUER).setAudience(PUBLIC_ORIGIN).setSubject('r12').setJti('r12').setIssuedAt(at/1000).setExpirationTime(at/1000+900).sign(signing.privateKey);
 const env={DB:f.db,SSO_CLIENT_ID:'browser',REQUEST_LIMITER:{limit:async()=>({success:true})}},app=createApplication(f.db,readSettings(env),{clock:()=>now,auth:{jwks:async()=>signing.publicKey},...(release?{release:createRelease(env,{clock:()=>now})}:{})});
 await app(new Request(PUBLIC_ORIGIN+'/v1/spaces',{headers:{authorization:'Bearer '+oauth}}));
 const memory=release?new MemoryStore(f.db,()=>now):new MemoryService(f.db,()=>now),saved=await memory.create(f.token,'so',{body:'CONFIDENTIAL-R12'},'seed');
 const call=(name,args,token=oauth,version='2025-11-25')=>app(new Request(PUBLIC_ORIGIN+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':version,...(version==='2026-07-28'?{'mcp-method':'tools/call','mcp-name':name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:'r12',method:'tools/call',params:{name,arguments:args,...(version==='2026-07-28'?{_meta:{'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientInfo':{name:'r12',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}:{})}})}));
 return {...f,oauth,memory,saved,call,setNow:value=>{now=value;},app};
}
function result(text){const payload=text.startsWith('event:')||text.startsWith('id:')?JSON.parse(text.match(/^data: (.+)$/m)[1]):JSON.parse(text);assert.equal(payload.id,'r12');return payload.result;}
for(const release of [false,true])for(const version of ['2025-11-25','2026-07-28'])for(const change of ['revoke','expire'])test('final MCP '+(release?'release':'foundation')+' '+version+' suppresses memory after membership '+change,async t=>{
 const f=await setup(t,release),count=inject(f.db,()=>f.db.raw.prepare(change==='revoke'?"UPDATE memberships SET revoked_at=? WHERE id='m2'":"UPDATE memberships SET expires_at=? WHERE id='m2'").run(at));
 const response=await f.call('memory_get',{spaceId:'so',memoryId:f.saved.id},f.oauth,version),text=await response.text();assert.equal(count(),1);assert.equal(response.status,200);assert.equal(response.headers.get('www-authenticate'),null);assert.doesNotMatch(text,/CONFIDENTIAL-R12/);assert.equal(result(text).isError,true);
 assert.equal((await f.app(new Request(PUBLIC_ORIGIN+'/v1/spaces/so/memories/'+f.saved.id,{headers:{authorization:'Bearer '+f.oauth}}))).status,403);
});
for(const kind of ['oauth','pat','session'])for(const change of ['credential','membership'])test(kind+' checks '+change+' expiry after the final snapshot without plaintext',async t=>{
 const f=await setup(t);let token=f.oauth,credentialId=f.db.raw.prepare("SELECT id FROM credentials WHERE id LIKE 'oauth:%'").get().id;
 if(kind==='session'){token=f.other;credentialId='session:bob';}if(kind==='pat'){const key=await new Admin({DB:f.db},()=>at).issueKey(f.other,{label:'Read',organizationId:'org',capabilities:['read'],spaceIds:['so'],expiresInDays:1});token=key.token;credentialId=key.id;}
 f.db.raw.prepare(change==='credential'?'UPDATE credentials SET expires_at=? WHERE id=?':'UPDATE memberships SET expires_at=? WHERE id=?').run(at+100,change==='credential'?credentialId:'m2');
 const count=inject(f.db,()=>f.setNow(at+200),true),response=await f.call('memory_get',{spaceId:'so',memoryId:f.saved.id},token),text=await response.text();assert.equal(count(),1);assert.doesNotMatch(text,/CONFIDENTIAL-R12/);
 if(kind==='oauth'&&change==='credential'){assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/invalid_token/);}else {assert.equal(response.status,200);assert.equal(response.headers.get('www-authenticate'),null);assert.equal(result(text).isError,true);}
});
for(const kind of ['pat','session'])test('final '+kind+' response suppresses revocation during buffering',async t=>{
 const f=await setup(t);let token=f.other;if(kind==='pat')token=(await new Admin({DB:f.db},()=>at).issueKey(f.other,{label:'Read',organizationId:'org',capabilities:['read'],spaceIds:['so'],expiresInDays:1})).token;
 const count=inject(f.db,()=>f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m2'").run(at)),response=await f.call('memory_get',{spaceId:'so',memoryId:f.saved.id},token),text=await response.text();assert.equal(count(),1);assert.equal(response.status,200);assert.doesNotMatch(text,/CONFIDENTIAL-R12/);assert.equal(result(text).isError,true);
});
for(const grant of ['independent','share revoked','recipient revoked','grantor revoked','share expired','grantor expired'])test('final snapshot respects accepted-share alternatives: '+grant,async t=>{
 const f=await setup(t),transfers=new Transfers(f.db,()=>at),share=await transfers.share(f.token,'so','bob@example.com',1);await transfers.accept(f.other,share.id);
 f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at+100);
 if(grant==='share expired')f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:bob'").run(at+172800000);
 if(grant==='grantor expired')f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+100);
 if(grant.endsWith('revoked'))inject(f.db,()=>{f.db.raw.prepare(grant==='share revoked'?'UPDATE release_shares SET revoked_at=? WHERE id=?':grant==='recipient revoked'?'UPDATE account_emails SET revoked_at=? WHERE id=?':'UPDATE memberships SET revoked_at=? WHERE id=?').run(at,grant==='share revoked'?share.id:grant==='recipient revoked'?'e2':'m1');f.setNow(at+200);});
 else inject(f.db,()=>f.setNow(at+(grant==='share expired'?86400001:200)),true);
 const response=await f.call('memory_get',{spaceId:'so',memoryId:f.saved.id},grant==='share expired'?f.other:f.oauth),text=await response.text();assert.equal(response.status,200);if(grant==='independent'){assert.match(text,/CONFIDENTIAL-R12/);assert.notEqual(result(text).isError,true);}else{assert.doesNotMatch(text,/CONFIDENTIAL-R12/);assert.equal(result(text).isError,true);}
});
for(const release of [false,true])for(const name of ['memory_get','memory_list','memory_search'])for(const change of ['revision','delete'])test('final '+(release?'release':'foundation')+' '+name+' suppresses stale '+change,async t=>{
 const f=await setup(t,release);inject(f.db,async()=>{if(change==='revision')await f.memory.update(f.token,'so',f.saved.id,{body:'REPLACEMENT',expectedRevision:1},'later-update');else await f.memory.remove(f.token,'so',f.saved.id,1,'later-delete');});
 const response=await f.call(name,{spaceId:'so',...(name==='memory_get'?{memoryId:f.saved.id}:name==='memory_search'?{query:'CONFIDENTIAL'}:{})}),text=await response.text();assert.equal(response.status,200);assert.doesNotMatch(text,/CONFIDENTIAL-R12/);assert.equal(result(text).isError,true);
});
for(const name of ['memory_get','memory_list','memory_search'])test(name+' suppresses source erasure at the final response',async t=>{
 const f=await setup(t);inject(f.db,async()=>{await f.memory.remove(f.token,'so',f.saved.id,1,'delete');await f.memory.erase(f.token,'so',f.saved.id,2,f.saved.id,'erase');});
 const response=await f.call(name,{spaceId:'so',...(name==='memory_get'?{memoryId:f.saved.id}:name==='memory_search'?{query:'CONFIDENTIAL'}:{})}),text=await response.text();assert.doesNotMatch(text,/CONFIDENTIAL-R12/);assert.equal(result(text).isError,true);
});
for(const name of ['memory_get','memory_list','memory_search'])test('supersession final visibility matches '+name+' contract',async t=>{
 const f=await setup(t);inject(f.db,()=>f.memory.create(f.token,'so',{body:'new fact',supersedesMemoryId:f.saved.id},'supersede'));
 const response=await f.call(name,{spaceId:'so',...(name==='memory_get'?{memoryId:f.saved.id}:name==='memory_search'?{query:'CONFIDENTIAL'}:{})}),text=await response.text();if(name==='memory_get'){assert.match(text,/CONFIDENTIAL-R12/);assert.notEqual(result(text).isError,true);}else {assert.doesNotMatch(text,/CONFIDENTIAL-R12/);assert.equal(result(text).isError,true);}
});
for(const release of [false,true])test('Space list suppresses expired metadata in final '+(release?'release':'foundation')+' snapshot',async t=>{
 const f=await setup(t,release);f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at+100);inject(f.db,()=>f.setNow(at+200),true);
 const response=await f.call('memory_spaces',{}),text=await response.text();assert.equal(response.status,200);assert.doesNotMatch(text,/Team/);assert.equal(result(text).isError,true);
});
for(const name of ['memory_list','memory_search'])test('empty '+name+' still checks requested Space authority',async t=>{
 const f=await setup(t);await f.memory.remove(f.token,'so',f.saved.id,1,'remove');inject(f.db,()=>f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m2'").run(at));
 const response=await f.call(name,{spaceId:'so',...(name==='memory_search'?{query:'absent'}:{})});assert.equal(result(await response.text()).isError,true);
});
for(const change of ['read lost','revision','erasure'])test('full write response becomes a receipt after '+change+' without claiming the committed write failed',async t=>{
 const f=await setup(t),key=await new Admin({DB:f.db},()=>at).issueKey(f.other,{label:'Writer',capabilities:['create','read'],spaceIds:['s2'],expiresInDays:1});
 inject(f.db,async()=>{const memory=f.db.raw.prepare("SELECT id FROM memories WHERE space_id='s2'").get();if(change==='read lost')f.db.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run('["create"]',key.id);else if(change==='revision')await f.memory.update(f.other,'s2',memory.id,{body:'later',expectedRevision:1},'later');else {await f.memory.remove(f.other,'s2',memory.id,1,'delete');await f.memory.erase(f.other,'s2',memory.id,2,memory.id,'erase');}});
 const response=await f.call('memory_add',{spaceId:'s2',body:'CONFIDENTIAL-R12',operationId:'create'},key.token),text=await response.text(),tool=result(text),receipt=JSON.parse(tool.content[0].text);assert.equal(tool.isError,false);assert.equal(receipt.representation,'receipt');assert.equal(receipt.revision,1);assert.equal(receipt.committedRevision,1);assert.doesNotMatch(text,/CONFIDENTIAL-R12/);
});
test('write-only receipt survives erasure and keeps its committed revision',async t=>{
 const f=await setup(t),key=await new Admin({DB:f.db},()=>at).issueKey(f.other,{label:'Writer',capabilities:['create'],spaceIds:['s2'],expiresInDays:1});
 inject(f.db,async()=>{const memory=f.db.raw.prepare("SELECT id FROM memories WHERE space_id='s2'").get();await f.memory.remove(f.other,'s2',memory.id,1,'delete');await f.memory.erase(f.other,'s2',memory.id,2,memory.id,'erase');});
 const response=await f.call('memory_add',{spaceId:'s2',body:'CONFIDENTIAL-R12',operationId:'create'},key.token),tool=result(await response.text()),receipt=JSON.parse(tool.content[0].text);assert.equal(tool.isError,false);assert.equal(receipt.representation,'receipt');assert.equal(receipt.revision,1);assert.equal(receipt.committedRevision,1);assert.equal('body' in receipt,false);
});
test('superseding add receipt retains its separate update-capability requirement',async t=>{
 const f=await setup(t),key=await new Admin({DB:f.db},()=>at).issueKey(f.token,{label:'Writer',organizationId:'org',capabilities:['create','update'],spaceIds:['so'],expiresInDays:1});inject(f.db,()=>f.db.raw.prepare('UPDATE release_credential_policies SET capabilities=? WHERE credential_id=?').run('["create"]',key.id));
 const response=await f.call('memory_add',{spaceId:'so',body:'new fact',supersedesMemoryId:f.saved.id,operationId:'replace'},key.token);assert.equal(result(await response.text()).isError,true);
});
test('a successful tool result without a captured manifest fails closed',async t=>{
 const f=await setup(t,false),response=await toolResponse(Response.json({jsonrpc:'2.0',id:'r12',result:{content:[{type:'text',text:'CONFIDENTIAL-R12'}]}}),f.other,f.db,()=>at,PUBLIC_ORIGIN,memoryResponseAuthority,{}),text=await response.text();assert.doesNotMatch(text,/CONFIDENTIAL-R12/);assert.equal(result(text).isError,true);
});
test('SSE captures delayed callback metadata only after buffering, and rewrites framing without stale length headers',async t=>{
 const f=await setup(t,false),context={},stream=new ReadableStream({start(controller){setTimeout(()=>{captureToolResponse(context,'memory_get',{spaceId:'so'},f.saved);controller.enqueue(new TextEncoder().encode('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:'r12',result:{content:[{type:'text',text:JSON.stringify(f.saved)}]}})+'\n\n'));controller.close();},0);}});
 inject(f.db,()=>f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m2'").run(at));const response=await toolResponse(new Response(stream,{headers:{'content-type':'text/event-stream','content-length':'9999','content-encoding':'identity'}}),f.other,f.db,()=>at,PUBLIC_ORIGIN,memoryResponseAuthority,context),text=await response.text();assert.doesNotMatch(text,/CONFIDENTIAL-R12/);assert.equal(result(text).isError,true);assert.equal(response.headers.get('content-length'),null);assert.equal(response.headers.get('content-encoding'),null);assert.ok(context.manifest);
});
test('empty Space discovery and ordinary SDK errors retain their protocol results',async t=>{
 const f=await setup(t);const key=await new Admin({DB:f.db},()=>at).issueKey(f.other,{label:'Create only',capabilities:['create'],spaceIds:['s2'],expiresInDays:1});
 const response=await f.call('memory_spaces',{},key.token),tool=result(await response.text());assert.notEqual(tool.isError,true);assert.deepEqual(JSON.parse(tool.content[0].text).results,[]);
 const unknown=await f.call('unknown_tool',{}),text=await unknown.text();assert.equal(unknown.status,200);assert.doesNotMatch(text,/CONFIDENTIAL-R12/);assert.match(text,/error/);
});
test('final response query binds bounded manifests and uses point lookups under foreign growth',async t=>{
 const f=await setup(t),prepare=f.db.prepare.bind(f.db);let query,values;f.db.raw.exec('PRAGMA temp_store=MEMORY');
 f.db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...args)=>{if(boundary(sql)){query=sql;values=args;}return bind(...args);};return statement;};
 await (await f.call('memory_get',{spaceId:'so',memoryId:f.saved.id})).text();
 const median=()=>{const times=[];for(let i=0;i<5;i++){const before=performance.now();f.db.raw.prepare(query).get(...values);times.push(performance.now()-before);}return times.sort((a,b)=>a-b)[2];},before=median();
 f.db.raw.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO spaces(id,name,account_id,security_mode,created_at,actor_credential_id) SELECT 'foreign:'||x,'Foreign','alice','managed',${at},'session:alice' FROM n;`);
 const elapsed=median(),plan=f.db.raw.prepare('EXPLAIN QUERY PLAN '+query).all(...values).map(row=>row.detail);assert.equal(plan.some(line=>/^SCAN (s|r)(?: |$)/.test(line)),false,plan.join('\n'));assert.ok(plan.some(line=>/SEARCH s .*\(id=\?\)/.test(line)),plan.join('\n'));assert.ok(elapsed<before*8+5);assert.ok(values.length<30);t.diagnostic('final snapshot median ms: '+before.toFixed(3)+' -> '+elapsed.toFixed(3));
});

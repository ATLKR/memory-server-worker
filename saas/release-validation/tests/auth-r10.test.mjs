import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {readFileSync,existsSync} from 'node:fs';
import {fixture,DB,at} from './db.mjs';
import {createApplication} from '../../src/app.ts';
import {createRelease} from '../../src/release/extension.ts';
import {readSettings,AUTH_ISSUER,PUBLIC_ORIGIN} from '../../src/config.ts';
import {WorkspaceService} from '../../src/workspace.ts';
import {MemoryService} from '../../src/memory.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {Admin} from '../../src/release/admin.ts';

const keys=await generateKeyPair('RS256');
async function oauth(t,releaseEnabled=true){const db=new DB();db.migrate();t.after(()=>db.close());let now=at;
 const token=await new SignJWT({token_use:'access',client_id:'agent',azp:'agent',scope:'memory:read memory:write memory:delete'}).setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(AUTH_ISSUER).setAudience(PUBLIC_ORIGIN).setSubject('r10').setJti('r10').setIssuedAt(at/1000).setExpirationTime(at/1000+900).sign(keys.privateKey);
 const env={DB:db,SSO_CLIENT_ID:'browser',REQUEST_LIMITER:{limit:async()=>({success:true})}},app=createApplication(db,readSettings(env),{clock:()=>now,auth:{jwks:async()=>keys.publicKey},...(releaseEnabled?{release:createRelease(env,{clock:()=>now})}:{})});
 const request=(bearer=token,name='memory_add',args={},version='2025-11-25')=>app(new Request(PUBLIC_ORIGIN+'/mcp',{method:'POST',headers:{...(bearer?{authorization:'Bearer '+bearer}:{}),'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':version,...(version==='2026-07-28'?{'mcp-method':'tools/call','mcp-name':name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,...(version==='2026-07-28'?{_meta:{'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientInfo':{name:'r10',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}:{})}})}));
 await app(new Request(PUBLIC_ORIGIN+'/v1/spaces',{headers:{authorization:'Bearer '+token}}));
 const space=db.raw.prepare("SELECT id FROM spaces WHERE account_id=(SELECT account_id FROM provider_identities WHERE subject='r10')").get().id;
 return {db,token,space,request,setNow:value=>{now=value;}};
}
for(const version of ['2025-11-25','2026-07-28'])for(const boundary of ['expiry','revocation'])test('MCP '+version+' returns invalid_token challenge for mid-tool '+boundary,async t=>{
 const f=await oauth(t),prepare=f.db.prepare.bind(f.db);let injected=false;
 f.db.prepare=sql=>{const statement=prepare(sql),first=statement.first.bind(statement);statement.first=async()=>{const value=await first();if(!injected&&sql.includes('SELECT c.id,c.account_id AS accountId')&&sql.includes('FROM spaces s')){injected=true;if(boundary==='expiry')f.setNow(at+900000);else f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id LIKE 'oauth:%'").run(at);}return value;};return statement;};
 const response=await f.request(f.token,'memory_add',{spaceId:f.space,body:'must not commit',operationId:'expired'},version);
 await response.text();
 assert.ok(injected);assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/error="invalid_token"/);assert.match(response.headers.get('www-authenticate'),/resource_metadata=/);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_operations').get().n,0);
});
test('foundation MCP also distinguishes mid-tool OAuth expiry from ACL errors',async t=>{
 const f=await oauth(t,false),prepare=f.db.prepare.bind(f.db);let armed=true;
 f.db.prepare=sql=>{const statement=prepare(sql),all=statement.all.bind(statement);statement.all=async()=>{const value=await all();if(armed&&sql.includes('LEFT JOIN memories r')){armed=false;f.setNow(at+900000);}return value;};return statement;};
 const response=await f.request(f.token,'memory_list',{spaceId:f.space});await response.text();assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/error="invalid_token"/);
});
test('rejected JWT includes invalid_token while an absent bearer has no error parameter',async t=>{
 const f=await oauth(t);f.setNow(at+900000);
 const invalid=await f.request(),missing=await f.request(null);assert.equal(invalid.status,401);assert.match(invalid.headers.get('www-authenticate'),/error="invalid_token"/);assert.equal(missing.status,401);assert.doesNotMatch(missing.headers.get('www-authenticate'),/error=/);
});
test('valid OAuth ordinary Space ACL denial retains SDK tool response',async t=>{
 const f=await oauth(t),response=await f.request(f.token,'memory_add',{spaceId:'foreign',body:'denied',operationId:'acl'});assert.equal(response.status,200);assert.equal(response.headers.get('www-authenticate'),null);assert.match(await response.text(),/access_denied/);
});
test('OAuth response boundary checks expiry after its final credential snapshot',async t=>{
 const f=await oauth(t),prepare=f.db.prepare.bind(f.db);let injected=false;
 f.db.prepare=sql=>{const statement=prepare(sql),first=statement.first.bind(statement);statement.first=async()=>{const value=await first();if(sql.includes("/* mcp-response-authority */")){injected=true;f.setNow(at+900000);}return value;};return statement;};
 const response=await f.request(f.token,'memory_list',{spaceId:f.space});assert.ok(injected);assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/error="invalid_token"/);
});

async function currentFixture(t){const f=await fixture();t.after(()=>f.db.close());const source=new URL('../../workspace-lookup-schema.sql',import.meta.url);if(f.db.raw.prepare('SELECT version FROM release_meta').get().version<15&&existsSync(source))f.db.raw.exec(readFileSync(source,'utf8'));return f;}
test('workspace and foundation queries stay tenant scoped under foreign Space and key growth',async t=>{
 const f=await currentFixture(t),workspace=new WorkspaceService(f.db,()=>at),memory=new MemoryService(f.db,()=>at),queries=new Map(),prepare=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...args)=>{if(sql.includes(' AS keys'))queries.set('workspace',{sql,args});if(sql.includes('ORDER BY s.created_at,s.id LIMIT 100'))queries.set('foundation',{sql,args});return bind(...args);};return statement;};
 const initial=await workspace.snapshot(f.token),spaces=await memory.listSpaces(f.token);assert.equal(initial.spaces.length,2);assert.equal(initial.keys.length,1);
 const median=fn=>{const samples=[];for(let i=0;i<5;i++){const start=performance.now();fn();samples.push(performance.now()-start);}return samples.sort((a,b)=>a-b)[2];};
 const before=Object.fromEntries([...queries].map(([name,{sql,args}])=>[name,median(()=>f.db.raw.prepare(sql).all(...args))]));
 f.db.raw.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO spaces(id,name,account_id,security_mode,created_at,actor_credential_id) SELECT 'foreign-space:'||x,'Foreign','bob','managed',${at},'session:bob' FROM n;
 WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,permission) SELECT 'foreign-key:'||x,'bob','personal_key',printf('%064x',x),${at+900000},'read' FROM n;`);
 assert.deepEqual(await workspace.snapshot(f.token),initial);assert.deepEqual(await memory.listSpaces(f.token),spaces);
 for(const [name,{sql,args}] of queries){const plan=f.db.raw.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>row.detail),elapsed=median(()=>f.db.raw.prepare(sql).all(...args));t.diagnostic(name+' median ms: '+before[name].toFixed(3)+' -> '+elapsed.toFixed(3));assert.equal(plan.some(line=>/^SCAN (s|k)(?: |$)/.test(line)),false,plan.join('\n'));assert.ok(elapsed<before[name]*8+5,name+' scales with foreign rows: '+elapsed);}
});
test('workspace candidates preserve own and exact organization key history without child or personal-key inheritance',async t=>{
 const f=await currentFixture(t),workspace=new WorkspaceService(f.db,()=>at),admin=new Admin({DB:f.db},()=>at);
 const parentKey=await admin.issueKey(f.other,{label:'Parent',organizationId:'org',capabilities:['read'],expiresInDays:1});
 const privateKey=await admin.issueKey(f.other,{label:'Private',capabilities:['read'],expiresInDays:1});
 f.db.raw.prepare("UPDATE memberships SET role='admin' WHERE id='m2'").run();
 const child=await workspace.createOrganization(f.other,{name:'Child',parentOrganizationId:'org',emailId:'e2'}),childKey=await admin.issueKey(f.other,{label:'Child',organizationId:child.id,capabilities:['read'],expiresInDays:1});
 const snapshot=()=>workspace.snapshot(f.token),before=await snapshot();assert.ok(before.keys.some(key=>key.id===parentKey.id));assert.ok(!before.keys.some(key=>[privateKey.id,childKey.id].includes(key.id)));assert.ok(!before.spaces.some(space=>space.id===child.spaceId));
 await workspace.revokeMembership(f.token,'org','m2');const historical=(await snapshot()).keys.find(key=>key.id===parentKey.id);assert.equal(historical.revokedAt,at);
 f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at);assert.deepEqual((await snapshot()).keys.map(key=>key.id),['key:alice']);
});
test('release workspace candidates deduplicate independent shares and revoke only the expired route',async t=>{
 const f=await currentFixture(t);let now=at;const transfer=new Transfers(f.db,()=>now),workspace=new WorkspaceService(f.db,()=>now),release=createRelease({DB:f.db},{clock:()=>now});
 const share=await transfer.share(f.token,'so','bob@example.com',1);await transfer.accept(f.other,share.id);
 assert.equal((await workspace.snapshot(f.other,release.workspaceSpaceAccess)).spaces.filter(space=>space.id==='so').length,1);
 f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at+100);now=at+200;
 const shared=(await workspace.snapshot(f.other,release.workspaceSpaceAccess)).spaces.find(space=>space.id==='so');assert.equal(shared.canWrite,false);
 await transfer.revoke(f.token,'so',share.id);assert.ok(!(await workspace.snapshot(f.other,release.workspaceSpaceAccess)).spaces.some(space=>space.id==='so'));
});
test('migration15 preserves populated history and gives admin quota checks an account index',async t=>{
 const db=new DB();db.migrate(14);t.after(()=>db.close());
 const workspace=new WorkspaceService(db,()=>at),session=await workspace.signIn({issuer:AUTH_ISSUER,subject:'retained15',email:'retained15@example.com',emailVerified:true,permission:'write',expiresAt:at+900000});
 db.raw.prepare('UPDATE credentials SET reauthenticated_at=? WHERE account_id=?').run(at,session.accountId);
 const account=(await workspace.snapshot(session.token)).account;
 await workspace.createOrganization(session.token,{name:'Retained organization',emailId:account.emails[0].id});
 const key=await new Admin({DB:db},()=>at).issueKey(session.token,{label:'Retained revoked key',capabilities:['read'],expiresInDays:1});
 db.raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(at,key.id);
 const tables=db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'release_fts_%' ORDER BY name").all().map(row=>row.name),before=Object.fromEntries(tables.filter(name=>!['release_meta','release_maintenance_progress'].includes(name)).map(name=>[name,db.raw.prepare('SELECT * FROM '+name).all()]));
 db.raw.exec(readFileSync(new URL('../../migrations/0015_workspace-lookup-schema.sql',import.meta.url),'utf8'));
 for(const [name,values] of Object.entries(before))assert.deepEqual(db.raw.prepare('SELECT * FROM '+name).all(),values,name);
 assert.equal(db.raw.prepare("SELECT cursor FROM release_maintenance_progress WHERE name='source_erasure'").get().cursor,'');assert.equal(db.raw.prepare('SELECT version FROM release_meta').get().version,15);
 const plan=db.raw.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM credentials k WHERE k.account_id=? AND k.kind<>'session' AND k.revoked_at IS NULL AND k.expires_at>?").all('alice',at).map(row=>row.detail);assert.ok(plan.some(line=>line.includes('workspace_credentials_account')),plan.join('\n'));
});

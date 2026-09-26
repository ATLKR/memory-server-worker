import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {fixture,DB,at} from './db.mjs';
import {createApplication} from '../../src/app.ts';
import {createRelease} from '../../src/release/extension.ts';
import {readSettings,AUTH_ISSUER,PUBLIC_ORIGIN} from '../../src/config.ts';
import {WorkspaceService} from '../../src/workspace.ts';
import {MemoryService} from '../../src/memory.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {Admin} from '../../src/release/admin.ts';

const keys=await generateKeyPair('RS256');
async function oauth(t,releaseEnabled=true){let now=at;const db=new DB(()=>now);(await db.migrate());t.after(()=>db.close());
 // OAuth sign-in records a provider identity; the lifecycle staleness gate
 // denies credentials whose issuer has no fresh apply head.
 await db.raw.prepare('INSERT INTO memory_ops.lifecycle_apply_head(issuer,applied_sequence,applied_at_ms) VALUES(?,0,?)').run(AUTH_ISSUER,9007199254740991);
 await db.raw.prepare("INSERT INTO memory_ops.lifecycle_apply_head(issuer,applied_sequence,applied_at_ms) VALUES('memory:control',0,?)").run(9007199254740991);
 const token=await new SignJWT({token_use:'access',client_id:'agent',azp:'agent',scope:'memory:read memory:write memory:delete'}).setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(AUTH_ISSUER).setAudience(PUBLIC_ORIGIN).setSubject('r10').setJti('r10').setIssuedAt(at/1000).setExpirationTime(at/1000+900).sign(keys.privateKey);
 const env={DB:db,SSO_CLIENT_ID:'browser',REQUEST_LIMITER:{limit:async()=>({success:true})}},app=createApplication(db,readSettings(env),{clock:()=>now,auth:{jwks:async()=>keys.publicKey},...(releaseEnabled?{release:createRelease(env,{clock:()=>now})}:{})});
 const request=(bearer=token,name='memory_add',args={},version='2025-11-25')=>app(new Request(PUBLIC_ORIGIN+'/mcp',{method:'POST',headers:{...(bearer?{authorization:'Bearer '+bearer}:{}),'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':version,...(version==='2026-07-28'?{'mcp-method':'tools/call','mcp-name':name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,...(version==='2026-07-28'?{_meta:{'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientInfo':{name:'r10',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}:{})}})}));
 await app(new Request(PUBLIC_ORIGIN+'/v1/spaces',{headers:{authorization:'Bearer '+token}}));
 const space=(await db.raw.prepare("SELECT id FROM spaces WHERE account_id=(SELECT account_id FROM provider_identities WHERE subject='r10')").get()).id;
 return {db,token,space,request,setNow:value=>{now=value;}};
}
for(const version of ['2025-11-25','2026-07-28'])for(const boundary of ['expiry','revocation'])test('MCP '+version+' returns invalid_token challenge for mid-tool '+boundary,async t=>{
 const f=await oauth(t),prepare=f.db.prepare.bind(f.db);let injected=false;
 f.db.prepare= sql=>{const statement=prepare(sql),first=statement.first.bind(statement);statement.first=async()=>{const value=await first();if(!injected&&sql.includes('SELECT c.id,c.account_id AS "accountId"')&&sql.includes('FROM memory_control.spaces s')){injected=true;if(boundary==='expiry')f.setNow(at+900000);else (await f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id LIKE 'oauth:%'").run(at));}return value;};return statement;};
 const response=await f.request(f.token,'memory_add',{spaceId:f.space,body:'must not commit',operationId:'expired'},version);
 await response.text();
 assert.ok(injected);assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/error="invalid_token"/);assert.match(response.headers.get('www-authenticate'),/resource_metadata=/);assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_operations').get()).n,0);
});
test('foundation MCP also distinguishes mid-tool OAuth expiry from ACL errors',async t=>{
 const f=await oauth(t,false),prepare=f.db.prepare.bind(f.db);let armed=true;
 f.db.prepare= sql=>{const statement=prepare(sql),all=statement.all.bind(statement);statement.all=async()=>{const value=await all();if(armed&&sql.includes('LEFT JOIN memory_content.memories r')){armed=false;f.setNow(at+900000);}return value;};return statement;};
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
 f.db.prepare= sql=>{const statement=prepare(sql),first=statement.first.bind(statement);statement.first=async()=>{const value=await first();if(sql.includes("/* mcp-response-authority */")){injected=true;f.setNow(at+900000);}return value;};return statement;};
 const response=await f.request(f.token,'memory_list',{spaceId:f.space});assert.ok(injected);assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/error="invalid_token"/);
});

async function currentFixture(t){const f=await fixture();t.after(()=>f.db.close());return f;}
test('workspace and foundation queries stay tenant scoped under foreign Space and key growth',async t=>{
 const f=await currentFixture(t),workspace=new WorkspaceService(f.db,()=>at),memory=new MemoryService(f.db,()=>at),queries=new Map(),prepare=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...args)=>{if(sql.includes(' AS keys'))queries.set('workspace',{sql,args});if(sql.includes('ORDER BY s.created_at_ms,s.id LIMIT 100'))queries.set('foundation',{sql,args});return bind(...args);};return statement;};
 const initial=await workspace.snapshot(f.token),spaces=await memory.listSpaces(f.token);assert.equal(initial.spaces.length,2);assert.equal(initial.keys.length,1);
 const median=async fn=>{const samples=[];for(let i=0;i<5;i++){const start=performance.now();await fn();samples.push(performance.now()-start);}return samples.sort((a,b)=>a-b)[2];};
 const before=Object.fromEntries(await Promise.all([...queries].map(async([name,{sql,args}])=>[name,await median(async()=>{await f.db.raw.prepare(sql).all(...args);})])));
 const policy=`jsonb_build_object('policyVersion',1,'residency','sg','profile','standard','processingBoundary','approved-processors','dataClass','general','classificationStatus','declared','sensitivityTags','[]'::jsonb,'placementEpoch',1)`;
 await f.db.raw.exec(`INSERT INTO memory_control.spaces(id,name,owner_account_id,deployment_id,data_policy,source_byte_limit,message_limit,security_mode,created_at_ms,actor_credential_id) SELECT 'foreign-space:'||x,'Foreign','bob','memory-sg',${policy},67108864,100000,'managed',${at},'session:bob' FROM generate_series(1,100000) x;
 INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at,permission) SELECT 'foreign-key:'||x,'bob','personal_key',lpad(to_hex(x),64,'0'),${at+900000},'read' FROM generate_series(1,100000) x;`);
 assert.deepEqual(await workspace.snapshot(f.token),initial);assert.deepEqual(await memory.listSpaces(f.token),spaces);
 for(const [name,{sql,args}] of queries){const plan=(await f.db.raw.prepare('EXPLAIN '+sql).all(...args)).map(row=>row['QUERY PLAN']),elapsed=await median(async()=>{await f.db.raw.prepare(sql).all(...args);});t.diagnostic(name+' median ms: '+before[name].toFixed(3)+' -> '+elapsed.toFixed(3));assert.equal(plan.some(line=>/Seq Scan on (\S+\.)?(spaces|credentials)( |$)/.test(line)),false,plan.join('\n'));assert.ok(elapsed<before[name]*8+5,name+' scales with foreign rows: '+elapsed);}
});
test('workspace candidates preserve own and exact organization key history without child or personal-key inheritance',async t=>{
 const f=await currentFixture(t),workspace=new WorkspaceService(f.db,()=>at),admin=new Admin({DB:f.db},()=>at);
 const parentKey=await admin.issueKey(f.other,{label:'Parent',organizationId:'org',capabilities:['read'],expiresInDays:1});
 const privateKey=await admin.issueKey(f.other,{label:'Private',capabilities:['read'],expiresInDays:1});
 (await f.db.raw.prepare("UPDATE memory_identity.memberships SET role='admin' WHERE id='m2'").run());
 const child=await workspace.createOrganization(f.other,{name:'Child',parentOrganizationId:'org',emailId:'e2'}),childKey=await admin.issueKey(f.other,{label:'Child',organizationId:child.id,capabilities:['read'],expiresInDays:1});
 const snapshot=()=>workspace.snapshot(f.token),before=await snapshot();assert.ok(before.keys.some(key=>key.id===parentKey.id));assert.ok(!before.keys.some(key=>[privateKey.id,childKey.id].includes(key.id)));assert.ok(!before.spaces.some(space=>space.id===child.spaceId));
 await workspace.revokeMembership(f.token,'org','m2');const historical=(await snapshot()).keys.find(key=>key.id===parentKey.id);assert.equal(historical.revokedAt,at);
 (await f.db.raw.prepare("UPDATE memory_identity.memberships SET expires_at=? WHERE id='m1'").run(at));assert.deepEqual((await snapshot()).keys.map(key=>key.id),['key:alice']);
});
test('release workspace candidates deduplicate independent shares and revoke only the expired route',async t=>{
 t.skip('cross-border share federation is deferred (0011); share INSERTs are denied');return;
 const f=await currentFixture(t);let now=at;const transfer=new Transfers(f.db,()=>now),workspace=new WorkspaceService(f.db,()=>now),release=createRelease({DB:f.db},{clock:()=>now});
 const share=await transfer.share(f.token,'so','bob@example.com',1);await transfer.accept(f.other,share.id);
 assert.equal((await workspace.snapshot(f.other,release.workspaceSpaceAccess)).spaces.filter(space=>space.id==='so').length,1);
 (await f.db.raw.prepare("UPDATE memory_identity.memberships SET expires_at=? WHERE id='m2'").run(at+100));now=at+200;
 const shared=(await workspace.snapshot(f.other,release.workspaceSpaceAccess)).spaces.find(space=>space.id==='so');assert.equal(shared.canWrite,false);
 await transfer.revoke(f.token,'so',share.id);assert.ok(!(await workspace.snapshot(f.other,release.workspaceSpaceAccess)).spaces.some(space=>space.id==='so'));
});
test('PostgreSQL lineage carries the migration-15 account index, erasure cursor and populated history',async t=>{
 // The D1 lineage applied these objects as incremental migration 15 over live
 // data; the PostgreSQL lineage creates them in 0010 before data exists, so
 // the check is structural: objects present, cursor seeded, index used.
 const db=new DB();(await db.migrate());t.after(()=>db.close());
 await db.raw.prepare('INSERT INTO memory_ops.lifecycle_apply_head(issuer,applied_sequence,applied_at_ms) VALUES(?,0,?)').run(AUTH_ISSUER,9007199254740991);
 await db.raw.prepare("INSERT INTO memory_ops.lifecycle_apply_head(issuer,applied_sequence,applied_at_ms) VALUES('memory:control',0,?)").run(9007199254740991);
 const workspace=new WorkspaceService(db,()=>at),session=await workspace.signIn({issuer:AUTH_ISSUER,subject:'retained15',email:'retained15@example.com',emailVerified:true,permission:'write',expiresAt:at+900000});
 (await db.raw.prepare('UPDATE memory_identity.credentials SET reauthenticated_at=? WHERE account_id=?').run(at,session.accountId));
 const account=(await workspace.snapshot(session.token)).account;
 await workspace.createOrganization(session.token,{name:'Retained organization',emailId:account.emails[0].id});
 const key=await new Admin({DB:db},()=>at).issueKey(session.token,{label:'Retained revoked key',capabilities:['read'],expiresInDays:1});
 (await db.raw.prepare('UPDATE memory_identity.credentials SET revoked_at=? WHERE id=?').run(at,key.id));
 const objects=(await db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('workspace_credentials_account','workspace_memberships_organization','release_memories_erasure_sweep') ORDER BY name").all()).map(row=>row.name);
 assert.deepEqual(objects,['release_memories_erasure_sweep','workspace_credentials_account','workspace_memberships_organization']);
 assert.equal((await db.raw.prepare("SELECT cursor FROM release_maintenance_progress WHERE name='source_erasure'").get()).cursor,'');
 assert.ok((await db.raw.prepare('SELECT version FROM release_meta').get()).version>=10);
 assert.equal((await db.raw.prepare('SELECT count(*) n FROM memory_identity.credentials WHERE id=?').get(key.id)).n,1);
 // Enough foreign credentials that the planner prefers an account-scoped index
 // over a sequential scan for the admin quota predicate.
 await db.raw.exec(`INSERT INTO memory_identity.accounts(id) VALUES('bulk');
 INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at,permission)
  SELECT 'bulk-key:'||x,'bulk','personal_key',lpad(to_hex(x),64,'0'),${at+900000},'read' FROM generate_series(1,5000) x;
 ANALYZE memory_identity.credentials;`);
 const plan=(await db.raw.prepare("EXPLAIN SELECT count(*) FROM memory_identity.credentials k WHERE k.account_id=? AND k.kind<>'session' AND k.revoked_at IS NULL AND k.expires_at>?").all(session.accountId,at)).map(row=>row['QUERY PLAN']);
 assert.equal(plan.some(line=>/Seq Scan on (\S+\.)?credentials( |$)/.test(line)),false,plan.join('\n'));
 assert.ok(plan.some(line=>/Index Scan|Index Only Scan|Bitmap Index Scan/.test(line)&&line.includes('credentials')),plan.join('\n'));
});

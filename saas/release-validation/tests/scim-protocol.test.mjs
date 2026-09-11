import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {Admin} from '../../src/release/admin.ts';
import {createRelease} from '../../src/release/extension.ts';

const origin='https://memory.example.com';
async function setup(t){
 const f=await fixture();t.after(()=>f.db.close());
 const env={DB:f.db,PUBLIC_ORIGIN:origin,REQUEST_LIMITER:{limit:async()=>({success:true})}};
 const admin=new Admin(env,()=>at),key=await admin.issueScimKey(f.token,'org');
 const release=createRelease(env,{clock:()=>at});
 return {...f,admin,key,request:(path='',init={})=>release.publicRoute(new Request(origin+'/scim/v2/org/Users'+path,{...init,headers:{authorization:'Bearer '+key.token,...init.headers}}))};
}

test('SCIM accepts its registered JSON media type for deactivation and keeps owner protection',async t=>{
 const f=await setup(t);
 const patch=path=>f.request('/'+path,{method:'PATCH',headers:{'content-type':'application/scim+json; charset=utf-8'},body:JSON.stringify({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'active',value:false}]})});
 assert.equal((await patch('m2')).status,204);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,at);
 assert.equal((await(await f.request('/m2')).json()).active,false);
 assert.equal((await(await f.request()).json()).totalResults,2);
 const denied=await patch('m1');assert.equal(denied.status,403);
 assert.match(denied.headers.get('content-type'),/^application\/scim\+json/);
 const error=await denied.json();assert.equal(error.status,'403');assert.deepEqual(error.schemas,['urn:ietf:params:scim:api:messages:2.0:Error']);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m1'").get().revoked_at,null);
});

for(const condition of ['expired','disabled'])test('SCIM active flag reflects effective membership: '+condition,async t=>{
 const f=await setup(t);
 if(condition==='expired')f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at);
 else f.db.raw.prepare("UPDATE accounts SET disabled_at=? WHERE id='bob'").run(at);
 const response=await f.request('/m2');assert.equal(response.status,200);
 assert.equal((await response.json()).active,false);
});

test('SCIM count zero returns only totals and detail URLs ignore list pagination',async t=>{
 const f=await setup(t),response=await f.request('?count=0');assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.totalResults,2);assert.equal(result.itemsPerPage,0);assert.deepEqual(result.Resources,[]);
 assert.match(response.headers.get('content-type'),/^application\/scim\+json/);
 const detail=await f.request('/m2?startIndex=10&count=0');assert.equal(detail.status,200);assert.equal((await detail.json()).id,'m2');
});

test('SCIM does not silently accept changes beyond supported active deactivation',async t=>{
 const f=await setup(t);
 const response=await f.request('/m2',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',value:{active:false,userName:'changed@example.com'}}]})});
 assert.equal(response.status,400);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,null);
});

test('SCIM rechecks authority after the final list-count read',async t=>{
 const f=await setup(t),prepare=f.db.prepare.bind(f.db);let injected=false;
 f.db.prepare=sql=>{const statement=prepare(sql),first=statement.first;
  statement.first=async()=>{const result=await first();if(sql.includes('SELECT count(*) AS n FROM memberships')&&!injected){injected=true;f.db.raw.prepare('UPDATE release_scim_keys SET revoked_at=? WHERE id=?').run(at,f.key.id);}return result;};return statement;};
 const response=await f.request();assert.equal(injected,true);assert.equal(response.status,401);
 assert.equal(JSON.stringify(await response.json()).includes('alice@example.com'),false);
});

test('SCIM DELETE hides a resource while retaining revoked membership history',async t=>{
 const f=await setup(t);
 assert.equal((await f.request('/m2',{method:'DELETE'})).status,204);
 assert.equal((await f.request('/m2')).status,404);
 assert.equal((await f.request('/m2',{method:'DELETE'})).status,404);
 assert.equal((await f.request('/m2',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'active',value:false}]})})).status,404);
 const listed=await(await f.request()).json();
 assert.equal(listed.totalResults,1);assert.deepEqual(listed.Resources.map(x=>x.id),['m1']);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,at);
 for(const sql of ['UPDATE release_scim_deletions SET deleted_at=deleted_at+1','DELETE FROM release_scim_deletions'])assert.throws(()=>f.db.raw.exec(sql),/immutable/);
});

for(const [query,start,count] of [['startIndex=0',1,2],['startIndex=-5',1,2],['count=-1',1,0],['count=500',1,2]])
test('SCIM normalizes pagination '+query,async t=>{
 const f=await setup(t),response=await f.request('?'+query);assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.startIndex,start);assert.equal(result.itemsPerPage,count);
});

for(const suffix of ['','/m2'])test('SCIM applies attribute inclusion and exclusion to '+(suffix?'detail':'lists'),async t=>{
 const f=await setup(t),values=async query=>{const response=await f.request(suffix+'?'+query);assert.equal(response.status,200);const data=await response.json();return suffix?[data]:data.Resources;};
 for(const resource of await values('attributes=id'))assert.deepEqual(Object.keys(resource).sort(),['id','schemas']);
 for(const resource of await values('excludedAttributes=userName,active,id,schemas'))assert.deepEqual(Object.keys(resource).sort(),['id','schemas']);
 for(const resource of await values('attributes=urn:ietf:params:scim:schemas:core:2.0:User:USERNAME'))assert.deepEqual(Object.keys(resource).sort(),['id','schemas','userName']);
 for(const resource of await values('excludedAttributes=urn:ietf:params:scim:schemas:core:2.0:User:userName'))assert.deepEqual(Object.keys(resource).sort(),['active','id','schemas']);
 for(const resource of await values('attributes=unknown'))assert.deepEqual(Object.keys(resource).sort(),['id','schemas']);
 assert.equal((await f.request(suffix+'?attributes=id&excludedAttributes=active')).status,400);
});

for(const query of ['count=1.5','count=1e2','count=0x10','count=','count=NaN','startIndex=1&startIndex=2','attributes=id,,active','excludedAttributes=active&excludedAttributes=userName'])
test('SCIM rejects malformed query '+query,async t=>{const f=await setup(t);assert.equal((await f.request('?'+query)).status,400);});

test('SCIM accepts signed decimal pagination and caps large requested pages',async t=>{
 const f=await setup(t);
 for(let i=0;i<205;i++)f.db.raw.exec(`INSERT INTO accounts(id) VALUES('page-${i}');
 INSERT INTO account_emails(id,account_id,address,domain,verified_at) VALUES('page-email-${i}','page-${i}','page-${i}@example.com','example.com',${at});
 INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES('page-member-${i}','org','page-${i}','page-email-${i}','member');`);
 const response=await f.request('?startIndex=%2B1&count=%2B500');assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.startIndex,1);assert.equal(result.itemsPerPage,200);assert.equal(result.totalResults,207);
});

test('SCIM DELETE keeps final-owner protection and checks authority at insertion',async t=>{
 const f=await setup(t);
 assert.equal((await f.request('/m1',{method:'DELETE'})).status,403);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_scim_deletions').get().n,0);
 const batch=f.db.batch.bind(f.db);
 f.db.batch=async statements=>{f.db.raw.prepare('UPDATE release_scim_keys SET revoked_at=? WHERE id=?').run(at,f.key.id);return batch(statements);};
 assert.equal((await f.request('/m2',{method:'DELETE'})).status,403);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_scim_deletions').get().n,0);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,null);
});

test('SCIM deletion and membership revocation roll back together on cascade failure',async t=>{
 const f=await setup(t);
 f.db.raw.exec("CREATE TRIGGER reject_scim_cascade BEFORE UPDATE ON memberships WHEN NEW.id='m2' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END;");
 assert.equal((await f.request('/m2',{method:'DELETE'})).status,500);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_scim_deletions').get().n,0);
 assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,null);
});

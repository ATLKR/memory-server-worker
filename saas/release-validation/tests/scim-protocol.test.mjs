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
 const response=await f.request('/m2',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({Operations:[{op:'replace',value:{active:false,userName:'changed@example.com'}}]})});
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {createApplication} from '../../src/app.ts';
import {readSettings,PUBLIC_ORIGIN} from '../../src/config.ts';
import {createRelease} from '../../src/release/extension.ts';

async function setup(t){
 const f=await fixture();t.after(()=>f.db.close());let now=at;
 f.db.raw.exec(`INSERT INTO domains(id,organization_id,name,verified_until) VALUES('domain-test','org','example.com',${at+900000});
 INSERT INTO domain_managers(domain_id,membership_id) VALUES('domain-test','m1');UPDATE memberships SET role='admin' WHERE id='m2';`);
 const env={DB:f.db,REQUEST_LIMITER:{limit:async()=>({success:true})}},app=createApplication(f.db,readSettings(env),{clock:()=>now,release:createRelease(env,{clock:()=>now})});
 const request=(token=f.token)=>app(new Request(PUBLIC_ORIGIN+'/v1/domains/domain-test/delegates',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({membershipId:'m2'})}));
 const granted=()=>f.db.raw.prepare("SELECT revoked_at FROM domain_managers WHERE domain_id='domain-test' AND membership_id='m2'").all();
 return {...f,request,granted,setNow:value=>{now=value;}};
}
test('a lost domain-delegation success response can be retried without a duplicate grant',async t=>{
 const f=await setup(t);assert.equal((await f.request()).status,200); // Discard the successful response body.
 const response=await f.request();assert.equal(response.status,200);assert.deepEqual(await response.json(),{completed:true});
 assert.deepEqual(f.granted().map(row=>row.revoked_at),[null]);
});
test('concurrent domain-delegation retries converge on one valid assignment',async t=>{
 const f=await setup(t),responses=await Promise.all([f.request(),f.request(),f.request()]);
 assert.deepEqual(responses.map(response=>response.status),[200,200,200]);assert.equal(f.granted().length,1);
});
const invalidate={
 'expired credential':db=>db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at),
 'revoked credential':db=>db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at),
 'expired proof':db=>db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-300001),
 'expired manager membership':db=>db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at),
 'revoked manager membership':db=>db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m1'").run(at),
 'revoked manager delegation':db=>db.raw.prepare("UPDATE domain_managers SET revoked_at=? WHERE membership_id='m1'").run(at),
 'demoted manager':db=>db.raw.prepare("UPDATE memberships SET role='member' WHERE id='m1'").run(),
 'expired target membership':db=>db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at),
 'revoked target membership':db=>db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m2'").run(at),
 'revoked target email':db=>db.raw.prepare("UPDATE account_emails SET revoked_at=? WHERE id='e2'").run(at),
 'demoted target':db=>db.raw.prepare("UPDATE memberships SET role='member' WHERE id='m2'").run(),
 'expired domain':db=>db.raw.prepare("UPDATE domains SET verified_until=? WHERE id='domain-test'").run(at),
 'revoked domain':db=>db.raw.prepare("UPDATE domains SET revoked_at=? WHERE id='domain-test'").run(at),
 'revoked target delegation':db=>db.raw.prepare("UPDATE domain_managers SET revoked_at=? WHERE membership_id='m2'").run(at),
};
for(const [label,change] of Object.entries(invalidate))test('domain-delegation retry cannot bypass '+label,async t=>{
 const f=await setup(t);assert.equal((await f.request()).status,200);change(f.db);const before=f.granted();
 const response=await f.request();assert.ok([401,403].includes(response.status),String(response.status));assert.deepEqual(f.granted(),before);
});
for(const mode of ['throw','unsuccessful'])test('domain delegation does not suppress unrelated database failure: '+mode,async t=>{
 const f=await setup(t);assert.equal((await f.request()).status,200);const prepare=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('INSERT INTO domain_managers'))statement.run=async()=>{if(mode==='throw')throw Error('synthetic unrelated database failure');return {success:false,meta:{changes:0}};};return statement;};
 const response=await f.request();assert.equal(response.status,mode==='throw'?500:503);assert.equal(f.granted().length,1);
});
for(const member of ['m1','m2'])test('rejoining does not restore or remap retained delegation '+member,async t=>{
 const f=await setup(t);assert.equal((await f.request()).status,200);
 f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at,member);
 const row=f.db.raw.prepare('SELECT * FROM memberships WHERE id=?').get(member);
 f.db.raw.prepare('INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES(?,?,?,?,?)').run(member+'-new',row.organization_id,row.account_id,row.email_id,row.role);
 const before=f.granted();assert.equal((await f.request()).status,403);assert.deepEqual(f.granted(),before);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM domain_managers WHERE membership_id=?').get(member+'-new').n,0);
});
test('replay authority is rechecked after the conditional insert await',async t=>{
 const f=await setup(t);assert.equal((await f.request()).status,200);const prepare=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('INSERT INTO domain_managers')){const run=statement.run.bind(statement);statement.run=async()=>{const result=await run();f.db.raw.prepare("UPDATE domain_managers SET revoked_at=? WHERE membership_id='m2'").run(at);return result;};}return statement;};
 assert.equal((await f.request()).status,403);assert.deepEqual(f.granted().map(row=>row.revoked_at),[at]);
});
for(const field of ['credential','manager','target','domain','proof'])test('domain-delegation replay rejects '+field+' expiry during its final snapshot',async t=>{
 const f=await setup(t);assert.equal((await f.request()).status,200);
 if(field==='credential')f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+1);
 if(field==='manager')f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+1);
 if(field==='target')f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m2'").run(at+1);
 if(field==='domain')f.db.raw.prepare("UPDATE domains SET verified_until=? WHERE id='domain-test'").run(at+1);
 if(field==='proof')f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-300000);
 let checks=0;const prepare=f.db.prepare.bind(f.db);f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('/* domain-delegation-replay */')){const first=statement.first.bind(statement);statement.first=async()=>{checks++;const result=await first();f.setNow(at+1);return result;};}return statement;};
 assert.equal((await f.request()).status,403);assert.equal(checks,1);assert.equal(f.granted().length,1);
});

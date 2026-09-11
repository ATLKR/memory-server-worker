import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {createRelease} from '../../src/release/extension.ts';
import {MemoryStore} from '../../src/release/memory.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {digest} from '../../src/release/util.ts';
import {WorkspaceService} from '../../src/workspace.ts';
import {performance} from 'node:perf_hooks';

const origin='https://memory.example.test';
function api(db,clock=()=>at){const release=createRelease({DB:db,PUBLIC_ORIGIN:origin},{clock});return async(path,token,method='GET',data)=>release.route(new Request(origin+path,{method,headers:{...(data===undefined?{}:{'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}),token);}

test('lost share responses are recoverable by a later browser credential and all grants can be revoked',async()=>{
 const {db,token,other}=await fixture();try{
  const request=api(db),store=new MemoryStore(db,()=>at),transfers=new Transfers(db,()=>at),memory=await store.create(token,'s1',{body:'private'},'create');
  const lost=await request('/v1/spaces/s1/shares',token,'POST',{email:'bob@example.com'});assert.equal(lost.status,201); // Deliberately discard its body.
  const retry=await request('/v1/spaces/s1/shares',token,'POST',{email:'bob@example.com'});assert.equal(retry.status,201);const receipt=await retry.json();
  assert.equal((await request('/v1/spaces/s1/shares/'+receipt.id,token,'DELETE')).status,204);
  const incoming=await transfers.invitations(other);assert.equal(incoming.results.length,1);await transfers.accept(other,incoming.results[0].id);
  assert.equal((await store.get(other,'s1',memory.id)).body,'private','Revoking only the retry receipt leaves the original grant usable');
  assert.deepEqual((await transfers.invitations(token)).results,[]);
  const newToken='later-browser-credential-'+'d'.repeat(40);db.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission) VALUES('session:later','alice','session',?,?,?,'write')").run(await digest(newToken),at+900000,at);
  db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(at);
  const response=await request('/v1/spaces/s1/shares',newToken);assert.equal(response.status,200);
  const page=await response.json();assert.equal(page.results.length,2);assert.equal(page.nextCursor,null);
  assert.deepEqual(new Set(page.results.map(row=>row.id)),new Set([receipt.id,incoming.results[0].id]));
  for(const row of page.results){assert.equal(row.recipientEmail,'bob@example.com');assert.equal((await request('/v1/spaces/s1/shares/'+row.id,newToken,'DELETE')).status,204);}
  await assert.rejects(()=>store.get(other,'s1',memory.id),error=>error.status===403);
  await assert.rejects(()=>transfers.accept(other,incoming.results[0].id),error=>error.status===403);
 }finally{db.close();}
});

test('outbound pagination is newest first, bounded, and retains expired, accepted, and revoked facts',async()=>{
 const {db,token,other}=await fixture();let now=at;try{
  const transfers=new Transfers(db,()=>now),issued=[];
  for(let n=0;n<61;n++){now=at+Math.floor(n/3);issued.push(await transfers.share(token,'s1','bob@example.com',1));}
  await transfers.accept(other,issued[0].id);await transfers.revoke(token,'s1',issued[1].id);
  db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+3*86400000);
  now=at+86400001; // No current recent proof; expired shares remain discoverable.
  const expected=db.raw.prepare('SELECT id FROM release_shares ORDER BY created_at DESC,id DESC').all().map(r=>r.id);
  const request=api(db,()=>now),first=await(await request('/v1/spaces/s1/shares',token)).json();
  assert.equal(first.results.length,25);assert.ok(first.nextCursor);const seen=[...first.results];let cursor=first.nextCursor;
  while(cursor){const response=await request('/v1/spaces/s1/shares?limit=25&cursor='+encodeURIComponent(cursor),token);assert.equal(response.status,200);const page=await response.json();assert.ok(page.results.length<=25);seen.push(...page.results);cursor=page.nextCursor;}
  assert.deepEqual(seen.map(r=>r.id),expected);assert.equal(new Set(seen.map(r=>r.id)).size,61);
  assert.ok(seen.find(r=>r.id===issued[0].id).acceptedAt);assert.ok(seen.find(r=>r.id===issued[1].id).revokedAt);assert.ok(seen.some(r=>r.expiresAt<now));
  for(const row of seen)assert.deepEqual(Object.keys(row).sort(),['id','spaceId','recipientEmail','createdAt','expiresAt','acceptedAt','revokedAt'].sort());
  for(const limit of ['0','101','-1','1.2','bad'])assert.equal((await request('/v1/spaces/s1/shares?limit='+limit,token)).status,400);
  assert.equal((await transfers.outbound(token,'s1',{limit:100})).results.length,61);
 }finally{db.close();}
});

test('outbound cursor is bound to the exact account and Space, while a new credential for that account can continue',async()=>{
 const {db,token,other}=await fixture();try{
  db.raw.exec("UPDATE memberships SET role='admin' WHERE id='m2'");const transfers=new Transfers(db,()=>at);
  for(let n=0;n<3;n++)await transfers.share(token,'so','bob@example.com');
  const first=await transfers.outbound(token,'so',{limit:1});assert.ok(first.nextCursor);
  await assert.rejects(()=>transfers.outbound(other,'so',{cursor:first.nextCursor}),e=>e.status===400&&e.code==='invalid_cursor');
  await assert.rejects(()=>transfers.outbound(token,'s1',{cursor:first.nextCursor}),e=>e.status===400&&e.code==='invalid_cursor');
  const secondToken='d'.repeat(64);db.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,permission) VALUES('new-session','alice','session',?,?,'write')").run(await digest(secondToken),at+900000);
  const second=await transfers.outbound(secondToken,'so',{limit:1,cursor:first.nextCursor});assert.notEqual(second.results[0].id,first.results[0].id);
  await assert.rejects(()=>transfers.outbound(token,'so',{cursor:'not-a-cursor'}),e=>e.status===400);
 }finally{db.close();}
});

test('current Space managers recover grants issued by another manager whose membership and credential were revoked',async()=>{
 const {db,token,other}=await fixture();try{
  const transfers=new Transfers(db,()=>at),share=await transfers.share(token,'so','alice@example.com');
  db.raw.exec("UPDATE memberships SET role='admin' WHERE id='m2';UPDATE memberships SET revoked_at=1 WHERE id='m1';UPDATE credentials SET revoked_at=1 WHERE id='session:alice'");
  const page=await transfers.outbound(other,'so');assert.equal(page.results.length,1);assert.equal(page.results[0].id,share.id);assert.equal(page.results[0].revokedAt,1);
  assert.equal(page.results[0].recipientEmail,'alice@example.com');await transfers.revoke(other,'so',share.id);
 }finally{db.close();}
});

test('outbound management does not inherit ancestor membership or accepted read shares',async()=>{
 const {db,token,other}=await fixture();try{
  const child=await new WorkspaceService(db,()=>at).createOrganization(token,{name:'Independent child',emailId:'e1',parentOrganizationId:'org'});
  db.raw.exec("UPDATE memberships SET role='admin' WHERE id='m2'");const transfers=new Transfers(db,()=>at);
  const share=await transfers.share(token,child.spaceId,'bob@example.com');await transfers.accept(other,share.id);
  assert.deepEqual((await transfers.outbound(other,'so')).results,[]);
  await assert.rejects(()=>transfers.outbound(other,child.spaceId),e=>e.status===403);
  db.raw.exec("UPDATE memberships SET revoked_at=1 WHERE id='m1'");
  assert.equal((await transfers.outbound(token,child.spaceId)).results[0].id,share.id,'Independent child membership survives loss of the parent grant');
 }finally{db.close();}
});

for(const kind of ['personal_key','oauth','read-session'])test('outbound list refuses '+kind+' even with an update policy',async()=>{
 const {db,token}=await fixture();try{
  const transfers=new Transfers(db,()=>at);await transfers.share(token,'s1','bob@example.com');const value=kind[0].repeat(64),credential=kind==='oauth'?'oauth:test':kind;
  db.raw.prepare('INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,permission) VALUES(?,?,?,?,?,?)').run(credential,'alice',kind==='personal_key'?'personal_key':'session',await digest(value),at+900000,kind==='read-session'?'read':'write');
  db.raw.prepare('INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) VALUES(?,?,?)').run(credential,'["update"]','["s1"]');
  await assert.rejects(()=>transfers.outbound(value,'s1'),e=>e.status===403);
 }finally{db.close();}
});

for(const boundary of ['credential-expiry','member-expiry','credential-revocation','member-revocation','organization-disabled'])test('outbound final snapshot enforces '+boundary,async()=>{
 const {db,token}=await fixture();let now=at,touched=false;try{
  const transfers=new Transfers(db,()=>now);await transfers.share(token,'so','bob@example.com');
  if(boundary==='credential-expiry')db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+1);
  if(boundary==='member-expiry')db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+1);
  const prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql);if(sql.includes('/* outbound-share-page */')){const first=s.first.bind(s);s.first=async()=>{
   touched=true;
   if(boundary==='credential-revocation')db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'");
   if(boundary==='member-revocation')db.raw.exec("UPDATE memberships SET revoked_at=1 WHERE id='m1'");
   if(boundary==='organization-disabled')db.raw.exec("UPDATE organizations SET disabled_at=1 WHERE id='org'");
   const result=await first();if(boundary.endsWith('expiry'))now=at+2;return result;
  };}return s;};
  await assert.rejects(()=>transfers.outbound(token,'so'),e=>e.status===403);assert.equal(touched,true);
 }finally{db.close();}
});

test('empty outbound pages still require current update authority',async()=>{
 const {db,token,other}=await fixture();try{
  const transfers=new Transfers(db,()=>at);assert.deepEqual(await transfers.outbound(token,'s1'),{results:[],nextCursor:null});
  await assert.rejects(()=>transfers.outbound(other,'s1'),e=>e.status===403);await assert.rejects(()=>transfers.outbound(other,'so'),e=>e.status===403);
 }finally{db.close();}
});

test('outbound pages seek their tenant index under100000 unrelated retained shares',async t=>{
 const {db,token}=await fixture();try{
  const transfers=new Transfers(db,()=>at);for(let n=0;n<28;n++)await transfers.share(token,'s1','bob@example.com');
  let captured;const prepare=db.prepare.bind(db);db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...values)=>{if(sql.includes('/* outbound-share-page */'))captured={sql,values};return bind(...values);};return statement;};
  const first=await transfers.outbound(token,'s1',{limit:25});assert.equal(first.results.length,25);assert.ok(first.nextCursor);
  await transfers.outbound(token,'s1',{limit:25,cursor:first.nextCursor});
  const plan=db.raw.prepare('EXPLAIN QUERY PLAN '+captured.sql).all(...captured.values).map(r=>r.detail).join('\n');
  assert.match(plan,/SEARCH sh USING INDEX release_shares_space_created \(space_id=\? AND created_at<\?\)/);assert.doesNotMatch(plan,/SCAN sh\b/);
  function measure(){const statement=db.raw.prepare(captured.sql),start=performance.now();for(let n=0;n<100;n++)statement.get(...captured.values);return(performance.now()-start)/100;}
  const before=measure();
  db.raw.prepare(`WITH RECURSIVE n(x) AS(VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99999)
   INSERT INTO release_shares(id,space_id,recipient_email_id,creator_credential_id,created_at,expires_at)
   SELECT 'foreign-'||x,'s2','e1','session:bob',?,? FROM n`).run(at,at+86400000);
  const after=measure();t.diagnostic(JSON.stringify({syntheticForeignShares:100000,beforeMeanMs:before,afterMeanMs:after}));
  const second=await transfers.outbound(token,'s1',{limit:25,cursor:first.nextCursor});assert.equal(second.results.length,3);assert.ok(second.results.every(r=>r.spaceId==='s1'));assert.equal(second.nextCursor,null);
  // Canonical rows are retained; migration18 adds an index without rewriting them.
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,100028);
 }finally{db.close();}
});

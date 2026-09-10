import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {WorkspaceService} from '../../src/workspace.ts';

for(const change of ['credential','membership','credential-expiry','membership-expiry','export-expiry'])test('final export snapshot rejects '+change+' loss during its last lookup',async()=>{
 const {db,token}=await fixture();let now=at;
 try{
  const space=change.startsWith('membership')?'so':'s1',store=new MemoryStore(db,()=>now),transfers=new Transfers(db,()=>now);
  db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+86400000);
  await store.create(token,space,{body:'Must not leak from the last export lookup'},'create');const session=await transfers.startExport(token,space);
  if(change==='credential-expiry')db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+1);
  if(change==='membership-expiry')db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+1);
  let fired=false;const prepare=db.prepare.bind(db);
  db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('release_export_sessions')&&!sql.startsWith('SELECT watermark')){
   const first=statement.first.bind(statement);statement.first=async()=>{
    fired=true;
    if(change==='credential')db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'");
    else if(change==='membership')db.raw.exec("UPDATE memberships SET revoked_at=1 WHERE id='m1'");
    else now=change==='export-expiry'?session.expiresAt+1:at+2;
    return first();
   };
  }return statement;};
  await assert.rejects(()=>transfers.exportPage(token,space,session.id),error=>error.status===(change==='export-expiry'?404:403));
  assert.equal(fired,true);
 }finally{db.close();}
});

test('single-memory FTS mutation resolves an indexed rowid among unrelated canonical memories',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'target original',source:'retained source'},'create');
  db.raw.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
   INSERT INTO memories(id,space_id,body,revision,created_at,updated_at,actor_credential_id)
   SELECT 'foreign:'||x,'s2','Unrelated foreign record '||x,1,?,?,'session:bob' FROM n`).run(at,at);
  const trigger=db.raw.prepare("SELECT sql FROM sqlite_master WHERE name='release_memory_index_update'").get().sql;
  const sql=trigger.match(/DELETE FROM release_fts[^;]+/)[0].replaceAll('NEW.id','?');
  const plan=db.raw.prepare('EXPLAIN QUERY PLAN '+sql).all(memory.id).map(row=>row.detail).join('\n');
  assert.match(plan,/release_fts VIRTUAL TABLE INDEX [^\n]*=/,'FTS mutation must constrain the virtual table rowid: '+plan);
  await store.update(token,'s1',memory.id,{body:'target replacement',expectedRevision:1},'update');
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_fts WHERE release_fts MATCH 'original'").get().n,0);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM release_fts WHERE release_fts MATCH 'replacement'").get().n,1);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_fts').get().n,2001);
  assert.equal(db.raw.prepare('SELECT source FROM memory_versions WHERE memory_id=?').get(memory.id).source,'retained source');
 }finally{db.close();}
});

test('personal memory reads do not materialize unrelated active memberships',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:'personal record'},'create');
  db.raw.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
   INSERT INTO organizations(id) SELECT 'unrelated:'||x FROM n;
   INSERT INTO memberships(id,organization_id,account_id,email_id,role)
   SELECT 'membership:'||id,id,'bob','e2','member' FROM organizations WHERE id LIKE 'unrelated:%';`);
  const prepare=db.prepare.bind(db),plans=[];
  db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);let values=[];
   statement.bind=(...args)=>{values=args;bind(...args);return statement;};
   if(sql.includes('active_credentials')){const first=statement.first.bind(statement);statement.first=async()=>{plans.push(db.raw.prepare('EXPLAIN QUERY PLAN '+sql).all(...values).map(row=>row.detail).join('\n'));return first();};}
   return statement;
  };
  assert.equal((await store.get(token,'s1',memory.id)).body,'personal record');assert.ok(plans.length>=2);
  for(const plan of plans)assert.doesNotMatch(plan,/MATERIALIZE active_memberships|SCAN m(?:\s|$)/,'Membership lookup must use the credential binding: '+plan);
 }finally{db.close();}
});

test('share creation resolves only the grantor membership without materializing other tenants',async()=>{
 const {db,token}=await fixture();try{
  db.raw.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
   INSERT INTO organizations(id) SELECT 'unrelated:'||x FROM n;
   INSERT INTO memberships(id,organization_id,account_id,email_id,role)
   SELECT 'membership:'||id,id,'bob','e2','member' FROM organizations WHERE id LIKE 'unrelated:%';`);
  const prepare=db.prepare.bind(db),plans=[];
  db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);let values=[];
   statement.bind=(...args)=>{values=args;bind(...args);return statement;};
   if(sql.includes('INSERT INTO release_shares')){const first=statement.first.bind(statement);statement.first=async()=>{plans.push(db.raw.prepare('EXPLAIN QUERY PLAN '+sql).all(...values).map(row=>row.detail).join('\n'));return first();};}
   return statement;
  };
  const transfers=new Transfers(db,()=>at),personal=await transfers.share(token,'s1','bob@example.com'),organization=await transfers.share(token,'so','bob@example.com');
  assert.equal(db.raw.prepare('SELECT creator_membership_id FROM release_shares WHERE id=?').get(personal.id).creator_membership_id,null);
  assert.equal(db.raw.prepare('SELECT creator_membership_id FROM release_shares WHERE id=?').get(organization.id).creator_membership_id,'m1');
  assert.equal(plans.length,2);for(const plan of plans)assert.doesNotMatch(plan,/MATERIALIZE active_memberships|SCAN m(?:\s|$)/,plan);
 }finally{db.close();}
});

test('foundation key trigger resolves the exact actor membership and retains its audit and metadata',async()=>{
 const {db,token,other}=await fixture();try{
  db.raw.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
   INSERT INTO accounts(id) SELECT 'unrelated:'||x FROM n;
  `).run();
  db.raw.prepare("INSERT INTO account_emails(id,account_id,address,domain,verified_at) SELECT id,id,'member'||substr(id,11)||'@example.com','example.com',? FROM accounts WHERE id LIKE 'unrelated:%'").run(at);
  db.raw.exec("INSERT INTO memberships(id,organization_id,account_id,email_id,role) SELECT id,'org',id,id,'member' FROM accounts WHERE id LIKE 'unrelated:%'");
  const service=new WorkspaceService(db,()=>at),trigger=db.raw.prepare("SELECT sql FROM sqlite_master WHERE name='workspace_key_apply'").get().sql;
  const insert=trigger.match(/INSERT INTO credentials[\s\S]*?;/)[0],plans=[];
  for(const organizationId of [undefined,'org']){
   const facts={id:'inspected-key',actor_credential_id:'session:alice',organization_id:organizationId??null,created_at:at,token_digest:'0'.repeat(64),expires_at:at+86400000,permission:'read'},values=[];
   const sql=insert.replace(/NEW\.(\w+)/g,(_,key)=>{values.push(facts[key]);return '?';});
   plans.push(db.raw.prepare('EXPLAIN QUERY PLAN '+sql).all(...values).map(row=>row.detail).join('\n'));
   const key=await service.issueKey(token,{label:'foundation key',organizationId,permission:'read',expiresInDays:1});
   const credential=db.raw.prepare('SELECT kind,membership_id,email_id FROM credentials WHERE id=?').get(key.id);
   assert.deepEqual({...credential},organizationId?{kind:'api_key',membership_id:'m1',email_id:'e1'}:{kind:'personal_key',membership_id:null,email_id:null});
   assert.equal(db.raw.prepare('SELECT label FROM workspace_key_metadata WHERE credential_id=?').get(key.id).label,'foundation key');
   assert.equal(db.raw.prepare("SELECT count(*) n FROM workspace_audit_events WHERE action='key_issued' AND credential_id=?").get(key.id).n,1);
  }
  for(const plan of plans)assert.doesNotMatch(plan,/MATERIALIZE active_memberships|SCAN m(?:\s|$)/,plan);
  db.raw.exec("UPDATE memberships SET role='admin' WHERE id='m1'");
  const adminKey=await service.issueKey(token,{label:'admin writer',organizationId:'org',permission:'write',expiresInDays:1});
  const memberKey=await service.issueKey(other,{label:'member reader',organizationId:'org',permission:'read',expiresInDays:1});
  assert.deepEqual({...db.raw.prepare('SELECT membership_id,email_id,permission FROM credentials WHERE id=?').get(adminKey.id)},{membership_id:'m1',email_id:'e1',permission:'write'});
  assert.deepEqual({...db.raw.prepare('SELECT membership_id,email_id,permission FROM credentials WHERE id=?').get(memberKey.id)},{membership_id:'m2',email_id:'e2',permission:'read'});
  await assert.rejects(()=>service.issueKey(other,{label:'member writer',organizationId:'org',permission:'write',expiresInDays:1}),error=>error.status===403);
  db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m1'").run(at);
  await assert.rejects(()=>service.issueKey(token,{label:'revoked',organizationId:'org',permission:'read',expiresInDays:1}),error=>error.status===403);
  assert.equal(db.raw.prepare('SELECT revoked_at FROM credentials WHERE id=?').get(adminKey.id).revoked_at,at);
  assert.equal(db.raw.prepare('SELECT label FROM workspace_key_metadata WHERE credential_id=?').get(adminKey.id).label,'admin writer');
  assert.equal(db.raw.prepare("SELECT count(*) n FROM workspace_audit_events WHERE action='key_issued' AND credential_id=?").get(adminKey.id).n,1);
  db.raw.prepare("UPDATE organizations SET disabled_at=? WHERE id='org'").run(at);
  await assert.rejects(()=>service.issueKey(other,{label:'disabled organization',organizationId:'org',permission:'read',expiresInDays:1}),error=>error.status===403);
  db.raw.prepare("UPDATE accounts SET disabled_at=? WHERE id='bob'").run(at);
  await assert.rejects(()=>service.issueKey(other,{label:'disabled account',permission:'read',expiresInDays:1}),error=>error.status===403);
 }finally{db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DB,fixture,at} from './db.mjs';
import {MemoryStore} from '../../src/release/memory.ts';
import {digest} from '../../src/release/util.ts';
import {WorkspaceService} from '../../src/workspace.ts';

test('lookup migration backfills canonical FTS rows and preserves retained data and outbox history',async()=>{
 const db=new DB();db.migrate(11);const token='a'.repeat(64);
 try{
  db.raw.exec("INSERT INTO accounts(id) VALUES('alice');");
  db.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at) VALUES('session:alice','alice','session',?,?,?)").run(await digest(token),at+900000,at);
  db.raw.prepare("INSERT INTO spaces VALUES('s1','Personal','alice',NULL,'managed',?,'session:alice')").run(at);
  const store=new MemoryStore(db,()=>at),live=await store.create(token,'s1',{body:'original word',source:'retained source'},'live');
  await store.update(token,'s1',live.id,{body:'current word',expectedRevision:1},'update');
  const trash=await store.create(token,'s1',{body:'trashed word',source:'trash source'},'trash');await store.remove(token,'s1',trash.id,1,'trash-delete');
  const erased=await store.create(token,'s1',{body:'erased word',source:'erased source'},'erased');await store.remove(token,'s1',erased.id,1,'erased-delete');await store.erase(token,'s1',erased.id,2,erased.id,'erase');
  const retained=['memories','memory_versions','memory_audit_events','release_jobs','credentials','memberships','release_pools','release_usage_events','release_erasure_ledger'];
  const snapshots=new Map(retained.map(table=>[table,db.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
  const searchBefore=db.raw.prepare('SELECT memory_id,space_id,body FROM release_fts ORDER BY memory_id').all();
  db.raw.exec(readFileSync(new URL('../../lookup-schema.sql',import.meta.url),'utf8'));
  for(const table of retained)assert.deepEqual(db.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),snapshots.get(table),table);
  assert.equal(db.raw.prepare('SELECT version FROM release_meta').get().version,12);
  assert.deepEqual(db.raw.prepare('SELECT memory_id,space_id,body FROM release_fts ORDER BY memory_id').all(),searchBefore);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM release_fts_rows').get().n,3);
  const mapped=db.raw.prepare('SELECT id FROM release_fts_rows WHERE memory_id=?').get(live.id).id;
  const fts=()=>db.raw.prepare('SELECT rowid,body FROM release_fts WHERE rowid=?').get(mapped);
  assert.equal(fts().body,'current word');
  await store.update(token,'s1',live.id,{body:'updated word',expectedRevision:2},'update-again');assert.equal(fts().body,'updated word');
  await store.remove(token,'s1',live.id,3,'delete');assert.equal(fts(),undefined);
  await store.restore(token,'s1',live.id,4,'restore');assert.equal(fts().rowid,mapped);
  db.raw.exec('VACUUM');assert.equal(fts().body,'updated word');
  await store.remove(token,'s1',live.id,5,'delete-again');await store.erase(token,'s1',live.id,6,live.id,'erase-live');assert.equal(fts(),undefined);
  assert.equal(db.raw.prepare('SELECT id FROM release_fts_rows WHERE memory_id=?').get(live.id).id,mapped);
  assert.deepEqual(db.raw.prepare('SELECT kind FROM release_jobs WHERE memory_id=? ORDER BY revision').all(live.id).map(row=>row.kind),['upsert','upsert','upsert','delete','upsert','delete','delete']);
  const max=db.raw.prepare('SELECT max(id) n FROM release_fts_rows').get().n;
  const next=await store.create(token,'s1',{body:'next word'},'next');assert.ok(db.raw.prepare('SELECT id FROM release_fts_rows WHERE memory_id=?').get(next.id).id>max);
  for(const recursive of ['ON','OFF']){
   db.raw.exec('PRAGMA recursive_triggers='+recursive);
   assert.throws(()=>db.raw.prepare('DELETE FROM release_fts_rows WHERE id=?').run(mapped),/retained/);
   assert.throws(()=>db.raw.prepare('UPDATE release_fts_rows SET memory_id=memory_id WHERE id=?').run(mapped),/immutable/);
   assert.throws(()=>db.raw.prepare('INSERT OR REPLACE INTO release_fts_rows(id,memory_id) VALUES(?,?)').run(mapped,live.id),/already exists/);
   assert.throws(()=>db.raw.prepare('INSERT OR REPLACE INTO release_fts_rows(id,memory_id) VALUES(?,?)').run(max+100,live.id),/already exists/);
  }
 }finally{db.close();}
});

test('indexed credential view matches the original view across live and revoked authority states',async()=>{
 const {db}=await fixture();try{
  const original=readFileSync(new URL('../../schema.sql',import.meta.url),'utf8').match(/CREATE VIEW active_credentials AS[\s\S]*?;/)[0];
  db.raw.exec(original.replace('CREATE VIEW active_credentials','CREATE TEMP VIEW legacy_active_credentials'));
  const states=['live','credential-expiry','membership-expiry','credential-revoked','membership-revoked','email-revoked','account-disabled','organization-disabled'];
  for(const state of states){
   db.raw.prepare('INSERT INTO accounts(id) VALUES(?)').run(state);
   db.raw.prepare('INSERT INTO organizations(id) VALUES(?)').run(state);
   db.raw.prepare('INSERT INTO account_emails(id,account_id,address,domain,verified_at) VALUES(?,?,?,?,?)').run(state,state,state+'@example.com','example.com',at);
   db.raw.prepare("INSERT INTO memberships(id,organization_id,account_id,email_id,role,expires_at) VALUES(?,?,?,?,'admin',?)").run(state,state,state,state,at+900000);
   for(const kind of ['session','personal_key','api_key'])db.raw.prepare('INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at) VALUES(?,?,?,?,?,?,?)').run(kind+':'+state,state,kind==='api_key'?state:null,kind==='api_key'?state:null,kind,await digest(kind+state),at+900000);
  }
  const equivalent=()=>assert.deepEqual(db.raw.prepare('SELECT * FROM active_credentials ORDER BY id').all(),db.raw.prepare('SELECT * FROM legacy_active_credentials ORDER BY id').all());
  equivalent();
  db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='api_key:credential-expiry'").run(at);
  db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='membership-expiry'").run(at);
  db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='api_key:credential-revoked'").run(at);
  db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='membership-revoked'").run(at);
  db.raw.prepare("UPDATE account_emails SET revoked_at=? WHERE id='email-revoked'").run(at);
  db.raw.prepare("UPDATE accounts SET disabled_at=? WHERE id='account-disabled'").run(at);
  db.raw.prepare("UPDATE organizations SET disabled_at=? WHERE id='organization-disabled'").run(at);
  equivalent();
  assert.equal(db.raw.prepare("SELECT membership_expires_at FROM active_credentials WHERE id='api_key:membership-expiry'").get().membership_expires_at,at,'The view remains clock-independent');
  assert.equal(db.raw.prepare("SELECT membership_expires_at FROM active_credentials WHERE id='session:organization-disabled'").get().membership_expires_at,9007199254740991);
  for(const state of ['credential-revoked','membership-revoked','email-revoked','account-disabled','organization-disabled'])assert.equal(db.raw.prepare('SELECT id FROM active_credentials WHERE id=?').get('api_key:'+state),undefined);
  db.raw.prepare("INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES('rejoined','membership-revoked','membership-revoked','membership-revoked','member')").run();
  db.raw.prepare("INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at) VALUES('new-key','membership-revoked','rejoined','membership-revoked','api_key',?,?)").run(await digest('new-key'),at+900000);
  equivalent();assert.equal(db.raw.prepare("SELECT id FROM active_credentials WHERE id='api_key:membership-revoked'").get(),undefined);assert.equal(db.raw.prepare("SELECT id FROM active_credentials WHERE id='new-key'").get().id,'new-key');
  for(const credential of ['session:live','api_key:live','new-key']){
   const plan=db.raw.prepare('EXPLAIN QUERY PLAN SELECT * FROM active_credentials WHERE token_digest=?').all(await digest(credential==='new-key'?'new-key':credential.replace(':',''))).map(row=>row.detail).join('\n');
   assert.doesNotMatch(plan,/MATERIALIZE active_memberships|SCAN m(?:\s|$)/,plan);
   assert.match(plan,/SEARCH m .*id=\? AND account_id=\? AND email_id=\?/,plan);
  }
 }finally{db.close();}
});

test('key lookup migration preserves existing credential bindings, validation, metadata, and audit',async()=>{
 const db=new DB();db.migrate(12);const token='a'.repeat(64);try{
  db.raw.exec("INSERT INTO accounts(id) VALUES('alice'); INSERT INTO organizations(id) VALUES('org');");
  db.raw.prepare("INSERT INTO account_emails(id,account_id,address,domain,verified_at) VALUES('e1','alice','alice@example.com','example.com',?)").run(at);
  db.raw.exec("INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES('m1','org','alice','e1','owner')");
  db.raw.prepare("INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at) VALUES('session:alice','alice','session',?,?,?)").run(await digest(token),at+900000,at);
  const service=new WorkspaceService(db,()=>at);
  await service.issueKey(token,{label:'existing personal',permission:'read',expiresInDays:1});
  await service.issueKey(token,{label:'existing organization',organizationId:'org',permission:'write',expiresInDays:1});
  const tables=['accounts','account_emails','memberships','credentials','workspace_key_issuances','workspace_key_metadata','workspace_audit_events'];
  const before=new Map(tables.map(table=>[table,db.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
  const validation=db.raw.prepare("SELECT sql FROM sqlite_master WHERE name='workspace_key_validate'").get().sql;
  db.raw.exec(readFileSync(new URL('../../key-lookup-schema.sql',import.meta.url),'utf8'));
  assert.equal(db.raw.prepare('SELECT version FROM release_meta').get().version,13);
  assert.equal(db.raw.prepare("SELECT sql FROM sqlite_master WHERE name='workspace_key_validate'").get().sql,validation);
  for(const table of tables)assert.deepEqual(db.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),before.get(table),table);
  const after=await service.issueKey(token,{label:'new organization',organizationId:'org',permission:'read',expiresInDays:1});
  assert.deepEqual({...db.raw.prepare('SELECT membership_id,email_id,permission FROM credentials WHERE id=?').get(after.id)},{membership_id:'m1',email_id:'e1',permission:'read'});
  assert.equal(db.raw.prepare('SELECT label FROM workspace_key_metadata WHERE credential_id=?').get(after.id).label,'new organization');
  assert.equal(db.raw.prepare("SELECT count(*) n FROM workspace_audit_events WHERE action='key_issued' AND credential_id=?").get(after.id).n,1);
 }finally{db.close();}
});

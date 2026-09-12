import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {DB,fixture,at} from './db.mjs';

const source=new URL('../../seoul-projection-schema.sql',import.meta.url);
const migration=new URL('../../migrations/0026_seoul-projection-schema.sql',import.meta.url);
const kinds=['subject','email','organization','membership','credential','space','target'];
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function install(db){assert.ok(existsSync(source),'inactive Seoul projection schema must exist');db.raw.exec(readFileSync(source,'utf8'));}
async function setup(){const f=await fixture();install(f.db);return f.db;}
function transaction(db,operation){db.raw.exec('BEGIN IMMEDIATE');try{const value=operation();db.raw.exec('COMMIT');return value;}catch(error){db.raw.exec('ROLLBACK');throw error;}}
function event(db,{eventId,sourceRevision,kind='head',streamKind=null,streamKey=null,sourceHash=null,spaceId=null,snapshotSeq=null,issuedAt=null,expiresAt=null,bytes='{}',payloadHash=hash(bytes)}){
 return db.raw.prepare(`INSERT INTO release_seoul_projection_events(event_id,source_revision,event_kind,stream_kind,stream_key,source_sha256,space_id,snapshot_seq,issued_at,expires_at,payload_bytes,payload_sha256)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId,sourceRevision,kind,streamKind,streamKey,sourceHash,spaceId,snapshotSeq,issuedAt,expiresAt,bytes,payloadHash);
}
function change(db,kind='space',key='s1',revision=db.raw.prepare('SELECT coalesce(max(revision),0)+1 n FROM release_seoul_authority_changes').get().n){
 const eventId=uuid(revision),recordBytes=JSON.stringify({effect:{type:'entity-head',disposition:'present'}}),sourceHash=hash(JSON.stringify({revision,kind,key,recordBytes}));
 const bytes=JSON.stringify({version:3,kind:'seoul-authority-head',eventId,sourceRevision:revision,head:{kind,key,revision,eventId,payloadSha256:sourceHash},effect:{type:'entity-head',disposition:'present'}}),payloadHash=hash(bytes);
 transaction(db,()=>{
  db.raw.prepare('INSERT INTO release_seoul_authority_changes(revision,source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?,?)').run(revision,'command:'+revision,kind,key,eventId,recordBytes,at);
  db.raw.prepare(`INSERT INTO release_seoul_authority_heads(stream_kind,stream_key,revision,event_id,payload_sha256) VALUES(?,?,?,?,?)
   ON CONFLICT(stream_kind,stream_key) DO UPDATE SET revision=excluded.revision,event_id=excluded.event_id,payload_sha256=excluded.payload_sha256`).run(kind,key,revision,eventId,null);
 });
 transaction(db,()=>{
  db.raw.prepare('INSERT INTO release_seoul_prepared_sources VALUES(?,?,?,?)').run(revision,eventId,sourceHash,payloadHash);
  event(db,{eventId,sourceRevision:revision,streamKind:kind,streamKey:key,sourceHash,bytes});
  db.raw.prepare('UPDATE release_seoul_authority_heads SET payload_sha256=? WHERE stream_kind=? AND stream_key=? AND revision=? AND payload_sha256 IS NULL').run(sourceHash,kind,key,revision);
 });
 return {revision,eventId,bytes,payloadHash,sourceHash,recordBytes,kind,key};
}
function snapshot(db,spaceId,seq,revision,id=1000+seq,issuedAt=at){
 const eventId=uuid(id),bytes=JSON.stringify({version:3,kind:'seoul-authority-snapshot',eventId,sourceRevision:revision,spaceId,snapshotSeq:seq,lease:{issuedAtMs:issuedAt,expiresAtMs:issuedAt+60000}});
 event(db,{eventId,sourceRevision:revision,kind:'snapshot',spaceId,snapshotSeq:seq,issuedAt,expiresAt:issuedAt+60000,bytes});
 return {eventId,payloadHash:hash(bytes),bytes};
}
function publish(db,spaceId,seq,s){return db.raw.prepare(`INSERT INTO release_seoul_published_snapshots(space_id,snapshot_seq,event_id,payload_sha256) VALUES(?,?,?,?)
 ON CONFLICT(space_id) DO UPDATE SET snapshot_seq=excluded.snapshot_seq,event_id=excluded.event_id,payload_sha256=excluded.payload_sha256`).run(spaceId,seq,s.eventId,s.payloadHash);}
const rows=(db,table)=>db.raw.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();

test('projection migration preserves populated central authority, content and metering and starts unready',async()=>{
 const {db}=await fixture();try{
  db.raw.prepare("INSERT INTO memories(id,space_id,body,source,revision,created_at,updated_at,actor_credential_id) VALUES('retained','s1','retained content','retained source',1,?,?,'session:alice')").run(at,at);
  const tables=db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'release_fts%' AND name<>'release_meta' ORDER BY name").all().map(r=>r.name);
  const before=new Map(tables.map(table=>[table,rows(db,table)]));
  const schema=db.raw.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  install(db);
  assert.ok(existsSync(migration),'generated forward migration must exist');
  assert.equal(readFileSync(migration,'utf8'),'-- Forward SaaS migration 26: seoul-projection-schema.sql\n'+readFileSync(source,'utf8'));
  for(const table of tables)assert.deepEqual(rows(db,table),before.get(table),table);
  for(const old of schema)assert.equal(db.raw.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(old.name).sql,old.sql,old.name);
  assert.equal(db.raw.prepare('SELECT version FROM release_meta').get().version,26);
  assert.deepEqual({...db.raw.prepare('SELECT * FROM release_seoul_projection_state').get()},{id:1,state:'backfill-required'});
  for(const table of ['release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_targets','release_seoul_dirty_spaces','release_seoul_projection_events','release_seoul_projection_deliveries','release_seoul_published_snapshots'])assert.equal(rows(db,table).length,0,table);
  assert.throws(()=>db.raw.exec("UPDATE release_seoul_projection_state SET state='ready'"),/CHECK|unready/);
  assert.throws(()=>db.raw.exec('DELETE FROM release_seoul_projection_state'),/retained/);
  assert.equal(db.raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('global revision and exact seven-kind heads are durable, monotonic and replay-safe',async()=>{
 const db=await setup();try{
  for(const kind of kinds)change(db,kind,kind==='target'||kind==='space'?'s1':kind);
  assert.deepEqual(rows(db,'release_seoul_authority_changes').map(r=>r.revision),[1,2,3,4,5,6,7]);
  assert.deepEqual(rows(db,'release_seoul_authority_heads').map(r=>r.stream_kind),kinds);
  assert.throws(()=>change(db,'share','s1'),/CHECK/);
  const c=change(db,'space','s1');
  assert.notEqual(c.sourceHash,c.payloadHash,'source-record identity differs from exact transport-byte identity');
  assert.equal(event(db,{eventId:c.eventId,sourceRevision:c.revision,streamKind:c.kind,streamKey:c.key,sourceHash:c.sourceHash,bytes:c.bytes}).changes,0);
  assert.equal(db.raw.prepare('INSERT INTO release_seoul_authority_changes VALUES(?,?,?,?,?,?,?)').run(c.revision,'command:'+c.revision,c.kind,c.key,c.eventId,c.recordBytes,at).changes,0);
  const old=rows(db,'release_seoul_authority_changes').find(r=>r.stream_kind==='space'&&r.revision!==c.revision);
  assert.throws(()=>db.raw.prepare('UPDATE release_seoul_authority_heads SET revision=?,event_id=?,payload_sha256=NULL WHERE stream_kind=? AND stream_key=?').run(old.revision,old.event_id,'space','s1'),/monotonic/);
  assert.throws(()=>db.raw.prepare("UPDATE release_seoul_authority_heads SET payload_sha256=? WHERE stream_kind='space'").run('f'.repeat(64)),/conflict|FOREIGN KEY/);
  assert.throws(()=>db.raw.exec('DELETE FROM release_seoul_authority_changes'),/retained/);
  assert.throws(()=>db.raw.exec('DELETE FROM release_seoul_authority_heads'),/retained/);
  assert.throws(()=>db.raw.exec('UPDATE release_seoul_authority_changes SET created_at=created_at+1'),/immutable/);
  assert.throws(()=>change(db,'subject','lower',1),/conflict|monotonic/);
 }finally{db.close();}
});

test('immutable events reject changed hash, changed bytes, revision reuse and REPLACE with recursive triggers on or off',async()=>{
 const db=await setup();try{
  const c=change(db);
  for(const recursive of ['ON','OFF']){
   db.raw.exec('PRAGMA recursive_triggers='+recursive);
   assert.throws(()=>event(db,{eventId:c.eventId,sourceRevision:c.revision,streamKind:c.kind,streamKey:c.key,sourceHash:c.sourceHash,bytes:'changed',payloadHash:c.payloadHash}),/conflict/);
   assert.throws(()=>event(db,{eventId:c.eventId,sourceRevision:c.revision,streamKind:c.kind,streamKey:c.key,sourceHash:c.sourceHash,bytes:c.bytes,payloadHash:'f'.repeat(64)}),/conflict/);
   assert.throws(()=>db.raw.prepare('INSERT OR REPLACE INTO release_seoul_authority_changes VALUES(?,?,?,?,?,?,?)').run(c.revision,'command:'+c.revision,c.kind,c.key,uuid(999),'changed',at),/conflict/);
   assert.throws(()=>db.raw.prepare('INSERT OR REPLACE INTO release_seoul_projection_events SELECT event_id,source_revision,event_kind,stream_kind,stream_key,source_sha256,space_id,snapshot_seq,issued_at,expires_at,?,payload_sha256 FROM release_seoul_projection_events').run('changed'),/conflict/);
   assert.throws(()=>db.raw.exec("UPDATE release_seoul_projection_events SET payload_bytes='changed'"),/immutable/);
   assert.throws(()=>db.raw.exec('DELETE FROM release_seoul_projection_events'),/retained/);
  }
  assert.equal(rows(db,'release_seoul_projection_events')[0].payload_bytes,c.bytes);
 }finally{db.close();}
});

test('events enforce byte size, hash and identifier format, head linkage and exact 60-second snapshot lease',async()=>{
 const db=await setup();try{
  const c=change(db);
  const base={eventId:uuid(1001),sourceRevision:c.revision,kind:'snapshot',spaceId:'s1',snapshotSeq:1,issuedAt:at,expiresAt:at+60000};
  for(const patch of [{bytes:''},{bytes:'한'.repeat(43691)},{payloadHash:'F'.repeat(64)},{eventId:'not-an-event'},{snapshotSeq:0},{snapshotSeq:1.5},{issuedAt:-1},{expiresAt:at+60001},{expiresAt:at+59999},{sourceRevision:0}])assert.throws(()=>event(db,{...base,...patch}),/CHECK|FOREIGN KEY/);
  assert.throws(()=>event(db,{eventId:uuid(999),sourceRevision:c.revision,streamKind:'space',streamKey:'s1',sourceHash:'a'.repeat(64)}),/FOREIGN KEY/);
  event(db,{...base,bytes:'a'.repeat(131072)});
  assert.equal(rows(db,'release_seoul_projection_events').at(-1).payload_bytes.length,131072);
 }finally{db.close();}
});

test('each Space publishes consecutive sequences independently at an unchanged authority revision',async()=>{
 const db=await setup();try{
  const c=change(db);const a=snapshot(db,'s1',1,c.revision),b=snapshot(db,'s1',2,c.revision),d=snapshot(db,'s1',3,c.revision),other=snapshot(db,'s2',1,c.revision,2001);
  publish(db,'s1',1,a);publish(db,'s1',2,b);publish(db,'s2',1,other);publish(db,'s1',3,d);
  assert.equal(publish(db,'s1',3,d).changes,0);
  assert.deepEqual(rows(db,'release_seoul_published_snapshots').map(r=>[r.space_id,r.snapshot_seq]),[['s1',3],['s2',1]]);
  assert.throws(()=>publish(db,'s1',2,b),/monotonic/);
  const skip=snapshot(db,'s1',5,c.revision,1005);assert.throws(()=>publish(db,'s1',5,skip),/consecutive/);
  assert.throws(()=>publish(db,'s1',3,{...d,eventId:b.eventId}),/conflict/);
  assert.throws(()=>snapshot(db,'s1',3,c.revision,9999),/conflict|UNIQUE/);
  assert.throws(()=>db.raw.exec('DELETE FROM release_seoul_published_snapshots'),/retained/);
  assert.throws(()=>db.raw.prepare('INSERT OR REPLACE INTO release_seoul_published_snapshots VALUES(?,?,?,?)').run('s1',1,a.eventId,a.payloadHash),/monotonic|conflict/);
 }finally{db.close();}
});

test('target state references its exact target head and dirty revisions never lose pending work',async()=>{
 const db=await setup();try{
  const c=change(db,'target','s1');
  db.raw.prepare('INSERT INTO release_seoul_targets(space_id,selected,revision) VALUES(?,?,?)').run('s1',1,c.revision);
  db.raw.prepare('INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision) VALUES(?,?)').run('s1',c.revision);
  const d=change(db,'target','s1');
  db.raw.prepare('UPDATE release_seoul_targets SET selected=0,revision=? WHERE space_id=?').run(d.revision,'s1');
  db.raw.prepare('UPDATE release_seoul_dirty_spaces SET dirty_revision=? WHERE space_id=?').run(d.revision,'s1');
  db.raw.prepare('UPDATE release_seoul_dirty_spaces SET captured_revision=? WHERE space_id=?').run(c.revision,'s1');
  assert.deepEqual({...rows(db,'release_seoul_dirty_spaces')[0]},{space_id:'s1',dirty_revision:d.revision,captured_revision:c.revision});
  assert.throws(()=>db.raw.prepare("UPDATE release_seoul_targets SET selected=1,revision=? WHERE space_id='s1'").run(c.revision),/monotonic/);
  assert.throws(()=>db.raw.exec("UPDATE release_seoul_targets SET selected=1 WHERE space_id='s1'"),/conflict/);
  assert.throws(()=>db.raw.exec('UPDATE release_seoul_dirty_spaces SET dirty_revision=1,captured_revision=0'),/monotonic/);
  assert.throws(()=>db.raw.exec('UPDATE release_seoul_dirty_spaces SET captured_revision=99'),/CHECK/);
  assert.throws(()=>db.raw.exec('DELETE FROM release_seoul_targets'),/retained/);
  assert.throws(()=>db.raw.prepare('INSERT INTO release_seoul_targets(space_id,selected,revision) VALUES(?,?,?)').run('s2',1,d.revision),/target head/);
 }finally{db.close();}
});

test('Space claims require current dirty revisions, database time and a bounded lowercase fence',async()=>{
 const db=await setup();try{
  const c=change(db);db.raw.prepare('INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision) VALUES(?,?)').run('s1',c.revision);
  const insert=(token='a'.repeat(32),claimedAt=at,expiresAt=at+15000,revision=c.revision)=>db.raw.prepare('INSERT INTO release_seoul_projection_lock VALUES(?,?,?,?,?)').run('s1',token,revision,claimedAt,expiresAt);
  for(const args of [['A'.repeat(32)],['a'.repeat(31)],['a'.repeat(32),at,at+15001],['a'.repeat(32),at,at],['a'.repeat(32),at-1,at+14999],['a'.repeat(32),at,at+15000,99]])assert.throws(()=>insert(...args),/CHECK|claim/);
  insert();assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_lock SET fence_token=?').run('b'.repeat(32)),/held/);
  db.setClock(()=>at+15000);
  db.raw.prepare('UPDATE release_seoul_projection_lock SET fence_token=?,claimed_at=?,expires_at=?').run('b'.repeat(32),at+15000,at+30000);
  assert.equal(rows(db,'release_seoul_projection_lock')[0].fence_token,'b'.repeat(32));
 }finally{db.close();}
});

test('delivery attempts have bounded fences, monotonic counters and terminal immutable receipts',async()=>{
 const db=await setup();try{
  const c=change(db);db.raw.prepare('INSERT INTO release_seoul_projection_deliveries(event_id) VALUES(?)').run(c.eventId);
  assert.equal(rows(db,'release_seoul_projection_deliveries')[0].state,'pending');
  assert.throws(()=>db.raw.exec('UPDATE release_seoul_projection_deliveries SET attempts=101'),/CHECK/);
  assert.throws(()=>db.raw.exec("UPDATE release_seoul_projection_deliveries SET state='ready'"),/CHECK/);
  assert.throws(()=>db.raw.exec("UPDATE release_seoul_projection_deliveries SET state='dispatching'"),/CHECK/);
  const claim=()=>db.raw.prepare("UPDATE release_seoul_projection_deliveries SET state='dispatching',attempts=attempts+1,fence_token=?,claimed_at=?,fence_expires_at=?").run('a'.repeat(32),at,at+15000);
  claim();assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_deliveries SET fence_token=?').run('b'.repeat(32)),/held/);
  assert.throws(()=>db.raw.exec('UPDATE release_seoul_projection_deliveries SET attempts=0'),/monotonic/);
  db.raw.prepare("UPDATE release_seoul_projection_deliveries SET state='dependency_pending',fence_token=NULL,claimed_at=NULL,fence_expires_at=NULL,receipt_bytes=?,next_attempt_at=?").run('{"outcome":"dependency_pending"}',at+1000);
  assert.equal(rows(db,'release_seoul_projection_events')[0].payload_bytes,c.bytes);
  db.raw.prepare("UPDATE release_seoul_projection_deliveries SET state='applied',receipt_bytes=?").run('{"outcome":"applied"}');
  assert.throws(()=>db.raw.exec("UPDATE release_seoul_projection_deliveries SET state='pending'"),/terminal/);
  assert.throws(()=>db.raw.exec("UPDATE release_seoul_projection_deliveries SET receipt_bytes='changed'"),/terminal/);
  assert.throws(()=>db.raw.prepare('INSERT OR REPLACE INTO release_seoul_projection_deliveries(event_id) VALUES(?)').run(c.eventId),/exists/);
 }finally{db.close();}
});

test('failed authority and publish batches roll back authoritative rows, heads, envelopes, delivery, sequence and dirty capture',async()=>{
 const db=await setup();try{
  const c=change(db);db.raw.prepare('INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision) VALUES(?,?)').run('s1',c.revision);
  const tables=['accounts','release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_projection_events','release_seoul_projection_deliveries','release_seoul_published_snapshots','release_seoul_dirty_spaces'];
  const before=new Map(tables.map(table=>[table,rows(db,table)]));
  await assert.rejects(db.batch([
   db.prepare("UPDATE accounts SET disabled_at=? WHERE id='alice'").bind(at),
   db.prepare('INSERT INTO release_seoul_authority_changes VALUES(?,?,?,?,?,?,?)').bind(2,'command:2','subject','subject',uuid(2),'{}',at),
   db.prepare("INSERT INTO release_seoul_authority_heads VALUES('subject','subject',2,?,NULL)").bind(uuid(2)),
   db.prepare('UPDATE release_seoul_dirty_spaces SET dirty_revision=2').bind(),
   db.prepare("INSERT INTO release_seoul_projection_deliveries(event_id) VALUES('missing')").bind(),
  ]),/FOREIGN KEY/);
  for(const table of tables)assert.deepEqual(rows(db,table),before.get(table),table);
  assert.throws(()=>transaction(db,()=>{
   const s=snapshot(db,'s1',1,c.revision);db.raw.prepare('INSERT INTO release_seoul_projection_deliveries(event_id) VALUES(?)').run(s.eventId);publish(db,'s1',1,s);
   db.raw.exec('UPDATE release_seoul_dirty_spaces SET captured_revision=dirty_revision');
   db.raw.exec("INSERT INTO release_seoul_projection_deliveries(event_id) VALUES('missing')");
  }),/FOREIGN KEY/);
  for(const table of tables)assert.deepEqual(rows(db,table),before.get(table),table);
 }finally{db.close();}
});

test('pending heads block snapshots and finalization requires a matching immutable prepared source and transport event',async()=>{
 const db=await setup();try{
  db.raw.prepare('INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?)').run('command:pending','subject','unmapped',uuid(1),'{"state":"deleted"}',at);
  const current=rows(db,'release_seoul_authority_heads')[0];assert.equal(current.revision,1);assert.equal(current.payload_sha256,null);
  assert.throws(()=>snapshot(db,'s1',1,1),/pending/);
  assert.throws(()=>db.raw.prepare('UPDATE release_seoul_authority_heads SET payload_sha256=?').run('a'.repeat(64)),/FOREIGN KEY/);
  assert.throws(()=>db.raw.prepare('INSERT INTO release_seoul_prepared_sources VALUES(?,?,?,?)').run(1,uuid(1),'a'.repeat(64),'b'.repeat(64)),/FOREIGN KEY/);
  const newer=change(db,'subject','unmapped');
  assert.throws(()=>transaction(db,()=>{
   const invalid='{}';db.raw.prepare('INSERT INTO release_seoul_prepared_sources VALUES(?,?,?,?)').run(1,uuid(1),'a'.repeat(64),hash(invalid));
   event(db,{eventId:uuid(1),sourceRevision:1,kind:'snapshot',spaceId:'s1',snapshotSeq:1,issuedAt:at,expiresAt:at+60000,bytes:invalid});
  }),/head event required/);
  const oldBytes='{"oldNegative":true}',oldSourceHash=hash('immutable old source with revision 1');
  transaction(db,()=>{
   db.raw.prepare('INSERT INTO release_seoul_prepared_sources VALUES(?,?,?,?)').run(1,uuid(1),oldSourceHash,hash(oldBytes));
   event(db,{eventId:uuid(1),sourceRevision:1,streamKind:'subject',streamKey:'unmapped',sourceHash:oldSourceHash,bytes:oldBytes});
   assert.equal(db.raw.prepare('UPDATE release_seoul_authority_heads SET payload_sha256=? WHERE revision=1 AND payload_sha256 IS NULL').run(oldSourceHash).changes,0);
  });
  assert.equal(rows(db,'release_seoul_authority_heads')[0].revision,newer.revision);
  assert.equal(rows(db,'release_seoul_authority_heads')[0].payload_sha256,newer.sourceHash);
  assert.equal(rows(db,'release_seoul_prepared_sources').length,2,'older negative source remains deliverable');
  assert.throws(()=>db.raw.exec('UPDATE release_seoul_prepared_sources SET source_sha256=transport_sha256'),/immutable/);
  assert.throws(()=>db.raw.exec('DELETE FROM release_seoul_prepared_sources'),/retained/);
 }finally{db.close();}
});

test('a zero-row conditional preparation gates its dependent writes instead of assuming rollback',async()=>{
 const db=await setup();try{
  const c=change(db);
  const before=rows(db,'release_seoul_projection_deliveries');
  await db.batch([
   db.prepare('INSERT INTO release_seoul_prepared_sources SELECT revision,event_id,?,? FROM release_seoul_authority_heads WHERE revision=? AND payload_sha256 IS NULL').bind('a'.repeat(64),'b'.repeat(64),c.revision),
   db.prepare('INSERT INTO release_seoul_projection_deliveries(event_id) SELECT event_id FROM release_seoul_prepared_sources WHERE revision=? AND source_sha256=? AND transport_sha256=?').bind(c.revision,'a'.repeat(64),'b'.repeat(64)),
  ]);
  assert.deepEqual(rows(db,'release_seoul_projection_deliveries'),before);
 }finally{db.close();}
});

test('source insertion advances pending heads with both recursive-trigger settings and generated revisions survive exact replay',async()=>{
 const db=await setup();try{
  for(const recursive of ['ON','OFF']){
   db.raw.exec('PRAGMA recursive_triggers='+recursive);
   const before=rows(db,'release_seoul_authority_changes').length;
   const values=['command:'+recursive,'subject','unmapped',uuid(500+before),'{}',at];
   const insert=db.raw.prepare('INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?)');
   insert.run(...values);const revision=rows(db,'release_seoul_authority_changes').at(-1).revision;
   assert.equal(rows(db,'release_seoul_authority_heads')[0].revision,revision);assert.equal(rows(db,'release_seoul_authority_heads')[0].payload_sha256,null);
   assert.equal(insert.run(...values).changes,0);assert.equal(rows(db,'release_seoul_authority_changes').length,before+1);
   assert.throws(()=>insert.run(values[0],values[1],values[2],uuid(900+before),'changed',at),/conflict/);
  }
  assert.deepEqual(rows(db,'release_seoul_authority_changes').map(r=>r.revision),[1,2]);
  change(db,'space','s1',10);
  const before=rows(db,'release_seoul_authority_changes'),heads=rows(db,'release_seoul_authority_heads');
  assert.throws(()=>db.raw.prepare('INSERT INTO release_seoul_authority_changes VALUES(?,?,?,?,?,?,?)').run(7,'lower-command','email','lower-key',uuid(777),'{}',at),/monotonic/);
  assert.deepEqual(rows(db,'release_seoul_authority_changes'),before);assert.deepEqual(rows(db,'release_seoul_authority_heads'),heads);
  db.raw.prepare('INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?)').run('next-generated','target','s1',uuid(888),'{}',at);
  assert.equal(rows(db,'release_seoul_authority_changes').at(-1).revision,11);
 }finally{db.close();}
});

test('a source event identity cannot collide with an earlier snapshot in either trigger mode',async()=>{
 const db=await setup();try{
  const c=change(db),s=snapshot(db,'s1',1,c.revision,901);
  const tables=['release_seoul_authority_changes','release_seoul_authority_heads','release_seoul_prepared_sources','release_seoul_projection_events','sqlite_sequence'];
  const before=new Map(tables.map(table=>[table,rows(db,table)]));
  for(const recursive of ['ON','OFF']){
   db.raw.exec('PRAGMA recursive_triggers='+recursive);
   assert.throws(()=>db.raw.prepare('INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?)').run('colliding-command','space','s1',s.eventId,'{}',at),/source event identity conflict/);
   for(const table of tables)assert.deepEqual(rows(db,table),before.get(table),table);
  }
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('head preparation accepts either deferred insertion order while preserving exact revision, kind and transport replay',async()=>{
 const db=await setup();try{
  for(const eventFirst of [true,false]){
   const eventId=uuid(eventFirst?910:911),key=eventFirst?'event-first':'binding-first';
   const {lastInsertRowid}=db.raw.prepare('INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at) VALUES(?,?,?,?,?,?)').run(key,'subject',key,eventId,'{}',at);
   const revision=Number(lastInsertRowid),sourceHash=hash('source:'+revision),bytes=JSON.stringify({revision,sourceHash}),transportHash=hash(bytes);
   const insertEvent=()=>event(db,{eventId,sourceRevision:revision,streamKind:'subject',streamKey:key,sourceHash,bytes});
   const insertBinding=()=>db.raw.prepare('INSERT INTO release_seoul_prepared_sources VALUES(?,?,?,?)').run(revision,eventId,sourceHash,transportHash);
   transaction(db,()=>{
    if(eventFirst){insertEvent();insertBinding();}else{insertBinding();insertEvent();}
    db.raw.prepare('UPDATE release_seoul_authority_heads SET payload_sha256=? WHERE revision=? AND payload_sha256 IS NULL').run(sourceHash,revision);
   });
   assert.equal(insertEvent().changes,0);assert.equal(insertBinding().changes,0);
   assert.deepEqual({...db.raw.prepare('SELECT h.revision,e.source_revision,e.event_kind,p.transport_sha256 FROM release_seoul_authority_heads h JOIN release_seoul_projection_events e ON e.event_id=h.event_id JOIN release_seoul_prepared_sources p ON p.revision=h.revision WHERE h.revision=?').get(revision)},
    {revision,source_revision:revision,event_kind:'head',transport_sha256:transportHash});
  }
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('expired Space claims require a fresh token, current database time and current dirty revision',async()=>{
 const db=await setup();try{
  const c=change(db);db.raw.prepare('INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision) VALUES(?,?)').run('s1',c.revision);
  db.raw.prepare('INSERT INTO release_seoul_projection_lock VALUES(?,?,?,?,?)').run('s1','a'.repeat(32),c.revision,at,at+10000);
  db.setClock(()=>at+9999);
  db.raw.prepare('UPDATE release_seoul_projection_lock SET expires_at=?').run(at+15000);
  assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_lock SET claimed_at=?,expires_at=?').run(at+9999,at+24999),/held/);
  assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_lock SET expires_at=?').run(at+15001),/CHECK/);
  db.setClock(()=>at+15000);
  const before=rows(db,'release_seoul_projection_lock');
  for(const claimedAt of [at+15000,at+86400000]){
   assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_lock SET claimed_at=?,expires_at=?').run(claimedAt,claimedAt+15000),/fresh.*fence/);
   assert.deepEqual(rows(db,'release_seoul_projection_lock'),before);
  }
  assert.throws(()=>db.raw.prepare('INSERT OR REPLACE INTO release_seoul_projection_lock VALUES(?,?,?,?,?)').run('s1','a'.repeat(32),c.revision,at+15000,at+30000),/fresh.*fence/);
  assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_lock SET fence_token=?,claimed_at=?,expires_at=?').run('b'.repeat(32),at+15001,at+30001),/database state/);
  const newer=change(db,'space','s1');db.raw.prepare('UPDATE release_seoul_dirty_spaces SET dirty_revision=?').run(newer.revision);
  assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_lock SET fence_token=?,claimed_at=?,expires_at=?').run('b'.repeat(32),at+15000,at+30000),/database state/);
  db.raw.prepare('UPDATE release_seoul_projection_lock SET fence_token=?,claimed_revision=?,claimed_at=?,expires_at=?').run('b'.repeat(32),newer.revision,at+15000,at+30000);
  assert.deepEqual({...rows(db,'release_seoul_projection_lock')[0]},{space_id:'s1',fence_token:'b'.repeat(32),claimed_revision:newer.revision,claimed_at:at+15000,expires_at:at+30000});
 }finally{db.close();}
});

test('expired delivery claims require a fresh token, database time and exactly one additional dispatch attempt',async()=>{
 const db=await setup();try{
  const c=change(db);db.raw.prepare('INSERT INTO release_seoul_projection_deliveries(event_id) VALUES(?)').run(c.eventId);
  db.raw.prepare("UPDATE release_seoul_projection_deliveries SET state='dispatching',attempts=1,fence_token=?,claimed_at=?,fence_expires_at=?").run('a'.repeat(32),at,at+10000);
  db.setClock(()=>at+9999);db.raw.prepare('UPDATE release_seoul_projection_deliveries SET fence_expires_at=?').run(at+15000);
  assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_deliveries SET claimed_at=?,fence_expires_at=?').run(at+9999,at+24999),/held/);
  assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_deliveries SET fence_expires_at=?').run(at+15001),/CHECK/);
  db.setClock(()=>at+15000);const before=rows(db,'release_seoul_projection_deliveries');
  for(const claimedAt of [at+15000,at+86400000]){
   assert.throws(()=>db.raw.prepare('UPDATE release_seoul_projection_deliveries SET claimed_at=?,fence_expires_at=?').run(claimedAt,claimedAt+15000),/fresh.*fence/);
   assert.deepEqual(rows(db,'release_seoul_projection_deliveries'),before);
  }
  const reclaim=(claimedAt,attempts)=>db.raw.prepare('UPDATE release_seoul_projection_deliveries SET fence_token=?,claimed_at=?,fence_expires_at=?,attempts=?').run('b'.repeat(32),claimedAt,claimedAt+15000,attempts);
  assert.throws(()=>reclaim(at+15001,2),/database time/);
  assert.throws(()=>reclaim(at+15000,1),/dispatch attempt/);
  assert.throws(()=>reclaim(at+15000,3),/dispatch attempt/);
  reclaim(at+15000,2);
  const current=rows(db,'release_seoul_projection_deliveries')[0];assert.equal(current.fence_token,'b'.repeat(32));assert.equal(current.claimed_at,at+15000);assert.equal(current.fence_expires_at,at+30000);assert.equal(current.attempts,2);
  assert.throws(()=>db.raw.exec('UPDATE release_seoul_projection_deliveries SET attempts=3'),/dispatch attempt/);
 }finally{db.close();}
});

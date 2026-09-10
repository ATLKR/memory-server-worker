import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {createRelease} from '../../src/release/extension.ts';
import {MemoryStore} from '../../src/release/memory.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {Ingest} from '../../src/release/ingest.ts';
import {Jobs} from '../../src/release/jobs.ts';

const origin='https://memory.example.test',secret='SENSITIVE ERASED CONTENT';
function api(env,clock=()=>at){const release=createRelease({...env,PUBLIC_ORIGIN:origin},{clock});return (path,token,method='GET',data)=>release.route(new Request(origin+path,{method,headers:{...(data===undefined?{}:{'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}),token);}
function race(db,change,{ingest=false}={}){
 const prepare=db.prepare.bind(db);let hydrated=false,changed=false;
 db.prepare=sql=>{
  const s=prepare(sql),isData=sql.includes('r.body')&&sql.startsWith('SELECT r.id')||sql.includes('FROM versions v')||sql.includes('i.proposals');
  for(const name of ['first','all']){const read=s[name].bind(s);s[name]=async()=>{
   const marker=sql.includes('/* rest-memory-disclosure */')||sql.includes('AS exportExpiresAt')||sql.includes('/* ingest-disclosure */');
   const oldGuard=sql.includes('FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND');
   if(!changed&&(hydrated&&(marker||oldGuard)||ingest&&sql.includes('/* ingest-disclosure */'))){changed=true;await change();}
   const result=await read();if(isData&&JSON.stringify(result).includes(secret))hydrated=true;return result;
  };}return s;
 };return()=>changed;
}

for(const kind of ['get','list','search','export'])test('HTTP '+kind+' omits plaintext erased before its final disclosure snapshot',async()=>{
 const {db,token}=await fixture();try{
  const request=api({DB:db}),store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:secret},'seed');
  let path='/v1/spaces/s1/memories'+(kind==='get'?'/'+memory.id:kind==='search'?'?query=SENSITIVE':'');
  if(kind==='export'){const session=await new Transfers(db,()=>at).startExport(token,'s1');path='/v1/spaces/s1/exports/'+session.id;}
  const changed=race(db,async()=>{
   assert.equal((await request('/v1/spaces/s1/memories/'+memory.id,token,'DELETE',{expectedRevision:1,operationId:'delete'})).status,204);
   assert.equal((await request('/v1/spaces/s1/memories/'+memory.id+'/erase',token,'POST',{expectedRevision:2,confirmation:memory.id,operationId:'erase'})).status,200);
  });
  const response=await request(path,token),wire=await response.text();assert.equal(changed(),true);assert.equal(db.raw.prepare('SELECT body FROM memories WHERE id=?').get(memory.id).body,'[erased]');
  assert.ok(!wire.includes(secret),wire);assert.equal(response.status,kind==='get'?404:200);if(kind!=='get')assert.deepEqual(JSON.parse(wire).results,[]);
 }finally{db.close();}
});

test('HTTP ingest GET returns current cancellation state without the cleared review quotation',async()=>{
 const {db,token}=await fixture();try{
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){return{response:{memories:[{body:secret,kind:'fact',sourceMessageId:'m',quote:secret}]}};}}};
  const request=api(env),ingest=new Ingest(env,()=>at),jobs=new Jobs(env,()=>at);jobs.ingest=job=>ingest.process(job);
  const submission=await ingest.submit(token,'s1',{messages:[{id:'m',role:'user',content:secret}]},'submit');await jobs.drain(1);
  const path='/v1/spaces/s1/ingests/'+submission.id,changed=race(db,async()=>{assert.equal((await request(path,token,'DELETE')).status,204);},{ingest:true});
  const response=await request(path,token),wire=await response.text();assert.equal(changed(),true);assert.equal(response.status,200);assert.ok(!wire.includes(secret),wire);
  const result=JSON.parse(wire);assert.equal(result.state,'cancelled');assert.deepEqual(result.proposals,[]);
  assert.deepEqual({...db.raw.prepare('SELECT state,ciphertext,proposals FROM release_ingests WHERE id=?').get(submission.id)},{state:'cancelled',ciphertext:null,proposals:null});
 }finally{db.close();}
});

test('HTTP ingest collection reports cancellation committed before its final read',async()=>{
 const {db,token}=await fixture();try{
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{}},ingest=new Ingest(env,()=>at),request=api(env);
  const submission=await ingest.submit(token,'s1',{messages:[{id:'m',role:'user',content:secret}]},'submit');
  let hydrated=false,changed=false;const prepare=db.prepare.bind(db);
  db.prepare=sql=>{const s=prepare(sql);for(const method of ['first','all']){const read=s[method].bind(s);s[method]=async()=>{
   if(!changed&&(sql.includes('/* ingest-list-disclosure */')||hydrated&&sql.includes('FROM spaces s CROSS JOIN active_credentials c WHERE s.id=? AND'))){changed=true;assert.equal((await request('/v1/spaces/s1/ingests/'+submission.id,token,'DELETE')).status,204);}
   const result=await read();if(sql.startsWith('SELECT i.id,')&&sql.includes('ORDER BY i.created_at'))hydrated=true;return result;
  };}return s;};
  const response=await request('/v1/spaces/s1/ingests',token);assert.equal(changed,true);assert.equal(response.status,200);assert.equal((await response.json()).results[0].state,'cancelled');
 }finally{db.close();}
});

for(const kind of ['list','trash','export'])test(kind+' cursor advances past a whole page erased after hydration',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),request=api({DB:db}),records=[];
  for(let n=0;n<2;n++)records.push(await store.create(token,'s1',{body:secret+' '+n},'seed-'+n));
  records.sort((a,b)=>a.id.localeCompare(b.id));
  if(kind==='trash')for(const memory of records)await store.remove(token,'s1',memory.id,1,'trash-'+memory.id);
  let path='/v1/spaces/s1/memories?limit=1'+(kind==='trash'?'&deleted=true':'');
  if(kind==='export'){const session=await new Transfers(db,()=>at).startExport(token,'s1');path='/v1/spaces/s1/exports/'+session.id+'?limit=1';}
  const changed=race(db,async()=>{if(kind!=='trash')await store.remove(token,'s1',records[0].id,1,'remove');await store.erase(token,'s1',records[0].id,2,records[0].id,'erase');});
  const first=await(await request(path,token)).json();assert.equal(changed(),true);assert.deepEqual(first.results,[]);assert.ok(first.nextCursor);
  const second=await(await request(path+'&cursor='+encodeURIComponent(first.nextCursor),token)).json();assert.deepEqual(second.results.map(r=>r.id),[records[1].id]);assert.equal(second.nextCursor,null);
 }finally{db.close();}
});

test('includeDeleted direct reads allow trash but never content erased before disclosure',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),memory=await store.create(token,'s1',{body:secret},'seed');await store.remove(token,'s1',memory.id,1,'remove');
  assert.equal((await store.get(token,'s1',memory.id,true)).body,secret);
  const changed=race(db,()=>store.erase(token,'s1',memory.id,2,memory.id,'erase'));
  await assert.rejects(()=>store.get(token,'s1',memory.id,true),e=>e.status===404);assert.equal(changed(),true);
 }finally{db.close();}
});

for(const kind of ['get','list','search'])for(const transition of ['revision','delete','supersede'])test(kind+' validates final '+transition+' eligibility',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),request=api({DB:db}),memory=await store.create(token,'s1',{body:secret},'seed');
  const changed=race(db,async()=>{
   if(transition==='revision')await store.update(token,'s1',memory.id,{body:'Replacement',expectedRevision:1},'update');
   else if(transition==='delete')await store.remove(token,'s1',memory.id,1,'delete');
   else await store.create(token,'s1',{body:'Successor',supersedesMemoryId:memory.id},'supersede');
  });
  const response=await request('/v1/spaces/s1/memories'+(kind==='get'?'/'+memory.id:kind==='search'?'?query=SENSITIVE':''),token),wire=await response.text();assert.equal(changed(),true);
  if(kind==='get'&&transition==='supersede'){assert.equal(response.status,200);assert.equal(JSON.parse(wire).body,secret,'A direct superseded predecessor is still a valid record');}
  else {assert.equal(response.status,kind==='get'?404:200);assert.ok(!wire.includes(secret));if(kind!=='get')assert.deepEqual(JSON.parse(wire).results,[]);}
 }finally{db.close();}
});

test('exports retain their historical revision when a later canonical revision remains unerased',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),transfer=new Transfers(db,()=>at),memory=await store.create(token,'s1',{body:secret},'seed'),session=await transfer.startExport(token,'s1');
  await store.update(token,'s1',memory.id,{body:'later canonical body',expectedRevision:1},'update');
  const changed=race(db,()=>store.update(token,'s1',memory.id,{body:'even later canonical body',expectedRevision:2},'update-again'));
  const page=await transfer.exportPage(token,'s1',session.id);assert.equal(changed(),true);assert.equal(page.results[0].body,secret);assert.equal(page.results[0].revision,1);
 }finally{db.close();}
});

for(const action of ['create','update','restore'])test('HTTP '+action+' returns a write receipt if its full representation is erased before disclosure',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),request=api({DB:db});let memory;
  if(action!=='create'){memory=await store.create(token,'s1',{body:action==='restore'?secret:'before'},'seed');if(action==='restore')await store.remove(token,'s1',memory.id,1,'initial-remove');}
  const changed=race(db,async()=>{const row=db.raw.prepare('SELECT id,revision FROM memories WHERE erased_at IS NULL').get();await store.remove(token,'s1',row.id,row.revision,'remove');await store.erase(token,'s1',row.id,row.revision+1,row.id,'erase');});
  const response=action==='create'?await request('/v1/spaces/s1/memories',token,'POST',{body:secret,operationId:'create'}):action==='update'?await request('/v1/spaces/s1/memories/'+memory.id,token,'PATCH',{body:secret,expectedRevision:1,operationId:'update'}):await request('/v1/spaces/s1/memories/'+memory.id+'/restore',token,'POST',{expectedRevision:2,operationId:'restore'});
  const wire=await response.text();assert.equal(changed(),true);assert.equal(response.status,action==='create'?201:200);assert.ok(!wire.includes(secret));assert.equal(JSON.parse(wire).representation,'receipt');
 }finally{db.close();}
});

for(const change of ['approved','expired-before','expired-after'])test('ingest disclosure uses current '+change+' state and hides proposals',async()=>{
 const {db,token}=await fixture();let now=at;try{
  db.raw.prepare('UPDATE credentials SET expires_at=?').run(at+172800000);
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{async run(){return{response:{memories:[{body:secret,kind:'fact',sourceMessageId:'m',quote:secret}]}};}}};
  const ingest=new Ingest(env,()=>now),jobs=new Jobs(env,()=>now);jobs.ingest=j=>ingest.process(j);const submission=await ingest.submit(token,'s1',{messages:[{id:'m',role:'user',content:secret}]},'submit');await jobs.drain(1);
  let touched=false;const prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql);if(sql.includes('/* ingest-disclosure */')){const first=s.first.bind(s);s.first=async()=>{touched=true;if(change==='approved')await ingest.approve(token,'s1',submission.id,[0],'approve');if(change==='expired-before')now=at+86400000;const result=await first();if(change==='expired-after')now=at+86400000;return result;};}return s;};
  const result=await ingest.get(token,'s1',submission.id);assert.equal(touched,true);assert.equal(result.state,change==='approved'?'approved':'expired');assert.deepEqual(result.proposals,[]);
 }finally{db.close();}
});

for(const kind of ['get','list','search','export','ingest','ingest-list'])for(const expiry of ['credential','membership'])test(kind+' final disclosure compares '+expiry+' expiry after its awaited read',async()=>{
 const {db,token}=await fixture();let now=at;try{
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{}},store=new MemoryStore(db,()=>now),request=api(env,()=>now),memory=await store.create(token,'so',{body:secret},'seed');
  let path='/v1/spaces/so/memories'+(kind==='get'?'/'+memory.id:kind==='search'?'?query=SENSITIVE':'');
  if(kind==='export'){const session=await new Transfers(db,()=>now).startExport(token,'so');path='/v1/spaces/so/exports/'+session.id;}
  if(kind==='ingest'){const submission=await new Ingest(env,()=>now).submit(token,'so',{messages:[{id:'m',role:'user',content:secret}]},'submit');path='/v1/spaces/so/ingests/'+submission.id;}
  if(kind==='ingest-list')path='/v1/spaces/so/ingests';
  db.raw.prepare(expiry==='credential'?"UPDATE credentials SET expires_at=? WHERE id='session:alice'":"UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+1);
  let touched=false;const prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql);if(sql.includes('-disclosure */')){const first=s.first.bind(s);s.first=async()=>{const result=await first();touched=true;now=at+2;return result;};}return s;};
  const response=await request(path,token);assert.equal(touched,true);assert.equal(response.status,403);assert.ok(!(await response.text()).includes(secret));
 }finally{db.close();}
});

for(const kind of ['get','list','search','export','ingest','ingest-list'])test(kind+' final database failures are not converted to successful empty content',async()=>{
 const {db,token}=await fixture();try{
  const env={DB:db,BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,3).toString('base64url'),AI:{}},store=new MemoryStore(db,()=>at),request=api(env),memory=await store.create(token,'s1',{body:secret},'seed');
  let path='/v1/spaces/s1/memories'+(kind==='get'?'/'+memory.id:kind==='search'?'?query=SENSITIVE':'');
  if(kind==='export'){const session=await new Transfers(db,()=>at).startExport(token,'s1');path='/v1/spaces/s1/exports/'+session.id;}
  if(kind==='ingest'){const submission=await new Ingest(env,()=>at).submit(token,'s1',{messages:[{id:'m',role:'user',content:secret}]},'submit');path='/v1/spaces/s1/ingests/'+submission.id;}
  if(kind==='ingest-list')path='/v1/spaces/s1/ingests';
  let touched=false;const prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql);if(sql.includes('-disclosure */'))s.first=async()=>{touched=true;throw Error('database unavailable');};return s;};
  const response=await request(path,token);assert.equal(touched,true);assert.equal(response.status,500);assert.ok(!(await response.text()).includes(secret));
 }finally{db.close();}
});

for(const kind of ['list','export'])test(kind+' final disclosure resolves only its bounded page through memory IDs',async()=>{
 const {db,token}=await fixture();try{
  const store=new MemoryStore(db,()=>at),transfers=new Transfers(db,()=>at),limit=kind==='list'?100:50;
  db.raw.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2100)
   INSERT INTO memories(id,space_id,body,revision,created_at,updated_at,actor_credential_id)
   SELECT printf('record:%04d',x),CASE WHEN x<=100 THEN 's1' ELSE 's2' END,'bounded content',1,?,?,
    CASE WHEN x<=100 THEN 'session:alice' ELSE 'session:bob' END FROM n`).run(at,at);
  const session=kind==='export'?await transfers.startExport(token,'s1'):null,plans=[],prepare=db.prepare.bind(db);
  db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);let values=[];
   statement.bind=(...args)=>{values=args;bind(...args);return statement;};
   if(sql.includes('-disclosure */')){const first=statement.first.bind(statement);statement.first=async()=>{
    const targets=values.find(value=>typeof value==='string'&&value.startsWith('['));
    assert.equal(JSON.parse(targets).length,limit);
    plans.push(db.raw.prepare('EXPLAIN QUERY PLAN '+sql).all(...values).map(row=>row.detail).join('\n'));
    return first();
   };}return statement;
  };
  const result=kind==='list'?await store.list(token,'s1',{limit}):await transfers.exportPage(token,'s1',session.id,null,limit);
  assert.equal(result.results.length,limit);assert.ok(result.results.every(row=>row.spaceId==='s1'));assert.equal(plans.length,1);
  assert.match(plans[0],/SEARCH r USING INDEX \S+ \((?:space_id=\? AND )?id=\?\)/,plans[0]);
  assert.doesNotMatch(plans[0],/SCAN r(?:\s|$)/,plans[0]);
 }finally{db.close();}
});

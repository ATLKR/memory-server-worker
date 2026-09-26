import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createLifecycleFixture} from './seoul-lifecycle-fixture.mjs';
import {encodeSeoulHeadEvent} from '../../src/release/seoul-projection-head-codec.ts';

export const ISSUER='https://auth-api.allen.company';
export const uuid=n=>n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000';
export const hash=raw=>createHash('sha256').update(raw,'utf8').digest('hex');
export const wire=value=>new TextDecoder().decode(encodeSeoulHeadEvent(value));
export function event(revision,kind='subject',key=ISSUER+'\nalice',effect={type:'entity-head',disposition:'present'},transport=revision) {
  return {version:3,kind:'seoul-authority-head',eventId:uuid(transport),sourceRevision:revision,issuer:ISSUER,
    head:{kind,key,revision,eventId:uuid(revision+100000),payloadSha256:'c'.repeat(64)},effect};
}
export const tables=['identity_projection_fence','identity_projection_events','identity_projection_receipts',
  'identity_projection_source_heads','identity_projection_heads','identity_projection_lifecycle','identity_projection_tombstones'];
export async function createHeadFixture(t,{seed=false,install=true}={}) {
  const f=await createLifecycleFixture(t,{seed});
  const initial=(await f.db.query('SELECT session_user AS role')).rows[0].role;
  const restore='SET SESSION AUTHORIZATION "'+initial.replaceAll('"','""')+'"';
  const draft=await readFile(new URL('../../postgres/projection-v3/head-foundation.sql',import.meta.url),'utf8').catch(e=>{
    if(e.code==='ENOENT')return null;throw e;
  });
  const installDraft=async()=>{
    assert.notEqual(draft,null,'inactive projection head SQL foundation must exist');
    await f.db.exec('SET SESSION AUTHORIZATION fixture_provisioner');
    try {await f.db.exec(draft);} finally {await f.db.exec('ROLLBACK');await f.db.exec(restore);}
  };
  const asRole=async(role,fn,setCaller=false)=>{
    assert.match(role,/^[a-z_]+$/);
    await f.db.exec('SET SESSION AUTHORIZATION '+role);
    try {if(setCaller)await f.db.exec('SET ROLE memory_projection_caller');return await fn(f.db);}
    finally {await f.db.exec('ROLLBACK');await f.db.exec(restore);}
  };
  const apply=(raw,digest=hash(raw))=>asRole('projection_test_login',async db=>(await db.query(
    'SELECT memory_identity.seoul_projection_apply($1::text,$2::text) AS receipt',[raw,digest])).rows[0].receipt,true);
  const status=(id,digest)=>asRole('projection_test_login',async db=>(await db.query(
    'SELECT memory_ops.seoul_projection_status($1::text,$2::text) AS receipt',[id,digest])).rows[0].receipt,true);
  const state=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,(await f.db.query(
    `SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) AS rows FROM memory_ops.${name} x`)).rows[0].rows])));
  if(install) {
    await installDraft();
    await f.db.exec(`CREATE ROLE projection_test_login LOGIN NOINHERIT;
      GRANT memory_projection_caller TO projection_test_login WITH INHERIT FALSE,SET TRUE,ADMIN FALSE;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;`);
  }
  return {...f,installDraft,asRole,apply,status,state};
}

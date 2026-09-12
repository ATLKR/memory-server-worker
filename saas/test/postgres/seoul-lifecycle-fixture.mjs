import { readFile } from 'node:fs/promises';
import { createSeoulFixture } from './seoul-fixture.mjs';

export const ERASE_OPERATION='11111111-1111-4111-8111-111111111111';
export const RETIRE_OPERATION='22222222-2222-4222-8222-222222222222';
export const REVOKE_OPERATION='33333333-3333-4333-8333-333333333333';
export async function createLifecycleFixture(t,options={}) {
  const f=await createSeoulFixture(t,options);
  const install=async()=>{
    const sql=await readFile(new URL('../../postgres/migrations/0005_seoul_archive_lifecycle.sql',import.meta.url),'utf8').catch(error=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(sql===null)return false;
    const original=(await f.db.query('SELECT session_user AS role')).rows[0].role;
    const restore='SET SESSION AUTHORIZATION "'+original.replaceAll('"','""')+'"';
    await f.db.exec('SET SESSION AUTHORIZATION fixture_provisioner');
    try {
      await f.db.exec(sql);
      // The installed foundation already made its creator edges inactive.
      // The older bootstrap fixture leaves them active for migration setup;
      // close only those capabilities before exercising the v5 runtime.
      await f.db.exec('GRANT memory_owner,memory_runtime,memory_background TO CURRENT_USER WITH INHERIT FALSE, SET FALSE');
    }
    // PGlite RESET restores its latest authorization, not necessarily the
    // caller's original session. Restore the captured identity explicitly.
    finally { await f.db.exec('ROLLBACK; '+restore); }
    return true;
  };
  const entries={seoul_archive_erase:'memory_content',seoul_space_retire:'memory_control',
    seoul_pat_revoke_self:'memory_identity',seoul_lifecycle_status:'memory_ops'};
  const call=async(name,digest,input)=>entries[name]
    ?f.asRuntime(async()=>(await f.db.query(`SELECT ${entries[name]}.${name}($1,$2::jsonb) AS value`,[digest,input])).rows[0].value)
    :f.call(name,digest,input);
  const grant=async()=>f.asOwner(()=>f.db.exec('UPDATE memory_identity.pat_space_grants SET can_erase=true,can_retire=true'));
  if(options.install!==false)await install();
  return {...f,install,call,grant};
}

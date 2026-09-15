import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createDispatchFixture} from './seoul-projection-snapshot-dispatch-fixture.mjs';
export const denied=e=>e.code==='PA002'&&e.message==='seoul_pat_denied';
export const spaceDenied=e=>e.code==='PA003'&&e.message==='seoul_space_denied';
export const policyDenied=e=>e.code==='PA004'&&e.message==='seoul_processing_denied';
export const expired=e=>e.code==='PA007'&&e.message==='seoul_authority_expired';
export const unavailable=e=>e.code==='PP004'&&e.message==='seoul_projection_unavailable';
export const DISPATCHER='memory_projection_dispatcher';
// The projected admission surface: the only projection tables the lifecycle
// role may read after the authorizer draft installs.
export const servingTables=['memory_ops.identity_projection_space_state','memory_ops.identity_projection_snapshot_generations',
  'memory_ops.identity_projection_heads','memory_identity.identity_projection_grants','memory_identity.identity_projection_grant_heads'];
export async function createServingFixture(t,{install=true}={}){
  const f=await createDispatchFixture(t);
  // The authorizer draft replaces the lifecycle-owned definer function; the
  // installer must hold SET on memory_lifecycle in addition to the migration
  // and projection owners.
  await f.db.exec('GRANT memory_lifecycle TO fixture_provisioner WITH INHERIT FALSE,SET TRUE,ADMIN FALSE');
  const sql=await readFile(new URL('../../postgres/projection-v3/serving-authorizer.sql',import.meta.url),'utf8').catch(e=>{
    if(e.code==='ENOENT')return null;throw e;});
  const installAuthorizer=async()=>{
    assert.notEqual(sql,null,'inactive serving authorizer SQL must exist');
    return f.asRole('fixture_provisioner',db=>db.exec(sql));
  };
  const serve=async(p,options)=>{await f.ready(p,options);return f.dispatch(p);};
  const asDispatcher=fn=>f.asRole(DISPATCHER,fn,true);
  if(install)await installAuthorizer();
  return {...f,installAuthorizer,serve,asDispatcher};
}

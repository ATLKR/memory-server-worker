import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createMaterializationFixture,encode,hash,uuid} from './seoul-projection-snapshot-materialization-fixture.mjs';
export {encode,hash,uuid};
export const invalid=e=>e.code==='PP001'&&e.message==='seoul_projection_input_invalid';
export const conflict=e=>e.code==='PP002'&&e.message==='seoul_projection_event_conflict';
export const absent=e=>e.code==='PP003'&&e.message==='seoul_projection_receipt_absent';
export async function createDispatchFixture(t,{install=true}={}){
  const f=await createMaterializationFixture(t);
  const sql=await readFile(new URL('../../postgres/projection-v3/snapshot-dispatch.sql',import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  const installDispatch=async()=>{
    assert.notEqual(sql,null,'inactive snapshot dispatch SQL must exist');
    return f.asRole('fixture_provisioner',db=>db.exec(sql));
  };
  // Caller-facing dispatch: the exact bytes go through the projection login and
  // caller role, never the owner path the materializer tests use.
  const dispatch=async p=>{const raw=typeof p==='string'?p:encode(p);return f.apply(raw);};
  if(install)await installDispatch();
  return {...f,installDispatch,dispatch};
}

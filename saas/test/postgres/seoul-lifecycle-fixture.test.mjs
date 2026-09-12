import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleFixture } from './seoul-lifecycle-fixture.mjs';

const identity=async db=>(await db.query('SELECT session_user AS session, current_user AS current')).rows[0];

test('lifecycle fixture restores its original session after migration and keeps creator capabilities inactive',async t=>{
  const f=await createLifecycleFixture(t,{install:false});
  const original=await identity(f.db);
  assert.notEqual(original.session,'fixture_provisioner');
  assert.equal(await f.install(),true);
  assert.deepEqual(await identity(f.db),original);
  assert.deepEqual((await f.db.query(`SELECT DISTINCT r.rolname, m.set_option, m.inherit_option
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
    JOIN pg_catalog.pg_roles member_role ON member_role.oid=m.member
    WHERE member_role.rolname='fixture_provisioner'
      AND r.rolname IN('memory_owner','memory_runtime','memory_background') ORDER BY r.rolname`)).rows,
    ['memory_background','memory_owner','memory_runtime'].map(rolname=>({rolname,set_option:false,inherit_option:false})));
  assert.equal((await f.asOwner(()=>f.db.query('SELECT count(*)::int AS count FROM memory_identity.credentials'))).rows[0].count,3);
  assert.deepEqual(await identity(f.db),original);
});

test('lifecycle fixture rolls back a rejected migration and restores its original session',async t=>{
  const f=await createLifecycleFixture(t,{install:false});
  const original=await identity(f.db);
  // A real CREATE ROLE collision rejects the migration after BEGIN.
  await f.db.exec('CREATE ROLE memory_lifecycle NOLOGIN');
  await assert.rejects(f.install(),{code:'42710'});
  assert.deepEqual(await identity(f.db),original);
  assert.equal((await f.db.query('SELECT max(version) AS version FROM memory_control.schema_migrations')).rows[0].version,4);
  assert.equal((await f.asOwner(()=>f.db.query('SELECT count(*)::int AS count FROM memory_identity.credentials'))).rows[0].count,3);
});

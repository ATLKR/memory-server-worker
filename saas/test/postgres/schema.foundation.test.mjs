import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const directory = new URL('../../postgres/migrations/', import.meta.url);
const privateSchemas = ['memory_content', 'memory_control', 'memory_identity', 'memory_jobs', 'memory_ops', 'memory_search'];
const authorityTables = ['accounts', 'account_emails', 'memberships', 'credentials', 'provider_identities'];
async function migrations() {
  const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return Promise.all(files.filter(name => /^\d+_.+\.sql$/.test(name)).sort().map(name => readFile(new URL(name, directory), 'utf8')));
}
async function fixture(t) {
  const db = new PGlite(); await db.waitReady; t.after(() => db.close());
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE TABLE public.supabase_sentinel(id integer PRIMARY KEY);
    INSERT INTO public.supabase_sentinel VALUES(7);
    GRANT SELECT ON public.supabase_sentinel TO anon, authenticated;`);
  for (const sql of await migrations()) await db.exec(sql);
  const schemas = (await db.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'memory\\_%' ESCAPE '\\' ORDER BY nspname")).rows.map(row => row.nspname);
  assert.deepEqual(schemas, privateSchemas, 'native private namespaces have not been installed');
  return db;
}
async function asRole(db, role, callback) {
  assert.match(role, /^(memory_owner|memory_runtime|memory_background|anon|authenticated)$/);
  await db.exec(`SET ROLE ${role}`);
  try { return await callback(); } finally { await db.exec('RESET ROLE'); }
}
const state = code => error => error?.code === code;
async function identityFixture(db) {
  await asRole(db, 'memory_owner', () => db.exec(`
    INSERT INTO memory_identity.accounts(id) VALUES('account:a'),('account:b');
    INSERT INTO memory_control.organizations(id) VALUES('org:one');
    INSERT INTO memory_identity.account_emails(id,account_id,address,domain,verified_at)
      VALUES('email:a','account:a','a@example.org','example.org',1),('email:b','account:b','b@example.org','example.org',1);
    INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role,expires_at)
      VALUES('member:a','org:one','account:a','email:a','owner',9007199254740991);
    INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at)
      VALUES('pat:a','account:a','personal_key',repeat('a',64),9007199254740991);
  `));
}

test('native schema capability roles have no login, escalation or owner membership', async t => {
  const db = await fixture(t);
  const roles = (await db.query(`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname IN ('memory_owner','memory_runtime','memory_background') ORDER BY rolname`)).rows;
  assert.equal(roles.length, 3);
  for (const role of roles) for (const key of ['rolcanlogin', 'rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']) assert.equal(role[key], false, `${role.rolname}.${key}`);
  assert.deepEqual((await db.query(`SELECT pg_has_role('memory_runtime','memory_owner','MEMBER') AS runtime_owner,
    pg_has_role('memory_background','memory_owner','MEMBER') AS background_owner`)).rows, [{runtime_owner:false,background_owner:false}]);
  await asRole(db, 'memory_runtime', () => assert.rejects(db.exec('CREATE TABLE memory_control.runtime_ddl(id integer)'), state('42501')));
  await asRole(db, 'memory_background', () => assert.rejects(db.exec('CREATE TABLE memory_jobs.background_ddl(id integer)'), state('42501')));
});

test('metadata begins unconfigured and owner initialization cannot be overwritten or removed', async t => {
  const db = await fixture(t);
  await asRole(db, 'memory_runtime', async () => {
    assert.deepEqual((await db.query('SELECT * FROM memory_control.deployment_identity')).rows, []);
    await assert.rejects(db.exec("INSERT INTO memory_control.deployment_identity(singleton,deployment_id,storage_region,processing_policy_id,created_at_ms) VALUES(1,'memory-sg','sg','standard-v1',1)"), state('42501'));
  });
  await asRole(db, 'memory_owner', async () => {
    await db.exec("INSERT INTO memory_control.deployment_identity VALUES(1,'memory-sg','sg','standard-v1',1)");
    await assert.rejects(db.exec("INSERT INTO memory_control.deployment_identity VALUES(1,'memory-seoul','kr-seoul','standard-v1',2)"), state('23505'));
    await assert.rejects(db.exec("UPDATE memory_control.deployment_identity SET storage_region='kr-seoul'"), state('55000'));
    await assert.rejects(db.exec('DELETE FROM memory_control.deployment_identity'), state('55000'));
    await assert.rejects(db.exec('TRUNCATE memory_control.deployment_identity'), state('55000'));
  });
  await asRole(db, 'memory_background', async () => {
    assert.deepEqual((await db.query('SELECT storage_region,processing_policy_id FROM memory_control.deployment_identity')).rows,[{storage_region:'sg',processing_policy_id:'standard-v1'}]);
    assert.equal((await db.query('SELECT max(version) AS version FROM memory_control.schema_migrations')).rows[0].version,3);
  });
});

test('metadata rejects a second singleton, unknown region, blank policy and unsafe epoch', async t => {
  const db = await fixture(t);
  for (const values of ["(2,'memory-sg','sg','standard-v1',1)","(1,'memory-sg','us','standard-v1',1)","(1,'memory-sg','sg','',1)","(1,'memory-sg','sg','standard-v1',9007199254740992)"]) {
    await asRole(db, 'memory_owner', () => assert.rejects(db.exec(`INSERT INTO memory_control.deployment_identity VALUES${values}`), state('23514')));
  }
});

test('schema version records cannot be rewritten, deleted or truncated by migration owner', async t => {
  const db = await fixture(t);
  await asRole(db, 'memory_owner', async () => {
    await assert.rejects(db.exec("UPDATE memory_control.schema_migrations SET name='rewritten' WHERE version=1"),state('55000'));
    await assert.rejects(db.exec('DELETE FROM memory_control.schema_migrations WHERE version=1'),state('55000'));
    await assert.rejects(db.exec('TRUNCATE memory_control.schema_migrations'),state('55000'));
  });
});

test('service schemas stay private without altering existing Supabase role permissions', async t => {
  const db = await fixture(t);
  for (const role of ['anon','authenticated']) {
    await asRole(db,role,async()=>{
      assert.deepEqual((await db.query('SELECT * FROM public.supabase_sentinel')).rows,[{id:7}]);
      for (const schema of privateSchemas) assert.equal((await db.query('SELECT has_schema_privilege(current_user,$1,\'USAGE\') AS allowed',[schema])).rows[0].allowed,false);
      await assert.rejects(db.query('SELECT * FROM memory_control.deployment_identity'),state('42501'));
    });
  }
  const visible = (await db.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
    LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE n.nspname=ANY($1::text[]) AND c.relkind='r' AND a.grantee=0`,[privateSchemas])).rows;
  assert.deepEqual(visible,[]);
});

test('identity tables grant no runtime access and RLS still denies accidental table grants', async t => {
  const db = await fixture(t); await identityFixture(db);
  for(const role of ['memory_runtime','memory_background']) await asRole(db,role,()=>assert.rejects(db.query('SELECT * FROM memory_identity.credentials'),state('42501')));
  const policies=(await db.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='memory_identity' AND c.relkind='r' ORDER BY relname`)).rows;
  assert.deepEqual(policies.map(row=>row.relname),[...authorityTables].sort());
  for(const row of policies){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
  await db.exec('GRANT USAGE ON SCHEMA memory_identity TO memory_runtime; GRANT SELECT,INSERT ON memory_identity.accounts TO memory_runtime');
  await asRole(db,'memory_runtime',async()=>{
    assert.deepEqual((await db.query('SELECT * FROM memory_identity.accounts')).rows,[]);
    await assert.rejects(db.exec("INSERT INTO memory_identity.accounts(id) VALUES('account:injected')"),state('42501'));
  });
});

test('membership and organization PAT cannot bind another account email or membership', async t => {
  const db = await fixture(t); await identityFixture(db);
  await asRole(db,'memory_owner',async()=>{
    await assert.rejects(db.exec("INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role) VALUES('member:wrong','org:one','account:b','email:a','member')"),state('23503'));
    await assert.rejects(db.exec("INSERT INTO memory_identity.credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at) VALUES('pat:wrong','account:b','member:a','email:a','api_key',repeat('b',64),100)"),state('23503'));
    await db.exec("INSERT INTO memory_identity.credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at) VALUES('pat:org','account:a','member:a','email:a','api_key',repeat('c',64),100)");
  });
});

test('personal PAT remains email-independent while malformed credential shapes are rejected', async t => {
  const db = await fixture(t); await identityFixture(db);
  await asRole(db,'memory_owner',async()=>{
    await assert.rejects(db.exec("INSERT INTO memory_identity.credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at) VALUES('pat:bad','account:a','member:a','email:a','personal_key',repeat('b',64),100)"),state('23514'));
    await assert.rejects(db.exec("INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at) VALUES('pat:bad2','account:a','api_key',repeat('b',64),100)"),state('23514'));
    await assert.rejects(db.exec("INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at) VALUES('pat:bad3','account:a','personal_key','plaintext-token',100)"),state('23514'));
    await db.exec("UPDATE memory_identity.account_emails SET revoked_at=2 WHERE id='email:a'");
    assert.deepEqual((await db.query("SELECT email_id,membership_id,revoked_at FROM memory_identity.credentials WHERE id='pat:a'")).rows,[{email_id:null,membership_id:null,revoked_at:null}]);
  });
});

test('identity binding is immutable and a revoked credential cannot be resurrected', async t => {
  const db = await fixture(t); await identityFixture(db);
  await asRole(db,'memory_owner',async()=>{
    await assert.rejects(db.exec("UPDATE memory_identity.credentials SET account_id='account:b' WHERE id='pat:a'"),state('55000'));
    await db.exec("UPDATE memory_identity.credentials SET revoked_at=2 WHERE id='pat:a'");
    await assert.rejects(db.exec("UPDATE memory_identity.credentials SET revoked_at=NULL WHERE id='pat:a'"),state('55000'));
    await assert.rejects(db.exec("DELETE FROM memory_identity.credentials WHERE id='pat:a'"),state('55000'));
    await assert.rejects(db.exec('TRUNCATE memory_identity.credentials CASCADE'),state('55000'));
  });
});

test('provider subjects cannot be reassigned to a different account', async t => {
  const db = await fixture(t); await identityFixture(db);
  await asRole(db,'memory_owner',async()=>{
    await db.exec("INSERT INTO memory_identity.provider_identities VALUES('https://auth-api.allen.company','subject:a','account:a',1)");
    await assert.rejects(db.exec("UPDATE memory_identity.provider_identities SET account_id='account:b' WHERE subject='subject:a'"),state('55000'));
    await assert.rejects(db.exec("INSERT INTO memory_identity.provider_identities VALUES('https://auth-api.allen.company','subject:a','account:b',2)"),state('23505'));
  });
});

test('provider subject bounds retain existing non-ASCII character semantics', async t => {
  const db = await fixture(t); await identityFixture(db);
  const subject = '한'.repeat(512);
  await asRole(db,'memory_owner',async()=>{
    await db.query('INSERT INTO memory_identity.provider_identities VALUES($1,$2,$3,$4)', ['https://auth-api.allen.company',subject,'account:a',1]);
    assert.equal((await db.query('SELECT subject FROM memory_identity.provider_identities')).rows[0].subject,subject);
    await assert.rejects(db.query('INSERT INTO memory_identity.provider_identities VALUES($1,$2,$3,$4)', ['https://auth-api.allen.company',subject+'한','account:a',1]),state('23514'));
  });
});

test('future owner-created objects do not inherit public execution or data grants', async t => {
  const db = await fixture(t);
  await asRole(db,'memory_owner',()=>db.exec(`CREATE TABLE memory_identity.future_secret(id integer);
    CREATE FUNCTION memory_identity.future_function() RETURNS integer LANGUAGE sql AS 'SELECT 1';`));
  assert.deepEqual((await db.query(`SELECT has_table_privilege('anon','memory_identity.future_secret','SELECT') AS read,
    has_function_privilege('anon','memory_identity.future_function()','EXECUTE') AS execute`)).rows,[{read:false,execute:false}]);
});

test('existing reserved role collisions fail bootstrap without modifying that role', async t => {
  const db=new PGlite(); await db.waitReady;t.after(()=>db.close());
  await db.exec('CREATE ROLE memory_runtime LOGIN');
  const sql=(await migrations())[0]; assert.equal(typeof sql,'string','native bootstrap migration is missing');
  await assert.rejects(db.exec(sql),state('42710'));
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='memory_runtime'")).rows[0].rolcanlogin,true);
  assert.deepEqual((await db.query("SELECT nspname FROM pg_namespace WHERE nspname='memory_identity'")).rows,[]);
});

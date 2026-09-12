import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import * as implementation from '../../src/postgres/seoul/privileges.ts';

test('invalid serving login expectations cannot inspect a database', async () => {
  const session = { query() { assert.fail('invalid role reached database'); } };
  for (const role of [undefined, '', 'postgres', 'memory_owner', 'memory_commands', 'memory_runtime', 'memory_background', 'bad role']) {
    await assert.rejects(implementation.verifySeoulServingPrivileges(session, role), { code: 'seoul_serving_expectation_invalid' });
  }
});

test('a serving catalogue query failure never exposes SQL or credential diagnostics', async () => {
  const session = { query() { throw Object.assign(new Error('private token and SQL'), { code: '42501', detail: 'private diagnostic' }); } };
  await assert.rejects(implementation.verifySeoulServingPrivileges(session, 'memory_seoul_login'), error => {
    assert.equal(error.code, 'seoul_serving_privileges_unavailable');
    assert.equal(error.message, 'seoul_serving_privileges_unavailable');
    assert.equal(error.cause, undefined);
    assert.equal(error.detail, undefined);
    return true;
  });
});

test('a malformed migration row collection cannot impersonate the expected four rows', async () => {
  let queries = 0;
  const session = { query() { return Promise.resolve({ rows: queries++ === 0
    ? [{ roles_ok: true, schemas_ok: true, tables_ok: true, columns_ok: true,
      functions_ok: true, policies_ok: true, defaults_ok: true, triggers_ok: true }]
    : { length: 4, some() { return false; } }, rowCount: 1 }); } };
  await assert.rejects(implementation.verifySeoulServingPrivileges(session, 'memory_seoul_runtime'), { code: 'seoul_serving_privileges_denied' });
});

test('the installed three-migration foundation cannot attest as an executable Seoul service', async t => {
  const db = new PGlite(); await db.waitReady; t.after(() => db.close());
  for (const name of ['0001_private_namespaces.sql', '0002_deployment_identity.sql', '0003_identity_foundation.sql']) {
    await db.exec(await readFile(new URL('../../postgres/migrations/' + name, import.meta.url), 'utf8'));
  }
  await db.exec(`RESET ROLE; CREATE ROLE memory_seoul_login LOGIN INHERIT;
    GRANT memory_runtime TO memory_seoul_login WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
    SET SESSION AUTHORIZATION memory_seoul_login`);
  const session = { async query(sql, values) { const result = await db.query(sql, values); return { rows: result.rows, rowCount: result.affectedRows ?? null }; } };
  await assert.rejects(implementation.verifySeoulServingPrivileges(session, 'memory_seoul_login'), { code: 'seoul_serving_privileges_denied' });
});

test('a claimed version four without the command catalogue cannot authorize serving', async t => {
  const db = new PGlite(); await db.waitReady; t.after(() => db.close());
  for (const name of ['0001_private_namespaces.sql', '0002_deployment_identity.sql', '0003_identity_foundation.sql']) {
    await db.exec(await readFile(new URL('../../postgres/migrations/' + name, import.meta.url), 'utf8'));
  }
  await db.exec(`SET ROLE memory_owner;
    INSERT INTO memory_control.schema_migrations(version,name) VALUES(4,'0004_seoul_pat_archive.sql');
    RESET ROLE; CREATE ROLE memory_seoul_login LOGIN INHERIT;
    GRANT memory_runtime TO memory_seoul_login WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
    SET SESSION AUTHORIZATION memory_seoul_login`);
  const session = { async query(sql, values) { const result = await db.query(sql, values); return { rows: result.rows, rowCount: result.affectedRows ?? null }; } };
  await assert.rejects(implementation.verifySeoulServingPrivileges(session, 'memory_seoul_login'), { code: 'seoul_serving_privileges_denied' });
});

async function servingFixture(t) {
  const { createSeoulFixture } = await import('./seoul-fixture.mjs');
  const fixture = await createSeoulFixture(t, { seed: false });
  const session = { async query(sql, values) { const result = await fixture.db.query(sql, values); return { rows: result.rows, rowCount: result.affectedRows ?? null }; } };
  return { ...fixture, verify: () => fixture.asRuntime(() => implementation.verifySeoulServingPrivileges(session, 'memory_seoul_runtime')) };
}

test('the installed serving catalogue permits metadata and exactly the three command entry points', async t => {
  const f = await servingFixture(t);
  await f.verify();
});

test('unrelated provider-owned public objects do not change the fixed serving boundary', async t => {
  const f = await servingFixture(t);
  await f.db.exec(`CREATE TABLE public.provider_fixture(id integer);
    CREATE FUNCTION public.provider_fixture() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
  await f.verify();
});

const deniedChanges = [
  ['command membership even without inheritance or SET', 'GRANT memory_commands TO memory_seoul_runtime WITH INHERIT FALSE, SET FALSE, ADMIN FALSE'],
  ['background membership', 'GRANT memory_background TO memory_seoul_runtime'],
  ['owner membership', 'GRANT memory_owner TO memory_seoul_runtime'],
  ['unlisted harmless capability membership', 'CREATE ROLE unrelated_capability; GRANT unrelated_capability TO memory_seoul_runtime'],
  ['runtime can administer its capability', 'GRANT memory_runtime TO memory_seoul_runtime WITH ADMIN TRUE'],
  ['runtime can SET its capability', 'GRANT memory_runtime TO memory_seoul_runtime WITH SET TRUE'],
  ['runtime loses inherited capability', 'GRANT memory_runtime TO memory_seoul_runtime WITH INHERIT FALSE'],
  ['runtime role escalation flag', 'ALTER ROLE memory_seoul_runtime CREATEROLE'],
  ['command role escalation flag', 'ALTER ROLE memory_commands BYPASSRLS'],
  ['command role gains login', 'ALTER ROLE memory_commands LOGIN'],
  ['command role gains inheritance', 'ALTER ROLE memory_commands INHERIT'],
  ['command role inherits another capability', 'CREATE ROLE unrelated_capability; GRANT unrelated_capability TO memory_commands'],
  ['command role schema CREATE', 'GRANT CREATE ON SCHEMA memory_content TO memory_commands'],
  ['runtime schema CREATE', 'GRANT CREATE ON SCHEMA memory_content TO memory_runtime'],
  ['PUBLIC CREATE in public schema', 'GRANT CREATE ON SCHEMA public TO PUBLIC'],
  ['runtime CREATE outside private schemas', 'GRANT CREATE ON SCHEMA public TO memory_seoul_runtime'],
  ['capability CREATE outside private schemas', 'GRANT CREATE ON SCHEMA public TO memory_runtime'],
  ['executor CREATE outside private schemas', 'GRANT CREATE ON SCHEMA public TO memory_commands'],
  ['owner CREATE outside private schemas', 'GRANT CREATE ON SCHEMA public TO memory_owner'],
  ['background CREATE outside private schemas', 'GRANT CREATE ON SCHEMA public TO memory_background'],
  ['owner owns an outside namespace', 'CREATE SCHEMA owner_export AUTHORIZATION memory_owner'],
  ['background owns an outside namespace', 'CREATE SCHEMA background_export AUTHORIZATION memory_background'],
  ['owner owns an outside table', 'CREATE TABLE public.owner_export(id integer); ALTER TABLE public.owner_export OWNER TO memory_owner'],
  ['background owns an outside table', 'CREATE TABLE public.background_export(id integer); ALTER TABLE public.background_export OWNER TO memory_background'],
  ['private messages inherit an unscoped readable parent', `CREATE TABLE public.memory_export (LIKE memory_content.archive_messages INCLUDING DEFAULTS);
    ALTER TABLE memory_content.archive_messages INHERIT public.memory_export;
    GRANT SELECT ON public.memory_export TO memory_runtime`],
  ['an outside child inherits private messages', 'CREATE TABLE public.extra_messages() INHERITS(memory_content.archive_messages)'],
  ['owner definer outside private schemas', `GRANT CREATE ON SCHEMA public TO memory_owner;
    SET ROLE memory_owner;
    CREATE FUNCTION public.memory_export() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
      BEGIN RETURN (SELECT jsonb_agg(content) FROM memory_content.archive_messages); END $fn$;
    RESET ROLE; REVOKE CREATE ON SCHEMA public FROM memory_owner;
    GRANT EXECUTE ON FUNCTION public.memory_export() TO memory_runtime`],
  ['background function outside private schemas', `CREATE FUNCTION public.background_export() RETURNS integer LANGUAGE sql AS 'SELECT 1';
    ALTER FUNCTION public.background_export() OWNER TO memory_background`],
  ['runtime direct table SELECT', 'GRANT SELECT ON memory_content.archive_messages TO memory_seoul_runtime'],
  ['runtime direct column SELECT', 'GRANT SELECT(content) ON memory_content.archive_messages TO memory_seoul_runtime'],
  ['runtime inherited column UPDATE', 'GRANT UPDATE(token_digest) ON memory_identity.credentials TO memory_runtime'],
  ['runtime metadata UPDATE', 'GRANT UPDATE(name) ON memory_control.schema_migrations TO memory_runtime'],
  ['PUBLIC content SELECT', 'GRANT SELECT ON memory_content.archive_messages TO PUBLIC'],
  ['command broader authority UPDATE', 'GRANT UPDATE ON memory_identity.credentials TO memory_commands'],
  ['command extra identity SELECT', 'GRANT SELECT ON memory_identity.provider_identities TO memory_commands'],
  ['command loses lock column privilege', 'REVOKE UPDATE(id) ON memory_identity.credentials FROM memory_commands'],
  ['missing entry EXECUTE', 'REVOKE EXECUTE ON FUNCTION memory_content.seoul_keyword_search(text,jsonb) FROM memory_runtime'],
  ['missing entry function', 'DROP FUNCTION memory_content.seoul_keyword_search(text,jsonb)'],
  ['entry changes to migration owner', 'ALTER FUNCTION memory_content.seoul_keyword_search(text,jsonb) OWNER TO memory_owner'],
  ['runtime private helper EXECUTE', 'GRANT EXECUTE ON FUNCTION memory_identity.seoul_pat_authority(text,text,boolean) TO memory_runtime'],
  ['PUBLIC private helper EXECUTE', 'GRANT EXECUTE ON FUNCTION memory_identity.seoul_pat_authority(text,text,boolean) TO PUBLIC'],
  ['grantable entry EXECUTE', 'GRANT EXECUTE ON FUNCTION memory_content.seoul_keyword_search(text,jsonb) TO memory_runtime WITH GRANT OPTION'],
  ['entry loses SECURITY DEFINER', 'ALTER FUNCTION memory_content.seoul_keyword_search(text,jsonb) SECURITY INVOKER'],
  ['entry unsafe search path', "ALTER FUNCTION memory_content.seoul_keyword_search(text,jsonb) SET search_path=pg_catalog,public"],
  ['private trigger loses SECURITY DEFINER', 'ALTER FUNCTION memory_content.seoul_archive_commit_fence() SECURITY INVOKER'],
  ['new unlisted executable function', "CREATE FUNCTION memory_content.unexpected() RETURNS integer LANGUAGE sql AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION memory_content.unexpected() TO memory_runtime"],
  ['executor PUBLIC function defaults', 'ALTER DEFAULT PRIVILEGES FOR ROLE memory_commands GRANT EXECUTE ON FUNCTIONS TO PUBLIC'],
  ['missing forced RLS', 'ALTER TABLE memory_content.archive_messages NO FORCE ROW LEVEL SECURITY'],
  ['disabled RLS', 'ALTER TABLE memory_identity.credentials DISABLE ROW LEVEL SECURITY'],
  ['unexpected runtime policy', 'CREATE POLICY runtime_bypass ON memory_content.archive_messages TO memory_runtime USING (true)'],
  ['missing executor SELECT policy', 'DROP POLICY seoul_commands_read ON memory_identity.credentials'],
  ['weakened executor SELECT policy', 'ALTER POLICY seoul_commands_read ON memory_identity.credentials TO PUBLIC'],
  ['missing commit expiry trigger', 'ALTER TABLE memory_content.archives DISABLE TRIGGER ALL'],
  ['removed commit expiry trigger', 'DROP TRIGGER seoul_archive_expiry ON memory_content.archives'],
  ['expiry trigger is no longer initially deferred', `DROP TRIGGER seoul_archive_expiry ON memory_content.archives;
    CREATE CONSTRAINT TRIGGER seoul_archive_expiry AFTER INSERT ON memory_content.archives
    DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION memory_content.seoul_archive_commit_fence()`],
  ['expiry trigger can exclude a stored operation', `DROP TRIGGER seoul_archive_expiry ON memory_content.archives;
    CREATE CONSTRAINT TRIGGER seoul_archive_expiry AFTER INSERT ON memory_content.archives
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_bytes>0)
    EXECUTE FUNCTION memory_content.seoul_archive_commit_fence()`],
  ['correct version but incorrect migration filename', `ALTER TABLE memory_control.schema_migrations DISABLE TRIGGER schema_migrations_append_only;
    UPDATE memory_control.schema_migrations SET name='0004_different.sql' WHERE version=4;
    ALTER TABLE memory_control.schema_migrations ENABLE TRIGGER schema_migrations_append_only`],
  ['unexpected future migration', "INSERT INTO memory_control.schema_migrations(version,name) VALUES(5,'0005_unreviewed.sql')"],
];

test('real catalogue privilege mutations cannot authorize the serving runtime', async t => {
  const f = await servingFixture(t);
  await f.verify();
  for (const [label, sql] of deniedChanges) await t.test(label, async () => {
    await f.db.exec('BEGIN');
    try {
      await f.db.exec(sql);
      await assert.rejects(f.verify(), { code: 'seoul_serving_privileges_denied' });
    } finally { await f.db.exec('ROLLBACK'); }
    await f.verify();
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySeoulServingPrivileges } from '../../src/postgres/seoul/privileges.ts';
import { createSeoulFixture } from './seoul-fixture.mjs';
import { createLifecycleFixture } from './seoul-lifecycle-fixture.mjs';

function session(f) {
  return { async query(sql, values) {
    const result = await f.db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  } };
}
const verify = (f, version) => f.asRuntime(() => verifySeoulServingPrivileges(session(f), f.runtimeRole, version));

test('unsupported schema versions fail before inspecting a database', async () => {
  let queried = false;
  const database = { query() { queried = true; throw new Error('must not query'); } };
  for (const version of [null, 0, 3, 6, '5', NaN, {}, false]) {
    await assert.rejects(verifySeoulServingPrivileges(database, 'memory_seoul_runtime', version),
      { code: 'seoul_serving_expectation_invalid' });
  }
  assert.equal(queried, false);
});

test('explicit v5 cannot fall back to an installed v4 command catalogue', async t => {
  const f = await createSeoulFixture(t, { seed: false });
  await verify(f);
  await verify(f, 4);
  await assert.rejects(verify(f, 5), { code: 'seoul_serving_privileges_denied' });
});

test('the v5 lifecycle catalogue requires an explicit version selection', async t => {
  const f = await createLifecycleFixture(t, { seed: false });
  await verify(f, 5);
  await assert.rejects(verify(f), { code: 'seoul_serving_privileges_denied' });
  await assert.rejects(verify(f, 4), { code: 'seoul_serving_privileges_denied' });
});

test('unrelated provider objects remain compatible with the v5 boundary', async t => {
  const f = await createLifecycleFixture(t, { seed: false });
  await verify(f, 5);
  await f.db.exec(`CREATE TABLE public.provider_health(id integer);
    CREATE FUNCTION public.provider_health() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
  await verify(f, 5);
});

test('inactive non-admin incoming memberships preserve provisioner grantor metadata', async t => {
  const f = await createLifecycleFixture(t, { seed: false });
  await verify(f, 5);
  await f.db.exec(`CREATE ROLE inactive_actor LOGIN;
    GRANT memory_lifecycle TO inactive_actor WITH INHERIT FALSE,SET FALSE,ADMIN FALSE`);
  await verify(f, 5);
  assert.deepEqual((await f.db.query(`SELECT pg_has_role('inactive_actor','memory_lifecycle','SET') AS can_set,
    has_table_privilege('inactive_actor','memory_content.archive_messages','SELECT') AS can_read`)).rows,
  [{ can_set: false, can_read: false }]);
});

const drift = [
  ['lifecycle gains LOGIN', 'ALTER ROLE memory_lifecycle LOGIN'],
  ['lifecycle gains INHERIT', 'ALTER ROLE memory_lifecycle INHERIT'],
  ['lifecycle gains BYPASSRLS', 'ALTER ROLE memory_lifecycle BYPASSRLS'],
  ['lifecycle gains CREATEROLE', 'ALTER ROLE memory_lifecycle CREATEROLE'],
  ['runtime joins lifecycle even without SET or inheritance', 'GRANT memory_lifecycle TO memory_seoul_runtime WITH INHERIT FALSE,SET FALSE,ADMIN FALSE'],
  ['command role joins lifecycle', 'GRANT memory_lifecycle TO memory_commands WITH INHERIT FALSE,SET FALSE,ADMIN FALSE'],
  ['lifecycle joins command role', 'GRANT memory_commands TO memory_lifecycle WITH INHERIT FALSE,SET FALSE,ADMIN FALSE'],
  ['lifecycle gains another capability', 'CREATE ROLE unrelated_capability; GRANT unrelated_capability TO memory_lifecycle'],
  ['outside LOGIN inherits lifecycle access', 'CREATE ROLE unexpected_actor LOGIN INHERIT; GRANT memory_lifecycle TO unexpected_actor WITH INHERIT TRUE,SET TRUE,ADMIN FALSE'],
  ['outside LOGIN can SET lifecycle without inheritance', 'CREATE ROLE unexpected_actor LOGIN; GRANT memory_lifecycle TO unexpected_actor WITH INHERIT FALSE,SET TRUE,ADMIN FALSE'],
  ['outside LOGIN can grant itself lifecycle authority', 'CREATE ROLE unexpected_actor LOGIN; GRANT memory_lifecycle TO unexpected_actor WITH INHERIT FALSE,SET FALSE,ADMIN TRUE'],
  ['outside LOGIN inherits the runtime capability', 'CREATE ROLE unexpected_actor LOGIN INHERIT; GRANT memory_runtime TO unexpected_actor WITH INHERIT TRUE,SET FALSE,ADMIN FALSE'],
  ['outside LOGIN can SET the command role', 'CREATE ROLE unexpected_actor LOGIN; GRANT memory_commands TO unexpected_actor WITH INHERIT FALSE,SET TRUE,ADMIN FALSE'],
  ['outside LOGIN can SET the owner role', 'CREATE ROLE unexpected_actor LOGIN; GRANT memory_owner TO unexpected_actor WITH INHERIT FALSE,SET TRUE,ADMIN FALSE'],
  ['outside LOGIN can SET the background role', 'CREATE ROLE unexpected_actor LOGIN; GRANT memory_background TO unexpected_actor WITH INHERIT FALSE,SET TRUE,ADMIN FALSE'],
  ['lifecycle can create database schemas', `DO $test$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO memory_lifecycle',current_database()); END $test$`, true],
  ['PUBLIC CREATE outside Memory schemas', 'GRANT CREATE ON SCHEMA public TO PUBLIC'],
  ['lifecycle CREATE outside Memory schemas', 'GRANT CREATE ON SCHEMA public TO memory_lifecycle'],
  ['lifecycle CREATE inside Memory schemas', 'GRANT CREATE ON SCHEMA memory_ops TO memory_lifecycle'],
  ['lifecycle owns an unrelated schema', 'CREATE SCHEMA lifecycle_export AUTHORIZATION memory_lifecycle'],
  ['lifecycle owns an unrelated table', 'CREATE TABLE public.lifecycle_export(id integer); ALTER TABLE public.lifecycle_export OWNER TO memory_lifecycle'],
  ['owner owns an unrelated table', 'CREATE TABLE public.owner_export(id integer); ALTER TABLE public.owner_export OWNER TO memory_owner'],
  ['background owns an unrelated table', 'CREATE TABLE public.background_export(id integer); ALTER TABLE public.background_export OWNER TO memory_background'],
  ['lifecycle loses required schema USAGE', 'REVOKE USAGE ON SCHEMA memory_ops FROM memory_lifecycle'],
  ['lifecycle gains unrelated schema USAGE', 'GRANT USAGE ON SCHEMA memory_search TO memory_lifecycle'],
  ['runtime reads lifecycle receipts directly', 'GRANT SELECT ON memory_ops.lifecycle_receipts TO memory_runtime'],
  ['runtime reads message content by column grant', 'GRANT SELECT(content) ON memory_content.archive_messages TO memory_seoul_runtime'],
  ['runtime mutates metadata', 'GRANT UPDATE(name) ON memory_control.schema_migrations TO memory_runtime'],
  ['lifecycle reads provider identities', 'GRANT SELECT ON memory_identity.provider_identities TO memory_lifecycle'],
  ['lifecycle can remove tombstones', 'GRANT DELETE ON memory_content.archives TO memory_lifecycle'],
  ['lifecycle can truncate messages', 'GRANT TRUNCATE ON memory_content.archive_messages TO memory_lifecycle'],
  ['lifecycle can overwrite source content', 'GRANT UPDATE(content) ON memory_content.archive_messages TO memory_lifecycle'],
  ['lifecycle can refund cumulative quota', 'GRANT UPDATE(source_bytes) ON memory_ops.space_usage TO memory_lifecycle'],
  ['lifecycle can rewrite immutable ingest operation hash', 'GRANT UPDATE(ingest_operation_hash) ON memory_content.archives TO memory_lifecycle'],
  ['command role can erase an archive directly', 'GRANT UPDATE(erased_at) ON memory_content.archives TO memory_commands'],
  ['command role can inspect lifecycle receipts', 'GRANT SELECT ON memory_ops.lifecycle_receipts TO memory_commands'],
  ['command role loses retained-counter maintenance', 'REVOKE UPDATE(retained_source_bytes) ON memory_ops.space_usage FROM memory_commands'],
  ['lifecycle loses an authority lock column', 'REVOKE UPDATE(id) ON memory_identity.accounts FROM memory_lifecycle'],
  ['lifecycle loses delete rights', 'REVOKE DELETE ON memory_content.archive_messages FROM memory_lifecycle'],
  ['lifecycle column privilege becomes grantable', 'GRANT UPDATE(revoked_at) ON memory_identity.credentials TO memory_lifecycle WITH GRANT OPTION'],
  ['new table inherits a readable outside parent', `CREATE TABLE public.receipt_parent (LIKE memory_ops.lifecycle_receipts INCLUDING DEFAULTS);
    ALTER TABLE memory_ops.lifecycle_receipts INHERIT public.receipt_parent;
    GRANT SELECT ON public.receipt_parent TO memory_runtime`],
  ['outside child inherits the receipt table', 'CREATE TABLE public.receipt_child() INHERITS(memory_ops.lifecycle_receipts)'],
  ['command role loses its one cross-role helper', 'REVOKE EXECUTE ON FUNCTION memory_identity.seoul_action_authority(text,text,text,uuid) FROM memory_commands'],
  ['command role gains another lifecycle helper', 'GRANT EXECUTE ON FUNCTION memory_ops.seoul_lifecycle_input(jsonb,text) TO memory_commands'],
  ['lifecycle gains a reverse command helper grant', 'GRANT EXECUTE ON FUNCTION memory_identity.seoul_pat_authority(text,text,boolean) TO memory_lifecycle'],
  ['runtime gains lifecycle private helper EXECUTE', 'GRANT EXECUTE ON FUNCTION memory_identity.seoul_action_authority(text,text,text,uuid) TO memory_runtime'],
  ['runtime gains guard EXECUTE', 'GRANT EXECUTE ON FUNCTION memory_content.seoul_lifecycle_guard() TO memory_runtime'],
  ['owner retains temporary fence EXECUTE', 'GRANT EXECUTE ON FUNCTION memory_ops.seoul_lifecycle_commit_fence() TO memory_owner'],
  ['PUBLIC can call erase', 'GRANT EXECUTE ON FUNCTION memory_content.seoul_archive_erase(text,jsonb) TO PUBLIC'],
  ['entry EXECUTE is grantable', 'GRANT EXECUTE ON FUNCTION memory_control.seoul_space_retire(text,jsonb) TO memory_runtime WITH GRANT OPTION'],
  ['entry EXECUTE is missing', 'REVOKE EXECUTE ON FUNCTION memory_identity.seoul_pat_revoke_self(text,jsonb) FROM memory_runtime'],
  ['entry function is missing', 'DROP FUNCTION memory_ops.seoul_lifecycle_status(text,jsonb)'],
  ['entry changes to table owner', 'ALTER FUNCTION memory_content.seoul_archive_erase(text,jsonb) OWNER TO memory_owner'],
  ['entry loses SECURITY DEFINER', 'ALTER FUNCTION memory_content.seoul_archive_erase(text,jsonb) SECURITY INVOKER'],
  ['guard gains SECURITY DEFINER', 'ALTER FUNCTION memory_content.seoul_lifecycle_guard() SECURITY DEFINER'],
  ['fence loses SECURITY DEFINER', 'ALTER FUNCTION memory_ops.seoul_lifecycle_commit_fence() SECURITY INVOKER'],
  ['action helper gets an unsafe search path', 'ALTER FUNCTION memory_identity.seoul_action_authority(text,text,text,uuid) SET search_path=pg_catalog,public'],
  ['unlisted lifecycle-owned public function', `CREATE FUNCTION public.lifecycle_export() RETURNS integer LANGUAGE sql AS 'SELECT 1';
    ALTER FUNCTION public.lifecycle_export() OWNER TO memory_lifecycle`],
  ['unlisted owner-owned public definer', `CREATE FUNCTION public.owner_export() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
    ALTER FUNCTION public.owner_export() OWNER TO memory_owner`],
  ['PUBLIC lifecycle function defaults', 'ALTER DEFAULT PRIVILEGES FOR ROLE memory_lifecycle GRANT EXECUTE ON FUNCTIONS TO PUBLIC'],
  ['additional schema-specific lifecycle defaults', 'ALTER DEFAULT PRIVILEGES FOR ROLE memory_lifecycle IN SCHEMA memory_ops GRANT EXECUTE ON FUNCTIONS TO memory_runtime'],
  ['receipt RLS disabled', 'ALTER TABLE memory_ops.lifecycle_receipts DISABLE ROW LEVEL SECURITY'],
  ['receipt forced RLS removed', 'ALTER TABLE memory_ops.lifecycle_receipts NO FORCE ROW LEVEL SECURITY'],
  ['missing lifecycle DELETE policy', 'DROP POLICY seoul_lifecycle_delete ON memory_content.archive_messages'],
  ['missing lifecycle receipt SELECT policy', 'DROP POLICY seoul_lifecycle_read ON memory_ops.lifecycle_receipts'],
  ['PUBLIC lifecycle UPDATE policy', 'ALTER POLICY seoul_lifecycle_update ON memory_content.archives TO PUBLIC'],
  ['lifecycle receipt INSERT policy loses its exact predicate', 'ALTER POLICY seoul_lifecycle_insert ON memory_ops.lifecycle_receipts WITH CHECK (false)'],
  ['unexpected runtime receipt policy', 'CREATE POLICY runtime_receipts ON memory_ops.lifecycle_receipts TO memory_runtime USING(true)'],
  ['missing archive scrub guard', 'DROP TRIGGER archives_immutable ON memory_content.archives'],
  ['extra enabled trigger calls a provider-owned public function', `CREATE FUNCTION public.extra_hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER extra_hook AFTER UPDATE ON memory_content.archives FOR EACH ROW EXECUTE FUNCTION public.extra_hook()`],
  ['extra enabled receipt trigger calls an allowed private function', `CREATE TRIGGER extra_hook AFTER UPDATE ON memory_ops.lifecycle_receipts FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()`],
  ['missing original immutable authority trigger', 'DROP TRIGGER credentials_immutable ON memory_identity.credentials'],
  ['original trigger name points to a public function', `DROP TRIGGER credentials_immutable ON memory_identity.credentials;
    CREATE FUNCTION public.extra_hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER credentials_immutable BEFORE UPDATE ON memory_identity.credentials FOR EACH ROW EXECUTE FUNCTION public.extra_hook()`],
  ['original immutable guard predicate becomes false', `DROP TRIGGER credentials_immutable ON memory_identity.credentials;
    CREATE TRIGGER credentials_immutable BEFORE UPDATE ON memory_identity.credentials FOR EACH ROW WHEN(false) EXECUTE FUNCTION memory_control.reject_mutation()`],
  ['original immutable guard only observes id updates', `DROP TRIGGER credentials_immutable ON memory_identity.credentials;
    CREATE TRIGGER credentials_immutable BEFORE UPDATE OF id ON memory_identity.credentials FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()`],
  ['original immutable guard observes the wrong event', `DROP TRIGGER credentials_immutable ON memory_identity.credentials;
    CREATE TRIGGER credentials_immutable BEFORE INSERT ON memory_identity.credentials FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()`],
  ['missing actual message delete guard', 'DROP TRIGGER no_delete ON memory_content.archive_messages'],
  ['missing meter scrub guard', 'DROP TRIGGER meters_immutable ON memory_ops.meter_events'],
  ['missing tombstone delete guard', 'DROP TRIGGER no_delete ON memory_content.archives'],
  ['missing receipt update guard', 'DROP TRIGGER no_update ON memory_ops.lifecycle_receipts'],
  ['missing receipt truncate guard', 'DROP TRIGGER no_truncate ON memory_ops.lifecycle_receipts'],
  ['guard can skip unchanged id on a scrub update', `DROP TRIGGER archives_immutable ON memory_content.archives;
    CREATE TRIGGER archives_immutable BEFORE UPDATE OF id ON memory_content.archives FOR EACH ROW EXECUTE FUNCTION memory_content.seoul_lifecycle_guard()`],
  ['guard gains a conditional bypass', `DROP TRIGGER meters_immutable ON memory_ops.meter_events;
    CREATE TRIGGER meters_immutable BEFORE UPDATE ON memory_ops.meter_events FOR EACH ROW WHEN(NEW.operation_id IS NOT NULL)
      EXECUTE FUNCTION memory_content.seoul_lifecycle_guard()`],
  ['guard points to another function', `DROP TRIGGER archives_immutable ON memory_content.archives;
    CREATE TRIGGER archives_immutable BEFORE UPDATE ON memory_content.archives FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()`],
  ['missing lifecycle commit fence', 'DROP TRIGGER seoul_lifecycle_expiry ON memory_ops.lifecycle_receipts'],
  ['missing original ingest commit fence', 'DROP TRIGGER seoul_archive_expiry ON memory_content.archives'],
  ['lifecycle fence no longer initially deferred', `DROP TRIGGER seoul_lifecycle_expiry ON memory_ops.lifecycle_receipts;
    CREATE CONSTRAINT TRIGGER seoul_lifecycle_expiry AFTER INSERT ON memory_ops.lifecycle_receipts
      DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION memory_ops.seoul_lifecycle_commit_fence()`],
  ['lifecycle fence can exclude a retirement', `DROP TRIGGER seoul_lifecycle_expiry ON memory_ops.lifecycle_receipts;
    CREATE CONSTRAINT TRIGGER seoul_lifecycle_expiry AFTER INSERT ON memory_ops.lifecycle_receipts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.action='erase') EXECUTE FUNCTION memory_ops.seoul_lifecycle_commit_fence()`],
  ['lifecycle trigger disabled', 'ALTER TABLE memory_ops.lifecycle_receipts DISABLE TRIGGER seoul_lifecycle_expiry'],
  ['correct version with unreviewed filename', `ALTER TABLE memory_control.schema_migrations DISABLE TRIGGER schema_migrations_append_only;
    UPDATE memory_control.schema_migrations SET name='0005_unreviewed.sql' WHERE version=5;
    ALTER TABLE memory_control.schema_migrations ENABLE TRIGGER schema_migrations_append_only`],
  ['unreviewed future migration', "INSERT INTO memory_control.schema_migrations(version,name) VALUES(6,'0006_unreviewed.sql')"],
];

test('real v5 catalogue drift cannot authorize lifecycle serving', async t => {
  const f = await createLifecycleFixture(t, { seed: false });
  await verify(f, 5);
  const engine = (await f.db.query("SELECT current_database() AS database,current_setting('server_version_num') AS version")).rows[0];
  for (const [label, sql, changesDatabaseAcl] of drift) await t.test(label, async context => {
    // The isolated embedded PG17.5 build cannot update template1's ACL (XX000
    // tuple concurrently deleted). The default PG18 suite executes this grant.
    if (changesDatabaseAcl && engine.database === 'template1' && engine.version === '170005') {
      context.skip('embedded PG17.5 template1 ACL mutation unavailable; exercised on PG18');
      return;
    }
    await f.db.exec('BEGIN');
    try {
      await f.db.exec(sql);
      await assert.rejects(verify(f, 5), { code: 'seoul_serving_privileges_denied' });
    } finally { await f.db.exec('ROLLBACK'); }
    await verify(f, 5);
  });
});

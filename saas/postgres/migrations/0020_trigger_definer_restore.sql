-- Regional lineage, version 20. Trigger definer restore: 0018's
-- CREATE OR REPLACE FUNCTION bodies for operation_meter and
-- storage_accounting reset prosecdef, so the metering triggers began running
-- as the invoker. memory_runtime holds only SELECT on the metering ledgers
-- (usage_events/usage_counters/usage_facts/storage_byte_deltas/
-- space_storage_counters), so every memories/memory_versions write and every
-- release_operations commit failed 42501. The 0014 convention is owner-side
-- evaluation for memory_owner trigger functions; any function legitimately
-- callable by a runtime role is an explicit callable, not a trigger fn. This
-- repeats the 0014 loop for owner-owned trigger functions still marked
-- invoker (release_jobs_episode and enrollment_state_guard only touch
-- NEW/OLD and are unaffected either way, but converge to the same boundary).
-- Future CREATE OR REPLACE FUNCTION on trigger functions must declare
-- SECURITY DEFINER inline; OR REPLACE does not preserve prosecdef.
BEGIN;
SET LOCAL ROLE memory_owner;

DO $definer$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT DISTINCT fn_ns.nspname AS schema_name, p.proname,
      pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_class rel ON rel.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
    JOIN pg_catalog.pg_namespace fn_ns ON fn_ns.oid = p.pronamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = p.proowner
    WHERE n.nspname IN ('memory_control', 'memory_identity', 'memory_content',
      'memory_search', 'memory_jobs', 'memory_ops')
      AND owner_role.rolname = 'memory_owner'
      AND NOT p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SECURITY DEFINER',
      fn.schema_name, fn.proname, fn.args);
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog',
      fn.schema_name, fn.proname, fn.args);
  END LOOP;
END
$definer$;

-- Post-condition: no owner-owned trigger function left as invoker. The audit
-- mirrors the loop's predicate and fails the migration on drift.
DO $audit$
DECLARE drift record;
BEGIN
  FOR drift IN
    SELECT DISTINCT fn_ns.nspname AS schema_name, p.proname
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_class rel ON rel.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
    JOIN pg_catalog.pg_namespace fn_ns ON fn_ns.oid = p.pronamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = p.proowner
    WHERE n.nspname IN ('memory_control', 'memory_identity', 'memory_content',
      'memory_search', 'memory_jobs', 'memory_ops')
      AND owner_role.rolname = 'memory_owner'
      AND NOT p.prosecdef
  LOOP
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'memory_trigger_invoker_remaining',
      DETAIL = drift.schema_name || '.' || drift.proname;
  END LOOP;
END
$audit$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (20, '0020_trigger_definer_restore.sql');
COMMIT;

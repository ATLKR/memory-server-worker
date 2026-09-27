-- Control-plane lineage, version 6. Runtime serving access.
--
-- The control cluster carries the same boundary discipline as the regional
-- one: every table has FORCE ROW LEVEL SECURITY with only the migration_owner
-- policy, so memory_runtime needs explicit per-verb capability. This
-- migration grants it while preserving the model:
--
--   * Directory reads (regions, deployments, canonical skeletons, enrollment
--     rows, Space placements) stay plain SELECT — already granted in 0003.
--   * Enrollment writes go through region-asserted definer commands. The
--     caller's attested region is pinned to the session GUC
--     memory.caller_region (set by connection.ts after deployment
--     attestation); a command rejects any region that is not both live and
--     the caller's own. Under a shared serving role this binding is a
--     reviewed claim, not a cryptographic boundary — the residual is
--     documented in docs/plans/2026-09-18-runtime-access-layer.md.
--   * The central lifecycle journal stays owner-written; regions read it
--     forward only through the bounded definer below.
--   * The billing catalog gets the exact verbs the billing service uses:
--     pools SELECT+UPDATE, checkout_requests SELECT+INSERT+UPDATE,
--     checkout_closures SELECT+INSERT, billing_events SELECT+INSERT+UPDATE,
--     billing_lock SELECT+UPDATE, webhook_events SELECT+INSERT. The
--     checkout-attempt freeze and closure append-only triggers are unchanged.
--   * Journal/apply tables (lifecycle_jwt_proofs, lifecycle_events,
--     lifecycle_state, provider_revocations) get no runtime policy; journal
--     reads use the definer and journal writes are owner commands.
BEGIN;
SET LOCAL ROLE memory_owner;

GRANT USAGE ON SCHEMA memory_control, memory_ops TO memory_runtime, memory_background;

-- ---------------------------------------------------------------------------
-- Owner-side evaluation for every memory_* trigger function owned by
-- memory_owner on this cluster (journal guards, lifecycle apply, pool
-- creation, immutability guards).
-- ---------------------------------------------------------------------------
DO $definer$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT DISTINCT p.oid, fn_ns.nspname AS schema_name, p.proname,
      pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_class rel ON rel.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
    JOIN pg_catalog.pg_namespace fn_ns ON fn_ns.oid = p.pronamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = p.proowner
    WHERE n.nspname IN ('memory_control', 'memory_ops')
      AND owner_role.rolname = 'memory_owner'
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SECURITY DEFINER',
      fn.schema_name, fn.proname, fn.args);
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog',
      fn.schema_name, fn.proname, fn.args);
  END LOOP;
END
$definer$;

-- ---------------------------------------------------------------------------
-- Region assertion. connection.ts pins the attested region to
-- memory.caller_region for every session; enrollment commands reject any
-- region that is not live or not the caller's own.
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_control.caller_region() RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $region$
  SELECT nullif(pg_catalog.current_setting('memory.caller_region', true), '')
$region$;
REVOKE ALL ON FUNCTION memory_control.caller_region() FROM PUBLIC;

CREATE FUNCTION memory_control.assert_live_caller_region(p_region text) RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $assert$
BEGIN
  IF p_region IS NULL OR p_region IS DISTINCT FROM memory_control.caller_region()
    OR NOT EXISTS(SELECT 1 FROM memory_control.regions r
      WHERE r.region = p_region AND r.retired_at_ms IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'region_unavailable'; END IF;
END
$assert$;
REVOKE ALL ON FUNCTION memory_control.assert_live_caller_region(text) FROM PUBLIC;

-- Canonical skeleton + live enrollment row. Idempotent: a second live
-- enrollment for (id, region) is a no-op, matching the service contract.
CREATE FUNCTION memory_control.enroll_account(p_account_id text, p_region text, p_at bigint)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  PERFORM memory_control.assert_live_caller_region(p_region);
  INSERT INTO memory_control.accounts(id, created_at_ms) VALUES (p_account_id, p_at)
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO memory_control.account_enrollments(account_id, region, enrolled_at_ms)
    SELECT p_account_id, p_region, p_at
    WHERE NOT EXISTS(SELECT 1 FROM memory_control.account_enrollments
      WHERE account_id = p_account_id AND region = p_region AND removed_at_ms IS NULL);
END
$cmd$;
REVOKE ALL ON FUNCTION memory_control.enroll_account(text, text, bigint) FROM PUBLIC;

-- Removal is terminal: removed_at_ms can never be cleared (the immutable
-- trigger rejects clearing a set value), and a later re-enrollment inserts a
-- fresh row. Returns whether a live row was closed.
CREATE FUNCTION memory_control.remove_account_enrollment(p_account_id text, p_region text, p_at bigint)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  PERFORM memory_control.assert_live_caller_region(p_region);
  UPDATE memory_control.account_enrollments SET removed_at_ms = p_at
    WHERE account_id = p_account_id AND region = p_region AND removed_at_ms IS NULL;
  RETURN FOUND;
END
$cmd$;
REVOKE ALL ON FUNCTION memory_control.remove_account_enrollment(text, text, bigint) FROM PUBLIC;

CREATE FUNCTION memory_control.enroll_organization(p_organization_id text, p_region text, p_at bigint)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  PERFORM memory_control.assert_live_caller_region(p_region);
  INSERT INTO memory_control.organizations(id, created_at_ms) VALUES (p_organization_id, p_at)
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO memory_control.organization_enrollments(organization_id, region, enrolled_at_ms)
    SELECT p_organization_id, p_region, p_at
    WHERE NOT EXISTS(SELECT 1 FROM memory_control.organization_enrollments
      WHERE organization_id = p_organization_id AND region = p_region AND removed_at_ms IS NULL);
END
$cmd$;
REVOKE ALL ON FUNCTION memory_control.enroll_organization(text, text, bigint) FROM PUBLIC;

CREATE FUNCTION memory_control.remove_organization_enrollment(p_organization_id text, p_region text, p_at bigint)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  PERFORM memory_control.assert_live_caller_region(p_region);
  UPDATE memory_control.organization_enrollments SET removed_at_ms = p_at
    WHERE organization_id = p_organization_id AND region = p_region AND removed_at_ms IS NULL;
  RETURN FOUND;
END
$cmd$;
REVOKE ALL ON FUNCTION memory_control.remove_organization_enrollment(text, text, bigint) FROM PUBLIC;

-- Bounded central-journal read for the regional apply unit. The journal
-- stays owner-written; this is the only runtime read path.
CREATE FUNCTION memory_ops.lifecycle_events_after(p_issuer text, p_after bigint, p_limit integer)
  RETURNS TABLE(id text, issuer text, subject text, sequence bigint, kind text,
    address text, occurred_at_ms bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  RETURN QUERY
    SELECT e.id::text, e.issuer, e.subject, e.sequence, e.kind, e.address,
      e.occurred_at_ms::bigint
    FROM memory_ops.lifecycle_events e
    WHERE e.issuer = p_issuer AND e.sequence > p_after
    ORDER BY e.sequence LIMIT least(greatest(p_limit, 1), 1000);
END
$cmd$;
REVOKE ALL ON FUNCTION memory_ops.lifecycle_events_after(text, bigint, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Billing catalog capability. Capability predicates stay true — tenant
-- scoping and atomicity live in the service predicates and the freeze
-- triggers, not in row policies.
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE grant_row record;
BEGIN
  FOR grant_row IN
    SELECT * FROM (VALUES
      ('memory_control.pools', 'SELECT,UPDATE'),
      ('memory_control.checkout_requests', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.checkout_closures', 'SELECT,INSERT'),
      ('memory_ops.billing_events', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.billing_lock', 'SELECT,UPDATE'),
      ('memory_ops.webhook_events', 'SELECT,INSERT')) AS t(relation, verbs)
  LOOP
    EXECUTE format('GRANT %s ON %s TO memory_runtime', grant_row.verbs, grant_row.relation);
    IF position('SELECT' IN grant_row.verbs) > 0 THEN
      EXECUTE format('CREATE POLICY runtime_select ON %s FOR SELECT TO memory_runtime USING (true)', grant_row.relation);
    END IF;
    IF position('INSERT' IN grant_row.verbs) > 0 THEN
      EXECUTE format('CREATE POLICY runtime_insert ON %s FOR INSERT TO memory_runtime WITH CHECK (true)', grant_row.relation);
    END IF;
    IF position('UPDATE' IN grant_row.verbs) > 0 THEN
      EXECUTE format('CREATE POLICY runtime_update ON %s FOR UPDATE TO memory_runtime USING (true) WITH CHECK (true)', grant_row.relation);
    END IF;
  END LOOP;
END
$grants$;

-- EXECUTE on the command entry points only; helpers stay private to owner.
GRANT EXECUTE ON FUNCTION memory_control.enroll_account(text, text, bigint) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_control.remove_account_enrollment(text, text, bigint) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_control.enroll_organization(text, text, bigint) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_control.remove_organization_enrollment(text, text, bigint) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_ops.lifecycle_events_after(text, bigint, integer) TO memory_runtime;

DO $private_objects$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.caller_region() FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.assert_live_caller_region(text) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.enroll_account(text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.remove_account_enrollment(text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.enroll_organization(text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.remove_organization_enrollment(text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_ops.lifecycle_events_after(text, bigint, integer) FROM %I', api_role);
    END IF;
  END LOOP;
END
$private_objects$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (6, '0006_runtime_access.sql');
COMMIT;

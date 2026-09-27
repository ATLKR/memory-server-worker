-- Regional lineage, version 14. Runtime serving access.
--
-- Until now every table carried FORCE ROW LEVEL SECURITY with only the
-- migration_owner policy, so the attested memory_runtime role could not serve
-- a single request. This migration grants the exact per-verb capability set
-- the ported service uses, while preserving the security model:
--
--   * The six identity-authority relations (memory_identity.accounts,
--     account_emails, memberships, credentials, provider_identities and
--     memory_control.organizations) still get NO runtime policy. Application
--     reads go through owner-evaluated runtime_* views; application writes go
--     through command records or the reviewed definer commands below.
--   * Command-record tables (workspace_*, challenges, flows, scim, shares)
--     get INSERT (and the mutable subset the record lifecycle needs); their
--     validate/apply triggers become SECURITY DEFINER so authority checks run
--     owner-side inside the same statement.
--   * Trigger-maintained ledgers/counters are SELECT-only.
--   * Seoul command-mediated tables (space_usage, meter_events,
--     lifecycle_receipts, archives, archive_messages, pat_space_grants) and
--     internal tables (payload_stage_accounts, *_audit_events besides the
--     exported memory_audit_events, usage_events, fts_rows) stay closed.
--
-- Guard corrections folded into the same lineage:
--   * domain_challenges / reauth_challenges: the blanket append-only trigger
--     also rejected the owner-side apply's used_at stamp and the service's
--     consume update. Column-scoped immutability replaces it; deletes are
--     narrowed to unused (or expired) rows.
--   * auth_flows / mail_budget: cleanup deletes are narrowed to expired flows
--     and past days instead of being impossible.
--   * domain_verifications.domain_id becomes DEFERRABLE: the apply trigger
--     creates the domains row in the same transaction, so the FK must be
--     checked at commit, not before the AFTER trigger runs.
--   * memory_search.fts_rows gains the missing immutability guard.
BEGIN;
SET LOCAL ROLE memory_owner;

-- ---------------------------------------------------------------------------
-- Schema usage for the two schemas never granted (jobs, search).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA memory_jobs, memory_search TO memory_runtime, memory_background;

-- ---------------------------------------------------------------------------
-- Owner-side evaluation for every memory_* trigger function owned by
-- memory_owner. Record inserts fire validators/applies that must see the
-- authority relations the invoker cannot. Seoul-slice functions owned by
-- memory_commands / memory_lifecycle are deliberately untouched.
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
    WHERE n.nspname IN ('memory_control', 'memory_identity', 'memory_content',
      'memory_search', 'memory_jobs', 'memory_ops')
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
-- Owner-evaluated identity read views. Raw authority relations keep zero
-- runtime access; views are the catalogue-visible read boundary. Only SELECT
-- is granted, so the auto-updatable view cannot be written through.
-- ---------------------------------------------------------------------------
CREATE VIEW memory_identity.runtime_accounts AS
  SELECT * FROM memory_identity.accounts;
CREATE VIEW memory_identity.runtime_account_emails AS
  SELECT * FROM memory_identity.account_emails;
CREATE VIEW memory_identity.runtime_memberships AS
  SELECT * FROM memory_identity.memberships;
CREATE VIEW memory_identity.runtime_credentials AS
  SELECT * FROM memory_identity.credentials;
CREATE VIEW memory_identity.runtime_provider_identities AS
  SELECT * FROM memory_identity.provider_identities;
CREATE VIEW memory_control.runtime_organizations AS
  SELECT * FROM memory_control.organizations;
REVOKE ALL ON
  memory_identity.runtime_accounts, memory_identity.runtime_account_emails,
  memory_identity.runtime_memberships, memory_identity.runtime_credentials,
  memory_identity.runtime_provider_identities, memory_control.runtime_organizations
  FROM PUBLIC;
GRANT SELECT ON
  memory_identity.runtime_accounts, memory_identity.runtime_account_emails,
  memory_identity.runtime_memberships, memory_identity.runtime_credentials,
  memory_identity.runtime_provider_identities, memory_control.runtime_organizations
  TO memory_runtime;

-- Existing owner views the service reads on every request.
GRANT SELECT ON memory_identity.active_credentials, memory_identity.active_memberships
  TO memory_runtime;
GRANT SELECT ON memory_ops.space_pools TO memory_runtime;

-- ---------------------------------------------------------------------------
-- Guard corrections.
-- ---------------------------------------------------------------------------

-- domain_challenges: used_at / verification_id are the owner-side apply's
-- one-way stamps; everything else stays frozen. Deletes keep only consumed
-- challenges as authority history (the service deletes expired, unused rows).
DROP TRIGGER IF EXISTS append_only ON memory_identity.domain_challenges;
DROP TRIGGER IF EXISTS no_delete ON memory_identity.domain_challenges;
CREATE TRIGGER domain_challenges_immutable BEFORE UPDATE ON memory_identity.domain_challenges
  FOR EACH ROW WHEN (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id
    OR NEW.domain IS DISTINCT FROM OLD.domain
    OR NEW.proof IS DISTINCT FROM OLD.proof
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
    OR (OLD.verification_id IS NOT NULL AND NEW.verification_id IS DISTINCT FROM OLD.verification_id))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER domain_challenges_delete_guard BEFORE DELETE ON memory_identity.domain_challenges
  FOR EACH ROW WHEN (OLD.used_at IS NOT NULL)
  EXECUTE FUNCTION memory_control.reject_mutation();

-- reauth_challenges: the consume statement stamps used_at and swaps
-- token_digest for the marker; those two columns stay mutable, the binding
-- columns freeze. Unused rows are disposable (send-failure compensation and
-- expiry cleanup); a consumed live row is retained.
DROP TRIGGER IF EXISTS append_only ON memory_identity.reauth_challenges;
DROP TRIGGER IF EXISTS no_delete ON memory_identity.reauth_challenges;
CREATE TRIGGER reauth_challenges_immutable BEFORE UPDATE ON memory_identity.reauth_challenges
  FOR EACH ROW WHEN (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.email_id IS DISTINCT FROM OLD.email_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER reauth_challenges_delete_guard BEFORE DELETE ON memory_identity.reauth_challenges
  FOR EACH ROW WHEN (OLD.used_at IS NOT NULL AND OLD.expires_at > memory_control.now_ms())
  EXECUTE FUNCTION memory_control.reject_mutation();

-- auth_flows: the only delete path is expiry cleanup before a new login.
DROP TRIGGER IF EXISTS no_delete ON memory_identity.auth_flows;
CREATE TRIGGER auth_flows_delete_guard BEFORE DELETE ON memory_identity.auth_flows
  FOR EACH ROW WHEN (OLD.expires_at > memory_control.now_ms())
  EXECUTE FUNCTION memory_control.reject_mutation();

-- mail_budget: the job service prunes strictly-past days; the live day's
-- counter can never be deleted to reset the quota.
DROP TRIGGER IF EXISTS no_delete ON memory_ops.mail_budget;
CREATE TRIGGER mail_budget_delete_guard BEFORE DELETE ON memory_ops.mail_budget
  FOR EACH ROW WHEN (OLD.day >= to_char(to_timestamp(memory_control.now_ms() / 1000.0)
    AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
  EXECUTE FUNCTION memory_control.reject_mutation();

-- domain_verifications: the apply creates the domains row after the command
-- row lands, in the same transaction. Defer the FK so it is checked at
-- commit instead of before the AFTER trigger runs.
DO $fk$
DECLARE constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
  JOIN pg_catalog.pg_class frel ON frel.oid = con.confrelid
  JOIN pg_catalog.pg_namespace fn ON fn.oid = frel.relnamespace
  WHERE n.nspname = 'memory_identity' AND rel.relname = 'domain_verifications'
    AND con.contype = 'f' AND fn.nspname = 'memory_identity' AND frel.relname = 'domains';
  IF constraint_name IS NULL
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'domain_verifications domain FK missing'; END IF;
  EXECUTE format('ALTER TABLE memory_identity.domain_verifications
    ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', constraint_name);
END
$fk$;

-- fts_rows is a stable trigger-maintained memory↔search-row mapping; no
-- statement may rewrite or remove a row.
CREATE TRIGGER fts_rows_immutable BEFORE UPDATE OR DELETE ON memory_search.fts_rows
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

-- ---------------------------------------------------------------------------
-- Reviewed definer commands: the only paths that write authority relations
-- outside command-record applies. Each carries its full original predicate;
-- neither inspects session_user.
-- ---------------------------------------------------------------------------

-- Session self-revocation (logout): possession of the live session digest is
-- the authority. Same predicate as the service's former direct update.
CREATE FUNCTION memory_identity.revoke_session(p_token_digest text, p_at bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  UPDATE memory_identity.credentials SET revoked_at = p_at
    WHERE token_digest = p_token_digest AND kind = 'session'
      AND membership_id IS NULL AND revoked_at IS NULL;
END
$cmd$;
REVOKE ALL ON FUNCTION memory_identity.revoke_session(text, bigint) FROM PUBLIC;

-- SCIM deactivation (PATCH active:false). Deactivation is not a deletion:
-- the membership stays visible to SCIM reads, so this cannot use the
-- scim_deletions command record. The full key/administrator/owner predicate
-- is re-evaluated owner-side; the function returns the deactivated member or
-- no row, mirroring the former UPDATE ... RETURNING contract.
CREATE FUNCTION memory_identity.scim_deactivate(p_membership_id text, p_organization_id text,
    p_key_digest text, p_at bigint)
  RETURNS TABLE(id text, "userName" text, active integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
DECLARE v_at bigint := greatest(p_at, memory_control.now_ms());
BEGIN
  RETURN QUERY
    WITH changed AS (
      UPDATE memory_identity.memberships target SET revoked_at = p_at
      WHERE target.id = p_membership_id AND target.organization_id = p_organization_id
        AND target.revoked_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM memory_identity.scim_deletions deleted
          WHERE deleted.membership_id = target.id)
        AND NOT EXISTS(SELECT 1 FROM memory_identity.memberships newer
          JOIN memory_identity.account_emails newer_email ON newer_email.id = newer.email_id
          WHERE newer.organization_id = target.organization_id AND newer.seq > target.seq
            AND newer_email.address = (SELECT e.address FROM memory_identity.account_emails e
              WHERE e.id = target.email_id))
        AND EXISTS(SELECT 1 FROM memory_identity.scim_keys k
          JOIN memory_identity.credentials issuer ON issuer.id = k.creator_credential_id
          JOIN memory_identity.active_memberships admin
            ON admin.id = k.creator_membership_id AND admin.account_id = issuer.account_id
            AND admin.email_id = k.creator_email_id AND admin.organization_id = k.organization_id
          WHERE k.token_digest = p_key_digest AND k.organization_id = target.organization_id
            AND k.revoked_at IS NULL AND k.expires_at > v_at
            AND admin.expires_at > v_at AND admin.role IN ('owner', 'admin')
            AND (target.role <> 'owner' OR (admin.role = 'owner'
              AND EXISTS(SELECT 1 FROM memory_identity.active_memberships other
                WHERE other.organization_id = target.organization_id AND other.role = 'owner'
                  AND other.expires_at > v_at AND other.id <> target.id))))
      RETURNING target.id, target.email_id)
    SELECT changed.id::text, e.address, 0 FROM changed
      JOIN memory_identity.account_emails e ON e.id = changed.email_id;
END
$cmd$;
REVOKE ALL ON FUNCTION memory_identity.scim_deactivate(text, text, text, bigint) FROM PUBLIC;

-- Provider-revocation apply, gated on the dedup receipt captured in the same
-- transaction. Mirrors the service's former atomic statement batch.
CREATE FUNCTION memory_ops.apply_provider_revocation(p_issuer text, p_subject text,
    p_kind text, p_address text, p_at bigint, p_event_id text, p_body_hash text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  IF p_kind NOT IN ('account.disabled', 'email.revoked')
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'unsupported revocation kind'; END IF;
  -- The whole apply is gated on the receipt this request just recorded: a
  -- call without a matching receipt writes nothing, preserving the
  -- INSERT ... WHERE receipt predicate this replaces.
  IF NOT EXISTS(SELECT 1 FROM memory_ops.webhook_events
      WHERE provider = 'identity' AND event_id = p_event_id AND body_hash = p_body_hash)
  THEN RETURN; END IF;
  IF p_kind = 'account.disabled' THEN
    UPDATE memory_identity.accounts SET disabled_at = p_at WHERE disabled_at IS NULL
      AND id IN (SELECT account_id FROM memory_identity.provider_identities
        WHERE issuer = p_issuer AND subject = p_subject);
  ELSE
    INSERT INTO memory_identity.external_email_blocks(account_id, address, created_at)
      SELECT account_id, p_address, p_at FROM memory_identity.provider_identities
      WHERE issuer = p_issuer AND subject = p_subject
      ON CONFLICT(account_id, address) DO NOTHING;
    UPDATE memory_identity.account_emails SET revoked_at = p_at WHERE address = p_address
      AND revoked_at IS NULL AND account_id IN
        (SELECT account_id FROM memory_identity.provider_identities
          WHERE issuer = p_issuer AND subject = p_subject);
    UPDATE memory_identity.email_challenges SET invalidated_at = p_at
      WHERE used_at IS NULL AND invalidated_at IS NULL AND address = p_address
        AND account_id IN (SELECT account_id FROM memory_identity.provider_identities
          WHERE issuer = p_issuer AND subject = p_subject);
  END IF;
END
$cmd$;
REVOKE ALL ON FUNCTION memory_ops.apply_provider_revocation(text, text, text, text, bigint, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Serving capability: exact per-verb grants and RLS policies. Capability
-- predicates stay true — tenant scoping lives in the service's authority
-- expressions and the owner-side guards, not in row policies.
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE grant_row record;
BEGIN
  FOR grant_row IN
    SELECT * FROM (VALUES
      -- Serving Space skeleton: createSpace inserts it directly.
      ('memory_control.spaces', 'SELECT,INSERT'),
      -- Command-record intake; validators fire owner-side.
      ('memory_identity.workspace_sign_ins', 'INSERT'),
      ('memory_identity.workspace_organization_creations', 'INSERT'),
      ('memory_identity.workspace_child_organization_creations', 'INSERT'),
      ('memory_identity.workspace_invitations', 'SELECT,INSERT'),
      ('memory_identity.workspace_invitation_acceptances', 'INSERT'),
      ('memory_identity.workspace_key_issuances', 'INSERT'),
      ('memory_identity.workspace_membership_revocations', 'INSERT'),
      ('memory_identity.workspace_key_revocations', 'INSERT'),
      ('memory_identity.domain_verifications', 'SELECT,INSERT'),
      ('memory_identity.scim_deletions', 'SELECT,INSERT'),
      -- Apply-written rows the service lists or joins.
      ('memory_identity.workspace_organization_metadata', 'SELECT'),
      ('memory_identity.workspace_key_metadata', 'SELECT'),
      ('memory_identity.organization_hierarchy', 'SELECT'),
      ('memory_identity.domains', 'SELECT'),
      ('memory_identity.email_blocks', 'SELECT'),
      -- Mutable command/flow state.
      ('memory_identity.domain_managers', 'SELECT,INSERT'),
      ('memory_identity.credential_policies', 'SELECT,INSERT,UPDATE'),
      ('memory_identity.domain_challenges', 'SELECT,INSERT,DELETE'),
      ('memory_identity.scim_keys', 'SELECT,INSERT,UPDATE'),
      ('memory_identity.reauth_challenges', 'SELECT,INSERT,UPDATE,DELETE'),
      ('memory_identity.email_challenges', 'SELECT,INSERT,UPDATE'),
      ('memory_identity.email_consumptions', 'SELECT,INSERT'),
      ('memory_identity.revocations', 'SELECT,INSERT'),
      ('memory_identity.external_email_blocks', 'SELECT,INSERT'),
      ('memory_identity.auth_flows', 'SELECT,INSERT,UPDATE,DELETE'),
      -- Deferred shares: writes must reach the deny trigger so the service
      -- can map memory_immutable_record to the stable 403.
      ('memory_identity.shares', 'SELECT,INSERT,UPDATE'),
      -- Content.
      ('memory_content.memories', 'SELECT,INSERT,UPDATE'),
      ('memory_content.memory_versions', 'SELECT,DELETE'),
      ('memory_content.release_ingests', 'SELECT,INSERT,UPDATE'),
      ('memory_content.payload_intents', 'SELECT,INSERT,UPDATE'),
      ('memory_content.payload_stages', 'SELECT,INSERT,UPDATE'),
      ('memory_content.payload_archive_permits', 'SELECT,INSERT'),
      ('memory_content.payload_archives', 'SELECT,INSERT'),
      -- Jobs.
      ('memory_jobs.release_jobs', 'SELECT,INSERT,UPDATE'),
      ('memory_jobs.ingest_operations', 'SELECT,INSERT'),
      ('memory_jobs.ingest_approvals', 'SELECT,INSERT'),
      -- Search: vector identifier ledger (kept for anti-resurrection sweeps).
      ('memory_search.vector_refs', 'SELECT,INSERT'),
      -- Operational state the service writes or claims.
      ('memory_ops.release_operations', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.release_events', 'SELECT,INSERT'),
      ('memory_ops.space_policies', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.erasure_permits', 'SELECT,INSERT,DELETE'),
      ('memory_ops.erasure_ledger', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.export_sessions', 'SELECT,INSERT,DELETE'),
      ('memory_ops.maintenance_progress', 'SELECT,UPDATE'),
      ('memory_ops.payload_backfill_progress', 'SELECT,UPDATE'),
      ('memory_ops.mail_budget', 'SELECT,INSERT,UPDATE,DELETE'),
      ('memory_ops.provider_revocations', 'INSERT'),
      ('memory_ops.webhook_events', 'SELECT,INSERT'),
      ('memory_ops.provider_budgets', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.lifecycle_jwt_proofs', 'SELECT,INSERT'),
      ('memory_ops.lifecycle_events', 'SELECT,INSERT'),
      ('memory_ops.heartbeats', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.lifecycle_applied_state', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.lifecycle_apply_head', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.payload_purges', 'SELECT,INSERT,UPDATE'),
      ('memory_ops.payload_retirements', 'SELECT,INSERT,UPDATE'),
      -- SELECT-only ledgers/counters (trigger-maintained evidence stays
      -- unwritable; the service only reads them).
      ('memory_ops.memory_audit_events', 'SELECT'),
      ('memory_ops.usage_counters', 'SELECT'),
      ('memory_ops.space_storage_counters', 'SELECT')) AS t(relation, verbs)
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
    IF position('DELETE' IN grant_row.verbs) > 0 THEN
      EXECUTE format('CREATE POLICY runtime_delete ON %s FOR DELETE TO memory_runtime USING (true)', grant_row.relation);
    END IF;
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------
-- Function EXECUTE: the policy-shape validator runs inside CHECK constraints
-- on command records the runtime inserts; the two commands above are the
-- only definer entry points.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION memory_control.data_policy_shape_valid(jsonb) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_identity.revoke_session(text, bigint) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_identity.scim_deactivate(text, text, text, bigint) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_ops.apply_provider_revocation(text, text, text, text, bigint, text, text) TO memory_runtime;

DO $private_objects$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION memory_identity.revoke_session(text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_identity.scim_deactivate(text, text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_ops.apply_provider_revocation(text, text, text, text, bigint, text, text) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON memory_identity.runtime_accounts, memory_identity.runtime_account_emails,
        memory_identity.runtime_memberships, memory_identity.runtime_credentials,
        memory_identity.runtime_provider_identities, memory_control.runtime_organizations FROM %I', api_role);
    END IF;
  END LOOP;
END
$private_objects$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (14, '0014_runtime_access.sql');
COMMIT;

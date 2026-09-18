-- Regional lineage, version 10. Execution-time admission hardening and
-- regional lifecycle-apply gating (D1 migrations 0019 and 0024), plus the
-- remaining missed schema details:
-- - every temporal guard now compares against greatest(recorded, wall), so a
--   backdated created_at cannot admit an already-expired credential/invite —
--   the recorded timestamp is still stored verbatim;
-- - workspace_sign_ins gains issued_at and the sign-in/apply guards gain the
--   lifecycle checks from D1 0024 (regional applied-state is the authority);
-- - lifecycle state gates credential minting, email claims, challenges and
--   consumptions (silent-skip) exactly like the D1 guards;
-- - reauth-consumption validate/apply, the SCIM membership-revoked cascade,
--   release_jobs.cleanup_only, the D1 maintenance/backfill cursor shapes, and
--   the remaining index-only migrations (0007, 0011, 0014, 0015, 0018-skip,
--   0021, 0023).
BEGIN;
SET LOCAL ROLE memory_owner;

-- Defined in 0002 (payload admission already needs it at version 9); OR
-- REPLACE keeps the identical body so later lineages stay self-consistent.
CREATE OR REPLACE FUNCTION memory_control.now_ms() RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $now$
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
$now$;
REVOKE ALL ON FUNCTION memory_control.now_ms() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Schema corrections and missed columns.
-- ---------------------------------------------------------------------------
ALTER TABLE memory_identity.workspace_sign_ins
  ADD COLUMN issued_at memory_control.epoch_ms;

-- Challenge consumption sets used_at; these tables were wrongly listed as
-- append-only in version 7.
DROP TRIGGER append_only ON memory_identity.domain_challenges;
DROP TRIGGER append_only ON memory_identity.reauth_challenges;

ALTER TABLE memory_jobs.release_jobs
  ADD COLUMN cleanup_only smallint NOT NULL DEFAULT 0
    CHECK (cleanup_only IN (0, 1) AND (cleanup_only = 0 OR kind = 'upsert'));
CREATE INDEX release_jobs_pending_claim ON memory_jobs.release_jobs(kind, cleanup_only, available_at, id)
  WHERE state = 'pending';
CREATE INDEX release_jobs_leased_claim ON memory_jobs.release_jobs(kind, cleanup_only, lease_until, id)
  WHERE state = 'leased' AND attempt < 5;
CREATE INDEX release_jobs_exhausted_lease ON memory_jobs.release_jobs(lease_until, id)
  WHERE state = 'leased' AND attempt >= 5;
CREATE INDEX release_jobs_done_sweep ON memory_jobs.release_jobs(id) WHERE state = 'done';

DROP TABLE memory_ops.maintenance_progress;
CREATE TABLE memory_ops.maintenance_progress (
  name text PRIMARY KEY,
  cursor text NOT NULL DEFAULT ''
);
INSERT INTO memory_ops.maintenance_progress(name) VALUES('vector_resweep'), ('source_erasure');
ALTER TABLE memory_ops.maintenance_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.maintenance_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON memory_ops.maintenance_progress TO memory_owner USING (true) WITH CHECK (true);
CREATE TRIGGER maintenance_progress_no_delete BEFORE DELETE ON memory_ops.maintenance_progress
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER maintenance_progress_no_truncate BEFORE TRUNCATE ON memory_ops.maintenance_progress
  FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();
REVOKE ALL ON memory_ops.maintenance_progress FROM PUBLIC, memory_runtime, memory_background;

DROP TABLE memory_ops.payload_backfill_progress;
CREATE TABLE memory_ops.payload_backfill_progress (
  kind text PRIMARY KEY CHECK (kind IN ('current', 'history')),
  after_memory_id text NOT NULL DEFAULT '',
  after_revision bigint NOT NULL DEFAULT 0,
  generation bigint NOT NULL DEFAULT 0,
  updated_at memory_control.epoch_ms NOT NULL DEFAULT 0,
  last_error text,
  last_error_at memory_control.epoch_ms
);
INSERT INTO memory_ops.payload_backfill_progress(kind) VALUES('current'), ('history');
ALTER TABLE memory_ops.payload_backfill_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.payload_backfill_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON memory_ops.payload_backfill_progress TO memory_owner USING (true) WITH CHECK (true);
CREATE TRIGGER payload_backfill_progress_no_delete BEFORE DELETE ON memory_ops.payload_backfill_progress
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER payload_backfill_progress_no_truncate BEFORE TRUNCATE ON memory_ops.payload_backfill_progress
  FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();
REVOKE ALL ON memory_ops.payload_backfill_progress FROM PUBLIC, memory_runtime, memory_background;

-- Index-only migrations 0011, 0014, 0015, 0018*, 0021, 0023 (tenant-scoped
-- paging, claim queues, cleanup sweeps; shares indexes skipped — deferred).
CREATE INDEX release_audit_export ON memory_ops.memory_audit_events(space_id, memory_id, id, revision)
  WHERE memory_id IS NOT NULL;
CREATE INDEX release_memories_live_created ON memory_content.memories(space_id, created_at DESC, id)
  WHERE deleted_at IS NULL AND erased_at IS NULL;
CREATE INDEX release_memories_trash_created ON memory_content.memories(space_id, created_at DESC, id)
  WHERE deleted_at IS NOT NULL AND erased_at IS NULL;
CREATE INDEX release_spaces_account_created ON memory_control.spaces(owner_account_id, created_at_ms, id)
  WHERE owner_account_id IS NOT NULL;
CREATE INDEX release_spaces_organization_created ON memory_control.spaces(organization_id, created_at_ms, id)
  WHERE organization_id IS NOT NULL;
CREATE INDEX release_memberships_account ON memory_identity.memberships(account_id, organization_id, id)
  WHERE revoked_at IS NULL;
CREATE INDEX workspace_credentials_account ON memory_identity.credentials(account_id, kind, id);
CREATE INDEX workspace_memberships_organization ON memory_identity.memberships(organization_id, id, account_id, email_id);
CREATE INDEX release_memories_erasure_sweep ON memory_content.memories(deleted_at, id)
  WHERE deleted_at IS NOT NULL AND erased_at IS NULL;
CREATE INDEX release_domains_pending_expiry ON memory_identity.domain_challenges(expires_at, id)
  WHERE used_at IS NULL;
CREATE INDEX release_memories_inline_archive ON memory_content.memories(id)
  WHERE payload_id IS NULL AND erased_at IS NULL;
CREATE INDEX release_versions_inline_archive ON memory_content.memory_versions(memory_id, revision)
  WHERE payload_id IS NULL;
CREATE INDEX release_mail_budget_day ON memory_ops.mail_budget(day, account_id);

-- ---------------------------------------------------------------------------
-- Lifecycle-apply gating (D1 0024 guards, against the regional applied state).
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_identity.lifecycle_signin_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_ops.lifecycle_applied_state l
      WHERE l.issuer = NEW.issuer AND l.subject = NEW.subject AND l.address = ''
        AND (l.kind <> 'account.resumed' OR NEW.issued_at IS NULL
          OR NEW.issued_at <= l.occurred_at_ms))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider lifecycle sign-in denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER lifecycle_signin_guard BEFORE INSERT ON memory_identity.workspace_sign_ins
  FOR EACH ROW EXECUTE FUNCTION memory_identity.lifecycle_signin_guard();

CREATE FUNCTION memory_identity.lifecycle_credential_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_ops.lifecycle_applied_state l
        ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = ''
      WHERE p.account_id = NEW.account_id AND l.kind <> 'account.resumed')
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider lifecycle account suspended'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER lifecycle_credential_guard BEFORE INSERT ON memory_identity.credentials
  FOR EACH ROW EXECUTE FUNCTION memory_identity.lifecycle_credential_guard();

CREATE FUNCTION memory_identity.lifecycle_claim_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_ops.lifecycle_applied_state l
        ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = ''
      WHERE p.account_id = NEW.account_id AND l.kind <> 'account.resumed')
    OR EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_ops.lifecycle_applied_state l
        ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = NEW.address
      WHERE p.account_id = NEW.account_id AND l.kind = 'email.revoked')
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider lifecycle email revoked'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER lifecycle_claim_guard BEFORE INSERT ON memory_identity.account_emails
  FOR EACH ROW EXECUTE FUNCTION memory_identity.lifecycle_claim_guard();

-- Extend the silent-skip guards with the same lifecycle predicates.
CREATE OR REPLACE FUNCTION memory_identity.challenge_external_block() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.external_email_blocks b
      WHERE b.account_id = NEW.account_id AND b.address = NEW.address)
    OR EXISTS(SELECT 1 FROM memory_ops.provider_revocations b
      JOIN memory_identity.provider_identities p
        ON p.issuer = b.issuer AND p.subject = b.subject
      WHERE p.account_id = NEW.account_id AND b.kind = 'email.revoked' AND b.address = NEW.address)
    OR EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_ops.lifecycle_applied_state l
        ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = ''
      WHERE p.account_id = NEW.account_id AND l.kind <> 'account.resumed')
    OR EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_ops.lifecycle_applied_state l
        ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = NEW.address
      WHERE p.account_id = NEW.account_id AND l.kind = 'email.revoked')
  THEN RETURN NULL; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.consumption_external_block() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.email_challenges q
      WHERE q.id = NEW.challenge_id AND (
        EXISTS(SELECT 1 FROM memory_identity.external_email_blocks b
          WHERE b.account_id = q.account_id AND b.address = q.address)
        OR EXISTS(SELECT 1 FROM memory_ops.provider_revocations b
          JOIN memory_identity.provider_identities p
            ON p.issuer = b.issuer AND p.subject = b.subject
          WHERE p.account_id = q.account_id AND b.kind = 'email.revoked' AND b.address = q.address)
        OR EXISTS(SELECT 1 FROM memory_identity.provider_identities p
          JOIN memory_ops.lifecycle_applied_state l
            ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = ''
          WHERE p.account_id = q.account_id AND l.kind <> 'account.resumed')
        OR EXISTS(SELECT 1 FROM memory_identity.provider_identities p
          JOIN memory_ops.lifecycle_applied_state l
            ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = q.address
          WHERE p.account_id = q.account_id AND l.kind = 'email.revoked')))
  THEN RETURN NULL; END IF;
  RETURN NEW;
END
$guard$;

-- The sign-in apply gains the D1 0024 lifecycle predicates on the claim.
CREATE OR REPLACE FUNCTION memory_identity.ws_sign_in_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
DECLARE v_deployment text;
BEGIN
  SELECT deployment_id INTO v_deployment FROM memory_control.deployment_identity;
  IF v_deployment IS NULL
    OR (NEW.data_policy ->> 'residency') IS DISTINCT FROM
       (SELECT storage_region FROM memory_control.deployment_identity)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'residency placement mismatch'; END IF;
  INSERT INTO memory_identity.accounts(id) SELECT NEW.new_account_id
    WHERE NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities
      WHERE issuer = NEW.issuer AND subject = NEW.subject);
  INSERT INTO memory_identity.provider_identities(issuer, subject, account_id, created_at)
    SELECT NEW.issuer, NEW.subject, NEW.new_account_id, NEW.created_at
    WHERE NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities
      WHERE issuer = NEW.issuer AND subject = NEW.subject);
  INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at,
      reauthenticated_at, permission)
    SELECT NEW.credential_id, p.account_id, 'session', NEW.token_digest, NEW.expires_at,
      NULL, NEW.permission
    FROM memory_identity.provider_identities p
    WHERE p.issuer = NEW.issuer AND p.subject = NEW.subject
      AND NOT EXISTS(SELECT 1 FROM memory_identity.credentials WHERE token_digest = NEW.token_digest);
  INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
    SELECT NEW.email_id, p.account_id, NEW.address, NEW.domain, NEW.created_at
    FROM memory_identity.provider_identities p
    WHERE p.issuer = NEW.issuer AND p.subject = NEW.subject AND NEW.address IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM memory_identity.account_emails e
        WHERE e.address = NEW.address AND e.revoked_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM memory_identity.email_blocks b WHERE b.address = NEW.address)
      AND NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities mapped
        JOIN memory_ops.lifecycle_applied_state l
          ON l.issuer = mapped.issuer AND l.subject = mapped.subject AND l.address = NEW.address
        WHERE mapped.account_id = p.account_id AND l.kind = 'email.revoked')
      AND NOT EXISTS(SELECT 1 FROM memory_ops.lifecycle_applied_state l
        JOIN memory_identity.provider_identities mapped
          ON mapped.issuer = l.issuer AND mapped.subject = l.subject
        WHERE mapped.account_id = p.account_id AND l.address = NEW.address
          AND l.kind = 'email.verified'
          AND (NEW.issued_at IS NULL OR NEW.issued_at <= l.occurred_at_ms))
      AND NOT EXISTS(SELECT 1 FROM memory_identity.external_email_blocks b
        WHERE b.account_id = p.account_id AND b.address = NEW.address)
      AND NOT EXISTS(SELECT 1 FROM memory_ops.provider_revocations b
        JOIN memory_identity.provider_identities mapped
          ON mapped.issuer = b.issuer AND mapped.subject = b.subject
        WHERE mapped.account_id = p.account_id AND b.kind = 'email.revoked' AND b.address = NEW.address);
  INSERT INTO memory_control.spaces(id, owner_account_id, deployment_id, data_policy,
      source_byte_limit, message_limit, name, security_mode, created_at_ms, actor_credential_id)
    SELECT NEW.personal_space_id, c.account_id, v_deployment, NEW.data_policy,
      67108864, 100000, 'Personal', 'managed', NEW.created_at, c.id
    FROM memory_identity.credentials c WHERE c.token_digest = NEW.token_digest
      AND NOT EXISTS(SELECT 1 FROM memory_control.spaces s WHERE s.owner_account_id = c.account_id);
  INSERT INTO memory_ops.workspace_audit_events(action, actor_credential_id, account_id, created_at)
    SELECT 'signed_in', c.id, c.account_id, NEW.created_at
    FROM memory_identity.credentials c WHERE c.token_digest = NEW.token_digest;
  RETURN NULL;
END
$apply$;

-- Reauth consumption: the proof consumption and credential refresh share one
-- statement (D1 0019).
CREATE FUNCTION memory_identity.reauth_consumption_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.used_at, memory_control.now_ms());
BEGIN
  IF NEW.credential_id IS DISTINCT FROM OLD.credential_id OR NEW.email_id IS DISTINCT FROM OLD.email_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.expires_at <= at_ms
    OR NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.account_emails e ON e.account_id = c.account_id
      WHERE c.id = NEW.credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.permission = 'write' AND c.expires_at > at_ms AND c.membership_expires_at > at_ms
        AND e.id = NEW.email_id AND e.revoked_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER reauth_consumption_validate BEFORE UPDATE OF used_at ON memory_identity.reauth_challenges
  FOR EACH ROW WHEN (OLD.used_at IS NULL AND NEW.used_at IS NOT NULL)
  EXECUTE FUNCTION memory_identity.reauth_consumption_validate();
CREATE FUNCTION memory_identity.reauth_consumption_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  UPDATE memory_identity.credentials SET reauthenticated_at = NEW.used_at WHERE id = NEW.credential_id;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER reauth_consumption_apply AFTER UPDATE OF used_at ON memory_identity.reauth_challenges
  FOR EACH ROW WHEN (OLD.used_at IS NULL AND NEW.used_at IS NOT NULL)
  EXECUTE FUNCTION memory_identity.reauth_consumption_apply();

-- SCIM keys die with the membership that created them.
CREATE FUNCTION memory_identity.scim_membership_revoked() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  UPDATE memory_identity.scim_keys SET revoked_at = NEW.revoked_at
    WHERE creator_membership_id = NEW.id AND creator_email_id = NEW.email_id AND revoked_at IS NULL;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER scim_membership_revoked AFTER UPDATE OF revoked_at ON memory_identity.memberships
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION memory_identity.scim_membership_revoked();

-- ---------------------------------------------------------------------------
-- Execution-time rebase (D1 0019): every guard compares against
-- greatest(recorded, wall). Function bodies only — trigger names/behaviors
-- and error codes are unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION memory_identity.consume_email_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.email_challenges p
      JOIN memory_identity.active_credentials c ON c.account_id = p.account_id
      WHERE p.id = NEW.challenge_id AND c.id = NEW.actor_credential_id AND c.kind = 'session'
        AND c.membership_id IS NULL AND c.expires_at > at_ms
        AND c.reauthenticated_at BETWEEN at_ms - 300000 AND NEW.created_at
        AND p.expires_at > at_ms AND p.used_at IS NULL AND p.invalidated_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM memory_identity.email_blocks b WHERE b.address = p.address))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'email consumption denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.self_revocation_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint;
BEGIN
  IF NEW.kind = 'self' THEN
    at_ms := greatest(NEW.created_at, memory_control.now_ms());
    IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
        JOIN memory_identity.account_emails e ON e.account_id = c.account_id
        WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.membership_id IS NULL
          AND c.expires_at > at_ms
          AND c.reauthenticated_at BETWEEN at_ms - 300000 AND NEW.created_at
          AND e.id = NEW.email_id AND e.revoked_at IS NULL)
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'self revocation denied'; END IF;
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.domain_revocation_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint;
BEGIN
  IF NEW.kind = 'domain' THEN
    at_ms := greatest(NEW.created_at, memory_control.now_ms());
    IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
        JOIN memory_identity.active_memberships m ON m.account_id = c.account_id
        JOIN memory_identity.domain_managers g ON g.membership_id = m.id AND g.revoked_at IS NULL
        JOIN memory_identity.domains d ON d.id = g.domain_id AND d.organization_id = m.organization_id
        WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.membership_id IS NULL
          AND c.expires_at > at_ms
          AND c.reauthenticated_at BETWEEN at_ms - 300000 AND NEW.created_at
          AND m.expires_at > at_ms AND m.role IN ('owner', 'admin')
          AND d.id = NEW.domain_id AND d.verified_until > at_ms AND d.revoked_at IS NULL
          AND NEW.address = lower(btrim(NEW.address))
          AND right(NEW.address, length(d.name) + 1) = '@' || d.name)
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'domain revocation denied'; END IF;
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.ws_sign_in_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NEW.expires_at <= at_ms
    OR EXISTS(SELECT 1 FROM memory_identity.provider_identities p
        JOIN memory_identity.accounts a ON a.id = p.account_id
        WHERE p.issuer = NEW.issuer AND p.subject = NEW.subject AND a.disabled_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM memory_identity.credentials c WHERE c.token_digest = NEW.token_digest
        AND (c.revoked_at IS NOT NULL OR c.expires_at <= at_ms OR c.kind <> 'session'
          OR c.permission <> NEW.permission OR NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities p
            WHERE p.issuer = NEW.issuer AND p.subject = NEW.subject AND p.account_id = c.account_id)))
    OR EXISTS(SELECT 1 FROM memory_ops.provider_revocations p
        WHERE p.issuer = NEW.issuer AND p.subject = NEW.subject AND p.kind = 'account.disabled')
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.ws_org_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.account_emails e ON e.account_id = c.account_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > at_ms AND e.id = NEW.email_id AND e.revoked_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.ws_invitation_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.active_memberships m ON m.account_id = c.account_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > at_ms
        AND m.id = NEW.creator_membership_id AND m.organization_id = NEW.organization_id
        AND m.expires_at > at_ms AND m.role IN ('owner', 'admin'))
    OR EXISTS(SELECT 1 FROM memory_identity.email_blocks b WHERE b.address = NEW.address)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.ws_acceptance_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.workspace_invitations i
      JOIN memory_identity.active_memberships creator
        ON creator.id = i.creator_membership_id AND creator.organization_id = i.organization_id
      JOIN memory_identity.active_credentials c ON c.id = NEW.actor_credential_id
      JOIN memory_identity.account_emails e
        ON e.account_id = c.account_id AND e.id = NEW.email_id AND e.address = i.address
      WHERE i.id = NEW.invitation_id AND i.accepted_at IS NULL AND i.expires_at > at_ms
        AND creator.expires_at > at_ms AND creator.role IN ('owner', 'admin')
        AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at > at_ms
        AND e.revoked_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM memory_identity.email_blocks b WHERE b.address = i.address)
        AND NOT EXISTS(SELECT 1 FROM memory_identity.memberships m
          WHERE m.organization_id = i.organization_id AND m.account_id = c.account_id
            AND m.revoked_at IS NULL))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.ws_key_issuance_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > at_ms AND (NEW.permission = 'read' OR c.permission = 'write')
        AND (NEW.organization_id IS NULL OR EXISTS(SELECT 1 FROM memory_identity.active_memberships m
          WHERE m.account_id = c.account_id AND m.organization_id = NEW.organization_id
            AND m.expires_at > at_ms
            AND (NEW.permission = 'read' OR m.role IN ('owner', 'admin')))))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.ws_key_issuance_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  INSERT INTO memory_identity.credentials(id, account_id, membership_id, email_id, kind,
      token_digest, expires_at, permission)
    SELECT NEW.id, c.account_id, m.id, m.email_id,
      CASE WHEN NEW.organization_id IS NULL THEN 'personal_key' ELSE 'api_key' END,
      NEW.token_digest, NEW.expires_at, NEW.permission
    FROM memory_identity.credentials c
    LEFT JOIN memory_identity.memberships m ON m.id = (
      SELECT candidate.id FROM memory_identity.active_memberships candidate
      WHERE candidate.account_id = c.account_id AND candidate.organization_id = NEW.organization_id
        AND candidate.expires_at > at_ms LIMIT 1)
    WHERE c.id = NEW.actor_credential_id;
  INSERT INTO memory_identity.workspace_key_metadata(credential_id, label, actor_credential_id, created_at)
    VALUES(NEW.id, NEW.label, NEW.actor_credential_id, NEW.created_at);
  INSERT INTO memory_ops.workspace_audit_events(action, actor_credential_id, organization_id,
      credential_id, created_at)
    VALUES('key_issued', NEW.actor_credential_id, NEW.organization_id, NEW.id, NEW.created_at);
  RETURN NULL;
END
$apply$;

CREATE OR REPLACE FUNCTION memory_identity.ws_membership_revocation_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.active_memberships actor
        ON actor.account_id = c.account_id AND actor.organization_id = NEW.organization_id
      JOIN memory_identity.memberships target
        ON target.id = NEW.membership_id AND target.organization_id = actor.organization_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > at_ms
        AND actor.expires_at > at_ms AND actor.role IN ('owner', 'admin')
        AND target.revoked_at IS NULL
        AND (target.role <> 'owner' OR (actor.role = 'owner' AND EXISTS(
          SELECT 1 FROM memory_identity.active_memberships other
          WHERE other.organization_id = actor.organization_id AND other.role = 'owner'
            AND other.expires_at > at_ms AND other.id <> target.id))))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.ws_key_revocation_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.credentials target ON target.id = NEW.credential_id
      LEFT JOIN memory_identity.memberships target_member
        ON target_member.id = target.membership_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > at_ms
        AND target.kind IN ('personal_key', 'api_key') AND target.revoked_at IS NULL
        AND (target.account_id = c.account_id OR EXISTS(SELECT 1 FROM memory_identity.active_memberships actor
          WHERE actor.account_id = c.account_id
            AND actor.organization_id = target_member.organization_id
            AND actor.expires_at > at_ms AND actor.role IN ('owner', 'admin'))))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.ws_child_org_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF EXISTS(SELECT 1 FROM memory_control.organizations WHERE id = NEW.id)
    OR NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.active_memberships m ON m.account_id = c.account_id
      JOIN memory_identity.account_emails e ON e.account_id = c.account_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > at_ms AND m.organization_id = NEW.parent_organization_id
        AND m.expires_at > at_ms AND m.role IN ('owner', 'admin')
        AND e.id = NEW.email_id AND e.revoked_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.domain_verification_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.domain_challenges p
      JOIN memory_identity.active_credentials c ON c.id = NEW.actor_credential_id
        AND c.account_id = p.actor_account_id
      JOIN memory_identity.active_memberships m ON m.id = NEW.membership_id
        AND m.account_id = c.account_id AND m.organization_id = p.organization_id
      WHERE p.id = NEW.challenge_id AND p.used_at IS NULL AND p.verification_id IS NULL
        AND p.expires_at > at_ms
        AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%' AND c.permission = 'write'
        AND c.expires_at > at_ms AND c.membership_expires_at > at_ms
        AND m.expires_at > at_ms AND m.role IN ('owner', 'admin')
        AND c.reauthenticated_at BETWEEN at_ms - 300000 AND at_ms
        AND NOT EXISTS(SELECT 1 FROM memory_identity.domains d WHERE d.id = NEW.domain_id
          AND (d.organization_id <> p.organization_id OR d.name <> p.domain OR d.revoked_at IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM memory_identity.domains d WHERE d.name = p.domain
          AND d.revoked_at IS NULL AND d.id <> NEW.domain_id)
        AND NOT EXISTS(SELECT 1 FROM memory_identity.domain_managers g
          WHERE g.domain_id = NEW.domain_id AND g.membership_id = m.id AND g.revoked_at IS NOT NULL))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.scim_key_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NEW.expires_at <= at_ms OR NEW.expires_at > NEW.created_at + 2592000000
    OR NEW.revoked_at IS NOT NULL
    OR NEW.token_digest IS NULL OR NEW.token_digest !~ '^[0-9a-f]{64}$'
    OR NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.active_memberships m ON m.account_id = c.account_id
      WHERE c.id = NEW.creator_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.permission = 'write' AND c.expires_at > at_ms
        AND c.reauthenticated_at BETWEEN at_ms - 300000 AND NEW.created_at
        AND m.id = NEW.creator_membership_id AND m.organization_id = NEW.organization_id
        AND m.email_id = NEW.creator_email_id AND m.expires_at > at_ms
        AND m.role IN ('owner', 'admin'))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_identity.scim_deletion_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.deleted_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.memberships target
      JOIN memory_identity.scim_keys k ON k.organization_id = target.organization_id
      JOIN memory_identity.credentials issuer ON issuer.id = k.creator_credential_id
      JOIN memory_identity.active_memberships admin
        ON admin.id = k.creator_membership_id AND admin.account_id = issuer.account_id
        AND admin.email_id = k.creator_email_id AND admin.organization_id = k.organization_id
      WHERE target.id = NEW.membership_id AND k.id = NEW.scim_key_id
        AND k.revoked_at IS NULL AND k.expires_at > at_ms
        AND admin.expires_at > at_ms AND admin.role IN ('owner', 'admin')
        AND (target.revoked_at IS NOT NULL OR target.role <> 'owner' OR (admin.role = 'owner'
          AND EXISTS(SELECT 1 FROM memory_identity.active_memberships other
            WHERE other.organization_id = target.organization_id AND other.role = 'owner'
              AND other.expires_at > at_ms AND other.id <> target.id))))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_denied'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_ops.operation_revision_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NEW.action IN ('update', 'delete', 'restore', 'erase')
    AND NOT EXISTS(SELECT 1 FROM memory_content.memories r
      WHERE r.id = NEW.memory_id AND r.space_id = NEW.space_id
        AND r.revision = NEW.expected_revision AND r.erased_at IS NULL
        AND ((NEW.action IN ('update', 'delete') AND r.deleted_at IS NULL)
          OR (NEW.action IN ('restore', 'erase') AND r.deleted_at IS NOT NULL))
        AND (NEW.action <> 'restore'
          OR r.deleted_at + coalesce((SELECT retention_days FROM memory_ops.space_policies
            WHERE space_id = r.space_id), 30) * 86400000 > at_ms))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_conflict'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_jobs.ingest_approval_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at, memory_control.now_ms());
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_content.release_ingests i
      JOIN memory_ops.release_operations o ON o.id = NEW.operation_id
      WHERE i.id = NEW.ingest_id AND i.account_id = o.account_id AND i.space_id = o.space_id
        AND i.state = 'review' AND i.expires_at > at_ms)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_conflict'; END IF;
  RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION
  memory_identity.lifecycle_signin_guard(), memory_identity.lifecycle_credential_guard(),
  memory_identity.lifecycle_claim_guard(), memory_identity.reauth_consumption_validate(),
  memory_identity.reauth_consumption_apply(), memory_identity.scim_membership_revoked(),
  memory_identity.consume_email_validate(), memory_identity.self_revocation_validate(),
  memory_identity.domain_revocation_validate(), memory_identity.ws_sign_in_validate(),
  memory_identity.ws_org_validate(), memory_identity.ws_invitation_validate(),
  memory_identity.ws_acceptance_validate(), memory_identity.ws_key_issuance_validate(),
  memory_identity.ws_key_issuance_apply(), memory_identity.ws_membership_revocation_validate(),
  memory_identity.ws_key_revocation_validate(), memory_identity.ws_child_org_validate(),
  memory_identity.domain_verification_validate(), memory_identity.scim_key_validate(),
  memory_identity.scim_deletion_validate(), memory_identity.challenge_external_block(),
  memory_identity.consumption_external_block(), memory_identity.ws_sign_in_apply(),
  memory_ops.operation_revision_guard(), memory_jobs.ingest_approval_guard() FROM PUBLIC;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (10, '0010_execution_time_guards.sql');
COMMIT;

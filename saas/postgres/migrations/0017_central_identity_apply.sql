-- Regional lineage, version 17. Regional apply for the central identity
-- events added by the control lineage
-- (docs/plans/2026-09-19-central-identity-events.md): enrollment
-- removal/restore and SSO-subject unlink.
--
-- - memory_ops.enrollment_applied_state is the region's projected enrollment
--   state per (scope, subject_id). The apply unit is the only writer; the
--   monotonic guard rejects key moves and non-increasing sequences (the
--   lifecycle_state_guard shape minus the event lookup — control rows are
--   filtered to this region before they arrive, so there is no local
--   journal to check against). Both kinds are restorable, so there is no
--   terminal-kind clause.
-- - memory_ops.provider_revocations gains the 'subject.unlinked' tombstone
--   kind; memory_ops.apply_subject_unlink stamps the tombstone and revokes
--   the session credentials that binding minted through workspace_sign_ins.
--   No lifecycle_applied_state row is written — a non-resumed kind on
--   (issuer, subject, '') would deny the whole account.
-- - ws_sign_in_validate denies tombstoned bindings, and the live views
--   exclude unlinked bindings from the lifecycle-denial join (a tombstoned
--   binding's residual state must not deny an account with other live
--   bindings) while probing enrollment_applied_state for removed accounts
--   and organizations.
BEGIN;
SET LOCAL ROLE memory_owner;

-- ---------------------------------------------------------------------------
-- Enrollment applied state. One row per (scope, subject_id): the latest
-- enrollment.* control event's kind, sequence and event id. No region column —
-- the filtered journal read guarantees only own-region rows arrive.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_ops.enrollment_applied_state (
  scope text NOT NULL CHECK (scope IN ('account', 'organization')),
  subject_id memory_control.identifier NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  kind text NOT NULL CHECK (kind IN ('enrollment.removed', 'enrollment.restored')),
  occurred_at_ms memory_control.epoch_ms NOT NULL,
  event_id memory_control.identifier NOT NULL,
  PRIMARY KEY (scope, subject_id)
);
CREATE FUNCTION memory_ops.enrollment_state_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.scope IS DISTINCT FROM OLD.scope
      OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
      OR NEW.sequence <= OLD.sequence)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'memory_immutable_record'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER enrollment_state_insert BEFORE INSERT ON memory_ops.enrollment_applied_state
  FOR EACH ROW EXECUTE FUNCTION memory_ops.enrollment_state_guard();
CREATE TRIGGER enrollment_state_update BEFORE UPDATE ON memory_ops.enrollment_applied_state
  FOR EACH ROW EXECUTE FUNCTION memory_ops.enrollment_state_guard();

-- ---------------------------------------------------------------------------
-- provider_revocations gains the subject-unlink tombstone kind; control and
-- provider channels converge onto the same regional tombstone. The inline
-- CHECK was never named, so it is found through pg_constraint.
-- ---------------------------------------------------------------------------
DO $constraint$
DECLARE constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
  WHERE n.nspname = 'memory_ops' AND rel.relname = 'provider_revocations'
    AND con.contype = 'c'
    AND position('kind' IN pg_get_constraintdef(con.oid)) > 0;
  IF constraint_name IS NULL
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_revocations kind CHECK missing'; END IF;
  EXECUTE format('ALTER TABLE memory_ops.provider_revocations DROP CONSTRAINT %I', constraint_name);
END
$constraint$;
ALTER TABLE memory_ops.provider_revocations
  ADD CONSTRAINT provider_revocations_kind_check
    CHECK (kind IN ('account.disabled', 'email.revoked', 'subject.unlinked'));

-- ---------------------------------------------------------------------------
-- subject.unlinked apply: tombstone the binding, then revoke the live session
-- credentials the binding minted. The tombstone is written even when the
-- local mapping is already gone, so a still-valid pre-unlink JWT cannot
-- recreate authority.
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_ops.apply_subject_unlink(p_issuer text, p_subject text, p_at bigint)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  INSERT INTO memory_ops.provider_revocations(issuer, subject, kind, address, created_at_ms)
    VALUES(p_issuer, p_subject, 'subject.unlinked', '', p_at)
    ON CONFLICT DO NOTHING;
  UPDATE memory_identity.credentials SET revoked_at = p_at
    WHERE revoked_at IS NULL AND kind = 'session' AND id IN
      (SELECT si.credential_id FROM memory_identity.workspace_sign_ins si
        WHERE si.issuer = p_issuer AND si.subject = p_subject);
END
$cmd$;
REVOKE ALL ON FUNCTION memory_ops.apply_subject_unlink(text, text, bigint) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Sign-in denial: a tombstoned binding cannot mint a new session. Body is the
-- 0010 final version with the provider_revocations predicate widened. The
-- SECURITY DEFINER is restated because OR REPLACE resets unspecified
-- attributes; the trigger must keep evaluating owner-side (0014).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION memory_identity.ws_sign_in_validate() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $guard$
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
        WHERE p.issuer = NEW.issuer AND p.subject = NEW.subject
          AND p.kind IN ('account.disabled', 'subject.unlinked'))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Live views. Same bodies as 0006 plus the unlink exclusion inside the
-- lifecycle-denial subquery and the enrollment probes. Column lists are
-- unchanged — memberships gained `seq` in 0011, so the membership columns
-- are listed explicitly (CREATE OR REPLACE cannot drop or reorder columns).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW memory_identity.active_memberships AS
  SELECT m.id, m.organization_id, m.account_id, m.email_id, m.role, m.expires_at, m.revoked_at
  FROM memory_identity.memberships m
  JOIN memory_identity.accounts a ON a.id = m.account_id AND a.disabled_at IS NULL
  JOIN memory_control.organizations o ON o.id = m.organization_id AND o.disabled_at IS NULL
  JOIN memory_identity.account_emails e ON e.id = m.email_id AND e.account_id = m.account_id
    AND e.revoked_at IS NULL
  WHERE m.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_ops.lifecycle_applied_state l
        ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = ''
      WHERE p.account_id = m.account_id AND l.kind <> 'account.resumed'
        AND NOT EXISTS(SELECT 1 FROM memory_ops.provider_revocations u
          WHERE u.issuer = p.issuer AND u.subject = p.subject AND u.kind = 'subject.unlinked'))
    AND NOT EXISTS(SELECT 1 FROM memory_ops.enrollment_applied_state er
      WHERE er.scope = 'account' AND er.subject_id = m.account_id AND er.kind = 'enrollment.removed')
    AND NOT EXISTS(SELECT 1 FROM memory_ops.enrollment_applied_state er
      WHERE er.scope = 'organization' AND er.subject_id = m.organization_id AND er.kind = 'enrollment.removed');

CREATE OR REPLACE VIEW memory_identity.active_credentials AS
  SELECT c.*, coalesce(m.expires_at, 9007199254740991) AS membership_expires_at
  FROM memory_identity.credentials c
  JOIN memory_identity.accounts a ON a.id = c.account_id AND a.disabled_at IS NULL
  LEFT JOIN memory_identity.active_memberships m ON m.id = c.membership_id
    AND m.account_id = c.account_id AND m.email_id = c.email_id
  WHERE c.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_ops.lifecycle_applied_state l
        ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = ''
      WHERE p.account_id = c.account_id AND l.kind <> 'account.resumed'
        AND NOT EXISTS(SELECT 1 FROM memory_ops.provider_revocations u
          WHERE u.issuer = p.issuer AND u.subject = p.subject AND u.kind = 'subject.unlinked'))
    AND NOT EXISTS(SELECT 1 FROM memory_ops.enrollment_applied_state er
      WHERE er.scope = 'account' AND er.subject_id = c.account_id AND er.kind = 'enrollment.removed')
    AND (c.kind IN ('session', 'personal_key') OR m.id IS NOT NULL);

-- Provider bindings minus the subject-unlinked tombstones: the serving view
-- the service reads where runtime_provider_identities would over-report.
CREATE VIEW memory_identity.active_provider_identities AS
  SELECT p.* FROM memory_identity.provider_identities p
  WHERE NOT EXISTS(SELECT 1 FROM memory_ops.provider_revocations u
    WHERE u.issuer = p.issuer AND u.subject = p.subject AND u.kind = 'subject.unlinked');
REVOKE ALL ON memory_identity.active_provider_identities FROM PUBLIC;
GRANT SELECT ON memory_identity.active_provider_identities TO memory_runtime;

-- ---------------------------------------------------------------------------
-- Boundaries and grants. The new state table takes the 0006 boundary
-- discipline (forced RLS, owner policy, no delete/truncate) and the 0014
-- lifecycle_applied_state runtime capability (SELECT,INSERT,UPDATE for
-- memory_runtime only — background has no apply role).
-- ---------------------------------------------------------------------------
DO $boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['memory_ops.enrollment_applied_state'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING (true) WITH CHECK (true)', target);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()', target);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()', target);
  END LOOP;
END
$boundaries$;

REVOKE ALL ON memory_ops.enrollment_applied_state FROM PUBLIC, memory_runtime, memory_background;
GRANT SELECT, INSERT, UPDATE ON memory_ops.enrollment_applied_state TO memory_runtime;
CREATE POLICY runtime_select ON memory_ops.enrollment_applied_state
  FOR SELECT TO memory_runtime USING (true);
CREATE POLICY runtime_insert ON memory_ops.enrollment_applied_state
  FOR INSERT TO memory_runtime WITH CHECK (true);
CREATE POLICY runtime_update ON memory_ops.enrollment_applied_state
  FOR UPDATE TO memory_runtime USING (true) WITH CHECK (true);

-- Function EXECUTE: apply_subject_unlink is the apply unit's definer entry
-- point, mirroring apply_provider_revocation in 0014.
GRANT EXECUTE ON FUNCTION memory_ops.apply_subject_unlink(text, text, bigint) TO memory_runtime;
REVOKE ALL ON FUNCTION
  memory_ops.enrollment_state_guard(), memory_identity.ws_sign_in_validate() FROM PUBLIC;

DO $private_objects$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON memory_ops.enrollment_applied_state,
        memory_identity.active_provider_identities FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_ops.enrollment_state_guard(),
        memory_ops.apply_subject_unlink(text, text, bigint),
        memory_identity.ws_sign_in_validate() FROM %I', api_role);
    END IF;
  END LOOP;
END
$private_objects$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (17, '0017_central_identity_apply.sql');
COMMIT;

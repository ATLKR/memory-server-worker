-- Control-plane lineage, version 7. Central identity events
-- (docs/plans/2026-09-19-central-identity-events.md): the lifecycle journal
-- becomes one journal with two witnesses. Provider rows keep the existing
-- webhook receipt + JWT/freshness proof checks verbatim. Control rows ride
-- the reserved issuer 'memory:control' — never a valid HTTPS issuer — and
-- are validated against the directory state they assert in the same
-- transaction, so a forged control row can only restate the truth. The
-- control channel carries enrollment.removed/enrollment.restored (subject
-- '<scope>:<id>', region set) and subject.unlinked (provider subject,
-- target_issuer set, region NULL = all regions). Control sequences are
-- allocated under a single advisory lock so commit order equals sequence
-- order, which the forward-only regional head requires.
--
-- Writers: the enroll/remove definer commands keep their signatures (the
-- 0006 grants persist) and append in the same transaction — removed when a
-- live row closed, restored only when a prior removed row exists (first-ever
-- enrollment emits nothing; absent state already means allowed). New definer
-- memory_control.unlink_subject stamps provider_identities.unlinked_at_ms
-- then appends a control subject.unlinked event. lifecycle_apply_state
-- routes control rows away from lifecycle_state (the directory is the
-- truth — derive, don't project) and converges provider subject.unlinked
-- onto unlinked_at_ms + a provider_revocations tombstone.
-- lifecycle_events_after is recreated with the new columns; control rows are
-- visible only when region IS NULL (global) or region = caller_region().
BEGIN;
SET LOCAL ROLE memory_owner;

-- ---------------------------------------------------------------------------
-- Journal shape: source/region/scope/target columns and the generalized
-- kind + channel CHECKs. The 0003 CHECKs were declared inline (generated
-- names); discover them by definition so the drop does not depend on the
-- naming convention.
-- ---------------------------------------------------------------------------
ALTER TABLE memory_ops.lifecycle_events
  ADD COLUMN source text NOT NULL DEFAULT 'provider',
  ADD COLUMN region text,
  ADD COLUMN scope text,
  ADD COLUMN target_id memory_control.identifier,
  ADD COLUMN target_issuer text;

DO $checks$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'memory_ops.lifecycle_events'::regclass
      AND c.contype = 'c'
  LOOP
    IF con.definition LIKE '%account.suspended%' OR con.definition LIKE '%btrim%' THEN
      EXECUTE format('ALTER TABLE memory_ops.lifecycle_events DROP CONSTRAINT %I', con.conname);
    END IF;
  END LOOP;
  FOR con IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'memory_ops.provider_revocations'::regclass
      AND c.contype = 'c'
  LOOP
    IF con.definition LIKE '%account.disabled%' THEN
      EXECUTE format('ALTER TABLE memory_ops.provider_revocations DROP CONSTRAINT %I', con.conname);
    END IF;
  END LOOP;
END
$checks$;

-- Existing rows all carry source='provider' via the default and satisfy the
-- provider shape below (account.* -> address '', email.* -> normalized
-- address), so the CHECKs validate cleanly against them.
ALTER TABLE memory_ops.lifecycle_events
  ADD CONSTRAINT lifecycle_events_kind_check CHECK (kind IN (
    'account.suspended', 'account.resumed', 'account.deleted',
    'email.revoked', 'email.verified', 'subject.unlinked',
    'enrollment.removed', 'enrollment.restored'));

ALTER TABLE memory_ops.lifecycle_events
  ADD CONSTRAINT lifecycle_events_channel_check CHECK (
    (source = 'provider' AND issuer <> 'memory:control'
      AND region IS NULL AND scope IS NULL
      AND target_id IS NULL AND target_issuer IS NULL
      AND ((kind LIKE 'account.%' AND address = '')
        OR (kind = 'subject.unlinked' AND address = '')
        OR (kind LIKE 'email.%' AND address = lower(btrim(address))
          AND length(address) BETWEEN 3 AND 254)))
    OR (source = 'control' AND issuer = 'memory:control' AND address = ''
      AND ((kind IN ('enrollment.removed', 'enrollment.restored')
          AND region IS NOT NULL AND scope IN ('account', 'organization')
          AND target_id IS NOT NULL AND target_issuer IS NULL
          AND subject = scope || ':' || target_id)
        OR (kind = 'subject.unlinked' AND region IS NULL AND scope IS NULL
          AND target_id IS NULL AND target_issuer IS NOT NULL
          AND length(subject) BETWEEN 1 AND 512))));

-- The revocation tombstone vocabulary gains subject.unlinked for the
-- provider-source unlink convergence below.
ALTER TABLE memory_ops.provider_revocations
  ADD CONSTRAINT provider_revocations_kind_check
    CHECK (kind IN ('account.disabled', 'email.revoked', 'subject.unlinked'));

-- ---------------------------------------------------------------------------
-- Guard: two witnesses. Control rows carry no webhook receipt; the directory
-- fact they assert (committed in the same transaction) is verified instead.
-- Provider rows keep the 0003 receipt/proof body verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION memory_ops.lifecycle_event_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $guard$
DECLARE now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF NEW.source = 'control' THEN
    IF NEW.kind = 'enrollment.removed' THEN
      IF NEW.scope = 'account' AND EXISTS(SELECT 1
          FROM memory_control.account_enrollments e
          WHERE e.account_id = NEW.target_id AND e.region = NEW.region
            AND e.removed_at_ms = NEW.occurred_at_ms)
      THEN RETURN NEW; END IF;
      IF NEW.scope = 'organization' AND EXISTS(SELECT 1
          FROM memory_control.organization_enrollments e
          WHERE e.organization_id = NEW.target_id AND e.region = NEW.region
            AND e.removed_at_ms = NEW.occurred_at_ms)
      THEN RETURN NEW; END IF;
    ELSIF NEW.kind = 'enrollment.restored' THEN
      IF NEW.scope = 'account' AND EXISTS(SELECT 1
          FROM memory_control.account_enrollments e
          WHERE e.account_id = NEW.target_id AND e.region = NEW.region
            AND e.removed_at_ms IS NULL AND e.enrolled_at_ms = NEW.occurred_at_ms)
      THEN RETURN NEW; END IF;
      IF NEW.scope = 'organization' AND EXISTS(SELECT 1
          FROM memory_control.organization_enrollments e
          WHERE e.organization_id = NEW.target_id AND e.region = NEW.region
            AND e.removed_at_ms IS NULL AND e.enrolled_at_ms = NEW.occurred_at_ms)
      THEN RETURN NEW; END IF;
    ELSIF NEW.kind = 'subject.unlinked' THEN
      IF EXISTS(SELECT 1 FROM memory_control.provider_identities p
          WHERE p.issuer = NEW.target_issuer AND p.subject = NEW.subject
            AND p.unlinked_at_ms IS NOT NULL)
      THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'identity_lifecycle_directory_missing';
  END IF;
  -- Control-only kinds can never carry a receipt on a provider stream.
  IF NEW.kind IN ('enrollment.removed', 'enrollment.restored')
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'identity_lifecycle_receipt_missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM memory_ops.webhook_events w
      WHERE w.provider = 'identity' AND w.event_id = NEW.id AND w.body_hash = NEW.body_hash)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'identity_lifecycle_receipt_missing'; END IF;
  IF (EXISTS(SELECT 1 FROM memory_ops.lifecycle_jwt_proofs p WHERE p.event_id = NEW.id)
      AND NOT EXISTS(SELECT 1 FROM memory_ops.lifecycle_jwt_proofs p WHERE p.event_id = NEW.id
        AND p.body_hash = NEW.body_hash AND p.issued_at_ms <= now_ms AND p.expires_at_ms > now_ms))
    OR (NOT EXISTS(SELECT 1 FROM memory_ops.lifecycle_jwt_proofs p WHERE p.event_id = NEW.id)
      AND now_ms NOT BETWEEN NEW.signed_at_ms - 300000 AND NEW.signed_at_ms + 300000)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'identity_lifecycle_signature_expired'; END IF;
  RETURN NEW;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Apply: control rows assert directory truth, so nothing is projected into
-- lifecycle_state. A provider-reported subject.unlinked converges the
-- central binding and leaves a provider tombstone; it never lands in
-- lifecycle_state, where a non-resumed kind on (issuer, subject, '') would
-- deny every address of the account.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION memory_ops.lifecycle_apply_state() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $apply$
BEGIN
  IF NEW.source = 'control' THEN RETURN NULL; END IF;
  IF NEW.kind = 'subject.unlinked' THEN
    UPDATE memory_control.provider_identities SET unlinked_at_ms = NEW.occurred_at_ms
      WHERE issuer = NEW.issuer AND subject = NEW.subject AND unlinked_at_ms IS NULL;
    INSERT INTO memory_ops.provider_revocations(issuer, subject, kind, address, created_at_ms)
      VALUES (NEW.issuer, NEW.subject, 'subject.unlinked', '', NEW.occurred_at_ms)
      ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;
  UPDATE memory_ops.lifecycle_state s
    SET sequence = NEW.sequence, kind = NEW.kind, occurred_at_ms = NEW.occurred_at_ms, event_id = NEW.id
    WHERE s.issuer = NEW.issuer AND s.subject = NEW.subject AND s.address = NEW.address
      AND s.sequence < NEW.sequence AND s.kind <> 'account.deleted';
  INSERT INTO memory_ops.lifecycle_state(issuer, subject, address, sequence, kind, occurred_at_ms, event_id)
    SELECT NEW.issuer, NEW.subject, NEW.address, NEW.sequence, NEW.kind, NEW.occurred_at_ms, NEW.id
    WHERE NOT EXISTS(SELECT 1 FROM memory_ops.lifecycle_state s
      WHERE s.issuer = NEW.issuer AND s.subject = NEW.subject AND s.address = NEW.address);
  RETURN NULL;
END
$apply$;

-- ---------------------------------------------------------------------------
-- Control writer. Shared SQL clock: the regional lineage defines the same
-- function in migrations/0007; the control lineage never applied it, so this
-- is the identical control-side copy needed by append_control_event.
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_control.now_ms() RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $clock$
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
$clock$;
REVOKE ALL ON FUNCTION memory_control.now_ms() FROM PUBLIC;

-- Private definer: only other definer commands call it. The advisory lock
-- serializes control-channel sequence allocation so commit order equals
-- sequence order.
CREATE FUNCTION memory_ops.append_control_event(p_kind text, p_subject text,
    p_address text, p_region text, p_scope text, p_target_id text,
    p_target_issuer text, p_at bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  -- ponytail: one global advisory key serializes all control writes; the
  -- ceiling is admin-rate. Upgrade path is a per-region key + per-region
  -- sequence space.
  PERFORM pg_advisory_xact_lock(hashtext('memory_ops.lifecycle_events:memory:control'));
  INSERT INTO memory_ops.lifecycle_events(id, issuer, subject, sequence, kind,
      address, occurred_at_ms, received_at_ms, signed_at_ms, body_hash,
      source, region, scope, target_id, target_issuer)
    VALUES (replace(gen_random_uuid()::text, '-', ''), 'memory:control', p_subject,
      1 + coalesce((SELECT max(e.sequence) FROM memory_ops.lifecycle_events e
        WHERE e.issuer = 'memory:control'), 0),
      p_kind, p_address, p_at, memory_control.now_ms(), memory_control.now_ms(),
      encode(sha256(convert_to(
        p_kind || p_subject || coalesce(p_target_issuer, '') || p_at::text, 'UTF8')), 'hex'),
      'control', p_region, p_scope, p_target_id, p_target_issuer);
END
$cmd$;
REVOKE ALL ON FUNCTION memory_ops.append_control_event(text, text, text, text, text, text, text, bigint) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Enrollment commands (signatures unchanged from 0006, so the existing
-- GRANTs persist). restored is appended only when the command inserts a new
-- live row AND a prior removed row exists for (id, region); removed is
-- appended when a live row was closed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION memory_control.enroll_account(p_account_id text, p_region text, p_at bigint)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
DECLARE v_reenroll boolean;
BEGIN
  PERFORM memory_control.assert_live_caller_region(p_region);
  INSERT INTO memory_control.accounts(id, created_at_ms) VALUES (p_account_id, p_at)
    ON CONFLICT (id) DO NOTHING;
  SELECT EXISTS(SELECT 1 FROM memory_control.account_enrollments
    WHERE account_id = p_account_id AND region = p_region AND removed_at_ms IS NOT NULL)
    INTO v_reenroll;
  INSERT INTO memory_control.account_enrollments(account_id, region, enrolled_at_ms)
    SELECT p_account_id, p_region, p_at
    WHERE NOT EXISTS(SELECT 1 FROM memory_control.account_enrollments
      WHERE account_id = p_account_id AND region = p_region AND removed_at_ms IS NULL);
  IF FOUND AND v_reenroll THEN
    PERFORM memory_ops.append_control_event('enrollment.restored',
      'account:' || p_account_id, '', p_region, 'account', p_account_id, NULL, p_at);
  END IF;
END
$cmd$;

CREATE OR REPLACE FUNCTION memory_control.remove_account_enrollment(p_account_id text, p_region text, p_at bigint)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
DECLARE v_closed boolean;
BEGIN
  PERFORM memory_control.assert_live_caller_region(p_region);
  UPDATE memory_control.account_enrollments SET removed_at_ms = p_at
    WHERE account_id = p_account_id AND region = p_region AND removed_at_ms IS NULL;
  v_closed := FOUND;
  IF v_closed THEN
    PERFORM memory_ops.append_control_event('enrollment.removed',
      'account:' || p_account_id, '', p_region, 'account', p_account_id, NULL, p_at);
  END IF;
  RETURN v_closed;
END
$cmd$;

CREATE OR REPLACE FUNCTION memory_control.enroll_organization(p_organization_id text, p_region text, p_at bigint)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
DECLARE v_reenroll boolean;
BEGIN
  PERFORM memory_control.assert_live_caller_region(p_region);
  INSERT INTO memory_control.organizations(id, created_at_ms) VALUES (p_organization_id, p_at)
    ON CONFLICT (id) DO NOTHING;
  SELECT EXISTS(SELECT 1 FROM memory_control.organization_enrollments
    WHERE organization_id = p_organization_id AND region = p_region AND removed_at_ms IS NOT NULL)
    INTO v_reenroll;
  INSERT INTO memory_control.organization_enrollments(organization_id, region, enrolled_at_ms)
    SELECT p_organization_id, p_region, p_at
    WHERE NOT EXISTS(SELECT 1 FROM memory_control.organization_enrollments
      WHERE organization_id = p_organization_id AND region = p_region AND removed_at_ms IS NULL);
  IF FOUND AND v_reenroll THEN
    PERFORM memory_ops.append_control_event('enrollment.restored',
      'organization:' || p_organization_id, '', p_region, 'organization', p_organization_id, NULL, p_at);
  END IF;
END
$cmd$;

CREATE OR REPLACE FUNCTION memory_control.remove_organization_enrollment(p_organization_id text, p_region text, p_at bigint)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
DECLARE v_closed boolean;
BEGIN
  PERFORM memory_control.assert_live_caller_region(p_region);
  UPDATE memory_control.organization_enrollments SET removed_at_ms = p_at
    WHERE organization_id = p_organization_id AND region = p_region AND removed_at_ms IS NULL;
  v_closed := FOUND;
  IF v_closed THEN
    PERFORM memory_ops.append_control_event('enrollment.removed',
      'organization:' || p_organization_id, '', p_region, 'organization', p_organization_id, NULL, p_at);
  END IF;
  RETURN v_closed;
END
$cmd$;

-- Console/admin origin for SSO-subject unlink: stamps the binding's terminal
-- unlinked_at_ms (the immutable trigger already forbids clearing a set
-- value) and journals a global control event. Returns whether a live
-- binding was closed.
CREATE FUNCTION memory_control.unlink_subject(p_issuer text, p_subject text, p_at bigint)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
DECLARE v_unlinked boolean;
BEGIN
  UPDATE memory_control.provider_identities SET unlinked_at_ms = p_at
    WHERE issuer = p_issuer AND subject = p_subject AND unlinked_at_ms IS NULL;
  v_unlinked := FOUND;
  IF v_unlinked THEN
    PERFORM memory_ops.append_control_event('subject.unlinked', p_subject, '',
      NULL, NULL, NULL, p_issuer, p_at);
  END IF;
  RETURN v_unlinked;
END
$cmd$;
REVOKE ALL ON FUNCTION memory_control.unlink_subject(text, text, bigint) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Bounded central-journal read, recreated for the new columns. Provider rows
-- stay globally readable; control rows are visible only when global
-- (region IS NULL) or addressed to the caller's attested region. An unset
-- memory.caller_region (owner/test sessions) sees all control rows.
-- ---------------------------------------------------------------------------
DROP FUNCTION memory_ops.lifecycle_events_after(text, bigint, integer);
CREATE FUNCTION memory_ops.lifecycle_events_after(p_issuer text, p_after bigint, p_limit integer)
  RETURNS TABLE(id text, issuer text, subject text, sequence bigint, kind text,
    address text, occurred_at_ms bigint, source text, region text, scope text,
    target_id text, target_issuer text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $cmd$
BEGIN
  RETURN QUERY
    SELECT e.id::text, e.issuer, e.subject, e.sequence, e.kind, e.address,
      e.occurred_at_ms::bigint, e.source, e.region, e.scope, e.target_id::text,
      e.target_issuer
    FROM memory_ops.lifecycle_events e
    WHERE e.issuer = p_issuer AND e.sequence > p_after
      AND (e.source = 'provider' OR e.region IS NULL
        OR memory_control.caller_region() IS NULL
        OR e.region = memory_control.caller_region())
    ORDER BY e.sequence LIMIT least(greatest(p_limit, 1), 1000);
END
$cmd$;
REVOKE ALL ON FUNCTION memory_ops.lifecycle_events_after(text, bigint, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Boundary discipline. No new tables — the journal columns inherit the 0003
-- RLS/no_delete/no_truncate triggers. EXECUTE on the command entry points
-- only; append_control_event stays private to owner (definer callers only).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION memory_ops.lifecycle_event_guard(),
  memory_ops.lifecycle_apply_state(),
  memory_ops.append_control_event(text, text, text, text, text, text, text, bigint),
  memory_control.enroll_account(text, text, bigint),
  memory_control.remove_account_enrollment(text, text, bigint),
  memory_control.enroll_organization(text, text, bigint),
  memory_control.remove_organization_enrollment(text, text, bigint),
  memory_control.unlink_subject(text, text, bigint),
  memory_ops.lifecycle_events_after(text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_control.unlink_subject(text, text, bigint) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_ops.lifecycle_events_after(text, bigint, integer) TO memory_runtime;

DO $private_objects$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.now_ms() FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_ops.append_control_event(text, text, text, text, text, text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.enroll_account(text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.remove_account_enrollment(text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.enroll_organization(text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.remove_organization_enrollment(text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_control.unlink_subject(text, text, bigint) FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_ops.lifecycle_event_guard() FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_ops.lifecycle_apply_state() FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION memory_ops.lifecycle_events_after(text, bigint, integer) FROM %I', api_role);
    END IF;
  END LOOP;
END
$private_objects$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (7, '0007_central_identity_events.sql');
COMMIT;

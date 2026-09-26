-- Regional lineage, version 6. Regional identity-authority tables ported from
-- D1 migration 0001's remaining tables (domains, domain_managers,
-- email_challenges, email_consumptions, revocations, email_blocks,
-- audit_events), plus the regional lifecycle-apply state the central journal
-- feeds (docs/plans/2026-09-16-postgres-regional-authority.md).
--
-- Audited trigger behavior is preserved: admission guards, cascades and
-- append-only/immutable rules stay as triggers so they constrain even
-- owner/migration writes. Subqueries cannot appear in WHEN clauses, so guards
-- run inside plpgsql functions. No live command functions yet — runtime still
-- has no DML on these tables; the services port (P-3/P-5) adds the reviewed
-- SECURITY DEFINER commands that issue these writes.
BEGIN;
SET LOCAL ROLE memory_owner;

-- ---------------------------------------------------------------------------
-- Regional lifecycle-apply state. Populated only by the regional apply unit;
-- nothing here is application-writable.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_ops.lifecycle_applied_state (
  issuer text NOT NULL,
  subject text NOT NULL,
  address text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  kind text NOT NULL,
  occurred_at_ms memory_control.epoch_ms NOT NULL,
  event_id memory_control.identifier NOT NULL,
  PRIMARY KEY (issuer, subject, address)
);
-- The region's applied position in the central journal, per issuer.
CREATE TABLE memory_ops.lifecycle_apply_head (
  issuer text PRIMARY KEY,
  applied_sequence bigint NOT NULL CHECK (applied_sequence BETWEEN 0 AND 9007199254740991),
  applied_at_ms memory_control.epoch_ms NOT NULL
);

-- ---------------------------------------------------------------------------
-- Domains and manager delegations.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_identity.domains (
  id memory_control.identifier PRIMARY KEY,
  organization_id memory_control.identifier NOT NULL REFERENCES memory_control.organizations(id),
  name text NOT NULL CHECK (name = lower(btrim(name)) AND position('.' IN name) > 1),
  verified_until memory_control.epoch_ms NOT NULL,
  revoked_at memory_control.epoch_ms
);
CREATE UNIQUE INDEX one_live_domain_owner ON memory_identity.domains(name) WHERE revoked_at IS NULL;
CREATE TRIGGER domains_immutable BEFORE UPDATE ON memory_identity.domains
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at))
  EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_identity.domain_managers (
  domain_id memory_control.identifier NOT NULL REFERENCES memory_identity.domains(id),
  membership_id memory_control.identifier NOT NULL REFERENCES memory_identity.memberships(id),
  revoked_at memory_control.epoch_ms,
  PRIMARY KEY (domain_id, membership_id)
);
CREATE TRIGGER domain_managers_immutable BEFORE UPDATE ON memory_identity.domain_managers
  FOR EACH ROW WHEN (NEW.domain_id IS DISTINCT FROM OLD.domain_id
    OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at))
  EXECUTE FUNCTION memory_control.reject_mutation();

-- ---------------------------------------------------------------------------
-- Email verification flow and claim ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_identity.email_challenges (
  id memory_control.identifier PRIMARY KEY,
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  address text NOT NULL CHECK (address = lower(btrim(address))),
  domain text NOT NULL CHECK (right(address, length(domain) + 1) = '@' || domain
    AND position('@' IN address) = length(address) - length(domain)),
  token_digest text NOT NULL UNIQUE CHECK (token_digest COLLATE "C" ~ '^[0-9a-f]{64}$'),
  expires_at memory_control.epoch_ms NOT NULL,
  used_at memory_control.epoch_ms,
  invalidated_at memory_control.epoch_ms
);
CREATE INDEX challenges_address ON memory_identity.email_challenges(address);
CREATE TRIGGER challenges_immutable BEFORE UPDATE ON memory_identity.email_challenges
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.address IS DISTINCT FROM OLD.address OR NEW.domain IS DISTINCT FROM OLD.domain
    OR NEW.token_digest IS DISTINCT FROM OLD.token_digest OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
    OR (OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE FUNCTION memory_identity.challenge_not_blocked() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.email_blocks b WHERE b.address = NEW.address)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'email address blocked'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER challenges_not_blocked BEFORE INSERT ON memory_identity.email_challenges
  FOR EACH ROW EXECUTE FUNCTION memory_identity.challenge_not_blocked();

CREATE TABLE memory_identity.email_consumptions (
  id memory_control.identifier PRIMARY KEY,
  challenge_id memory_control.identifier NOT NULL UNIQUE REFERENCES memory_identity.email_challenges(id),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  created_at memory_control.epoch_ms NOT NULL
);
CREATE TRIGGER consumptions_append_only BEFORE UPDATE OR DELETE ON memory_identity.email_consumptions
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_identity.revocations (
  id memory_control.identifier PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('self', 'domain')),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  email_id memory_control.identifier REFERENCES memory_identity.account_emails(id),
  domain_id memory_control.identifier REFERENCES memory_identity.domains(id),
  address text,
  created_at memory_control.epoch_ms NOT NULL,
  CHECK ((kind = 'self' AND email_id IS NOT NULL AND domain_id IS NULL AND address IS NULL)
    OR (kind = 'domain' AND email_id IS NULL AND domain_id IS NOT NULL AND address IS NOT NULL))
);
CREATE TRIGGER revocations_append_only BEFORE UPDATE OR DELETE ON memory_identity.revocations
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_identity.email_blocks (
  address text PRIMARY KEY CHECK (address = lower(btrim(address))),
  domain_id memory_control.identifier NOT NULL REFERENCES memory_identity.domains(id),
  revocation_id memory_control.identifier NOT NULL REFERENCES memory_identity.revocations(id),
  created_at memory_control.epoch_ms NOT NULL
);
CREATE TRIGGER blocks_permanent BEFORE UPDATE OR DELETE ON memory_identity.email_blocks
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

-- Identifier-only audit ledger; no free text or payload columns.
CREATE TABLE memory_ops.identity_audit_events (
  id memory_control.identifier PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN
    ('email_verified', 'email_revoked', 'membership_revoked', 'credential_revoked',
     'self_revocation', 'domain_revocation')),
  actor_credential_id memory_control.identifier REFERENCES memory_identity.credentials(id),
  account_id memory_control.identifier REFERENCES memory_identity.accounts(id),
  email_id memory_control.identifier REFERENCES memory_identity.account_emails(id),
  organization_id memory_control.identifier REFERENCES memory_control.organizations(id),
  membership_id memory_control.identifier REFERENCES memory_identity.memberships(id),
  credential_id memory_control.identifier REFERENCES memory_identity.credentials(id),
  domain_id memory_control.identifier REFERENCES memory_identity.domains(id),
  revocation_id memory_control.identifier REFERENCES memory_identity.revocations(id),
  created_at memory_control.epoch_ms NOT NULL
);
CREATE TRIGGER identity_audit_append_only BEFORE UPDATE OR DELETE ON memory_ops.identity_audit_events
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

-- ---------------------------------------------------------------------------
-- Live views. Identical to the D1 0024 shapes but the lifecycle predicate reads
-- the region's applied state instead of the central journal.
-- ---------------------------------------------------------------------------
CREATE VIEW memory_identity.active_memberships AS
  SELECT m.* FROM memory_identity.memberships m
  JOIN memory_identity.accounts a ON a.id = m.account_id AND a.disabled_at IS NULL
  JOIN memory_control.organizations o ON o.id = m.organization_id AND o.disabled_at IS NULL
  JOIN memory_identity.account_emails e ON e.id = m.email_id AND e.account_id = m.account_id
    AND e.revoked_at IS NULL
  WHERE m.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_ops.lifecycle_applied_state l
        ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = ''
      WHERE p.account_id = m.account_id AND l.kind <> 'account.resumed');

CREATE VIEW memory_identity.active_credentials AS
  SELECT c.*, coalesce(m.expires_at, 9007199254740991) AS membership_expires_at
  FROM memory_identity.credentials c
  JOIN memory_identity.accounts a ON a.id = c.account_id AND a.disabled_at IS NULL
  LEFT JOIN memory_identity.active_memberships m ON m.id = c.membership_id
    AND m.account_id = c.account_id AND m.email_id = c.email_id
  WHERE c.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_ops.lifecycle_applied_state l
        ON l.issuer = p.issuer AND l.subject = p.subject AND l.address = ''
      WHERE p.account_id = c.account_id AND l.kind <> 'account.resumed')
    AND (c.kind IN ('session', 'personal_key') OR m.id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Admission guards (the D1 INSERT-time WHEN predicates, in function bodies).
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_identity.claim_not_blocked() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.email_blocks b WHERE b.address = NEW.address)
    OR NOT EXISTS(SELECT 1 FROM memory_identity.accounts a
      WHERE a.id = NEW.account_id AND a.disabled_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'email claim denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER claims_not_blocked BEFORE INSERT ON memory_identity.account_emails
  FOR EACH ROW EXECUTE FUNCTION memory_identity.claim_not_blocked();

CREATE FUNCTION memory_identity.membership_live_claim() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.account_emails e
      JOIN memory_identity.accounts a ON a.id = e.account_id
      JOIN memory_control.organizations o ON o.id = NEW.organization_id
      WHERE e.id = NEW.email_id AND e.account_id = NEW.account_id AND e.revoked_at IS NULL
        AND a.disabled_at IS NULL AND o.disabled_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'inactive membership claim'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER memberships_live_claim BEFORE INSERT ON memory_identity.memberships
  FOR EACH ROW EXECUTE FUNCTION memory_identity.membership_live_claim();

CREATE FUNCTION memory_identity.credential_live_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.accounts
      WHERE id = NEW.account_id AND disabled_at IS NULL)
    OR (NEW.membership_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_identity.active_memberships m
      WHERE m.id = NEW.membership_id AND m.account_id = NEW.account_id AND m.email_id = NEW.email_id))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'inactive credential binding'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER credentials_live_binding BEFORE INSERT ON memory_identity.credentials
  FOR EACH ROW EXECUTE FUNCTION memory_identity.credential_live_binding();

CREATE FUNCTION memory_identity.domain_manager_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.domains d
      JOIN memory_identity.active_memberships m ON m.organization_id = d.organization_id
      WHERE d.id = NEW.domain_id AND m.id = NEW.membership_id
        AND m.role IN ('owner', 'admin') AND d.revoked_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid domain delegation'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER domain_managers_binding BEFORE INSERT ON memory_identity.domain_managers
  FOR EACH ROW EXECUTE FUNCTION memory_identity.domain_manager_binding();

-- ---------------------------------------------------------------------------
-- Ledger behavior: consumption issues the claim, revocation cascades, and
-- revocations audit themselves — identical effects to the D1 triggers.
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_identity.consume_email_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_identity.account_emails(id, account_id, address, domain, verified_at)
    SELECT NEW.id, account_id, address, domain, NEW.created_at
    FROM memory_identity.email_challenges WHERE id = NEW.challenge_id;
  UPDATE memory_identity.email_challenges SET used_at = NEW.created_at WHERE id = NEW.challenge_id;
  INSERT INTO memory_ops.identity_audit_events(id, event_type, actor_credential_id, account_id, email_id, created_at)
    SELECT replace(gen_random_uuid()::text, '-', ''), 'email_verified', NEW.actor_credential_id,
      account_id, NEW.id, NEW.created_at
    FROM memory_identity.email_challenges WHERE id = NEW.challenge_id;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER consume_email AFTER INSERT ON memory_identity.email_consumptions
  FOR EACH ROW EXECUTE FUNCTION memory_identity.consume_email_apply();

CREATE FUNCTION memory_identity.consume_email_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.email_challenges p
      JOIN memory_identity.active_credentials c ON c.account_id = p.account_id
      WHERE p.id = NEW.challenge_id AND c.id = NEW.actor_credential_id AND c.kind = 'session'
        AND c.membership_id IS NULL AND c.expires_at > NEW.created_at
        AND c.reauthenticated_at BETWEEN NEW.created_at - 300000 AND NEW.created_at
        AND p.expires_at > NEW.created_at AND p.used_at IS NULL AND p.invalidated_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM memory_identity.email_blocks b WHERE b.address = p.address))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'email consumption denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER consume_email_validate BEFORE INSERT ON memory_identity.email_consumptions
  FOR EACH ROW EXECUTE FUNCTION memory_identity.consume_email_validate();

CREATE FUNCTION memory_identity.revocation_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW.kind = 'self' AND NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.account_emails e ON e.account_id = c.account_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.membership_id IS NULL
        AND c.expires_at > NEW.created_at
        AND c.reauthenticated_at BETWEEN NEW.created_at - 300000 AND NEW.created_at
        AND e.id = NEW.email_id AND e.revoked_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'self revocation denied'; END IF;
  IF NEW.kind = 'domain' AND NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.active_memberships m ON m.account_id = c.account_id
      JOIN memory_identity.domain_managers g ON g.membership_id = m.id AND g.revoked_at IS NULL
      JOIN memory_identity.domains d ON d.id = g.domain_id AND d.organization_id = m.organization_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.membership_id IS NULL
        AND c.expires_at > NEW.created_at
        AND c.reauthenticated_at BETWEEN NEW.created_at - 300000 AND NEW.created_at
        AND m.expires_at > NEW.created_at AND m.role IN ('owner', 'admin')
        AND d.id = NEW.domain_id AND d.verified_until > NEW.created_at AND d.revoked_at IS NULL
        AND NEW.address = lower(btrim(NEW.address))
        AND right(NEW.address, length(d.name)) = d.name
        AND position('@' IN NEW.address) = length(NEW.address) - length(d.name))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'domain revocation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER revocation_validate BEFORE INSERT ON memory_identity.revocations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.revocation_validate();

CREATE FUNCTION memory_identity.apply_revocation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_identity.email_blocks(address, domain_id, revocation_id, created_at)
    SELECT NEW.address, NEW.domain_id, NEW.id, NEW.created_at WHERE NEW.kind = 'domain'
      AND NOT EXISTS(SELECT 1 FROM memory_identity.email_blocks WHERE address = NEW.address);
  UPDATE memory_identity.email_challenges SET invalidated_at = NEW.created_at
    WHERE used_at IS NULL AND invalidated_at IS NULL
      AND ((NEW.kind = 'domain' AND address = NEW.address)
        OR (NEW.kind = 'self' AND EXISTS(SELECT 1 FROM memory_identity.account_emails e
          WHERE e.id = NEW.email_id AND e.address = email_challenges.address
            AND e.account_id = email_challenges.account_id)));
  UPDATE memory_identity.account_emails SET revoked_at = NEW.created_at WHERE revoked_at IS NULL
    AND ((NEW.kind = 'self' AND id = NEW.email_id) OR (NEW.kind = 'domain' AND address = NEW.address));
  INSERT INTO memory_ops.identity_audit_events(id, event_type, actor_credential_id, email_id,
      domain_id, revocation_id, created_at)
    VALUES(replace(gen_random_uuid()::text, '-', ''), NEW.kind || '_revocation',
      NEW.actor_credential_id, NEW.email_id, NEW.domain_id, NEW.id, NEW.created_at);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER apply_revocation AFTER INSERT ON memory_identity.revocations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.apply_revocation();

CREATE FUNCTION memory_identity.cascade_email_revocation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $cascade$
BEGIN
  UPDATE memory_identity.memberships SET revoked_at = NEW.revoked_at WHERE email_id = NEW.id AND revoked_at IS NULL;
  UPDATE memory_identity.credentials SET revoked_at = NEW.revoked_at WHERE email_id = NEW.id AND revoked_at IS NULL;
  UPDATE memory_identity.email_challenges SET invalidated_at = NEW.revoked_at
    WHERE account_id = NEW.account_id AND address = NEW.address AND used_at IS NULL AND invalidated_at IS NULL;
  INSERT INTO memory_ops.identity_audit_events(id, event_type, account_id, email_id, created_at)
    VALUES(replace(gen_random_uuid()::text, '-', ''), 'email_revoked', NEW.account_id, NEW.id, NEW.revoked_at);
  RETURN NULL;
END
$cascade$;
CREATE TRIGGER cascade_email_revocation AFTER UPDATE OF revoked_at ON memory_identity.account_emails
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION memory_identity.cascade_email_revocation();

CREATE FUNCTION memory_identity.cascade_membership_revocation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $cascade$
BEGIN
  UPDATE memory_identity.credentials SET revoked_at = NEW.revoked_at WHERE membership_id = NEW.id AND revoked_at IS NULL;
  UPDATE memory_identity.domain_managers SET revoked_at = NEW.revoked_at WHERE membership_id = NEW.id AND revoked_at IS NULL;
  INSERT INTO memory_ops.identity_audit_events(id, event_type, account_id, email_id, organization_id,
      membership_id, created_at)
    VALUES(replace(gen_random_uuid()::text, '-', ''), 'membership_revoked', NEW.account_id,
      NEW.email_id, NEW.organization_id, NEW.id, NEW.revoked_at);
  RETURN NULL;
END
$cascade$;
CREATE TRIGGER cascade_membership_revocation AFTER UPDATE OF revoked_at ON memory_identity.memberships
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION memory_identity.cascade_membership_revocation();

CREATE FUNCTION memory_identity.audit_credential_revocation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $cascade$
BEGIN
  INSERT INTO memory_ops.identity_audit_events(id, event_type, account_id, email_id, membership_id,
      credential_id, created_at)
    VALUES(replace(gen_random_uuid()::text, '-', ''), 'credential_revoked', NEW.account_id,
      NEW.email_id, NEW.membership_id, NEW.id, NEW.revoked_at);
  RETURN NULL;
END
$cascade$;
CREATE TRIGGER audit_credential_revocation AFTER UPDATE OF revoked_at ON memory_identity.credentials
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION memory_identity.audit_credential_revocation();

-- ---------------------------------------------------------------------------
-- Boundaries and grants. Identity tables keep the 0003 discipline: forced RLS,
-- owner-only policy, no runtime access. The ops ledger and lifecycle-apply
-- tables are likewise owner-only until the command/apply units land.
-- ---------------------------------------------------------------------------
DO $boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'memory_identity.domains', 'memory_identity.domain_managers',
    'memory_identity.email_challenges', 'memory_identity.email_consumptions',
    'memory_identity.revocations', 'memory_identity.email_blocks',
    'memory_ops.identity_audit_events', 'memory_ops.lifecycle_applied_state',
    'memory_ops.lifecycle_apply_head'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING (true) WITH CHECK (true)', target);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()', target);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()', target);
  END LOOP;
END
$boundaries$;

REVOKE ALL ON memory_identity.domains, memory_identity.domain_managers,
  memory_identity.email_challenges, memory_identity.email_consumptions,
  memory_identity.revocations, memory_identity.email_blocks,
  memory_ops.identity_audit_events, memory_ops.lifecycle_applied_state,
  memory_ops.lifecycle_apply_head FROM PUBLIC, memory_runtime, memory_background;
-- Functions owned by other roles (memory_lifecycle, memory_commands) are out of
-- scope; revoke only the functions this migration creates.
REVOKE ALL ON FUNCTION
  memory_identity.challenge_not_blocked(), memory_identity.claim_not_blocked(),
  memory_identity.membership_live_claim(), memory_identity.credential_live_binding(),
  memory_identity.domain_manager_binding(), memory_identity.consume_email_apply(),
  memory_identity.consume_email_validate(), memory_identity.revocation_validate(),
  memory_identity.apply_revocation(), memory_identity.cascade_email_revocation(),
  memory_identity.cascade_membership_revocation(), memory_identity.audit_credential_revocation()
  FROM PUBLIC;
DO $private_objects$
DECLARE api_role text; fn text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON memory_identity.domains, memory_identity.domain_managers,
        memory_identity.email_challenges, memory_identity.email_consumptions,
        memory_identity.revocations, memory_identity.email_blocks,
        memory_ops.identity_audit_events, memory_ops.lifecycle_applied_state,
        memory_ops.lifecycle_apply_head FROM %I', api_role);
      FOREACH fn IN ARRAY ARRAY[
        'challenge_not_blocked()', 'claim_not_blocked()', 'membership_live_claim()',
        'credential_live_binding()', 'domain_manager_binding()', 'consume_email_apply()',
        'consume_email_validate()', 'revocation_validate()', 'apply_revocation()',
        'cascade_email_revocation()', 'cascade_membership_revocation()', 'audit_credential_revocation()'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION memory_identity.%s FROM %I', fn, api_role);
      END LOOP;
    END IF;
  END LOOP;
END
$private_objects$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (6, '0006_identity_authority.sql');
COMMIT;

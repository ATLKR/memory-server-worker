-- Control-plane lineage, version 3. Applied to the control cluster after the
-- shared foundation (migrations/0001_private_namespaces.sql and
-- migrations/0002_deployment_identity.sql). Requires a migration login able to
-- SET ROLE memory_owner. No memberships granted.
--
-- New-model core for the regional-authority architecture
-- (docs/plans/2026-09-16-postgres-regional-authority.md): the region and
-- deployment catalog, the canonical account/organization id skeletons, the
-- central SSO subject bindings, the per-region enrollment directory, the
-- Space placement directory, and the central lifecycle journal. Regional
-- clusters own the full identity/content rows; nothing here carries Space
-- content, emails, memberships, credentials or grants.
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE FUNCTION memory_control.data_policy_shape_valid(policy jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $shape$
  SELECT policy IS NOT NULL AND jsonb_typeof(policy) = 'object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(policy) k)
      = ARRAY['classificationStatus','dataClass','placementEpoch','policyVersion',
              'processingBoundary','profile','residency','sensitivityTags']
    AND jsonb_typeof(policy -> 'policyVersion') = 'number'
    AND jsonb_typeof(policy -> 'residency') = 'string'
    AND jsonb_typeof(policy -> 'profile') = 'string'
    AND jsonb_typeof(policy -> 'processingBoundary') = 'string'
    AND jsonb_typeof(policy -> 'dataClass') = 'string'
    AND jsonb_typeof(policy -> 'classificationStatus') = 'string'
    AND jsonb_typeof(policy -> 'sensitivityTags') = 'array'
    AND jsonb_typeof(policy -> 'placementEpoch') = 'number'
    AND (policy ->> 'placementEpoch')::bigint BETWEEN 1 AND 9007199254740991
    AND policy -> 'policyVersion' = '1'::jsonb;
$shape$;

-- Approved residency regions. Operators add a region row only after the
-- regional deployment itself is verified; retiring blocks new placements.
CREATE TABLE memory_control.regions (
  region text PRIMARY KEY
    CHECK (region COLLATE "C" ~ '^[a-z][a-z0-9-]{0,31}$'),
  added_at_ms memory_control.epoch_ms NOT NULL,
  retired_at_ms memory_control.epoch_ms
);
CREATE TRIGGER regions_immutable BEFORE UPDATE ON memory_control.regions
  FOR EACH ROW WHEN (NEW.region IS DISTINCT FROM OLD.region
    OR NEW.added_at_ms IS DISTINCT FROM OLD.added_at_ms
    OR (OLD.retired_at_ms IS NOT NULL AND NEW.retired_at_ms IS DISTINCT FROM OLD.retired_at_ms))
  EXECUTE FUNCTION memory_control.reject_mutation();

-- Registered deployments, including the control deployment itself. A regional
-- deployment's own memory_control.deployment_identity singleton is the region's
-- authority; this catalog is the routing/directory view.
CREATE TABLE memory_control.deployments (
  deployment_id memory_control.identifier PRIMARY KEY,
  region text NOT NULL REFERENCES memory_control.regions(region),
  processing_policy_id memory_control.identifier NOT NULL,
  added_at_ms memory_control.epoch_ms NOT NULL,
  retired_at_ms memory_control.epoch_ms
);
CREATE TRIGGER deployments_immutable BEFORE UPDATE ON memory_control.deployments
  FOR EACH ROW WHEN (NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
    OR NEW.region IS DISTINCT FROM OLD.region
    OR NEW.processing_policy_id IS DISTINCT FROM OLD.processing_policy_id
    OR NEW.added_at_ms IS DISTINCT FROM OLD.added_at_ms
    OR (OLD.retired_at_ms IS NOT NULL AND NEW.retired_at_ms IS DISTINCT FROM OLD.retired_at_ms))
  EXECUTE FUNCTION memory_control.reject_mutation();

-- Canonical id registry skeletons. disabled_at_ms is the global-disable flag;
-- setting/clearing it is a reviewed owner command (provider lifecycle suspend/
-- resume flows through it). All other identity state lives in the regions.
CREATE TABLE memory_control.accounts (
  id memory_control.identifier PRIMARY KEY,
  created_at_ms memory_control.epoch_ms NOT NULL,
  disabled_at_ms memory_control.epoch_ms
);
CREATE TRIGGER accounts_immutable BEFORE UPDATE ON memory_control.accounts
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms)
  EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_control.organizations (
  id memory_control.identifier PRIMARY KEY,
  created_at_ms memory_control.epoch_ms NOT NULL,
  disabled_at_ms memory_control.epoch_ms
);
CREATE TRIGGER organizations_immutable BEFORE UPDATE ON memory_control.organizations
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms)
  EXECUTE FUNCTION memory_control.reject_mutation();

-- Central SSO subject bindings: the only identity row that is central by
-- design. Unlinking is terminal and journaled; the binding row is retained.
CREATE TABLE memory_control.provider_identities (
  issuer text NOT NULL
    CHECK (length(issuer) BETWEEN 1 AND 2048 AND issuer !~ '[\x00-\x1F\x7F]'),
  subject text NOT NULL
    CHECK (length(subject) BETWEEN 1 AND 512 AND subject !~ '[\x00-\x1F\x7F]'),
  account_id memory_control.identifier NOT NULL REFERENCES memory_control.accounts(id),
  created_at_ms memory_control.epoch_ms NOT NULL,
  unlinked_at_ms memory_control.epoch_ms,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX provider_identities_account ON memory_control.provider_identities(account_id);
CREATE TRIGGER provider_identities_immutable BEFORE UPDATE ON memory_control.provider_identities
  FOR EACH ROW WHEN (NEW.issuer IS DISTINCT FROM OLD.issuer
    OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms
    OR (OLD.unlinked_at_ms IS NOT NULL AND NEW.unlinked_at_ms IS DISTINCT FROM OLD.unlinked_at_ms))
  EXECUTE FUNCTION memory_control.reject_mutation();

-- Enrollment directory: which regions own identity rows for each account and
-- organization. Removal keeps history; a live row is unique per (id, region).
CREATE TABLE memory_control.account_enrollments (
  account_id memory_control.identifier NOT NULL REFERENCES memory_control.accounts(id),
  region text NOT NULL REFERENCES memory_control.regions(region),
  enrolled_at_ms memory_control.epoch_ms NOT NULL,
  removed_at_ms memory_control.epoch_ms
);
CREATE UNIQUE INDEX one_live_account_enrollment
  ON memory_control.account_enrollments(account_id, region) WHERE removed_at_ms IS NULL;
CREATE INDEX account_enrollments_region ON memory_control.account_enrollments(region);
CREATE TRIGGER account_enrollments_immutable BEFORE UPDATE ON memory_control.account_enrollments
  FOR EACH ROW WHEN (NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.region IS DISTINCT FROM OLD.region
    OR NEW.enrolled_at_ms IS DISTINCT FROM OLD.enrolled_at_ms
    OR (OLD.removed_at_ms IS NOT NULL AND NEW.removed_at_ms IS DISTINCT FROM OLD.removed_at_ms))
  EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_control.organization_enrollments (
  organization_id memory_control.identifier NOT NULL REFERENCES memory_control.organizations(id),
  region text NOT NULL REFERENCES memory_control.regions(region),
  enrolled_at_ms memory_control.epoch_ms NOT NULL,
  removed_at_ms memory_control.epoch_ms
);
CREATE UNIQUE INDEX one_live_organization_enrollment
  ON memory_control.organization_enrollments(organization_id, region) WHERE removed_at_ms IS NULL;
CREATE INDEX organization_enrollments_region ON memory_control.organization_enrollments(region);
CREATE TRIGGER organization_enrollments_immutable BEFORE UPDATE ON memory_control.organization_enrollments
  FOR EACH ROW WHEN (NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.region IS DISTINCT FROM OLD.region
    OR NEW.enrolled_at_ms IS DISTINCT FROM OLD.enrolled_at_ms
    OR (OLD.removed_at_ms IS NOT NULL AND NEW.removed_at_ms IS DISTINCT FROM OLD.removed_at_ms))
  EXECUTE FUNCTION memory_control.reject_mutation();

-- Space placement directory (skeleton). The serving row lives in home_region;
-- this is the only global Space record. home_region/data_policy change only
-- through a re-placement that strictly increases placement_epoch; a closed
-- Space is frozen. The data_policy residency must equal home_region and the
-- policy's placementEpoch must equal placement_epoch (null-safe checks).
CREATE TABLE memory_control.spaces (
  id memory_control.identifier PRIMARY KEY,
  owner_account_id memory_control.identifier REFERENCES memory_control.accounts(id),
  organization_id memory_control.identifier REFERENCES memory_control.organizations(id),
  home_region text NOT NULL REFERENCES memory_control.regions(region),
  data_policy jsonb NOT NULL,
  placement_epoch bigint NOT NULL CHECK (placement_epoch BETWEEN 1 AND 9007199254740991),
  created_at_ms memory_control.epoch_ms NOT NULL,
  closed_at_ms memory_control.epoch_ms,
  CHECK ((owner_account_id IS NOT NULL) <> (organization_id IS NOT NULL)),
  CHECK (memory_control.data_policy_shape_valid(data_policy)),
  CHECK (data_policy ->> 'residency' IS NOT NULL AND data_policy ->> 'residency' = home_region),
  CHECK ((data_policy ->> 'placementEpoch') IS NOT NULL
    AND (data_policy ->> 'placementEpoch')::bigint = placement_epoch)
);
CREATE INDEX spaces_home_region ON memory_control.spaces(home_region);
CREATE INDEX spaces_owner ON memory_control.spaces(owner_account_id);
CREATE INDEX spaces_organization ON memory_control.spaces(organization_id);
CREATE TRIGGER spaces_placement_guard BEFORE UPDATE ON memory_control.spaces
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms
    OR OLD.closed_at_ms IS NOT NULL
    OR NEW.placement_epoch < OLD.placement_epoch
    OR ((NEW.home_region IS DISTINCT FROM OLD.home_region
        OR NEW.data_policy IS DISTINCT FROM OLD.data_policy)
        AND NEW.placement_epoch <= OLD.placement_epoch))
  EXECUTE FUNCTION memory_control.reject_mutation();

-- Central lifecycle journal (port of the D1 release_identity_lifecycle_* and
-- webhook/provider-revocation tables into memory_ops). Regions apply these
-- events through their own apply-head; the regional side-effects the D1
-- triggers performed on credentials/memberships/emails are intentionally
-- absent here — they are regional apply work, not central tables.
CREATE TABLE memory_ops.webhook_events (
  provider text NOT NULL CHECK (provider COLLATE "C" ~ '^[a-z][a-z0-9_-]{0,31}$'),
  event_id memory_control.identifier NOT NULL,
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  created_at_ms memory_control.epoch_ms NOT NULL,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE memory_ops.lifecycle_jwt_proofs (
  event_id memory_control.identifier PRIMARY KEY,
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  issued_at_ms memory_control.epoch_ms NOT NULL,
  expires_at_ms memory_control.epoch_ms NOT NULL
    CHECK (expires_at_ms > issued_at_ms AND expires_at_ms - issued_at_ms <= 900000)
);
CREATE TRIGGER lifecycle_jwt_time BEFORE INSERT ON memory_ops.lifecycle_jwt_proofs
  FOR EACH ROW WHEN (NEW.issued_at_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
    OR NEW.expires_at_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
  EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_ops.lifecycle_events (
  id memory_control.identifier PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  kind text NOT NULL CHECK (kind IN ('account.suspended', 'account.resumed', 'account.deleted',
    'email.revoked', 'email.verified')),
  address text NOT NULL,
  occurred_at_ms memory_control.epoch_ms NOT NULL,
  received_at_ms memory_control.epoch_ms NOT NULL,
  signed_at_ms memory_control.epoch_ms NOT NULL,
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (issuer, sequence),
  CHECK ((kind LIKE 'account.%' AND address = '')
    OR (kind LIKE 'email.%' AND address = lower(btrim(address))
      AND length(address) BETWEEN 3 AND 254))
);
-- WHEN clauses cannot contain subqueries; receipt and freshness checks run in
-- the guard body. Equivalent to the D1 receipt/time triggers.
CREATE FUNCTION memory_ops.lifecycle_event_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
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
CREATE TRIGGER lifecycle_event_guard BEFORE INSERT ON memory_ops.lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION memory_ops.lifecycle_event_guard();

CREATE TABLE memory_ops.lifecycle_state (
  issuer text NOT NULL,
  subject text NOT NULL,
  address text NOT NULL,
  sequence bigint NOT NULL,
  kind text NOT NULL,
  occurred_at_ms memory_control.epoch_ms NOT NULL,
  event_id memory_control.identifier NOT NULL REFERENCES memory_ops.lifecycle_events(id),
  PRIMARY KEY (issuer, subject, address)
);
CREATE FUNCTION memory_ops.lifecycle_state_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.issuer IS DISTINCT FROM OLD.issuer
      OR NEW.subject IS DISTINCT FROM OLD.subject
      OR NEW.address IS DISTINCT FROM OLD.address
      OR NEW.sequence <= OLD.sequence OR OLD.kind = 'account.deleted')
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'memory_immutable_record'; END IF;
  IF NOT EXISTS(SELECT 1 FROM memory_ops.lifecycle_events e
      WHERE e.id = NEW.event_id AND e.issuer = NEW.issuer AND e.subject = NEW.subject
        AND e.address = NEW.address AND e.sequence = NEW.sequence AND e.kind = NEW.kind
        AND e.occurred_at_ms = NEW.occurred_at_ms)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'memory_immutable_record'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER lifecycle_state_insert BEFORE INSERT ON memory_ops.lifecycle_state
  FOR EACH ROW EXECUTE FUNCTION memory_ops.lifecycle_state_guard();
CREATE TRIGGER lifecycle_state_update BEFORE UPDATE ON memory_ops.lifecycle_state
  FOR EACH ROW EXECUTE FUNCTION memory_ops.lifecycle_state_guard();
CREATE FUNCTION memory_ops.lifecycle_apply_state() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
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
CREATE TRIGGER lifecycle_state_apply AFTER INSERT ON memory_ops.lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION memory_ops.lifecycle_apply_state();

-- Provider-level tombstones survive missing local mappings so a still-valid
-- pre-revocation JWT cannot recreate authority.
CREATE TABLE memory_ops.provider_revocations (
  issuer text NOT NULL,
  subject text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('account.disabled', 'email.revoked')),
  address text NOT NULL,
  created_at_ms memory_control.epoch_ms NOT NULL,
  PRIMARY KEY (issuer, subject, kind, address)
);

-- Row boundaries and grants.
DO $boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'memory_control.regions', 'memory_control.deployments',
    'memory_control.accounts', 'memory_control.organizations',
    'memory_control.provider_identities', 'memory_control.account_enrollments',
    'memory_control.organization_enrollments', 'memory_control.spaces',
    'memory_ops.webhook_events', 'memory_ops.lifecycle_jwt_proofs',
    'memory_ops.lifecycle_events', 'memory_ops.lifecycle_state',
    'memory_ops.provider_revocations'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING (true) WITH CHECK (true)', target);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()', target);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()', target);
  END LOOP;
  -- The directory is runtime-readable: routing and sign-in resolution SELECT
  -- under RLS, while no policy grants writes. Journal tables stay owner-only.
  FOREACH target IN ARRAY ARRAY[
    'memory_control.regions', 'memory_control.deployments',
    'memory_control.accounts', 'memory_control.organizations',
    'memory_control.provider_identities', 'memory_control.account_enrollments',
    'memory_control.organization_enrollments', 'memory_control.spaces'] LOOP
    EXECUTE format('CREATE POLICY directory_read ON %s TO memory_runtime, memory_background USING (true)', target);
  END LOOP;
END
$boundaries$;

-- Runtime reads the directory for routing and sign-in resolution only. The
-- lifecycle journal, webhook receipts and revocation tombstones stay
-- owner-written; regional apply/dispatcher access is added with that unit.
GRANT SELECT ON memory_control.regions, memory_control.deployments,
  memory_control.accounts, memory_control.organizations,
  memory_control.provider_identities, memory_control.account_enrollments,
  memory_control.organization_enrollments, memory_control.spaces
  TO memory_runtime, memory_background;
REVOKE ALL ON memory_ops.webhook_events, memory_ops.lifecycle_jwt_proofs,
  memory_ops.lifecycle_events, memory_ops.lifecycle_state,
  memory_ops.provider_revocations FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON FUNCTION memory_ops.lifecycle_apply_state(),
  memory_ops.lifecycle_event_guard(), memory_ops.lifecycle_state_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_control.data_policy_shape_valid(jsonb) FROM PUBLIC;
DO $private_objects$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA memory_control FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA memory_ops FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA memory_control FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA memory_ops FROM %I', api_role);
    END IF;
  END LOOP;
END
$private_objects$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (3, '0003_placement_directory.sql');
COMMIT;

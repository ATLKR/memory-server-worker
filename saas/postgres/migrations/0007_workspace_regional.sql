-- Regional lineage, version 7. Workspace command records and OAuth/hierarchy/
-- SCIM/domain-verification identity tables ported from D1 migrations
-- 0003, 0004, 0005, 0006 (credential_policies, domain_challenges, scim_keys,
-- reauth_challenges, external_email_blocks, mail_budget), 0010
-- (scim_deletions) and 0020 (domain_verifications), per the frozen
-- classification (docs/plans/2026-09-17-residency-data-classification.md).
--
-- Differences from a literal port:
-- - Command rows that create a Space (sign-in, org creation, child-org
--   creation) carry the declared `data_policy`; residency is asserted against
--   this cluster's deployment_identity inside the apply functions.
-- - The regional serving Space row is `memory_control.spaces` (the Seoul
--   slice's table evolves into the general serving row): this migration adds
--   the serving columns (name, security_mode, created_at_ms,
--   actor_credential_id) as nullable; reviewed commands always populate them.
-- - `RAISE(IGNORE)` becomes `RETURN NULL` (silent row skip).
-- - Provider-revocation tombstones are applied regionally into
--   memory_ops.provider_revocations by the lifecycle-apply unit.
-- - SQLite INTEGER PRIMARY KEY autoincrement becomes GENERATED ALWAYS
--   AS IDENTITY; randomblob(16) audit ids become uuid hex.
BEGIN;
SET LOCAL ROLE memory_owner;

-- Regional copy of the policy shape validator (control/0003 defines the same
-- function on the control cluster; it does not exist on regional clusters).
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
REVOKE ALL ON FUNCTION memory_control.data_policy_shape_valid(jsonb) FROM PUBLIC;

-- The serving columns on the regional Space row.
ALTER TABLE memory_control.spaces
  ADD COLUMN name text CHECK (name IS NULL OR (name !~ '[\x00-\x1F\x7F]'
    AND length(name) BETWEEN 1 AND 100 AND length(btrim(name)) > 0)),
  ADD COLUMN security_mode text CHECK (security_mode IS NULL OR security_mode = 'managed'),
  ADD COLUMN created_at_ms memory_control.epoch_ms,
  ADD COLUMN actor_credential_id memory_control.identifier REFERENCES memory_identity.credentials(id);
CREATE INDEX spaces_owner ON memory_control.spaces(owner_account_id);
CREATE INDEX spaces_organization ON memory_control.spaces(organization_id);

-- ---------------------------------------------------------------------------
-- Workspace command tables. All are append-only transaction records.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_identity.workspace_sign_ins (
  id memory_control.identifier PRIMARY KEY,
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048 AND issuer !~ '[\x00-\x1F\x7F]'),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 512 AND subject !~ '[\x00-\x1F\x7F]'),
  new_account_id memory_control.identifier NOT NULL,
  credential_id memory_control.identifier NOT NULL,
  token_digest text NOT NULL CHECK (token_digest COLLATE "C" ~ '^[0-9a-f]{64}$'),
  expires_at memory_control.epoch_ms NOT NULL,
  permission text NOT NULL CHECK (permission IN ('read', 'write')),
  email_id memory_control.identifier NOT NULL,
  address text,
  domain text,
  personal_space_id memory_control.identifier NOT NULL,
  data_policy jsonb NOT NULL CHECK (memory_control.data_policy_shape_valid(data_policy)),
  created_at memory_control.epoch_ms NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + 900000),
  CHECK ((address IS NULL AND domain IS NULL) OR (address IS NOT NULL AND domain IS NOT NULL))
);

CREATE TABLE memory_identity.workspace_organization_creations (
  id memory_control.identifier PRIMARY KEY,
  name text NOT NULL CHECK (name !~ '[\x00-\x1F\x7F]' AND length(name) BETWEEN 1 AND 100
    AND length(btrim(name)) > 0),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  email_id memory_control.identifier NOT NULL REFERENCES memory_identity.account_emails(id),
  membership_id memory_control.identifier NOT NULL,
  space_id memory_control.identifier NOT NULL,
  data_policy jsonb NOT NULL CHECK (memory_control.data_policy_shape_valid(data_policy)),
  created_at memory_control.epoch_ms NOT NULL
);

CREATE TABLE memory_identity.workspace_organization_metadata (
  organization_id memory_control.identifier PRIMARY KEY REFERENCES memory_control.organizations(id),
  name text NOT NULL CHECK (name !~ '[\x00-\x1F\x7F]' AND length(name) BETWEEN 1 AND 100
    AND length(btrim(name)) > 0)
);

CREATE TABLE memory_identity.workspace_invitations (
  id memory_control.identifier PRIMARY KEY,
  organization_id memory_control.identifier NOT NULL REFERENCES memory_control.organizations(id),
  address text NOT NULL CHECK (address = lower(btrim(address)) AND length(address) BETWEEN 3 AND 254
    AND address !~ '[\x00-\x1F\x7F]'),
  role text NOT NULL CHECK (role IN ('member', 'admin')),
  token_digest text NOT NULL UNIQUE CHECK (token_digest COLLATE "C" ~ '^[0-9a-f]{64}$'),
  creator_membership_id memory_control.identifier NOT NULL REFERENCES memory_identity.memberships(id),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  created_at memory_control.epoch_ms NOT NULL,
  expires_at memory_control.epoch_ms NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 259200000),
  accepted_at memory_control.epoch_ms CHECK (accepted_at IS NULL OR accepted_at >= created_at)
);
CREATE INDEX workspace_invitations_organization ON memory_identity.workspace_invitations(organization_id);
CREATE TRIGGER workspace_invitations_immutable BEFORE UPDATE ON memory_identity.workspace_invitations
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.address IS DISTINCT FROM OLD.address
    OR NEW.role IS DISTINCT FROM OLD.role OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
    OR NEW.creator_membership_id IS DISTINCT FROM OLD.creator_membership_id
    OR NEW.actor_credential_id IS DISTINCT FROM OLD.actor_credential_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at))
  EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_identity.workspace_invitation_acceptances (
  id memory_control.identifier PRIMARY KEY,
  invitation_id memory_control.identifier NOT NULL UNIQUE REFERENCES memory_identity.workspace_invitations(id),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  email_id memory_control.identifier NOT NULL REFERENCES memory_identity.account_emails(id),
  created_at memory_control.epoch_ms NOT NULL
);

CREATE TABLE memory_identity.workspace_key_issuances (
  id memory_control.identifier PRIMARY KEY,
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  organization_id memory_control.identifier REFERENCES memory_control.organizations(id),
  label text NOT NULL CHECK (label !~ '[\x00-\x1F\x7F]' AND length(label) BETWEEN 1 AND 100
    AND length(btrim(label)) > 0),
  permission text NOT NULL CHECK (permission IN ('read', 'write')),
  token_digest text NOT NULL UNIQUE CHECK (token_digest COLLATE "C" ~ '^[0-9a-f]{64}$'),
  created_at memory_control.epoch_ms NOT NULL,
  expires_at memory_control.epoch_ms NOT NULL
    CHECK (expires_at >= created_at + 86400000 AND expires_at <= created_at + 7776000000)
);

CREATE TABLE memory_identity.workspace_key_metadata (
  credential_id memory_control.identifier PRIMARY KEY REFERENCES memory_identity.credentials(id),
  label text NOT NULL CHECK (label !~ '[\x00-\x1F\x7F]' AND length(label) BETWEEN 1 AND 100
    AND length(btrim(label)) > 0),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  created_at memory_control.epoch_ms NOT NULL
);

CREATE TABLE memory_identity.workspace_membership_revocations (
  id memory_control.identifier PRIMARY KEY,
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  organization_id memory_control.identifier NOT NULL REFERENCES memory_control.organizations(id),
  membership_id memory_control.identifier NOT NULL REFERENCES memory_identity.memberships(id),
  created_at memory_control.epoch_ms NOT NULL
);

CREATE TABLE memory_identity.workspace_key_revocations (
  id memory_control.identifier PRIMARY KEY,
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  created_at memory_control.epoch_ms NOT NULL
);

-- Identifier-only audit: no tokens/digests, names, subjects, or addresses.
CREATE TABLE memory_ops.workspace_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('signed_in', 'organization_created', 'invitation_created',
    'invitation_accepted', 'key_issued', 'key_revoked', 'membership_revoked')),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  account_id memory_control.identifier REFERENCES memory_identity.accounts(id),
  organization_id memory_control.identifier REFERENCES memory_control.organizations(id),
  membership_id memory_control.identifier REFERENCES memory_identity.memberships(id),
  credential_id memory_control.identifier REFERENCES memory_identity.credentials(id),
  invitation_id memory_control.identifier REFERENCES memory_identity.workspace_invitations(id),
  created_at memory_control.epoch_ms NOT NULL
);

-- ---------------------------------------------------------------------------
-- OAuth browser transactions and organization hierarchy.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_identity.auth_flows (
  state_digest text PRIMARY KEY CHECK (state_digest COLLATE "C" ~ '^[0-9a-f]{64}$'),
  browser_digest text NOT NULL CHECK (browser_digest COLLATE "C" ~ '^[0-9a-f]{64}$'),
  verifier text CHECK (verifier IS NULL OR length(verifier) = 43),
  issuer text NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  expires_at memory_control.epoch_ms NOT NULL
    CHECK (expires_at > created_at AND expires_at <= created_at + 600000),
  consumed_at memory_control.epoch_ms CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX auth_flows_expiry ON memory_identity.auth_flows(expires_at);

CREATE TABLE memory_identity.workspace_child_organization_creations (
  id memory_control.identifier PRIMARY KEY,
  parent_organization_id memory_control.identifier NOT NULL REFERENCES memory_control.organizations(id),
  name text NOT NULL CHECK (name !~ '[\x00-\x1F\x7F]' AND length(name) BETWEEN 1 AND 100
    AND length(btrim(name)) > 0),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  email_id memory_control.identifier NOT NULL REFERENCES memory_identity.account_emails(id),
  membership_id memory_control.identifier NOT NULL,
  space_id memory_control.identifier NOT NULL,
  data_policy jsonb NOT NULL CHECK (memory_control.data_policy_shape_valid(data_policy)),
  created_at memory_control.epoch_ms NOT NULL,
  CHECK (id <> parent_organization_id)
);
CREATE TABLE memory_identity.organization_hierarchy (
  organization_id memory_control.identifier PRIMARY KEY REFERENCES memory_control.organizations(id),
  parent_organization_id memory_control.identifier NOT NULL REFERENCES memory_control.organizations(id),
  CHECK (organization_id <> parent_organization_id)
);
CREATE INDEX organization_hierarchy_parent ON memory_identity.organization_hierarchy(parent_organization_id);

-- ---------------------------------------------------------------------------
-- Credential policies, domain verification, SCIM, re-auth, external blocks.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_identity.credential_policies (
  credential_id memory_control.identifier PRIMARY KEY REFERENCES memory_identity.credentials(id),
  capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
  space_ids jsonb CHECK (space_ids IS NULL OR jsonb_typeof(space_ids) = 'array'),
  verified_oauth boolean NOT NULL DEFAULT false
);

CREATE TABLE memory_identity.domain_challenges (
  id memory_control.identifier PRIMARY KEY,
  organization_id memory_control.identifier REFERENCES memory_control.organizations(id),
  actor_account_id memory_control.identifier REFERENCES memory_identity.accounts(id),
  domain text NOT NULL,
  proof text NOT NULL,
  expires_at memory_control.epoch_ms NOT NULL,
  used_at memory_control.epoch_ms,
  verification_id memory_control.identifier
);
CREATE TABLE memory_identity.domain_verifications (
  id memory_control.identifier PRIMARY KEY,
  challenge_id memory_control.identifier NOT NULL UNIQUE REFERENCES memory_identity.domain_challenges(id),
  domain_id memory_control.identifier NOT NULL REFERENCES memory_identity.domains(id),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  membership_id memory_control.identifier NOT NULL REFERENCES memory_identity.memberships(id),
  created_at memory_control.epoch_ms NOT NULL,
  verified_until memory_control.epoch_ms NOT NULL
    CHECK (verified_until = created_at + 2592000000)
);

CREATE TABLE memory_identity.scim_keys (
  id memory_control.identifier PRIMARY KEY,
  organization_id memory_control.identifier REFERENCES memory_control.organizations(id),
  token_digest text UNIQUE CHECK (token_digest COLLATE "C" ~ '^[0-9a-f]{64}$'),
  creator_credential_id memory_control.identifier REFERENCES memory_identity.credentials(id),
  expires_at memory_control.epoch_ms NOT NULL,
  revoked_at memory_control.epoch_ms,
  creator_membership_id memory_control.identifier REFERENCES memory_identity.memberships(id),
  creator_email_id memory_control.identifier REFERENCES memory_identity.account_emails(id),
  created_at memory_control.epoch_ms NOT NULL
);
CREATE TABLE memory_identity.scim_deletions (
  membership_id memory_control.identifier PRIMARY KEY REFERENCES memory_identity.memberships(id),
  scim_key_id memory_control.identifier NOT NULL REFERENCES memory_identity.scim_keys(id),
  deleted_at memory_control.epoch_ms NOT NULL
);

CREATE TABLE memory_identity.reauth_challenges (
  id memory_control.identifier PRIMARY KEY,
  credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  email_id memory_control.identifier NOT NULL REFERENCES memory_identity.account_emails(id),
  token_digest text NOT NULL,
  expires_at memory_control.epoch_ms NOT NULL,
  used_at memory_control.epoch_ms
);

CREATE TABLE memory_identity.external_email_blocks (
  account_id memory_control.identifier REFERENCES memory_identity.accounts(id),
  address text NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  PRIMARY KEY (account_id, address)
);

-- Per-account daily outbound mail quota; travels with the account's region.
CREATE TABLE memory_ops.mail_budget (
  account_id memory_control.identifier REFERENCES memory_identity.accounts(id),
  day text,
  quantity bigint NOT NULL CHECK (quantity BETWEEN 0 AND 20),
  PRIMARY KEY (account_id, day)
);

-- Regional provider-revocation tombstones, applied by the lifecycle-apply
-- unit. A still-valid pre-revocation JWT cannot recreate authority.
CREATE TABLE memory_ops.provider_revocations (
  issuer text NOT NULL,
  subject text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('account.disabled', 'email.revoked')),
  address text NOT NULL,
  created_at_ms memory_control.epoch_ms NOT NULL,
  PRIMARY KEY (issuer, subject, kind, address)
);

-- ---------------------------------------------------------------------------
-- Guards and applies (D1 trigger bodies, as functions).
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_identity.ws_sign_in_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.provider_identities p
      JOIN memory_identity.accounts a ON a.id = p.account_id
      WHERE p.issuer = NEW.issuer AND p.subject = NEW.subject AND a.disabled_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM memory_identity.credentials c WHERE c.token_digest = NEW.token_digest
      AND (c.revoked_at IS NOT NULL OR c.expires_at <= NEW.created_at OR c.kind <> 'session'
        OR c.permission <> NEW.permission OR NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities p
          WHERE p.issuer = NEW.issuer AND p.subject = NEW.subject AND p.account_id = c.account_id)))
    OR EXISTS(SELECT 1 FROM memory_ops.provider_revocations p
      WHERE p.issuer = NEW.issuer AND p.subject = NEW.subject AND p.kind = 'account.disabled')
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER workspace_sign_in_validate BEFORE INSERT ON memory_identity.workspace_sign_ins
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_sign_in_validate();

CREATE FUNCTION memory_identity.ws_sign_in_apply() RETURNS trigger
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
      AND NOT EXISTS(SELECT 1 FROM memory_identity.external_email_blocks b
        WHERE b.account_id = p.account_id AND b.address = NEW.address);
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
CREATE TRIGGER workspace_sign_in_apply AFTER INSERT ON memory_identity.workspace_sign_ins
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_sign_in_apply();

CREATE FUNCTION memory_identity.ws_org_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.account_emails e ON e.account_id = c.account_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > NEW.created_at AND e.id = NEW.email_id AND e.revoked_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER workspace_org_validate BEFORE INSERT ON memory_identity.workspace_organization_creations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_org_validate();

CREATE FUNCTION memory_identity.ws_org_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
DECLARE v_deployment text;
BEGIN
  SELECT deployment_id INTO v_deployment FROM memory_control.deployment_identity;
  IF v_deployment IS NULL
    OR (NEW.data_policy ->> 'residency') IS DISTINCT FROM
       (SELECT storage_region FROM memory_control.deployment_identity)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'residency placement mismatch'; END IF;
  INSERT INTO memory_control.organizations(id) VALUES(NEW.id);
  INSERT INTO memory_identity.workspace_organization_metadata(organization_id, name)
    VALUES(NEW.id, NEW.name);
  INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
    SELECT NEW.membership_id, NEW.id, c.account_id, NEW.email_id, 'owner'
    FROM memory_identity.credentials c WHERE c.id = NEW.actor_credential_id;
  INSERT INTO memory_control.spaces(id, organization_id, deployment_id, data_policy,
      source_byte_limit, message_limit, name, security_mode, created_at_ms, actor_credential_id)
    VALUES(NEW.space_id, NEW.id, v_deployment, NEW.data_policy,
      67108864, 100000, NEW.name, 'managed', NEW.created_at, NEW.actor_credential_id);
  INSERT INTO memory_ops.workspace_audit_events(action, actor_credential_id, organization_id,
      membership_id, created_at)
    VALUES('organization_created', NEW.actor_credential_id, NEW.id, NEW.membership_id, NEW.created_at);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER workspace_org_apply AFTER INSERT ON memory_identity.workspace_organization_creations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_org_apply();

CREATE FUNCTION memory_identity.ws_invitation_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.active_memberships m ON m.account_id = c.account_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > NEW.created_at
        AND m.id = NEW.creator_membership_id AND m.organization_id = NEW.organization_id
        AND m.expires_at > NEW.created_at AND m.role IN ('owner', 'admin'))
    OR EXISTS(SELECT 1 FROM memory_identity.email_blocks b WHERE b.address = NEW.address)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER workspace_invitation_validate BEFORE INSERT ON memory_identity.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_invitation_validate();
CREATE FUNCTION memory_identity.ws_invitation_audit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_ops.workspace_audit_events(action, actor_credential_id, organization_id,
      membership_id, invitation_id, created_at)
    VALUES('invitation_created', NEW.actor_credential_id, NEW.organization_id,
      NEW.creator_membership_id, NEW.id, NEW.created_at);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER workspace_invitation_audit AFTER INSERT ON memory_identity.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_invitation_audit();

CREATE FUNCTION memory_identity.ws_acceptance_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.workspace_invitations i
      JOIN memory_identity.active_memberships creator
        ON creator.id = i.creator_membership_id AND creator.organization_id = i.organization_id
      JOIN memory_identity.active_credentials c ON c.id = NEW.actor_credential_id
      JOIN memory_identity.account_emails e
        ON e.account_id = c.account_id AND e.id = NEW.email_id AND e.address = i.address
      WHERE i.id = NEW.invitation_id AND i.accepted_at IS NULL AND i.expires_at > NEW.created_at
        AND creator.expires_at > NEW.created_at AND creator.role IN ('owner', 'admin')
        AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at > NEW.created_at
        AND e.revoked_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM memory_identity.email_blocks b WHERE b.address = i.address)
        AND NOT EXISTS(SELECT 1 FROM memory_identity.memberships m
          WHERE m.organization_id = i.organization_id AND m.account_id = c.account_id
            AND m.revoked_at IS NULL))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER workspace_acceptance_validate BEFORE INSERT ON memory_identity.workspace_invitation_acceptances
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_acceptance_validate();
CREATE FUNCTION memory_identity.ws_acceptance_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_identity.memberships(id, organization_id, account_id, email_id, role)
    SELECT NEW.id, i.organization_id, c.account_id, NEW.email_id, i.role
    FROM memory_identity.workspace_invitations i
    JOIN memory_identity.credentials c ON c.id = NEW.actor_credential_id
    WHERE i.id = NEW.invitation_id;
  UPDATE memory_identity.workspace_invitations SET accepted_at = NEW.created_at
    WHERE id = NEW.invitation_id;
  INSERT INTO memory_ops.workspace_audit_events(action, actor_credential_id, organization_id,
      membership_id, invitation_id, created_at)
    SELECT 'invitation_accepted', NEW.actor_credential_id, i.organization_id, NEW.id, i.id, NEW.created_at
    FROM memory_identity.workspace_invitations i WHERE i.id = NEW.invitation_id;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER workspace_acceptance_apply AFTER INSERT ON memory_identity.workspace_invitation_acceptances
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_acceptance_apply();

CREATE FUNCTION memory_identity.ws_key_issuance_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > NEW.created_at AND (NEW.permission = 'read' OR c.permission = 'write')
        AND (NEW.organization_id IS NULL OR EXISTS(SELECT 1 FROM memory_identity.active_memberships m
          WHERE m.account_id = c.account_id AND m.organization_id = NEW.organization_id
            AND m.expires_at > NEW.created_at
            AND (NEW.permission = 'read' OR m.role IN ('owner', 'admin')))))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER workspace_key_issuance_validate BEFORE INSERT ON memory_identity.workspace_key_issuances
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_key_issuance_validate();
CREATE FUNCTION memory_identity.ws_key_issuance_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_identity.credentials(id, account_id, membership_id, email_id, kind,
      token_digest, expires_at, permission)
    SELECT NEW.id, c.account_id, m.id, m.email_id,
      CASE WHEN NEW.organization_id IS NULL THEN 'personal_key' ELSE 'api_key' END,
      NEW.token_digest, NEW.expires_at, NEW.permission
    FROM memory_identity.credentials c
    LEFT JOIN memory_identity.active_memberships m ON m.account_id = c.account_id
      AND m.organization_id = NEW.organization_id AND m.expires_at > NEW.created_at
    WHERE c.id = NEW.actor_credential_id;
  INSERT INTO memory_identity.workspace_key_metadata(credential_id, label, actor_credential_id, created_at)
    VALUES(NEW.id, NEW.label, NEW.actor_credential_id, NEW.created_at);
  INSERT INTO memory_ops.workspace_audit_events(action, actor_credential_id, organization_id,
      credential_id, created_at)
    VALUES('key_issued', NEW.actor_credential_id, NEW.organization_id, NEW.id, NEW.created_at);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER workspace_key_issuance_apply AFTER INSERT ON memory_identity.workspace_key_issuances
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_key_issuance_apply();

CREATE FUNCTION memory_identity.ws_membership_revocation_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.active_memberships actor
        ON actor.account_id = c.account_id AND actor.organization_id = NEW.organization_id
      JOIN memory_identity.memberships target
        ON target.id = NEW.membership_id AND target.organization_id = actor.organization_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > NEW.created_at
        AND actor.expires_at > NEW.created_at AND actor.role IN ('owner', 'admin')
        AND target.revoked_at IS NULL
        AND (target.role <> 'owner' OR (actor.role = 'owner' AND EXISTS(
          SELECT 1 FROM memory_identity.active_memberships other
          WHERE other.organization_id = actor.organization_id AND other.role = 'owner'
            AND other.expires_at > NEW.created_at AND other.id <> target.id))))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER workspace_membership_revocation_validate BEFORE INSERT
  ON memory_identity.workspace_membership_revocations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_membership_revocation_validate();
CREATE FUNCTION memory_identity.ws_membership_revocation_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  UPDATE memory_identity.memberships SET revoked_at = NEW.created_at WHERE id = NEW.membership_id;
  INSERT INTO memory_ops.workspace_audit_events(action, actor_credential_id, organization_id,
      membership_id, created_at)
    VALUES('membership_revoked', NEW.actor_credential_id, NEW.organization_id, NEW.membership_id,
      NEW.created_at);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER workspace_membership_revocation_apply AFTER INSERT
  ON memory_identity.workspace_membership_revocations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_membership_revocation_apply();

CREATE FUNCTION memory_identity.ws_key_revocation_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.credentials target ON target.id = NEW.credential_id
      LEFT JOIN memory_identity.memberships target_member
        ON target_member.id = target.membership_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > NEW.created_at
        AND target.kind IN ('personal_key', 'api_key') AND target.revoked_at IS NULL
        AND (target.account_id = c.account_id OR EXISTS(SELECT 1 FROM memory_identity.active_memberships actor
          WHERE actor.account_id = c.account_id
            AND actor.organization_id = target_member.organization_id
            AND actor.expires_at > NEW.created_at AND actor.role IN ('owner', 'admin'))))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER workspace_key_revocation_validate BEFORE INSERT ON memory_identity.workspace_key_revocations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_key_revocation_validate();
CREATE FUNCTION memory_identity.ws_key_revocation_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  UPDATE memory_identity.credentials SET revoked_at = NEW.created_at WHERE id = NEW.credential_id;
  INSERT INTO memory_ops.workspace_audit_events(action, actor_credential_id, credential_id, created_at)
    VALUES('key_revoked', NEW.actor_credential_id, NEW.credential_id, NEW.created_at);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER workspace_key_revocation_apply AFTER INSERT ON memory_identity.workspace_key_revocations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_key_revocation_apply();

-- ---------------------------------------------------------------------------
-- Hierarchy and SCIM/domain verification.
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_identity.ws_child_org_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_control.organizations WHERE id = NEW.id)
    OR NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.active_memberships m ON m.account_id = c.account_id
      JOIN memory_identity.account_emails e ON e.account_id = c.account_id
      WHERE c.id = NEW.actor_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.expires_at > NEW.created_at AND m.organization_id = NEW.parent_organization_id
        AND m.expires_at > NEW.created_at AND m.role IN ('owner', 'admin')
        AND e.id = NEW.email_id AND e.revoked_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER workspace_child_org_validate BEFORE INSERT ON memory_identity.workspace_child_organization_creations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_child_org_validate();
CREATE FUNCTION memory_identity.ws_child_org_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_identity.workspace_organization_creations(id, name, actor_credential_id,
      email_id, membership_id, space_id, data_policy, created_at)
    VALUES(NEW.id, NEW.name, NEW.actor_credential_id, NEW.email_id, NEW.membership_id,
      NEW.space_id, NEW.data_policy, NEW.created_at);
  INSERT INTO memory_identity.organization_hierarchy(organization_id, parent_organization_id)
    VALUES(NEW.id, NEW.parent_organization_id);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER workspace_child_org_apply AFTER INSERT ON memory_identity.workspace_child_organization_creations
  FOR EACH ROW EXECUTE FUNCTION memory_identity.ws_child_org_apply();

CREATE FUNCTION memory_identity.org_hierarchy_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.workspace_child_organization_creations command
      WHERE command.id = NEW.organization_id AND command.parent_organization_id = NEW.parent_organization_id)
    OR EXISTS(WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_organization_id
      UNION
      SELECT h.parent_organization_id FROM memory_identity.organization_hierarchy h
        JOIN ancestors a ON h.organization_id = a.id
    ) SELECT 1 FROM ancestors WHERE id = NEW.organization_id)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'workspace operation denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER organization_hierarchy_validate BEFORE INSERT ON memory_identity.organization_hierarchy
  FOR EACH ROW EXECUTE FUNCTION memory_identity.org_hierarchy_validate();
CREATE TRIGGER organization_hierarchy_immutable BEFORE UPDATE OR DELETE
  ON memory_identity.organization_hierarchy
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

CREATE FUNCTION memory_identity.domain_verification_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE at_ms bigint := greatest(NEW.created_at,
    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint);
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
CREATE TRIGGER domain_verification_validate BEFORE INSERT ON memory_identity.domain_verifications
  FOR EACH ROW EXECUTE FUNCTION memory_identity.domain_verification_validate();
CREATE FUNCTION memory_identity.domain_verification_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  UPDATE memory_identity.domain_challenges SET used_at = NEW.created_at, verification_id = NEW.id
    WHERE id = NEW.challenge_id;
  INSERT INTO memory_identity.domains(id, organization_id, name, verified_until)
    SELECT NEW.domain_id, p.organization_id, p.domain, NEW.verified_until
    FROM memory_identity.domain_challenges p
    WHERE p.id = NEW.challenge_id
      AND NOT EXISTS(SELECT 1 FROM memory_identity.domains d WHERE d.id = NEW.domain_id);
  UPDATE memory_identity.domains SET verified_until = NEW.verified_until WHERE id = NEW.domain_id;
  INSERT INTO memory_identity.domain_managers(domain_id, membership_id)
    SELECT NEW.domain_id, NEW.membership_id
    WHERE NOT EXISTS(SELECT 1 FROM memory_identity.domain_managers g
      WHERE g.domain_id = NEW.domain_id AND g.membership_id = NEW.membership_id);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER domain_verification_apply AFTER INSERT ON memory_identity.domain_verifications
  FOR EACH ROW EXECUTE FUNCTION memory_identity.domain_verification_apply();

CREATE FUNCTION memory_identity.scim_key_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW.expires_at <= NEW.created_at OR NEW.expires_at > NEW.created_at + 2592000000
    OR NEW.revoked_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM memory_identity.active_credentials c
      JOIN memory_identity.active_memberships m ON m.account_id = c.account_id
      WHERE c.id = NEW.creator_credential_id AND c.kind = 'session' AND c.id NOT LIKE 'oauth:%'
        AND c.permission = 'write' AND c.expires_at > NEW.created_at
        AND c.reauthenticated_at BETWEEN NEW.created_at - 300000 AND NEW.created_at
        AND m.id = NEW.creator_membership_id AND m.organization_id = NEW.organization_id
        AND m.email_id = NEW.creator_email_id AND m.expires_at > NEW.created_at
        AND m.role IN ('owner', 'admin'))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER scim_key_validate BEFORE INSERT ON memory_identity.scim_keys
  FOR EACH ROW EXECUTE FUNCTION memory_identity.scim_key_validate();

CREATE FUNCTION memory_identity.scim_deletion_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_identity.memberships target
      JOIN memory_identity.scim_keys k ON k.organization_id = target.organization_id
      JOIN memory_identity.credentials issuer ON issuer.id = k.creator_credential_id
      JOIN memory_identity.active_memberships admin
        ON admin.id = k.creator_membership_id AND admin.account_id = issuer.account_id
        AND admin.email_id = k.creator_email_id AND admin.organization_id = k.organization_id
      WHERE target.id = NEW.membership_id AND k.id = NEW.scim_key_id
        AND k.revoked_at IS NULL AND k.expires_at > NEW.deleted_at
        AND admin.expires_at > NEW.deleted_at AND admin.role IN ('owner', 'admin')
        AND (target.revoked_at IS NOT NULL OR target.role <> 'owner' OR (admin.role = 'owner'
          AND EXISTS(SELECT 1 FROM memory_identity.active_memberships other
            WHERE other.organization_id = target.organization_id AND other.role = 'owner'
              AND other.expires_at > NEW.deleted_at AND other.id <> target.id))))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_denied'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER scim_deletion_validate BEFORE INSERT ON memory_identity.scim_deletions
  FOR EACH ROW EXECUTE FUNCTION memory_identity.scim_deletion_validate();
CREATE FUNCTION memory_identity.scim_deletion_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  UPDATE memory_identity.memberships SET revoked_at = coalesce(revoked_at, NEW.deleted_at)
    WHERE id = NEW.membership_id;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER scim_deletion_apply AFTER INSERT ON memory_identity.scim_deletions
  FOR EACH ROW EXECUTE FUNCTION memory_identity.scim_deletion_apply();

-- Provider-revocation and external-block guards. RAISE(IGNORE) becomes a
-- silent skip (RETURN NULL) for challenge/consumption rows.
CREATE FUNCTION memory_identity.provider_email_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_ops.provider_revocations b
      JOIN memory_identity.provider_identities p
        ON p.issuer = b.issuer AND p.subject = b.subject
      WHERE p.account_id = NEW.account_id AND b.kind = 'email.revoked' AND b.address = NEW.address)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider email revoked'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER provider_email_guard BEFORE INSERT ON memory_identity.account_emails
  FOR EACH ROW EXECUTE FUNCTION memory_identity.provider_email_guard();

CREATE FUNCTION memory_identity.external_claim_block() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.external_email_blocks b
      WHERE b.account_id = NEW.account_id AND b.address = NEW.address)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'externally revoked email'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER external_claim_block BEFORE INSERT ON memory_identity.account_emails
  FOR EACH ROW EXECUTE FUNCTION memory_identity.external_claim_block();

CREATE FUNCTION memory_identity.challenge_external_block() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.external_email_blocks b
      WHERE b.account_id = NEW.account_id AND b.address = NEW.address)
    OR EXISTS(SELECT 1 FROM memory_ops.provider_revocations b
      JOIN memory_identity.provider_identities p
        ON p.issuer = b.issuer AND p.subject = b.subject
      WHERE p.account_id = NEW.account_id AND b.kind = 'email.revoked' AND b.address = NEW.address)
  THEN RETURN NULL; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER challenge_external_block BEFORE INSERT ON memory_identity.email_challenges
  FOR EACH ROW EXECUTE FUNCTION memory_identity.challenge_external_block();

CREATE FUNCTION memory_identity.consumption_external_block() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_identity.email_challenges challenge
      WHERE challenge.id = NEW.challenge_id AND (
        EXISTS(SELECT 1 FROM memory_identity.external_email_blocks b
          WHERE b.account_id = challenge.account_id AND b.address = challenge.address)
        OR EXISTS(SELECT 1 FROM memory_ops.provider_revocations b
          JOIN memory_identity.provider_identities p
            ON p.issuer = b.issuer AND p.subject = b.subject
          WHERE p.account_id = challenge.account_id AND b.kind = 'email.revoked'
            AND b.address = challenge.address)))
  THEN RETURN NULL; END IF;
  RETURN NEW;
END
$guard$;
-- Name order matters: BEFORE triggers fire alphabetically, so this silent-skip
-- guard must precede consume_email_validate (matches the D1 RAISE(IGNORE)
-- trigger running before the validate trigger).
CREATE TRIGGER consume_block BEFORE INSERT ON memory_identity.email_consumptions
  FOR EACH ROW EXECUTE FUNCTION memory_identity.consumption_external_block();

-- ---------------------------------------------------------------------------
-- Boundaries and grants.
-- ---------------------------------------------------------------------------
DO $boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'memory_identity.workspace_sign_ins', 'memory_identity.workspace_organization_creations',
    'memory_identity.workspace_organization_metadata', 'memory_identity.workspace_invitations',
    'memory_identity.workspace_invitation_acceptances', 'memory_identity.workspace_key_issuances',
    'memory_identity.workspace_key_metadata', 'memory_identity.workspace_membership_revocations',
    'memory_identity.workspace_key_revocations', 'memory_identity.auth_flows',
    'memory_identity.workspace_child_organization_creations', 'memory_identity.organization_hierarchy',
    'memory_identity.credential_policies', 'memory_identity.domain_challenges',
    'memory_identity.domain_verifications', 'memory_identity.scim_keys',
    'memory_identity.scim_deletions', 'memory_identity.reauth_challenges',
    'memory_identity.external_email_blocks', 'memory_ops.workspace_audit_events',
    'memory_ops.mail_budget', 'memory_ops.provider_revocations'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING (true) WITH CHECK (true)', target);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()', target);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()', target);
  END LOOP;
  -- Command receipts are append-only: only invitations mutate (accepted_at).
  FOREACH target IN ARRAY ARRAY[
    'memory_identity.workspace_sign_ins', 'memory_identity.workspace_organization_creations',
    'memory_identity.workspace_organization_metadata', 'memory_identity.workspace_invitation_acceptances',
    'memory_identity.workspace_key_issuances', 'memory_identity.workspace_key_metadata',
    'memory_identity.workspace_membership_revocations', 'memory_identity.workspace_key_revocations',
    'memory_identity.workspace_child_organization_creations', 'memory_identity.scim_deletions',
    'memory_identity.domain_verifications', 'memory_ops.workspace_audit_events',
    'memory_ops.provider_revocations', 'memory_identity.external_email_blocks',
    'memory_identity.credential_policies', 'memory_identity.domain_challenges',
    'memory_identity.reauth_challenges'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()', target);
  END LOOP;
END
$boundaries$;

REVOKE ALL ON ALL TABLES IN SCHEMA memory_identity FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON memory_ops.workspace_audit_events, memory_ops.mail_budget,
  memory_ops.provider_revocations FROM PUBLIC, memory_runtime, memory_background;
DO $private_objects$
DECLARE api_role text; target text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      FOREACH target IN ARRAY ARRAY[
        'memory_identity.workspace_sign_ins', 'memory_identity.workspace_organization_creations',
        'memory_identity.workspace_organization_metadata', 'memory_identity.workspace_invitations',
        'memory_identity.workspace_invitation_acceptances', 'memory_identity.workspace_key_issuances',
        'memory_identity.workspace_key_metadata', 'memory_identity.workspace_membership_revocations',
        'memory_identity.workspace_key_revocations', 'memory_identity.auth_flows',
        'memory_identity.workspace_child_organization_creations', 'memory_identity.organization_hierarchy',
        'memory_identity.credential_policies', 'memory_identity.domain_challenges',
        'memory_identity.domain_verifications', 'memory_identity.scim_keys',
        'memory_identity.scim_deletions', 'memory_identity.reauth_challenges',
        'memory_identity.external_email_blocks', 'memory_ops.workspace_audit_events',
        'memory_ops.mail_budget', 'memory_ops.provider_revocations', 'memory_control.spaces'] LOOP
        EXECUTE format('REVOKE ALL ON %s FROM %I', target, api_role);
      END LOOP;
    END IF;
  END LOOP;
END
$private_objects$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (7, '0007_workspace_regional.sql');
COMMIT;

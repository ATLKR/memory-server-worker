-- Identity structure and immutable bindings only. This does NOT port live
-- authority, lifecycle receipts, credential issuance or sign-in commands.
-- Runtime/background receive no identity DML or granting authority function.
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE TABLE memory_identity.accounts (
  id memory_control.identifier PRIMARY KEY,
  disabled_at memory_control.epoch_ms
);
CREATE TABLE memory_control.organizations (
  id memory_control.identifier PRIMARY KEY,
  disabled_at memory_control.epoch_ms
);
CREATE TABLE memory_identity.account_emails (
  id memory_control.identifier PRIMARY KEY,
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  address text NOT NULL CHECK (address = lower(btrim(address)) AND length(address) BETWEEN 3 AND 254),
  domain text NOT NULL CHECK (domain = lower(domain) AND position('.' IN domain) > 1
    AND right(address, length(domain) + 1) = '@' || domain
    AND position('@' IN address) = length(address) - length(domain)),
  verified_at memory_control.epoch_ms NOT NULL,
  revoked_at memory_control.epoch_ms,
  UNIQUE (id, account_id)
);
CREATE UNIQUE INDEX one_live_email_claim ON memory_identity.account_emails(address) WHERE revoked_at IS NULL;
CREATE INDEX account_email_claims ON memory_identity.account_emails(account_id);

CREATE TABLE memory_identity.memberships (
  id memory_control.identifier PRIMARY KEY,
  organization_id memory_control.identifier NOT NULL REFERENCES memory_control.organizations(id),
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  email_id memory_control.identifier NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  expires_at memory_control.epoch_ms NOT NULL DEFAULT 9007199254740991,
  revoked_at memory_control.epoch_ms,
  FOREIGN KEY (email_id, account_id) REFERENCES memory_identity.account_emails(id, account_id),
  UNIQUE (id, account_id, email_id)
);
CREATE UNIQUE INDEX one_live_membership ON memory_identity.memberships(organization_id, account_id) WHERE revoked_at IS NULL;
CREATE INDEX memberships_email ON memory_identity.memberships(email_id);
CREATE INDEX memberships_account ON memory_identity.memberships(account_id);

CREATE TABLE memory_identity.credentials (
  id memory_control.identifier PRIMARY KEY,
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  membership_id memory_control.identifier,
  email_id memory_control.identifier,
  kind text NOT NULL CHECK (kind IN ('session', 'personal_key', 'api_key')),
  token_digest text NOT NULL UNIQUE CHECK (token_digest COLLATE "C" ~ '^[0-9a-f]{64}$'),
  expires_at memory_control.epoch_ms NOT NULL,
  reauthenticated_at memory_control.epoch_ms,
  revoked_at memory_control.epoch_ms,
  permission text NOT NULL DEFAULT 'write' CHECK (permission IN ('read', 'write')),
  FOREIGN KEY (membership_id, account_id, email_id) REFERENCES memory_identity.memberships(id, account_id, email_id),
  UNIQUE (id, account_id),
  CHECK ((kind IN ('session', 'personal_key') AND membership_id IS NULL AND email_id IS NULL)
    OR (kind = 'api_key' AND membership_id IS NOT NULL AND email_id IS NOT NULL))
);
CREATE INDEX credentials_membership ON memory_identity.credentials(membership_id);
CREATE INDEX credentials_email ON memory_identity.credentials(email_id);
CREATE INDEX credentials_account ON memory_identity.credentials(account_id);

CREATE TABLE memory_identity.provider_identities (
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  created_at memory_control.epoch_ms NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX provider_identities_account ON memory_identity.provider_identities(account_id);

CREATE TRIGGER accounts_immutable BEFORE UPDATE ON memory_identity.accounts
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR
    (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER organizations_immutable BEFORE UPDATE ON memory_control.organizations
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR
    (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER account_emails_immutable BEFORE UPDATE ON memory_identity.account_emails
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.address IS DISTINCT FROM OLD.address OR NEW.domain IS DISTINCT FROM OLD.domain
    OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER memberships_immutable BEFORE UPDATE ON memory_identity.memberships
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.email_id IS DISTINCT FROM OLD.email_id
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER credentials_immutable BEFORE UPDATE ON memory_identity.credentials
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.membership_id IS DISTINCT FROM OLD.membership_id OR NEW.email_id IS DISTINCT FROM OLD.email_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER provider_identities_immutable BEFORE UPDATE ON memory_identity.provider_identities
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

-- The owner-only policy is for explicit import/migration work. No runtime policy
-- is installed, even if a future grant accidentally exposes one of these tables.
DO $identity_boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['memory_identity.accounts', 'memory_control.organizations',
    'memory_identity.account_emails', 'memory_identity.memberships',
    'memory_identity.credentials', 'memory_identity.provider_identities'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING (true) WITH CHECK (true)', target);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()', target);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()', target);
  END LOOP;
END
$identity_boundaries$;

REVOKE ALL ON memory_control.organizations FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON ALL TABLES IN SCHEMA memory_identity FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON SCHEMA memory_identity FROM PUBLIC, memory_runtime, memory_background;
DO $private_objects$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA memory_control, memory_identity FROM %I', api_role);
    END IF;
  END LOOP;
END
$private_objects$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES (3, '0003_identity_foundation.sql');
COMMIT;

-- SCIM key bindings are immutable once issued; only revoked_at may be set once.
-- Ports release_scim_key_immutable from the retired D1 lineage — 0007 grants
-- delete/truncate guards but never installed the UPDATE freeze.
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE TRIGGER scim_key_immutable BEFORE UPDATE ON memory_identity.scim_keys
  FOR EACH ROW WHEN (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
    OR NEW.creator_credential_id IS DISTINCT FROM OLD.creator_credential_id
    OR NEW.creator_membership_id IS DISTINCT FROM OLD.creator_membership_id
    OR NEW.creator_email_id IS DISTINCT FROM OLD.creator_email_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at))
  EXECUTE FUNCTION memory_control.reject_mutation();

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (12, '0012_scim_key_freeze.sql');
COMMIT;

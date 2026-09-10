-- Forward SaaS migration 13: key-lookup-schema.sql
-- Keep foundation key validation, credential bindings and audit behavior while
-- avoiding materialization of every active membership in the organization.
DROP TRIGGER workspace_key_apply;
CREATE TRIGGER workspace_key_apply AFTER INSERT ON workspace_key_issuances BEGIN
  INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission)
    SELECT NEW.id,c.account_id,m.id,m.email_id,
      CASE WHEN NEW.organization_id IS NULL THEN 'personal_key' ELSE 'api_key' END,
      NEW.token_digest,NEW.expires_at,NEW.permission
    FROM credentials c LEFT JOIN memberships m ON m.id=(
      SELECT candidate.id FROM active_memberships candidate WHERE candidate.account_id=c.account_id
        AND candidate.organization_id=NEW.organization_id AND candidate.expires_at>NEW.created_at)
    WHERE c.id=NEW.actor_credential_id;
  INSERT INTO workspace_key_metadata(credential_id,label,actor_credential_id,created_at)
    VALUES(NEW.id,NEW.label,NEW.actor_credential_id,NEW.created_at);
  INSERT INTO workspace_audit_events(action,actor_credential_id,organization_id,credential_id,created_at)
    VALUES('key_issued',NEW.actor_credential_id,NEW.organization_id,NEW.id,NEW.created_at);
END;
UPDATE release_meta SET version=13 WHERE version=12;

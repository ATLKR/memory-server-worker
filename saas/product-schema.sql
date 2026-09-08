-- Apply after schema.sql and memory-schema.sql. All timestamps are Unix ms.
-- Commands are append-only transaction records. Each command plus every
-- authority change, default Space and audit event commits in one statement.
PRAGMA foreign_keys = ON;

CREATE TABLE provider_identities (
  issuer TEXT NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048 AND instr(issuer,char(0))=0),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 512 AND instr(subject,char(0))=0),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(issuer,subject)
);
CREATE INDEX provider_identities_account ON provider_identities(account_id);
CREATE TABLE workspace_sign_ins (
  id TEXT PRIMARY KEY NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  new_account_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  token_digest TEXT NOT NULL CHECK(length(token_digest)=64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('read','write')),
  email_id TEXT NOT NULL,
  address TEXT,
  domain TEXT,
  personal_space_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  CHECK(expires_at>created_at AND expires_at<=created_at+900000),
  CHECK((address IS NULL AND domain IS NULL) OR (address IS NOT NULL AND domain IS NOT NULL))
);
CREATE TABLE workspace_organization_creations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(instr(name,char(0))=0 AND length(name) BETWEEN 1 AND 100 AND length(trim(name))>0),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  email_id TEXT NOT NULL REFERENCES account_emails(id),
  membership_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE TABLE workspace_organization_metadata (
  organization_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK(instr(name,char(0))=0 AND length(name) BETWEEN 1 AND 100 AND length(trim(name))>0)
);
CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  address TEXT NOT NULL CHECK(address=lower(trim(address)) AND length(address) BETWEEN 3 AND 254 AND instr(address,char(0))=0),
  role TEXT NOT NULL CHECK(role IN ('member','admin')),
  token_digest TEXT NOT NULL UNIQUE CHECK(length(token_digest)=64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  creator_membership_id TEXT NOT NULL REFERENCES memberships(id),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+259200000),
  accepted_at INTEGER CHECK(accepted_at IS NULL OR accepted_at>=created_at)
);
CREATE INDEX workspace_invitations_organization ON workspace_invitations(organization_id);
CREATE TABLE workspace_invitation_acceptances (
  id TEXT PRIMARY KEY NOT NULL,
  invitation_id TEXT NOT NULL UNIQUE REFERENCES workspace_invitations(id),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  email_id TEXT NOT NULL REFERENCES account_emails(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE TABLE workspace_key_issuances (
  id TEXT PRIMARY KEY NOT NULL,
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  organization_id TEXT REFERENCES organizations(id),
  label TEXT NOT NULL CHECK(instr(label,char(0))=0 AND length(label) BETWEEN 1 AND 100 AND length(trim(label))>0),
  permission TEXT NOT NULL CHECK(permission IN ('read','write')),
  token_digest TEXT NOT NULL UNIQUE CHECK(length(token_digest)=64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>=created_at+86400000 AND expires_at<=created_at+7776000000)
);
CREATE TABLE workspace_key_metadata (
  credential_id TEXT PRIMARY KEY NOT NULL REFERENCES credentials(id),
  label TEXT NOT NULL CHECK(instr(label,char(0))=0 AND length(label) BETWEEN 1 AND 100 AND length(trim(label))>0),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE TABLE workspace_membership_revocations (
  id TEXT PRIMARY KEY NOT NULL,
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE TABLE workspace_key_revocations (
  id TEXT PRIMARY KEY NOT NULL,
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);
-- Identifier-only audit: no tokens/digests, names, subjects, or addresses.
CREATE TABLE workspace_audit_events (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('signed_in','organization_created','invitation_created','invitation_accepted','key_issued','key_revoked','membership_revoked')),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  account_id TEXT REFERENCES accounts(id),
  organization_id TEXT REFERENCES organizations(id),
  membership_id TEXT REFERENCES memberships(id),
  credential_id TEXT REFERENCES credentials(id),
  invitation_id TEXT REFERENCES workspace_invitations(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);

-- The application invokes this only after cryptographically verified provider
-- proof. Exact issuer+subject is the mapping key; an email is never an account key.
CREATE TRIGGER workspace_sign_in_validate BEFORE INSERT ON workspace_sign_ins
WHEN EXISTS(SELECT 1 FROM provider_identities p JOIN accounts a ON a.id=p.account_id
    WHERE p.issuer=NEW.issuer AND p.subject=NEW.subject AND a.disabled_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM credentials c WHERE c.token_digest=NEW.token_digest AND
    (c.revoked_at IS NOT NULL OR c.expires_at<=NEW.created_at OR c.kind<>'session'
      OR c.permission<>NEW.permission OR NOT EXISTS(SELECT 1 FROM provider_identities p
        WHERE p.issuer=NEW.issuer AND p.subject=NEW.subject AND p.account_id=c.account_id)))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;
CREATE TRIGGER workspace_sign_in_apply AFTER INSERT ON workspace_sign_ins BEGIN
  INSERT INTO accounts(id) SELECT NEW.new_account_id
    WHERE NOT EXISTS(SELECT 1 FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
  INSERT INTO provider_identities(issuer,subject,account_id,created_at)
    SELECT NEW.issuer,NEW.subject,NEW.new_account_id,NEW.created_at
    WHERE NOT EXISTS(SELECT 1 FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
  INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission)
    SELECT NEW.credential_id,p.account_id,'session',NEW.token_digest,NEW.expires_at,NULL,NEW.permission
    FROM provider_identities p WHERE p.issuer=NEW.issuer AND p.subject=NEW.subject
      AND NOT EXISTS(SELECT 1 FROM credentials WHERE token_digest=NEW.token_digest);
  INSERT INTO account_emails(id,account_id,address,domain,verified_at)
    SELECT NEW.email_id,p.account_id,NEW.address,NEW.domain,NEW.created_at
    FROM provider_identities p WHERE p.issuer=NEW.issuer AND p.subject=NEW.subject AND NEW.address IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM account_emails e WHERE e.address=NEW.address AND e.revoked_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=NEW.address);
  INSERT INTO spaces(id,name,account_id,security_mode,created_at,actor_credential_id)
    SELECT NEW.personal_space_id,'Personal',c.account_id,'managed',NEW.created_at,c.id
    FROM credentials c WHERE c.token_digest=NEW.token_digest
      AND NOT EXISTS(SELECT 1 FROM spaces s WHERE s.account_id=c.account_id);
  INSERT INTO workspace_audit_events(action,actor_credential_id,account_id,created_at)
    SELECT 'signed_in',c.id,c.account_id,NEW.created_at FROM credentials c WHERE c.token_digest=NEW.token_digest;
END;

CREATE TRIGGER workspace_org_validate BEFORE INSERT ON workspace_organization_creations
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id
  WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>NEW.created_at
    AND e.id=NEW.email_id AND e.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;
CREATE TRIGGER workspace_org_apply AFTER INSERT ON workspace_organization_creations BEGIN
  INSERT INTO organizations(id) VALUES(NEW.id);
  INSERT INTO workspace_organization_metadata(organization_id,name) VALUES(NEW.id,NEW.name);
  INSERT INTO memberships(id,organization_id,account_id,email_id,role)
    SELECT NEW.membership_id,NEW.id,c.account_id,NEW.email_id,'owner' FROM credentials c WHERE c.id=NEW.actor_credential_id;
  INSERT INTO spaces(id,name,organization_id,security_mode,created_at,actor_credential_id)
    VALUES(NEW.space_id,NEW.name,NEW.id,'managed',NEW.created_at,NEW.actor_credential_id);
  INSERT INTO workspace_audit_events(action,actor_credential_id,organization_id,membership_id,created_at)
    VALUES('organization_created',NEW.actor_credential_id,NEW.id,NEW.membership_id,NEW.created_at);
END;

CREATE TRIGGER workspace_invitation_validate BEFORE INSERT ON workspace_invitations
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id
  WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>NEW.created_at
    AND m.id=NEW.creator_membership_id AND m.organization_id=NEW.organization_id
    AND m.expires_at>NEW.created_at AND m.role IN ('owner','admin'))
  OR EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=NEW.address)
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;
CREATE TRIGGER workspace_invitation_audit AFTER INSERT ON workspace_invitations BEGIN
  INSERT INTO workspace_audit_events(action,actor_credential_id,organization_id,membership_id,invitation_id,created_at)
    VALUES('invitation_created',NEW.actor_credential_id,NEW.organization_id,NEW.creator_membership_id,NEW.id,NEW.created_at);
END;
CREATE TRIGGER workspace_acceptance_validate BEFORE INSERT ON workspace_invitation_acceptances
WHEN NOT EXISTS(SELECT 1 FROM workspace_invitations i
  JOIN active_memberships creator ON creator.id=i.creator_membership_id AND creator.organization_id=i.organization_id
  JOIN active_credentials c ON c.id=NEW.actor_credential_id
  JOIN account_emails e ON e.account_id=c.account_id AND e.id=NEW.email_id AND e.address=i.address
  WHERE i.id=NEW.invitation_id AND i.accepted_at IS NULL AND i.expires_at>NEW.created_at
    AND creator.expires_at>NEW.created_at AND creator.role IN ('owner','admin')
    AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>NEW.created_at AND e.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=i.address)
    AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=i.organization_id
      AND m.account_id=c.account_id AND m.revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;
CREATE TRIGGER workspace_acceptance_apply AFTER INSERT ON workspace_invitation_acceptances BEGIN
  INSERT INTO memberships(id,organization_id,account_id,email_id,role)
    SELECT NEW.id,i.organization_id,c.account_id,NEW.email_id,i.role
    FROM workspace_invitations i JOIN credentials c ON c.id=NEW.actor_credential_id WHERE i.id=NEW.invitation_id;
  UPDATE workspace_invitations SET accepted_at=NEW.created_at WHERE id=NEW.invitation_id;
  INSERT INTO workspace_audit_events(action,actor_credential_id,organization_id,membership_id,invitation_id,created_at)
    SELECT 'invitation_accepted',NEW.actor_credential_id,i.organization_id,NEW.id,i.id,NEW.created_at
    FROM workspace_invitations i WHERE i.id=NEW.invitation_id;
END;

CREATE TRIGGER workspace_key_validate BEFORE INSERT ON workspace_key_issuances
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c WHERE c.id=NEW.actor_credential_id
  AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>NEW.created_at AND (NEW.permission='read' OR c.permission='write')
  AND (NEW.organization_id IS NULL OR EXISTS(SELECT 1 FROM active_memberships m
    WHERE m.account_id=c.account_id AND m.organization_id=NEW.organization_id AND m.expires_at>NEW.created_at
      AND (NEW.permission='read' OR m.role IN ('owner','admin')))))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;
CREATE TRIGGER workspace_key_apply AFTER INSERT ON workspace_key_issuances BEGIN
  INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission)
    SELECT NEW.id,c.account_id,m.id,m.email_id,
      CASE WHEN NEW.organization_id IS NULL THEN 'personal_key' ELSE 'api_key' END,
      NEW.token_digest,NEW.expires_at,NEW.permission
    FROM credentials c LEFT JOIN active_memberships m ON m.account_id=c.account_id
      AND m.organization_id=NEW.organization_id AND m.expires_at>NEW.created_at
    WHERE c.id=NEW.actor_credential_id;
  INSERT INTO workspace_key_metadata(credential_id,label,actor_credential_id,created_at)
    VALUES(NEW.id,NEW.label,NEW.actor_credential_id,NEW.created_at);
  INSERT INTO workspace_audit_events(action,actor_credential_id,organization_id,credential_id,created_at)
    VALUES('key_issued',NEW.actor_credential_id,NEW.organization_id,NEW.id,NEW.created_at);
END;

CREATE TRIGGER workspace_membership_revocation_validate BEFORE INSERT ON workspace_membership_revocations
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c
  JOIN active_memberships actor ON actor.account_id=c.account_id AND actor.organization_id=NEW.organization_id
  JOIN memberships target ON target.id=NEW.membership_id AND target.organization_id=actor.organization_id
  WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>NEW.created_at
    AND actor.expires_at>NEW.created_at AND actor.role IN ('owner','admin') AND target.revoked_at IS NULL
    AND (target.role<>'owner' OR (actor.role='owner' AND EXISTS(SELECT 1 FROM active_memberships other
      WHERE other.organization_id=actor.organization_id AND other.role='owner'
        AND other.expires_at>NEW.created_at AND other.id<>target.id))))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;
CREATE TRIGGER workspace_membership_revocation_apply AFTER INSERT ON workspace_membership_revocations BEGIN
  UPDATE memberships SET revoked_at=NEW.created_at WHERE id=NEW.membership_id;
  INSERT INTO workspace_audit_events(action,actor_credential_id,organization_id,membership_id,created_at)
    VALUES('membership_revoked',NEW.actor_credential_id,NEW.organization_id,NEW.membership_id,NEW.created_at);
END;
CREATE TRIGGER workspace_key_revocation_validate BEFORE INSERT ON workspace_key_revocations
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c JOIN credentials target ON target.id=NEW.credential_id
  LEFT JOIN memberships target_member ON target_member.id=target.membership_id
  WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>NEW.created_at
    AND target.kind IN ('personal_key','api_key') AND target.revoked_at IS NULL
    AND (target.account_id=c.account_id OR EXISTS(SELECT 1 FROM active_memberships actor
      WHERE actor.account_id=c.account_id AND actor.organization_id=target_member.organization_id
        AND actor.expires_at>NEW.created_at AND actor.role IN ('owner','admin'))))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;
CREATE TRIGGER workspace_key_revocation_apply AFTER INSERT ON workspace_key_revocations BEGIN
  UPDATE credentials SET revoked_at=NEW.created_at WHERE id=NEW.credential_id;
  INSERT INTO workspace_audit_events(action,actor_credential_id,credential_id,created_at)
    VALUES('key_revoked',NEW.actor_credential_id,NEW.credential_id,NEW.created_at);
END;

CREATE TRIGGER provider_identities_no_replace BEFORE INSERT ON provider_identities
WHEN EXISTS(SELECT 1 FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject)
BEGIN SELECT RAISE(ABORT,'provider identity already exists'); END;
CREATE TRIGGER provider_identities_no_update BEFORE UPDATE ON provider_identities
BEGIN SELECT RAISE(ABORT,'provider identity is immutable'); END;
CREATE TRIGGER provider_identities_no_delete BEFORE DELETE ON provider_identities
BEGIN SELECT RAISE(ABORT,'provider identity is immutable'); END;
CREATE TRIGGER workspace_invitations_no_replace BEFORE INSERT ON workspace_invitations
WHEN EXISTS(SELECT 1 FROM workspace_invitations WHERE id=NEW.id OR token_digest=NEW.token_digest)
BEGIN SELECT RAISE(ABORT,'invitation already exists'); END;
CREATE TRIGGER workspace_invitations_immutable BEFORE UPDATE ON workspace_invitations
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.address IS NOT OLD.address
  OR NEW.role IS NOT OLD.role OR NEW.token_digest IS NOT OLD.token_digest
  OR NEW.creator_membership_id IS NOT OLD.creator_membership_id OR NEW.actor_credential_id IS NOT OLD.actor_credential_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at)
BEGIN SELECT RAISE(ABORT,'invitation is immutable'); END;
CREATE TRIGGER workspace_invitations_no_delete BEFORE DELETE ON workspace_invitations
BEGIN SELECT RAISE(ABORT,'invitation is immutable'); END;
CREATE TRIGGER workspace_audit_no_replace BEFORE INSERT ON workspace_audit_events
WHEN EXISTS(SELECT 1 FROM workspace_audit_events WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'workspace audit is append-only'); END;
CREATE TRIGGER workspace_audit_no_update BEFORE UPDATE ON workspace_audit_events
BEGIN SELECT RAISE(ABORT,'workspace audit is append-only'); END;
CREATE TRIGGER workspace_audit_no_delete BEFORE DELETE ON workspace_audit_events
BEGIN SELECT RAISE(ABORT,'workspace audit is append-only'); END;

CREATE TRIGGER workspace_sign_ins_no_replace BEFORE INSERT ON workspace_sign_ins
WHEN EXISTS(SELECT 1 FROM workspace_sign_ins WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_sign_ins_no_update BEFORE UPDATE ON workspace_sign_ins
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_sign_ins_no_delete BEFORE DELETE ON workspace_sign_ins
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;

CREATE TRIGGER workspace_organization_creations_no_replace BEFORE INSERT ON workspace_organization_creations
WHEN EXISTS(SELECT 1 FROM workspace_organization_creations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_organization_creations_no_update BEFORE UPDATE ON workspace_organization_creations
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_organization_creations_no_delete BEFORE DELETE ON workspace_organization_creations
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;

CREATE TRIGGER workspace_organization_metadata_no_replace BEFORE INSERT ON workspace_organization_metadata
WHEN EXISTS(SELECT 1 FROM workspace_organization_metadata WHERE organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_organization_metadata_no_update BEFORE UPDATE ON workspace_organization_metadata
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_organization_metadata_no_delete BEFORE DELETE ON workspace_organization_metadata
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;

CREATE TRIGGER workspace_invitation_acceptances_no_replace BEFORE INSERT ON workspace_invitation_acceptances
WHEN EXISTS(SELECT 1 FROM workspace_invitation_acceptances WHERE id=NEW.id OR invitation_id=NEW.invitation_id)
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_invitation_acceptances_no_update BEFORE UPDATE ON workspace_invitation_acceptances
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_invitation_acceptances_no_delete BEFORE DELETE ON workspace_invitation_acceptances
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;

CREATE TRIGGER workspace_key_issuances_no_replace BEFORE INSERT ON workspace_key_issuances
WHEN EXISTS(SELECT 1 FROM workspace_key_issuances WHERE id=NEW.id OR token_digest=NEW.token_digest)
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_key_issuances_no_update BEFORE UPDATE ON workspace_key_issuances
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_key_issuances_no_delete BEFORE DELETE ON workspace_key_issuances
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;

CREATE TRIGGER workspace_key_metadata_no_replace BEFORE INSERT ON workspace_key_metadata
WHEN EXISTS(SELECT 1 FROM workspace_key_metadata WHERE credential_id=NEW.credential_id)
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_key_metadata_no_update BEFORE UPDATE ON workspace_key_metadata
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_key_metadata_no_delete BEFORE DELETE ON workspace_key_metadata
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;

CREATE TRIGGER workspace_membership_revocations_no_replace BEFORE INSERT ON workspace_membership_revocations
WHEN EXISTS(SELECT 1 FROM workspace_membership_revocations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_membership_revocations_no_update BEFORE UPDATE ON workspace_membership_revocations
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_membership_revocations_no_delete BEFORE DELETE ON workspace_membership_revocations
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;

CREATE TRIGGER workspace_key_revocations_no_replace BEFORE INSERT ON workspace_key_revocations
WHEN EXISTS(SELECT 1 FROM workspace_key_revocations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_key_revocations_no_update BEFORE UPDATE ON workspace_key_revocations
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;
CREATE TRIGGER workspace_key_revocations_no_delete BEFORE DELETE ON workspace_key_revocations
BEGIN SELECT RAISE(ABORT,'workspace record is append-only'); END;

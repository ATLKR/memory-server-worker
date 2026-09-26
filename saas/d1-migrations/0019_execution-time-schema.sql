-- Forward SaaS migration 19: execution-time-schema.sql
-- Execute temporal authorization at SQLite statement time, including database
-- queue delays. Preserve recorded timestamps, immutable history, and exact
-- identity/tenant bindings; only temporal admission becomes stricter.

DROP TRIGGER consume_email_validate;
CREATE TRIGGER consume_email_validate BEFORE INSERT ON email_consumptions
WHEN NOT EXISTS(SELECT 1 FROM email_challenges p JOIN active_credentials c ON c.account_id=p.account_id
  WHERE p.id=NEW.challenge_id AND c.id=NEW.actor_credential_id AND c.kind='session'
    AND c.membership_id IS NULL AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
    AND c.reauthenticated_at BETWEEN max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))-300000 AND NEW.created_at
    AND p.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND p.used_at IS NULL AND p.invalidated_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=p.address))
BEGIN SELECT RAISE(ABORT,'email consumption denied'); END;

DROP TRIGGER self_revocation_validate;
CREATE TRIGGER self_revocation_validate BEFORE INSERT ON revocations WHEN NEW.kind='self'
  AND NOT EXISTS(SELECT 1 FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id
    WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.membership_id IS NULL
    AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND c.reauthenticated_at BETWEEN max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))-300000 AND NEW.created_at
    AND e.id=NEW.email_id AND e.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'self revocation denied'); END;

DROP TRIGGER domain_revocation_validate;
CREATE TRIGGER domain_revocation_validate BEFORE INSERT ON revocations WHEN NEW.kind='domain'
  AND NOT EXISTS(SELECT 1 FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id
    JOIN domain_managers g ON g.membership_id=m.id AND g.revoked_at IS NULL
    JOIN domains d ON d.id=g.domain_id AND d.organization_id=m.organization_id
    WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.membership_id IS NULL
    AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND c.reauthenticated_at BETWEEN max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))-300000 AND NEW.created_at
    AND m.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND m.role IN ('owner','admin')
    AND d.id=NEW.domain_id AND d.verified_until>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND d.revoked_at IS NULL
    AND NEW.address=lower(trim(NEW.address))
    AND substr(NEW.address,instr(NEW.address,'@')+1)=d.name)
BEGIN SELECT RAISE(ABORT,'domain revocation denied'); END;

DROP TRIGGER workspace_sign_in_validate;
CREATE TRIGGER workspace_sign_in_validate BEFORE INSERT ON workspace_sign_ins
WHEN NEW.expires_at<=max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
  OR EXISTS(SELECT 1 FROM provider_identities p JOIN accounts a ON a.id=p.account_id
    WHERE p.issuer=NEW.issuer AND p.subject=NEW.subject AND a.disabled_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM credentials c WHERE c.token_digest=NEW.token_digest AND
    (c.revoked_at IS NOT NULL OR c.expires_at<=max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) OR c.kind<>'session'
      OR c.permission<>NEW.permission OR NOT EXISTS(SELECT 1 FROM provider_identities p
        WHERE p.issuer=NEW.issuer AND p.subject=NEW.subject AND p.account_id=c.account_id)))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;

DROP TRIGGER workspace_org_validate;
CREATE TRIGGER workspace_org_validate BEFORE INSERT ON workspace_organization_creations
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id
  WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
    AND e.id=NEW.email_id AND e.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;

DROP TRIGGER workspace_invitation_validate;
CREATE TRIGGER workspace_invitation_validate BEFORE INSERT ON workspace_invitations
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id
  WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
    AND m.id=NEW.creator_membership_id AND m.organization_id=NEW.organization_id
    AND m.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND m.role IN ('owner','admin'))
  OR EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=NEW.address)
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;

DROP TRIGGER workspace_acceptance_validate;
CREATE TRIGGER workspace_acceptance_validate BEFORE INSERT ON workspace_invitation_acceptances
WHEN NOT EXISTS(SELECT 1 FROM workspace_invitations i
  JOIN active_memberships creator ON creator.id=i.creator_membership_id AND creator.organization_id=i.organization_id
  JOIN active_credentials c ON c.id=NEW.actor_credential_id
  JOIN account_emails e ON e.account_id=c.account_id AND e.id=NEW.email_id AND e.address=i.address
  WHERE i.id=NEW.invitation_id AND i.accepted_at IS NULL AND i.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
    AND creator.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND creator.role IN ('owner','admin')
    AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND e.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=i.address)
    AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=i.organization_id
      AND m.account_id=c.account_id AND m.revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;

DROP TRIGGER workspace_key_validate;
CREATE TRIGGER workspace_key_validate BEFORE INSERT ON workspace_key_issuances
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c WHERE c.id=NEW.actor_credential_id
  AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND (NEW.permission='read' OR c.permission='write')
  AND (NEW.organization_id IS NULL OR EXISTS(SELECT 1 FROM active_memberships m
    WHERE m.account_id=c.account_id AND m.organization_id=NEW.organization_id AND m.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
      AND (NEW.permission='read' OR m.role IN ('owner','admin')))))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;

DROP TRIGGER workspace_key_apply;
CREATE TRIGGER workspace_key_apply AFTER INSERT ON workspace_key_issuances BEGIN
  INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission)
    SELECT NEW.id,c.account_id,m.id,m.email_id,
      CASE WHEN NEW.organization_id IS NULL THEN 'personal_key' ELSE 'api_key' END,
      NEW.token_digest,NEW.expires_at,NEW.permission
    FROM credentials c LEFT JOIN memberships m ON m.id=(
      SELECT candidate.id FROM active_memberships candidate WHERE candidate.account_id=c.account_id
        AND candidate.organization_id=NEW.organization_id AND candidate.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)))
    WHERE c.id=NEW.actor_credential_id;
  INSERT INTO workspace_key_metadata(credential_id,label,actor_credential_id,created_at)
    VALUES(NEW.id,NEW.label,NEW.actor_credential_id,NEW.created_at);
  INSERT INTO workspace_audit_events(action,actor_credential_id,organization_id,credential_id,created_at)
    VALUES('key_issued',NEW.actor_credential_id,NEW.organization_id,NEW.id,NEW.created_at);
END;

DROP TRIGGER workspace_membership_revocation_validate;
CREATE TRIGGER workspace_membership_revocation_validate BEFORE INSERT ON workspace_membership_revocations
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c
  JOIN active_memberships actor ON actor.account_id=c.account_id AND actor.organization_id=NEW.organization_id
  JOIN memberships target ON target.id=NEW.membership_id AND target.organization_id=actor.organization_id
  WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
    AND actor.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND actor.role IN ('owner','admin') AND target.revoked_at IS NULL
    AND (target.role<>'owner' OR (actor.role='owner' AND EXISTS(SELECT 1 FROM active_memberships other
      WHERE other.organization_id=actor.organization_id AND other.role='owner'
        AND other.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND other.id<>target.id))))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;

DROP TRIGGER workspace_key_revocation_validate;
CREATE TRIGGER workspace_key_revocation_validate BEFORE INSERT ON workspace_key_revocations
WHEN NOT EXISTS(SELECT 1 FROM active_credentials c JOIN credentials target ON target.id=NEW.credential_id
  LEFT JOIN memberships target_member ON target_member.id=target.membership_id
  WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
    AND target.kind IN ('personal_key','api_key') AND target.revoked_at IS NULL
    AND (target.account_id=c.account_id OR EXISTS(SELECT 1 FROM active_memberships actor
      WHERE actor.account_id=c.account_id AND actor.organization_id=target_member.organization_id
        AND actor.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND actor.role IN ('owner','admin'))))
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;

DROP TRIGGER workspace_child_org_validate;
CREATE TRIGGER workspace_child_org_validate BEFORE INSERT ON workspace_child_organization_creations
WHEN EXISTS(SELECT 1 FROM organizations WHERE id=NEW.id)
  OR NOT EXISTS(SELECT 1 FROM active_credentials c
    JOIN active_memberships m ON m.account_id=c.account_id
    JOIN account_emails e ON e.account_id=c.account_id
    WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%'
      AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND m.organization_id=NEW.parent_organization_id
      AND m.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND m.role IN ('owner','admin')
      AND e.id=NEW.email_id AND e.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;

DROP TRIGGER release_operation_revision;
CREATE TRIGGER release_operation_revision BEFORE INSERT ON release_operations
 WHEN NEW.action IN ('update','delete','restore','erase') BEGIN
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM memories r WHERE r.id=NEW.memory_id AND r.space_id=NEW.space_id AND r.revision=NEW.expected_revision AND r.erased_at IS NULL
 AND ((NEW.action IN ('update','delete') AND r.deleted_at IS NULL)
  OR (NEW.action IN ('restore','erase') AND r.deleted_at IS NOT NULL))
 AND (NEW.action<>'restore' OR r.deleted_at+coalesce((SELECT retention_days FROM release_space_policies WHERE space_id=r.space_id),30)*86400000>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))))
 THEN RAISE(ABORT,'release_conflict') END);
END;

DROP TRIGGER release_ingest_approval_guard;
CREATE TRIGGER release_ingest_approval_guard BEFORE INSERT ON release_ingest_approvals
WHEN NOT EXISTS(SELECT 1 FROM release_ingests i JOIN release_operations o ON o.id=NEW.operation_id WHERE i.id=NEW.ingest_id AND i.account_id=o.account_id AND i.space_id=o.space_id AND i.state='review' AND i.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)))
BEGIN SELECT RAISE(ABORT,'release_conflict'); END;

DROP TRIGGER release_scim_key_validate;
CREATE TRIGGER release_scim_key_validate BEFORE INSERT ON release_scim_keys
WHEN NEW.id IS NULL OR typeof(NEW.token_digest)<>'text' OR typeof(NEW.created_at)<>'integer' OR NEW.created_at<0
  OR typeof(NEW.expires_at)<>'integer' OR NEW.expires_at<=max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) OR NEW.expires_at>NEW.created_at+2592000000
  OR NEW.revoked_at IS NOT NULL OR length(NEW.token_digest)<>64 OR NEW.token_digest GLOB '*[^0-9a-f]*'
  OR NOT EXISTS(SELECT 1 FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id
    WHERE c.id=NEW.creator_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%'
      AND c.permission='write' AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
      AND c.reauthenticated_at BETWEEN max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))-300000 AND NEW.created_at
      AND m.id=NEW.creator_membership_id AND m.email_id=NEW.creator_email_id
      AND m.organization_id=NEW.organization_id AND m.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND m.role IN ('owner','admin'))
BEGIN SELECT RAISE(ABORT,'release_denied'); END;

DROP TRIGGER release_share_validate;
CREATE TRIGGER release_share_validate BEFORE INSERT ON release_shares
WHEN NEW.id IS NULL OR typeof(NEW.created_at)<>'integer' OR NEW.created_at<0
  OR typeof(NEW.expires_at)<>'integer' OR NEW.expires_at<=max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) OR NEW.expires_at>NEW.created_at+2592000000
  OR NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM account_emails e JOIN accounts recipient ON recipient.id=e.account_id
    WHERE e.id=NEW.recipient_email_id AND e.revoked_at IS NULL AND recipient.disabled_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM active_credentials c JOIN spaces s ON s.id=NEW.space_id
    WHERE c.id=NEW.creator_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%'
      AND c.permission='write' AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
      AND c.reauthenticated_at BETWEEN max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))-300000 AND NEW.created_at
      AND ((s.account_id=c.account_id AND s.organization_id IS NULL AND NEW.creator_membership_id IS NULL AND NEW.creator_email_id IS NULL)
        OR (s.organization_id IS NOT NULL AND EXISTS(SELECT 1 FROM active_memberships m
          WHERE m.id=NEW.creator_membership_id AND m.account_id=c.account_id AND m.email_id=NEW.creator_email_id
            AND m.organization_id=s.organization_id AND m.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND m.role IN ('owner','admin')))))
BEGIN SELECT RAISE(ABORT,'release_denied'); END;

DROP TRIGGER release_checkout_closure_validate;
CREATE TRIGGER release_checkout_closure_validate BEFORE INSERT ON release_checkout_closures
WHEN NOT EXISTS(SELECT 1 FROM release_checkout_requests r JOIN active_credentials c ON c.id=NEW.actor_credential_id
 JOIN release_space_pools sp ON sp.pool_id=r.pool_id JOIN spaces s ON s.id=sp.space_id
 WHERE r.id=NEW.request_id AND r.session_id=NEW.session_id AND r.checkout_attempted=1 AND r.expires_at<=max(NEW.checked_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
   AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.permission='write' AND c.expires_at>max(NEW.checked_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
   AND c.reauthenticated_at BETWEEN max(NEW.checked_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))-300000 AND NEW.checked_at
   AND (s.account_id=c.account_id OR EXISTS(SELECT 1 FROM active_memberships m WHERE m.account_id=c.account_id
     AND m.organization_id=s.organization_id AND m.expires_at>max(NEW.checked_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND m.role IN ('owner','admin'))))
BEGIN SELECT RAISE(ABORT,'release_denied'); END;

DROP TRIGGER release_scim_deletion_validate;
CREATE TRIGGER release_scim_deletion_validate BEFORE INSERT ON release_scim_deletions
WHEN NOT EXISTS(SELECT 1 FROM memberships target JOIN release_scim_keys k ON k.organization_id=target.organization_id
 JOIN credentials issuer ON issuer.id=k.creator_credential_id
 JOIN active_memberships admin ON admin.id=k.creator_membership_id AND admin.account_id=issuer.account_id
   AND admin.email_id=k.creator_email_id AND admin.organization_id=k.organization_id
 WHERE target.id=NEW.membership_id AND k.id=NEW.scim_key_id AND k.revoked_at IS NULL AND k.expires_at>max(NEW.deleted_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
   AND admin.expires_at>max(NEW.deleted_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND admin.role IN ('owner','admin')
   AND (target.revoked_at IS NOT NULL OR target.role<>'owner' OR (admin.role='owner' AND EXISTS(
     SELECT 1 FROM active_memberships other WHERE other.organization_id=target.organization_id
       AND other.role='owner' AND other.expires_at>max(NEW.deleted_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND other.id<>target.id))))
BEGIN SELECT RAISE(ABORT,'release_denied'); END;

-- A proof consumption and its credential refresh share one SQLite statement,
-- so no later batch statement can refresh an already expired credential.
CREATE TRIGGER release_reauth_consumption_validate BEFORE UPDATE OF used_at ON release_reauth_challenges
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND (
 NEW.credential_id IS NOT OLD.credential_id OR NEW.email_id IS NOT OLD.email_id
 OR NEW.expires_at IS NOT OLD.expires_at OR NEW.expires_at<=max(NEW.used_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
 OR NOT EXISTS(SELECT 1 FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id
   WHERE c.id=NEW.credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.permission='write'
     AND c.expires_at>max(NEW.used_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND c.membership_expires_at>max(NEW.used_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
     AND e.id=NEW.email_id AND e.revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'release_denied'); END;
CREATE TRIGGER release_reauth_consumption_apply AFTER UPDATE OF used_at ON release_reauth_challenges
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL BEGIN
 UPDATE credentials SET reauthenticated_at=NEW.used_at WHERE id=NEW.credential_id;
END;

UPDATE release_meta SET version=19 WHERE version=18;

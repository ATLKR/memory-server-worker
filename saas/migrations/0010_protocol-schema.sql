-- Forward SaaS migration 10: protocol-schema.sql
-- Forward-only billing replacement receipts and SCIM deletion history.
CREATE TABLE release_checkout_closures(
 request_id TEXT PRIMARY KEY NOT NULL REFERENCES release_checkout_requests(id),
 session_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('expired','subscription_ended')),
 subscription_id TEXT,
 actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
 checked_at INTEGER NOT NULL CHECK(typeof(checked_at)='integer' AND checked_at>=0),
 CHECK((state='expired' AND subscription_id IS NULL) OR (state='subscription_ended' AND subscription_id IS NOT NULL))
);
CREATE TRIGGER release_checkout_closure_validate BEFORE INSERT ON release_checkout_closures
WHEN NOT EXISTS(SELECT 1 FROM release_checkout_requests r JOIN active_credentials c ON c.id=NEW.actor_credential_id
 JOIN release_space_pools sp ON sp.pool_id=r.pool_id JOIN spaces s ON s.id=sp.space_id
 WHERE r.id=NEW.request_id AND r.session_id=NEW.session_id AND r.checkout_attempted=1 AND r.expires_at<=NEW.checked_at
   AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.permission='write' AND c.expires_at>NEW.checked_at
   AND c.reauthenticated_at BETWEEN NEW.checked_at-300000 AND NEW.checked_at
   AND (s.account_id=c.account_id OR EXISTS(SELECT 1 FROM active_memberships m WHERE m.account_id=c.account_id
     AND m.organization_id=s.organization_id AND m.expires_at>NEW.checked_at AND m.role IN ('owner','admin'))))
BEGIN SELECT RAISE(ABORT,'release_denied'); END;
CREATE TRIGGER release_checkout_closure_no_replace BEFORE INSERT ON release_checkout_closures
WHEN EXISTS(SELECT 1 FROM release_checkout_closures WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'Checkout closure is immutable'); END;
CREATE TRIGGER release_checkout_closure_no_update BEFORE UPDATE ON release_checkout_closures
BEGIN SELECT RAISE(ABORT,'Checkout closure is immutable'); END;
CREATE TRIGGER release_checkout_closure_no_delete BEFORE DELETE ON release_checkout_closures
BEGIN SELECT RAISE(ABORT,'Checkout closure is immutable'); END;

CREATE TABLE release_scim_deletions(
 membership_id TEXT PRIMARY KEY NOT NULL REFERENCES memberships(id),
 scim_key_id TEXT NOT NULL REFERENCES release_scim_keys(id),
 deleted_at INTEGER NOT NULL CHECK(typeof(deleted_at)='integer' AND deleted_at>=0)
);
CREATE TRIGGER release_scim_deletion_validate BEFORE INSERT ON release_scim_deletions
WHEN NOT EXISTS(SELECT 1 FROM memberships target JOIN release_scim_keys k ON k.organization_id=target.organization_id
 JOIN credentials issuer ON issuer.id=k.creator_credential_id
 JOIN active_memberships admin ON admin.id=k.creator_membership_id AND admin.account_id=issuer.account_id
   AND admin.email_id=k.creator_email_id AND admin.organization_id=k.organization_id
 WHERE target.id=NEW.membership_id AND k.id=NEW.scim_key_id AND k.revoked_at IS NULL AND k.expires_at>NEW.deleted_at
   AND admin.expires_at>NEW.deleted_at AND admin.role IN ('owner','admin')
   AND (target.revoked_at IS NOT NULL OR target.role<>'owner' OR (admin.role='owner' AND EXISTS(
     SELECT 1 FROM active_memberships other WHERE other.organization_id=target.organization_id
       AND other.role='owner' AND other.expires_at>NEW.deleted_at AND other.id<>target.id))))
BEGIN SELECT RAISE(ABORT,'release_denied'); END;
CREATE TRIGGER release_scim_deletion_apply AFTER INSERT ON release_scim_deletions BEGIN
 UPDATE memberships SET revoked_at=coalesce(revoked_at,NEW.deleted_at) WHERE id=NEW.membership_id;
END;
CREATE TRIGGER release_scim_deletion_no_replace BEFORE INSERT ON release_scim_deletions
WHEN EXISTS(SELECT 1 FROM release_scim_deletions WHERE membership_id=NEW.membership_id)
BEGIN SELECT RAISE(ABORT,'SCIM deletion is immutable'); END;
CREATE TRIGGER release_scim_deletion_no_update BEFORE UPDATE ON release_scim_deletions
BEGIN SELECT RAISE(ABORT,'SCIM deletion is immutable'); END;
CREATE TRIGGER release_scim_deletion_no_delete BEFORE DELETE ON release_scim_deletions
BEGIN SELECT RAISE(ABORT,'SCIM deletion is immutable'); END;
UPDATE release_meta SET version=10 WHERE version=9;

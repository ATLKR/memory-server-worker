-- Domain verification is one guarded command: its receipt, consumed DNS proof,
-- domain ownership/renewal, and exact manager assignment commit together.
CREATE TABLE release_domain_verifications(
 id TEXT PRIMARY KEY NOT NULL,
 challenge_id TEXT NOT NULL UNIQUE REFERENCES release_domain_challenges(id),
 domain_id TEXT NOT NULL REFERENCES domains(id),
 actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
 membership_id TEXT NOT NULL REFERENCES memberships(id),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 verified_until INTEGER NOT NULL CHECK(typeof(verified_until)='integer' AND verified_until=created_at+2592000000)
);
CREATE TRIGGER release_domain_verification_validate BEFORE INSERT ON release_domain_verifications
WHEN NOT EXISTS(
 SELECT 1 FROM release_domain_challenges p JOIN active_credentials c ON c.id=NEW.actor_credential_id AND c.account_id=p.actor_account_id
 JOIN active_memberships m ON m.id=NEW.membership_id AND m.account_id=c.account_id AND m.organization_id=p.organization_id
 WHERE p.id=NEW.challenge_id AND p.used_at IS NULL AND p.verification_id IS NULL
   AND p.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
   AND c.kind='session' AND c.id NOT LIKE 'oauth:%' AND c.permission='write'
   AND c.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
   AND c.membership_expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
   AND m.expires_at>max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER)) AND m.role IN ('owner','admin')
   AND c.reauthenticated_at BETWEEN max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))-300000
     AND max(NEW.created_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))
   AND NOT EXISTS(SELECT 1 FROM domains d WHERE d.id=NEW.domain_id
     AND (d.organization_id<>p.organization_id OR d.name<>p.domain OR d.revoked_at IS NOT NULL))
   AND NOT EXISTS(SELECT 1 FROM domains d WHERE d.name=p.domain AND d.revoked_at IS NULL AND d.id<>NEW.domain_id)
   AND NOT EXISTS(SELECT 1 FROM domain_managers g WHERE g.domain_id=NEW.domain_id AND g.membership_id=m.id AND g.revoked_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT,'release_denied'); END;
CREATE TRIGGER release_domain_verification_apply AFTER INSERT ON release_domain_verifications BEGIN
 UPDATE release_domain_challenges SET used_at=NEW.created_at,verification_id=NEW.id WHERE id=NEW.challenge_id;
 INSERT INTO domains(id,organization_id,name,verified_until)
   SELECT NEW.domain_id,p.organization_id,p.domain,NEW.verified_until FROM release_domain_challenges p
   WHERE p.id=NEW.challenge_id AND NOT EXISTS(SELECT 1 FROM domains d WHERE d.id=NEW.domain_id);
 UPDATE domains SET verified_until=NEW.verified_until WHERE id=NEW.domain_id;
 INSERT INTO domain_managers(domain_id,membership_id)
   SELECT NEW.domain_id,NEW.membership_id WHERE NOT EXISTS(SELECT 1 FROM domain_managers g
     WHERE g.domain_id=NEW.domain_id AND g.membership_id=NEW.membership_id);
END;
CREATE TRIGGER release_domain_verification_no_replace BEFORE INSERT ON release_domain_verifications
WHEN EXISTS(SELECT 1 FROM release_domain_verifications WHERE id=NEW.id OR challenge_id=NEW.challenge_id)
BEGIN SELECT RAISE(ABORT,'Domain verification receipt is immutable'); END;
CREATE TRIGGER release_domain_verification_no_update BEFORE UPDATE ON release_domain_verifications
BEGIN SELECT RAISE(ABORT,'Domain verification receipt is immutable'); END;
CREATE TRIGGER release_domain_verification_no_delete BEFORE DELETE ON release_domain_verifications
BEGIN SELECT RAISE(ABORT,'Domain verification receipt is immutable'); END;

-- Older pending proofs for an exact provider-revoked account/address become
-- invalid at migration execution time. Consumed proofs and other history stay
-- unchanged. The guards also cover proofs prepared after a standing revocation.
UPDATE email_challenges SET invalidated_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER)
WHERE used_at IS NULL AND invalidated_at IS NULL AND (
 EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=email_challenges.account_id AND b.address=email_challenges.address)
 OR EXISTS(SELECT 1 FROM release_provider_revocations b JOIN provider_identities p ON p.issuer=b.issuer AND p.subject=b.subject
   WHERE p.account_id=email_challenges.account_id AND b.kind='email.revoked' AND b.address=email_challenges.address)
);
CREATE TRIGGER release_email_challenge_block BEFORE INSERT ON email_challenges
WHEN EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=NEW.account_id AND b.address=NEW.address)
 OR EXISTS(SELECT 1 FROM release_provider_revocations b JOIN provider_identities p ON p.issuer=b.issuer AND p.subject=b.subject
   WHERE p.account_id=NEW.account_id AND b.kind='email.revoked' AND b.address=NEW.address)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER release_email_consumption_block BEFORE INSERT ON email_consumptions
WHEN EXISTS(SELECT 1 FROM email_challenges challenge WHERE challenge.id=NEW.challenge_id AND (
 EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=challenge.account_id AND b.address=challenge.address)
 OR EXISTS(SELECT 1 FROM release_provider_revocations b JOIN provider_identities p ON p.issuer=b.issuer AND p.subject=b.subject
   WHERE p.account_id=challenge.account_id AND b.kind='email.revoked' AND b.address=challenge.address)
))
BEGIN SELECT RAISE(IGNORE); END;

UPDATE release_meta SET version=20 WHERE version=19;

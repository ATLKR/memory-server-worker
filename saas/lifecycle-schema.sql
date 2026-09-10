-- Ordered v2 identity lifecycle; v1 permanent tombstones remain unchanged.
ALTER TABLE workspace_sign_ins ADD COLUMN issued_at INTEGER CHECK(issued_at IS NULL OR (typeof(issued_at)='integer' AND issued_at BETWEEN 0 AND 9007199254740991));
-- These proofs are inserted only from an already verified resource JWT. They
-- retain the exact publisher body hash, so HMAC delivery is the same event.
CREATE TABLE release_identity_lifecycle_jwt_proofs(
 event_id TEXT PRIMARY KEY NOT NULL,body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
 issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL CHECK(expires_at>issued_at AND expires_at-issued_at<=900000)
);
CREATE TRIGGER release_lifecycle_jwt_time BEFORE INSERT ON release_identity_lifecycle_jwt_proofs
 WHEN NEW.issued_at>CAST(round(unixepoch('subsec')*1000) AS INTEGER) OR NEW.expires_at<=CAST(round(unixepoch('subsec')*1000) AS INTEGER)
 BEGIN SELECT RAISE(ABORT,'identity_lifecycle_jwt_expired'); END;
CREATE TRIGGER release_lifecycle_jwt_no_replace BEFORE INSERT ON release_identity_lifecycle_jwt_proofs
 WHEN EXISTS(SELECT 1 FROM release_identity_lifecycle_jwt_proofs WHERE event_id=NEW.event_id)
 BEGIN SELECT RAISE(ABORT,'Identity lifecycle proof already exists'); END;
CREATE TRIGGER release_lifecycle_jwt_no_update BEFORE UPDATE ON release_identity_lifecycle_jwt_proofs
 BEGIN SELECT RAISE(ABORT,'Identity lifecycle proof is immutable'); END;
CREATE TRIGGER release_lifecycle_jwt_no_delete BEFORE DELETE ON release_identity_lifecycle_jwt_proofs
 BEGIN SELECT RAISE(ABORT,'Identity lifecycle proof is retained'); END;
CREATE TABLE release_identity_lifecycle_events(
 id TEXT PRIMARY KEY NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),
 kind TEXT NOT NULL CHECK(kind IN ('account.suspended','account.resumed','account.deleted','email.revoked','email.verified')),
 address TEXT NOT NULL,
 occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at)='integer' AND occurred_at BETWEEN 0 AND 9007199254740991),
 received_at INTEGER NOT NULL,signed_at INTEGER NOT NULL,body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
 UNIQUE(issuer,sequence),
 CHECK((kind LIKE 'account.%' AND address='') OR (kind LIKE 'email.%' AND address=lower(trim(address)) AND length(address) BETWEEN 3 AND 254))
);
CREATE TABLE release_identity_lifecycle_state(
 issuer TEXT NOT NULL,subject TEXT NOT NULL,address TEXT NOT NULL,
 sequence INTEGER NOT NULL,kind TEXT NOT NULL,occurred_at INTEGER NOT NULL,
 event_id TEXT NOT NULL REFERENCES release_identity_lifecycle_events(id),
 PRIMARY KEY(issuer,subject,address)
);
CREATE TRIGGER release_lifecycle_event_guard BEFORE INSERT ON release_identity_lifecycle_events
 WHEN NOT EXISTS(SELECT 1 FROM release_webhook_events w WHERE w.provider='identity' AND w.event_id=NEW.id AND w.body_hash=NEW.body_hash)
 BEGIN SELECT RAISE(ABORT,'identity_lifecycle_receipt_missing'); END;
CREATE TRIGGER release_lifecycle_event_time BEFORE INSERT ON release_identity_lifecycle_events
 WHEN (EXISTS(SELECT 1 FROM release_identity_lifecycle_jwt_proofs WHERE event_id=NEW.id)
   AND NOT EXISTS(SELECT 1 FROM release_identity_lifecycle_jwt_proofs p WHERE p.event_id=NEW.id AND p.body_hash=NEW.body_hash
     AND p.issued_at<=CAST(round(unixepoch('subsec')*1000) AS INTEGER) AND p.expires_at>CAST(round(unixepoch('subsec')*1000) AS INTEGER)))
 OR (NOT EXISTS(SELECT 1 FROM release_identity_lifecycle_jwt_proofs WHERE event_id=NEW.id)
   AND CAST(round(unixepoch('subsec')*1000) AS INTEGER) NOT BETWEEN NEW.signed_at-300000 AND NEW.signed_at+300000)
 BEGIN SELECT RAISE(ABORT,'identity_lifecycle_signature_expired'); END;
CREATE TRIGGER release_lifecycle_event_no_replace BEFORE INSERT ON release_identity_lifecycle_events
 WHEN EXISTS(SELECT 1 FROM release_identity_lifecycle_events WHERE id=NEW.id OR (issuer=NEW.issuer AND sequence=NEW.sequence))
 BEGIN SELECT RAISE(ABORT,'identity_lifecycle_event_conflict'); END;
CREATE TRIGGER release_lifecycle_event_no_update BEFORE UPDATE ON release_identity_lifecycle_events
 BEGIN SELECT RAISE(ABORT,'Identity lifecycle history is immutable'); END;
CREATE TRIGGER release_lifecycle_event_no_delete BEFORE DELETE ON release_identity_lifecycle_events
 BEGIN SELECT RAISE(ABORT,'Identity lifecycle history is retained'); END;
CREATE TRIGGER release_lifecycle_state_insert BEFORE INSERT ON release_identity_lifecycle_state
 WHEN NOT EXISTS(SELECT 1 FROM release_identity_lifecycle_events e WHERE e.id=NEW.event_id AND e.issuer=NEW.issuer AND e.subject=NEW.subject AND e.address=NEW.address AND e.sequence=NEW.sequence AND e.kind=NEW.kind AND e.occurred_at=NEW.occurred_at)
 BEGIN SELECT RAISE(ABORT,'Invalid identity lifecycle state'); END;
CREATE TRIGGER release_lifecycle_state_update BEFORE UPDATE ON release_identity_lifecycle_state
 WHEN NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR NEW.address IS NOT OLD.address OR NEW.sequence<=OLD.sequence OR OLD.kind='account.deleted'
 OR NOT EXISTS(SELECT 1 FROM release_identity_lifecycle_events e WHERE e.id=NEW.event_id AND e.issuer=NEW.issuer AND e.subject=NEW.subject AND e.address=NEW.address AND e.sequence=NEW.sequence AND e.kind=NEW.kind AND e.occurred_at=NEW.occurred_at)
 BEGIN SELECT RAISE(ABORT,'Invalid identity lifecycle transition'); END;
CREATE TRIGGER release_lifecycle_state_no_delete BEFORE DELETE ON release_identity_lifecycle_state
 BEGIN SELECT RAISE(ABORT,'Identity lifecycle state is retained'); END;
CREATE TRIGGER release_lifecycle_state_no_replace BEFORE INSERT ON release_identity_lifecycle_state
 WHEN EXISTS(SELECT 1 FROM release_identity_lifecycle_state WHERE issuer=NEW.issuer AND subject=NEW.subject AND address=NEW.address)
 BEGIN SELECT RAISE(ABORT,'Identity lifecycle state already exists'); END;
CREATE TRIGGER release_lifecycle_apply AFTER INSERT ON release_identity_lifecycle_events BEGIN
 UPDATE release_identity_lifecycle_state SET sequence=NEW.sequence,kind=NEW.kind,occurred_at=NEW.occurred_at,event_id=NEW.id
 WHERE issuer=NEW.issuer AND subject=NEW.subject AND address=NEW.address AND sequence<NEW.sequence AND kind<>'account.deleted';
 INSERT INTO release_identity_lifecycle_state(issuer,subject,address,sequence,kind,occurred_at,event_id)
 SELECT NEW.issuer,NEW.subject,NEW.address,NEW.sequence,NEW.kind,NEW.occurred_at,NEW.id
 WHERE NOT EXISTS(SELECT 1 FROM release_identity_lifecycle_state WHERE issuer=NEW.issuer AND subject=NEW.subject AND address=NEW.address);
END;
-- Positive events also invalidate old grants: a resume/reverification may be
-- delivered before its preceding negative event. No event creates authority.
CREATE TRIGGER release_lifecycle_revoke_insert AFTER INSERT ON release_identity_lifecycle_state BEGIN
 UPDATE credentials SET revoked_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE revoked_at IS NULL AND NEW.address=''
   AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
 UPDATE memberships SET revoked_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE revoked_at IS NULL AND NEW.address=''
   AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
 UPDATE account_emails SET revoked_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE revoked_at IS NULL AND (NEW.address='' OR address=NEW.address)
   AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
 UPDATE email_challenges SET invalidated_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE used_at IS NULL AND invalidated_at IS NULL AND (NEW.address='' OR address=NEW.address)
   AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
 UPDATE accounts SET disabled_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE disabled_at IS NULL AND NEW.kind='account.deleted'
   AND id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
END;
CREATE TRIGGER release_lifecycle_revoke_update AFTER UPDATE ON release_identity_lifecycle_state BEGIN
 UPDATE credentials SET revoked_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE revoked_at IS NULL AND NEW.address=''
   AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
 UPDATE memberships SET revoked_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE revoked_at IS NULL AND NEW.address=''
   AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
 UPDATE account_emails SET revoked_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE revoked_at IS NULL AND (NEW.address='' OR address=NEW.address)
   AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
 UPDATE email_challenges SET invalidated_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE used_at IS NULL AND invalidated_at IS NULL AND (NEW.address='' OR address=NEW.address)
   AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
 UPDATE accounts SET disabled_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE disabled_at IS NULL AND NEW.kind='account.deleted'
   AND id IN (SELECT account_id FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
END;
CREATE TRIGGER release_lifecycle_signin BEFORE INSERT ON workspace_sign_ins
 WHEN EXISTS(SELECT 1 FROM release_identity_lifecycle_state l WHERE l.issuer=NEW.issuer AND l.subject=NEW.subject AND l.address=''
   AND (l.kind<>'account.resumed' OR NEW.issued_at IS NULL OR NEW.issued_at<=l.occurred_at))
 BEGIN SELECT RAISE(ABORT,'provider lifecycle sign-in denied'); END;
CREATE TRIGGER release_lifecycle_credential BEFORE INSERT ON credentials WHEN EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address='' WHERE p.account_id=NEW.account_id AND l.kind<>'account.resumed')
 BEGIN SELECT RAISE(ABORT,'provider lifecycle account suspended'); END;
CREATE TRIGGER release_lifecycle_claim BEFORE INSERT ON account_emails WHEN EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address='' WHERE p.account_id=NEW.account_id AND l.kind<>'account.resumed') OR EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address=NEW.address WHERE p.account_id=NEW.account_id AND l.kind='email.revoked')
 BEGIN SELECT RAISE(ABORT,'provider lifecycle email revoked'); END;
CREATE TRIGGER release_lifecycle_challenge BEFORE INSERT ON email_challenges WHEN EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address='' WHERE p.account_id=NEW.account_id AND l.kind<>'account.resumed') OR EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address=NEW.address WHERE p.account_id=NEW.account_id AND l.kind='email.revoked')
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER release_lifecycle_consumption BEFORE INSERT ON email_consumptions
 WHEN EXISTS(SELECT 1 FROM email_challenges q WHERE q.id=NEW.challenge_id AND (EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address='' WHERE p.account_id=q.account_id AND l.kind<>'account.resumed') OR EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address=q.address WHERE p.account_id=q.account_id AND l.kind='email.revoked')))
 BEGIN SELECT RAISE(IGNORE); END;

DROP VIEW active_memberships;
CREATE VIEW active_memberships AS
  SELECT m.* FROM memberships m
  JOIN accounts a ON a.id=m.account_id AND a.disabled_at IS NULL
  JOIN organizations o ON o.id=m.organization_id AND o.disabled_at IS NULL
  JOIN account_emails e ON e.id=m.email_id AND e.account_id=m.account_id AND e.revoked_at IS NULL
  WHERE m.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address='' WHERE p.account_id=m.account_id AND l.kind<>'account.resumed');
DROP VIEW active_credentials;
CREATE VIEW active_credentials AS
 SELECT c.*,coalesce(m.expires_at,9007199254740991) AS membership_expires_at
 FROM credentials c JOIN accounts a ON a.id=c.account_id AND a.disabled_at IS NULL
 LEFT JOIN memberships m ON m.id=c.membership_id AND m.account_id=c.account_id
  AND m.email_id=c.email_id AND m.revoked_at IS NULL
 WHERE c.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address='' WHERE p.account_id=c.account_id AND l.kind<>'account.resumed') AND (c.kind IN ('session','personal_key') OR (
  m.id IS NOT NULL
  AND EXISTS(SELECT 1 FROM organizations o WHERE o.id=m.organization_id AND o.disabled_at IS NULL)
  AND EXISTS(SELECT 1 FROM account_emails e WHERE e.id=m.email_id AND e.account_id=m.account_id AND e.revoked_at IS NULL)
 ));

DROP TRIGGER workspace_sign_in_apply;
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
      AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=NEW.address)
      AND NOT EXISTS(SELECT 1 FROM provider_identities mapped JOIN release_identity_lifecycle_state l ON l.issuer=mapped.issuer AND l.subject=mapped.subject AND l.address=NEW.address WHERE mapped.account_id=p.account_id AND l.kind='email.revoked')
      AND NOT EXISTS(SELECT 1 FROM release_identity_lifecycle_state l JOIN provider_identities mapped ON mapped.issuer=l.issuer AND mapped.subject=l.subject
        WHERE mapped.account_id=p.account_id AND l.address=NEW.address AND l.kind='email.verified' AND (NEW.issued_at IS NULL OR NEW.issued_at<=l.occurred_at))
      AND NOT EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=p.account_id AND b.address=NEW.address)
      AND NOT EXISTS(SELECT 1 FROM release_provider_revocations b
        JOIN provider_identities mapped ON mapped.issuer=b.issuer AND mapped.subject=b.subject
        WHERE mapped.account_id=p.account_id AND b.kind='email.revoked' AND b.address=NEW.address);
  INSERT INTO spaces(id,name,account_id,security_mode,created_at,actor_credential_id)
    SELECT NEW.personal_space_id,'Personal',c.account_id,'managed',NEW.created_at,c.id
    FROM credentials c WHERE c.token_digest=NEW.token_digest
      AND NOT EXISTS(SELECT 1 FROM spaces s WHERE s.account_id=c.account_id);
  INSERT INTO workspace_audit_events(action,actor_credential_id,account_id,created_at)
    SELECT 'signed_in',c.id,c.account_id,NEW.created_at FROM credentials c WHERE c.token_digest=NEW.token_digest;
END;
UPDATE release_meta SET version=24 WHERE version=23;

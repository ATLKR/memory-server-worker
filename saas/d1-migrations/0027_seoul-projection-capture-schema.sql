-- Forward SaaS migration 27: seoul-projection-capture-schema.sql
-- Inactive explicit capture for scoped key issuance and self email unlink.
-- No triggers are attached to authoritative central tables; no runtime injects
-- this dependency. Transient rows exist only inside the trusted atomic batch.
CREATE TABLE release_seoul_capture_attempts(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 command_kind TEXT NOT NULL CHECK(command_kind IN ('scoped-key','self-email-unlink')),
 account_id TEXT REFERENCES accounts(id),
 entity_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL,
 organization_id TEXT,
 requested_space_ids TEXT,
 address TEXT,
 previously_present INTEGER NOT NULL CHECK(previously_present IN (0,1)),
 accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)),
 identity_count INTEGER NOT NULL DEFAULT 0,
 identity_bytes INTEGER NOT NULL DEFAULT 0,
 unsupported_mapping INTEGER NOT NULL DEFAULT 0,
 anchor_subject TEXT,
 membership_count INTEGER NOT NULL DEFAULT 0,
 credential_count INTEGER NOT NULL DEFAULT 0,
 space_count INTEGER NOT NULL DEFAULT 0,
 source_bytes INTEGER NOT NULL DEFAULT 0,
 largest_source INTEGER NOT NULL DEFAULT 0,
 exclusion_reason TEXT CHECK(exclusion_reason IS NULL OR exclusion_reason IN ('unmapped','unsupported-mapping','identity-count','identity-bytes','fanout-count','source-bytes','unsupported-state')),
 captured_at INTEGER NOT NULL DEFAULT(CAST(round(unixepoch('subsec')*1000) AS INTEGER))
);
CREATE TABLE release_seoul_capture_scope(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_capture_attempts(id),
 stream_kind TEXT NOT NULL CHECK(stream_kind IN ('email','membership','credential')),
 stream_key TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 issuer TEXT,
 subject TEXT,
 address TEXT,
 prior_claim_id TEXT,
 before_bytes TEXT CHECK(before_bytes IS NULL OR length(CAST(before_bytes AS BLOB))<=131072),
 after_bytes TEXT CHECK(after_bytes IS NULL OR length(CAST(after_bytes AS BLOB))<=131072),
 PRIMARY KEY(attempt_id,stream_kind,stream_key)
);
CREATE TABLE release_seoul_capture_spaces(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_capture_attempts(id),
 space_id TEXT NOT NULL REFERENCES spaces(id),
 PRIMARY KEY(attempt_id,space_id)
);
CREATE TABLE release_seoul_account_exclusions(
 account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id),
 reason TEXT NOT NULL CHECK(reason IN ('unmapped','unsupported-mapping','identity-count','identity-bytes','fanout-count','source-bytes','unsupported-state')),
 capture_attempt_id TEXT NOT NULL CHECK(length(capture_attempt_id)=36),
 count_lower_bound INTEGER NOT NULL CHECK(count_lower_bound BETWEEN 0 AND 2049),
 byte_estimate INTEGER NOT NULL CHECK(typeof(byte_estimate)='integer' AND byte_estimate>=0),
 captured_at INTEGER NOT NULL CHECK(typeof(captured_at)='integer' AND captured_at>=0)
);
CREATE TRIGGER release_seoul_exclusion_no_update BEFORE UPDATE ON release_seoul_account_exclusions
 BEGIN SELECT RAISE(ABORT,'projection exclusion requires reviewed remediation'); END;
CREATE TRIGGER release_seoul_exclusion_no_delete BEFORE DELETE ON release_seoul_account_exclusions
 BEGIN SELECT RAISE(ABORT,'projection exclusion is retained'); END;
CREATE TRIGGER release_seoul_exclusion_no_replace BEFORE INSERT ON release_seoul_account_exclusions
 WHEN EXISTS(SELECT 1 FROM release_seoul_account_exclusions WHERE account_id=NEW.account_id)
 BEGIN SELECT RAISE(ABORT,'projection exclusion already exists'); END;
CREATE INDEX release_seoul_identity_scope ON provider_identities(account_id,issuer,subject);
CREATE INDEX release_seoul_membership_scope ON memberships(email_id,organization_id,id);
CREATE INDEX release_seoul_credential_scope ON credentials(email_id,kind,id);
UPDATE release_meta SET version=27 WHERE version=26;

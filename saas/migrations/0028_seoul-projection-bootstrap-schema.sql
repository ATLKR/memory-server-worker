-- Forward SaaS migration 28: seoul-projection-bootstrap-schema.sql
-- Additive, inactive bootstrap staging. Candidate IDs never authorize writes.
-- All staging is removed in the same batch; no retained history is changed.
CREATE TABLE release_seoul_bootstrap_attempts(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 command_kind TEXT NOT NULL CHECK(command_kind IN ('workspace-sign-in','organization-create','organization-child-create')),
 receipt_id TEXT NOT NULL, account_id TEXT, candidate_account_id TEXT,
 issuer TEXT, subject TEXT, address TEXT, email_id TEXT NOT NULL,
 credential_id TEXT, membership_id TEXT, space_id TEXT NOT NULL, organization_id TEXT,
 receipt_before INTEGER NOT NULL DEFAULT 0 CHECK(receipt_before IN (0,1)),
 account_before INTEGER NOT NULL DEFAULT 0 CHECK(account_before IN (0,1)),
 mapping_before INTEGER NOT NULL DEFAULT 0 CHECK(mapping_before IN (0,1)),
 email_before INTEGER NOT NULL DEFAULT 0 CHECK(email_before IN (0,1)),
 credential_before INTEGER NOT NULL DEFAULT 0 CHECK(credential_before IN (0,1)),
 space_before INTEGER NOT NULL DEFAULT 0 CHECK(space_before IN (0,1)),
 organization_before INTEGER NOT NULL DEFAULT 0 CHECK(organization_before IN (0,1)),
 membership_before INTEGER NOT NULL DEFAULT 0 CHECK(membership_before IN (0,1)),
 accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)),
 mapping_created INTEGER NOT NULL DEFAULT 0 CHECK(mapping_created IN (0,1)),
 email_created INTEGER NOT NULL DEFAULT 0 CHECK(email_created IN (0,1)),
 space_created INTEGER NOT NULL DEFAULT 0 CHECK(space_created IN (0,1)),
 identity_count INTEGER NOT NULL DEFAULT 0, identity_bytes INTEGER NOT NULL DEFAULT 0,
 claim_count INTEGER NOT NULL DEFAULT 0, membership_count INTEGER NOT NULL DEFAULT 0,
 space_count INTEGER NOT NULL DEFAULT 0, source_count INTEGER NOT NULL DEFAULT 0,
 source_bytes INTEGER NOT NULL DEFAULT 0, largest_source INTEGER NOT NULL DEFAULT 0,
 anchor_subject TEXT,
 exclusion_reason TEXT CHECK(exclusion_reason IS NULL OR exclusion_reason IN ('unmapped','unsupported-mapping','identity-count','identity-bytes','fanout-count','source-bytes','unsupported-state')),
 captured_at INTEGER NOT NULL DEFAULT(CAST(round(unixepoch('subsec')*1000) AS INTEGER))
);
CREATE TABLE release_seoul_bootstrap_scope(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_bootstrap_attempts(id),
 stream_kind TEXT NOT NULL CHECK(stream_kind IN ('subject','email','organization','membership','space')),
 stream_key TEXT NOT NULL, entity_id TEXT, issuer TEXT, subject TEXT, address TEXT,
 subject_sort_key TEXT,
 before_bytes TEXT CHECK(before_bytes IS NULL OR length(CAST(before_bytes AS BLOB))<=131072),
 after_bytes TEXT CHECK(after_bytes IS NULL OR length(CAST(after_bytes AS BLOB))<=131072),
 PRIMARY KEY(attempt_id,stream_kind,stream_key)
);
CREATE TABLE release_seoul_bootstrap_spaces(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_bootstrap_attempts(id),
 space_id TEXT NOT NULL,
 dependency TEXT NOT NULL CHECK(dependency IN ('mapping','claim','new')),
 PRIMARY KEY(attempt_id,space_id,dependency)
);
CREATE INDEX release_seoul_bootstrap_email_scope ON account_emails(account_id,address,id);
CREATE TRIGGER release_seoul_bootstrap_staging_guard BEFORE INSERT ON release_seoul_bootstrap_attempts
 WHEN EXISTS(SELECT 1 FROM release_seoul_bootstrap_attempts)
 BEGIN SELECT RAISE(ABORT,'bootstrap staging is not empty'); END;
UPDATE release_meta SET version=28 WHERE version=27;

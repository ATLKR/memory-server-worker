-- Inactive, exact-command staging. No new authority or durable command receipt.
CREATE TABLE release_seoul_command_attempts(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 command_kind TEXT NOT NULL CHECK(command_kind IN ('email-link','domain-email-revoke','scim-deactivate','scim-delete','space-create')),
 receipt_id TEXT, entity_id TEXT NOT NULL, actor_id TEXT, challenge_id TEXT,
 domain_id TEXT, scim_key_id TEXT, account_id TEXT, organization_id TEXT,
 email_id TEXT, address TEXT, command_at INTEGER NOT NULL,
 receipt_before INTEGER NOT NULL DEFAULT 0 CHECK(receipt_before IN (0,1)),
 entity_before INTEGER NOT NULL DEFAULT 0 CHECK(entity_before IN (0,1)),
 member_was_live INTEGER NOT NULL DEFAULT 0 CHECK(member_was_live IN (0,1)),
 accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)),
 identity_count INTEGER NOT NULL DEFAULT 0, identity_bytes INTEGER NOT NULL DEFAULT 0,
 membership_count INTEGER NOT NULL DEFAULT 0, credential_count INTEGER NOT NULL DEFAULT 0,
 space_count INTEGER NOT NULL DEFAULT 0, source_count INTEGER NOT NULL DEFAULT 0,
 source_bytes INTEGER NOT NULL DEFAULT 0, largest_source INTEGER NOT NULL DEFAULT 0,
 anchor_subject TEXT,
 exclusion_reason TEXT CHECK(exclusion_reason IS NULL OR exclusion_reason IN ('unmapped','unsupported-mapping','identity-count','identity-bytes','fanout-count','source-bytes','unsupported-state')),
 captured_at INTEGER NOT NULL DEFAULT(CAST(round(unixepoch('subsec')*1000) AS INTEGER))
);
CREATE TABLE release_seoul_command_scope(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_command_attempts(id),
 stream_kind TEXT NOT NULL CHECK(stream_kind IN ('email','membership','credential','space')),
 stream_key TEXT NOT NULL, entity_id TEXT, issuer TEXT, subject TEXT, address TEXT,
 before_bytes TEXT CHECK(before_bytes IS NULL OR length(CAST(before_bytes AS BLOB))<=131072),
 after_bytes TEXT CHECK(after_bytes IS NULL OR length(CAST(after_bytes AS BLOB))<=131072),
 PRIMARY KEY(attempt_id,stream_kind,stream_key)
);
CREATE TABLE release_seoul_command_spaces(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_command_attempts(id),
 space_id TEXT NOT NULL, PRIMARY KEY(attempt_id,space_id)
);
CREATE TRIGGER release_seoul_command_staging_guard BEFORE INSERT ON release_seoul_command_attempts
 WHEN EXISTS(SELECT 1 FROM release_seoul_command_attempts)
 BEGIN SELECT RAISE(ABORT,'command capture staging is not empty'); END;
-- Equality probes exclude arbitrarily large revoked history before LIMIT513.
CREATE INDEX release_seoul_command_live_memberships ON memberships(email_id,revoked_at,id);
CREATE INDEX release_seoul_command_live_email_credentials ON credentials(email_id,revoked_at,kind,id);
UPDATE release_meta SET version=32 WHERE version=31;

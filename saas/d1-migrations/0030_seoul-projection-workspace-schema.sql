-- Forward SaaS migration 30: seoul-projection-workspace-schema.sql
-- Additive inactive staging for four exact Workspace authority commands.
-- An attempt is transient scope, never a command receipt or authorization.
CREATE TABLE release_seoul_workspace_attempts(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 command_kind TEXT NOT NULL CHECK(command_kind IN ('invite-accept','membership-revoke','workspace-key-issue','workspace-key-revoke')),
 receipt_id TEXT NOT NULL, entity_id TEXT NOT NULL,
 actor_id TEXT, invitation_id TEXT, account_id TEXT, organization_id TEXT,
 membership_id TEXT, email_id TEXT, address TEXT,
 command_at INTEGER NOT NULL DEFAULT 0,
 receipt_before INTEGER NOT NULL DEFAULT 0 CHECK(receipt_before IN (0,1)),
 entity_before INTEGER NOT NULL DEFAULT 0 CHECK(entity_before IN (0,1)),
 accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)),
 identity_count INTEGER NOT NULL DEFAULT 0, identity_bytes INTEGER NOT NULL DEFAULT 0,
 credential_count INTEGER NOT NULL DEFAULT 0, space_count INTEGER NOT NULL DEFAULT 0,
 source_bytes INTEGER NOT NULL DEFAULT 0, largest_source INTEGER NOT NULL DEFAULT 0,
 anchor_subject TEXT,
 exclusion_reason TEXT CHECK(exclusion_reason IS NULL OR exclusion_reason IN ('unmapped','unsupported-mapping','identity-count','identity-bytes','fanout-count','source-bytes','unsupported-state')),
 captured_at INTEGER NOT NULL DEFAULT(CAST(round(unixepoch('subsec')*1000) AS INTEGER))
);
CREATE TABLE release_seoul_workspace_scope(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_workspace_attempts(id),
 stream_kind TEXT NOT NULL CHECK(stream_kind IN ('membership','credential')),
 entity_id TEXT NOT NULL,
 before_bytes TEXT CHECK(before_bytes IS NULL OR length(CAST(before_bytes AS BLOB))<=131072),
 after_bytes TEXT CHECK(after_bytes IS NULL OR length(CAST(after_bytes AS BLOB))<=131072),
 PRIMARY KEY(attempt_id,stream_kind,entity_id)
);
CREATE TABLE release_seoul_workspace_spaces(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_workspace_attempts(id),
 space_id TEXT NOT NULL, PRIMARY KEY(attempt_id,space_id)
);
CREATE TRIGGER release_seoul_workspace_staging_guard BEFORE INSERT ON release_seoul_workspace_attempts
 WHEN EXISTS(SELECT 1 FROM release_seoul_workspace_attempts)
 BEGIN SELECT RAISE(ABORT,'workspace capture staging is not empty'); END;
-- The live exact-membership probe must not traverse unbounded revoked history.
CREATE INDEX release_seoul_workspace_live_credentials ON credentials(membership_id,revoked_at,kind,id);
UPDATE release_meta SET version=30 WHERE version=29;

-- Inactive additive V1 capture; staging conveys no authority or readiness.
CREATE TABLE release_seoul_provider_v1_attempts(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 publisher_event_id TEXT NOT NULL, body_hash TEXT NOT NULL,
 issuer TEXT NOT NULL, subject TEXT NOT NULL, address TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('account.disabled','email.revoked')),
 account_id TEXT, key_supported INTEGER NOT NULL CHECK(key_supported IN (0,1)),
 receipt_before INTEGER NOT NULL DEFAULT 0, tombstone_before INTEGER NOT NULL DEFAULT 0,
 disabled_before INTEGER, block_before INTEGER NOT NULL DEFAULT 0, claim_before TEXT,
 receipt_new INTEGER NOT NULL DEFAULT 0, tombstone_new INTEGER NOT NULL DEFAULT 0,
 changed INTEGER NOT NULL DEFAULT 0, stored_revocation_at INTEGER,
 identity_count INTEGER NOT NULL DEFAULT 0, identity_bytes INTEGER NOT NULL DEFAULT 0,
 membership_count INTEGER NOT NULL DEFAULT 0, credential_count INTEGER NOT NULL DEFAULT 0,
 space_count INTEGER NOT NULL DEFAULT 0, source_count INTEGER NOT NULL DEFAULT 0,
 source_bytes INTEGER NOT NULL DEFAULT 0, largest_source INTEGER NOT NULL DEFAULT 0,
 anchor_subject TEXT,
 exclusion_reason TEXT CHECK(exclusion_reason IS NULL OR exclusion_reason IN ('unmapped','unsupported-mapping','identity-count','identity-bytes','fanout-count','source-bytes','unsupported-state')),
 captured_at INTEGER NOT NULL DEFAULT(CAST(round(unixepoch('subsec')*1000) AS INTEGER))
);
CREATE TABLE release_seoul_provider_v1_identities(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_provider_v1_attempts(id),
 issuer TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, sort_key TEXT NOT NULL,
 PRIMARY KEY(attempt_id,issuer,subject)
);
CREATE TABLE release_seoul_provider_v1_scope(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_provider_v1_attempts(id),
 stream_kind TEXT NOT NULL CHECK(stream_kind IN ('subject','email','membership','credential')),
 stream_key TEXT NOT NULL, entity_id TEXT, issuer TEXT, subject TEXT, address TEXT,
 prior_claim_id TEXT,
 before_bytes TEXT CHECK(before_bytes IS NULL OR length(CAST(before_bytes AS BLOB))<=131072),
 after_bytes TEXT CHECK(after_bytes IS NULL OR length(CAST(after_bytes AS BLOB))<=131072),
 PRIMARY KEY(attempt_id,stream_kind,stream_key)
);
CREATE TABLE release_seoul_provider_v1_spaces(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_provider_v1_attempts(id),
 space_id TEXT NOT NULL, PRIMARY KEY(attempt_id,space_id)
);
CREATE TRIGGER release_seoul_provider_v1_staging_guard BEFORE INSERT ON release_seoul_provider_v1_attempts
 WHEN EXISTS(SELECT 1 FROM release_seoul_provider_v1_attempts)
 OR EXISTS(SELECT 1 FROM release_seoul_provider_v1_identities)
 OR EXISTS(SELECT 1 FROM release_seoul_provider_v1_scope)
 OR EXISTS(SELECT 1 FROM release_seoul_provider_v1_spaces)
 BEGIN SELECT RAISE(ABORT,'V1 capture staging is not empty'); END;
UPDATE release_meta SET version=33 WHERE version=32;

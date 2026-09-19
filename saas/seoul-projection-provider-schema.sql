-- Inactive, additive V2 capture. Staging is never authority or readiness.
CREATE TABLE release_seoul_provider_operations(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 account_id TEXT, account_wide INTEGER NOT NULL CHECK(account_wide IN (0,1)),
 address TEXT NOT NULL, event_count INTEGER NOT NULL CHECK(event_count BETWEEN 1 AND 2),
 identity_count INTEGER NOT NULL DEFAULT 0, identity_bytes INTEGER NOT NULL DEFAULT 0,
 claim_count INTEGER NOT NULL DEFAULT 0, membership_count INTEGER NOT NULL DEFAULT 0,
 credential_count INTEGER NOT NULL DEFAULT 0, space_count INTEGER NOT NULL DEFAULT 0,
 source_count INTEGER NOT NULL DEFAULT 0, source_bytes INTEGER NOT NULL DEFAULT 0,
 largest_source INTEGER NOT NULL DEFAULT 0, anchor_subject TEXT,
 exclusion_reason TEXT CHECK(exclusion_reason IS NULL OR exclusion_reason IN ('unmapped','unsupported-mapping','identity-count','identity-bytes','fanout-count','source-bytes','unsupported-state')),
 captured_at INTEGER NOT NULL DEFAULT(CAST(round(unixepoch('subsec')*1000) AS INTEGER))
);
CREATE TABLE release_seoul_provider_attempts(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 operation_id TEXT NOT NULL REFERENCES release_seoul_provider_operations(id),
 ordinal INTEGER NOT NULL CHECK(ordinal IN (0,1)),
 publisher_event_id TEXT NOT NULL, body_hash TEXT NOT NULL,
 issuer TEXT NOT NULL, subject TEXT NOT NULL, address TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('account.suspended','account.resumed','account.deleted','email.revoked','email.verified')),
 sequence INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
 key_supported INTEGER NOT NULL CHECK(key_supported IN (0,1)),
 event_before INTEGER NOT NULL DEFAULT 0 CHECK(event_before IN (0,1)),
 receipt_before INTEGER NOT NULL DEFAULT 0 CHECK(receipt_before IN (0,1)),
 advanced INTEGER NOT NULL DEFAULT 0 CHECK(advanced IN (0,1)),
 UNIQUE(operation_id,ordinal)
);
CREATE TABLE release_seoul_provider_identities(
 operation_id TEXT NOT NULL REFERENCES release_seoul_provider_operations(id),
 issuer TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, sort_key TEXT NOT NULL,
 PRIMARY KEY(operation_id,issuer,subject)
);
CREATE TABLE release_seoul_provider_scope(
 attempt_id TEXT NOT NULL REFERENCES release_seoul_provider_attempts(id),
 stream_kind TEXT NOT NULL CHECK(stream_kind IN ('subject','email','membership','credential')),
 stream_key TEXT NOT NULL, entity_id TEXT, issuer TEXT, subject TEXT, address TEXT,
 prior_claim_id TEXT,
 before_bytes TEXT CHECK(before_bytes IS NULL OR length(CAST(before_bytes AS BLOB))<=131072),
 after_bytes TEXT CHECK(after_bytes IS NULL OR length(CAST(after_bytes AS BLOB))<=131072),
 PRIMARY KEY(attempt_id,stream_kind,stream_key)
);
CREATE TABLE release_seoul_provider_spaces(
 operation_id TEXT NOT NULL REFERENCES release_seoul_provider_operations(id),
 space_id TEXT NOT NULL, PRIMARY KEY(operation_id,space_id)
);
CREATE TRIGGER release_seoul_provider_staging_guard BEFORE INSERT ON release_seoul_provider_operations
 WHEN EXISTS(SELECT 1 FROM release_seoul_provider_operations)
 BEGIN SELECT RAISE(ABORT,'provider capture staging is not empty'); END;
-- Durable mapping is retained only for actual new lifecycle state advancement.
-- It deliberately has no FK to the transient operation/attempt rows.
CREATE TABLE release_seoul_provider_groups(
 outer_operation_id TEXT NOT NULL CHECK(length(outer_operation_id)=36),
 ordinal INTEGER NOT NULL CHECK(ordinal IN (0,1)),
 sub_attempt_id TEXT NOT NULL UNIQUE CHECK(length(sub_attempt_id)=36),
 publisher_event_id TEXT NOT NULL REFERENCES release_identity_lifecycle_events(id),
 PRIMARY KEY(outer_operation_id,ordinal)
);
CREATE TRIGGER release_seoul_provider_group_guard BEFORE INSERT ON release_seoul_provider_groups
 WHEN NOT EXISTS(SELECT 1 FROM release_seoul_provider_attempts a WHERE a.id=NEW.sub_attempt_id
  AND a.operation_id=NEW.outer_operation_id AND a.ordinal=NEW.ordinal AND a.publisher_event_id=NEW.publisher_event_id AND a.advanced=1)
 OR EXISTS(SELECT 1 FROM release_seoul_provider_groups WHERE sub_attempt_id=NEW.sub_attempt_id
  OR (outer_operation_id=NEW.outer_operation_id AND ordinal=NEW.ordinal))
 BEGIN SELECT RAISE(ABORT,'provider capture group requires fresh accepted advancement'); END;
CREATE TRIGGER release_seoul_provider_group_no_update BEFORE UPDATE ON release_seoul_provider_groups
 BEGIN SELECT RAISE(ABORT,'provider capture group is immutable'); END;
CREATE TRIGGER release_seoul_provider_group_no_delete BEFORE DELETE ON release_seoul_provider_groups
 BEGIN SELECT RAISE(ABORT,'provider capture group is retained'); END;
-- Full history is counted before source/fanout construction. Existing live-only
-- authority indexes cannot bound a retained account's historical population.
CREATE INDEX release_seoul_provider_membership_scope ON memberships(account_id,organization_id,email_id,id);
CREATE INDEX release_seoul_provider_credential_scope ON credentials(account_id,kind,email_id,id);
UPDATE release_meta SET version=31 WHERE version=30;

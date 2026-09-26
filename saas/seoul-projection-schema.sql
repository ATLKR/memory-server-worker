-- Inactive Seoul projection foundation. No central write hooks, backfill,
-- preparer, dispatcher, regional authority or route is enabled by this schema.
-- Times and counters use safe integer milliseconds. TEXT retains exact UTF-8
-- bytes; limits measure CAST(... AS BLOB), not Unicode character counts.
CREATE TABLE release_seoul_projection_state(
 id INTEGER PRIMARY KEY CHECK(id=1),
 state TEXT NOT NULL CHECK(state='backfill-required')
);
INSERT INTO release_seoul_projection_state VALUES(1,'backfill-required');
CREATE TRIGGER release_seoul_state_no_replace BEFORE INSERT ON release_seoul_projection_state
 WHEN EXISTS(SELECT 1 FROM release_seoul_projection_state WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'projection remains unready'); END;
CREATE TRIGGER release_seoul_state_no_delete BEFORE DELETE ON release_seoul_projection_state
 BEGIN SELECT RAISE(ABORT,'projection state is retained'); END;

-- The authoritative batch records an effective, projection-safe source record
-- and a caller-generated command/event identity. The database assigns revision.
-- A source record is not a transport envelope. No SQL SHA256 is assumed.
-- Writers omit revision. BEFORE INSERT must not inspect the unassigned rowid;
-- source replay compares supplied immutable fields, then AFTER INSERT checks
-- the actual revision. Replay is a no-op, not rollback of other batch writes.
CREATE TABLE release_seoul_authority_changes(
 revision INTEGER PRIMARY KEY AUTOINCREMENT CHECK(revision BETWEEN 1 AND 9007199254740991),
 source_command_id TEXT NOT NULL CHECK(typeof(source_command_id)='text' AND length(source_command_id) BETWEEN 1 AND 256),
 stream_kind TEXT NOT NULL CHECK(stream_kind IN ('subject','email','organization','membership','credential','space','target')),
 stream_key TEXT NOT NULL CHECK(typeof(stream_key)='text' AND length(CAST(stream_key AS BLOB)) BETWEEN 1 AND 2048),
 event_id TEXT NOT NULL UNIQUE CHECK(length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-' AND length(replace(event_id,'-',''))=32 AND replace(event_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 record_bytes TEXT NOT NULL CHECK(typeof(record_bytes)='text' AND length(CAST(record_bytes AS BLOB)) BETWEEN 1 AND 131072),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 UNIQUE(source_command_id,stream_kind,stream_key),
 UNIQUE(revision,stream_kind,stream_key,event_id),
 UNIQUE(revision,event_id)
);
CREATE TRIGGER release_seoul_change_insert BEFORE INSERT ON release_seoul_authority_changes BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_projection_events WHERE event_id=NEW.event_id AND event_kind<>'head') THEN RAISE(ABORT,'source event identity conflict') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_authority_changes c
  WHERE (c.event_id=NEW.event_id OR (c.source_command_id=NEW.source_command_id AND c.stream_kind=NEW.stream_kind AND c.stream_key=NEW.stream_key))
   AND NOT (c.source_command_id=NEW.source_command_id AND c.stream_kind=NEW.stream_kind AND c.stream_key=NEW.stream_key AND c.event_id=NEW.event_id AND c.record_bytes=NEW.record_bytes AND c.created_at=NEW.created_at))
  THEN RAISE(ABORT,'authority change conflict') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE event_id=NEW.event_id) THEN RAISE(IGNORE) END);
END;
CREATE TRIGGER release_seoul_change_no_update BEFORE UPDATE ON release_seoul_authority_changes
 BEGIN SELECT RAISE(ABORT,'authority changes are immutable'); END;
CREATE TRIGGER release_seoul_change_no_delete BEFORE DELETE ON release_seoul_authority_changes
 BEGIN SELECT RAISE(ABORT,'authority changes are retained'); END;

-- payload_sha256 on a HEAD is the digest of the canonical immutable SOURCE
-- core including its assigned revision. NULL means digest_pending and is never
-- a usable dependency. Transport SHA256 is a separate prepared-source field.
CREATE TABLE release_seoul_authority_heads(
 stream_kind TEXT NOT NULL,
 stream_key TEXT NOT NULL,
 revision INTEGER NOT NULL,
 event_id TEXT NOT NULL,
 payload_sha256 TEXT CHECK(payload_sha256 IS NULL OR (length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')),
 PRIMARY KEY(stream_kind,stream_key),
 FOREIGN KEY(revision,stream_kind,stream_key,event_id) REFERENCES release_seoul_authority_changes(revision,stream_kind,stream_key,event_id),
 FOREIGN KEY(revision,event_id,payload_sha256) REFERENCES release_seoul_prepared_sources(revision,event_id,source_sha256)
);
CREATE TRIGGER release_seoul_head_insert BEFORE INSERT ON release_seoul_authority_heads BEGIN
 SELECT (CASE WHEN NEW.revision<(SELECT revision FROM release_seoul_authority_heads WHERE stream_kind=NEW.stream_kind AND stream_key=NEW.stream_key) THEN RAISE(ABORT,'head revision must be monotonic') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_authority_heads h WHERE h.stream_kind=NEW.stream_kind AND h.stream_key=NEW.stream_key AND h.revision=NEW.revision AND (h.event_id<>NEW.event_id OR (h.payload_sha256 IS NOT NULL AND h.payload_sha256 IS NOT NEW.payload_sha256))) THEN RAISE(ABORT,'head conflict') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_authority_heads h WHERE h.stream_kind=NEW.stream_kind AND h.stream_key=NEW.stream_key AND h.revision=NEW.revision AND h.event_id=NEW.event_id AND h.payload_sha256 IS NEW.payload_sha256) THEN RAISE(IGNORE) END);
 SELECT (CASE WHEN NEW.revision IS NOT (SELECT max(revision) FROM release_seoul_authority_changes WHERE stream_kind=NEW.stream_kind AND stream_key=NEW.stream_key) THEN RAISE(ABORT,'head must name current source change') END);
END;
CREATE TRIGGER release_seoul_head_update BEFORE UPDATE ON release_seoul_authority_heads BEGIN
 SELECT (CASE WHEN NEW.stream_kind<>OLD.stream_kind OR NEW.stream_key<>OLD.stream_key THEN RAISE(ABORT,'head identity is immutable') END);
 SELECT (CASE WHEN NEW.revision<OLD.revision THEN RAISE(ABORT,'head revision must be monotonic') END);
 SELECT (CASE WHEN NEW.revision=OLD.revision AND (NEW.event_id<>OLD.event_id OR (OLD.payload_sha256 IS NOT NULL AND NEW.payload_sha256 IS NOT OLD.payload_sha256)) THEN RAISE(ABORT,'head conflict') END);
 SELECT (CASE WHEN NEW.revision IS NOT (SELECT max(revision) FROM release_seoul_authority_changes WHERE stream_kind=NEW.stream_kind AND stream_key=NEW.stream_key) THEN RAISE(ABORT,'head must name current source change') END);
END;
CREATE TRIGGER release_seoul_head_no_delete BEFORE DELETE ON release_seoul_authority_heads
 BEGIN SELECT RAISE(ABORT,'authority heads are retained'); END;
-- This trigger runs only on the new source table. Integrating accepted central
-- commands and enumerating their cascade effects remains a separate unit.
CREATE TRIGGER release_seoul_change_pending AFTER INSERT ON release_seoul_authority_changes BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE revision>NEW.revision) THEN RAISE(ABORT,'authority revision must be monotonic') END);
 UPDATE release_seoul_authority_heads SET revision=NEW.revision,event_id=NEW.event_id,payload_sha256=NULL WHERE stream_kind=NEW.stream_kind AND stream_key=NEW.stream_key;
 INSERT INTO release_seoul_authority_heads(stream_kind,stream_key,revision,event_id,payload_sha256)
  SELECT NEW.stream_kind,NEW.stream_key,NEW.revision,NEW.event_id,NULL WHERE NOT EXISTS(SELECT 1 FROM release_seoul_authority_heads WHERE stream_kind=NEW.stream_kind AND stream_key=NEW.stream_key);
END;

-- Preparation is a later atomic batch. Bidirectional deferred foreign keys
-- require both the immutable prepared binding and exact transport event at
-- COMMIT, while permitting either insertion order. JS verifies both digests.
-- An older negative source may be prepared without overwriting a newer head.
CREATE TABLE release_seoul_prepared_sources(
 revision INTEGER PRIMARY KEY,
 event_id TEXT NOT NULL UNIQUE,
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
 transport_sha256 TEXT NOT NULL CHECK(length(transport_sha256)=64 AND transport_sha256 NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(revision,event_id,source_sha256),
 UNIQUE(revision,event_id,source_sha256,transport_sha256),
 FOREIGN KEY(revision,event_id) REFERENCES release_seoul_authority_changes(revision,event_id),
 FOREIGN KEY(event_id,revision,source_sha256,transport_sha256) REFERENCES release_seoul_projection_events(event_id,source_revision,source_sha256,payload_sha256) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER release_seoul_prepared_insert BEFORE INSERT ON release_seoul_prepared_sources BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_prepared_sources p WHERE (p.revision=NEW.revision OR p.event_id=NEW.event_id) AND NOT(p.revision=NEW.revision AND p.event_id=NEW.event_id AND p.source_sha256=NEW.source_sha256 AND p.transport_sha256=NEW.transport_sha256)) THEN RAISE(ABORT,'prepared source conflict') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_prepared_sources WHERE revision=NEW.revision) THEN RAISE(IGNORE) END);
END;
CREATE TRIGGER release_seoul_prepared_no_update BEFORE UPDATE ON release_seoul_prepared_sources
 BEGIN SELECT RAISE(ABORT,'prepared sources are immutable'); END;
CREATE TRIGGER release_seoul_prepared_no_delete BEFORE DELETE ON release_seoul_prepared_sources
 BEGIN SELECT RAISE(ABORT,'prepared sources are retained'); END;

CREATE TABLE release_seoul_projection_events(
 event_id TEXT PRIMARY KEY NOT NULL CHECK(length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-' AND length(replace(event_id,'-',''))=32 AND replace(event_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 source_revision INTEGER NOT NULL REFERENCES release_seoul_authority_changes(revision),
 event_kind TEXT NOT NULL CHECK(event_kind IN ('head','snapshot')),
 stream_kind TEXT,
 stream_key TEXT,
 source_sha256 TEXT,
 space_id TEXT REFERENCES spaces(id),
 snapshot_seq INTEGER,
 issued_at INTEGER,
 expires_at INTEGER,
 payload_bytes TEXT NOT NULL CHECK(typeof(payload_bytes)='text' AND length(CAST(payload_bytes AS BLOB)) BETWEEN 1 AND 131072),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
 CHECK((event_kind='head' AND stream_kind IS NOT NULL AND stream_key IS NOT NULL AND source_sha256 IS NOT NULL AND space_id IS NULL AND snapshot_seq IS NULL AND issued_at IS NULL AND expires_at IS NULL)
  OR (event_kind='snapshot' AND stream_kind IS NULL AND stream_key IS NULL AND source_sha256 IS NULL AND space_id IS NOT NULL AND typeof(snapshot_seq)='integer' AND snapshot_seq BETWEEN 1 AND 9007199254740991 AND typeof(issued_at)='integer' AND issued_at BETWEEN 0 AND 9007199254680991 AND typeof(expires_at)='integer' AND expires_at=issued_at+60000)),
 UNIQUE(event_id,payload_sha256),
 UNIQUE(event_id,source_revision,source_sha256,payload_sha256),
 UNIQUE(space_id,snapshot_seq),
 UNIQUE(space_id,snapshot_seq,event_id,payload_sha256),
 FOREIGN KEY(source_revision,stream_kind,stream_key,event_id) REFERENCES release_seoul_authority_changes(revision,stream_kind,stream_key,event_id),
 FOREIGN KEY(source_revision,event_id,source_sha256,payload_sha256) REFERENCES release_seoul_prepared_sources(revision,event_id,source_sha256,transport_sha256) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER release_seoul_event_insert BEFORE INSERT ON release_seoul_projection_events BEGIN
 SELECT (CASE WHEN NEW.event_kind<>'head' AND EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE event_id=NEW.event_id) THEN RAISE(ABORT,'source change head event required') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE (e.event_id=NEW.event_id OR (e.space_id=NEW.space_id AND e.snapshot_seq=NEW.snapshot_seq)) AND NOT(e.event_id=NEW.event_id AND e.source_revision=NEW.source_revision AND e.event_kind=NEW.event_kind AND e.stream_kind IS NEW.stream_kind AND e.stream_key IS NEW.stream_key AND e.source_sha256 IS NEW.source_sha256 AND e.space_id IS NEW.space_id AND e.snapshot_seq IS NEW.snapshot_seq AND e.issued_at IS NEW.issued_at AND e.expires_at IS NEW.expires_at AND e.payload_bytes=NEW.payload_bytes AND e.payload_sha256=NEW.payload_sha256)) THEN RAISE(ABORT,'projection event conflict') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_projection_events WHERE event_id=NEW.event_id) THEN RAISE(IGNORE) END);
 SELECT (CASE WHEN NEW.event_kind='snapshot' AND EXISTS(SELECT 1 FROM release_seoul_authority_heads WHERE payload_sha256 IS NULL) THEN RAISE(ABORT,'authority digest pending') END);
END;
CREATE TRIGGER release_seoul_event_no_update BEFORE UPDATE ON release_seoul_projection_events
 BEGIN SELECT RAISE(ABORT,'projection events are immutable'); END;
CREATE TRIGGER release_seoul_event_no_delete BEFORE DELETE ON release_seoul_projection_events
 BEGIN SELECT RAISE(ABORT,'projection events are retained'); END;

CREATE TABLE release_seoul_targets(
 space_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces(id),
 selected INTEGER NOT NULL CHECK(typeof(selected)='integer' AND selected IN (0,1)),
 revision INTEGER NOT NULL REFERENCES release_seoul_authority_changes(revision)
);
CREATE TRIGGER release_seoul_target_insert BEFORE INSERT ON release_seoul_targets BEGIN
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM release_seoul_authority_heads WHERE stream_kind='target' AND stream_key=NEW.space_id AND revision=NEW.revision) THEN RAISE(ABORT,'target head required') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_targets WHERE space_id=NEW.space_id AND revision>NEW.revision) THEN RAISE(ABORT,'target revision must be monotonic') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_targets WHERE space_id=NEW.space_id AND revision=NEW.revision AND selected<>NEW.selected) THEN RAISE(ABORT,'target conflict') END);
END;
CREATE TRIGGER release_seoul_target_update BEFORE UPDATE ON release_seoul_targets BEGIN
 SELECT (CASE WHEN NEW.space_id<>OLD.space_id THEN RAISE(ABORT,'target identity is immutable') END);
 SELECT (CASE WHEN NEW.revision<OLD.revision THEN RAISE(ABORT,'target revision must be monotonic') END);
 SELECT (CASE WHEN NEW.revision=OLD.revision AND NEW.selected<>OLD.selected THEN RAISE(ABORT,'target conflict') END);
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM release_seoul_authority_heads WHERE stream_kind='target' AND stream_key=NEW.space_id AND revision=NEW.revision) THEN RAISE(ABORT,'target head required') END);
END;
CREATE TRIGGER release_seoul_target_no_delete BEFORE DELETE ON release_seoul_targets
 BEGIN SELECT RAISE(ABORT,'target removals are retained'); END;

CREATE TABLE release_seoul_dirty_spaces(
 space_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces(id),
 dirty_revision INTEGER NOT NULL REFERENCES release_seoul_authority_changes(revision),
 captured_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(captured_revision)='integer' AND captured_revision BETWEEN 0 AND dirty_revision)
);
CREATE TRIGGER release_seoul_dirty_insert BEFORE INSERT ON release_seoul_dirty_spaces
 WHEN EXISTS(SELECT 1 FROM release_seoul_dirty_spaces WHERE space_id=NEW.space_id AND (dirty_revision>NEW.dirty_revision OR captured_revision>NEW.captured_revision))
 BEGIN SELECT RAISE(ABORT,'dirty revisions must be monotonic'); END;
CREATE TRIGGER release_seoul_dirty_update BEFORE UPDATE ON release_seoul_dirty_spaces
 WHEN NEW.space_id<>OLD.space_id OR NEW.dirty_revision<OLD.dirty_revision OR NEW.captured_revision<OLD.captured_revision
 BEGIN SELECT RAISE(ABORT,'dirty revisions must be monotonic'); END;
CREATE TRIGGER release_seoul_dirty_no_delete BEFORE DELETE ON release_seoul_dirty_spaces
 BEGIN SELECT RAISE(ABORT,'dirty capture history is retained'); END;

CREATE TABLE release_seoul_projection_lock(
 space_id TEXT PRIMARY KEY NOT NULL REFERENCES release_seoul_dirty_spaces(space_id),
 fence_token TEXT NOT NULL CHECK(length(fence_token)=32 AND fence_token NOT GLOB '*[^0-9a-f]*'),
 claimed_revision INTEGER NOT NULL REFERENCES release_seoul_authority_changes(revision),
 claimed_at INTEGER NOT NULL CHECK(typeof(claimed_at)='integer' AND claimed_at BETWEEN 0 AND 9007199254725991),
 expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>claimed_at AND expires_at<=claimed_at+15000)
);
CREATE TRIGGER release_seoul_lock_insert BEFORE INSERT ON release_seoul_projection_lock BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_projection_lock WHERE space_id=NEW.space_id AND expires_at>CAST(round(unixepoch('subsec')*1000) AS INTEGER)) THEN RAISE(ABORT,'projection fence held') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_projection_lock WHERE space_id=NEW.space_id AND fence_token=NEW.fence_token) THEN RAISE(ABORT,'expired claim requires a fresh projection fence') END);
 SELECT (CASE WHEN NEW.claimed_at<>CAST(round(unixepoch('subsec')*1000) AS INTEGER) OR NOT EXISTS(SELECT 1 FROM release_seoul_dirty_spaces WHERE space_id=NEW.space_id AND dirty_revision=NEW.claimed_revision) THEN RAISE(ABORT,'projection claim must use current database state') END);
END;
CREATE TRIGGER release_seoul_lock_update BEFORE UPDATE ON release_seoul_projection_lock BEGIN
 SELECT (CASE WHEN NEW.space_id<>OLD.space_id THEN RAISE(ABORT,'claim identity is immutable') END);
 SELECT (CASE WHEN OLD.expires_at>CAST(round(unixepoch('subsec')*1000) AS INTEGER) AND (NEW.fence_token<>OLD.fence_token OR NEW.claimed_at<>OLD.claimed_at OR NEW.claimed_revision<>OLD.claimed_revision) THEN RAISE(ABORT,'projection fence held') END);
 SELECT (CASE WHEN OLD.expires_at<=CAST(round(unixepoch('subsec')*1000) AS INTEGER) AND NEW.fence_token=OLD.fence_token THEN RAISE(ABORT,'expired claim requires a fresh projection fence') END);
 SELECT (CASE WHEN NEW.fence_token<>OLD.fence_token AND (NEW.claimed_at<>CAST(round(unixepoch('subsec')*1000) AS INTEGER) OR NOT EXISTS(SELECT 1 FROM release_seoul_dirty_spaces WHERE space_id=NEW.space_id AND dirty_revision=NEW.claimed_revision)) THEN RAISE(ABORT,'projection claim must use current database state') END);
END;

-- A sequence is independent of source_revision. Repeated lease refreshes at
-- the same authority revision publish 1,2,3 for one Space; another starts at 1.
CREATE TABLE release_seoul_published_snapshots(
 space_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces(id),
 snapshot_seq INTEGER NOT NULL CHECK(typeof(snapshot_seq)='integer' AND snapshot_seq BETWEEN 1 AND 9007199254740991),
 event_id TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL,
 FOREIGN KEY(space_id,snapshot_seq,event_id,payload_sha256) REFERENCES release_seoul_projection_events(space_id,snapshot_seq,event_id,payload_sha256)
);
CREATE TRIGGER release_seoul_published_insert BEFORE INSERT ON release_seoul_published_snapshots BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_published_snapshots WHERE space_id=NEW.space_id AND snapshot_seq>NEW.snapshot_seq) THEN RAISE(ABORT,'published sequence must be monotonic') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_published_snapshots WHERE space_id=NEW.space_id AND snapshot_seq=NEW.snapshot_seq AND (event_id<>NEW.event_id OR payload_sha256<>NEW.payload_sha256)) THEN RAISE(ABORT,'published sequence conflict') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_published_snapshots WHERE space_id=NEW.space_id AND snapshot_seq=NEW.snapshot_seq AND event_id=NEW.event_id AND payload_sha256=NEW.payload_sha256) THEN RAISE(IGNORE) END);
 SELECT (CASE WHEN NEW.snapshot_seq<>coalesce((SELECT snapshot_seq FROM release_seoul_published_snapshots WHERE space_id=NEW.space_id),0)+1 THEN RAISE(ABORT,'published sequence must be consecutive') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_authority_heads WHERE payload_sha256 IS NULL) THEN RAISE(ABORT,'authority digest pending') END);
END;
CREATE TRIGGER release_seoul_published_update BEFORE UPDATE ON release_seoul_published_snapshots BEGIN
 SELECT (CASE WHEN NEW.space_id<>OLD.space_id THEN RAISE(ABORT,'published Space identity is immutable') END);
 SELECT (CASE WHEN NEW.snapshot_seq<OLD.snapshot_seq THEN RAISE(ABORT,'published sequence must be monotonic') END);
 SELECT (CASE WHEN NEW.snapshot_seq=OLD.snapshot_seq AND (NEW.event_id<>OLD.event_id OR NEW.payload_sha256<>OLD.payload_sha256) THEN RAISE(ABORT,'published sequence conflict') END);
 SELECT (CASE WHEN NEW.snapshot_seq>OLD.snapshot_seq+1 THEN RAISE(ABORT,'published sequence must be consecutive') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_authority_heads WHERE payload_sha256 IS NULL) THEN RAISE(ABORT,'authority digest pending') END);
END;
CREATE TRIGGER release_seoul_published_no_delete BEFORE DELETE ON release_seoul_published_snapshots
 BEGIN SELECT RAISE(ABORT,'published sequences are retained'); END;

-- These states describe delivery only. None grants authority or readiness.
-- 100 is a storage ceiling per immutable event, not an enabled retry policy.
-- Unknown commits remain uncertain; the future dispatcher must reconcile GET
-- before considering another POST. Exact receipts are validated by that code.
CREATE TABLE release_seoul_projection_deliveries(
 event_id TEXT PRIMARY KEY NOT NULL REFERENCES release_seoul_projection_events(event_id),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','dependency_pending','uncertain','applied','snapshot_superseded','conflict')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts BETWEEN 0 AND 100),
 next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(typeof(next_attempt_at)='integer' AND next_attempt_at BETWEEN 0 AND 9007199254740991),
 fence_token TEXT,
 claimed_at INTEGER,
 fence_expires_at INTEGER,
 receipt_bytes TEXT CHECK(receipt_bytes IS NULL OR (typeof(receipt_bytes)='text' AND length(CAST(receipt_bytes AS BLOB)) BETWEEN 1 AND 131072)),
 CHECK((fence_token IS NULL AND claimed_at IS NULL AND fence_expires_at IS NULL AND state<>'dispatching') OR
  (state='dispatching' AND fence_token IS NOT NULL AND length(fence_token)=32 AND fence_token NOT GLOB '*[^0-9a-f]*' AND typeof(claimed_at)='integer' AND claimed_at BETWEEN 0 AND 9007199254725991 AND typeof(fence_expires_at)='integer' AND fence_expires_at>claimed_at AND fence_expires_at<=claimed_at+15000 AND attempts>0)),
 CHECK(state NOT IN ('dependency_pending','applied','snapshot_superseded','conflict') OR receipt_bytes IS NOT NULL)
);
CREATE INDEX release_seoul_delivery_due ON release_seoul_projection_deliveries(state,next_attempt_at);
CREATE TRIGGER release_seoul_delivery_insert BEFORE INSERT ON release_seoul_projection_deliveries BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_projection_deliveries WHERE event_id=NEW.event_id) THEN RAISE(ABORT,'delivery already exists') END);
 SELECT (CASE WHEN NEW.fence_token IS NOT NULL AND NEW.claimed_at<>CAST(round(unixepoch('subsec')*1000) AS INTEGER) THEN RAISE(ABORT,'delivery claim must use database time') END);
END;
CREATE TRIGGER release_seoul_delivery_update BEFORE UPDATE ON release_seoul_projection_deliveries BEGIN
 SELECT (CASE WHEN NEW.event_id<>OLD.event_id THEN RAISE(ABORT,'delivery identity is immutable') END);
 SELECT (CASE WHEN NEW.attempts<OLD.attempts THEN RAISE(ABORT,'attempt count must be monotonic') END);
 SELECT (CASE WHEN OLD.state IN ('applied','snapshot_superseded','conflict') AND (NEW.state<>OLD.state OR NEW.attempts<>OLD.attempts OR NEW.next_attempt_at<>OLD.next_attempt_at OR NEW.fence_token IS NOT OLD.fence_token OR NEW.claimed_at IS NOT OLD.claimed_at OR NEW.fence_expires_at IS NOT OLD.fence_expires_at OR NEW.receipt_bytes IS NOT OLD.receipt_bytes) THEN RAISE(ABORT,'terminal delivery is immutable') END);
 SELECT (CASE WHEN OLD.fence_expires_at>CAST(round(unixepoch('subsec')*1000) AS INTEGER) AND NEW.fence_token IS NOT NULL AND (NEW.fence_token<>OLD.fence_token OR NEW.claimed_at<>OLD.claimed_at) THEN RAISE(ABORT,'delivery fence held') END);
 SELECT (CASE WHEN OLD.fence_expires_at<=CAST(round(unixepoch('subsec')*1000) AS INTEGER) AND NEW.fence_token=OLD.fence_token THEN RAISE(ABORT,'expired claim requires a fresh delivery fence') END);
 SELECT (CASE WHEN NEW.fence_token IS NOT NULL AND (OLD.fence_token IS NULL OR NEW.fence_token<>OLD.fence_token) AND NEW.claimed_at<>CAST(round(unixepoch('subsec')*1000) AS INTEGER) THEN RAISE(ABORT,'delivery claim must use database time') END);
 SELECT (CASE WHEN NEW.fence_token IS NOT NULL AND ((NEW.fence_token=OLD.fence_token AND NEW.attempts<>OLD.attempts) OR ((OLD.fence_token IS NULL OR NEW.fence_token<>OLD.fence_token) AND NEW.attempts<>OLD.attempts+1)) THEN RAISE(ABORT,'dispatch attempt must advance once per fresh fence') END);
END;
CREATE TRIGGER release_seoul_delivery_no_delete BEFORE DELETE ON release_seoul_projection_deliveries
 BEGIN SELECT RAISE(ABORT,'delivery history is retained'); END;

UPDATE release_meta SET version=26 WHERE version=25;

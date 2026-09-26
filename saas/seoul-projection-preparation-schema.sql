-- Inactive single-source preparation witness. The trusted preparer inserts
-- and deletes its only row in one atomic batch. Retention is an operator fault,
-- never a lease or an instruction to clean up another attempt.
CREATE TABLE release_seoul_preparation_stage(
 token TEXT PRIMARY KEY NOT NULL CHECK(typeof(token)='text' AND length(token)=36 AND substr(token,9,1)='-' AND substr(token,14,1)='-' AND substr(token,19,1)='-' AND substr(token,24,1)='-' AND length(replace(token,'-',''))=32 AND replace(token,'-','') NOT GLOB '*[^0-9a-f]*'),
 revision INTEGER NOT NULL UNIQUE CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 source_command_id TEXT NOT NULL CHECK(typeof(source_command_id)='text' AND length(source_command_id)=36 AND substr(source_command_id,9,1)='-' AND substr(source_command_id,14,1)='-' AND substr(source_command_id,19,1)='-' AND substr(source_command_id,24,1)='-' AND length(replace(source_command_id,'-',''))=32 AND replace(source_command_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 stream_kind TEXT NOT NULL CHECK(stream_kind IN ('subject','email','organization','membership','credential','space')),
 stream_key TEXT NOT NULL CHECK(typeof(stream_key)='text' AND length(CAST(stream_key AS BLOB)) BETWEEN 1 AND 2048),
 event_id TEXT NOT NULL UNIQUE CHECK(typeof(event_id)='text' AND length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-' AND length(replace(event_id,'-',''))=32 AND replace(event_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 record_bytes TEXT NOT NULL CHECK(typeof(record_bytes)='text' AND length(CAST(record_bytes AS BLOB)) BETWEEN 1 AND 131072),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 source_sha256 TEXT NOT NULL CHECK(typeof(source_sha256)='text' AND length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
 transport_sha256 TEXT NOT NULL CHECK(typeof(transport_sha256)='text' AND length(transport_sha256)=64 AND transport_sha256 NOT GLOB '*[^0-9a-f]*'),
 payload_bytes TEXT NOT NULL CHECK(typeof(payload_bytes)='text' AND length(CAST(payload_bytes AS BLOB)) BETWEEN 1 AND 131072),
 eligible INTEGER NOT NULL CHECK(typeof(eligible)='integer' AND eligible IN (0,1)),
 complete_guard INTEGER NOT NULL DEFAULT 1 CHECK(typeof(complete_guard)='integer' AND complete_guard=1),
 FOREIGN KEY(revision,stream_kind,stream_key,event_id) REFERENCES release_seoul_authority_changes(revision,stream_kind,stream_key,event_id),
 FOREIGN KEY(revision,event_id) REFERENCES release_seoul_authority_changes(revision,event_id)
);
-- Unconditional INSERT must reach this trigger even when eligibility is zero.
-- This rejects same-token INSERT OR REPLACE with recursive_triggers ON or OFF.
CREATE TRIGGER release_seoul_preparation_fresh BEFORE INSERT ON release_seoul_preparation_stage
 WHEN EXISTS(SELECT 1 FROM release_seoul_preparation_stage LIMIT 1)
 BEGIN SELECT RAISE(ABORT,'preparation staging is not empty'); END;
CREATE TRIGGER release_seoul_preparation_immutable BEFORE UPDATE ON release_seoul_preparation_stage
 WHEN NEW.token IS NOT OLD.token OR NEW.revision IS NOT OLD.revision OR NEW.source_command_id IS NOT OLD.source_command_id
  OR NEW.stream_kind IS NOT OLD.stream_kind OR NEW.stream_key IS NOT OLD.stream_key OR NEW.event_id IS NOT OLD.event_id
  OR NEW.record_bytes IS NOT OLD.record_bytes OR NEW.created_at IS NOT OLD.created_at OR NEW.source_sha256 IS NOT OLD.source_sha256
  OR NEW.transport_sha256 IS NOT OLD.transport_sha256 OR NEW.payload_bytes IS NOT OLD.payload_bytes OR NEW.eligible IS NOT OLD.eligible
 BEGIN SELECT RAISE(ABORT,'preparation witness is immutable'); END;
UPDATE release_meta SET version=29 WHERE version=28;

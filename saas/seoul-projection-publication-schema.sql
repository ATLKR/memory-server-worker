-- Inactive snapshot publication witness. The trusted store inserts and deletes
-- its only row inside one atomic publish batch. A retained row is an operator
-- fault, never a lease or an instruction to clean up another attempt. issued_at
-- is the claim-time lease anchor; the batch's eligibility decision re-verifies
-- the live fence, the examined dirty revision, the observed target tuple and
-- every pinned dependency head before any durable row is written.
CREATE TABLE release_seoul_snapshot_stage(
 token TEXT PRIMARY KEY NOT NULL CHECK(typeof(token)='text' AND length(token)=36 AND substr(token,9,1)='-' AND substr(token,14,1)='-' AND substr(token,19,1)='-' AND substr(token,24,1)='-' AND length(replace(token,'-',''))=32 AND replace(token,'-','') NOT GLOB '*[^0-9a-f]*'),
 event_id TEXT NOT NULL UNIQUE CHECK(typeof(event_id)='text' AND length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-' AND length(replace(event_id,'-',''))=32 AND replace(event_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 space_id TEXT NOT NULL CHECK(typeof(space_id)='text' AND length(CAST(space_id AS BLOB)) BETWEEN 1 AND 128),
 snapshot_seq INTEGER NOT NULL CHECK(typeof(snapshot_seq)='integer' AND snapshot_seq BETWEEN 1 AND 9007199254740991),
 source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision BETWEEN 1 AND 9007199254740991) REFERENCES release_seoul_authority_changes(revision),
 issued_at INTEGER NOT NULL CHECK(typeof(issued_at)='integer' AND issued_at BETWEEN 0 AND 9007199254680991),
 expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at=issued_at+60000),
 payload_bytes TEXT NOT NULL CHECK(typeof(payload_bytes)='text' AND length(CAST(payload_bytes AS BLOB)) BETWEEN 1 AND 131072),
 payload_sha256 TEXT NOT NULL CHECK(typeof(payload_sha256)='text' AND length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
 fence_token TEXT NOT NULL CHECK(typeof(fence_token)='text' AND length(fence_token)=32 AND fence_token NOT GLOB '*[^0-9a-f]*'),
 claimed_at INTEGER NOT NULL CHECK(typeof(claimed_at)='integer' AND claimed_at BETWEEN 0 AND 9007199254725991 AND claimed_at=issued_at),
 lock_expires_at INTEGER NOT NULL CHECK(typeof(lock_expires_at)='integer' AND lock_expires_at>claimed_at AND lock_expires_at<=claimed_at+15000),
 target_revision INTEGER CHECK(target_revision IS NULL OR (typeof(target_revision)='integer' AND target_revision BETWEEN 1 AND 9007199254740991)),
 target_selected INTEGER CHECK(target_selected IS NULL OR (typeof(target_selected)='integer' AND target_selected IN (0,1))),
 eligible INTEGER NOT NULL CHECK(typeof(eligible)='integer' AND eligible IN (0,1)),
 complete_guard INTEGER NOT NULL DEFAULT 1 CHECK(typeof(complete_guard)='integer' AND complete_guard=1),
 CHECK((target_revision IS NULL)=(target_selected IS NULL))
);
-- Unconditional INSERT must reach this trigger even when eligibility is zero.
-- This rejects same-token INSERT OR REPLACE with recursive_triggers ON or OFF.
CREATE TRIGGER release_seoul_snapshot_stage_fresh BEFORE INSERT ON release_seoul_snapshot_stage
 WHEN EXISTS(SELECT 1 FROM release_seoul_snapshot_stage LIMIT 1)
 BEGIN SELECT RAISE(ABORT,'snapshot staging is not empty'); END;
CREATE TRIGGER release_seoul_snapshot_stage_immutable BEFORE UPDATE ON release_seoul_snapshot_stage
 WHEN NEW.token IS NOT OLD.token OR NEW.event_id IS NOT OLD.event_id OR NEW.space_id IS NOT OLD.space_id
  OR NEW.snapshot_seq IS NOT OLD.snapshot_seq OR NEW.source_revision IS NOT OLD.source_revision
  OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.payload_bytes IS NOT OLD.payload_bytes OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.fence_token IS NOT OLD.fence_token OR NEW.claimed_at IS NOT OLD.claimed_at
  OR NEW.lock_expires_at IS NOT OLD.lock_expires_at OR NEW.target_revision IS NOT OLD.target_revision
  OR NEW.target_selected IS NOT OLD.target_selected OR NEW.eligible IS NOT OLD.eligible
 BEGIN SELECT RAISE(ABORT,'snapshot witness is immutable'); END;
UPDATE release_meta SET version=36 WHERE version=35;

-- Forward SaaS migration 34: seoul-projection-target-schema.sql
-- Inactive trusted single-Space target commands; no route or selection is enabled.
CREATE TABLE release_seoul_target_attempt(
 token TEXT NOT NULL CHECK((typeof(token)='text' AND length(CAST(token AS BLOB)) BETWEEN 1 AND 36)) CHECK((length(token)=36 AND substr(token,9,1)='-' AND substr(token,14,1)='-' AND substr(token,19,1)='-' AND substr(token,24,1)='-' AND length(replace(token,'-',''))=32 AND replace(token,'-','') NOT GLOB '*[^0-9a-f]*')) PRIMARY KEY,
 command_id TEXT NOT NULL CHECK((typeof(command_id)='text' AND length(CAST(command_id AS BLOB)) BETWEEN 1 AND 36)) CHECK((length(command_id)=36 AND substr(command_id,9,1)='-' AND substr(command_id,14,1)='-' AND substr(command_id,19,1)='-' AND substr(command_id,24,1)='-' AND length(replace(command_id,'-',''))=32 AND replace(command_id,'-','') NOT GLOB '*[^0-9a-f]*')) UNIQUE,
 space_id TEXT NOT NULL CHECK((typeof(space_id)='text' AND length(CAST(space_id AS BLOB)) BETWEEN 1 AND 128)) CHECK((substr(space_id,1,1) GLOB '[A-Za-z0-9]' AND space_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
 expected_revision INTEGER CHECK(expected_revision IS NULL OR (typeof(expected_revision)='integer' AND expected_revision BETWEEN 1 AND 9007199254740991)),
 selected INTEGER NOT NULL CHECK((typeof(selected)='integer' AND selected IN (0,1))),
 operator_reference TEXT NOT NULL CHECK((typeof(operator_reference)='text' AND length(CAST(operator_reference AS BLOB)) BETWEEN 1 AND 256)) CHECK((substr(operator_reference,1,1) GLOB '[A-Za-z0-9]' AND operator_reference NOT GLOB '*[^A-Za-z0-9._:-]*')),
 new_event_id TEXT NOT NULL CHECK((typeof(new_event_id)='text' AND length(CAST(new_event_id AS BLOB)) BETWEEN 1 AND 36)) CHECK((length(new_event_id)=36 AND substr(new_event_id,9,1)='-' AND substr(new_event_id,14,1)='-' AND substr(new_event_id,19,1)='-' AND substr(new_event_id,24,1)='-' AND length(replace(new_event_id,'-',''))=32 AND replace(new_event_id,'-','') NOT GLOB '*[^0-9a-f]*')) UNIQUE,
 prior_state TEXT NOT NULL CHECK(prior_state IN ('absent','present')),
 prior_revision INTEGER CHECK(prior_revision IS NULL OR (typeof(prior_revision)='integer' AND prior_revision BETWEEN 1 AND 9007199254740991)),
 prior_selected INTEGER CHECK(prior_selected IS NULL OR (typeof(prior_selected)='integer' AND prior_selected IN (0,1))),
 prior_event_id TEXT CHECK(prior_event_id IS NULL OR (typeof(prior_event_id)='text' AND length(CAST(prior_event_id AS BLOB)) BETWEEN 1 AND 36)) CHECK(prior_event_id IS NULL OR (length(prior_event_id)=36 AND substr(prior_event_id,9,1)='-' AND substr(prior_event_id,14,1)='-' AND substr(prior_event_id,19,1)='-' AND substr(prior_event_id,24,1)='-' AND length(replace(prior_event_id,'-',''))=32 AND replace(prior_event_id,'-','') NOT GLOB '*[^0-9a-f]*')),
 prior_source_command_id TEXT CHECK(prior_source_command_id IS NULL OR (typeof(prior_source_command_id)='text' AND length(CAST(prior_source_command_id AS BLOB)) BETWEEN 1 AND 36)) CHECK(prior_source_command_id IS NULL OR (length(prior_source_command_id)=36 AND substr(prior_source_command_id,9,1)='-' AND substr(prior_source_command_id,14,1)='-' AND substr(prior_source_command_id,19,1)='-' AND substr(prior_source_command_id,24,1)='-' AND length(replace(prior_source_command_id,'-',''))=32 AND replace(prior_source_command_id,'-','') NOT GLOB '*[^0-9a-f]*')),
 prior_record_bytes TEXT CHECK(prior_record_bytes IS NULL OR (typeof(prior_record_bytes)='text' AND length(CAST(prior_record_bytes AS BLOB)) BETWEEN 1 AND 131072)),
 prior_created_at INTEGER CHECK(prior_created_at IS NULL OR (typeof(prior_created_at)='integer' AND prior_created_at BETWEEN 0 AND 9007199254740991)),
 prior_source_sha256 TEXT CHECK(prior_source_sha256 IS NULL OR (typeof(prior_source_sha256)='text' AND length(CAST(prior_source_sha256 AS BLOB)) BETWEEN 1 AND 64)) CHECK(prior_source_sha256 IS NULL OR (length(prior_source_sha256)=64 AND prior_source_sha256 NOT GLOB '*[^0-9a-f]*')),
 prior_transport_sha256 TEXT CHECK(prior_transport_sha256 IS NULL OR (typeof(prior_transport_sha256)='text' AND length(CAST(prior_transport_sha256 AS BLOB)) BETWEEN 1 AND 64)) CHECK(prior_transport_sha256 IS NULL OR (length(prior_transport_sha256)=64 AND prior_transport_sha256 NOT GLOB '*[^0-9a-f]*')),
 prior_payload_bytes TEXT CHECK(prior_payload_bytes IS NULL OR (typeof(prior_payload_bytes)='text' AND length(CAST(prior_payload_bytes AS BLOB)) BETWEEN 1 AND 131072)),
 prior_changed_receipt_bytes TEXT CHECK(prior_changed_receipt_bytes IS NULL OR (typeof(prior_changed_receipt_bytes)='text' AND length(CAST(prior_changed_receipt_bytes AS BLOB)) BETWEEN 1 AND 2048)),
 decided_at INTEGER NOT NULL CHECK((typeof(decided_at)='integer' AND decided_at BETWEEN 0 AND 9007199254740991)),
 decision TEXT NOT NULL CHECK(decision IN ('changed','unchanged','already_committed','command_conflict','target_missing','target_state_invalid','stale_revision')),
 eligible INTEGER NOT NULL CHECK((typeof(eligible)='integer' AND eligible IN (0,1))),
 observed_command_receipt_bytes TEXT CHECK(observed_command_receipt_bytes IS NULL OR (typeof(observed_command_receipt_bytes)='text' AND length(CAST(observed_command_receipt_bytes AS BLOB)) BETWEEN 1 AND 2048)),
 observed_space_present INTEGER NOT NULL CHECK(typeof(observed_space_present)='integer' AND observed_space_present IN (0,1)),
 observed_command_source_present INTEGER NOT NULL CHECK(typeof(observed_command_source_present)='integer' AND observed_command_source_present IN (0,1)),
 prior_dirty_revision INTEGER CHECK(prior_dirty_revision IS NULL OR (typeof(prior_dirty_revision)='integer' AND prior_dirty_revision BETWEEN 1 AND 9007199254740991)),
 prior_captured_revision INTEGER CHECK(prior_captured_revision IS NULL OR (typeof(prior_captured_revision)='integer' AND prior_captured_revision BETWEEN 0 AND 9007199254740991)),
 observed_target_revision INTEGER CHECK(observed_target_revision IS NULL OR (typeof(observed_target_revision)='integer' AND observed_target_revision BETWEEN 1 AND 9007199254740991)),
 observed_target_selected INTEGER CHECK(observed_target_selected IS NULL OR (typeof(observed_target_selected)='integer' AND observed_target_selected IN (0,1))),
 observed_head_revision INTEGER CHECK(observed_head_revision IS NULL OR (typeof(observed_head_revision)='integer' AND observed_head_revision BETWEEN 1 AND 9007199254740991)),
 observed_head_event_id TEXT CHECK(observed_head_event_id IS NULL OR (typeof(observed_head_event_id)='text' AND length(CAST(observed_head_event_id AS BLOB)) BETWEEN 1 AND 36)) CHECK(observed_head_event_id IS NULL OR (length(observed_head_event_id)=36 AND substr(observed_head_event_id,9,1)='-' AND substr(observed_head_event_id,14,1)='-' AND substr(observed_head_event_id,19,1)='-' AND substr(observed_head_event_id,24,1)='-' AND length(replace(observed_head_event_id,'-',''))=32 AND replace(observed_head_event_id,'-','') NOT GLOB '*[^0-9a-f]*')),
 observed_head_digest TEXT CHECK(observed_head_digest IS NULL OR (typeof(observed_head_digest)='text' AND length(CAST(observed_head_digest AS BLOB)) BETWEEN 1 AND 64)) CHECK(observed_head_digest IS NULL OR (length(observed_head_digest)=64 AND observed_head_digest NOT GLOB '*[^0-9a-f]*')),
 observed_source_revision INTEGER CHECK(observed_source_revision IS NULL OR (typeof(observed_source_revision)='integer' AND observed_source_revision BETWEEN 1 AND 9007199254740991)),
 observed_source_event_id TEXT CHECK(observed_source_event_id IS NULL OR (typeof(observed_source_event_id)='text' AND length(CAST(observed_source_event_id AS BLOB)) BETWEEN 1 AND 36)) CHECK(observed_source_event_id IS NULL OR (length(observed_source_event_id)=36 AND substr(observed_source_event_id,9,1)='-' AND substr(observed_source_event_id,14,1)='-' AND substr(observed_source_event_id,19,1)='-' AND substr(observed_source_event_id,24,1)='-' AND length(replace(observed_source_event_id,'-',''))=32 AND replace(observed_source_event_id,'-','') NOT GLOB '*[^0-9a-f]*')),
 observed_source_stream_key TEXT CHECK(observed_source_stream_key IS NULL OR (typeof(observed_source_stream_key)='text' AND length(CAST(observed_source_stream_key AS BLOB)) BETWEEN 1 AND 2048)),
 observed_source_record_bytes TEXT CHECK(observed_source_record_bytes IS NULL OR (typeof(observed_source_record_bytes)='text' AND length(CAST(observed_source_record_bytes AS BLOB)) BETWEEN 1 AND 131072)),
 observed_source_created_at INTEGER CHECK(observed_source_created_at IS NULL OR (typeof(observed_source_created_at)='integer' AND observed_source_created_at BETWEEN 0 AND 9007199254740991)),
 CHECK((prior_state='absent' AND prior_revision IS NULL AND prior_selected IS NULL AND prior_event_id IS NULL AND prior_source_command_id IS NULL AND prior_record_bytes IS NULL AND prior_created_at IS NULL AND prior_source_sha256 IS NULL AND prior_transport_sha256 IS NULL AND prior_payload_bytes IS NULL AND prior_changed_receipt_bytes IS NULL) OR (prior_state='present' AND prior_revision IS NOT NULL AND prior_selected IS NOT NULL AND prior_event_id IS NOT NULL AND prior_source_command_id IS NOT NULL AND prior_record_bytes IS NOT NULL AND prior_created_at IS NOT NULL AND prior_source_sha256 IS NOT NULL AND prior_transport_sha256 IS NOT NULL AND prior_payload_bytes IS NOT NULL AND prior_changed_receipt_bytes IS NOT NULL)),
 CHECK(eligible=CASE WHEN decision IN ('changed','unchanged') THEN 1 ELSE 0 END),
 CHECK(eligible=0 OR observed_command_receipt_bytes IS NULL),
 CHECK(decision NOT IN ('already_committed','command_conflict') OR observed_command_receipt_bytes IS NOT NULL),
 CHECK((prior_dirty_revision IS NULL AND prior_captured_revision IS NULL) OR (prior_dirty_revision IS NOT NULL AND prior_captured_revision IS NOT NULL)),
 CHECK(prior_captured_revision IS NULL OR prior_captured_revision<=prior_dirty_revision),
 CHECK((observed_target_revision IS NULL AND observed_target_selected IS NULL) OR (observed_target_revision IS NOT NULL AND observed_target_selected IS NOT NULL)),
 CHECK((observed_head_revision IS NULL AND observed_head_event_id IS NULL) OR (observed_head_revision IS NOT NULL AND observed_head_event_id IS NOT NULL)),
 CHECK(observed_head_digest IS NULL OR observed_head_revision IS NOT NULL),
 CHECK((observed_source_revision IS NULL AND observed_source_event_id IS NULL AND observed_source_stream_key IS NULL AND observed_source_record_bytes IS NULL AND observed_source_created_at IS NULL) OR (observed_source_revision IS NOT NULL AND observed_source_event_id IS NOT NULL AND observed_source_stream_key IS NOT NULL AND observed_source_record_bytes IS NOT NULL AND observed_source_created_at IS NOT NULL))
);
CREATE TRIGGER release_seoul_target_attempt_fresh BEFORE INSERT ON release_seoul_target_attempt
 WHEN EXISTS(SELECT 1 FROM release_seoul_target_attempt LIMIT 1)
 BEGIN SELECT RAISE(ABORT,'target operation staging is not empty'); END;
CREATE TRIGGER release_seoul_target_attempt_immutable BEFORE UPDATE ON release_seoul_target_attempt
 BEGIN SELECT RAISE(ABORT,'target operation witness is immutable'); END;

CREATE TABLE release_seoul_target_receipts(
 command_id TEXT NOT NULL CHECK((typeof(command_id)='text' AND length(CAST(command_id AS BLOB)) BETWEEN 1 AND 36)) CHECK((length(command_id)=36 AND substr(command_id,9,1)='-' AND substr(command_id,14,1)='-' AND substr(command_id,19,1)='-' AND substr(command_id,24,1)='-' AND length(replace(command_id,'-',''))=32 AND replace(command_id,'-','') NOT GLOB '*[^0-9a-f]*')) PRIMARY KEY,
 space_id TEXT NOT NULL CHECK((typeof(space_id)='text' AND length(CAST(space_id AS BLOB)) BETWEEN 1 AND 128)) CHECK((substr(space_id,1,1) GLOB '[A-Za-z0-9]' AND space_id NOT GLOB '*[^A-Za-z0-9._:-]*')) REFERENCES spaces(id),
 expected_revision INTEGER CHECK(expected_revision IS NULL OR (typeof(expected_revision)='integer' AND expected_revision BETWEEN 1 AND 9007199254740991)),
 selected INTEGER NOT NULL CHECK((typeof(selected)='integer' AND selected IN (0,1))),
 operator_reference TEXT NOT NULL CHECK((typeof(operator_reference)='text' AND length(CAST(operator_reference AS BLOB)) BETWEEN 1 AND 256)) CHECK((substr(operator_reference,1,1) GLOB '[A-Za-z0-9]' AND operator_reference NOT GLOB '*[^A-Za-z0-9._:-]*')),
 outcome TEXT NOT NULL CHECK(outcome IN ('changed','unchanged')),
 resulting_revision INTEGER NOT NULL CHECK((typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991)),
 resulting_event_id TEXT NOT NULL CHECK((typeof(resulting_event_id)='text' AND length(CAST(resulting_event_id AS BLOB)) BETWEEN 1 AND 36)) CHECK((length(resulting_event_id)=36 AND substr(resulting_event_id,9,1)='-' AND substr(resulting_event_id,14,1)='-' AND substr(resulting_event_id,19,1)='-' AND substr(resulting_event_id,24,1)='-' AND length(replace(resulting_event_id,'-',''))=32 AND replace(resulting_event_id,'-','') NOT GLOB '*[^0-9a-f]*')),
 decided_at INTEGER NOT NULL CHECK((typeof(decided_at)='integer' AND decided_at BETWEEN 0 AND 9007199254740991)),
 CHECK((outcome='unchanged' AND expected_revision IS NOT NULL AND expected_revision=resulting_revision) OR (outcome='changed' AND (expected_revision IS NULL OR resulting_revision>expected_revision))),
 FOREIGN KEY(resulting_revision,resulting_event_id) REFERENCES release_seoul_authority_changes(revision,event_id)
);
CREATE UNIQUE INDEX release_seoul_target_changed_receipt ON release_seoul_target_receipts(resulting_revision) WHERE outcome='changed';
CREATE INDEX release_seoul_target_receipt_source ON release_seoul_target_receipts(resulting_revision,resulting_event_id);
CREATE TRIGGER release_seoul_target_receipt_insert BEFORE INSERT ON release_seoul_target_receipts BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_target_receipts WHERE command_id=NEW.command_id) THEN RAISE(ABORT,'target command receipt is occupied') END);
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM release_seoul_target_attempt s JOIN release_seoul_authority_changes c ON c.revision=NEW.resulting_revision AND c.event_id=NEW.resulting_event_id
 WHERE s.command_id=NEW.command_id AND s.space_id=NEW.space_id AND s.expected_revision IS NEW.expected_revision AND s.selected=NEW.selected AND s.operator_reference=NEW.operator_reference AND s.decided_at=NEW.decided_at AND s.eligible=1 AND s.decision=NEW.outcome
 AND c.stream_kind='target' AND c.stream_key=NEW.space_id AND c.record_bytes=json_object('version',3,'kind','target-source','spaceId',NEW.space_id,'selected',json(CASE WHEN NEW.selected=1 THEN 'true' ELSE 'false' END),'changedAtMs',c.created_at,'origin',json_object('kind','command','commandType','target-reconcile','receiptId',c.source_command_id),'effect',json(CASE WHEN NEW.selected=1 THEN json_object('type','entity-head','disposition','changed') ELSE json_object('type','entity-negative','entityKind','target','entityId',NEW.space_id,'state','removed','occurredAtMs',c.created_at) END))
 AND ((NEW.outcome='changed' AND c.source_command_id=NEW.command_id AND c.event_id=s.new_event_id AND c.created_at=NEW.decided_at
  AND ((s.prior_state='absent' AND NEW.expected_revision IS NULL) OR (s.prior_state='present' AND NEW.expected_revision=s.prior_revision AND NEW.selected<>s.prior_selected AND c.revision>s.prior_revision))
  AND EXISTS(SELECT 1 FROM release_seoul_authority_heads h WHERE h.stream_kind='target' AND h.stream_key=NEW.space_id AND h.revision=c.revision AND h.event_id=c.event_id AND h.payload_sha256 IS NULL))
 OR (NEW.outcome='unchanged' AND s.prior_state='present' AND NEW.expected_revision=s.prior_revision AND NEW.resulting_revision=s.prior_revision AND NEW.selected=s.prior_selected
  AND c.source_command_id=s.prior_source_command_id AND c.event_id=s.prior_event_id AND c.record_bytes=s.prior_record_bytes AND c.created_at=s.prior_created_at
  AND EXISTS(SELECT 1 FROM release_seoul_target_receipts o WHERE o.command_id=c.source_command_id AND o.outcome='changed' AND o.space_id=NEW.space_id AND o.selected=NEW.selected AND o.resulting_revision=c.revision AND o.resulting_event_id=c.event_id AND o.decided_at=c.created_at AND json_object('commandId',o.command_id,'spaceId',o.space_id,'expectedRevision',o.expected_revision,'selected',json(CASE WHEN o.selected=1 THEN 'true' ELSE 'false' END),'operatorReference',o.operator_reference,'outcome',o.outcome,'resultingRevision',o.resulting_revision,'resultingEventId',o.resulting_event_id,'decidedAtMs',o.decided_at)=s.prior_changed_receipt_bytes)
  AND EXISTS(SELECT 1 FROM release_seoul_targets t JOIN release_seoul_authority_heads h ON h.stream_kind='target' AND h.stream_key=t.space_id AND h.revision=t.revision WHERE t.space_id=NEW.space_id AND t.revision=c.revision AND t.selected=NEW.selected AND h.event_id=c.event_id)))
 ) THEN RAISE(ABORT,'target command receipt requires exact staged source') END);
END;
CREATE TRIGGER release_seoul_target_receipt_immutable BEFORE UPDATE ON release_seoul_target_receipts BEGIN SELECT RAISE(ABORT,'target command receipt is immutable'); END;
CREATE TRIGGER release_seoul_target_receipt_retained BEFORE DELETE ON release_seoul_target_receipts BEGIN SELECT RAISE(ABORT,'target command receipt is retained'); END;

-- Separate target witness preserves the immutable 0029 six-kind table.
CREATE TABLE release_seoul_target_preparation_stage(
 token TEXT PRIMARY KEY NOT NULL CHECK(typeof(token)='text' AND length(token)=36 AND substr(token,9,1)='-' AND substr(token,14,1)='-' AND substr(token,19,1)='-' AND substr(token,24,1)='-' AND length(replace(token,'-',''))=32 AND replace(token,'-','') NOT GLOB '*[^0-9a-f]*'),
 revision INTEGER NOT NULL UNIQUE CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 source_command_id TEXT NOT NULL CHECK(typeof(source_command_id)='text' AND length(source_command_id)=36 AND substr(source_command_id,9,1)='-' AND substr(source_command_id,14,1)='-' AND substr(source_command_id,19,1)='-' AND substr(source_command_id,24,1)='-' AND length(replace(source_command_id,'-',''))=32 AND replace(source_command_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 stream_kind TEXT NOT NULL CHECK(stream_kind='target'),
 stream_key TEXT NOT NULL CHECK((typeof(stream_key)='text' AND length(CAST(stream_key AS BLOB)) BETWEEN 1 AND 128)) CHECK((substr(stream_key,1,1) GLOB '[A-Za-z0-9]' AND stream_key NOT GLOB '*[^A-Za-z0-9._:-]*')),
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
CREATE TRIGGER release_seoul_target_preparation_fresh BEFORE INSERT ON release_seoul_target_preparation_stage
 WHEN EXISTS(SELECT 1 FROM release_seoul_target_preparation_stage LIMIT 1) OR EXISTS(SELECT 1 FROM release_seoul_preparation_stage LIMIT 1)
 BEGIN SELECT RAISE(ABORT,'preparation staging is not empty'); END;
CREATE TRIGGER release_seoul_target_preparation_immutable BEFORE UPDATE ON release_seoul_target_preparation_stage
 WHEN NEW.token IS NOT OLD.token OR NEW.revision IS NOT OLD.revision OR NEW.source_command_id IS NOT OLD.source_command_id
  OR NEW.stream_kind IS NOT OLD.stream_kind OR NEW.stream_key IS NOT OLD.stream_key OR NEW.event_id IS NOT OLD.event_id
  OR NEW.record_bytes IS NOT OLD.record_bytes OR NEW.created_at IS NOT OLD.created_at OR NEW.source_sha256 IS NOT OLD.source_sha256
  OR NEW.transport_sha256 IS NOT OLD.transport_sha256 OR NEW.payload_bytes IS NOT OLD.payload_bytes OR NEW.eligible IS NOT OLD.eligible
 BEGIN SELECT RAISE(ABORT,'preparation witness is immutable'); END;


CREATE TRIGGER release_seoul_preparation_target_fresh BEFORE INSERT ON release_seoul_preparation_stage
 WHEN EXISTS(SELECT 1 FROM release_seoul_target_preparation_stage LIMIT 1)
 BEGIN SELECT RAISE(ABORT,'target preparation staging is not empty'); END;
UPDATE release_meta SET version=34 WHERE version=33;

-- Apply after schema.sql. Managed plaintext memory only; no zero-access mode.
PRAGMA foreign_keys = ON;

CREATE TABLE spaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(instr(name,char(0))=0 AND length(name) BETWEEN 1 AND 100 AND length(trim(name))>0),
  account_id TEXT REFERENCES accounts(id),
  organization_id TEXT REFERENCES organizations(id),
  security_mode TEXT NOT NULL CHECK(security_mode='managed'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  CHECK((account_id IS NOT NULL AND organization_id IS NULL) OR (account_id IS NULL AND organization_id IS NOT NULL))
);
CREATE INDEX spaces_account ON spaces(account_id);
CREATE INDEX spaces_organization ON spaces(organization_id);

CREATE TABLE memories (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  body TEXT NOT NULL CHECK(instr(body,char(0))=0 AND length(CAST(body AS BLOB)) BETWEEN 1 AND 16384 AND length(trim(body))>0),
  source TEXT CHECK(source IS NULL OR (instr(source,char(0))=0 AND length(CAST(source AS BLOB))<=2048)),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN created_at AND 9007199254740991),
  deleted_at INTEGER CHECK(deleted_at IS NULL OR (typeof(deleted_at)='integer' AND deleted_at=updated_at)),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id)
);
CREATE INDEX memories_live_space ON memories(space_id,updated_at DESC,id) WHERE deleted_at IS NULL;

CREATE TABLE memory_versions (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  revision INTEGER NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  body TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  archived_at INTEGER NOT NULL,
  PRIMARY KEY(memory_id,revision)
);

-- Only immutable identifiers, revision counters, event type, and time. Memory
-- body/source, Space name, email addresses, and credential digests stay out.
CREATE TABLE memory_audit_events (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('space_created','memory_created','memory_updated','memory_deleted')),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  memory_id TEXT REFERENCES memories(id),
  revision INTEGER,
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  created_at INTEGER NOT NULL
);

-- REPLACE performs an implicit delete that does not run delete triggers when
-- recursive_triggers is disabled. Reject existing keys before that can happen.
CREATE TRIGGER spaces_no_replace BEFORE INSERT ON spaces
WHEN EXISTS (SELECT 1 FROM spaces WHERE id=NEW.id) BEGIN
  SELECT RAISE(ABORT,'Space replacement is not supported');
END;
CREATE TRIGGER memories_no_replace BEFORE INSERT ON memories
WHEN EXISTS (SELECT 1 FROM memories WHERE id=NEW.id) BEGIN
  SELECT RAISE(ABORT,'Memory replacement is not supported');
END;
CREATE TRIGGER memory_versions_no_replace BEFORE INSERT ON memory_versions
WHEN EXISTS (SELECT 1 FROM memory_versions WHERE memory_id=NEW.memory_id AND revision=NEW.revision) BEGIN
  SELECT RAISE(ABORT,'Memory history is append-only');
END;
CREATE TRIGGER memory_audit_no_replace BEFORE INSERT ON memory_audit_events
WHEN EXISTS (SELECT 1 FROM memory_audit_events WHERE id=NEW.id) BEGIN
  SELECT RAISE(ABORT,'Memory audit is append-only');
END;

CREATE TRIGGER spaces_created_audit AFTER INSERT ON spaces BEGIN
  INSERT INTO memory_audit_events(action,space_id,actor_credential_id,created_at)
  VALUES('space_created',NEW.id,NEW.actor_credential_id,NEW.created_at);
END;
CREATE TRIGGER spaces_immutable BEFORE UPDATE ON spaces BEGIN
  SELECT RAISE(ABORT,'Space identity is immutable');
END;
CREATE TRIGGER spaces_no_delete BEFORE DELETE ON spaces BEGIN
  SELECT RAISE(ABORT,'Space deletion is not supported');
END;

CREATE TRIGGER memories_initial_revision BEFORE INSERT ON memories
WHEN NEW.revision<>1 OR NEW.deleted_at IS NOT NULL OR NEW.created_at<>NEW.updated_at BEGIN
  SELECT RAISE(ABORT,'Invalid initial memory state');
END;
CREATE TRIGGER memories_created_audit AFTER INSERT ON memories BEGIN
  INSERT INTO memory_audit_events(action,space_id,memory_id,revision,actor_credential_id,created_at)
  VALUES('memory_created',NEW.space_id,NEW.id,NEW.revision,NEW.actor_credential_id,NEW.created_at);
END;
CREATE TRIGGER memories_validate_transition BEFORE UPDATE ON memories
WHEN NEW.id<>OLD.id OR NEW.space_id<>OLD.space_id OR NEW.created_at<>OLD.created_at
  OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR OLD.deleted_at IS NOT NULL
  OR (NEW.deleted_at IS NOT NULL AND (NEW.body<>OLD.body OR NEW.source IS NOT OLD.source)) BEGIN
  SELECT RAISE(ABORT,'Invalid memory transition');
END;
CREATE TRIGGER memories_preserve_version AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_versions(memory_id,revision,space_id,body,source,created_at,updated_at,deleted_at,actor_credential_id,archived_at)
  VALUES(OLD.id,OLD.revision,OLD.space_id,OLD.body,OLD.source,OLD.created_at,OLD.updated_at,OLD.deleted_at,OLD.actor_credential_id,NEW.updated_at);
  INSERT INTO memory_audit_events(action,space_id,memory_id,revision,actor_credential_id,created_at)
  VALUES(CASE WHEN NEW.deleted_at IS NULL THEN 'memory_updated' ELSE 'memory_deleted' END,
    NEW.space_id,NEW.id,NEW.revision,NEW.actor_credential_id,NEW.updated_at);
END;
CREATE TRIGGER memories_no_delete BEFORE DELETE ON memories BEGIN
  SELECT RAISE(ABORT,'Memory deletion requires a tombstone');
END;
CREATE TRIGGER memory_versions_no_update BEFORE UPDATE ON memory_versions BEGIN
  SELECT RAISE(ABORT,'Memory history is append-only');
END;
CREATE TRIGGER memory_versions_no_delete BEFORE DELETE ON memory_versions BEGIN
  SELECT RAISE(ABORT,'Memory history is append-only');
END;
CREATE TRIGGER memory_audit_no_update BEFORE UPDATE ON memory_audit_events BEGIN
  SELECT RAISE(ABORT,'Memory audit is append-only');
END;
CREATE TRIGGER memory_audit_no_delete BEFORE DELETE ON memory_audit_events BEGIN
  SELECT RAISE(ABORT,'Memory audit is append-only');
END;

-- Forward SaaS migration 12: lookup-schema.sql
-- Stable, identifier-only FTS row addresses. Never rely on a table's implicit
-- rowid: VACUUM may change those for tables with a non-integer primary key.
CREATE TABLE release_fts_rows(
 id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id>0),
 memory_id TEXT NOT NULL UNIQUE REFERENCES memories(id)
);
INSERT INTO release_fts_rows(memory_id) SELECT id FROM memories ORDER BY id;
CREATE TRIGGER release_fts_rows_no_replace BEFORE INSERT ON release_fts_rows
WHEN EXISTS(SELECT 1 FROM release_fts_rows WHERE id=NEW.id OR memory_id=NEW.memory_id)
 BEGIN SELECT RAISE(ABORT,'FTS row identity already exists'); END;
CREATE TRIGGER release_fts_rows_no_update BEFORE UPDATE ON release_fts_rows
 BEGIN SELECT RAISE(ABORT,'FTS row identity is immutable'); END;
CREATE TRIGGER release_fts_rows_no_delete BEFORE DELETE ON release_fts_rows
 BEGIN SELECT RAISE(ABORT,'FTS row identity is retained'); END;

-- Rebuild only derived search content; source, history and audit are untouched.
DELETE FROM release_fts;
INSERT INTO release_fts(rowid,memory_id,space_id,body)
 SELECT f.id,m.id,m.space_id,m.body FROM memories m JOIN release_fts_rows f ON f.memory_id=m.id
 WHERE m.deleted_at IS NULL AND m.erased_at IS NULL;
DROP TRIGGER release_memory_index_insert;
CREATE TRIGGER release_memory_index_insert AFTER INSERT ON memories BEGIN
 INSERT INTO release_fts_rows(memory_id) VALUES(NEW.id);
 INSERT INTO release_fts(rowid,memory_id,space_id,body)
  SELECT id,NEW.id,NEW.space_id,NEW.body FROM release_fts_rows
  WHERE memory_id=NEW.id AND NEW.deleted_at IS NULL AND NEW.erased_at IS NULL;
 INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
  VALUES(NEW.id||':'||NEW.revision,NEW.id,NEW.space_id,NEW.revision,'upsert',NEW.updated_at,NEW.updated_at);
END;
DROP TRIGGER release_memory_index_update;
CREATE TRIGGER release_memory_index_update AFTER UPDATE ON memories BEGIN
 DELETE FROM release_fts WHERE rowid=(SELECT id FROM release_fts_rows WHERE memory_id=NEW.id);
 INSERT INTO release_fts(rowid,memory_id,space_id,body)
  SELECT id,NEW.id,NEW.space_id,NEW.body FROM release_fts_rows
  WHERE memory_id=NEW.id AND NEW.deleted_at IS NULL AND NEW.erased_at IS NULL;
 INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
  VALUES(NEW.id||':'||NEW.revision,NEW.id,NEW.space_id,NEW.revision,CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,NEW.updated_at,NEW.updated_at);
END;

-- A LEFT JOIN to the nested active_memberships view materializes memberships
-- across tenants. Resolve the credential's immutable membership tuple directly.
DROP VIEW active_credentials;
CREATE VIEW active_credentials AS
 SELECT c.*,coalesce(m.expires_at,9007199254740991) AS membership_expires_at
 FROM credentials c JOIN accounts a ON a.id=c.account_id AND a.disabled_at IS NULL
 LEFT JOIN memberships m ON m.id=c.membership_id AND m.account_id=c.account_id
  AND m.email_id=c.email_id AND m.revoked_at IS NULL
 WHERE c.revoked_at IS NULL AND (c.kind IN ('session','personal_key') OR (
  m.id IS NOT NULL
  AND EXISTS(SELECT 1 FROM organizations o WHERE o.id=m.organization_id AND o.disabled_at IS NULL)
  AND EXISTS(SELECT 1 FROM account_emails e WHERE e.id=m.email_id AND e.account_id=m.account_id AND e.revoked_at IS NULL)
 ));
UPDATE release_meta SET version=12 WHERE version=11;

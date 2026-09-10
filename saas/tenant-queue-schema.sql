-- Tenant-local Space candidates and bounded queue branches.
CREATE INDEX release_spaces_account_created ON spaces(account_id,created_at,id) WHERE account_id IS NOT NULL;
CREATE INDEX release_spaces_organization_created ON spaces(organization_id,created_at,id) WHERE organization_id IS NOT NULL;
CREATE INDEX release_memberships_account ON memberships(account_id,organization_id,id) WHERE revoked_at IS NULL;

ALTER TABLE release_jobs ADD COLUMN cleanup_only INTEGER NOT NULL DEFAULT 0
 CHECK(cleanup_only IN (0,1) AND (cleanup_only=0 OR kind='upsert'));
UPDATE release_jobs SET cleanup_only=1 WHERE kind='upsert' AND EXISTS(
 SELECT 1 FROM memories m WHERE m.id=release_jobs.memory_id AND m.revision=release_jobs.revision
 AND m.deleted_at IS NULL AND m.erased_at IS NULL AND next_chunk>=(length(m.body)+1649)/1650);
CREATE INDEX release_jobs_pending_claim ON release_jobs(kind,cleanup_only,available_at,id) WHERE state='pending';
CREATE INDEX release_jobs_leased_claim ON release_jobs(kind,cleanup_only,lease_until,id) WHERE state='leased' AND attempt<5;
CREATE INDEX release_jobs_exhausted_lease ON release_jobs(lease_until,id) WHERE state='leased' AND attempt>=5;
CREATE INDEX release_jobs_done_sweep ON release_jobs(id) WHERE state='done';
CREATE TABLE release_maintenance_progress(name TEXT PRIMARY KEY,cursor TEXT NOT NULL DEFAULT '');
INSERT INTO release_maintenance_progress(name) VALUES('vector_resweep');

-- Prefix indexes cover every supported token length (1..31 Unicode codepoints).
-- The extra tenant term is exact, encoded as t + lowercase UTF-8 hex. Ranking
-- uses body highlight spans only, avoiding global bm25 document-frequency work.
DROP TRIGGER release_memory_index_insert;
DROP TRIGGER release_memory_index_update;
DROP TABLE release_fts;
CREATE VIRTUAL TABLE release_fts USING fts5(memory_id UNINDEXED,space_id UNINDEXED,body,tenant,
 tokenize='unicode61',prefix='1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31');
INSERT INTO release_fts(rowid,memory_id,space_id,body,tenant)
 SELECT f.id,m.id,m.space_id,m.body,'t'||lower(hex(m.space_id))
 FROM memories m JOIN release_fts_rows f ON f.memory_id=m.id
 WHERE m.deleted_at IS NULL AND m.erased_at IS NULL;
CREATE TRIGGER release_memory_index_insert AFTER INSERT ON memories BEGIN
 INSERT INTO release_fts_rows(memory_id) VALUES(NEW.id);
 INSERT INTO release_fts(rowid,memory_id,space_id,body,tenant)
  SELECT id,NEW.id,NEW.space_id,NEW.body,'t'||lower(hex(NEW.space_id)) FROM release_fts_rows
  WHERE memory_id=NEW.id AND NEW.deleted_at IS NULL AND NEW.erased_at IS NULL;
 INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
  VALUES(NEW.id||':'||NEW.revision,NEW.id,NEW.space_id,NEW.revision,'upsert',NEW.updated_at,NEW.updated_at);
END;
CREATE TRIGGER release_memory_index_update AFTER UPDATE ON memories BEGIN
 DELETE FROM release_fts WHERE rowid=(SELECT id FROM release_fts_rows WHERE memory_id=NEW.id);
 INSERT INTO release_fts(rowid,memory_id,space_id,body,tenant)
  SELECT id,NEW.id,NEW.space_id,NEW.body,'t'||lower(hex(NEW.space_id)) FROM release_fts_rows
  WHERE memory_id=NEW.id AND NEW.deleted_at IS NULL AND NEW.erased_at IS NULL;
 INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
  VALUES(NEW.id||':'||NEW.revision,NEW.id,NEW.space_id,NEW.revision,CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,NEW.updated_at,NEW.updated_at);
END;
UPDATE release_meta SET version=14 WHERE version=13;

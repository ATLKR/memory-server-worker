-- Operational list paging indexes. Ports the D1 lineage's migration 0016
-- (retrieval-progress): the caller-scoped ingest list and the per-space job
-- list page in display order without a table scan.
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE INDEX release_ingests_account_space_created
  ON memory_content.release_ingests(account_id, space_id, created_at DESC, id);
CREATE INDEX release_jobs_space_created
  ON memory_jobs.release_jobs(space_id, created_at DESC, id);
-- The rebuild job enqueues every revision of one Space, live and deleted;
-- the partial live/trash indexes cannot serve that whole-space scan.
CREATE INDEX release_memories_space_all
  ON memory_content.memories(space_id, id);

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (13, '0013_retrieval_progress.sql');
COMMIT;

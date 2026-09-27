-- Forward SaaS migration 16: retrieval-progress-schema.sql
-- Tenant-local operational lists and rebuilds include retained terminal rows.
CREATE INDEX release_ingests_account_space_created ON release_ingests(account_id,space_id,created_at DESC,id);
CREATE INDEX release_jobs_space_created ON release_jobs(space_id,created_at DESC,id);
CREATE INDEX release_memories_space_all ON memories(space_id,id);

-- Accepted Vectorize deletions are asynchronous. Keep the exact pending page
-- until absence is confirmed, independently from the provider-failure budget.
-- Existing jobs have no pending request and keep their durable progress.
ALTER TABLE release_jobs ADD COLUMN cleanup_pending TEXT NOT NULL DEFAULT '[]'
 CHECK(json_valid(cleanup_pending) AND json_type(cleanup_pending)='array' AND json_array_length(cleanup_pending)<=100);
UPDATE release_meta SET version=16 WHERE version=15;

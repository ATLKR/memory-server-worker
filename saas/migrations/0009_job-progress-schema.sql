-- Forward SaaS migration 9: job-progress-schema.sql
-- Durable progress for bounded indexing/erasure slices; retained identifiers remain intact.
ALTER TABLE release_jobs ADD COLUMN next_chunk INTEGER NOT NULL DEFAULT 0 CHECK(next_chunk>=0);
ALTER TABLE release_jobs ADD COLUMN cleanup_cursor TEXT NOT NULL DEFAULT '';
-- Equality by memory and a vector-id range preserve cursor order without sorting history.
CREATE INDEX release_vector_refs_cleanup ON release_vector_refs(memory_id,vector_id,revision);
UPDATE release_meta SET version=9 WHERE version=8;

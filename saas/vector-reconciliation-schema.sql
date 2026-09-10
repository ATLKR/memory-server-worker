-- A pending Vectorize deletion may be followed by a previously accepted upsert.
-- Preserve a retry deadline and increasing propagation window across workers.
ALTER TABLE release_jobs ADD COLUMN cleanup_retry_at INTEGER NOT NULL DEFAULT 0
    CHECK(cleanup_retry_at >= 0);
ALTER TABLE release_jobs ADD COLUMN cleanup_retry_delay INTEGER NOT NULL DEFAULT 60000
    CHECK(cleanup_retry_delay BETWEEN 60000 AND 86400000);

UPDATE release_meta SET version=17 WHERE version=16;

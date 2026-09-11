-- Aggregate provider reservations and bounded legacy-payload conversion progress.
-- Service provider reservations are separate from customer usage units.
-- Reserve before uncertain network effects; never refund a potentially billed call.
CREATE TABLE release_provider_budgets(
 month TEXT NOT NULL CHECK(length(month)=7),
 kind TEXT NOT NULL CHECK(kind IN ('embedding','extraction')),
 calls INTEGER NOT NULL CHECK(calls>=0),
 reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>=0),
 PRIMARY KEY(month,kind));

-- Indexed inline candidates remain eligible until exact-content archival commits.
-- Cursors wrap after exhaustion so uncertain failures are retried without
-- repeatedly scanning all already-converted payloads or retained history.
CREATE INDEX release_memories_inline_archive ON memories(id)
 WHERE payload_id IS NULL AND erased_at IS NULL;
CREATE INDEX release_versions_inline_archive ON memory_versions(memory_id,revision)
 WHERE payload_id IS NULL;
CREATE TABLE release_payload_backfill_progress(
 kind TEXT PRIMARY KEY CHECK(kind IN ('current','history')),
 after_memory_id TEXT NOT NULL DEFAULT '',
 after_revision INTEGER NOT NULL DEFAULT 0,
 generation INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 last_error_at INTEGER);
INSERT INTO release_payload_backfill_progress(kind) VALUES('current'),('history');
UPDATE release_meta SET version=23;

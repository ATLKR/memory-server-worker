-- Tenant-scoped keyset pagination; no retained content or audit rows change.
CREATE INDEX release_audit_export ON memory_audit_events(space_id,memory_id,id,revision)
 WHERE memory_id IS NOT NULL;
CREATE INDEX release_memories_live_created ON memories(space_id,created_at DESC,id)
 WHERE deleted_at IS NULL AND erased_at IS NULL;
CREATE INDEX release_memories_trash_created ON memories(space_id,created_at DESC,id)
 WHERE deleted_at IS NOT NULL AND erased_at IS NULL;
CREATE INDEX release_shares_recipient_page ON release_shares(recipient_email_id,created_at,id)
 WHERE revoked_at IS NULL;
UPDATE release_meta SET version=11 WHERE version=10;

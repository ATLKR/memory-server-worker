-- Forward SaaS migration 15: workspace-lookup-schema.sql
-- Tenant-bound workspace history lookup and resumable source-retention sweep.
CREATE INDEX workspace_credentials_account ON credentials(account_id,kind,id);
CREATE INDEX workspace_memberships_organization ON memberships(organization_id,id,account_id,email_id);
CREATE INDEX release_memories_erasure_sweep ON memories(deleted_at,id)
 WHERE deleted_at IS NOT NULL AND erased_at IS NULL;
INSERT INTO release_maintenance_progress(name) VALUES('source_erasure');
UPDATE release_meta SET version=15 WHERE version=14;

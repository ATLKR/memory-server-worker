-- Regional lineage, version 19. Serving-path grant fix:
-- memory_ops.provider_revocations was granted INSERT-only to memory_runtime
-- in 0014 (the lifecycle-apply unit writes tombstones), but the authority
-- checks embed SELECT NOT EXISTS probes on the same table
-- (src/release/authority.ts, plus the 0010/0017 guard functions). Without a
-- SELECT grant every space-scoped runtime operation fails permission denied.
-- The tombstones are denial evidence the serving path must read; granting
-- SELECT matches the other read-only ledgers (usage_counters,
-- memory_audit_events). Trigger functions that probe it run as SECURITY
-- DEFINER and were unaffected.
BEGIN;
SET LOCAL ROLE memory_owner;

GRANT SELECT ON memory_ops.provider_revocations TO memory_runtime;
CREATE POLICY runtime_select ON memory_ops.provider_revocations
  FOR SELECT TO memory_runtime USING (true);

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (19, '0019_revocations_read.sql');
COMMIT;

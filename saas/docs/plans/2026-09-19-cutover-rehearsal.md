# Regional cutover rehearsal (P-6)

Status: **rehearsed at the database layer** on PGlite. Live provider cutover
remains unexecuted; this document is the procedure and its evidence so far.

## Model

One consistent cut, sealed, copied, verified — never dual writers.

1. **Freeze**: source stays the sole writer until activation. The seal is a
   consistent snapshot of named tables (per-table row count + SHA-256 over
   canonical ordered row dumps + schema-inventory digest).
   `src/postgres/cutover.ts`.
2. **Copy**: INSERT-only into an empty target with
   `session_replication_role='replica'` (the pg_restore pattern) — user and
   constraint triggers are suppressed, so derived rows (job outbox, fts
   mapping, audit) are carried verbatim by the cut instead of regenerated.
   `OVERRIDING SYSTEM VALUE` preserves `GENERATED ALWAYS AS IDENTITY` values;
   sequences are resynced (`setval(max)`) after load so post-cut inserts never
   reuse copied ids. Generated columns are excluded from the insert list and
   still sealed — a wrong generation expression fails verification.
3. **Provision-seeded tables** (`memory_ops.maintenance_progress`,
   `memory_ops.payload_backfill_progress`, `memory_control.schema_migrations`)
   are never copied; they are reconciliation checks — the seal verifies the
   target's seed equals the source's.
4. **Verify**: `verifyManifest` recomputes every seal on the target. Any
   mismatch — count, digest, or column inventory — blocks activation.
5. **Rollback**: a failed verify leaves the source untouched and the target
   discardable. There is no merge path.
6. **Replay**: writes landing after the cut change the seal; the target is
   rebuilt from a fresh manifest rather than patched.

## Evidence

`test/postgres/cutover-rehearsal.test.mjs` (5/5 on PGlite):

- Full-surface enumeration (`listRegionalTables`, 60+ regional tables) sealed
  and re-verified on a fresh schema.
- Byte-identical reproduction of a seeded regional cut.
- A legal post-verify mutation on the target is caught by the seal — and the
  schema's own transition guards reject an illegal one outright.
- Post-cut writes change the seal; a rebuilt target re-verifies.
- The importer refuses non-empty targets, unknown tables, and unsafe names.

## Not yet covered

- **Payload/object artifacts** (R2/object-store payloads referenced by
  `memories.payload_*`): reconciliation is row-level only so far — object
  bytes are out of the Postgres cut and need their own inventory/digest pass.
- **Live rehearsal** on real Neon/Supabase instances, including measured
  RPO/RTO, TLS-path verification, and the acceptance record.
- **Operational runbook ordering** for a production cut: freeze trigger at the
  service layer (write quarantine flag), migration-window sizing, and the
  rollback journal for post-activation regression.

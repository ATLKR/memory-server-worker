# Regional cutover rehearsal (P-6)

Status: **rehearsed live on both clusters** (2026-09-19) — Neon `sg` and
Supabase `kr-seoul`, sealed → copied → verified → unfrozen against a fresh
target database, with post-cut attestation passing as the runtime login.
See the live evidence section below.

## Model

One consistent cut, sealed, copied, verified — never dual writers.

1. **Freeze**: `freezeRuntime` revokes `LOGIN` from the runtime group role
   **and every serving member login** (e.g. `memory_sg_runtime`,
   `memory_seoul_runtime` — group `NOLOGIN` does not fence member sessions)
   and terminates their backends — every serving path dies while the operator
   session running the seal is unaffected. Admin-option holders of the role
   (the operator) are excluded so the freeze cannot lock itself out. Read-only
   transactions are session-bypassable and grant replay is error-prone;
   `NOLOGIN` is airtight and exactly reversible with `unfreezeRuntime`. The seal is a consistent
   snapshot of named tables (per-table row count + SHA-256 over canonical
   ordered row dumps + schema-inventory digest). `src/postgres/cutover.ts`.
2. **Copy**: INSERT-only into an empty target under
   `ALTER TABLE ... DISABLE TRIGGER USER` — derived-row triggers (job outbox,
   fts mapping, audit) are suppressed so those rows are carried verbatim by
   the cut instead of regenerated, while **constraint triggers stay live**:
   neither Neon nor Supabase grants `session_replication_role` or
   `DISABLE TRIGGER ALL` (the RI constraint triggers are system triggers), so
   `copyOrder` topologically sorts parents-first and drops the one intra-cycle
   FK (`archives` ↔ `lifecycle_receipts`) for the load window, re-adding it
   afterwards where the `ADD CONSTRAINT` validation itself proves the copied
   data is consistent. `OVERRIDING SYSTEM VALUE` preserves `GENERATED ALWAYS
   AS IDENTITY` values; sequences are resynced (`setval(max)`) after load so
   post-cut inserts never reuse copied ids. Generated columns are excluded
   from the insert list and still sealed — a wrong generation expression fails
   verification.
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

`test/postgres/cutover-rehearsal.test.mjs` (7/7 on PGlite):

- Full-surface enumeration (`listRegionalTables`, 60+ regional tables) sealed
  and re-verified on a fresh schema.
- Byte-identical reproduction of a seeded regional cut.
- A legal post-verify mutation on the target is caught by the seal — and the
  schema's own transition guards reject an illegal one outright.
- Post-cut writes change the seal; a rebuilt target re-verifies.
- The importer refuses non-empty targets, unknown tables, and unsafe names.
- Payload objects: live-reference inventory collapses agreed references,
  excludes terminal stages, and verifies fetched bytes against stored
  digests — a missing or corrupt object blocks activation on the target.
- The freeze flips `memory_runtime`'s `rolcanlogin` at the authority and
  restores it; unsafe role names are rejected before any DDL runs.

### Live evidence (2026-09-19)

`postgres-rehearse.mjs --run` against the real clusters, target = fresh
`memory_rehearsal_cutover` database on the same cluster (both sealed the same
fixture lineage 1–17; manifest digest identical across providers):

| | sg (Neon `ep-lingering-pine`) | kr-seoul (Supabase pooler) |
|---|---|---|
| tables enumerated | 79 | 79 |
| rows copied | 37 | 198 |
| provision-seeded | deployment_identity, maintenance_progress, payload_backfill_progress | same |
| cyclic FK dropped+re-added | `archives_erasure_actor_credential_id_erasure_operation_id_fkey` | same |
| mismatches | 0 | 0 |
| manifest sha256 | `ea1038b3…fe417bddc` | identical |
| freeze→verify total | 104.9s | 15.2s |
| RPO | 0 (sealed cut) | 0 |
| runtime unfrozen | true | true |

Post-cut attestation on each target as the runtime login
(`postgres-attest.mjs --schema-version 17`): `attested:true`,
`allDenialsHeld:true` — the runtime login on the copied database still cannot
read auth tables, run DDL, COPY OUT, or ALTER SYSTEM. Evidence JSONs are held
outside the repository with the ops artifacts.

### Provider constraints discovered live

- `SET session_replication_role='replica'` is denied on Neon and Supabase
  (`42501`) — neither grants it to any non-superuser role.
- `ALTER TABLE ... DISABLE TRIGGER ALL` is denied on Neon (`42501`, RI
  constraint triggers are system triggers); `DISABLE TRIGGER USER` is the
  portable mechanism.
- Role membership: ADMIN alone does not satisfy `SET ROLE`; the owner needs
  `WITH SET TRUE`/`INHERIT TRUE` on the memory roles (Supabase `postgres`
  self-grants; Neon uses `memory_sg_migrator`).
- Supabase: direct `db.<ref>.supabase.co` does not resolve on this project —
  the session pooler (`aws-0-ap-northeast-2.pooler.supabase.com:5432`,
  `<login>.<ref>` user) is the operator path, and its CA chain is
  self-signed (pinned TOFU for the rehearsal; the dashboard CA download is
  the production source).
- Seoul's deployment database is `postgres` (the project name
  `MemoryServiceDB` was never a database name).

## Payload/object layer

Row cuts carry only `(payload_shard_id, payload_object_key, payload_sha256,
payload_bytes)` references — the bytes live in the object store outside
Postgres. The cut therefore runs a parallel object pass:

- `payloadInventory` enumerates every live reference — `memories`,
  `memory_versions`, and `payload_stages` in `ready`/`published`/
  `purge_pending`. `staging` objects may not be uploaded yet and `purged`
  ones are already gone — both are reconciliation outcomes, not cutover
  content. References agreeing on a key collapse into one inventory row; a
  digest conflict surfaces as an extra unresolved entry.
- `sealPayloadObjects` fetches each object through a `PayloadFetcher`
  ((shard,key)→bytes: R2, S3, or a fixture), verifies size + SHA-256, and
  seals the set. Unfetched or digest-mismatched references land in
  `unresolved` and block activation.
- `verifyPayloadObjects` re-fetches on the target store — the object bytes
  are re-homed to the residency-pinned store for the region; the seal is
  what proves they arrived identical.

## Not yet covered

- **Payload object re-home** — the object-store pass reported `skipped` on
  both live runs (no object store configured in the rehearsal env); the row
  inventory sealed one 64 KiB external-payload reference but the bytes were
  not physically re-homed. Needs a real shard credential.
- **Cross-cluster target** — the rehearsal used a fresh database on the same
  cluster (`--roles-exist` handles cluster-global role collisions). A real
  migration to a *new* cluster/provider exercises the full 0001 provisioning
  path including `CREATE ROLE`.
- **Fixture residue** — `rehearsal-`-prefixed seed rows remain on both source
  databases; boundary tables reject deletes by design. Re-sealing before a
  real cut absorbs them.
- **Rollback journal** for post-activation regression — rebuild-not-merge is
  rehearsed; a journaled operational record is an ops artifact, not code.
- **Production-scale RTO** — measured numbers are for the fixture +
  pre-existing data (37–198 rows); the real cut's RTO scales with row volume.

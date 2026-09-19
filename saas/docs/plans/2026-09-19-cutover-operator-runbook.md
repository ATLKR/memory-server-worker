# Regional cutover — operator runbook (live)

Execution procedure for a live regional cut (e.g. `kr-seoul` onto a fresh
Supabase `ap-northeast-2` cluster, or `sg` onto Neon `aws-ap-southeast-1`).
The primitives and their rehearsal evidence live in
`src/postgres/cutover.ts` and `test/postgres/cutover-rehearsal.test.mjs`
(7/7 on PGlite); this document orders them for a real target. Nothing here
activates a region — activation is a separate signed acceptance step.

## 0. Inputs (private, outside the repository)

- `region.env.json` — the worker-shaped env for the **source/target**:
  `MEMORY_SG_*` or `MEMORY_KR_SEOUL_*` keys (`_TARGET_JSON`,
  `_RUNTIME_PASSWORD`, `_TRANSPORT`, optional `_TLS_CA`), plus `_CONTROL_`
  keys when the control plane moves or is also being attested.
- A fresh target cluster provisioned at the same regional schema lineage
  (contiguous migrations 1..N, `deployment_identity` row set, runtime roles
  provisioned `NOLOGIN` until cut).
- The object store for the region (R2 bucket / S3 prefix) with a fetcher
  credential scoped to it.

### Known live targets (attested 2026-09-19)

**kr-seoul** — Supabase project `dnhcszbgdzgjpsktjaxn` (MemoryServiceDB,
`ap-northeast-2`, pooler `aws-0-ap-northeast-2.pooler.supabase.com`; direct
`db.*` does not resolve, `connectionMode` must be `session-pooler`, and the
pooler user is `<login>.dnhcszbgdzgjpsktjaxn`). Regional lineage 0001–0016
applied, `deployment_identity` = `memory-seoul`/`kr-seoul`/
`kr-primary-storage-v1`, runtime login `memory_seoul_runtime` (member of
`memory_runtime`), `postgres-attest` → `attested:true, allDenialsHeld:true`,
61 regional tables.

**sg** — Neon project `memoryservice-nonseoul`, endpoint
`ep-lingering-pine-azosommb.c-3.ap-southeast-1.aws.neon.tech`, database
`memoryservice-nonseoul` (`connectionMode` `direct`; Neon forbids
`session-pooler` here). Full lineage 0001–0016 applied 2026-09-19,
`deployment_identity` = `memory-sg`/`sg`/`sg-primary-storage-v1`, runtime
login `memory_sg_runtime`, `postgres-attest` → `attested:true,
allDenialsHeld:true`, 61 regional tables.

### Provisioning notes learned from the live run

- Migration logins need `CREATEROLE` (0004/0005 create roles) plus
  membership in `memory_owner`/`memory_lifecycle`/`memory_commands`/
  `memory_background` **granted `WITH SET TRUE`** — a plain membership
  cannot `SET ROLE` on PG ≥16. `postgres` on Supabase has ADMIN on the
  memory roles but `SET FALSE`, so it cannot run migrations directly;
  `memory_migrator` (Seoul) / `memory_sg_migrator` (sg) were provisioned
  for this and their credentials stored in the vault.
- Supabase pooler reports a `VALID UNTIL`-expired login as
  `(EAUTHQUERY) unsupported or invalid secret format` — when rotating a
  runtime password also `ALTER ROLE ... VALID UNTIL 'infinity'` (or a new
  expiry), not just `PASSWORD`.
- On a provider owner connection (Neon `*_owner`), `CREATE SCHEMA
  ... AUTHORIZATION memory_owner` needs the owner to hold `memory_owner`
  with `SET TRUE` — grant it after `0001`'s role creation before running
  the schema section.
- Savepoint recovery inside a failed transaction requires the recovery
  statement to reach the server unprefaced — the runtime session's
  `set_config` preamble previously made `ROLLBACK TO` unreachable
  (fixed in `0bf2272`).

### Serving precondition: lifecycle journal sync

The regional staleness gate (`lifecycleFreshnessSql` in
`src/release/authority.ts`) denies every credential whose bound issuer has
no fresh `memory_ops.lifecycle_apply_head`. A serving region therefore
**must** run the scheduled `syncLifecycleJournal` against its control
target — `syncLifecycleJournal` now stamps the head even for issuers whose
journal is empty, but only when it actually executes. A region deployed
without `CONTROL_DB` never syncs, and every OAuth-bound account there
fails closed permanently.

## 1. Attest both ends first

```powershell
node --experimental-strip-types scripts/postgres-attest.mjs --region kr-seoul --policy <policy-id> --env-file region.env.json
node --experimental-strip-types scripts/postgres-attest.mjs --region kr-seoul --policy <policy-id> --env-file region.env.json --control
```

Both must print `"attested": true` with `allDenialsHeld: true`. A failed
denial (`ALLOWED` on `pg_authid`, `pg_shadow`, DDL, COPY, `ALTER SYSTEM`)
means the role boundary is broken — stop; do not cut onto a boundary that
leaks. Record the JSON outputs as cutover evidence.

## 2. Freeze (admin session, target untouched)

`freezeRuntime(admin, 'memory_runtime')` — `ALTER ROLE ... NOLOGIN` +
`pg_terminate_backend` for its sessions. Every serving connection dies;
there is no in-flight write to race the seal. The operator session is a
different role and unaffected.

## 3. Seal + copy + payload objects

1. `listRegionalTables(source)` — full surface, not a hand list.
2. `exportManifest(source, deploymentId, region, tables, at)` — the cut.
3. `copyTable(source, target, table)` for every enumerated table **except**
   provision-seeded ones (detected live: tables non-empty on a fresh
   target — today `memory_ops.maintenance_progress`,
   `memory_ops.payload_backfill_progress`; `schema_migrations` is never in
   the enumeration). The importer writes `OVERRIDING SYSTEM VALUE` and
   resyncs sequences; constraint triggers stay suppressed for the whole
   load so ordering does not matter.
4. `sealPayloadObjects(source, fetcher)` — fetch every live object
   (memories + versions + non-terminal stages), verify sha256/bytes, and
   re-home the bytes to the target region's store.
   `unresolved.length !== 0` → abort to rollback.

## 4. Verify, then decide

`verifyManifest(target, manifest)` + `verifyPayloadObjects(seal, targetFetcher)`.
Any mismatch → **rollback**: drop the target, `unfreezeRuntime(admin)` on
the source, investigate; the source is the untouched authority. Empty
mismatch lists → the cut is consistent; activation (deployment attestation
flip, routing enablement, acceptance record) is a separate signed step.

## 5. Abort/replay rules

- Post-seal writes cannot exist (LOGIN revoked); if the freeze was partial
  the seal check on the source detects drift — reseal rather than patch.
- Never re-run `copyTable` into a non-empty target — rebuild the target.
- The payload fetcher must be region-pinned read→region-pinned write;
  object bytes never route through the worker.

## Evidence to retain

- Both `postgres-attest` JSON reports (source + control, before the cut).
- The manifest JSON (tables, per-table digests, schema digest).
- The `PayloadSeal` JSON (objects, unresolved, digest).
- `verifyManifest`/`verifyPayloadObjects` outputs (empty = pass).
- Wall-clock RPO (=0 for a sealed cut) and RTO (freeze→verify) measured on
  the real run — record the numbers; do not claim them from the rehearsal.

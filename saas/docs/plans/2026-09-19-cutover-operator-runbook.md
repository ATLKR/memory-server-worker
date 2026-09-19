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

### Known live target: kr-seoul

The existing Supabase project `dnhcszbgdzgjpsktjaxn` (MemoryServiceDB,
`ap-northeast-2`, pooler `aws-0-ap-northeast-2.pooler.supabase.com` — direct
`db.*` hostnames do not resolve on this project, so `connectionMode` must be
`session-pooler` or `transaction-pooler`, and `user` must be
`memory_runtime.dnhcszbgdzgjpsktjaxn`). Two gaps before it can host the cut:

- It currently runs the **old projection schema** (0001–0005 series); the
  regional `postgres/migrations` 0001–0016 have never been applied there.
- Its provisioned runtime login is `memory_seoul_runtime`; the new
  migrations grant to `memory_runtime` — either create the new role or
  rename before applying 0014's grants, otherwise the attested role has no
  privileges.

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

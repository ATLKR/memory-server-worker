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

**kr-seoul** — Supabase project `dnhcszbgdzgjpsktjaxn` (the deployment
database is `postgres`; `ap-northeast-2`, pooler
`aws-0-ap-northeast-2.pooler.supabase.com`; direct `db.*` does not resolve,
`connectionMode` must be `session-pooler`, and the pooler user is
`<login>.dnhcszbgdzgjpsktjaxn`; the pooler CA chain is self-signed — pin it
via `MEMORY_KR_SEOUL_TLS_CA`/`PGSSLROOTCERT`). Regional lineage 0001–0017
applied, `deployment_identity` = `memory-seoul`/`kr-seoul`/
`kr-primary-storage-v1`, runtime login `memory_seoul_runtime` (member of
`memory_runtime`). Live cut rehearsal 2026-09-19: 79 tables, 198 rows,
15.2s freeze→verify, 0 mismatches; post-cut `postgres-attest` →
`attested:true, allDenialsHeld:true`.

**sg** — Neon project `memoryservice-nonseoul`, endpoint
`ep-lingering-pine-azosommb.c-3.ap-southeast-1.aws.neon.tech`, database
`memoryservice-nonseoul` (`connectionMode` `direct`; Neon forbids
`session-pooler` here). Full lineage 0001–0017 applied 2026-09-19,
`deployment_identity` = `memory-sg`/`sg`/`sg-primary-storage-v1`, runtime
login `memory_sg_runtime`. Live cut rehearsal 2026-09-19: 79 tables, 37
rows, 104.9s freeze→verify, 0 mismatches; post-cut `postgres-attest` →
`attested:true, allDenialsHeld:true`.

### Live topology update (2026-09-26)

- Control plane provisioned: `memoryservice-control` on the Neon sg
  endpoint, control lineage 1–7, `deployment_identity` =
  `memory-control`/`sg`/`standard-v1`, catalog seeded
  (regions `kr-seoul`,`sg`; deployments `memory-seoul`,`memory-sg`).
- Serving login = the `memory_runtime` group role itself
  (`connection.ts` requires `current_user = session_user = expectedRole`);
  the September `memory_seoul_runtime`/`memory_sg_runtime` logins are
  obsolete — do not reuse them for worker targets.
- Workers cannot open raw TCP: `pg` native transport fails on Workers.
  Production transport is **Hyperdrive** for all three connections
  (configs `memory-kr`, `memory-sg`, `memory-control`; bindings
  `KR_HYPERDRIVE`, `SG_HYPERDRIVE`, `*_CONTROL_HYPERDRIVE`).
- `allenlabs-memory-kr-seoul` and `allenlabs-memory-sg` are deployed and
  live-verified: `/health` 200 and `/v1/spaces` 401 through attested PG
  sessions over `memory.allenlabs.org/{region}/*`.
- Control attestation pins `controlRegion`/`controlSchemaVersion`(7)/
  `controlPolicyId`(`standard-v1`) — separate from the region pins.

### Prod D1 measurement (2026-09-26, for cutover sizing)

Source data is near-empty, so the sealed cut is seconds-scale, not
minutes-scale:

| Database | Tables | Meaningful rows |
|---|---|---|
| central `a186c3b4` | 82 | 1 account, 1 space, 1 pool, 3 credentials, 1 provider_identity, 1 email, 16 lifecycle events, 8 lifecycle states, 16 webhook events, 3 workspace sign-ins; `memories` = 0 |
| hot-01 `037bcfea` | 10 | 0 payloads, 0 tombstones |
| hot-02 `5e16ed77` | 10 | 0 payloads, 0 tombstones |

Consequence for section 3: the payload seal is a no-op today (no live
objects), and `copyTable` volume is ~50 rows across the non-empty central
tables — the FK-cycle machinery is exercised, not stressed. Record the
manifest anyway; it is the evidence that nothing was silently dropped.

### Prod D1 → PostgreSQL cutover sequence (2026-09-26 sizing)

Ordered steps for cutting the production worker off D1. The source is
tiny (~50 live rows, zero payloads), so steps 3–5 are one short window:

1. Pick the home region for existing prod data: the owner account and
   its single Space are unplaced; declare `kr-seoul` residency in the
   control catalog (enroll via `memory_control.enroll_account` +
   `enroll_organization` on the control session, then insert the
   `memory_control.spaces` placement row with `data_policy.residency =
   home_region` and `placement_epoch = 1`).
2. Snapshot the D1 counts (the table in this runbook is the baseline;
   re-run the same per-table COUNT + page_count measure immediately
   before the freeze and diff against it).
3. Freeze: deploy a maintenance flag on the prod worker (D1 has no
   LOGIN gate) or drain the route; confirm by re-measuring counts.
4. Export every non-empty central table (list above) plus `release_pools`
   and the `release_meta`/`release_fts_config` singletons into the
   manifest; hot shards have no data — record them as empty manifests.
5. Map-insert into the `kr-seoul` regional schemas (`memory_identity`,
   `memory_control` skeletons, `memory_content`, `memory_ops`); resync
   sequences; verify row counts and digests against the manifest.
6. Verify: `postgres-attest` on `memory-seoul` + control, then a live
   OAuth-scoped request against `memory.allenlabs.org/kr-seoul/` proves
   the serving path reads the imported rows.
7. Flip the prod worker off D1 (deploy with PG region wiring or repoint
   the unprefixed route to the regional worker — decide per acceptance
   doc), then apply the owner-pool unlimited UPDATE on the target
   (`Post-cutover operator adjustments`) and confirm `state='active'`.
8. Evidence: freeze timestamp, post-freeze counts, manifest, verify
   outputs, cut completion timestamp — write all five into the ops
   record (RPO=0 only if step-3 freeze held the whole window).

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
- Neither provider grants `session_replication_role` or
  `DISABLE TRIGGER ALL` to non-superusers — the copy path uses
  `DISABLE TRIGGER USER` + `copyOrder` (parents-first, cyclic FKs
  dropped/re-added) instead.
- `pg_auth_members` holds admin-option rows for the operator logins —
  freeze/unfreeze filter on `set_option OR inherit_option` and skip
  `current_user`, or the cut fences the operator itself.
- `postgres-rehearse.mjs --seed` writes a `rehearsal-`-prefixed fixture
  (2 accounts, org, spaces, memories, payload chain, jobs); it is
  idempotent and safe to re-run. The fixture rows persist on the source
  — boundary tables reject deletes by design.

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

`freezeRuntime(admin, 'memory_runtime')` — `ALTER ROLE ... NOLOGIN` on the
group **and every serving member login** (admin-option holders excluded so
the operator cannot fence itself), plus `pg_terminate_backend` for their
sessions. Every serving connection dies; there is no in-flight write to race
the seal. The operator session is a different role and unaffected.

## 3. Seal + copy + payload objects

1. `listRegionalTables(source)` — full surface, not a hand list.
2. `exportManifest(source, deploymentId, region, tables, at)` — the cut.
3. `copyOrder(target, tables)` — parents-first plan plus the intra-cycle FKs
   to drop (today `archives` ↔ `lifecycle_receipts`). Drop those constraints,
   then `copyTable(source, target, table)` in plan order for every enumerated
   table **except** provision-seeded ones (detected live: tables non-empty on
   a fresh target — today `memory_ops.maintenance_progress`,
   `memory_ops.payload_backfill_progress`; `schema_migrations` is never in
   the enumeration). Each copy runs under `DISABLE TRIGGER USER` — managed
   providers grant no way to suspend constraint triggers, so order + the
   dropped cycle edge is the mechanism. The importer writes `OVERRIDING
   SYSTEM VALUE` and resyncs sequences. Re-add the dropped constraints after
   the load — their validation is the FK-integrity proof.
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

## Post-cutover operator adjustments

- Owner pool stays unlimited on the target: after the cut verifies,
  `UPDATE memory_control.pools SET monthly_units=2147483647,
  storage_limit_bytes=1099511627776 WHERE id='account:b87f427d-3543-49b4-999e-da4332861227'`
  (the D1 `release_pools` row was set the same way 2026-09-25; metering
  via `usage_facts`/`usage_events` is trigger-driven and unaffected).
- `pools.state` must be `active` — the same quota check fails closed on
  `state != 'active'` regardless of the limit values.

## Evidence to retain

- Both `postgres-attest` JSON reports (source + control, before the cut).
- The manifest JSON (tables, per-table digests, schema digest).
- The `PayloadSeal` JSON (objects, unresolved, digest).
- `verifyManifest`/`verifyPayloadObjects` outputs (empty = pass).
- Wall-clock RPO (=0 for a sealed cut) and RTO (freeze→verify) measured on
  the real run — record the numbers; do not claim them from the rehearsal.

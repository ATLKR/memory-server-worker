# PostgreSQL regional authority — re-platform design

**Status:** design draft, 2026-09-16. Supersedes the D1-authority → Seoul
projection direction for the residency problem. User decision 2026-09-16: all
durable storage is PostgreSQL; no immediate multi-region requirement, but the
design must admit region-specific placement (Seoul today; US/EU later) that the
customer declares per Space. GA schedule is not tight — correctness of design
is the goal.

## Goal

Replace the D1/SQLite authority store with PostgreSQL while making residency a
customer-declared, per-Space property enforced in SQL — not a deployment-wide
constant and not an application-layer hint.

## Non-goals

- Multi-active regions, cross-region failover, or data sovereignty proofs for
  providers we have not contracted with.
- Any dual-write or silent fallback between stores (existing rule).
- Removing or weakening the existing authorization, lifecycle, erasure or
  metering contracts — the port must preserve them or the unit is not done.
- Activating any region, route or billing change before its own live
  acceptance gate.

## What exists already (surveyed 2026-09-16)

- **Narrow DB boundary.** Services consume `Database`
  (`src/release/types.ts:11`) / `IdentityDatabase` (`src/identity.ts:8`):
  `prepare → {bind,first,all,run}`, `batch`, `withSession('first-primary')`.
  122 `.prepare(` call sites in `src/`, 45 `withSession`, 11 `batch`.
  One Postgres adapter implementing `Database` reaches all 37 consumers.
- **Postgres schema namespaces designed for this port.** `postgres/` holds
  `memory_control` (deployment/catalog/placement), `memory_identity`
  (principals/credentials/memberships/authority ledger), `memory_content`,
  `memory_search`, `memory_jobs`, `memory_ops` — all created, forced-RLS,
  owner-gated, with role separation (`memory_owner` / `memory_runtime` /
  `memory_background` / `memory_commands` / `memory_lifecycle`).
- **Deployment + residency machinery.** `memory_control.deployment_identity`
  singleton carries `deployment_id`, `storage_region IN ('sg','kr-seoul')`,
  `processing_policy_id`; `memory_control.spaces` carries immutable
  `deployment_id` + `data_policy` (8-key jsonb: policyVersion, residency,
  profile, processingBoundary, dataClass, classificationStatus,
  sensitivityTags, placementEpoch); `src/postgres/residency-policy.ts` is the
  placement-selection and admission validator; the serving authorizer
  enforces residency in SQL (PA004).
- **Transport layer.** `src/postgres/connection.ts` — native socket and
  Hyperdrive transports with deployment attestation;
  `src/postgres/seoul/worker.ts` — route-free Hono composition.
- **Prior port inventory.** `postgres/PORTING.md` lists the full-port matrix
  (≈75 central tables, 5 views, 227 triggers on the D1 side).

## Target architecture

Two Postgres tiers. No D1, no durable-SQL authority, no projection pipeline.

### Tier 1 — control-plane cluster (one)

Holds globally-unique, low-sensitivity data:

- Global identity: accounts, organizations, account_emails, memberships,
  provider_identities, domains, email challenges/consumptions, revocations,
  workspace/SSO command records — the D1 `GLOBAL` set (≈80 tables).
- **Placement directory:** `spaces` skeleton rows — `id`, owner/org
  references, `home_region`, `data_policy`, `placement_epoch`, status.
  This is the only global copy of Space identity; every Space-scoped row
  lives in the region it names.
- Deployments catalog, global billing/checkout, global audit of identity
  mutations, mail budgets, heartbeats, `release_meta`-equivalent ledger.

The control plane is itself a PostgreSQL deployment in a chosen default
region (provider-neutral, e.g. `sg` until a first customer demands
otherwise). It stores no Space content, no memory payloads, no
region-locked plaintext.

### Tier 2 — regional data-plane clusters (one per residency region)

Each residency region (`kr-seoul` today; `us-*`, `eu-*` when a customer
demands them) runs a full `memory_*` schema set and is authoritative for
everything Space-scoped for the Spaces homed there:

- Space content and history (`memory_content`), payloads and archive
  references, lexical/vector search state (`memory_search`), jobs/queues/
  outbox (`memory_jobs`), usage/metering/audit/erasure ledger (`memory_ops`).
- **Regional authority ledger:** the PAT digests, `pat_space_grants`,
  lifecycle receipts and per-Space usage needed to authorize operations in
  that region — the `memory_identity` tables already designed for this.
- The minimal identity mirror rows (account/membership/email records
  referenced by grants in that region) — see "identity distribution" below.
- `memory_control.deployment_identity` declares the cluster's own
  `storage_region` and `processing_policy_id`; `memory_control.spaces`
  carries each homed Space's immutable `deployment_id` + `data_policy`.

`spaces` rows exist in both tiers by design: the control-plane skeleton is
the placement directory; the regional row is the serving record. The two
copies are kept consistent by the placement workflow, and the regional
authorizer treats its own row as authoritative for admission.

### Serving path

1. Request hits the regional Worker entry (Hono). The router resolves the
   Space's home region from the placement directory — a single indexed read
   on the control plane (or a cached+signed placement token minted at
   Space-selection time; caching policy is a decision below).
2. The request is dispatched to that region's serving composition — the
   existing `createSeoulApp` pattern generalized to `createRegionApp`, over
   the existing native/Hyperdrive transport.
3. The regional `seoul_action_authority`-equivalent function evaluates
   credential + grant + Space + `data_policy` + deployment identity in SQL —
   the current projected-authorizer logic becomes the permanent authorizer
   once its projection-predicates are replaced by direct regional truth
   (no generation/lease — the regional rows are authoritative, not copies).

## Residency model — customer-declared per Space

- `data_policy.residency` is declared at Space creation (or inherited from
  the owning organization's default) and written into both the
  control-plane skeleton and the regional row. `residency-policy.ts`
  (`selectStoragePlacement` / `parseDataPolicy`) validates the choice;
  `dataClass`/`sensitivityTags` can *force* a residency (medical-strict
  cannot pick `approved-processors`; clinical-origin content cannot leave
  its approved boundary) but never silently override a declared stricter
  region.
- `placementEpoch` supports re-placement: re-homing a Space is an explicit
  administrative workflow that bumps the epoch, migrates regional rows
  under a sealed manifest, and closes the old region's copy — never an
  implicit fallback.
- Enforcement points (all in SQL, defense-in-depth in TS):
  `assertRegionalStorageAdmission`/`assertSameStorageRegion` at the service
  boundary; the regional authorizer re-checks `data_policy` +
  `deployment_identity` per operation; the immutable `data_policy` trigger
  (`spaces_immutable`) already exists.
- Everything not covered by a residency declaration keeps the existing
  rule: no inference from IP/email/names, no cross-region fallback, no
  silent downgrade.

## Identity distribution

Accounts/organizations/memberships/emails are written on the control
plane. A region needs those rows only when a grant in that region
references them.

- **Bounded identity sync:** a central journal of identity mutations is
  applied to each region that references the identity — idempotent, ordered
  per identity key, with an explicit head/position per region. This is a
  much smaller surface than the v3 projection pipeline: identity rows only,
  no content, no per-Space generations.
- **Revocation lag** is handled by the same pattern the projected
  authorizer already proves: the regional admission check compares the
  mirror's applied-head to the identity's revocation marker; a region
  that has not applied a revocation denies once its bounded staleness
  budget expires (fail closed).
- PAT issuance is routed to the Space's region: creating a Seoul PAT writes
  the regional ledger directly (central records the issuance event for
  audit/billing). The ledger row is born authoritative — no apply lag for
  the grant itself.
- Whether SSO sessions themselves are regional is a decision below.

## What the projection pipeline becomes

- `migrations/0026–0036` (sources/heads/prepared/events/deliveries/
  watermarks/dirty/staging/targets/manifests/snapshot-stage) and the
  `src/release/seoul-projection-*` modules were D1→Seoul transport. Under
  this design they are replaced by:
  - the identity-sync journal (control → region), and
  - direct regional writes for everything Space-scoped.
- The regional-side v3 machinery partially survives: `serving-authorizer`'s
  admission checks (data_policy/deployment/grant evaluation) become the
  permanent regional authorizer; the generation/lease/grant-heads freshness
  machinery is retired for content (regional rows are authoritative) but
  the head-comparison pattern may be reused for the identity mirror's
  staleness bound. Final call at implementation review.
- `snapshot-dispatch`/`snapshot-materialization`/provisioning drafts: their
  role separation, preflight/postflight and ACL patterns carry over; the
  snapshot transport does not.

## Porting surface (from the survey)

| Work item | Scale |
| --- | --- |
| Postgres `Database` adapter (prepare/bind/first/all/run, batch, withSession) | 1 module; `src/postgres/connection.ts` already gives sessions |
| SQL dialect: `unixepoch('subsec')` → DB clock | `sql-clock.ts` (9 sites) |
| JSON1 → jsonb (`json_extract` 80, `json_*` ~188 total) | pervasive; rewrite per call site |
| `ON CONFLICT`/`RETURNING`/`rowid`/`sqlite_*`/`changes()` | 25/12/16 sites; `sqlite_*` mostly `durable-sql` internals (drop with D1) |
| `migrations/0001–0036` → postgres migrations | 122 tables; projection-only tables (0036-era) dropped |
| Test surface | 651 `.prepare(` in `test/`; a pglite-backed `Database` adapter lets suites run unmodified except SQL assertions |
| Durable-SQL/DO engine, D1 bindings, `d1` backend branch | retired after cutover (kept unbound, then removed) |

## Phasing

Each phase is independently committed, reviewed and verified; nothing is
activated before its own gate.

1. **P-0 Design + inventory (this doc).** Freeze data classification
   (global/regional/cross-border), enumerate open decisions, baseline the
   existing Postgres schemas.
2. **P-1 Postgres `Database` adapter + test pglite adapter.** Same
   interface; transactional `batch`; `withSession('first-primary')` maps to
   a single-session connection. Existing unit suites run against it.
3. **P-2 Schema port.** Postgres migrations for the ~80 global tables into
   `memory_control`/`memory_identity`/`memory_ops` on the control plane and
   the ~22 Space-regional tables into `memory_content`/`memory_search`/
   `memory_jobs`/`memory_ops` on the regional cluster — reusing existing
   `postgres/` objects where they match, extending where they don't.
   Placement directory + `data_policy` writer on `spaces`.
4. **P-3 Service port.** Dialect rewrites at the 122 call sites; identity/
   auth/workspace/memory/api/mcp first, then release modules (jobs, search,
   payloads, lifecycle, billing). Per-module focused suites.
5. **P-4 Placement + routing.** `data_policy` on Space creation,
   `resolveMemoryRoute` consumes the directory, `createRegionApp`
   generalization, region attestation.
6. **P-5 Identity sync + regional authority.** Journal/outbox + regional
   apply; permanent regional authorizer; revocation staleness bound.
7. **P-6 Cutover, backfill, recovery.** Sealed import (existing pattern:
   exact table/column/schema identity, chunk hashes, row counts, digests),
   freeze writes, verify target, keep D1 as recovery artifact, no dual
   writes, rollback reconciliation.
8. **P-7 Residency verification + GA gate.** Regional residency proof
   (storage, backups, WAL, logs), cost evidence within the $50/month budget,
   live acceptance per region.

## Open decisions (need answers before their phase)

1. **Placement lookup path:** does every request read the directory, or is
   placement carried by a signed token/claim minted when the client selects
   a Space? (Latency vs revocation freshness.)
2. **Account home vs Space home:** may an account in region A hold grants
   on a Space in region B? If yes, identity mirror is mandatory; if no
   (region-locked identities), the model is simpler but constrains
   cross-region org usage. Initial proposal: allow it via the bounded
   mirror — cross-region shares stay a separately-reviewed federation unit.
3. **SSO/session placement:** sessions central with regional re-check, or
   issued regionally like PATs?
4. **Control-plane location/provider:** which region hosts it, and does any
   customer's residency declaration ever cover control-plane rows
   (org metadata is itself residency-sensitive for strict customers)?
5. **Backup/WAL residency evidence** per provider — which managed Postgres
   (Supabase, Neon, others) can actually prove in-region backups and
   operator-access bounds for each tier.
6. **`release_shares`** (only cross-border D1 table): federation design or
   region-locked shares initially.
7. **Search vectors:** which vector store per region (pgvector vs external)
   — the existing inventory says regional vector projections are separate
   work; keep that boundary.
8. **What to do with the existing v3 projection drafts** already merged to
   `feat/seoul-identity-projection-v3`: keep as the identity-sync/apply
   foundation, repurpose, or supersede and archive. The role/preflight/
   postflight discipline carries over regardless.

## Constraints carried forward

- No advertising a region/backend as operational before live verification.
- No dual writers; no silent fallback; deterministic bounded writes only.
- Backend HTTP stays Hono; frontend preference TanStack Start/Router.
- $50/month Cloudflare budget rule extends to total platform spend —
  Postgres hosting costs must be measured and evidenced before GA.
- Secrets via env only; provider credentials never in bindings/logs.

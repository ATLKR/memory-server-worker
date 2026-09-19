# PostgreSQL regional authority — re-platform design

**Status:** design draft, 2026-09-16, amended 2026-09-17. Supersedes the
D1-authority → Seoul projection direction for the residency problem. User
decision 2026-09-16: all durable storage is PostgreSQL; no immediate
multi-region requirement, but the design must admit region-specific
placement (Seoul today; US/EU later) that the customer declares per Space.
GA schedule is not tight — correctness of design is the goal.

Amendment 2026-09-16: the identity model is decided — **central SSO
subject + explicit per-region enrollment** (replaces the bounded-mirror
sketch below; open decisions 2 and 3 resolved). Identity rows are owned by
regions; the control plane holds only subject bindings, the canonical id
registry, the enrollment directory, and the global-disable journal.

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

- **Central identity minimum:** SSO subject bindings
  (provider/issuer/subject → canonical account id), the canonical
  account/organization id registry, the **enrollment directory** (which
  regions each account/organization is enrolled in), and the
  global-disable flag per account. No emails, memberships, credentials,
  grants or lifecycle rows exist centrally — a residency declaration then
  covers a strict customer's identity state completely.
- **Placement directory:** `spaces` skeleton rows — `id`, owner/org
  references, `home_region`, `data_policy`, `placement_epoch`, status.
  This is the only global copy of Space identity; every Space-scoped row
  lives in the region it names.
- Deployments catalog, global billing/checkout catalog, the central
  lifecycle journal (account disable / SSO-subject unlink / enrollment
  removal events, ordered per region), audit of control-plane mutations,
  `release_meta`-equivalent ledger.

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
- **Regional identity ownership:** for accounts/organizations enrolled in
  the region — account, organization, email, membership, credential/PAT,
  grant and lifecycle rows in `memory_identity`, born authoritative in the
  region (never a copy of a central original).
- **Regional authority ledger:** the PAT digests, `pat_space_grants`,
  lifecycle receipts and per-Space usage needed to authorize operations in
  that region — the `memory_identity` tables already designed for this.
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

## Identity model — central subject + explicit regional enrollment

Decided 2026-09-16. Identity is **not** replicated: the control plane
holds the minimum needed to authenticate and route, and each region *owns*
the identity rows for the accounts and organizations enrolled there.
Rejected alternatives: region-locked identities (breaks mixed-residency
customers and cross-region orgs), global identity + regional mirror
(stores strict customers' identity metadata outside their declared
region), signed cross-region attestation (still needs online revocation
checks; highest complexity).

- **Control plane minimum:** SSO subject bindings
  (provider/issuer/subject → canonical account id), the canonical
  account/organization id registry, the enrollment directory, and the
  per-account global-disable flag. Nothing else identity-related is
  central.
- **Regional ownership:** an enrolled account's account, email,
  membership, credential/PAT, grant and lifecycle rows are first-class
  rows in that region's `memory_identity` schema — the region is their
  authority. The same applies to enrolled organizations.
- **Enrollment is an explicit act:** SSO sign-in at a regional endpoint →
  if the subject has no enrollment in that region, run the enrollment
  flow (consent + policy validation) → create the regional account row.
  Organization membership follows the same pattern: the organization must
  be enrolled in region R and the invitee must enroll in R before the
  membership row exists — an extension of the existing
  `workspace_invitations`/`acceptances` command pattern.
- **Space home and account home are independent:** an account enrolled in
  region A may hold a grant on a Space homed in region B only if the
  account is *also* enrolled in B. Cross-region sharing is therefore a
  consent-based enrollment act, not implicit synchronization — the grant
  row lives in the Space's region and references the regional account row
  there.
- **Global revocation is one narrow journal:** only central events —
  account disable, SSO-subject unlink, enrollment removal — are applied
  to the affected regions in order, reusing the v3 head-comparison /
  bounded-staleness pattern (a region that has not applied a revocation
  denies once its staleness budget expires; fail closed). PAT issuance
  and grants are regional writes with zero apply lag.
- **SSO/session evaluation:** the SSO subject is resolved centrally (it
  is the login key); sessions are minted and evaluated *regionally*
  against the regional account row and current enrollment — the same
  principle as the regional serving authorizer, in the region's SQL.
- **Region-only accounts** (no central SSO subject — regional credential
  only) stay possible for strict customers: the directory simply has no
  central mapping for them. The schema permits this now; the product flow
  can surface it later.

## What the projection pipeline becomes

- `migrations/0026–0036` (sources/heads/prepared/events/deliveries/
  watermarks/dirty/staging/targets/manifests/snapshot-stage) and the
  `src/release/seoul-projection-*` modules were D1→Seoul transport. Under
  this design they are replaced by:
  - the central lifecycle journal (control → region: account disable,
    SSO-subject unlink, enrollment removal only), and
  - direct regional writes for everything Space-scoped and everything
    identity-scoped.
- The regional-side v3 machinery partially survives: `serving-authorizer`'s
  admission checks (data_policy/deployment/grant evaluation) become the
  permanent regional authorizer; the generation/lease/grant-heads freshness
  machinery is retired for content (regional rows are authoritative) but
  the head-comparison pattern is reused for the lifecycle journal's
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
3. **P-2 Schema port.** Postgres migrations per the frozen classification
   ([`2026-09-17-residency-data-classification.md`](2026-09-17-residency-data-classification.md)):
   14 control-plane tables + 3 split skeletons (accounts, organizations,
   spaces) into `memory_control`/`memory_ops` on the control plane; 33
   identity + 27 Space-scoped tables into `memory_identity`/
   `memory_content`/`memory_search`/`memory_jobs`/`memory_ops`/
   `memory_control` on the regional cluster — reusing existing `postgres/`
   objects where they match, extending where they don't. Enrollment
   directory, placement directory + `data_policy` writer on `spaces`.
4. **P-3 Service port.** Dialect rewrites at the 122 call sites; identity/
   auth/workspace/memory/api/mcp first, then release modules (jobs, search,
   payloads, lifecycle, billing). Per-module focused suites.
5. **P-4 Placement + routing.** `data_policy` on Space creation,
   `resolveMemoryRoute` consumes the directory, `createRegionApp`
   generalization, region attestation.
6. **P-5 Regional enrollment + authority.** Enrollment commands +
   directory writer, central lifecycle journal + regional apply, permanent
   regional authorizer, revocation staleness bound.
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
2. ~~**Account home vs Space home**~~ — **resolved 2026-09-16:** yes, via
   explicit per-region enrollment. An account must be enrolled in the
   Space's region to hold a grant there; no identity mirror exists.
   Cross-region share workflows are enrollment invitations and stay a
   separately-reviewed unit.
3. ~~**SSO/session placement**~~ — **resolved 2026-09-16:** central SSO
   subject resolution + regional session minting/evaluation against the
   regional account row and enrollment state.
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

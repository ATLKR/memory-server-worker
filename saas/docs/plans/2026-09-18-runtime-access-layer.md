# Runtime access layer — regional + control planes (P-3b)

Status: committee-reviewed 2026-09-18 (two reviewers converged; corrections
folded in). Regional migration is **`0014_runtime_access.sql`** — `0013` was
taken by `0013_retrieval_progress.sql` while this design was in review.

## Problem (verified)

The ported release service executes every statement through the attested
regional session (`createPostgresDatabase(session)` in
`src/postgres/region-app.ts`). In production that session runs as a login role
inheriting `memory_runtime`. Verified in PGlite under
`SET SESSION AUTHORIZATION memory_runtime` after applying all 12 regional
migrations: `SELECT` on `active_credentials`, `spaces`,
`lifecycle_apply_head`, `provider_identities`, `memories` all fail `42501`.
Every table is `FORCE ROW LEVEL SECURITY` with only the `migration_owner`
policy, and the handful of 0011 grants has no matching policies — so the
service can execute **zero** data statements under its attested role. All
tests pass because PGlite fixtures run as superuser.

PORTING.md already prescribes the model: runtime has no direct
INSERT/UPDATE/DELETE/SELECT on identity-authority tables; writes go through
"reviewed SECURITY DEFINER commands"; the control plane shows the designed
pattern (`directory_read` policy + SELECT grant for runtime reads). The
command-record machinery (`workspace_*` tables + `ws_*_validate`/`ws_*_apply`
triggers) exists but the triggers are invoker — they cannot run under
runtime either.

## Design

The layer is one regional migration (`0013_runtime_access.sql`) plus one
control migration (`0006_runtime_access.sql`), a handful of new definer
commands, curated runtime views, and a privileges-catalogue verifier that
pins the exact surface.

### 1. Trigger functions → SECURITY DEFINER

Every trigger function that issues queries or DML against guarded tables
must run as `memory_owner` (its owner) or it deadlocks the runtime role at
`42501`. `ALTER FUNCTION ... SECURITY DEFINER` on:

- `ws_*_validate` + `ws_*_apply` (command admission + guarded apply)
- `domain_verification_validate/apply`, `scim_*_validate/apply`
- `provider_email_guard`, `external_claim_block`, `challenge_external_block`,
  `consume_block`, `claim_not_blocked`, `membership_live_claim`,
  `credential_live_binding`, `domain_manager_binding`,
  `organization_hierarchy_validate`, `organization_hierarchy_immutable`
- content guards that query/insert: `supersession_guard`, `space_audit`,
  `memory_created`, `memory_updated`, `memory_versions_guard`,
  `memory_validate_transition`, `ingest_approval_guard`,
  `operation_revision_guard`, `operation_meter`, `storage_accounting`,
  `payload_*` guards, residency/data_policy checks from 0008
- `memory_control.reject_mutation` may stay invoker (raises unconditionally)
  but is marked definer too for uniformity.

Pure NEW/OLD predicates could stay invoker; marking the full set definer is
uniform and their bodies are fixed and reviewed.

### 2. Runtime policies + grants — regional

Following the `directory_read` precedent. First, the mechanical enabler the
draft missed: `GRANT USAGE ON SCHEMA` for every runtime-touched schema —
0002 granted only `memory_control`; `memory_jobs` and `memory_search` lack
USAGE entirely, and without it every table grant is dead at 42501.

- **App-writable tables** (`runtime_read` + per-verb write policies, pinned
  per table — no blanket write): memories, memory_versions (DELETE for
  erasure), payload_intents/stages/archives/archive_permits (DELETE on
  permits), release_ingests, release_jobs, ingest_operations,
  ingest_approvals, release_operations, release_events (direct app INSERT —
  memory.ts, admin.ts), erasure_permits (DELETE), erasure_ledger (INSERT;
  its `vector_erased_at` completion UPDATE needs the append-only trigger
  narrowed — known defect), space_pools, space_policies, mail_budget,
  provider_budgets, payload_purges, payload_retirements, export_sessions,
  maintenance_progress, payload_backfill_progress, webhook_events,
  lifecycle_jwt_proofs, lifecycle_events, heartbeats (INSERT+UPDATE — the
  scheduled path upserts under runtime, extension.ts), provider_revocations
  (regional tombstones, admin.ts INSERT), lifecycle_apply_head +
  lifecycle_applied_state (SELECT+INSERT+UPDATE — `syncLifecycleJournal`
  upserts under the runtime session; **preferred:** definer
  `apply_lifecycle_event` enforcing monotonic sequence + terminal
  `account.deleted` owner-side, falling back to direct policies only if the
  command shape can't express the batch), memory_search.* (fts_rows +
  vector_refs), memory_control.spaces (SELECT+INSERT — `createSpace` writes
  directly; residency enforced by CHECK + data_policy triggers),
  memory_control.organizations (SELECT only).
- **SELECT-only** (trigger-maintained ledgers/counters — runtime INSERT
  would let a compromised runtime forge audit/billing evidence):
  memory_audit_events, usage_counters, space_storage_counters,
  workspace_audit_events, identity_audit_events (if present). The app reads
  them for quota/audit display but never writes them directly.
- **No runtime access at all** (Seoul-slice command-mediated):
  meter_events, space_usage — these belong to `memory_commands`/
  `memory_lifecycle` definer functions (0004/0005); granting runtime DML
  would bypass that slice's reviewed command layer.
- `runtime_record` on **command-record / claim tables**: workspace_sign_ins
  (INSERT only — rows carry token_digest; the app never reads it back, and
  `ws_sign_in_validate` cannot verify the SSO proof itself — the
  session-mint trust boundary is documented below),
  workspace_organization_creations, workspace_child_organization_creations,
  workspace_invitations, workspace_invitation_acceptances,
  workspace_key_issuances, workspace_key_revocations,
  workspace_membership_revocations, workspace_key_metadata,
  domain_verifications, domain_challenges (INSERT/UPDATE-via-apply/DELETE —
  jobs.ts deletes expired challenges), domain_managers, scim_keys,
  scim_deletions, auth_flows (INSERT/UPDATE/DELETE — auth.ts deletes),
  reauth_challenges (INSERT/UPDATE/DELETE — admin cleanup deletes),
  email_challenges, email_consumptions, credential_policies, revocations,
  email_blocks, external_email_blocks, shares (SELECT+INSERT+UPDATE — the
  UPDATEs at transfer.ts accept/revoke must reach the deny trigger so
  `deferredShare` maps `memory_immutable_record` to 403; a 42501 would
  surface as a 500), organization_hierarchy, domains (SELECT only —
  created by definer apply). SELECT+INSERT for all; UPDATE only for the
  mutable subset listed; DELETE only for the three tables the app deletes.
- **Authority-6** (accounts, organizations, account_emails, memberships,
  credentials, provider_identities): zero direct runtime access — unchanged.
  Reads via views, writes via records/definer commands only.

### 3. Runtime views (identity reads)

The app reads raw identity tables at ~40 sites. Each gets a pass-through or
narrowed owner-definer view, `GRANT SELECT` to memory_runtime:

- `runtime_credentials` = credentials (needed for id/digest lookups and
  author joins; `active_credentials` already exposes the digest shape the
  service verifies — digest exposure to the serving role is accepted and
  documented: verification is the runtime's function)
- `runtime_account_emails`, `runtime_accounts`,
  `runtime_provider_identities`, `runtime_memberships`,
  `runtime_organizations`
- existing `active_credentials`, `active_memberships` get
  `GRANT SELECT` + no policy needed (owner-definer views; underlying
  access evaluates as `memory_owner` which `migration_owner` covers)

Site rewrites: `memory_identity.credentials` → `runtime_credentials` etc.
Only SELECT sites; no semantics change.

### 4. Definer commands for the direct authority writes (~6 sites)

- `admin.ts:164` key issuance INSERT credentials → `workspace_key_issuances`
  record (existing apply already issues the credential) — reroute site.
- `admin.ts:169` credential_policies insert → record table has runtime
  INSERT policy already.
- `auth.ts:254` credential self-revocation → `workspace_key_revocations`
  record or `memory_commands.revoke_credential(id, at)` definer.
- `admin.ts:436/443` account disable + email revoke → new definer commands
  `disable_account` / `revoke_email_claim` (or `revocations` record rows —
  revocations is already an app-inserted record table; a definer apply can
  process it. Decide during implementation; record-table route preferred if
  existing apply coverage exists).
- `admin.ts:495` membership revoke → `workspace_membership_revocations`
  record (existing apply).
- `admin.ts:390` domain_managers insert → record table with runtime INSERT
  policy.

### 5. Control plane (`control/0006_runtime_access.sql`)

The control connection attests as `memory_runtime` too. Control/0003 is
explicit: "the directory is runtime-readable ... while no policy grants
writes. Journal tables stay owner-only; regional apply/dispatcher access is
added with that unit." The unit is this migration.

- **Enrollment: definer commands, not policies.** `enroll_account`,
  `remove_account_enrollment`, `enroll_organization`,
  `remove_organization_enrollment` — covering the canonical skeletons
  (`memory_control.accounts`/`organizations` inserts that enrollment.ts
  also performs) plus the enrollment rows. A USING(true)/CHECK(true)
  policy would let a compromised *regional* runtime strip enrollment rows
  in *any* region (the directory is global). The command asserts the target
  region exists and is active; a `memory_control.runtime_region_bindings`
  owner-maintained mapping (login role → region) lets the command reject a
  caller acting outside its own region when the provisioner binds one —
  absent bindings keep single-cluster/dev flows working.
- **Journal: definer `journal_append` / `revocation_append`** for
  `webhook_events`, `lifecycle_jwt_proofs`, `lifecycle_events`,
  `provider_revocations` — keeps the append-only journal command-mediated
  per the 0003 comment.
- **Lifecycle sync read:** `syncLifecycleJournal` reads
  `memory_ops.lifecycle_events` over the control connection — either a
  `journal_read(issuer, after_sequence, limit)` definer or a SELECT policy;
  pick during implementation (definer preferred, same boundary).
- **Billing catalog:** `pools`, `checkout_requests`, `billing_events`,
  `checkout_closures`, `billing_lock` — these are control-plane tables
  (they were wrongly listed under the regional §2 in the first draft). The
  app interleaves provider calls between statements, so whole-operation
  functions don't fit; designed runtime policies + the existing 0005
  freeze trigger are the pragmatic layer, with column-scoped UPDATE where
  feasible. If review prefers, `checkout_claim`/`checkout_close` definers —
  decide at implementation.
- SELECT on the directory stays as granted by 0003.

### 6. Verification

- Extend the seoul-style privileges catalogue to a new manifest pinning
  every runtime grant/policy/view/definer function — the ACL diff IS the
  review artifact; unexpected grants fail the suite.
- New `test/postgres/runtime-access.test.mjs`: full migrated DB, fixture
  data as owner, then `SET SESSION AUTHORIZATION memory_runtime` and run
  real service operations end-to-end (`createApplication` requests or the
  underlying service calls) — the missing test that would have caught this.
- Assert denial still holds where designed: raw authority-6 tables reject
  runtime; `INSERT` on non-record identity-adjacent tables rejects.

## Accepted trust boundaries (documented per review)

- **`workspace_sign_ins` session-mint:** a runtime INSERT reaches
  `ws_sign_in_validate`, which only *denies* bad states (disabled account,
  conflicting credential, provider revocation) — it cannot verify the SSO
  proof, which lives at the service boundary. A compromised `memory_runtime`
  could mint session credentials for any non-disabled account by inserting
  sign-in records. This is inherent to the record-table model (identical to
  the D1 lineage). Mitigations: INSERT-only policy (no SELECT — rows carry
  token_digest), and the risk is named here so a future hardening pass can
  add a proof column the validator checks.
- **`token_digest` in runtime views:** `active_credentials` already exposes
  `c.*` including `token_digest` (0006). `runtime_credentials` adds no new
  exposure class; digests are SHA-256 over high-entropy tokens and the
  serving role's documented function is verifying them. Views are owned by
  `memory_owner` with `security_invoker` unset — they are a catalogue/
  audit boundary, not a column boundary.
- **Provisioner invariant:** the deployment login must be a member of
  `memory_runtime` only — no other role memberships, no schema ownership.
  Attestation already pins `current_user = session_user = expectedRole`
  plus membership/ownership edges; the manifest asserts
  `memory_runtime ∉ members(memory_owner)`.

## Explicit non-goals

- No `SELECT *`-style broad policy on authority tables.
- No runtime DELETE anywhere except the tables the ported code already
  deletes from: memory_versions, erasure_permits, payload_archive_permits
  (permit-gated erasure), auth_flows, reauth_challenges, domain_challenges
  (expired-artifact cleanup).
- Cross-region share federation stays deferred (shares insert/update
  policies exist only to reach the immutable deferred-deny trigger, whose
  55000 the service maps to the stable `share_unavailable` 403 — a bare
  42501 would surface as a 500).
- `memory_background` keeps its own grants for future units; nothing in the
  ported app attests as it today — the region-app scheduled path runs under
  `memory_runtime`, so heartbeats/maintenance/lifecycle-apply writes land
  on the runtime policies (or the lifecycle-apply definer).
- No `serial`/bare-`nextval` defaults exist in runtime-writable tables
  (IDENTITY columns need no sequence grants — confirmed during review).

## Resolved at committee review (2026-09-18)

1. `token_digest` through views: **accepted** — no new exposure class vs
   `active_credentials`; documented above. Column-scoped grants were
   rejected — they don't bypass RLS, so a base-table SELECT policy would
   still be required and would break the documented invariant (and
   `schema.foundation.test.mjs` asserts raw-table denial).
2. Control writes: **definer commands** for enrollment (region-asserted),
   journal append, and journal read; **designed policies** for the billing
   tables whose flows interleave provider calls.
3. `release_operations`/checkout claim paths stay **direct statements** —
   the freeze/guard triggers (now definer-marked) enforce the atomicity
   invariants.
4. `memory_control.spaces` is a regional skeleton, not an authority-6 table:
   runtime SELECT+INSERT (createSpace) is consistent with the model.
5. The runtime-read rewrite must cover **every**
   `memory_identity.<authority-table>` fragment in src/, including the
   inlined `authority()`/`liveAccountSql()`/`shareGrantorAuthority()`
   predicates inside INSERT/UPDATE statements (~99 refs across 13 files) —
   not just top-level SELECTs.
6. `verifySeoulServingPrivileges`-style manifest pins: schema USAGE,
   per-table policy verbs, view ownership + `security_invoker` unset,
   `prosecdef` + `proconfig=search_path=pg_catalog` on every
   trigger/definer function, EXECUTE grants, and negative assertions (no
   runtime policy on authority-6; `memory_runtime` not a member of
   `memory_owner`; no definer function body references `session_user`).

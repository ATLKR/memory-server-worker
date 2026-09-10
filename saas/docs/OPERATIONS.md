# Operations runbook

This runbook describes the current release. Historical deployment evidence is
retained in [VERIFICATION.md](VERIFICATION.md); the latest deployment is documented in
[release/INTEGRATION.md](release/INTEGRATION.md). Cloudflare Email
proof delivery is covered in [release/EMAIL.md](release/EMAIL.md). Treat these
documents as the source of truth for release behavior.

## Current source and environments

The candidate is **0.5.0-rc.1, central schema 25 and HOT schema 1**. Production
remains rc.3 with central migrations 1–7. Staging at
`https://memory-staging.allenlabs.org` runs the earlier `1a93820` revision with
central migrations 1–23 and HOT 1; 24–25 are not deployed. All remaining migrations
are mandatory before the current Worker is deployed. Historical rc.4 test counts
do not describe this candidate.

The selected GA is invite-only and metered, including AI retrieval and reviewed
extraction, with paid billing disabled. Earlier staging live evidence covers SSO,
scoped PATs, the official MCP SDK, AI, ten-level independent organization ACLs,
CRUD/restore/erasure and metering. Mail receiver deployment/proof consumption,
central lifecycle rollout and final-revision acceptance remain pending. Current
Authentication35 finished with zero actionable findings; Storage36 reported
three findings now assigned for correction. Affected domains will be reviewed
again after fixes, and a fresh console review follows these corrections.

## Maintenance and diagnosis

The source configures `*/5 * * * *` for expired transient-state cleanup. Each
invocation processes at most 100 rows per cleanup category: ingest payloads,
export sessions, unused domain challenges, reauthentication challenges and
past-day mail budgets. Consumed DNS proofs and immutable verification receipts
are retained.
Expiry is checked by request authorization independently of the sweep, so a
backlog does not extend a credential or challenge lifetime. Immutable identity
and audit records are retained. Migrations 1–7 are applied in the recorded
production environment and byte-frozen. This PR additionally requires forward
migrations `0008_checkout-schema.sql`, `0009_job-progress-schema.sql`,
`0010_protocol-schema.sql`, `0011_pagination-schema.sql`,
`0012_lookup-schema.sql`, `0013_key-lookup-schema.sql`,
`0014_tenant-queue-schema.sql`, `0015_workspace-lookup-schema.sql`,
`0016_retrieval-progress-schema.sql`, `0017_vector-reconciliation-schema.sql`,
`0018_outbound-share-schema.sql`, `0019_execution-time-schema.sql`,
`0020_domain-verification-schema.sql`, `0021_domain-retention-schema.sql`,
`0022_payload-schema.sql`, `0023_operational-schema.sql`,
`0024_lifecycle-schema.sql` and `0025_queue-episode-schema.sql`.
None of migrations 8–25 has been applied to production. New environments apply
central migrations 1–25 and `shard-migrations/0001_payloads.sql` to every HOT DB.
Readiness requires central 25/HOT 1. The final full validation is to be rerun;
the [integration record](release/INTEGRATION.md) scopes earlier native/local
evidence and remaining live acceptance.

Migration 22 adds immutable payload pointers, logical byte accounting, durable
preparation intents and purge/retirement outboxes. Migration 23 adds aggregate
UTC-month provider cost reservations and bounded inline-backfill progress.
Migration 24 adds ordered account/exact-email lifecycle handling and verified
JWT lifecycle heads before new sign-in claims. Migration 25 records current
queue episode time without rewriting original creation time; unreconstructable
older retry episode times remain unknown.

Migration 19 and the application SQL helpers evaluate deadline admission at the
later of the application-bound time and the database statement's execution time.
A queued statement cannot use an already-expired credential, membership or
recent proof, or an elapsed restoration/ingest deadline or lease, to authorize a
later mutation. This tightens temporal admission while preserving recorded
timestamps and immutable identity/history/audit records. Recent-proof consumption
and the matching credential's `reauthenticated_at` update run atomically through
one SQL statement and its triggers. Include queue-delay expiry and proof
consumption rollback cases in staging acceptance after applying migration 19.

Migration 20 makes DNS verification one receipt/trigger statement: challenge
consumption, domain creation or renewal, and the exact manager assignment commit
or roll back together. A completed receipt can be replayed only by the same
account with a current browser session, recent email proof, the original live
owner/admin membership and its nonrevoked domain-manager assignment. Domain and
receipt validity are checked again. It returns the original `verifiedUntil`
without repeating DNS or extending verification.

An accepted provider email-revocation event invalidates unused pending proofs
for the exact account/address; standing blocks reject new proof issuance or
consumption with 403. Migration 20 backfills only unused, not-yet-invalidated
proofs covered by those exact blocks, using database execution time. Consumed
proofs and immutable history remain intact. Migration 21 adds a selective
unused-DNS-proof expiry index; cleanup removes at most 100 unused expired DNS
challenges per invocation and retains consumed proofs and verification receipts.

Migration 14 rebuilds only the derived FTS table, preserving its stable row IDs,
source and history. It adds exact encoded tenant terms and prefix indexes for
lengths 1–31. Search rejects longer processed terms with `search_token_too_long`
before charging usage; it never falls back to a global prefix scan. Ranking uses
local body match density instead of global BM25 statistics. These indexes use
additional physical D1 space beyond the logical body/history quota. Measure
database size and migration duration on a populated staging copy before rollout.
[FTS5 prefix indexes](https://www.sqlite.org/fts5.html#prefix_indexes).

A local SQLite comparison with 1,000 identical bilingual documents in 20 Spaces
(354,890 logical body bytes) used 688,128 bytes for the previous FTS table and
1,945,600 bytes for tenant/prefix indexing: 2.83 times the FTS-only footprint.
This synthetic sample excludes source/history tables and is not a production
capacity forecast. Both migration 12 and migration 14 rebuild derived FTS content;
include both steps when measuring an upgrade from the deployed schema 7.

The same migration adds tenant-specific Space candidate indexes, per-state queue
indexes, a cleanup-only job flag and a durable maintenance cursor. Existing job
progress remains intact. Queue claims select bounded candidates before combining
states; maintenance can continue its bounded scan on a later invocation.
Space pagination bounds candidates from each source before merging and checking
current access; exact-scoped PATs start from their stored Space IDs. Sorting the
caller's own membership/share set may still grow with that set. These indexes
remove unrelated-tenant scans, not the cost of enumerating an arbitrarily large
set of the caller's grants. Include large-account pagination in capacity testing.

Migration 15 adds account/key and retained organization-membership indexes for
the initial workspace snapshot, plus a tombstone index and source-erasure cursor.
Automatic source erasure, when enabled, inspects at most 20 raw tombstones per
invocation before applying each Space's retention policy. It advances past rows
that are not yet due and wraps for later checks; a configured retention duration
is an eligibility threshold, not a promise of deletion at that exact instant.
Existing source, history, job progress and the vector-sweep cursor remain intact.

Migration 16 indexes per-Space ingest/job lists and all retained memory states
used by index rebuilds. It also records at most 100 vector IDs in a pending
deletion page. Accepted asynchronous deletions are confirmed on later slices,
with a five-second delay while visibility is pending. These waits preserve prior
failure counts; actual provider errors and abandoned leases retain the five-attempt
failure limit. A deletion cursor and erasure confirmation advance only after
absence is observed under the current lease. Migration 17 adds a durable retry
deadline and delay for each pending page. If vectors remain visible, the same
page is deleted again after an initial 60-second interval, doubling up to 24 hours.
Checkpointing before the provider request preserves the propagation window across
restarts. Visibility waits and reconciliation do not spend failure attempts;
actual provider errors and abandoned leases still do. This also removes vectors
from an older upsert that finishes between deletion and confirmation.
`vector_erased_at` records the most recent confirmed absence; later sweeps retain
that historical observation while their job is pending. It does not certify that
an earlier provider request can never finish later. Inspect pending/dead cleanup
jobs alongside that timestamp. Initial erasure leaves it null until confirmation.
Identifiers remain available for
subsequent anti-resurrection sweeps.

Queries and stored bodies use the same Unicode61 tokenization without query-only
NFKC conversion. Identical fullwidth or ligature words remain searchable; ASCII
and compatibility variants remain distinct. The 31-code-point limit applies to
each of the first 20 distinct processed terms in the original query.

Checkout recovery records whether a Stripe Checkout request may have been sent.
A customer-creation failure leaves the request unattempted; its first Checkout
attempt atomically refreshes the expiry to 35 minutes and permanently marks the
attempt. Concurrent callers and retries use that persisted expiry. A lost
Checkout response, or any checkout row that predates migration 8, is treated as
attempted even when `session_id` is NULL. Do not reset its marker or extend its
expiry: reconcile the existing Stripe attempt and preserve the idempotency key.
An expired operation requires a new operation ID. Stripe requires at least a
30-minute creation window and rejects changed parameters for an existing
idempotency key. [Checkout expiry](https://docs.stripe.com/api/checkout/sessions/create),
[Stripe idempotency](https://docs.stripe.com/api/idempotent_requests).

A local expiry alone does not authorize a replacement purchase: an earlier
session may have completed while its payment event is still queued. Migration 10
records an immutable closure only after Stripe confirms expiry or confirms that
the completed session's matching subscription ended. A completed live purchase
requires reconciliation instead of a new checkout. If a prior attempt's session
ID is unknown after response loss, keep it blocked for operator reconciliation;
do not guess that NULL means no purchase occurred.

SCIM DELETE records a tombstone for the exact membership, revokes its access and
removes that resource from SCIM queries while preserving internal audit history.
PATCH deactivation remains visible with `active:false`. GET supports SCIM page
normalization and attribute selection without returning explicitly excluded email
fields. The adapter remains deprovisioning-only; it does not provision users.

Indexing and vector cleanup retain durable chunk/cursor progress under the current
job lease. Successful partial work yields without consuming a failure attempt;
provider failures and crashed expired leases are capped at five attempts before
manual recovery. Cleanup retains identifier-only references for later erasure
sweeps and confirms each deletion page before advancing its cursor. An erasure
ledger is marked complete only after the full pass. Jobs become eligible for a
repeat sweep after 24 hours; the durable scan visits at most 100 completed jobs
per invocation, so a full scan of a large backlog can take longer than a day.
Sweeps of soft-deleted, erased and current live memories restart cleanup progress
to catch late obsolete provider writes. The done job's `available_at` records
the last confirmed completion. Monitor backlog size and the oldest completion
age rather than assuming a daily completion guarantee.
Restored memories and live leases are excluded. Explicit rebuilds also
reset progress without taking over a live lease. A manual failed-job retry keeps
its confirmed progress. Per-slice provider-call/time limits and a drain time budget
leave room for the rest of the scheduled pipeline.

Live memories also revisit obsolete vector references daily, retaining completed
chunk progress so cleanup does not repeat embedding calls. Migration 11 indexes
Space export history, memory creation ordering and recipient invitation pages.
Exports select a bounded page of target IDs before hydrating revisions; received
invitations use account-bound cursors and at most 100 rows per requested page.

Migration 18 adds `release_shares_space_created` on
`release_shares(space_id, created_at DESC, id DESC)` for bounded, newest-first
outbound share history. It preserves all existing grants and their timestamps.

Migration 12 rebuilds derived FTS content with retained, immutable row-ID mapping
and replaces the credential view's global membership materialization with exact
membership lookup. Source, versions, audit, membership and credential rows are
preserved. The FTS backfill runs once during migration; include its duration in
the staging rollout for the actual database size. Subsequent memory mutations
locate one FTS row through its indexed identifier.
Migration 13 applies the same exact-membership lookup to foundation key issuance
while retaining its validation, original membership/email binding and audit.

The current managed-AI candidate enables `BACKGROUND_JOBS_ENABLED=true` with
configured AI/Vectorize and ingestion keys; earlier staging live probes exercised
these providers. Keep `PAID_BILLING_ENABLED=false` and
`AUTO_ERASURE_ENABLED=false`. Explicit recently reauthenticated erasure remains
separate. The five-minute cron bounds provider work and maintenance; monitor
backlog and current episode age rather than assuming completion every five minutes.

`/ready` requires central 25/HOT 1, storage/provider/config checks, a recent
heartbeat, invite enrollment, metered AI budget and the signed acceptance record.
`LIVE_ACCEPTANCE_ID` alone is insufficient. The Ed25519 JWS binds all 15 required
gates to the exact source/config/schema, with a maximum seven-day lifetime.
A healthy cleanup heartbeat or liveness response does not perform those gates.
See [GA acceptance](release/GA_ACCEPTANCE.md).

Browser authentication failures return HTTP 400 with an `X-Auth-Failure` code such
as `AUTH_CALLBACK_VALIDATION`, `AUTH_FLOW_CLAIM`, `AUTH_TOKEN_EXCHANGE_403`,
`AUTH_TOKEN_RESPONSE`, `AUTH_TOKEN_VERIFICATION` or `AUTH_WORKSPACE_SIGN_IN`.
Record the fixed code and time when diagnosing a failed attempt. The optional
numeric suffix is an upstream HTTP status; it is not the callback response status.
Do not collect authorization codes, JWTs, cookies or full callback URLs. Request
logging remains disabled. The unsupported Workers redirect mode that caused the
observed login failure was corrected, and real-account SSO passed. MCP client
scope configuration is covered in [CONNECTING.md](CONNECTING.md).

## Creation and delegation recovery

Organization and Space creation POSTs are not idempotent. A transport failure,
unreadable successful response or mutation 5xx can follow a committed write. If
the outcome is uncertain, refresh `/v1/workspace` and inspect existing IDs, names, organization and
parent context before creating again. Do not automatically repeat the POST.
The root editor explains this uncertainty and asks users to copy needed drafts
before refreshing the page. Memory mutations with an operation ID retain their
existing same-operation retry behavior. Confirmed validation/authorization errors
and ordinary GET retry guidance remain separate.

In `/manage`, an edit completion clears only the draft it submitted. A newer
failed draft remains available for retry and same-account session recovery;
an older body-free receipt preserves its submitted copy separately.

A domain-delegation retry returns `200 {"completed":true}` for the exact same
live domain/membership pair. Every retry checks the current manager, target,
domain validity, browser session and recent email proof. It never revives a
revoked assignment or remaps it to a membership created after rejoining.

## Outbound share recovery

`GET /v1/spaces/:spaceId/shares` returns `{results,nextCursor}` for issued
grants, newest first by `createdAt` and then `id`. The `limit` defaults to 25
and must be an integer from 1 to 100. Continue with the returned opaque cursor;
it is bound to the requesting account and Space. Each row contains
`id,spaceId,recipientEmail,createdAt,expiresAt,acceptedAt,revokedAt`.

The list requires a current browser session with current update permission for
the Space. PATs and external OAuth bearers cannot use it. Listing does not
require a recent email proof. It includes grants issued by older browser
sessions and expired or revoked grants. The returned timestamps are retained
history and do not assert that the recipient currently has access.

Share creation with `POST /v1/spaces/:spaceId/shares` is not idempotent. If a
response is lost or a mutation 5xx leaves the outcome uncertain, do not
automatically repeat the POST. Refresh the outbound
list, inspect the original and any duplicate grants, and revoke unwanted grants
with `DELETE /v1/spaces/:spaceId/shares/:shareId`. Creation and revocation still
require current update permission and an email proof from the last five minutes.
The `/manage` console offers refresh, incremental pages and per-row revocation.
Confirmed revocation cannot be overwritten by an earlier list response. Until a
fresh read returns `revokedAt`, the UI shows confirmation without inventing a
timestamp; account and Space changes still invalidate old responses.
An uncertain DELETE response asks the user to inspect that ID's revocation
record; it does not claim that revocation failed or automatically create a grant.
After resolving an uncertain outcome, create another grant only if needed.

## Response checks and retained content

Trash rows expose `restoreUntil = deletedAt + current retentionDays * 86400000`
and `restoreExpired`, which becomes true at the cutoff itself. The default
Space policy is 30 days; a changed policy affects subsequent reads and restore
decisions. These fields describe retention, not write permission. Restore still
requires current update authority and the expected revision. An unchanged
tombstone at or beyond its cutoff returns `409 restore_expired`; a mismatched revision
returns `409 revision_conflict`.

Memory get/list/search responses check current read authority, the represented
revision, erasure and the requested live/trash state in their final primary
snapshot. Normal lists and searches also omit superseded facts. Exports retain
their historical snapshot revisions, while the final query checks current
export authority/session and suppresses erased sources. This final snapshot is
the response decision point. List/export cursors follow the raw candidate page:
continue a non-null `nextCursor` even when filtering leaves `results` empty.

Ingest detail and lists read current authority and state together, then check
expiry before returning. Approved and cancelled jobs keep those terminal states;
other jobs past their deadline report `expired`. Only an unexpired `review`
response contains proposals or source quotes. Approved, cancelled and expired
responses do not return earlier proposals.

## Deployment boundaries

This runbook covers the Standard memory Worker in `saas/`, deployed at `https://memory.allenlabs.org`. It remains a hosted pilot. Version-specific test results, Worker version IDs and acceptance results belong in the maintained release integration record.

## Historical production bootstrap record (rc.3; unchanged)

| Item | Confirmed state |
| --- | --- |
| Live domain | `https://memory.allenlabs.org` |
| Product / Worker deployment version | See [release/INTEGRATION.md](release/INTEGRATION.md) |
| Dedicated production D1 UUID | `a186c3b4-9092-4619-97b0-cda5b99d9b5d` |
| Remote migrations | All seven applied: identity, memory, product, auth, hierarchy, release and maintenance indexes |
| Cloudflare account | Approved personal account configured for this deployment |
| Central-auth live settings | Additive trusted-origin/resource update completed; 14 other bindings and existing auth domains preserved |
| Durable central-auth configuration | Source allowlists and generated types updated; full upstream CI passed |
| Validation / public HTTP | Version-specific local and CI results are in the integration record |
| Browser SSO | Real-account login/callback and authenticated workspace passed on 2026-09-09 |

The earlier remote D1 permission error was resolved for this deployment using authorized temporary credentials. The deployment used one-hour account tokens scoped to D1 Write, Workers Scripts Write, and Account Settings Read, plus zone permissions restricted to `allenlabs.org` for Zone Read and Workers Routes Write. All temporary deployment tokens were revoked after use.

Deployment and diagnostics used short-lived, account-scoped temporary credentials, all revoked after use. No credential was saved in this repository. Future remote maintenance requires a newly authorized credential; revoked deployment tokens are not reusable.

## Service and identity boundaries

| Purpose | Address or identifier |
| --- | --- |
| Service origin and OAuth resource/audience | `https://memory.allenlabs.org` |
| Browser callback | `https://memory.allenlabs.org/auth/callback` |
| MCP endpoint | `https://memory.allenlabs.org/mcp` |
| Protected-resource metadata | `https://memory.allenlabs.org/.well-known/oauth-protected-resource` |
| Existing central authentication UI | `https://auth.allen.company` |
| Existing OAuth issuer and API | `https://auth-api.allen.company` |
| Stable Worker/protocol service ID | `allenlabs-memory` |
| Dedicated production D1 database name / binding | `allenlabs-memory-production` / `DB` |

The identity platform intentionally keeps its existing `allen.company` domains. Do not migrate the issuer to a marketing domain. The separate legacy personal service at `https://memory.allenlim.net` and its database must remain intact; never bind this SaaS Worker to the legacy database.

The public OAuth client has already been registered through central dynamic client registration (DCR); its ID is recorded as `SSO_CLIENT_ID` in `wrangler.jsonc`. It uses authorization code with S256 PKCE, `token_endpoint_auth_method: none`, and the exact callback above. There is no client secret to invent, persist, or add to the Worker.

The central-auth operator has appended the service origin to live `TRUSTED_ORIGINS` and `https://memory.allenlabs.org` to live `OAUTH_PROTECTED_RESOURCES` with the intended `memory:read`, `memory:write`, and `memory:delete` resource scopes. This additive settings update preserved the existing `https://memory.allenlim.net` entries, 14 other bindings, and `auth-api.allen.company` / `auth.allen.company`. The durable private upstream main configuration and generated types are recorded above, with full CI passing. For future changes, preserve the provider's existing configuration format and entries; do not replace either allowlist with this service alone or publish the full private configuration. Browser redirect and issued-token audience checks remain part of live sign-in verification.

The current provider expires dynamically registered clients after 90 days of inactivity. Treat the DCR client as operationally maintained configuration, not a permanent registration. Before reviving an idle installation, verify that the client still exists. If it expired, register a new public client using the same callback/grants/scopes and update `SSO_CLIENT_ID`, or arrange a deliberately persistent registration with the central-auth operator. Do not repeatedly register duplicate clients on every deploy. Changing the client ID does not change the exact issuer/subject account mapping.

## Validate the release locally

Run these commands from the repository root using Node 24.19.0, or another version explicitly supported by `saas/package.json`:

```sh
cd saas
npm ci
npm run types
npm run check
npm run test:d1
```

`npm run types` runs `wrangler types worker-configuration.d.ts --strict-vars=false`; review generated binding changes. `npm run check` runs strict typechecking, baseline and release SQLite/auth/UI/HTTP suites, client templates and migration consistency. `npm run test:d1` builds and runs the Worker against local Miniflare/workerd and D1. It covers populated forward upgrades, conservative preservation of existing checkout attempts, customer-failure recovery, durable vector-cleanup progress, independent nested organizations, provisioning, PATs, memory operations, MCP, cleanup and native OAuth transport. Tests use synthetic local data; they do not verify live SSO, remote D1 permissions, DNS, or production readiness.

Additional existing scripts:

| Command | Purpose |
| --- | --- |
| `npm run build` | Bundle dry run into `.local/build`; does not deploy |
| `npm run db:local` | Apply numbered migrations to local Wrangler D1 |
| `npm run dev:console` | Ephemeral console at `http://127.0.0.1:8792`, with a synthetic 15-minute session |
| `npm run dev` | Separate legacy foundation demo at `http://127.0.0.1:8790` |
| `npm run migrations:check` | Verify schema/migration consistency and exact frozen baseline hashes |

The console/demo modules are local-only and are not Worker entry points. Never copy their synthetic sessions or bootstrap users into hosted storage.

## Bootstrap reference and subsequent deployments

Initial bootstrap is complete. Do not recreate `allenlabs-memory-production`, replace its UUID, or rerun database creation for this live installation. Its current `DB` binding must remain `a186c3b4-9092-4619-97b0-cda5b99d9b5d`. Never substitute the legacy personal-service database.

For reference, bootstrap created a dedicated D1 database, recorded the returned UUID in `wrangler.jsonc`, verified the account/custom domain, and applied all four initial migrations before deployment. A separately approved new environment needs its own distinct database name, UUID, and bindings; `npx wrangler d1 create <new-database-name>` is the CLI creation path for such an environment. Do not use it to recreate the existing production database. [Cloudflare D1 command reference](https://developers.cloudflare.com/d1/wrangler-commands/).

For subsequent releases, obtain fresh authorized credentials scoped to the intended personal account and exact zone. Complete the local validation above, review any forward migrations, and verify the existing `DB` UUID before a remote change. Preserve `database_name: allenlabs-memory-production`, `migrations_dir: migrations`, `PUBLIC_ORIGIN`, the registered `SSO_CLIENT_ID`, and the exact custom-domain route. Keep `workers_dev: false`, `preview_urls: false`, and `observability.enabled: false`.

```sh
npm run types
npm run preflight
npm run db:remote
npm run deploy
```

These argument-free commands target production. For staging, pass
`-- --config .\wrangler.staging.jsonc` to preflight, build, db:remote and deploy.
`preflight` validates local configuration without proving remote readiness.
`db:remote` applies every registered active/draining HOT migration first, then
central DB migrations. `deploy` requires a clean source and runs check/preflight;
it does not apply migrations or run native/live acceptance. Stop on any failure
and inspect which databases and versions were applied before retrying.

Production has only migrations 1–7 applied; staging has 1–23. Current source requires all central migrations through 25 and HOT 1. `migrations:check` verifies their frozen SHA-256 hashes, and `.gitattributes` pins SQL files to LF. To add a forward migration, register its source in `scripts/migrations.mjs`; `migrations:sync` can create the missing new file but refuses to rewrite an existing migration. Never edit an applied file to change production schema. Apply a required migration before deploying code that queries its new tables. Never roll back to a writer that ignores release capability policies. Revoke temporary maintenance tokens after use and verify cleanup.

Real-account sign-in passed after the Workers redirect fix, including approval, callback and authenticated Space loading. No security protections were disabled. If login fails again, collect only the fixed failure stage and time, never real callback codes.

For each rollout record the deployment version, migration state, test time and observed results. Validate public liveness, authentication/discovery and affected authenticated workflows. Earlier staging has live PAT/official SDK, AI and organizational workflow evidence. Actual mail proof, central lifecycle rollout, load/recovery and final-revision acceptance remain separate gates. Do not infer those outcomes from consent, local tests or liveness alone.

## Daily operation and security

`GET /health` reports process liveness and version. It performs no D1 query, provider verification, or authenticated operation and is not a readiness check. Investigate login failures, database errors, and application denials independently of a healthy liveness response.

The `REQUEST_LIMITER` binding currently allows 120 calls per 60 seconds per key at a Cloudflare location. Application keys separate auth/pre-auth IP controls and authenticated account controls. These counters are eventually consistent and local to a point of presence; they are not a global billing quota or exact accounting system. A 429 response includes `Retry-After: 60`. [Cloudflare rate-limit behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Keep Worker invocation/request logging disabled: OAuth callback query strings contain authorization codes. Do not enable broad `wrangler tail`, URL/header capture, tracing, or request-body logging for a login incident. Never log cookies, authorization headers, raw provider tokens, invitation/key secrets, or memory bodies. Use sanitized status counts, request IDs, and identifier-only audit records. Current raw provider bearer tokens are verified in memory and stored only as SHA-256 digests; opaque browser sessions and machine keys also persist digest-only. Keep Cloudflare credentials in their approved credential store, outside repository files and diagnostics.

Browser cookies are Secure, HttpOnly, and SameSite=Lax. Sessions last at most 15 minutes and never beyond the verified provider token expiry. The provider supplies no `auth_time`; callback time and refresh must not substitute for recent proof. The session initially has `reauthenticated_at=NULL`. A one-use email proof bound to that session establishes a five-minute recent-reauthentication window for sensitive operations. Cloudflare Email receipt remains a separate live acceptance check.

The editor temporarily retains an unsaved draft in the open page when a session expires. Reconnection and write retries verify the original account and current write access to the original Space; optimistic revision checks still apply. This is ephemeral page memory, not localStorage, sessionStorage, or a durable draft service. Reloading or closing the page loses the draft. Explicit logout or reconnection under another account clears it.

Organizations may nest with no fixed product depth cap; SQLite tests exercise 128 child levels. Each organization's membership and memory permissions remain independent. Only a current owner/admin of the immediate parent may create a child, and the creator becomes its owner through their selected live email claim. Parent/child relationships grant no authority and do not extend key scope or revocation cascades. The parent is immutable after creation; no move, delete, or reparent workflow exists. Workspace snapshots disclose parent IDs only when the caller also has current explicit parent membership.

Machine keys are shown once and expire after 1–90 days. Revoke an exposed key by identifier, then issue a replacement. Organization keys remain bound to the exact membership/email claim; removing that authority cascades revocation. Do not clear `revoked_at`, rewrite a claim binding, or restore an expired/revoked external bearer credential to resolve an access complaint. Investigate current account, organization, claim, membership, credential expiry, and role first.

Display-only changes use `PRODUCT_NAME`, `PRODUCT_SHORT_NAME`, `PRODUCT_DESCRIPTION`, `PRODUCT_SUPPORT_EMAIL`, and `PRODUCT_ACCENT_COLOR`; run the validation/build commands before redeploying. Future trademark changes must leave `SERVICE_ID`, MCP tool names, stored IDs, account mappings, and credential bindings unchanged. Treat `PUBLIC_ORIGIN`, issuer, OAuth audience/callback, and client registration as separate infrastructure contracts.

## Backups and recovery

D1 Time Travel is automatic on the production storage backend. Its recovery window is 7 days on Workers Free and 30 days on Workers Paid. Verify the actual plan and database backend, and record a bookmark before a significant migration. Restores overwrite the database in place and cancel in-flight queries. [Cloudflare Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/).

```sh
npx wrangler d1 info allenlabs-memory-production
npx wrangler d1 time-travel info allenlabs-memory-production
```

This database contains both memory and authorization history. An earlier restore can make revoked keys, memberships, and email claims live again, remove later email blocks, and reopen consumed invitations or OAuth flows. Restoring content therefore requires an access-recovery plan:

1. Put the service behind an emergency traffic block/maintenance deployment that refuses browser, REST, MCP, and auth routes. There is no built-in maintenance switch; establish and verify the edge block before restoration.
2. Preserve the current bookmark and the post-restore-point revocation/disablement and consumed-proof evidence in an access-controlled incident record. If required evidence cannot be recovered, keep access closed.
3. Confirm the exact dedicated database UUID and approved restore point. Run the documented Time Travel restore only under that incident plan; retain its returned undo bookmark.
4. Reapply or reconcile revoked/disabled accounts, organizations, claims, memberships, keys, email blocks, and consumed invitations. Invalidate restored sessions and pending OAuth/email proofs as appropriate. Never reopen using the restored authorization snapshot alone.
5. Validate schema/migration compatibility, fresh login, tenant isolation, and known revoked-key/member denial while public traffic remains blocked. Reopen only after reconciliation and verification are recorded.

User memory exports are bounded snapshots, not database backups or complete
account exports. Sharded recovery also needs immutable R2 payloads, all active/
draining HOT metadata and tombstones, and post-snapshot revocation/erasure evidence.
The actual provider rejected full D1 export because of FTS virtual tables.
The explicit regular-table exporter with separate DDL/FTS reconstruction is under
native verification; this is not yet a successful remote recovery drill.
Follow [multi-store recovery](release/MULTI_STORE_RECOVERY.md). A Time Travel
window is not a permanent archive or an atomic cross-store snapshot.

## Current release limits

Normal deletion creates a tombstone. Recently reauthenticated explicit erasure removes individual memory payload/history while retaining identifier/audit records; automatic retention erasure is implemented but disabled in the pilot. Backups and complete account deletion are outside that erasure operation. See [release/OPERATIONS.ko.md](release/OPERATIONS.ko.md) for the data lifecycle.

Physical HOT D1 sharding, canonical private R2 payloads, pooled accounting, FTS5,
AI/Vectorize retrieval, reviewed ingestion, export and sharing are implemented.
Managed memory remains service-readable; Zero-Access is unavailable. The central
metadata DB and each HOT DB remain finite. See [SCALING.md](SCALING.md).

The registry allows at most 16 active/draining entries and preserves existing
payload placement. Draining stops new placement; it does not migrate existing
objects. Keep referenced bindings until an independently verified migration
removes their references. Inline conversion is opt-in with
`STORAGE_BACKFILL_ENABLED=true`, bounded to one current and one history candidate
per invocation. It preserves logical charges and exact content/revision.
Private R2 keeps canonical current/history payloads; historical HOT copies retire
through durable outboxes. Erasure receipts confirm central access removal,
not completed external cleanup.

Invite enrollment and provider reservations are separate from user quotas.
Production AI reservation cap is $20/month and staging $0.20/month. Memory's
overall $50/month Cloudflare target needs separate actual billing, capacity and
alert response; this AI cap cannot enforce every infrastructure charge. Paid
billing stays excluded. Mail proof, lifecycle live rollout, load, alerts and
isolated provider recovery remain acceptance work.

The public/private lifecycle implementation and native two-Worker test cover
9 immutable events and 11 delivery attempts, including false/lost acknowledgments
and resume. The central publisher is not deployed. Its eventual-delivery target
is under two minutes and must be measured with oldest pending age. Account
suspension revokes old authority; resume requires fresh SSO and does not restore
old credentials or organization memberships. Exact-email re-verification permits
a new verified claim, not old ACL revival. Verified signed lifecycle heads apply
before new claims so delayed delivery does not revoke post-transition ownership.
Account deletion and existing v1 permanent blocks remain terminal.
Outgoing personal shares are unavailable while their owning account is suspended.
An explicit resume may make those retained grants usable again; it does not
restore revoked recipient email claims, old sessions/PATs or organization
memberships. Organization content remains governed by that organization's current
authority rather than the former writer's personal lifecycle.

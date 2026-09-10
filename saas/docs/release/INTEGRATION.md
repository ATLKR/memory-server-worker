# Integrated release candidate: 0.4.0-rc.4

This is the maintained integration record. Other files in this folder originated
in the supplied release kit and describe its proposed design and launch work.
They are reference material, not an instruction to activate payments, send mail,
erase data, or certify GA. Their original test counts are historical.

Source archive: `memory-worker-pr22-release-candidate-0.4.0-rc.1.zip`.
SHA-256: `18e0155b8362d285867fbbb34f0db3a88208de20b4e91801924bbd0bbd671d69`.
It targeted commit `b94c434f2074ea975111cb4e3efd4371a9481ac1`; its 91 manifest
entries verified. This proves archive consistency, not publisher identity.
The integration retains the repository's MIT license and attribution.

## PR #22 follow-up review

Additional source corrections and independent fresh-agent review rounds are
tracked in [REVIEW_LOOP.md](REVIEW_LOOP.md). These PR changes are separate from
the recorded rc.3 deployment below; a code review is not a deployment record.
The rc.4 source requires forward migrations `0008_checkout-schema.sql`,
`0009_job-progress-schema.sql`, `0010_protocol-schema.sql`,
`0011_pagination-schema.sql`, `0012_lookup-schema.sql`,
`0013_key-lookup-schema.sql`, `0014_tenant-queue-schema.sql`,
`0015_workspace-lookup-schema.sql`, `0016_retrieval-progress-schema.sql`,
`0017_vector-reconciliation-schema.sql`, `0018_outbound-share-schema.sql`,
`0019_execution-time-schema.sql`, `0020_domain-verification-schema.sql` and
`0021_domain-retention-schema.sql` before
deployment. It preserves existing checkout records conservatively and freezes
retry parameters once Checkout may have been attempted. Indexing/vector cleanup
checkpoints let bounded work continue across invocations while retaining erasure
identifiers. Confirmed checkout-closure receipts prevent duplicate purchases while
payment events are queued; SCIM deletion tombstones preserve internal history.
Migration 16 adds per-Space operational lookup and durable confirmation of accepted
asynchronous vector deletions. Migration 17 adds bounded retries for pending
deletion pages when older upserts finish late. Migration 18 indexes retained
outbound shares by Space and newest creation time for bounded recovery lists.
Migration 19 and the SQL helpers use the later of the application-bound time and
database execution time for deadline admission. A queued statement cannot use an
expired credential, membership, recent proof, restoration window, ingest lifetime
or lease to authorize a later mutation. Historical timestamps and immutable
records remain intact. Proof consumption and the corresponding credential's
reauthentication timestamp update execute atomically through one statement and
its triggers. Migration 20 atomically records DNS verification, consumes its
challenge, creates or renews the domain, and assigns the exact manager. A replay
checks the same account's current session, recent proof, original live membership,
nonrevoked manager assignment and domain/receipt validity; it returns the original
`verifiedUntil` without DNS or an extension. Accepted provider email revocation
invalidates pending proofs for that exact account/address, and standing blocks
deny further issuance or consumption. The migration backfills only unused,
not-yet-invalidated blocked proofs at database execution time. Migration 21
indexes unused DNS proof expiry for cleanup of at most 100 unused expired
challenges per invocation; consumed proofs and immutable receipts remain.
The candidate readiness check now requires schema 21.
Migrations 8–21 are currently PR-only; production
still has migrations 1–7 and the rc.3 Worker.

The current UI keeps pending one-time issuance dialogs open until their outcome
is available, preserves account/Space-bound drafts and receipts, and reconciles
approved/cancelled extraction cards even when a refresh replaces the original
card. Mutation transport/body-read failures and 5xx responses are treated as
uncertain outcomes: organization/Space creation asks for workspace inspection,
and sharing offers retained outgoing history and revocation before another POST.
Expired trash uses server retention metadata to disable Restore and explain
`restore_expired`. Release search accepts valid queries up to 1,024 UTF-8 bytes
with the existing 31-character term limit; the foundation input retains 256
characters. Both support links encode mailbox contents while preserving the
literal `@` separator and configured spelling.
Edit completion owns only its submitted draft: a newer failed draft survives an
older response, and an older receipt-only submission is retained separately.
Confirmed share revocations survive delayed list snapshots without inventing a
revocation timestamp; a fresh read can supply the stored `revokedAt`.
SCIM, export and billing-portal issuance buttons stay locked while a request is
pending; intentional later issuances retain their own receipts.

The full local check on 2026-09-10 passed 1,410 tests:
208 foundation, 1,196 release and six client/template tests. Strict typechecking,
all 21 migration source comparisons and the seven frozen production hashes also
passed. `npm audit --audit-level=low` reported zero vulnerabilities. The final
native run passed the build and bundled workerd/D1 checks, including populated
upgrades from schema 5 through migration 21, encoded PAT revocation and job retries, checkout recovery, SCIM
qualified deactivation/deletion/projection/pagination, account-bound invitation
pages, lost-response outbound grant recovery across browser sessions and resumable
cleanup of 1,001 vector references.
Lookup migrations preserve identity, source, history and audit rows, retain stable
FTS mapping and preserve exact foundation-key membership/email bindings.
Native checks also cover all eight configured job-claim candidate branches,
the 31-code-point search-prefix boundary, identical fullwidth/ligature/private-use
and combining-mark words, 11 pages of accepted asynchronous vector deletions,
and durable re-deletion after a late upsert without losing the propagation window
or prior failure count across worker restarts.
It also passed 20 Unicode exact-body search cases and OR-separator punctuation
controls after the final Unicode correction.
The final MCP response check suppresses buffered memory when membership expires
or is revoked, and a superseding write checks all three required actions without
exceeding native D1's query-depth limit. Seven native authentication/HTTP runtime
tests passed in that native run. Six native queued-expiry cases also passed for
credential, membership, recent proof, retention, ingest and lease admission.
Ten native domain checks passed for atomic verification, current-authority replay,
queued expiry, rollback, provider proof revocation and bounded cleanup that
retains consumed DNS proofs and immutable receipts.
Eight native interleavings additionally commit erasure, cancellation
or approval immediately before the final REST content/state snapshot. Native
checks preserve empty-page cursor progress, distinguish expired restoration from
a true revision conflict, and reflect a changed retention policy. The latest
51-case lexical evaluation returns recall@5 0.62 and MRR@5 0.59,
with zero forbidden or stale hits and one negative-query false positive. Its
32.6078 ms p95 was measured while other checks were running; it is not a benchmark.
The
tenant-local ranking change lowers MRR by 0.01 against the preceding implementation
on this small fixture. These are local results; independent
follow-up review and the exact final revision's CI are recorded separately in
[REVIEW_LOOP.md](REVIEW_LOOP.md) and the PR.

## Recorded 0.4.0-rc.3 deployment: 2026-09-09

[The rc.3 corrections](RC3_FIXES.md) are deployed from runtime commit
`d44a13ad90248305b2c46b5e0d6a30e85d1aeace`, Worker version
`4454c391-5587-4835-a15c-c73926644724`. No new migration or provider configuration
was required. The seven deployed migration hashes remain unchanged.

Local verification passes 349 baseline/release/client tests and seven native
workerd auth/HTTP tests, plus the expanded bundled Worker/D1 integration. All four
workflows pass for the runtime commit. Live HTTPS confirms rc.3, maintenance
heartbeat, separate MCP/SCIM authentication challenges and SCIM error formatting.
Real-account SSO again reaches the console. A synthetic invalid email proof
produces a proof error while preserving the session; subsequent workspace
refresh succeeds. No email was sent or PAT issued for that negative test.

## 0.4.0-rc.2 source changes

This update configures a five-minute cron for bounded expiry cleanup. The new
index-only `0007_maintenance-schema.sql` supports expired ingest payload, export,
domain/reauthentication challenge and mail-budget cleanup. Each category is
limited to 100 rows per invocation; request-time expiry checks remain authoritative
while a backlog is cleared. All seven deployed migrations now have frozen byte hashes.

`BACKGROUND_JOBS_ENABLED=false` separates this cleanup from AI, vector, ingestion
and billing processing. `AUTO_ERASURE_ENABLED=false` continues to preserve retained
memory bodies and history. The UI disables unavailable ingestion, index rebuild,
billing and proof-mail controls based on server configuration. The ingestion and
index-rebuild APIs reject disabled processing rather than accepting unusable work.
The maintenance heartbeat window is 15 minutes for the five-minute schedule;
`/ready` still requires all provider and operator-acceptance checks.

Codex and Claude SSO templates explicitly request identity and memory read/write/
delete scopes, avoiding a connection that unexpectedly has only read access.
See [CONNECTING.md](../CONNECTING.md) for reauthentication and read-only options.
Browser authentication failures now return a fixed phase code and, when available,
an upstream HTTP status, without provider bodies, tokens, cookies or callback
parameters. Actual workerd reproduced the failure before any outbound token
request: `redirect: 'error'` is unsupported. Token, JWKS and provider HTTP requests
now use manual redirects and explicitly reject 3xx. Native runtime tests verify
PKCE exchange, signature validation, session issuance and refusal to forward
credentials to a redirect target. Real-account login passed after deployment.

The legacy root dependency tree also uses patched sharp 0.35.4 and Vitest 4.1.11.
Its local full audit reports zero vulnerabilities, and the existing 208 tests,
typechecks, Worker/UI builds, generated types and deterministic plugin archive
checks pass. Runtime dependencies and the legacy service version are unchanged.
See the [sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
and [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).

## Recorded 0.4.0-rc.2 deployment: 2026-09-09

Runtime commit `34d55c46977dec357369b710d39547d77f1cec71` is deployed as Worker
version `2caf8509-de0e-48af-9e5a-10d60b3c6f6b`. The index-only migration 7 is
applied to the existing dedicated D1; all seven migration hashes are frozen.
Migration 7 SHA-256: `f31ebfb8bd1e811e9c2582cc1e08433444d99b22e61775d66469f94dbbb1fec9`.
The pre-migration-7 bookmark is
`0000000f-00000000-000050e1-e7d77f3a4c41f4ea234df1659abff6e8`.

Real-account browser acceptance passed: existing central SSO, approval, token
exchange and signature verification completed, then the authenticated management
console loaded the personal Space and verified email. No security protections
were disabled. Mail delivery and real-client PAT/SSO connection acceptance remain
separate checks.

Public HTTPS checks passed: rc.2 liveness and management return 200; unauthenticated
REST/MCP return 401; discovery uses the central issuer. Cleanup cron is deployed
every five minutes with both provider-processing and automatic-erasure switches
false. `/ready` remains 503 for the inactive provider and launch requirements.
All four workflows passed for the runtime commit: SaaS push/PR, legacy CI, CodeQL.

## Recorded 0.4.0-rc.1 deployment: 2026-09-09

Release `0.4.0-rc.1` is deployed at `https://memory.allenlabs.org` from runtime
commit `ca249c3bfdae1ab15f934717de4c7dd2e29adc30`, Worker version
`8637303b-2899-4145-a1df-c71208e909f1`. Migration 6 is applied and its bytes are
now frozen by the migration checker. Public HTTPS checks pass for the management
page/assets, liveness, protected REST/MCP rejection, OAuth discovery and PKCE
redirection. Schema, SSO and native Email binding configuration checks are true.
Actual user callback completion and email receipt are still unverified.

The pre-migration-6 D1 Time Travel bookmark is
`0000000b-00000000-000050e1-2780da49ab84ab9bfffe1cbe5c0df3ab`.
It is a recovery reference within the provider retention window, not permission
to overwrite live data; restore and reconcile separately before considering a cutover.

## Available in the pilot

- Atomic memory operation IDs and usage receipts, optimistic revisions, memory
  kinds, provenance and explicit supersession. Supersession requires update
  authority as well as create authority.
- Exact Space and read/create/update/delete/export key policies. Organization
  permissions remain independent at every nesting depth.
- FTS5 prefix search, trash listing/restoration, snapshot exports and explicit
  verified-email read sharing. Permanent erasure requires recent proof and an
  exact memory-ID confirmation; backup expiry is a separate matter.
- Monthly pooled usage and retained-content byte accounting. The pilot defaults
  to 1,000 units/month and 100 MiB content per personal account or organization.
  These are application limits, not the size of the physical database.
- A Korean `/manage` console alongside the original editor. Product branding is
  configurable; stable service ID, MCP tool names and authentication stay fixed.
- The existing SDK 2 transport, with 2025 protocol compatibility and the current
  protocol. Existing `memoryId` arguments remain supported. MCP mutations require
  an operationId; REST callers should supply one for retry safety.

## Implemented adapters that are not activated by default

AI + Vectorize provide hybrid retrieval and encrypted transient-source extraction
followed by human review. Mail provides email proofs and recent reauthentication.
Signed identity webhooks and exact-membership SCIM keys support deprovisioning.
Stripe supports Checkout, Portal and signed webhook reconciliation. Each requires
real provider configuration and end-to-end acceptance; absent configuration fails
closed. Following the user's explicit choice, mail now uses the native Cloudflare
Email Service binding and the existing verified `allenlabs.org` sending domain,
with sender `memory@allenlabs.org`. Resend is removed. Provider errors/timeouts
invalidate pending proof; delivery is not automatically retried. See [EMAIL.md](EMAIL.md).

The recorded rc.1 deployment had no cron schedule. The rc.2 source adds cleanup
without enabling provider jobs or automatic memory erasure, as described above.
An explicit erase request remains a separate interactive operation. Before
enabling provider processing, configure/test providers, backlog capacity,
retention, deletion and recovery behavior. `/ready` intentionally returns 503 until
the full readiness requirements are met; `/health` is a separate liveness endpoint.

## Corrections made during rc.1 integration

Actual six-schema tests reproduce and prevent create-only supersession, repeated
unmetered embedding calls, stale jobs deleting newer vectors, hidden current
vector candidates, lost write receipts after deletion, and source disclosure to
AI after detected credential revocation. Search operation replay returns fresh
lexical results with `semantic_skipped_on_replay`, without another provider call.

SCIM keys and outbound organization shares bind the original membership/email
permanently. SCIM cannot remove the last owner; share invitations and reads check
the grantor's original membership. Normal grantor logout does not terminate
durable sharing. Provider disablement resolves identity mapping in the same atomic
batch; email-only revocation preserves personal login without recreating the
blocked claim. Stripe retries retain the persisted request expiry.

The management console fences late results by account/Space/action, clears secrets
immediately on logout/clear, and preserves drafts per Space. The real SDK replaces
the kit's handwritten MCP envelope. Crypto types are compatible with TypeScript 7.

The release test fixture now loads the actual migrations 1–5, including their
immutable and revocation triggers. Existing remote migration bytes remain frozen;
all changes use migration 6. The bundled workerd test applies it to populated D1
and checks old revisions, FTS backfill, current ACLs and atomic writes.
The harness also exercises the installed Wrangler statement splitter. Its local
path misparsed a compact `+CASE` expression; adding whitespace reproduced and
resolved that separate issue. Remote migrations send the whole script to D1's
REST parser, where an isolated database reproduced `incomplete input` for the
unparenthesized `CASE` in `release_operation_budget`. All five unparenthesized
trigger `CASE` expressions are now enclosed in parentheses without changing their
SQL semantics, following the [reported workaround](https://github.com/cloudflare/workers-sdk/issues/4727).
Both failed production attempts rolled back migration 6 completely; the existing
five migrations and production Worker remained intact.
The corrected whole script subsequently passed on an isolated remote D1 database,
including final-schema and foreign-key checks; that temporary database was removed.
Email timeout tests wait for the actual provider invocation before advancing
their fake clock, avoiding a platform-dependent event-loop race.

The development-only `sharp` dependency is overridden to the maintainer's patched
0.35.4; the resulting npm audit reports no vulnerabilities. It is not bundled in
the production Worker. [Maintainer advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).

## Verification and remaining limits

Run `npm run check`, `npm run test:d1`, and `npm run eval:lexical` from `saas`.
The recorded rc.1 local check covered 171 existing tests, 143 release tests and
five client/template tests, plus typechecking and migration source/hash consistency.
The rc.2 source added maintenance, disabled-feature, callback-diagnostic and
client-scope regressions. Its historical local checks passed: 174 baseline, 151 release and six
client/template tests, plus seven native authentication/HTTP runtime tests and
the populated workerd/D1 scheduled-cleanup integration test.
The evaluation loads the supplied synthetic corpus through the real memory APIs.
That historical 51-case evaluation returned recall@5 0.62, MRR@5 0.60, forbidden hits 0,
stale hits 0, and one negative query with irrelevant results. This measures lexical
retrieval, not semantic quality; local latency excludes the network.

PAT and OAuth both authenticate MCP and compatible clients/plugins. PATs can be
restricted to named Spaces and capabilities; SSO uses the existing Better Auth
provider under `allen.company`. External OAuth clients have independent client IDs
and are verified against the service resource, while browser callbacks retain the
exact configured browser client binding. See [CONNECTING.md](../CONNECTING.md).

Real-user OAuth callback completion passed after the rc.2 transport fix and again
on rc.3. Live Stripe/mail/AI/webhook integration, external MCP clients, load testing
and recovery drills remain outstanding. The service is a pilot, not GA.

Storage still uses one D1 database. This kit does not implement R2 offload or
physical sharding; the per-database 10 GB limit still applies. See
[SCALING.md](../SCALING.md) for the proposed design and consistency constraints.
Never roll back to a writer that ignores new capability policies. Recover with a
compatible forward fix or a separately restored and reconciled environment.

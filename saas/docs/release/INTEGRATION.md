# Current candidate: 0.5.0-rc.1

## Migration record — 2026-09-10 15:20 UTC

Production central schema 25 and both HOT schemas 1 were confirmed at
15:20:12.568 UTC. HOT02 convergence was confirmed at 15:18:37.785 UTC; its
original uncertain operation remains intact, and the new receipt explicitly
records a supplemental attempt with unknown original-versus-supplemental
attribution. The exact schemas and unchanged unrelated resources were observed
before continuing central migrations.

The active production Worker at this checkpoint remains
`4454c391-5587-4835-a15c-c73926644724` (0.4.0-rc.3). The new Worker rollout and
production identity-publisher activation are still pending. Migration success
alone does not establish deployed code, runtime guards or live acceptance.

## Rollout checkpoint — 2026-09-10 15:18 UTC

The staging and issuer evidence in the 15:07 record below is confirmed. At this
checkpoint, production still serves Worker version
`4454c391-5587-4835-a15c-c73926644724` (0.4.0-rc.3), with central migrations 1–7.
HOT01 migration 0001 is confirmed. HOT02 has an unresolved original attempt;
a separately journaled, guarded convergence attempt is in progress. An unchanged
read-only observation does not prove the original request was never dispatched.
Neither the new production Worker nor production identity delivery is confirmed.
Later receipts must establish the resulting schema, exact Worker source/version,
permanent guards, schedule and actual protocol checks before this status changes.

The default support contact remains `allenlim@allenlabs.org`; routing a different
support address is separate from the temporary synthetic mailbox test. Human
browser SSO on the final source, complete cost coverage, alert-response and
operational-policy acceptance remain open. This checkpoint grants no GA approval.

## Validation record — 2026-09-10 15:07 UTC

Staging remains source `f1cb578642e79059731f9249ecdec261e53e8e64`,
Worker version `7efa79bf-9fb4-4e67-9c0a-f6ef6ba9a28b`, central schema 25
and both HOT schemas 1. Its fresh bounded acceptance run completed 14 core
checks plus two actual console CSP/asset checks, three physical-storage checks
and 48 authenticated read requests with zero errors (p95 774 ms, max 1,261 ms).
The two reviewed-ingestion checks are explicitly inherited from `2741623`;
the exact two-file CSP-only difference was checked. They are not new AI calls
on `f1cb578`. The additional provider reservation was $0.0024.

The actual central identity publisher now runs private source
`55908368f5191881f6b0c0125ef5af63fcdbf971`, Worker version
`bbb66ddb-73bb-4cd2-8fe4-297f44627791`, with migration 0010 and a one-minute
schedule. Its configured destination at this checkpoint is staging. A fresh
synthetic live run `42ec5d080186254b07f8523e` covered signed JWT/JWKS admission, the real OAuth consent
and callback protocol, six ordered identity events, delayed/retried delivery,
revocation/resume and terminal cleanup. Both synthetic subjects and their
authority were removed. This proves the issuer protocol, not a human browser
sign-in. Native final-source tests separately recorded nine events and eleven
deliveries across two Worker/D1 instances.

The synthetic mail run `d9ad0b006010bb5e6004d42a3ad0cd3c` received an actual
email for the final staging revision and consumed its proof using
the session that requested it. Another session and a repeated consumption
both returned 403. The first cleanup observation was incomplete; a separate
read-only reconciliation and bounded cleanup subsequently confirmed the exact
temporary receiver, route, encrypted receipt and private bucket absent, the
fixture authority disabled, and all temporary API tokens revoked. The private
composite proof retains the original incomplete result and hashes the later
cleanup evidence instead of rewriting the first result. The composite is
`independent-proof-and-teardown.json`: proof checks and final teardown passed,
the original completion remains false, and `realHumanSso` remains false. A previous attempt
failed with `routing_unknown_address` and remains recorded as a failure.

Production rollout, isolated recovery, operational alert response and complete
cost/policy acceptance remain separate work. No GA approval is claimed by
these synthetic checks. Later deployment records must identify their actual
versions and confirmation times.

## Deployment record — 2026-09-10 14:09 UTC

This dated record identifies the observed runtime. A later documentation commit
does not change that deployed source or extend its acceptance evidence. Private
deployment receipts retain the source, module/configuration checks and provider
observations; verify a fresh receipt before another rollout.

| Scope | Confirmed state at this checkpoint |
| --- | --- |
| Staging source | `f1cb578642e79059731f9249ecdec261e53e8e64` |
| Staging Worker version | `7efa79bf-9fb4-4e67-9c0a-f6ef6ba9a28b`; update confirmed by read-only reconciliation at 14:09 UTC |
| Staging schema and schedule | Central migrations 1–25; both HOT databases on schema 1; one-minute cron |
| Production | Recorded deployment remains 0.4.0-rc.3 with central migrations 1–7; candidate rollout pending |
| Central identity publisher | Actual rollout and end-to-end acceptance remain pending in this record |
| Final acceptance | The new staging source's live validation is in progress; no completed GA acceptance is claimed |

On the previous source `2741623e633407756902547e9d57c50507b00326`,
16 functional checks and three physical-storage checks passed, together with a
bounded 48-request load sample. These results belong to that source and are
historical evidence, not final acceptance of `f1cb578`. The new source changes
the `/manage` content security policy; its deployment confirmation alone does
not complete the [15 acceptance gates](GA_ACCEPTANCE.md).

Actual mail receipt and proof consumption on `1a93820`, and the separate
`141f65f` observations below, likewise retain their original scope. Issuer and
production rollout results must be recorded after their actual verification.
Final-source cost, alert-response, policy and isolated-recovery evidence remain
required before GA promotion. Review conclusions apply only to their recorded
source and scope; see [REVIEW_LOOP.md](REVIEW_LOOP.md).

## Historical source and deployment checkpoint — 2026-09-10 handoff

The following checkpoint is preserved as recorded at handoff. Its references to
current source, undeployed changes, pending reviews and verification describe
that checkpoint, not the later deployment record above.

| Scope | Recorded state |
| --- | --- |
| Current source | 0.5.0-rc.1; central migrations 1–25; HOT schema 1 |
| Production | Unchanged 0.4.0-rc.3; central migrations 1–7 |
| Staging | Revision `141f65f`; central migrations 1–25; two HOT databases on schema 1 |
| Not deployed | Current post-staging fixes and one-minute schedule; central private lifecycle publisher |

Every remaining migration is required before deploying the current Worker:
production needs 8–25; staging already has all 25. Each HOT uses
`shard-migrations/0001_payloads.sql`. No current full-suite total is claimed
until the combined rerun finishes. Historical counts below belong to rc.4.

The candidate implements physical data-only D1 sharding and private R2 canonical
current/history payloads, with central authority, immutable pointers, exact
logical sizes, receipts and durable preparation/cleanup. The registry allows
up to 16 active/draining shards and preserves stored placement. Draining does
not move old data automatically. Inline backfill is opt-in and bounded.
The central metadata DB and every HOT remain finite.

Earlier staging live evidence covers real SSO, scoped PATs, the official MCP SDK,
AI retrieval/reviewed extraction, ten-level independent organization ACLs,
CRUD/restore/erasure and metering. One Space wrote across two physical HOT DBs
and hydrated private R2 payloads. These results apply to that earlier deployment,
not automatically to the latest candidate. On `1a93820`, a native Cloudflare Email
message was actually received and its proof consumed in the original SSO session.
The temporary receiver and its resources were removed afterwards.

On `141f65f`, 17 synthetic live checks passed, including REST/PAT/official MCP,
independent organization ACLs, R2 hydration, quota denial, actual grounded AI
extraction, approval replay, sharing/export/trash/restore and erasure. Direct
provider reads confirmed 11 current R2/HOT heads across both databases, 11 indexed
heads and absence of the erased vector. Vectorize REST visibility lagged its
binding confirmation; physical success was recorded only after a fresh read
observed absence. Final additional conservative AI reservations were $0.0328.
A bounded 48-request authenticated R2 read sample at concurrency four recorded
p50 660 ms, p95 967 ms and max 1,178 ms with zero errors. This is a finite pilot
sample, not a maximum-capacity or sustained-uptime result.

The five-minute deployed schedule delayed one queued extraction past its creator
session's expiry. It correctly refused provider disclosure; cancellation and one
new submission with a fresh credential passed. The next source configuration uses
a one-minute schedule with the same bounded work per invocation. Queue age and
credential expiry still require monitoring; cadence is not a throughput guarantee.

Public/private ordered identity lifecycle and signed JWT lifecycle heads are
implemented. Native two-Worker/D1 tests recorded 9 immutable events and 11 delivery
attempts, including false/lost acknowledgment, suspension/resume and delayed
positive-event delivery without losing a fresh owner. The central publisher
has not been deployed; its under-two-minute eventual-delivery target still needs
live backlog-age and retry evidence.

The actual provider rejected full D1 export containing FTS virtual tables.
An explicit regular-table exporter with DDL/derived-index reconstruction is under
native verification. This is not yet a successful provider recovery drill.

The selected GA is **invite-only and metered, with AI enabled and paid billing
excluded**. Memory's $50/month Cloudflare target needs measured infrastructure
costs and operator response alongside AI reservation caps. `LIVE_ACCEPTANCE_ID`
alone is insufficient: readiness requires all 15 passed gate records in an
Ed25519-signed, expiring JWS bound to the exact source/config/schema, plus current
technical checks. See [GA_ACCEPTANCE.md](GA_ACCEPTANCE.md).

Authentication35 finished with zero actionable findings on its reviewed source.
Storage36 reported three findings now assigned for correction; affected domains
require fresh review after those changes.
Console34's successful-self-removal reconciliation and outdated deployment
instructions have been corrected; fresh console review follows. No current
zero-finding conclusion or final full-suite count is recorded here.

## Historical 0.4.0-rc.4 integration record

Everything below this heading retains the earlier rc.4 integration and deployment
history. References to “current”, pending work or final tests within that historical
record describe its then-current source, not the schema-25 candidate above.

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

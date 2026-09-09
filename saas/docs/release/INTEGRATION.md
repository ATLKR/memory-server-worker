# Integrated release candidate: 0.4.0-rc.2

This is the maintained integration record. Other files in this folder originated
in the supplied release kit and describe its proposed design and launch work.
They are reference material, not an instruction to activate payments, send mail,
erase data, or certify GA. Their original test counts are historical.

Source archive: `memory-worker-pr22-release-candidate-0.4.0-rc.1.zip`.
SHA-256: `18e0155b8362d285867fbbb34f0db3a88208de20b4e91801924bbd0bbd671d69`.
It targeted commit `b94c434f2074ea975111cb4e3efd4371a9481ac1`; its 91 manifest
entries verified. This proves archive consistency, not publisher identity.
The integration retains the repository's MIT license and attribution.

## 0.4.0-rc.2 source changes

This update configures a five-minute cron for bounded expiry cleanup. The new
index-only `0007_maintenance-schema.sql` supports expired ingest payload, export,
domain/reauthentication challenge and mail-budget cleanup. Each category is
limited to 100 rows per invocation; request-time expiry checks remain authoritative
while a backlog is cleared. Deployed migrations 1–6 keep their exact bytes.

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
credentials to a redirect target. Live login acceptance follows deployment.

The legacy root dependency tree also uses patched sharp 0.35.4 and Vitest 4.1.11.
Its local full audit reports zero vulnerabilities, and the existing 208 tests,
typechecks, Worker/UI builds, generated types and deterministic plugin archive
checks pass. Runtime dependencies and the legacy service version are unchanged.
See the [sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
and [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).

This section records source changes and the stated local checks. It does not
establish rc.2 deployment, migration application, hosted CI completion or real-user
provider acceptance.

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
The rc.2 source adds maintenance, disabled-feature, callback-diagnostic and
client-scope regressions. Local checks pass: 174 baseline, 151 release and six
client/template tests, plus seven native authentication/HTTP runtime tests and
the populated workerd/D1 scheduled-cleanup integration test.
The evaluation loads the supplied synthetic corpus through the real memory APIs.
All 51 cases were evaluated locally: recall@5 0.62, MRR@5 0.60, forbidden hits 0,
stale hits 0, and one negative query with irrelevant results. This measures lexical
retrieval, not semantic quality; local latency excludes the network.

PAT and OAuth both authenticate MCP and compatible clients/plugins. PATs can be
restricted to named Spaces and capabilities; SSO uses the existing Better Auth
provider under `allen.company`. External OAuth clients have independent client IDs
and are verified against the service resource, while browser callbacks retain the
exact configured browser client binding. See [CONNECTING.md](../CONNECTING.md).

Real-user OAuth callback completion remains unverified after the previously
observed client navigation block. Live Stripe/mail/AI/webhook integration, load
testing and recovery drills are still outstanding. The service is a pilot, not GA.

Storage still uses one D1 database. This kit does not implement R2 offload or
physical sharding; the per-database 10 GB limit still applies. See
[SCALING.md](../SCALING.md) for the proposed design and consistency constraints.
Never roll back to a writer that ignores new capability policies. Recover with a
compatible forward fix or a separately restored and reconciled environment.

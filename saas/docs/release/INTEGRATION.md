# Integrated release candidate: 0.4.0-rc.1

This is the maintained integration record. Other files in this folder originated
in the supplied release kit and describe its proposed design and launch work.
They are reference material, not an instruction to activate payments, send mail,
erase data, or certify GA. Their original test counts are historical.

Source archive: `memory-worker-pr22-release-candidate-0.4.0-rc.1.zip`.
SHA-256: `18e0155b8362d285867fbbb34f0db3a88208de20b4e91801924bbd0bbd671d69`.
It targeted commit `b94c434f2074ea975111cb4e3efd4371a9481ac1`; its 91 manifest
entries verified. This proves archive consistency, not publisher identity.
The integration retains the repository's MIT license and attribution.

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

The deployment has no cron schedule. `AUTO_ERASURE_ENABLED=false` also prevents a
future indexing schedule from silently activating retention-based memory erasure.
An explicit erase request remains a separate interactive operation. Before
enabling cron, configure/test providers, backlog capacity, retention, deletion and
recovery behavior. `/ready` intentionally returns 503 until the full readiness
requirements are met; `/health` remains a separate liveness endpoint.

## Corrections made during integration

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
The harness also uses the installed Wrangler statement splitter: a compact
`+CASE` expression exposed a deployment-only split error and was corrected with
whitespace. The first remote attempt rolled back before migration 6 applied.
Email timeout tests wait for the actual provider invocation before advancing
their fake clock, avoiding a platform-dependent event-loop race.

The development-only `sharp` dependency is overridden to the maintainer's patched
0.35.4; the resulting npm audit reports no vulnerabilities. It is not bundled in
the production Worker. [Maintainer advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).

## Verification and remaining limits

Run `npm run check`, `npm run test:d1`, and `npm run eval:lexical` from `saas`.
The complete local check covers 171 existing tests, 143 release tests and five
client/template tests, plus typechecking and migration source/hash consistency.
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

# Physically sharded managed storage and metered GA

The user authorized physical D1 sharding, R2 separation, production deployment,
live acceptance, and continued work toward GA. On 2026-09-10 they chose all
features, including AI retrieval and reviewed extraction, with paid billing
excluded but usage metered. This design implements that scope without changing
the independent membership policy or central Better Auth service.

## Architecture and alternatives

Keep mutable authority, Space ownership, current memory heads, retained revision
metadata, idempotency receipts, usage and logical storage counters in the existing
primary D1. Move immutable payload bytes and lexical postings into multiple
physical hot D1 databases. Store immutable payloads in a private R2 bucket for
retained history and recovery. A payload contains body, source and provenance;
event time, kind, supersession and revision/liveness remain central metadata.

This is preferred over copying ACLs into complete tenant databases, which would
require a distributed revocation barrier and quota reservations. Moving only old
history to R2 would reduce growth but leave all current text and FTS in one D1.
The selected design removes those large objects while preserving one central
transaction as the authorization and quota decision. Central metadata remains
finite; it has capacity monitoring and is not advertised as unlimited storage.

## Publish protocol

1. Validate input and current capability. Hash the same canonical operation
   request used by the existing idempotency contract. Look for a committed
   receipt before doing external storage work.
2. In central D1, create or recover an account/Space/client-key intent with stable
   memory IDs and immutable payload locators. A different request hash conflicts.
   This is bounded staging, not a charged or visible memory operation. Intent
   admission checks current authority and limits outstanding uncommitted payloads.
3. Upload canonical payload bytes to R2 with a checksum and create-only condition;
   store the same immutable payload and tenant-scoped FTS projection in a selected
   hot shard. Verify existing objects instead of overwriting mismatched bytes.
4. One central transaction checks execution-time authority, exact revision,
   recent proof when required, intent readiness and logical quotas. It commits the
   operation receipt, head/history transition, usage and publication state.
   Ingest approval publishes up to 20 selected memories in this same transaction.
5. Retire old hot copies through bounded durable work after publication. R2
   retains referenced historical payloads. A lost response reuses the committed
   receipt; failed or expired preparations remain unreachable and are collected.

No external object, token, cached ACL or successful upload independently grants
access. Paid-provider bindings remain disabled; metering is not disabled.

## Representation and reads

Forward migration 22 adds `payload_id`, `payload_shard_id`,
`payload_object_key`, `payload_sha256`, `payload_bytes` and `logical_bytes` to
heads and revision metadata. Legacy rows retain inline content until individually
verified. External rows use an internal marker in the legacy non-null body field;
that marker and all storage locator fields must never appear in public memory
representations. Public serializers explicitly enumerate supported fields.

Payload IDs belong to one memory and Space. There is no cross-memory content
deduplication. Soft deletion and restoration may reuse immutable content, while
their central metadata revisions and retained logical-byte charges remain distinct.

Readers select authorized central rows, hydrate bounded immutable bytes and
verify their hash/context, then perform the final central authority and represented
revision/liveness check. No asynchronous payload retrieval happens after that
check. Export uses its exact historical watermark and final export/erasure check;
omitted erased rows still advance the raw snapshot cursor. Background indexing
hydrates before its final live-source and lease check before each provider call.

## Physical shard routing and lexical search

`STORAGE_MODE` is `inline` or `sharded`. Sharded mode requires private
`MEMORY_PAYLOADS` and `STORAGE_SHARDS_JSON`, an explicit array of immutable shard
IDs, D1 binding names, and `active` or `draining` mode. The initial deployment has
two distinct hot databases. At most 16 configured shards bound request fan-out;
at most four storage requests run concurrently. Draining shards remain readable.
They cannot be removed while a referenced hot placement still requires them.

New payloads are placed only on active configured shards. The central committed
pointer determines their actual location; organization nesting and display names
never choose a database. Adding a shard does not reinterpret an existing pointer.
Capacity checks and an operator migration command support expansion and movement.

Prepared and previous payloads retain separate FTS rows, so a preparation cannot
replace a still-current projection. Search reads ranked keyset pages from each
tenant-specific shard index and validates candidate payload IDs against central
current heads and current grants. It merges validated ranks deterministically.
Work has explicit page/candidate budgets. If stale or prepared postings prevent
proving a complete result within that budget, return a retryable unavailable
response instead of silently reporting a false empty or incomplete result.

## Erasure, collection and archive conversion

Erasure first makes all affected central content inaccessible and durably records
distinct payload locators before clearing head/history pointers. Its receipt
reports external cleanup pending until storage confirms removal. Vector cleanup
and payload cleanup have separate completion evidence.

R2 normal uploads are create-only. Purging overwrites the known key with a
zero-byte purge tombstone and retires the hot copy under a permanent per-payload
shard tombstone. The identifiers remain so a delayed upload cannot restore
plaintext. Tombstones have no lifecycle expiration while late writes can exist.
Retries verify terminal state on both stores. A partial failure never reports
completed physical erasure. GC claims and central publication are mutually
exclusive; expired stages cannot be published after collection starts.

Legacy archive conversion uses an exact transient permit comparing the original
body, source, provenance and metadata revision in the same central transaction.
It installs a verified external pointer and clears inline bytes without inventing
a revision, modifying audit/history identity, or refunding logical usage. Any
concurrent content change causes the conversion to skip or retry that row.
Central FTS is retained for inline rows until their verified shard projection is
ready. New forward migrations preserve migrations 1–21 byte-for-byte.

## Deployment, recovery and GA evidence

Deployment commands carry one explicit configuration target through preflight,
migration and Wrangler. Staging must use separate DBs, bucket, Worker and domain;
production identifiers in a staging target are rejected. No test harness writes
synthetic security fixtures into customer production data.

Before production migration: verify backup/Time Travel recovery points, capture
resource manifests, run populated upgrades and a multi-store restore drill on
isolated staging, then deploy a backward-compatible candidate and incrementally
convert content. Test routing to both physical shards and R2 fallback before
converting production rows. A maintenance/admission control supports recovery.

The metered GA profile requires SSO, mail/proof, AI/Vectorize, reviewed encrypted
ingestion, identity revocation delivery/reconciliation, storage readiness,
maintenance, observability, restore evidence and a revision-bound acceptance
record. Paid checkout/portal is excluded. Simply setting `RELEASE_MODE=ga` or
putting a nonempty string in `LIVE_ACCEPTANCE_ID` does not constitute acceptance.

Live tests cover real login and reconnection, mail proof, PAT restrictions and
revocation, supported MCP clients, AI/Vectorize indexing/extraction, tenant
isolation, deletion, rate/usage limits, provider failure, recovery and bounded
load. Tests that require a user-owned browser session, an actual destination or
business policy request only the missing information. GA status reflects completed
evidence and remaining decisions rather than an aspirational environment flag.

## Primary references

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 transactions and primary reads](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [R2 binding and conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [Workers production practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

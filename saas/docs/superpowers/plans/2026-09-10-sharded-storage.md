# Sharded storage and metered GA implementation plan

**Goal:** Physically separate large managed-memory content across D1 shards and
R2, preserve current authorization and recovery guarantees, deploy and collect
the evidence needed for metered GA without paid billing.

**Architecture:** Immutable external preparation followed by one authoritative
central D1 publish transaction. Central metadata and quotas remain transactional;
all returned content receives a final central authorization/liveness check.

**Tech stack:** Cloudflare Workers, D1, R2, Workers AI, Vectorize, Cloudflare Email,
TypeScript, Node 24 tests and native Miniflare/workerd integration.

**Spec:** [2026-09-10-sharded-storage-design.md](../specs/2026-09-10-sharded-storage-design.md)

## Global constraints

- Preserve central `auth.allen.company` / `auth-api.allen.company` and production
  `memory.allenlabs.org`, optional PAT Space restrictions and independent nested
  organization membership. Display branding must remain configurable.
- Freeze central migrations 1–21; introduce forward central 22 and independent
  shard migration 1. Maintain inline compatibility until verified conversion.
- No paid charges; preserve metering and enable/test AI features for the chosen GA.
- At most 16 configured shards and four concurrent storage calls; bounded reads,
  pages and background work. No runtime Cloudflare management API credentials.
- New native regression tests reproduce failures, including delayed side effects,
  before a result is reported fixed. Fresh independent reviews precede deployment.

## Task 1: Central publication, compatibility and logical metering

Owner: authentication implementation agent. Files: `payload-schema.sql`,
`migrations/0022_payload-schema.sql`, `src/release/memory.ts`, optional
`src/release/payload-intents.ts`, focused central publication tests.

Contract consumed from Task 2:

```ts
type PayloadRef = { id: string; shardId: string; objectKey: string; sha256: string; bytes: number };
type PayloadContent = { body: string; source: string | null; provenance: Provenance };
type PayloadContext = { spaceId: string; memoryId: string };
```

- [ ] Add six pointer/size columns, immutable stage identity, account/Space/key
  intent uniqueness, ready/publication/GC fencing and purge outbox. Verify exact
  logical-byte accounting for inline and external current/history rows.
- [ ] Implement `MemoryStore(db, clock, payloadStore?)`, `preparePayloads`, optional
  prepared state on `commit`, and a pointer-aware insertion helper for ingest.
- [ ] Verify same-key retries keep IDs, changed input conflicts, quota is charged
  once, queued revocation/expiry prevents publish, and failed preparations remain
  inaccessible. Up to 20 ingest memories publish together or not at all.
- [ ] Implement `hydrateRows` and explicit public serialization. Check update-only
  PATs preserve omitted source/provenance without acquiring read capability.
- [ ] Implement exact archival permits and truthful erasure cleanup state; verify
  ordinary history edits remain forbidden and conversion preserves audit/usage.

## Task 2: Physical hot shards and R2 payloads

Owner: storage implementation agent. Files: `src/release/payload-types.ts`,
`src/release/payloads.ts`, `shard-schema.sql`,
`shard-migrations/0001_payloads.sql`, focused payload tests,
`test/storage-runtime.integration.mjs`.

```ts
class PayloadStore {
  constructor(env: StorageEnv, clock?: () => number);
  readonly enabled: boolean;
  descriptor(context: PayloadContext, content: PayloadContent, payloadId: string): Promise<PayloadRef>;
  stage(context: PayloadContext, ref: PayloadRef, content: PayloadContent): Promise<void>;
  read(context: PayloadContext, ref: PayloadRef): Promise<PayloadContent>;
  retireHot(context: PayloadContext, ref: PayloadRef): Promise<void>;
  purge(context: PayloadContext, ref: PayloadRef): Promise<void>;
  shardIds(): string[];
  // Explicit score/key cursor, tenant-scoped bounded result page.
  searchPage(shardId: string, spaceId: string, expression: string, after: unknown, limit: number): Promise<PayloadCandidatePage>;
}
```

- [ ] Validate configuration and distinct bindings, private R2 access, active-only
  placement and immutable pointer/context; encode/check canonical hashes and sizes.
- [ ] Implement checksum/create-only stage, bounded hot read with R2 fallback,
  permanent purge tombstones and idempotent partial-failure retries.
- [ ] Implement tenant FTS keyset pages retaining separate prepared/old projections.
- [ ] Native tests use central D1, two distinct hot D1 databases and actual R2.
  Hold writes before application and after acknowledgment; test purge/restart,
  hash corruption, object loss, staging conflicts and terminal tombstone guards.

## Task 3: Target-safe deployment tooling

Owner: console/operations implementation agent. Files:
`scripts/deployment-config.mjs`, `scripts/deployment-command.mjs`,
`scripts/preflight.mjs`, `scripts/preflight.test.mjs`, package script entries.

- [ ] Carry the selected `--config` through every subprocess as an argument array.
  Reject unsupported environment overrides and missing/invalid config explicitly.
- [ ] Validate distinct staging resources, route/origin, nonpublic alternate Worker
  endpoints and restricted mail sender. Invalid templates cannot be deployed.
- [ ] Run a fake child executable to prove argument fidelity, target isolation and
  failure propagation without contacting Cloudflare. Integrate the test into CI.

## Task 4: Hydration, search, ingestion and bounded maintenance

Owner: coordinator. Files: `src/release/types.ts`, `extension.ts`, `search.ts`,
`transfer.ts`, `jobs.ts`, `ingest.ts`, migration loaders and native tests.

- [ ] Wire one storage configuration through MemoryStore, Search, Ingest and
  Transfers; preserve inline fixtures and block any external-marker fallback.
- [ ] Hydrate before final REST/MCP/export/provider authority and source checks.
  Reproduce revocation and erasure during a held R2 read and prevent disclosure.
- [ ] Merge bounded shard FTS candidate pages only after exact central publication
  checks. Preserve Unicode/prefix semantics and return explicit retryable failure
  on insufficient scan coverage; never expose staged or obsolete payloads.
- [ ] Stage approved ingest payloads before their existing atomic central approval.
  Keep proposal cancellation, expiry, receipt recovery and account isolation.
- [ ] Process cold-retirement, orphan/purge work with bounded durable claims and
  deadlines. Implement resumable inline conversion and capacity/health inspection.
- [ ] Run existing suites plus native populated upgrades and multi-store failures;
  collect fresh independent authentication/storage/client/recovery reviews.

## Task 5: Metered GA readiness and live acceptance

Owner: coordinator, delegating independent operations work as Task 3 completes.

- [ ] Implement a metered, nonpaid feature profile and revision-bound acceptance
  manifest; paid billing is explicitly disabled while AI, quotas and metering run.
- [ ] Add maintenance/admission controls, sanitized operational metrics and
  shard/R2/cleanup health. Define measurable staging load and recovery thresholds.
- [ ] Provision isolated staging, apply central/shard migrations, run restore and
  delayed-side-effect tests, verify all configured resources and capacity limits.
- [ ] Connect real AI/Vectorize, mail and identity revocation/reconciliation; execute
  SSO/PAT/MCP and tenant-isolation tests using designated synthetic accounts/data.
- [ ] Complete account data lifecycle, operator procedures and the user-supplied
  business/support/retention decisions needed for the offered public scope.
- [ ] Capture production recovery points, deploy the verified candidate, convert
  small bounded batches, verify real routing/R2/hydration and monitor failures.
- [ ] Promote to GA only when the actual acceptance record is complete. Publish
  exact commit, configuration/migration identities, test evidence and remaining
  limitations; do not replace missing evidence with a GA flag.

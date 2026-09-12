# Native PostgreSQL port status

> Current scope: the user's later 2026-09-11 decision prefers Cloudflare for feasible persistence and full raw Agent Memory ingest, with Seoul PostgreSQL only for explicitly external Cloudflare data. See `../docs/cloudflare-storage-research.ko.md`. The full port matrix below is an inventory of the earlier alternative, not an instruction to expand PostgreSQL as the default backend. Migration 0004 and a standalone Hono PAT archive/keyword implementation are now present; see [Seoul serving scope and release gates](SEOUL-SERVING.md). No mandatory pgvector or general-memory Neon path is being activated.

The D1 baseline is preserved at `adfb256545f395274f2645e2e83c16642b596d84`. This directory contains a foundation and a bounded native serving module, not a complete operational Memory backend. This source package does not install migration 0004 or execute a production cutover. Provider installation receipts are separate from source tests. The existing D1 migrations and SQL are unchanged.

## Implemented foundation

The following foundation details describe migrations 0001–0003. Migration 0004
extends their runtime authority through named commands, without broad runtime
identity/content table access; its exact scope is documented separately above.

| Native migration | Result |
| --- | --- |
| `migrations/0001_private_namespaces.sql` | Creates six private namespaces and three distinct NOLOGIN capability roles. Rejects existing reserved role names instead of taking over or altering them. Restricts defaults for the new owner role, including global default function EXECUTE. |
| `migrations/0002_deployment_identity.sql` | Defines bounded identifier/epoch domains, immutable deployment identity, append-only migration versions, and a private trigger function. Runtime/background may read deployment metadata only. No region or processing policy row is seeded. |
| `migrations/0003_identity_foundation.sql` | Adds native account, organization, email-claim, membership, credential and provider-identity structure; composite ownership references; immutable bindings; monotonic revocation/disable markers; retained identity rows. RLS is enabled and forced, with an owner-only import policy. Runtime/background identity access remains denied. |

The metadata contract is:

```text
memory_control.deployment_identity
  singleton smallint PRIMARY KEY CHECK(singleton = 1)
  deployment_id text identifier
  storage_region text CHECK IN ('sg', 'kr-seoul')
  processing_policy_id text identifier
  created_at_ms bigint within JavaScript's nonnegative safe-integer range

memory_control.schema_migrations
  version positive integer PRIMARY KEY
  name unique migration filename
  installed_at_ms bigint within the same range
```

The provisioner must initialize the exact selected deployment, storage region and policy identifier. A policy identifier is a reference, not approval or an ingress/AI enable flag. No row means unconfigured. UPDATE, DELETE and TRUNCATE are rejected, including under `memory_owner`; deliberate changes require a separately reviewed migration. The version ledger starts with contiguous versions 1–3. Application attestation must verify the complete expected sequence and reject missing or unexpected future versions.

## Roles and execution preconditions

- `memory_owner`: NOLOGIN, no superuser/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS. Owns only the new Memory schemas and objects. Used by explicit migrations/import, never ordinary requests.
- `memory_runtime`: NOLOGIN capability role, no DDL privileges in Memory schemas, no owner membership, metadata SELECT only in this foundation.
- `memory_background`: separate NOLOGIN capability role with the same initial metadata-only access. Queue/cleanup privileges must be added explicitly with their native implementation.

Actual login roles, passwords and membership grants are the provisioner's responsibility. These SQL files never grant a capability to a login or modify Supabase built-in objects. Bootstrap requires permission to create roles and assign schema ownership. Later migrations require an independently authorized migration login able to `SET ROLE memory_owner`. Validate those capabilities on the actual selected provider before attempting any migration; do not substitute the runtime login or weaken its privileges to make bootstrap succeed.

Apply files once, in filename order, as individual transactions. `0001` intentionally rejects a role-name collision and existing schemas also abort creation. Do not retry unknown outcomes blindly. A future reviewed migration runner must reconcile catalog/ledger state and source checksums before deciding whether a file was committed. The ledger identifies native versions; deployment receipts must additionally pin the migration file hashes and source commit. There is no automatic provider runner in this foundation.

`PUBLIC`, and existing `anon`/`authenticated` roles, have no service-object access. Only new `memory_*` objects and defaults of the new `memory_owner` are modified. Supabase Data API exposed-schema settings remain a separate deployment check; these namespaces must stay unexposed. Existing unrelated grants remain unchanged. If the provider grants PUBLIC CREATE elsewhere, that inherited privilege cannot be negated by an ordinary per-role REVOKE; the provisioner and connection attestation must reject an unsafe login/target or apply an independently reviewed provider policy. This migration does not modify the provider's `public` schema.

## Identity scope and deliberate denials

`account_emails(id, account_id)` owns the email claim. A membership references that exact pair, and an organization credential references `(membership_id, account_id, email_id)` together. Session/personal PAT rows cannot carry an organization membership/email; organization PATs must carry both. `credentials(id, account_id)` is also unique for future ownership references. SHA-256 token digests are validated as lowercase 64-character hex; no bearer token is stored.

Personal PATs remain independent of an email claim, matching the existing product. Updating an email to revoked does not silently revoke a personal PAT. Foundation migrations 0001–0003 provide no live-admission functions. Migration 0004 adds fixed PAT checks and per-Space archive/search commands that lock and recheck current authority. Full email/member/account lifecycle command and event parity remains pending. Runtime still has no direct INSERT/UPDATE/DELETE/SELECT on identity tables; do not add a broad runtime policy to make an incomplete flow work.

Identifiers remain text and include existing colon-prefixed conventions. The native identifier domain limits them to the existing Memory API identifier syntax, so importer validation must flag any historical administrative rows outside that syntax before loading. Provider issuer/subject bounds preserve character limits, not UTF-8 byte limits. Long composite provider keys must also be tested against actual PostgreSQL index limits before full identity parity; do not truncate identifiers to make an import pass.

## Historical full-port inventory

This matrix records the foundation-era gaps against the full original product.
The bounded PAT archive/keyword subset in [SEOUL-SERVING.md](SEOUL-SERVING.md)
supersedes its relevant authority, ingest, usage and search entries. It does not
establish full lifecycle, SSO, erasure or recovery parity.

| Existing implementation / contract | Native status | Required next work |
| --- | --- | --- |
| `src/release/types.ts:17`, `src/release/util.ts:99` — D1 query/batch/primary API | Separate connection work package | One native transaction/connection; exact row counts, bound parameters, bigint decoding, rollback/unknown commit handling; no SQL-string compatibility shim. |
| `migrations/0001_schema.sql:7` — account/email/member/credential structure | Structural foundation present | Full live binding, issuance, email proof, revocation authorization and audit command port. |
| `migrations/0003_product-schema.sql:7` — provider mapping and workspace commands | Provider mapping only | Verified central SSO receipts, invitation/key/sign-in atomic commands and bounded identity freshness. |
| `migrations/0005_hierarchy-schema.sql:27` — immutable child creation, cycle prevention | Not ported | Native organization creation, immutable hierarchy, arbitrary product depth, no inherited memory permission. |
| `src/release/authority.ts:35` — PAT/session/Space/share authority | Bounded native PAT/selected-Space archive/search commands in 0004 | Full session/share/lifecycle parity, grantor/recipient flows and independent-client concurrency acceptance remain pending. |
| `migrations/0024_lifecycle-schema.sql:36` — issuer proof/sequence/revocation | Not ported | Signed event receipt, exact issuer sequence, replay/conflict rules and region-local fail-closed projection. |
| `src/release/memory.ts:234` — operation receipt/revision/quotas | Native immutable archive receipts, per-Space source/message quotas and one meter event in 0004 | Editable memory revision CAS, shared budgets and full head/history parity remain pending. Test actual competing clients. |
| `src/release/memory.ts:65` — irreversible erasure and restore | Not ported | Native privacy ledger, tombstone dominance, history/payload removal, retention checks and safe recovery quarantine. |
| `src/release/payloads.ts:117` — D1 HOT + canonical R2 payloads | Not ported | Region-local PostgreSQL canonical bytes/hash and typed content; preserve old tombstones/import evidence. No hidden active D1/R2 path. |
| `src/release/search.ts:11` — FTS5 and Vectorize | Literal native archive keyword search in 0004; no semantic capability | Full-text language/prefix parity and approved regional vector projections/rebuild remain separate work. |
| `src/release/jobs.ts:70` — queue lease/budget/provider fencing | Not ported | Native claim/renew/checkpoint/outbox, no stale completion, expiry after lock wait, independent worker concurrency. |
| `src/release/ingest.ts:47` — encrypted transient input | Not ported | Region-local ciphertext/key/AAD/TTL, before-provider authority recheck and approved processing policy. |
| `src/release/storage-readiness.ts:13` / `readiness.ts:94` | Not ported | PostgreSQL-only profile readiness and actual queue/search/storage/backup evidence. D1 acceptance is historical. |
| `postgres/` import/backup/cutover | Not implemented | Source schema/runtime guards, exact consistent cut, row/ACL/payload/privacy reconciliation, regional restore and post-write rollback journal. Never enable dual writers. |

Discovery counted 75 ordinary central tables, 5 views and 227 final triggers in 25 central migrations, plus a separate shard schema. This foundation intentionally implements only the structure above. Those counts do not measure parity or justify removing any remaining D1 rule.

## Schema boundaries and clinical extension

- `memory_control`: regional deployment/catalog and explicit region policy identifiers.
- `memory_identity`: principals, credentials, memberships and eventual signed lifecycle/authority state.
- `memory_content`: future canonical memory/history/payload/ingest data.
- `memory_search`: future regional lexical and vector projections.
- `memory_jobs`: future durable jobs/outbox/lease/checkpoint state.
- `memory_ops`: future immutable audit, usage, budgets, heartbeat and migration/recovery evidence.

No clinical tables or namespace are pre-created. The latest user decision places medical/strict data in Seoul and general data outside Seoul; this supersedes the earlier blanket recommendation to leave medical placement undecided. Storage admission must use that explicit fixed-region profile. It does not establish where runtime, inference, logs, backups, keys, SSO or operators process data. The later Cloudflare BAA/filtering and processing controls remain separate work, and this unfinished foundation cannot yet accept product traffic. A future clinical extension needs explicit Seoul physical separation, role/key boundaries and its own migration review; a schema name is not a residency guarantee. Do not send content overseas to classify it and do not infer sensitivity from names, IPs or email domains.

## Verification

Run from `saas`:

```sh
node --test --test-concurrency=1 test/postgres/schema.foundation.test.mjs
```

The suite executes native SQL with PGlite. It verifies privileged-role flags, metadata initialization/mutation denials, version retention, unrelated Supabase grants, private/default ACLs, forced RLS after an accidental table grant, cross-account FK rejection, personal PAT semantics, monotonic revocation, provider binding identity and non-ASCII length compatibility. Initial tests were observed red before migration implementation; the Unicode parity regression was separately observed red before fixing the byte/character distinction.

PGlite is an embedded PostgreSQL engine, not proof of provider networking/TLS, actual role provisioning, independent-client locking, pooler semantics, region placement or service parity. Those require the separately gated native/provider acceptance work. Existing D1 tests must continue to pass until the complete active PostgreSQL implementation is verified.

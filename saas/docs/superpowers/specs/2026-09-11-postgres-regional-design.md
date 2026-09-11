# Regional PostgreSQL migration

> Superseded as the default architecture by the user's later 2026-09-11 instruction: use Cloudflare for feasible data and processing, including full raw Agent Memory ingest; retain Seoul PostgreSQL only for explicitly external Cloudflare data. See `../../cloudflare-storage-research.ko.md`. The document below preserves the earlier full-PostgreSQL design as historical context. It is not a current instruction to migrate ordinary data to Neon, prohibit Cloudflare copies, or require pgvector. Existing foundation code remains an unconnected alternative; no production PostgreSQL cutover occurred.

Status: implementation in progress under the user's 2026-09-11 instruction. This document does not authorize a production cutover or assert medical compliance. The user has authorized the migration; cutover requires the concrete validation below.

The active Memory service will use PostgreSQL, retaining the existing D1 implementation and migration history. Each deployment has exactly one home database: `sg` (Neon Singapore) or `kr-seoul` (Supabase Seoul). There is no cross-region fallback, connection race, read replica selection or bearer-token broadcast. A schema is a logical boundary; distinct database instances, credentials and deployment contexts provide the regional boundary.

The first work package is the database boundary: strict region configuration, TLS-verified bounded PostgreSQL connections, native transactions, private schema/role separation and executable PostgreSQL tests. Existing D1 production remains intact until the complete service and migration have passed tests. Source baselines and previous D1 acceptance evidence remain historical; none certify the new backend.

Schemas in each region separate deployment/control metadata, identity and authority, content and immutable revisions, search projections, background jobs, operational audit and metering. Private schemas must not be granted to Supabase `anon`/`authenticated` or exposed through its Data API. Runtime roles have no DDL, superuser, role creation or BYPASSRLS privileges. Migration credentials never run application requests. Regional policy metadata is immutable through ordinary CRUD. Tenant membership and current revocation remain authoritative at the database mutation, with an execution-time clock.

Memory bodies, revision payloads, ingest ciphertext and derived vectors belong to the selected regional PostgreSQL database. Active PostgreSQL profiles may not retain D1/HOT, R2 or Vectorize as a hidden data path. No SQL-string shim may silently weaken SQLite triggers, affected-row semantics, atomic command batches, query authority or search behavior. Native ports must have real PostgreSQL coverage for concurrent quota admission, conflicting revisions, rollback, retry/replay and expired credentials.

Data classification was independently examined in ChatGPT Chat `6 Pro`, as requested by the user. The user's subsequent decision overrides the suggested blanket medical-profile exclusion: general memory consolidates in Neon Singapore; medical and strict profiles use Supabase Seoul. `storageRegion` stays separate from `processingPolicy`: successful Seoul storage admission is not an HTTP/AI/MCP processing approval or end-to-end residency guarantee. The user will separately arrange Cloudflare BAA or filtering. Keep this external-processor policy separate and do not assume an unsigned BAA or unverified filter has been approved. See `../../postgres-residency-policy.ko.md`. Incoming content must never be sent overseas to determine its classification. No inferred medical classification from names, IP geolocation or email domains.

Central Better Auth remains the configured identity issuer. This Memory migration does not silently migrate the shared authentication platform. Any local identity projection must use bounded, fail-closed freshness/revocation rules; a Seoul strict profile cannot claim compliance from the existing global SSO deployment.

Migration runs against exactly selected databases after backup: load schemas and source data, reconcile identities/ACL/history/erasure and bytes, rebuild local indexes, test CRUD/SSO/PAT/MCP/AI, quiesce old writers, import final delta and verify. Never enable dual writers. Keep D1 and R2 historical backups read-only through a documented rollback window; a rollback after new writes requires reconciliation, never flipping a flag and losing writes. Remove old active bindings and scheduled writers only after a verified cutover. Do not delete old resources as part of initial switch.

Budget evidence must include both DB providers and Cloudflare. Keep the existing Memory Cloudflare USD 50 monthly limit; distinguish it from newly user-selected DB subscription charges. Existing AI admission limits are not invoice totals. Paid billing remains excluded.

Official technical references checked on 2026-09-11:

- https://node-postgres.com/features/transactions
- https://node-postgres.com/features/ssl
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/platform/regions
- https://developers.cloudflare.com/data-localization/how-to/workers/

Final acceptance: application parity and D1 tests pass; native PostgreSQL transactions and concurrency pass; actual Neon/Supabase targets/regions/roles/TLS verified; no active legacy storage use in PostgreSQL profiles; restored deletion/revocation remains effective; cross-region routing/egress negatives pass; source-pinned deployment and post-cutover checks succeed. Missing evidence keeps the corresponding profile unavailable.

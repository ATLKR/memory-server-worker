# Regional PostgreSQL Implementation Plan

> Superseded as a whole-service migration by the user's later 2026-09-11 Cloudflare-first direction. See `../../cloudflare-storage-research.ko.md`. Preserve the tested PostgreSQL foundation for the Seoul exception path. Do not continue a default general-memory→Neon migration or require local pgvector. Raw Cloudflare Agent Memory ingest is explicitly authorized without a new legal/BAA implementation gate.

> For agentic workers: use subagent-driven-development for bounded independent tasks; root integrates and reviews shared contracts.

**Goal:** Replace active Memory persistence with regional PostgreSQL while preserving the D1 backend and all security/behavior contracts.

**Architecture:** Complete regional data planes, private schemas and distinct roles. Native PostgreSQL transactions, no cross-region fallback, explicit profile readiness and independently tested migration.

**Tech Stack:** TypeScript, node-postgres, PostgreSQL, pgvector where available; PGlite for embedded engine tests plus actual provider concurrency tests.

**Spec:** `../specs/2026-09-11-postgres-regional-design.md`

## Global constraints

- D1 baseline adfb256545f395274f2645e2e83c16642b596d84 remains preserved.
- Only MemoryServiceDB targets authorized; no hospital credentials/resources.
- No secrets in source, logs, evidence or prompts. No automatic cross-region retries.
- Region classification response is advice to verify, not authority to transfer data.
- No production cutover until native service parity and migration checks pass.

## 1. PostgreSQL connection and transaction boundary

- [x] Add `src/postgres/connection.ts` structural native query interfaces, per-operation bounded connections, explicit region target, TLS server verification and request cleanup.
- [x] Test transaction ordering, rollback, abort/deadline, safe bigint decoding, affected rows and ambiguous commit handling. Never retry unknown writes.
- [x] Add private schema roles/deployment identity metadata and real engine tests.

## 2. Native schema and authority port

- [ ] Inventory 75 central tables, 5 views, 227 triggers and 25 migrations; record explicit equivalents for authorization/command triggers.
- [ ] Add PostgreSQL migrations in `postgres/` without altering `migrations/` or shard SQL.
- [ ] Port identity/organization/Space/PAT authority and idempotency/quota/revision transactions; test actual PostgreSQL races, not only mocked ports.

## 3. Regional payload/search/jobs

- [ ] Store payload, history, ciphertext, tombstones and vectors in regional PostgreSQL; preserve deletion and authority rechecks.
- [ ] Port lexical search and background fencing/budget/outbox; test ranking, Unicode behavior and retries.
- [ ] Apply independently reviewed storage/processing classification contract before external AI/exports.

## 4. Runtime and deployment profiles

- [ ] Integrate PostgreSQL into request and scheduler composition without consulting D1 in PostgreSQL mode.
- [ ] Add explicit regional endpoints/credentials/readiness/fingerprints; replace D1 monitor persistence.
- [ ] Validate staging SSO/PAT/REST/MCP/AI and no legacy binding access; fresh independent review loop.

## 5. Migration and cutover

- [ ] Back up/quiesce old writers, import and reconcile exact snapshots, verify deletion/revocation and restore.
- [ ] Execute source-pinned cutover and remove active legacy bindings/schedules; preserve rollback evidence.
- [ ] Complete actual per-region checks, cost and incident alert drill before GA promotion.

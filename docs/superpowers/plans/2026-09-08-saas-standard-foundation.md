# Standard Memory Foundation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded implementation and independent review. Track checked steps below.

**Goal:** Turn the partially published SaaS branch into a runnable, tested identity and Standard memory foundation.

**Architecture:** Isolated `saas/` module, SQLite/D1 SQL authority, canonical versioned memory, Fetch-based API and localhost demo. Production personal-service routing remains intact.

**Tech Stack:** TypeScript, Node 24, node:sqlite, Web Crypto, SQL compatible with D1.

**Spec:** `docs/superpowers/specs/2026-09-08-saas-standard-foundation-design.md`

## Global constraints

- Current personal-service Worker configuration, data and credentials are out of scope for mutation.
- Account and immutable email claim IDs are distinct; organization memberships refer to claim IDs.
- Authority is read from current database state; authorization failure never falls back to personal profiles.
- Standard (`managed`) only. Zero-Access requests must be rejected.
- No remote deployment, actual mail delivery, payment or secret retrieval in this iteration.

### Task 1: Restore identity persistence

Files: `saas/schema.sql`, `saas/test/identity.test.mjs`, `saas/test/helpers.mjs`, `saas/src/identity.ts` only where tests identify defects.

Interfaces: consume `IdentityDatabase`, `IdentityService`, `digestToken` from existing `identity.ts`; produce the SQL tables/views referenced by that file and a SQLite test helper.

- [x] Write stateful tests using node:sqlite. Check multiple emails, membership-bound tokens, recent sessions, proof expiry/replay/cross-account, domain delegation/exact domain, atomic cascading revocation, rollback and no resurrection.
- [x] Run `node --experimental-sqlite --test test/identity.test.mjs` and record expected failures from missing persistence.
- [x] Implement SQL tables, constraints, active views and atomic triggers; make source fixes only when a test shows an issue.
- [x] Run the identity suite and pass every assertion.

### Task 2: Versioned Standard memory and authorization

Files: `saas/src/memory.ts`, `saas/memory-schema.sql`, `saas/test/memory.test.mjs`.

Interfaces: consume `IdentityDatabase` and `active_credentials`/`active_memberships`; produce `MemoryService` accepting database and clock. Methods createSpace, create, get, update, remove, search accept a token and explicit Space ID; updates/deletes require expected revision. Space and record identifiers are server-generated UUIDs.

- [x] Write independent fixtures and failing tests for personal/org isolation, current permissions, revision conflicts, deletion filtering, managed-only mode and bounded search.
- [x] Implement conditional SQL writes with live authorization predicates and atomic version triggers. Read through `first-primary` and filter tombstones in SQL.
- [x] Run the focused suite, then the full identity/memory suites.

### Task 3: Runnable API, validation and development handoff

Files: `saas/src/api.ts`, `saas/test/api.test.mjs`, `saas/dev/server.mjs`, `saas/dev/sqlite.mjs`, `saas/tsconfig.json`, `saas/package.json`, `saas/package-lock.json`, `saas/README.md`, `.github/workflows/saas.yml`.

Interfaces: `createMemoryApi(db, clock?)` returns a Fetch handler; development server binds 127.0.0.1 and uses random synthetic credentials. API path `/v1/spaces` and `/v1/spaces/:spaceId/memories` with item GET/PATCH/DELETE and collection GET search/POST.

- [x] Test missing/bad Bearer tokens, authorization failure, invalid JSON, body limits, revisions and sanitized errors through real Request/Response and real SQLite.
- [x] Implement a bounded body reader and JSON error responses; expose only the intended methods. No credential/bootstrap management route.
- [x] Add reproducible install/typecheck/test scripts and CI, with an explicit test entry point so an empty glob cannot pass.
- [x] Run standalone check and local HTTP smoke; run existing tests/typecheck/build as dependencies allow. Record exact blockers, if any.
- [x] Obtain independent review, address findings, update README and verification report, and leave the local feature branch reviewable.

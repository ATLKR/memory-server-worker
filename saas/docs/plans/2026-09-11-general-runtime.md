# General Agent Memory Runtime Implementation Plan

> **For agentic workers:** Use the existing approved regional-routing design and implement the independently testable units below. Root integrates and verifies the complete change before committing or deploying.

**Goal:** Connect general personal and organization Spaces to Agent Memory through REST/MCP, with durable usage, deployment-wide admission budgets and whole-profile retirement.

**Architecture:** Preserve the medical consent ledger. Add one SQLite Durable Object per general Space and a separate deployment budget coordination object. Current legacy identity/ACL is rechecked before provider I/O and disclosure; its D1 migration remains explicit subsequent work. Store metadata only in the new objects. A profile belongs to actual Space owner and generation, never the caller.

**Tech Stack:** TypeScript, Cloudflare Workers SQLite Durable Objects, existing Agent Memory HTTP adapter, native SQLite/workerd tests.

**Spec:** `../agent-routing.ko.md`, `../consent-runtime.ko.md`, and the user-approved Cloudflare-first/Seoul-only routing and metered invite-GA policy.

## Global constraints

- Hard Seoul restrictions win; no automatic alternate destination or unknown ingest replay.
- Independent organization ACL, exact PAT capability/Space restrictions, accepted read-only sharing and current revocation remain enforced.
- Admission ceilings are not actual billing evidence. The total Cloudflare USD50/month gate still requires measured coverage and alert validation. Privacy erasure continues when admission budget is exhausted.
- Newly implemented routes default disabled. No production cutover, zero-D1 or GA claim follows from local tests alone.
- All RPC data has strict schemas. No transcript, query, answer, bearer or consent evidence body enters these ledgers.

## 1. Space operation ledger

Files: `src/routing/general-types.ts`, `general-ledger.ts`, `general-ledger-object.ts`, `test/routing-general/ledger.test.mjs`.

- [x] Implement `GeneralSpaceStub` from the shared contract with immutable identity and `space:<spaceId>` object-name binding.
- [x] Atomically admit one operation ID/body hash/actor, charge usage once, and return a dispatch permission only for the first admission. Replays cannot change owner, provider, operation, content hash or usage.
- [x] Recheck expiry and active generation for dispatch/disclosure. Finalization remains possible after expiry or retirement and permits only one terminal transition.
- [x] Retire the current generation atomically, preserve a deletion outbox and increment the active generation. Acknowledgement is distinct from physical purge. Retired generations never become readable again.
- [x] Exercise SQLite restart/concurrency, replay collisions, month rollover, finalization, retirement/late response races and raw-content rejection. Bound operation and retirement growth.

## 2. Deployment admission budget

Files: `src/routing/budget-ledger.ts`, `budget-ledger-object.ts`, `test/routing-general/budget.test.mjs`.

- [x] Implement `RoutingBudgetStub`. Pin `budget:<budgetId>` identity and the policy for each UTC month.
- [x] Reserve once per stable ticket-derived reservation ID, atomically enforcing request/input-byte/monetary-reservation ceilings across Spaces. Cap the configured reservation ceiling at50,000,000 microUSD and retain unknown/failed reservations conservatively.
- [x] Reject expired/changed policies, mismatched replays, unsafe integer arithmetic and capacity overflow. Never call reservation amounts actual bills.
- [x] Test concurrent cross-Space cap enforcement, identical replay, mismatched replay, arithmetic boundaries, UTC rollover and outcome idempotency.

## 3. Existing authority adapter

Files: `src/routing/general-authority.ts`, `test/routing-general/authority.test.mjs`.

- [x] Implement `resolveGeneralRoutingAuthority(db,token,spaceId,operation,clock)` returning `GeneralAuthority` using the existing authority SQL and primary snapshot. Map ingest→create, search/usage→read, clear→delete.
- [x] Return immutable actual owner identity alongside actor/credential and the minimum active access expiry. Preserve personal, organization and accepted sharing semantics; never infer parent rights.
- [x] Test exact PAT restrictions, disabled owners, membership/credential/share expiry and revocation, member read versus admin write, external share read-only and personal ownership.

## 4. Shared executor and transport

Files: new general executor/API modules, `server-api.ts`, `server-mcp.ts`, `client.ts`, plugin sources, app public discovery, environment/config and native integration tests.

- [x] Validate and freeze input before any credential/provider work. Add explicit routing-protocol dispatch so existing legacy MCP semantics stay intact.
- [x] General REST and MCP call one executor: fresh authority→Space admission→global budget reservation→fresh authority/active generation→provider→durable outcomes→fresh authority/generation→bounded response.
- [x] Replays return state metadata only; failed budget/authority before I/O never dispatches. Abort/deadline checks cover every awaited boundary.
- [x] Whole-Space clear records retirement before provider deletion. A server-owned reconciliation operation can retry the same retired profile without reviving client authorization. Report logical hiding, provider acknowledgement and physical purge separately.
- [x] Add actual discovery for the routing protocol and integrate global budget reservation into the medical provider route as well. The management consent API stays usable independently of provider readiness.
- [ ] Verify local full-stack/native integration, regression tests, canonical plugin bundle, full checks and fresh agent review. Pin the source before bounded staging deployment/live synthetic validation and upload a precise handoff.

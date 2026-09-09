# Product verification — 2026-09-08

This is the historical **0.3.0** deployment record. The current **0.4.0-rc.1**
source has additional release suites and a populated sixth-migration workerd/D1
test. Current evidence and activation limits are in
[release/INTEGRATION.md](release/INTEGRATION.md). Local tests do not establish live
provider or real-user SSO acceptance.

## Current productization result

The standalone module now contains real central OAuth authentication, account provisioning, organization invitations/offboarding, personal and organization API keys, a responsive Korean console, REST and an SDK 2 MCP server. The dedicated product origin is `https://memory.allenlabs.org`; central authentication stays under `allen.company`.

| Current check | Observed result |
|---|---|
| `npm run check` | Passed: TypeScript, 171 tests, migration-source consistency and frozen deployed baseline hashes |
| Identity / canonical memory / original API | 39 / 27 / 8 passed |
| Product memory authority and pagination | 3 passed |
| Workspace provisioning, invites, members, keys, hierarchy, atomic SQL | 32 passed, including 128 nested levels and no inherited authority |
| Actual RS256 OAuth state/token/JWKS tests | 31 passed |
| UI DOM workflows | 24 passed, including draft retention and account-bound reauthentication |
| Integrated application/REST/MCP/SSO | 7 passed |
| `npm run test:d1` | Passed against the bundled Worker and actual local workerd/D1 |
| Five remote D1 migrations | All applied successfully; populated forward-upgrade also passed locally |
| Worker dry-run bundle | Passed, 1108.86 KiB / 202.98 KiB gzip |
| Browser smoke | Korean memory creation persisted; mobile organization creation and live admin directory succeeded |
| Browser layout | Desktop 1265px and mobile 390px inspected; memory-list overlap fixed; temporary viewport reset |
| Browser console errors | None observed during final smoke |
| Live OAuth client registration | HTTP 201; one public client registered for exact product callback |
| Production Worker | Version 0.3.0 deployed; Cloudflare version `16f1ae09-9280-4cff-942f-4a8b90644367` |
| Dedicated production D1 | `allenlabs-memory-production`, UUID `a186c3b4-9092-4619-97b0-cda5b99d9b5d` |
| Local deployment preflight | Passed with real dedicated database and registered public client |
| Public HTTPS smoke | Home/assets/health/metadata 200; protected APIs 401; forged Origin 403; PKCE login 302 to the correct central issuer |
| Live central auth configuration | Both allowlists appended; 14 other bindings and existing auth domains preserved |
| Live browser SSO | User authenticated and consent finalized; callback navigation blocked by the client before token exchange; end-to-end success is not claimed |

`test/d1.integration.mjs` runs the built production Worker with a real D1 binding and rate-limit binding. It first populates the four original schemas, applies the fifth hierarchy migration, and confirms prior data and revocations survive. It verifies provider-identity provisioning, nested organizations with independent ACLs, invitations, member keys, REST storage/revisions/conflicts, MCP tool listing, exact-organization offboarding and the OAuth redirect. Redirects are manual in the harness so synthetic tests never follow a login redirect to the live auth provider.

OAuth integration tests sign real RS256 test JWTs and execute callback exchange with an injected provider. They verify exact issuer/audience/client, verified-email mapping, PKCE/browser-state binding, replay, expiry, banned users, read/write scopes and session revocation. A public-key cache regression confirms separate request controllers reuse only public JWKS data and refresh stale keys. No production user authentication has been claimed by these tests.

Independent review found and fixed machine-key Space creation, personal-key organization helper access, member write-capability display, missing member-directory workflow, logout following a redirect into HTML, late secret responses overwriting a different dialog, and memory-list layout overflow. Tests exercise the regressions and all final suites pass. The reviewer reported no remaining confirmed correctness/security findings in the reviewed scope; this is not a security certification or production load test.

The registered client ID is public configuration in `wrangler.jsonc`. No client secret or refresh token was issued/stored by this browser integration. The central auth allowlists were updated live and durably in the private upstream source; its full auth CI passed. Existing origins, resources and `allen.company` identity endpoints remain intact. Private configuration was not copied into this public repository.

Deployment and diagnostics used short-lived credentials scoped to the approved personal Cloudflare account, all revoked after use. No credential was saved in this repository.

The live browser failure was reproduced independently of real authentication: a local synthetic form and ordinary link to a dummy callback are blocked, and even `/auth/callback` without query parameters returns a browser `ERR_BLOCKED_BY_CLIENT`. Normal Chrome displayed that error; the in-app browser remained on the consent document. Read-only provider metadata confirmed approval and one authorization code, with no token exchange. The deployed provider contains its exact-callback-origin CSP and 303 redirect fix; focused upstream tests passed 20/20. These findings establish a client-side navigation block, not its particular extension/policy owner. No browser protections or server security headers were weakened. Verification in a user-created ordinary browser tab remains pending.

Migration 0005 was preceded by a D1 Time Travel bookmark. All previously deployed migration bytes remain frozen, and SQL line endings are pinned to LF. Draft-expiry recovery stores text only in the current page's memory, verifies the original account and writable Space on reconnect/retry, and clears it on explicit logout or account change.

Remaining launch work: resolve/verify the browser callback block and complete live authenticated workflows; pooled billing/quotas; semantic indexing; recovery/load drills; real email/DNS and reauthentication proof; export/permanent erasure/retention; approved sharing and Zero-Access. Standard tombstones retain historical plaintext. The configured support mailbox has not been independently verified operational. Physical D1 sharding and R2 archival are proposed in `SCALING.md` and are not implemented; the current database still has its platform size limit.

The legacy application was not modified during this productization increment. Its earlier 208-test/build verification is recorded below as historical evidence; it was not rerun without a legacy code change. This file records local and deployment checks; publication and remote CI status are tracked in the pull request.

## Historical foundation verification (before this productization increment)

Source baseline: `origin/feat/saas-identity-foundation` at `b957a701a126df7ee6928a020db72566ce817962`. Local branch: `feat/saas-standard-foundation`.

## Results

| Check | Result |
|---|---|
| Standalone `saas` TypeScript check | Passed |
| Real SQLite identity tests | 39 passed |
| Real SQLite memory tests | 27 passed |
| Fetch HTTP API tests | 8 passed |
| Total standalone suite | 74 passed, 0 failed |
| Existing root typecheck | Passed across Worker, UI and plugins |
| Existing root tests | 208 passed: Worker 93 + workerd 2 + UI 22 + CLI/plugins 63 + OpenClaw 11 + artifact tests 17 |
| Existing plugin artifact verification | Passed, v3.2.1 |
| Existing root build | Passed: Worker dry-run bundle, UI client/server build |
| Actual localhost HTTP smoke | Passed: search, Korean create/update, revision conflict, delete, denied deleted read, request byte limit |
| Local workerd/D1 smoke | Passed: both SQL schemas, first-primary reads, revisions/conflicts, search, email proof, atomic revocation, unrelated personal access, deletion filtering |

The local API was stopped after its smoke test. Its SQLite data was synthetic and ephemeral. No live service was deployed or migrated.

## Reproduce the main checks

```sh
# repository root
npm ci
npm run typecheck
npm test
npm run build

# standalone module
cd saas
npm ci
npm run check
npm run dev
```

Validation used Node v24.19.0 and TypeScript 7.0.2 on Windows. The Codex environment contained Node without npm on PATH; a temporary npm 12.0.2 launcher was installed in the task's scratch `work/` directory. No machine-wide npm or Git identity setting was changed. The repository retains standard npm commands and lockfiles.

For the additional D1 smoke, root-lockfile Miniflare `5.20260811.0-alpha` ran local workerd. The exported `convertV4MiniflareOptions` adapted its configuration. SQLite parsed each schema into complete statements (including triggers); each statement was executed through a real D1 binding before service operations were exercised. This verifies local D1 execution, not a deployed D1 account, geographic replication or production load.

## Coverage and boundaries

Identity tests cover multiple emails, proof expiry/replay/cross-account use, recent reauthentication, exact live domain delegation, cascade revocation, no privilege resurrection, scoped credentials, expired/disabled identities, last-email removal, immutable bindings and all-or-nothing audit rollback. Replacement guards were verified with SQLite recursive triggers disabled.

Memory tests cover personal/organization isolation, membership/credential expiry, role and read/write policy, conditional write-time authority, post-write authority recheck, concurrent revision conflicts, history, tombstone filtering, bounded search/input, and audit atomicity. API tests cover the same service through Request/Response, input/media limits, sanitized errors and HTTP status behavior.

Independent review found embedded NUL text could cause SQL constraint errors or truncated search snippets. A new HTTP regression failed with 500 instead of 400 before the fix. The service and SQL now reject NUL in name/body/source (and service query input); ten additional memory tests plus the HTTP regression pass. The full suite and local D1 smoke were rerun after the fix.

The reviewer rechecked the scoped fix and reported the finding addressed with no new actionable findings. A final actual localhost HTTP probe confirmed NUL rejection as 400, Korean-text creation/search and missing-credential rejection; its child server was stopped afterward.

Public signup, trusted identity/session provisioning, external issuer mapping, email sending, domain DNS proof, production MCP integration, Vectorize, pooled billing, shared-memory approvals, export/physical erasure and Zero-Access remain explicit following milestones. Tombstoning retains historical plaintext and must not be described as complete erasure. No compliance or production-readiness claim is made.

At this historical foundation checkpoint, GitHub CI was configured locally but had not run remotely; no push, PR, merge or release had been performed.

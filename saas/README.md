# Memory by Allen Labs — hosted pilot

The source includes **0.4.0-rc.2** maintenance and connection fixes on top of the
integrated release kit. This source update is not a deployment or CI result. See the maintained
[release integration record](docs/release/INTEGRATION.md) for current features,
verification, activation defaults and remaining work. The latest recorded pilot
deployment there is 0.4.0-rc.1. The sections below retain the historical 0.3.0
baseline; the integration record supersedes its feature limits.

The candidate adds atomic retry receipts, capability/Space-scoped PATs, FTS5,
trash/restore, exports, explicit sharing, pooled quotas and a `/manage` console.
MCP clients/plugins can connect with PAT or central Better Auth SSO; see
[connection instructions](docs/CONNECTING.md). Email proofs use native Cloudflare
Email Service. AI extraction/hybrid search, Stripe and signed deprovisioning have
adapters and tests but require live provider configuration. A five-minute cron
performs bounded expiry cleanup; `BACKGROUND_JOBS_ENABLED=false` keeps provider
processing off and `AUTO_ERASURE_ENABLED=false` preserves retained memories.
Unavailable ingestion, index rebuild and billing controls are disabled in the UI.
The seventh, index-only migration supports cleanup; deployed migrations 1–6 retain
their exact bytes. Run `npm run check`, `npm run test:d1` and
`npm run eval:lexical` to verify the candidate. SSO templates now request their
intended identity/read/write/delete scopes explicitly. Callback failure codes
identify a fixed processing stage without exposing credentials. A Workers-only
login failure was reproduced and fixed: unsupported `redirect: 'error'` prevented
token/JWKS requests from being sent. Manual redirects with explicit 3xx rejection
now pass the actual workerd PKCE/token/JWKS/session tests; live acceptance follows
deployment.

The `saas/` module provides a Korean browser console, central sign-in, personal/team Spaces, versioned memory, organization administration, REST, and MCP on a Cloudflare Worker with dedicated D1 storage. The display name is provisional and configurable. The existing personal Worker, UI, plugins, and database remain separate.

Product origin: [memory.allenlabs.org](https://memory.allenlabs.org). Central authentication intentionally remains at [auth.allen.company](https://auth.allen.company), with OAuth issuer/API [auth-api.allen.company](https://auth-api.allen.company).

The pilot's **0.3.0** release is deployed at [memory.allenlabs.org](https://memory.allenlabs.org) as Worker version `16f1ae09-9280-4cff-942f-4a8b90644367`. All five remote migrations are applied to dedicated D1 database `a186c3b4-9092-4619-97b0-cda5b99d9b5d`. The central SSO origin/resource allowlists are configured on the existing authentication platform, and its durable source/configuration change has passing upstream CI. This is not a GA-readiness claim. Operational credentials are restricted to the approved personal Cloudflare account. Never copy credentials into this repository or logs.

A complete real-user SSO login has **not** passed. The latest attempt recorded approved provider consent and an issued but unconsumed authorization code. The controlled in-app browser and Chrome reported `ERR_BLOCKED_BY_CLIENT` for `/auth/callback`, including requests with no parameters or synthetic credentials. This observed client-side request block does not establish a server-side SSO defect. An ordinary Chrome test outside the controlled browser session is pending; no security protections were disabled. The 0.3.0 public HTTP smoke check passed on 2026-09-08 at 09:22 UTC: 200 for the home page, health, and assets, 401 for protected endpoints, and a 302 login redirect to the correct issuer.

## Run and verify

Use Node 24.19.0, or another version supported by `package.json`:

```sh
cd saas
npm ci
npm run check
npm run test:d1
npm run dev:console
```

The console opens at [127.0.0.1:8792](http://127.0.0.1:8792) with synthetic data and a 15-minute local session. All data resets on restart. Set `MEMORY_CONSOLE_PORT` to change the port; stop with Ctrl+C. This preview bypasses real SSO and does not verify hosted login or provider logout. Its bootstrap code is excluded from the Worker.

`npm run dev` retains the earlier API-only demo at [127.0.0.1:8790](http://127.0.0.1:8790); synthetic connection details are written to git-ignored `.local/demo.json`. Both demos bind only to localhost and reject foreign Host/Origin headers.

`check` runs TypeScript, explicit SQLite/auth/HTTP/UI suites, and migration consistency checks. The 0.3.0 verification passed all **171 tests**, typechecking, migration checks, and the actual local Miniflare/workerd D1 integration run. `test:d1` builds the Worker and exercises a populated forward migration and independent nested-organization access on that local D1 path. The dedicated [CI workflow](../.github/workflows/saas.yml) is configured; these local SaaS results are separate from the passing central-auth upstream CI. See the [verification record](docs/VERIFICATION.md) for evidence and limits.

## Identity and access

Browser SSO uses authorization code with S256 PKCE, server-held one-use state, browser binding, and verified RS256 access tokens. Issuer, service audience, client binding, token type, and expiry are checked exactly. This provider flow does not assume OIDC ID tokens; the application neither stores nor renews refresh tokens.

Browser sessions use Secure, HttpOnly, SameSite=Lax cookies and last at most 15 minutes, bounded by provider-token expiry. Cookie mutations require the exact same Origin. The provider supplies no `auth_time`: callback time and token refresh are not recent reauthentication, and ordinary sign-in does not unlock sensitive email/domain proof operations.

If a session expires while editing, the open page retains the draft temporarily and pauses writes. Reconnecting and retrying require the same account and current write access to the original Space; revision checks still apply. Drafts remain only in the page's memory, never localStorage or sessionStorage. Reloading or closing the page loses them; explicit logout or reconnecting as another account clears them.

Accounts map to exact issuer + subject, never an email-based account merge. Independently verified email claims bind organization memberships. Revoking a claim or membership removes its derived organization access and keys while preserving the personal account and unrelated claims. Authorization uses current database state, including roles, disablement, revocation, and expiry.

Owners/admins can write team memories, invite members, list current members, and offboard them; members can read. Invitations expire after 72 hours, are single-use, and require the exact invited verified email and a still-authorized inviter. Codes are shared manually; no invitation email is sent. Last-owner removal is guarded. Membership removal revokes derived organization keys, not the person's personal account.

Organizations can nest without a fixed product depth cap; a chain of 128 child levels is covered by tests. Each organization has independent permissions: parent/child relationships grant no memory, membership, key, or administrative access. Creating a child requires current owner/admin access to its immediate parent, and the creator owns the child through their selected live verified email. Parents are immutable in this release; moving, reparenting, and deleting organizations are unavailable. Workspace results include only explicit current memberships and expose `parentId` only when the parent is also accessible, otherwise null.

Machine keys have `read` or `write` permission and a 1–90 day lifetime. Personal keys are account-bound; organization keys are bound to the exact membership/email claim. Keys and invitation codes appear once; only digests persist. The UI keeps no tokens in browser storage.

Machine keys and external OAuth bearer grants can list authorized Spaces and access memory data. They cannot create Spaces, read the management workspace snapshot, or administer organizations, memberships, or keys. These operations require an interactive browser session. Billing ownership grants no data authority.

## HTTP and MCP

REST accepts browser session cookies or authorized Bearer credentials. JSON writes use `Content-Type: application/json`; cookie writes also require the same-origin `Origin` header. MCP accepts Bearer credentials only, never browser cookies.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/`, `/assets/app.js`, `/assets/app.css` | Console shell and local assets; strict CSP |
| GET | `/health` | Version/liveness only, not database or SSO readiness |
| GET | `/auth/login`, `/auth/callback` | Central sign-in and one-use callback |
| POST | `/auth/logout` | Revoke browser session and redirect |
| GET | `/.well-known/oauth-protected-resource` | Resource/audience metadata; `/mcp` suffix also supported |
| GET | `/v1/workspace` | Account, claims, accessible Spaces, organizations, key metadata |
| GET / POST | `/v1/spaces` | List accessible Spaces / create `{name, organizationId?, securityMode: "managed"}` |
| GET | `/v1/spaces/:spaceId/memories` | `{results, nextCursor?}`; optional `limit` and opaque `cursor` |
| GET | `/v1/spaces/:spaceId/memories?query=...` | Bounded keyword snippets; optional `limit`, no cursor |
| POST | `/v1/spaces/:spaceId/memories` | Create `{body, source?}` at revision 1 |
| GET / PATCH / DELETE | `/v1/spaces/:spaceId/memories/:id` | Read, update `{body, source?, expectedRevision}`, or delete `{expectedRevision}` |
| POST | `/v1/organizations` | Create `{name, emailId, parentOrganizationId?}` and a default team Space |
| POST | `/v1/organizations/:id/invites` | Issue `{email, role: "member" or "admin"}` invitation |
| GET | `/v1/organizations/:id/members` | Owner/admin list of current members |
| DELETE | `/v1/organizations/:id/memberships/:membershipId` | Offboard membership and revoke derived keys |
| POST | `/v1/invitations/accept` | Accept `{token}` using the matching email claim |
| POST / DELETE | `/v1/keys`, `/v1/keys/:id` | Issue `{label, organizationId?, permission, expiresInDays}` / revoke key |
| POST | `/mcp` | Stateless MCP at the same live memory authority boundary |

MCP uses the pinned `@modelcontextprotocol/server` **2.0.0** SDK with stateless legacy transport compatibility tested against protocol `2025-11-25`. It exposes seven tools: `memory_spaces`, `memory_list`, `memory_search`, `memory_get`, `memory_add`, `memory_update`, and `memory_delete`. Start with `memory_spaces`; agent connections use `https://memory.allenlabs.org/mcp` and `Authorization: Bearer <key-or-OAuth-access-token>`. Retries of `memory_add` can create duplicates.

Request limits are 24 KiB JSON, 16 KiB UTF-8 memory body, and 2 KiB UTF-8 source. Space names allow 100 characters, queries 256, list/search limits 1–50, and snippets at most 500 characters. NUL text is rejected. Updates/deletes require the current revision.

Errors are sanitized: 400 invalid input, 401 authentication required/expired, 403 denied resources or scope, 404 unknown route, 405 unsupported method, 409 revision conflict, 413 oversized request, 415 wrong media type, 421 wrong host, and 429 throttling with `Retry-After: 60`. Responses disable caching; errors/audit must not expose memory text, secrets, or SQL. The edge limiter is not pooled billing quota accounting.

## Storage and deployment

Standard stores service-readable plaintext. `zero_access` is rejected; no simulated encryption or compliance certification is claimed. Search is literal substring search, not semantic retrieval; exact Korean substrings work and SQLite case folding is ASCII-based.

Conditional SQL writes enforce live permissions and preserve prior versions plus identifier-only audit atomically. Deletion is a tombstone: normal reads/search hide the record, but content/history remain. This is **not physical erasure**, including from backups. Post-write reads check authority again; a write may commit before a concurrent revocation prevents its response.

The deployed `DB` binding targets the dedicated `allenlabs-memory-production` database, separate from the legacy personal database. All five migrations are applied remotely in order: `0001_schema.sql`, `0002_memory-schema.sql`, `0003_product-schema.sql`, `0004_auth-schema.sql`, and forward migration `0005_hierarchy-schema.sql`. The first four migration files remain byte-identical. `npm run db:local` applies numbered migrations locally. Migration checks freeze the deployed baseline hashes, existing migration files cannot be regenerated, and Git attributes pin SQL files to LF. Future schema changes require new forward migrations before compatible code deployment.

`npm run build` is a dry-run bundle. The pilot's D1 binding, custom domain, public OAuth client, and additive central-auth origin/resource allowlists are configured. Preserve existing provider entries and the separate personal service during future rollout. `preflight` validates configuration, `db:remote` applies migrations, and `deploy` checks/preflights before publishing; deployment does not automatically migrate D1. Invocation logs remain disabled because callback URLs carry codes. Follow [OPERATIONS.md](docs/OPERATIONS.md), including backup restoration and revocation reconciliation, before remote changes.

## Change the product name

Edit only these display variables in `wrangler.jsonc`, then run checks/build and redeploy:

| Variable | Purpose / validation |
| --- | --- |
| `PRODUCT_NAME` | Full title, 1–80 characters |
| `PRODUCT_SHORT_NAME` | Sidebar name, 1–30 characters |
| `PRODUCT_DESCRIPTION` | Description/metadata, 1–240 characters |
| `PRODUCT_SUPPORT_EMAIL` | Valid support email address |
| `PRODUCT_ACCENT_COLOR` | Six-digit hex color, e.g. `#276747` |

Brand text is escaped and control characters are rejected. Keep `SERVICE_ID`, issuer, service origin/audience, OAuth client ID/callback, cookie names, MCP tool names, database IDs, and account mappings stable during a display rename. A rename integration test verifies branding can change while stored accounts, Spaces, and memory remain accessible.

## Following milestones

Billing/payments and pooled quota accounting; user export and physical erasure/retention; operated email/DNS proofs and genuine recent reauthentication; approved personal-to-team sharing; rebuildable Vectorize/embedding search; a separately designed Zero-Access client/key workflow; provider-wide deprovisioning and tested account/backup recovery drills remain future work. Storage currently uses one dedicated D1 database; sharding is not implemented. Live user SSO verification is still outstanding.

See the [product design](../docs/superpowers/specs/2026-09-08-productization-design.md), [implementation plan](../docs/superpowers/plans/2026-09-08-productization.md), [operations runbook](docs/OPERATIONS.md), and [verification record](docs/VERIFICATION.md).

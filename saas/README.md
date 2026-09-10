# Memory by Allen Labs — hosted pilot

**0.4.0-rc.3** is deployed at [memory.allenlabs.org](https://memory.allenlabs.org).
The PR source is **0.4.0-rc.4**, including review fixes and forward migrations 8–21;
this candidate has not been deployed. Apply migrations 8–21 before deploying it;
the candidate readiness check requires schema 21. The current full local check
passes 1,410 tests; native evidence and remaining acceptance gates are scoped in
the integration record below.
Real-account SSO now reaches the authenticated management console. See the
[rc.3 corrections](docs/release/RC3_FIXES.md) for account-switching, retry,
revocation and SCIM fixes. The maintained
[release integration record](docs/release/INTEGRATION.md) records the current
features, verification and remaining work. This README describes the current
release; older deployment records are retained in that integration record and
[VERIFICATION.md](docs/VERIFICATION.md).
Post-deployment PR corrections and their review status are recorded in the
[independent review loop](docs/release/REVIEW_LOOP.md).

The candidate adds atomic retry receipts, capability/Space-scoped PATs, FTS5,
trash/restore, exports, explicit sharing, pooled quotas and a `/manage` console.
Space managers can inspect issued shares with `GET /v1/spaces/:spaceId/shares`
to recover an uncertain creation response. Share creation is not idempotent:
refresh the list and inspect/revoke unwanted grants before creating another.
See the [API contract](docs/release/API.ko.md) and
[recovery procedure](docs/OPERATIONS.md#outbound-share-recovery).
MCP clients/plugins can connect with PAT or central Better Auth SSO; see
[connection instructions](docs/CONNECTING.md). Email proofs use native Cloudflare
Email Service. AI extraction/hybrid search, Stripe and signed deprovisioning have
adapters and tests but require live provider configuration. A five-minute cron
performs bounded expiry cleanup; `BACKGROUND_JOBS_ENABLED=false` keeps provider
processing off and `AUTO_ERASURE_ENABLED=false` preserves retained memories.
Unavailable ingestion, index rebuild and billing controls are disabled in the UI.
The candidate also preserves one-time dialog results while issuance is pending,
reconciles approved/cancelled extraction cards across refreshes, and disables
restoration when the server reports an expired retention period. Uncertain
creation or share responses, including mutation 5xx responses, require checking
the workspace or outgoing-share list before repeating creation. The release
editor accepts the API's 1,024-byte search limit; the foundation editor retains
its 256-character input limit.
An older edit response cannot clear a newer draft, including when only a write
receipt is returned. Confirmed share revocation survives delayed list responses;
a fresh read supplies the stored revocation timestamp.
SCIM, export and billing-portal issuance buttons remain locked while their
request is pending, preventing accidental duplicate issuance.
The seventh, index-only migration supports cleanup; all seven deployed migrations retain
their exact bytes. Run `npm run check`, `npm run test:d1` and
`npm run eval:lexical` to verify the candidate. SSO templates now request their
intended identity/read/write/delete scopes explicitly. Callback failure codes
identify a fixed processing stage without exposing credentials. A Workers-only
login failure was reproduced and fixed: unsupported `redirect: 'error'` prevented
token/JWKS requests from being sent. Manual redirects with explicit 3xx rejection
pass the actual workerd PKCE/token/JWKS/session tests and live SSO acceptance.

The `saas/` module provides a Korean browser console, central sign-in, personal/team Spaces, versioned memory, organization administration, REST, and MCP on a Cloudflare Worker with dedicated D1 storage. The display name is provisional and configurable. The existing personal Worker, UI, plugins, and database remain separate.

Product origin: [memory.allenlabs.org](https://memory.allenlabs.org). Central authentication intentionally remains at [auth.allen.company](https://auth.allen.company), with OAuth issuer/API [auth-api.allen.company](https://auth-api.allen.company).

The dedicated D1 database is `a186c3b4-9092-4619-97b0-cda5b99d9b5d`, with migrations 1–7 applied. The central SSO origin/resource allowlists are configured on the existing authentication platform. Operational credentials are restricted to the approved personal Cloudflare account. Never copy credentials into this repository or logs.

Real-account SSO was verified on 2026-09-09 after the rc.2 fix: approval returned
to Memory and loaded the authenticated personal Space and verified email. Earlier
controlled-browser failures are superseded by this result. No browser or provider
security protection was disabled. Live email receipt and PAT issuance after email
proof remain to be verified.

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

`check` runs TypeScript, SQLite/auth/HTTP/UI suites, release regressions, client templates and migration consistency checks. `test:d1` builds the Worker, exercises populated forward migrations and runs native workerd authentication/HTTP checks. The dedicated [CI workflow](../.github/workflows/saas.yml) runs both commands. Current totals and live acceptance evidence are recorded separately in the [release integration record](docs/release/INTEGRATION.md).

## Identity and access

Browser SSO uses authorization code with S256 PKCE, server-held one-use state, browser binding, and verified RS256 access tokens. Issuer, service audience, client binding, token type, and expiry are checked exactly. This provider flow does not assume OIDC ID tokens; the application neither stores nor renews refresh tokens.

Browser sessions use Secure, HttpOnly, SameSite=Lax cookies and last at most 15 minutes, bounded by provider-token expiry. Cookie mutations require the exact same Origin. The provider supplies no `auth_time`: callback time and token refresh are not recent reauthentication, and ordinary sign-in does not unlock sensitive email/domain proof operations.

If a session expires while editing, the open page retains the draft temporarily and pauses writes. Reconnecting and retrying require the same account and current write access to the original Space; revision checks still apply. Drafts remain only in the page's memory, never localStorage or sessionStorage. Reloading or closing the page loses them; explicit logout or reconnecting as another account clears them.

Accounts map to exact issuer + subject, never an email-based account merge. Independently verified email claims bind organization memberships. Revoking a claim or membership removes its derived organization access and keys while preserving the personal account and unrelated claims. Authorization uses current database state, including roles, disablement, revocation, and expiry.

Owners/admins can write team memories, invite members, list current members, and offboard them; members can read. Invitations expire after 72 hours, are single-use, and require the exact invited verified email and a still-authorized inviter. Codes are shared manually; no invitation email is sent. Last-owner removal is guarded. Membership removal revokes derived organization keys, not the person's personal account.

Organizations can nest without a fixed product depth cap; a chain of 128 child levels is covered by tests. Each organization has independent permissions: parent/child relationships grant no memory, membership, key, or administrative access. Creating a child requires current owner/admin access to its immediate parent, and the creator owns the child through their selected live verified email. Parents are immutable in this release; moving, reparenting, and deleting organizations are unavailable. Workspace results include only explicit current memberships and expose `parentId` only when the parent is also accessible, otherwise null.

PATs have explicit `read`, `create`, `update`, `delete` and/or `export` capabilities, optional exact Space restrictions and a 1–90 day lifetime. Issuance requires an interactive session with an email proof completed within five minutes. The legacy `permission: read/write` input remains compatible; use explicit capabilities for new integrations. Personal keys are account-bound; organization keys are bound to the exact membership/email claim. Keys and invitation codes appear once; only digests persist. The UI keeps no tokens in browser storage.

Machine keys and external OAuth bearer grants can list authorized Spaces and access memory data. They cannot create Spaces, read the management workspace snapshot, or administer organizations, memberships, or keys. These operations require an interactive browser session. Billing ownership grants no data authority.

## HTTP and MCP

REST accepts browser session cookies or authorized Bearer credentials. JSON writes use `Content-Type: application/json`; cookie writes also require the same-origin `Origin` header. MCP accepts Bearer credentials only, never browser cookies.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/`, `/manage`, `/assets/*` | Editor, management console and local assets; strict CSP |
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
| POST / DELETE | `/v1/keys`, `/v1/keys/:id` | Issue `{label, organizationId?, capabilities, spaceIds?, expiresInDays}` after recent proof / revoke key |
| POST | `/mcp` | Stateless MCP at the same live memory authority boundary |

MCP uses the pinned `@modelcontextprotocol/server` **2.0.0** SDK with stateless transport compatibility. It exposes eight tools: `memory_spaces`, `memory_list`, `memory_search`, `memory_get`, `memory_add`, `memory_update`, `memory_delete`, and `memory_ingest`. Ingestion requires configured, enabled providers. Start with `memory_spaces` for a read-capable credential; agent connections use `https://memory.allenlabs.org/mcp` and `Authorization: Bearer <key-or-OAuth-access-token>`. MCP mutations require `operationId`: reuse the same ID and input when retrying a lost response. REST mutations accept `operationId` or `Idempotency-Key`; omitting both generates a new operation and cannot deduplicate a client retry. See the [complete release API](docs/release/API.ko.md) for retention, trash, exports, sharing and management paths.

Release API requests allow 64 KiB of JSON; the foundation organization/workspace APIs retain a 24 KiB JSON limit. Memory bodies allow 16 KiB UTF-8 and sources allow 2 KiB UTF-8. Canonical conversation-ingest messages have a separate 24,000-byte JSON limit. Space names allow 100 characters; release search queries allow 1,024 UTF-8 bytes. Space/memory list limits are 1–100 and search limits are 1–50. NUL text is rejected. Updates/deletes require the current revision.

Errors are sanitized: 400 invalid input, 401 authentication required/expired, 403 denied resources or scope, 404 unknown route, 405 unsupported method, 409 revision conflict, 413 oversized request, 415 wrong media type, 421 wrong host, and 429 throttling with `Retry-After: 60`. Responses disable caching; errors/audit must not expose memory text, secrets, or SQL. The edge limiter is not pooled billing quota accounting.

## Storage and deployment

Standard stores service-readable plaintext. `zero_access` is rejected; no simulated encryption or compliance certification is claimed. Search uses tenant-filtered FTS5 token-prefix matching with local match-density ranking. Queries allow 1,024 UTF-8 bytes and process at most 20 distinct terms; each processed term must be at most 31 Unicode characters. Longer terms return `400 search_token_too_long` before usage is charged. This explicit limit keeps every supported prefix on an index; ranking does not use other tenants’ document statistics. Optional AI/Vectorize adds hybrid retrieval; without those providers the service returns lexical results and a degraded-mode reason. Queries and stored bodies use Unicode61 tokenization without query-only NFKC conversion; fullwidth/ligature words remain searchable, and ASCII compatibility variants remain distinct. Arbitrary substring matching is not the release search contract.

Conditional SQL writes enforce live permissions and preserve prior versions plus identifier-only audit atomically. Normal deletion is a tombstone: normal reads/search hide the record, but content/history remain. A separate recently reauthenticated erasure removes the memory payload and prior versions; identifier/audit records and backups are outside that operation. Automatic retention erasure remains disabled in the deployed pilot. Post-write reads check authority again; a write may commit before a concurrent revocation prevents its response.

The deployed `DB` binding targets the dedicated `allenlabs-memory-production` database, separate from the legacy personal database. Migrations 1–7 are applied remotely and remain byte-identical. The candidate adds forward migrations for checkout recovery, resumable indexing/vector deletion, confirmed provider receipts, SCIM history, tenant-scoped lookup/pagination, durable reconciliation, execution-time deadline checks, and atomic domain verification with retained proof history. Apply every remaining numbered migration through `0021_domain-retention-schema.sql` before deploying rc.4; the [deployment table](docs/release/DEPLOYMENT.ko.md) lists the current prerequisites. `npm run db:local` applies numbered migrations locally. Migration checks freeze deployed baseline hashes, existing migration files cannot be regenerated, and Git attributes pin SQL files to LF. Future schema changes require new forward migrations before compatible code deployment.

Deadline admission uses the later of the application-bound time and the database
statement's execution time. Waiting in the database queue cannot extend a
credential, membership, proof, restoration window, ingest lifetime or lease so
that it authorizes a later mutation. Migration 19 preserves recorded timestamps
and immutable history, and makes recent-proof consumption and the credential's
reauthentication timestamp update one atomic trigger operation.

Migration 20 commits DNS proof consumption, domain creation/renewal and the exact
manager assignment with one immutable verification receipt. An authorized retry
returns its original `verifiedUntil` without another DNS check or extension.
Accepted provider email revocation invalidates pending proofs for that exact
account/address; standing blocks prevent their reuse. Migration 21 indexes only
unused DNS challenges for bounded expiry cleanup; consumed proofs and immutable
receipts remain. See the [API contract](docs/release/API.ko.md) for replay conditions.

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

Live email receipt and PAT issuance, external MCP-client installation, AI/payment/webhook acceptance, load tests and recovery drills remain outstanding. Pooled quotas, export, explicit sharing and individual-memory erasure are implemented; they do not establish a complete account-deletion or backup-erasure workflow. Zero-Access and physical D1 sharding/R2 offload remain unimplemented. Storage currently uses one dedicated D1 database and retains its per-database 10 GB limit. Real-account browser SSO has passed; the service remains a pilot.

See the [product design](../docs/superpowers/specs/2026-09-08-productization-design.md), [implementation plan](../docs/superpowers/plans/2026-09-08-productization.md), [operations runbook](docs/OPERATIONS.md), and [verification record](docs/VERIFICATION.md).

# Operations runbook

The deployment record below describes 0.3.0. The latest recorded 0.4.0-rc.2
deployment and the 0.4.0-rc.2 source changes are documented in
[release/INTEGRATION.md](release/INTEGRATION.md). Cloudflare Email
proof delivery is covered in [release/EMAIL.md](release/EMAIL.md). Treat these
current documents as the source of truth for release behavior; retain this prior
deployment record for recovery context.

## 0.4.0-rc.2 maintenance and diagnosis

The source configures `*/5 * * * *` for expired transient-state cleanup. Each
invocation processes at most 100 rows per cleanup category: ingest payloads,
export sessions, domain/reauthentication challenges and past-day mail budgets.
Expiry is checked by request authorization independently of the sweep, so a
backlog does not extend a credential or challenge lifetime. Immutable identity
and audit records are retained. Apply the index-only forward migration
`0007_maintenance-schema.sql` before deploying this code; migrations 1–6 remain
byte-frozen. This section does not assert that migration 7 or this code is live.

Keep `BACKGROUND_JOBS_ENABLED=false` and `AUTO_ERASURE_ENABLED=false` for the
current pilot configuration. The cron does not dispatch AI/vector/ingestion or
billing jobs with the first switch off, and does not erase retained memories with
the second switch off. Explicit, recently reauthenticated erasure is separate.
Enabling provider processing requires its bindings/secrets and acceptance checks;
unconfigured ingestion, index rebuild and billing controls remain disabled.
`/ready` accepts a successful maintenance heartbeat younger than 15 minutes but
still requires provider processing and all other readiness checks for HTTP 200.
A cleanup heartbeat alone is not GA readiness.

Browser authentication failures return HTTP 400 with an `X-Auth-Failure` code such
as `AUTH_CALLBACK_VALIDATION`, `AUTH_FLOW_CLAIM`, `AUTH_TOKEN_EXCHANGE_403`,
`AUTH_TOKEN_RESPONSE`, `AUTH_TOKEN_VERIFICATION` or `AUTH_WORKSPACE_SIGN_IN`.
Record the fixed code and time when diagnosing a failed attempt. The optional
numeric suffix is an upstream HTTP status; it is not the callback response status.
Do not collect authorization codes, JWTs, cookies or full callback URLs. Request
logging remains disabled. The observed real-user SSO failure is still under
investigation; these diagnostics do not establish or fix its cause. MCP client
scope configuration is covered in [CONNECTING.md](CONNECTING.md).

## Historical 0.3.0 runbook

This runbook covers the Standard memory Worker in `saas/`, deployed at `https://memory.allenlabs.org`. Release 0.3.0 and its fifth migration are deployed; the service remains a hosted pilot rather than production GA. Real-user browser login remains unverified. The 0.3.0 public HTTP smoke check passed on 2026-09-08 at 09:22 UTC. Central-auth upstream CI is green; that result is separate from this SaaS module's passing local checks.

## Deployment record — 2026-09-08

| Item | Confirmed state |
| --- | --- |
| Live domain | `https://memory.allenlabs.org` |
| Product / Worker deployment version | `0.3.0` / `16f1ae09-9280-4cff-942f-4a8b90644367` |
| Dedicated production D1 UUID | `a186c3b4-9092-4619-97b0-cda5b99d9b5d` |
| Remote migrations | All five applied: identity, memory, product, auth, and forward hierarchy migration `0005_hierarchy-schema.sql` |
| Cloudflare account | Approved personal account configured for this deployment |
| Central-auth live settings | Additive trusted-origin/resource update completed; 14 other bindings and existing auth domains preserved |
| Durable central-auth configuration | Source allowlists and generated types updated; full upstream CI passed |
| Local 0.3.0 validation | 171 tests, TypeScript, frozen migration checks, and bundled local workerd/D1 integration passed |
| Public HTTP verification | 0.3.0 passed at 2026-09-08 09:22 UTC: home/health/assets 200, protected endpoints 401, login 302 to the correct issuer |
| Outstanding user verification | Hosted SSO completion; ordinary Chrome test outside the controlled browser session pending |

The earlier remote D1 permission error was resolved for this deployment using authorized temporary credentials. The deployment used one-hour account tokens scoped to D1 Write, Workers Scripts Write, and Account Settings Read, plus zone permissions restricted to `allenlabs.org` for Zone Read and Workers Routes Write. All temporary deployment tokens were revoked after use.

Deployment and diagnostics used short-lived, account-scoped temporary credentials, all revoked after use. No credential was saved in this repository. Future remote maintenance requires a newly authorized credential; revoked deployment tokens are not reusable.

## Service and identity boundaries

| Purpose | Address or identifier |
| --- | --- |
| Service origin and OAuth resource/audience | `https://memory.allenlabs.org` |
| Browser callback | `https://memory.allenlabs.org/auth/callback` |
| MCP endpoint | `https://memory.allenlabs.org/mcp` |
| Protected-resource metadata | `https://memory.allenlabs.org/.well-known/oauth-protected-resource` |
| Existing central authentication UI | `https://auth.allen.company` |
| Existing OAuth issuer and API | `https://auth-api.allen.company` |
| Stable Worker/protocol service ID | `allenlabs-memory` |
| Dedicated production D1 database name / binding | `allenlabs-memory-production` / `DB` |

The identity platform intentionally keeps its existing `allen.company` domains. Do not migrate the issuer to a marketing domain. The separate legacy personal service at `https://memory.allenlim.net` and its database must remain intact; never bind this SaaS Worker to the legacy database.

The public OAuth client has already been registered through central dynamic client registration (DCR); its ID is recorded as `SSO_CLIENT_ID` in `wrangler.jsonc`. It uses authorization code with S256 PKCE, `token_endpoint_auth_method: none`, and the exact callback above. There is no client secret to invent, persist, or add to the Worker.

The central-auth operator has appended the service origin to live `TRUSTED_ORIGINS` and `https://memory.allenlabs.org` to live `OAUTH_PROTECTED_RESOURCES` with the intended `memory:read`, `memory:write`, and `memory:delete` resource scopes. This additive settings update preserved the existing `https://memory.allenlim.net` entries, 14 other bindings, and `auth-api.allen.company` / `auth.allen.company`. The durable private upstream main configuration and generated types are recorded above, with full CI passing. For future changes, preserve the provider's existing configuration format and entries; do not replace either allowlist with this service alone or publish the full private configuration. Browser redirect and issued-token audience checks remain part of live sign-in verification.

The current provider expires dynamically registered clients after 90 days of inactivity. Treat the DCR client as operationally maintained configuration, not a permanent registration. Before reviving an idle installation, verify that the client still exists. If it expired, register a new public client using the same callback/grants/scopes and update `SSO_CLIENT_ID`, or arrange a deliberately persistent registration with the central-auth operator. Do not repeatedly register duplicate clients on every deploy. Changing the client ID does not change the exact issuer/subject account mapping.

## Validate the release locally

Run these commands from the repository root using Node 24.19.0, or another version explicitly supported by `saas/package.json`:

```sh
cd saas
npm ci
npm run types
npm run check
npm run test:d1
```

`npm run types` runs `wrangler types worker-configuration.d.ts --strict-vars=false`; review generated binding changes. `npm run check` runs strict typechecking, the explicit SQLite/auth/UI/HTTP test suites, and migration-source consistency checks. `npm run test:d1` first performs the dry-run Worker build, then runs the bundled Worker against local Miniflare/workerd and D1. It covers a populated four-to-five migration upgrade, independent nested organizations, provisioning, invitations, machine keys, memory revisions, MCP, and exact-organization offboarding. The 0.3.0 run passed all 171 tests and these runtime checks. Tests use synthetic local data; they do not verify live SSO, remote D1 permissions, DNS, or production readiness.

Additional existing scripts:

| Command | Purpose |
| --- | --- |
| `npm run build` | Bundle dry run into `.local/build`; does not deploy |
| `npm run db:local` | Apply numbered migrations to local Wrangler D1 |
| `npm run dev:console` | Ephemeral console at `http://127.0.0.1:8792`, with a synthetic 15-minute session |
| `npm run dev` | Separate legacy foundation demo at `http://127.0.0.1:8790` |
| `npm run migrations:check` | Verify schema/migration consistency and exact frozen baseline hashes |

The console/demo modules are local-only and are not Worker entry points. Never copy their synthetic sessions or bootstrap users into hosted storage.

## Bootstrap reference and subsequent deployments

Initial bootstrap is complete. Do not recreate `allenlabs-memory-production`, replace its UUID, or rerun database creation for this live installation. Its current `DB` binding must remain `a186c3b4-9092-4619-97b0-cda5b99d9b5d`. Never substitute the legacy personal-service database.

For reference, bootstrap created a dedicated D1 database, recorded the returned UUID in `wrangler.jsonc`, verified the account/custom domain, and applied all four initial migrations before deployment. A separately approved new environment needs its own distinct database name, UUID, and bindings; `npx wrangler d1 create <new-database-name>` is the CLI creation path for such an environment. Do not use it to recreate the existing production database. [Cloudflare D1 command reference](https://developers.cloudflare.com/d1/wrangler-commands/).

For subsequent releases, obtain fresh authorized credentials scoped to the intended personal account and exact zone. Complete the local validation above, review any forward migrations, and verify the existing `DB` UUID before a remote change. Preserve `database_name: allenlabs-memory-production`, `migrations_dir: migrations`, `PUBLIC_ORIGIN`, the registered `SSO_CLIENT_ID`, and the exact custom-domain route. Keep `workers_dev: false`, `preview_urls: false`, and `observability.enabled: false`.

```sh
npm run types
npm run preflight
npm run db:remote
npm run deploy
```

`preflight` checks local configuration, including the real D1 UUID, client ID, custom domain, alternate-host restrictions, and disabled invocation logging. It does not call the provider or prove remote readiness. `db:remote` runs preflight and applies migrations with `wrangler d1 migrations apply DB --remote`. `deploy` runs check and preflight before `wrangler deploy`; it does not apply D1 migrations or run `test:d1` for you. Stop on any failing command and inspect which remote migrations, if any, were applied before retrying.

All five migrations are now applied remotely in order. Migration 0005 adds the hierarchy without changing the first four migration files or their existing data. `migrations:check` verifies the original baseline's SHA-256 hashes, and `.gitattributes` pins SQL files to LF. `migrations:sync` can create a missing new forward migration but refuses to rewrite an existing migration. Add reviewed forward migrations; never regenerate or edit an already applied file to change production schema. Apply a required migration before deploying code that queries its new tables. A code rollback also requires compatible database schema. Revoke temporary maintenance tokens after the authorized work and verify cleanup.

The latest real-user sign-in attempt remains incomplete. Provider-side evidence shows approved consent and an authorization code issued but not consumed. The controlled in-app browser and Chrome reported `ERR_BLOCKED_BY_CLIENT` for `/auth/callback`, including requests without parameters or with synthetic credentials. This observed client-side block does not establish a broken server-side SSO implementation. An ordinary Chrome test outside the controlled browser session is pending. No security protections were disabled during diagnosis; do not log or copy real callback codes while investigating.

The 0.3.0 public check passed at 2026-09-08 09:22 UTC: home, health, and assets returned 200, protected endpoints returned 401, and login returned 302 to `auth-api.allen.company`. Live authenticated checks still need to verify browser login/callback/logout, personal Space isolation, independent parent/child access, member read versus admin write, invitation acceptance, machine-key REST/MCP access and revocation, and membership removal with exact derived-key denial. Record the deployment version, migration state, test time, and actual results. Do not infer user-login success from provider consent, local tests, public liveness, or deployment alone.

## Daily operation and security

`GET /health` reports process liveness and version. It performs no D1 query, provider verification, or authenticated operation and is not a readiness check. Investigate login failures, database errors, and application denials independently of a healthy liveness response.

The `REQUEST_LIMITER` binding currently allows 120 calls per 60 seconds per key at a Cloudflare location. Application keys separate auth/pre-auth IP controls and authenticated account controls. These counters are eventually consistent and local to a point of presence; they are not a global billing quota or exact accounting system. A 429 response includes `Retry-After: 60`. [Cloudflare rate-limit behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Keep Worker invocation/request logging disabled: OAuth callback query strings contain authorization codes. Do not enable broad `wrangler tail`, URL/header capture, tracing, or request-body logging for a login incident. Never log cookies, authorization headers, raw provider tokens, invitation/key secrets, or memory bodies. Use sanitized status counts, request IDs, and identifier-only audit records. Current raw provider bearer tokens are verified in memory and stored only as SHA-256 digests; opaque browser sessions and machine keys also persist digest-only. Keep Cloudflare credentials in their approved credential store, outside repository files and diagnostics.

Browser cookies are Secure, HttpOnly, and SameSite=Lax. Sessions last at most 15 minutes and never beyond the verified provider token expiry; users must sign in again after expiry. The provider supplies no `auth_time`. Refresh, sign-in callback time, or token use must not be substituted for verified recent reauthentication. `reauthenticated_at` remains NULL for these sessions, so sensitive email-link/unlink and delegated domain-revocation workflows remain unavailable through ordinary hosted sign-in.

The editor temporarily retains an unsaved draft in the open page when a session expires. Reconnection and write retries verify the original account and current write access to the original Space; optimistic revision checks still apply. This is ephemeral page memory, not localStorage, sessionStorage, or a durable draft service. Reloading or closing the page loses the draft. Explicit logout or reconnection under another account clears it.

Organizations may nest with no fixed product depth cap; SQLite tests exercise 128 child levels. Each organization's membership and memory permissions remain independent. Only a current owner/admin of the immediate parent may create a child, and the creator becomes its owner through their selected live email claim. Parent/child relationships grant no authority and do not extend key scope or revocation cascades. The parent is immutable after creation; no move, delete, or reparent workflow exists. Workspace snapshots disclose parent IDs only when the caller also has current explicit parent membership.

Machine keys are shown once and expire after 1–90 days. Revoke an exposed key by identifier, then issue a replacement. Organization keys remain bound to the exact membership/email claim; removing that authority cascades revocation. Do not clear `revoked_at`, rewrite a claim binding, or restore an expired/revoked external bearer credential to resolve an access complaint. Investigate current account, organization, claim, membership, credential expiry, and role first.

Display-only changes use `PRODUCT_NAME`, `PRODUCT_SHORT_NAME`, `PRODUCT_DESCRIPTION`, `PRODUCT_SUPPORT_EMAIL`, and `PRODUCT_ACCENT_COLOR`; run the validation/build commands before redeploying. Future trademark changes must leave `SERVICE_ID`, MCP tool names, stored IDs, account mappings, and credential bindings unchanged. Treat `PUBLIC_ORIGIN`, issuer, OAuth audience/callback, and client registration as separate infrastructure contracts.

## Backups and recovery

D1 Time Travel is automatic on the production storage backend. Its recovery window is 7 days on Workers Free and 30 days on Workers Paid. Verify the actual plan and database backend, and record a bookmark before a significant migration. Restores overwrite the database in place and cancel in-flight queries. [Cloudflare Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/).

```sh
npx wrangler d1 info allenlabs-memory-production
npx wrangler d1 time-travel info allenlabs-memory-production
```

This database contains both memory and authorization history. An earlier restore can make revoked keys, memberships, and email claims live again, remove later email blocks, and reopen consumed invitations or OAuth flows. Restoring content therefore requires an access-recovery plan:

1. Put the service behind an emergency traffic block/maintenance deployment that refuses browser, REST, MCP, and auth routes. There is no built-in maintenance switch; establish and verify the edge block before restoration.
2. Preserve the current bookmark and the post-restore-point revocation/disablement and consumed-proof evidence in an access-controlled incident record. If required evidence cannot be recovered, keep access closed.
3. Confirm the exact dedicated database UUID and approved restore point. Run the documented Time Travel restore only under that incident plan; retain its returned undo bookmark.
4. Reapply or reconcile revoked/disabled accounts, organizations, claims, memberships, keys, email blocks, and consumed invitations. Invalidate restored sessions and pending OAuth/email proofs as appropriate. Never reopen using the restored authorization snapshot alone.
5. Validate schema/migration compatibility, fresh login, tenant isolation, and known revoked-key/member denial while public traffic remains blocked. Reopen only after reconciliation and verification are recorded.

No scheduled long-term backup export or user export workflow is implemented here. A Time Travel window is not a permanent archive. Design and test any additional backup retention and access controls before relying on them.

## Current release limits

Memory deletion creates a tombstone; previous bodies remain in `memory_versions` and storage history. There is no permanent purge, retention-expiry job, user export, or erasure workflow. Do not promise physical deletion from storage or backups.

Billing, payments, pooled usage accounting, vector/semantic search, embeddings, provider-wide deprovisioning, and Zero-Access encryption are not implemented. Storage uses one dedicated D1 database; the scale review is a proposal, and no sharding or shard routing is deployed. Search is bounded literal substring search; Standard memory is server-readable. Email reauthentication/proof-delivery and account-recovery operations still need a supported provider proof and an operated workflow. These limits, plus full live user SSO and recovery validation, remain release gates; do not label this service production GA based on the current implementation or deployment alone.

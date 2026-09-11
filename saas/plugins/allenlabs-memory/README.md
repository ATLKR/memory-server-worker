# Allen Labs Memory — SaaS routing plugin

This plugin lets an agent choose a destination before sending a memory or search query. General content can use Cloudflare Agent Memory with managed vectors. Uncertain or Seoul-locked content selects an operator-configured Seoul PostgreSQL service with pgvector. Medical content defaults to Seoul. An operator can enable automatic lookup of registered company consent once; employees then need neither a consent prompt nor a consent ID for each call. An existing explicit consent reference is also supported. Cloudflare transfer still requires current server verification and respects every hard Seoul restriction. The classification is a placement decision, not a legal conclusion.

This is a separate product artifact under `saas/plugins/allenlabs-memory`. It does not replace, install, or modify the legacy plugin under `plugins/allenlim-memory-server`. Its display title lives in `.codex-plugin/plugin.json`; rebranding can change presentation without changing tool identifiers or protocol versions.

Mixed conversations can be split into independently meaningful units and saved through separate calls with separate stable operation IDs. Inseparable clinical context stays together in its permitted destination; without Cloudflare consent it remains in Seoul. Hard-locked originals stay in Seoul. Do not copy clinical identifiers or sensitive cross-links into a general unit. For an authorized search spanning both stores, use separately classified, route-safe query variants and merge results locally with their route provenance. The stdio transport permits up to four concurrent calls; it never broadcasts a query itself. An irrelevant second destination need not be queried.

## Current availability

The local decision tool works offline. Remote calls require a server implementing `memory-routing-v1`, with public `/.well-known/memory-routing` metadata attesting a ready compatible target before content or credentials are sent. The current deployed Memory service must not be presumed to support this new contract. Administrator registration of company consent and deployment of the corresponding server ledger/receipt endpoints remain pending. The plugin does not create consent records. A configured URL is not evidence of readiness. The plugin fails closed when metadata is missing or incompatible; it does not provision a Seoul database or migrate data. See the [SaaS routing design](../../docs/agent-routing.ko.md) for the current product contract.

The supplied MCP manifest starts the bundled `scripts/mcp-stdio.mjs` using Node.js. Build and package validation must run before distributing the plugin. No source checkout or external npm modules should be needed by the bundle. Use the supported Node version from `saas/package.json` during development. There are no automatic prompt, session, or post-turn upload hooks.

## Tools

- `memory_route`: `{ "routing": { "version": 1, "classification": "general" } }`. Returns a local route plan; sends no request. Classifications are `general`, `medical`, `region-locked`, `uncertain`. Optional `destination` is `auto`, `agent-memory`, or `seoul`; optional `requiredRegion` is `kr-seoul`. With company mode configured, medical calls can omit `medicalCloudflareConsent`; the plugin adds `{ "mode": "organization" }` automatically. An existing explicit `{ "consentId": "record-id", "version": 1 }` reference is preserved. Neither selector is proof of consent: remote calls verify the current server record before content is sent. Hard Seoul locks and uncertainty cannot be waived by either selector.
- `memory_ingest`: `{ "routing": { "version": 1, "classification": "uncertain" }, "operationId": "stable-operation-id", "messages": [{ "role": "user", "content": "Authorized memory content" }] }`. Optional `sessionId`; message roles `system`, `user`, `assistant`; optional ISO `timestamp`. Up to 500 messages, 32,768 UTF-8 bytes each and 1 MiB total. Preserve the same ID and exact input for any deliberate retry/reconciliation.
- `memory_search`: `{ "routing": { "version": 1, "classification": "general" }, "query": "Relevant context", "limit": 10 }`. Query at most 1,024 UTF-8 bytes; limit 1–50. Searches one destination only.

Arguments do not accept URLs, credentials, arbitrary Space IDs, or caller-declared trusted source restrictions. The operator selects each route's Space. The remote service must verify the actual Space/source restrictions on every call. A route result is not a scan of the content and is not permission to bypass those restrictions.

## Operator configuration

Set environment variables on the MCP process through the host's protected configuration or secret injection. Do not store credentials in the manifest, commit them, or send them in chat/tool arguments.

| Destination | Origin and Space | Exactly one credential |
|---|---|---|
| Cloudflare Agent Memory | `MEMORY_CF_ORIGIN` (default `https://memory.allenlabs.org`), required `MEMORY_CF_SPACE_ID` | `MEMORY_CF_PAT` or `MEMORY_CF_SSO_TOKEN` |
| Seoul | Required `MEMORY_SEOUL_ORIGIN`, required `MEMORY_SEOUL_SPACE_ID` | `MEMORY_SEOUL_PAT` or `MEMORY_SEOUL_SSO_TOKEN` |

Origins must be HTTPS origins, without credentials, paths, query strings, or fragments. No Seoul hostname is preconfigured. Conflicting PAT and SSO values are rejected for the selected route; an unselected route's configuration is not used. Tokens are bound to the chosen route and exact normalized origin, never copied across hosts. Legacy `MEMORY_PAT`/`MEMORY_API_KEY` values are ignored.

SSO tokens must already be valid for that destination's resource/audience through the host or supported service sign-in flow. The central identity issuer can remain `allen.company`; that does not make a bearer token interchangeable between two services. This stdio process neither starts browser login nor refreshes tokens. If the destination needs authentication, sign in through its supported flow and inject a destination-specific access token, or use its PAT.

Local route planning and tool discovery need no environment variables. Actual remote calls lazily load the selected configuration, verify destination metadata without sending tokens/body, and then call its `/mcp`. Redirects and unavailable targets must not cause a fallback to another host. An error result does not mean an unknown remote write was rolled back.

For registered company consent, set `MEMORY_MEDICAL_CONSENT_MODE=organization` once in the organization's managed MCP configuration. The plugin supplements medical decisions that lack a consent selector; it never changes their medical classification or overwrites an explicit reference. Before each medical Cloudflare operation, the client asks the authenticated destination server to resolve its current organization record, using only the selected Space, operation, and selector. The original messages/query are not included in that check. A valid scoped receipt resolves the exact record/version for that operation. Grants are not cached between calls. Unregistered, revoked, expired, or mismatched consent blocks the operation for administrator remediation; it neither prompts each employee for consent nor silently retries in Seoul. The server must recheck its current ledger when the receipt is used. Only `organization` is accepted; an unknown or empty mode fails. When unset, medical calls without an explicit selector keep the default Seoul route.

For a workspace that must stay in Seoul, set `MEMORY_ROUTING_RESTRICTION=seoul` on this plugin process. The restriction is applied before offline route planning and before choosing any target or credential. Its only accepted value is `seoul`; leaving it unset applies no extra operator restriction. A tool argument cannot remove the lock. This local constraint supplements the server's actual Space/source restrictions.

MCP cancellation immediately aborts active requests and removes queued requests, including when all four remote calls and the bounded waiting queue are occupied. Cancellation before upload prevents dispatch. Once an upload has been dispatched, cancellation can leave its outcome unknown; reconcile the existing operation ID rather than assuming rollback or creating a new operation.

## Development and distribution

Root SaaS build integration bundles `src/stdio.mjs` with the shared `saas/src/routing/client.ts` and `policy.ts`. Run the plugin's native tests and `scripts/validate-package.mjs` on the built directory. The package validator rejects automatic hooks, an unexpected MCP executable/entry path, missing bundle/skill files, and unsupported package payloads. The repository's standard plugin-creator validator should also pass.

Distribute the manifest, `.mcp.json`, README, skill, generated stdio bundle, `LICENSE`, and `THIRD_PARTY_NOTICES.md` after validation. Installation and marketplace registration are separate user actions; this directory alone does not install a plugin.

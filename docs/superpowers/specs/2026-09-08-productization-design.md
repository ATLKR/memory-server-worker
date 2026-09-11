# Productization: Allen Labs hosted memory

## Accepted direction

User requests as much real product development as possible, hosted at `https://memory.allenlabs.org`, using the existing Allen Labs identity platform. User clarified that the identity platform intentionally remains `https://auth.allen.company` / `https://auth-api.allen.company`; service domains use allenlabs.org. Product title must be changeable after trademark registration.

This architectural extension builds on the tested Standard foundation. Keep stable protocol/product IDs independent of display brand. Provisional display name: `Memory by Allen Labs`; runtime configuration owns name, short name, description, support address and accent color. Domain and issuer are environment configuration, never derived from brand text. No automatic email-based account merge.

## Working product slice

1. Cloudflare Worker with persistent D1, numbered migrations, custom-domain configuration, local development and a deployment preflight. No reuse of the personal-service database.
2. Browser SSO authorization-code flow using the real central authorization server contract, S256 PKCE, exact issuer/audience/signature checking, server-held state and one-use callback, safe redirect allowlist, HttpOnly/Secure session cookie, same-origin CSRF defense and logout revocation. Do not assume OIDC ID tokens exist: the current provider is OAuth with signed access-token identity.
3. Stable issuer/subject mapping, account provisioning and default personal Space. Verified SSO email can establish a new immutable claim; blocked/reassigned addresses never revive old authority or merge accounts. Session TTL is bounded; reauthentication must reflect actual provider proof, not token refresh.
4. Workspace APIs: account summary, accessible Spaces, organization creation using an active verified email, copyable expiring invitations, email-bound acceptance, current-member administration, personal/organization machine-key issuance and revocation. Never send invitations to third parties during development.
5. Usable responsive browser console: sign-in, Spaces, memory list/search/create/edit/delete, organization/invitation and key administration. Metadata, titles and UI copy use brand configuration. Secrets appear only once in explicit issuance results; never localStorage or logs. User content always text, not HTML.
6. Stateless MCP transport using the same memory and current authorization rules. Machine keys permit agent access; organization keys remain membership-bound. Tool names and resource identifiers do not change with marketing title.

## Storage and authority

Existing identities, claim revocations and canonical versioned memory remain authoritative. Add `personal_key` credential kind with account-only memory access; interactive identity administration still requires `session`. Organization API keys remain derived from immutable membership/email. Add product metadata/invitation/provider mapping through separate schema/migrations. All relevant writes are conditional SQL or a single trigger transaction, with no stale check followed by unconditional mutation.

SSO and provisioning authenticate a user only after verified provider proof. External failure is closed and does not silently fall back to demo or personal-service auth. Production never seeds demo users/tokens. Browser cookies are accepted only by same-origin browser APIs, never by MCP. Machine Bearer keys are accepted by REST/MCP. Responses and private HTML are no-store. Body/record limits and identifier-only audit remain enforced.

## Completion evidence and remaining launch gates

Run fresh tests for auth replay/PKCE/issuer/audience/expiry, account binding, tenant isolation, invitation and key lifecycle, HTTP CSRF and MCP protocol. Test D1 migrations in workerd, bundle dry-run, and browser UI using the local demo. Independent review precedes handoff/deployment. Preserve earlier working-tree changes.

Cloudflare and central-auth configuration are checked separately from local implementation. If credentials or provider registration are unavailable, finish all reviewable code and exact deployment instructions, then report that specific remaining blocker. Paid payments, semantic retrieval, physical erasure/retention, provider-wide deprovisioning and Zero-Access retain explicit future release gates; do not market them as implemented.

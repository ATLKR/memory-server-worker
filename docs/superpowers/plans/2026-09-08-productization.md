# Hosted Memory Productization Implementation Plan

**Goal:** Ship a deployable, usable Standard memory application with Allen Labs SSO and replaceable display branding.
**Architecture:** Worker Fetch handler, D1 authority, existing canonical service, modular SSO/workspace/UI/MCP boundaries.
**Spec:** `../specs/2026-09-08-productization-design.md`
**Global constraints:** Preserve prior local work and personal-service configuration; memory.allenlabs.org product origin; central auth remains allen.company; display naming independent of protocol/database identifiers; no secrets or synthetic bootstrap in production.

- [x] Identity/workspace: tested external identity provisioning, organization/invite and key lifecycle, account/Space listings and administrator member directory.
- [x] SSO: inspect exact provider contract, implement verified OAuth flow and safe browser session management; register public client.
- [x] UI/branding: responsive console and one-source product display configuration.
- [x] Runtime: Worker/D1 migrations, REST/MCP integration, safe local demo, deployment config/preflight.
- [x] Validate: 171 tests, bundled local workerd/D1 populated upgrade, desktop/mobile browser checks and independent review/fixes. Five remote migrations and Worker 0.3.0 deployed using user-designated personal credentials; temporary tokens revoked.
- [x] Product follow-up: arbitrarily deep organization hierarchy with independent ACLs and draft retention through session expiry.
- [x] Handoff documentation: product README, verification, brand-change guide and launch limits updated.
- [ ] Live authenticated verification: provider consent succeeds, but managed browser callback navigation is blocked with ERR_BLOCKED_BY_CLIENT. User-created normal-browser comparison pending; no security protections weakened.

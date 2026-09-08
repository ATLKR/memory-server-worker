# SaaS identity foundation — partial publication

**This branch is NOT a runnable or deployed SaaS. Do not merge or deploy it as a completed feature.**

Baseline: `master` at `8b5a9bbe9e815c6e75ff811b4073e038394dfaf1` (v3.2.1).

Only `saas/package.json` and `saas/src/identity.ts` were successfully published as code. The connected tool blocked the SQL schema write and a bulk tree write, so the schema, tests, type configuration and other supporting files are not present on this branch. A complete locally tested standalone module and audit document were prepared separately for the user. No production configuration, central-auth service, existing memory data or default branch was changed. No CI update, PR, merge, release or deployment was completed.

## Implemented locally

- Stable account ID with multiple verified email claims.
- Single-use, account-bound, expiring email verification challenges; only proof digests stored.
- Memberships bound to an immutable email claim ID, rather than an email string or a replaceable primary email.
- Atomic email, derived membership and credential revocation with audit records.
- Domain-manager service-email revocation requiring an exact verified domain, active owner/admin membership, explicit delegation and recent interactive reauthentication.
- Administrative re-link blocks; re-verification never resurrects old memberships or credentials.
- Current membership checks through fresh primary reads. Personal accounts survive organization-email removal.

The locally executed TypeScript check and 25 real SQLite tests passed. This is not a claim that upstream workspace tests, GitHub Actions, Cloudflare D1/workerd, live authentication integration or cross-region race tests passed.

## Actual existing-code gaps

- `packages/memory-worker/src/security.ts:resolveProfileName` binds scopes to an individual user; it does not implement organization Spaces.
- `packages/memory-worker/src/index.ts` authenticates and selects an Agent Memory profile directly. A live identity/membership/Space-ACL gate is needed at every access path.
- `packages/memory-worker/src/auth.ts` consumes central-auth JWTs and a Worker-secret credential registry capped at 20 entries. The SaaS identity database is not connected to either path.
- `packages/memory-worker/wrangler.jsonc` is the existing personal-service configuration, not an isolated SaaS environment.

## Integration gates

1. Map external issuer/subject identities to stable accounts; connect sessions, refresh tokens and PAT revocation without automatic email-based account merging.
2. Implement real DNS ownership verification, domain delegation lifecycle, invitation acceptance, rate limits and email delivery.
3. Wire live checks and action/Space permissions into MCP, REST, export, queues and billing; fence in-flight writes/responses against revocation. Never fall back to a legacy profile on authorization failure.
4. Implement canonical memory storage, explicit sharing, replaceable Agent Memory/Vectorize adapters and a pooled organization allowance ledger. These are not implemented in this branch.
5. Add UI/recovery and authenticated IdP/SCIM deprovisioning integration, then run full staging and upstream regression tests.

Domain revocation removes the service's email claim and rights derived from it. It does NOT delete a Google Workspace or Microsoft 365 mailbox, a personal account, personal memory, or another organization's unrelated membership. Existing production JWTs are not revoked by this isolated, unintegrated foundation.

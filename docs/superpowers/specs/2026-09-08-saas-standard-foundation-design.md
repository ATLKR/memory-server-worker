# Standard memory service foundation

## Source and repository verification

The user requested continuation from their ChatGPT planning, using the dedicated GitHub repository under Documents/Development. On 2026-09-08, `ATLKR/memory-server-worker` was verified as a standalone, public, non-fork repository. No additional dedicated SaaS repository was found among the accessible repositories. This checkout continues `feat/saas-identity-foundation` at `b957a701a126df7ee6928a020db72566ce817962`; the personal-service baseline is v3.2.1, `8b5a9bbe9e815c6e75ff811b4073e038394dfaf1`.

Planning sources:

- [에이전트 메모리 서비스 기획](https://chatgpt.com/c/6a9fa043-1054-83ee-97e4-7091d7e60b28): stable accounts, multiple verified emails, memberships tied to individual email claims, revocation by self and explicitly delegated domain managers, pooled organization usage, canonical memory ownership and replaceable search infrastructure.
- [에이전트 메모리 암호화](https://chatgpt.com/c/6a9fa4e3-1614-83ee-b127-a9151b38f1f3): latest direction is Standard first; reserve the processing boundary for a future personal Zero-Access mode. Do not claim managed storage is zero-access.

The earlier chat reported an additional ZIP with 25 tests, but that archive is not available from the task reader. Only three files are present upstream. Missing files will be reconstructed and tested here, not described as recovered originals.

## Deliverable in this iteration

Complete an independently installable and testable `saas/` foundation, then add a working Standard memory service core with personal and organization Spaces. Keep the current personal Worker, UI, plugins and production configuration intact. This is an architectural extension authorized by the user's request to implement the existing plan.

### Identity

Keep the existing IdentityService contract. Reconstruct SQLite/D1-compatible schema, active views, immutable claim relationships and transaction triggers. A claim removal atomically revokes its memberships, derived credentials and pending challenges; unrelated email claims, organizations and the account survive. Domain revocation requires verified exact-domain ownership, current owner/admin membership, explicit delegation and recent interactive reauthentication; it also blocks relinking. Reverification creates a new claim ID and never revives old authority. Audit events are in the same transaction, contain identifiers only and are append-only.

### Standard memory core

Personal Spaces belong to one account; organization Spaces require a current membership. Session tokens may access their account's personal Space and current organization memberships; membership-bound credentials cannot access personal Spaces or another organization. Read-only credentials cannot mutate records. Start with owner/admin write access for organization Spaces and member read access. The billing owner grants no data access.

Canonical SQL records own memory ID, Space, body, source, revision and deletion state. Each update uses an expected revision to prevent lost updates, preserves the prior body in a version table, and checks live authorization in the write statement. Delete is a tombstone with a version record; deleted records are excluded from normal reads/search. A bounded keyword search returns snippets/IDs without an LLM and is explicitly not advertised as semantic search. This is the first provider-independent storage slice; Vectorize remains a future replaceable index.

Space security mode is `managed` only at runtime. Requests for `zero_access` are rejected; no silent downgrade, fake cryptography or claims of HIPAA compliance. Source text may be stored, but must not appear in audit/error logs.

### Local execution and boundary

Provide a localhost-only demo using SQLite and the same Fetch handler/service code, with random ephemeral development tokens and synthetic data. No production token, account, DNS, mailbox, payment or remote database mutation. Public signup, central-auth integration, production MCP, email delivery and deployment are follow-up work; no insecure account bootstrap HTTP endpoint will be provided.

## Validation

Use real SQLite for state transitions, atomic rollback and tenant isolation. Cover expired/replayed/cross-account challenges; email removal and administration boundaries; non-resurrection; revoked/expired/restricted tokens; wrong Space/membership; optimistic revision conflicts; deletion filtering; input/body limits; HTTP authorization and error sanitization. Run standalone typecheck and tests, a local HTTP smoke test, and relevant existing repository regression checks. Add a dedicated CI job so the module cannot silently run zero tests again.

Cloudflare interface references checked on 2026-09-08: [D1 database](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/). Production reads need `first-primary`; staging D1 and cross-region tests remain separate gates.

## Following milestones

1. Verified external issuer/subject mapping, real email delivery and DNS proof, invites and secure session lifecycle.
2. Bind the new live authority gate to production MCP/REST/export and asynchronous work, including in-flight revocation fences.
3. Vectorize/embedding adapter, rebuild/export, approved personal-to-org sharing.
4. Organization pooled allowance reservation/settlement ledger and payment integration.
5. Management UI, recovery and domain delegation administration; Zero-Access Personal after its client trust and key-recovery design is validated.

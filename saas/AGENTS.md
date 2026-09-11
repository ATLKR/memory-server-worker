# Memory SaaS framework choices

User instruction, 2026-09-11:

- Backend HTTP services must use Hono. Apply this to the real request entry and middleware, not only an unused dependency. Preserve the existing authenticated product contract while migrating storage.
- Prefer TanStack Start and TanStack Router for new frontend/full-stack work when no framework is otherwise required. Preserve the existing console during the storage cutover; new UI architecture should follow this preference.
- For self-managed agent memory/workflows on Durable Objects, consult the official `cloudflare/agents` repository and use its SDK or frameworks such as Flue when they materially support the needed agent lifecycle. Plain SQL coordination does not itself require an agent harness.
- Do not mix backend framework adoption with unverified changes to authorization, retries, data residency, or durable state identity.

These choices supplement the approved Cloudflare-first storage plan, exact Space permissions, independent organization ACL, and separate Seoul PostgreSQL path. They do not authorize advertising a region or backend as operational before live verification.

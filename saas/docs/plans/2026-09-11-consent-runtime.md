# Organization consent runtime

The approved product flow is one organization administrator configuration, followed by quiet server-side checks for every employee request. A standing grant never creates Space membership, crosses a child-organization boundary, or overrides an explicit Seoul restriction.

## Implementation sequence

1. Persist current consent, immutable revision audit, short-lived opaque receipt hashes, and provider-operation admission in one SQLite Durable Object per organization. Use synchronous transactions for each transition, compare-and-set versions, retained operation IDs, and explicit unknown provider outcomes.
2. Connect grant/read/revoke and consent-check HTTP routes to existing authenticated SSO/PAT and exact Space authority. Only a recent interactive organization administrator may change the grant. The client sends a selector, not its own authority or consent record.
3. Connect routed MCP requests to the provider adapter only when the actual provider and durable admission are configured. Revalidate consent and current Space authority before dispatch and before returning provider content. Keep raw content out of the consent ledger and logs.
4. Verify native SQLite concurrency/restart/receipt behavior, authenticated endpoint rejection cases, provider outcome handling, and the existing suite. Check actual personal Cloudflare account access separately using synthetic data only after authorization is established.
5. Deploy a verified staging candidate when its prerequisites are available; keep readiness false for missing provider or regional runtime. Publish source and a precise handoff with remaining GA gates.

## Boundaries

The transitional identity/ACL adapter still reads the existing D1 authority. A Durable Object transaction cannot make that separate database or a provider fetch atomic. This increment does not claim the requested final zero-D1 cutover, regional PostgreSQL production readiness, physical provider erasure, or GA merely from a successful consent check. The full authority migration and recovery gates remain explicit work.

Receipts bind the authenticated credential, organization, Space, request, operation, grant revision and expiry. Dispatch consumes the receipt with operation admission. An operation whose remote outcome is unknown is never automatically resubmitted. Revocation or a changed grant prevents new dispatch and disclosure under the obsolete revision; already dispatched external processing requires separate provider cleanup.

Cloudflare Agent Memory access is verified independently of local tests. A 401 from an account-owned token does not distinguish unsupported token type from beta entitlement. Do not mark an unavailable route as ready or send content to an alternative region automatically.

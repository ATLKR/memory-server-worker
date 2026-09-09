# 0.4.0-rc.3 correctness fixes

This update preserves the seven deployed migrations and the current pilot
configuration. Provider processing and automatic memory erasure remain disabled.

- The console clears another account's drafts, proof and PAT form state when a
  refreshed workspace reveals an account change. It preserves new typing during
  a same-account refresh and ignores superseded ingest/share list responses.
- A mistyped email proof fails with a retryable proof error, without reporting an
  invalid session and making the console discard the login.
- Repeated share acceptance preserves the original consent timestamp and checks
  the live recipient and grantor again. Revoked or foreign shares remain denied.
- Memory detail reads recheck access after fetching the row, matching the other
  read paths when credential or share revocation races a response.
- Multi-chunk indexing renews only the worker's current, unexpired lease between
  provider operations. An expired or reclaimed lease cannot be revived.
- SCIM deactivation accepts `application/scim+json`, returns SCIM media/error
  envelopes, supports count-only queries, and reports expired/disabled members
  as inactive. It rejects mixed unsupported PATCH changes and checks authority
  after the final list-count query. Memory MCP retains its own OAuth discovery
  challenge; SCIM uses its separate Bearer realm. This remains a deprovisioning
  subset, not a complete provisioning implementation.

SCIM behavior follows the relevant portions of [RFC 7644](https://www.rfc-editor.org/rfc/rfc7644.html).

## Verification

`npm run check` passes 349 tests: 174 baseline, 169 release, and six client/template
tests, plus typechecking and migration consistency. `npm run test:d1` passes the
bundled Worker/D1 integration and seven actual workerd authentication/HTTP tests.
The new D1 checks cover lease renewal/reclamation, share acceptance retries,
SCIM media/pagination and last-owner protection. Eighteen new unit/integration
regressions also cover partial OAuth scopes and exact organization PAT boundaries.

Live provider acceptance, physical D1 sharding and the remaining launch work
remain as described in [the maintained integration record](INTEGRATION.md).

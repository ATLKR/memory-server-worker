# Pure snapshot facts (B1)

This inactive local extension installs one function after the held head foundation and pure snapshot validator. It needs neither the snapshot ledger nor regional provisioning. It adds no table, role, policy, receipt, schema marker, source hash, authority row, materialization or serving grant. Existing caller apply continues to reject snapshots.

```sql
memory_identity.projection_v3_snapshot_fact(
  p_snapshot jsonb, p_kind text, p_stream_key text
) RETURNS jsonb
```

The function is IMMUTABLE, SECURITY INVOKER, not STRICT, owned by `memory_projection_owner`, with fixed `search_path=pg_catalog` and only owner EXECUTE. Its body reads JSONB input and invokes the held narrow scalar/row validators. It performs no relation read, DML, lock, clock sampling, authentication or authority decision.

## Acceptance precondition and local checks

The caller supplies owned JSONB from an already accepted canonical snapshot. The actual composition calls `projection_v3_snapshot_canonical(text)` once per distinct event per required pass; that validator parses internally, checks the complete scalar/graph contract and returns canonical text. The caller then parses that returned text once to retain its JSONB value. This is not one total JSON parse. No full canonical validation or graph validation occurs inside the fact extractor.

JSONB cannot establish the original transport spelling, duplicate-key absence, raw byte length, authentication, received source identity or regional truth. Calling the extractor directly with arbitrary JSONB does not replace that acceptance boundary. The tests distinguish narrow malformed-JSONB checks from full raw-validator composition.

The requested kind/key must have an exact head reference in at least one grant. The extractor checks the held key domain and the complete referenced head shape; repeated references to that requested stream must agree. A matching descriptive row alone does not make a fact available. It checks unique local account/credential/Space joins and, for an organization credential, unique email/membership/organization joins, their ownership bindings, live nullable state, and the relevant head bindings. Returned rows and policies use the held closed row validators. It does not recompute grant permissions or expiry from a lease, establish completeness of every unrequested head, or repeat whole-event validation.

SQL NULL arguments, JSON null snapshot, unknown kind, target, malformed key, absent/unreferenced stream, duplicate or absent required local row, and inconsistent required bindings fail `PP001: seoul_projection_input_invalid` with no detail/hint. Valid nullable fields inside facts remain JSON null. A personal grant's null email/organization/membership heads are inapplicable and are skipped; they never act as wildcards. An empty descriptive snapshot has no extractable fact.

## Exact fact grains

| Requested kind | Exact result |
| --- | --- |
| subject | `{account: <exact account>, providerIdentities: <complete provider subset for that account>}` |
| email | `{email: <exact live claim>}` |
| organization | `{organization: <exact organization>}` |
| membership | `{membership: <exact membership>}` |
| credential | `{credential: <exact credential>, credentialPolicy: <complete corresponding policy>}` |
| space | `{space: <exact signed Space including policy>}` |

Subject keys retain the exact issuer prefix plus the whole opaque subject. Email keys split at the final newline to retain embedded/trailing subject newlines. The exact mapping supplies the account, and the account plus canonical mailbox resolves the exact live claim; no claiming-subject field is invented. Aliases of the same account produce equal subject facts. Provider filtering preserves input ordinality, including validated JavaScript UTF16 ordering for prefixes and astral/BMP subjects. It never substitutes a PostgreSQL collation sort. All four provider fields remain in the result.

Membership facts include global account/email/organization binding, role, expiry and revocation. Credential facts include all signed credential fields and full credentialId/capabilities/null-or-array Space scope; the scope is never filtered to the consuming Space. Space facts include the signed owner XOR organization, disabled state and complete signed policy. No result contains consuming grant flags, grant provenance, selected state, snapshot sequence/checkpoint, lease, setup approval/deployment/quota/usage, or regional reauthentication. Internal JSONB object order is not a transport contract; array order is significant.

A fact is a projection from the first successfully applied snapshot under a separately received source tuple. It does not independently reconstruct or authenticate the central source body or its payload SHA. Future materialization must store that first witness and compare exact facts, while independently checking every source tuple. B1 does not classify conflicts, store witnesses or authorize application.

## Allocation and future caller obligations

One invocation returns one grain. A subject invocation builds its complete account provider vector once, after validating the matching references. It does not construct or return a provider vector per alias. Other results contain one row and, for a credential, one complete policy. The helper scans bounded JSON arrays for requested references and their local joins; it introduces no extra wire, grant, provider or graph cap. The existing canonical event bound remains 131072 bytes.

The focused fixture measures input UTF8 size, returned compact JSON size and PostgreSQL `jsonb::text` size independently. Compact serialization uses the held scalar spellings and is a subset plus fixed wrapper of the bounded event. JSONB text adds spaces and uses its own object order; JSONB representation, intermediate narrow validator text, parsing and allocator overhead are separate. The measurements do not establish a 128 KiB allocator ceiling, a copy count, a provider throughput/latency promise, or a universal maximum over all valid snapshots.

The future B2 caller must validate every distinct requested stream and separate five-tuple before sharing a grain. Subject grains share by account ID; email grains share by exact claim ID; other grains share by kind/entity ID within one validated event. It may use one valid representative referenced stream per grain, invoke B1 once, and keep small source-to-grain references. Calling once per alias and deduplicating already allocated vectors afterward does not meet that requirement.

For prior witnesses, B2 must group by event ID, load/validate/parse one prior body at a time, extract each requested prior grain once, compare every associated source, then release that event group before loading the next. Candidate and prior event work repeats in independently required final/deferred passes. With P prior events, total raw prior reads can reach P times 131072 bytes. B1 does not prove that this future caller avoids amplification; body-load, validation, extraction and allocation instrumentation belongs to B2.

## Installation boundary

The installation is one transaction and requires existing explicit SET authority for `memory_owner` and `memory_projection_owner`. It rejects an exact signature collision, missing held validators, or pre-existing projection-owner schema CREATE. It temporarily grants schema CREATE as `memory_owner`, creates the exact function as the projection owner, then restores CREATE before commit. It never adds or changes a role edge, global/schema default privilege or old function.

After function creation, installation enumerates its actual effective ACL entries, including PUBLIC and arbitrary/quoted/default grantees, and revokes all non-owner grants using RESTRICT. This removes grants with grant options and inherited access through those grantee groups without changing the groups. Dependent grant chains cause rollback rather than an unreviewed cascade. Postflight checks exact owner, immutable/invoker/null-call/search-path/result metadata, owner-only ACL, and absent retained schema CREATE. Trusted owner/superuser ability to execute or change private code remains part of the existing administrator boundary.

Tests compare all old memory rows, relations/columns, function definitions/ACLs, triggers, policies, schema ACLs, role attributes/edges and default ACLs before/after install and extraction. They separately verify exact new function metadata and capability refusal, installation collision/SET failures, arbitrary quoted/inherited/grant-option defaults, unchanged head receipt/status and unchanged snapshot caller refusal. Local PGlite PostgreSQL evidence is not a hosted PostgreSQL, transport, live provider, materialization, admission or production-installation claim.

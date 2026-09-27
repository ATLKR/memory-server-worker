# Inactive caller snapshot dispatch

Load `snapshot-dispatch.sql` explicitly after schema1–5, head foundation,
protected provisioning, snapshot validation, ledger A, facts B1 and
materialization B2 in a disposable database. This is the caller-facing half of
unit C only. It is not an installed migration, adds no schema6 marker, no role,
no table, no policy and no public-authorizer change, and it does not by itself
constitute the final coherent C installation — the ordinary admission/public
authorizer predicates that must accompany materialized positive rows remain a
separate draft that must ship in the same coherent installation before any
serving exposure.

The unit makes exactly one change: it replaces
`memory_identity.seoul_projection_apply(text,text)` so that an exact canonical
`seoul-authority-snapshot` envelope is routed to the owner-only
`memory_identity.projection_v3_snapshot_materialize(text,text)` instead of
failing validation. Every other behavior is preserved byte-for-byte: head
envelopes follow the existing head path unchanged, `memory_ops.seoul_projection_status(text,text)` is not
replaced, and the two caller EXECUTE grants are unchanged.

## Contract

- Apply is `SECURITY DEFINER` owned by `memory_projection_owner` with fixed
  `search_path=pg_catalog`; EXECUTE remains exactly
  `memory_projection_owner` + `memory_projection_caller`. The materializer it
  delegates to remains owner-only `SECURITY INVOKER`: the caller can reach it
  only through the definer apply. The install also rejects incoming caller
  escalation surface: no non-provisioner role may already `USAGE` the caller
  role without `SET ROLE`, and no caller membership may carry `INHERIT` or
  `ADMIN` options.
- Input handling is unchanged: null/oversized (>131072 UTF-8 bytes) raw text,
  malformed hash, or a hash mismatch is `PP001` before any durable work; JSON
  that cannot be parsed or whose `kind` is neither `seoul-authority-head` nor
  `seoul-authority-snapshot` is `PP001` inside the exception-guarded prelude.
- A snapshot envelope is validated entirely by the materializer/ledger chain:
  canonical byte equality, transport UUID occupancy (`PP002`), reservation
  ownership (`snapshot_sequence_conflict`), source-event aliases
  (`source_identity_conflict`), pending-head/dependency, retained-row,
  provisioning, lease and clock checks, then the immutable receipt attempt.
  The dispatch layer adds no new acceptance or rejection semantics.
- Replay: an exact terminal event returns its stored receipt text
  byte-identically; a pending event's identical bytes produce the next
  attempt number. The dispatcher-facing GET (`seoul_projection_status`)
  already returns the latest stored attempt for either event kind and is not
  modified here.
- The install preflight requires the B2 function/table inventory to exist with
  owner-only ACLs and RLS/forced-RLS, both caller entries to carry the exact
  owner/caller EXECUTE pair, no outgoing role membership for the two
  projection roles, and an apply body that does not already route snapshots —
  an explicit rerun is an `PP004` fault, not a silent no-op.
- Postflight re-verifies both caller entries' owner/definer/search_path/ACL,
  the routing branch's presence, and the materializer's owner-only ACL.

## Non-goals and remaining work

No dispatcher runtime, retry policy, public route, authorization route gate,
central route wiring, backfill, rollback operation, provider deployment or GA
claim is included. The pending-head redispatch bound, per-event dispatch fence
and GET-first unknown-commit reconciliation belong to the D1 dispatcher unit,
not to this entry point. Local PGlite checks do not prove provider PostgreSQL
behavior, independent TCP contention, live lease timing or production
readiness.

# Seoul projection serving authorizer (inactive draft)

`serving-authorizer.sql` is the remaining half of unit C: it turns the v5
serving authorizer into the projected admission path and creates the dedicated
dispatcher login. It is reviewed draft SQL loaded explicitly by tests — never
an installed migration — and stays inactive until the coherent C installation,
backfill and live-acceptance gates complete.

Requires schema5 plus head-foundation, snapshot-validation, snapshot-ledger,
snapshot-facts, snapshot-materialization and snapshot-dispatch installs.

## What it changes

- `memory_identity.projection_v3_serving_bound(credential,kind,permission,
  account,organization,member_role,space,action)` — private `SECURITY DEFINER`
  helper owned by `memory_lifecycle`, `EXECUTE` to nobody else. For one named
  Space it replays the exact v5 grant/Space/deployment/policy checks and then
  requires the projected admission state:
  - `identity_projection_space_state.current_sequence` exists for the Space,
  - that generation row is `selected`,
  - an `identity_projection_grants` row exists on the current generation for
    the credential, is not revoked, and is byte-consistent with the legacy
    `pat_space_grants` row (account, all four `can_*` flags, expiry) — since
    projected grants never carry `can_erase`/`can_retire`, erase, retire and
    status deny on every projected Space,
  - every recorded `identity_projection_grant_heads` dependency still equals
    the current `identity_projection_heads` revision — a head that moved
    forward makes the grant stale and admission fails closed until a
    refreshed snapshot lands. A grant with no recorded head rows does not
    qualify.
  - All of these reads happen in one SQL statement so the current sequence,
    generation, projected grant and head comparison share a single
    READ COMMITTED snapshot.
  - On success it returns `least(legacy grant expiry, projected grant expiry,
    generation lease_expires_at_ms)`, which the caller folds into the
    authority TTL so lease expiry surfaces as `PA007 seoul_authority_expired`.
  - The v5 `FOR UPDATE` Space lock for `retire` is intentionally omitted:
    projected grants never carry `can_retire`, so `retire` always denies
    before the lock would matter.
- `seoul_action_authority` is replaced in place — same signature, owner
  (`memory_lifecycle`), `SECURITY DEFINER`, `search_path=pg_catalog` and exact
  `EXECUTE` surface (owner plus `memory_commands`). Named-Space actions call
  the bound helper after the unchanged credential/account/membership/email/
  org/terminal checks. The unscoped `check` now iterates the credential's
  live grants and requires at least one Space whose bound is still in the
  future; it grants no Space authority and returns only the generic
  admission/TTL — never the qualifying Space, grant or policy. Per-candidate
  evaluation swallows only the helper's expected `PA003`/`PA004` denials —
  every other error propagates — and the returned TTL is re-checked against
  database time before return. `revoke` keeps its credential-scoped terminal
  semantics unchanged.
- `memory_lifecycle` receives `SELECT` plus one `projection_serving_select`
  RLS policy on exactly five projection tables: `space_state`,
  `snapshot_generations`, `identity_projection_heads`, `identity_projection_
  grants`, `identity_projection_grant_heads`. No write or `EXECUTE` on any
  projection object is added.
- `memory_projection_dispatcher` — `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS`, member of `memory_projection_caller`
  with `SET` only. No password is assigned; it cannot authenticate until an
  operator sets a credential at deployment. It holds no table privilege and
  cannot reach the projection owner.

## Fail-closed guarantees

- A Space with no projection state row denies every named action; a
  credential with no qualifying projected grant denies `check` (`PA002`).
- Install refuses to run without dispatch installed, without the exact v5
  authorizer metadata, with a pre-existing dispatcher/helper, on rerun, with
  unexpected role attributes, outgoing memberships of the projection or
  lifecycle roles, incoming caller edges with `INHERIT`/`ADMIN`, or any prior
  lifecycle privilege on the projection tables.
- Postflight re-verifies the dispatcher attributes and edges, the replaced
  function's owner/ACL/proconfig, the helper's owner-only ACL, and the exact
  five-table policy/grant surface.

`seoul_pat_authority` and `seoul_pat_check` bodies are unchanged — they
delegate to the replaced authority function. No route, public surface, or
production behavior is activated by this draft.

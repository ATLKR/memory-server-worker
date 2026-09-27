# Central identity events — enrollment removal + SSO-subject unlink (P-5 closure)

**Status:** implementation contract, 2026-09-19. Synthesis of three architect
candidates (opus-xhigh base; fable-xhigh grafts). Closes the remaining P-5 gap
in `2026-09-16-postgres-regional-authority.md`: the central lifecycle journal
must carry enrollment removal and SSO-subject unlink to regions, not only
account disable.

## Decisions

1. **One journal, two witnesses.** `memory_ops.lifecycle_events` gains
   `source` (`'provider'` default | `'control'`), `region`, `scope`,
   `target_id`, `target_issuer`. The guard's invariant generalizes from "every
   row has a webhook receipt" to "every row is backed by its origin fact":
   provider rows keep the existing receipt+proof checks verbatim; control rows
   must match the directory state they assert (a forged control row can only
   restate the truth — otherwise rejected).
2. **Control channel** rides reserved issuer `'memory:control'` — never a
   valid HTTPS issuer, never collides with a provider's `UNIQUE(issuer,
   sequence)` space. Control sequences are allocated under
   `pg_advisory_xact_lock` so commit order equals sequence order (the
   forward-only regional head requires it). ponytail: one global advisory key
   serializes control writes; ceiling is admin-rate, upgrade path is a
   per-region key + per-region sequence.
3. **Event kinds.** Provider channel adds `subject.unlinked` (address `''`,
   receipt+proof as today). Control channel carries `enrollment.removed`,
   `enrollment.restored` (subject `account:<id>`/`organization:<id>`, `region`
   set) and `subject.unlinked` (`subject` = provider subject, `target_issuer` =
   binding issuer, `region` NULL = all regions).
4. **Writers.** `enroll_*`/`remove_*_enrollment` definers keep their
   signatures and append in the same transaction: `removed` when a live row
   closed, `restored` only when a prior removed row exists (first-ever
   enrollment emits nothing — absent state already means allowed). New definer
   `memory_control.unlink_subject(issuer, subject, at)` stamps
   `provider_identities.unlinked_at_ms` then appends a control
   `subject.unlinked` event — the console/admin origin; the provider webhook
   path (`receiveLifecycle`, `applyVerifiedLifecycle`) gains the
   `subject.unlinked` kind in its allowlist with zero other changes.
   `lifecycle_apply_state` on control routes control rows away from
   `lifecycle_state` (the directory is the truth — derive, don't project) and
   converges provider `subject.unlinked` onto `unlinked_at_ms` +
   `provider_revocations` tombstone.
5. **Regional read.** `lifecycle_events_after` recreated with the new columns;
   control rows are visible only when `region IS NULL` (global: unlink) or
   `region = memory_control.caller_region()` (a Seoul enrollment event is not
   readable from `sg`). Unset GUC (owner/test sessions) sees all control rows.
6. **Regional apply.** `enrollment.*` upserts new
   `memory_ops.enrollment_applied_state(scope, subject_id)` — monotonic
   sequence, restorable (removed ⇄ restored by latest event). No region
   column: the filtered read guarantees only own-region rows arrive.
   `subject.unlinked` calls `memory_ops.apply_subject_unlink` — tombstone in
   the existing `provider_revocations` (kind CHECK gains `subject.unlinked`),
   then `credentials.revoked_at` for the sessions that binding minted via
   `workspace_sign_ins` (the existing binding→credential linkage). No
   `lifecycle_applied_state` row — a non-`resumed` kind on
   `(issuer,subject,'')` would deny the whole account (over-denial trap).
7. **Denial.** `active_credentials`/`active_memberships` gain
   `enrollment_applied_state` probes and exclude unlinked bindings from their
   lifecycle join (a tombstoned binding's residual suspension stops denying an
   account with other live bindings). `ws_sign_in_validate` widens its
   `provider_revocations` check to `('account.disabled','subject.unlinked')`.
   `liveAccountSql`/`authority()` gain the enrollment probes.
   `lifecycleFreshnessSql` requires, per bound provider identity, fresh heads
   for its issuer AND `'memory:control'` — an attached region cut off from
   control denies bound accounts within the staleness budget. Region-only
   accounts stay exempt (they have no central state to be stale about).
8. **TS.** `lifecycle-apply.ts`: `CONTROL_CHANNEL` const, `CentralLifecycleEvent`
   becomes a discriminated union on `source`, `event()` parses the new columns,
   `applyLifecycleEvent` routes by kind, `syncLifecycleJournal` unions the
   control channel into the issuer list. `enrollment.ts` adds `unlinkSubject`.
   `authority.ts` adds `enrolledSql(scope, idExpr)` + the freshness term. No
   call-site signature changes.

## Rejected alternatives

- Second control-authored journal (`directory_events` + own head/sync):
  duplicates head tracking, reader definer, sync loop and staleness SQL —
  two answers to "is this region current?".
- `subject='account:'||id` convention into `lifecycle_applied_state`: the
  string encoding leaks into every reader and `account.deleted` terminality
  would silently apply to enrollment rows.
- `unlinked` as an `applied_state` kind: over-denies multi-binding accounts.
- New `credential_bindings` provenance table: `workspace_sign_ins` already
  carries (issuer, subject, credential_id).
- `deployment_identity.control_attached` latch: deferred — enrollment only
  governs provider-bound accounts, which the per-binding freshness term
  already covers.

## Migrations

- Control: `postgres/control/0007_central_identity_events.sql`
- Regional: `postgres/migrations/0017_central_identity_apply.sql`

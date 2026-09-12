# Native Seoul lifecycle SQL contract

Migration `0005_seoul_archive_lifecycle.sql` extends the installed 0001–0004
contract without changing those source files. It creates no LOGIN, deployment,
backup policy, SSO authority, embedding provider or regional processing claim.
It must run as the original CREATEROLE provisioner with its existing
`memory_owner` SET and `memory_commands` ADMIN edges. Temporary schema CREATE
and command-role SET grants are revoked before COMMIT.

All four runtime entries accept `(text token_digest, jsonb input)` and return
`{admission:{issuedAtMs,expiresAtMs},result}`. Admission uses the database clock,
is at most 30 seconds, and is bounded by the current authority expiry. The
repository must retain its monotonic disclosure check after COMMIT.

| Entry | Exact input | Result |
| --- | --- | --- |
| `memory_content.seoul_archive_erase` | `spaceId,archiveId,expectedRevision,operationId` | `SeoulEraseReceipt` |
| `memory_control.seoul_space_retire` | `spaceId,operationId` | `{spaceId,operationId,state:'retired',replayed:false}` |
| `memory_identity.seoul_pat_revoke_self` | `operationId` | `{operationId,state:'revoked',replayed:false}` |
| `memory_ops.seoul_lifecycle_status` | `{kind:'archive',spaceId,archiveId}` or `{kind:'operation',spaceId,operationId}` | Archive state/revision or this actor's erase receipt/null |

The exact public types are in `src/postgres/seoul/lifecycle-types.ts`.
Lifecycle operation IDs are lowercase UUIDv4; archive IDs retain the existing
lowercase UUID-shaped syntax. Archive status `stored` means source rows remain;
it does not claim that an archive's hidden marker permits search visibility.
Operation status is only an erase-receipt lookup, scoped to current actor,
account and Space. It cannot reveal another actor or action.

Existing SQLSTATEs PA001–PA007 retain their meanings. PA008 is
`seoul_archive_erased`; PA009 is `seoul_revision_conflict`. Changed operation
bindings, receipt PK collisions and retirement with retained data are PA005
`seoul_operation_conflict`. Target denial uses PA003 without a foreign archive
existence disclosure. Runtime must never return provider diagnostics.

## Permanent erase and terminal authority

Erase requires write permission and a fresh `can_erase` grant. Retirement
requires write permission and `can_retire`. Both flags default to false;
ingest permission does not imply either. Personal authority must own the exact
Space; organization authority needs the exact current owner/admin membership,
verified unrevoked email and unexpired grant. No parent-organization inheritance
is added. A cleanup-only PAT may erase without ingest/search permission.

The first erase uses revision 1, deletes all active message rows and removes
archive operation text, source request digest, session, routing, original ingest
and authority timestamps, and `hidden_at`. Meter operation text and its precise
ingest timestamp are scrubbed in the same transaction. Generated archive IDs,
actor/Space references, operation-key hash, quantities and erasure receipt/state
remain. These references are not claimed anonymous.

The operation-key hash is database SHA256 over UTF-8 canonical JSONB
`[spaceId,operationId]`. Ingest checks the original credential/account binding
before returning PA008 for an erased operation. Another actor gets PA005.
Erased input never recreates source or returns its old ingest receipt.

Matching erase operation/actor/body replays after fresh authorization, preserving
the original removal counts. A different operation with expected revision 1
against revision 2 fails PA009. A new operation with expected revision 2 records
an already-erased receipt with zero removal counts. Retained counters decrease
only once; cumulative source/message quota and meter quantities never refund.
There is no period-based billing bucket in this migration.

Retirement refuses remaining source, then disables only the selected Space.
Self-revoke targets only the presented PAT. These terminal actions cannot be
replayed or queried using disabled ordinary authority. An uncertain ACK needs
separate administrator read-only comparison against a pre-recorded exact
target/actor/operation manifest; the API does not reactivate authority or retry
mutations automatically. Synthetic account/email/member audit references remain.

## Privilege verifier integration

The exact version-5 verifier must attest the new `memory_lifecycle` role,
`memory_ops.lifecycle_receipts` table and the following deltas:

- `memory_lifecycle` is NOLOGIN/NOINHERIT/non-owner/non-BYPASSRLS. Its creator
  retains only ADMIN, with INHERIT/SET false. Runtime never joins this role.
- It owns eight functions: `seoul_action_authority(text,text,text,uuid)` in
  identity; `seoul_lifecycle_input(jsonb,text)`, `seoul_lifecycle_status(text,jsonb)`
  and `seoul_lifecycle_commit_fence()` in ops; `seoul_lifecycle_guard()` and
  `seoul_archive_erase(text,jsonb)` in content; `seoul_space_retire(text,jsonb)` in
  control; `seoul_pat_revoke_self(text,jsonb)` in identity. Only the guard is
  SECURITY INVOKER. Every function fixes `search_path=pg_catalog`.
- Runtime receives only the four public entry EXECUTEs plus ops schema USAGE.
  `memory_commands` receives only EXECUTE on the private action authorizer, in
  addition to its existing function ownership. No PUBLIC/default EXECUTE remains.
- Lifecycle receives the exact SELECT/immutable-ID-lock/update/delete/insert
  ACLs in the migration. It gets message DELETE, archive scrub-column UPDATE,
  two meter scrub-column UPDATE, retained-counter UPDATE, Space disabled-at
  UPDATE and credential revoked-at UPDATE. It cannot mutate account/org/email/
  membership identity. `memory_commands` gains only retained-counter UPDATE.
- Forced RLS remains, with explicit lifecycle read/update policies, one message
  DELETE policy and one receipt INSERT policy. Existing command policies remain.
- The archive update trigger, message delete trigger and meter update trigger
  use the guarded invoker function. Receipt UPDATE/DELETE/TRUNCATE are rejected.
  The new deferred receipt fence reauthorizes at COMMIT, including the exact
  receipt-bound intentional disabled/revoked transition.
- Old authority and ingest signatures/owners/EXECUTEs stay fixed; their bodies
  delegate to action authority and maintain tombstones/retained counters.

Locks follow account → org → email/member → credential → grant → Space → usage
→ archive. Self-revoke takes its credential and retire takes its Space FOR UPDATE
from the start. Search may linearize before erase and finish an admitted read;
there is no drain timer or retroactive response cancellation.

## Validation boundary

`test/postgres/seoul-lifecycle.test.mjs` uses the real migrations and PostgreSQL
engine through `seoul-lifecycle-fixture.mjs`, including migration from populated
version 4, explicit ACL denial, metadata removal, operation replay/collision,
cumulative counters and deferred-COMMIT expiry rollback. Its injected trigger
faults are local failure tests, not proof of independent TCP concurrency.

Primary row removal does not assert physical MVCC/WAL/PITR/backup purge.
Permanent native restore remains unavailable; future restore must reapply the
latest independently retained Seoul erasure manifest before opening traffic.
Live installation, independent socket races and provider backup behavior require
separate observed evidence. No Cloudflare Agent Memory or R2 copy is removed by
these functions.

# Inactive snapshot ledger draft

Load `snapshot-ledger.sql` explicitly after schema1–5, `head-foundation.sql` and `snapshot-validation.sql` in a disposable database. This is an owner-only ledger unit, not an installed migration or a positive materializer. It adds no schema6 marker, login, role membership, deployment/setup value, identity, grant, Space, usage, source fact, provenance or admission function. The existing caller apply function still rejects every snapshot before persistence.

The two internal interfaces are:

```sql
memory_ops.projection_v3_snapshot_ledger_begin(text,text)
  RETURNS TABLE(transport_event_id uuid,next_attempt_no bigint,
                required_reason text,replay_receipt_text text)

memory_ops.projection_v3_snapshot_ledger_append(uuid,text,bigint,text,text)
  RETURNS text
```

Both are VOLATILE SECURITY INVOKER functions owned by memory_projection_owner, with fixed `search_path=pg_catalog` and no other role's EXECUTE grant. Begin takes exact canonical snapshot text and its lowercase transport SHA256. Append takes only the returned event UUID, exact hash, expected attempt number and a closed outcome/reason pair. It takes no raw receipt, arbitrary JSON, supplied clock, lease override or assertion that materialization happened. Native typed-argument, permission or missing-prerequisite SQL errors can occur before these private functions; they are not a new external SQL sanitizer.

## Events, reservations and immutable attempts

The original event table gains head/snapshot kind and nullable Space/sequence fields. Existing head rows retain their original raw text/hash/revision/time and receive the literal head/null/null shape. Events remain unique by transport UUID. There is deliberately no universal event uniqueness on Space/sequence: a losing candidate needs its own event and receipt.

The new memory_owner-owned FORCE-RLS reservation table has one immutable owner per `(space_id,snapshot_seq)` and one reservation per event. Its exact event/Space/sequence FK and unique tuple support the later generation FK. It has no positive Space FK, so an empty snapshot may refer to a Space that has never been materialized. Pending or failed reservations are never recycled, and a higher reservation alone does not supersede another candidate.

Receipt attempts are safe bigints from1 through9007199254740991. An insert guard requires attempt1 or exactly latest+1, immutable history supplies the induction, and a partial unique index permits at most one non-pending terminal receipt. No COUNT of all historical attempts is used in request paths. Head events remain terminal attempt1 with their existing four reason pairs. Snapshot attempts use the committed19-pair vocabulary and always have empty currentHeads. Missing first receipt, stale counter, exhausted counter or impossible ledger binding fails unavailable. Arbitrary interior corruption after an administrator disables guards is outside that inductive proof.

Events, receipts and reservations reject UPDATE, DELETE and TRUNCATE at statement level, including no-op/zero-row mutations. A parent-only TRUNCATE may be rejected even earlier by PostgreSQL's native FK check; neither path permits deletion. Existing source history receives only the new insert fence/namespace guard. Known new user triggers and the reservation FK's two parent RI triggers are accounted for explicitly in preservation tests; old trigger identities/definitions remain unchanged.

Begin and append require READ COMMITTED and take the existing global singleton FOR UPDATE before fresh regional/ledger reads. The extended head entry now requires READ COMMITTED as well, including replay. No function changes transaction isolation or constraint modes. Missing fence is unavailable. Dependency UUIDs are deduplicated from the validated bounded graph, then checked through individual exact event-ID lookups. Event and latest/first/terminal receipt reads use their indexed identities. The one-time installation validation of retained head rows is a separate catalogue/data scan, not a request bound.

## Exact replay and namespace order

Malformed/checksum/noncanonical input is PP001 before persistence, even if its UUID is occupied. Begin checks the occupied transport UUID before namespace or reservation rules: different raw text/hash is PP002; an exact terminal event returns its original stored receipt immediately with null next-attempt/required-reason fields. An exact pending event returns the next checked attempt. An existing event without attempt1 is unavailable, including a second begin before the first append in the same explicit transaction.

A new outer snapshot UUID already used by any retained source event is PP002 before inserting the event, including an empty snapshot. A snapshot checkpoint is never inserted into source history. In the other arrival order, a distinct outer head whose embedded source UUID belongs to any snapshot records its existing source_identity_conflict and inserts no source/head/lifecycle/tombstone. An occupied outer transport UUID still wins with PP002. Generic head transport and source UUIDs may remain different.

For snapshots, a different reservation owner forces snapshot_sequence_conflict. Otherwise a submitted dependency UUID already occupied by a snapshot forces source_identity_conflict. Append rechecks these facts and cannot suppress them. The absence of a namespace alias does not prohibit a declared source_identity_conflict: the later B materializer may observe a different source tuple/revision conflict that this ledger unit does not classify. No missing current source, setup record or entity is created by these checks.

## Receipt construction and transaction completion

Begin returns one decision row or one terminal replay row. It never returns an eligibility capability. Append performs exactly one INSERT and returns its actual `RETURNING receipt_text`. It does not create an event/reservation, replay a terminal, retry a stale counter or downgrade an inconsistent decision.

Append uses SQL NULL solely as an internal receipt-text construction sentinel. The snapshot BEFORE INSERT guard requires that sentinel, validates event/reservation/attempt and requested pair, samples safe DB `clock_timestamp()` milliseconds, and constructs the exact14-field canonical receipt. The stored column remains NOT NULL. Non-null supplied snapshot receipt text is rejected. All event identity fields, empty currentHeads and applied-only exact signed expiry are derived from the stored canonical event. Receipt text is at most16384 UTF8 bytes; input text is at most131072. The guard preserves the original head receipt format and validates its event/current-tuple binding without letting SQL NULL comparisons accept a missing current head.

At the recorded decision time, all committed receipt-codec implications apply: live selected positive graphs and live grant deadlines for positive post-clock reasons, zero grants for empty-applied, expiry equality denied, the5000ms future allowance, exact pre-clock source/sequence/newer-sequence applicability, and a null lease for every non-applied outcome. Only the two applied reasons return the unchanged signed expiry. The19 reason pairs retain their adopted submitted semantics; a structural owner fixture is not proof that the corresponding regional reason actually holds.

A deferred SECURITY DEFINER checker, owned by memory_projection_owner, requires every new event to have attempt1 and consistent reservation ownership. It works after the inner definer returns to the real outer caller. Begin-only autocommit therefore rolls back, and forcing the completeness constraints IMMEDIATE causes an incomplete begin to fail early. New applied snapshot receipts also receive a fresh deferred ledger clock check; append performs a fresh check before returning. An exception must abort the entire owning transaction, including a new event/reservation and any future B writes. Neither helper commits or catches unexpected DML failures to return a candidate receipt.

B must decide after its real ordered locks/observations and before positive DML. Append's later DB sample becomes the stored attemptedAtMs. If that sample no longer supports the requested outcome, fail unavailable and roll back rather than committing an expired rejection beside positive writes. The preliminary, final-function and deferred checks establish liveness when evaluated. They cannot guarantee wall-clock durability or remote ACK before expiry, and callers can force constraints IMMEDIATE. The later transport must own a single-statement autocommit apply, and every ordinary admission must evaluate its own fresh deadlines. Historical applied receipts never certify present authority or network-delivery timing.

## Privileges and installation preservation

Installation needs the existing provisioner's explicit SET rights to memory_owner and memory_projection_owner. It creates no role edges and preserves the existing ones. It rejects unexpected privileged attributes on the three projection/table-owner roles, unexpected non-administrative owner SET/INHERIT paths, existing projection-owner schema CREATE privilege, unexpected old ledger ACLs, or altered old ledger RLS policy shape. These conflicts fail before new schema persists; they are not silently repaired. The trusted current provisioner and superuser/owner DDL boundary remains explicit.

New table/function ACLs are closed by enumerating their actual grantees, including PUBLIC, arbitrary retained roles, inherited groups and grant options originating from global or schema defaults. REVOKE uses RESTRICT on those exact new objects; any unexpected dependent grant prevents installation. No schema-wide cleanup, retained-default change or fixed optional-role-only assumption is used. Temporary function EXECUTE grants needed to attach triggers are removed before commit. The new reservation relation grants the projection owner SELECT/INSERT only, backed by the exact FORCE-RLS policies; the code owner owns no table. New functions have only owner EXECUTE, and final catalogue checks verify owner, volatility, security mode, search path and ACL shape.

Actual PostgreSQL18.3/PGlite observation: a table-generated composite row type has typacl=NULL and does not inherit an explicit owner ALTER DEFAULT PRIVILEGES ... ON TYPES grant. The draft checks that actual null row-type/column ACL shape and performs no speculative type GRANT/REVOKE. This is not a claim that PostgreSQL's native implicit type usage is an independent table-read permission barrier. An early test's assumption that explicit GRANT ON TYPE would fail was disproved and removed; no such claim is made here.

The new draft replaces only `memory_identity.seoul_projection_apply(text,text)` and `memory_ops.seoul_projection_status(text,text)`. Head apply uses explicit event/receipt INSERT columns and the added UUID-namespace check; its original retained receipt/status bytes stay exact. Status keeps caller EXECUTE and returns the latest stored attempt for either event kind by exact UUID/hash. Malformed, unknown or mismatching status is PP003. It does not lock for writing, reserve, append, refresh time, re-evaluate authority or authorize a retry after an unknown transaction outcome.

## Local fixture boundary and remaining integration

The test owner may request applied/pending/denied/conflict receipts to prove this ledger's structure and submitted-data semantics. The fixture deliberately materializes no positive regional rows. These receipts are local synthetic records; even read-only caller status does not make them evidence of real materialization, current authority, provider behavior or GA readiness.

The B installation must reject preexisting synthetic snapshot event/receipt/reservation history and preserve real head history. Load A+B on a fresh snapshot ledger, create snapshot state through the actual B materializer, and add the real complete generation/grant/head/provenance/fact/setup/negative checks in matching final/deferred guards. No permissive stub or materialization boolean may stand in for them. C must integrate ordinary admission/public-authorizer changes and snapshot dispatch atomically in the final coherent installation: schema5 alone would otherwise admit newly materialized legacy positive rows without these new predicates.

Local functional checks do not establish separate TCP-session contention/visibility, PostgreSQL17.6 provider behavior, late COMMIT/ACK timing, cost, source capture closure, a stable central snapshot builder, dispatcher reconciliation, live routing or service readiness. Existing billing and budget constraints are unaffected.

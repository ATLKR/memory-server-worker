# Inactive local head SQL draft

This draft is installed explicitly by disposable PGlite tests after migrations 0001–0005. It is not an installed migration, adds no version 6 marker, and does not alter public SQL functions, application configuration, routes or existing authority. It cannot apply snapshots or create accounts, claims, memberships, credentials, Spaces, grants, usage, provenance or leases.

The only caller entries are `memory_identity.seoul_projection_apply(text,text)` and `memory_ops.seoul_projection_status(text,text)`, returning canonical receipt **text**. Apply arguments are exact canonical head JSON text and lowercase SHA256 of those exact UTF-8 bytes. Status arguments are exact lowercase transport UUID and transport hash. Head `payloadSha256` means source-change digest and is independently bound to global source revision/source event ID. It is never substituted for the transport digest.

The receipt field order is fixed:

`version,kind,eventId,transportPayloadSha256,sourceRevision,eventKind,spaceId,snapshotSeq,attemptNo,outcome,reason,currentHeads,leaseExpiresAtMs,attemptedAtMs`.

Values are version 3, kind `seoul-projection-receipt`, exact event/hash/revision, eventKind `head`, null Space/sequence/lease, attemptNo 1, zero or one current exact head in codec field order, and a DB-observed safe millisecond attempted time. Stored bytes are immutable; replay and status return them without reserialization or refreshing time.

| Outcome | Reason | Meaning |
| --- | --- | --- |
| applied | head_applied | New current source head |
| applied | head_already_current | Same source tuple/effect under another transport ID |
| head_superseded | newer_head_present | Older consistent source; late irreversible evidence is still retained |
| conflict | source_identity_conflict | New transport ID claims an occupied source revision/event with a different tuple/effect |

Invalid text/hash/schema, including snapshots, raises `seoul_projection_input_invalid` before mutation. Changed bytes/hash under an occupied transport ID raises `seoul_projection_event_conflict` without changing its stored event/receipt. Unknown/mismatching status raises `seoul_projection_receipt_absent` and does not write. Future snapshot/pending receipt vocabulary is a separate reviewed unit; committed D1 delivery enums are unchanged.

Tables are memory_owner-owned, private, ENABLE/FORCE RLS and reject deletion/truncation. Events, source bindings, terminal receipts and irreversible evidence reject updates. Heads advance monotonically; explicit lifecycle state has its own monotonic revision. Subject deletion and immutable entity negatives remain independently terminal despite generic positives, explicit resume, or late delivery. Target removal remains immutable source history and is not a permanent Space tombstone; reselection and positive authority are unimplemented.

The nonlogin/noninherit/non-BYPASSRLS memory_projection_owner owns only code and receives exact table/column privileges with explicit RLS policies. memory_projection_caller receives schema USAGE plus the two EXECUTEs only. No caller/login membership path reaches the owner or existing capability roles. Temporary CREATE and provisioner SET/INHERIT edges are removed before commit; new owner default PUBLIC function execution is revoked. Public/runtime roles have no projection access. A singleton UPDATE lock serializes local apply; this one embedded-engine test does not prove independent TCP/provider concurrency, live lease behavior, cost or readiness.

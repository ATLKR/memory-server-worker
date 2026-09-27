# Seoul target manifest (inert local primitive)

This same-database primitive records a complete finite desired set, reconciles its exact additions and actual selected omissions, and observes agreement with an explicitly supplied parsed configuration. It has no runtime factory, public route, background loop, production target values, installer or permission gate. Local implementation and verification do not activate regional service.

The nine new tables retain immutable manifests, desired members, a current-generation singleton, 32-row inventory/verification pages, exact per-Space commands, seals, completion history, cancellation history and one transient operation witness. The selected-target partial index excludes historical false rows. Generation publication freezes target writes until inventory seals; every subsequent source, receipt, target and head revision path requires its exact current step. The existing target preparer may finalize only the same source/head through its actual eligible preparation stage and exact prepared/event/delivery facts.

## Named source inventory

Tables: `release_seoul_target_manifests`, `release_seoul_target_manifest_members`, `release_seoul_target_manifest_control`, `release_seoul_target_manifest_pages`, `release_seoul_target_manifest_steps`, `release_seoul_target_manifest_seals`, `release_seoul_target_manifest_completions`, `release_seoul_target_manifest_cancellations`, `release_seoul_target_manifest_attempt`.

Indexes: `release_seoul_targets_selected_space`, `target_manifest_steps_page`, `target_manifest_steps_expected_source`; other lookup indexes are the listed PK/UNIQUE constraints.

Constraints:

- `target_manifests_pk`
- `target_manifest_id_uq`
- `target_manifest_predecessor_uq`
- `target_manifest_predecessor_fk`
- `target_manifest_shape_ck`
- `target_manifest_members_pk`
- `target_manifest_member_order_uq`
- `target_manifest_members_generation_fk`
- `target_manifest_member_shape_ck`
- `target_manifest_control_pk`
- `target_manifest_control_generation_fk`
- `target_manifest_control_shape_ck`
- `target_manifest_pages_pk`
- `target_manifest_pages_generation_fk`
- `target_manifest_page_shape_ck`
- `target_manifest_steps_pk`
- `target_manifest_step_command_uq`
- `target_manifest_steps_generation_fk`
- `target_manifest_step_source_fk`
- `target_manifest_step_page_fk`
- `target_manifest_step_shape_ck`
- `target_manifest_seals_pk`
- `target_manifest_seals_generation_fk`
- `target_manifest_seal_shape_ck`
- `target_manifest_completions_pk`
- `target_manifest_completions_generation_fk`
- `target_manifest_completion_shape_ck`
- `target_manifest_cancellations_pk`
- `target_manifest_cancellation_id_uq`
- `target_manifest_cancellations_generation_fk`
- `target_manifest_cancellation_shape_ck`
- `target_manifest_attempt_pk`
- `target_manifest_attempt_shape_ck`

Triggers:

- `target_manifests_occupied`
- `target_manifests_immutable`
- `target_manifests_retained`
- `target_manifest_members_occupied`
- `target_manifest_members_immutable`
- `target_manifest_members_retained`
- `target_manifest_pages_occupied`
- `target_manifest_pages_immutable`
- `target_manifest_pages_retained`
- `target_manifest_steps_occupied`
- `target_manifest_steps_immutable`
- `target_manifest_steps_retained`
- `target_manifest_seals_occupied`
- `target_manifest_seals_immutable`
- `target_manifest_seals_retained`
- `target_manifest_completions_occupied`
- `target_manifest_completions_immutable`
- `target_manifest_completions_retained`
- `target_manifest_cancellations_occupied`
- `target_manifest_cancellations_immutable`
- `target_manifest_cancellations_retained`
- `target_manifest_control_insert`
- `target_manifest_control_retained`
- `target_manifest_control_advance`
- `target_manifest_attempt_fresh`
- `target_manifest_attempt_immutable`
- `target_manifest_attempt_context`
- `target_manifest_header_context`
- `target_manifest_member_context`
- `target_manifest_page_context`
- `target_manifest_step_context`
- `target_manifest_seal_context`
- `target_manifest_completion_context`
- `target_manifest_cancellation_context`
- `target_manifest_target_attempt_context`
- `target_manifest_source_context`
- `target_manifest_receipt_context`
- `target_manifest_head_insert_context`
- `target_manifest_head_update_context`
- `target_manifest_target_insert_context`
- `target_manifest_target_update_context`
- `target_manifest_page_desired_first`
- `target_manifest_page_desired_after`
- `target_manifest_page_omitted_first`
- `target_manifest_page_omitted_after`
- `target_manifest_page_verify_first`
- `target_manifest_page_verify_after`
- `target_manifest_page_previous_children`
- `target_manifest_seal_terminal_children`
- `target_manifest_completion_selected`
- `target_manifest_verify_exact_proof`
- `target_manifest_step_current_proof`
- `target_manifest_attempt_page_shape`

SQLite has no new role/privilege objects. Existing schema and all previous migration files stay byte-for-byte retained. Owner DDL tampering is outside the supported writer cooperation boundary.


## Immutable input and generation identity

Apply the full forward chain through 0035 before using this coordinator or the updated target writer. There is no missing-table fallback. The nine tables are installed empty except for one control singleton with a NULL generation. Existing targets are retained without fabricated manifests or history.

The pure codec owns exactly version, manifestId, expectedGeneration, operatorReference and spaceIds before asynchronous work. Version is 1; manifestId is a lowercase UUID; expectedGeneration is null or a positive safe integer. The audit reference is non-secret ASCII matching the identifier grammar at 1–256 bytes. Space IDs use the same grammar at 1–128 bytes, with 0–1024 unique entries in a dense ordinary array. Accessors, extra properties, invalid scalars, duplicates, coercion and negative zero are rejected. Canonicalization sorts ASCII IDs and never silently deduplicates them.

The canonical set is its sorted JSON string array. The canonical manifest has the five fields in the order above. SHA-256 uses distinct UTF-8 domains, memory:seoul-target-set:v1 followed by newline and memory:seoul-target-manifest:v1 followed by newline. Neither digest is a source-change or transport digest. Maximum set and manifest texts are 134,145 and 134,539 bytes; the largest escaped manifest string parameter is 136,603 bytes. These accepted configuration bounds are independent of the 131,072-byte source-event limit.

Publication is a predecessor CAS: null becomes generation 1, and an exact current predecessor becomes its safe successor. A manifest ID permanently names its exact bytes and both digests. Historical publication recovery requires those bytes/digests, all desired members at their canonical ordinals, and a current generation at least as large as the immutable published generation. An incomplete header or child set cannot establish publication. Adjacent monotonic advancement establishes historical publication without walking the predecessor chain. Exhausted generation or cumulative-count arithmetic returns capacity without an unsafe successor.

## Fixed API and atomic operations

createSeoulProjectionTargetManifest(database, adapter) accepts the same fixed native-d1 or durable-sql adapter assertion as the writer. This trusted adapter choice is not authentication. Every method receives one closed owned record. In the table, ref means exactly manifestId and generation, and a cursor is null or one valid Space ID.

| Method | Exact input beyond ref | Normal result / durable batch statements |
| --- | --- | --- |
| publish | The five-field manifest, rather than ref | published; 8 |
| readManifest | None | observed; read only |
| readPlanningPage | phase desired or omitted, afterSpaceId | planning_page; read only |
| appendPlanningPage | phase, pageNo, afterSpaceId, steps of exactly spaceId/commandId/expectedRevision | page_recorded; 6 |
| seal | None | sealed; 5 |
| cancel | cancellationId UUID, operatorReference | cancelled; 5 |
| readSteps | afterSpaceId | steps; read only |
| verifyPage | pageNo, afterSpaceId | page_verified; 6 |
| complete | None | completed; 5 |
| observeAgreement | configuredSpaceIds | agreed; read only |

The existing target writer adds setManifestStep with exactly ref and spaceId. It loads the immutable stored five-field command itself, uses the held private helper to own its current prior and historical proofs, and executes thirteen statements: manifest witness, original fixed ten-statement target plan, manifest cleanup and a consumed final assertion. Callers cannot provide target command facts, receipts, SQL, table names, digests or transaction callbacks through this method. Direct setTarget keeps its original ten-statement behavior while the current generation is null. After publication, a fresh direct command reports manifest_controlled; exact historical receipt recovery remains separately labeled.

Every durable batch starts with unconditional fresh staging and removes its own token. Retained manifest or target-operation staging is checked before historical replay. The real engine consumes scalar failure branches before transaction exit; omitted writes, RAISE(IGNORE), cleanup omissions and malformed results cannot be interpreted as successful completion. Source, receipt and manifest audit times come from the database. Historical replay preserves original times.

## Exact finite inventory and stability

Publication freezes target selection/revision mutation until inventory seals. Desired pages enumerate the manifest member key. Omitted pages enumerate actual prior-selected targets absent from that desired set. This includes partial progress of a superseded generation. The prior selected population K has no 1024 assumption. A partial selected-target index excludes retained false rows; first and subsequent pages use distinct indexed SQL, keyset cursors and 33-row lookahead, retaining at most 32 page items. No OFFSET, historical manifest substitute or whole-set copy is used.

Each append binds exactly the next items, their current expected revisions and caller-owned stable UUIDs. Selection is derived from the desired/omitted phase and the audit reference from the manifest. Immutable pages have gap-free predecessors, exact children, safe cumulative counts and explicit terminals, including empty first pages. The terminal seal binds both full chains and their counts. A missing desired Space can retain its exact absent-revision step; application reports target_missing until independent authorized Space creation makes that same step eligible.

After sealing, every old target attempt, target source insertion, receipt insertion, target INSERT/UPDATE and head revision path requires the exact current uncancelled generation and immutable step. A committed command cannot mint a second result under that generation. Thus a verified step's target, source and receipt remain stable through subsequent verification pages and final activation of central completion. Mere cached page booleans do not prove mutable state. The one permitted change is actual target preparation finalizing the same pending head to its exact digest under the retained 0034 preparation witness and exact prepared source/event/delivery bindings. Invalid non-null raw digests are rejected even while a head is pending.

Verification rechecks complete historical original-changed lineage and exact current target/head/source/prepared facts for each stored command, then repeats the fixed proof in the atomic page batch. The completion predicate also binds all five stored step fields. Final completion requires terminal verified count equal to the seal and exact actual selected equality: every desired member is selected and an indexed N+1 selected count contains no extra target. N is at most 1024; K was handled pagewise. Cancellation or supersession blocks current application/verification/completion. Earlier immutable history remains readable with a separately observed current status.

## Reads, recovery and agreement

| Read | Bounded returned shape |
| --- | --- |
| Manifest/publication observation | One validated scalar/header/control row and at most three small page summaries; publication compares canonical bytes and bounded member closure in SQL |
| Planning suggestion | At most 33 Space/revision pairs, then one final coherent control observation; it reserves nothing |
| Stored steps | At most 33 closed five-field commands; only 32 are returned or passed to target proof observation |
| Target proof page | At most 32 fixed target observations; SQL limits target source/prepared proof text to 4096 bytes per field before aggregation, accepted receipt text to 2048, current digest fields to canonical 64-byte text or NULL plus an explicit invalid-current marker |
| Agreement | One final coherent scalar proof, including immutable completedAtMs and database observedAtMs; no full manifest/source payload is returned |

The current head and prepared source/transport digest flags use actual BLOB length as well as TEXT grammar. Old SQLite TEXT checks can admit a hex prefix followed by NUL; this metadata must not enlarge a response or invalidate an unrelated exact historical receipt. Source, receipt and target grammar validation still precedes use of returned proof values. No 32-row page copies arbitrary 128 KiB prepared payloads. The helper's closed target grammar maximum is 587 source-record bytes, 988 source-row JSON bytes and 740 transport bytes. The 4096 extraction ceiling is a target-specific observation envelope, not an expanded accepted target grammar.

ReadSteps uses its final coherent target/control observation for current labels, including an additional final observation for an empty page. Historical receipt validity and currentResultValid are separate. Incomplete, cancelled and superseded generations cannot produce current agreement. readManifest is an advisory historical observation, not readiness evidence.

After a thrown batch or malformed acknowledgement, an operation makes exactly one fresh primary proof read and never automatically repeats its mutation. Only complete exact immutable history with no retained stage establishes the corresponding already_* result. An accepted old target command returns historical_commit with separate current/cancelled/superseded metadata where applicable. Absence, contradictory history, residue or a failed read returns uncertain. Late supersession/cancellation can deliberately abort the unconditional old target stage inside the thirteen statements; absent history after that abort is still uncertain. A future operator must settle its oldest potentially running uncertain call before intentionally resubmitting that immutable operation. New UUIDs or an empty receipt read do not settle it.

observeAgreement owns the actual parsed configuration supplied by its trusted future caller. It recomputes set identity and reconstructs the canonical manifest identity, then requires the same completed current uncancelled generation, exact bytes/digests/member closure, no stage residue and exact current selected equality in its final database read. Configuration order is semantically irrelevant; duplicates remain invalid. completedAtMs is the immutable completion time and observedAtMs is this final read's DB time. Neither is a lease or permission for a later regional request. Routing readers and configuration adoption are deliberately unwired.

Failures use bounded fixed statuses: invalid_input, manifest_conflict, generation_conflict, manifest_missing, superseded, cancelled, not_sealed, not_complete, page_conflict, target_state_invalid, staging_retained, capacity, request_limit, configuration_mismatch and uncertain. Exact historical replays use already_published, already_recorded, already_sealed, already_verified, already_completed or already_cancelled. Read-only phase exhaustion may report inventory_sealed or already_complete. No database error text, credentials, source payload or regional-readiness claim is exposed.

## Installation and verification scope

The source and generated 0035 migration are additive. They preserve all old schema/generated migration bytes. SQLite has no new roles or privileges. The migration generator only generates files; it is not an incremental D1/Durable installer. This forward source contains no standalone BEGIN/COMMIT and is compatible with the actual existing Wrangler splitter. Local tests execute complete ordered split chains, and separate explicit transaction fixtures inject late DDL/postflight errors to prove full schema and metadata rollback. Live installation remains a later root-owned integration task.

Every operation checks the existing limits of 100 statements, 100 parameters per statement, 100,000 UTF-8 SQL bytes per statement and a 1 MiB serialized request with the existing 4096-byte reserve. The fixed batches above are smaller. Evidence includes maximum 1024-ID publication, a 32-proof request, K=1057 selected omissions beside 1057 retained false rows, actual first/after keyset plans and full generation/phase/page child seeks. Actual measured request/response sizes and command outcomes belong to the pinned implementation report; they are local fixture measurements, not a database allocator or provider cost ceiling.

The contract applies to supported same-database writers with installed guards. A database owner replacing triggers or fabricating arbitrary proof tables is outside that cooperation boundary. The unit adds no regional admission, snapshot construction, retained-row backfill, lease/dispatch runtime, routing/configuration change, cost acceptance or GA. Projection state stays backfill-required; paid billing and service activation remain unchanged.

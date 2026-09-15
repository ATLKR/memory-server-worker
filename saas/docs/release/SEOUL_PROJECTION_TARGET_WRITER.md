# Inactive single-Space target writer

`createSeoulProjectionTargetWriter(database, adapter)` creates one trusted same-database primitive. It has no runtime factory, public route, operator authentication, selected Space list or background execution. The adapter is the fixed `native-d1` / `durable-sql` caller assertion used by the other inactive projection modules. It is not a cryptographic provenance or authorization proof.

Apply the complete forward migration chain through `0034_seoul-projection-target-schema.sql` before using this writer or the updated preparer. The new schema preserves every historical source/generated migration. It adds the target-operation witness, immutable target-command receipts, receipt indexes and a separate target preparation witness. Projection state remains `backfill-required`.

## Command and receipt

`setTarget(unknown)` owns exactly `commandId`, `spaceId`, `expectedRevision`, `selected`, and `operatorReference` before any asynchronous work. The command is a closed scalar record without accessors or extra fields. Command ID is a lowercase UUID. Space uses `[A-Za-z0-9][A-Za-z0-9._:-]*` at 1–128 ASCII bytes; operatorReference uses the same grammar at 1–256 bytes. The latter is non-secret audit data and gives no authority. Expected revision is null or a positive safe integer; zero, negative zero, coercion and unsafe values are rejected. Selected is a strict boolean. Invalid commands make zero DB calls.

Accepted receipt fields, in canonical order, are `commandId`, `spaceId`, `expectedRevision`, `selected`, `operatorReference`, `outcome`, `resultingRevision`, `resultingEventId`, and `decidedAtMs`. Outcome is `changed` or `unchanged`. Receipts are immutable scalar rows; no caller may supply an accepted receipt blob. Their exact source revision/event FK, canonical target body, selection and original changed-command lineage are checked. A full source-pair index covers unchanged as well as changed receipts; a partial unique index prevents two changed receipts claiming one source.

A clean absent target requires an existing Space and no current target row/head. Initial true and initial false each create a changed source. A false row remains retained and dirty. An existing target at the exact expected revision with the same choice creates only an unchanged receipt; it leaves source/head/dirty/captured, preparation/delivery, claim/lease and published state unchanged. Different choices create one higher source revision. A stale expectation fails even when the desired choice now happens to match.

Changed source, receipt and source-body changedAtMs use one actual DB decision-time scalar. The writer accepts no application clock or timestamp override. An unchanged receipt has its own DB audit time but refers to the older original changed source; it never claims that the new command created that source. Historical replay does not resample time or require its result to still be today's target.

## Historical proof and current mutation

The current target must bind the exact source/head revision/event/key, canonical target body and original changed receipt addressed by that source's source_command_id. Missing lineage, orphan heads and malformed legacy bodies are invalid retained state; no adoption, overwrite or repair is performed.

Historical command proof uses indexed immutable source/receipt joins and exact canonical target-body construction. It is independent of the current target/head and does not require preparation. This same proof applies to an identical command that wins the interval between preflight and the batch; its new revision/time/event are not vouched for by the loser's older cached digest.

Planning a fresh current mutation separately owns and hashes the complete current source. A non-null head digest must match that actual computed source digest and the exact prepared source, transport digest/text, event metadata and delivery. A NULL-to-exact prepared finalization during the read/batch interval is permitted; unchanged leaves it intact, while changed creates a higher pending head. The writer never supplies a SQL digest or clears permanent identity negatives.

Retained target-operation staging has precedence over every historical replay. A coherent first-primary observation returns `staging_retained` without writes if any operation row remains. There is no automatic stage cleanup. The two preparation tables have their own both-direction retained-stage rule.

## One atomic attempt

The writer performs no durable write outside one ten-statement batch. Other writers may run between first-primary reads and that batch. The batch uses an unconditional fresh witness, records actual decision-time receipt/target/head/source/dirty observations, and compares its owned prior tuple inside the transaction. Eligibility is a column; an ineligible operation cannot reuse a retained witness.

The fixed sequence is witness insertion, changed source insertion, accepted receipt insertion, initial-target INSERT, existing-target CAS UPDATE, changed dirty INSERT/UPDATE, consumed completion SELECT, bounded result SELECT, own-token cleanup, and consumed no-leftover SELECT. Separate target INSERT and UPDATE make absence and present-state CAS explicit. Source revision is obtained only through the exact inserted source identity.

The dirty INSERT reads current dirty and captured values in that same statement, including legitimate progress after witness creation; its conflict branch updates only the maximum dirty revision. It never writes a cached captured revision. Changed completion treats the staged captured value as a lower bound. Unchanged and ineligible completion require exact preservation of their actual staged dirty/captured observation. Ineligible branches also preserve observed current target/head, Space presence and indexed source-command absence/presence, including conflicting orphan state. A raced historical success rechecks complete original source lineage at completion.

Both final assertions are SELECT scalars consumed before the actual Durable engine leaves `transactionSync`. Missing stage or an omitted required step fails the first; retained operation residue fails the last. Their failure branch is SQLite's lazy integer-overflow expression. A table trigger's RAISE(IGNORE) cannot skip a SELECT assertion. This is transaction completion integrity, not a defense against a trusted SQL owner changing schemas or arbitrarily fabricating witnesses.

## Results and unknown acknowledgements

Results are `committed` / `already_committed` with the exact nine-field receipt, or a fixed no-payload `invalid_command`, `command_conflict`, `target_missing`, `target_state_invalid`, `stale_revision`, `staging_retained`, `request_limit`, or `uncertain` status. No SQL error, source body, operator authentication claim or regional readiness result is returned.

After a thrown batch or malformed response, make exactly one fresh first-primary historical observation. Only a complete matching receipt proof with no operation residue returns `already_committed`; absence, residue, contradiction or read failure returns `uncertain`. Never repeat a mutation, regenerate IDs, infer rollback from a missing receipt, or borrow the preparer's `preparation_absent` semantics. A future operator transport must resolve an earlier potentially running uncertain invocation before another intentional mutation.

## Source preparation and limits

The target source body is closed: version 3, kind target-source, Space, selected, changedAtMs, command target-reconcile origin with exact receipt UUID, and effect. Selected true permits only entity-head/changed. False permits only entity-negative/target/removed with matching Space/time. Source command ID, origin receipt, key and timestamp must agree. Source and transport digests remain distinct; the head wire union is unchanged.

The frozen 0029 witness admits only the prior six streams. 0034 therefore adds `release_seoul_target_preparation_stage` with the same exact source FKs/bounds and target-only Space grammar. Updated preparation uses one of two fixed table literals after codec validation and observes both stages. A new target-table fresh trigger checks old and new tables, while one additive old-table trigger checks the target table. Existing old trigger definitions and seven-statement preparer behavior remain intact. There is no mixed-schema fallback or caller-selected table name.

The writer uses at most 100 statements, 100 values per statement, 100,000 SQL bytes per statement, and 1 MiB serialized request including the existing 4,096-byte reserve. Source body remains bounded to 128 KiB. All added lookups bind receipt PK, exact Space/head key, source revision/event or leading command/kind/key index before semantic checks. No whole target/account/source-history enumeration, global max revision, guessed rowid, changes() count or digest override is used.

Local tests cover actual Durable and D1-shaped execution, recursion ON/OFF, schema preservation, strict ownership, CAS/replay/lineage, digest finalization, skipped writes and rollback, unknown ACK, indexed bounds, and persisted source/preparer/HMAC/actual PostgreSQL head receipt composition. These tests do not constitute a live-provider deployment or physical COMMIT-time deadline guarantee.

Complete finite-manifest identity/digest, additions and omitted-ID removals, obsolete-manifest exclusion, partial progress/recovery and exact runtime configuration agreement remain separate mandatory work. This primitive selects no operational target and does not complete backfill, positive snapshot materialization/admission, cost acceptance or GA.

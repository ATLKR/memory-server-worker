-- Regional migration 0016: erasure_ledger forward-only completion stamp.
--
-- The daily vector_resweep re-runs an erased memory's delete job and
-- re-confirms that every retained vector identifier is gone; each confirmed
-- pass must be able to move vector_erased_at forward so the ledger records
-- the last confirmed cleanup, not the first. The trigger still denies every
-- other column change, deleting the row, clearing the stamp, or rewriting it
-- backwards.
BEGIN;
SET LOCAL ROLE memory_owner;

DROP TRIGGER erasure_ledger_completion ON memory_ops.erasure_ledger;
CREATE TRIGGER erasure_ledger_completion BEFORE UPDATE ON memory_ops.erasure_ledger
  FOR EACH ROW WHEN (
    NEW.memory_id IS DISTINCT FROM OLD.memory_id OR NEW.space_id IS DISTINCT FROM OLD.space_id
    OR NEW.erased_at IS DISTINCT FROM OLD.erased_at
    OR (NEW.vector_erased_at IS DISTINCT FROM OLD.vector_erased_at
        AND OLD.vector_erased_at IS NOT NULL
        AND (NEW.vector_erased_at IS NULL OR NEW.vector_erased_at <= OLD.vector_erased_at)))
  EXECUTE FUNCTION memory_control.reject_mutation();

INSERT INTO memory_control.schema_migrations(version, name) VALUES (16, '0016_erasure_completion.sql');
COMMIT;

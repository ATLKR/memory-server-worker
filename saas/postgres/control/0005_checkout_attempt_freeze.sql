-- Control-plane lineage, version 5. Attempted checkout parameters are frozen:
-- a claimed request keeps its pool, price, operation key, creation time and the
-- winning expiry so retries replay identical Stripe parameters (D1 trigger
-- release_checkout_attempt_immutable).
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE TRIGGER checkout_attempt_immutable BEFORE UPDATE ON memory_control.checkout_requests
  FOR EACH ROW WHEN (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.pool_id IS DISTINCT FROM OLD.pool_id
    OR NEW.price_id IS DISTINCT FROM OLD.price_id
    OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.checkout_attempted = 1
      AND (NEW.checkout_attempted IS DISTINCT FROM 1 OR NEW.expires_at IS DISTINCT FROM OLD.expires_at)))
  EXECUTE FUNCTION memory_control.reject_mutation();

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (5, '0005_checkout_attempt_freeze.sql');
COMMIT;

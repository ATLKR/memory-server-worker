-- Forward SaaS migration 8: checkout-schema.sql
-- Checkout recovery for the next release. Applied migrations 0001..0007 stay frozen.
-- Existing rows (and writes from older code) have unknown provider history, so
-- their expiry must remain immutable even when session_id/checkout_url are NULL.
ALTER TABLE release_checkout_requests ADD COLUMN checkout_attempted INTEGER NOT NULL DEFAULT 1 CHECK(checkout_attempted IN (0,1));
CREATE TRIGGER release_checkout_attempt_immutable BEFORE UPDATE ON release_checkout_requests
WHEN NEW.id IS NOT OLD.id OR NEW.pool_id IS NOT OLD.pool_id OR NEW.price_id IS NOT OLD.price_id
  OR NEW.operation_key IS NOT OLD.operation_key OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.checkout_attempted=1 AND (NEW.checkout_attempted<>1 OR NEW.expires_at IS NOT OLD.expires_at))
BEGIN SELECT RAISE(ABORT,'Checkout attempt parameters are immutable'); END;
UPDATE release_meta SET version=8 WHERE version=6;

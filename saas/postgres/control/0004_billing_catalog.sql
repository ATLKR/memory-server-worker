-- Control-plane lineage, version 4. The global billing catalog and provider
-- cost reservations (D1 migrations 0006, 0008, 0010, 0023): pools keyed by the
-- derived account:/org: ids, checkout requests/closures, the billing event
-- queue and lock, heartbeats, and provider budgets.
--
-- Cross-tier adjustments:
-- - Checkout-closure and pool-usage predicates that read regional spaces or
--   regional identity (active_credentials/memberships) are evaluated at the
--   service boundary before a central receipt is written; the tables keep the
--   receipts and the immutable evidence, not the cross-cluster guard.
-- - actor_credential_id on checkout_closures names a regional credential row;
--   it is stored for audit, not referenced.
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE TABLE memory_control.pools (
  id memory_control.identifier PRIMARY KEY,
  plan text NOT NULL DEFAULT 'free',
  monthly_units bigint NOT NULL DEFAULT 1000 CHECK (monthly_units >= 0),
  storage_limit_bytes bigint NOT NULL DEFAULT 104857600 CHECK (storage_limit_bytes >= 0),
  storage_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'read_only')),
  customer_id text UNIQUE,
  subscription_id text UNIQUE,
  updated_at memory_control.epoch_ms NOT NULL DEFAULT 0
);
-- Space placement creates the owner's pool row, as in D1.
CREATE FUNCTION memory_control.space_pool_insert() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_control.pools(id)
    VALUES(CASE WHEN NEW.organization_id IS NULL THEN 'account:' || NEW.owner_account_id
      ELSE 'org:' || NEW.organization_id END)
    ON CONFLICT (id) DO NOTHING;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER space_pool_insert AFTER INSERT ON memory_control.spaces
  FOR EACH ROW EXECUTE FUNCTION memory_control.space_pool_insert();
CREATE TRIGGER pools_no_delete BEFORE DELETE ON memory_control.pools
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER pools_no_truncate BEFORE TRUNCATE ON memory_control.pools
  FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_control.checkout_requests (
  id memory_control.identifier PRIMARY KEY,
  pool_id memory_control.identifier REFERENCES memory_control.pools(id),
  price_id text NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  operation_key text,
  session_id text,
  checkout_url text,
  expires_at memory_control.epoch_ms NOT NULL DEFAULT 0,
  checkout_attempted smallint NOT NULL DEFAULT 1 CHECK (checkout_attempted IN (0, 1))
);
CREATE UNIQUE INDEX checkout_key ON memory_control.checkout_requests(pool_id, operation_key);

CREATE TABLE memory_ops.checkout_closures (
  request_id memory_control.identifier PRIMARY KEY REFERENCES memory_control.checkout_requests(id),
  session_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('expired', 'subscription_ended')),
  subscription_id text,
  actor_credential_id memory_control.identifier NOT NULL,
  checked_at memory_control.epoch_ms NOT NULL,
  CHECK ((state = 'expired' AND subscription_id IS NULL)
    OR (state = 'subscription_ended' AND subscription_id IS NOT NULL))
);
CREATE TRIGGER checkout_closures_append_only BEFORE UPDATE OR DELETE ON memory_ops.checkout_closures
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_ops.billing_events (
  id memory_control.identifier PRIMARY KEY,
  subscription_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt bigint NOT NULL DEFAULT 0,
  available_at memory_control.epoch_ms NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  last_error text
);
CREATE TABLE memory_ops.billing_lock (
  id smallint PRIMARY KEY CHECK (id = 1),
  token text,
  expires_at memory_control.epoch_ms NOT NULL DEFAULT 0
);
INSERT INTO memory_ops.billing_lock(id) VALUES(1);
CREATE TRIGGER billing_lock_no_delete BEFORE DELETE ON memory_ops.billing_lock
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_ops.heartbeats (
  name text PRIMARY KEY,
  last_success_at memory_control.epoch_ms NOT NULL
);

-- Provider cost reservations per month/kind; reserve before uncertain network
-- effects and never refund a potentially billed call.
CREATE TABLE memory_ops.provider_budgets (
  month text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  kind text NOT NULL CHECK (kind IN ('embedding', 'extraction')),
  calls bigint NOT NULL CHECK (calls >= 0),
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd >= 0),
  PRIMARY KEY (month, kind)
);

DO $boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'memory_control.pools', 'memory_control.checkout_requests',
    'memory_ops.checkout_closures', 'memory_ops.billing_events',
    'memory_ops.billing_lock', 'memory_ops.heartbeats', 'memory_ops.provider_budgets'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING (true) WITH CHECK (true)', target);
  END LOOP;
END
$boundaries$;

-- Derived space→pool mapping, identical to the regional view so the billing
-- service can resolve a Space to its pool on either lineage.
CREATE VIEW memory_ops.space_pools AS
  SELECT s.id AS space_id,
    CASE WHEN s.organization_id IS NULL THEN 'account:' || s.owner_account_id
      ELSE 'org:' || s.organization_id END AS pool_id
  FROM memory_control.spaces s;

REVOKE ALL ON memory_control.pools, memory_control.checkout_requests,
  memory_ops.checkout_closures, memory_ops.billing_events, memory_ops.billing_lock,
  memory_ops.heartbeats, memory_ops.provider_budgets
  FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON FUNCTION memory_control.space_pool_insert() FROM PUBLIC;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (4, '0004_billing_catalog.sql');
COMMIT;

-- Regional lineage, version 18. Raw metering facts (2026-09-24 plan):
-- usage_events.units is a rating, not a measurement. usage_facts carries the
-- physical dimensions per committed operation so future pricing re-derives
-- without data loss. storage_byte_deltas records the timestamped deltas the
-- gauge collapses, making byte-hours reconstructable.
BEGIN;
SET LOCAL ROLE memory_owner;

ALTER TABLE memory_ops.release_operations
  ADD COLUMN detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object');

CREATE TABLE memory_ops.usage_facts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id memory_control.identifier NOT NULL
    REFERENCES memory_ops.release_operations(id),
  pool_id text NOT NULL,
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  account_id memory_control.identifier NOT NULL,
  action text NOT NULL,
  period text NOT NULL,
  rate_version integer NOT NULL DEFAULT 1 CHECK (rate_version >= 1),
  units bigint NOT NULL,
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  items bigint NOT NULL DEFAULT 0 CHECK (items >= 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  occurred_at memory_control.epoch_ms NOT NULL
);
CREATE INDEX usage_facts_pool_period ON memory_ops.usage_facts(pool_id, period);
CREATE INDEX usage_facts_space ON memory_ops.usage_facts(space_id, occurred_at);
CREATE TRIGGER usage_facts_append_only BEFORE UPDATE OR DELETE ON memory_ops.usage_facts
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_ops.storage_byte_deltas (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  delta bigint NOT NULL,
  occurred_at memory_control.epoch_ms NOT NULL
);
CREATE INDEX storage_byte_deltas_space ON memory_ops.storage_byte_deltas(space_id, occurred_at);
CREATE TRIGGER storage_byte_deltas_append_only BEFORE UPDATE OR DELETE
  ON memory_ops.storage_byte_deltas FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

-- Metering trigger extension: a facts row per committed operation, carrying the
-- receipt's detail. Failed operations never reach release_operations, so their
-- provider-side consumption is recorded by the reservation layer, not here.
CREATE OR REPLACE FUNCTION memory_ops.operation_meter() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_ops.usage_events
    SELECT NEW.id, sp.pool_id, NEW.account_id, NEW.period, NEW.units, NEW.created_at
    FROM memory_ops.space_pools sp WHERE sp.space_id = NEW.space_id;
  INSERT INTO memory_ops.usage_counters(pool_id, period, units)
    SELECT sp.pool_id, NEW.period, NEW.units FROM memory_ops.space_pools sp
    WHERE sp.space_id = NEW.space_id
    ON CONFLICT (pool_id, period) DO UPDATE SET units = usage_counters.units + excluded.units;
  INSERT INTO memory_ops.usage_facts
    (operation_id, pool_id, space_id, account_id, action, period, units,
     bytes, items, detail, occurred_at)
    SELECT NEW.id, sp.pool_id, NEW.space_id, NEW.account_id, NEW.action,
      NEW.period, NEW.units,
      coalesce((NEW.detail->>'bytes')::bigint, 0),
      coalesce((NEW.detail->>'items')::bigint, 0),
      NEW.detail, NEW.created_at
    FROM memory_ops.space_pools sp WHERE sp.space_id = NEW.space_id;
  RETURN NULL;
END
$apply$;

-- Byte-hour reconstruction: every delta the gauge applies is also a row.
CREATE OR REPLACE FUNCTION memory_ops.storage_accounting() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
DECLARE delta bigint; v_space text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    delta := coalesce(NEW.logical_bytes, octet_length(NEW.body) + coalesce(octet_length(NEW.source), 0)
      + octet_length(NEW.provenance::text));
    v_space := NEW.space_id;
  ELSIF TG_OP = 'UPDATE' THEN
    delta := (CASE WHEN NEW.erased_at IS NULL
        THEN coalesce(NEW.logical_bytes, octet_length(NEW.body) + coalesce(octet_length(NEW.source), 0)
          + octet_length(NEW.provenance::text)) ELSE 0 END)
      - coalesce(OLD.logical_bytes, octet_length(OLD.body) + coalesce(octet_length(OLD.source), 0)
        + octet_length(OLD.provenance::text));
    v_space := NEW.space_id;
  ELSE
    delta := -coalesce(OLD.logical_bytes, octet_length(OLD.body) + coalesce(octet_length(OLD.source), 0)
      + octet_length(OLD.provenance::text));
    v_space := OLD.space_id;
  END IF;
  INSERT INTO memory_ops.storage_byte_deltas(space_id, delta, occurred_at)
    VALUES(v_space, delta, memory_control.now_ms());
  INSERT INTO memory_ops.space_storage_counters(space_id, bytes) VALUES(v_space, greatest(delta, 0))
    ON CONFLICT (space_id) DO UPDATE SET bytes = space_storage_counters.bytes + delta;
  RETURN NULL;
END
$apply$;

DO $boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'memory_ops.usage_facts', 'memory_ops.storage_byte_deltas'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING (true) WITH CHECK (true)', target);
  END LOOP;
END
$boundaries$;

GRANT SELECT ON memory_ops.usage_facts, memory_ops.storage_byte_deltas
  TO memory_runtime, memory_background;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (18, '0018_metering_facts.sql');
COMMIT;

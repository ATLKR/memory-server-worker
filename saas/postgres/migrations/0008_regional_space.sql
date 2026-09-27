-- Regional lineage, version 8. Regional-space core: memory content/history,
-- Space-scoped ops ledgers, the job queue, and the search-reference tables —
-- ported from D1 migrations 0002, 0006, 0007, 0009, 0012, 0013, 0014, 0015,
-- 0016, 0017, 0019, 0021 and the base columns of 0022, per the frozen
-- classification. The payload-staging tables and payload-reference triggers
-- land in the next regional migration.
--
-- Cross-tier adjustments (classification: release_pools stays central):
-- - Pool quota (monthly units) and storage-limit checks are cross-tier reads
--   performed at the service boundary, not inside regional SQL. Regional
--   triggers keep the metering (usage_events + usage_counters) and per-space
--   byte accounting (memory_ops.space_storage_counters); they cannot update a
--   central table from a regional cluster.
-- - release_fts (the FTS5 virtual table) is not ported; the stable
--   rowid↔memory mapping (release_fts_rows) and the job-enqueue triggers are,
--   so whichever regional search mechanism lands can index consistently.
-- - release_jobs carries every column the later ALTERs added (queued_at,
--   next_chunk, cleanup_cursor, cleanup_pending, cleanup_retry_at,
--   cleanup_retry_delay); memories/memory_versions carry the 0022 payload
--   columns now so no ALTER is needed later.
BEGIN;
SET LOCAL ROLE memory_owner;

-- ---------------------------------------------------------------------------
-- Content.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_content.memories (
  id memory_control.identifier PRIMARY KEY,
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  body text NOT NULL CHECK (body !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' AND octet_length(body) BETWEEN 1 AND 16384
    AND length(btrim(body)) > 0),
  source text CHECK (source IS NULL OR (source !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' AND octet_length(source) <= 2048)),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at memory_control.epoch_ms NOT NULL,
  updated_at memory_control.epoch_ms NOT NULL CHECK (updated_at >= created_at),
  deleted_at memory_control.epoch_ms CHECK (deleted_at IS NULL OR deleted_at = updated_at),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  kind text NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact', 'event', 'instruction', 'task')),
  provenance jsonb NOT NULL DEFAULT '{"originKind":"user"}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  event_time memory_control.epoch_ms,
  supersedes_id memory_control.identifier REFERENCES memory_content.memories(id),
  erased_at memory_control.epoch_ms,
  payload_id text, payload_shard_id text, payload_object_key text,
  payload_sha256 text, payload_bytes bigint, logical_bytes bigint
);
CREATE INDEX memories_live_space ON memory_content.memories(space_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX release_memories_payload ON memory_content.memories(payload_id) WHERE payload_id IS NOT NULL;
CREATE UNIQUE INDEX release_one_successor ON memory_content.memories(supersedes_id)
  WHERE supersedes_id IS NOT NULL;
CREATE INDEX release_memories_deleted ON memory_content.memories(deleted_at)
  WHERE deleted_at IS NOT NULL AND erased_at IS NULL;

CREATE TABLE memory_content.memory_versions (
  memory_id memory_control.identifier NOT NULL REFERENCES memory_content.memories(id),
  revision bigint NOT NULL,
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  body text NOT NULL,
  source text,
  created_at memory_control.epoch_ms NOT NULL,
  updated_at memory_control.epoch_ms NOT NULL,
  deleted_at memory_control.epoch_ms,
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  archived_at memory_control.epoch_ms NOT NULL,
  kind text NOT NULL DEFAULT 'fact',
  provenance jsonb NOT NULL DEFAULT '{"originKind":"user"}'::jsonb,
  event_time memory_control.epoch_ms,
  supersedes_id memory_control.identifier,
  payload_id text, payload_shard_id text, payload_object_key text,
  payload_sha256 text, payload_bytes bigint, logical_bytes bigint,
  PRIMARY KEY (memory_id, revision)
);
CREATE INDEX release_versions_payload ON memory_content.memory_versions(payload_id)
  WHERE payload_id IS NOT NULL;

CREATE TABLE memory_ops.memory_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('space_created', 'memory_created', 'memory_updated', 'memory_deleted')),
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  memory_id memory_control.identifier REFERENCES memory_content.memories(id),
  revision bigint,
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  created_at memory_control.epoch_ms NOT NULL
);

-- ---------------------------------------------------------------------------
-- Ops ledgers: operations, metering, policies, erasure, export, cursors.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_ops.usage_counters (
  pool_id text,
  period text,
  units bigint NOT NULL DEFAULT 0 CHECK (units >= 0),
  PRIMARY KEY (pool_id, period)
);
CREATE TABLE memory_ops.release_operations (
  id memory_control.identifier PRIMARY KEY,
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  client_key text NOT NULL,
  request_hash text NOT NULL,
  action text NOT NULL,
  memory_id memory_control.identifier,
  expected_revision bigint,
  committed_revision bigint,
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  created_at memory_control.epoch_ms NOT NULL,
  period text NOT NULL,
  units bigint NOT NULL CHECK (units >= 0),
  UNIQUE (account_id, space_id, client_key)
);
CREATE TABLE memory_ops.usage_events (
  operation_id memory_control.identifier PRIMARY KEY REFERENCES memory_ops.release_operations(id),
  pool_id text NOT NULL,
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  period text NOT NULL,
  units bigint NOT NULL,
  created_at memory_control.epoch_ms NOT NULL
);
CREATE TABLE memory_ops.space_policies (
  space_id text PRIMARY KEY REFERENCES memory_control.spaces(id),
  retention_days bigint NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650)
);
CREATE TABLE memory_ops.erasure_permits (
  memory_id memory_control.identifier PRIMARY KEY REFERENCES memory_content.memories(id),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  created_at memory_control.epoch_ms NOT NULL
);
CREATE TABLE memory_ops.erasure_ledger (
  memory_id memory_control.identifier PRIMARY KEY REFERENCES memory_content.memories(id),
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  erased_at memory_control.epoch_ms NOT NULL,
  vector_erased_at memory_control.epoch_ms
);
CREATE TABLE memory_ops.release_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  actor_credential_id memory_control.identifier REFERENCES memory_identity.credentials(id),
  resource_id text NOT NULL,
  created_at memory_control.epoch_ms NOT NULL
);
CREATE TABLE memory_ops.export_sessions (
  id memory_control.identifier PRIMARY KEY,
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  watermark bigint NOT NULL,
  expires_at memory_control.epoch_ms NOT NULL,
  created_at memory_control.epoch_ms NOT NULL
);
CREATE INDEX release_exports_expiry ON memory_ops.export_sessions(expires_at, id);
CREATE TABLE memory_ops.maintenance_progress (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at memory_control.epoch_ms NOT NULL
);
CREATE TABLE memory_ops.payload_backfill_progress (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at memory_control.epoch_ms NOT NULL
);
-- Per-space live+history byte accounting, maintained by triggers. The central
-- pool catalog holds the limit; the service boundary compares.
CREATE TABLE memory_ops.space_storage_counters (
  space_id text PRIMARY KEY REFERENCES memory_control.spaces(id),
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0)
);

-- ---------------------------------------------------------------------------
-- Jobs and search references.
-- ---------------------------------------------------------------------------
CREATE TABLE memory_jobs.release_jobs (
  id text PRIMARY KEY,
  memory_id memory_control.identifier REFERENCES memory_content.memories(id),
  space_id text REFERENCES memory_control.spaces(id),
  revision bigint,
  kind text NOT NULL CHECK (kind IN ('upsert', 'delete', 'ingest')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done', 'dead')),
  attempt bigint NOT NULL DEFAULT 0,
  available_at memory_control.epoch_ms NOT NULL,
  lease_until memory_control.epoch_ms,
  lease_token text,
  last_error text,
  created_at memory_control.epoch_ms NOT NULL,
  queued_at memory_control.epoch_ms,
  next_chunk bigint NOT NULL DEFAULT 0 CHECK (next_chunk >= 0),
  cleanup_cursor text NOT NULL DEFAULT '',
  cleanup_pending jsonb NOT NULL DEFAULT '[]'::jsonb,
  cleanup_retry_at memory_control.epoch_ms NOT NULL DEFAULT 0,
  cleanup_retry_delay memory_control.epoch_ms NOT NULL DEFAULT 60000
);
CREATE INDEX release_jobs_due ON memory_jobs.release_jobs(state, available_at, lease_until);

CREATE TABLE memory_search.vector_refs (
  memory_id memory_control.identifier REFERENCES memory_content.memories(id),
  vector_id text PRIMARY KEY,
  revision bigint NOT NULL
);
-- Stable search-row mapping; the FTS mechanism itself is a later regional
-- decision (postgres FTS vs pgvector vs external).
CREATE TABLE memory_search.fts_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  memory_id memory_control.identifier UNIQUE NOT NULL REFERENCES memory_content.memories(id)
);

CREATE TABLE memory_content.release_ingests (
  id text PRIMARY KEY,
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  actor_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  ciphertext text,
  proposals text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'review', 'approved', 'cancelled', 'expired', 'failed')),
  expires_at memory_control.epoch_ms NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  approval_hash text,
  result_ids text
);
CREATE INDEX release_ingests_expiry ON memory_content.release_ingests(expires_at, id)
  WHERE ciphertext IS NOT NULL OR proposals IS NOT NULL OR state IN ('queued', 'review', 'failed');
CREATE TABLE memory_jobs.ingest_operations (
  operation_id memory_control.identifier PRIMARY KEY REFERENCES memory_ops.release_operations(id),
  ingest_id text NOT NULL REFERENCES memory_content.release_ingests(id)
);
CREATE TABLE memory_jobs.ingest_approvals (
  operation_id memory_control.identifier PRIMARY KEY REFERENCES memory_ops.release_operations(id),
  ingest_id text UNIQUE NOT NULL REFERENCES memory_content.release_ingests(id),
  approval_hash text NOT NULL,
  result_ids text NOT NULL,
  created_at memory_control.epoch_ms NOT NULL
);
CREATE FUNCTION memory_jobs.ingest_approval_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_content.release_ingests i
      JOIN memory_ops.release_operations o ON o.id = NEW.operation_id
      WHERE i.id = NEW.ingest_id AND i.account_id = o.account_id AND i.space_id = o.space_id
        AND i.state = 'review' AND i.expires_at > NEW.created_at)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_conflict'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER ingest_approval_guard BEFORE INSERT ON memory_jobs.ingest_approvals
  FOR EACH ROW EXECUTE FUNCTION memory_jobs.ingest_approval_guard();

-- Derived space→pool mapping (pool id is derived from the owner; the pool
-- catalog itself is central).
CREATE VIEW memory_ops.space_pools AS
  SELECT s.id AS space_id,
    CASE WHEN s.organization_id IS NULL THEN 'account:' || s.owner_account_id
      ELSE 'org:' || s.organization_id END AS pool_id
  FROM memory_control.spaces s;

-- Byte-size views (0022 final shape; logical_bytes overrides measured bytes).
CREATE VIEW memory_content.release_memory_sizes AS
  SELECT id, space_id,
    CASE WHEN erased_at IS NULL
      THEN coalesce(logical_bytes, octet_length(body) + coalesce(octet_length(source), 0)
        + octet_length(provenance::text))
      ELSE 0 END AS bytes
  FROM memory_content.memories;
CREATE VIEW memory_content.release_version_sizes AS
  SELECT memory_id, revision, space_id,
    coalesce(logical_bytes, octet_length(body) + coalesce(octet_length(source), 0)
      + octet_length(provenance::text)) AS bytes
  FROM memory_content.memory_versions;

-- ---------------------------------------------------------------------------
-- Memory transition rules (0006-era shape; the payload-aware version lands
-- with the payload tables in the next migration).
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_content.memory_validate_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW.id <> OLD.id OR NEW.space_id <> OLD.space_id OR NEW.created_at <> OLD.created_at
    OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
    OR OLD.erased_at IS NOT NULL
    OR (NEW.erased_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_ops.erasure_permits p
      WHERE p.memory_id = OLD.id AND p.actor_credential_id = NEW.actor_credential_id))
    OR (NEW.erased_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL)
    OR (NEW.erased_at IS NULL AND NEW.deleted_at IS NOT NULL
      AND (NEW.body <> OLD.body OR NEW.source IS DISTINCT FROM OLD.source))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid memory transition'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER memories_validate_transition BEFORE UPDATE ON memory_content.memories
  FOR EACH ROW EXECUTE FUNCTION memory_content.memory_validate_transition();

CREATE FUNCTION memory_content.memory_initial_revision() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW.revision <> 1 OR NEW.deleted_at IS NOT NULL OR NEW.created_at <> NEW.updated_at
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid initial memory state'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER memories_initial_revision BEFORE INSERT ON memory_content.memories
  FOR EACH ROW EXECUTE FUNCTION memory_content.memory_initial_revision();

CREATE FUNCTION memory_content.supersession_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_content.memories prior
      WHERE prior.id = NEW.supersedes_id AND prior.space_id = NEW.space_id
        AND prior.deleted_at IS NULL AND prior.erased_at IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_conflict'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER supersession_guard BEFORE INSERT ON memory_content.memories
  FOR EACH ROW EXECUTE FUNCTION memory_content.supersession_guard();

CREATE FUNCTION memory_content.space_audit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_ops.memory_audit_events(action, space_id, actor_credential_id, created_at)
    VALUES('space_created', NEW.id, NEW.actor_credential_id, NEW.created_at_ms);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER spaces_created_audit AFTER INSERT ON memory_control.spaces
  FOR EACH ROW WHEN (NEW.actor_credential_id IS NOT NULL)
  EXECUTE FUNCTION memory_content.space_audit();
-- Serving identity is immutable; the Seoul-slice columns (disabled_at,
-- source_byte_limit, message_limit) stay mutable for the existing module.
CREATE TRIGGER spaces_serving_guard BEFORE UPDATE ON memory_control.spaces
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
    OR NEW.data_policy IS DISTINCT FROM OLD.data_policy
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.security_mode IS DISTINCT FROM OLD.security_mode
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms
    OR NEW.actor_credential_id IS DISTINCT FROM OLD.actor_credential_id)
  EXECUTE FUNCTION memory_control.reject_mutation();

CREATE FUNCTION memory_content.memory_created() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_ops.memory_audit_events(action, space_id, memory_id, revision,
      actor_credential_id, created_at)
    VALUES('memory_created', NEW.space_id, NEW.id, NEW.revision, NEW.actor_credential_id, NEW.created_at);
  INSERT INTO memory_search.fts_rows(memory_id) VALUES(NEW.id)
    ON CONFLICT (memory_id) DO NOTHING;
  INSERT INTO memory_jobs.release_jobs(id, memory_id, space_id, revision, kind, available_at, created_at)
    VALUES(NEW.id || ':' || NEW.revision, NEW.id, NEW.space_id, NEW.revision, 'upsert',
      NEW.updated_at, NEW.updated_at);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER memories_created AFTER INSERT ON memory_content.memories
  FOR EACH ROW EXECUTE FUNCTION memory_content.memory_created();

CREATE FUNCTION memory_content.memory_updated() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_content.memory_versions(memory_id, revision, space_id, body, source,
      created_at, updated_at, deleted_at, actor_credential_id, archived_at, kind, provenance,
      event_time, supersedes_id, payload_id, payload_shard_id, payload_object_key,
      payload_sha256, payload_bytes, logical_bytes)
    SELECT OLD.id, OLD.revision, OLD.space_id, OLD.body, OLD.source, OLD.created_at,
      OLD.updated_at, OLD.deleted_at, OLD.actor_credential_id, NEW.updated_at, OLD.kind,
      OLD.provenance, OLD.event_time, OLD.supersedes_id, OLD.payload_id, OLD.payload_shard_id,
      OLD.payload_object_key, OLD.payload_sha256, OLD.payload_bytes, OLD.logical_bytes
    WHERE NEW.erased_at IS NULL AND NEW.revision <> OLD.revision;
  INSERT INTO memory_ops.memory_audit_events(action, space_id, memory_id, revision,
      actor_credential_id, created_at)
    VALUES(CASE WHEN NEW.deleted_at IS NULL THEN 'memory_updated' ELSE 'memory_deleted' END,
      NEW.space_id, NEW.id, NEW.revision, NEW.actor_credential_id, NEW.updated_at);
  INSERT INTO memory_jobs.release_jobs(id, memory_id, space_id, revision, kind, available_at, created_at)
    SELECT NEW.id || ':' || NEW.revision, NEW.id, NEW.space_id, NEW.revision,
      CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END, NEW.updated_at, NEW.updated_at
    WHERE NEW.revision <> OLD.revision;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER memories_updated AFTER UPDATE ON memory_content.memories
  FOR EACH ROW EXECUTE FUNCTION memory_content.memory_updated();

-- memory_versions are append-only except the erasure-permit bypass.
CREATE FUNCTION memory_content.memory_versions_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS(SELECT 1 FROM memory_ops.erasure_permits
      WHERE memory_id = OLD.memory_id)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Memory history is append-only'; END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'Memory history is append-only'; END IF;
  RETURN OLD;
END
$guard$;
CREATE TRIGGER memory_versions_no_update BEFORE UPDATE ON memory_content.memory_versions
  FOR EACH ROW EXECUTE FUNCTION memory_content.memory_versions_guard();
CREATE TRIGGER memory_versions_no_delete BEFORE DELETE ON memory_content.memory_versions
  FOR EACH ROW EXECUTE FUNCTION memory_content.memory_versions_guard();
CREATE TRIGGER memories_no_delete BEFORE DELETE ON memory_content.memories
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

-- Operation revision precondition + metering (D1 release_operation_*).
CREATE FUNCTION memory_ops.operation_revision_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW.action IN ('update', 'delete', 'restore', 'erase')
    AND NOT EXISTS(SELECT 1 FROM memory_content.memories r
      WHERE r.id = NEW.memory_id AND r.space_id = NEW.space_id
        AND r.revision = NEW.expected_revision AND r.erased_at IS NULL
        AND ((NEW.action IN ('update', 'delete') AND r.deleted_at IS NULL)
          OR (NEW.action IN ('restore', 'erase') AND r.deleted_at IS NOT NULL))
        AND (NEW.action <> 'restore'
          OR r.deleted_at + coalesce((SELECT retention_days FROM memory_ops.space_policies
            WHERE space_id = r.space_id), 30) * 86400000 > NEW.created_at))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_conflict'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER operation_revision BEFORE INSERT ON memory_ops.release_operations
  FOR EACH ROW EXECUTE FUNCTION memory_ops.operation_revision_guard();

CREATE FUNCTION memory_ops.operation_meter() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_ops.usage_events
    SELECT NEW.id, sp.pool_id, NEW.account_id, NEW.period, NEW.units, NEW.created_at
    FROM memory_ops.space_pools sp WHERE sp.space_id = NEW.space_id;
  INSERT INTO memory_ops.usage_counters(pool_id, period, units)
    SELECT sp.pool_id, NEW.period, NEW.units FROM memory_ops.space_pools sp
    WHERE sp.space_id = NEW.space_id
    ON CONFLICT (pool_id, period) DO UPDATE SET units = usage_counters.units + excluded.units;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER operation_meter AFTER INSERT ON memory_ops.release_operations
  FOR EACH ROW EXECUTE FUNCTION memory_ops.operation_meter();
CREATE TRIGGER usage_events_append_only BEFORE UPDATE OR DELETE ON memory_ops.usage_events
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

-- Per-space storage accounting (the pool-limit check itself is a cross-tier
-- service-boundary read).
CREATE FUNCTION memory_ops.storage_accounting() RETURNS trigger
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
  INSERT INTO memory_ops.space_storage_counters(space_id, bytes) VALUES(v_space, greatest(delta, 0))
    ON CONFLICT (space_id) DO UPDATE SET bytes = space_storage_counters.bytes + delta;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER storage_accounting_memories AFTER INSERT OR UPDATE ON memory_content.memories
  FOR EACH ROW EXECUTE FUNCTION memory_ops.storage_accounting();
CREATE TRIGGER storage_accounting_versions AFTER INSERT OR DELETE ON memory_content.memory_versions
  FOR EACH ROW EXECUTE FUNCTION memory_ops.storage_accounting();

-- ---------------------------------------------------------------------------
-- Boundaries and grants.
-- ---------------------------------------------------------------------------
DO $boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'memory_content.memories', 'memory_content.memory_versions', 'memory_content.release_ingests',
    'memory_jobs.release_jobs', 'memory_jobs.ingest_operations', 'memory_jobs.ingest_approvals',
    'memory_search.vector_refs', 'memory_search.fts_rows',
    'memory_ops.memory_audit_events', 'memory_ops.usage_counters', 'memory_ops.release_operations',
    'memory_ops.usage_events', 'memory_ops.space_policies', 'memory_ops.erasure_permits',
    'memory_ops.erasure_ledger', 'memory_ops.release_events', 'memory_ops.export_sessions',
    'memory_ops.maintenance_progress', 'memory_ops.payload_backfill_progress',
    'memory_ops.space_storage_counters'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING (true) WITH CHECK (true)', target);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()', target);
  END LOOP;
  -- Append-only ledgers: audit/events/erasure/metering rows never change.
  -- erasure_permits is transient authorization scratch (insert+delete in the
  -- same erase batch), not a ledger.
  FOREACH target IN ARRAY ARRAY[
    'memory_ops.memory_audit_events', 'memory_ops.release_events'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()', target);
  END LOOP;
END
$boundaries$;
-- erasure_ledger is append-only except its one-time vector_erased_at
-- completion stamp, which the job service writes once every provider page is
-- confirmed gone. Deleting the ledger or rewriting either timestamp is denied.
CREATE TRIGGER erasure_ledger_completion BEFORE UPDATE ON memory_ops.erasure_ledger
  FOR EACH ROW WHEN (
    NEW.memory_id IS DISTINCT FROM OLD.memory_id OR NEW.space_id IS DISTINCT FROM OLD.space_id
    OR NEW.erased_at IS DISTINCT FROM OLD.erased_at
    OR (OLD.vector_erased_at IS NOT NULL AND NEW.vector_erased_at IS DISTINCT FROM OLD.vector_erased_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER erasure_ledger_no_delete BEFORE DELETE ON memory_ops.erasure_ledger
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

REVOKE ALL ON ALL TABLES IN SCHEMA memory_content FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON ALL TABLES IN SCHEMA memory_jobs FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON ALL TABLES IN SCHEMA memory_search FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON memory_ops.memory_audit_events, memory_ops.usage_counters,
  memory_ops.release_operations, memory_ops.usage_events, memory_ops.space_policies,
  memory_ops.erasure_permits, memory_ops.erasure_ledger, memory_ops.release_events,
  memory_ops.export_sessions, memory_ops.maintenance_progress,
  memory_ops.payload_backfill_progress, memory_ops.space_storage_counters,
  memory_ops.space_pools
  FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON FUNCTION memory_content.memory_validate_transition(),
  memory_content.memory_initial_revision(), memory_content.supersession_guard(),
  memory_content.space_audit(), memory_content.memory_created(), memory_content.memory_updated(),
  memory_content.memory_versions_guard(), memory_ops.operation_revision_guard(),
  memory_ops.operation_meter(), memory_ops.storage_accounting(),
  memory_jobs.ingest_approval_guard() FROM PUBLIC;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (8, '0008_regional_space.sql');
COMMIT;

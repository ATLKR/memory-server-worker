-- Regional lineage, version 9. External-payload staging and archival
-- (D1 migration 0022): multi-item staging intents, staged payload items,
-- purge/retirement queues, archive permits and committed archive records,
-- plus the payload-reference guards on memories/memory_versions and the
-- payload-aware replacements for the 0008 transition/version triggers.
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE TABLE memory_content.payload_intents (
  id memory_control.identifier PRIMARY KEY,
  account_id memory_control.identifier NOT NULL REFERENCES memory_identity.accounts(id),
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  client_key text NOT NULL,
  request_hash text NOT NULL,
  action text NOT NULL,
  memory_id memory_control.identifier,
  expected_revision bigint,
  item_count bigint NOT NULL CHECK (item_count BETWEEN 1 AND 20),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes BETWEEN 1 AND 2621440),
  created_at memory_control.epoch_ms NOT NULL,
  expires_at memory_control.epoch_ms NOT NULL CHECK (expires_at > created_at),
  published_at memory_control.epoch_ms,
  collection_started_at memory_control.epoch_ms,
  UNIQUE (account_id, space_id, client_key)
);
CREATE INDEX payload_intents_account ON memory_content.payload_intents(account_id, published_at);
CREATE INDEX payload_intents_expiry ON memory_content.payload_intents(expires_at, id)
  WHERE published_at IS NULL AND collection_started_at IS NULL;

CREATE TABLE memory_ops.payload_stage_accounts (
  account_id memory_control.identifier PRIMARY KEY REFERENCES memory_identity.accounts(id),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  quantity bigint NOT NULL CHECK (quantity >= 0)
);

CREATE TABLE memory_content.payload_stages (
  id memory_control.identifier PRIMARY KEY,
  intent_id memory_control.identifier NOT NULL REFERENCES memory_content.payload_intents(id),
  ordinal bigint NOT NULL CHECK (ordinal BETWEEN 0 AND 19),
  memory_id memory_control.identifier NOT NULL,
  payload_shard_id text NOT NULL,
  payload_object_key text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  payload_bytes bigint NOT NULL CHECK (payload_bytes BETWEEN 1 AND 131072),
  logical_bytes bigint NOT NULL CHECK (logical_bytes BETWEEN 1 AND 24576),
  state text NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'ready', 'published', 'purge_pending', 'purged')),
  created_at memory_control.epoch_ms NOT NULL,
  UNIQUE (intent_id, ordinal)
);
CREATE INDEX payload_stages_memory ON memory_content.payload_stages(memory_id, id);
CREATE INDEX payload_stages_collection ON memory_content.payload_stages(state, intent_id, id);

CREATE TABLE memory_ops.payload_purges (
  payload_id memory_control.identifier PRIMARY KEY REFERENCES memory_content.payload_stages(id),
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  memory_id memory_control.identifier NOT NULL,
  payload_shard_id text NOT NULL,
  payload_object_key text NOT NULL,
  payload_sha256 text NOT NULL,
  payload_bytes bigint NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  purged_at memory_control.epoch_ms,
  available_at memory_control.epoch_ms NOT NULL DEFAULT 0,
  attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text
);
CREATE INDEX payload_purges_pending ON memory_ops.payload_purges(available_at, created_at, payload_id)
  WHERE purged_at IS NULL;

CREATE TABLE memory_ops.payload_retirements (
  payload_id memory_control.identifier PRIMARY KEY REFERENCES memory_content.payload_stages(id),
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  memory_id memory_control.identifier NOT NULL,
  payload_shard_id text NOT NULL,
  payload_object_key text NOT NULL,
  payload_sha256 text NOT NULL,
  payload_bytes bigint NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  retired_at memory_control.epoch_ms,
  available_at memory_control.epoch_ms NOT NULL DEFAULT 0,
  attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text
);
CREATE INDEX payload_retirements_pending ON memory_ops.payload_retirements(available_at, created_at, payload_id)
  WHERE retired_at IS NULL;

CREATE TABLE memory_content.payload_archive_permits (
  payload_id memory_control.identifier PRIMARY KEY REFERENCES memory_content.payload_stages(id),
  memory_id memory_control.identifier NOT NULL,
  revision bigint NOT NULL,
  target text NOT NULL CHECK (target IN ('current', 'history')),
  created_at memory_control.epoch_ms NOT NULL,
  UNIQUE (memory_id, revision, target)
);
CREATE TABLE memory_content.payload_archives (
  payload_id memory_control.identifier PRIMARY KEY REFERENCES memory_content.payload_stages(id),
  memory_id memory_control.identifier NOT NULL,
  revision bigint NOT NULL,
  target text NOT NULL CHECK (target IN ('current', 'history')),
  created_at memory_control.epoch_ms NOT NULL
);

-- ---------------------------------------------------------------------------
-- Intent admission and accounting.
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_content.payload_intent_budget() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF coalesce((SELECT bytes FROM memory_ops.payload_stage_accounts WHERE account_id = NEW.account_id), 0)
      + NEW.reserved_bytes > 8388608
    OR coalesce((SELECT quantity FROM memory_ops.payload_stage_accounts WHERE account_id = NEW.account_id), 0)
      + NEW.item_count > 200
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_payload_budget'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER payload_intent_budget BEFORE INSERT ON memory_content.payload_intents
  FOR EACH ROW EXECUTE FUNCTION memory_content.payload_intent_budget();
CREATE FUNCTION memory_content.payload_intent_reserve() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_ops.payload_stage_accounts(account_id, bytes, quantity)
    VALUES(NEW.account_id, NEW.reserved_bytes, NEW.item_count)
    ON CONFLICT (account_id) DO UPDATE
      SET bytes = payload_stage_accounts.bytes + excluded.bytes,
          quantity = payload_stage_accounts.quantity + excluded.quantity;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER payload_intent_reserve AFTER INSERT ON memory_content.payload_intents
  FOR EACH ROW EXECUTE FUNCTION memory_content.payload_intent_reserve();

CREATE FUNCTION memory_content.payload_stage_admission() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_content.payload_intents i
      WHERE i.id = NEW.intent_id AND i.published_at IS NULL AND i.collection_started_at IS NULL
        AND i.expires_at > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
        AND NEW.ordinal < i.item_count AND NEW.state = 'staging'
        AND (SELECT count(*) FROM memory_content.payload_stages WHERE intent_id = i.id) < i.item_count
        AND coalesce((SELECT sum(payload_bytes) FROM memory_content.payload_stages WHERE intent_id = i.id), 0)
          + NEW.payload_bytes <= i.reserved_bytes)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_denied: Payload staging unavailable'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER payload_stage_admission BEFORE INSERT ON memory_content.payload_stages
  FOR EACH ROW EXECUTE FUNCTION memory_content.payload_stage_admission();

-- ---------------------------------------------------------------------------
-- State machines.
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_content.payload_intent_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.space_id IS DISTINCT FROM OLD.space_id OR NEW.client_key IS DISTINCT FROM OLD.client_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.action IS DISTINCT FROM OLD.action
    OR NEW.memory_id IS DISTINCT FROM OLD.memory_id
    OR NEW.expected_revision IS DISTINCT FROM OLD.expected_revision
    OR NEW.item_count IS DISTINCT FROM OLD.item_count OR NEW.reserved_bytes IS DISTINCT FROM OLD.reserved_bytes
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NOT (OLD.published_at IS NULL AND OLD.collection_started_at IS NULL AND (
      (NEW.published_at IS NOT NULL AND NEW.collection_started_at IS NULL
        AND (SELECT count(*) FROM memory_content.payload_stages
          WHERE intent_id = OLD.id AND state = 'published') = OLD.item_count)
      OR (NEW.published_at IS NULL AND NEW.collection_started_at IS NOT NULL
        AND OLD.expires_at <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
        AND (SELECT count(*) FROM memory_content.payload_stages p
          WHERE p.intent_id = OLD.id AND p.state IN ('purge_pending', 'purged')
            AND EXISTS(SELECT 1 FROM memory_ops.payload_purges q WHERE q.payload_id = p.id))
          = OLD.item_count)))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'release_denied: Invalid payload intent transition'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER payload_intent_immutable BEFORE UPDATE ON memory_content.payload_intents
  FOR EACH ROW EXECUTE FUNCTION memory_content.payload_intent_transition();
CREATE FUNCTION memory_content.payload_intent_release() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  UPDATE memory_ops.payload_stage_accounts
    SET bytes = bytes - NEW.reserved_bytes, quantity = quantity - NEW.item_count
    WHERE account_id = NEW.account_id;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER payload_intent_release AFTER UPDATE OF published_at ON memory_content.payload_intents
  FOR EACH ROW WHEN (OLD.published_at IS NULL AND NEW.published_at IS NOT NULL)
  EXECUTE FUNCTION memory_content.payload_intent_release();

CREATE FUNCTION memory_content.payload_stage_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
    OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.memory_id IS DISTINCT FROM OLD.memory_id
    OR NEW.payload_shard_id IS DISTINCT FROM OLD.payload_shard_id
    OR NEW.payload_object_key IS DISTINCT FROM OLD.payload_object_key
    OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
    OR NEW.payload_bytes IS DISTINCT FROM OLD.payload_bytes
    OR NEW.logical_bytes IS DISTINCT FROM OLD.logical_bytes
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT ((OLD.state = 'staging' AND NEW.state IN ('ready', 'purge_pending'))
      OR (OLD.state = 'ready' AND NEW.state IN ('published', 'purge_pending'))
      OR (OLD.state = 'published' AND NEW.state = 'purge_pending')
      OR (OLD.state = 'purge_pending' AND NEW.state = 'purged'))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid payload stage transition'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER payload_stage_immutable BEFORE UPDATE ON memory_content.payload_stages
  FOR EACH ROW EXECUTE FUNCTION memory_content.payload_stage_transition();

CREATE FUNCTION memory_content.payload_stage_publish() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_content.payload_intents i
      WHERE i.id = NEW.intent_id AND i.collection_started_at IS NULL
        AND i.expires_at > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
    OR NOT EXISTS(SELECT 1 FROM memory_content.memories m
        JOIN memory_content.payload_intents i ON i.id = NEW.intent_id
        WHERE m.id = NEW.memory_id AND m.space_id = i.space_id AND m.payload_id = NEW.id
      UNION ALL SELECT 1 FROM memory_content.memory_versions m
        JOIN memory_content.payload_intents i ON i.id = NEW.intent_id
        WHERE m.memory_id = NEW.memory_id AND m.space_id = i.space_id AND m.payload_id = NEW.id)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Payload publication incomplete'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER payload_stage_publish BEFORE UPDATE OF state ON memory_content.payload_stages
  FOR EACH ROW WHEN (NEW.state = 'published')
  EXECUTE FUNCTION memory_content.payload_stage_publish();

CREATE FUNCTION memory_content.payload_stage_collect() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_content.memories WHERE payload_id = NEW.id)
    OR EXISTS(SELECT 1 FROM memory_content.memory_versions WHERE payload_id = NEW.id)
    OR (NEW.state = 'purged' AND NOT EXISTS(SELECT 1 FROM memory_ops.payload_purges
      WHERE payload_id = NEW.id AND purged_at IS NOT NULL))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Payload remains referenced'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER payload_stage_collect BEFORE UPDATE OF state ON memory_content.payload_stages
  FOR EACH ROW WHEN (NEW.state IN ('purge_pending', 'purged'))
  EXECUTE FUNCTION memory_content.payload_stage_collect();

CREATE FUNCTION memory_content.payload_stage_collected() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_content.payload_stages
      WHERE intent_id = NEW.intent_id AND state <> 'purged' AND id <> NEW.id)
  THEN
    UPDATE memory_ops.payload_stage_accounts SET
        bytes = bytes - (SELECT reserved_bytes FROM memory_content.payload_intents WHERE id = NEW.intent_id),
        quantity = quantity - (SELECT item_count FROM memory_content.payload_intents WHERE id = NEW.intent_id)
      WHERE account_id = (SELECT account_id FROM memory_content.payload_intents
        WHERE id = NEW.intent_id AND published_at IS NULL);
  END IF;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER payload_stage_collected AFTER UPDATE OF state ON memory_content.payload_stages
  FOR EACH ROW WHEN (NEW.state = 'purged' AND OLD.state = 'purge_pending')
  EXECUTE FUNCTION memory_content.payload_stage_collected();

-- ---------------------------------------------------------------------------
-- Purge/retirement/archive-permit rules.
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_ops.payload_cleanup_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NEW.payload_id IS DISTINCT FROM OLD.payload_id OR NEW.space_id IS DISTINCT FROM OLD.space_id
    OR NEW.memory_id IS DISTINCT FROM OLD.memory_id
    OR NEW.payload_shard_id IS DISTINCT FROM OLD.payload_shard_id
    OR NEW.payload_object_key IS DISTINCT FROM OLD.payload_object_key
    OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
    OR NEW.payload_bytes IS DISTINCT FROM OLD.payload_bytes
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (TG_TABLE_NAME = 'payload_purges' AND OLD.purged_at IS NOT NULL)
    OR (TG_TABLE_NAME = 'payload_retirements' AND OLD.retired_at IS NOT NULL)
    OR NEW.attempts < OLD.attempts
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Payload cleanup evidence is immutable'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER payload_purges_immutable BEFORE UPDATE ON memory_ops.payload_purges
  FOR EACH ROW EXECUTE FUNCTION memory_ops.payload_cleanup_immutable();
CREATE TRIGGER payload_retirements_immutable BEFORE UPDATE ON memory_ops.payload_retirements
  FOR EACH ROW EXECUTE FUNCTION memory_ops.payload_cleanup_immutable();

CREATE FUNCTION memory_content.payload_archive_permit_validate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_content.payload_stages p
      JOIN memory_content.payload_intents i ON i.id = p.intent_id
      WHERE p.id = NEW.payload_id AND p.memory_id = NEW.memory_id AND p.state = 'ready'
        AND i.action = 'archive'
        AND i.expires_at > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
        AND ((NEW.target = 'current' AND EXISTS(SELECT 1 FROM memory_content.memories m
          WHERE m.id = NEW.memory_id AND m.revision = NEW.revision AND m.space_id = i.space_id
            AND m.payload_id IS NULL AND m.erased_at IS NULL
            AND p.logical_bytes = octet_length(m.body) + coalesce(octet_length(m.source), 0)
              + octet_length(m.provenance::text)))
        OR (NEW.target = 'history' AND EXISTS(SELECT 1 FROM memory_content.memory_versions m
          JOIN memory_content.memories h ON h.id = m.memory_id
          WHERE m.memory_id = NEW.memory_id AND m.revision = NEW.revision AND m.space_id = i.space_id
            AND m.payload_id IS NULL AND h.erased_at IS NULL
            AND p.logical_bytes = octet_length(m.body) + coalesce(octet_length(m.source), 0)
              + octet_length(m.provenance::text)))))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Payload archive source changed'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER payload_archive_permit_validate BEFORE INSERT ON memory_content.payload_archive_permits
  FOR EACH ROW EXECUTE FUNCTION memory_content.payload_archive_permit_validate();
CREATE TRIGGER payload_archive_permit_no_update BEFORE UPDATE ON memory_content.payload_archive_permits
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER payload_archives_immutable BEFORE UPDATE ON memory_content.payload_archives
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();

-- ---------------------------------------------------------------------------
-- Payload reference guards on memories/memory_versions, and the
-- payload-aware replacements for the 0008 transition/version triggers.
-- ---------------------------------------------------------------------------
CREATE FUNCTION memory_content.memory_payload_reference() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE v_op_ok boolean; v_ready_ok boolean;
BEGIN
  -- Columns without a payload_id are forbidden.
  IF NEW.payload_id IS NULL AND (NEW.payload_shard_id IS NOT NULL OR NEW.payload_object_key IS NOT NULL
      OR NEW.payload_sha256 IS NOT NULL OR NEW.payload_bytes IS NOT NULL OR NEW.logical_bytes IS NOT NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid payload reference'; END IF;
  IF NEW.payload_id IS NOT NULL THEN
    IF NEW.body <> '[external]' OR NEW.source IS NOT NULL OR NEW.provenance::text <> '{}'
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid payload reference'; END IF;
    -- A ready-stage payload is referencable when the matching operation row
    -- exists (publication flow) or an archive permit exists.
    SELECT EXISTS(SELECT 1 FROM memory_ops.release_operations o
        JOIN memory_content.payload_stages p ON p.id = NEW.payload_id
        JOIN memory_content.payload_intents i ON i.id = p.intent_id
        WHERE p.id = NEW.payload_id AND o.account_id = i.account_id AND o.space_id = i.space_id
          AND o.client_key = i.client_key AND o.request_hash = i.request_hash)
      OR EXISTS(SELECT 1 FROM memory_content.payload_archive_permits permit
        WHERE permit.payload_id = NEW.payload_id) INTO v_op_ok;
    IF NOT EXISTS(SELECT 1 FROM memory_content.payload_stages p
        JOIN memory_content.payload_intents i ON i.id = p.intent_id
        WHERE p.id = NEW.payload_id AND p.memory_id = NEW.id AND i.space_id = NEW.space_id
          AND ((TG_OP = 'UPDATE' AND p.state = 'published' AND NEW.payload_id IS NOT DISTINCT FROM OLD.payload_id)
            OR (p.state = 'ready' AND v_op_ok))
          AND p.payload_shard_id IS NOT DISTINCT FROM NEW.payload_shard_id
          AND p.payload_object_key IS NOT DISTINCT FROM NEW.payload_object_key
          AND p.payload_sha256 IS NOT DISTINCT FROM NEW.payload_sha256
          AND p.payload_bytes IS NOT DISTINCT FROM NEW.payload_bytes
          AND p.logical_bytes IS NOT DISTINCT FROM NEW.logical_bytes)
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid payload reference'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.payload_id IS NOT NULL AND NEW.payload_id IS NULL AND NEW.erased_at IS NULL)
      OR (NEW.erased_at IS NULL AND (NEW.deleted_at IS NOT NULL OR OLD.deleted_at IS NOT NULL)
        AND NEW.revision <> OLD.revision
        AND NOT (NEW.payload_id IS NOT DISTINCT FROM OLD.payload_id
          AND NEW.payload_shard_id IS NOT DISTINCT FROM OLD.payload_shard_id
          AND NEW.payload_object_key IS NOT DISTINCT FROM OLD.payload_object_key
          AND NEW.payload_sha256 IS NOT DISTINCT FROM OLD.payload_sha256
          AND NEW.payload_bytes IS NOT DISTINCT FROM OLD.payload_bytes
          AND NEW.logical_bytes IS NOT DISTINCT FROM OLD.logical_bytes))
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid payload reference'; END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER memories_payload_insert BEFORE INSERT ON memory_content.memories
  FOR EACH ROW EXECUTE FUNCTION memory_content.memory_payload_reference();
CREATE TRIGGER memories_payload_update BEFORE UPDATE ON memory_content.memories
  FOR EACH ROW EXECUTE FUNCTION memory_content.memory_payload_reference();

CREATE FUNCTION memory_content.version_payload_reference() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
DECLARE v_op_ok boolean;
BEGIN
  IF NEW.payload_id IS NULL AND (NEW.payload_shard_id IS NOT NULL OR NEW.payload_object_key IS NOT NULL
      OR NEW.payload_sha256 IS NOT NULL OR NEW.payload_bytes IS NOT NULL OR NEW.logical_bytes IS NOT NULL)
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid payload reference'; END IF;
  IF NEW.payload_id IS NOT NULL THEN
    IF NEW.body <> '[external]' OR NEW.source IS NOT NULL OR NEW.provenance::text <> '{}'
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid payload reference'; END IF;
    SELECT EXISTS(SELECT 1 FROM memory_ops.release_operations o
        JOIN memory_content.payload_stages p ON p.id = NEW.payload_id
        JOIN memory_content.payload_intents i ON i.id = p.intent_id
        WHERE p.id = NEW.payload_id AND o.account_id = i.account_id AND o.space_id = i.space_id
          AND o.client_key = i.client_key AND o.request_hash = i.request_hash)
      OR EXISTS(SELECT 1 FROM memory_content.payload_archive_permits permit
        WHERE permit.payload_id = NEW.payload_id) INTO v_op_ok;
    IF NOT EXISTS(SELECT 1 FROM memory_content.payload_stages p
        JOIN memory_content.payload_intents i ON i.id = p.intent_id
        WHERE p.id = NEW.payload_id AND p.memory_id = NEW.memory_id AND i.space_id = NEW.space_id
          AND (p.state = 'published' OR (p.state = 'ready' AND v_op_ok))
          AND p.payload_shard_id IS NOT DISTINCT FROM NEW.payload_shard_id
          AND p.payload_object_key IS NOT DISTINCT FROM NEW.payload_object_key
          AND p.payload_sha256 IS NOT DISTINCT FROM NEW.payload_sha256
          AND p.payload_bytes IS NOT DISTINCT FROM NEW.payload_bytes
          AND p.logical_bytes IS NOT DISTINCT FROM NEW.logical_bytes)
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid payload reference'; END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER memory_versions_payload_insert BEFORE INSERT ON memory_content.memory_versions
  FOR EACH ROW EXECUTE FUNCTION memory_content.version_payload_reference();
CREATE TRIGGER memory_versions_payload_update BEFORE UPDATE ON memory_content.memory_versions
  FOR EACH ROW EXECUTE FUNCTION memory_content.version_payload_reference();

-- Payload-aware replacements for the 0008 transition/version guards.
CREATE OR REPLACE FUNCTION memory_content.memory_validate_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  -- The payload-archive attach is the only non-revision update: every other
  -- column must stay identical and a matching 'current' permit must exist.
  IF NOT (OLD.payload_id IS NULL AND NEW.payload_id IS NOT NULL AND NEW.id = OLD.id
      AND NEW.space_id IS NOT DISTINCT FROM OLD.space_id AND NEW.revision IS NOT DISTINCT FROM OLD.revision
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
      AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
      AND NEW.actor_credential_id IS NOT DISTINCT FROM OLD.actor_credential_id
      AND NEW.kind IS NOT DISTINCT FROM OLD.kind AND NEW.event_time IS NOT DISTINCT FROM OLD.event_time
      AND NEW.supersedes_id IS NOT DISTINCT FROM OLD.supersedes_id
      AND NEW.erased_at IS NOT DISTINCT FROM OLD.erased_at
      AND NEW.logical_bytes = coalesce(OLD.logical_bytes,
        octet_length(OLD.body) + coalesce(octet_length(OLD.source), 0) + octet_length(OLD.provenance::text))
      AND EXISTS(SELECT 1 FROM memory_content.payload_archive_permits a
        WHERE a.payload_id = NEW.payload_id AND a.memory_id = OLD.id AND a.revision = OLD.revision
          AND a.target = 'current'))
    AND (NEW.id <> OLD.id OR NEW.space_id <> OLD.space_id OR NEW.created_at <> OLD.created_at
      OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
      OR OLD.erased_at IS NOT NULL
      OR (NEW.erased_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_ops.erasure_permits p
        WHERE p.memory_id = OLD.id AND p.actor_credential_id = NEW.actor_credential_id))
      OR (NEW.erased_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL)
      OR (NEW.erased_at IS NULL AND NEW.deleted_at IS NOT NULL
        AND (NEW.body <> OLD.body OR NEW.source IS DISTINCT FROM OLD.source)))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid memory transition'; END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION memory_content.memory_versions_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM memory_ops.erasure_permits WHERE memory_id = OLD.memory_id)
    THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Memory history is append-only'; END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: only the payload-archive attach is permitted, with a 'history' permit.
  IF NOT (OLD.payload_id IS NULL AND NEW.payload_id IS NOT NULL AND NEW.memory_id = OLD.memory_id
      AND NEW.space_id IS NOT DISTINCT FROM OLD.space_id AND NEW.revision IS NOT DISTINCT FROM OLD.revision
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
      AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
      AND NEW.actor_credential_id IS NOT DISTINCT FROM OLD.actor_credential_id
      AND NEW.kind IS NOT DISTINCT FROM OLD.kind AND NEW.event_time IS NOT DISTINCT FROM OLD.event_time
      AND NEW.supersedes_id IS NOT DISTINCT FROM OLD.supersedes_id
      AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
      AND NEW.logical_bytes = coalesce(OLD.logical_bytes,
        octet_length(OLD.body) + coalesce(octet_length(OLD.source), 0) + octet_length(OLD.provenance::text))
      AND EXISTS(SELECT 1 FROM memory_content.payload_archive_permits a
        WHERE a.payload_id = NEW.payload_id AND a.memory_id = OLD.memory_id
          AND a.revision = OLD.revision AND a.target = 'history'))
  THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Memory history is append-only'; END IF;
  RETURN NEW;
END
$guard$;

CREATE FUNCTION memory_content.payload_archived() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  IF TG_TABLE_NAME = 'memories' THEN
    INSERT INTO memory_content.payload_archives
      SELECT payload_id, memory_id, revision, target, created_at
      FROM memory_content.payload_archive_permits
      WHERE payload_id = NEW.payload_id AND memory_id = NEW.id AND revision = NEW.revision AND target = 'current';
  ELSE
    INSERT INTO memory_content.payload_archives
      SELECT payload_id, memory_id, revision, target, created_at
      FROM memory_content.payload_archive_permits
      WHERE payload_id = NEW.payload_id AND memory_id = NEW.memory_id AND revision = NEW.revision
        AND target = 'history';
  END IF;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER memories_payload_archived AFTER UPDATE ON memory_content.memories
  FOR EACH ROW WHEN (OLD.payload_id IS NULL AND NEW.payload_id IS NOT NULL AND NEW.revision = OLD.revision)
  EXECUTE FUNCTION memory_content.payload_archived();
CREATE TRIGGER memory_versions_payload_archived AFTER UPDATE ON memory_content.memory_versions
  FOR EACH ROW WHEN (OLD.payload_id IS NULL AND NEW.payload_id IS NOT NULL AND NEW.revision = OLD.revision)
  EXECUTE FUNCTION memory_content.payload_archived();

CREATE FUNCTION memory_content.payload_retire_old() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_ops.payload_retirements(payload_id, space_id, memory_id, payload_shard_id,
      payload_object_key, payload_sha256, payload_bytes, created_at, retired_at)
    SELECT OLD.payload_id, OLD.space_id, OLD.id, OLD.payload_shard_id, OLD.payload_object_key,
      OLD.payload_sha256, OLD.payload_bytes,
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint, NULL
    WHERE NOT EXISTS(SELECT 1 FROM memory_ops.payload_retirements WHERE payload_id = OLD.payload_id);
  RETURN NULL;
END
$apply$;
CREATE TRIGGER payload_retire_old AFTER UPDATE ON memory_content.memories
  FOR EACH ROW WHEN (OLD.payload_id IS NOT NULL AND NEW.payload_id IS DISTINCT FROM OLD.payload_id)
  EXECUTE FUNCTION memory_content.payload_retire_old();

-- ---------------------------------------------------------------------------
-- Boundaries and grants.
-- ---------------------------------------------------------------------------
DO $boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'memory_content.payload_intents', 'memory_content.payload_stages',
    'memory_content.payload_archive_permits', 'memory_content.payload_archives',
    'memory_ops.payload_stage_accounts', 'memory_ops.payload_purges',
    'memory_ops.payload_retirements'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING (true) WITH CHECK (true)', target);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()', target);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()', target);
  END LOOP;
END
$boundaries$;

REVOKE ALL ON memory_content.payload_intents, memory_content.payload_stages,
  memory_content.payload_archive_permits, memory_content.payload_archives,
  memory_ops.payload_stage_accounts, memory_ops.payload_purges,
  memory_ops.payload_retirements FROM PUBLIC, memory_runtime, memory_background;
REVOKE ALL ON FUNCTION
  memory_content.payload_intent_budget(), memory_content.payload_intent_reserve(),
  memory_content.payload_stage_admission(), memory_content.payload_intent_transition(),
  memory_content.payload_intent_release(), memory_content.payload_stage_transition(),
  memory_content.payload_stage_publish(), memory_content.payload_stage_collect(),
  memory_content.payload_stage_collected(), memory_ops.payload_cleanup_immutable(),
  memory_content.payload_archive_permit_validate(), memory_content.memory_payload_reference(),
  memory_content.version_payload_reference(), memory_content.payload_archived(),
  memory_content.payload_retire_old() FROM PUBLIC;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (9, '0009_payload_staging.sql');
COMMIT;

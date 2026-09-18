-- Regional lineage, version 11. Deferred cross-border shares stub.
-- release_shares is classified cross-border and the federation unit is
-- deferred; the service's share-read paths still reference the shape, so the
-- table exists with the D1 column contract and every insert is denied. No
-- share can be created until the federation unit adds its reviewed writer.
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE TABLE memory_identity.shares (
  id memory_control.identifier PRIMARY KEY,
  space_id memory_control.identifier NOT NULL REFERENCES memory_control.spaces(id),
  recipient_email_id memory_control.identifier NOT NULL REFERENCES memory_identity.account_emails(id),
  creator_credential_id memory_control.identifier NOT NULL REFERENCES memory_identity.credentials(id),
  creator_membership_id memory_control.identifier REFERENCES memory_identity.memberships(id),
  creator_email_id memory_control.identifier REFERENCES memory_identity.account_emails(id),
  expires_at memory_control.epoch_ms NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  accepted_at memory_control.epoch_ms,
  revoked_at memory_control.epoch_ms
);
CREATE INDEX shares_space_created ON memory_identity.shares(space_id, created_at DESC, id DESC);
CREATE INDEX shares_recipient_page ON memory_identity.shares(recipient_email_id, created_at, id)
  WHERE revoked_at IS NULL;
-- No writer exists yet: insertion is denied outright, not just unauthorized.
CREATE TRIGGER shares_deferred BEFORE INSERT ON memory_identity.shares
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER shares_append_only BEFORE UPDATE OR DELETE ON memory_identity.shares
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER shares_no_truncate BEFORE TRUNCATE ON memory_identity.shares
  FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();

ALTER TABLE memory_identity.shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_identity.shares FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON memory_identity.shares TO memory_owner USING (true) WITH CHECK (true);
REVOKE ALL ON memory_identity.shares FROM PUBLIC, memory_runtime, memory_background;

-- The service's execution-time expressions call now_ms(); grant the runtime
-- capability roles EXECUTE (the function is STABLE and reads nothing else).
GRANT EXECUTE ON FUNCTION memory_control.now_ms() TO memory_runtime, memory_background;

-- Cleanup cursors and intent budgets are background-capability state. Version
-- 10 recreated both tables and revoked grants; the job service updates them.
GRANT SELECT, UPDATE ON memory_ops.maintenance_progress TO memory_background;
GRANT SELECT, UPDATE ON memory_ops.payload_backfill_progress TO memory_background;
-- SCIM visibility orders "latest insertion" by the D1 rowid; give memberships a
-- durable monotonic insertion order for the same comparison.
ALTER TABLE memory_identity.memberships
  ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;

-- The provider webhook dedup receipt keeps the D1 shape: the first recorded
-- body wins and a conflicting replay is a stable 409.
CREATE TABLE memory_ops.webhook_events (
  provider text NOT NULL,
  event_id memory_control.identifier NOT NULL,
  body_hash text NOT NULL CHECK(body_hash COLLATE "C" ~ '^[a-f0-9]{64}$'),
  created_at memory_control.epoch_ms NOT NULL,
  PRIMARY KEY(provider, event_id)
);
ALTER TABLE memory_ops.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON memory_ops.webhook_events TO memory_owner USING (true) WITH CHECK (true);
CREATE TRIGGER webhook_events_no_update BEFORE UPDATE ON memory_ops.webhook_events
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER webhook_events_no_delete BEFORE DELETE ON memory_ops.webhook_events
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
GRANT SELECT, INSERT ON memory_ops.webhook_events TO memory_runtime;

-- Provider call budget reservation, keyed by UTC month and provider kind. The
-- service boundary compares its reservation against the configured cap.
CREATE TABLE memory_ops.provider_budgets (
  month text NOT NULL CHECK(month COLLATE "C" ~ '^[0-9]{4}-[0-9]{2}$'),
  kind text NOT NULL CHECK(kind IN ('embedding', 'extraction')),
  calls bigint NOT NULL CHECK(calls >= 0),
  reserved_microusd bigint NOT NULL CHECK(reserved_microusd >= 0),
  PRIMARY KEY(month, kind)
);
ALTER TABLE memory_ops.provider_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.provider_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON memory_ops.provider_budgets TO memory_owner USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON memory_ops.provider_budgets TO memory_runtime, memory_background;

-- Lexical candidate search. The durable FTS mechanism (pg_tsvector vs external
-- engine) is a later regional decision; a 'simple'-config generated vector
-- preserves the request path's prefix-match candidate semantics for now.
ALTER TABLE memory_content.memories
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED;
CREATE INDEX memories_search_vector ON memory_content.memories USING gin(search_vector);

-- Identity-event intake receipts. The central journal (P-5) becomes the source
-- of truth; these preserve the v1 webhook/JWT-bound intake path until then.
CREATE TABLE memory_ops.lifecycle_jwt_proofs (
  event_id memory_control.identifier PRIMARY KEY,
  body_hash text NOT NULL CHECK(body_hash COLLATE "C" ~ '^[a-f0-9]{64}$'),
  issued_at memory_control.epoch_ms NOT NULL,
  expires_at memory_control.epoch_ms NOT NULL CHECK(expires_at > issued_at)
);
CREATE TABLE memory_ops.lifecycle_events (
  id memory_control.identifier PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  sequence bigint NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
  kind text NOT NULL,
  address text NOT NULL,
  occurred_at memory_control.epoch_ms NOT NULL,
  received_at memory_control.epoch_ms NOT NULL,
  signed_at memory_control.epoch_ms NOT NULL,
  body_hash text NOT NULL CHECK(body_hash COLLATE "C" ~ '^[a-f0-9]{64}$'),
  UNIQUE(issuer, subject, address, sequence)
);
ALTER TABLE memory_ops.lifecycle_jwt_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.lifecycle_jwt_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON memory_ops.lifecycle_jwt_proofs TO memory_owner USING (true) WITH CHECK (true);
ALTER TABLE memory_ops.lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON memory_ops.lifecycle_events TO memory_owner USING (true) WITH CHECK (true);
CREATE TRIGGER lifecycle_events_no_update BEFORE UPDATE ON memory_ops.lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER lifecycle_events_no_delete BEFORE DELETE ON memory_ops.lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
GRANT SELECT, INSERT ON memory_ops.lifecycle_jwt_proofs, memory_ops.lifecycle_events TO memory_runtime;

-- Scheduled-maintenance liveness marker read by the readiness probe.
CREATE TABLE memory_ops.heartbeats (
  name text PRIMARY KEY,
  last_success_at memory_control.epoch_ms NOT NULL
);
ALTER TABLE memory_ops.heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON memory_ops.heartbeats TO memory_owner USING (true) WITH CHECK (true);
GRANT SELECT ON memory_ops.heartbeats TO memory_runtime;
GRANT SELECT, INSERT, UPDATE ON memory_ops.heartbeats TO memory_background;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (11, '0011_deferred_shares.sql');
COMMIT;

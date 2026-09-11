-- Requires an independently provisioned migration login permitted to SET ROLE
-- memory_owner (or an explicitly privileged provisioner). No memberships granted.
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE DOMAIN memory_control.identifier AS text
  CHECK (VALUE COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$');
CREATE DOMAIN memory_control.epoch_ms AS bigint
  CHECK (VALUE BETWEEN 0 AND 9007199254740991);

CREATE FUNCTION memory_control.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $immutable$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'memory_immutable_record';
END
$immutable$;

CREATE TABLE memory_control.schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL UNIQUE CHECK (name COLLATE "C" ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'),
  installed_at_ms memory_control.epoch_ms NOT NULL
    DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
);
CREATE TRIGGER schema_migrations_append_only BEFORE UPDATE OR DELETE ON memory_control.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER schema_migrations_no_truncate BEFORE TRUNCATE ON memory_control.schema_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();

CREATE TABLE memory_control.deployment_identity (
  singleton smallint PRIMARY KEY CHECK (singleton = 1),
  deployment_id memory_control.identifier NOT NULL,
  storage_region text NOT NULL CHECK (storage_region IN ('sg', 'kr-seoul')),
  -- This names a policy; it neither approves processing nor enables ingress.
  processing_policy_id memory_control.identifier NOT NULL,
  created_at_ms memory_control.epoch_ms NOT NULL
);
CREATE TRIGGER deployment_identity_immutable BEFORE UPDATE OR DELETE ON memory_control.deployment_identity
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER deployment_identity_no_truncate BEFORE TRUNCATE ON memory_control.deployment_identity
  FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();

REVOKE ALL ON ALL TABLES IN SCHEMA memory_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA memory_control FROM PUBLIC;
REVOKE ALL ON DOMAIN memory_control.identifier, memory_control.epoch_ms FROM PUBLIC;
GRANT USAGE ON SCHEMA memory_control TO memory_runtime, memory_background;
GRANT SELECT ON memory_control.deployment_identity, memory_control.schema_migrations TO memory_runtime, memory_background;

DO $private_objects$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA memory_control FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA memory_control FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON DOMAIN memory_control.identifier, memory_control.epoch_ms FROM %I', api_role);
    END IF;
  END LOOP;
END
$private_objects$;

INSERT INTO memory_control.schema_migrations(version, name) VALUES
  (1, '0001_private_namespaces.sql'),
  (2, '0002_deployment_identity.sql');
-- Deliberately no deployment_identity row. The provisioner initializes the
-- exact selected region and policy only after identity/placement verification.
COMMIT;

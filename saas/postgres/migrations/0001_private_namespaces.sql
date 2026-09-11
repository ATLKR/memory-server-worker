-- Native PostgreSQL bootstrap. Run only against an explicitly selected empty
-- Memory target with a provisioner allowed to create roles and assign ownership.
-- No login roles, passwords, regional data or existing Supabase objects change.
BEGIN;

DO $bootstrap$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('memory_owner', 'memory_runtime', 'memory_background')) THEN
    RAISE EXCEPTION USING ERRCODE = '42710', MESSAGE = 'memory_reserved_role_exists';
  END IF;
END
$bootstrap$;

CREATE ROLE memory_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE memory_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE memory_background NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

CREATE SCHEMA memory_control AUTHORIZATION memory_owner;
CREATE SCHEMA memory_identity AUTHORIZATION memory_owner;
CREATE SCHEMA memory_content AUTHORIZATION memory_owner;
CREATE SCHEMA memory_search AUTHORIZATION memory_owner;
CREATE SCHEMA memory_jobs AUTHORIZATION memory_owner;
CREATE SCHEMA memory_ops AUTHORIZATION memory_owner;

REVOKE ALL ON SCHEMA memory_control, memory_identity, memory_content, memory_search, memory_jobs, memory_ops FROM PUBLIC;

-- Default EXECUTE/USAGE grants are global for this NEW dedicated owner role.
-- A per-schema default revoke cannot undo a global default function grant.
ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE memory_owner REVOKE USAGE ON TYPES FROM PUBLIC;

DO $private_schemas$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA memory_control, memory_identity, memory_content, memory_search, memory_jobs, memory_ops FROM %I', api_role);
    END IF;
  END LOOP;
END
$private_schemas$;

COMMIT;

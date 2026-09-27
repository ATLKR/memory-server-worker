-- Regional migration 0015: queue-episode stamping for release_jobs.
--
-- Ports the D1 lineage's migration-25 semantics: queued_at records the start
-- of the job's current unfinished episode so operations observability reports
-- real backlog age instead of the original creation time.
--   - INSERT stamps queued_at when the caller left it NULL (fixtures that
--     seed explicit episode history keep their value).
--   - A done/dead → pending transition starts a fresh episode.
--   - pending ↔ leased churn keeps the original episode start.
-- An explicitly-written queued_at (episode reset or legacy NULL) is never
-- overwritten by non-state updates.
BEGIN;
SET LOCAL ROLE memory_owner;

CREATE FUNCTION memory_jobs.release_jobs_episode() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $trig$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.queued_at IS NULL THEN NEW.queued_at := memory_control.now_ms(); END IF;
  ELSIF OLD.state IN ('done', 'dead') AND NEW.state = 'pending' THEN
    NEW.queued_at := memory_control.now_ms();
  END IF;
  RETURN NEW;
END
$trig$;
REVOKE ALL ON FUNCTION memory_jobs.release_jobs_episode() FROM PUBLIC;

CREATE TRIGGER release_jobs_episode BEFORE INSERT OR UPDATE OF state
  ON memory_jobs.release_jobs FOR EACH ROW
  EXECUTE FUNCTION memory_jobs.release_jobs_episode();

INSERT INTO memory_control.schema_migrations(version, name) VALUES (15, '0015_queue_episode.sql');
COMMIT;

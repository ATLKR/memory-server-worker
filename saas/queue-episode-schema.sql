-- Preserve original job creation while measuring the current unfinished episode.
ALTER TABLE release_jobs ADD COLUMN queued_at INTEGER
 CHECK(queued_at IS NULL OR (typeof(queued_at)='integer' AND queued_at BETWEEN 0 AND 9007199254740991));
-- An unchanged initial availability identifies an initial active enqueue. Older
-- retry/reconciliation episodes cannot be reconstructed and remain explicitly unknown.
UPDATE release_jobs SET queued_at=created_at
 WHERE state IN ('pending','leased') AND available_at=created_at;
CREATE TRIGGER release_jobs_initial_episode AFTER INSERT ON release_jobs BEGIN
 UPDATE release_jobs SET queued_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE id=NEW.id;
END;
CREATE TRIGGER release_jobs_new_episode AFTER UPDATE OF state ON release_jobs
 WHEN OLD.state IN ('done','dead') AND NEW.state='pending' BEGIN
 UPDATE release_jobs SET queued_at=CAST(round(unixepoch('subsec')*1000) AS INTEGER) WHERE id=NEW.id;
END;
UPDATE release_meta SET version=25 WHERE version=24;

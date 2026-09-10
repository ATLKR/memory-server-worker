-- Central publication and immutable external payload metadata. Inline rows stay valid.
PRAGMA foreign_keys=ON;
ALTER TABLE memories ADD COLUMN payload_id TEXT;
ALTER TABLE memories ADD COLUMN payload_shard_id TEXT;
ALTER TABLE memories ADD COLUMN payload_object_key TEXT;
ALTER TABLE memories ADD COLUMN payload_sha256 TEXT;
ALTER TABLE memories ADD COLUMN payload_bytes INTEGER;
ALTER TABLE memories ADD COLUMN logical_bytes INTEGER;
ALTER TABLE memory_versions ADD COLUMN payload_id TEXT;
ALTER TABLE memory_versions ADD COLUMN payload_shard_id TEXT;
ALTER TABLE memory_versions ADD COLUMN payload_object_key TEXT;
ALTER TABLE memory_versions ADD COLUMN payload_sha256 TEXT;
ALTER TABLE memory_versions ADD COLUMN payload_bytes INTEGER;
ALTER TABLE memory_versions ADD COLUMN logical_bytes INTEGER;

CREATE TABLE release_payload_intents(
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),space_id TEXT NOT NULL REFERENCES spaces(id),
 client_key TEXT NOT NULL,request_hash TEXT NOT NULL,action TEXT NOT NULL,memory_id TEXT,expected_revision INTEGER,
 item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 20),reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes BETWEEN 1 AND 2621440),
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL CHECK(expires_at>created_at),published_at INTEGER,collection_started_at INTEGER,
 UNIQUE(account_id,space_id,client_key));
CREATE INDEX release_payload_intents_account ON release_payload_intents(account_id,published_at);
CREATE INDEX release_payload_intents_expiry ON release_payload_intents(expires_at,id) WHERE published_at IS NULL AND collection_started_at IS NULL;
CREATE TABLE release_payload_stage_accounts(account_id TEXT PRIMARY KEY REFERENCES accounts(id),bytes INTEGER NOT NULL CHECK(bytes>=0),quantity INTEGER NOT NULL CHECK(quantity>=0));
CREATE TABLE release_payload_stages(
 id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES release_payload_intents(id),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 19),
 memory_id TEXT NOT NULL,payload_shard_id TEXT NOT NULL,payload_object_key TEXT NOT NULL,payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 131072),logical_bytes INTEGER NOT NULL CHECK(logical_bytes BETWEEN 1 AND 24576),
 state TEXT NOT NULL DEFAULT 'staging' CHECK(state IN ('staging','ready','published','purge_pending','purged')),created_at INTEGER NOT NULL,
 UNIQUE(intent_id,ordinal));
CREATE INDEX release_payload_stages_memory ON release_payload_stages(memory_id,id);
CREATE INDEX release_payload_stages_collection ON release_payload_stages(state,intent_id,id);
CREATE TRIGGER release_payload_stage_admission BEFORE INSERT ON release_payload_stages WHEN NOT EXISTS(
 SELECT 1 FROM release_payload_intents i WHERE i.id=NEW.intent_id AND i.published_at IS NULL AND i.collection_started_at IS NULL
 AND i.expires_at>CAST(round(unixepoch('subsec')*1000) AS INTEGER) AND NEW.ordinal<i.item_count AND NEW.state='staging'
 AND (SELECT count(*) FROM release_payload_stages WHERE intent_id=i.id)<i.item_count
 AND coalesce((SELECT sum(payload_bytes) FROM release_payload_stages WHERE intent_id=i.id),0)+NEW.payload_bytes<=i.reserved_bytes)
 BEGIN SELECT RAISE(ABORT,'release_denied: Payload staging unavailable'); END;
CREATE INDEX release_memories_payload ON memories(payload_id) WHERE payload_id IS NOT NULL;
CREATE INDEX release_versions_payload ON memory_versions(payload_id) WHERE payload_id IS NOT NULL;
CREATE TABLE release_payload_purges(
 payload_id TEXT PRIMARY KEY REFERENCES release_payload_stages(id),space_id TEXT NOT NULL REFERENCES spaces(id),memory_id TEXT NOT NULL,
 payload_shard_id TEXT NOT NULL,payload_object_key TEXT NOT NULL,payload_sha256 TEXT NOT NULL,payload_bytes INTEGER NOT NULL,
 created_at INTEGER NOT NULL,purged_at INTEGER,available_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),last_error TEXT);
CREATE INDEX release_payload_purges_pending ON release_payload_purges(available_at,created_at,payload_id) WHERE purged_at IS NULL;
CREATE TABLE release_payload_retirements(
 payload_id TEXT PRIMARY KEY REFERENCES release_payload_stages(id),space_id TEXT NOT NULL REFERENCES spaces(id),memory_id TEXT NOT NULL,
 payload_shard_id TEXT NOT NULL,payload_object_key TEXT NOT NULL,payload_sha256 TEXT NOT NULL,payload_bytes INTEGER NOT NULL,
 created_at INTEGER NOT NULL,retired_at INTEGER,available_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),last_error TEXT);
CREATE INDEX release_payload_retirements_pending ON release_payload_retirements(available_at,created_at,payload_id) WHERE retired_at IS NULL;
CREATE TABLE release_payload_archive_permits(
 payload_id TEXT PRIMARY KEY REFERENCES release_payload_stages(id),memory_id TEXT NOT NULL,revision INTEGER NOT NULL,
 target TEXT NOT NULL CHECK(target IN ('current','history')),created_at INTEGER NOT NULL,UNIQUE(memory_id,revision,target));
CREATE TABLE release_payload_archives(
 payload_id TEXT PRIMARY KEY REFERENCES release_payload_stages(id),memory_id TEXT NOT NULL,revision INTEGER NOT NULL,
 target TEXT NOT NULL CHECK(target IN ('current','history')),created_at INTEGER NOT NULL);
CREATE TRIGGER release_payload_intent_budget BEFORE INSERT ON release_payload_intents BEGIN
 SELECT CASE WHEN coalesce((SELECT bytes FROM release_payload_stage_accounts WHERE account_id=NEW.account_id),0)+NEW.reserved_bytes>8388608
   OR coalesce((SELECT quantity FROM release_payload_stage_accounts WHERE account_id=NEW.account_id),0)+NEW.item_count>200
 THEN RAISE(ABORT,'release_payload_budget') END;
END;
CREATE TRIGGER release_payload_intent_reserve AFTER INSERT ON release_payload_intents BEGIN
 INSERT INTO release_payload_stage_accounts VALUES(NEW.account_id,NEW.reserved_bytes,NEW.item_count)
 ON CONFLICT(account_id) DO UPDATE SET bytes=bytes+excluded.bytes,quantity=quantity+excluded.quantity;
END;
CREATE TRIGGER release_payload_intent_immutable BEFORE UPDATE ON release_payload_intents WHEN
 NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.space_id IS NOT OLD.space_id OR NEW.client_key IS NOT OLD.client_key
 OR NEW.request_hash IS NOT OLD.request_hash OR NEW.action IS NOT OLD.action OR NEW.memory_id IS NOT OLD.memory_id
 OR NEW.expected_revision IS NOT OLD.expected_revision OR NEW.item_count IS NOT OLD.item_count OR NEW.reserved_bytes IS NOT OLD.reserved_bytes
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR NOT (OLD.published_at IS NULL AND OLD.collection_started_at IS NULL AND (
   (NEW.published_at IS NOT NULL AND NEW.collection_started_at IS NULL
     AND (SELECT count(*) FROM release_payload_stages WHERE intent_id=OLD.id AND state='published')=OLD.item_count)
   OR (NEW.published_at IS NULL AND NEW.collection_started_at IS NOT NULL AND OLD.expires_at<=CAST(round(unixepoch('subsec')*1000) AS INTEGER)
     AND (SELECT count(*) FROM release_payload_stages p WHERE p.intent_id=OLD.id AND p.state IN ('purge_pending','purged')
       AND EXISTS(SELECT 1 FROM release_payload_purges q WHERE q.payload_id=p.id))=OLD.item_count)))
 BEGIN SELECT RAISE(ABORT,'release_denied: Invalid payload intent transition'); END;
CREATE TRIGGER release_payload_intent_release AFTER UPDATE OF published_at ON release_payload_intents WHEN OLD.published_at IS NULL AND NEW.published_at IS NOT NULL BEGIN
 UPDATE release_payload_stage_accounts SET bytes=bytes-NEW.reserved_bytes,quantity=quantity-NEW.item_count WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER release_payload_stage_immutable BEFORE UPDATE ON release_payload_stages WHEN
 NEW.id IS NOT OLD.id OR NEW.intent_id IS NOT OLD.intent_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.memory_id IS NOT OLD.memory_id
 OR NEW.payload_shard_id IS NOT OLD.payload_shard_id OR NEW.payload_object_key IS NOT OLD.payload_object_key OR NEW.payload_sha256 IS NOT OLD.payload_sha256
 OR NEW.payload_bytes IS NOT OLD.payload_bytes OR NEW.logical_bytes IS NOT OLD.logical_bytes OR NEW.created_at IS NOT OLD.created_at
 OR NOT ((OLD.state='staging' AND NEW.state IN ('ready','purge_pending')) OR (OLD.state='ready' AND NEW.state IN ('published','purge_pending'))
   OR (OLD.state='published' AND NEW.state='purge_pending') OR (OLD.state='purge_pending' AND NEW.state='purged'))
 BEGIN SELECT RAISE(ABORT,'Invalid payload stage transition'); END;
CREATE TRIGGER release_payload_stage_publish BEFORE UPDATE OF state ON release_payload_stages WHEN NEW.state='published' AND (
 NOT EXISTS(SELECT 1 FROM release_payload_intents i WHERE i.id=NEW.intent_id AND i.collection_started_at IS NULL AND i.expires_at>CAST(round(unixepoch('subsec')*1000) AS INTEGER))
 OR NOT EXISTS(SELECT 1 FROM memories m JOIN release_payload_intents i ON i.id=NEW.intent_id WHERE m.id=NEW.memory_id AND m.space_id=i.space_id AND m.payload_id=NEW.id
   UNION ALL SELECT 1 FROM memory_versions m JOIN release_payload_intents i ON i.id=NEW.intent_id WHERE m.memory_id=NEW.memory_id AND m.space_id=i.space_id AND m.payload_id=NEW.id))
 BEGIN SELECT RAISE(ABORT,'Payload publication incomplete'); END;
CREATE TRIGGER release_payload_stage_collect BEFORE UPDATE OF state ON release_payload_stages WHEN NEW.state IN ('purge_pending','purged') AND (
 EXISTS(SELECT 1 FROM memories WHERE payload_id=NEW.id) OR EXISTS(SELECT 1 FROM memory_versions WHERE payload_id=NEW.id)
 OR (NEW.state='purged' AND NOT EXISTS(SELECT 1 FROM release_payload_purges WHERE payload_id=NEW.id AND purged_at IS NOT NULL)))
 BEGIN SELECT RAISE(ABORT,'Payload remains referenced'); END;
CREATE TRIGGER release_payload_stage_collected AFTER UPDATE OF state ON release_payload_stages WHEN NEW.state='purged' AND OLD.state='purge_pending'
 AND NOT EXISTS(SELECT 1 FROM release_payload_stages WHERE intent_id=NEW.intent_id AND state<>'purged') BEGIN
 UPDATE release_payload_stage_accounts SET bytes=bytes-(SELECT reserved_bytes FROM release_payload_intents WHERE id=NEW.intent_id),
 quantity=quantity-(SELECT item_count FROM release_payload_intents WHERE id=NEW.intent_id)
 WHERE account_id=(SELECT account_id FROM release_payload_intents WHERE id=NEW.intent_id AND published_at IS NULL);
END;
CREATE TRIGGER release_payload_intents_no_replace BEFORE INSERT ON release_payload_intents WHEN EXISTS(SELECT 1 FROM release_payload_intents WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Payload identity already exists'); END;
CREATE TRIGGER release_payload_intents_no_delete BEFORE DELETE ON release_payload_intents BEGIN SELECT RAISE(ABORT,'Payload evidence is retained'); END;
CREATE TRIGGER release_payload_stages_no_replace BEFORE INSERT ON release_payload_stages WHEN EXISTS(SELECT 1 FROM release_payload_stages WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Payload identity already exists'); END;
CREATE TRIGGER release_payload_stages_no_delete BEFORE DELETE ON release_payload_stages BEGIN SELECT RAISE(ABORT,'Payload evidence is retained'); END;
CREATE TRIGGER release_payload_purges_no_replace BEFORE INSERT ON release_payload_purges WHEN EXISTS(SELECT 1 FROM release_payload_purges WHERE payload_id=NEW.payload_id) BEGIN SELECT RAISE(ABORT,'Payload identity already exists'); END;
CREATE TRIGGER release_payload_purges_no_delete BEFORE DELETE ON release_payload_purges BEGIN SELECT RAISE(ABORT,'Payload evidence is retained'); END;
CREATE TRIGGER release_payload_retirements_no_replace BEFORE INSERT ON release_payload_retirements WHEN EXISTS(SELECT 1 FROM release_payload_retirements WHERE payload_id=NEW.payload_id) BEGIN SELECT RAISE(ABORT,'Payload identity already exists'); END;
CREATE TRIGGER release_payload_retirements_no_delete BEFORE DELETE ON release_payload_retirements BEGIN SELECT RAISE(ABORT,'Payload evidence is retained'); END;
CREATE TRIGGER release_payload_archives_no_replace BEFORE INSERT ON release_payload_archives WHEN EXISTS(SELECT 1 FROM release_payload_archives WHERE payload_id=NEW.payload_id) BEGIN SELECT RAISE(ABORT,'Payload identity already exists'); END;
CREATE TRIGGER release_payload_archives_no_delete BEFORE DELETE ON release_payload_archives BEGIN SELECT RAISE(ABORT,'Payload evidence is retained'); END;
CREATE TRIGGER release_payload_archives_no_update BEFORE UPDATE ON release_payload_archives BEGIN SELECT RAISE(ABORT,'Payload archive is immutable'); END;
CREATE TRIGGER release_payload_purges_immutable BEFORE UPDATE ON release_payload_purges WHEN NEW.payload_id IS NOT OLD.payload_id OR NEW.space_id IS NOT OLD.space_id OR NEW.memory_id IS NOT OLD.memory_id OR NEW.payload_shard_id IS NOT OLD.payload_shard_id OR NEW.payload_object_key IS NOT OLD.payload_object_key OR NEW.payload_sha256 IS NOT OLD.payload_sha256 OR NEW.payload_bytes IS NOT OLD.payload_bytes OR NEW.created_at IS NOT OLD.created_at OR OLD.purged_at IS NOT NULL OR NEW.attempts<OLD.attempts BEGIN SELECT RAISE(ABORT,'Payload cleanup evidence is immutable'); END;
CREATE TRIGGER release_payload_retirements_immutable BEFORE UPDATE ON release_payload_retirements WHEN NEW.payload_id IS NOT OLD.payload_id OR NEW.space_id IS NOT OLD.space_id OR NEW.memory_id IS NOT OLD.memory_id OR NEW.payload_shard_id IS NOT OLD.payload_shard_id OR NEW.payload_object_key IS NOT OLD.payload_object_key OR NEW.payload_sha256 IS NOT OLD.payload_sha256 OR NEW.payload_bytes IS NOT OLD.payload_bytes OR NEW.created_at IS NOT OLD.created_at OR OLD.retired_at IS NOT NULL OR NEW.attempts<OLD.attempts BEGIN SELECT RAISE(ABORT,'Payload cleanup evidence is immutable'); END;
CREATE TRIGGER memories_payload_insert BEFORE INSERT ON memories WHEN
 (NEW.payload_id IS NULL AND (NEW.payload_shard_id IS NOT NULL OR NEW.payload_object_key IS NOT NULL OR NEW.payload_sha256 IS NOT NULL OR NEW.payload_bytes IS NOT NULL OR NEW.logical_bytes IS NOT NULL))
 OR (NEW.payload_id IS NOT NULL AND (NEW.body<>'[external]' OR NEW.source IS NOT NULL OR NEW.provenance<>'{}' OR NOT EXISTS(SELECT 1 FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id WHERE p.id=NEW.payload_id AND p.memory_id=NEW.id AND i.space_id=NEW.space_id AND ((p.state='published' AND 0) OR (p.state='ready' AND (EXISTS(SELECT 1 FROM release_operations o WHERE o.account_id=i.account_id AND o.space_id=i.space_id AND o.client_key=i.client_key AND o.request_hash=i.request_hash) OR EXISTS(SELECT 1 FROM release_payload_archive_permits permit WHERE permit.payload_id=p.id)))) AND p.payload_shard_id=NEW.payload_shard_id AND p.payload_object_key=NEW.payload_object_key AND p.payload_sha256=NEW.payload_sha256 AND p.payload_bytes=NEW.payload_bytes AND p.logical_bytes=NEW.logical_bytes)))

 BEGIN SELECT RAISE(ABORT,'Invalid payload reference'); END;
CREATE TRIGGER memories_payload_update BEFORE UPDATE ON memories WHEN
 (NEW.payload_id IS NULL AND (NEW.payload_shard_id IS NOT NULL OR NEW.payload_object_key IS NOT NULL OR NEW.payload_sha256 IS NOT NULL OR NEW.payload_bytes IS NOT NULL OR NEW.logical_bytes IS NOT NULL))
 OR (NEW.payload_id IS NOT NULL AND (NEW.body<>'[external]' OR NEW.source IS NOT NULL OR NEW.provenance<>'{}' OR NOT EXISTS(SELECT 1 FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id WHERE p.id=NEW.payload_id AND p.memory_id=NEW.id AND i.space_id=NEW.space_id AND ((p.state='published' AND NEW.payload_id IS OLD.payload_id) OR (p.state='ready' AND (EXISTS(SELECT 1 FROM release_operations o WHERE o.account_id=i.account_id AND o.space_id=i.space_id AND o.client_key=i.client_key AND o.request_hash=i.request_hash) OR EXISTS(SELECT 1 FROM release_payload_archive_permits permit WHERE permit.payload_id=p.id)))) AND p.payload_shard_id=NEW.payload_shard_id AND p.payload_object_key=NEW.payload_object_key AND p.payload_sha256=NEW.payload_sha256 AND p.payload_bytes=NEW.payload_bytes AND p.logical_bytes=NEW.logical_bytes)))
 OR (OLD.payload_id IS NOT NULL AND NEW.payload_id IS NULL AND NEW.erased_at IS NULL)
 OR (NEW.erased_at IS NULL AND (NEW.deleted_at IS NOT NULL OR OLD.deleted_at IS NOT NULL) AND NEW.revision<>OLD.revision AND NOT (NEW.payload_id IS OLD.payload_id AND NEW.payload_shard_id IS OLD.payload_shard_id AND NEW.payload_object_key IS OLD.payload_object_key AND NEW.payload_sha256 IS OLD.payload_sha256 AND NEW.payload_bytes IS OLD.payload_bytes AND NEW.logical_bytes IS OLD.logical_bytes))
 BEGIN SELECT RAISE(ABORT,'Invalid payload reference'); END;
CREATE TRIGGER memory_versions_payload_insert BEFORE INSERT ON memory_versions WHEN
 (NEW.payload_id IS NULL AND (NEW.payload_shard_id IS NOT NULL OR NEW.payload_object_key IS NOT NULL OR NEW.payload_sha256 IS NOT NULL OR NEW.payload_bytes IS NOT NULL OR NEW.logical_bytes IS NOT NULL))
 OR (NEW.payload_id IS NOT NULL AND (NEW.body<>'[external]' OR NEW.source IS NOT NULL OR NEW.provenance<>'{}' OR NOT EXISTS(SELECT 1 FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id WHERE p.id=NEW.payload_id AND p.memory_id=NEW.memory_id AND i.space_id=NEW.space_id AND (p.state='published' OR (p.state='ready' AND (EXISTS(SELECT 1 FROM release_operations o WHERE o.account_id=i.account_id AND o.space_id=i.space_id AND o.client_key=i.client_key AND o.request_hash=i.request_hash) OR EXISTS(SELECT 1 FROM release_payload_archive_permits permit WHERE permit.payload_id=p.id)))) AND p.payload_shard_id=NEW.payload_shard_id AND p.payload_object_key=NEW.payload_object_key AND p.payload_sha256=NEW.payload_sha256 AND p.payload_bytes=NEW.payload_bytes AND p.logical_bytes=NEW.logical_bytes)))

 BEGIN SELECT RAISE(ABORT,'Invalid payload reference'); END;
CREATE TRIGGER memory_versions_payload_update BEFORE UPDATE ON memory_versions WHEN
 (NEW.payload_id IS NULL AND (NEW.payload_shard_id IS NOT NULL OR NEW.payload_object_key IS NOT NULL OR NEW.payload_sha256 IS NOT NULL OR NEW.payload_bytes IS NOT NULL OR NEW.logical_bytes IS NOT NULL))
 OR (NEW.payload_id IS NOT NULL AND (NEW.body<>'[external]' OR NEW.source IS NOT NULL OR NEW.provenance<>'{}' OR NOT EXISTS(SELECT 1 FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id WHERE p.id=NEW.payload_id AND p.memory_id=NEW.memory_id AND i.space_id=NEW.space_id AND (p.state='published' OR (p.state='ready' AND (EXISTS(SELECT 1 FROM release_operations o WHERE o.account_id=i.account_id AND o.space_id=i.space_id AND o.client_key=i.client_key AND o.request_hash=i.request_hash) OR EXISTS(SELECT 1 FROM release_payload_archive_permits permit WHERE permit.payload_id=p.id)))) AND p.payload_shard_id=NEW.payload_shard_id AND p.payload_object_key=NEW.payload_object_key AND p.payload_sha256=NEW.payload_sha256 AND p.payload_bytes=NEW.payload_bytes AND p.logical_bytes=NEW.logical_bytes)))

 BEGIN SELECT RAISE(ABORT,'Invalid payload reference'); END;
DROP TRIGGER memories_validate_transition;
CREATE TRIGGER memories_validate_transition BEFORE UPDATE ON memories WHEN NOT (OLD.payload_id IS NULL AND NEW.payload_id IS NOT NULL AND NEW.id=OLD.id AND NEW.space_id IS OLD.space_id AND NEW.revision IS OLD.revision AND NEW.created_at IS OLD.created_at AND NEW.updated_at IS OLD.updated_at AND NEW.deleted_at IS OLD.deleted_at AND NEW.actor_credential_id IS OLD.actor_credential_id AND NEW.kind IS OLD.kind AND NEW.event_time IS OLD.event_time AND NEW.supersedes_id IS OLD.supersedes_id AND NEW.erased_at IS OLD.erased_at AND NEW.logical_bytes=coalesce(OLD.logical_bytes,length(CAST(OLD.body AS BLOB))+coalesce(length(CAST(OLD.source AS BLOB)),0)+length(CAST(OLD.provenance AS BLOB))) AND EXISTS(SELECT 1 FROM release_payload_archive_permits a WHERE a.payload_id=NEW.payload_id AND a.memory_id=OLD.id AND a.revision=OLD.revision AND a.target='current')) AND (
 NEW.id<>OLD.id OR NEW.space_id<>OLD.space_id OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR OLD.erased_at IS NOT NULL
 OR (NEW.erased_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM release_erasure_permits p WHERE p.memory_id=OLD.id AND p.actor_credential_id=NEW.actor_credential_id))
 OR (NEW.erased_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL)
 OR (NEW.erased_at IS NULL AND NEW.deleted_at IS NOT NULL AND (NEW.body<>OLD.body OR NEW.source IS NOT OLD.source)))
 BEGIN SELECT RAISE(ABORT,'Invalid memory transition'); END;
DROP TRIGGER memories_preserve_version;
CREATE TRIGGER memories_preserve_version AFTER UPDATE ON memories WHEN NEW.revision<>OLD.revision BEGIN
 INSERT INTO memory_versions(memory_id,revision,space_id,body,source,created_at,updated_at,deleted_at,actor_credential_id,archived_at,kind,provenance,event_time,supersedes_id,payload_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,logical_bytes)
 SELECT OLD.id,OLD.revision,OLD.space_id,OLD.body,OLD.source,OLD.created_at,OLD.updated_at,OLD.deleted_at,OLD.actor_credential_id,NEW.updated_at,OLD.kind,OLD.provenance,OLD.event_time,OLD.supersedes_id,OLD.payload_id,OLD.payload_shard_id,OLD.payload_object_key,OLD.payload_sha256,OLD.payload_bytes,OLD.logical_bytes WHERE NEW.erased_at IS NULL;
 INSERT INTO memory_audit_events(action,space_id,memory_id,revision,actor_credential_id,created_at)
 VALUES(CASE WHEN NEW.deleted_at IS NULL THEN 'memory_updated' ELSE 'memory_deleted' END,NEW.space_id,NEW.id,NEW.revision,NEW.actor_credential_id,NEW.updated_at);
END;
DROP TRIGGER memory_versions_no_update;
CREATE TRIGGER memory_versions_no_update BEFORE UPDATE ON memory_versions WHEN NOT (OLD.payload_id IS NULL AND NEW.payload_id IS NOT NULL AND NEW.memory_id=OLD.memory_id AND NEW.space_id IS OLD.space_id AND NEW.revision IS OLD.revision AND NEW.created_at IS OLD.created_at AND NEW.updated_at IS OLD.updated_at AND NEW.deleted_at IS OLD.deleted_at AND NEW.actor_credential_id IS OLD.actor_credential_id AND NEW.kind IS OLD.kind AND NEW.event_time IS OLD.event_time AND NEW.supersedes_id IS OLD.supersedes_id AND NEW.archived_at IS OLD.archived_at AND NEW.logical_bytes=coalesce(OLD.logical_bytes,length(CAST(OLD.body AS BLOB))+coalesce(length(CAST(OLD.source AS BLOB)),0)+length(CAST(OLD.provenance AS BLOB))) AND EXISTS(SELECT 1 FROM release_payload_archive_permits a WHERE a.payload_id=NEW.payload_id AND a.memory_id=OLD.memory_id AND a.revision=OLD.revision AND a.target='history')) BEGIN SELECT RAISE(ABORT,'Memory history is append-only'); END;
CREATE TRIGGER memories_payload_archived AFTER UPDATE ON memories WHEN OLD.payload_id IS NULL AND NEW.payload_id IS NOT NULL AND NEW.revision=OLD.revision BEGIN
 INSERT INTO release_payload_archives SELECT payload_id,memory_id,revision,target,created_at FROM release_payload_archive_permits WHERE payload_id=NEW.payload_id AND memory_id=NEW.id AND revision=NEW.revision AND target='current';
END;
CREATE TRIGGER memory_versions_payload_archived AFTER UPDATE ON memory_versions WHEN OLD.payload_id IS NULL AND NEW.payload_id IS NOT NULL AND NEW.revision=OLD.revision BEGIN
 INSERT INTO release_payload_archives SELECT payload_id,memory_id,revision,target,created_at FROM release_payload_archive_permits WHERE payload_id=NEW.payload_id AND memory_id=NEW.memory_id AND revision=NEW.revision AND target='history';
END;
DROP VIEW release_memory_sizes;
CREATE VIEW release_memory_sizes AS SELECT id,space_id,CASE WHEN erased_at IS NULL THEN coalesce(memories.logical_bytes,length(CAST(memories.body AS BLOB))+coalesce(length(CAST(memories.source AS BLOB)),0)+length(CAST(memories.provenance AS BLOB))) ELSE 0 END AS bytes FROM memories;
DROP VIEW release_version_sizes;
CREATE VIEW release_version_sizes AS SELECT memory_id,revision,space_id,coalesce(memory_versions.logical_bytes,length(CAST(memory_versions.body AS BLOB))+coalesce(length(CAST(memory_versions.source AS BLOB)),0)+length(CAST(memory_versions.provenance AS BLOB))) AS bytes FROM memory_versions;
DROP TRIGGER release_storage_guard_insert;
CREATE TRIGGER release_storage_guard_insert BEFORE INSERT ON memories BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM release_space_pools sp JOIN release_pools p ON p.id=sp.pool_id WHERE sp.space_id=NEW.space_id AND p.storage_bytes+coalesce(NEW.logical_bytes,length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB)))>p.storage_limit_bytes) THEN RAISE(ABORT,'release_storage') END;
END;
DROP TRIGGER release_storage_guard_update;
CREATE TRIGGER release_storage_guard_update BEFORE UPDATE ON memories WHEN NEW.revision<>OLD.revision AND NEW.deleted_at IS NULL AND NEW.erased_at IS NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM release_space_pools sp JOIN release_pools p ON p.id=sp.pool_id WHERE sp.space_id=NEW.space_id AND p.storage_bytes+coalesce(NEW.logical_bytes,length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB)))>p.storage_limit_bytes) THEN RAISE(ABORT,'release_storage') END;
END;
DROP TRIGGER release_storage_insert;
CREATE TRIGGER release_storage_insert AFTER INSERT ON memories BEGIN UPDATE release_pools SET storage_bytes=storage_bytes+coalesce(NEW.logical_bytes,length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB))) WHERE id=(SELECT pool_id FROM release_space_pools WHERE space_id=NEW.space_id); END;
DROP TRIGGER release_storage_update;
CREATE TRIGGER release_storage_update AFTER UPDATE ON memories BEGIN UPDATE release_pools SET storage_bytes=storage_bytes-coalesce(OLD.logical_bytes,length(CAST(OLD.body AS BLOB))+coalesce(length(CAST(OLD.source AS BLOB)),0)+length(CAST(OLD.provenance AS BLOB)))+(CASE WHEN NEW.erased_at IS NULL THEN coalesce(NEW.logical_bytes,length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB))) ELSE 0 END) WHERE id=(SELECT pool_id FROM release_space_pools WHERE space_id=NEW.space_id); END;
DROP TRIGGER release_storage_version_insert;
CREATE TRIGGER release_storage_version_insert AFTER INSERT ON memory_versions BEGIN UPDATE release_pools SET storage_bytes=storage_bytes+coalesce(NEW.logical_bytes,length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB))) WHERE id=(SELECT pool_id FROM release_space_pools WHERE space_id=NEW.space_id); END;
DROP TRIGGER release_storage_version_delete;
CREATE TRIGGER release_storage_version_delete AFTER DELETE ON memory_versions BEGIN UPDATE release_pools SET storage_bytes=storage_bytes-coalesce(OLD.logical_bytes,length(CAST(OLD.body AS BLOB))+coalesce(length(CAST(OLD.source AS BLOB)),0)+length(CAST(OLD.provenance AS BLOB))) WHERE id=(SELECT pool_id FROM release_space_pools WHERE space_id=OLD.space_id); END;
CREATE TRIGGER release_payload_retire_old AFTER UPDATE ON memories WHEN OLD.payload_id IS NOT NULL AND NEW.payload_id IS NOT OLD.payload_id BEGIN
 INSERT INTO release_payload_retirements(payload_id,space_id,memory_id,payload_shard_id,payload_object_key,payload_sha256,payload_bytes,created_at,retired_at) SELECT OLD.payload_id,OLD.space_id,OLD.id,OLD.payload_shard_id,OLD.payload_object_key,OLD.payload_sha256,OLD.payload_bytes,CAST(round(unixepoch('subsec')*1000) AS INTEGER),NULL
 WHERE NOT EXISTS(SELECT 1 FROM release_payload_retirements WHERE payload_id=OLD.payload_id);
END;
DROP TRIGGER release_memory_index_insert;
DROP TRIGGER release_memory_index_update;
CREATE TRIGGER release_memory_index_insert AFTER INSERT ON memories BEGIN
 INSERT INTO release_fts_rows(memory_id) VALUES(NEW.id);
 INSERT INTO release_fts(rowid,memory_id,space_id,body,tenant)
  SELECT id,NEW.id,NEW.space_id,NEW.body,'t'||lower(hex(NEW.space_id)) FROM release_fts_rows
  WHERE memory_id=NEW.id AND NEW.deleted_at IS NULL AND NEW.erased_at IS NULL AND NEW.payload_id IS NULL;
 INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
  VALUES(NEW.id||':'||NEW.revision,NEW.id,NEW.space_id,NEW.revision,'upsert',NEW.updated_at,NEW.updated_at);
END;
CREATE TRIGGER release_memory_index_update AFTER UPDATE ON memories BEGIN
 DELETE FROM release_fts WHERE rowid=(SELECT id FROM release_fts_rows WHERE memory_id=NEW.id);
 INSERT INTO release_fts(rowid,memory_id,space_id,body,tenant)
  SELECT id,NEW.id,NEW.space_id,NEW.body,'t'||lower(hex(NEW.space_id)) FROM release_fts_rows
  WHERE memory_id=NEW.id AND NEW.deleted_at IS NULL AND NEW.erased_at IS NULL AND NEW.payload_id IS NULL;
 INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
  SELECT NEW.id||':'||NEW.revision,NEW.id,NEW.space_id,NEW.revision,CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,NEW.updated_at,NEW.updated_at WHERE NEW.revision<>OLD.revision;
END;
CREATE TRIGGER release_payload_archive_permit_validate BEFORE INSERT ON release_payload_archive_permits WHEN NOT EXISTS(
 SELECT 1 FROM release_payload_stages p JOIN release_payload_intents i ON i.id=p.intent_id WHERE p.id=NEW.payload_id AND p.memory_id=NEW.memory_id
 AND p.state='ready' AND i.action='archive' AND i.expires_at>CAST(round(unixepoch('subsec')*1000) AS INTEGER) AND (
 (NEW.target='current' AND EXISTS(SELECT 1 FROM memories m WHERE m.id=NEW.memory_id AND m.revision=NEW.revision AND m.space_id=i.space_id AND m.payload_id IS NULL AND m.erased_at IS NULL
 AND p.logical_bytes=length(CAST(m.body AS BLOB))+coalesce(length(CAST(m.source AS BLOB)),0)+length(CAST(m.provenance AS BLOB))))
 OR (NEW.target='history' AND EXISTS(SELECT 1 FROM memory_versions m JOIN memories h ON h.id=m.memory_id WHERE m.memory_id=NEW.memory_id AND m.revision=NEW.revision AND m.space_id=i.space_id AND m.payload_id IS NULL AND h.erased_at IS NULL
 AND p.logical_bytes=length(CAST(m.body AS BLOB))+coalesce(length(CAST(m.source AS BLOB)),0)+length(CAST(m.provenance AS BLOB))))))
 BEGIN SELECT RAISE(ABORT,'Payload archive source changed'); END;
CREATE TRIGGER release_payload_archive_permit_no_update BEFORE UPDATE ON release_payload_archive_permits BEGIN SELECT RAISE(ABORT,'Payload archive permit is immutable'); END;
CREATE TRIGGER release_payload_archive_permit_no_replace BEFORE INSERT ON release_payload_archive_permits WHEN EXISTS(SELECT 1 FROM release_payload_archive_permits WHERE payload_id=NEW.payload_id OR (memory_id=NEW.memory_id AND revision=NEW.revision AND target=NEW.target)) BEGIN SELECT RAISE(ABORT,'Payload archive permit exists'); END;
UPDATE release_meta SET version=22 WHERE version=21;

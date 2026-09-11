-- Generated from shard-schema.sql; independent hot-shard migration 1.
-- Data-only hot payload shard. Authority, publication and quota stay central.
PRAGMA foreign_keys=ON;
CREATE TABLE payload_meta(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO payload_meta VALUES(1);
CREATE TABLE payloads(
 row_id INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 space_id TEXT NOT NULL,
 memory_id TEXT NOT NULL,
 content TEXT NOT NULL CHECK(json_valid(content) AND json_type(content)='object'
   AND json_type(content,'$.body')='text' AND json_type(content,'$.provenance')='object'
   AND coalesce(json_type(content,'$.source') IN ('text','null'),0)),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 bytes INTEGER NOT NULL CHECK(bytes=length(CAST(content AS BLOB)) AND bytes BETWEEN 1 AND 131072),
 created_at INTEGER NOT NULL
);
CREATE INDEX payloads_space ON payloads(space_id,id);
CREATE TABLE payload_tombstones(
 id TEXT PRIMARY KEY NOT NULL,
 space_id TEXT NOT NULL,
 memory_id TEXT NOT NULL,
 retired_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE payload_fts USING fts5(payload_id UNINDEXED,memory_id UNINDEXED,space_id UNINDEXED,body,tenant,
 tokenize='unicode61',prefix='1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31');
CREATE TRIGGER payloads_retired BEFORE INSERT ON payloads
 WHEN EXISTS(SELECT 1 FROM payload_tombstones WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'payload_retired'); END;
CREATE TRIGGER payloads_no_replace BEFORE INSERT ON payloads
 WHEN EXISTS(SELECT 1 FROM payloads WHERE id=NEW.id OR row_id=NEW.row_id)
 BEGIN SELECT RAISE(ABORT,'payload_immutable'); END;
CREATE TRIGGER payloads_no_update BEFORE UPDATE ON payloads
 BEGIN SELECT RAISE(ABORT,'payload_immutable'); END;
CREATE TRIGGER payloads_no_delete BEFORE DELETE ON payloads
 WHEN NOT EXISTS(SELECT 1 FROM payload_tombstones WHERE id=OLD.id AND space_id=OLD.space_id AND memory_id=OLD.memory_id)
 BEGIN SELECT RAISE(ABORT,'payload_immutable'); END;
CREATE TRIGGER payloads_index_insert AFTER INSERT ON payloads BEGIN
 INSERT INTO payload_fts(rowid,payload_id,memory_id,space_id,body,tenant)
 VALUES(NEW.row_id,NEW.id,NEW.memory_id,NEW.space_id,json_extract(NEW.content,'$.body'),'t'||lower(hex(NEW.space_id)));
END;
CREATE TRIGGER payloads_index_delete AFTER DELETE ON payloads BEGIN
 DELETE FROM payload_fts WHERE rowid=OLD.row_id;
END;
CREATE TRIGGER payload_tombstones_context BEFORE INSERT ON payload_tombstones
 WHEN EXISTS(SELECT 1 FROM payloads WHERE id=NEW.id AND (space_id<>NEW.space_id OR memory_id<>NEW.memory_id))
 BEGIN SELECT RAISE(ABORT,'payload_context_mismatch'); END;
CREATE TRIGGER payload_tombstones_no_replace BEFORE INSERT ON payload_tombstones
 WHEN EXISTS(SELECT 1 FROM payload_tombstones WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'payload_tombstone_immutable'); END;
CREATE TRIGGER payload_tombstones_no_update BEFORE UPDATE ON payload_tombstones
 BEGIN SELECT RAISE(ABORT,'payload_tombstone_immutable'); END;
CREATE TRIGGER payload_tombstones_no_delete BEFORE DELETE ON payload_tombstones
 BEGIN SELECT RAISE(ABORT,'payload_tombstone_immutable'); END;
CREATE TRIGGER payload_tombstones_apply AFTER INSERT ON payload_tombstones BEGIN
 DELETE FROM payloads WHERE id=NEW.id;
END;

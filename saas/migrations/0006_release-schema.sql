-- Forward SaaS migration 6: release-schema.sql
-- Forward-only migration after PR #22 migrations 0001..0005. Never edit them.
PRAGMA foreign_keys=ON;
CREATE TABLE release_meta(version INTEGER PRIMARY KEY, installed_at TEXT NOT NULL);
INSERT INTO release_meta VALUES(6,strftime('%Y-%m-%dT%H:%M:%SZ','now'));
ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact' CHECK(kind IN ('fact','event','instruction','task'));
ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT '{"originKind":"user"}' CHECK(json_valid(provenance));
ALTER TABLE memories ADD COLUMN event_time INTEGER CHECK(event_time IS NULL OR event_time>=0);
ALTER TABLE memories ADD COLUMN supersedes_id TEXT REFERENCES memories(id);
ALTER TABLE memories ADD COLUMN erased_at INTEGER;
ALTER TABLE memory_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact';
ALTER TABLE memory_versions ADD COLUMN provenance TEXT NOT NULL DEFAULT '{"originKind":"user"}';
ALTER TABLE memory_versions ADD COLUMN event_time INTEGER;
ALTER TABLE memory_versions ADD COLUMN supersedes_id TEXT;
CREATE UNIQUE INDEX release_one_successor ON memories(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX release_memories_deleted ON memories(deleted_at) WHERE deleted_at IS NOT NULL AND erased_at IS NULL;
CREATE TABLE release_credential_policies(
 credential_id TEXT PRIMARY KEY REFERENCES credentials(id),
 capabilities TEXT NOT NULL CHECK(json_valid(capabilities) AND json_type(capabilities)='array'),
 space_ids TEXT CHECK(space_ids IS NULL OR (json_valid(space_ids) AND json_type(space_ids)='array'))
);
-- Preserve existing credentials' authority; all new keys get an explicit policy.
INSERT INTO release_credential_policies SELECT id,
 CASE WHEN permission='write' THEN '["read","create","update","delete","export"]' ELSE '["read"]' END,NULL
 FROM credentials WHERE kind<>'session' OR id LIKE 'oauth:%';
CREATE TABLE release_pools(
 id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'free',
 monthly_units INTEGER NOT NULL DEFAULT 1000 CHECK(monthly_units>=0),
 storage_limit_bytes INTEGER NOT NULL DEFAULT 104857600 CHECK(storage_limit_bytes>=0),
 storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK(storage_bytes>=0),
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','read_only')),
 customer_id TEXT UNIQUE, subscription_id TEXT UNIQUE, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE VIEW release_space_pools AS SELECT s.id AS space_id,CASE WHEN s.organization_id IS NULL THEN 'account:'||s.account_id ELSE 'org:'||s.organization_id END AS pool_id FROM spaces s;
INSERT INTO release_pools(id) SELECT DISTINCT pool_id FROM release_space_pools;
CREATE TRIGGER release_space_pool AFTER INSERT ON spaces BEGIN
 INSERT INTO release_pools(id) VALUES(CASE WHEN NEW.organization_id IS NULL THEN 'account:'||NEW.account_id ELSE 'org:'||NEW.organization_id END) ON CONFLICT(id) DO NOTHING;
END;
CREATE TABLE release_usage_counters(pool_id TEXT REFERENCES release_pools(id),period TEXT,units INTEGER NOT NULL DEFAULT 0 CHECK(units>=0),PRIMARY KEY(pool_id,period));
CREATE TABLE release_operations(
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),space_id TEXT NOT NULL REFERENCES spaces(id),
 client_key TEXT NOT NULL,request_hash TEXT NOT NULL,action TEXT NOT NULL,
 memory_id TEXT,expected_revision INTEGER,committed_revision INTEGER,
 actor_credential_id TEXT NOT NULL REFERENCES credentials(id),created_at INTEGER NOT NULL,
 period TEXT NOT NULL,units INTEGER NOT NULL CHECK(units>=0),
 UNIQUE(account_id,space_id,client_key)
);
CREATE TABLE release_usage_events(
 operation_id TEXT PRIMARY KEY REFERENCES release_operations(id),pool_id TEXT NOT NULL REFERENCES release_pools(id),
 account_id TEXT NOT NULL REFERENCES accounts(id),period TEXT NOT NULL,units INTEGER NOT NULL,created_at INTEGER NOT NULL
);
CREATE TRIGGER release_operation_budget BEFORE INSERT ON release_operations WHEN NEW.units>0 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM release_space_pools sp JOIN release_pools p ON p.id=sp.pool_id
 LEFT JOIN release_usage_counters u ON u.pool_id=p.id AND u.period=NEW.period
 WHERE sp.space_id=NEW.space_id AND p.state='active' AND coalesce(u.units,0)+NEW.units<=p.monthly_units)
 THEN RAISE(ABORT,'release_quota') END;
END;
CREATE TRIGGER release_operation_meter AFTER INSERT ON release_operations BEGIN
 INSERT INTO release_usage_events SELECT NEW.id,sp.pool_id,NEW.account_id,NEW.period,NEW.units,NEW.created_at FROM release_space_pools sp WHERE sp.space_id=NEW.space_id;
 INSERT INTO release_usage_counters(pool_id,period,units) SELECT sp.pool_id,NEW.period,NEW.units FROM release_space_pools sp WHERE sp.space_id=NEW.space_id
 ON CONFLICT(pool_id,period) DO UPDATE SET units=units+excluded.units;
END;
CREATE TRIGGER release_usage_immutable_update BEFORE UPDATE ON release_usage_events BEGIN SELECT RAISE(ABORT,'Usage is immutable'); END;
CREATE TRIGGER release_usage_immutable_delete BEFORE DELETE ON release_usage_events BEGIN SELECT RAISE(ABORT,'Usage is immutable'); END;
CREATE TABLE release_space_policies(space_id TEXT PRIMARY KEY REFERENCES spaces(id),retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 1 AND 3650));
CREATE TABLE release_erasure_permits(memory_id TEXT PRIMARY KEY REFERENCES memories(id),actor_credential_id TEXT NOT NULL REFERENCES credentials(id),created_at INTEGER NOT NULL);
CREATE TABLE release_erasure_ledger(memory_id TEXT PRIMARY KEY REFERENCES memories(id),space_id TEXT NOT NULL REFERENCES spaces(id),erased_at INTEGER NOT NULL,vector_erased_at INTEGER);
CREATE TABLE release_events(id INTEGER PRIMARY KEY,action TEXT NOT NULL,actor_credential_id TEXT REFERENCES credentials(id),resource_id TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE release_jobs(
 id TEXT PRIMARY KEY,memory_id TEXT REFERENCES memories(id),space_id TEXT REFERENCES spaces(id),revision INTEGER,
 kind TEXT NOT NULL CHECK(kind IN ('upsert','delete','ingest')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','done','dead')),
 attempt INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_until INTEGER,lease_token TEXT,
 last_error TEXT,created_at INTEGER NOT NULL
);
CREATE INDEX release_jobs_due ON release_jobs(state,available_at,lease_until);
CREATE TABLE release_vector_refs(memory_id TEXT REFERENCES memories(id),vector_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
CREATE TABLE release_ingests(
 id TEXT PRIMARY KEY REFERENCES release_jobs(id),account_id TEXT NOT NULL REFERENCES accounts(id),space_id TEXT NOT NULL REFERENCES spaces(id),
 actor_credential_id TEXT NOT NULL REFERENCES credentials(id),ciphertext TEXT,proposals TEXT,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','review','approved','cancelled','expired','failed')),
 expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL
);
CREATE TABLE release_export_sessions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),space_id TEXT NOT NULL REFERENCES spaces(id),watermark INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE release_shares(
 id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES spaces(id),recipient_email_id TEXT NOT NULL REFERENCES account_emails(id),
 creator_credential_id TEXT NOT NULL REFERENCES credentials(id),accepted_at INTEGER,revoked_at INTEGER,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL
);
CREATE INDEX release_shares_recipient ON release_shares(recipient_email_id,space_id);
CREATE TABLE release_domain_challenges(id TEXT PRIMARY KEY,organization_id TEXT REFERENCES organizations(id),actor_account_id TEXT REFERENCES accounts(id),domain TEXT NOT NULL,proof TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
CREATE TABLE release_scim_keys(id TEXT PRIMARY KEY,organization_id TEXT REFERENCES organizations(id),token_digest TEXT UNIQUE,creator_credential_id TEXT REFERENCES credentials(id),expires_at INTEGER NOT NULL,revoked_at INTEGER);
CREATE TABLE release_webhook_events(provider TEXT,event_id TEXT,body_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(provider,event_id));
CREATE TABLE release_checkout_requests(id TEXT PRIMARY KEY,pool_id TEXT REFERENCES release_pools(id),price_id TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE release_billing_events(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempt INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,created_at INTEGER NOT NULL);

-- Only the erasure transaction can bypass historical plaintext retention.
DROP TRIGGER memories_validate_transition;
CREATE TRIGGER memories_validate_transition BEFORE UPDATE ON memories WHEN
 NEW.id<>OLD.id OR NEW.space_id<>OLD.space_id OR NEW.created_at<>OLD.created_at
 OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR OLD.erased_at IS NOT NULL
 OR (NEW.erased_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM release_erasure_permits p WHERE p.memory_id=OLD.id AND p.actor_credential_id=NEW.actor_credential_id))
 OR (NEW.erased_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL)
 OR (NEW.erased_at IS NULL AND NEW.deleted_at IS NOT NULL AND (NEW.body<>OLD.body OR NEW.source IS NOT OLD.source))
 BEGIN SELECT RAISE(ABORT,'Invalid memory transition'); END;
DROP TRIGGER memories_preserve_version;
CREATE TRIGGER memories_preserve_version AFTER UPDATE ON memories BEGIN
 INSERT INTO memory_versions(memory_id,revision,space_id,body,source,created_at,updated_at,deleted_at,actor_credential_id,archived_at,kind,provenance,event_time,supersedes_id)
 SELECT OLD.id,OLD.revision,OLD.space_id,OLD.body,OLD.source,OLD.created_at,OLD.updated_at,OLD.deleted_at,OLD.actor_credential_id,NEW.updated_at,OLD.kind,OLD.provenance,OLD.event_time,OLD.supersedes_id WHERE NEW.erased_at IS NULL;
 INSERT INTO memory_audit_events(action,space_id,memory_id,revision,actor_credential_id,created_at)
 VALUES(CASE WHEN NEW.deleted_at IS NULL THEN 'memory_updated' ELSE 'memory_deleted' END,NEW.space_id,NEW.id,NEW.revision,NEW.actor_credential_id,NEW.updated_at);
END;
DROP TRIGGER memory_versions_no_delete;
CREATE TRIGGER memory_versions_no_delete BEFORE DELETE ON memory_versions WHEN NOT EXISTS(SELECT 1 FROM release_erasure_permits WHERE memory_id=OLD.memory_id)
 BEGIN SELECT RAISE(ABORT,'Memory history is append-only'); END;
CREATE TRIGGER release_supersession_guard BEFORE INSERT ON memories WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memories old WHERE old.id=NEW.supersedes_id AND old.space_id=NEW.space_id AND old.deleted_at IS NULL AND old.erased_at IS NULL)
 BEGIN SELECT RAISE(ABORT,'release_conflict'); END;

CREATE VIRTUAL TABLE release_fts USING fts5(memory_id UNINDEXED,space_id UNINDEXED,body,tokenize='unicode61');
INSERT INTO release_fts(memory_id,space_id,body) SELECT id,space_id,body FROM memories WHERE deleted_at IS NULL;
CREATE TRIGGER release_memory_index_insert AFTER INSERT ON memories BEGIN
 INSERT INTO release_fts(memory_id,space_id,body) SELECT NEW.id,NEW.space_id,NEW.body WHERE NEW.deleted_at IS NULL;
 INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at) VALUES(NEW.id||':'||NEW.revision,NEW.id,NEW.space_id,NEW.revision,'upsert',NEW.updated_at,NEW.updated_at);
END;
CREATE TRIGGER release_memory_index_update AFTER UPDATE ON memories BEGIN
 DELETE FROM release_fts WHERE memory_id=NEW.id;
 INSERT INTO release_fts(memory_id,space_id,body) SELECT NEW.id,NEW.space_id,NEW.body WHERE NEW.deleted_at IS NULL AND NEW.erased_at IS NULL;
 INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
 VALUES(NEW.id||':'||NEW.revision,NEW.id,NEW.space_id,NEW.revision,CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,NEW.updated_at,NEW.updated_at);
END;
-- Backfill search work; a deployment cannot silently omit pre-existing memories.
INSERT INTO release_jobs(id,memory_id,space_id,revision,kind,available_at,created_at)
 SELECT id||':'||revision,id,space_id,revision,CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,updated_at,updated_at FROM memories;

-- Storage includes live content AND retained revisions (UTF-8 bytes).
CREATE VIEW release_memory_sizes AS SELECT id,space_id,CASE WHEN erased_at IS NULL THEN length(CAST(body AS BLOB))+coalesce(length(CAST(source AS BLOB)),0)+length(CAST(provenance AS BLOB)) ELSE 0 END AS bytes FROM memories;
CREATE VIEW release_version_sizes AS SELECT memory_id,revision,space_id,length(CAST(body AS BLOB))+coalesce(length(CAST(source AS BLOB)),0)+length(CAST(provenance AS BLOB)) AS bytes FROM memory_versions;
UPDATE release_pools SET storage_bytes=coalesce((SELECT sum(x.bytes) FROM (SELECT space_id,bytes FROM release_memory_sizes UNION ALL SELECT space_id,bytes FROM release_version_sizes) x JOIN release_space_pools sp ON sp.space_id=x.space_id WHERE sp.pool_id=release_pools.id),0);
CREATE TRIGGER release_storage_guard_insert BEFORE INSERT ON memories BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM release_space_pools sp JOIN release_pools p ON p.id=sp.pool_id WHERE sp.space_id=NEW.space_id AND p.storage_bytes+length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB))>p.storage_limit_bytes) THEN RAISE(ABORT,'release_storage') END;
END;
CREATE TRIGGER release_storage_guard_update BEFORE UPDATE ON memories WHEN NEW.deleted_at IS NULL AND NEW.erased_at IS NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM release_space_pools sp JOIN release_pools p ON p.id=sp.pool_id WHERE sp.space_id=NEW.space_id AND p.storage_bytes+length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB))>p.storage_limit_bytes) THEN RAISE(ABORT,'release_storage') END;
END;
CREATE TRIGGER release_storage_insert AFTER INSERT ON memories BEGIN UPDATE release_pools SET storage_bytes=storage_bytes+length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB)) WHERE id=(SELECT pool_id FROM release_space_pools WHERE space_id=NEW.space_id); END;
CREATE TRIGGER release_storage_update AFTER UPDATE ON memories BEGIN UPDATE release_pools SET storage_bytes=storage_bytes-length(CAST(OLD.body AS BLOB))-coalesce(length(CAST(OLD.source AS BLOB)),0)-length(CAST(OLD.provenance AS BLOB))+ CASE WHEN NEW.erased_at IS NULL THEN length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB)) ELSE 0 END WHERE id=(SELECT pool_id FROM release_space_pools WHERE space_id=NEW.space_id); END;
CREATE TRIGGER release_storage_version_insert AFTER INSERT ON memory_versions BEGIN UPDATE release_pools SET storage_bytes=storage_bytes+length(CAST(NEW.body AS BLOB))+coalesce(length(CAST(NEW.source AS BLOB)),0)+length(CAST(NEW.provenance AS BLOB)) WHERE id=(SELECT pool_id FROM release_space_pools WHERE space_id=NEW.space_id); END;
CREATE TRIGGER release_storage_version_delete AFTER DELETE ON memory_versions BEGIN UPDATE release_pools SET storage_bytes=storage_bytes-length(CAST(OLD.body AS BLOB))-coalesce(length(CAST(OLD.source AS BLOB)),0)-length(CAST(OLD.provenance AS BLOB)) WHERE id=(SELECT pool_id FROM release_space_pools WHERE space_id=OLD.space_id); END;
CREATE TRIGGER release_operation_revision BEFORE INSERT ON release_operations
 WHEN NEW.action IN ('update','delete','restore','erase') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM memories r WHERE r.id=NEW.memory_id AND r.space_id=NEW.space_id AND r.revision=NEW.expected_revision AND r.erased_at IS NULL
 AND ((NEW.action IN ('update','delete') AND r.deleted_at IS NULL)
  OR (NEW.action IN ('restore','erase') AND r.deleted_at IS NOT NULL))
 AND (NEW.action<>'restore' OR r.deleted_at+coalesce((SELECT retention_days FROM release_space_policies WHERE space_id=r.space_id),30)*86400000>NEW.created_at))
 THEN RAISE(ABORT,'release_conflict') END;
END;
CREATE TABLE release_reauth_challenges(id TEXT PRIMARY KEY,credential_id TEXT NOT NULL REFERENCES credentials(id),email_id TEXT NOT NULL REFERENCES account_emails(id),token_digest TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
CREATE TABLE release_external_email_blocks(account_id TEXT REFERENCES accounts(id),address TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account_id,address));
CREATE TRIGGER release_external_claim_block BEFORE INSERT ON account_emails WHEN EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=NEW.account_id AND b.address=NEW.address) BEGIN SELECT RAISE(ABORT,'externally revoked email'); END;
ALTER TABLE release_domain_challenges ADD COLUMN verification_id TEXT;
CREATE TABLE release_mail_budget(account_id TEXT REFERENCES accounts(id),day TEXT,quantity INTEGER NOT NULL CHECK(quantity BETWEEN 0 AND 20),PRIMARY KEY(account_id,day));

ALTER TABLE release_ingests ADD COLUMN approval_hash TEXT;
ALTER TABLE release_ingests ADD COLUMN result_ids TEXT;
CREATE TABLE release_ingest_operations(operation_id TEXT PRIMARY KEY REFERENCES release_operations(id),ingest_id TEXT NOT NULL REFERENCES release_ingests(id));
CREATE TABLE release_ingest_approvals(operation_id TEXT PRIMARY KEY REFERENCES release_operations(id),ingest_id TEXT UNIQUE NOT NULL REFERENCES release_ingests(id),approval_hash TEXT NOT NULL,result_ids TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TRIGGER release_ingest_approval_guard BEFORE INSERT ON release_ingest_approvals
WHEN NOT EXISTS(SELECT 1 FROM release_ingests i JOIN release_operations o ON o.id=NEW.operation_id WHERE i.id=NEW.ingest_id AND i.account_id=o.account_id AND i.space_id=o.space_id AND i.state='review' AND i.expires_at>NEW.created_at)
BEGIN SELECT RAISE(ABORT,'release_conflict'); END;

ALTER TABLE release_checkout_requests ADD COLUMN operation_key TEXT;
ALTER TABLE release_checkout_requests ADD COLUMN session_id TEXT;
ALTER TABLE release_checkout_requests ADD COLUMN checkout_url TEXT;
ALTER TABLE release_checkout_requests ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX release_checkout_key ON release_checkout_requests(pool_id,operation_key);
CREATE TABLE release_billing_lock(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT,expires_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO release_billing_lock(id) VALUES(1);
ALTER TABLE release_billing_events ADD COLUMN last_error TEXT;
CREATE TABLE release_heartbeats(name TEXT PRIMARY KEY,last_success_at INTEGER NOT NULL);
-- Pre-release coarse OAuth policies must be replaced by the FIRST verified JWT
-- scope set, not silently inherit newly introduced export/delete capabilities.
ALTER TABLE release_credential_policies ADD COLUMN verified_oauth INTEGER NOT NULL DEFAULT 0 CHECK(verified_oauth IN (0,1));

-- Revocation can arrive before the first local mapping. Keep the issuer+subject
-- tombstone so a still-unexpired pre-revocation JWT cannot recreate authority.
CREATE TABLE release_provider_revocations (
 issuer TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('account.disabled','email.revoked')),
 address TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(issuer,subject,kind,address)
);
CREATE TRIGGER release_provider_signin_guard BEFORE INSERT ON workspace_sign_ins
WHEN EXISTS(SELECT 1 FROM release_provider_revocations p WHERE p.issuer=NEW.issuer AND p.subject=NEW.subject AND p.kind='account.disabled')
BEGIN SELECT RAISE(ABORT,'provider identity revoked'); END;
CREATE TRIGGER release_provider_email_guard BEFORE INSERT ON account_emails
WHEN EXISTS(SELECT 1 FROM release_provider_revocations b JOIN provider_identities p ON p.issuer=b.issuer AND p.subject=b.subject
 WHERE p.account_id=NEW.account_id AND b.kind='email.revoked' AND b.address=NEW.address)
BEGIN SELECT RAISE(ABORT,'provider email revoked'); END;
-- Append after release_provider_revocations and its guards in migration 0006.
-- Existing migrations 0001..0005 are untouched. The SCIM table is new and empty
-- in this not-yet-deployed sixth migration; validation forbids null new bindings.
ALTER TABLE release_scim_keys ADD COLUMN creator_membership_id TEXT REFERENCES memberships(id);
ALTER TABLE release_scim_keys ADD COLUMN creator_email_id TEXT REFERENCES account_emails(id);
ALTER TABLE release_scim_keys ADD COLUMN created_at INTEGER;
CREATE TRIGGER release_scim_key_validate BEFORE INSERT ON release_scim_keys
WHEN NEW.id IS NULL OR typeof(NEW.token_digest)<>'text' OR typeof(NEW.created_at)<>'integer' OR NEW.created_at<0
  OR typeof(NEW.expires_at)<>'integer' OR NEW.expires_at<=NEW.created_at OR NEW.expires_at>NEW.created_at+2592000000
  OR NEW.revoked_at IS NOT NULL OR length(NEW.token_digest)<>64 OR NEW.token_digest GLOB '*[^0-9a-f]*'
  OR NOT EXISTS(SELECT 1 FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id
    WHERE c.id=NEW.creator_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%'
      AND c.permission='write' AND c.expires_at>NEW.created_at
      AND c.reauthenticated_at BETWEEN NEW.created_at-300000 AND NEW.created_at
      AND m.id=NEW.creator_membership_id AND m.email_id=NEW.creator_email_id
      AND m.organization_id=NEW.organization_id AND m.expires_at>NEW.created_at AND m.role IN ('owner','admin'))
BEGIN SELECT RAISE(ABORT,'release_denied'); END;
CREATE TRIGGER release_scim_key_no_replace BEFORE INSERT ON release_scim_keys
WHEN EXISTS(SELECT 1 FROM release_scim_keys WHERE id=NEW.id OR token_digest=NEW.token_digest)
BEGIN SELECT RAISE(ABORT,'SCIM credential binding is immutable'); END;
CREATE TRIGGER release_scim_key_immutable BEFORE UPDATE ON release_scim_keys
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.token_digest IS NOT OLD.token_digest OR NEW.creator_credential_id IS NOT OLD.creator_credential_id
  OR NEW.creator_membership_id IS NOT OLD.creator_membership_id OR NEW.creator_email_id IS NOT OLD.creator_email_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'SCIM credential binding is immutable'); END;
CREATE TRIGGER release_scim_key_no_delete BEFORE DELETE ON release_scim_keys
BEGIN SELECT RAISE(ABORT,'SCIM credentials cannot be deleted'); END;
CREATE TRIGGER release_scim_membership_revoked AFTER UPDATE OF revoked_at ON memberships
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN
  UPDATE release_scim_keys SET revoked_at=NEW.revoked_at
    WHERE creator_membership_id=NEW.id AND creator_email_id=NEW.email_id AND revoked_at IS NULL;
END;

-- Keep the exact existing personal bootstrap, omitting any provider-blocked
-- claim. Direct claim insertion remains denied by the release claim guards.
DROP TRIGGER workspace_sign_in_apply;
CREATE TRIGGER workspace_sign_in_apply AFTER INSERT ON workspace_sign_ins BEGIN
  INSERT INTO accounts(id) SELECT NEW.new_account_id
    WHERE NOT EXISTS(SELECT 1 FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
  INSERT INTO provider_identities(issuer,subject,account_id,created_at)
    SELECT NEW.issuer,NEW.subject,NEW.new_account_id,NEW.created_at
    WHERE NOT EXISTS(SELECT 1 FROM provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
  INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission)
    SELECT NEW.credential_id,p.account_id,'session',NEW.token_digest,NEW.expires_at,NULL,NEW.permission
    FROM provider_identities p WHERE p.issuer=NEW.issuer AND p.subject=NEW.subject
      AND NOT EXISTS(SELECT 1 FROM credentials WHERE token_digest=NEW.token_digest);
  INSERT INTO account_emails(id,account_id,address,domain,verified_at)
    SELECT NEW.email_id,p.account_id,NEW.address,NEW.domain,NEW.created_at
    FROM provider_identities p WHERE p.issuer=NEW.issuer AND p.subject=NEW.subject AND NEW.address IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM account_emails e WHERE e.address=NEW.address AND e.revoked_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=NEW.address)
      AND NOT EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=p.account_id AND b.address=NEW.address)
      AND NOT EXISTS(SELECT 1 FROM release_provider_revocations b
        JOIN provider_identities mapped ON mapped.issuer=b.issuer AND mapped.subject=b.subject
        WHERE mapped.account_id=p.account_id AND b.kind='email.revoked' AND b.address=NEW.address);
  INSERT INTO spaces(id,name,account_id,security_mode,created_at,actor_credential_id)
    SELECT NEW.personal_space_id,'Personal',c.account_id,'managed',NEW.created_at,c.id
    FROM credentials c WHERE c.token_digest=NEW.token_digest
      AND NOT EXISTS(SELECT 1 FROM spaces s WHERE s.account_id=c.account_id);
  INSERT INTO workspace_audit_events(action,actor_credential_id,account_id,created_at)
    SELECT 'signed_in',c.id,c.account_id,NEW.created_at FROM credentials c WHERE c.token_digest=NEW.token_digest;
END;
-- Add to the not-yet-deployed sixth migration after the existing release tables.
-- Sharing is a durable account/membership grant; the browser credential records
-- the original account but its ordinary expiry/logout does not revoke the share.
ALTER TABLE release_shares ADD COLUMN creator_membership_id TEXT REFERENCES memberships(id);
ALTER TABLE release_shares ADD COLUMN creator_email_id TEXT REFERENCES account_emails(id);
CREATE TRIGGER release_share_validate BEFORE INSERT ON release_shares
WHEN NEW.id IS NULL OR typeof(NEW.created_at)<>'integer' OR NEW.created_at<0
  OR typeof(NEW.expires_at)<>'integer' OR NEW.expires_at<=NEW.created_at OR NEW.expires_at>NEW.created_at+2592000000
  OR NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM account_emails e JOIN accounts recipient ON recipient.id=e.account_id
    WHERE e.id=NEW.recipient_email_id AND e.revoked_at IS NULL AND recipient.disabled_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM active_credentials c JOIN spaces s ON s.id=NEW.space_id
    WHERE c.id=NEW.creator_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%'
      AND c.permission='write' AND c.expires_at>NEW.created_at
      AND c.reauthenticated_at BETWEEN NEW.created_at-300000 AND NEW.created_at
      AND ((s.account_id=c.account_id AND s.organization_id IS NULL AND NEW.creator_membership_id IS NULL AND NEW.creator_email_id IS NULL)
        OR (s.organization_id IS NOT NULL AND EXISTS(SELECT 1 FROM active_memberships m
          WHERE m.id=NEW.creator_membership_id AND m.account_id=c.account_id AND m.email_id=NEW.creator_email_id
            AND m.organization_id=s.organization_id AND m.expires_at>NEW.created_at AND m.role IN ('owner','admin')))))
BEGIN SELECT RAISE(ABORT,'release_denied'); END;
CREATE TRIGGER release_share_no_replace BEFORE INSERT ON release_shares
WHEN EXISTS(SELECT 1 FROM release_shares WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Share binding is immutable'); END;
CREATE TRIGGER release_share_immutable BEFORE UPDATE ON release_shares
WHEN NEW.id IS NOT OLD.id OR NEW.space_id IS NOT OLD.space_id OR NEW.recipient_email_id IS NOT OLD.recipient_email_id
  OR NEW.creator_credential_id IS NOT OLD.creator_credential_id OR NEW.creator_membership_id IS NOT OLD.creator_membership_id
  OR NEW.creator_email_id IS NOT OLD.creator_email_id OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'Share binding is immutable'); END;
CREATE TRIGGER release_share_no_delete BEFORE DELETE ON release_shares
BEGIN SELECT RAISE(ABORT,'Shares cannot be deleted'); END;
CREATE TRIGGER release_share_membership_revoked AFTER UPDATE OF revoked_at ON memberships
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN
  UPDATE release_shares SET revoked_at=NEW.revoked_at
    WHERE creator_membership_id=NEW.id AND creator_email_id=NEW.email_id AND revoked_at IS NULL;
END;

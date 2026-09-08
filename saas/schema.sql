-- SQLite / Cloudflare D1 identity authority. Timestamps are Unix milliseconds.
-- Foreign keys must remain enabled. Application writes use bound parameters.
-- Views are clock-independent: check expires_at AND membership_expires_at
-- against the request clock. Membership consumers also check m.expires_at.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  disabled_at INTEGER CHECK (disabled_at IS NULL OR disabled_at >= 0)
);
CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  disabled_at INTEGER CHECK (disabled_at IS NULL OR disabled_at >= 0)
);
CREATE TABLE account_emails (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  address TEXT NOT NULL CHECK (address=lower(trim(address)) AND length(address) BETWEEN 3 AND 254),
  domain TEXT NOT NULL CHECK (domain=lower(domain) AND instr(domain,'.')>1 AND address LIKE '%@'||domain
    AND instr(address,'@')=length(address)-length(domain)),
  verified_at INTEGER NOT NULL CHECK (verified_at>=0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at>=0),
  UNIQUE(id,account_id)
);
CREATE UNIQUE INDEX one_live_email_claim ON account_emails(address) WHERE revoked_at IS NULL;
CREATE INDEX account_email_claims ON account_emails(account_id);
CREATE TABLE memberships (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  expires_at INTEGER NOT NULL DEFAULT 9007199254740991 CHECK (expires_at>=0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at>=0),
  FOREIGN KEY (email_id,account_id) REFERENCES account_emails(id,account_id),
  UNIQUE(id,account_id,email_id)
);
CREATE UNIQUE INDEX one_live_membership ON memberships(organization_id,account_id) WHERE revoked_at IS NULL;
CREATE INDEX memberships_email ON memberships(email_id);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  membership_id TEXT,
  email_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('session','personal_key','api_key')),
  token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest)=64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL CHECK (expires_at>=0),
  reauthenticated_at INTEGER CHECK (reauthenticated_at IS NULL OR reauthenticated_at>=0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at>=0),
  permission TEXT NOT NULL DEFAULT 'write' CHECK (permission IN ('read','write')),
  FOREIGN KEY (membership_id,account_id,email_id) REFERENCES memberships(id,account_id,email_id),
  CHECK ((kind IN ('session','personal_key') AND membership_id IS NULL AND email_id IS NULL)
    OR (kind='api_key' AND membership_id IS NOT NULL AND email_id IS NOT NULL))
);
CREATE INDEX credentials_membership ON credentials(membership_id);
CREATE INDEX credentials_email ON credentials(email_id);
CREATE TABLE domains (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK (name=lower(trim(name)) AND instr(name,'.')>1),
  verified_until INTEGER NOT NULL CHECK (verified_until>=0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at>=0)
);
CREATE UNIQUE INDEX one_live_domain_owner ON domains(name) WHERE revoked_at IS NULL;
CREATE TABLE domain_managers (
  domain_id TEXT NOT NULL REFERENCES domains(id),
  membership_id TEXT NOT NULL REFERENCES memberships(id),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at>=0),
  PRIMARY KEY(domain_id,membership_id)
);
CREATE TABLE email_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  address TEXT NOT NULL CHECK (address=lower(trim(address))),
  domain TEXT NOT NULL CHECK (address LIKE '%@'||domain AND instr(address,'@')=length(address)-length(domain)),
  token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest)=64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL CHECK (expires_at>=0),
  used_at INTEGER CHECK (used_at IS NULL OR used_at>=0),
  invalidated_at INTEGER CHECK (invalidated_at IS NULL OR invalidated_at>=0)
);
CREATE INDEX challenges_address ON email_challenges(address);
CREATE TABLE email_consumptions (
  id TEXT PRIMARY KEY NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES email_challenges(id),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  created_at INTEGER NOT NULL CHECK (created_at>=0)
);
CREATE TABLE revocations (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('self','domain')),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  email_id TEXT REFERENCES account_emails(id),
  domain_id TEXT REFERENCES domains(id),
  address TEXT,
  created_at INTEGER NOT NULL CHECK (created_at>=0),
  CHECK ((kind='self' AND email_id IS NOT NULL AND domain_id IS NULL AND address IS NULL)
    OR (kind='domain' AND email_id IS NULL AND domain_id IS NOT NULL AND address IS NOT NULL))
);
CREATE TABLE email_blocks (
  address TEXT PRIMARY KEY NOT NULL CHECK (address=lower(trim(address))),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  revocation_id TEXT NOT NULL REFERENCES revocations(id),
  created_at INTEGER NOT NULL CHECK (created_at>=0)
);
-- No free-text/address/payload columns: audit contains identifiers only.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN
    ('email_verified','email_revoked','membership_revoked','credential_revoked','self_revocation','domain_revocation')),
  actor_credential_id TEXT REFERENCES credentials(id),
  account_id TEXT REFERENCES accounts(id),
  email_id TEXT REFERENCES account_emails(id),
  organization_id TEXT REFERENCES organizations(id),
  membership_id TEXT REFERENCES memberships(id),
  credential_id TEXT REFERENCES credentials(id),
  domain_id TEXT REFERENCES domains(id),
  revocation_id TEXT REFERENCES revocations(id),
  created_at INTEGER NOT NULL CHECK (created_at>=0)
);

CREATE VIEW active_memberships AS
  SELECT m.* FROM memberships m
  JOIN accounts a ON a.id=m.account_id AND a.disabled_at IS NULL
  JOIN organizations o ON o.id=m.organization_id AND o.disabled_at IS NULL
  JOIN account_emails e ON e.id=m.email_id AND e.account_id=m.account_id AND e.revoked_at IS NULL
  WHERE m.revoked_at IS NULL;
CREATE VIEW active_credentials AS
  SELECT c.*,coalesce(m.expires_at,9007199254740991) AS membership_expires_at
  FROM credentials c JOIN accounts a ON a.id=c.account_id AND a.disabled_at IS NULL
  LEFT JOIN active_memberships m ON m.id=c.membership_id AND m.account_id=c.account_id AND m.email_id=c.email_id
  WHERE c.revoked_at IS NULL AND (c.kind IN ('session','personal_key') OR m.id IS NOT NULL);

-- SQLite REPLACE can bypass DELETE triggers when recursive_triggers is off.
-- Check collisions before insertion, including alternate unique keys, so
-- REPLACE cannot erase history or reuse authority IDs in either configuration.
CREATE TRIGGER accounts_no_replace BEFORE INSERT ON accounts
WHEN EXISTS(SELECT 1 FROM accounts WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'account ID already exists'); END;
CREATE TRIGGER organizations_no_replace BEFORE INSERT ON organizations
WHEN EXISTS(SELECT 1 FROM organizations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'organization ID already exists'); END;
CREATE TRIGGER claims_no_replace BEFORE INSERT ON account_emails
WHEN EXISTS(SELECT 1 FROM account_emails WHERE id=NEW.id
  OR (address=NEW.address AND revoked_at IS NULL AND NEW.revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'email claim already exists'); END;
CREATE TRIGGER memberships_no_replace BEFORE INSERT ON memberships
WHEN EXISTS(SELECT 1 FROM memberships WHERE id=NEW.id OR
  (organization_id=NEW.organization_id AND account_id=NEW.account_id AND revoked_at IS NULL AND NEW.revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'membership already exists'); END;
CREATE TRIGGER credentials_no_replace BEFORE INSERT ON credentials
WHEN EXISTS(SELECT 1 FROM credentials WHERE id=NEW.id OR token_digest=NEW.token_digest)
BEGIN SELECT RAISE(ABORT,'credential already exists'); END;
CREATE TRIGGER domains_no_replace BEFORE INSERT ON domains
WHEN EXISTS(SELECT 1 FROM domains WHERE id=NEW.id OR (name=NEW.name AND revoked_at IS NULL AND NEW.revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'domain already exists'); END;
CREATE TRIGGER managers_no_replace BEFORE INSERT ON domain_managers
WHEN EXISTS(SELECT 1 FROM domain_managers WHERE domain_id=NEW.domain_id AND membership_id=NEW.membership_id)
BEGIN SELECT RAISE(ABORT,'delegation already exists'); END;
CREATE TRIGGER challenges_no_replace BEFORE INSERT ON email_challenges
WHEN EXISTS(SELECT 1 FROM email_challenges WHERE id=NEW.id OR token_digest=NEW.token_digest)
BEGIN SELECT RAISE(ABORT,'challenge already exists'); END;
CREATE TRIGGER consumptions_no_replace BEFORE INSERT ON email_consumptions
WHEN EXISTS(SELECT 1 FROM email_consumptions WHERE id=NEW.id OR challenge_id=NEW.challenge_id)
BEGIN SELECT RAISE(ABORT,'consumption already exists'); END;
CREATE TRIGGER revocations_no_replace BEFORE INSERT ON revocations
WHEN EXISTS(SELECT 1 FROM revocations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'revocation already exists'); END;
CREATE TRIGGER blocks_no_replace BEFORE INSERT ON email_blocks
WHEN EXISTS(SELECT 1 FROM email_blocks WHERE address=NEW.address)
BEGIN SELECT RAISE(ABORT,'email block already exists'); END;
CREATE TRIGGER audit_no_replace BEFORE INSERT ON audit_events
WHEN EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'audit event already exists'); END;

-- Stable identifiers and claim relationships are never reassigned. Revocation
-- and disablement are terminal; recovery issues new claims and credentials.
CREATE TRIGGER accounts_immutable BEFORE UPDATE ON accounts
WHEN NEW.id IS NOT OLD.id OR (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NOT OLD.disabled_at)
BEGIN SELECT RAISE(ABORT,'immutable account'); END;
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts
BEGIN SELECT RAISE(ABORT,'accounts cannot be deleted'); END;
CREATE TRIGGER organizations_immutable BEFORE UPDATE ON organizations
WHEN NEW.id IS NOT OLD.id OR (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NOT OLD.disabled_at)
BEGIN SELECT RAISE(ABORT,'immutable organization'); END;
CREATE TRIGGER organizations_no_delete BEFORE DELETE ON organizations
BEGIN SELECT RAISE(ABORT,'organizations cannot be deleted'); END;
CREATE TRIGGER claims_immutable BEFORE UPDATE ON account_emails
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.address IS NOT OLD.address
  OR NEW.domain IS NOT OLD.domain OR NEW.verified_at IS NOT OLD.verified_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'immutable email claim'); END;
CREATE TRIGGER claims_no_delete BEFORE DELETE ON account_emails
BEGIN SELECT RAISE(ABORT,'email claims cannot be deleted'); END;
CREATE TRIGGER claims_not_blocked BEFORE INSERT ON account_emails
WHEN EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=NEW.address)
  OR NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.disabled_at IS NULL)
BEGIN SELECT RAISE(ABORT,'email claim denied'); END;
CREATE TRIGGER memberships_immutable BEFORE UPDATE ON memberships
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.account_id IS NOT OLD.account_id OR NEW.email_id IS NOT OLD.email_id
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'immutable membership binding'); END;
CREATE TRIGGER memberships_no_delete BEFORE DELETE ON memberships
BEGIN SELECT RAISE(ABORT,'memberships cannot be deleted'); END;
CREATE TRIGGER memberships_live_claim BEFORE INSERT ON memberships
WHEN NOT EXISTS(SELECT 1 FROM account_emails e JOIN accounts a ON a.id=e.account_id
  JOIN organizations o ON o.id=NEW.organization_id
  WHERE e.id=NEW.email_id AND e.account_id=NEW.account_id AND e.revoked_at IS NULL
  AND a.disabled_at IS NULL AND o.disabled_at IS NULL)
BEGIN SELECT RAISE(ABORT,'inactive membership claim'); END;
CREATE TRIGGER credentials_immutable BEFORE UPDATE ON credentials
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.membership_id IS NOT OLD.membership_id
  OR NEW.email_id IS NOT OLD.email_id OR NEW.kind IS NOT OLD.kind OR NEW.token_digest IS NOT OLD.token_digest
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'immutable credential binding'); END;
CREATE TRIGGER credentials_no_delete BEFORE DELETE ON credentials
BEGIN SELECT RAISE(ABORT,'credentials cannot be deleted'); END;
CREATE TRIGGER credentials_live_binding BEFORE INSERT ON credentials
WHEN NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND disabled_at IS NULL)
  OR (NEW.membership_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM active_memberships m
    WHERE m.id=NEW.membership_id AND m.account_id=NEW.account_id AND m.email_id=NEW.email_id))
BEGIN SELECT RAISE(ABORT,'inactive credential binding'); END;
CREATE TRIGGER domains_immutable BEFORE UPDATE ON domains
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.name IS NOT OLD.name
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'immutable domain binding'); END;
CREATE TRIGGER domains_no_delete BEFORE DELETE ON domains
BEGIN SELECT RAISE(ABORT,'domains cannot be deleted'); END;
CREATE TRIGGER domain_managers_binding BEFORE INSERT ON domain_managers
WHEN NOT EXISTS(SELECT 1 FROM domains d JOIN active_memberships m ON m.organization_id=d.organization_id
  WHERE d.id=NEW.domain_id AND m.id=NEW.membership_id AND m.role IN ('owner','admin') AND d.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'invalid domain delegation'); END;
CREATE TRIGGER domain_managers_immutable BEFORE UPDATE ON domain_managers
WHEN NEW.domain_id IS NOT OLD.domain_id OR NEW.membership_id IS NOT OLD.membership_id
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'immutable domain delegation'); END;
CREATE TRIGGER domain_managers_no_delete BEFORE DELETE ON domain_managers
BEGIN SELECT RAISE(ABORT,'delegations cannot be deleted'); END;
CREATE TRIGGER challenges_immutable BEFORE UPDATE ON email_challenges
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.address IS NOT OLD.address
  OR NEW.domain IS NOT OLD.domain OR NEW.token_digest IS NOT OLD.token_digest OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.used_at IS NOT NULL AND NEW.used_at IS NOT OLD.used_at)
  OR (OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS NOT OLD.invalidated_at)
BEGIN SELECT RAISE(ABORT,'immutable email challenge'); END;
CREATE TRIGGER challenges_not_blocked BEFORE INSERT ON email_challenges
WHEN EXISTS(SELECT 1 FROM email_blocks WHERE address=NEW.address)
BEGIN SELECT RAISE(ABORT,'email address blocked'); END;
CREATE TRIGGER challenges_no_delete BEFORE DELETE ON email_challenges
BEGIN SELECT RAISE(ABORT,'challenges cannot be deleted'); END;
CREATE TRIGGER consumptions_no_update BEFORE UPDATE ON email_consumptions
BEGIN SELECT RAISE(ABORT,'consumptions are append-only'); END;
CREATE TRIGGER consumptions_no_delete BEFORE DELETE ON email_consumptions
BEGIN SELECT RAISE(ABORT,'consumptions are append-only'); END;
CREATE TRIGGER revocations_no_update BEFORE UPDATE ON revocations
BEGIN SELECT RAISE(ABORT,'revocations are append-only'); END;
CREATE TRIGGER revocations_no_delete BEFORE DELETE ON revocations
BEGIN SELECT RAISE(ABORT,'revocations are append-only'); END;
CREATE TRIGGER blocks_no_update BEFORE UPDATE ON email_blocks
BEGIN SELECT RAISE(ABORT,'email blocks are permanent'); END;
CREATE TRIGGER blocks_no_delete BEFORE DELETE ON email_blocks
BEGIN SELECT RAISE(ABORT,'email blocks are permanent'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;

-- Every consumption creates a new claim ID in the same SQL statement.
CREATE TRIGGER consume_email_validate BEFORE INSERT ON email_consumptions
WHEN NOT EXISTS(SELECT 1 FROM email_challenges p JOIN active_credentials c ON c.account_id=p.account_id
  WHERE p.id=NEW.challenge_id AND c.id=NEW.actor_credential_id AND c.kind='session'
    AND c.membership_id IS NULL AND c.expires_at>NEW.created_at
    AND c.reauthenticated_at BETWEEN NEW.created_at-300000 AND NEW.created_at
    AND p.expires_at>NEW.created_at AND p.used_at IS NULL AND p.invalidated_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=p.address))
BEGIN SELECT RAISE(ABORT,'email consumption denied'); END;
CREATE TRIGGER consume_email AFTER INSERT ON email_consumptions
BEGIN
  INSERT INTO account_emails(id,account_id,address,domain,verified_at)
    SELECT NEW.id,account_id,address,domain,NEW.created_at FROM email_challenges WHERE id=NEW.challenge_id;
  UPDATE email_challenges SET used_at=NEW.created_at WHERE id=NEW.challenge_id;
  INSERT INTO audit_events(id,event_type,actor_credential_id,account_id,email_id,created_at)
    SELECT lower(hex(randomblob(16))),'email_verified',NEW.actor_credential_id,account_id,NEW.id,NEW.created_at
    FROM email_challenges WHERE id=NEW.challenge_id;
END;

CREATE TRIGGER self_revocation_validate BEFORE INSERT ON revocations WHEN NEW.kind='self'
  AND NOT EXISTS(SELECT 1 FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id
    WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.membership_id IS NULL
    AND c.expires_at>NEW.created_at AND c.reauthenticated_at BETWEEN NEW.created_at-300000 AND NEW.created_at
    AND e.id=NEW.email_id AND e.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'self revocation denied'); END;
CREATE TRIGGER domain_revocation_validate BEFORE INSERT ON revocations WHEN NEW.kind='domain'
  AND NOT EXISTS(SELECT 1 FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id
    JOIN domain_managers g ON g.membership_id=m.id AND g.revoked_at IS NULL
    JOIN domains d ON d.id=g.domain_id AND d.organization_id=m.organization_id
    WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.membership_id IS NULL
    AND c.expires_at>NEW.created_at AND c.reauthenticated_at BETWEEN NEW.created_at-300000 AND NEW.created_at
    AND m.expires_at>NEW.created_at AND m.role IN ('owner','admin')
    AND d.id=NEW.domain_id AND d.verified_until>NEW.created_at AND d.revoked_at IS NULL
    AND NEW.address=lower(trim(NEW.address))
    AND substr(NEW.address,instr(NEW.address,'@')+1)=d.name)
BEGIN SELECT RAISE(ABORT,'domain revocation denied'); END;
CREATE TRIGGER apply_revocation AFTER INSERT ON revocations
BEGIN
  INSERT INTO email_blocks(address,domain_id,revocation_id,created_at)
    SELECT NEW.address,NEW.domain_id,NEW.id,NEW.created_at WHERE NEW.kind='domain'
    AND NOT EXISTS(SELECT 1 FROM email_blocks WHERE address=NEW.address);
  UPDATE email_challenges SET invalidated_at=NEW.created_at
    WHERE used_at IS NULL AND invalidated_at IS NULL
    AND ((NEW.kind='domain' AND address=NEW.address)
      OR (NEW.kind='self' AND EXISTS(SELECT 1 FROM account_emails e
        WHERE e.id=NEW.email_id AND e.address=email_challenges.address AND e.account_id=email_challenges.account_id)));
  UPDATE account_emails SET revoked_at=NEW.created_at WHERE revoked_at IS NULL
    AND ((NEW.kind='self' AND id=NEW.email_id) OR (NEW.kind='domain' AND address=NEW.address));
  INSERT INTO audit_events(id,event_type,actor_credential_id,email_id,domain_id,revocation_id,created_at)
    VALUES(lower(hex(randomblob(16))),NEW.kind||'_revocation',NEW.actor_credential_id,NEW.email_id,NEW.domain_id,NEW.id,NEW.created_at);
END;
CREATE TRIGGER cascade_email_revocation AFTER UPDATE OF revoked_at ON account_emails
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE memberships SET revoked_at=NEW.revoked_at WHERE email_id=NEW.id AND revoked_at IS NULL;
  UPDATE credentials SET revoked_at=NEW.revoked_at WHERE email_id=NEW.id AND revoked_at IS NULL;
  UPDATE email_challenges SET invalidated_at=NEW.revoked_at
    WHERE account_id=NEW.account_id AND address=NEW.address AND used_at IS NULL AND invalidated_at IS NULL;
  INSERT INTO audit_events(id,event_type,account_id,email_id,created_at)
    VALUES(lower(hex(randomblob(16))),'email_revoked',NEW.account_id,NEW.id,NEW.revoked_at);
END;
CREATE TRIGGER cascade_membership_revocation AFTER UPDATE OF revoked_at ON memberships
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE credentials SET revoked_at=NEW.revoked_at WHERE membership_id=NEW.id AND revoked_at IS NULL;
  UPDATE domain_managers SET revoked_at=NEW.revoked_at WHERE membership_id=NEW.id AND revoked_at IS NULL;
  INSERT INTO audit_events(id,event_type,account_id,email_id,organization_id,membership_id,created_at)
    VALUES(lower(hex(randomblob(16))),'membership_revoked',NEW.account_id,NEW.email_id,NEW.organization_id,NEW.id,NEW.revoked_at);
END;
CREATE TRIGGER audit_credential_revocation AFTER UPDATE OF revoked_at ON credentials
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO audit_events(id,event_type,account_id,email_id,membership_id,credential_id,created_at)
    VALUES(lower(hex(randomblob(16))),'credential_revoked',NEW.account_id,NEW.email_id,NEW.membership_id,NEW.id,NEW.revoked_at);
END;

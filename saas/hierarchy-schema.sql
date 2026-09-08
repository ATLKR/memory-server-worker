-- Forward-only addition after the four deployed SaaS schemas. A hierarchy
-- edge describes organization structure only; it never grants authority.
PRAGMA foreign_keys = ON;

CREATE TABLE workspace_child_organization_creations (
  id TEXT PRIMARY KEY NOT NULL,
  parent_organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK(instr(name,char(0))=0 AND length(name) BETWEEN 1 AND 100 AND length(trim(name))>0),
  actor_credential_id TEXT NOT NULL REFERENCES credentials(id),
  email_id TEXT NOT NULL REFERENCES account_emails(id),
  membership_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  CHECK(id<>parent_organization_id)
);
CREATE TABLE organization_hierarchy (
  organization_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id),
  parent_organization_id TEXT NOT NULL REFERENCES organizations(id),
  CHECK(organization_id<>parent_organization_id)
);
CREATE INDEX organization_hierarchy_parent ON organization_hierarchy(parent_organization_id);

-- Both the caller's current parent membership and their selected live email
-- are checked in this mutating statement. The selected child-owner email may
-- differ from the claim supporting their independent parent membership.
CREATE TRIGGER workspace_child_org_validate BEFORE INSERT ON workspace_child_organization_creations
WHEN EXISTS(SELECT 1 FROM organizations WHERE id=NEW.id)
  OR NOT EXISTS(SELECT 1 FROM active_credentials c
    JOIN active_memberships m ON m.account_id=c.account_id
    JOIN account_emails e ON e.account_id=c.account_id
    WHERE c.id=NEW.actor_credential_id AND c.kind='session' AND c.id NOT LIKE 'oauth:%'
      AND c.expires_at>NEW.created_at AND m.organization_id=NEW.parent_organization_id
      AND m.expires_at>NEW.created_at AND m.role IN ('owner','admin')
      AND e.id=NEW.email_id AND e.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;
CREATE TRIGGER workspace_child_org_apply AFTER INSERT ON workspace_child_organization_creations BEGIN
  INSERT INTO workspace_organization_creations(id,name,actor_credential_id,email_id,membership_id,space_id,created_at)
    VALUES(NEW.id,NEW.name,NEW.actor_credential_id,NEW.email_id,NEW.membership_id,NEW.space_id,NEW.created_at);
  INSERT INTO organization_hierarchy(organization_id,parent_organization_id)
    VALUES(NEW.id,NEW.parent_organization_id);
END;

-- Only the original child-creation command may establish an edge. An existing
-- root cannot be attached later. The ancestor walk has no product depth cap;
-- UNION also terminates safely if a malformed ancestor cycle ever exists.
CREATE TRIGGER organization_hierarchy_validate BEFORE INSERT ON organization_hierarchy
WHEN NOT EXISTS(SELECT 1 FROM workspace_child_organization_creations command
    WHERE command.id=NEW.organization_id AND command.parent_organization_id=NEW.parent_organization_id)
  OR EXISTS(WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.parent_organization_id
    UNION
    SELECT h.parent_organization_id FROM organization_hierarchy h JOIN ancestors a ON h.organization_id=a.id
  ) SELECT 1 FROM ancestors WHERE id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT,'workspace operation denied'); END;

-- Explicit INSERT collision guards also protect against REPLACE when SQLite
-- recursive_triggers is off. Relationships and commands cannot be rewritten.
CREATE TRIGGER organization_hierarchy_no_replace BEFORE INSERT ON organization_hierarchy
WHEN EXISTS(SELECT 1 FROM organization_hierarchy WHERE organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT,'hierarchy is immutable'); END;
CREATE TRIGGER organization_hierarchy_no_update BEFORE UPDATE ON organization_hierarchy
BEGIN SELECT RAISE(ABORT,'hierarchy is immutable'); END;
CREATE TRIGGER organization_hierarchy_no_delete BEFORE DELETE ON organization_hierarchy
BEGIN SELECT RAISE(ABORT,'hierarchy is immutable'); END;
CREATE TRIGGER workspace_child_org_no_replace BEFORE INSERT ON workspace_child_organization_creations
WHEN EXISTS(SELECT 1 FROM workspace_child_organization_creations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'command is append-only'); END;
CREATE TRIGGER workspace_child_org_no_update BEFORE UPDATE ON workspace_child_organization_creations
BEGIN SELECT RAISE(ABORT,'command is append-only'); END;
CREATE TRIGGER workspace_child_org_no_delete BEFORE DELETE ON workspace_child_organization_creations
BEGIN SELECT RAISE(ABORT,'command is append-only'); END;

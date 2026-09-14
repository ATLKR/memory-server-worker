-- INACTIVE LOCAL FOUNDATION. Explicit disposable schema5 + head-fence loading.
-- Requires existing SET memory_owner authority. No roles, seeds or migration marker.
BEGIN;
SET LOCAL ROLE memory_owner;

-- Private setup values are local JSONB evidence, never canonical transport bytes.
CREATE FUNCTION memory_identity.projection_v3_setup_valid(p jsonb,t text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $valid$
DECLARE keys text[]; types text[]; item jsonb; value text; previous text; local_part text; domain_part text; label text;
  n numeric; i integer; units integer;
  js_space constant text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p IS NULL OR t IS NULL THEN RETURN false; END IF;
  IF pg_catalog.left(t,9)='nullable:' THEN
    RETURN p='null'::jsonb OR memory_identity.projection_v3_setup_valid(p,pg_catalog.substr(t,10));
  END IF;
  IF t='null' THEN RETURN p='null'::jsonb; END IF;
  IF t='bool' THEN RETURN pg_catalog.jsonb_typeof(p)='boolean'; END IF;
  IF t IN('epoch','source_limit','message_limit') THEN
    IF pg_catalog.jsonb_typeof(p)<>'number' THEN RETURN false; END IF;
    n:=(p#>>'{}')::numeric;
    RETURN n=pg_catalog.trunc(n) AND n BETWEEN CASE WHEN t='message_limit' THEN 1 ELSE 0 END
      AND CASE t WHEN 'source_limit' THEN 67108864 WHEN 'message_limit' THEN 100000 ELSE 9007199254740991 END;
  END IF;
  IF t IN('id','space_id','digest','issuer','subject','address','domain','role','permission','kind') THEN
    IF pg_catalog.jsonb_typeof(p)<>'string' THEN RETURN false; END IF;
    value:=p#>>'{}';
    CASE t
    WHEN 'id' THEN RETURN value COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$';
    WHEN 'space_id' THEN RETURN value COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
    WHEN 'digest' THEN RETURN value COLLATE "C" ~ '^[0-9a-f]{64}$';
    WHEN 'issuer' THEN RETURN value='https://auth-api.allen.company';
    WHEN 'role' THEN RETURN value IN('owner','admin','member');
    WHEN 'permission' THEN RETURN value IN('read','write');
    WHEN 'kind' THEN RETURN value IN('personal_key','api_key');
    WHEN 'subject' THEN
      units:=pg_catalog.length(value);
      IF units>512 OR pg_catalog.btrim(value,js_space)='' THEN RETURN false; END IF;
      FOR i IN 1..pg_catalog.length(value) LOOP
        IF pg_catalog.ascii(pg_catalog.substr(value,i,1))>65535 THEN units:=units+1; END IF;
      END LOOP;
      RETURN units<=512;
    WHEN 'domain' THEN
      IF pg_catalog.length(value)>253 OR pg_catalog.strpos(value,'.')=0 THEN RETURN false; END IF;
      FOREACH label IN ARRAY pg_catalog.string_to_array(value,'.') LOOP
        IF label COLLATE "C" !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    WHEN 'address' THEN
      IF pg_catalog.length(value) NOT BETWEEN 3 AND 254 OR value COLLATE "C" !~ '^[^@]+@[^@]+$' THEN RETURN false; END IF;
      local_part:=pg_catalog.split_part(value,'@',1);domain_part:=pg_catalog.split_part(value,'@',2);
      RETURN pg_catalog.length(local_part)<=64 AND local_part COLLATE "C" ~ $mail$^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$$mail$
        AND pg_catalog.left(local_part,1)<>'.' AND pg_catalog.right(local_part,1)<>'.' AND pg_catalog.strpos(local_part,'..')=0
        AND memory_identity.projection_v3_setup_valid(pg_catalog.to_jsonb(domain_part),'domain');
    END CASE;
  END IF;
  IF pg_catalog.jsonb_typeof(p)<>'object' OR pg_catalog.octet_length(p::text)>131072 THEN RETURN false; END IF;
  IF t='policy' THEN
    keys:=ARRAY['policyVersion','residency','profile','processingBoundary','dataClass','classificationStatus','sensitivityTags','placementEpoch'];
    IF NOT(p ?& keys) OR p-keys<>'{}'::jsonb OR p->'policyVersion'<>'1'::jsonb OR p->'placementEpoch'<>'1'::jsonb
      OR p->'residency'<>'"kr-seoul"'::jsonb OR p->'profile'<>'"kr-primary-storage"'::jsonb
      OR p->'processingBoundary'<>'"approved-processors"'::jsonb OR p->'dataClass'<>'"personal"'::jsonb
      OR p->'classificationStatus'<>'"declared"'::jsonb OR pg_catalog.jsonb_typeof(p->'sensitivityTags')<>'array' THEN RETURN false; END IF;
    IF pg_catalog.jsonb_array_length(p->'sensitivityTags')>4 THEN RETURN false; END IF;
    FOR item IN SELECT x FROM pg_catalog.jsonb_array_elements(p->'sensitivityTags') x LOOP
      IF pg_catalog.jsonb_typeof(item)<>'string' THEN RETURN false; END IF;
      value:=item#>>'{}';
      IF value NOT IN('clinical-origin','credential','government-id','health')
        OR(previous IS NOT NULL AND value COLLATE "C"<=previous COLLATE "C") THEN RETURN false; END IF;
      previous:=value;
    END LOOP;
    RETURN NOT(p->'sensitivityTags' ? 'clinical-origin') OR p->'sensitivityTags' ? 'health';
  END IF;
  CASE t
  WHEN 'account','organization' THEN keys:=ARRAY['id','disabled_at'];types:=ARRAY['id','null'];
  WHEN 'provider_identity' THEN keys:=ARRAY['issuer','subject','account_id','created_at'];types:=ARRAY['issuer','subject','id','epoch'];
  WHEN 'email' THEN keys:=ARRAY['id','account_id','address','domain','verified_at','revoked_at'];types:=ARRAY['id','id','address','domain','epoch','null'];
  WHEN 'membership' THEN keys:=ARRAY['id','organization_id','account_id','email_id','role','expires_at','revoked_at'];types:=ARRAY['id','id','id','id','role','epoch','null'];
  WHEN 'credential' THEN
    keys:=ARRAY['id','account_id','membership_id','email_id','kind','token_digest','expires_at','reauthenticated_at','revoked_at','permission'];
    types:=ARRAY['id','id','nullable:id','nullable:id','kind','digest','epoch','nullable:epoch','null','permission'];
  WHEN 'space' THEN
    keys:=ARRAY['id','owner_account_id','organization_id','deployment_id','data_policy','disabled_at','source_byte_limit','message_limit'];
    types:=ARRAY['space_id','nullable:id','nullable:id','id','policy','null','source_limit','message_limit'];
  WHEN 'legacy_grant' THEN
    keys:=ARRAY['credential_id','account_id','space_id','can_ingest','can_search','expires_at','revoked_at','can_erase','can_retire'];
    types:=ARRAY['id','id','space_id','bool','bool','epoch','null','bool','bool'];
  ELSE RETURN false;
  END CASE;
  IF NOT(p ?& keys) OR p-keys<>'{}'::jsonb THEN RETURN false; END IF;
  FOR i IN 1..pg_catalog.cardinality(keys) LOOP
    IF NOT memory_identity.projection_v3_setup_valid(p->keys[i],types[i]) THEN RETURN false; END IF;
  END LOOP;
  IF t='email' THEN RETURN p->>'domain'=pg_catalog.split_part(p->>'address','@',2); END IF;
  IF t='credential' THEN
    RETURN (p->>'kind'='personal_key' AND p->'membership_id'='null'::jsonb AND p->'email_id'='null'::jsonb)
      OR(p->>'kind'='api_key' AND p->'membership_id'<>'null'::jsonb AND p->'email_id'<>'null'::jsonb);
  END IF;
  IF t='space' THEN RETURN (p->'owner_account_id'='null'::jsonb)<>(p->'organization_id'='null'::jsonb); END IF;
  RETURN true;
END
$valid$;

CREATE TABLE memory_ops.identity_projection_space_provisioning(
  space_id text PRIMARY KEY CHECK(space_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  approval_id uuid NOT NULL UNIQUE,approval_reference memory_control.identifier NOT NULL,
  approved_at_ms memory_control.epoch_ms NOT NULL,approved_by_session name NOT NULL,
  deployment_singleton smallint NOT NULL CHECK(deployment_singleton=1) REFERENCES memory_control.deployment_identity(singleton),
  deployment_id memory_control.identifier NOT NULL,storage_region text NOT NULL CHECK(storage_region='kr-seoul'),
  processing_policy_id memory_control.identifier NOT NULL CHECK(processing_policy_id='kr-primary-storage-v1'),
  deployment_created_at_ms memory_control.epoch_ms NOT NULL,
  data_policy jsonb NOT NULL CHECK(memory_identity.projection_v3_setup_valid(data_policy,'policy')),
  source_byte_limit bigint NOT NULL CHECK(source_byte_limit BETWEEN 0 AND 67108864),
  message_limit integer NOT NULL CHECK(message_limit BETWEEN 1 AND 100000)
);
CREATE TABLE memory_identity.identity_projection_retained_dispositions(
  approval_id uuid PRIMARY KEY,approval_reference memory_control.identifier NOT NULL,
  approved_at_ms memory_control.epoch_ms NOT NULL,approved_by_session name NOT NULL,
  deployment_singleton smallint NOT NULL CHECK(deployment_singleton=1) REFERENCES memory_control.deployment_identity(singleton),
  deployment_id memory_control.identifier NOT NULL,storage_region text NOT NULL CHECK(storage_region='kr-seoul'),
  processing_policy_id memory_control.identifier NOT NULL CHECK(processing_policy_id='kr-primary-storage-v1'),
  deployment_created_at_ms memory_control.epoch_ms NOT NULL,
  entity_kind text NOT NULL CHECK(entity_kind IN('account','organization','provider_identity','email','membership','credential','space','legacy_grant')),
  entity_id memory_control.identifier,issuer text,subject text,credential_id memory_control.identifier,space_id text,
  disposition text NOT NULL CHECK(disposition='adopt_exact_binding'),
  retained_basis jsonb NOT NULL,authorized_binding jsonb NOT NULL,
  CHECK((entity_kind IN('account','organization','email','membership','credential','space') AND entity_id IS NOT NULL
      AND issuer IS NULL AND subject IS NULL AND credential_id IS NULL AND space_id IS NULL)
    OR(entity_kind='provider_identity' AND entity_id IS NULL AND issuer IS NOT NULL AND subject IS NOT NULL AND credential_id IS NULL AND space_id IS NULL)
    OR(entity_kind='legacy_grant' AND entity_id IS NULL AND issuer IS NULL AND subject IS NULL AND credential_id IS NOT NULL AND space_id IS NOT NULL)),
  CHECK(entity_kind<>'space' OR entity_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK(issuer IS NULL OR issuer='https://auth-api.allen.company'),
  CHECK(subject IS NULL OR memory_identity.projection_v3_setup_valid(pg_catalog.to_jsonb(subject),'subject')),
  CHECK(space_id IS NULL OR space_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK(pg_catalog.octet_length(retained_basis::text)+pg_catalog.octet_length(authorized_binding::text)<=131072),
  CHECK(memory_identity.projection_v3_setup_valid(retained_basis,entity_kind)),
  CHECK(memory_identity.projection_v3_setup_valid(authorized_binding,entity_kind))
);
CREATE UNIQUE INDEX projection_retained_id_key ON memory_identity.identity_projection_retained_dispositions(entity_kind,entity_id) WHERE entity_id IS NOT NULL;
CREATE UNIQUE INDEX projection_retained_provider_key ON memory_identity.identity_projection_retained_dispositions(issuer,subject) WHERE entity_kind='provider_identity';
CREATE UNIQUE INDEX projection_retained_grant_key ON memory_identity.identity_projection_retained_dispositions(credential_id,space_id) WHERE entity_kind='legacy_grant';

CREATE FUNCTION memory_ops.projection_v3_setup_insert_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fence$
BEGIN
  IF current_user<>'memory_owner' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_setup_invalid'; END IF;
  PERFORM id FROM memory_ops.identity_projection_fence WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP005',MESSAGE='seoul_projection_setup_conflict'; END IF;
  RETURN NULL;
END
$fence$;
CREATE FUNCTION memory_ops.projection_v3_setup_insert_count() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $count$
DECLARE n integer;
BEGIN
  SELECT pg_catalog.count(*) INTO n FROM(SELECT 1 FROM inserted_setup_rows LIMIT 2) bounded;
  IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_setup_invalid'; END IF;
  RETURN NULL;
END
$count$;

CREATE FUNCTION memory_identity.projection_v3_setup_insert_row() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $row$
DECLARE deployment memory_control.deployment_identity%ROWTYPE; actual jsonb; allowed text[]:='{}';
  provision memory_ops.identity_projection_space_provisioning%ROWTYPE;
BEGIN
  IF current_user<>'memory_owner' OR NEW.approval_id IS NULL OR NEW.approval_reference IS NULL
    OR NEW.deployment_singleton IS DISTINCT FROM 1 OR NEW.deployment_id IS NULL OR NEW.storage_region IS NULL
    OR NEW.processing_policy_id IS NULL OR NEW.deployment_created_at_ms IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_setup_invalid';
  END IF;
  SELECT * INTO deployment FROM memory_control.deployment_identity WHERE singleton=1;
  IF NOT FOUND OR NEW.deployment_id IS DISTINCT FROM deployment.deployment_id OR NEW.storage_region IS DISTINCT FROM deployment.storage_region
    OR NEW.processing_policy_id IS DISTINCT FROM deployment.processing_policy_id OR NEW.deployment_created_at_ms IS DISTINCT FROM deployment.created_at_ms
    OR NEW.storage_region<>'kr-seoul' OR NEW.processing_policy_id<>'kr-primary-storage-v1' THEN
    RAISE EXCEPTION USING ERRCODE='PP005',MESSAGE='seoul_projection_setup_conflict';
  END IF;
  NEW.approved_at_ms:=pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint;
  NEW.approved_by_session:=session_user;
  IF TG_TABLE_SCHEMA='memory_ops' AND TG_TABLE_NAME='identity_projection_space_provisioning' THEN
    IF NOT memory_identity.projection_v3_setup_valid(pg_catalog.to_jsonb(NEW.space_id),'space_id')
      OR NOT memory_identity.projection_v3_setup_valid(NEW.data_policy,'policy')
      OR NEW.source_byte_limit IS NULL OR NEW.source_byte_limit NOT BETWEEN 0 AND 67108864
      OR NEW.message_limit IS NULL OR NEW.message_limit NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_setup_invalid';
    END IF;
    IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_space_provisioning WHERE space_id=NEW.space_id OR approval_id=NEW.approval_id) THEN
      RAISE EXCEPTION USING ERRCODE='PP005',MESSAGE='seoul_projection_setup_conflict';
    END IF;
    SELECT pg_catalog.to_jsonb(s) INTO actual FROM memory_control.spaces s WHERE s.id=NEW.space_id FOR SHARE;
    IF FOUND AND(actual->>'deployment_id' IS DISTINCT FROM NEW.deployment_id OR actual->'data_policy' IS DISTINCT FROM NEW.data_policy
      OR(actual->>'source_byte_limit')::bigint IS DISTINCT FROM NEW.source_byte_limit OR(actual->>'message_limit')::integer IS DISTINCT FROM NEW.message_limit) THEN
      RAISE EXCEPTION USING ERRCODE='PP005',MESSAGE='seoul_projection_setup_conflict';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_SCHEMA<>'memory_identity' OR TG_TABLE_NAME<>'identity_projection_retained_dispositions'
    OR NEW.entity_kind IS NULL OR NEW.disposition IS DISTINCT FROM 'adopt_exact_binding'
    OR NEW.retained_basis IS NULL OR NEW.authorized_binding IS NULL
    OR pg_catalog.octet_length(NEW.retained_basis::text)+pg_catalog.octet_length(NEW.authorized_binding::text)>131072
    OR NOT memory_identity.projection_v3_setup_valid(NEW.retained_basis,NEW.entity_kind)
    OR NOT memory_identity.projection_v3_setup_valid(NEW.authorized_binding,NEW.entity_kind) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_setup_invalid';
  END IF;
  IF NOT((NEW.entity_kind IN('account','organization','email','membership','credential','space') AND NEW.entity_id IS NOT NULL
      AND NEW.issuer IS NULL AND NEW.subject IS NULL AND NEW.credential_id IS NULL AND NEW.space_id IS NULL)
    OR(NEW.entity_kind='provider_identity' AND NEW.entity_id IS NULL AND NEW.issuer IS NOT NULL AND NEW.subject IS NOT NULL AND NEW.credential_id IS NULL AND NEW.space_id IS NULL)
    OR(NEW.entity_kind='legacy_grant' AND NEW.entity_id IS NULL AND NEW.issuer IS NULL AND NEW.subject IS NULL AND NEW.credential_id IS NOT NULL AND NEW.space_id IS NOT NULL))
    OR(NEW.entity_kind='space' AND NOT memory_identity.projection_v3_setup_valid(pg_catalog.to_jsonb(NEW.entity_id),'space_id'))
    OR(NEW.entity_kind='provider_identity' AND(NOT memory_identity.projection_v3_setup_valid(pg_catalog.to_jsonb(NEW.issuer),'issuer') OR NOT memory_identity.projection_v3_setup_valid(pg_catalog.to_jsonb(NEW.subject),'subject')))
    OR(NEW.entity_kind='legacy_grant' AND NOT memory_identity.projection_v3_setup_valid(pg_catalog.to_jsonb(NEW.space_id),'space_id')) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_setup_invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM memory_identity.identity_projection_retained_dispositions d WHERE d.approval_id=NEW.approval_id
    OR(d.entity_kind=NEW.entity_kind AND d.entity_id=NEW.entity_id)
    OR(NEW.entity_kind='provider_identity' AND d.issuer=NEW.issuer AND d.subject=NEW.subject)
    OR(NEW.entity_kind='legacy_grant' AND d.credential_id=NEW.credential_id AND d.space_id=NEW.space_id)) THEN
    RAISE EXCEPTION USING ERRCODE='PP005',MESSAGE='seoul_projection_setup_conflict';
  END IF;
  CASE NEW.entity_kind
  WHEN 'account' THEN
    SELECT pg_catalog.to_jsonb(x) INTO actual FROM memory_identity.accounts x WHERE x.id=NEW.entity_id FOR SHARE;
    IF NOT EXISTS(SELECT 1 FROM memory_identity.provider_identities WHERE account_id=NEW.entity_id AND issuer='https://auth-api.allen.company' LIMIT 1) THEN
      RAISE EXCEPTION USING ERRCODE='PP005',MESSAGE='seoul_projection_setup_conflict';
    END IF;
  WHEN 'organization' THEN SELECT pg_catalog.to_jsonb(x) INTO actual FROM memory_control.organizations x WHERE x.id=NEW.entity_id FOR SHARE;
  WHEN 'provider_identity' THEN SELECT pg_catalog.to_jsonb(x) INTO actual FROM memory_identity.provider_identities x WHERE x.issuer=NEW.issuer AND x.subject=NEW.subject FOR SHARE;
  WHEN 'email' THEN SELECT pg_catalog.to_jsonb(x) INTO actual FROM memory_identity.account_emails x WHERE x.id=NEW.entity_id FOR SHARE;
  WHEN 'membership' THEN
    SELECT pg_catalog.to_jsonb(x) INTO actual FROM memory_identity.memberships x WHERE x.id=NEW.entity_id FOR SHARE;
    allowed:=ARRAY['role','expires_at'];
  WHEN 'credential' THEN
    SELECT pg_catalog.to_jsonb(x) INTO actual FROM memory_identity.credentials x WHERE x.id=NEW.entity_id FOR SHARE;
    allowed:=ARRAY['permission','expires_at'];
  WHEN 'space' THEN
    SELECT pg_catalog.to_jsonb(x) INTO actual FROM memory_control.spaces x WHERE x.id=NEW.entity_id FOR SHARE;
    SELECT * INTO provision FROM memory_ops.identity_projection_space_provisioning WHERE space_id=NEW.entity_id;
    IF NOT FOUND OR provision.deployment_id IS DISTINCT FROM NEW.deployment_id OR provision.storage_region IS DISTINCT FROM NEW.storage_region
      OR provision.processing_policy_id IS DISTINCT FROM NEW.processing_policy_id OR provision.deployment_created_at_ms IS DISTINCT FROM NEW.deployment_created_at_ms
      OR NEW.authorized_binding->>'deployment_id' IS DISTINCT FROM provision.deployment_id
      OR provision.data_policy IS DISTINCT FROM NEW.authorized_binding->'data_policy'
      OR provision.source_byte_limit IS DISTINCT FROM(NEW.authorized_binding->>'source_byte_limit')::bigint
      OR provision.message_limit IS DISTINCT FROM(NEW.authorized_binding->>'message_limit')::integer THEN
      RAISE EXCEPTION USING ERRCODE='PP005',MESSAGE='seoul_projection_setup_conflict';
    END IF;
    PERFORM space_id FROM memory_ops.space_usage WHERE space_id=NEW.entity_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP005',MESSAGE='seoul_projection_setup_conflict'; END IF;
  WHEN 'legacy_grant' THEN
    SELECT pg_catalog.to_jsonb(x) INTO actual FROM memory_identity.pat_space_grants x WHERE x.credential_id=NEW.credential_id AND x.space_id=NEW.space_id FOR SHARE;
    allowed:=ARRAY['can_ingest','can_search','expires_at'];
  ELSE RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_setup_invalid';
  END CASE;
  IF actual IS NULL OR actual IS DISTINCT FROM NEW.retained_basis
    OR NEW.retained_basis-allowed IS DISTINCT FROM NEW.authorized_binding-allowed THEN
    RAISE EXCEPTION USING ERRCODE='PP005',MESSAGE='seoul_projection_setup_conflict';
  END IF;
  RETURN NEW;
END
$row$;

ALTER TABLE memory_ops.identity_projection_space_provisioning ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.identity_projection_space_provisioning FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_identity.identity_projection_retained_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_identity.identity_projection_retained_dispositions FORCE ROW LEVEL SECURITY;
CREATE POLICY setup_owner_select ON memory_ops.identity_projection_space_provisioning FOR SELECT TO memory_owner USING(true);
CREATE POLICY setup_owner_insert ON memory_ops.identity_projection_space_provisioning FOR INSERT TO memory_owner WITH CHECK(true);
CREATE POLICY setup_projection_select ON memory_ops.identity_projection_space_provisioning FOR SELECT TO memory_projection_owner USING(true);
CREATE POLICY setup_owner_select ON memory_identity.identity_projection_retained_dispositions FOR SELECT TO memory_owner USING(true);
CREATE POLICY setup_owner_insert ON memory_identity.identity_projection_retained_dispositions FOR INSERT TO memory_owner WITH CHECK(true);
CREATE POLICY setup_projection_select ON memory_identity.identity_projection_retained_dispositions FOR SELECT TO memory_projection_owner USING(true);

CREATE TRIGGER setup_insert_fence BEFORE INSERT ON memory_ops.identity_projection_space_provisioning FOR EACH STATEMENT EXECUTE FUNCTION memory_ops.projection_v3_setup_insert_fence();
CREATE TRIGGER setup_insert_row BEFORE INSERT ON memory_ops.identity_projection_space_provisioning FOR EACH ROW EXECUTE FUNCTION memory_identity.projection_v3_setup_insert_row();
CREATE TRIGGER setup_insert_count AFTER INSERT ON memory_ops.identity_projection_space_provisioning REFERENCING NEW TABLE AS inserted_setup_rows FOR EACH STATEMENT EXECUTE FUNCTION memory_ops.projection_v3_setup_insert_count();
CREATE TRIGGER setup_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON memory_ops.identity_projection_space_provisioning FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER setup_insert_fence BEFORE INSERT ON memory_identity.identity_projection_retained_dispositions FOR EACH STATEMENT EXECUTE FUNCTION memory_ops.projection_v3_setup_insert_fence();
CREATE TRIGGER setup_insert_row BEFORE INSERT ON memory_identity.identity_projection_retained_dispositions FOR EACH ROW EXECUTE FUNCTION memory_identity.projection_v3_setup_insert_row();
CREATE TRIGGER setup_insert_count AFTER INSERT ON memory_identity.identity_projection_retained_dispositions REFERENCING NEW TABLE AS inserted_setup_rows FOR EACH STATEMENT EXECUTE FUNCTION memory_ops.projection_v3_setup_insert_count();
CREATE TRIGGER setup_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON memory_identity.identity_projection_retained_dispositions FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();

REVOKE ALL ON memory_ops.identity_projection_space_provisioning,memory_identity.identity_projection_retained_dispositions
  FROM PUBLIC,memory_projection_owner,memory_projection_caller,memory_runtime,memory_background,memory_commands,memory_lifecycle;
REVOKE ALL ON FUNCTION memory_identity.projection_v3_setup_valid(jsonb,text),memory_ops.projection_v3_setup_insert_fence(),
  memory_ops.projection_v3_setup_insert_count(),memory_identity.projection_v3_setup_insert_row()
  FROM PUBLIC,memory_projection_owner,memory_projection_caller,memory_runtime,memory_background,memory_commands,memory_lifecycle;
-- Retained owner defaults can name any role, including a runtime login or an
-- inherited group. Enumerate ACLs on only the six new objects; never change
-- old objects, defaults or role edges. Fixed object names and quoted grantees
-- keep catalogue role names out of SQL syntax. RESTRICT fails on an unexpected
-- dependent grant instead of changing objects outside this foundation.
DO $new_object_acls$
DECLARE acl_grantee name;
BEGIN
  FOR acl_grantee IN
    SELECT r.rolname FROM pg_catalog.pg_roles r WHERE r.oid IN (
      SELECT a.grantee FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid IN ('memory_ops.identity_projection_space_provisioning'::regclass,'memory_identity.identity_projection_retained_dispositions'::regclass)
        AND a.grantee<>c.relowner
      UNION
      SELECT a.grantee FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid IN ('memory_identity.projection_v3_setup_valid(jsonb,text)'::regprocedure,'memory_ops.projection_v3_setup_insert_fence()'::regprocedure,
        'memory_ops.projection_v3_setup_insert_count()'::regprocedure,'memory_identity.projection_v3_setup_insert_row()'::regprocedure)
        AND a.grantee<>p.proowner
    ) ORDER BY r.oid
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON memory_ops.identity_projection_space_provisioning,memory_identity.identity_projection_retained_dispositions FROM %I RESTRICT',acl_grantee);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION memory_identity.projection_v3_setup_valid(jsonb,text),memory_ops.projection_v3_setup_insert_fence(),memory_ops.projection_v3_setup_insert_count(),memory_identity.projection_v3_setup_insert_row() FROM %I RESTRICT',acl_grantee);
  END LOOP;
END
$new_object_acls$;
GRANT SELECT(space_id,approval_id,deployment_singleton,deployment_id,storage_region,processing_policy_id,deployment_created_at_ms,data_policy,source_byte_limit,message_limit)
  ON memory_ops.identity_projection_space_provisioning TO memory_projection_owner;
GRANT SELECT(approval_id,deployment_singleton,deployment_id,storage_region,processing_policy_id,deployment_created_at_ms,entity_kind,entity_id,issuer,subject,credential_id,space_id,disposition,retained_basis,authorized_binding)
  ON memory_identity.identity_projection_retained_dispositions TO memory_projection_owner;
COMMIT;

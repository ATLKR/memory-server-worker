-- Requires a CREATEROLE provisioner independently permitted to SET memory_owner.
-- Fixed private PAT/archive slice; no login, token issuance, SSO or extension.
BEGIN;
SET LOCAL createrole_self_grant = 'set, inherit';
CREATE ROLE memory_commands NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER DEFAULT PRIVILEGES FOR ROLE memory_commands REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SET LOCAL ROLE memory_owner;

CREATE TABLE memory_control.spaces (
  id text PRIMARY KEY CHECK (id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  owner_account_id memory_control.identifier REFERENCES memory_identity.accounts(id),
  organization_id memory_control.identifier REFERENCES memory_control.organizations(id),
  deployment_id memory_control.identifier NOT NULL,
  data_policy jsonb NOT NULL CHECK (jsonb_typeof(data_policy) = 'object'),
  disabled_at memory_control.epoch_ms,
  source_byte_limit bigint NOT NULL CHECK (source_byte_limit BETWEEN 0 AND 67108864),
  message_limit integer NOT NULL CHECK (message_limit BETWEEN 1 AND 100000),
  CHECK ((owner_account_id IS NULL) <> (organization_id IS NULL))
);
CREATE TABLE memory_identity.pat_space_grants (
  credential_id memory_control.identifier NOT NULL,
  account_id memory_control.identifier NOT NULL,
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  can_ingest boolean NOT NULL, can_search boolean NOT NULL,
  expires_at memory_control.epoch_ms NOT NULL,
  revoked_at memory_control.epoch_ms,
  PRIMARY KEY(credential_id,space_id),
  FOREIGN KEY(credential_id,account_id) REFERENCES memory_identity.credentials(id,account_id)
);
CREATE TABLE memory_content.archives (
  id text PRIMARY KEY CHECK (id COLLATE "C" ~ '^arc:[a-f0-9-]{36}$'),
  space_id text NOT NULL REFERENCES memory_control.spaces(id),
  operation_id text NOT NULL CHECK (operation_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  credential_id memory_control.identifier NOT NULL,
  account_id memory_control.identifier NOT NULL,
  request_format integer NOT NULL CHECK (request_format = 1),
  request_digest text NOT NULL CHECK (request_digest COLLATE "C" ~ '^[a-f0-9]{64}$'),
  session_id text, routing jsonb NOT NULL,
  message_count integer NOT NULL CHECK (message_count BETWEEN 1 AND 500),
  source_bytes bigint NOT NULL CHECK (source_bytes BETWEEN 0 AND 1048576),
  created_at_ms memory_control.epoch_ms NOT NULL,
  authority_expires_at_ms memory_control.epoch_ms NOT NULL,
  hidden_at memory_control.epoch_ms, erased_at memory_control.epoch_ms,
  UNIQUE(space_id,operation_id), UNIQUE(space_id,id),
  FOREIGN KEY(credential_id,account_id) REFERENCES memory_identity.credentials(id,account_id),
  FOREIGN KEY(credential_id,space_id) REFERENCES memory_identity.pat_space_grants(credential_id,space_id)
);
CREATE TABLE memory_content.archive_messages (
  id text PRIMARY KEY CHECK (id COLLATE "C" ~ '^mem:[a-f0-9-]{36}$'),
  space_id text NOT NULL, archive_id text NOT NULL,
  message_index integer NOT NULL CHECK (message_index BETWEEN 0 AND 499),
  revision integer NOT NULL CHECK (revision = 1),
  role text NOT NULL CHECK (role IN ('system','user','assistant')),
  content text NOT NULL CHECK (octet_length(content) <= 32768),
  original_timestamp text,
  source_bytes integer NOT NULL CHECK (source_bytes = octet_length(content)),
  content_digest text NOT NULL CHECK (content_digest = encode(sha256(convert_to(content,'UTF8')),'hex')),
  UNIQUE(space_id,id), UNIQUE(space_id,archive_id,message_index),
  FOREIGN KEY(space_id,archive_id) REFERENCES memory_content.archives(space_id,id)
);
CREATE TABLE memory_ops.space_usage (
  space_id text PRIMARY KEY REFERENCES memory_control.spaces(id),
  source_bytes bigint NOT NULL DEFAULT 0 CHECK (source_bytes BETWEEN 0 AND 67108864),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count BETWEEN 0 AND 100000)
);
CREATE TABLE memory_ops.meter_events (
  space_id text NOT NULL, archive_id text NOT NULL,
  operation_id text NOT NULL,
  source_bytes bigint NOT NULL CHECK (source_bytes BETWEEN 0 AND 1048576),
  message_count integer NOT NULL CHECK (message_count BETWEEN 1 AND 500),
  created_at_ms memory_control.epoch_ms NOT NULL,
  PRIMARY KEY(space_id,archive_id), UNIQUE(space_id,operation_id),
  FOREIGN KEY(space_id,archive_id) REFERENCES memory_content.archives(space_id,id)
);

CREATE TRIGGER spaces_immutable BEFORE UPDATE ON memory_control.spaces FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
    OR NEW.data_policy IS DISTINCT FROM OLD.data_policy
    OR (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER pat_grants_immutable BEFORE UPDATE ON memory_identity.pat_space_grants FOR EACH ROW
  WHEN (NEW.credential_id IS DISTINCT FROM OLD.credential_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.space_id IS DISTINCT FROM OLD.space_id OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER archives_immutable BEFORE UPDATE ON memory_content.archives FOR EACH ROW
  WHEN ((to_jsonb(NEW)-'hidden_at'-'erased_at') IS DISTINCT FROM (to_jsonb(OLD)-'hidden_at'-'erased_at')
    OR (OLD.hidden_at IS NOT NULL AND NEW.hidden_at IS DISTINCT FROM OLD.hidden_at)
    OR (OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER messages_immutable BEFORE UPDATE ON memory_content.archive_messages
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER meters_immutable BEFORE UPDATE ON memory_ops.meter_events
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER usage_binding_immutable BEFORE UPDATE ON memory_ops.space_usage FOR EACH ROW
  WHEN (NEW.space_id IS DISTINCT FROM OLD.space_id) EXECUTE FUNCTION memory_control.reject_mutation();

DO $boundaries$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['memory_control.spaces','memory_identity.pat_space_grants','memory_content.archives',
    'memory_content.archive_messages','memory_ops.space_usage','memory_ops.meter_events'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY migration_owner ON %s TO memory_owner USING(true) WITH CHECK(true)',target);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()',target);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['memory_identity.accounts','memory_control.organizations','memory_identity.account_emails',
    'memory_identity.memberships','memory_identity.credentials','memory_identity.pat_space_grants','memory_control.spaces',
    'memory_content.archives','memory_content.archive_messages','memory_ops.space_usage','memory_ops.meter_events'] LOOP
    EXECUTE format('CREATE POLICY seoul_commands_read ON %s FOR SELECT TO memory_commands USING(true)',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['memory_identity.accounts','memory_control.organizations','memory_identity.account_emails',
    'memory_identity.memberships','memory_identity.credentials','memory_identity.pat_space_grants','memory_control.spaces',
    'memory_content.archives','memory_ops.space_usage'] LOOP
    EXECUTE format('CREATE POLICY seoul_commands_update ON %s FOR UPDATE TO memory_commands USING(true) WITH CHECK(true)',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['memory_content.archives','memory_content.archive_messages','memory_ops.meter_events'] LOOP
    EXECUTE format('CREATE POLICY seoul_commands_insert ON %s FOR INSERT TO memory_commands WITH CHECK(true)',target);
  END LOOP;
END
$boundaries$;

GRANT USAGE ON SCHEMA memory_control,memory_identity,memory_content,memory_ops TO memory_commands;
GRANT SELECT ON memory_control.deployment_identity,memory_control.schema_migrations,memory_control.organizations,memory_control.spaces,
  memory_identity.accounts,memory_identity.account_emails,memory_identity.memberships,memory_identity.credentials,memory_identity.pat_space_grants,
  memory_content.archives,memory_content.archive_messages,memory_ops.space_usage,memory_ops.meter_events TO memory_commands;
-- PostgreSQL row locks require UPDATE permission. Only immutable binding
-- columns are granted; their triggers reject changed values.
GRANT UPDATE(id) ON memory_identity.accounts,memory_control.organizations,memory_identity.account_emails,
  memory_identity.memberships,memory_identity.credentials,memory_control.spaces,memory_content.archives TO memory_commands;
GRANT UPDATE(credential_id) ON memory_identity.pat_space_grants TO memory_commands;
GRANT UPDATE(source_bytes,message_count) ON memory_ops.space_usage TO memory_commands;
GRANT INSERT ON memory_content.archives,memory_content.archive_messages,memory_ops.meter_events TO memory_commands;
GRANT CREATE ON SCHEMA memory_identity,memory_content TO memory_commands;
RESET ROLE;
SET LOCAL ROLE memory_commands;

CREATE FUNCTION memory_identity.seoul_pat_authority(p_digest text,p_space text,p_ingest boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $authority$
DECLARE c memory_identity.credentials%ROWTYPE; a memory_identity.accounts%ROWTYPE;
  m memory_identity.memberships%ROWTYPE; e memory_identity.account_emails%ROWTYPE;
  o memory_control.organizations%ROWTYPE; g memory_identity.pat_space_grants%ROWTYPE;
  s memory_control.spaces%ROWTYPE; d memory_control.deployment_identity%ROWTYPE;
  at_ms bigint; until_ms bigint; policy jsonb;
BEGIN
  IF p_digest IS NULL OR p_digest COLLATE "C" !~ '^[a-f0-9]{64}$' OR p_ingest IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='seoul_pat_denied';
  END IF;
  SELECT * INTO c FROM memory_identity.credentials WHERE token_digest=p_digest;
  IF NOT FOUND OR c.kind NOT IN ('personal_key','api_key') THEN
    RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='seoul_pat_denied';
  END IF;
  -- Resolve immutable references first, then take conflict-capable locks in a
  -- consistent account -> org -> email/member -> credential -> grant -> Space order.
  SELECT * INTO a FROM memory_identity.accounts WHERE id=c.account_id FOR SHARE;
  IF c.kind='api_key' THEN
    SELECT * INTO m FROM memory_identity.memberships WHERE id=c.membership_id;
    SELECT * INTO o FROM memory_control.organizations WHERE id=m.organization_id FOR SHARE;
    SELECT * INTO e FROM memory_identity.account_emails WHERE id=c.email_id FOR SHARE;
    SELECT * INTO m FROM memory_identity.memberships WHERE id=c.membership_id FOR SHARE;
  END IF;
  SELECT * INTO c FROM memory_identity.credentials WHERE token_digest=p_digest FOR SHARE;
  at_ms := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  until_ms := least(c.expires_at,at_ms+30000);
  IF a.id IS NULL OR a.disabled_at IS NOT NULL OR c.revoked_at IS NOT NULL OR c.permission NOT IN ('read','write') THEN
    RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='seoul_pat_denied';
  END IF;
  IF c.kind='api_key' THEN
    IF m.id IS NULL OR o.id IS NULL OR e.id IS NULL OR o.disabled_at IS NOT NULL OR m.revoked_at IS NOT NULL OR e.revoked_at IS NOT NULL OR e.verified_at>at_ms
      OR m.account_id<>a.id OR m.email_id<>e.id OR e.account_id<>a.id THEN
      RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='seoul_pat_denied';
    END IF;
    until_ms:=least(until_ms,m.expires_at);
  END IF;
  IF until_ms<=at_ms THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  IF p_space IS NOT NULL THEN
    SELECT * INTO g FROM memory_identity.pat_space_grants WHERE credential_id=c.id AND space_id=p_space FOR SHARE;
    SELECT * INTO s FROM memory_control.spaces WHERE id=p_space FOR SHARE;
    IF g.credential_id IS NULL OR s.id IS NULL OR g.account_id<>a.id OR g.revoked_at IS NOT NULL OR s.disabled_at IS NOT NULL
      OR (p_ingest AND (NOT g.can_ingest OR c.permission<>'write')) OR (NOT p_ingest AND NOT g.can_search)
      OR (c.kind='personal_key' AND s.owner_account_id IS DISTINCT FROM a.id)
      OR (c.kind='api_key' AND (s.organization_id IS DISTINCT FROM m.organization_id OR (p_ingest AND m.role NOT IN ('owner','admin')))) THEN
      RAISE EXCEPTION USING ERRCODE='PA003',MESSAGE='seoul_space_denied';
    END IF;
    SELECT * INTO d FROM memory_control.deployment_identity WHERE singleton=1;
    policy:=s.data_policy;
    IF d.deployment_id IS NULL OR s.deployment_id<>d.deployment_id OR d.storage_region<>'kr-seoul'
      OR d.processing_policy_id<>'kr-primary-storage-v1' OR jsonb_typeof(policy)<>'object'
      OR NOT (policy ?& ARRAY['policyVersion','residency','profile','processingBoundary','dataClass','classificationStatus','sensitivityTags','placementEpoch'])
      OR (policy-ARRAY['policyVersion','residency','profile','processingBoundary','dataClass','classificationStatus','sensitivityTags','placementEpoch'])<>'{}'::jsonb
      OR policy->'policyVersion'<>'1'::jsonb OR policy->'residency' IS DISTINCT FROM '"kr-seoul"'::jsonb
      OR policy->'profile' IS DISTINCT FROM '"kr-primary-storage"'::jsonb
      OR policy->'processingBoundary' IS DISTINCT FROM '"approved-processors"'::jsonb
      OR jsonb_typeof(policy->'classificationStatus')<>'string' OR policy->>'classificationStatus' NOT IN ('declared','verified')
      OR jsonb_typeof(policy->'dataClass')<>'string' OR policy->>'dataClass' NOT IN ('general','personal','health','clinical','restricted')
      OR jsonb_typeof(policy->'sensitivityTags')<>'array' OR jsonb_typeof(policy->'placementEpoch')<>'number' THEN
      RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='seoul_processing_denied';
    END IF;
    IF (policy->>'placementEpoch')::numeric NOT BETWEEN 1 AND 9007199254740991 OR trunc((policy->>'placementEpoch')::numeric)<>(policy->>'placementEpoch')::numeric
      OR jsonb_array_length(policy->'sensitivityTags')>4
      OR jsonb_array_length(policy->'sensitivityTags')<>(SELECT count(DISTINCT v) FROM jsonb_array_elements(policy->'sensitivityTags') v)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(policy->'sensitivityTags') v
        WHERE jsonb_typeof(v)<>'string' OR v#>>'{}' NOT IN ('health','clinical-origin','government-id','credential')) THEN
      RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='seoul_processing_denied';
    END IF;
    until_ms:=least(until_ms,g.expires_at);
    at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
    IF until_ms<=at_ms THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  END IF;
  RETURN jsonb_build_object('issuedAtMs',at_ms,'expiresAtMs',until_ms,'accountId',a.id,'credentialId',c.id);
END
$authority$;

CREATE FUNCTION memory_identity.seoul_pat_check(p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $check$
DECLARE auth jsonb;
BEGIN
  auth:=memory_identity.seoul_pat_authority(p_digest,NULL,false);
  RETURN jsonb_build_object('admission',auth-ARRAY['accountId','credentialId'],'result',jsonb_build_object('authenticated',true));
END
$check$;

CREATE FUNCTION memory_content.seoul_validate_input(p_input jsonb,p_ingest boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $validate$
DECLARE r jsonb; consent jsonb; item jsonb; total_bytes bigint:=0; stamp text; allowed text[];
BEGIN
  allowed:=CASE WHEN p_ingest THEN ARRAY['spaceId','operationId','routing','messages','sessionId'] ELSE ARRAY['spaceId','routing','query','limit','mode'] END;
  IF p_input IS NULL OR p_ingest IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (p_input-allowed)<>'{}'::jsonb OR NOT(p_input ?& ARRAY['spaceId','routing'])
    OR jsonb_typeof(p_input->'spaceId')<>'string' OR p_input->>'spaceId' COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
  END IF;
  r:=p_input->'routing';
  IF jsonb_typeof(r)<>'object' OR NOT(r ?& ARRAY['version','classification'])
    OR (r-ARRAY['version','classification','destination','requiredRegion','medicalCloudflareConsent'])<>'{}'::jsonb
    OR r->'version'<>'1'::jsonb OR jsonb_typeof(r->'classification')<>'string'
    OR r->>'classification' NOT IN ('general','medical','region-locked','uncertain')
    OR (r ? 'destination' AND (jsonb_typeof(r->'destination')<>'string' OR r->>'destination' NOT IN ('auto','seoul')))
    OR (r ? 'requiredRegion' AND r->'requiredRegion'<>'"kr-seoul"'::jsonb) THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
  END IF;
  IF r ? 'medicalCloudflareConsent' THEN
    consent:=r->'medicalCloudflareConsent';
    IF jsonb_typeof(consent)<>'object' OR NOT(consent='{"mode":"organization"}'::jsonb OR
      (consent ?& ARRAY['consentId','version'] AND (consent-ARRAY['consentId','version'])='{}'::jsonb
        AND jsonb_typeof(consent->'consentId')='string' AND consent->>'consentId' COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND jsonb_typeof(consent->'version')='number' AND (consent->>'version')::numeric BETWEEN 1 AND 9007199254740991
        AND trunc((consent->>'version')::numeric)=(consent->>'version')::numeric)) THEN
      RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
    END IF;
  END IF;
  IF p_ingest THEN
    IF NOT(p_input ?& ARRAY['operationId','messages']) OR jsonb_typeof(p_input->'operationId')<>'string'
      OR p_input->>'operationId' COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR jsonb_typeof(p_input->'messages')<>'array' THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid'; END IF;
    IF jsonb_array_length(p_input->'messages') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid'; END IF;
    IF p_input ? 'sessionId' AND (jsonb_typeof(p_input->'sessionId')<>'string' OR length(p_input->>'sessionId') NOT BETWEEN 1 AND 64
      OR p_input->>'sessionId' IN ('.','..') OR p_input->>'sessionId' COLLATE "C" ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
    END IF;
    -- The shared string schema counts UTF-16 units; PostgreSQL length counts
    -- codepoints. A supplementary character occupies two accepted units.
    IF p_input ? 'sessionId' AND (SELECT sum(CASE WHEN ascii(value)>65535 THEN 2 ELSE 1 END)
      FROM string_to_table(p_input->>'sessionId',NULL) AS units(value))>64 THEN
      RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_input->'messages') LOOP
      IF jsonb_typeof(item)<>'object' OR NOT(item ?& ARRAY['role','content']) OR (item-ARRAY['role','content','timestamp'])<>'{}'::jsonb
        OR item->>'role' NOT IN ('system','user','assistant') OR jsonb_typeof(item->'role')<>'string' OR jsonb_typeof(item->'content')<>'string'
        OR octet_length(item->>'content')>32768 THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid'; END IF;
      total_bytes:=total_bytes+octet_length(item->>'content');
      IF item ? 'timestamp' THEN
        stamp:=item->>'timestamp';
        IF jsonb_typeof(item->'timestamp')<>'string' OR length(stamp)>40 OR left(stamp,4)='0000'
          OR stamp COLLATE "C" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,9})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' THEN
          RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
        END IF;
        -- Validate the calendar separately; preserve the accepted original
        -- offset and nanoseconds rather than normalizing through timestamptz.
        BEGIN PERFORM left(stamp,10)::date;
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid'; END;
      END IF;
    END LOOP;
    IF total_bytes>1048576 THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid'; END IF;
  ELSE
    IF NOT(p_input ? 'query') OR jsonb_typeof(p_input->'query')<>'string' OR octet_length(p_input->>'query') NOT BETWEEN 1 AND 1024
      OR (p_input ? 'mode' AND p_input->'mode'<>'"keyword"'::jsonb)
      OR (p_input ? 'limit' AND (jsonb_typeof(p_input->'limit')<>'number' OR (p_input->>'limit')::numeric NOT BETWEEN 1 AND 50
        OR trunc((p_input->>'limit')::numeric)<>(p_input->>'limit')::numeric)) THEN
      RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
    END IF;
    p_input:=jsonb_build_object('mode','keyword','limit',20)||p_input;
  END IF;
  RETURN p_input;
END
$validate$;

CREATE FUNCTION memory_content.seoul_archive_ingest(p_digest text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $ingest$
DECLARE input jsonb; auth jsonb; usage memory_ops.space_usage%ROWTYPE; space memory_control.spaces%ROWTYPE;
  archived memory_content.archives%ROWTYPE; digest text; total_bytes bigint; message_count integer;
  item jsonb; idx integer:=0; stamp bigint; until_ms bigint; replayed boolean:=false;
BEGIN
  input:=memory_content.seoul_validate_input(p_input,true);
  auth:=memory_identity.seoul_pat_authority(p_digest,input->>'spaceId',true);
  SELECT * INTO usage FROM memory_ops.space_usage WHERE space_id=input->>'spaceId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PA003',MESSAGE='seoul_space_denied'; END IF;
  SELECT * INTO space FROM memory_control.spaces WHERE id=input->>'spaceId';
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;until_ms:=(auth->>'expiresAtMs')::bigint;
  IF stamp>=until_ms THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
  SELECT * INTO archived FROM memory_content.archives WHERE space_id=space.id AND operation_id=input->>'operationId';
  IF FOUND THEN
    IF archived.request_format<>1 OR archived.request_digest<>digest OR archived.credential_id<>auth->>'credentialId'
      OR archived.account_id<>auth->>'accountId' THEN RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict'; END IF;
    replayed:=true;
  ELSE
    SELECT count(*)::integer,sum(octet_length(value->>'content')) INTO message_count,total_bytes FROM jsonb_array_elements(input->'messages');
    IF usage.source_bytes+total_bytes>space.source_byte_limit OR usage.message_count+message_count>space.message_limit THEN
      RAISE EXCEPTION USING ERRCODE='PA006',MESSAGE='seoul_quota_exceeded';
    END IF;
    INSERT INTO memory_content.archives(id,space_id,operation_id,credential_id,account_id,request_format,request_digest,
      session_id,routing,message_count,source_bytes,created_at_ms,authority_expires_at_ms)
      VALUES('arc:'||gen_random_uuid()::text,space.id,input->>'operationId',auth->>'credentialId',auth->>'accountId',1,digest,
        input->>'sessionId',input->'routing',message_count,total_bytes,stamp,until_ms) RETURNING * INTO archived;
    FOR item IN SELECT value FROM jsonb_array_elements(input->'messages') LOOP
      INSERT INTO memory_content.archive_messages(id,space_id,archive_id,message_index,revision,role,content,original_timestamp,source_bytes,content_digest)
        VALUES('mem:'||gen_random_uuid()::text,space.id,archived.id,idx,1,item->>'role',item->>'content',item->>'timestamp',
          octet_length(item->>'content'),encode(sha256(convert_to(item->>'content','UTF8')),'hex'));
      idx:=idx+1;
    END LOOP;
    UPDATE memory_ops.space_usage SET source_bytes=space_usage.source_bytes+total_bytes,message_count=space_usage.message_count+archived.message_count WHERE space_id=space.id;
    INSERT INTO memory_ops.meter_events VALUES(space.id,archived.id,archived.operation_id,total_bytes,message_count,stamp);
  END IF;
  IF floor(extract(epoch FROM clock_timestamp())*1000)::bigint>=until_ms THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  RETURN jsonb_build_object('admission',auth-ARRAY['accountId','credentialId'],'result',jsonb_build_object(
    'spaceId',space.id,'operationId',archived.operation_id,'archiveId',archived.id,'state','stored','extraction','none',
    'messageCount',archived.message_count,'sourceBytes',archived.source_bytes,'replayed',replayed));
END
$ingest$;

CREATE FUNCTION memory_content.seoul_keyword_search(p_digest text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $search$
DECLARE input jsonb; auth jsonb; matches jsonb:='[]'::jsonb; item record; needle text;
BEGIN
  input:=memory_content.seoul_validate_input(p_input,false);
  auth:=memory_identity.seoul_pat_authority(p_digest,input->>'spaceId',false);
  -- Pinned NFC + ASCII case fold, literal substring. No stemming, regex,
  -- wildcard expansion, accent removal, model or embedding provider.
  needle:=translate(normalize(input->>'query',NFC),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
  FOR item IN SELECT m.id,m.revision,left(m.content,512) AS excerpt
    FROM memory_content.archive_messages m JOIN memory_content.archives a ON a.space_id=m.space_id AND a.id=m.archive_id
    WHERE m.space_id=input->>'spaceId' AND a.hidden_at IS NULL AND a.erased_at IS NULL
      AND strpos(translate(normalize(m.content,NFC),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),needle)>0
    ORDER BY a.created_at_ms,m.id COLLATE "C" LIMIT (input->>'limit')::integer FOR SHARE OF a LOOP
    matches:=matches||jsonb_build_array(jsonb_build_object('memoryId',item.id,'revision',item.revision,'excerpt',item.excerpt));
  END LOOP;
  IF floor(extract(epoch FROM clock_timestamp())*1000)::bigint>=(auth->>'expiresAtMs')::bigint THEN
    RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired';
  END IF;
  RETURN jsonb_build_object('admission',auth-ARRAY['accountId','credentialId'],'result',jsonb_build_object(
    'spaceId',input->>'spaceId','mode','keyword','matches',matches,'count',jsonb_array_length(matches)));
END
$search$;

CREATE FUNCTION memory_content.seoul_archive_commit_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fence$
DECLARE bearer_digest text; auth jsonb;
BEGIN
  SELECT token_digest INTO bearer_digest FROM memory_identity.credentials WHERE id=NEW.credential_id;
  auth:=memory_identity.seoul_pat_authority(bearer_digest,NEW.space_id,true);
  IF auth->>'credentialId'<>NEW.credential_id OR auth->>'accountId'<>NEW.account_id
    OR floor(extract(epoch FROM clock_timestamp())*1000)::bigint>=NEW.authority_expires_at_ms THEN
    RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired';
  END IF;
  RETURN NEW;
END
$fence$;

REVOKE ALL ON FUNCTION memory_identity.seoul_pat_authority(text,text,boolean),memory_identity.seoul_pat_check(text),
  memory_content.seoul_validate_input(jsonb,boolean),memory_content.seoul_archive_ingest(text,jsonb),
  memory_content.seoul_keyword_search(text,jsonb),memory_content.seoul_archive_commit_fence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_identity.seoul_pat_check(text),memory_content.seoul_archive_ingest(text,jsonb),
  memory_content.seoul_keyword_search(text,jsonb) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_content.seoul_archive_commit_fence() TO memory_owner;
RESET ROLE;
SET LOCAL ROLE memory_owner;
CREATE CONSTRAINT TRIGGER seoul_archive_expiry AFTER INSERT ON memory_content.archives
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_content.seoul_archive_commit_fence();
REVOKE CREATE ON SCHEMA memory_identity,memory_content FROM memory_commands;
GRANT USAGE ON SCHEMA memory_identity,memory_content TO memory_runtime;
INSERT INTO memory_control.schema_migrations(version,name) VALUES(4,'0004_seoul_pat_archive.sql');
RESET ROLE;
SET LOCAL ROLE memory_commands;
REVOKE EXECUTE ON FUNCTION memory_content.seoul_archive_commit_fence() FROM memory_owner;
RESET ROLE;
-- Retain only the creator's narrow administrative edge, not ambient data or SET.
GRANT memory_commands TO CURRENT_USER WITH INHERIT FALSE, SET FALSE;
COMMIT;

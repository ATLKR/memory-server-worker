-- Permanent active-row archive erasure and narrowly scoped authority retirement.
-- Requires the original CREATEROLE provisioner with memory_owner SET authority
-- and its existing ADMIN edge to memory_commands. No LOGIN or provider changes.
BEGIN;
SET LOCAL createrole_self_grant='set, inherit';
CREATE ROLE memory_lifecycle NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER DEFAULT PRIVILEGES FOR ROLE memory_lifecycle REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT memory_commands TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
SET LOCAL ROLE memory_owner;

DO $precondition$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_content.archives WHERE erased_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
  END IF;
END
$precondition$;
ALTER TABLE memory_identity.pat_space_grants ADD COLUMN can_erase boolean NOT NULL DEFAULT false,
  ADD COLUMN can_retire boolean NOT NULL DEFAULT false;
-- Drop the old immutable trigger only inside this schema migration, before the
-- one-time hash backfill. Runtime code never changes trigger availability.
DROP TRIGGER archives_immutable ON memory_content.archives;
ALTER TABLE memory_content.archives ADD COLUMN lifecycle_revision integer NOT NULL DEFAULT 1 CHECK(lifecycle_revision IN(1,2)),
  ADD COLUMN ingest_operation_hash text,
  ADD COLUMN erasure_actor_credential_id memory_control.identifier,
  ADD COLUMN erasure_operation_id uuid;
UPDATE memory_content.archives SET ingest_operation_hash=encode(sha256(convert_to(jsonb_build_array(space_id,operation_id)::text,'UTF8')),'hex');
ALTER TABLE memory_content.archives ALTER COLUMN ingest_operation_hash SET NOT NULL,
  ADD CHECK(ingest_operation_hash COLLATE "C" ~ '^[a-f0-9]{64}$'),
  ADD UNIQUE(space_id,ingest_operation_hash),
  ALTER COLUMN operation_id DROP NOT NULL, ALTER COLUMN request_digest DROP NOT NULL,
  ALTER COLUMN routing DROP NOT NULL, ALTER COLUMN created_at_ms DROP NOT NULL,
  ALTER COLUMN authority_expires_at_ms DROP NOT NULL;
ALTER TABLE memory_content.archives ADD CONSTRAINT archives_lifecycle_shape CHECK(
  (erased_at IS NULL AND lifecycle_revision=1 AND operation_id IS NOT NULL AND request_digest IS NOT NULL
    AND routing IS NOT NULL AND created_at_ms IS NOT NULL AND authority_expires_at_ms IS NOT NULL
    AND erasure_actor_credential_id IS NULL AND erasure_operation_id IS NULL
    AND ingest_operation_hash=encode(sha256(convert_to(jsonb_build_array(space_id,operation_id)::text,'UTF8')),'hex'))
  OR (erased_at IS NOT NULL AND lifecycle_revision=2 AND operation_id IS NULL AND request_digest IS NULL
    AND session_id IS NULL AND routing IS NULL AND created_at_ms IS NULL AND authority_expires_at_ms IS NULL
    AND hidden_at IS NULL AND erasure_actor_credential_id IS NOT NULL AND erasure_operation_id IS NOT NULL));
ALTER TABLE memory_ops.meter_events ALTER COLUMN operation_id DROP NOT NULL, ALTER COLUMN created_at_ms DROP NOT NULL,
  ADD CHECK((operation_id IS NULL)=(created_at_ms IS NULL));
ALTER TABLE memory_ops.space_usage ADD COLUMN retained_source_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN retained_message_count integer NOT NULL DEFAULT 0,
  ADD CHECK(retained_source_bytes BETWEEN 0 AND source_bytes),
  ADD CHECK(retained_message_count BETWEEN 0 AND message_count);
UPDATE memory_ops.space_usage u SET retained_source_bytes=s.bytes,retained_message_count=s.messages
  FROM (SELECT space_id,sum(source_bytes)::bigint AS bytes,sum(message_count)::integer AS messages
    FROM memory_content.archives GROUP BY space_id) s WHERE u.space_id=s.space_id;

CREATE TABLE memory_ops.lifecycle_receipts (
  actor_credential_id memory_control.identifier NOT NULL,
  actor_account_id memory_control.identifier NOT NULL,
  operation_id uuid NOT NULL CHECK(operation_id::text COLLATE "C" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  action text NOT NULL CHECK(action IN('erase','retire','revoke')),
  space_id text REFERENCES memory_control.spaces(id), archive_id text,
  request_digest text NOT NULL CHECK(request_digest COLLATE "C" ~ '^[a-f0-9]{64}$'),
  expected_revision integer CHECK(expected_revision IN(1,2)),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  issued_at_ms memory_control.epoch_ms NOT NULL,
  expires_at_ms memory_control.epoch_ms NOT NULL,
  action_at_ms memory_control.epoch_ms NOT NULL,
  PRIMARY KEY(actor_credential_id,operation_id),
  FOREIGN KEY(actor_credential_id,actor_account_id) REFERENCES memory_identity.credentials(id,account_id),
  FOREIGN KEY(space_id,archive_id) REFERENCES memory_content.archives(space_id,id),
  CHECK(expires_at_ms>issued_at_ms AND expires_at_ms-issued_at_ms<=30000 AND action_at_ms>=issued_at_ms AND action_at_ms<expires_at_ms),
  CHECK((action='erase' AND space_id IS NOT NULL AND archive_id IS NOT NULL AND expected_revision IS NOT NULL)
    OR(action='retire' AND space_id IS NOT NULL AND archive_id IS NULL AND expected_revision IS NULL)
    OR(action='revoke' AND space_id IS NULL AND archive_id IS NULL AND expected_revision IS NULL))
);
ALTER TABLE memory_content.archives ADD FOREIGN KEY(erasure_actor_credential_id,erasure_operation_id)
  REFERENCES memory_ops.lifecycle_receipts(actor_credential_id,operation_id);
ALTER TABLE memory_ops.lifecycle_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.lifecycle_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON memory_ops.lifecycle_receipts TO memory_owner USING(true) WITH CHECK(true);
CREATE TRIGGER no_update BEFORE UPDATE ON memory_ops.lifecycle_receipts FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON memory_ops.lifecycle_receipts FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON memory_ops.lifecycle_receipts FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();

GRANT USAGE ON SCHEMA memory_control,memory_identity,memory_content,memory_ops TO memory_lifecycle;
GRANT SELECT ON memory_control.deployment_identity,memory_control.schema_migrations,memory_control.organizations,memory_control.spaces,
  memory_identity.accounts,memory_identity.account_emails,memory_identity.memberships,memory_identity.credentials,memory_identity.pat_space_grants,
  memory_content.archives,memory_content.archive_messages,memory_ops.space_usage,memory_ops.meter_events,memory_ops.lifecycle_receipts TO memory_lifecycle;
GRANT UPDATE(id) ON memory_identity.accounts,memory_control.organizations,memory_identity.account_emails,memory_identity.memberships TO memory_lifecycle;
GRANT UPDATE(id,revoked_at) ON memory_identity.credentials TO memory_lifecycle;
GRANT UPDATE(credential_id) ON memory_identity.pat_space_grants TO memory_lifecycle;
GRANT UPDATE(id,disabled_at) ON memory_control.spaces TO memory_lifecycle;
GRANT UPDATE(id,operation_id,request_digest,session_id,routing,created_at_ms,authority_expires_at_ms,hidden_at,erased_at,
  lifecycle_revision,erasure_actor_credential_id,erasure_operation_id) ON memory_content.archives TO memory_lifecycle;
GRANT DELETE ON memory_content.archive_messages TO memory_lifecycle;
GRANT UPDATE(operation_id,created_at_ms) ON memory_ops.meter_events TO memory_lifecycle;
GRANT UPDATE(retained_source_bytes,retained_message_count) ON memory_ops.space_usage TO memory_lifecycle,memory_commands;
GRANT INSERT ON memory_ops.lifecycle_receipts TO memory_lifecycle;
DO $policies$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['memory_identity.accounts','memory_control.organizations','memory_identity.account_emails',
    'memory_identity.memberships','memory_identity.credentials','memory_identity.pat_space_grants','memory_control.spaces',
    'memory_content.archives','memory_content.archive_messages','memory_ops.space_usage','memory_ops.meter_events','memory_ops.lifecycle_receipts'] LOOP
    EXECUTE format('CREATE POLICY seoul_lifecycle_read ON %s FOR SELECT TO memory_lifecycle USING(true)',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['memory_identity.accounts','memory_control.organizations','memory_identity.account_emails',
    'memory_identity.memberships','memory_identity.credentials','memory_identity.pat_space_grants','memory_control.spaces',
    'memory_content.archives','memory_ops.space_usage','memory_ops.meter_events'] LOOP
    EXECUTE format('CREATE POLICY seoul_lifecycle_update ON %s FOR UPDATE TO memory_lifecycle USING(true) WITH CHECK(true)',target);
  END LOOP;
END
$policies$;
CREATE POLICY seoul_lifecycle_delete ON memory_content.archive_messages FOR DELETE TO memory_lifecycle USING(true);
CREATE POLICY seoul_lifecycle_insert ON memory_ops.lifecycle_receipts FOR INSERT TO memory_lifecycle WITH CHECK(true);
GRANT CREATE ON SCHEMA memory_control,memory_identity,memory_content,memory_ops TO memory_lifecycle;
RESET ROLE;
SET LOCAL ROLE memory_lifecycle;

CREATE FUNCTION memory_identity.seoul_action_authority(p_digest text,p_space text,p_action text,p_terminal_operation uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $authority$
DECLARE c memory_identity.credentials%ROWTYPE; a memory_identity.accounts%ROWTYPE;
  m memory_identity.memberships%ROWTYPE; e memory_identity.account_emails%ROWTYPE;
  o memory_control.organizations%ROWTYPE; g memory_identity.pat_space_grants%ROWTYPE;
  s memory_control.spaces%ROWTYPE; d memory_control.deployment_identity%ROWTYPE;
  at_ms bigint; until_ms bigint; policy jsonb; terminal memory_ops.lifecycle_receipts%ROWTYPE;
BEGIN
  IF p_digest IS NULL OR p_digest COLLATE "C" !~ '^[a-f0-9]{64}$' OR p_action IS NULL OR p_action NOT IN ('check','ingest','search','erase','retire','revoke','status')
    OR ((p_space IS NULL) <> (p_action IN ('check','revoke'))) THEN
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
  IF p_action='revoke' THEN
    SELECT * INTO c FROM memory_identity.credentials WHERE token_digest=p_digest FOR UPDATE;
  ELSE
    SELECT * INTO c FROM memory_identity.credentials WHERE token_digest=p_digest FOR SHARE;
  END IF;
  IF p_terminal_operation IS NOT NULL THEN
    SELECT * INTO terminal FROM memory_ops.lifecycle_receipts WHERE actor_credential_id=c.id AND operation_id=p_terminal_operation;
    IF terminal.actor_credential_id IS NULL OR terminal.actor_account_id<>c.account_id OR terminal.action<>p_action
      OR terminal.space_id IS DISTINCT FROM p_space OR p_action NOT IN ('retire','revoke') THEN
      RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired';
    END IF;
  END IF;
  at_ms := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  until_ms := least(c.expires_at,at_ms+30000);
  IF a.id IS NULL OR a.disabled_at IS NOT NULL OR (c.revoked_at IS NOT NULL AND NOT(p_action='revoke' AND terminal.actor_credential_id IS NOT NULL AND c.revoked_at=terminal.action_at_ms)) OR c.permission NOT IN ('read','write') THEN
    RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='seoul_pat_denied';
  END IF;
  IF c.kind='api_key' THEN
    IF m.id IS NULL OR o.id IS NULL OR e.id IS NULL OR o.disabled_at IS NOT NULL OR m.revoked_at IS NOT NULL OR e.revoked_at IS NOT NULL OR e.verified_at>at_ms
      OR m.account_id<>a.id OR m.email_id<>e.id OR e.account_id<>a.id THEN
      RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='seoul_pat_denied';
    END IF;
    until_ms:=least(until_ms,m.expires_at);
  END IF;
  IF terminal.actor_credential_id IS NOT NULL THEN until_ms:=least(until_ms,terminal.expires_at_ms); END IF;
  IF until_ms<=at_ms THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  IF p_space IS NOT NULL THEN
    SELECT * INTO g FROM memory_identity.pat_space_grants WHERE credential_id=c.id AND space_id=p_space FOR SHARE;
    IF p_action='retire' THEN
      SELECT * INTO s FROM memory_control.spaces WHERE id=p_space FOR UPDATE;
    ELSE
      SELECT * INTO s FROM memory_control.spaces WHERE id=p_space FOR SHARE;
    END IF;
    IF g.credential_id IS NULL OR s.id IS NULL OR g.account_id<>a.id OR g.revoked_at IS NOT NULL OR (s.disabled_at IS NOT NULL AND NOT(p_action='retire' AND terminal.actor_credential_id IS NOT NULL AND s.disabled_at=terminal.action_at_ms))
      OR (p_action='ingest' AND NOT g.can_ingest) OR (p_action='search' AND NOT g.can_search)
      OR (p_action='erase' AND NOT g.can_erase) OR (p_action='retire' AND NOT g.can_retire)
      OR (p_action='status' AND NOT g.can_erase)
      OR (p_action IN ('ingest','erase','retire','status') AND c.permission<>'write')
      OR (c.kind='personal_key' AND s.owner_account_id IS DISTINCT FROM a.id)
      OR (c.kind='api_key' AND (s.organization_id IS DISTINCT FROM m.organization_id OR (p_action IN ('ingest','erase','retire','status') AND m.role NOT IN ('owner','admin')))) THEN
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

CREATE FUNCTION memory_ops.seoul_lifecycle_input(p_input jsonb,p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $input$
DECLARE keys text[];
BEGIN
  keys:=CASE p_action WHEN 'erase' THEN ARRAY['spaceId','archiveId','expectedRevision','operationId']
    WHEN 'retire' THEN ARRAY['spaceId','operationId'] WHEN 'revoke' THEN ARRAY['operationId']
    WHEN 'status' THEN CASE p_input->>'kind' WHEN 'archive' THEN ARRAY['kind','spaceId','archiveId']
      WHEN 'operation' THEN ARRAY['kind','spaceId','operationId'] END END;
  IF keys IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR NOT(p_input ?& keys) OR p_input-keys<>'{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
  END IF;
  IF 'spaceId'=ANY(keys) AND (jsonb_typeof(p_input->'spaceId')<>'string'
    OR p_input->>'spaceId' COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
  END IF;
  IF 'archiveId'=ANY(keys) AND (jsonb_typeof(p_input->'archiveId')<>'string'
    OR p_input->>'archiveId' COLLATE "C" !~ '^arc:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
  END IF;
  IF 'operationId'=ANY(keys) AND (jsonb_typeof(p_input->'operationId')<>'string'
    OR p_input->>'operationId' COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
  END IF;
  IF 'expectedRevision'=ANY(keys) AND p_input->'expectedRevision' NOT IN('1'::jsonb,'2'::jsonb) THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='seoul_input_invalid';
  END IF;
  RETURN p_input;
END
$input$;

CREATE FUNCTION memory_content.seoul_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
DECLARE a memory_content.archives%ROWTYPE; r memory_ops.lifecycle_receipts%ROWTYPE;
BEGIN
  IF TG_TABLE_SCHEMA='memory_content' AND TG_TABLE_NAME='archives' AND TG_OP='UPDATE' THEN
    IF OLD.erased_at IS NULL AND NEW.erased_at IS NULL
      AND (to_jsonb(NEW)-'hidden_at')=(to_jsonb(OLD)-'hidden_at')
      AND (OLD.hidden_at IS NULL OR NEW.hidden_at IS NOT DISTINCT FROM OLD.hidden_at) THEN RETURN NEW; END IF;
    IF current_user<>'memory_lifecycle' OR OLD.erased_at IS NOT NULL OR NEW.erased_at IS NULL
      OR (to_jsonb(NEW)-ARRAY['operation_id','request_digest','session_id','routing','created_at_ms','authority_expires_at_ms',
        'hidden_at','erased_at','lifecycle_revision','erasure_actor_credential_id','erasure_operation_id'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['operation_id','request_digest','session_id','routing','created_at_ms','authority_expires_at_ms',
        'hidden_at','erased_at','lifecycle_revision','erasure_actor_credential_id','erasure_operation_id']) THEN
      RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
    END IF;
    SELECT * INTO r FROM memory_ops.lifecycle_receipts WHERE actor_credential_id=NEW.erasure_actor_credential_id AND operation_id=NEW.erasure_operation_id;
    IF r.action IS DISTINCT FROM 'erase' OR r.archive_id IS DISTINCT FROM NEW.id OR r.space_id IS DISTINCT FROM NEW.space_id
      OR r.expected_revision<>1 OR r.action_at_ms IS DISTINCT FROM NEW.erased_at
      OR r.result->'revision'<>'2'::jsonb OR r.result->'removedMessages' IS DISTINCT FROM to_jsonb(OLD.message_count)
      OR r.result->'removedSourceBytes' IS DISTINCT FROM to_jsonb(OLD.source_bytes) THEN
      RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user<>'memory_lifecycle' THEN RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict'; END IF;
  SELECT * INTO a FROM memory_content.archives WHERE space_id=OLD.space_id AND id=OLD.archive_id;
  SELECT * INTO r FROM memory_ops.lifecycle_receipts WHERE actor_credential_id=a.erasure_actor_credential_id AND operation_id=a.erasure_operation_id;
  IF a.erased_at IS NULL OR r.action IS DISTINCT FROM 'erase' OR r.archive_id IS DISTINCT FROM a.id OR r.space_id IS DISTINCT FROM a.space_id
    OR r.action_at_ms IS DISTINCT FROM a.erased_at THEN RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict'; END IF;
  IF TG_TABLE_SCHEMA='memory_content' AND TG_TABLE_NAME='archive_messages' AND TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_TABLE_SCHEMA='memory_ops' AND TG_TABLE_NAME='meter_events' AND TG_OP='UPDATE'
    AND NEW.operation_id IS NULL AND NEW.created_at_ms IS NULL
    AND OLD.operation_id IS NOT NULL AND OLD.created_at_ms IS NOT NULL
    AND (to_jsonb(NEW)-ARRAY['operation_id','created_at_ms'])=(to_jsonb(OLD)-ARRAY['operation_id','created_at_ms']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
END
$guard$;

CREATE FUNCTION memory_content.seoul_archive_erase(p_digest text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $erase$
DECLARE input jsonb; auth jsonb; a memory_content.archives%ROWTYPE; r memory_ops.lifecycle_receipts%ROWTYPE;
  result jsonb; digest text; stamp bigint; removed_bytes bigint; removed_messages integer;
BEGIN
  input:=memory_ops.seoul_lifecycle_input(p_input,'erase');
  auth:=memory_identity.seoul_action_authority(p_digest,input->>'spaceId','erase');
  PERFORM 1 FROM memory_ops.space_usage WHERE space_id=input->>'spaceId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PA003',MESSAGE='seoul_space_denied'; END IF;
  SELECT * INTO a FROM memory_content.archives WHERE space_id=input->>'spaceId' AND id=input->>'archiveId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PA003',MESSAGE='seoul_space_denied'; END IF;
  digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
  SELECT * INTO r FROM memory_ops.lifecycle_receipts WHERE actor_credential_id=auth->>'credentialId' AND operation_id=(input->>'operationId')::uuid;
  IF FOUND THEN
    IF r.actor_account_id<>auth->>'accountId' OR r.action<>'erase' OR r.space_id<>a.space_id OR r.archive_id<>a.id OR r.request_digest<>digest THEN
      RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
    END IF;
    result:=r.result||jsonb_build_object('replayed',true);
  ELSE
    IF a.lifecycle_revision<>(input->>'expectedRevision')::integer THEN RAISE EXCEPTION USING ERRCODE='PA009',MESSAGE='seoul_revision_conflict'; END IF;
    stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
    IF stamp>=(auth->>'expiresAtMs')::bigint THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
    removed_bytes:=CASE WHEN a.erased_at IS NULL THEN a.source_bytes ELSE 0 END;
    removed_messages:=CASE WHEN a.erased_at IS NULL THEN a.message_count ELSE 0 END;
    result:=jsonb_build_object('spaceId',a.space_id,'archiveId',a.id,'operationId',input->>'operationId','revision',2,
      'state','primary_erased','replayed',false,'primaryRowsRemoved',true,'removedMessages',removed_messages,'removedSourceBytes',removed_bytes,
      'restoreAllowed',false,'backupCleanup','not_confirmed','physicalMediaCleanup','not_confirmed');
    BEGIN
      INSERT INTO memory_ops.lifecycle_receipts VALUES(auth->>'credentialId',auth->>'accountId',(input->>'operationId')::uuid,'erase',a.space_id,a.id,
        digest,a.lifecycle_revision,result,(auth->>'issuedAtMs')::bigint,(auth->>'expiresAtMs')::bigint,stamp);
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict'; END;
    IF a.erased_at IS NULL THEN
      UPDATE memory_content.archives SET operation_id=NULL,request_digest=NULL,session_id=NULL,routing=NULL,created_at_ms=NULL,
        authority_expires_at_ms=NULL,hidden_at=NULL,erased_at=stamp,lifecycle_revision=2,
        erasure_actor_credential_id=auth->>'credentialId',erasure_operation_id=(input->>'operationId')::uuid WHERE id=a.id;
      DELETE FROM memory_content.archive_messages WHERE space_id=a.space_id AND archive_id=a.id;
      UPDATE memory_ops.meter_events SET operation_id=NULL,created_at_ms=NULL WHERE space_id=a.space_id AND archive_id=a.id;
      UPDATE memory_ops.space_usage SET retained_source_bytes=retained_source_bytes-removed_bytes,
        retained_message_count=retained_message_count-removed_messages WHERE space_id=a.space_id;
    END IF;
  END IF;
  IF floor(extract(epoch FROM clock_timestamp())*1000)::bigint>=(auth->>'expiresAtMs')::bigint THEN
    RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired';
  END IF;
  RETURN jsonb_build_object('admission',auth-ARRAY['accountId','credentialId'],'result',result);
END
$erase$;

CREATE FUNCTION memory_control.seoul_space_retire(p_digest text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $retire$
DECLARE input jsonb; auth jsonb; result jsonb; stamp bigint;
BEGIN
  input:=memory_ops.seoul_lifecycle_input(p_input,'retire');
  auth:=memory_identity.seoul_action_authority(p_digest,input->>'spaceId','retire');
  IF EXISTS(SELECT 1 FROM memory_ops.lifecycle_receipts WHERE actor_credential_id=auth->>'credentialId' AND operation_id=(input->>'operationId')::uuid)
    OR EXISTS(SELECT 1 FROM memory_content.archives WHERE space_id=input->>'spaceId' AND erased_at IS NULL)
    OR EXISTS(SELECT 1 FROM memory_content.archive_messages WHERE space_id=input->>'spaceId') THEN
    RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
  END IF;
  PERFORM 1 FROM memory_ops.space_usage WHERE space_id=input->>'spaceId' AND retained_source_bytes=0 AND retained_message_count=0 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict'; END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF stamp>=(auth->>'expiresAtMs')::bigint THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  result:=jsonb_build_object('spaceId',input->>'spaceId','operationId',input->>'operationId','state','retired','replayed',false);
  BEGIN
    INSERT INTO memory_ops.lifecycle_receipts VALUES(auth->>'credentialId',auth->>'accountId',(input->>'operationId')::uuid,'retire',input->>'spaceId',NULL,
      encode(sha256(convert_to(input::text,'UTF8')),'hex'),NULL,result,(auth->>'issuedAtMs')::bigint,(auth->>'expiresAtMs')::bigint,stamp);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict'; END;
  UPDATE memory_control.spaces SET disabled_at=stamp WHERE id=input->>'spaceId';
  RETURN jsonb_build_object('admission',auth-ARRAY['accountId','credentialId'],'result',result);
END
$retire$;

CREATE FUNCTION memory_identity.seoul_pat_revoke_self(p_digest text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $revoke$
DECLARE input jsonb; auth jsonb; result jsonb; stamp bigint;
BEGIN
  input:=memory_ops.seoul_lifecycle_input(p_input,'revoke');
  auth:=memory_identity.seoul_action_authority(p_digest,NULL,'revoke');
  IF EXISTS(SELECT 1 FROM memory_ops.lifecycle_receipts WHERE actor_credential_id=auth->>'credentialId' AND operation_id=(input->>'operationId')::uuid) THEN
    RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
  END IF;
  stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF stamp>=(auth->>'expiresAtMs')::bigint THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  result:=jsonb_build_object('operationId',input->>'operationId','state','revoked','replayed',false);
  BEGIN
    INSERT INTO memory_ops.lifecycle_receipts VALUES(auth->>'credentialId',auth->>'accountId',(input->>'operationId')::uuid,'revoke',NULL,NULL,
      encode(sha256(convert_to(input::text,'UTF8')),'hex'),NULL,result,(auth->>'issuedAtMs')::bigint,(auth->>'expiresAtMs')::bigint,stamp);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict'; END;
  UPDATE memory_identity.credentials SET revoked_at=stamp WHERE id=auth->>'credentialId';
  RETURN jsonb_build_object('admission',auth-ARRAY['accountId','credentialId'],'result',result);
END
$revoke$;

CREATE FUNCTION memory_ops.seoul_lifecycle_status(p_digest text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $status$
DECLARE input jsonb; auth jsonb; a memory_content.archives%ROWTYPE; result jsonb; receipt jsonb;
BEGIN
  input:=memory_ops.seoul_lifecycle_input(p_input,'status');
  auth:=memory_identity.seoul_action_authority(p_digest,input->>'spaceId','status');
  IF input->>'kind'='archive' THEN
    SELECT * INTO a FROM memory_content.archives WHERE space_id=input->>'spaceId' AND id=input->>'archiveId' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PA003',MESSAGE='seoul_space_denied'; END IF;
    result:=jsonb_build_object('kind','archive','spaceId',a.space_id,'archiveId',a.id,'revision',a.lifecycle_revision,
      'state',CASE WHEN a.erased_at IS NULL THEN 'stored' ELSE 'primary_erased' END);
  ELSE
    SELECT r.result INTO receipt FROM memory_ops.lifecycle_receipts r WHERE r.actor_credential_id=auth->>'credentialId'
      AND r.actor_account_id=auth->>'accountId' AND r.action='erase' AND r.space_id=input->>'spaceId'
      AND r.operation_id=(input->>'operationId')::uuid;
    result:=jsonb_build_object('kind','operation','spaceId',input->>'spaceId','operationId',input->>'operationId','receipt',receipt);
  END IF;
  IF floor(extract(epoch FROM clock_timestamp())*1000)::bigint>=(auth->>'expiresAtMs')::bigint THEN
    RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired';
  END IF;
  RETURN jsonb_build_object('admission',auth-ARRAY['accountId','credentialId'],'result',result);
END
$status$;

CREATE FUNCTION memory_ops.seoul_lifecycle_commit_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fence$
DECLARE bearer_digest text; auth jsonb;
BEGIN
  SELECT token_digest INTO bearer_digest FROM memory_identity.credentials WHERE id=NEW.actor_credential_id;
  auth:=memory_identity.seoul_action_authority(bearer_digest,NEW.space_id,NEW.action,
    CASE WHEN NEW.action IN('retire','revoke') THEN NEW.operation_id ELSE NULL END);
  IF auth->>'credentialId'<>NEW.actor_credential_id OR auth->>'accountId'<>NEW.actor_account_id
    OR floor(extract(epoch FROM clock_timestamp())*1000)::bigint>=NEW.expires_at_ms THEN
    RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired';
  END IF;
  IF NEW.action='erase' AND (NOT EXISTS(SELECT 1 FROM memory_content.archives WHERE id=NEW.archive_id AND space_id=NEW.space_id AND erased_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM memory_content.archive_messages WHERE archive_id=NEW.archive_id AND space_id=NEW.space_id)
    OR EXISTS(SELECT 1 FROM memory_ops.meter_events WHERE archive_id=NEW.archive_id AND space_id=NEW.space_id AND (operation_id IS NOT NULL OR created_at_ms IS NOT NULL))) THEN
    RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
  END IF;
  RETURN NEW;
END
$fence$;

REVOKE ALL ON FUNCTION memory_identity.seoul_action_authority(text,text,text,uuid),memory_ops.seoul_lifecycle_input(jsonb,text),
  memory_content.seoul_lifecycle_guard(),memory_content.seoul_archive_erase(text,jsonb),memory_control.seoul_space_retire(text,jsonb),
  memory_identity.seoul_pat_revoke_self(text,jsonb),memory_ops.seoul_lifecycle_status(text,jsonb),memory_ops.seoul_lifecycle_commit_fence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_identity.seoul_action_authority(text,text,text,uuid) TO memory_commands;
GRANT EXECUTE ON FUNCTION memory_content.seoul_archive_erase(text,jsonb),memory_control.seoul_space_retire(text,jsonb),
  memory_identity.seoul_pat_revoke_self(text,jsonb),memory_ops.seoul_lifecycle_status(text,jsonb) TO memory_runtime;
GRANT EXECUTE ON FUNCTION memory_content.seoul_lifecycle_guard(),memory_ops.seoul_lifecycle_commit_fence() TO memory_owner;
RESET ROLE;
SET LOCAL ROLE memory_owner;
CREATE TRIGGER archives_immutable BEFORE UPDATE ON memory_content.archives FOR EACH ROW EXECUTE FUNCTION memory_content.seoul_lifecycle_guard();
DROP TRIGGER no_delete ON memory_content.archive_messages;
CREATE TRIGGER no_delete BEFORE DELETE ON memory_content.archive_messages FOR EACH ROW EXECUTE FUNCTION memory_content.seoul_lifecycle_guard();
DROP TRIGGER meters_immutable ON memory_ops.meter_events;
CREATE TRIGGER meters_immutable BEFORE UPDATE ON memory_ops.meter_events FOR EACH ROW EXECUTE FUNCTION memory_content.seoul_lifecycle_guard();
CREATE CONSTRAINT TRIGGER seoul_lifecycle_expiry AFTER INSERT ON memory_ops.lifecycle_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_ops.seoul_lifecycle_commit_fence();
GRANT USAGE ON SCHEMA memory_ops TO memory_runtime;
GRANT CREATE ON SCHEMA memory_identity,memory_content TO memory_commands;
REVOKE CREATE ON SCHEMA memory_control,memory_identity,memory_content,memory_ops FROM memory_lifecycle;
RESET ROLE;
SET LOCAL ROLE memory_lifecycle;
REVOKE EXECUTE ON FUNCTION memory_content.seoul_lifecycle_guard(),memory_ops.seoul_lifecycle_commit_fence() FROM memory_owner;
RESET ROLE;
SET LOCAL ROLE memory_commands;

CREATE OR REPLACE FUNCTION memory_identity.seoul_pat_authority(p_digest text,p_space text,p_ingest boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $authority$
BEGIN
  IF p_ingest IS NULL THEN RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='seoul_pat_denied'; END IF;
  RETURN memory_identity.seoul_action_authority(p_digest,p_space,
    CASE WHEN p_space IS NULL THEN 'check' WHEN p_ingest THEN 'ingest' ELSE 'search' END);
END
$authority$;

CREATE OR REPLACE FUNCTION memory_content.seoul_archive_ingest(p_digest text,p_input jsonb) RETURNS jsonb
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
  SELECT * INTO archived FROM memory_content.archives WHERE space_id=space.id AND ingest_operation_hash=encode(sha256(convert_to(jsonb_build_array(space.id,input->>'operationId')::text,'UTF8')),'hex');
  IF FOUND THEN
    IF archived.credential_id<>auth->>'credentialId' OR archived.account_id<>auth->>'accountId' THEN
      RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
    END IF;
    IF archived.erased_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='PA008',MESSAGE='seoul_archive_erased'; END IF;
    IF archived.operation_id IS DISTINCT FROM input->>'operationId' OR archived.request_format<>1 OR archived.request_digest<>digest THEN
      RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='seoul_operation_conflict';
    END IF;
    replayed:=true;
  ELSE
    SELECT count(*)::integer,sum(octet_length(value->>'content')) INTO message_count,total_bytes FROM jsonb_array_elements(input->'messages');
    IF usage.source_bytes+total_bytes>space.source_byte_limit OR usage.message_count+message_count>space.message_limit THEN
      RAISE EXCEPTION USING ERRCODE='PA006',MESSAGE='seoul_quota_exceeded';
    END IF;
    INSERT INTO memory_content.archives(id,space_id,operation_id,credential_id,account_id,request_format,request_digest,
      session_id,routing,message_count,source_bytes,created_at_ms,authority_expires_at_ms,ingest_operation_hash)
      VALUES('arc:'||gen_random_uuid()::text,space.id,input->>'operationId',auth->>'credentialId',auth->>'accountId',1,digest,
        input->>'sessionId',input->'routing',message_count,total_bytes,stamp,until_ms,
        encode(sha256(convert_to(jsonb_build_array(space.id,input->>'operationId')::text,'UTF8')),'hex')) RETURNING * INTO archived;
    FOR item IN SELECT value FROM jsonb_array_elements(input->'messages') LOOP
      INSERT INTO memory_content.archive_messages(id,space_id,archive_id,message_index,revision,role,content,original_timestamp,source_bytes,content_digest)
        VALUES('mem:'||gen_random_uuid()::text,space.id,archived.id,idx,1,item->>'role',item->>'content',item->>'timestamp',
          octet_length(item->>'content'),encode(sha256(convert_to(item->>'content','UTF8')),'hex'));
      idx:=idx+1;
    END LOOP;
    UPDATE memory_ops.space_usage SET source_bytes=space_usage.source_bytes+total_bytes,message_count=space_usage.message_count+archived.message_count,
      retained_source_bytes=space_usage.retained_source_bytes+total_bytes,retained_message_count=space_usage.retained_message_count+archived.message_count WHERE space_id=space.id;
    INSERT INTO memory_ops.meter_events VALUES(space.id,archived.id,archived.operation_id,total_bytes,message_count,stamp);
  END IF;
  IF floor(extract(epoch FROM clock_timestamp())*1000)::bigint>=until_ms THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  RETURN jsonb_build_object('admission',auth-ARRAY['accountId','credentialId'],'result',jsonb_build_object(
    'spaceId',space.id,'operationId',archived.operation_id,'archiveId',archived.id,'state','stored','extraction','none',
    'messageCount',archived.message_count,'sourceBytes',archived.source_bytes,'replayed',replayed));
END
$ingest$;

RESET ROLE;
SET LOCAL ROLE memory_owner;
REVOKE CREATE ON SCHEMA memory_identity,memory_content FROM memory_commands;
INSERT INTO memory_control.schema_migrations(version,name) VALUES(5,'0005_seoul_archive_lifecycle.sql');
RESET ROLE;
GRANT memory_commands TO CURRENT_USER WITH INHERIT FALSE, SET FALSE;
GRANT memory_lifecycle TO CURRENT_USER WITH INHERIT FALSE, SET FALSE;
COMMIT;

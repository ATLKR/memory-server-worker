-- INACTIVE LOCAL DRAFT. Disposable schema5 tests only; not an installed migration.
-- No LOGIN, migration marker, existing function replacement or positive authority.
BEGIN;
DO $collision$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN('memory_projection_owner','memory_projection_caller')) THEN
    RAISE EXCEPTION USING ERRCODE='42710',MESSAGE='memory_projection_reserved_role_exists';
  END IF;
END
$collision$;
SET LOCAL createrole_self_grant='set, inherit';
CREATE ROLE memory_projection_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE memory_projection_caller NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER DEFAULT PRIVILEGES FOR ROLE memory_projection_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT memory_owner TO CURRENT_USER WITH INHERIT FALSE,SET TRUE;
SET LOCAL ROLE memory_owner;

CREATE TABLE memory_ops.identity_projection_fence(id smallint PRIMARY KEY CHECK(id=1));
CREATE TABLE memory_ops.identity_projection_events(
  transport_event_id uuid PRIMARY KEY,
  transport_payload_sha256 text NOT NULL CHECK(transport_payload_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  payload_text text NOT NULL CHECK(pg_catalog.octet_length(payload_text)<=131072),
  source_revision bigint NOT NULL CHECK(source_revision BETWEEN 1 AND 9007199254740991),
  received_at_ms bigint NOT NULL CHECK(received_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK(transport_payload_sha256=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload_text,'UTF8')),'hex'))
);
CREATE TABLE memory_ops.identity_projection_receipts(
  transport_event_id uuid NOT NULL REFERENCES memory_ops.identity_projection_events(transport_event_id),
  attempt_no integer NOT NULL CHECK(attempt_no=1),
  outcome text NOT NULL CHECK(outcome IN('applied','head_superseded','conflict')),
  reason text NOT NULL,
  receipt_text text NOT NULL CHECK(pg_catalog.octet_length(receipt_text)<=16384),
  PRIMARY KEY(transport_event_id,attempt_no),
  CHECK((outcome='applied' AND reason IN('head_applied','head_already_current'))
    OR(outcome='head_superseded' AND reason='newer_head_present')
    OR(outcome='conflict' AND reason='source_identity_conflict'))
);
CREATE TABLE memory_ops.identity_projection_source_heads(
  source_revision bigint PRIMARY KEY CHECK(source_revision BETWEEN 1 AND 9007199254740991),
  source_event_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind IN('subject','email','organization','membership','credential','space','target')),
  stream_key text NOT NULL CHECK(pg_catalog.octet_length(stream_key) BETWEEN 1 AND 2048),
  source_sha256 text NOT NULL CHECK(source_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  effect jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(effect)='object'),
  UNIQUE(kind,stream_key,source_revision)
);
CREATE TABLE memory_ops.identity_projection_heads(
  kind text NOT NULL,stream_key text NOT NULL,source_revision bigint NOT NULL,
  PRIMARY KEY(kind,stream_key),
  FOREIGN KEY(kind,stream_key,source_revision) REFERENCES memory_ops.identity_projection_source_heads(kind,stream_key,source_revision)
);
CREATE TABLE memory_ops.identity_projection_lifecycle(
  kind text NOT NULL CHECK(kind IN('subject','email')),stream_key text NOT NULL,
  source_revision bigint NOT NULL,
  state text NOT NULL,
  occurred_at_ms bigint NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(kind,stream_key),
  FOREIGN KEY(kind,stream_key,source_revision) REFERENCES memory_ops.identity_projection_source_heads(kind,stream_key,source_revision),
  CHECK((kind='subject' AND state IN('suspended','resumed','deleted')) OR(kind='email' AND state IN('verified','revoked')))
);
CREATE TABLE memory_ops.identity_projection_tombstones(
  kind text NOT NULL CHECK(kind IN('subject','organization','membership','credential','space')),
  stream_key text NOT NULL,source_revision bigint NOT NULL,
  PRIMARY KEY(kind,stream_key),
  FOREIGN KEY(kind,stream_key,source_revision) REFERENCES memory_ops.identity_projection_source_heads(kind,stream_key,source_revision)
);

DO $boundaries$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['identity_projection_fence','identity_projection_events','identity_projection_receipts',
    'identity_projection_source_heads','identity_projection_heads','identity_projection_lifecycle','identity_projection_tombstones'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE memory_ops.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE pg_catalog.format('ALTER TABLE memory_ops.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE pg_catalog.format('CREATE POLICY migration_owner ON memory_ops.%I TO memory_owner USING(true) WITH CHECK(true)',name);
    EXECUTE pg_catalog.format('CREATE POLICY projection_owner_select ON memory_ops.%I FOR SELECT TO memory_projection_owner USING(true)',name);
    EXECUTE pg_catalog.format('CREATE TRIGGER no_delete BEFORE DELETE ON memory_ops.%I FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()',name);
    EXECUTE pg_catalog.format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON memory_ops.%I FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()',name);
    IF name NOT IN('identity_projection_heads','identity_projection_lifecycle') THEN
      EXECUTE pg_catalog.format('CREATE TRIGGER no_update BEFORE UPDATE ON memory_ops.%I FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation()',name);
    END IF;
    IF name<>'identity_projection_fence' THEN
      EXECUTE pg_catalog.format('CREATE POLICY projection_owner_insert ON memory_ops.%I FOR INSERT TO memory_projection_owner WITH CHECK(true)',name);
      EXECUTE pg_catalog.format('GRANT INSERT ON memory_ops.%I TO memory_projection_owner',name);
    END IF;
    EXECUTE pg_catalog.format('GRANT SELECT ON memory_ops.%I TO memory_projection_owner',name);
  END LOOP;
END
$boundaries$;
CREATE POLICY projection_owner_update ON memory_ops.identity_projection_fence FOR UPDATE TO memory_projection_owner USING(id=1) WITH CHECK(id=1);
CREATE POLICY projection_owner_update ON memory_ops.identity_projection_heads FOR UPDATE TO memory_projection_owner USING(true) WITH CHECK(true);
CREATE POLICY projection_owner_update ON memory_ops.identity_projection_lifecycle FOR UPDATE TO memory_projection_owner USING(true) WITH CHECK(true);
INSERT INTO memory_ops.identity_projection_fence VALUES(1);
GRANT UPDATE(id) ON memory_ops.identity_projection_fence TO memory_projection_owner;
GRANT UPDATE(source_revision) ON memory_ops.identity_projection_heads TO memory_projection_owner;
GRANT UPDATE(source_revision,state,occurred_at_ms) ON memory_ops.identity_projection_lifecycle TO memory_projection_owner;
GRANT USAGE,CREATE ON SCHEMA memory_identity,memory_ops TO memory_projection_owner;
GRANT USAGE ON SCHEMA memory_identity,memory_ops TO memory_projection_caller;
RESET ROLE;
SET LOCAL ROLE memory_projection_owner;

CREATE FUNCTION memory_identity.seoul_projection_head_canonical(p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $canonical$
DECLARE h jsonb; e jsonb; keys text[]; prop text; rev bigint; stamp bigint;
  stream text; identity text; email text; rest text; local_part text; domain_part text; label text;
  source_kind text; source_key text; effect_text text; head_text text; separator integer; units integer; i integer;
  prefix constant text := E'https://auth-api.allen.company\n';
  js_space constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  keys:=ARRAY['version','kind','eventId','sourceRevision','issuer','head','effect'];
  IF p IS NULL OR pg_catalog.jsonb_typeof(p)<>'object' OR NOT(p ?& keys) OR p-keys<>'{}'::jsonb
    OR p->'version'<>'3'::jsonb OR p->'kind'<>'"seoul-authority-head"'::jsonb
    OR p->'issuer'<>'"https://auth-api.allen.company"'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  h:=p->'head';e:=p->'effect';keys:=ARRAY['kind','key','revision','eventId','payloadSha256'];
  IF pg_catalog.jsonb_typeof(h)<>'object' OR NOT(h ?& keys) OR h-keys<>'{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  FOREACH prop IN ARRAY ARRAY['kind','key','eventId','payloadSha256'] LOOP
    IF pg_catalog.jsonb_typeof(h->prop)<>'string' THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
  END LOOP;
  IF pg_catalog.jsonb_typeof(p->'eventId')<>'string' OR p->>'eventId' COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR h->>'eventId' COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR h->>'payloadSha256' COLLATE "C" !~ '^[a-f0-9]{64}$'
    OR pg_catalog.jsonb_typeof(p->'sourceRevision')<>'number' OR pg_catalog.jsonb_typeof(h->'revision')<>'number'
    OR (p->>'sourceRevision')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR pg_catalog.trunc((p->>'sourceRevision')::numeric)<>(p->>'sourceRevision')::numeric
    OR h->'revision'<>p->'sourceRevision' THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  rev:=(p->>'sourceRevision')::bigint;source_kind:=h->>'kind';source_key:=h->>'key';
  IF source_kind NOT IN('subject','email','organization','membership','credential','space','target')
    OR pg_catalog.octet_length(source_key)>2048 THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  IF source_kind IN('subject','email') THEN
    IF pg_catalog.left(source_key,pg_catalog.length(prefix))<>prefix THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    rest:=pg_catalog.substr(source_key,pg_catalog.length(prefix)+1);
    IF source_kind='email' THEN
      separator:=pg_catalog.strpos(pg_catalog.reverse(rest),E'\n');
      IF separator<1 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      identity:=pg_catalog.left(rest,pg_catalog.length(rest)-separator);email:=pg_catalog.right(rest,separator-1);
      IF pg_catalog.length(email) NOT BETWEEN 3 AND 254 OR email COLLATE "C" !~ '^[^@]+@[^@]+$' THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      local_part:=pg_catalog.split_part(email,'@',1);domain_part:=pg_catalog.split_part(email,'@',2);
      IF pg_catalog.length(local_part)>64 OR local_part COLLATE "C" !~ $mail$^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$$mail$
        OR pg_catalog.left(local_part,1)='.' OR pg_catalog.right(local_part,1)='.' OR pg_catalog.strpos(local_part,'..')>0
        OR pg_catalog.length(domain_part)>253 OR pg_catalog.strpos(domain_part,'.')=0 THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      FOREACH label IN ARRAY pg_catalog.string_to_array(domain_part,'.') LOOP
        IF label COLLATE "C" !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' THEN
          RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
        END IF;
      END LOOP;
    ELSE identity:=rest; END IF;
    units:=pg_catalog.length(identity);
    IF units>512 OR pg_catalog.btrim(identity,js_space)='' THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    FOR i IN 1..pg_catalog.length(identity) LOOP
      IF pg_catalog.ascii(pg_catalog.substr(identity,i,1))>65535 THEN units:=units+1; END IF;
    END LOOP;
    IF units>512 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
  ELSIF source_key COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  IF pg_catalog.jsonb_typeof(e)<>'object' OR pg_catalog.jsonb_typeof(e->'type') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  CASE e->>'type'
  WHEN 'entity-head' THEN
    keys:=ARRAY['type','disposition'];
    IF NOT(e ?& keys) OR e-keys<>'{}'::jsonb OR e->'disposition' NOT IN('"present"'::jsonb,'"changed"'::jsonb) THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    effect_text:='{"type":"entity-head","disposition":'||pg_catalog.to_json(e->>'disposition')::text||'}';
  WHEN 'subject-lifecycle','email-lifecycle','entity-negative' THEN
    keys:=CASE e->>'type' WHEN 'subject-lifecycle' THEN ARRAY['type','subject','state','occurredAtMs']
      WHEN 'email-lifecycle' THEN ARRAY['type','subject','address','state','occurredAtMs']
      ELSE ARRAY['type','entityKind','entityId','state','occurredAtMs'] END;
    IF NOT(e ?& keys) OR e-keys<>'{}'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    FOREACH prop IN ARRAY keys LOOP
      IF prop<>'occurredAtMs' AND pg_catalog.jsonb_typeof(e->prop)<>'string' THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
    END LOOP;
    IF pg_catalog.jsonb_typeof(e->'occurredAtMs')<>'number' OR (e->>'occurredAtMs')::numeric NOT BETWEEN 0 AND 9007199254740991
      OR pg_catalog.trunc((e->>'occurredAtMs')::numeric)<>(e->>'occurredAtMs')::numeric THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    stamp:=(e->>'occurredAtMs')::bigint;
    IF e->>'type'='subject-lifecycle' THEN
      IF source_kind<>'subject' OR e->>'subject' IS DISTINCT FROM identity OR e->>'state' NOT IN('suspended','resumed','deleted') THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      effect_text:='{"type":"subject-lifecycle","subject":'||pg_catalog.to_json(identity)::text;
    ELSIF e->>'type'='email-lifecycle' THEN
      IF source_kind<>'email' OR e->>'subject' IS DISTINCT FROM identity OR e->>'address' IS DISTINCT FROM email OR e->>'state' NOT IN('verified','revoked') THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      effect_text:='{"type":"email-lifecycle","subject":'||pg_catalog.to_json(identity)::text||',"address":'||pg_catalog.to_json(email)::text;
    ELSE
      IF e->>'entityKind'<>source_kind OR e->>'entityId'<>source_key
        OR NOT((source_kind IN('organization','space') AND e->>'state'='disabled')
          OR(source_kind IN('membership','credential') AND e->>'state'='revoked') OR(source_kind='target' AND e->>'state'='removed')) THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      effect_text:='{"type":"entity-negative","entityKind":'||pg_catalog.to_json(source_kind)::text||',"entityId":'||pg_catalog.to_json(source_key)::text;
    END IF;
    effect_text:=effect_text||',"state":'||pg_catalog.to_json(e->>'state')::text||',"occurredAtMs":'||stamp::text||'}';
  ELSE RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END CASE;
  head_text:='{"kind":'||pg_catalog.to_json(source_kind)::text||',"key":'||pg_catalog.to_json(source_key)::text||',"revision":'||rev::text
    ||',"eventId":'||pg_catalog.to_json(h->>'eventId')::text||',"payloadSha256":'||pg_catalog.to_json(h->>'payloadSha256')::text||'}';
  RETURN '{"version":3,"kind":"seoul-authority-head","eventId":'||pg_catalog.to_json(p->>'eventId')::text||',"sourceRevision":'||rev::text
    ||',"issuer":"https://auth-api.allen.company","head":'||head_text||',"effect":'||effect_text||'}';
END
$canonical$;

CREATE FUNCTION memory_ops.seoul_projection_monotonic_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.stream_key IS DISTINCT FROM OLD.stream_key OR NEW.source_revision<=OLD.source_revision THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='memory_immutable_record';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE FUNCTION memory_identity.seoul_projection_apply(p_raw text,p_transport_sha256 text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $apply$
DECLARE p jsonb; h jsonb; e jsonb; canonical text; transport_id uuid; rev bigint; source_id uuid;
  source_kind text; source_key text; source_digest text; at_ms bigint; outcome_value text; reason_value text;
  bound memory_ops.identity_projection_events%ROWTYPE; source memory_ops.identity_projection_source_heads%ROWTYPE;
  current_source memory_ops.identity_projection_source_heads%ROWTYPE; receipt text; head_text text:=''; source_conflict boolean:=false;
BEGIN
  -- This exception scope contains validation only. PostgreSQL JSON diagnostics
  -- must not disclose raw input, and validation must finish before any DML.
  BEGIN
    IF p_raw IS NULL OR p_transport_sha256 IS NULL OR pg_catalog.octet_length(p_raw)>131072
      OR p_transport_sha256 COLLATE "C" !~ '^[0-9a-f]{64}$'
      OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_raw,'UTF8')),'hex')<>p_transport_sha256 THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    p:=p_raw::jsonb;canonical:=memory_identity.seoul_projection_head_canonical(p);
    IF canonical IS NULL OR canonical<>p_raw THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    transport_id:=(p->>'eventId')::uuid;rev:=(p->>'sourceRevision')::bigint;h:=p->'head';e:=p->'effect';
    source_id:=(h->>'eventId')::uuid;source_kind:=h->>'kind';source_key:=h->>'key';source_digest:=h->>'payloadSha256';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END;
  PERFORM id FROM memory_ops.identity_projection_fence WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO bound FROM memory_ops.identity_projection_events WHERE transport_event_id=transport_id;
  IF FOUND THEN
    IF bound.transport_payload_sha256<>p_transport_sha256 OR bound.payload_text<>p_raw THEN
      RAISE EXCEPTION USING ERRCODE='PP002',MESSAGE='seoul_projection_event_conflict';
    END IF;
    SELECT receipt_text INTO receipt FROM memory_ops.identity_projection_receipts WHERE transport_event_id=transport_id AND attempt_no=1;
    IF receipt IS NULL THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    RETURN receipt;
  END IF;
  at_ms:=pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint;
  INSERT INTO memory_ops.identity_projection_events VALUES(transport_id,p_transport_sha256,p_raw,rev,at_ms);
  FOR source IN SELECT * FROM memory_ops.identity_projection_source_heads WHERE source_revision=rev OR source_event_id=source_id LOOP
    IF source.source_revision<>rev OR source.source_event_id<>source_id OR source.kind<>source_kind OR source.stream_key<>source_key
      OR source.source_sha256<>source_digest OR source.effect<>e THEN source_conflict:=true; END IF;
  END LOOP;
  IF source_conflict THEN outcome_value:='conflict';reason_value:='source_identity_conflict';
  ELSE
    INSERT INTO memory_ops.identity_projection_source_heads VALUES(rev,source_id,source_kind,source_key,source_digest,e)
      ON CONFLICT(source_revision) DO NOTHING;
    -- Irreversible evidence cannot be skipped merely because head delivery raced.
    IF (e->>'type'='subject-lifecycle' AND e->>'state'='deleted')
      OR(e->>'type'='entity-negative' AND source_kind IN('organization','space','membership','credential')) THEN
      INSERT INTO memory_ops.identity_projection_tombstones VALUES(source_kind,source_key,rev) ON CONFLICT(kind,stream_key) DO NOTHING;
    END IF;
    IF e->>'type' IN('subject-lifecycle','email-lifecycle') THEN
      INSERT INTO memory_ops.identity_projection_lifecycle VALUES(source_kind,source_key,rev,e->>'state',(e->>'occurredAtMs')::bigint)
      ON CONFLICT(kind,stream_key) DO UPDATE SET source_revision=EXCLUDED.source_revision,state=EXCLUDED.state,occurred_at_ms=EXCLUDED.occurred_at_ms
        WHERE memory_ops.identity_projection_lifecycle.source_revision<EXCLUDED.source_revision;
    END IF;
    SELECT s.* INTO current_source FROM memory_ops.identity_projection_heads c
      JOIN memory_ops.identity_projection_source_heads s ON s.source_revision=c.source_revision
      WHERE c.kind=source_kind AND c.stream_key=source_key;
    IF NOT FOUND OR current_source.source_revision<rev THEN
      INSERT INTO memory_ops.identity_projection_heads VALUES(source_kind,source_key,rev)
        ON CONFLICT(kind,stream_key) DO UPDATE SET source_revision=EXCLUDED.source_revision;
      outcome_value:='applied';reason_value:='head_applied';
    ELSIF current_source.source_revision=rev THEN outcome_value:='applied';reason_value:='head_already_current';
    ELSE outcome_value:='head_superseded';reason_value:='newer_head_present'; END IF;
  END IF;
  SELECT s.* INTO current_source FROM memory_ops.identity_projection_heads c
    JOIN memory_ops.identity_projection_source_heads s ON s.source_revision=c.source_revision
    WHERE c.kind=source_kind AND c.stream_key=source_key;
  IF FOUND THEN
    head_text:='{"kind":'||pg_catalog.to_json(current_source.kind)::text||',"key":'||pg_catalog.to_json(current_source.stream_key)::text
      ||',"revision":'||current_source.source_revision::text||',"eventId":'||pg_catalog.to_json(current_source.source_event_id::text)::text
      ||',"payloadSha256":'||pg_catalog.to_json(current_source.source_sha256)::text||'}';
  END IF;
  receipt:='{"version":3,"kind":"seoul-projection-receipt","eventId":'||pg_catalog.to_json(transport_id::text)::text
    ||',"transportPayloadSha256":'||pg_catalog.to_json(p_transport_sha256)::text||',"sourceRevision":'||rev::text
    ||',"eventKind":"head","spaceId":null,"snapshotSeq":null,"attemptNo":1,"outcome":'||pg_catalog.to_json(outcome_value)::text
    ||',"reason":'||pg_catalog.to_json(reason_value)::text||',"currentHeads":['||head_text||'],"leaseExpiresAtMs":null,"attemptedAtMs":'||at_ms::text||'}';
  INSERT INTO memory_ops.identity_projection_receipts VALUES(transport_id,1,outcome_value,reason_value,receipt);
  RETURN receipt;
END
$apply$;

CREATE FUNCTION memory_ops.seoul_projection_status(p_event_id text,p_transport_sha256 text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $status$
DECLARE receipt text;
BEGIN
  IF p_event_id IS NULL OR p_event_id COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR p_transport_sha256 IS NULL OR p_transport_sha256 COLLATE "C" !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='PP003',MESSAGE='seoul_projection_receipt_absent';
  END IF;
  SELECT r.receipt_text INTO receipt FROM memory_ops.identity_projection_events e JOIN memory_ops.identity_projection_receipts r USING(transport_event_id)
    WHERE e.transport_event_id=p_event_id::uuid AND e.transport_payload_sha256=p_transport_sha256 AND r.attempt_no=1;
  IF receipt IS NULL THEN RAISE EXCEPTION USING ERRCODE='PP003',MESSAGE='seoul_projection_receipt_absent'; END IF;
  RETURN receipt;
END
$status$;
REVOKE ALL ON FUNCTION memory_identity.seoul_projection_apply(text,text),memory_identity.seoul_projection_head_canonical(jsonb),
  memory_ops.seoul_projection_monotonic_guard(),memory_ops.seoul_projection_status(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_identity.seoul_projection_apply(text,text),memory_ops.seoul_projection_status(text,text) TO memory_projection_caller;
GRANT EXECUTE ON FUNCTION memory_ops.seoul_projection_monotonic_guard() TO memory_owner;
RESET ROLE;
SET LOCAL ROLE memory_owner;
CREATE TRIGGER monotonic_update BEFORE UPDATE ON memory_ops.identity_projection_heads FOR EACH ROW EXECUTE FUNCTION memory_ops.seoul_projection_monotonic_guard();
CREATE TRIGGER monotonic_update BEFORE UPDATE ON memory_ops.identity_projection_lifecycle FOR EACH ROW EXECUTE FUNCTION memory_ops.seoul_projection_monotonic_guard();
REVOKE CREATE ON SCHEMA memory_identity,memory_ops FROM memory_projection_owner;
RESET ROLE;
SET LOCAL ROLE memory_projection_owner;
REVOKE EXECUTE ON FUNCTION memory_ops.seoul_projection_monotonic_guard() FROM memory_owner;
RESET ROLE;
GRANT memory_owner,memory_projection_owner,memory_projection_caller TO CURRENT_USER WITH INHERIT FALSE,SET FALSE;
COMMIT;

-- INACTIVE LOCAL LEDGER. Explicit schema5 + head + pure snapshot validation only.
-- Owner-only structural snapshot fixtures; no materialization, dispatch or v6 marker.
BEGIN;
SET LOCAL ROLE memory_projection_owner;
DO $preflight$
DECLARE item record; target oid; approved oid[]; owner_id oid:='memory_owner'::regrole; code_id oid:='memory_projection_owner'::regrole;
  caller_id oid:='memory_projection_caller'::regrole; p jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR NOT pg_has_role(session_user,owner_id,'SET') OR NOT pg_has_role(session_user,code_id,'SET')
    OR has_schema_privilege(code_id,'memory_ops','CREATE') OR has_schema_privilege(code_id,'memory_identity','CREATE')
    OR EXISTS(SELECT 1 FROM pg_roles WHERE oid IN(owner_id,code_id,caller_id)
      AND(rolsuper OR rolinherit OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR to_regclass('memory_ops.identity_projection_snapshot_reservations') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='memory_ops' AND (p.proname LIKE 'projection_v3_ledger_%' OR p.proname LIKE 'projection_v3_snapshot_ledger_%'))
    OR EXISTS(SELECT 1 FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname<>session_user AND r.oid NOT IN(owner_id,code_id)
      AND (pg_has_role(r.oid,owner_id,'SET') OR pg_has_role(r.oid,owner_id,'USAGE') OR pg_has_role(r.oid,code_id,'SET') OR pg_has_role(r.oid,code_id,'USAGE'))) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
  END IF;
  FOR item IN SELECT c.* FROM pg_class c WHERE c.oid IN('memory_ops.identity_projection_fence'::regclass,
    'memory_ops.identity_projection_events'::regclass,'memory_ops.identity_projection_receipts'::regclass,
    'memory_ops.identity_projection_source_heads'::regclass,'memory_ops.identity_projection_heads'::regclass,
    'memory_ops.identity_projection_lifecycle'::regclass,'memory_ops.identity_projection_tombstones'::regclass) LOOP
    IF item.relowner<>owner_id OR NOT item.relrowsecurity OR NOT item.relforcerowsecurity
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(item.relacl,acldefault('r',item.relowner))) a
        WHERE a.grantee<>owner_id AND (a.grantee<>code_id OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')
          OR(item.relname='identity_projection_fence' AND a.privilege_type<>'SELECT')))
      OR EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE col.attrelid=item.oid AND a.grantee<>owner_id
        AND (a.grantee<>code_id OR a.is_grantable OR a.privilege_type<>'UPDATE' OR NOT(
          (item.relname='identity_projection_fence' AND col.attname='id') OR(item.relname='identity_projection_heads' AND col.attname='source_revision')
          OR(item.relname='identity_projection_lifecycle' AND col.attname IN('source_revision','state','occurred_at_ms'))))) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
    END IF;
    IF(SELECT count(*) FROM pg_policy WHERE polrelid=item.oid)<>(CASE WHEN item.relname IN('identity_projection_heads','identity_projection_lifecycle') THEN 4 ELSE 3 END)
      OR EXISTS(SELECT 1 FROM pg_policy q WHERE q.polrelid=item.oid AND(NOT q.polpermissive OR NOT coalesce(
        (q.polname='migration_owner' AND q.polcmd='*' AND q.polroles=ARRAY[owner_id] AND pg_get_expr(q.polqual,q.polrelid)='true' AND pg_get_expr(q.polwithcheck,q.polrelid)='true')
        OR(q.polname='projection_owner_select' AND q.polcmd='r' AND q.polroles=ARRAY[code_id] AND pg_get_expr(q.polqual,q.polrelid)='true' AND q.polwithcheck IS NULL)
        OR(q.polname='projection_owner_insert' AND item.relname<>'identity_projection_fence' AND q.polcmd='a' AND q.polroles=ARRAY[code_id] AND q.polqual IS NULL AND pg_get_expr(q.polwithcheck,q.polrelid)='true')
        OR(q.polname='projection_owner_update' AND item.relname IN('identity_projection_fence','identity_projection_heads','identity_projection_lifecycle') AND q.polcmd='w' AND q.polroles=ARRAY[code_id]
          AND pg_get_expr(q.polqual,q.polrelid)=CASE WHEN item.relname='identity_projection_fence' THEN '(id = 1)' ELSE 'true' END
          AND pg_get_expr(q.polwithcheck,q.polrelid)=CASE WHEN item.relname='identity_projection_fence' THEN '(id = 1)' ELSE 'true' END),false))) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
    END IF;
  END LOOP;
  FOR item IN SELECT p.* FROM pg_proc p WHERE p.oid IN('memory_identity.seoul_projection_apply(text,text)'::regprocedure,
    'memory_ops.seoul_projection_status(text,text)'::regprocedure,'memory_identity.seoul_projection_head_canonical(jsonb)'::regprocedure,
    'memory_ops.seoul_projection_monotonic_guard()'::regprocedure,'memory_identity.projection_v3_snapshot_utf16(text)'::regprocedure,
    'memory_identity.projection_v3_snapshot_value(jsonb,text,bigint)'::regprocedure,'memory_identity.projection_v3_snapshot_graph(jsonb)'::regprocedure,
    'memory_identity.projection_v3_snapshot_canonical(text)'::regprocedure) LOOP
    approved:=CASE WHEN item.proname IN('seoul_projection_apply','seoul_projection_status') THEN ARRAY[code_id,caller_id] ELSE ARRAY[code_id] END;
    IF item.proowner<>code_id OR EXISTS(SELECT 1 FROM aclexplode(coalesce(item.proacl,acldefault('f',item.proowner))) a
      WHERE NOT(a.grantee=ANY(approved)) OR a.privilege_type<>'EXECUTE' OR(a.grantee<>code_id AND a.is_grantable)) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_events e LEFT JOIN memory_ops.identity_projection_receipts r USING(transport_event_id)
    WHERE r.attempt_no IS NULL OR r.attempt_no<>1) THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  FOR item IN SELECT * FROM memory_ops.identity_projection_events LOOP
    p:=item.payload_text::jsonb;
    IF memory_identity.seoul_projection_head_canonical(p) IS DISTINCT FROM item.payload_text OR p->>'eventId'<>item.transport_event_id::text
      OR(p->>'sourceRevision')::bigint<>item.source_revision THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
END
$preflight$;
SET LOCAL ROLE memory_owner;
ALTER TABLE memory_ops.identity_projection_events ADD COLUMN event_kind text NOT NULL DEFAULT 'head',ADD COLUMN space_id text,ADD COLUMN snapshot_seq bigint,
  ADD CONSTRAINT projection_events_kind_shape_ck CHECK((event_kind='head' AND space_id IS NULL AND snapshot_seq IS NULL)
    OR(event_kind='snapshot' AND space_id IS NOT NULL AND space_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND snapshot_seq IS NOT NULL AND snapshot_seq BETWEEN 1 AND 9007199254740991)),
  ADD CONSTRAINT projection_events_id_kind_uq UNIQUE(transport_event_id,event_kind),
  ADD CONSTRAINT projection_events_id_space_seq_uq UNIQUE(transport_event_id,space_id,snapshot_seq);
DO $checks$
DECLARE c record; found_count integer:=0;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='memory_ops.identity_projection_receipts'::regclass AND contype='c'
    AND(conkey=ARRAY[2]::smallint[] OR conkey=ARRAY[3]::smallint[] OR conkey=ARRAY[3,4]::smallint[]) LOOP
    EXECUTE format('ALTER TABLE memory_ops.identity_projection_receipts DROP CONSTRAINT %I',c.conname);found_count:=found_count+1;
  END LOOP;
  IF found_count<>3 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
END
$checks$;
ALTER TABLE memory_ops.identity_projection_receipts ALTER COLUMN attempt_no TYPE bigint,
  ADD CONSTRAINT projection_receipts_attempt_range_ck CHECK(attempt_no BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT projection_receipts_outcome_ck CHECK(outcome IN('applied','dependency_pending','snapshot_superseded','head_superseded','conflict'));
CREATE UNIQUE INDEX projection_receipts_terminal_uq ON memory_ops.identity_projection_receipts(transport_event_id) WHERE outcome<>'dependency_pending';
CREATE TABLE memory_ops.identity_projection_snapshot_reservations(
  space_id text NOT NULL CHECK(space_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  snapshot_seq bigint NOT NULL CHECK(snapshot_seq BETWEEN 1 AND 9007199254740991),transport_event_id uuid NOT NULL,
  CONSTRAINT projection_reservations_pk PRIMARY KEY(space_id,snapshot_seq),
  CONSTRAINT projection_reservations_event_uq UNIQUE(transport_event_id),
  CONSTRAINT projection_reservations_generation_uq UNIQUE(space_id,snapshot_seq,transport_event_id),
  CONSTRAINT projection_reservations_event_fk FOREIGN KEY(transport_event_id,space_id,snapshot_seq)
    REFERENCES memory_ops.identity_projection_events(transport_event_id,space_id,snapshot_seq)
);
ALTER TABLE memory_ops.identity_projection_snapshot_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ops.identity_projection_snapshot_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_owner ON memory_ops.identity_projection_snapshot_reservations TO memory_owner USING(true) WITH CHECK(true);
CREATE POLICY ledger_projection_select ON memory_ops.identity_projection_snapshot_reservations FOR SELECT TO memory_projection_owner USING(true);
CREATE POLICY ledger_projection_insert ON memory_ops.identity_projection_snapshot_reservations FOR INSERT TO memory_projection_owner WITH CHECK(true);
GRANT SELECT,INSERT ON memory_ops.identity_projection_snapshot_reservations TO memory_projection_owner;
GRANT CREATE ON SCHEMA memory_ops,memory_identity TO memory_projection_owner;
RESET ROLE;
SET LOCAL ROLE memory_projection_owner;

CREATE FUNCTION memory_ops.projection_v3_ledger_insert_fence() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fence$
BEGIN
  IF current_user<>'memory_projection_owner' OR current_setting('transaction_isolation')<>'read committed' OR TG_OP<>'INSERT'
    OR TG_TABLE_SCHEMA<>'memory_ops' OR TG_TABLE_NAME NOT IN('identity_projection_events','identity_projection_receipts','identity_projection_snapshot_reservations','identity_projection_source_heads') THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
  END IF;
  PERFORM id FROM memory_ops.identity_projection_fence WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  RETURN NULL;
END
$fence$;
CREATE FUNCTION memory_ops.projection_v3_ledger_event_insert() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $event$
DECLARE p jsonb; canonical text;
BEGIN
  BEGIN
    IF NEW.payload_text IS NULL OR octet_length(NEW.payload_text) NOT BETWEEN 1 AND 131072 OR NEW.transport_payload_sha256 IS NULL
      OR NEW.transport_payload_sha256 COLLATE "C" !~ '^[0-9a-f]{64}$'
      OR encode(sha256(convert_to(NEW.payload_text,'UTF8')),'hex')<>NEW.transport_payload_sha256 THEN RAISE EXCEPTION 'invalid'; END IF;
    p:=NEW.payload_text::jsonb;
    IF NEW.event_kind='head' THEN canonical:=memory_identity.seoul_projection_head_canonical(p);
      IF NEW.space_id IS NOT NULL OR NEW.snapshot_seq IS NOT NULL THEN RAISE EXCEPTION 'invalid'; END IF;
    ELSIF NEW.event_kind='snapshot' THEN canonical:=memory_identity.projection_v3_snapshot_canonical(NEW.payload_text);
      IF NEW.space_id IS DISTINCT FROM p->>'spaceId' OR NEW.snapshot_seq IS DISTINCT FROM(p->>'snapshotSeq')::bigint THEN RAISE EXCEPTION 'invalid'; END IF;
    ELSE RAISE EXCEPTION 'invalid'; END IF;
    IF canonical COLLATE "C" IS DISTINCT FROM NEW.payload_text COLLATE "C" OR NEW.transport_event_id IS DISTINCT FROM(p->>'eventId')::uuid
      OR NEW.source_revision IS DISTINCT FROM(p->>'sourceRevision')::bigint OR NEW.received_at_ms IS NULL
      OR NEW.received_at_ms NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'invalid'; END IF;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END;
  IF NEW.event_kind='snapshot' AND EXISTS(SELECT 1 FROM memory_ops.identity_projection_source_heads WHERE source_event_id=NEW.transport_event_id) THEN
    RAISE EXCEPTION USING ERRCODE='PP002',MESSAGE='seoul_projection_event_conflict';
  END IF;
  RETURN NEW;
END
$event$;
CREATE FUNCTION memory_ops.projection_v3_ledger_source_insert() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $source$
BEGIN
  IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_events WHERE transport_event_id=NEW.source_event_id AND event_kind='snapshot') THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
  END IF;RETURN NEW;
END
$source$;
CREATE FUNCTION memory_ops.projection_v3_ledger_reservation_insert() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $reservation$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_events WHERE transport_event_id=NEW.transport_event_id AND event_kind='snapshot'
    AND space_id=NEW.space_id AND snapshot_seq=NEW.snapshot_seq) THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  RETURN NEW;
END
$reservation$;

CREATE FUNCTION memory_ops.projection_v3_snapshot_ledger_begin(p_raw text,p_transport_sha256 text)
RETURNS TABLE(transport_event_id uuid,next_attempt_no bigint,required_reason text,replay_receipt_text text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $begin$
DECLARE p jsonb; e memory_ops.identity_projection_events%ROWTYPE; latest memory_ops.identity_projection_receipts%ROWTYPE;
  candidate_id uuid; winner uuid; alias_id uuid; last_no bigint; at_ms bigint; source_alias boolean;
BEGIN
  BEGIN
    IF p_raw IS NULL OR p_transport_sha256 IS NULL OR octet_length(p_raw) NOT BETWEEN 1 AND 131072
      OR p_transport_sha256 COLLATE "C" !~ '^[0-9a-f]{64}$' OR encode(sha256(convert_to(p_raw,'UTF8')),'hex')<>p_transport_sha256 THEN RAISE EXCEPTION 'invalid'; END IF;
    PERFORM memory_identity.projection_v3_snapshot_canonical(p_raw);p:=p_raw::jsonb;candidate_id:=(p->>'eventId')::uuid;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  PERFORM id FROM memory_ops.identity_projection_fence WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO e FROM memory_ops.identity_projection_events x WHERE x.transport_event_id=candidate_id;
  IF FOUND THEN
    IF e.transport_payload_sha256<>p_transport_sha256 OR e.payload_text COLLATE "C"<>p_raw COLLATE "C" THEN
      RAISE EXCEPTION USING ERRCODE='PP002',MESSAGE='seoul_projection_event_conflict'; END IF;
    IF e.event_kind<>'snapshot' OR e.space_id<>p->>'spaceId' OR e.snapshot_seq<>(p->>'snapshotSeq')::bigint OR e.source_revision<>(p->>'sourceRevision')::bigint
      OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts x WHERE x.transport_event_id=candidate_id AND x.attempt_no=1) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    SELECT * INTO latest FROM memory_ops.identity_projection_receipts x WHERE x.transport_event_id=candidate_id ORDER BY x.attempt_no DESC LIMIT 1;
    IF latest.outcome<>'dependency_pending' THEN RETURN QUERY SELECT candidate_id,NULL::bigint,NULL::text,latest.receipt_text;RETURN; END IF;
    IF latest.attempt_no>=9007199254740991 OR EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts x WHERE x.transport_event_id=candidate_id AND x.outcome<>'dependency_pending') THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    last_no:=latest.attempt_no+1;
  ELSE
    IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_source_heads WHERE source_event_id=candidate_id) THEN
      RAISE EXCEPTION USING ERRCODE='PP002',MESSAGE='seoul_projection_event_conflict'; END IF;
    at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
    INSERT INTO memory_ops.identity_projection_events(transport_event_id,transport_payload_sha256,payload_text,source_revision,received_at_ms,event_kind,space_id,snapshot_seq)
      VALUES(candidate_id,p_transport_sha256,p_raw,(p->>'sourceRevision')::bigint,at_ms,'snapshot',p->>'spaceId',(p->>'snapshotSeq')::bigint);
    last_no:=1;
  END IF;
  SELECT x.transport_event_id INTO winner FROM memory_ops.identity_projection_snapshot_reservations x WHERE x.space_id=p->>'spaceId' AND x.snapshot_seq=(p->>'snapshotSeq')::bigint;
  IF NOT FOUND THEN
    IF last_no<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    INSERT INTO memory_ops.identity_projection_snapshot_reservations(space_id,snapshot_seq,transport_event_id) VALUES(p->>'spaceId',(p->>'snapshotSeq')::bigint,candidate_id);winner:=candidate_id;
  END IF;
  IF winner<>candidate_id THEN RETURN QUERY SELECT candidate_id,last_no,'snapshot_sequence_conflict'::text,NULL::text;RETURN; END IF;
  source_alias:=false;
  FOR alias_id IN SELECT DISTINCT(h.v->>'eventId')::uuid FROM jsonb_array_elements(p->'grants') g(v)
    CROSS JOIN LATERAL jsonb_array_elements(g.v->'heads'->'subjects'||CASE WHEN g.v->'heads'->'emails'='null'::jsonb THEN '[]'::jsonb ELSE g.v->'heads'->'emails' END
      ||jsonb_build_array(g.v->'heads'->'organization',g.v->'heads'->'membership',g.v->'heads'->'credential',g.v->'heads'->'space',g.v->'heads'->'target')) h(v)
    WHERE h.v<>'null'::jsonb LOOP
    IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_events x WHERE x.transport_event_id=alias_id AND x.event_kind='snapshot') THEN source_alias:=true;EXIT; END IF;
  END LOOP;
  RETURN QUERY SELECT candidate_id,last_no,CASE WHEN source_alias THEN 'source_identity_conflict'::text ELSE NULL::text END,NULL::text;
END
$begin$;

CREATE FUNCTION memory_ops.projection_v3_ledger_receipt_insert() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $receipt$
DECLARE e memory_ops.identity_projection_events%ROWTYPE; latest memory_ops.identity_projection_receipts%ROWTYPE;
  p jsonb; r jsonb; source memory_ops.identity_projection_source_heads%ROWTYPE; winner uuid; alias_id uuid; source_alias boolean;
  at_ms bigint; issued bigint; expiry bigint; positive boolean; expired boolean; future boolean; grants_live boolean; expected_outcome text;
  canonical text; head_text text:=''; lease_text text:='null'; seq_text text:='null'; space_text text:='null';
BEGIN
  SELECT * INTO e FROM memory_ops.identity_projection_events WHERE transport_event_id=NEW.transport_event_id;
  IF NOT FOUND OR NEW.attempt_no IS NULL OR NEW.attempt_no NOT BETWEEN 1 AND 9007199254740991 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO latest FROM memory_ops.identity_projection_receipts WHERE transport_event_id=NEW.transport_event_id ORDER BY attempt_no DESC LIMIT 1;
  IF FOUND THEN
    IF latest.outcome<>'dependency_pending' OR latest.attempt_no>=9007199254740991 OR NEW.attempt_no<>latest.attempt_no+1
      OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts WHERE transport_event_id=NEW.transport_event_id AND attempt_no=1)
      OR EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts WHERE transport_event_id=NEW.transport_event_id AND outcome<>'dependency_pending') THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  ELSIF NEW.attempt_no<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  p:=e.payload_text::jsonb;
  IF e.event_kind='snapshot' THEN
    IF NEW.receipt_text IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    expected_outcome:=CASE
      WHEN NEW.reason IN('snapshot_applied','empty_snapshot_applied') THEN 'applied'
      WHEN NEW.reason IN('dependency_head_missing','dependency_head_behind','provisioning_missing','retained_row_disposition_missing') THEN 'dependency_pending'
      WHEN NEW.reason IN('newer_snapshot_present','newer_dependency_present','terminal_identity_denied','lifecycle_denied','target_deselected','lease_expired','lease_issued_in_future','authority_expired') THEN 'snapshot_superseded'
      WHEN NEW.reason IN('snapshot_sequence_conflict','source_identity_conflict','immutable_entity_conflict','provisioning_conflict','retained_row_disposition_conflict') THEN 'conflict' ELSE NULL END;
    IF expected_outcome IS NULL OR NEW.outcome IS DISTINCT FROM expected_outcome THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    PERFORM memory_identity.projection_v3_snapshot_canonical(e.payload_text);
    IF e.space_id IS DISTINCT FROM p->>'spaceId' OR e.snapshot_seq IS DISTINCT FROM(p->>'snapshotSeq')::bigint OR e.source_revision IS DISTINCT FROM(p->>'sourceRevision')::bigint
      OR e.transport_event_id IS DISTINCT FROM(p->>'eventId')::uuid OR e.transport_payload_sha256<>encode(sha256(convert_to(e.payload_text,'UTF8')),'hex') THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    SELECT transport_event_id INTO winner FROM memory_ops.identity_projection_snapshot_reservations WHERE space_id=e.space_id AND snapshot_seq=e.snapshot_seq;
    IF NOT FOUND OR(winner<>e.transport_event_id AND NEW.reason<>'snapshot_sequence_conflict') OR(winner=e.transport_event_id AND NEW.reason='snapshot_sequence_conflict') THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    source_alias:=false;
    FOR alias_id IN SELECT DISTINCT(h.v->>'eventId')::uuid FROM jsonb_array_elements(p->'grants') g(v)
      CROSS JOIN LATERAL jsonb_array_elements(g.v->'heads'->'subjects'||CASE WHEN g.v->'heads'->'emails'='null'::jsonb THEN '[]'::jsonb ELSE g.v->'heads'->'emails' END
        ||jsonb_build_array(g.v->'heads'->'organization',g.v->'heads'->'membership',g.v->'heads'->'credential',g.v->'heads'->'space',g.v->'heads'->'target')) h(v)
      WHERE h.v<>'null'::jsonb LOOP
      IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_events x WHERE x.transport_event_id=alias_id AND x.event_kind='snapshot') THEN source_alias:=true;EXIT; END IF;
    END LOOP;
    IF winner=e.transport_event_id AND source_alias AND NEW.reason<>'source_identity_conflict' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;issued:=(p->'lease'->>'issuedAtMs')::bigint;expiry:=(p->'lease'->>'expiresAtMs')::bigint;
    positive:=jsonb_array_length(p->'grants')>0;expired:=at_ms>=expiry;future:=issued>at_ms AND issued-at_ms>5000;
    SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'grants') g(v) WHERE(g.v->>'expiresAtMs')::bigint<=at_ms) INTO grants_live;
    IF at_ms NOT BETWEEN 0 AND 9007199254740991 OR (CASE NEW.reason
      WHEN 'snapshot_sequence_conflict' THEN false WHEN 'newer_snapshot_present' THEN false WHEN 'source_identity_conflict' THEN NOT positive
      WHEN 'lease_expired' THEN NOT expired WHEN 'lease_issued_in_future' THEN expired OR NOT future
      WHEN 'authority_expired' THEN NOT positive OR expired OR future OR grants_live
      WHEN 'empty_snapshot_applied' THEN positive OR expired OR future
      ELSE NOT positive OR p->'selected'<>'true'::jsonb OR expired OR future OR NOT grants_live END) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    IF NEW.outcome='applied' THEN lease_text:=expiry::text; END IF;space_text:=to_json(e.space_id)::text;seq_text:=e.snapshot_seq::text;
  ELSIF e.event_kind='head' THEN
    BEGIN
      IF NEW.attempt_no<>1 OR NEW.receipt_text IS NULL OR octet_length(NEW.receipt_text)>16384 THEN RAISE EXCEPTION 'invalid'; END IF;
      r:=NEW.receipt_text::jsonb;at_ms:=(r->>'attemptedAtMs')::bigint;
      IF at_ms<>e.received_at_ms OR at_ms NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'invalid'; END IF;
      SELECT s.* INTO source FROM memory_ops.identity_projection_heads h JOIN memory_ops.identity_projection_source_heads s USING(source_revision)
        WHERE h.kind=p->'head'->>'kind' AND h.stream_key=p->'head'->>'key';
      IF FOUND THEN head_text:='{"kind":'||to_json(source.kind)::text||',"key":'||to_json(source.stream_key)::text||',"revision":'||source.source_revision::text
        ||',"eventId":'||to_json(source.source_event_id::text)::text||',"payloadSha256":'||to_json(source.source_sha256)::text||'}'; END IF;
      IF NOT coalesce((NEW.outcome='applied' AND NEW.reason IN('head_applied','head_already_current') AND source.source_revision=e.source_revision
          AND source.source_event_id=(p->'head'->>'eventId')::uuid AND source.source_sha256=p->'head'->>'payloadSha256')
        OR(NEW.outcome='head_superseded' AND NEW.reason='newer_head_present' AND source.source_revision>e.source_revision)
        OR(NEW.outcome='conflict' AND NEW.reason='source_identity_conflict'),false) THEN RAISE EXCEPTION 'invalid'; END IF;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END;
  ELSE RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  canonical:='{"version":3,"kind":"seoul-projection-receipt","eventId":'||to_json(e.transport_event_id::text)::text
    ||',"transportPayloadSha256":'||to_json(e.transport_payload_sha256)::text||',"sourceRevision":'||e.source_revision::text
    ||',"eventKind":'||to_json(e.event_kind)::text||',"spaceId":'||space_text||',"snapshotSeq":'||seq_text||',"attemptNo":'||NEW.attempt_no::text
    ||',"outcome":'||to_json(NEW.outcome)::text||',"reason":'||to_json(NEW.reason)::text||',"currentHeads":['||head_text
    ||'],"leaseExpiresAtMs":'||lease_text||',"attemptedAtMs":'||at_ms::text||'}';
  IF canonical IS NULL OR octet_length(canonical)>16384 OR(e.event_kind='head' AND canonical COLLATE "C"<>NEW.receipt_text COLLATE "C") THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  NEW.receipt_text:=canonical;RETURN NEW;
END
$receipt$;

CREATE FUNCTION memory_ops.projection_v3_snapshot_ledger_live(p_transport_event_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $live$
DECLARE p jsonb; at_ms bigint; issued bigint; expiry bigint;
BEGIN
  SELECT payload_text::jsonb INTO p FROM memory_ops.identity_projection_events WHERE transport_event_id=p_transport_event_id AND event_kind='snapshot';
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts WHERE transport_event_id=p_transport_event_id AND outcome='applied') THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;issued:=(p->'lease'->>'issuedAtMs')::bigint;expiry:=(p->'lease'->>'expiresAtMs')::bigint;
  IF at_ms NOT BETWEEN 0 AND 9007199254740991 OR at_ms>=expiry OR(issued>at_ms AND issued-at_ms>5000)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'grants') g(v) WHERE(g.v->>'expiresAtMs')::bigint<=at_ms) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
END
$live$;
CREATE FUNCTION memory_ops.projection_v3_snapshot_ledger_append(p_transport_event_id uuid,p_transport_sha256 text,p_expected_attempt_no bigint,p_outcome text,p_reason text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $append$
DECLARE receipt text;
BEGIN
  IF p_transport_event_id IS NULL OR p_transport_sha256 IS NULL OR p_transport_sha256 COLLATE "C" !~ '^[0-9a-f]{64}$'
    OR p_expected_attempt_no IS NULL OR p_expected_attempt_no NOT BETWEEN 1 AND 9007199254740991 OR p_outcome IS NULL OR p_reason IS NULL
    OR octet_length(p_outcome)>32 OR octet_length(p_reason)>64 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  PERFORM id FROM memory_ops.identity_projection_fence WHERE id=1 FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_events WHERE transport_event_id=p_transport_event_id AND event_kind='snapshot' AND transport_payload_sha256=p_transport_sha256) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  INSERT INTO memory_ops.identity_projection_receipts(transport_event_id,attempt_no,outcome,reason,receipt_text)
    VALUES(p_transport_event_id,p_expected_attempt_no,p_outcome,p_reason,NULL) RETURNING receipt_text INTO receipt;
  IF p_outcome='applied' THEN PERFORM memory_ops.projection_v3_snapshot_ledger_live(p_transport_event_id); END IF;
  RETURN receipt;
END
$append$;
CREATE FUNCTION memory_ops.projection_v3_ledger_complete() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $complete$
DECLARE e memory_ops.identity_projection_events%ROWTYPE; first_receipt memory_ops.identity_projection_receipts%ROWTYPE; winner uuid;
BEGIN
  IF TG_OP<>'INSERT' OR TG_TABLE_SCHEMA<>'memory_ops' OR TG_TABLE_NAME NOT IN('identity_projection_events','identity_projection_receipts','identity_projection_snapshot_reservations') THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO e FROM memory_ops.identity_projection_events WHERE transport_event_id=NEW.transport_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO first_receipt FROM memory_ops.identity_projection_receipts WHERE transport_event_id=e.transport_event_id AND attempt_no=1;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF e.event_kind='snapshot' THEN
    SELECT transport_event_id INTO winner FROM memory_ops.identity_projection_snapshot_reservations WHERE space_id=e.space_id AND snapshot_seq=e.snapshot_seq;
    IF NOT FOUND OR(winner<>e.transport_event_id AND first_receipt.reason<>'snapshot_sequence_conflict') OR(winner=e.transport_event_id AND first_receipt.reason='snapshot_sequence_conflict') THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    IF TG_TABLE_NAME='identity_projection_receipts' THEN
      IF NEW.outcome='applied' THEN PERFORM memory_ops.projection_v3_snapshot_ledger_live(e.transport_event_id); END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$complete$;

CREATE OR REPLACE FUNCTION memory_identity.seoul_projection_apply(p_raw text,p_transport_sha256 text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $apply$
DECLARE p jsonb; h jsonb; e jsonb; canonical text; transport_id uuid; rev bigint; source_id uuid;
  source_kind text; source_key text; source_digest text; at_ms bigint; outcome_value text; reason_value text;
  bound memory_ops.identity_projection_events%ROWTYPE; source memory_ops.identity_projection_source_heads%ROWTYPE;
  current_source memory_ops.identity_projection_source_heads%ROWTYPE; receipt text; head_text text:=''; source_conflict boolean:=false;
BEGIN
  BEGIN
    IF p_raw IS NULL OR p_transport_sha256 IS NULL OR pg_catalog.octet_length(p_raw)>131072
      OR p_transport_sha256 COLLATE "C" !~ '^[0-9a-f]{64}$'
      OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_raw,'UTF8')),'hex')<>p_transport_sha256 THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    p:=p_raw::jsonb;canonical:=memory_identity.seoul_projection_head_canonical(p);
    IF canonical IS NULL OR canonical<>p_raw THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    transport_id:=(p->>'eventId')::uuid;rev:=(p->>'sourceRevision')::bigint;h:=p->'head';e:=p->'effect';
    source_id:=(h->>'eventId')::uuid;source_kind:=h->>'kind';source_key:=h->>'key';source_digest:=h->>'payloadSha256';
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  PERFORM id FROM memory_ops.identity_projection_fence WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO bound FROM memory_ops.identity_projection_events WHERE transport_event_id=transport_id;
  IF FOUND THEN
    IF bound.transport_payload_sha256<>p_transport_sha256 OR bound.payload_text<>p_raw THEN RAISE EXCEPTION USING ERRCODE='PP002',MESSAGE='seoul_projection_event_conflict'; END IF;
    SELECT receipt_text INTO receipt FROM memory_ops.identity_projection_receipts WHERE transport_event_id=transport_id AND attempt_no=1;
    IF receipt IS NULL THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;RETURN receipt;
  END IF;
  at_ms:=pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint;
  INSERT INTO memory_ops.identity_projection_events(transport_event_id,transport_payload_sha256,payload_text,source_revision,received_at_ms,event_kind,space_id,snapshot_seq)
    VALUES(transport_id,p_transport_sha256,p_raw,rev,at_ms,'head',NULL,NULL);
  SELECT EXISTS(SELECT 1 FROM memory_ops.identity_projection_events WHERE transport_event_id=source_id AND event_kind='snapshot') INTO source_conflict;
  FOR source IN SELECT * FROM memory_ops.identity_projection_source_heads WHERE source_revision=rev OR source_event_id=source_id LOOP
    IF source.source_revision<>rev OR source.source_event_id<>source_id OR source.kind<>source_kind OR source.stream_key<>source_key
      OR source.source_sha256<>source_digest OR source.effect<>e THEN source_conflict:=true; END IF;
  END LOOP;
  IF source_conflict THEN outcome_value:='conflict';reason_value:='source_identity_conflict';
  ELSE
    INSERT INTO memory_ops.identity_projection_source_heads VALUES(rev,source_id,source_kind,source_key,source_digest,e) ON CONFLICT(source_revision) DO NOTHING;
    IF(e->>'type'='subject-lifecycle' AND e->>'state'='deleted') OR(e->>'type'='entity-negative' AND source_kind IN('organization','space','membership','credential')) THEN
      INSERT INTO memory_ops.identity_projection_tombstones VALUES(source_kind,source_key,rev) ON CONFLICT(kind,stream_key) DO NOTHING;
    END IF;
    IF e->>'type' IN('subject-lifecycle','email-lifecycle') THEN
      INSERT INTO memory_ops.identity_projection_lifecycle VALUES(source_kind,source_key,rev,e->>'state',(e->>'occurredAtMs')::bigint)
      ON CONFLICT(kind,stream_key) DO UPDATE SET source_revision=EXCLUDED.source_revision,state=EXCLUDED.state,occurred_at_ms=EXCLUDED.occurred_at_ms
        WHERE memory_ops.identity_projection_lifecycle.source_revision<EXCLUDED.source_revision;
    END IF;
    SELECT s.* INTO current_source FROM memory_ops.identity_projection_heads c JOIN memory_ops.identity_projection_source_heads s ON s.source_revision=c.source_revision
      WHERE c.kind=source_kind AND c.stream_key=source_key;
    IF NOT FOUND OR current_source.source_revision<rev THEN
      INSERT INTO memory_ops.identity_projection_heads VALUES(source_kind,source_key,rev) ON CONFLICT(kind,stream_key) DO UPDATE SET source_revision=EXCLUDED.source_revision;
      outcome_value:='applied';reason_value:='head_applied';
    ELSIF current_source.source_revision=rev THEN outcome_value:='applied';reason_value:='head_already_current';
    ELSE outcome_value:='head_superseded';reason_value:='newer_head_present'; END IF;
  END IF;
  SELECT s.* INTO current_source FROM memory_ops.identity_projection_heads c JOIN memory_ops.identity_projection_source_heads s ON s.source_revision=c.source_revision
    WHERE c.kind=source_kind AND c.stream_key=source_key;
  IF FOUND THEN head_text:='{"kind":'||pg_catalog.to_json(current_source.kind)::text||',"key":'||pg_catalog.to_json(current_source.stream_key)::text
    ||',"revision":'||current_source.source_revision::text||',"eventId":'||pg_catalog.to_json(current_source.source_event_id::text)::text
    ||',"payloadSha256":'||pg_catalog.to_json(current_source.source_sha256)::text||'}'; END IF;
  receipt:='{"version":3,"kind":"seoul-projection-receipt","eventId":'||pg_catalog.to_json(transport_id::text)::text
    ||',"transportPayloadSha256":'||pg_catalog.to_json(p_transport_sha256)::text||',"sourceRevision":'||rev::text
    ||',"eventKind":"head","spaceId":null,"snapshotSeq":null,"attemptNo":1,"outcome":'||pg_catalog.to_json(outcome_value)::text
    ||',"reason":'||pg_catalog.to_json(reason_value)::text||',"currentHeads":['||head_text||'],"leaseExpiresAtMs":null,"attemptedAtMs":'||at_ms::text||'}';
  INSERT INTO memory_ops.identity_projection_receipts(transport_event_id,attempt_no,outcome,reason,receipt_text) VALUES(transport_id,1,outcome_value,reason_value,receipt);
  RETURN receipt;
END
$apply$;
CREATE OR REPLACE FUNCTION memory_ops.seoul_projection_status(p_event_id text,p_transport_sha256 text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $status$
DECLARE receipt text;
BEGIN
  IF p_event_id IS NULL OR p_event_id COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR p_transport_sha256 IS NULL OR p_transport_sha256 COLLATE "C" !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='PP003',MESSAGE='seoul_projection_receipt_absent'; END IF;
  SELECT r.receipt_text INTO receipt FROM memory_ops.identity_projection_events e JOIN memory_ops.identity_projection_receipts r USING(transport_event_id)
    WHERE e.transport_event_id=p_event_id::uuid AND e.transport_payload_sha256=p_transport_sha256 ORDER BY r.attempt_no DESC LIMIT 1;
  IF receipt IS NULL THEN RAISE EXCEPTION USING ERRCODE='PP003',MESSAGE='seoul_projection_receipt_absent'; END IF;RETURN receipt;
END
$status$;

-- New function objects only. Explicitly remove PUBLIC and every actual retained
-- default grantee; RESTRICT aborts rather than cleaning a dependent grant chain.
DO $function_acls$
DECLARE item record; grantee record;
BEGIN
  FOR item IN SELECT p.oid,p.proowner,p.proacl,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='memory_ops' AND p.proname IN('projection_v3_ledger_insert_fence','projection_v3_ledger_event_insert','projection_v3_ledger_source_insert',
      'projection_v3_ledger_reservation_insert','projection_v3_ledger_receipt_insert','projection_v3_ledger_complete',
      'projection_v3_snapshot_ledger_live','projection_v3_snapshot_ledger_begin','projection_v3_snapshot_ledger_append') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC RESTRICT',item.signature);
    FOR grantee IN SELECT DISTINCT r.rolname FROM aclexplode(coalesce(item.proacl,acldefault('f',item.proowner))) a JOIN pg_roles r ON r.oid=a.grantee WHERE a.grantee<>item.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I RESTRICT',item.signature,grantee.rolname);
    END LOOP;
  END LOOP;
END
$function_acls$;
GRANT EXECUTE ON FUNCTION memory_ops.projection_v3_ledger_insert_fence(),memory_ops.projection_v3_ledger_event_insert(),
  memory_ops.projection_v3_ledger_source_insert(),memory_ops.projection_v3_ledger_reservation_insert(),memory_ops.projection_v3_ledger_receipt_insert(),
  memory_ops.projection_v3_ledger_complete() TO memory_owner;
RESET ROLE;
SET LOCAL ROLE memory_owner;
DO $table_acl$
DECLARE grantee record; row_type_acl aclitem[];
BEGIN
  REVOKE ALL ON memory_ops.identity_projection_snapshot_reservations FROM PUBLIC;
  FOR grantee IN SELECT DISTINCT r.rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    JOIN pg_roles r ON r.oid=a.grantee WHERE c.oid='memory_ops.identity_projection_snapshot_reservations'::regclass AND a.grantee<>c.relowner LOOP
    EXECUTE format('REVOKE ALL ON memory_ops.identity_projection_snapshot_reservations FROM %I RESTRICT',grantee.rolname);
  END LOOP;
  SELECT t.typacl INTO row_type_acl FROM pg_class c JOIN pg_type t ON t.oid=c.reltype WHERE c.oid='memory_ops.identity_projection_snapshot_reservations'::regclass;
  -- Actual table-generated row types do not inherit ALTER DEFAULT ... TYPES.
  -- Assert observed null ACL; no speculative GRANT/REVOKE ON TYPE is performed.
  IF row_type_acl IS NOT NULL OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='memory_ops.identity_projection_snapshot_reservations'::regclass AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
END
$table_acl$;
GRANT SELECT,INSERT ON memory_ops.identity_projection_snapshot_reservations TO memory_projection_owner;
CREATE TRIGGER ledger_insert_fence BEFORE INSERT ON memory_ops.identity_projection_events FOR EACH STATEMENT EXECUTE FUNCTION memory_ops.projection_v3_ledger_insert_fence();
CREATE TRIGGER ledger_insert_fence BEFORE INSERT ON memory_ops.identity_projection_receipts FOR EACH STATEMENT EXECUTE FUNCTION memory_ops.projection_v3_ledger_insert_fence();
CREATE TRIGGER ledger_insert_fence BEFORE INSERT ON memory_ops.identity_projection_snapshot_reservations FOR EACH STATEMENT EXECUTE FUNCTION memory_ops.projection_v3_ledger_insert_fence();
CREATE TRIGGER ledger_insert_fence BEFORE INSERT ON memory_ops.identity_projection_source_heads FOR EACH STATEMENT EXECUTE FUNCTION memory_ops.projection_v3_ledger_insert_fence();
CREATE TRIGGER ledger_event_insert BEFORE INSERT ON memory_ops.identity_projection_events FOR EACH ROW EXECUTE FUNCTION memory_ops.projection_v3_ledger_event_insert();
CREATE TRIGGER ledger_receipt_insert BEFORE INSERT ON memory_ops.identity_projection_receipts FOR EACH ROW EXECUTE FUNCTION memory_ops.projection_v3_ledger_receipt_insert();
CREATE TRIGGER ledger_source_insert BEFORE INSERT ON memory_ops.identity_projection_source_heads FOR EACH ROW EXECUTE FUNCTION memory_ops.projection_v3_ledger_source_insert();
CREATE TRIGGER ledger_reservation_insert BEFORE INSERT ON memory_ops.identity_projection_snapshot_reservations FOR EACH ROW EXECUTE FUNCTION memory_ops.projection_v3_ledger_reservation_insert();
CREATE TRIGGER ledger_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON memory_ops.identity_projection_events FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER ledger_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON memory_ops.identity_projection_receipts FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER ledger_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON memory_ops.identity_projection_snapshot_reservations FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();
CREATE CONSTRAINT TRIGGER ledger_complete AFTER INSERT ON memory_ops.identity_projection_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_ops.projection_v3_ledger_complete();
CREATE CONSTRAINT TRIGGER ledger_complete AFTER INSERT ON memory_ops.identity_projection_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_ops.projection_v3_ledger_complete();
CREATE CONSTRAINT TRIGGER ledger_complete AFTER INSERT ON memory_ops.identity_projection_snapshot_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_ops.projection_v3_ledger_complete();
REVOKE CREATE ON SCHEMA memory_ops,memory_identity FROM memory_projection_owner;
RESET ROLE;
SET LOCAL ROLE memory_projection_owner;
REVOKE EXECUTE ON FUNCTION memory_ops.projection_v3_ledger_insert_fence(),memory_ops.projection_v3_ledger_event_insert(),
  memory_ops.projection_v3_ledger_source_insert(),memory_ops.projection_v3_ledger_reservation_insert(),memory_ops.projection_v3_ledger_receipt_insert(),
  memory_ops.projection_v3_ledger_complete() FROM memory_owner;
DO $postflight$
DECLARE code_id oid:='memory_projection_owner'::regrole; owner_id oid:='memory_owner'::regrole; count_functions integer;
BEGIN
  SELECT count(*) INTO count_functions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='memory_ops'
    AND(p.proname LIKE 'projection_v3_ledger_%' OR p.proname LIKE 'projection_v3_snapshot_ledger_%');
  IF count_functions<>9 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='memory_ops' AND(p.proname LIKE 'projection_v3_ledger_%' OR p.proname LIKE 'projection_v3_snapshot_ledger_%')
      AND(p.proowner<>code_id OR p.prosecdef<>(p.proname='projection_v3_ledger_complete') OR p.provolatile<>'v'
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] OR NOT has_function_privilege(code_id,p.oid,'EXECUTE')))
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='memory_ops'
      AND(p.proname LIKE 'projection_v3_ledger_%' OR p.proname LIKE 'projection_v3_snapshot_ledger_%')
      AND(p.proowner<>code_id OR a.grantee<>code_id OR a.privilege_type<>'EXECUTE'))
    OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid='memory_ops.identity_projection_snapshot_reservations'::regclass
      AND(c.relowner<>owner_id OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR(a.grantee<>owner_id
        AND(a.grantee<>code_id OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))))
    OR NOT has_table_privilege(code_id,'memory_ops.identity_projection_snapshot_reservations','SELECT')
    OR NOT has_table_privilege(code_id,'memory_ops.identity_projection_snapshot_reservations','INSERT')
    OR(SELECT count(*) FROM pg_policy WHERE polrelid='memory_ops.identity_projection_snapshot_reservations'::regclass)<>3
    OR EXISTS(SELECT 1 FROM pg_policy q WHERE q.polrelid='memory_ops.identity_projection_snapshot_reservations'::regclass AND(NOT q.polpermissive OR NOT coalesce(
      (q.polname='ledger_owner' AND q.polcmd='*' AND q.polroles=ARRAY[owner_id] AND pg_get_expr(q.polqual,q.polrelid)='true' AND pg_get_expr(q.polwithcheck,q.polrelid)='true')
      OR(q.polname='ledger_projection_select' AND q.polcmd='r' AND q.polroles=ARRAY[code_id] AND pg_get_expr(q.polqual,q.polrelid)='true' AND q.polwithcheck IS NULL)
      OR(q.polname='ledger_projection_insert' AND q.polcmd='a' AND q.polroles=ARRAY[code_id] AND q.polqual IS NULL AND pg_get_expr(q.polwithcheck,q.polrelid)='true'),false))) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
END
$postflight$;
RESET ROLE;
COMMIT;

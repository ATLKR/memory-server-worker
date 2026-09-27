-- INACTIVE LOCAL DISPATCH. Explicit schema5 + head + validation + ledger A +
-- facts B1 + materialization B2 drafts only; no authorizer change, no schema6
-- marker, no runtime login and no production setup value. The sole change is
-- that the existing caller apply entry routes an exact canonical snapshot
-- envelope to the owner-only materializer instead of rejecting it.
BEGIN;
SET LOCAL ROLE memory_projection_owner;
DO $preflight$
DECLARE item record; owner_id oid:='memory_owner'::regrole; code_id oid:='memory_projection_owner'::regrole;
  caller_id oid:='memory_projection_caller'::regrole; apply record;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR NOT pg_has_role(session_user,owner_id,'SET') OR NOT pg_has_role(session_user,code_id,'SET')
    OR has_schema_privilege(code_id,'memory_ops','CREATE') OR has_schema_privilege(code_id,'memory_identity','CREATE')
    OR EXISTS(SELECT 1 FROM pg_roles WHERE oid IN(owner_id,code_id,caller_id)
      AND(rolsuper OR rolinherit OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS(SELECT 1 FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname<>session_user AND r.oid NOT IN(owner_id,code_id)
      AND (pg_has_role(r.oid,owner_id,'SET') OR pg_has_role(r.oid,owner_id,'USAGE') OR pg_has_role(r.oid,code_id,'SET') OR pg_has_role(r.oid,code_id,'USAGE')))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN(code_id,caller_id))
    -- The sanctioned caller path is a NOINHERIT member that SET ROLEs first.
    -- Any non-provisioner role that can already USE the caller's privileges
    -- without SET, or hold ADMIN/INHERIT caller edges, is escalation surface.
    OR EXISTS(SELECT 1 FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname<>session_user AND r.oid NOT IN(owner_id,code_id,caller_id)
      AND pg_has_role(r.oid,caller_id,'USAGE'))
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE m.roleid=caller_id
      AND NOT r.rolsuper AND r.rolname<>session_user AND(m.admin_option OR m.inherit_option)) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
  END IF;
  -- The B2 materializer must already be installed before dispatch can route to
  -- it; to_regprocedure/to_regclass return NULL instead of throwing.
  IF to_regprocedure('memory_identity.projection_v3_snapshot_materialize(text,text)') IS NULL
    OR to_regprocedure('memory_identity.projection_v3_snapshot_classify(uuid)') IS NULL
    OR to_regprocedure('memory_identity.projection_v3_snapshot_materialization_assert(uuid,bigint)') IS NULL
    OR to_regprocedure('memory_identity.projection_v3_snapshot_plan(uuid)') IS NULL
    OR to_regprocedure('memory_identity.projection_v3_materialization_row()') IS NULL
    OR to_regprocedure('memory_identity.projection_v3_materialization_pointer()') IS NULL
    OR to_regprocedure('memory_identity.projection_v3_materialization_receipt()') IS NULL
    OR to_regprocedure('memory_identity.projection_v3_materialization_complete()') IS NULL
    OR to_regprocedure('memory_ops.projection_v3_materialization_insert_fence()') IS NULL
    OR to_regprocedure('memory_identity.seoul_projection_apply(text,text)') IS NULL
    OR to_regprocedure('memory_ops.seoul_projection_status(text,text)') IS NULL
    OR to_regclass('memory_ops.identity_projection_snapshot_generations') IS NULL
    OR to_regclass('memory_ops.identity_projection_space_state') IS NULL
    OR to_regclass('memory_identity.identity_projection_grants') IS NULL
    OR to_regclass('memory_identity.identity_projection_grant_heads') IS NULL
    OR to_regclass('memory_identity.identity_projection_source_facts') IS NULL
    OR to_regclass('memory_identity.identity_projection_mutable_fact_current') IS NULL
    OR to_regclass('memory_identity.identity_projection_entities') IS NULL
    OR to_regclass('memory_identity.identity_projection_provider_entities') IS NULL
    OR to_regclass('memory_identity.identity_projection_legacy_grant_entities') IS NULL
    OR to_regclass('memory_ops.identity_projection_snapshot_reservations') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
  END IF;
  FOR item IN SELECT p.* FROM pg_proc p WHERE p.oid IN(
    'memory_identity.projection_v3_snapshot_materialize(text,text)'::regprocedure,
    'memory_identity.projection_v3_snapshot_classify(uuid)'::regprocedure,
    'memory_identity.projection_v3_snapshot_materialization_assert(uuid,bigint)'::regprocedure,
    'memory_identity.projection_v3_snapshot_plan(uuid)'::regprocedure,
    'memory_identity.projection_v3_materialization_row()'::regprocedure,
    'memory_identity.projection_v3_materialization_pointer()'::regprocedure,
    'memory_identity.projection_v3_materialization_receipt()'::regprocedure,
    'memory_identity.projection_v3_materialization_complete()'::regprocedure,
    'memory_ops.projection_v3_materialization_insert_fence()'::regprocedure) LOOP
    IF item.proowner<>code_id OR item.provolatile<>'v' OR item.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
      OR item.prosecdef<>(item.proname IN('projection_v3_materialization_receipt','projection_v3_materialization_complete'))
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(item.proacl,acldefault('f',item.proowner))) a
        WHERE a.grantee<>code_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
    END IF;
  END LOOP;
  FOR item IN SELECT c.* FROM pg_class c WHERE c.oid IN('memory_ops.identity_projection_snapshot_generations'::regclass,
    'memory_ops.identity_projection_space_state'::regclass,'memory_identity.identity_projection_grants'::regclass,
    'memory_identity.identity_projection_grant_heads'::regclass,'memory_identity.identity_projection_source_facts'::regclass,
    'memory_identity.identity_projection_mutable_fact_current'::regclass,'memory_identity.identity_projection_entities'::regclass,
    'memory_identity.identity_projection_provider_entities'::regclass,'memory_identity.identity_projection_legacy_grant_entities'::regclass,
    'memory_ops.identity_projection_snapshot_reservations'::regclass) LOOP
    IF item.relowner<>owner_id OR NOT item.relrowsecurity OR NOT item.relforcerowsecurity THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
    END IF;
  END LOOP;
  -- The two caller entries must exist with the exact owner/caller EXECUTE pair,
  -- and apply must not already route snapshots (an explicit rerun is a fault).
  FOR item IN SELECT p.* FROM pg_proc p WHERE p.oid IN('memory_identity.seoul_projection_apply(text,text)'::regprocedure,
    'memory_ops.seoul_projection_status(text,text)'::regprocedure) LOOP
    IF item.proowner<>code_id OR NOT item.prosecdef OR item.provolatile<>'v'
      OR item.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(item.proacl,acldefault('f',item.proowner))) a
        WHERE a.grantee NOT IN(code_id,caller_id) OR a.privilege_type<>'EXECUTE' OR (a.grantee=caller_id AND a.is_grantable)) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
    END IF;
    IF item.proname='seoul_projection_apply' THEN apply:=item; END IF;
  END LOOP;
  IF apply.oid IS NULL OR position('seoul-authority-snapshot' IN apply.prosrc)>0 THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
  END IF;
END
$preflight$;
RESET ROLE;
SET LOCAL ROLE memory_owner;
-- Temporary CREATE so the projection owner can replace its own function; the
-- grant is removed before commit and re-verified by postflight.
GRANT CREATE ON SCHEMA memory_identity TO memory_projection_owner;
RESET ROLE;
SET LOCAL ROLE memory_projection_owner;

-- The head path below is byte-identical to the ledger's replacement. The only
-- addition is the snapshot-envelope branch: an exact canonical snapshot is
-- handed to the owner-only materializer, which re-runs its own byte, hash,
-- canonical, reservation, dependency, lease and receipt rules and returns the
-- stored receipt text. Malformed text/hash/JSON never leaves the inner block.
CREATE OR REPLACE FUNCTION memory_identity.seoul_projection_apply(p_raw text,p_transport_sha256 text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $apply$
DECLARE p jsonb; h jsonb; e jsonb; canonical text; transport_id uuid; rev bigint; source_id uuid;
  source_kind text; source_key text; source_digest text; at_ms bigint; outcome_value text; reason_value text;
  bound memory_ops.identity_projection_events%ROWTYPE; source memory_ops.identity_projection_source_heads%ROWTYPE;
  current_source memory_ops.identity_projection_source_heads%ROWTYPE; receipt text; head_text text:=''; source_conflict boolean:=false;
  snapshot_envelope boolean:=false;
BEGIN
  BEGIN
    IF p_raw IS NULL OR p_transport_sha256 IS NULL OR pg_catalog.octet_length(p_raw)>131072
      OR p_transport_sha256 COLLATE "C" !~ '^[0-9a-f]{64}$'
      OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_raw,'UTF8')),'hex')<>p_transport_sha256 THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    p:=p_raw::jsonb;
    IF p->>'kind'='seoul-authority-snapshot' THEN snapshot_envelope:=true;
    ELSE
      canonical:=memory_identity.seoul_projection_head_canonical(p);
      IF canonical IS NULL OR canonical<>p_raw THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      transport_id:=(p->>'eventId')::uuid;rev:=(p->>'sourceRevision')::bigint;h:=p->'head';e:=p->'effect';
      source_id:=(h->>'eventId')::uuid;source_kind:=h->>'kind';source_key:=h->>'key';source_digest:=h->>'payloadSha256';
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END;
  IF snapshot_envelope THEN RETURN memory_identity.projection_v3_snapshot_materialize(p_raw,p_transport_sha256); END IF;
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
RESET ROLE;
SET LOCAL ROLE memory_owner;
REVOKE CREATE ON SCHEMA memory_identity FROM memory_projection_owner;
RESET ROLE;
SET LOCAL ROLE memory_projection_owner;

DO $postflight$
DECLARE item record; owner_id oid:='memory_owner'::regrole; code_id oid:='memory_projection_owner'::regrole;
  caller_id oid:='memory_projection_caller'::regrole;
BEGIN
  FOR item IN SELECT p.* FROM pg_proc p WHERE p.oid IN('memory_identity.seoul_projection_apply(text,text)'::regprocedure,
    'memory_ops.seoul_projection_status(text,text)'::regprocedure) LOOP
    IF item.proowner<>code_id OR NOT item.prosecdef OR item.provolatile<>'v'
      OR item.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(item.proacl,acldefault('f',item.proowner))) a
        WHERE a.grantee NOT IN(code_id,caller_id) OR a.privilege_type<>'EXECUTE' OR (a.grantee=caller_id AND a.is_grantable)) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
    END IF;
  END LOOP;
  IF position('seoul-authority-snapshot' IN (SELECT prosrc FROM pg_proc WHERE oid='memory_identity.seoul_projection_apply(text,text)'::regprocedure))=0
    OR has_schema_privilege(code_id,'memory_identity','CREATE') OR has_schema_privilege(code_id,'memory_ops','CREATE')
    OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='memory_identity.projection_v3_snapshot_materialize(text,text)'::regprocedure
      AND(p.prosecdef OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>code_id))) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
  END IF;
END
$postflight$;
RESET ROLE;
COMMIT;

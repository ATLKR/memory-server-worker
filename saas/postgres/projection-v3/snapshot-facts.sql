-- INACTIVE LOCAL PURE HELPER. Requires the held head and snapshot validators.
-- The argument is caller-owned JSONB from an already validated canonical event.
BEGIN;
DO $preflight$
DECLARE code_id oid:='memory_projection_owner'::regrole;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'memory_owner','SET')
    OR NOT pg_catalog.pg_has_role(session_user,code_id,'SET')
    OR pg_catalog.has_schema_privilege(code_id,'memory_identity','CREATE')
    OR pg_catalog.to_regprocedure('memory_identity.projection_v3_snapshot_fact(jsonb,text,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('memory_identity.projection_v3_snapshot_value(jsonb,text,bigint)') IS NULL
    OR pg_catalog.to_regprocedure('memory_identity.projection_v3_snapshot_canonical(text)') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
  END IF;
END
$preflight$;
SET LOCAL ROLE memory_owner;
GRANT CREATE ON SCHEMA memory_identity TO memory_projection_owner;
SET LOCAL ROLE memory_projection_owner;

CREATE FUNCTION memory_identity.projection_v3_snapshot_fact(p_snapshot jsonb,p_kind text,p_stream_key text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fact$
DECLARE
  prefix constant text:=E'https://auth-api.allen.company\n';
  requested_subject text; address text; separator integer; rows jsonb; refs jsonb;
  mapping jsonb; g jsonb; h jsonb; prior_head jsonb; c jsonb; a jsonb; sp jsonb; m jsonb; e jsonb; o jsonb; policy jsonb;
  providers jsonb; source_rev bigint; found_reference boolean:=false;
BEGIN
  IF pg_catalog.jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR p_kind IS NULL OR p_stream_key IS NULL
    OR p_kind NOT IN('subject','email','organization','membership','credential','space') THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  -- The held narrow head validator supplies the exact key domain, including
  -- opaque UTF16 subjects and canonical ASCII mailboxes. This is not a source.
  PERFORM memory_identity.projection_v3_snapshot_value(pg_catalog.jsonb_build_object(
    'kind',p_kind,'key',p_stream_key,'revision',1,'eventId','00000000-0000-0000-0000-000000000001',
    'payloadSha256',pg_catalog.repeat('0',64)),'head',1);
  source_rev:=memory_identity.projection_v3_snapshot_value(p_snapshot->'sourceRevision','revision',NULL)::bigint;
  IF pg_catalog.jsonb_typeof(p_snapshot->'grants') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  IF p_kind IN('subject','email') THEN
    requested_subject:=pg_catalog.substr(p_stream_key,pg_catalog.length(prefix)+1);
    IF p_kind='email' THEN
      separator:=pg_catalog.length(requested_subject)-pg_catalog.strpos(pg_catalog.reverse(requested_subject),E'\n')+1;
      address:=pg_catalog.substr(requested_subject,separator+1);
      requested_subject:=pg_catalog.left(requested_subject,separator-1);
    END IF;
    SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(p_snapshot->'providerIdentities') x(v)
      WHERE v->>'issuer'='https://auth-api.allen.company' AND v->>'subject'=requested_subject;
    IF pg_catalog.jsonb_array_length(rows) IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    mapping:=rows->0;
    PERFORM memory_identity.projection_v3_snapshot_value(mapping,'provider',source_rev);
  END IF;

  -- Inspect only actual references to this requested stream and their local
  -- account/credential/Space and (when applicable) membership/email/org joins.
  -- No complete graph canonicalization, provider vector construction per head,
  -- relation read, clock, or authority check occurs here.
  FOR g IN SELECT v FROM pg_catalog.jsonb_array_elements(p_snapshot->'grants') x(v) LOOP
    IF p_kind IN('subject','email') THEN
      refs:=g->'heads'->(CASE p_kind WHEN 'subject' THEN 'subjects' ELSE 'emails' END);
      IF refs IS NULL OR refs='null'::jsonb THEN CONTINUE; END IF;
    ELSE
      h:=g->'heads'->p_kind;
      IF h IS NULL OR h='null'::jsonb THEN CONTINUE; END IF;
      refs:=pg_catalog.jsonb_build_array(h);
    END IF;
    SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(refs) x(v)
      WHERE v->>'kind'=p_kind AND v->>'key'=p_stream_key;
    IF rows IS NULL THEN CONTINUE; END IF;
    IF pg_catalog.jsonb_array_length(rows)<>1 THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    h:=rows->0;
    PERFORM memory_identity.projection_v3_snapshot_value(h,'head',source_rev);
    IF prior_head IS NOT NULL AND prior_head IS DISTINCT FROM h THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    prior_head:=h;found_reference:=true;
    SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(p_snapshot->'accounts') x(v) WHERE v->>'id'=g->>'accountId';
    IF pg_catalog.jsonb_array_length(rows) IS DISTINCT FROM 1 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    a:=rows->0;PERFORM memory_identity.projection_v3_snapshot_value(a,'account',source_rev);
    SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(p_snapshot->'credentials') x(v) WHERE v->>'id'=g->>'credentialId';
    IF pg_catalog.jsonb_array_length(rows) IS DISTINCT FROM 1 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    c:=rows->0;PERFORM memory_identity.projection_v3_snapshot_value(c,'credential',source_rev);
    SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(p_snapshot->'spaces') x(v) WHERE v->>'id'=g->>'spaceId';
    IF pg_catalog.jsonb_array_length(rows) IS DISTINCT FROM 1 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    sp:=rows->0;PERFORM memory_identity.projection_v3_snapshot_value(sp,'space',source_rev);
    IF c->>'accountId' IS DISTINCT FROM a->>'id' OR sp->>'id' IS DISTINCT FROM p_snapshot->>'spaceId'
      OR (sp->>'accountId' IS NULL)=(sp->>'organizationId' IS NULL)
      OR a->'disabledAtMs' IS DISTINCT FROM 'null'::jsonb OR c->'revokedAtMs' IS DISTINCT FROM 'null'::jsonb
      OR sp->'disabledAtMs' IS DISTINCT FROM 'null'::jsonb
      OR g->'heads'->'credential'->>'kind' IS DISTINCT FROM 'credential' OR g->'heads'->'credential'->>'key' IS DISTINCT FROM c->>'id'
      OR g->'heads'->'space'->>'kind' IS DISTINCT FROM 'space' OR g->'heads'->'space'->>'key' IS DISTINCT FROM sp->>'id' THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    IF c->>'kind'='personal_key' THEN
      IF c->'membershipId' IS DISTINCT FROM 'null'::jsonb OR c->'emailId' IS DISTINCT FROM 'null'::jsonb
        OR sp->>'accountId' IS DISTINCT FROM a->>'id' OR g->>'provenance' IS DISTINCT FROM 'owner'
        OR g->'heads'->'emails' IS DISTINCT FROM 'null'::jsonb OR g->'heads'->'organization' IS DISTINCT FROM 'null'::jsonb
        OR g->'heads'->'membership' IS DISTINCT FROM 'null'::jsonb OR p_kind IN('email','organization','membership') THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
    ELSE
      SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(p_snapshot->'memberships') x(v) WHERE v->>'id'=c->>'membershipId';
      IF pg_catalog.jsonb_array_length(rows) IS DISTINCT FROM 1 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      m:=rows->0;PERFORM memory_identity.projection_v3_snapshot_value(m,'membership',source_rev);
      SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(p_snapshot->'emails') x(v) WHERE v->>'id'=c->>'emailId';
      IF pg_catalog.jsonb_array_length(rows) IS DISTINCT FROM 1 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      e:=rows->0;PERFORM memory_identity.projection_v3_snapshot_value(e,'email',source_rev);
      SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(p_snapshot->'organizations') x(v) WHERE v->>'id'=sp->>'organizationId';
      IF pg_catalog.jsonb_array_length(rows) IS DISTINCT FROM 1 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      o:=rows->0;PERFORM memory_identity.projection_v3_snapshot_value(o,'account',source_rev);
      IF sp->'accountId' IS DISTINCT FROM 'null'::jsonb OR g->>'provenance' IS DISTINCT FROM 'organization-member'
        OR m->>'accountId' IS DISTINCT FROM a->>'id' OR e->>'accountId' IS DISTINCT FROM a->>'id'
        OR m->>'emailId' IS DISTINCT FROM e->>'id' OR m->>'organizationId' IS DISTINCT FROM o->>'id'
        OR m->'revokedAtMs' IS DISTINCT FROM 'null'::jsonb OR e->'revokedAtMs' IS DISTINCT FROM 'null'::jsonb OR o->'disabledAtMs' IS DISTINCT FROM 'null'::jsonb
        OR g->'heads'->'organization'->>'kind' IS DISTINCT FROM 'organization' OR g->'heads'->'organization'->>'key' IS DISTINCT FROM o->>'id'
        OR g->'heads'->'membership'->>'kind' IS DISTINCT FROM 'membership' OR g->'heads'->'membership'->>'key' IS DISTINCT FROM m->>'id' THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
    END IF;
    IF (p_kind IN('subject','email') AND mapping->>'accountId' IS DISTINCT FROM a->>'id')
      OR (p_kind='email' AND e->>'address' IS DISTINCT FROM address)
      OR (p_kind='organization' AND o->>'id' IS DISTINCT FROM p_stream_key)
      OR (p_kind='membership' AND m->>'id' IS DISTINCT FROM p_stream_key)
      OR (p_kind='credential' AND c->>'id' IS DISTINCT FROM p_stream_key)
      OR (p_kind='space' AND sp->>'id' IS DISTINCT FROM p_stream_key) THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
  END LOOP;
  IF NOT found_reference THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;

  CASE p_kind
    WHEN 'subject' THEN
      -- Filter with ordinality: a database collation sort would alter the held
      -- JavaScript UTF16 order for astral versus BMP subjects. Build once.
      SELECT pg_catalog.jsonb_agg(v ORDER BY ord) INTO providers
        FROM pg_catalog.jsonb_array_elements(p_snapshot->'providerIdentities') WITH ORDINALITY x(v,ord) WHERE v->>'accountId'=a->>'id';
      PERFORM memory_identity.projection_v3_snapshot_value(providers,'list:provider:131072:subject',source_rev);
      RETURN pg_catalog.jsonb_build_object('account',a,'providerIdentities',providers);
    WHEN 'email' THEN
      SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(p_snapshot->'emails') x(v)
        WHERE v->>'accountId'=mapping->>'accountId' AND v->>'address'=address;
      IF pg_catalog.jsonb_array_length(rows) IS DISTINCT FROM 1 OR rows->0 IS DISTINCT FROM e THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      RETURN pg_catalog.jsonb_build_object('email',e);
    WHEN 'organization' THEN RETURN pg_catalog.jsonb_build_object('organization',o);
    WHEN 'membership' THEN RETURN pg_catalog.jsonb_build_object('membership',m);
    WHEN 'credential' THEN
      SELECT pg_catalog.jsonb_agg(v) INTO rows FROM pg_catalog.jsonb_array_elements(p_snapshot->'credentialPolicies') x(v) WHERE v->>'credentialId'=c->>'id';
      IF pg_catalog.jsonb_array_length(rows) IS DISTINCT FROM 1 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      policy:=rows->0;PERFORM memory_identity.projection_v3_snapshot_value(policy,'credentialPolicy',source_rev);
      IF policy->'spaceIds'<>'null'::jsonb AND NOT(policy->'spaceIds' ? (sp->>'id')) THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      RETURN pg_catalog.jsonb_build_object('credential',c,'credentialPolicy',policy);
    WHEN 'space' THEN RETURN pg_catalog.jsonb_build_object('space',sp);
  END CASE;
  RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
EXCEPTION WHEN data_exception THEN
  RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
END
$fact$;

DO $acl$
DECLARE item record;
BEGIN
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.oid='memory_identity.projection_v3_snapshot_fact(jsonb,text,text)'::regprocedure AND a.grantee<>p.proowner LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION memory_identity.projection_v3_snapshot_fact(jsonb,text,text) FROM %s RESTRICT',
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(item.grantee)) END);
  END LOOP;
END
$acl$;
SET LOCAL ROLE memory_owner;
REVOKE CREATE ON SCHEMA memory_identity FROM memory_projection_owner;
SET LOCAL ROLE memory_projection_owner;
DO $postflight$
BEGIN
  IF pg_catalog.has_schema_privilege('memory_projection_owner','memory_identity','CREATE') OR NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid='memory_identity.projection_v3_snapshot_fact(jsonb,text,text)'::regprocedure
      AND p.proowner='memory_projection_owner'::regrole AND p.provolatile='i' AND NOT p.prosecdef AND NOT p.proisstrict
      AND p.proconfig=ARRAY['search_path=pg_catalog'] AND p.prorettype='jsonb'::regtype
      AND p.proacl=ARRAY[('memory_projection_owner=X/memory_projection_owner')::aclitem]) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable';
  END IF;
END
$postflight$;
RESET ROLE;
COMMIT;

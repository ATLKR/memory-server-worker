-- INACTIVE LOCAL B2. Requires schema5, protected setup, A and B1.
-- Owner-only complete materialization. No caller dispatch or serving marker.
BEGIN;
SET LOCAL ROLE memory_projection_owner;
DO $preflight$
DECLARE c record; q record; a record; f record; cols text[]; expected text[]; acl_expected aclitem[]; column_expected aclitem[]; reader text; seen integer:=0;
  owner_id oid:='memory_owner'::regrole; code_id oid:='memory_projection_owner'::regrole;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR NOT pg_has_role(session_user,owner_id,'SET') OR NOT pg_has_role(session_user,code_id,'SET')
    OR has_schema_privilege(code_id,'memory_identity','CREATE') OR has_schema_privilege(code_id,'memory_ops','CREATE')
    OR EXISTS(SELECT 1 FROM pg_roles WHERE oid IN(owner_id,code_id,'memory_projection_caller'::regrole,'memory_runtime'::regrole,'memory_background'::regrole,'memory_commands'::regrole,'memory_lifecycle'::regrole)
      AND(rolsuper OR rolinherit OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS(SELECT 1 FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname<>session_user AND r.oid NOT IN(owner_id,code_id)
      AND(pg_has_role(r.oid,owner_id,'SET') OR pg_has_role(r.oid,owner_id,'USAGE') OR pg_has_role(r.oid,code_id,'SET') OR pg_has_role(r.oid,code_id,'USAGE')))
    -- Neither projection role has an outgoing membership in the baseline.
    -- Reject its first hop even for indirect/custom or ADMIN-only capability.
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN(code_id,'memory_projection_caller'::regrole))
    OR to_regprocedure('memory_identity.projection_v3_snapshot_fact(jsonb,text,text)') IS NULL
    OR to_regprocedure('memory_ops.projection_v3_snapshot_ledger_begin(text,text)') IS NULL
    OR to_regclass('memory_ops.identity_projection_space_provisioning') IS NULL
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('memory_identity','memory_ops')
      AND(p.proname LIKE 'projection_v3_materialization_%' OR p.proname IN('projection_v3_snapshot_plan','projection_v3_snapshot_materialize','projection_v3_snapshot_classify','projection_v3_snapshot_materialization_assert')))
    OR EXISTS(SELECT 1 FROM pg_class collision JOIN pg_namespace n ON n.oid=collision.relnamespace WHERE n.nspname IN('memory_identity','memory_ops') AND collision.relname IN(
      'identity_projection_snapshot_generations','identity_projection_space_state','identity_projection_grants','identity_projection_grant_heads',
      'identity_projection_source_facts','identity_projection_mutable_fact_current','identity_projection_entities','identity_projection_provider_entities','identity_projection_legacy_grant_entities')) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  -- Lock precedes the fresh history observation and every new DDL/privilege.
  PERFORM id FROM memory_ops.identity_projection_fence WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_events WHERE event_kind IS DISTINCT FROM 'head' OR space_id IS NOT NULL OR snapshot_seq IS NOT NULL)
    OR EXISTS(SELECT 1 FROM memory_ops.identity_projection_snapshot_reservations)
    OR EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts r LEFT JOIN memory_ops.identity_projection_events e USING(transport_event_id)
      WHERE e.transport_event_id IS NULL OR e.event_kind IS DISTINCT FROM 'head' OR r.attempt_no<>1 OR r.outcome='dependency_pending' OR r.outcome='snapshot_superseded'
        OR(r.receipt_text::jsonb)->>'eventKind' IS DISTINCT FROM 'head')
    OR EXISTS(SELECT 1 FROM memory_ops.identity_projection_events e WHERE NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts r WHERE r.transport_event_id=e.transport_event_id)) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  FOR c IN SELECT * FROM pg_namespace WHERE nspname IN('memory_control','memory_identity','memory_ops','memory_content','memory_jobs','memory_search') LOOP
    acl_expected:=ARRAY['memory_owner=UC/memory_owner'::aclitem];
    FOREACH reader IN ARRAY(CASE c.nspname
      WHEN 'memory_control' THEN ARRAY['memory_runtime','memory_background','memory_commands','memory_lifecycle']
      WHEN 'memory_identity' THEN ARRAY['memory_commands','memory_runtime','memory_lifecycle','memory_projection_owner','memory_projection_caller']
      WHEN 'memory_ops' THEN ARRAY['memory_commands','memory_lifecycle','memory_runtime','memory_projection_owner','memory_projection_caller']
      WHEN 'memory_content' THEN ARRAY['memory_commands','memory_runtime','memory_lifecycle'] ELSE ARRAY[]::text[] END) LOOP
      acl_expected:=acl_expected||format('%s=U/memory_owner',reader)::aclitem;
    END LOOP;
    IF c.nspowner<>owner_id OR c.nspacl IS NULL OR NOT(c.nspacl @> acl_expected AND c.nspacl <@ acl_expected) OR cardinality(c.nspacl)<>cardinality(acl_expected) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
  FOR f IN SELECT * FROM(VALUES
    ('memory_identity.projection_v3_setup_insert_row()','memory_owner','v',false),('memory_identity.projection_v3_setup_valid(jsonb,text)','memory_owner','i',false),
    ('memory_ops.projection_v3_setup_insert_count()','memory_owner','v',false),('memory_ops.projection_v3_setup_insert_fence()','memory_owner','v',false),
    ('memory_identity.projection_v3_snapshot_canonical(text)','memory_projection_owner','i',false),('memory_identity.projection_v3_snapshot_fact(jsonb,text,text)','memory_projection_owner','i',false),
    ('memory_identity.projection_v3_snapshot_graph(jsonb)','memory_projection_owner','i',false),('memory_identity.projection_v3_snapshot_utf16(text)','memory_projection_owner','i',false),
    ('memory_identity.projection_v3_snapshot_value(jsonb,text,bigint)','memory_projection_owner','i',false),('memory_identity.seoul_projection_head_canonical(jsonb)','memory_projection_owner','v',false),
    ('memory_identity.seoul_projection_apply(text,text)','memory_projection_owner','v',true),('memory_ops.seoul_projection_status(text,text)','memory_projection_owner','v',true),
    ('memory_ops.seoul_projection_monotonic_guard()','memory_projection_owner','v',false),('memory_ops.projection_v3_ledger_complete()','memory_projection_owner','v',true),
    ('memory_ops.projection_v3_ledger_event_insert()','memory_projection_owner','v',false),('memory_ops.projection_v3_ledger_insert_fence()','memory_projection_owner','v',false),
    ('memory_ops.projection_v3_ledger_receipt_insert()','memory_projection_owner','v',false),('memory_ops.projection_v3_ledger_reservation_insert()','memory_projection_owner','v',false),
    ('memory_ops.projection_v3_ledger_source_insert()','memory_projection_owner','v',false),('memory_ops.projection_v3_snapshot_ledger_append(uuid,text,bigint,text,text)','memory_projection_owner','v',false),
    ('memory_ops.projection_v3_snapshot_ledger_begin(text,text)','memory_projection_owner','v',false),('memory_ops.projection_v3_snapshot_ledger_live(uuid)','memory_projection_owner','v',false)
    ) required(signature,owner_name,volatility,definer) LOOP
    SELECT * INTO c FROM pg_proc WHERE oid=to_regprocedure(f.signature);
    acl_expected:=ARRAY[format('%s=X/%s',f.owner_name,f.owner_name)::aclitem];
    IF f.signature IN('memory_identity.seoul_projection_apply(text,text)','memory_ops.seoul_projection_status(text,text)') THEN
      acl_expected:=acl_expected||'memory_projection_caller=X/memory_projection_owner'::aclitem; END IF;
    IF NOT FOUND OR c.proowner<>f.owner_name::regrole OR c.provolatile::text<>f.volatility OR c.prosecdef<>f.definer OR c.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
      OR c.proacl IS NULL OR NOT(c.proacl @> acl_expected AND c.proacl <@ acl_expected) OR cardinality(c.proacl)<>cardinality(acl_expected) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
  FOR c IN SELECT * FROM pg_class WHERE oid IN('memory_ops.identity_projection_fence'::regclass,'memory_ops.identity_projection_events'::regclass,
    'memory_ops.identity_projection_receipts'::regclass,'memory_ops.identity_projection_source_heads'::regclass,'memory_ops.identity_projection_heads'::regclass,
    'memory_ops.identity_projection_lifecycle'::regclass,'memory_ops.identity_projection_tombstones'::regclass,'memory_ops.identity_projection_snapshot_reservations'::regclass) LOOP
    acl_expected:=acldefault('r',owner_id)||format('memory_projection_owner=%s/memory_owner',CASE WHEN c.relname='identity_projection_fence' THEN 'r' ELSE 'ar' END)::aclitem;
    IF c.relowner<>owner_id OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR c.relacl IS NULL
      OR NOT(c.relacl @> acl_expected AND c.relacl <@ acl_expected) OR cardinality(c.relacl)<>cardinality(acl_expected) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    FOR a IN SELECT * FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped LOOP
      column_expected:=CASE WHEN(c.relname='identity_projection_fence' AND a.attname='id') OR(c.relname='identity_projection_heads' AND a.attname='source_revision')
        OR(c.relname='identity_projection_lifecycle' AND a.attname IN('source_revision','state','occurred_at_ms')) THEN ARRAY['memory_projection_owner=w/memory_owner'::aclitem] ELSE NULL END;
      IF a.attacl IS DISTINCT FROM column_expected THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
    IF(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)<>(CASE WHEN c.relname IN('identity_projection_heads','identity_projection_lifecycle') THEN 4 ELSE 3 END) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    FOR q IN SELECT * FROM pg_policy WHERE polrelid=c.oid LOOP
      IF NOT q.polpermissive OR NOT coalesce(
        (q.polname=CASE WHEN c.relname='identity_projection_snapshot_reservations' THEN 'ledger_owner' ELSE 'migration_owner' END AND q.polcmd='*' AND q.polroles=ARRAY[owner_id] AND pg_get_expr(q.polqual,c.oid)='true' AND pg_get_expr(q.polwithcheck,c.oid)='true')
        OR(q.polname=CASE WHEN c.relname='identity_projection_snapshot_reservations' THEN 'ledger_projection_select' ELSE 'projection_owner_select' END AND q.polcmd='r' AND q.polroles=ARRAY[code_id] AND pg_get_expr(q.polqual,c.oid)='true' AND q.polwithcheck IS NULL)
        OR(q.polname=CASE WHEN c.relname='identity_projection_snapshot_reservations' THEN 'ledger_projection_insert' ELSE 'projection_owner_insert' END AND c.relname<>'identity_projection_fence' AND q.polcmd='a' AND q.polroles=ARRAY[code_id] AND q.polqual IS NULL AND pg_get_expr(q.polwithcheck,c.oid)='true')
        OR(q.polname='projection_owner_update' AND c.relname IN('identity_projection_fence','identity_projection_heads','identity_projection_lifecycle') AND q.polcmd='w' AND q.polroles=ARRAY[code_id]
          AND pg_get_expr(q.polqual,c.oid)=CASE WHEN c.relname='identity_projection_fence' THEN '(id = 1)' ELSE 'true' END AND pg_get_expr(q.polwithcheck,c.oid)=CASE WHEN c.relname='identity_projection_fence' THEN '(id = 1)' ELSE 'true' END),false) THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
  END LOOP;
  -- Exact legacy columns, existing read policies and column-only writer grants.
  FOR c IN SELECT x.* FROM pg_class x JOIN pg_namespace ns ON ns.oid=x.relnamespace
    WHERE(ns.nspname='memory_identity' AND x.relname IN('accounts','provider_identities','account_emails','memberships','credentials','pat_space_grants'))
      OR(ns.nspname='memory_control' AND x.relname IN('organizations','spaces','deployment_identity')) OR(ns.nspname='memory_ops' AND x.relname='space_usage') LOOP
    seen:=seen+1;
    expected:=CASE c.relname
      WHEN 'accounts' THEN ARRAY['id','disabled_at'] WHEN 'organizations' THEN ARRAY['id','disabled_at']
      WHEN 'provider_identities' THEN ARRAY['issuer','subject','account_id','created_at']
      WHEN 'account_emails' THEN ARRAY['id','account_id','address','domain','verified_at','revoked_at']
      WHEN 'memberships' THEN ARRAY['id','organization_id','account_id','email_id','role','expires_at','revoked_at']
      WHEN 'credentials' THEN ARRAY['id','account_id','membership_id','email_id','kind','token_digest','expires_at','reauthenticated_at','revoked_at','permission']
      WHEN 'spaces' THEN ARRAY['id','owner_account_id','organization_id','deployment_id','data_policy','disabled_at','source_byte_limit','message_limit']
      WHEN 'pat_space_grants' THEN ARRAY['credential_id','account_id','space_id','can_ingest','can_search','expires_at','revoked_at','can_erase','can_retire']
      WHEN 'space_usage' THEN ARRAY['space_id','source_bytes','message_count','retained_source_bytes','retained_message_count']
      ELSE ARRAY['singleton','deployment_id','storage_region','processing_policy_id','created_at_ms'] END;
    SELECT array_agg(attname::text ORDER BY attnum) INTO cols FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped;
    IF cols IS DISTINCT FROM expected OR c.relowner<>owner_id OR c.relrowsecurity<>(c.relname<>'deployment_identity')
      OR c.relforcerowsecurity<>(c.relname<>'deployment_identity') THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    acl_expected:=acldefault('r',owner_id);
    FOREACH reader IN ARRAY(CASE WHEN c.relname='deployment_identity' THEN ARRAY['memory_runtime','memory_background','memory_commands','memory_lifecycle']
      WHEN c.relname='provider_identities' THEN ARRAY[]::text[] ELSE ARRAY['memory_commands','memory_lifecycle'] END) LOOP
      acl_expected:=acl_expected||format('%s=r/memory_owner',reader)::aclitem;
    END LOOP;
    IF c.relacl IS NULL OR NOT(c.relacl @> acl_expected AND c.relacl <@ acl_expected) OR cardinality(c.relacl)<>cardinality(acl_expected) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    FOR a IN SELECT * FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped LOOP
      column_expected:=NULL;
      IF(c.relname IN('accounts','organizations','account_emails','memberships','credentials','spaces') AND a.attname='id')
        OR(c.relname='pat_space_grants' AND a.attname='credential_id') OR(c.relname='space_usage' AND a.attname IN('retained_source_bytes','retained_message_count')) THEN
        column_expected:=ARRAY['memory_commands=w/memory_owner'::aclitem,'memory_lifecycle=w/memory_owner'::aclitem];
      ELSIF(c.relname='credentials' AND a.attname='revoked_at') OR(c.relname='spaces' AND a.attname='disabled_at') THEN column_expected:=ARRAY['memory_lifecycle=w/memory_owner'::aclitem];
      ELSIF c.relname='space_usage' AND a.attname IN('source_bytes','message_count') THEN column_expected:=ARRAY['memory_commands=w/memory_owner'::aclitem]; END IF;
      IF(column_expected IS NULL)<>(a.attacl IS NULL) OR(column_expected IS NOT NULL AND(NOT(a.attacl @> column_expected AND a.attacl <@ column_expected) OR cardinality(a.attacl)<>cardinality(column_expected))) THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
    FOR a IN SELECT * FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) WHERE grantee<>owner_id LOOP
      IF a.is_grantable OR a.privilege_type<>'SELECT' OR NOT(a.grantee=ANY(CASE WHEN c.relname='deployment_identity'
          THEN ARRAY['memory_runtime'::regrole::oid,'memory_background'::regrole::oid,'memory_commands'::regrole::oid,'memory_lifecycle'::regrole::oid]
          WHEN c.relname='provider_identities' THEN ARRAY[]::oid[] ELSE ARRAY['memory_commands'::regrole::oid,'memory_lifecycle'::regrole::oid] END)) THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
    FOR a IN SELECT col.attname,z.* FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) z WHERE col.attrelid=c.oid AND z.grantee<>owner_id LOOP
      IF a.is_grantable OR a.privilege_type<>'UPDATE' OR NOT(a.grantee IN('memory_commands'::regrole,'memory_lifecycle'::regrole))
        OR NOT((c.relname IN('accounts','organizations','account_emails','memberships','credentials','spaces') AND a.attname='id')
          OR(c.relname='credentials' AND a.attname='revoked_at' AND a.grantee='memory_lifecycle'::regrole)
          OR(c.relname='spaces' AND a.attname='disabled_at' AND a.grantee='memory_lifecycle'::regrole)
          OR(c.relname='pat_space_grants' AND a.attname='credential_id')
          OR(c.relname='space_usage' AND(a.attname IN('retained_source_bytes','retained_message_count') OR(a.attname IN('source_bytes','message_count') AND a.grantee='memory_commands'::regrole)))) THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
    IF(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)<>(CASE c.relname WHEN 'deployment_identity' THEN 0 WHEN 'provider_identities' THEN 1 ELSE 5 END) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    FOR q IN SELECT * FROM pg_policy WHERE polrelid=c.oid LOOP
      IF NOT q.polpermissive OR NOT coalesce(
        (q.polname='migration_owner' AND q.polcmd='*' AND q.polroles=ARRAY[owner_id] AND pg_get_expr(q.polqual,c.oid)='true' AND pg_get_expr(q.polwithcheck,c.oid)='true')
        OR(q.polname IN('seoul_commands_read','seoul_lifecycle_read') AND q.polcmd='r' AND q.polroles=ARRAY[(CASE WHEN q.polname='seoul_commands_read' THEN 'memory_commands' ELSE 'memory_lifecycle' END)::regrole::oid] AND pg_get_expr(q.polqual,c.oid)='true' AND q.polwithcheck IS NULL)
        OR(q.polname IN('seoul_commands_update','seoul_lifecycle_update') AND q.polcmd='w' AND q.polroles=ARRAY[(CASE WHEN q.polname='seoul_commands_update' THEN 'memory_commands' ELSE 'memory_lifecycle' END)::regrole::oid] AND pg_get_expr(q.polqual,c.oid)='true' AND pg_get_expr(q.polwithcheck,c.oid)='true'),false) THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
  END LOOP;
  IF seen<>10 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  FOR c IN SELECT * FROM pg_class WHERE oid IN('memory_ops.identity_projection_space_provisioning'::regclass,'memory_identity.identity_projection_retained_dispositions'::regclass) LOOP
    expected:=CASE WHEN c.relname='identity_projection_space_provisioning' THEN ARRAY['space_id','approval_id','deployment_singleton','deployment_id','storage_region','processing_policy_id','deployment_created_at_ms','data_policy','source_byte_limit','message_limit']
      ELSE ARRAY['approval_id','deployment_singleton','deployment_id','storage_region','processing_policy_id','deployment_created_at_ms','entity_kind','entity_id','issuer','subject','credential_id','space_id','disposition','retained_basis','authorized_binding'] END;
    IF c.relowner<>owner_id OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR c.relacl IS DISTINCT FROM acldefault('r',owner_id)
      OR(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)<>3 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    FOR a IN SELECT * FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped LOOP
      column_expected:=CASE WHEN a.attname=ANY(expected) THEN ARRAY['memory_projection_owner=r/memory_owner'::aclitem] ELSE NULL END;
      IF a.attacl IS DISTINCT FROM column_expected THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
    FOR q IN SELECT * FROM pg_policy WHERE polrelid=c.oid LOOP
      IF NOT q.polpermissive OR NOT coalesce(
        (q.polname='setup_owner_select' AND q.polcmd='r' AND q.polroles=ARRAY[owner_id] AND pg_get_expr(q.polqual,c.oid)='true' AND q.polwithcheck IS NULL)
        OR(q.polname='setup_owner_insert' AND q.polcmd='a' AND q.polroles=ARRAY[owner_id] AND q.polqual IS NULL AND pg_get_expr(q.polwithcheck,c.oid)='true')
        OR(q.polname='setup_projection_select' AND q.polcmd='r' AND q.polroles=ARRAY[code_id] AND pg_get_expr(q.polqual,c.oid)='true' AND q.polwithcheck IS NULL),false) THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
  END LOOP;
  IF has_function_privilege(code_id,'memory_identity.projection_v3_setup_valid(jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
END
$preflight$;
SET LOCAL ROLE memory_owner;
GRANT USAGE ON SCHEMA memory_control TO memory_projection_owner;
CREATE TABLE memory_ops.identity_projection_snapshot_generations(
  space_id text NOT NULL,snapshot_seq bigint NOT NULL,transport_event_id uuid NOT NULL,selected boolean NOT NULL,
  lease_issued_at_ms bigint NOT NULL,lease_expires_at_ms bigint NOT NULL,grant_count integer NOT NULL,provisioning_approval_id uuid,
  CONSTRAINT materialization_generations_pk PRIMARY KEY(space_id,snapshot_seq),
  CONSTRAINT materialization_generations_event_uq UNIQUE(transport_event_id),
  CONSTRAINT materialization_generations_reservation_fk FOREIGN KEY(space_id,snapshot_seq,transport_event_id) REFERENCES memory_ops.identity_projection_snapshot_reservations(space_id,snapshot_seq,transport_event_id),
  CONSTRAINT materialization_generations_provision_fk FOREIGN KEY(provisioning_approval_id) REFERENCES memory_ops.identity_projection_space_provisioning(approval_id),
  CONSTRAINT materialization_generations_shape_ck CHECK(snapshot_seq BETWEEN 1 AND 9007199254740991 AND lease_issued_at_ms BETWEEN 0 AND 9007199254680991
    AND lease_expires_at_ms=lease_issued_at_ms+60000 AND grant_count>=0 AND((grant_count=0 AND provisioning_approval_id IS NULL) OR(grant_count>0 AND selected AND provisioning_approval_id IS NOT NULL)))
);
CREATE TABLE memory_ops.identity_projection_space_state(
  space_id text NOT NULL,current_sequence bigint NOT NULL,
  CONSTRAINT materialization_space_state_pk PRIMARY KEY(space_id),
  CONSTRAINT materialization_space_state_generation_fk FOREIGN KEY(space_id,current_sequence) REFERENCES memory_ops.identity_projection_snapshot_generations(space_id,snapshot_seq),
  CONSTRAINT materialization_space_state_sequence_ck CHECK(current_sequence BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE memory_identity.identity_projection_grants(
  space_id text NOT NULL,snapshot_seq bigint NOT NULL,credential_id text NOT NULL,account_id text NOT NULL,provenance text NOT NULL,
  credential_policy jsonb NOT NULL,can_ingest boolean NOT NULL,can_search boolean NOT NULL,can_erase boolean NOT NULL,can_retire boolean NOT NULL,
  expires_at_ms bigint NOT NULL,revoked_at_ms bigint,
  CONSTRAINT materialization_grants_pk PRIMARY KEY(space_id,snapshot_seq,credential_id),
  CONSTRAINT materialization_grants_generation_fk FOREIGN KEY(space_id,snapshot_seq) REFERENCES memory_ops.identity_projection_snapshot_generations(space_id,snapshot_seq),
  CONSTRAINT materialization_grants_credential_fk FOREIGN KEY(credential_id,account_id) REFERENCES memory_identity.credentials(id,account_id),
  CONSTRAINT materialization_grants_legacy_fk FOREIGN KEY(credential_id,space_id) REFERENCES memory_identity.pat_space_grants(credential_id,space_id),
  CONSTRAINT materialization_grants_shape_ck CHECK(provenance IN('owner','organization-member') AND NOT can_erase AND NOT can_retire AND revoked_at_ms IS NULL
    AND expires_at_ms BETWEEN 0 AND 9007199254740991 AND jsonb_typeof(credential_policy)='object' AND credential_policy->>'credentialId'=credential_id)
);
CREATE INDEX projection_grants_credential_space ON memory_identity.identity_projection_grants(credential_id,space_id,snapshot_seq);
CREATE TABLE memory_identity.identity_projection_grant_heads(
  space_id text NOT NULL,snapshot_seq bigint NOT NULL,credential_id text NOT NULL,kind text NOT NULL,stream_key text NOT NULL,source_revision bigint NOT NULL,
  CONSTRAINT materialization_grant_heads_pk PRIMARY KEY(space_id,snapshot_seq,credential_id,kind,stream_key),
  CONSTRAINT materialization_grant_heads_grant_fk FOREIGN KEY(space_id,snapshot_seq,credential_id) REFERENCES memory_identity.identity_projection_grants(space_id,snapshot_seq,credential_id),
  CONSTRAINT materialization_grant_heads_source_fk FOREIGN KEY(kind,stream_key,source_revision) REFERENCES memory_ops.identity_projection_source_heads(kind,stream_key,source_revision)
);
CREATE INDEX projection_grant_heads_source ON memory_identity.identity_projection_grant_heads(source_revision,space_id,snapshot_seq);
CREATE TABLE memory_identity.identity_projection_source_facts(
  source_revision bigint NOT NULL,first_snapshot_event_id uuid NOT NULL,
  CONSTRAINT materialization_source_facts_pk PRIMARY KEY(source_revision),
  CONSTRAINT materialization_source_facts_source_fk FOREIGN KEY(source_revision) REFERENCES memory_ops.identity_projection_source_heads(source_revision),
  CONSTRAINT materialization_source_facts_event_fk FOREIGN KEY(first_snapshot_event_id) REFERENCES memory_ops.identity_projection_events(transport_event_id)
);
CREATE INDEX projection_source_facts_event ON memory_identity.identity_projection_source_facts(first_snapshot_event_id,source_revision);
CREATE TABLE memory_identity.identity_projection_mutable_fact_current(
  kind text NOT NULL,entity_id text NOT NULL,source_revision bigint NOT NULL,
  CONSTRAINT materialization_mutable_current_pk PRIMARY KEY(kind,entity_id),
  CONSTRAINT materialization_mutable_current_fact_fk FOREIGN KEY(source_revision) REFERENCES memory_identity.identity_projection_source_facts(source_revision),
  CONSTRAINT materialization_mutable_current_source_fk FOREIGN KEY(kind,entity_id,source_revision) REFERENCES memory_ops.identity_projection_source_heads(kind,stream_key,source_revision),
  CONSTRAINT materialization_mutable_current_kind_ck CHECK(kind IN('membership','credential'))
);
CREATE TABLE memory_identity.identity_projection_entities(
  entity_kind text NOT NULL,entity_id text NOT NULL,origin text NOT NULL,first_snapshot_event_id uuid NOT NULL,disposition_approval_id uuid,first_binding jsonb NOT NULL,
  CONSTRAINT materialization_entities_pk PRIMARY KEY(entity_kind,entity_id),
  CONSTRAINT materialization_entities_event_fk FOREIGN KEY(first_snapshot_event_id) REFERENCES memory_ops.identity_projection_events(transport_event_id),
  CONSTRAINT materialization_entities_approval_fk FOREIGN KEY(disposition_approval_id) REFERENCES memory_identity.identity_projection_retained_dispositions(approval_id),
  CONSTRAINT materialization_entities_shape_ck CHECK(entity_kind IN('account','organization','email','membership','credential','space') AND jsonb_typeof(first_binding)='object'
    AND((origin='creation' AND disposition_approval_id IS NULL) OR(origin='retained_adoption' AND disposition_approval_id IS NOT NULL)))
);
CREATE INDEX projection_entities_event ON memory_identity.identity_projection_entities(first_snapshot_event_id,entity_kind,entity_id);
CREATE TABLE memory_identity.identity_projection_provider_entities(
  issuer text NOT NULL,subject text NOT NULL,account_id text NOT NULL,created_at bigint NOT NULL,origin text NOT NULL,first_snapshot_event_id uuid NOT NULL,disposition_approval_id uuid,first_binding jsonb NOT NULL,
  CONSTRAINT materialization_provider_entities_pk PRIMARY KEY(issuer,subject),
  CONSTRAINT materialization_provider_entities_provider_fk FOREIGN KEY(issuer,subject) REFERENCES memory_identity.provider_identities(issuer,subject),
  CONSTRAINT materialization_provider_entities_event_fk FOREIGN KEY(first_snapshot_event_id) REFERENCES memory_ops.identity_projection_events(transport_event_id),
  CONSTRAINT materialization_provider_entities_approval_fk FOREIGN KEY(disposition_approval_id) REFERENCES memory_identity.identity_projection_retained_dispositions(approval_id),
  CONSTRAINT materialization_provider_entities_shape_ck CHECK(jsonb_typeof(first_binding)='object' AND((origin='creation' AND disposition_approval_id IS NULL) OR(origin='retained_adoption' AND disposition_approval_id IS NOT NULL)))
);
CREATE INDEX projection_provider_entities_event ON memory_identity.identity_projection_provider_entities(first_snapshot_event_id,issuer,subject);
CREATE TABLE memory_identity.identity_projection_legacy_grant_entities(
  credential_id text NOT NULL,space_id text NOT NULL,account_id text NOT NULL,origin text NOT NULL,first_snapshot_event_id uuid NOT NULL,disposition_approval_id uuid,first_binding jsonb NOT NULL,
  CONSTRAINT materialization_legacy_entities_pk PRIMARY KEY(credential_id,space_id),
  CONSTRAINT materialization_legacy_entities_legacy_fk FOREIGN KEY(credential_id,space_id) REFERENCES memory_identity.pat_space_grants(credential_id,space_id),
  CONSTRAINT materialization_legacy_entities_credential_fk FOREIGN KEY(credential_id,account_id) REFERENCES memory_identity.credentials(id,account_id),
  CONSTRAINT materialization_legacy_entities_event_fk FOREIGN KEY(first_snapshot_event_id) REFERENCES memory_ops.identity_projection_events(transport_event_id),
  CONSTRAINT materialization_legacy_entities_approval_fk FOREIGN KEY(disposition_approval_id) REFERENCES memory_identity.identity_projection_retained_dispositions(approval_id),
  CONSTRAINT materialization_legacy_entities_shape_ck CHECK(jsonb_typeof(first_binding)='object' AND((origin='creation' AND disposition_approval_id IS NULL) OR(origin='retained_adoption' AND disposition_approval_id IS NOT NULL)))
);
CREATE INDEX projection_legacy_entities_event ON memory_identity.identity_projection_legacy_grant_entities(first_snapshot_event_id,credential_id,space_id);

GRANT SELECT ON memory_identity.accounts,memory_control.organizations,memory_identity.provider_identities,memory_identity.account_emails,
  memory_identity.memberships,memory_identity.credentials,memory_control.spaces,memory_identity.pat_space_grants,memory_ops.space_usage TO memory_projection_owner;
GRANT SELECT(singleton,deployment_id,storage_region,processing_policy_id,created_at_ms) ON memory_control.deployment_identity TO memory_projection_owner;
GRANT INSERT(id,disabled_at),UPDATE(id) ON memory_identity.accounts TO memory_projection_owner;
GRANT INSERT(id,disabled_at),UPDATE(id) ON memory_control.organizations TO memory_projection_owner;
GRANT INSERT(issuer,subject,account_id,created_at) ON memory_identity.provider_identities TO memory_projection_owner;
GRANT INSERT(id,account_id,address,domain,verified_at,revoked_at),UPDATE(id) ON memory_identity.account_emails TO memory_projection_owner;
GRANT INSERT(id,organization_id,account_id,email_id,role,expires_at,revoked_at),UPDATE(role,expires_at) ON memory_identity.memberships TO memory_projection_owner;
GRANT INSERT(id,account_id,membership_id,email_id,kind,token_digest,expires_at,reauthenticated_at,revoked_at,permission),UPDATE(permission,expires_at) ON memory_identity.credentials TO memory_projection_owner;
GRANT INSERT(id,owner_account_id,organization_id,deployment_id,data_policy,disabled_at,source_byte_limit,message_limit),UPDATE(id) ON memory_control.spaces TO memory_projection_owner;
GRANT INSERT(credential_id,account_id,space_id,can_ingest,can_search,expires_at,revoked_at,can_erase,can_retire),UPDATE(can_ingest,can_search,expires_at) ON memory_identity.pat_space_grants TO memory_projection_owner;
GRANT INSERT(space_id,source_bytes,message_count,retained_source_bytes,retained_message_count),UPDATE(space_id) ON memory_ops.space_usage TO memory_projection_owner;
DO $policies$
DECLARE n text; rel regclass; a record;
BEGIN
  FOREACH n IN ARRAY ARRAY['memory_ops.identity_projection_snapshot_generations','memory_ops.identity_projection_space_state',
    'memory_identity.identity_projection_grants','memory_identity.identity_projection_grant_heads','memory_identity.identity_projection_source_facts',
    'memory_identity.identity_projection_mutable_fact_current','memory_identity.identity_projection_entities',
    'memory_identity.identity_projection_provider_entities','memory_identity.identity_projection_legacy_grant_entities'] LOOP
    rel:=n::regclass;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',rel);
    EXECUTE format('CREATE POLICY materialization_owner ON %s TO memory_owner USING(true) WITH CHECK(true)',rel);
    FOR a IN SELECT DISTINCT x.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=rel AND x.grantee<>c.relowner LOOP
      EXECUTE format('REVOKE ALL ON %s FROM %s RESTRICT',rel,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=rel AND attacl IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_type t ON t.oid=c.reltype WHERE c.oid=rel AND t.typacl IS NOT NULL) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    EXECUTE format('GRANT SELECT,INSERT ON %s TO memory_projection_owner',rel);
  END LOOP;
  FOREACH n IN ARRAY ARRAY['memory_ops.identity_projection_snapshot_generations','memory_ops.identity_projection_space_state',
    'memory_identity.identity_projection_grants','memory_identity.identity_projection_grant_heads','memory_identity.identity_projection_source_facts',
    'memory_identity.identity_projection_mutable_fact_current','memory_identity.identity_projection_entities',
    'memory_identity.identity_projection_provider_entities','memory_identity.identity_projection_legacy_grant_entities',
    'memory_identity.accounts','memory_control.organizations','memory_identity.provider_identities','memory_identity.account_emails',
    'memory_identity.memberships','memory_identity.credentials','memory_control.spaces','memory_identity.pat_space_grants','memory_ops.space_usage'] LOOP
    rel:=n::regclass;
    EXECUTE format('CREATE POLICY materialization_select ON %s FOR SELECT TO memory_projection_owner USING(true)',rel);
    EXECUTE format('CREATE POLICY materialization_insert ON %s FOR INSERT TO memory_projection_owner WITH CHECK(true)',rel);
    IF n IN('memory_ops.identity_projection_space_state','memory_identity.identity_projection_mutable_fact_current','memory_identity.accounts','memory_control.organizations',
      'memory_identity.account_emails','memory_identity.memberships','memory_identity.credentials','memory_control.spaces','memory_identity.pat_space_grants','memory_ops.space_usage') THEN
      EXECUTE format('CREATE POLICY materialization_update ON %s FOR UPDATE TO memory_projection_owner USING(true) WITH CHECK(true)',rel);
    END IF;
  END LOOP;
END
$policies$;
GRANT UPDATE(current_sequence) ON memory_ops.identity_projection_space_state TO memory_projection_owner;
GRANT UPDATE(source_revision) ON memory_identity.identity_projection_mutable_fact_current TO memory_projection_owner;
GRANT CREATE ON SCHEMA memory_identity,memory_ops TO memory_projection_owner;
SET LOCAL ROLE memory_projection_owner;

CREATE FUNCTION memory_identity.projection_v3_snapshot_plan(p_event_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $plan$
#variable_conflict use_variable
DECLARE e memory_ops.identity_projection_events%ROWTYPE; p jsonb; prior jsonb; raw text; h jsonb; g jsonb; v jsonb; fact jsonb;
  actual jsonb; intended jsonb; provenance jsonb; approval jsonb; row_value jsonb; row_values jsonb:='[]';
  sources jsonb:='{}'; grains jsonb:='{}'; comparisons jsonb:='{}'; grant_values jsonb:='[]'; witnesses jsonb:='{}'; prior_grains jsonb; prior_sources jsonb; prior_hash text;
  flags jsonb:='{}'; provision jsonb; deployment jsonb; usage jsonb; meta jsonb; metrics jsonb;
  item record; source record; current_source record; witness record; k text; key text; grain_key text; kind text; id text;
  refs jsonb; allowed text[]; negative text; rev bigint; current_rev bigint; first_event uuid; prior_event uuid; current_seq bigint; winner uuid;
  at_ms bigint; extra boolean; policy_equal boolean; current_equal boolean; provider_count integer; expected_count integer;
  validations integer:=1; parses integer:=1; loads integer:=1; extracts integer:=0; largest_body integer:=0; largest_fact integer:=0;
BEGIN
  IF current_user<>'memory_projection_owner' OR current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  PERFORM f.id FROM memory_ops.identity_projection_fence f WHERE f.id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO e FROM memory_ops.identity_projection_events WHERE transport_event_id=p_event_id AND event_kind='snapshot';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  BEGIN
    p:=memory_identity.projection_v3_snapshot_canonical(e.payload_text)::jsonb;
    IF encode(sha256(convert_to(e.payload_text,'UTF8')),'hex')<>e.transport_payload_sha256 OR p->>'eventId'<>e.transport_event_id::text
      OR p->>'spaceId'<>e.space_id OR(p->>'snapshotSeq')::bigint<>e.snapshot_seq OR(p->>'sourceRevision')::bigint<>e.source_revision THEN RAISE EXCEPTION 'invalid'; END IF;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END;
  largest_body:=octet_length(e.payload_text);e.payload_text:=NULL;
  meta:=jsonb_build_object('eventId',p_event_id,'transportPayloadSha256',e.transport_payload_sha256,'sourceRevision',e.source_revision,
    'spaceId',e.space_id,'snapshotSeq',e.snapshot_seq,'selected',p->'selected','lease',p->'lease');
  SELECT transport_event_id INTO winner FROM memory_ops.identity_projection_snapshot_reservations WHERE space_id=e.space_id AND snapshot_seq=e.snapshot_seq;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF winner<>p_event_id THEN flags:=flags||'{"snapshot_sequence_conflict":true}'; END IF;
  SELECT current_sequence INTO current_seq FROM memory_ops.identity_projection_space_state WHERE space_id=e.space_id;
  IF FOUND AND NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_snapshot_generations WHERE space_id=e.space_id AND snapshot_seq=current_seq) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF current_seq>e.snapshot_seq THEN flags:=flags||'{"newer_snapshot_present":true}'; END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(p->'grants') LOOP
    refs:='[]';
    FOR h IN SELECT value FROM jsonb_array_elements(g->'heads'->'subjects'||coalesce(nullif(g->'heads'->'emails','null'::jsonb),'[]')
      ||jsonb_build_array(g->'heads'->'organization',g->'heads'->'membership',g->'heads'->'credential',g->'heads'->'space',g->'heads'->'target')) WHERE value<>'null'::jsonb LOOP
      rev:=(h->>'revision')::bigint;refs:=refs||to_jsonb(rev);
      IF sources ? rev::text THEN CONTINUE; END IF;
      kind:=h->>'kind';key:=h->>'key';grain_key:=NULL;
      IF kind<>'target' THEN
        IF kind='subject' THEN grain_key:='subject:'||(g->>'accountId');
        ELSIF kind='email' THEN
          SELECT 'email:'||(c.value->>'emailId') INTO grain_key FROM jsonb_array_elements(p->'credentials') c WHERE c.value->>'id'=g->>'credentialId';
        ELSE grain_key:=kind||':'||key; END IF;
        IF NOT grains ? grain_key THEN
          fact:=memory_identity.projection_v3_snapshot_fact(p,kind,key);extracts:=extracts+1;largest_fact:=greatest(largest_fact,octet_length(fact::text));
          grains:=grains||jsonb_build_object(grain_key,fact);
        END IF;
      END IF;
      FOR source IN SELECT * FROM memory_ops.identity_projection_source_heads WHERE source_revision=rev OR source_event_id=(h->>'eventId')::uuid LOOP
        IF source.source_revision<>rev OR source.source_event_id<>(h->>'eventId')::uuid OR source.kind<>kind OR source.stream_key<>key OR source.source_sha256<>h->>'payloadSha256' THEN
          flags:=flags||'{"source_identity_conflict":true}'; END IF;
      END LOOP;
      IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_events WHERE transport_event_id=(h->>'eventId')::uuid AND event_kind='snapshot') THEN flags:=flags||'{"source_identity_conflict":true}'; END IF;
      SELECT c.source_revision,s.kind,s.stream_key,s.effect INTO current_source FROM memory_ops.identity_projection_heads c
        LEFT JOIN memory_ops.identity_projection_source_heads s ON s.source_revision=c.source_revision WHERE c.kind=kind AND c.stream_key=key;
      IF NOT FOUND THEN flags:=flags||'{"dependency_head_missing":true}';current_rev:=NULL;
      ELSE
        current_rev:=current_source.source_revision;
        IF current_source.kind IS DISTINCT FROM kind OR current_source.stream_key IS DISTINCT FROM key THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
        IF current_rev<rev THEN flags:=flags||'{"dependency_head_behind":true}'; ELSIF current_rev>rev THEN flags:=flags||'{"newer_dependency_present":true}'; END IF;
        IF kind='target' AND current_source.effect->>'type'='entity-negative' AND current_source.effect->>'state'='removed' THEN flags:=flags||'{"target_deselected":true}'; END IF;
      END IF;
      IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_tombstones t WHERE t.kind=kind AND t.stream_key=key) THEN flags:=flags||'{"terminal_identity_denied":true}'; END IF;
      IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_lifecycle l WHERE l.kind=kind AND l.stream_key=key AND l.state IN('suspended','revoked','deleted')) THEN
        flags:=flags||'{"lifecycle_denied":true}'; END IF;
      SELECT first_snapshot_event_id INTO first_event FROM memory_identity.identity_projection_source_facts WHERE source_revision=rev;
      IF kind<>'target' AND first_event IS NULL AND EXISTS(SELECT 1 FROM memory_identity.identity_projection_grant_heads gh
        JOIN memory_ops.identity_projection_snapshot_generations gen USING(space_id,snapshot_seq) WHERE gh.source_revision=rev AND gen.transport_event_id<>p_event_id) THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
      sources:=sources||jsonb_build_object(rev::text,h||jsonb_build_object('grainKey',grain_key,'currentRevision',current_rev,'firstSnapshotEventId',first_event));
      IF first_event IS NOT NULL THEN witnesses:=witnesses||jsonb_build_object(rev::text,jsonb_build_object('eventId',first_event,'kind',kind,'key',key,'grainKey',grain_key,'candidate',true)); END IF;
    END LOOP;
    grant_values:=grant_values||jsonb_build_object('credentialId',g->'credentialId','accountId',g->'accountId','spaceId',g->'spaceId','provenance',g->'provenance',
      'canIngest',g->'canIngest','canSearch',g->'canSearch','canErase',false,'canRetire',false,'expiresAtMs',g->'expiresAtMs','revokedAtMs',NULL,'sourceRevisions',refs);
  END LOOP;
  -- Early structural conflicts and empty snapshots require no positive rows.
  IF NOT(flags ? 'snapshot_sequence_conflict' OR flags ? 'source_identity_conflict') AND jsonb_array_length(grant_values)>0 THEN
    SELECT jsonb_build_object('singleton',singleton,'deployment_id',deployment_id,'storage_region',storage_region,'processing_policy_id',processing_policy_id,'created_at_ms',created_at_ms)
      INTO deployment FROM memory_control.deployment_identity WHERE singleton=1;
    IF deployment IS NULL OR deployment->>'storage_region'<>'kr-seoul' OR deployment->>'processing_policy_id'<>'kr-primary-storage-v1' THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    SELECT jsonb_build_object('space_id',space_id,'approval_id',approval_id,'deployment_singleton',deployment_singleton,'deployment_id',deployment_id,'storage_region',storage_region,
      'processing_policy_id',processing_policy_id,'deployment_created_at_ms',deployment_created_at_ms,'data_policy',data_policy,'source_byte_limit',source_byte_limit,'message_limit',message_limit)
      INTO provision FROM memory_ops.identity_projection_space_provisioning WHERE space_id=e.space_id;
    IF provision IS NULL THEN flags:=flags||'{"provisioning_missing":true}';
    ELSE
      BEGIN
        PERFORM memory_identity.projection_v3_snapshot_value(provision->'data_policy','policy',NULL);
        PERFORM memory_identity.projection_v3_snapshot_value(provision->'deployment_created_at_ms','time',NULL);
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END;
      IF provision->>'deployment_id' IS DISTINCT FROM deployment->>'deployment_id' OR provision->>'storage_region' IS DISTINCT FROM deployment->>'storage_region'
        OR provision->>'processing_policy_id' IS DISTINCT FROM deployment->>'processing_policy_id' OR provision->'deployment_created_at_ms' IS DISTINCT FROM deployment->'created_at_ms'
        OR provision->'data_policy' IS DISTINCT FROM p->'spaces'->0->'policy' THEN flags:=flags||'{"provisioning_conflict":true}'; END IF;
      IF provision->'deployment_singleton'<>'1'::jsonb OR(provision->>'source_byte_limit')::bigint NOT BETWEEN 0 AND 67108864 OR(provision->>'message_limit')::integer NOT BETWEEN 1 AND 100000 THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END IF;
    -- Category order is also the worker's write order. Providers remain plain
    -- indexed observations and are counted before filtering their issuer.
    FOR item IN SELECT candidate.* FROM(SELECT 1 AS ord,'account'::text AS kind,value AS v FROM jsonb_array_elements(p->'accounts')
      UNION ALL SELECT 2,'organization',value FROM jsonb_array_elements(p->'organizations')
      UNION ALL SELECT 3,'provider_identity',value FROM jsonb_array_elements(p->'providerIdentities')
      UNION ALL SELECT 4,'email',value FROM jsonb_array_elements(p->'emails')
      UNION ALL SELECT 5,'membership',value FROM jsonb_array_elements(p->'memberships')
      UNION ALL SELECT 6,'credential',value FROM jsonb_array_elements(p->'credentials')
      UNION ALL SELECT 7,'legacy_grant',value FROM jsonb_array_elements(p->'grants')
      UNION ALL SELECT 8,'space',value FROM jsonb_array_elements(p->'spaces')) candidate
      ORDER BY candidate.ord,(candidate.v->>'id') COLLATE "C",(candidate.v->>'credentialId') COLLATE "C",CASE WHEN candidate.kind='provider_identity' THEN memory_identity.projection_v3_snapshot_utf16(candidate.v->>'subject') END LOOP
      kind:=item.kind;v:=item.v;id:=v->>'id';actual:=NULL;intended:=NULL;provenance:=NULL;approval:=NULL;negative:=NULL;allowed:=ARRAY[]::text[];rev:=NULL;policy_equal:=true;
      CASE kind
      WHEN 'account' THEN
        SELECT to_jsonb(x) INTO actual FROM memory_identity.accounts x WHERE x.id=id FOR UPDATE;
        intended:=jsonb_build_object('id',id,'disabled_at',NULL);negative:='disabled_at';
        SELECT count(*) INTO expected_count FROM jsonb_array_elements(p->'providerIdentities') x WHERE x.value->>'accountId'=id;
        SELECT count(*) INTO provider_count FROM(SELECT 1 FROM memory_identity.provider_identities x WHERE x.account_id=id LIMIT expected_count+1) bounded;
        IF actual IS NOT NULL THEN
          IF provider_count>expected_count OR EXISTS(SELECT 1 FROM memory_identity.provider_identities x WHERE x.account_id=id
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'providerIdentities') y WHERE y.value->>'issuer'=x.issuer AND y.value->>'subject'=x.subject
              AND y.value->>'accountId'=x.account_id AND(y.value->>'createdAtMs')::bigint=x.created_at)) THEN flags:=flags||'{"immutable_entity_conflict":true}'; END IF;
        ELSIF provider_count<>0 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
        SELECT min((value->>'revision')::bigint) INTO rev FROM jsonb_each(sources) WHERE value->>'grainKey'='subject:'||id;
      WHEN 'organization' THEN
        SELECT to_jsonb(x) INTO actual FROM memory_control.organizations x WHERE x.id=id FOR UPDATE;
        intended:=jsonb_build_object('id',id,'disabled_at',NULL);negative:='disabled_at';
      WHEN 'provider_identity' THEN
        SELECT to_jsonb(x) INTO actual FROM memory_identity.provider_identities x WHERE x.issuer=v->>'issuer' AND x.subject=v->>'subject';
        intended:=jsonb_build_object('issuer',v->'issuer','subject',v->'subject','account_id',v->'accountId','created_at',v->'createdAtMs');
        SELECT to_jsonb(x) INTO provenance FROM memory_identity.identity_projection_provider_entities x WHERE x.issuer=v->>'issuer' AND x.subject=v->>'subject';
        SELECT min((value->>'revision')::bigint) INTO rev FROM jsonb_each(sources) WHERE value->>'grainKey'='subject:'||(v->>'accountId');
      WHEN 'email' THEN
        SELECT to_jsonb(x) INTO actual FROM memory_identity.account_emails x WHERE x.id=id FOR UPDATE;
        intended:=jsonb_build_object('id',id,'account_id',v->'accountId','address',v->'address','domain',split_part(v->>'address','@',2),'verified_at',v->'verifiedAtMs','revoked_at',NULL);negative:='revoked_at';
        IF EXISTS(SELECT 1 FROM memory_identity.account_emails x WHERE x.address=v->>'address' AND x.revoked_at IS NULL AND x.id<>id) THEN flags:=flags||'{"immutable_entity_conflict":true}'; END IF;
        SELECT min((value->>'revision')::bigint) INTO rev FROM jsonb_each(sources) WHERE value->>'grainKey'='email:'||id;
      WHEN 'membership' THEN
        SELECT to_jsonb(x) INTO actual FROM memory_identity.memberships x WHERE x.id=id FOR UPDATE;
        intended:=jsonb_build_object('id',id,'organization_id',v->'organizationId','account_id',v->'accountId','email_id',v->'emailId','role',v->'role','expires_at',v->'expiresAtMs','revoked_at',NULL);
        negative:='revoked_at';allowed:=ARRAY['role','expires_at'];
        IF EXISTS(SELECT 1 FROM memory_identity.memberships x WHERE x.organization_id=v->>'organizationId' AND x.account_id=v->>'accountId' AND x.revoked_at IS NULL AND x.id<>id) THEN flags:=flags||'{"immutable_entity_conflict":true}'; END IF;
      WHEN 'credential' THEN
        SELECT to_jsonb(x) INTO actual FROM memory_identity.credentials x WHERE x.id=id FOR UPDATE;
        intended:=jsonb_build_object('id',id,'account_id',v->'accountId','membership_id',v->'membershipId','email_id',v->'emailId','kind',v->'kind','token_digest',v->'tokenDigest',
          'expires_at',v->'expiresAtMs','reauthenticated_at',coalesce(actual->'reauthenticated_at','null'),'revoked_at',NULL,'permission',v->'permission');
        negative:='revoked_at';allowed:=ARRAY['permission','expires_at'];
        IF EXISTS(SELECT 1 FROM memory_identity.credentials x WHERE x.token_digest=v->>'tokenDigest' AND x.id<>id) THEN flags:=flags||'{"immutable_entity_conflict":true}'; END IF;
      WHEN 'legacy_grant' THEN
        SELECT to_jsonb(x) INTO actual FROM memory_identity.pat_space_grants x WHERE x.credential_id=v->>'credentialId' AND x.space_id=v->>'spaceId' FOR UPDATE;
        intended:=jsonb_build_object('credential_id',v->'credentialId','account_id',v->'accountId','space_id',v->'spaceId','can_ingest',v->'canIngest','can_search',v->'canSearch',
          'expires_at',v->'expiresAtMs','revoked_at',NULL,'can_erase',coalesce(actual->'can_erase','false'),'can_retire',coalesce(actual->'can_retire','false'));
        negative:='revoked_at';allowed:=ARRAY['can_ingest','can_search','expires_at'];
        SELECT to_jsonb(x) INTO provenance FROM memory_identity.identity_projection_legacy_grant_entities x WHERE x.credential_id=v->>'credentialId' AND x.space_id=v->>'spaceId';
        rev:=(v->'heads'->'credential'->>'revision')::bigint;
      WHEN 'space' THEN
        -- Lock without copying an unbounded incompatible legacy data_policy.
        PERFORM x.id FROM memory_control.spaces x WHERE x.id=id FOR UPDATE;
        SELECT x.data_policy=v->'policy' INTO policy_equal FROM memory_control.spaces x WHERE x.id=id;
        SELECT jsonb_build_object('id',x.id,'owner_account_id',x.owner_account_id,'organization_id',x.organization_id,'deployment_id',x.deployment_id,
          'data_policy',CASE WHEN policy_equal THEN x.data_policy ELSE NULL END,'disabled_at',x.disabled_at,'source_byte_limit',x.source_byte_limit,'message_limit',x.message_limit)
          INTO actual FROM memory_control.spaces x WHERE x.id=id;
        intended:=jsonb_build_object('id',id,'owner_account_id',v->'accountId','organization_id',v->'organizationId','deployment_id',deployment->'deployment_id','data_policy',v->'policy',
          'disabled_at',NULL,'source_byte_limit',provision->'source_byte_limit','message_limit',provision->'message_limit');negative:='disabled_at';
        IF policy_equal=false THEN flags:=flags||'{"immutable_entity_conflict":true,"provisioning_conflict":true}'; END IF;
        IF actual IS NOT NULL AND provision IS NOT NULL AND(actual->'deployment_id' IS DISTINCT FROM provision->'deployment_id'
          OR actual->'source_byte_limit' IS DISTINCT FROM provision->'source_byte_limit' OR actual->'message_limit' IS DISTINCT FROM provision->'message_limit') THEN flags:=flags||'{"provisioning_conflict":true}'; END IF;
      END CASE;
      IF kind NOT IN('provider_identity','legacy_grant') THEN
        SELECT to_jsonb(x) INTO provenance FROM memory_identity.identity_projection_entities x WHERE x.entity_kind=kind AND x.entity_id=id;
      END IF;
      IF rev IS NULL THEN SELECT min((value->>'revision')::bigint) INTO rev FROM jsonb_each(sources) WHERE value->>'grainKey'=kind||':'||id; END IF;
      IF negative IS NOT NULL AND actual->negative IS DISTINCT FROM 'null'::jsonb AND actual IS NOT NULL THEN flags:=flags||'{"terminal_identity_denied":true}'; END IF;
      IF actual IS NULL AND provenance IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
      IF actual IS NOT NULL THEN
        IF (actual-allowed-coalesce(negative,'')-CASE WHEN kind='space' THEN ARRAY['deployment_id','source_byte_limit','message_limit'] ELSE ARRAY[]::text[] END)
          IS DISTINCT FROM(intended-allowed-coalesce(negative,'')-CASE WHEN kind='space' THEN ARRAY['deployment_id','source_byte_limit','message_limit'] ELSE ARRAY[]::text[] END) THEN
          flags:=flags||'{"immutable_entity_conflict":true}'; END IF;
        IF provenance IS NULL THEN
          IF EXISTS(SELECT 1 FROM memory_identity.identity_projection_source_facts sf WHERE sf.source_revision=rev)
            OR(kind='provider_identity' AND EXISTS(SELECT 1 FROM memory_identity.identity_projection_entities pe WHERE pe.entity_kind='account' AND pe.entity_id=v->>'accountId'))
            OR(kind='account' AND EXISTS(SELECT 1 FROM memory_identity.provider_identities pi JOIN memory_identity.identity_projection_provider_entities pe USING(issuer,subject) WHERE pi.account_id=id))
            OR(kind='legacy_grant' AND EXISTS(SELECT 1 FROM memory_identity.identity_projection_grants pg WHERE pg.credential_id=v->>'credentialId' AND pg.space_id=v->>'spaceId')) THEN
            RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
          SELECT jsonb_build_object('approval_id',d.approval_id,'deployment_singleton',d.deployment_singleton,'deployment_id',d.deployment_id,'storage_region',d.storage_region,
            'processing_policy_id',d.processing_policy_id,'deployment_created_at_ms',d.deployment_created_at_ms,'entity_kind',d.entity_kind,'entity_id',d.entity_id,
            'issuer',d.issuer,'subject',d.subject,'credential_id',d.credential_id,'space_id',d.space_id,'disposition',d.disposition,'retained_basis',d.retained_basis,'authorized_binding',d.authorized_binding)
            INTO approval FROM memory_identity.identity_projection_retained_dispositions d WHERE d.entity_kind=kind AND
              ((kind NOT IN('provider_identity','legacy_grant') AND d.entity_id=id) OR(kind='provider_identity' AND d.issuer=v->>'issuer' AND d.subject=v->>'subject')
                OR(kind='legacy_grant' AND d.credential_id=v->>'credentialId' AND d.space_id=v->>'spaceId'));
          IF approval IS NULL THEN flags:=flags||'{"retained_row_disposition_missing":true}';
          ELSE
            IF approval->>'disposition'<>'adopt_exact_binding' OR approval->'deployment_singleton'<>'1'::jsonb
              OR approval->'deployment_id' IS DISTINCT FROM deployment->'deployment_id' OR approval->'storage_region' IS DISTINCT FROM deployment->'storage_region'
              OR approval->'processing_policy_id' IS DISTINCT FROM deployment->'processing_policy_id' OR approval->'deployment_created_at_ms' IS DISTINCT FROM deployment->'created_at_ms'
              OR (actual-coalesce(negative,'')) IS DISTINCT FROM((approval->'retained_basis')-coalesce(negative,''))
              OR intended IS DISTINCT FROM approval->'authorized_binding' THEN flags:=flags||'{"retained_row_disposition_conflict":true}'; END IF;
          END IF;
        ELSE
          IF provenance->>'origin' NOT IN('creation','retained_adoption') OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_snapshot_generations x
            JOIN memory_ops.identity_projection_receipts r ON r.transport_event_id=x.transport_event_id AND r.outcome='applied'
            WHERE x.transport_event_id=(provenance->>'first_snapshot_event_id')::uuid AND x.grant_count>0)
            AND (provenance->>'first_snapshot_event_id')::uuid<>p_event_id THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
          IF provenance->>'origin'='retained_adoption' THEN
            SELECT jsonb_build_object('entity_kind',d.entity_kind,'entity_id',d.entity_id,'issuer',d.issuer,'subject',d.subject,'credential_id',d.credential_id,'space_id',d.space_id,
              'authorized_binding',d.authorized_binding,'deployment_id',d.deployment_id,'storage_region',d.storage_region,'processing_policy_id',d.processing_policy_id,'deployment_created_at_ms',d.deployment_created_at_ms)
              INTO approval FROM memory_identity.identity_projection_retained_dispositions d WHERE d.approval_id=(provenance->>'disposition_approval_id')::uuid;
            IF approval IS NULL OR approval->>'entity_kind'<>kind OR approval->'authorized_binding' IS DISTINCT FROM provenance->'first_binding'
              OR(kind NOT IN('provider_identity','legacy_grant') AND approval->>'entity_id' IS DISTINCT FROM id)
              OR(kind='provider_identity' AND(approval->>'issuer' IS DISTINCT FROM v->>'issuer' OR approval->>'subject' IS DISTINCT FROM v->>'subject'))
              OR(kind='legacy_grant' AND(approval->>'credential_id' IS DISTINCT FROM v->>'credentialId' OR approval->>'space_id' IS DISTINCT FROM v->>'spaceId')) THEN
              RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
          ELSIF provenance->'disposition_approval_id'<>'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
          IF((provenance->'first_binding')-allowed-coalesce(negative,'')-CASE kind WHEN 'credential' THEN ARRAY['reauthenticated_at'] WHEN 'legacy_grant' THEN ARRAY['can_erase','can_retire'] ELSE ARRAY[]::text[] END)
            IS DISTINCT FROM(intended-allowed-coalesce(negative,'')-CASE kind WHEN 'credential' THEN ARRAY['reauthenticated_at'] WHEN 'legacy_grant' THEN ARRAY['can_erase','can_retire'] ELSE ARRAY[]::text[] END) THEN flags:=flags||'{"immutable_entity_conflict":true}'; END IF;
          IF kind IN('membership','credential') THEN
            SELECT c.source_revision,f.first_snapshot_event_id INTO current_rev,first_event FROM memory_identity.identity_projection_mutable_fact_current c
              LEFT JOIN memory_identity.identity_projection_source_facts f USING(source_revision) WHERE c.kind=kind AND c.entity_id=id;
            IF NOT FOUND OR first_event IS NULL THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
            IF NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_heads ch WHERE ch.kind=kind AND ch.stream_key=id AND ch.source_revision>=current_rev) THEN
              RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
            witnesses:=witnesses||jsonb_build_object(current_rev::text,coalesce(witnesses->current_rev::text,'{}')||jsonb_build_object('eventId',first_event,'kind',kind,'key',id,'grainKey',kind||':'||id,'current',true));
            comparisons:=comparisons||jsonb_build_object(kind||':'||id,jsonb_build_object('sourceRevision',current_rev,'firstSnapshotEventId',first_event,'actualMatchesCurrent',false,'candidateOrder',sign(rev-current_rev)));
            IF current_rev>rev THEN flags:=flags||'{"newer_dependency_present":true}'; END IF;
          END IF;
        END IF;
      END IF;
      row_value:=jsonb_build_object('kind',kind,'id',id,'issuer',v->'issuer','subject',v->'subject','credentialId',v->'credentialId','spaceId',v->'spaceId',
        'sourceRevision',rev,'actual',actual,'intended',intended,'provenance',provenance,'approval',approval);
      row_values:=row_values||row_value;
    END LOOP;
    SELECT to_jsonb(x) INTO usage FROM memory_ops.space_usage x WHERE x.space_id=e.space_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM memory_control.spaces x WHERE x.id=e.space_id) AND usage IS NULL THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;

    -- One prior event body and one local grain cache are live at a time.
    FOR prior_event IN SELECT DISTINCT(value->>'eventId')::uuid FROM jsonb_each(witnesses) ORDER BY 1 LOOP
      IF prior_event=p_event_id THEN prior:=p;
      ELSE
        SELECT payload_text,transport_payload_sha256 INTO raw,prior_hash FROM memory_ops.identity_projection_events WHERE transport_event_id=prior_event AND event_kind='snapshot';
        IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_snapshot_generations x JOIN memory_ops.identity_projection_receipts r USING(transport_event_id)
          WHERE x.transport_event_id=prior_event AND x.grant_count>0 AND r.outcome='applied') THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
        BEGIN
          IF encode(sha256(convert_to(raw,'UTF8')),'hex') IS DISTINCT FROM prior_hash THEN RAISE EXCEPTION 'invalid'; END IF;
          prior:=memory_identity.projection_v3_snapshot_canonical(raw)::jsonb;
          IF prior->>'eventId' IS DISTINCT FROM prior_event::text OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_snapshot_generations gen
            WHERE gen.transport_event_id=prior_event AND gen.space_id=prior->>'spaceId' AND gen.snapshot_seq=(prior->>'snapshotSeq')::bigint AND gen.grant_count=jsonb_array_length(prior->'grants')) THEN RAISE EXCEPTION 'invalid'; END IF;
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END;
        validations:=validations+1;parses:=parses+1;loads:=loads+1;largest_body:=greatest(largest_body,octet_length(raw));raw:=NULL;
      END IF;
      prior_grains:=CASE WHEN prior_event=p_event_id THEN grains ELSE '{}'::jsonb END;
      prior_sources:='{}';
      FOR g IN SELECT value FROM jsonb_array_elements(prior->'grants') LOOP
        FOR h IN SELECT value FROM jsonb_array_elements(g->'heads'->'subjects'||coalesce(nullif(g->'heads'->'emails','null'::jsonb),'[]')
          ||jsonb_build_array(g->'heads'->'organization',g->'heads'->'membership',g->'heads'->'credential',g->'heads'->'space',g->'heads'->'target')) WHERE value<>'null'::jsonb LOOP
          prior_sources:=prior_sources||jsonb_build_object(h->>'revision',h);
        END LOOP;
      END LOOP;
      FOR witness IN SELECT x.key,x.value FROM jsonb_each(witnesses) x WHERE(x.value->>'eventId')::uuid=prior_event ORDER BY x.key::bigint LOOP
        kind:=witness.value->>'kind';key:=witness.value->>'key';grain_key:=witness.value->>'grainKey';rev:=witness.key::bigint;
        IF kind='target' OR NOT EXISTS(SELECT 1 FROM memory_identity.identity_projection_grant_heads gh JOIN memory_ops.identity_projection_snapshot_generations gen USING(space_id,snapshot_seq)
          WHERE gh.source_revision=rev AND gen.transport_event_id=prior_event AND gh.kind=kind AND gh.stream_key=key) THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
        SELECT jsonb_build_object('kind',sh.kind,'key',sh.stream_key,'revision',sh.source_revision,'eventId',sh.source_event_id,'payloadSha256',sh.source_sha256)
          INTO h FROM memory_ops.identity_projection_source_heads sh WHERE sh.source_revision=rev;
        IF h IS NULL OR h IS DISTINCT FROM prior_sources->rev::text THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
        IF NOT prior_grains ? grain_key THEN
          BEGIN fact:=memory_identity.projection_v3_snapshot_fact(prior,kind,key);
          EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END;
          extracts:=extracts+1;largest_fact:=greatest(largest_fact,octet_length(fact::text));prior_grains:=prior_grains||jsonb_build_object(grain_key,fact);
        END IF;
        fact:=prior_grains->grain_key;
        IF coalesce((witness.value->>'candidate')::boolean,false) AND fact IS DISTINCT FROM grains->grain_key THEN flags:=flags||'{"immutable_entity_conflict":true}'; END IF;
        IF coalesce((witness.value->>'current')::boolean,false) THEN
          SELECT value->'actual' INTO actual FROM jsonb_array_elements(row_values) WHERE value->>'kind'=kind AND value->>'id'=key;
          v:=fact->kind;
          IF kind='membership' THEN intended:=jsonb_build_object('id',v->'id','organization_id',v->'organizationId','account_id',v->'accountId','email_id',v->'emailId','role',v->'role','expires_at',v->'expiresAtMs','revoked_at',v->'revokedAtMs');
          ELSE intended:=jsonb_build_object('id',v->'id','account_id',v->'accountId','membership_id',v->'membershipId','email_id',v->'emailId','kind',v->'kind','token_digest',v->'tokenDigest',
            'permission',v->'permission','expires_at',v->'expiresAtMs','revoked_at',v->'revokedAtMs'); END IF;
          current_equal:=(actual-'reauthenticated_at'-'revoked_at') IS NOT DISTINCT FROM(intended-'revoked_at');
          comparisons:=jsonb_set(comparisons,ARRAY[grain_key,'actualMatchesCurrent'],to_jsonb(current_equal));
          IF NOT current_equal THEN flags:=flags||'{"immutable_entity_conflict":true}'; END IF;
        END IF;
      END LOOP;
      prior:=NULL;prior_grains:=NULL;prior_sources:=NULL;fact:=NULL;
    END LOOP;
  END IF;
  at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF at_ms NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF at_ms>=(p->'lease'->>'expiresAtMs')::bigint THEN flags:=flags||'{"lease_expired":true}'; END IF;
  IF(p->'lease'->>'issuedAtMs')::bigint>at_ms AND(p->'lease'->>'issuedAtMs')::bigint-at_ms>5000 THEN flags:=flags||'{"lease_issued_in_future":true}'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(grant_values) WHERE(value->>'expiresAtMs')::bigint<=at_ms) THEN flags:=flags||'{"authority_expired":true}'; END IF;
  meta:=meta||jsonb_build_object('observedAtMs',at_ms);
  metrics:=jsonb_build_object('validations',validations,'callerParses',parses,'bodyLoads',loads,'grainExtractions',extracts,'largestBodyBytes',largest_body,'largestFactTextBytes',largest_fact);
  RETURN jsonb_build_object('event',meta,'sources',sources,'grains',grains,'currentComparisons',comparisons,'grants',grant_values,'rows',row_values,'provision',provision,'usage',usage,'flags',flags,'metrics',metrics);
END
$plan$;

CREATE FUNCTION memory_identity.projection_v3_snapshot_classify(p_event_id uuid)
RETURNS TABLE(outcome text,reason text,observed_at_ms bigint)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $classify$
DECLARE plan jsonb; candidate text;
BEGIN
  plan:=memory_identity.projection_v3_snapshot_plan(p_event_id);observed_at_ms:=(plan->'event'->>'observedAtMs')::bigint;
  FOREACH candidate IN ARRAY ARRAY['snapshot_sequence_conflict','source_identity_conflict','newer_snapshot_present','lease_expired','lease_issued_in_future','authority_expired',
    'immutable_entity_conflict','provisioning_conflict','retained_row_disposition_conflict','terminal_identity_denied','lifecycle_denied','target_deselected','newer_dependency_present',
    'dependency_head_missing','dependency_head_behind','provisioning_missing','retained_row_disposition_missing'] LOOP
    IF plan->'flags' ? candidate THEN
      reason:=candidate;outcome:=CASE WHEN candidate IN('snapshot_sequence_conflict','source_identity_conflict','immutable_entity_conflict','provisioning_conflict','retained_row_disposition_conflict') THEN 'conflict'
        WHEN candidate IN('dependency_head_missing','dependency_head_behind','provisioning_missing','retained_row_disposition_missing') THEN 'dependency_pending' ELSE 'snapshot_superseded' END;
      RETURN NEXT;RETURN;
    END IF;
  END LOOP;
  outcome:='applied';reason:=CASE WHEN jsonb_array_length(plan->'grants')=0 THEN 'empty_snapshot_applied' ELSE 'snapshot_applied' END;RETURN NEXT;
END
$classify$;

CREATE FUNCTION memory_identity.projection_v3_snapshot_materialize(p_raw text,p_transport_sha256 text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $worker$
#variable_conflict use_column
DECLARE begun record; decision record; plan jsonb; r jsonb; v jsonb; g jsonb; h jsonb; rev jsonb; kind text; n integer; receipt text; sid text; seq bigint; expected_usage jsonb;
BEGIN
  SELECT * INTO begun FROM memory_ops.projection_v3_snapshot_ledger_begin(p_raw,p_transport_sha256);
  IF begun.replay_receipt_text IS NOT NULL THEN RETURN begun.replay_receipt_text; END IF;
  SELECT * INTO decision FROM memory_identity.projection_v3_snapshot_classify(begun.transport_event_id);
  IF decision.outcome<>'applied' THEN RETURN memory_ops.projection_v3_snapshot_ledger_append(begun.transport_event_id,p_transport_sha256,begun.next_attempt_no,decision.outcome,decision.reason); END IF;
  plan:=memory_identity.projection_v3_snapshot_plan(begun.transport_event_id);
  IF plan->'flags'<>'{}'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  sid:=plan->'event'->>'spaceId';seq:=(plan->'event'->>'snapshotSeq')::bigint;
  IF jsonb_array_length(plan->'grants')>0 THEN expected_usage:=coalesce(nullif(plan->'usage','null'::jsonb),
    jsonb_build_object('space_id',sid,'source_bytes',0,'message_count',0,'retained_source_bytes',0,'retained_message_count',0)); END IF;
  -- Materialize only preclassified rows. Every actual INSERT/UPDATE is checked.
  -- The only changes to existing positives are the three permitted field sets.
  FOR r IN SELECT value FROM jsonb_array_elements(plan->'rows') LOOP
    v:=r->'intended';kind:=r->>'kind';n:=0;
    IF r->'actual'='null'::jsonb THEN
      CASE kind
      WHEN 'account' THEN INSERT INTO memory_identity.accounts(id,disabled_at) VALUES(v->>'id',NULL);
      WHEN 'organization' THEN INSERT INTO memory_control.organizations(id,disabled_at) VALUES(v->>'id',NULL);
      WHEN 'provider_identity' THEN INSERT INTO memory_identity.provider_identities(issuer,subject,account_id,created_at) VALUES(v->>'issuer',v->>'subject',v->>'account_id',(v->>'created_at')::bigint);
      WHEN 'email' THEN INSERT INTO memory_identity.account_emails(id,account_id,address,domain,verified_at,revoked_at) VALUES(v->>'id',v->>'account_id',v->>'address',v->>'domain',(v->>'verified_at')::bigint,NULL);
      WHEN 'membership' THEN INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role,expires_at,revoked_at) VALUES(v->>'id',v->>'organization_id',v->>'account_id',v->>'email_id',v->>'role',(v->>'expires_at')::bigint,NULL);
      WHEN 'credential' THEN INSERT INTO memory_identity.credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,reauthenticated_at,revoked_at,permission)
        VALUES(v->>'id',v->>'account_id',v->>'membership_id',v->>'email_id',v->>'kind',v->>'token_digest',(v->>'expires_at')::bigint,NULL,NULL,v->>'permission');
      WHEN 'space' THEN INSERT INTO memory_control.spaces(id,owner_account_id,organization_id,deployment_id,data_policy,disabled_at,source_byte_limit,message_limit)
        VALUES(v->>'id',v->>'owner_account_id',v->>'organization_id',v->>'deployment_id',v->'data_policy',NULL,(v->>'source_byte_limit')::bigint,(v->>'message_limit')::integer);
      WHEN 'legacy_grant' THEN CONTINUE; -- Space exists before the FK-dependent grant.
      ELSE RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END CASE;
      GET DIAGNOSTICS n=ROW_COUNT;
      IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    ELSIF r->'actual' IS DISTINCT FROM v AND kind IN('membership','credential') THEN
      IF r->'provenance'<>'null'::jsonb AND(plan->'currentComparisons'->(kind||':'||(r->>'id'))->>'candidateOrder')::integer<>1 THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
      IF kind='membership' THEN UPDATE memory_identity.memberships SET role=v->>'role',expires_at=(v->>'expires_at')::bigint WHERE id=v->>'id';
      ELSE UPDATE memory_identity.credentials SET permission=v->>'permission',expires_at=(v->>'expires_at')::bigint WHERE id=v->>'id'; END IF;
      GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END IF;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(plan->'rows') WHERE value->>'kind'='legacy_grant' LOOP
    v:=r->'intended';
    IF r->'actual'='null'::jsonb THEN
      INSERT INTO memory_identity.pat_space_grants(credential_id,account_id,space_id,can_ingest,can_search,expires_at,revoked_at,can_erase,can_retire)
        VALUES(v->>'credential_id',v->>'account_id',v->>'space_id',(v->>'can_ingest')::boolean,(v->>'can_search')::boolean,(v->>'expires_at')::bigint,NULL,false,false);
    ELSIF r->'actual' IS DISTINCT FROM v THEN
      UPDATE memory_identity.pat_space_grants SET can_ingest=(v->>'can_ingest')::boolean,can_search=(v->>'can_search')::boolean,expires_at=(v->>'expires_at')::bigint
        WHERE credential_id=v->>'credential_id' AND space_id=v->>'space_id';
    ELSE CONTINUE; END IF;
    GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
  IF jsonb_array_length(plan->'grants')>0 AND plan->'usage'='null'::jsonb THEN
    INSERT INTO memory_ops.space_usage(space_id,source_bytes,message_count,retained_source_bytes,retained_message_count) VALUES(sid,0,0,0,0);
    GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(plan->'rows') LOOP
    v:=r->'intended';kind:=r->>'kind';
    -- Assert complete after row, including the current regional preservation.
    CASE kind
    WHEN 'account' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.accounts x WHERE x.id=v->>'id';
    WHEN 'organization' THEN SELECT to_jsonb(x) INTO h FROM memory_control.organizations x WHERE x.id=v->>'id';
    WHEN 'provider_identity' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.provider_identities x WHERE x.issuer=v->>'issuer' AND x.subject=v->>'subject';
    WHEN 'email' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.account_emails x WHERE x.id=v->>'id';
    WHEN 'membership' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.memberships x WHERE x.id=v->>'id';
    WHEN 'credential' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.credentials x WHERE x.id=v->>'id';
    WHEN 'space' THEN SELECT to_jsonb(x) INTO h FROM memory_control.spaces x WHERE x.id=v->>'id';
    WHEN 'legacy_grant' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.pat_space_grants x WHERE x.credential_id=v->>'credential_id' AND x.space_id=v->>'space_id';
    END CASE;
    IF h IS DISTINCT FROM v THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    IF r->'provenance'='null'::jsonb THEN
      IF kind='provider_identity' THEN
        INSERT INTO memory_identity.identity_projection_provider_entities(issuer,subject,account_id,created_at,origin,first_snapshot_event_id,disposition_approval_id,first_binding)
          VALUES(v->>'issuer',v->>'subject',v->>'account_id',(v->>'created_at')::bigint,CASE WHEN r->'actual'='null'::jsonb THEN 'creation' ELSE 'retained_adoption' END,
            begun.transport_event_id,(r->'approval'->>'approval_id')::uuid,v);
      ELSIF kind='legacy_grant' THEN
        INSERT INTO memory_identity.identity_projection_legacy_grant_entities(credential_id,space_id,account_id,origin,first_snapshot_event_id,disposition_approval_id,first_binding)
          VALUES(v->>'credential_id',v->>'space_id',v->>'account_id',CASE WHEN r->'actual'='null'::jsonb THEN 'creation' ELSE 'retained_adoption' END,
            begun.transport_event_id,(r->'approval'->>'approval_id')::uuid,v);
      ELSE
        INSERT INTO memory_identity.identity_projection_entities(entity_kind,entity_id,origin,first_snapshot_event_id,disposition_approval_id,first_binding)
          VALUES(kind,v->>'id',CASE WHEN r->'actual'='null'::jsonb THEN 'creation' ELSE 'retained_adoption' END,begun.transport_event_id,(r->'approval'->>'approval_id')::uuid,v);
      END IF;
      GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END IF;
  END LOOP;
  IF expected_usage IS NOT NULL THEN
    SELECT to_jsonb(x) INTO h FROM memory_ops.space_usage x WHERE x.space_id=sid;
    IF h IS DISTINCT FROM expected_usage THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END IF;
  FOR h IN SELECT value FROM jsonb_each(plan->'sources') WHERE value->>'kind'<>'target' ORDER BY key::bigint LOOP
    IF h->'firstSnapshotEventId'='null'::jsonb THEN
      INSERT INTO memory_identity.identity_projection_source_facts(source_revision,first_snapshot_event_id) VALUES((h->>'revision')::bigint,begun.transport_event_id);
      GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END IF;
    IF h->>'kind' IN('membership','credential') THEN
      INSERT INTO memory_identity.identity_projection_mutable_fact_current(kind,entity_id,source_revision) VALUES(h->>'kind',h->>'key',(h->>'revision')::bigint)
        ON CONFLICT(kind,entity_id) DO UPDATE SET source_revision=EXCLUDED.source_revision
          WHERE memory_identity.identity_projection_mutable_fact_current.source_revision<EXCLUDED.source_revision;
      -- Equal revisions intentionally produce no update; assertion checks exactness.
    END IF;
  END LOOP;
  INSERT INTO memory_ops.identity_projection_snapshot_generations(space_id,snapshot_seq,transport_event_id,selected,lease_issued_at_ms,lease_expires_at_ms,grant_count,provisioning_approval_id)
    VALUES(sid,seq,begun.transport_event_id,(plan->'event'->>'selected')::boolean,(plan->'event'->'lease'->>'issuedAtMs')::bigint,
      (plan->'event'->'lease'->>'expiresAtMs')::bigint,jsonb_array_length(plan->'grants'),(plan->'provision'->>'approval_id')::uuid);
  GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(plan->'grants') LOOP
    INSERT INTO memory_identity.identity_projection_grants(space_id,snapshot_seq,credential_id,account_id,provenance,credential_policy,can_ingest,can_search,can_erase,can_retire,expires_at_ms,revoked_at_ms)
      VALUES(sid,seq,g->>'credentialId',g->>'accountId',g->>'provenance',plan->'grains'->('credential:'||(g->>'credentialId'))->'credentialPolicy',
        (g->>'canIngest')::boolean,(g->>'canSearch')::boolean,false,false,(g->>'expiresAtMs')::bigint,NULL);
    GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    FOR rev IN SELECT value FROM jsonb_array_elements(g->'sourceRevisions') LOOP
      h:=plan->'sources'->(rev#>>'{}');
      INSERT INTO memory_identity.identity_projection_grant_heads(space_id,snapshot_seq,credential_id,kind,stream_key,source_revision)
        VALUES(sid,seq,g->>'credentialId',h->>'kind',h->>'key',(h->>'revision')::bigint);
      GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
  END LOOP;
  INSERT INTO memory_ops.identity_projection_space_state(space_id,current_sequence) VALUES(sid,seq)
    ON CONFLICT(space_id) DO UPDATE SET current_sequence=EXCLUDED.current_sequence;
  GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  receipt:=memory_ops.projection_v3_snapshot_ledger_append(begun.transport_event_id,p_transport_sha256,begun.next_attempt_no,decision.outcome,decision.reason);
  PERFORM memory_identity.projection_v3_snapshot_materialization_assert(begun.transport_event_id,begun.next_attempt_no);
  -- Reuse the original before-write bindings after all stage/receipt triggers.
  -- A freshly derived plan cannot recover changed regional preservation fields.
  FOR r IN SELECT value FROM jsonb_array_elements(plan->'rows') LOOP
    v:=r->'intended';kind:=r->>'kind';
    CASE kind
    WHEN 'account' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.accounts x WHERE x.id=v->>'id';
    WHEN 'organization' THEN SELECT to_jsonb(x) INTO h FROM memory_control.organizations x WHERE x.id=v->>'id';
    WHEN 'provider_identity' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.provider_identities x WHERE x.issuer=v->>'issuer' AND x.subject=v->>'subject';
    WHEN 'email' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.account_emails x WHERE x.id=v->>'id';
    WHEN 'membership' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.memberships x WHERE x.id=v->>'id';
    WHEN 'credential' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.credentials x WHERE x.id=v->>'id';
    WHEN 'space' THEN SELECT to_jsonb(x) INTO h FROM memory_control.spaces x WHERE x.id=v->>'id';
    WHEN 'legacy_grant' THEN SELECT to_jsonb(x) INTO h FROM memory_identity.pat_space_grants x WHERE x.credential_id=v->>'credential_id' AND x.space_id=v->>'space_id';
    END CASE;
    IF h IS DISTINCT FROM v THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
  IF expected_usage IS NOT NULL THEN
    SELECT to_jsonb(x) INTO h FROM memory_ops.space_usage x WHERE x.space_id=sid;
    IF h IS DISTINCT FROM expected_usage THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END IF;
  RETURN receipt;
END
$worker$;

CREATE FUNCTION memory_identity.projection_v3_snapshot_materialization_assert(p_event_id uuid,p_attempt_no bigint) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $assert$
DECLARE plan jsonb; gen memory_ops.identity_projection_snapshot_generations%ROWTYPE; r memory_ops.identity_projection_receipts%ROWTYPE;
  g jsonb; h jsonb; v jsonb; expected jsonb; actual jsonb; sid text; seq bigint; expected_heads integer:=0;
BEGIN
  plan:=memory_identity.projection_v3_snapshot_plan(p_event_id);sid:=plan->'event'->>'spaceId';seq:=(plan->'event'->>'snapshotSeq')::bigint;
  IF plan->'flags'<>'{}'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO r FROM memory_ops.identity_projection_receipts WHERE transport_event_id=p_event_id AND attempt_no=p_attempt_no;
  IF NOT FOUND OR r.outcome<>'applied' OR r.reason IS DISTINCT FROM(CASE WHEN jsonb_array_length(plan->'grants')=0 THEN 'empty_snapshot_applied' ELSE 'snapshot_applied' END) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO gen FROM memory_ops.identity_projection_snapshot_generations WHERE space_id=sid AND snapshot_seq=seq;
  IF NOT FOUND OR gen.transport_event_id<>p_event_id OR gen.selected IS DISTINCT FROM(plan->'event'->>'selected')::boolean
    OR gen.lease_issued_at_ms<>(plan->'event'->'lease'->>'issuedAtMs')::bigint OR gen.lease_expires_at_ms<>(plan->'event'->'lease'->>'expiresAtMs')::bigint
    OR gen.grant_count<>jsonb_array_length(plan->'grants') OR gen.provisioning_approval_id IS DISTINCT FROM(plan->'provision'->>'approval_id')::uuid
    OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_space_state WHERE space_id=sid AND current_sequence=seq)
    OR(SELECT count(*) FROM memory_identity.identity_projection_grants WHERE space_id=sid AND snapshot_seq=seq)<>gen.grant_count THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(plan->'grants') LOOP
    expected:=jsonb_build_object('space_id',sid,'snapshot_seq',seq,'credential_id',g->'credentialId','account_id',g->'accountId','provenance',g->'provenance',
      'credential_policy',plan->'grains'->('credential:'||(g->>'credentialId'))->'credentialPolicy','can_ingest',g->'canIngest','can_search',g->'canSearch',
      'can_erase',false,'can_retire',false,'expires_at_ms',g->'expiresAtMs','revoked_at_ms',NULL);
    SELECT to_jsonb(x) INTO actual FROM memory_identity.identity_projection_grants x WHERE x.space_id=sid AND x.snapshot_seq=seq AND x.credential_id=g->>'credentialId';
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    expected_heads:=expected_heads+jsonb_array_length(g->'sourceRevisions');
    FOR v IN SELECT value FROM jsonb_array_elements(g->'sourceRevisions') LOOP
      h:=plan->'sources'->(v#>>'{}');
      IF NOT EXISTS(SELECT 1 FROM memory_identity.identity_projection_grant_heads x JOIN memory_ops.identity_projection_source_heads s ON s.source_revision=x.source_revision
        WHERE x.space_id=sid AND x.snapshot_seq=seq AND x.credential_id=g->>'credentialId' AND x.kind=h->>'kind' AND x.stream_key=h->>'key'
          AND x.source_revision=(h->>'revision')::bigint AND s.source_event_id=(h->>'eventId')::uuid AND s.source_sha256=h->>'payloadSha256'
          AND s.kind=x.kind AND s.stream_key=x.stream_key) THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    END LOOP;
  END LOOP;
  IF(SELECT count(*) FROM memory_identity.identity_projection_grant_heads WHERE space_id=sid AND snapshot_seq=seq)<>expected_heads THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(plan->'rows') LOOP
    IF v->'actual' IS DISTINCT FROM v->'intended' OR v->'provenance'='null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    IF v->'provenance'->>'origin'='creation' AND(v->'provenance'->>'first_snapshot_event_id')::uuid=p_event_id
      AND((v->>'kind'='credential' AND v->'actual'->'reauthenticated_at' IS DISTINCT FROM 'null'::jsonb)
        OR(v->>'kind'='legacy_grant' AND(v->'actual'->'can_erase' IS DISTINCT FROM 'false'::jsonb OR v->'actual'->'can_retire' IS DISTINCT FROM 'false'::jsonb))) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
  FOR h IN SELECT value FROM jsonb_each(plan->'sources') WHERE value->>'kind'<>'target' LOOP
    IF h->'firstSnapshotEventId'='null'::jsonb OR(h->>'kind' IN('membership','credential') AND NOT EXISTS(SELECT 1 FROM memory_identity.identity_projection_mutable_fact_current c
      WHERE c.kind=h->>'kind' AND c.entity_id=h->>'key' AND c.source_revision=(h->>'revision')::bigint)) THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
  IF gen.grant_count=0 AND(EXISTS(SELECT 1 FROM memory_identity.identity_projection_source_facts WHERE first_snapshot_event_id=p_event_id)
    OR EXISTS(SELECT 1 FROM memory_identity.identity_projection_entities WHERE first_snapshot_event_id=p_event_id)
    OR EXISTS(SELECT 1 FROM memory_identity.identity_projection_provider_entities WHERE first_snapshot_event_id=p_event_id)
    OR EXISTS(SELECT 1 FROM memory_identity.identity_projection_legacy_grant_entities WHERE first_snapshot_event_id=p_event_id)) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF gen.grant_count>0 AND(plan->'usage'='null'::jsonb OR(plan->'usage'->>'source_bytes')::bigint<0 OR(plan->'usage'->>'message_count')::bigint<0
    OR(plan->'usage'->>'retained_source_bytes')::bigint<0 OR(plan->'usage'->>'retained_message_count')::bigint<0
    OR(plan->'usage'->>'retained_source_bytes')::bigint>(plan->'usage'->>'source_bytes')::bigint
    OR(plan->'usage'->>'retained_message_count')::bigint>(plan->'usage'->>'message_count')::bigint) THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF gen.grant_count>0 AND EXISTS(SELECT 1 FROM memory_identity.identity_projection_entities pe WHERE pe.entity_kind='space' AND pe.entity_id=sid
    AND pe.origin='creation' AND pe.first_snapshot_event_id=p_event_id) AND plan->'usage' IS DISTINCT FROM
      jsonb_build_object('space_id',sid,'source_bytes',0,'message_count',0,'retained_source_bytes',0,'retained_message_count',0) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
END
$assert$;

CREATE FUNCTION memory_ops.projection_v3_materialization_insert_fence() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fence$
BEGIN
  IF current_user<>'memory_projection_owner' OR current_setting('transaction_isolation')<>'read committed' OR TG_OP NOT IN('INSERT','UPDATE') THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  PERFORM f.id FROM memory_ops.identity_projection_fence f WHERE f.id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;RETURN NULL;
END
$fence$;
CREATE FUNCTION memory_identity.projection_v3_materialization_row() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $row$
DECLARE actual jsonb; expected jsonb; approval jsonb; v jsonb:=to_jsonb(NEW); kind text; event_id uuid;
BEGIN
  IF TG_OP<>'INSERT' OR current_user<>'memory_projection_owner' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  -- A completed immutable generation cannot acquire or repair children later.
  -- Before receipt insertion the full receipt assertion proves the exact set.
  IF TG_TABLE_NAME='identity_projection_snapshot_generations' THEN event_id:=(v->>'transport_event_id')::uuid;
  ELSIF TG_TABLE_NAME IN('identity_projection_grants','identity_projection_grant_heads') THEN
    SELECT transport_event_id INTO event_id FROM memory_ops.identity_projection_snapshot_generations WHERE space_id=v->>'space_id' AND snapshot_seq=(v->>'snapshot_seq')::bigint;
  ELSE event_id:=(v->>'first_snapshot_event_id')::uuid; END IF;
  IF event_id IS NULL OR EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts WHERE transport_event_id=event_id AND outcome='applied') THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF TG_TABLE_NAME='identity_projection_snapshot_generations' THEN
    IF NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_events e WHERE e.transport_event_id=NEW.transport_event_id AND e.event_kind='snapshot'
      AND e.space_id=NEW.space_id AND e.snapshot_seq=NEW.snapshot_seq) THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  ELSIF TG_TABLE_NAME='identity_projection_source_facts' THEN
    IF NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_source_heads s WHERE s.source_revision=NEW.source_revision AND s.kind IN('subject','email','organization','membership','credential','space'))
      OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_events WHERE transport_event_id=NEW.first_snapshot_event_id AND event_kind='snapshot') THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  ELSIF TG_TABLE_NAME IN('identity_projection_entities','identity_projection_provider_entities','identity_projection_legacy_grant_entities') THEN
    kind:=CASE TG_TABLE_NAME WHEN 'identity_projection_entities' THEN v->>'entity_kind' WHEN 'identity_projection_provider_entities' THEN 'provider_identity' ELSE 'legacy_grant' END;
    CASE kind
    WHEN 'account' THEN SELECT to_jsonb(x) INTO actual FROM memory_identity.accounts x WHERE x.id=v->>'entity_id';
    WHEN 'organization' THEN SELECT to_jsonb(x) INTO actual FROM memory_control.organizations x WHERE x.id=v->>'entity_id';
    WHEN 'email' THEN SELECT to_jsonb(x) INTO actual FROM memory_identity.account_emails x WHERE x.id=v->>'entity_id';
    WHEN 'membership' THEN SELECT to_jsonb(x) INTO actual FROM memory_identity.memberships x WHERE x.id=v->>'entity_id';
    WHEN 'credential' THEN SELECT to_jsonb(x) INTO actual FROM memory_identity.credentials x WHERE x.id=v->>'entity_id';
    WHEN 'space' THEN SELECT to_jsonb(x) INTO actual FROM memory_control.spaces x WHERE x.id=v->>'entity_id';
    WHEN 'provider_identity' THEN
      SELECT to_jsonb(x) INTO actual FROM memory_identity.provider_identities x WHERE x.issuer=v->>'issuer' AND x.subject=v->>'subject';
      IF actual->'account_id' IS DISTINCT FROM v->'account_id' OR actual->'created_at' IS DISTINCT FROM v->'created_at' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    WHEN 'legacy_grant' THEN
      SELECT to_jsonb(x) INTO actual FROM memory_identity.pat_space_grants x WHERE x.credential_id=v->>'credential_id' AND x.space_id=v->>'space_id';
      IF actual->'account_id' IS DISTINCT FROM v->'account_id' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    ELSE RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END CASE;
    IF actual IS NULL OR actual IS DISTINCT FROM v->'first_binding' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    IF v->>'origin'='retained_adoption' THEN
      SELECT jsonb_build_object('entity_kind',d.entity_kind,'entity_id',d.entity_id,'issuer',d.issuer,'subject',d.subject,'credential_id',d.credential_id,'space_id',d.space_id,'authorized_binding',d.authorized_binding)
        INTO approval FROM memory_identity.identity_projection_retained_dispositions d WHERE d.approval_id=(v->>'disposition_approval_id')::uuid;
      IF approval IS NULL OR approval->>'entity_kind' IS DISTINCT FROM kind OR approval->'authorized_binding' IS DISTINCT FROM actual
        OR(kind NOT IN('provider_identity','legacy_grant') AND approval->>'entity_id' IS DISTINCT FROM v->>'entity_id')
        OR(kind='provider_identity' AND(approval->>'issuer' IS DISTINCT FROM v->>'issuer' OR approval->>'subject' IS DISTINCT FROM v->>'subject'))
        OR(kind='legacy_grant' AND(approval->>'credential_id' IS DISTINCT FROM v->>'credential_id' OR approval->>'space_id' IS DISTINCT FROM v->>'space_id')) THEN
        RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    ELSIF v->>'origin' IS DISTINCT FROM 'creation' OR v->'disposition_approval_id' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  ELSIF TG_TABLE_NAME='identity_projection_grants' THEN
    BEGIN PERFORM memory_identity.projection_v3_snapshot_value(NEW.credential_policy,'credentialPolicy',NULL);
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END;
  ELSIF TG_TABLE_NAME<>'identity_projection_grant_heads' THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  RETURN NEW;
END
$row$;
CREATE FUNCTION memory_identity.projection_v3_materialization_pointer() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $pointer$
DECLARE event_id uuid; equal_existing boolean:=false;
BEGIN
  IF current_user<>'memory_projection_owner' OR TG_OP NOT IN('INSERT','UPDATE') THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF TG_TABLE_SCHEMA='memory_ops' AND TG_TABLE_NAME='identity_projection_space_state' THEN
    IF TG_OP='UPDATE' AND(NEW.space_id IS DISTINCT FROM OLD.space_id OR NEW.current_sequence<=OLD.current_sequence) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    SELECT transport_event_id INTO event_id FROM memory_ops.identity_projection_snapshot_generations WHERE space_id=NEW.space_id AND snapshot_seq=NEW.current_sequence;
  ELSIF TG_TABLE_SCHEMA='memory_identity' AND TG_TABLE_NAME='identity_projection_mutable_fact_current' THEN
    IF TG_OP='UPDATE' AND(NEW.kind IS DISTINCT FROM OLD.kind OR NEW.entity_id IS DISTINCT FROM OLD.entity_id OR NEW.source_revision<=OLD.source_revision) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    IF NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_source_heads WHERE source_revision=NEW.source_revision AND kind=NEW.kind AND stream_key=NEW.entity_id)
      OR NOT EXISTS(SELECT 1 FROM memory_identity.identity_projection_source_facts WHERE source_revision=NEW.source_revision) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    SELECT first_snapshot_event_id INTO event_id FROM memory_identity.identity_projection_source_facts WHERE source_revision=NEW.source_revision;
    -- BEFORE INSERT also runs for the worker's unchanged ON CONFLICT branch.
    equal_existing:=TG_OP='INSERT' AND EXISTS(SELECT 1 FROM memory_identity.identity_projection_mutable_fact_current
      WHERE kind=NEW.kind AND entity_id=NEW.entity_id AND source_revision=NEW.source_revision);
  ELSE RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF event_id IS NULL OR(NOT equal_existing AND EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts WHERE transport_event_id=event_id AND outcome='applied')) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  RETURN NEW;
END
$pointer$;
CREATE FUNCTION memory_identity.projection_v3_materialization_receipt() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $receipt$
DECLARE event_kind text; decision record;
BEGIN
  IF TG_TABLE_SCHEMA<>'memory_ops' OR TG_TABLE_NAME<>'identity_projection_receipts' OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT e.event_kind INTO event_kind FROM memory_ops.identity_projection_events e WHERE e.transport_event_id=NEW.transport_event_id;
  IF event_kind='head' THEN RETURN NULL; END IF;
  IF event_kind IS DISTINCT FROM 'snapshot' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF NEW.outcome='applied' THEN PERFORM memory_identity.projection_v3_snapshot_materialization_assert(NEW.transport_event_id,NEW.attempt_no);
  ELSE
    SELECT * INTO decision FROM memory_identity.projection_v3_snapshot_classify(NEW.transport_event_id);
    IF decision.outcome IS DISTINCT FROM NEW.outcome OR decision.reason IS DISTINCT FROM NEW.reason
      OR EXISTS(SELECT 1 FROM memory_ops.identity_projection_snapshot_generations WHERE transport_event_id=NEW.transport_event_id)
      OR EXISTS(SELECT 1 FROM memory_identity.identity_projection_source_facts WHERE first_snapshot_event_id=NEW.transport_event_id)
      OR EXISTS(SELECT 1 FROM memory_identity.identity_projection_entities WHERE first_snapshot_event_id=NEW.transport_event_id)
      OR EXISTS(SELECT 1 FROM memory_identity.identity_projection_provider_entities WHERE first_snapshot_event_id=NEW.transport_event_id)
      OR EXISTS(SELECT 1 FROM memory_identity.identity_projection_legacy_grant_entities WHERE first_snapshot_event_id=NEW.transport_event_id) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END IF;
  RETURN NULL;
END
$receipt$;
CREATE FUNCTION memory_identity.projection_v3_materialization_complete() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $complete$
DECLARE v jsonb:=to_jsonb(NEW); event_id uuid; gen memory_ops.identity_projection_snapshot_generations%ROWTYPE; kind text; relevant boolean:=false;
BEGIN
  IF TG_TABLE_SCHEMA='memory_ops' AND TG_TABLE_NAME='identity_projection_receipts' THEN
    IF EXISTS(SELECT 1 FROM memory_ops.identity_projection_events WHERE transport_event_id=NEW.transport_event_id AND event_kind='snapshot') AND NEW.outcome='applied' THEN
      PERFORM memory_identity.projection_v3_snapshot_materialization_assert(NEW.transport_event_id,NEW.attempt_no);
    END IF;RETURN NULL;
  END IF;
  -- Indexed local completion, never one full candidate parse per child.
  IF TG_TABLE_NAME='identity_projection_snapshot_generations' THEN event_id:=(v->>'transport_event_id')::uuid;
  ELSIF TG_TABLE_NAME IN('identity_projection_space_state','identity_projection_grants','identity_projection_grant_heads') THEN
    SELECT transport_event_id INTO event_id FROM memory_ops.identity_projection_snapshot_generations WHERE space_id=v->>'space_id'
      AND snapshot_seq=coalesce((v->>'snapshot_seq')::bigint,(v->>'current_sequence')::bigint);
  ELSIF TG_TABLE_NAME='identity_projection_mutable_fact_current' THEN
    SELECT first_snapshot_event_id INTO event_id FROM memory_identity.identity_projection_source_facts WHERE source_revision=(v->>'source_revision')::bigint;
  ELSE event_id:=(v->>'first_snapshot_event_id')::uuid; END IF;
  SELECT * INTO gen FROM memory_ops.identity_projection_snapshot_generations WHERE transport_event_id=event_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM memory_ops.identity_projection_receipts WHERE transport_event_id=event_id AND outcome='applied') THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF TG_TABLE_NAME IN('identity_projection_source_facts','identity_projection_mutable_fact_current') THEN
    IF gen.grant_count=0 OR NOT EXISTS(SELECT 1 FROM memory_identity.identity_projection_grant_heads gh WHERE gh.space_id=gen.space_id AND gh.snapshot_seq=gen.snapshot_seq
      AND gh.source_revision=(v->>'source_revision')::bigint AND gh.kind<>'target') THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  ELSIF TG_TABLE_NAME IN('identity_projection_entities','identity_projection_provider_entities','identity_projection_legacy_grant_entities') THEN
    IF gen.grant_count=0 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
    IF TG_TABLE_NAME='identity_projection_provider_entities' THEN
      SELECT EXISTS(SELECT 1 FROM memory_identity.identity_projection_grants pg JOIN memory_identity.identity_projection_grant_heads gh USING(space_id,snapshot_seq,credential_id)
        WHERE pg.space_id=gen.space_id AND pg.snapshot_seq=gen.snapshot_seq AND pg.account_id=v->>'account_id'
          AND gh.kind='subject' AND gh.stream_key=(v->>'issuer')||E'\n'||(v->>'subject')) INTO relevant;
    ELSIF TG_TABLE_NAME='identity_projection_legacy_grant_entities' THEN
      SELECT EXISTS(SELECT 1 FROM memory_identity.identity_projection_grants WHERE space_id=gen.space_id AND snapshot_seq=gen.snapshot_seq AND credential_id=v->>'credential_id' AND space_id=v->>'space_id') INTO relevant;
    ELSE
      kind:=v->>'entity_kind';
      SELECT EXISTS(SELECT 1 FROM memory_identity.identity_projection_grants g JOIN memory_identity.credentials c ON c.id=g.credential_id
        LEFT JOIN memory_identity.memberships m ON m.id=c.membership_id
        WHERE g.space_id=gen.space_id AND g.snapshot_seq=gen.snapshot_seq AND CASE(v->>'entity_kind')
          WHEN 'account' THEN g.account_id=v->>'entity_id' WHEN 'credential' THEN g.credential_id=v->>'entity_id' WHEN 'space' THEN g.space_id=v->>'entity_id'
          WHEN 'email' THEN c.email_id=v->>'entity_id' WHEN 'membership' THEN c.membership_id=v->>'entity_id' WHEN 'organization' THEN m.organization_id=v->>'entity_id' ELSE false END) INTO relevant;
    END IF;
    IF NOT relevant THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END IF;
  RETURN NULL;
END
$complete$;

DO $function_acl$
DECLARE f record; a record;
BEGIN
  FOR f IN SELECT p.*,p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN('memory_identity','memory_ops') AND(p.proname LIKE 'projection_v3_materialization_%' OR p.proname IN('projection_v3_snapshot_plan','projection_v3_snapshot_materialize','projection_v3_snapshot_classify','projection_v3_snapshot_materialization_assert')) LOOP
    FOR a IN SELECT DISTINCT grantee FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) WHERE grantee<>f.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s RESTRICT',f.signature,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
    END LOOP;
  END LOOP;
END
$function_acl$;
GRANT EXECUTE ON FUNCTION memory_ops.projection_v3_materialization_insert_fence(),memory_identity.projection_v3_materialization_row(),
  memory_identity.projection_v3_materialization_pointer(),memory_identity.projection_v3_materialization_receipt(),memory_identity.projection_v3_materialization_complete() TO memory_owner;
SET LOCAL ROLE memory_owner;
DO $triggers$
DECLARE n text; rel regclass; pointer boolean;
BEGIN
  FOREACH n IN ARRAY ARRAY['memory_ops.identity_projection_snapshot_generations','memory_ops.identity_projection_space_state',
    'memory_identity.identity_projection_grants','memory_identity.identity_projection_grant_heads','memory_identity.identity_projection_source_facts',
    'memory_identity.identity_projection_mutable_fact_current','memory_identity.identity_projection_entities',
    'memory_identity.identity_projection_provider_entities','memory_identity.identity_projection_legacy_grant_entities'] LOOP
    rel:=n::regclass;pointer:=n IN('memory_ops.identity_projection_space_state','memory_identity.identity_projection_mutable_fact_current');
    EXECUTE format('CREATE TRIGGER materialization_insert_fence BEFORE INSERT %s ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_ops.projection_v3_materialization_insert_fence()',CASE WHEN pointer THEN 'OR UPDATE' ELSE '' END,rel);
    EXECUTE format('CREATE TRIGGER %I BEFORE %s DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation()',CASE WHEN pointer THEN 'materialization_no_delete' ELSE 'materialization_no_mutation' END,CASE WHEN pointer THEN '' ELSE 'UPDATE OR' END,rel);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT %s ON %s FOR EACH ROW EXECUTE FUNCTION memory_identity.%I()',CASE WHEN pointer THEN 'materialization_pointer' ELSE 'materialization_row' END,
      CASE WHEN pointer THEN 'OR UPDATE' ELSE '' END,rel,CASE WHEN pointer THEN 'projection_v3_materialization_pointer' ELSE 'projection_v3_materialization_row' END);
    EXECUTE format('CREATE CONSTRAINT TRIGGER materialization_complete AFTER INSERT %s ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_identity.projection_v3_materialization_complete()',CASE WHEN pointer THEN 'OR UPDATE' ELSE '' END,rel);
  END LOOP;
END
$triggers$;
CREATE TRIGGER materialization_receipt_observed AFTER INSERT ON memory_ops.identity_projection_receipts FOR EACH ROW EXECUTE FUNCTION memory_identity.projection_v3_materialization_receipt();
CREATE CONSTRAINT TRIGGER materialization_receipt_complete AFTER INSERT ON memory_ops.identity_projection_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_identity.projection_v3_materialization_complete();
REVOKE CREATE ON SCHEMA memory_identity,memory_ops FROM memory_projection_owner;
SET LOCAL ROLE memory_projection_owner;
REVOKE EXECUTE ON FUNCTION memory_ops.projection_v3_materialization_insert_fence(),memory_identity.projection_v3_materialization_row(),
  memory_identity.projection_v3_materialization_pointer(),memory_identity.projection_v3_materialization_receipt(),memory_identity.projection_v3_materialization_complete() FROM memory_owner;
DO $postflight$
BEGIN
  IF has_schema_privilege('memory_projection_owner','memory_identity','CREATE') OR has_schema_privilege('memory_projection_owner','memory_ops','CREATE')
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN('memory_identity','memory_ops') AND(p.proname LIKE 'projection_v3_materialization_%' OR p.proname IN('projection_v3_snapshot_plan','projection_v3_snapshot_materialize','projection_v3_snapshot_classify','projection_v3_snapshot_materialization_assert'))
      AND(p.proowner<>'memory_projection_owner'::regrole OR p.provolatile<>'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
        OR p.prosecdef<>(p.proname IN('projection_v3_materialization_receipt','projection_v3_materialization_complete'))
        OR p.proacl IS DISTINCT FROM ARRAY['memory_projection_owner=X/memory_projection_owner'::aclitem])) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
END
$postflight$;
RESET ROLE;
COMMIT;

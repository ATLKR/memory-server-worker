-- INACTIVE LOCAL DRAFT. Disposable schema5 + head foundation + validation +
-- ledger A + facts B1 + materialization B2 + dispatch drafts only; not an
-- installed migration or a production setup value. This is the remaining
-- half of unit C: the serving authorizer learns the projected admission
-- predicates and the dedicated projection dispatcher login is created.
--
-- seoul_action_authority is replaced so that every named-Space action
-- additionally requires that Space's current projected generation to be
-- selected with a live lease, an exact matching projected grant row whose
-- recorded dependency head vector is still the current head state, and flag
-- consistency between the legacy and projected grant rows. The unscoped
-- 'check' action now requires at least one qualifying projected grant on a
-- currently selected Space and never discloses which one. 'revoke' keeps its
-- credential-scoped terminal semantics unchanged.
--
-- No other serving function, route, table or positive DML surface changes.
-- The projection stays inactive: this file is reviewed draft SQL loaded
-- explicitly by tests, and regional authority remains unready until the
-- coherent installation, backfill and live-acceptance gates complete.
BEGIN;
DO $preflight$
DECLARE owner_id regrole:='memory_owner'; code_id regrole:='memory_projection_owner';
  caller_id regrole:='memory_projection_caller'; lifecycle_id regrole:='memory_lifecycle';
  dispatcher_name text:='memory_projection_dispatcher';
  prow record; c record;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF NOT pg_has_role(session_user,owner_id,'SET') OR NOT pg_has_role(session_user,code_id,'SET')
    OR NOT pg_has_role(session_user,lifecycle_id,'SET') THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=dispatcher_name)
    OR to_regprocedure('memory_identity.projection_v3_serving_bound(text,text,text,text,text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  -- The projection and lifecycle roles keep their reviewed attributes; the
  -- dispatcher is the only projected caller login this draft may add.
  IF EXISTS(SELECT 1 FROM pg_roles WHERE oid IN(owner_id,code_id,caller_id,lifecycle_id)
      AND(rolsuper OR rolinherit OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN(code_id,caller_id,lifecycle_id))
    OR EXISTS(SELECT 1 FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname<>session_user AND r.oid NOT IN(owner_id,code_id,caller_id,lifecycle_id)
      AND (pg_has_role(r.oid,owner_id,'SET') OR pg_has_role(r.oid,owner_id,'USAGE') OR pg_has_role(r.oid,code_id,'SET') OR pg_has_role(r.oid,code_id,'USAGE')
        OR pg_has_role(r.oid,lifecycle_id,'SET') OR pg_has_role(r.oid,lifecycle_id,'USAGE') OR pg_has_role(r.oid,caller_id,'USAGE')))
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE m.roleid=caller_id
      AND NOT r.rolsuper AND r.rolname<>session_user AND(m.admin_option OR m.inherit_option)) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  -- The dispatch draft must already have routed the caller apply entry to the
  -- materializer, and the v5 authorizer chain must exist.
  IF to_regprocedure('memory_identity.seoul_projection_apply(text,text)') IS NULL
    OR to_regprocedure('memory_identity.projection_v3_snapshot_materialize(text,text)') IS NULL
    OR to_regprocedure('memory_identity.seoul_action_authority(text,text,text,uuid)') IS NULL
    OR to_regprocedure('memory_identity.seoul_pat_authority(text,text,boolean)') IS NULL
    OR to_regprocedure('memory_identity.seoul_pat_check(text)') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT * INTO prow FROM pg_proc WHERE oid='memory_identity.seoul_projection_apply(text,text)'::regprocedure;
  IF position('seoul-authority-snapshot' IN prow.prosrc)=0 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  FOR c IN SELECT * FROM pg_class WHERE oid IN(
    'memory_ops.identity_projection_space_state'::regclass,'memory_ops.identity_projection_snapshot_generations'::regclass,
    'memory_ops.identity_projection_heads'::regclass,'memory_identity.identity_projection_grants'::regclass,
    'memory_identity.identity_projection_grant_heads'::regclass) LOOP
    IF c.relowner<>owner_id OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
      OR EXISTS(SELECT 1 FROM pg_policy q WHERE q.polrelid=c.oid AND lifecycle_id=ANY(q.polroles)) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
  -- The v5 authorizer must still be the lifecycle-owned definer function with
  -- exactly its memory_commands EXECUTE grant and no projection reads.
  SELECT p.* INTO prow FROM pg_proc p WHERE p.oid='memory_identity.seoul_action_authority(text,text,text,uuid)'::regprocedure;
  IF NOT FOUND OR prow.proowner<>lifecycle_id OR NOT prow.prosecdef OR prow.provolatile<>'v'
    OR prow.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
    OR position('identity_projection_' IN prow.prosrc)>0 THEN RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(prow.proacl,acldefault('f',prow.proowner))) a
      WHERE(a.grantee<>lifecycle_id AND a.grantee<>'memory_commands'::regrole)OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
    OR NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(prow.proacl,acldefault('f',prow.proowner))) a WHERE a.grantee='memory_commands'::regrole) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  FOR prow IN SELECT p.* FROM pg_proc p WHERE p.oid IN('memory_identity.seoul_pat_authority(text,text,boolean)'::regprocedure,
    'memory_identity.seoul_pat_check(text)'::regprocedure) LOOP
    IF NOT prow.prosecdef OR prow.provolatile<>'v' OR prow.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
  -- Lifecycle may not already hold any privilege on the projection tables; the
  -- draft below is the only reviewed path that introduces them.
  FOR c IN SELECT * FROM pg_class WHERE oid IN(
    'memory_ops.identity_projection_space_state'::regclass,'memory_ops.identity_projection_snapshot_generations'::regclass,
    'memory_ops.identity_projection_heads'::regclass,'memory_identity.identity_projection_grants'::regclass,
    'memory_identity.identity_projection_grant_heads'::regclass) LOOP
    IF EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=lifecycle_id) THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
END
$preflight$;

-- The dedicated dispatcher login. It can authenticate only after an operator
-- assigns a credential at deployment; it holds no table privilege and can SET
-- ROLE to the caller role only.
SET LOCAL createrole_self_grant='set, inherit';
CREATE ROLE memory_projection_dispatcher LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT memory_projection_caller TO memory_projection_dispatcher WITH INHERIT FALSE,SET TRUE,ADMIN FALSE;

-- The lifecycle-owned definer authorizer gains read access to exactly the
-- projected admission surface: the per-Space current generation, the selected
-- generation's lease/selection row, the projected grant rows and their
-- recorded dependency head vector, and the current head state it is compared
-- against. Read-only; no write or EXECUTE on any projection object.
SET LOCAL ROLE memory_owner;
GRANT SELECT ON memory_ops.identity_projection_space_state,memory_ops.identity_projection_snapshot_generations,
  memory_ops.identity_projection_heads,memory_identity.identity_projection_grants,memory_identity.identity_projection_grant_heads
  TO memory_lifecycle;
DO $policies$
DECLARE rel regclass;
BEGIN
  FOREACH rel IN ARRAY ARRAY['memory_ops.identity_projection_space_state','memory_ops.identity_projection_snapshot_generations',
    'memory_ops.identity_projection_heads','memory_identity.identity_projection_grants','memory_identity.identity_projection_grant_heads']::regclass[] LOOP
    EXECUTE format('CREATE POLICY projection_serving_select ON %s FOR SELECT TO memory_lifecycle USING(true)',rel);
  END LOOP;
END
$policies$;
GRANT CREATE ON SCHEMA memory_identity TO memory_lifecycle;
RESET ROLE;

SET LOCAL ROLE memory_lifecycle;

-- Per-Space projected admission bound. Returns the lease- and grant-capped
-- expiry for (credential, action, space), or raises the same sanitized errors
-- the named branch of seoul_action_authority used before. A NULL return is
-- impossible: every failure raises. The projected grant must exist on the
-- Space's CURRENT generation, be byte-consistent with the legacy grant row,
-- carry no erase/retire capability (projected grants never do), and have a
-- recorded dependency head vector that still equals the current head state.
CREATE FUNCTION memory_identity.projection_v3_serving_bound(
  p_credential text,p_kind text,p_permission text,p_account text,p_organization text,p_member_role text,
  p_space text,p_action text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $bound$
DECLARE g memory_identity.pat_space_grants%ROWTYPE; s memory_control.spaces%ROWTYPE;
  d memory_control.deployment_identity%ROWTYPE; proj record; policy jsonb;
BEGIN
  SELECT * INTO g FROM memory_identity.pat_space_grants WHERE credential_id=p_credential AND space_id=p_space FOR SHARE;
  SELECT * INTO s FROM memory_control.spaces WHERE id=p_space FOR SHARE;
  IF g.credential_id IS NULL OR s.id IS NULL OR g.account_id<>p_account OR g.revoked_at IS NOT NULL OR s.disabled_at IS NOT NULL
    OR (p_action='ingest' AND NOT g.can_ingest) OR (p_action='search' AND NOT g.can_search)
    OR (p_action='erase' AND NOT g.can_erase) OR (p_action='retire' AND NOT g.can_retire)
    OR (p_action='status' AND NOT g.can_erase)
    OR (p_action IN ('ingest','erase','retire','status') AND p_permission<>'write')
    OR (p_kind='personal_key' AND s.owner_account_id IS DISTINCT FROM p_account)
    OR (p_kind='api_key' AND (s.organization_id IS DISTINCT FROM p_organization OR (p_action IN ('ingest','erase','retire','status') AND p_member_role NOT IN ('owner','admin')))) THEN
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
  -- Read the entire projected admission predicate in one statement so the
  -- current generation, its lease, the projected grant and the head-freshness
  -- comparison share one READ COMMITTED snapshot.
  SELECT ss.current_sequence,gen.selected,gen.lease_expires_at_ms,pg.account_id,pg.expires_at_ms,pg.revoked_at_ms,
    pg.can_ingest,pg.can_search,pg.can_erase,pg.can_retire,pg.credential_id,
    EXISTS(SELECT 1 FROM memory_identity.identity_projection_grant_heads gh
      WHERE gh.space_id=ss.space_id AND gh.snapshot_seq=ss.current_sequence AND gh.credential_id=p_credential)
    AND NOT EXISTS(SELECT 1 FROM memory_identity.identity_projection_grant_heads gh
      LEFT JOIN memory_ops.identity_projection_heads cur ON cur.kind=gh.kind AND cur.stream_key=gh.stream_key
      WHERE gh.space_id=ss.space_id AND gh.snapshot_seq=ss.current_sequence AND gh.credential_id=p_credential
        AND cur.source_revision IS DISTINCT FROM gh.source_revision) AS heads_current
  INTO proj
  FROM memory_ops.identity_projection_space_state ss
  LEFT JOIN memory_ops.identity_projection_snapshot_generations gen ON gen.space_id=ss.space_id AND gen.snapshot_seq=ss.current_sequence
  LEFT JOIN memory_identity.identity_projection_grants pg ON pg.space_id=ss.space_id AND pg.snapshot_seq=ss.current_sequence AND pg.credential_id=p_credential
  WHERE ss.space_id=p_space;
  IF NOT FOUND OR proj.selected IS DISTINCT FROM true OR proj.credential_id IS NULL OR proj.account_id<>p_account
    OR proj.revoked_at_ms IS NOT NULL OR proj.expires_at_ms IS DISTINCT FROM g.expires_at
    OR proj.can_ingest IS DISTINCT FROM g.can_ingest OR proj.can_search IS DISTINCT FROM g.can_search
    OR proj.can_erase IS DISTINCT FROM g.can_erase OR proj.can_retire IS DISTINCT FROM g.can_retire
    OR NOT proj.heads_current THEN
    RAISE EXCEPTION USING ERRCODE='PA003',MESSAGE='seoul_space_denied';
  END IF;
  RETURN least(g.expires_at,proj.expires_at_ms,proj.lease_expires_at_ms);
END
$bound$;
REVOKE EXECUTE ON FUNCTION memory_identity.projection_v3_serving_bound(text,text,text,text,text,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION memory_identity.seoul_action_authority(p_digest text,p_space text,p_action text,p_terminal_operation uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $authority$
DECLARE c memory_identity.credentials%ROWTYPE; a memory_identity.accounts%ROWTYPE;
  m memory_identity.memberships%ROWTYPE; e memory_identity.account_emails%ROWTYPE;
  o memory_control.organizations%ROWTYPE;
  terminal memory_ops.lifecycle_receipts%ROWTYPE;
  at_ms bigint; until_ms bigint; cap bigint; candidate record; qualified boolean:=false;
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
    -- One named Space: ordinary grant/Space/policy checks plus the projected
    -- admission bound (selected generation, live lease, consistent projected
    -- grant, still-current dependency head vector). The bound folds the
    -- legacy grant expiry, the projected grant expiry and the lease into cap.
    cap:=memory_identity.projection_v3_serving_bound(c.id,c.kind,c.permission,a.id,m.organization_id,m.role,p_space,p_action);
    until_ms:=least(until_ms,cap);
    at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
    IF until_ms<=at_ms THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  ELSIF p_action='check' THEN
    -- The unscoped check must prove at least one grant on one currently
    -- selected Space passes every ordinary and projected check. It grants no
    -- Space authority and reveals neither the qualifying Space nor its grant.
    FOR candidate IN SELECT g.space_id FROM memory_identity.pat_space_grants g WHERE g.credential_id=c.id AND g.account_id=a.id AND g.revoked_at IS NULL LOOP
      BEGIN
        cap:=memory_identity.projection_v3_serving_bound(c.id,c.kind,c.permission,a.id,m.organization_id,m.role,candidate.space_id,'check');
        IF cap>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN qualified:=true;until_ms:=least(until_ms,cap); END IF;
      -- Only the helper's expected sanitized denials are per-candidate;
      -- every other failure (RLS, locks, internal errors) propagates.
      EXCEPTION WHEN sqlstate 'PA003' OR sqlstate 'PA004' THEN cap:=NULL;
      END;
    END LOOP;
    IF NOT qualified THEN RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='seoul_pat_denied'; END IF;
    at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
    IF until_ms<=at_ms THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='seoul_authority_expired'; END IF;
  END IF;
  RETURN jsonb_build_object('issuedAtMs',at_ms,'expiresAtMs',until_ms,'accountId',a.id,'credentialId',c.id);
END
$authority$;
RESET ROLE;
SET LOCAL ROLE memory_owner;
REVOKE CREATE ON SCHEMA memory_identity FROM memory_lifecycle;
RESET ROLE;

DO $postflight$
DECLARE owner_id regrole:='memory_owner'; code_id regrole:='memory_projection_owner';
  caller_id regrole:='memory_projection_caller'; lifecycle_id regrole:='memory_lifecycle';
  dispatcher_id regrole:='memory_projection_dispatcher'; prow record; c record;
BEGIN
  SELECT * INTO prow FROM pg_roles WHERE oid=dispatcher_id;
  IF prow.rolname IS NULL OR NOT prow.rolcanlogin OR prow.rolinherit OR prow.rolsuper OR prow.rolcreatedb OR prow.rolcreaterole OR prow.rolreplication OR prow.rolbypassrls
    OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=caller_id AND member=dispatcher_id AND NOT admin_option AND NOT inherit_option AND set_option) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=dispatcher_id AND m.roleid<>caller_id) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT p.* INTO prow FROM pg_proc p WHERE p.oid='memory_identity.seoul_action_authority(text,text,text,uuid)'::regprocedure;
  IF prow.proowner<>lifecycle_id OR NOT prow.prosecdef OR prow.provolatile<>'v' OR prow.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
    OR position('projection_v3_serving_bound' IN prow.prosrc)=0 THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  SELECT p.* INTO prow FROM pg_proc p WHERE p.oid='memory_identity.projection_v3_serving_bound(text,text,text,text,text,text,text,text)'::regprocedure;
  IF NOT FOUND OR prow.proowner<>lifecycle_id OR NOT prow.prosecdef OR prow.provolatile<>'v'
    OR prow.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
    OR EXISTS(SELECT 1 FROM aclexplode(coalesce(prow.proacl,acldefault('f',prow.proowner))) a WHERE a.grantee<>lifecycle_id) THEN
    RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  FOR c IN SELECT * FROM pg_class WHERE oid IN(
    'memory_ops.identity_projection_space_state'::regclass,'memory_ops.identity_projection_snapshot_generations'::regclass,
    'memory_ops.identity_projection_heads'::regclass,'memory_identity.identity_projection_grants'::regclass,
    'memory_identity.identity_projection_grant_heads'::regclass) LOOP
    IF NOT has_table_privilege(lifecycle_id,c.oid,'SELECT')
      OR(SELECT count(*) FROM pg_policy q WHERE q.polrelid=c.oid AND q.polname='projection_serving_select' AND lifecycle_id=ANY(q.polroles) AND q.polcmd='r')<>1 THEN
      RAISE EXCEPTION USING ERRCODE='PP004',MESSAGE='seoul_projection_unavailable'; END IF;
  END LOOP;
END
$postflight$;
COMMIT;

-- INACTIVE LOCAL EXTENSION. Install explicitly after schema5 + head-foundation.
-- Pure validation only: no authority reads/writes, public apply or schema marker.
BEGIN;
GRANT memory_owner,memory_projection_owner TO CURRENT_USER WITH INHERIT FALSE,SET TRUE;
SET LOCAL ROLE memory_owner;
GRANT CREATE ON SCHEMA memory_identity TO memory_projection_owner;
RESET ROLE;
SET LOCAL ROLE memory_projection_owner;

-- PostgreSQL UTF8/C order differs from JavaScript for astral versus BMP scalars.
-- Integer arrays compare lexically, including the shorter-prefix-first rule.
CREATE FUNCTION memory_identity.projection_v3_snapshot_utf16(p text) RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $utf16$
DECLARE result integer[]:='{}'; cp integer; i integer;
BEGIN
  IF p IS NULL OR pg_catalog.octet_length(p)>131072 THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  FOR i IN 1..pg_catalog.length(p) LOOP
    cp:=pg_catalog.ascii(pg_catalog.substr(p,i,1));
    IF cp>65535 THEN result:=result||ARRAY[55296+(cp-65536)/1024,56320+(cp-65536)%1024];
    ELSE result:=pg_catalog.array_append(result,cp); END IF;
  END LOOP;
  RETURN result;
END
$utf16$;

-- The type names and field sequences below are closed internal schema tags.
-- Reconstruct every object and number; never serialize jsonb as transport text.
CREATE FUNCTION memory_identity.projection_v3_snapshot_value(p jsonb,t text,source_rev bigint) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $value$
DECLARE keys text[]; types text[]; result text; value jsonb; item text; field text;
  child text; order_field text; bound integer; i integer; n numeric; key_units integer[]; previous integer[];
  synthetic jsonb; prefix constant text:=E'https://auth-api.allen.company\n';
  js_space constant text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p IS NULL OR t IS NULL THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
  IF pg_catalog.left(t,1)='?' THEN
    IF p='null'::jsonb THEN RETURN 'null'; END IF;
    RETURN memory_identity.projection_v3_snapshot_value(p,pg_catalog.substr(t,2),source_rev);
  END IF;
  IF pg_catalog.left(t,1)='=' THEN
    IF p<>pg_catalog.substr(t,2)::jsonb THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    RETURN pg_catalog.substr(t,2);
  END IF;
  IF t IN('time','revision') THEN
    IF pg_catalog.jsonb_typeof(p)<>'number' THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    n:=p::text::numeric;
    IF n NOT BETWEEN (CASE t WHEN 'revision' THEN 1 ELSE 0 END) AND 9007199254740991 OR pg_catalog.trunc(n)<>n THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    RETURN n::bigint::text;
  END IF;
  IF t='bool' THEN
    IF pg_catalog.jsonb_typeof(p)<>'boolean' THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    RETURN p::text;
  END IF;
  IF t IN('id','spaceId','uuid','digest','subject','address') OR pg_catalog.left(t,7)='choice:' THEN
    IF pg_catalog.jsonb_typeof(p)<>'string' THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    item:=p#>>'{}';
    IF t IN('id','spaceId') THEN
      IF pg_catalog.length(item)>(CASE t WHEN 'id' THEN 256 ELSE 128 END) OR item COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
    ELSIF t='uuid' THEN
      IF item COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
    ELSIF t='digest' THEN
      IF item COLLATE "C" !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    ELSIF t='subject' THEN
      -- UTF8 PostgreSQL text cannot contain NUL or unpaired surrogate scalars.
      IF pg_catalog.length(item)>512 OR pg_catalog.cardinality(memory_identity.projection_v3_snapshot_utf16(item))>512 OR pg_catalog.btrim(item,js_space)='' THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
    ELSIF t='address' THEN
      -- Reuse the committed ASCII mailbox rules, with a fixed opaque subject.
      synthetic:=pg_catalog.jsonb_build_object('kind','email','key',prefix||E'a\n'||item,'revision',1,
        'eventId','00000000-0000-0000-0000-000000000001','payloadSha256',pg_catalog.repeat('0',64));
      PERFORM memory_identity.seoul_projection_head_canonical(pg_catalog.jsonb_build_object('version',3,'kind','seoul-authority-head',
        'eventId',synthetic->'eventId','sourceRevision',1,'issuer','https://auth-api.allen.company','head',synthetic,
        'effect',pg_catalog.jsonb_build_object('type','email-lifecycle','subject','a','address',item,'state','verified','occurredAtMs',0)));
    ELSE
      IF NOT(item=ANY(pg_catalog.string_to_array(pg_catalog.substr(t,8),','))) THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
    END IF;
    RETURN pg_catalog.to_json(item)::text;
  END IF;
  IF pg_catalog.left(t,5)='list:' THEN
    child:=pg_catalog.split_part(t,':',2);bound:=pg_catalog.split_part(t,':',3)::integer;order_field:=pg_catalog.split_part(t,':',4);
    IF pg_catalog.jsonb_typeof(p)<>'array' OR pg_catalog.jsonb_array_length(p)>bound THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    result:='[';
    FOR value IN SELECT v FROM pg_catalog.jsonb_array_elements(p) AS a(v) LOOP
      item:=memory_identity.projection_v3_snapshot_value(value,child,source_rev);
      key_units:=memory_identity.projection_v3_snapshot_utf16(CASE WHEN order_field='' THEN value#>>'{}' ELSE value->>order_field END);
      IF previous IS NOT NULL AND previous>=key_units THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      previous:=key_units;IF result<>'[' THEN result:=result||','; END IF;result:=result||item;
    END LOOP;
    RETURN result||']';
  END IF;
  CASE t
    WHEN 'snapshot' THEN
      keys:=ARRAY['version','kind','eventId','sourceRevision','snapshotSeq','issuer','spaceId','selected','accounts','providerIdentities','emails','organizations','memberships','credentials','credentialPolicies','spaces','grants','lease'];
      types:=ARRAY['=3','="seoul-authority-snapshot"','uuid','revision','revision','="https://auth-api.allen.company"','spaceId','bool','list:account:200:id','list:provider:131072:subject','list:email:200:id','list:account:131072:id','list:membership:200:id','list:credential:131072:id','list:credentialPolicy:131072:credentialId','list:space:131072:id','list:grant:131072:credentialId','lease'];
    WHEN 'account' THEN keys:=ARRAY['id','disabledAtMs'];types:=ARRAY['id','?time'];
    WHEN 'provider' THEN keys:=ARRAY['issuer','subject','accountId','createdAtMs'];types:=ARRAY['="https://auth-api.allen.company"','subject','id','time'];
    WHEN 'email' THEN keys:=ARRAY['id','accountId','address','verifiedAtMs','revokedAtMs'];types:=ARRAY['id','id','address','time','?time'];
    WHEN 'membership' THEN
      keys:=ARRAY['id','accountId','emailId','organizationId','role','expiresAtMs','revokedAtMs'];
      types:=ARRAY['id','id','id','id','choice:owner,admin,member','time','?time'];
    WHEN 'credential' THEN
      keys:=ARRAY['id','accountId','kind','permission','tokenDigest','membershipId','emailId','expiresAtMs','revokedAtMs'];
      types:=ARRAY['id','id','choice:personal_key,api_key','choice:read,write','digest','?id','?id','time','?time'];
    WHEN 'credentialPolicy' THEN keys:=ARRAY['credentialId','capabilities','spaceIds'];types:=ARRAY['id','list:capability:5:','?list:spaceId:50:'];
    WHEN 'capability' THEN RETURN memory_identity.projection_v3_snapshot_value(p,'choice:read,create,update,delete,export',source_rev);
    WHEN 'tag' THEN RETURN memory_identity.projection_v3_snapshot_value(p,'choice:clinical-origin,credential,government-id,health',source_rev);
    WHEN 'policy' THEN
      keys:=ARRAY['policyVersion','residency','profile','processingBoundary','dataClass','classificationStatus','sensitivityTags','placementEpoch'];
      types:=ARRAY['=1','="kr-seoul"','="kr-primary-storage"','="approved-processors"','="personal"','="declared"','list:tag:4:','=1'];
    WHEN 'space' THEN keys:=ARRAY['id','accountId','organizationId','disabledAtMs','policy'];types:=ARRAY['spaceId','?id','?id','?time','policy'];
    WHEN 'grant' THEN
      keys:=ARRAY['credentialId','accountId','spaceId','provenance','canIngest','canSearch','canErase','canRetire','expiresAtMs','revokedAtMs','heads'];
      types:=ARRAY['id','id','spaceId','choice:owner,organization-member','bool','bool','=false','=false','time','=null','heads'];
    WHEN 'heads' THEN keys:=ARRAY['subjects','emails','organization','membership','credential','space','target'];types:=ARRAY['list:head:131072:key','?list:head:131072:key','?head','?head','head','head','head'];
    WHEN 'head' THEN
      keys:=ARRAY['kind','key','revision','eventId','payloadSha256'];types:=ARRAY['choice:subject,email,organization,membership,credential,space,target','headKey','revision','uuid','digest'];
    WHEN 'headKey' THEN
      IF pg_catalog.jsonb_typeof(p)<>'string' THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      RETURN pg_catalog.to_json(p#>>'{}')::text;
    WHEN 'lease' THEN keys:=ARRAY['issuedAtMs','expiresAtMs'];types:=ARRAY['time','time'];
    ELSE RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END CASE;
  IF pg_catalog.jsonb_typeof(p)<>'object' OR NOT(p ?& keys) OR p-keys<>'{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  result:='{';
  FOR i IN 1..pg_catalog.cardinality(keys) LOOP
    field:=keys[i];IF i>1 THEN result:=result||','; END IF;
    result:=result||pg_catalog.to_json(field)::text||':'||memory_identity.projection_v3_snapshot_value(p->field,types[i],source_rev);
  END LOOP;
  IF t='head' THEN
    PERFORM memory_identity.seoul_projection_head_canonical(pg_catalog.jsonb_build_object('version',3,'kind','seoul-authority-head',
      'eventId',p->'eventId','sourceRevision',p->'revision','issuer','https://auth-api.allen.company','head',p,
      'effect',pg_catalog.jsonb_build_object('type','entity-head','disposition','present')));
    IF (p->>'revision')::bigint>source_rev THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
  ELSIF t='credentialPolicy' AND p->'spaceIds'='[]'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  ELSIF t='policy' AND p->'sensitivityTags' ? 'clinical-origin' AND NOT(p->'sensitivityTags' ? 'health') THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  ELSIF t='lease' AND ((p->>'issuedAtMs')::bigint>9007199254680991 OR (p->>'expiresAtMs')::bigint<>(p->>'issuedAtMs')::bigint+60000) THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  RETURN result||'}';
END
$value$;

-- JSONB maps here are local variables only, never relation reads or authority.
-- Keys are internal structural encodings, not transport/source digest bytes.
CREATE FUNCTION memory_identity.projection_v3_snapshot_graph(p jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $graph$
DECLARE account_rows jsonb:='{}'; org_rows jsonb:='{}'; email_rows jsonb:='{}'; member_rows jsonb:='{}'; identities jsonb:='{}';
  needed_accounts jsonb:='{}'; needed_emails jsonb:='{}'; needed_members jsonb:='{}'; counts jsonb:='{}'; digests jsonb:='{}';
  seen_heads jsonb:='{}'; revision_streams jsonb:='{}'; event_streams jsonb:='{}'; addresses jsonb:='{}'; membership_tuples jsonb:='{}';
  sp jsonb; row_value jsonb; c jsonb; policy jsonb; g jsonb; h jsonb; a jsonb; m jsonb; e jsonb; o jsonb;
  all_heads jsonb; expected_subjects jsonb; expected_emails jsonb; keys jsonb;
  kind text; key_value text; stream text; revision_key text; event_key text; tuple jsonb; prop text;
  aid text; sid text; oid text; id text; count_value integer; idx integer; issued bigint; expiry bigint;
  direct_write boolean; can_search boolean; can_ingest boolean;
  prefix constant text:=E'https://auth-api.allen.company\n';
BEGIN
  IF pg_catalog.jsonb_array_length(p->'spaces')<>1 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
  sp:=p->'spaces'->0;sid:=sp->>'id';aid:=sp->>'accountId';oid:=sp->>'organizationId';issued:=(p->'lease'->>'issuedAtMs')::bigint;
  IF sid<>p->>'spaceId' OR (aid IS NULL)=(oid IS NULL) THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
  FOR row_value IN SELECT v FROM pg_catalog.jsonb_array_elements(p->'accounts') AS x(v) LOOP account_rows:=account_rows||pg_catalog.jsonb_build_object(row_value->>'id',row_value); END LOOP;
  FOR row_value IN SELECT v FROM pg_catalog.jsonb_array_elements(p->'organizations') AS x(v) LOOP org_rows:=org_rows||pg_catalog.jsonb_build_object(row_value->>'id',row_value); END LOOP;
  FOR row_value IN SELECT v FROM pg_catalog.jsonb_array_elements(p->'emails') AS x(v) LOOP email_rows:=email_rows||pg_catalog.jsonb_build_object(row_value->>'id',row_value); END LOOP;
  FOR row_value IN SELECT v FROM pg_catalog.jsonb_array_elements(p->'memberships') AS x(v) LOOP member_rows:=member_rows||pg_catalog.jsonb_build_object(row_value->>'id',row_value); END LOOP;
  IF aid IS NOT NULL THEN
    IF NOT(account_rows ? aid) THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    needed_accounts:=pg_catalog.jsonb_build_object(aid,true);
  END IF;
  IF (oid IS NULL AND org_rows<>'{}'::jsonb) OR (oid IS NOT NULL AND (NOT(org_rows ? oid) OR org_rows-oid<>'{}'::jsonb)) THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  FOR row_value IN SELECT v FROM pg_catalog.jsonb_array_elements(p->'providerIdentities') AS x(v) LOOP
    id:=row_value->>'accountId';key_value:=prefix||(row_value->>'subject');
    IF NOT(account_rows ? id) THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    -- Strict subject ordering already forbids duplicate issuer/subject tuples.
    identities:=identities||pg_catalog.jsonb_build_object(id,coalesce(identities->id,'[]'::jsonb)||pg_catalog.to_jsonb(key_value));
  END LOOP;
  FOR id IN SELECT pg_catalog.jsonb_object_keys(account_rows) LOOP
    IF NOT(identities ? id) THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
  END LOOP;
  IF pg_catalog.jsonb_array_length(p->'credentials')<>pg_catalog.jsonb_array_length(p->'credentialPolicies') OR pg_catalog.jsonb_array_length(p->'credentials')<>pg_catalog.jsonb_array_length(p->'grants') THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  FOR idx IN 0..pg_catalog.jsonb_array_length(p->'credentials')-1 LOOP
    c:=p->'credentials'->idx;policy:=p->'credentialPolicies'->idx;g:=p->'grants'->idx;h:=g->'heads';id:=c->>'id';aid:=c->>'accountId';
    IF policy->>'credentialId'<>id OR g->>'credentialId'<>id OR g->>'accountId'<>aid OR g->>'spaceId'<>sid OR NOT(account_rows ? aid) OR digests ? (c->>'tokenDigest') THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    digests:=digests||pg_catalog.jsonb_build_object(c->>'tokenDigest',true);count_value:=coalesce((counts->>aid)::integer,0)+1;
    IF count_value>100 THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    counts:=counts||pg_catalog.jsonb_build_object(aid,count_value);a:=account_rows->aid;needed_accounts:=needed_accounts||pg_catalog.jsonb_build_object(aid,true);
    IF p->'selected'<>'true'::jsonb OR sp->'disabledAtMs'<>'null'::jsonb OR a->'disabledAtMs'<>'null'::jsonb OR c->'revokedAtMs'<>'null'::jsonb
      OR (c->>'expiresAtMs')::bigint<=issued OR (policy->'spaceIds'<>'null'::jsonb AND NOT(policy->'spaceIds' ? sid)) THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    expected_subjects:=identities->aid;
    SELECT coalesce(pg_catalog.jsonb_agg(v->'key' ORDER BY ord),'[]'::jsonb) INTO keys FROM pg_catalog.jsonb_array_elements(h->'subjects') WITH ORDINALITY AS x(v,ord);
    IF keys<>expected_subjects OR keys='[]'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    IF h->'credential'->>'kind'<>'credential' OR h->'credential'->>'key'<>id OR h->'space'->>'kind'<>'space' OR h->'space'->>'key'<>sid OR h->'target'->>'kind'<>'target' OR h->'target'->>'key'<>sid THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    expiry:=(c->>'expiresAtMs')::bigint;direct_write:=false;
    IF g->>'provenance'='owner' THEN
      IF c->>'kind'<>'personal_key' OR c->'membershipId'<>'null'::jsonb OR c->'emailId'<>'null'::jsonb OR sp->>'accountId' IS DISTINCT FROM aid OR oid IS NOT NULL
        OR h->'emails'<>'null'::jsonb OR h->'organization'<>'null'::jsonb OR h->'membership'<>'null'::jsonb THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      direct_write:=true;
    ELSE
      IF c->>'kind'<>'api_key' OR c->'membershipId'='null'::jsonb OR c->'emailId'='null'::jsonb OR sp->'accountId'<>'null'::jsonb OR oid IS NULL
        OR h->'emails'='null'::jsonb OR h->'organization'='null'::jsonb OR h->'membership'='null'::jsonb THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      m:=member_rows->(c->>'membershipId');e:=email_rows->(c->>'emailId');o:=org_rows->oid;
      IF m IS NULL OR e IS NULL OR o IS NULL OR m->>'accountId'<>aid OR e->>'accountId'<>aid OR m->>'emailId'<>e->>'id' OR m->>'organizationId'<>oid
        OR m->'revokedAtMs'<>'null'::jsonb OR (m->>'expiresAtMs')::bigint<=issued OR e->'revokedAtMs'<>'null'::jsonb
        OR (e->>'verifiedAtMs')::bigint>issued OR o->'disabledAtMs'<>'null'::jsonb THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      needed_emails:=needed_emails||pg_catalog.jsonb_build_object(e->>'id',true);needed_members:=needed_members||pg_catalog.jsonb_build_object(m->>'id',true);
      IF h->'organization'->>'kind'<>'organization' OR h->'organization'->>'key'<>oid OR h->'membership'->>'kind'<>'membership' OR h->'membership'->>'key'<>m->>'id' THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      -- Sort complete email keys independently: appending an address changes
      -- order for prefix-related subjects containing the newline separator.
      SELECT pg_catalog.jsonb_agg(v||E'\n'||(e->>'address') ORDER BY memory_identity.projection_v3_snapshot_utf16(v||E'\n'||(e->>'address')))
        INTO expected_emails FROM pg_catalog.jsonb_array_elements_text(expected_subjects) AS x(v);
      SELECT coalesce(pg_catalog.jsonb_agg(v->'key' ORDER BY ord),'[]'::jsonb) INTO keys FROM pg_catalog.jsonb_array_elements(h->'emails') WITH ORDINALITY AS x(v,ord);
      IF keys<>expected_emails THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      expiry:=least(expiry,(m->>'expiresAtMs')::bigint);direct_write:=m->>'role' IN('owner','admin');
    END IF;
    can_search:=policy->'capabilities' ? 'read';can_ingest:=policy->'capabilities' ? 'create' AND c->>'permission'='write' AND direct_write;
    IF NOT(can_search OR can_ingest) OR (g->>'canSearch')::boolean<>can_search OR (g->>'canIngest')::boolean<>can_ingest OR (g->>'expiresAtMs')::bigint<>expiry OR expiry<=issued THEN
      RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
    END IF;
    FOR row_value IN SELECT v FROM pg_catalog.jsonb_array_elements(h->'subjects') AS x(v) LOOP
      IF row_value->>'kind'<>'subject' THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    END LOOP;
    all_heads:=h->'subjects';
    IF h->'emails'<>'null'::jsonb THEN
      FOR row_value IN SELECT v FROM pg_catalog.jsonb_array_elements(h->'emails') AS x(v) LOOP
        IF row_value->>'kind'<>'email' THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
      END LOOP;
      all_heads:=all_heads||(h->'emails');
    END IF;
    FOREACH prop IN ARRAY ARRAY['organization','membership','credential','space','target'] LOOP
      IF h->prop<>'null'::jsonb THEN all_heads:=all_heads||pg_catalog.jsonb_build_array(h->prop); END IF;
    END LOOP;
    FOR row_value IN SELECT v FROM pg_catalog.jsonb_array_elements(all_heads) AS x(v) LOOP
      kind:=row_value->>'kind';key_value:=row_value->>'key';stream:=pg_catalog.jsonb_build_array(kind,key_value)::text;
      revision_key:=row_value->>'revision';event_key:=row_value->>'eventId';tuple:=pg_catalog.jsonb_build_array(row_value->'revision',event_key,row_value->>'payloadSha256');
      IF (seen_heads ? stream AND seen_heads->stream<>tuple) OR (revision_streams ? revision_key AND revision_streams->>revision_key<>stream)
        OR (event_streams ? event_key AND event_streams->>event_key<>stream) OR event_key=p->>'eventId' THEN
        RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
      END IF;
      seen_heads:=seen_heads||pg_catalog.jsonb_build_object(stream,tuple);revision_streams:=revision_streams||pg_catalog.jsonb_build_object(revision_key,stream);event_streams:=event_streams||pg_catalog.jsonb_build_object(event_key,stream);
    END LOOP;
  END LOOP;
  FOR id IN SELECT pg_catalog.jsonb_object_keys(account_rows) LOOP IF NOT(needed_accounts ? id) THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF; END LOOP;
  FOR id IN SELECT pg_catalog.jsonb_object_keys(email_rows) LOOP
    IF NOT(needed_emails ? id) OR addresses ? (email_rows->id->>'address') THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    addresses:=addresses||pg_catalog.jsonb_build_object(email_rows->id->>'address',true);
  END LOOP;
  FOR id IN SELECT pg_catalog.jsonb_object_keys(member_rows) LOOP
    stream:=pg_catalog.jsonb_build_array(member_rows->id->>'organizationId',member_rows->id->>'accountId')::text;
    IF NOT(needed_members ? id) OR membership_tuples ? stream THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
    membership_tuples:=membership_tuples||pg_catalog.jsonb_build_object(stream,true);
  END LOOP;
END
$graph$;

CREATE FUNCTION memory_identity.projection_v3_snapshot_canonical(p_raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $canonical$
DECLARE p jsonb; canonical text; source_rev bigint;
BEGIN
  IF p_raw IS NULL OR pg_catalog.octet_length(p_raw) NOT BETWEEN 1 AND 131072 THEN
    RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
  END IF;
  p:=p_raw::jsonb;
  source_rev:=memory_identity.projection_v3_snapshot_value(p->'sourceRevision','revision',NULL)::bigint;
  canonical:=memory_identity.projection_v3_snapshot_value(p,'snapshot',source_rev);
  IF canonical COLLATE "C"<>p_raw COLLATE "C" THEN RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid'; END IF;
  PERFORM memory_identity.projection_v3_snapshot_graph(p);
  RETURN p_raw;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING ERRCODE='PP001',MESSAGE='seoul_projection_input_invalid';
END
$canonical$;

REVOKE ALL ON FUNCTION memory_identity.projection_v3_snapshot_utf16(text),memory_identity.projection_v3_snapshot_value(jsonb,text,bigint),
  memory_identity.projection_v3_snapshot_graph(jsonb),memory_identity.projection_v3_snapshot_canonical(text) FROM PUBLIC;
RESET ROLE;
SET LOCAL ROLE memory_owner;
REVOKE CREATE ON SCHEMA memory_identity FROM memory_projection_owner;
RESET ROLE;
GRANT memory_owner,memory_projection_owner TO CURRENT_USER WITH INHERIT FALSE,SET FALSE;
COMMIT;

import type { PgSession } from '../connection.ts';

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const migrations = ['0001_private_namespaces.sql', '0002_deployment_identity.sql',
  '0003_identity_foundation.sql', '0004_seoul_pat_archive.sql'];

// Fixed migration-4 and explicitly selected migration-5 privilege contracts.
// Only booleans leave PostgreSQL; no authority/content rows are read.
// ACL comparisons include PUBLIC, column grants and grant options. Role edges
// are checked even when their privileges are not currently inherited.
// Reserved-role ownership and non-system CREATE are checked across namespaces;
// unrelated provider objects remain outside this fixed service inventory.
// Owner TOAST relations are PostgreSQL internals, not unexpected public tables.
// In v5, inactive provisioner memberships retain their grantor metadata; ADMIN
// requires an already privileged creator. Exact grantors remain installation pins.
function catalogueSql(schemaVersion: 4 | 5): string {
  const lifecycle = schemaVersion === 5;
  const lifecycleRole = lifecycle ? ",'memory_lifecycle'" : '';
  return `WITH
 roles AS (SELECT * FROM pg_catalog.pg_roles WHERE rolname IN
   ($1,'memory_owner','memory_runtime','memory_background','memory_commands'${lifecycleRole})),
 schemas AS (SELECT n.oid,n.nspname::text AS name,r.rolname::text AS owner,n.nspacl
   FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
   WHERE pg_catalog.left(n.nspname,7)='memory_'),
 expected_schemas(name) AS (VALUES ('memory_control'),('memory_identity'),('memory_content'),
   ('memory_search'),('memory_jobs'),('memory_ops')),
 schema_acl AS (SELECT s.name,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
   a.privilege_type AS privilege,a.is_grantable AS grantable FROM schemas s
   JOIN pg_catalog.pg_roles r ON r.rolname=s.owner,
   LATERAL pg_catalog.aclexplode(COALESCE(s.nspacl,pg_catalog.acldefault('n',r.oid))) a),
 expected_schema_acl AS (
   SELECT e.name,'memory_owner'::text AS grantee,p.privilege,false AS grantable
     FROM expected_schemas e CROSS JOIN (VALUES ('CREATE'),('USAGE')) p(privilege)
   UNION ALL SELECT name,grantee,'USAGE',false FROM (VALUES
     ('memory_control','memory_runtime'),('memory_control','memory_background'),
     ('memory_identity','memory_runtime'),('memory_content','memory_runtime'),
     ('memory_control','memory_commands'),('memory_identity','memory_commands'),
     ('memory_content','memory_commands'),('memory_ops','memory_commands')${lifecycle ? `,
     ('memory_ops','memory_runtime'),('memory_control','memory_lifecycle'),('memory_identity','memory_lifecycle'),
     ('memory_content','memory_lifecycle'),('memory_ops','memory_lifecycle')` : ''}) v(name,grantee)),
 table_spec(name,metadata,command_read,command_insert,update_columns) AS (VALUES
   ('memory_control.deployment_identity',true,true,false,ARRAY[]::text[]),
   ('memory_control.schema_migrations',true,true,false,ARRAY[]::text[]),
   ('memory_control.organizations',false,true,false,ARRAY['id']),
   ('memory_control.spaces',false,true,false,ARRAY['id']),
   ('memory_identity.accounts',false,true,false,ARRAY['id']),
   ('memory_identity.account_emails',false,true,false,ARRAY['id']),
   ('memory_identity.memberships',false,true,false,ARRAY['id']),
   ('memory_identity.credentials',false,true,false,ARRAY['id']),
   ('memory_identity.provider_identities',false,false,false,ARRAY[]::text[]),
   ('memory_identity.pat_space_grants',false,true,false,ARRAY['credential_id']),
   ('memory_content.archives',false,true,true,ARRAY['id']),
   ('memory_content.archive_messages',false,true,true,ARRAY[]::text[]),
   ('memory_ops.space_usage',false,true,false,ARRAY['source_bytes','message_count'${lifecycle ? ",'retained_source_bytes','retained_message_count'" : ''}]),
   ('memory_ops.meter_events',false,true,true,ARRAY[]::text[])${lifecycle ? `,
   ('memory_ops.lifecycle_receipts',false,false,false,ARRAY[]::text[])` : ''}),
 ${lifecycle ? `lifecycle_spec(name,metadata,can_insert,can_delete,update_columns) AS (VALUES
   ('memory_control.deployment_identity',true,false,false,ARRAY[]::text[]),
   ('memory_control.schema_migrations',true,false,false,ARRAY[]::text[]),
   ('memory_control.organizations',false,false,false,ARRAY['id']),
   ('memory_control.spaces',false,false,false,ARRAY['id','disabled_at']),
   ('memory_identity.accounts',false,false,false,ARRAY['id']),
   ('memory_identity.account_emails',false,false,false,ARRAY['id']),
   ('memory_identity.memberships',false,false,false,ARRAY['id']),
   ('memory_identity.credentials',false,false,false,ARRAY['id','revoked_at']),
   ('memory_identity.pat_space_grants',false,false,false,ARRAY['credential_id']),
   ('memory_content.archives',false,false,false,ARRAY['id','operation_id','request_digest','session_id','routing',
     'created_at_ms','authority_expires_at_ms','hidden_at','erased_at','lifecycle_revision','erasure_actor_credential_id','erasure_operation_id']),
   ('memory_content.archive_messages',false,false,true,ARRAY[]::text[]),
   ('memory_ops.space_usage',false,false,false,ARRAY['retained_source_bytes','retained_message_count']),
   ('memory_ops.meter_events',false,false,false,ARRAY['operation_id','created_at_ms']),
   ('memory_ops.lifecycle_receipts',false,true,false,ARRAY[]::text[])),` : ''}
 tables AS (SELECT c.oid,s.name||'.'||c.relname AS name,r.rolname::text AS owner,
   c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl FROM schemas s
   JOIN pg_catalog.pg_class c ON c.relnamespace=s.oid JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
   WHERE c.relkind IN ('r','p','v','m','S','f')),
 table_acl AS (SELECT t.name,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
   a.privilege_type AS privilege,a.is_grantable AS grantable FROM tables t
   JOIN pg_catalog.pg_roles r ON r.rolname=t.owner,
   LATERAL pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',r.oid))) a),
 expected_table_acl AS (
   SELECT t.name,'memory_owner'::text AS grantee,a.privilege_type AS privilege,false AS grantable
     FROM table_spec t CROSS JOIN roles r,LATERAL pg_catalog.aclexplode(pg_catalog.acldefault('r',r.oid)) a
     WHERE r.rolname='memory_owner'
   UNION ALL SELECT name,'memory_commands','SELECT',false FROM table_spec WHERE command_read
   UNION ALL SELECT name,'memory_commands','INSERT',false FROM table_spec WHERE command_insert
   UNION ALL SELECT t.name,r.name,'SELECT',false FROM table_spec t
     CROSS JOIN (VALUES ('memory_runtime'),('memory_background')) r(name) WHERE t.metadata${lifecycle ? `
   UNION ALL SELECT name,'memory_lifecycle','SELECT',false FROM lifecycle_spec
   UNION ALL SELECT name,'memory_lifecycle','INSERT',false FROM lifecycle_spec WHERE can_insert
   UNION ALL SELECT name,'memory_lifecycle','DELETE',false FROM lifecycle_spec WHERE can_delete` : ''}),
 column_acl AS (SELECT t.name,c.attname::text AS column_name,
   CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
   a.privilege_type AS privilege,a.is_grantable AS grantable
   FROM tables t JOIN pg_catalog.pg_attribute c ON c.attrelid=t.oid AND c.attnum>0 AND NOT c.attisdropped,
   LATERAL pg_catalog.aclexplode(CASE WHEN pg_catalog.cardinality(c.attacl)>0 THEN c.attacl END) a),
 expected_column_acl AS (SELECT t.name,c.column_name,'memory_commands'::text AS grantee,'UPDATE'::text AS privilege,false AS grantable
   FROM table_spec t,LATERAL pg_catalog.unnest(t.update_columns) c(column_name)${lifecycle ? `
   UNION ALL SELECT t.name,c.column_name,'memory_lifecycle','UPDATE',false
     FROM lifecycle_spec t,LATERAL pg_catalog.unnest(t.update_columns) c(column_name)` : ''}),
 function_spec(name,owner,definer,result,entry) AS (VALUES
   ('memory_control.reject_mutation()','memory_owner',false,'trigger',false),
   ('memory_identity.seoul_pat_check(text)','memory_commands',true,'jsonb',true),
   ('memory_identity.seoul_pat_authority(text, text, boolean)','memory_commands',true,'jsonb',false),
   ('memory_content.seoul_validate_input(jsonb, boolean)','memory_commands',true,'jsonb',false),
   ('memory_content.seoul_archive_ingest(text, jsonb)','memory_commands',true,'jsonb',true),
   ('memory_content.seoul_keyword_search(text, jsonb)','memory_commands',true,'jsonb',true),
   ('memory_content.seoul_archive_commit_fence()','memory_commands',true,'trigger',false)${lifecycle ? `,
   ('memory_identity.seoul_action_authority(text, text, text, uuid)','memory_lifecycle',true,'jsonb',false),
   ('memory_ops.seoul_lifecycle_input(jsonb, text)','memory_lifecycle',true,'jsonb',false),
   ('memory_content.seoul_lifecycle_guard()','memory_lifecycle',false,'trigger',false),
   ('memory_content.seoul_archive_erase(text, jsonb)','memory_lifecycle',true,'jsonb',true),
   ('memory_control.seoul_space_retire(text, jsonb)','memory_lifecycle',true,'jsonb',true),
   ('memory_identity.seoul_pat_revoke_self(text, jsonb)','memory_lifecycle',true,'jsonb',true),
   ('memory_ops.seoul_lifecycle_status(text, jsonb)','memory_lifecycle',true,'jsonb',true),
   ('memory_ops.seoul_lifecycle_commit_fence()','memory_lifecycle',true,'trigger',false)` : ''}),
 functions AS (SELECT p.oid,n.nspname||'.'||p.proname||'('||pg_catalog.oidvectortypes(p.proargtypes)||')' AS name,
   r.rolname::text AS owner,p.prosecdef AS definer,pg_catalog.pg_get_function_result(p.oid) AS result,
   p.prokind,p.proconfig,p.proacl,p.proleakproof,p.proretset,l.lanname
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE pg_catalog.left(n.nspname,7)='memory_'
     OR r.rolname IN ($1,'memory_runtime','memory_commands','memory_owner','memory_background'${lifecycleRole})),
 function_acl AS (SELECT f.name,
   CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
   a.privilege_type AS privilege,a.is_grantable AS grantable FROM functions f
   JOIN pg_catalog.pg_roles r ON r.rolname=f.owner,
   LATERAL pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',r.oid))) a),
 expected_function_acl AS (SELECT name,owner AS grantee,'EXECUTE'::text AS privilege,false AS grantable FROM function_spec
   UNION ALL SELECT name,'memory_runtime','EXECUTE',false FROM function_spec WHERE entry${lifecycle ? `
   UNION ALL SELECT 'memory_identity.seoul_action_authority(text, text, text, uuid)','memory_commands','EXECUTE',false` : ''}),
 policies AS (SELECT t.name,p.polname::text AS policy,p.polcmd::text AS command,p.polpermissive AS permissive,
   ARRAY(SELECT CASE WHEN x.role_id=0 THEN 'PUBLIC' ELSE r.rolname::text END
     FROM pg_catalog.unnest(p.polroles) x(role_id) LEFT JOIN pg_catalog.pg_roles r ON r.oid=x.role_id ORDER BY 1) AS grantees,
   pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expr,
   pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expr
   FROM tables t JOIN pg_catalog.pg_policy p ON p.polrelid=t.oid),
 expected_policies AS (
   SELECT name,'migration_owner'::text AS policy,'*'::text AS command,true AS permissive,
     ARRAY['memory_owner']::text[] AS grantees,'true'::text AS using_expr,'true'::text AS check_expr FROM table_spec WHERE NOT metadata
   UNION ALL SELECT name,'seoul_commands_read','r',true,ARRAY['memory_commands'],'true',NULL FROM table_spec WHERE command_read AND NOT metadata
   UNION ALL SELECT name,'seoul_commands_insert','a',true,ARRAY['memory_commands'],NULL,'true' FROM table_spec WHERE command_insert
   UNION ALL SELECT name,'seoul_commands_update','w',true,ARRAY['memory_commands'],'true','true' FROM table_spec WHERE pg_catalog.cardinality(update_columns)>0${lifecycle ? `
   UNION ALL SELECT name,'seoul_lifecycle_read','r',true,ARRAY['memory_lifecycle'],'true',NULL FROM lifecycle_spec WHERE NOT metadata
   UNION ALL SELECT name,'seoul_lifecycle_insert','a',true,ARRAY['memory_lifecycle'],NULL,'true' FROM lifecycle_spec WHERE can_insert
   UNION ALL SELECT name,'seoul_lifecycle_delete','d',true,ARRAY['memory_lifecycle'],'true',NULL FROM lifecycle_spec WHERE can_delete
   UNION ALL SELECT name,'seoul_lifecycle_update','w',true,ARRAY['memory_lifecycle'],'true','true' FROM lifecycle_spec WHERE pg_catalog.cardinality(update_columns)>0` : ''}),
 function_defaults AS (SELECT r.rolname::text AS owner,COALESCE(d.defaclnamespace,0) AS namespace,
   CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
   a.privilege_type AS privilege,a.is_grantable AS grantable
   FROM roles r LEFT JOIN pg_catalog.pg_default_acl d ON d.defaclrole=r.oid AND d.defaclobjtype='f',
   LATERAL pg_catalog.aclexplode(COALESCE(d.defaclacl,pg_catalog.acldefault('f',r.oid))) a
   WHERE r.rolname IN ('memory_owner','memory_commands'${lifecycleRole}))${lifecycle ? `,
 lifecycle_triggers(relation,name,function_name,type,deferred) AS (VALUES
   ('memory_content.archives','archives_immutable','memory_content.seoul_lifecycle_guard()',19,false),
   ('memory_content.archives','no_delete','memory_control.reject_mutation()',11,false),
   ('memory_content.archives','no_truncate','memory_control.reject_mutation()',34,false),
   ('memory_content.archive_messages','no_delete','memory_content.seoul_lifecycle_guard()',11,false),
   ('memory_content.archive_messages','messages_immutable','memory_control.reject_mutation()',19,false),
   ('memory_content.archive_messages','no_truncate','memory_control.reject_mutation()',34,false),
   ('memory_ops.meter_events','meters_immutable','memory_content.seoul_lifecycle_guard()',19,false),
   ('memory_ops.meter_events','no_delete','memory_control.reject_mutation()',11,false),
   ('memory_ops.meter_events','no_truncate','memory_control.reject_mutation()',34,false),
   ('memory_ops.lifecycle_receipts','no_update','memory_control.reject_mutation()',19,false),
   ('memory_ops.lifecycle_receipts','no_delete','memory_control.reject_mutation()',11,false),
   ('memory_ops.lifecycle_receipts','no_truncate','memory_control.reject_mutation()',34,false),
   ('memory_ops.lifecycle_receipts','seoul_lifecycle_expiry','memory_ops.seoul_lifecycle_commit_fence()',5,true)),
 expected_triggers(relation,name,function_name) AS (
   SELECT relation,name,function_name FROM lifecycle_triggers
   UNION SELECT name,g.trigger_name,'memory_control.reject_mutation()'
     FROM table_spec CROSS JOIN (VALUES ('no_delete'),('no_truncate')) g(trigger_name) WHERE NOT metadata
       AND NOT EXISTS(SELECT 1 FROM lifecycle_triggers e WHERE e.relation=table_spec.name AND e.name=g.trigger_name)
   UNION SELECT relation,name,'memory_control.reject_mutation()' FROM (VALUES
     ('memory_control.schema_migrations','schema_migrations_append_only'),
     ('memory_control.schema_migrations','schema_migrations_no_truncate'),
     ('memory_control.deployment_identity','deployment_identity_immutable'),
     ('memory_control.deployment_identity','deployment_identity_no_truncate'),
     ('memory_control.organizations','organizations_immutable'),('memory_control.spaces','spaces_immutable'),
     ('memory_identity.accounts','accounts_immutable'),('memory_identity.account_emails','account_emails_immutable'),
     ('memory_identity.memberships','memberships_immutable'),('memory_identity.credentials','credentials_immutable'),
     ('memory_identity.provider_identities','provider_identities_immutable'),
     ('memory_identity.pat_space_grants','pat_grants_immutable'),('memory_ops.space_usage','usage_binding_immutable')) g(relation,name)
   UNION SELECT 'memory_content.archives','seoul_archive_expiry','memory_content.seoul_archive_commit_fence()'),
 trigger_conditions(name,condition) AS (VALUES
   ('organizations_immutable',$condition$(((new.id)::text IS DISTINCT FROM (old.id)::text) OR ((old.disabled_at IS NOT NULL) AND ((new.disabled_at)::bigint IS DISTINCT FROM (old.disabled_at)::bigint)))$condition$),
   ('accounts_immutable',$condition$(((new.id)::text IS DISTINCT FROM (old.id)::text) OR ((old.disabled_at IS NOT NULL) AND ((new.disabled_at)::bigint IS DISTINCT FROM (old.disabled_at)::bigint)))$condition$),
   ('spaces_immutable',$condition$((new.id IS DISTINCT FROM old.id) OR ((new.owner_account_id)::text IS DISTINCT FROM (old.owner_account_id)::text) OR ((new.organization_id)::text IS DISTINCT FROM (old.organization_id)::text) OR ((new.deployment_id)::text IS DISTINCT FROM (old.deployment_id)::text) OR (new.data_policy IS DISTINCT FROM old.data_policy) OR ((old.disabled_at IS NOT NULL) AND ((new.disabled_at)::bigint IS DISTINCT FROM (old.disabled_at)::bigint)))$condition$),
   ('account_emails_immutable',$condition$(((new.id)::text IS DISTINCT FROM (old.id)::text) OR ((new.account_id)::text IS DISTINCT FROM (old.account_id)::text) OR (new.address IS DISTINCT FROM old.address) OR (new.domain IS DISTINCT FROM old.domain) OR ((new.verified_at)::bigint IS DISTINCT FROM (old.verified_at)::bigint) OR ((old.revoked_at IS NOT NULL) AND ((new.revoked_at)::bigint IS DISTINCT FROM (old.revoked_at)::bigint)))$condition$),
   ('credentials_immutable',$condition$(((new.id)::text IS DISTINCT FROM (old.id)::text) OR ((new.account_id)::text IS DISTINCT FROM (old.account_id)::text) OR ((new.membership_id)::text IS DISTINCT FROM (old.membership_id)::text) OR ((new.email_id)::text IS DISTINCT FROM (old.email_id)::text) OR (new.kind IS DISTINCT FROM old.kind) OR (new.token_digest IS DISTINCT FROM old.token_digest) OR ((old.revoked_at IS NOT NULL) AND ((new.revoked_at)::bigint IS DISTINCT FROM (old.revoked_at)::bigint)))$condition$),
   ('memberships_immutable',$condition$(((new.id)::text IS DISTINCT FROM (old.id)::text) OR ((new.organization_id)::text IS DISTINCT FROM (old.organization_id)::text) OR ((new.account_id)::text IS DISTINCT FROM (old.account_id)::text) OR ((new.email_id)::text IS DISTINCT FROM (old.email_id)::text) OR ((old.revoked_at IS NOT NULL) AND ((new.revoked_at)::bigint IS DISTINCT FROM (old.revoked_at)::bigint)))$condition$),
   ('pat_grants_immutable',$condition$(((new.credential_id)::text IS DISTINCT FROM (old.credential_id)::text) OR ((new.account_id)::text IS DISTINCT FROM (old.account_id)::text) OR (new.space_id IS DISTINCT FROM old.space_id) OR ((old.revoked_at IS NOT NULL) AND ((new.revoked_at)::bigint IS DISTINCT FROM (old.revoked_at)::bigint)))$condition$),
   ('usage_binding_immutable',$condition$(new.space_id IS DISTINCT FROM old.space_id)$condition$)),
 expected_trigger_fields AS (SELECT e.*,c.condition,
   CASE WHEN e.name IN ('seoul_archive_expiry','seoul_lifecycle_expiry') THEN 5
     WHEN e.name IN ('no_truncate','schema_migrations_no_truncate','deployment_identity_no_truncate') THEN 34
     WHEN e.name='no_delete' THEN 11
     WHEN e.name IN ('schema_migrations_append_only','deployment_identity_immutable') THEN 27
     ELSE 19 END AS type FROM expected_triggers e LEFT JOIN trigger_conditions c USING(name)),
 expected_trigger_definitions AS (SELECT e.*,
   'CREATE '||CASE WHEN e.type=5 THEN 'CONSTRAINT ' ELSE '' END||'TRIGGER '||e.name||' '||
     CASE e.type WHEN 5 THEN 'AFTER INSERT' WHEN 11 THEN 'BEFORE DELETE' WHEN 19 THEN 'BEFORE UPDATE'
       WHEN 27 THEN 'BEFORE DELETE OR UPDATE' WHEN 34 THEN 'BEFORE TRUNCATE' END||' ON '||e.relation||
     CASE WHEN e.type=5 THEN ' DEFERRABLE INITIALLY DEFERRED' ELSE '' END||
     CASE WHEN e.type=34 THEN ' FOR EACH STATEMENT' ELSE ' FOR EACH ROW' END||
     CASE WHEN e.condition IS NULL THEN '' ELSE ' WHEN ('||e.condition||')' END||
     ' EXECUTE FUNCTION '||e.function_name AS definition FROM expected_trigger_fields e),
 actual_triggers AS (SELECT t.name AS relation,g.tgname::text AS name,f.name AS function_name,
   pg_catalog.pg_get_triggerdef(g.oid,false) AS definition
   FROM pg_catalog.pg_trigger g JOIN tables t ON t.oid=g.tgrelid
   LEFT JOIN functions f ON f.oid=g.tgfoid WHERE NOT g.tgisinternal)` : ''}
SELECT
 (current_user=$1 AND session_user=$1 AND (SELECT count(*) FROM roles)=${lifecycle ? 6 : 5}
   AND NOT EXISTS(SELECT 1 FROM roles WHERE rolcanlogin IS DISTINCT FROM (rolname=$1)
     OR rolinherit IS DISTINCT FROM (rolname=$1) OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication)
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN roles r ON r.oid=m.member
     JOIN roles g ON g.oid=m.roleid WHERE r.rolname=$1 AND g.rolname='memory_runtime' AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN roles r ON r.oid=m.member
     LEFT JOIN roles g ON g.oid=m.roleid WHERE r.rolname<>$1 OR g.rolname IS DISTINCT FROM 'memory_runtime'
       OR NOT m.inherit_option OR m.set_option OR m.admin_option)${lifecycle ? `
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN roles target ON target.oid=m.roleid
     JOIN pg_catalog.pg_roles member_role ON member_role.oid=m.member
     WHERE NOT(member_role.rolname=$1 AND target.rolname='memory_runtime'
       AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
       AND (m.inherit_option OR m.set_option OR (m.admin_option AND NOT(member_role.rolcreaterole OR member_role.rolsuper))))` : ''}
   AND NOT EXISTS(SELECT 1 FROM roles r WHERE r.rolname IN ($1,'memory_runtime','memory_commands'${lifecycleRole})
     AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE'))
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN roles r
     WHERE pg_catalog.left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
       AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')
       AND NOT(r.rolname='memory_owner' AND EXISTS(SELECT 1 FROM expected_schemas e WHERE e.name=n.nspname)))
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n JOIN roles r ON r.oid=n.nspowner
     WHERE r.rolname<>'memory_owner' OR NOT EXISTS(SELECT 1 FROM expected_schemas e WHERE e.name=n.nspname))
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN roles r ON r.oid=c.relowner
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE r.rolname<>'memory_owner' OR (pg_catalog.left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
       AND NOT EXISTS(SELECT 1 FROM expected_schemas e WHERE e.name=n.nspname)))) AS roles_ok,
 (NOT EXISTS(SELECT 1 FROM schemas s FULL JOIN expected_schemas e USING(name)
     WHERE s.name IS NULL OR e.name IS NULL OR s.owner IS DISTINCT FROM 'memory_owner')
   AND NOT EXISTS((SELECT * FROM schema_acl EXCEPT SELECT * FROM expected_schema_acl)
     UNION ALL (SELECT * FROM expected_schema_acl EXCEPT SELECT * FROM schema_acl))) AS schemas_ok,
 (NOT EXISTS(SELECT 1 FROM tables t FULL JOIN table_spec e USING(name)
     WHERE t.name IS NULL OR e.name IS NULL OR t.owner IS DISTINCT FROM 'memory_owner' OR t.relkind<>'r'
       OR t.relrowsecurity IS DISTINCT FROM NOT e.metadata OR t.relforcerowsecurity IS DISTINCT FROM NOT e.metadata)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i JOIN tables t ON t.oid=i.inhrelid OR t.oid=i.inhparent)
   AND NOT EXISTS((SELECT * FROM table_acl EXCEPT SELECT * FROM expected_table_acl)
     UNION ALL (SELECT * FROM expected_table_acl EXCEPT SELECT * FROM table_acl))) AS tables_ok,
 (NOT EXISTS((SELECT * FROM column_acl EXCEPT SELECT * FROM expected_column_acl)
   UNION ALL (SELECT * FROM expected_column_acl EXCEPT SELECT * FROM column_acl))) AS columns_ok,
 (NOT EXISTS(SELECT 1 FROM functions f FULL JOIN function_spec e USING(name)
     WHERE f.name IS NULL OR e.name IS NULL OR f.owner IS DISTINCT FROM e.owner OR f.definer IS DISTINCT FROM e.definer
       OR f.result IS DISTINCT FROM e.result OR f.prokind<>'f' OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
       OR f.proleakproof OR f.proretset OR f.lanname<>'plpgsql')
   AND NOT EXISTS((SELECT * FROM function_acl EXCEPT SELECT * FROM expected_function_acl)
     UNION ALL (SELECT * FROM expected_function_acl EXCEPT SELECT * FROM function_acl))) AS functions_ok,
 (NOT EXISTS((SELECT * FROM policies EXCEPT SELECT * FROM expected_policies)
   UNION ALL (SELECT * FROM expected_policies EXCEPT SELECT * FROM policies))) AS policies_ok,
 ((SELECT count(*) FROM function_defaults)=${lifecycle ? 3 : 2} AND NOT EXISTS(SELECT 1 FROM function_defaults
   WHERE namespace<>0 OR owner<>grantee OR privilege<>'EXECUTE' OR grantable)) AS defaults_ok,
 ((SELECT count(*) FROM pg_catalog.pg_trigger g JOIN tables t ON t.oid=g.tgrelid
     JOIN functions f ON f.oid=g.tgfoid WHERE t.name='memory_content.archives' AND g.tgname='seoul_archive_expiry'
       AND f.name='memory_content.seoul_archive_commit_fence()' AND NOT g.tgisinternal
       AND g.tgdeferrable AND g.tginitdeferred AND g.tgenabled='O' AND g.tgtype=5
       AND g.tgconstraint<>0 AND g.tgnargs=0 AND g.tgqual IS NULL)=1
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g JOIN tables t ON t.oid=g.tgrelid WHERE g.tgenabled<>'O')${lifecycle ? `
   AND NOT EXISTS(SELECT 1 FROM expected_trigger_definitions e FULL JOIN actual_triggers a USING(relation,name)
     WHERE e.name IS NULL OR a.name IS NULL OR a.function_name IS DISTINCT FROM e.function_name
       OR a.definition IS DISTINCT FROM e.definition)
   AND NOT EXISTS(SELECT 1 FROM lifecycle_triggers e
     LEFT JOIN tables t ON t.name=e.relation
     LEFT JOIN pg_catalog.pg_trigger g ON g.tgrelid=t.oid AND g.tgname=e.name
     LEFT JOIN functions f ON f.oid=g.tgfoid
     WHERE g.oid IS NULL OR f.name IS DISTINCT FROM e.function_name OR g.tgisinternal OR g.tgenabled<>'O'
       OR g.tgtype<>e.type OR g.tgdeferrable IS DISTINCT FROM e.deferred OR g.tginitdeferred IS DISTINCT FROM e.deferred
       OR (g.tgconstraint<>0) IS DISTINCT FROM e.deferred OR g.tgnargs<>0 OR g.tgqual IS NOT NULL
       OR g.tgattr<>''::pg_catalog.int2vector OR g.tgoldtable IS NOT NULL OR g.tgnewtable IS NOT NULL)` : ''}) AS triggers_ok`;
}
const flags = ['roles_ok', 'schemas_ok', 'tables_ok', 'columns_ok', 'functions_ok', 'policies_ok', 'defaults_ok', 'triggers_ok'];

/** Fixed native Seoul command boundary. Compose after deployment identity
 * verification on the same transaction. Function bodies/constraint definitions
 * are pinned by installation/preflight; this does not hash them or attest
 * physical residency, credentials, authority, TLS or serving readiness. */
export async function verifySeoulServingPrivileges(session: PgSession, expectedRole: string, schemaVersion: 4 | 5 = 4): Promise<void> {
  if ((schemaVersion !== 4 && schemaVersion !== 5) || typeof expectedRole !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(expectedRole)
    || /(^|_)(postgres|admin|owner|commands|migrator|migration|service_role|anon|authenticated)($|_)/.test(expectedRole)
    || ['memory_runtime', 'memory_background'].includes(expectedRole)
    || (schemaVersion === 5 && expectedRole === 'memory_lifecycle')) fail('seoul_serving_expectation_invalid');
  let rows: Record<string, unknown>[];
  try { rows = (await session.query(catalogueSql(schemaVersion), [expectedRole])).rows; }
  catch { fail('seoul_serving_privileges_unavailable'); }
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || Object.keys(rows[0]).length !== flags.length
    || flags.some(flag => rows[0]![flag] !== true)) fail('seoul_serving_privileges_denied');
  const expectedMigrations = schemaVersion === 5 ? [...migrations, '0005_seoul_archive_lifecycle.sql'] : migrations;
  try { rows = (await session.query(`SELECT version, name FROM memory_control.schema_migrations ORDER BY version LIMIT ${schemaVersion + 1}`)).rows; }
  catch { fail('seoul_serving_privileges_unavailable'); }
  if (!Array.isArray(rows) || rows.length !== expectedMigrations.length || rows.some((row, index) => !row || row.version !== index + 1 || row.name !== expectedMigrations[index])) {
    fail('seoul_serving_privileges_denied');
  }
}

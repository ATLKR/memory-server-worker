import type { PgSession } from '../connection.ts';

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const migrations = ['0001_private_namespaces.sql', '0002_deployment_identity.sql',
  '0003_identity_foundation.sql', '0004_seoul_pat_archive.sql'];

// This is the fixed migration-4 privilege contract, not a general catalog
// framework. Only booleans leave PostgreSQL; no authority/content rows are read.
// ACL comparisons include PUBLIC, column grants and grant options. Role edges
// are checked even when their privileges are not currently inherited.
// Reserved-role ownership and non-system CREATE are checked across namespaces;
// unrelated provider objects remain outside this fixed service inventory.
// Owner TOAST relations are PostgreSQL internals, not unexpected public tables.
const catalogueSql = `WITH
 roles AS (SELECT * FROM pg_catalog.pg_roles WHERE rolname IN
   ($1,'memory_owner','memory_runtime','memory_background','memory_commands')),
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
     ('memory_content','memory_commands'),('memory_ops','memory_commands')) v(name,grantee)),
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
   ('memory_ops.space_usage',false,true,false,ARRAY['source_bytes','message_count']),
   ('memory_ops.meter_events',false,true,true,ARRAY[]::text[])),
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
     CROSS JOIN (VALUES ('memory_runtime'),('memory_background')) r(name) WHERE t.metadata),
 column_acl AS (SELECT t.name,c.attname::text AS column_name,
   CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
   a.privilege_type AS privilege,a.is_grantable AS grantable
   FROM tables t JOIN pg_catalog.pg_attribute c ON c.attrelid=t.oid AND c.attnum>0 AND NOT c.attisdropped,
   LATERAL pg_catalog.aclexplode(CASE WHEN pg_catalog.cardinality(c.attacl)>0 THEN c.attacl END) a),
 expected_column_acl AS (SELECT t.name,c.column_name,'memory_commands'::text AS grantee,'UPDATE'::text AS privilege,false AS grantable
   FROM table_spec t,LATERAL pg_catalog.unnest(t.update_columns) c(column_name)),
 function_spec(name,owner,definer,result,entry) AS (VALUES
   ('memory_control.reject_mutation()','memory_owner',false,'trigger',false),
   ('memory_identity.seoul_pat_check(text)','memory_commands',true,'jsonb',true),
   ('memory_identity.seoul_pat_authority(text, text, boolean)','memory_commands',true,'jsonb',false),
   ('memory_content.seoul_validate_input(jsonb, boolean)','memory_commands',true,'jsonb',false),
   ('memory_content.seoul_archive_ingest(text, jsonb)','memory_commands',true,'jsonb',true),
   ('memory_content.seoul_keyword_search(text, jsonb)','memory_commands',true,'jsonb',true),
   ('memory_content.seoul_archive_commit_fence()','memory_commands',true,'trigger',false)),
 functions AS (SELECT p.oid,n.nspname||'.'||p.proname||'('||pg_catalog.oidvectortypes(p.proargtypes)||')' AS name,
   r.rolname::text AS owner,p.prosecdef AS definer,pg_catalog.pg_get_function_result(p.oid) AS result,
   p.prokind,p.proconfig,p.proacl,p.proleakproof,p.proretset,l.lanname
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE pg_catalog.left(n.nspname,7)='memory_'
     OR r.rolname IN ($1,'memory_runtime','memory_commands','memory_owner','memory_background')),
 function_acl AS (SELECT f.name,
   CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
   a.privilege_type AS privilege,a.is_grantable AS grantable FROM functions f
   JOIN pg_catalog.pg_roles r ON r.rolname=f.owner,
   LATERAL pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',r.oid))) a),
 expected_function_acl AS (SELECT name,owner AS grantee,'EXECUTE'::text AS privilege,false AS grantable FROM function_spec
   UNION ALL SELECT name,'memory_runtime','EXECUTE',false FROM function_spec WHERE entry),
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
   UNION ALL SELECT name,'seoul_commands_update','w',true,ARRAY['memory_commands'],'true','true' FROM table_spec WHERE pg_catalog.cardinality(update_columns)>0),
 function_defaults AS (SELECT r.rolname::text AS owner,COALESCE(d.defaclnamespace,0) AS namespace,
   CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
   a.privilege_type AS privilege,a.is_grantable AS grantable
   FROM roles r LEFT JOIN pg_catalog.pg_default_acl d ON d.defaclrole=r.oid AND d.defaclobjtype='f',
   LATERAL pg_catalog.aclexplode(COALESCE(d.defaclacl,pg_catalog.acldefault('f',r.oid))) a
   WHERE r.rolname IN ('memory_owner','memory_commands'))
SELECT
 (current_user=$1 AND session_user=$1 AND (SELECT count(*) FROM roles)=5
   AND NOT EXISTS(SELECT 1 FROM roles WHERE rolcanlogin IS DISTINCT FROM (rolname=$1)
     OR rolinherit IS DISTINCT FROM (rolname=$1) OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication)
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN roles r ON r.oid=m.member
     JOIN roles g ON g.oid=m.roleid WHERE r.rolname=$1 AND g.rolname='memory_runtime' AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN roles r ON r.oid=m.member
     LEFT JOIN roles g ON g.oid=m.roleid WHERE r.rolname<>$1 OR g.rolname IS DISTINCT FROM 'memory_runtime'
       OR NOT m.inherit_option OR m.set_option OR m.admin_option)
   AND NOT EXISTS(SELECT 1 FROM roles r WHERE r.rolname IN ($1,'memory_runtime','memory_commands')
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
 ((SELECT count(*) FROM function_defaults)=2 AND NOT EXISTS(SELECT 1 FROM function_defaults
   WHERE namespace<>0 OR owner<>grantee OR privilege<>'EXECUTE' OR grantable)) AS defaults_ok,
 ((SELECT count(*) FROM pg_catalog.pg_trigger g JOIN tables t ON t.oid=g.tgrelid
     JOIN functions f ON f.oid=g.tgfoid WHERE t.name='memory_content.archives' AND g.tgname='seoul_archive_expiry'
       AND f.name='memory_content.seoul_archive_commit_fence()' AND NOT g.tgisinternal
       AND g.tgdeferrable AND g.tginitdeferred AND g.tgenabled='O' AND g.tgtype=5
       AND g.tgconstraint<>0 AND g.tgnargs=0 AND g.tgqual IS NULL)=1
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g JOIN tables t ON t.oid=g.tgrelid WHERE g.tgenabled<>'O')) AS triggers_ok`;
const flags = ['roles_ok', 'schemas_ok', 'tables_ok', 'columns_ok', 'functions_ok', 'policies_ok', 'defaults_ok', 'triggers_ok'];

/** Fixed native Seoul command boundary. Compose after deployment identity
 * verification on the same transaction. Function bodies/constraint definitions
 * are pinned by installation/preflight; this does not hash them or attest
 * physical residency, credentials, authority, TLS or serving readiness. */
export async function verifySeoulServingPrivileges(session: PgSession, expectedRole: string): Promise<void> {
  if (typeof expectedRole !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(expectedRole)
    || /(^|_)(postgres|admin|owner|commands|migrator|migration|service_role|anon|authenticated)($|_)/.test(expectedRole)
    || ['memory_runtime', 'memory_background'].includes(expectedRole)) fail('seoul_serving_expectation_invalid');
  let rows: Record<string, unknown>[];
  try { rows = (await session.query(catalogueSql, [expectedRole])).rows; }
  catch { fail('seoul_serving_privileges_unavailable'); }
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || Object.keys(rows[0]).length !== flags.length
    || flags.some(flag => rows[0]![flag] !== true)) fail('seoul_serving_privileges_denied');
  try { rows = (await session.query('SELECT version, name FROM memory_control.schema_migrations ORDER BY version LIMIT 5')).rows; }
  catch { fail('seoul_serving_privileges_unavailable'); }
  if (!Array.isArray(rows) || rows.length !== migrations.length || rows.some((row, index) => !row || row.version !== index + 1 || row.name !== migrations[index])) {
    fail('seoul_serving_privileges_denied');
  }
}

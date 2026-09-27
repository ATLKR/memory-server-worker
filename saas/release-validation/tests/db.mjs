import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { digest } from '../../src/release/util.ts';
export const at=Date.UTC(2026,8,8,12);

const MIGRATION_DIR=new URL('../../postgres/migrations/',import.meta.url);
const MIGRATIONS=readdirSync(MIGRATION_DIR).filter(f=>f.endsWith('.sql')).sort();

/** Translates `?` placeholders to `$n`, skipping quoted strings — the same
 * contract the Postgres Database adapter applies to service SQL. */
function translate(sql){
  let out='',n=0,i=0;
  while(i<sql.length){
    const c=sql[i];
    if(c==="'"){const j=sql.indexOf("'",i+1);out+=sql.slice(i,j===-1?undefined:j+1);i=j===-1?sql.length:j+1;}
    else if(c==='?'){out+='$'+(++n);i+=1;}
    else{out+=c;i+=1;}
  }
  return out;
}
// PGlite returns integer/numeric columns as bigint or numeric strings; the
// retired SQLite driver returned JS numbers for all of them.
const NUMERIC_OIDS=new Set([20,21,23,26,1700]);
const decode=(value,fields)=>{
  if(typeof value==='bigint')return Number(value);
  if(Array.isArray(value))return value.map(v=>decode(v));
  if(value&&typeof value==='object'&&!(value instanceof Uint8Array)&&!(value instanceof Date)){
    const row={};
    for(const[k,v]of Object.entries(value)){
      const oid=fields?.find(f=>f.name===k)?.dataTypeID;
      row[k]=typeof v==='string'&&NUMERIC_OIDS.has(oid)&&/^-?\d+$/.test(v)?Number(v):decode(v);
    }
    return row;
  }
  return value;
};

/** PGlite-backed fixture for the same small Database contract services consume.
 * `raw` mirrors the old sync-sqlite call shape but every call is async. */
export class DB {
  raw;
  constructor(clock=()=>at){
    this.clock=clock;
    const engine=this.engine=new PGlite();
    this._ready=(async()=>{
      await engine.waitReady;
      for(const name of MIGRATIONS)await engine.exec(readFileSync(new URL(name,MIGRATION_DIR),'utf8'));
      // Tests inject the database clock through a session GUC.
      await engine.exec(`CREATE OR REPLACE FUNCTION memory_control.now_ms() RETURNS bigint
        LANGUAGE sql AS $$ SELECT current_setting('app.test_now_ms', true)::bigint $$`);
      await engine.query(`SELECT set_config('app.test_now_ms',$1,false)`,[String(clock())]);
      // The deployment singleton supplies residency when a command passes NULL.
      await engine.query(`INSERT INTO memory_control.deployment_identity
        VALUES(1,'memory-sg','sg','standard-v1',1)`);
      // The billing catalog lives on the control plane; the tests need the same
      // objects on this one connection. heartbeats/provider_budgets already
      // exist in the regional set, so the catalog objects land here manually
      // (kept in parity with postgres/control/0004+0005).
      await engine.exec(`
CREATE TABLE memory_control.pools (
  id memory_control.identifier PRIMARY KEY,
  plan text NOT NULL DEFAULT 'free',
  monthly_units bigint NOT NULL DEFAULT 1000 CHECK (monthly_units >= 0),
  storage_limit_bytes bigint NOT NULL DEFAULT 104857600 CHECK (storage_limit_bytes >= 0),
  storage_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'read_only')),
  customer_id text UNIQUE,
  subscription_id text UNIQUE,
  updated_at memory_control.epoch_ms NOT NULL DEFAULT 0
);
CREATE FUNCTION memory_control.space_pool_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $apply$
BEGIN
  INSERT INTO memory_control.pools(id)
    VALUES(CASE WHEN NEW.organization_id IS NULL THEN 'account:' || NEW.owner_account_id
      ELSE 'org:' || NEW.organization_id END)
    ON CONFLICT (id) DO NOTHING;
  RETURN NULL;
END
$apply$;
CREATE TRIGGER space_pool_insert AFTER INSERT ON memory_control.spaces
  FOR EACH ROW EXECUTE FUNCTION memory_control.space_pool_insert();
CREATE TRIGGER pools_no_delete BEFORE DELETE ON memory_control.pools
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TRIGGER pools_no_truncate BEFORE TRUNCATE ON memory_control.pools
  FOR EACH STATEMENT EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TABLE memory_control.checkout_requests (
  id memory_control.identifier PRIMARY KEY,
  pool_id memory_control.identifier REFERENCES memory_control.pools(id),
  price_id text NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  operation_key text,
  session_id text,
  checkout_url text,
  expires_at memory_control.epoch_ms NOT NULL DEFAULT 0,
  checkout_attempted smallint NOT NULL DEFAULT 1 CHECK (checkout_attempted IN (0, 1))
);
CREATE UNIQUE INDEX checkout_key ON memory_control.checkout_requests(pool_id, operation_key);
CREATE TRIGGER checkout_attempt_immutable BEFORE UPDATE ON memory_control.checkout_requests
  FOR EACH ROW WHEN (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.pool_id IS DISTINCT FROM OLD.pool_id
    OR NEW.price_id IS DISTINCT FROM OLD.price_id OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.checkout_attempted = 1
      AND (NEW.checkout_attempted IS DISTINCT FROM 1 OR NEW.expires_at IS DISTINCT FROM OLD.expires_at)))
  EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TABLE memory_ops.checkout_closures (
  request_id memory_control.identifier PRIMARY KEY REFERENCES memory_control.checkout_requests(id),
  session_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('expired', 'subscription_ended')),
  subscription_id text,
  actor_credential_id memory_control.identifier NOT NULL,
  checked_at memory_control.epoch_ms NOT NULL,
  CHECK ((state = 'expired' AND subscription_id IS NULL)
    OR (state = 'subscription_ended' AND subscription_id IS NOT NULL))
);
CREATE TRIGGER checkout_closures_append_only BEFORE UPDATE OR DELETE ON memory_ops.checkout_closures
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();
CREATE TABLE memory_ops.billing_events (
  id memory_control.identifier PRIMARY KEY,
  subscription_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt bigint NOT NULL DEFAULT 0,
  available_at memory_control.epoch_ms NOT NULL,
  created_at memory_control.epoch_ms NOT NULL,
  last_error text
);
CREATE TABLE memory_ops.billing_lock (
  id smallint PRIMARY KEY CHECK (id = 1),
  token text,
  expires_at memory_control.epoch_ms NOT NULL DEFAULT 0
);
INSERT INTO memory_ops.billing_lock(id) VALUES(1);
CREATE TRIGGER billing_lock_no_delete BEFORE DELETE ON memory_ops.billing_lock
  FOR EACH ROW EXECUTE FUNCTION memory_control.reject_mutation();`);
      // Legacy test SQL uses unqualified names from the old flat schema. The
      // `legacy` schema sits first in the path for names whose columns were
      // renamed (spaces.account_id→owner_account_id, created_at→created_at_ms).
      await engine.exec(`CREATE SCHEMA legacy;
        CREATE VIEW legacy.spaces AS
          SELECT id, name, owner_account_id AS account_id, owner_account_id, organization_id,
            security_mode, created_at_ms AS created_at, created_at_ms, actor_credential_id,
            disabled_at, deployment_id, data_policy, source_byte_limit, message_limit
          FROM memory_control.spaces;
        CREATE VIEW legacy.audit_events AS SELECT * FROM memory_ops.identity_audit_events;`);
      await engine.exec(`SET search_path TO legacy,memory_identity,memory_control,memory_content,memory_ops,memory_jobs,memory_search,memory_billing,public`);
      // Compatibility views keep the retired release_* table names readable and
      // writable where the view is a plain projection of the new table.
      await engine.exec(`
        CREATE VIEW release_pools AS SELECT * FROM memory_control.pools;
        CREATE VIEW release_usage_counters AS SELECT * FROM memory_ops.usage_counters;
        CREATE VIEW release_usage_events AS SELECT * FROM memory_ops.usage_events;
        CREATE VIEW release_operations AS SELECT * FROM memory_ops.release_operations;
        CREATE VIEW release_credential_policies AS SELECT * FROM memory_identity.credential_policies;
        CREATE VIEW release_shares AS SELECT * FROM memory_identity.shares;
        CREATE VIEW release_jobs AS SELECT * FROM memory_jobs.release_jobs;
        CREATE VIEW release_space_policies AS SELECT * FROM memory_ops.space_policies;
        CREATE VIEW release_export_sessions AS SELECT * FROM memory_ops.export_sessions;
        CREATE VIEW release_vector_refs AS SELECT * FROM memory_search.vector_refs;
        CREATE VIEW release_fts_rows AS SELECT * FROM memory_search.fts_rows;
        CREATE VIEW release_erasure_permits AS SELECT * FROM memory_ops.erasure_permits;
        CREATE VIEW release_erasure_ledger AS SELECT * FROM memory_ops.erasure_ledger;
        CREATE VIEW release_maintenance_progress AS SELECT * FROM memory_ops.maintenance_progress;
        CREATE VIEW release_payload_backfill_progress AS SELECT * FROM memory_ops.payload_backfill_progress;
        CREATE VIEW release_events AS SELECT * FROM memory_ops.release_events;
        CREATE VIEW release_ingest_approvals AS SELECT * FROM memory_jobs.ingest_approvals;
        CREATE VIEW release_scim_keys AS SELECT * FROM memory_identity.scim_keys;
        CREATE VIEW release_scim_deletions AS SELECT * FROM memory_identity.scim_deletions;
        CREATE VIEW release_domain_challenges AS SELECT * FROM memory_identity.domain_challenges;
        CREATE VIEW release_domain_verifications AS SELECT * FROM memory_identity.domain_verifications;
        CREATE VIEW release_external_email_blocks AS SELECT * FROM memory_identity.external_email_blocks;
        CREATE VIEW release_reauth_challenges AS SELECT * FROM memory_identity.reauth_challenges;
        CREATE VIEW release_checkout_requests AS SELECT * FROM memory_control.checkout_requests;
        CREATE VIEW release_checkout_closures AS SELECT * FROM memory_ops.checkout_closures;
        CREATE VIEW release_billing_events AS SELECT * FROM memory_ops.billing_events;
        CREATE VIEW release_billing_lock AS SELECT * FROM memory_ops.billing_lock;
        CREATE VIEW release_space_pools AS SELECT * FROM memory_ops.space_pools;
        CREATE VIEW release_webhook_events AS SELECT * FROM memory_ops.webhook_events;
        CREATE VIEW release_heartbeats AS SELECT * FROM memory_ops.heartbeats;
        CREATE VIEW release_provider_budgets AS SELECT * FROM memory_ops.provider_budgets;
        CREATE VIEW release_provider_revocations AS SELECT * FROM memory_ops.provider_revocations;
        CREATE VIEW release_mail_budget AS SELECT * FROM memory_ops.mail_budget;
        CREATE VIEW release_identity_lifecycle_events AS SELECT * FROM memory_ops.lifecycle_events;
        CREATE VIEW release_identity_lifecycle_jwt_proofs AS SELECT * FROM memory_ops.lifecycle_jwt_proofs;
        CREATE VIEW release_identity_lifecycle_state AS SELECT * FROM memory_ops.lifecycle_applied_state;
        CREATE VIEW release_payload_intents AS SELECT * FROM memory_content.payload_intents;
        CREATE VIEW release_payload_stages AS SELECT * FROM memory_content.payload_stages;
        CREATE VIEW release_payload_stage_accounts AS SELECT * FROM memory_ops.payload_stage_accounts;
        CREATE VIEW release_payload_purges AS SELECT * FROM memory_ops.payload_purges;
        CREATE VIEW release_payload_retirements AS SELECT * FROM memory_ops.payload_retirements;
        CREATE VIEW release_payload_archive_permits AS SELECT * FROM memory_content.payload_archive_permits;
        CREATE VIEW release_payload_archives AS SELECT * FROM memory_content.payload_archives;
        -- The D1 lineage tracked its version in release_meta; the PostgreSQL
        -- lineage records every migration in memory_control.schema_migrations.
        CREATE VIEW release_meta AS SELECT max(version) AS version FROM memory_control.schema_migrations;
        -- Object-introspection SQL written against the SQLite catalog.
        CREATE VIEW sqlite_master AS
          SELECT c.relname AS name,
            CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'i' THEN 'index' ELSE c.relkind::text END AS type,
            coalesce(pg_get_viewdef(c.oid), '') AS sql
          FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND c.relkind IN ('r','v','i');`);
    })();
    const ready=()=>this._ready;
    // now_ms() tracks the caller's clock: refresh the session GUC before every
    // statement so tests that advance `now` between prepare and run see it.
    const query=async(sql,v)=>{await ready();await engine.query(`SELECT set_config('app.test_now_ms',$1,false)`,[String(this.clock())]);return engine.query(sql,v);};
    // Pin a new clock: every later statement re-evaluates this.clock() so tests
    // that freeze or advance time via setClock keep that value until changed.
    this.setClock=async fn=>{this.clock=fn;await ready();await engine.query(`SELECT set_config('app.test_now_ms',$1,false)`,[String(fn())]);};
    this.raw={
      exec:async sql=>{await query('SELECT 1',[]);await engine.exec(sql);},
      prepare:sql=>({
        get:async(...v)=>{const r=await query(translate(sql),v);const row=r.rows[0];return row===undefined?null:decode(row,r.fields);},
        all:async(...v)=>{const r=await query(translate(sql),v);return r.rows.map(row=>decode(row,r.fields));},
        run:async(...v)=>{const r=await query(translate(sql),v);return {changes:r.rowCount};},
      }),
    };
    this._query=query;
  }
  async migrate(){await this._ready;}
  prepare(sql){let values=[];const db=this;return {bind(...v){values=v;return this;},
    async first(){const r=await db._query(translate(sql),values);const row=r.rows[0];return row===undefined?null:decode(row,r.fields);},
    async all(){const r=await db._query(translate(sql),values);return {success:true,results:r.rows.map(row=>decode(row,r.fields)),meta:{}};},
    async run(){const r=await db._query(translate(sql),values);return {success:true,results:[],meta:{changes:r.rowCount}};}};}
  withSession(){return this;}
  async batch(statements){await this._ready;await this.engine.exec('BEGIN');try{const results=[];for(const s of statements){results.push(await s.all());}await this.engine.exec('COMMIT');return results;}catch(e){await this.engine.exec('ROLLBACK');throw e;}}
  close(){return this.engine.close();}
}
export async function fixture({clock=()=>at}={}){
 const db=new DB(clock);await db.migrate();
 const token='a'.repeat(64),other='b'.repeat(64),key='c'.repeat(64);
 await db.raw.exec(`INSERT INTO memory_identity.accounts(id) VALUES('alice'),('bob'); INSERT INTO memory_control.organizations(id) VALUES('org');
 INSERT INTO memory_identity.account_emails(id,account_id,address,domain,verified_at) VALUES('e1','alice','alice@example.com','example.com',${at}),('e2','bob','bob@example.com','example.com',${at});
 INSERT INTO memory_identity.memberships(id,organization_id,account_id,email_id,role,expires_at) VALUES('m1','org','alice','e1','owner',9007199254740991),('m2','org','bob','e2','member',9007199254740991);`);
 for(const [id,account,t,kind] of [['session:alice','alice',token,'session'],['session:bob','bob',other,'session'],['key:alice','alice',key,'personal_key']]){
 await db.raw.prepare('INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at,permission) VALUES(?,?,?,?,?,?,?)').run(id,account,kind,await digest(t),at+900000,at,'write');
 }
 const policy=`jsonb_build_object('policyVersion',1,'residency','sg','profile','standard','processingBoundary','approved-processors','dataClass','general','classificationStatus','declared','sensitivityTags','[]'::jsonb,'placementEpoch',1)`;
 await db.raw.exec(`INSERT INTO memory_control.spaces(id,owner_account_id,organization_id,deployment_id,data_policy,source_byte_limit,message_limit,name,security_mode,created_at_ms,actor_credential_id) VALUES
  ('s1','alice',NULL,'memory-sg',${policy},67108864,100000,'Personal','managed',${at},'session:alice'),
  ('s2','bob',NULL,'memory-sg',${policy},67108864,100000,'Other','managed',${at},'session:bob'),
  ('so',NULL,'org','memory-sg',${policy},67108864,100000,'Team','managed',${at},'session:alice');
 INSERT INTO memory_identity.credential_policies(credential_id,capabilities,space_ids) VALUES('key:alice','["read","create"]'::jsonb,'["s1"]'::jsonb);
 -- The lifecycle-journal staleness gate denies credentials whose issuer has no
 -- fresh apply-head; tests that exercise staleness overwrite this head.
 INSERT INTO memory_ops.lifecycle_apply_head(issuer, applied_sequence, applied_at_ms)
  VALUES('https://auth-api.allen.company',0,9007199254740991),('memory:control',0,9007199254740991)
  ON CONFLICT (issuer) DO NOTHING;`);
 return {db,token,other,key};
}

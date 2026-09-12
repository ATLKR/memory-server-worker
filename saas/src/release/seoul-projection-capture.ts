import type { IdentityDatabase, SqlValue } from '../identity.ts';
import type { Database, Result, Statement } from './types.ts';

const ISSUER = 'https://auth-api.allen.company';
const TRUSTED_CONSTRUCTION = Symbol('trusted seoul capture composition');
/** Internal projection representation limits, never central admission quotas.
 * 512 bounds combined effective keys and raw dependent Spaces separately,
 * before target filtering. Many unselected Spaces may therefore conservatively
 * exclude the account. This bounds discovery without changing central quotas.
 * Account-indexed LIMIT 513 sentinels stop discovery; normal JSON is constructed
 * only after conservative 6x UTF-8 escaping estimates fit 128 KiB per record
 * and 512 KiB per command. Existing invite/PAT limits do not bound retained
 * history, so excess history is an explicit account exclusion, not truncation.
 */
export const SEOUL_CAPTURE_LIMITS = Object.freeze({ keys: 512, spaces: 512, recordBytes: 131072, commandBytes: 524288 });
type AdapterKind = 'native-d1' | 'durable-sql';
type KeyScope = { accountId: string; keyId: string; organizationId: string | null; spaceIds: string[] | null };
type UnlinkScope = { emailId: string; revocationId: string };
type Plan = { statements: Statement[]; commandIndex: number };
const sqlBytes = (value: string) => `coalesce(length(CAST(${value} AS BLOB)),0)`;
const scalarCost = (...values: string[]) => `6*(${values.map(sqlBytes).join('+')})`;
// SQL UUIDv4, independently minted only for an actual changed source row.
const UUID = "lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))";
const trimWhitespace = 'char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279)';
const positions = 'positions(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM positions WHERE n<512)';
// Match the opaque 512-JS-unit subject contract, including astral scalars and
// embedded newlines. Re-encoding each scalar catches malformed retained UTF-8;
// no normalization or arbitrary subject splitting occurs.
const validSubject = (p: string) => `(typeof(${p}.subject)='text' AND length(${p}.subject) BETWEEN 1 AND 512 AND instr(${p}.subject,char(0))=0
 AND length(trim(${p}.subject,${trimWhitespace}))>0
 AND (SELECT sum(CASE WHEN unicode(substr(${p}.subject,n,1))>65535 THEN 2 ELSE 1 END) FROM positions WHERE n<=length(${p}.subject))<=512
 AND NOT EXISTS(SELECT 1 FROM positions WHERE n<=length(${p}.subject) AND (unicode(substr(${p}.subject,n,1)) BETWEEN 55296 AND 57343
  OR hex(CAST(char(unicode(substr(${p}.subject,n,1))) AS BLOB))<>hex(CAST(substr(${p}.subject,n,1) AS BLOB)))))`;
const validId = (value: string) => `(typeof(${value})='text' AND length(${value}) BETWEEN 1 AND 256 AND substr(${value},1,1) GLOB '[A-Za-z0-9]' AND ${value} NOT GLOB '*[^A-Za-z0-9._:-]*')`;
const validTime = (value: string) => `(typeof(${value})='integer' AND ${value} BETWEEN 0 AND 9007199254740991)`;
const validNullableTime = (value: string) => `(${value} IS NULL OR ${validTime(value)})`;
const membershipCost = `1024+${scalarCost('m.id','m.organization_id','m.account_id','m.email_id','m.role')}`;
const credentialCost = `2048+${scalarCost('c.id','c.account_id','c.membership_id','c.email_id','p.capabilities','p.space_ids')}`;

function policy(c: string): string {
  return `(SELECT json_object('capabilities',json((SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(p.capabilities) ORDER BY value COLLATE BINARY))),
   'spaceIds',CASE WHEN p.space_ids IS NULL THEN NULL ELSE json((SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(p.space_ids) ORDER BY value COLLATE BINARY))) END)
   FROM release_credential_policies p WHERE p.credential_id=${c}.id)`;
}
function effectiveState(): string {
  return `CASE k.stream_kind
   WHEN 'credential' THEN (SELECT json_object('version',3,'kind','credential-source','id',c.id,'accountId',c.account_id,'credentialKind',c.kind,
    'tokenDigest',c.token_digest,'membershipId',c.membership_id,'emailId',c.email_id,'permission',c.permission,'expiresAtMs',c.expires_at,'revokedAtMs',c.revoked_at,
    'policy',json(${policy('c')})) FROM credentials c WHERE c.id=k.entity_id AND c.kind IN ('personal_key','api_key'))
   WHEN 'membership' THEN (SELECT json_object('version',3,'kind','membership-source','id',m.id,'organizationId',m.organization_id,'accountId',m.account_id,'emailId',m.email_id,
    'role',m.role,'expiresAtMs',m.expires_at,'revokedAtMs',m.revoked_at) FROM memberships m WHERE m.id=k.entity_id)
   WHEN 'email' THEN (SELECT json_object('version',3,'kind','email-source','issuer',k.issuer,'subject',k.subject,'address',k.address,'accountId',a.account_id,
    'liveClaim',json((SELECT json_object('id',e.id,'verifiedAtMs',e.verified_at) FROM account_emails e WHERE e.account_id=a.account_id AND e.address=k.address AND e.revoked_at IS NULL)),
    'changedClaim',NULL,'addressBlocked',json(CASE WHEN EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=k.address) OR EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=a.account_id AND b.address=k.address) THEN 'true' ELSE 'false' END),
    'legacyRevoked',json(CASE WHEN EXISTS(SELECT 1 FROM release_provider_revocations r WHERE r.issuer=k.issuer AND r.subject=k.subject AND r.kind='email.revoked' AND r.address=k.address) THEN 'true' ELSE 'false' END),
    'lifecycle',json(coalesce((SELECT json_object('state','event','eventId',l.event_id,'sequence',l.sequence,'kind',l.kind,'occurredAtMs',l.occurred_at) FROM release_identity_lifecycle_state l WHERE l.issuer=k.issuer AND l.subject=k.subject AND l.address=k.address),'{"state":"absent"}')))
    FROM release_seoul_capture_attempts a WHERE a.id=k.attempt_id)
   END`;
}

/** Adapter provenance is a trusted composition assertion, not a runtime proof
 * that arbitrary supplied code is atomic. Native D1 must be the real binding;
 * durable-sql must be the reviewed client -> SqlDatabaseEngine transactionSync
 * adapter. There is no injection in production in this slice, no fallback,
 * and no support for a caller's parallel/non-atomic fixture under another mode.
 */
export function createSeoulProjectionCapture(database: Database, adapter: AdapterKind): SeoulProjectionCapture {
  if (!database || typeof database.prepare !== 'function' || typeof database.withSession !== 'function' || typeof database.batch !== 'function'
      || !['native-d1','durable-sql'].includes(adapter)) throw new Error('seoul_capture_adapter_unsupported');
  return new SeoulProjectionCapture(database, TRUSTED_CONSTRUCTION);
}

export class SeoulProjectionCapture {
  private readonly database: Database;
  constructor(database: Database, construction: symbol) {
    if (construction !== TRUSTED_CONSTRUCTION) throw new Error('seoul_capture_adapter_unsupported');
    this.database = database;
  }
  assertDatabase(database: IdentityDatabase): void {
    if (database !== this.database) throw new Error('seoul_capture_database_mismatch');
  }
  issueKeyStatements(database: Database, scope: KeyScope, commands: Statement[]): Statement[] {
    this.assertDatabase(database);
    return this.plan('scoped-key',scope,commands).statements;
  }
  async unlinkEmail(database: IdentityDatabase, scope: UnlinkScope, sql: string, values: SqlValue[]): Promise<Result> {
    this.assertDatabase(database);
    const plan = this.plan('self-email-unlink',scope,[this.database.prepare(sql).bind(...values)]);
    const result = await this.database.batch(plan.statements);
    if (result.length !== plan.statements.length || result.some(row => !row.success)) throw new Error('seoul_capture_batch_failed');
    return result[plan.commandIndex]!;
  }
  private plan(kind: 'scoped-key' | 'self-email-unlink', scope: KeyScope | UnlinkScope, commands: Statement[]): Plan {
    const attempt = crypto.randomUUID(), statements: Statement[] = [];
    const add = (sql: string, values: SqlValue[] = [attempt]) => statements.push(this.database.prepare(sql).bind(...values));
    if (kind === 'scoped-key') {
      const key = scope as KeyScope;
      add(`INSERT INTO release_seoul_capture_attempts(id,command_kind,account_id,entity_id,receipt_id,organization_id,requested_space_ids,previously_present)
       VALUES(?,'scoped-key',?,?,?,?,?,EXISTS(SELECT 1 FROM credentials WHERE id=?))`,[attempt,key.accountId,key.keyId,key.keyId,key.organizationId,key.spaceIds===null?null:JSON.stringify(key.spaceIds),key.keyId]);
    } else {
      const email = scope as UnlinkScope;
      add(`INSERT INTO release_seoul_capture_attempts(id,command_kind,account_id,entity_id,receipt_id,address,previously_present)
       VALUES(?,'self-email-unlink',(SELECT account_id FROM account_emails WHERE id=?),?,?,(SELECT address FROM account_emails WHERE id=?),EXISTS(SELECT 1 FROM revocations WHERE id=?))`,
      [attempt,email.emailId,email.emailId,email.revocationId,email.emailId,email.revocationId]);
    }
    add(`WITH RECURSIVE ${positions}, bounded AS (SELECT p.* FROM provider_identities p JOIN release_seoul_capture_attempts a ON a.account_id=p.account_id WHERE a.id=? ORDER BY p.issuer,p.subject LIMIT 513)
     UPDATE release_seoul_capture_attempts SET identity_count=(SELECT count(*) FROM bounded),identity_bytes=coalesce((SELECT sum(256+${scalarCost('p.issuer','p.subject','p.account_id')}) FROM bounded p),0),
      unsupported_mapping=EXISTS(SELECT 1 FROM bounded p WHERE p.issuer<>'${ISSUER}' OR NOT ${validSubject('p')} OR typeof(p.created_at)<>'integer' OR p.created_at NOT BETWEEN 0 AND 9007199254740991),
      anchor_subject=(SELECT p.subject FROM (SELECT p.* FROM provider_identities p JOIN release_seoul_capture_attempts a ON a.account_id=p.account_id WHERE a.id=? AND p.issuer='${ISSUER}' ORDER BY p.subject COLLATE BINARY LIMIT 513) p WHERE ${validSubject('p')} ORDER BY p.subject COLLATE BINARY LIMIT 1)
     WHERE id=?`,[attempt,attempt,attempt]);
    add(`UPDATE release_seoul_capture_attempts AS a SET
     membership_count=CASE WHEN command_kind='self-email-unlink' THEN (SELECT count(*) FROM (SELECT id FROM memberships WHERE email_id=a.entity_id LIMIT 513)) ELSE 0 END,
     credential_count=CASE WHEN command_kind='self-email-unlink' THEN (SELECT count(*) FROM (SELECT id FROM credentials WHERE email_id=a.entity_id AND kind='api_key' LIMIT 513)) ELSE 1 END
     WHERE id=?`);
    add(`UPDATE release_seoul_capture_attempts SET exclusion_reason=CASE
     WHEN NOT ${validId('account_id')} THEN 'unsupported-state'
     WHEN identity_count=0 THEN 'unmapped' WHEN identity_count>512 THEN 'identity-count' WHEN unsupported_mapping THEN 'unsupported-mapping'
     WHEN identity_bytes+4096>131072 THEN 'identity-bytes' WHEN identity_count+membership_count+credential_count>512 THEN 'fanout-count'
     ELSE (SELECT reason FROM release_seoul_account_exclusions x WHERE x.account_id=release_seoul_capture_attempts.account_id) END WHERE id=?`);
    if (kind === 'self-email-unlink') this.validateEmailScope(add,attempt);
    const selected = `(EXISTS(SELECT 1 FROM release_seoul_targets t WHERE t.space_id=scoped.id AND t.selected=1) OR EXISTS(SELECT 1 FROM release_seoul_dirty_spaces d WHERE d.space_id=scoped.id))`;
    const spaces = kind === 'scoped-key'
      ? `SELECT s.id FROM spaces s WHERE ((a.organization_id IS NULL AND s.account_id=a.account_id AND s.organization_id IS NULL) OR (a.organization_id IS NOT NULL AND s.organization_id=a.organization_id AND s.account_id IS NULL))
          AND (a.requested_space_ids IS NULL OR EXISTS(SELECT 1 FROM json_each(a.requested_space_ids) j WHERE j.value=s.id))`
      : `SELECT DISTINCT s.id FROM memberships m JOIN spaces s ON s.organization_id=m.organization_id WHERE m.email_id=a.entity_id`;
    add(`UPDATE release_seoul_capture_attempts AS a SET space_count=CASE WHEN exclusion_reason IS NULL THEN (SELECT count(*) FROM (${spaces} LIMIT 513)) ELSE 0 END WHERE id=?`);
    // Validate raw retained IDs before copying into staging or dirty state.
    // At most 512 ASCII IDs of 128 bytes cap the copied ID set at 64 KiB.
    add(`UPDATE release_seoul_capture_attempts AS a SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND space_count<=512
     AND EXISTS(SELECT 1 FROM (${spaces}) raw WHERE length(raw.id)>128 OR NOT ${validId('raw.id')})`);
    this.estimates(add,attempt,kind);
    add(`UPDATE release_seoul_capture_attempts SET exclusion_reason=coalesce(exclusion_reason,CASE WHEN space_count>512 THEN 'fanout-count' WHEN largest_source>131072 OR source_bytes>524288 THEN 'source-bytes' END) WHERE id=?`);
    this.validateSources(add,attempt,kind);
    if (kind === 'scoped-key') {
      add(`INSERT INTO release_seoul_capture_scope(attempt_id,stream_kind,stream_key,entity_id)
       SELECT id,'credential',entity_id,entity_id FROM release_seoul_capture_attempts WHERE id=? AND exclusion_reason IS NULL`);
    } else {
      add(`INSERT INTO release_seoul_capture_scope(attempt_id,stream_kind,stream_key,entity_id,issuer,subject,address,prior_claim_id)
       SELECT a.id,'email',p.issuer||char(10)||p.subject||char(10)||a.address,a.entity_id,p.issuer,p.subject,a.address,
        (SELECT e.id FROM account_emails e WHERE e.account_id=a.account_id AND e.address=a.address AND e.revoked_at IS NULL)
       FROM release_seoul_capture_attempts a JOIN provider_identities p ON p.account_id=a.account_id WHERE a.id=? AND a.exclusion_reason IS NULL ORDER BY p.issuer COLLATE BINARY,p.subject COLLATE BINARY`);
      add(`INSERT INTO release_seoul_capture_scope(attempt_id,stream_kind,stream_key,entity_id)
       SELECT a.id,'membership',m.id,m.id FROM release_seoul_capture_attempts a JOIN memberships m ON m.email_id=a.entity_id WHERE a.id=? AND a.exclusion_reason IS NULL ORDER BY m.id COLLATE BINARY`);
      add(`INSERT INTO release_seoul_capture_scope(attempt_id,stream_kind,stream_key,entity_id)
       SELECT a.id,'credential',c.id,c.id FROM release_seoul_capture_attempts a JOIN credentials c ON c.email_id=a.entity_id AND c.kind='api_key' WHERE a.id=? AND a.exclusion_reason IS NULL ORDER BY c.id COLLATE BINARY`);
    }
    add(`INSERT INTO release_seoul_capture_spaces(attempt_id,space_id)
     SELECT a.id,scoped.id FROM release_seoul_capture_attempts a JOIN spaces scoped ON scoped.id IN (${spaces}) WHERE a.id=? AND a.exclusion_reason IS NULL AND ${selected} ORDER BY scoped.id COLLATE BINARY`);
    add(`UPDATE release_seoul_capture_scope AS k SET before_bytes=${effectiveState()} WHERE attempt_id=?`);
    const commandIndex = statements.length;
    statements.push(...commands);
    add(`UPDATE release_seoul_capture_attempts AS a SET accepted=CASE WHEN previously_present=0 AND ${kind==='scoped-key'
      ? "EXISTS(SELECT 1 FROM credentials c WHERE c.id=a.entity_id AND c.account_id=a.account_id AND c.kind IN ('personal_key','api_key'))"
      : "EXISTS(SELECT 1 FROM revocations r WHERE r.id=a.receipt_id AND r.kind='self' AND r.email_id=a.entity_id)"} THEN 1 ELSE 0 END WHERE id=?`);
    if (kind==='scoped-key') {
      this.estimates(add,attempt,kind);
      add(`UPDATE release_seoul_capture_attempts SET exclusion_reason=coalesce(exclusion_reason,CASE WHEN largest_source>131072 OR source_bytes>524288 THEN 'source-bytes' END) WHERE id=?`);
      this.validateSources(add,attempt,kind);
    }
    add(`UPDATE release_seoul_capture_scope AS k SET after_bytes=${effectiveState()} WHERE attempt_id=?
     AND EXISTS(SELECT 1 FROM release_seoul_capture_attempts a WHERE a.id=k.attempt_id AND a.accepted=1 AND a.exclusion_reason IS NULL)`);
    add(`INSERT INTO release_seoul_account_exclusions(account_id,reason,capture_attempt_id,count_lower_bound,byte_estimate,captured_at)
     SELECT account_id,exclusion_reason,id,min(2049,identity_count+membership_count+credential_count+space_count),max(identity_bytes,source_bytes),captured_at
     FROM release_seoul_capture_attempts a WHERE id=? AND accepted=1 AND exclusion_reason IS NOT NULL AND account_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM release_seoul_account_exclusions x WHERE x.account_id=a.account_id)`);
    add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
     SELECT a.id,'subject','${ISSUER}'||char(10)||anchor_subject,${UUID},
      json_object('version',3,'kind','subject-source-unrepresentable','issuer','${ISSUER}','subject',anchor_subject,'accountId',account_id,'reason',exclusion_reason,
       'countLowerBound',min(2049,identity_count+membership_count+credential_count+space_count),'byteEstimate',max(identity_bytes,source_bytes),'captureAttemptId',a.id),captured_at
     FROM release_seoul_capture_attempts a WHERE a.id=? AND accepted=1 AND exclusion_reason IS NOT NULL AND anchor_subject IS NOT NULL AND ${validId('account_id')}`);
    add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
     SELECT a.id,k.stream_kind,k.stream_key,${UUID},CASE WHEN k.stream_kind='email' THEN json_set(k.after_bytes,'$.changedClaim',json((SELECT json_object('id',e.id,'verifiedAtMs',e.verified_at,'revokedAtMs',e.revoked_at) FROM account_emails e WHERE e.id=k.prior_claim_id AND e.revoked_at IS NOT NULL))) ELSE k.after_bytes END,a.captured_at
     FROM release_seoul_capture_scope k JOIN release_seoul_capture_attempts a ON a.id=k.attempt_id
     WHERE a.id=? AND a.accepted=1 AND a.exclusion_reason IS NULL AND k.after_bytes IS NOT NULL AND k.before_bytes IS NOT k.after_bytes
     ORDER BY k.stream_kind COLLATE BINARY,k.stream_key COLLATE BINARY`);
    add(`INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision)
     SELECT s.space_id,(SELECT max(revision) FROM release_seoul_authority_changes WHERE source_command_id=s.attempt_id)
     FROM release_seoul_capture_spaces s JOIN release_seoul_capture_attempts a ON a.id=s.attempt_id
     WHERE s.attempt_id=? AND a.exclusion_reason IS NULL AND EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE source_command_id=s.attempt_id)
     ON CONFLICT(space_id) DO UPDATE SET dirty_revision=max(release_seoul_dirty_spaces.dirty_revision,excluded.dirty_revision)`);
    add('DELETE FROM release_seoul_capture_scope WHERE attempt_id=?');
    add('DELETE FROM release_seoul_capture_spaces WHERE attempt_id=?');
    add('DELETE FROM release_seoul_capture_attempts WHERE id=?');
    if(statements.length>100) throw new Error('seoul_capture_statement_limit');
    return {statements,commandIndex};
  }
  private validateEmailScope(add: (sql: string, values?: SqlValue[]) => number, attempt: string): void {
    // Match identity.canonicalEmail and the head codec on already-canonical
    // bytes; never trim, lowercase or reinterpret a retained address. Bound
    // the whole scalar before label splitting or constructing any stream key.
    add(`WITH RECURSIVE bounded AS (
      SELECT address FROM release_seoul_capture_attempts WHERE id=? AND exclusion_reason IS NULL
       AND typeof(address)='text' AND length(CAST(address AS BLOB)) BETWEEN 3 AND 254 AND instr(address,char(0))=0
     ), parts AS (SELECT address,substr(address,1,instr(address,'@')-1) local,substr(address,instr(address,'@')+1) domain FROM bounded),
     labels(label,remaining) AS (
      SELECT NULL,domain||'.' FROM parts
      UNION ALL SELECT substr(remaining,1,instr(remaining,'.')-1),substr(remaining,instr(remaining,'.')+1) FROM labels WHERE remaining<>''
     )
     UPDATE release_seoul_capture_attempts SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND NOT EXISTS(
      SELECT 1 FROM parts WHERE address=lower(trim(address)) AND instr(address,'@')>1 AND instr(domain,'@')=0
       AND length(local) BETWEEN 1 AND 64 AND local NOT GLOB '*[^a-z0-9!#$%&''*+/=?^_\`{|}~.-]*'
       AND substr(local,1,1)<>'.' AND substr(local,-1)<>'.' AND instr(local,'..')=0
       AND length(domain)<=253 AND instr(domain,'.')>0 AND domain NOT GLOB '*[^a-z0-9.-]*'
       AND NOT EXISTS(SELECT 1 FROM labels WHERE label IS NOT NULL AND (length(label) NOT BETWEEN 1 AND 63
        OR substr(label,1,1) NOT GLOB '[a-z0-9]' OR substr(label,-1) NOT GLOB '[a-z0-9]'))
     )`,[attempt,attempt]);
    // Add exact separator/UTF-8 lengths before copying a composite key. The
    // mapping probe already established a complete supported <=512-row set.
    add(`UPDATE release_seoul_capture_attempts AS a SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL
     AND EXISTS(SELECT 1 FROM provider_identities p WHERE p.account_id=a.account_id
      AND ${sqlBytes('p.issuer')}+1+${sqlBytes('p.subject')}+1+${sqlBytes('a.address')}>2048)`,[attempt]);
  }
  private validateSources(add: (sql: string, values?: SqlValue[]) => number, attempt: string, kind: 'scoped-key' | 'self-email-unlink'): void {
    const credentialRows = kind==='scoped-key' ? 'c.id=a.entity_id' : "c.email_id=a.entity_id AND c.kind='api_key'";
    // This statement runs only after row counts and raw byte estimates fit.
    // json_each therefore never parses unbounded retained policy input. Null
    // policy is retained as null; a later positive builder must reject it.
    add(`UPDATE release_seoul_capture_attempts AS a SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND (
     EXISTS(SELECT 1 FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${credentialRows} AND (
      NOT ${validId('c.id')} OR NOT ${validId('c.account_id')} OR (c.membership_id IS NOT NULL AND NOT ${validId('c.membership_id')})
      OR (c.email_id IS NOT NULL AND NOT ${validId('c.email_id')}) OR NOT ${validTime('c.expires_at')} OR NOT ${validNullableTime('c.revoked_at')}
      OR (p.credential_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM json_each(p.capabilities))
       OR EXISTS(SELECT 1 FROM json_each(p.capabilities) j WHERE j.type<>'text' OR j.value NOT IN ('read','create','update','delete','export'))
       OR (p.space_ids IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM json_each(p.space_ids)) OR EXISTS(SELECT 1 FROM json_each(p.space_ids) j WHERE j.type<>'text' OR NOT ${validId('j.value')})))))))
     OR (command_kind='self-email-unlink' AND (
      EXISTS(SELECT 1 FROM memberships m WHERE m.email_id=a.entity_id AND (NOT ${validId('m.id')} OR NOT ${validId('m.account_id')} OR NOT ${validId('m.organization_id')} OR NOT ${validId('m.email_id')} OR NOT ${validTime('m.expires_at')} OR NOT ${validNullableTime('m.revoked_at')}))
      OR EXISTS(SELECT 1 FROM account_emails e WHERE (e.id=a.entity_id OR e.id=(SELECT live.id FROM account_emails live WHERE live.address=a.address AND live.revoked_at IS NULL)) AND e.account_id=a.account_id AND (NOT ${validId('e.id')} OR NOT ${validTime('e.verified_at')} OR NOT ${validNullableTime('e.revoked_at')}))
      OR EXISTS(SELECT 1 FROM provider_identities p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND l.address=a.address WHERE p.account_id=a.account_id AND (NOT ${validId('l.event_id')} OR NOT ${validTime('l.sequence')} OR NOT ${validTime('l.occurred_at')}))
     )))`,[attempt]);
  }
  private estimates(add: (sql: string, values?: SqlValue[]) => number, attempt: string, kind: 'scoped-key' | 'self-email-unlink'): void {
    const credentialRows = kind==='scoped-key' ? 'c.id=a.entity_id' : "c.email_id=a.entity_id AND c.kind='api_key'";
    // Length arithmetic precedes json_each/json_object; excluded scope never
    // constructs normal records. All scalar-row scans are account/email indexed
    // and capped before aggregate estimates. Padding includes changedClaim.
    add(`UPDATE release_seoul_capture_attempts AS a SET source_bytes=CASE WHEN exclusion_reason IS NULL THEN
      coalesce((SELECT sum(cost) FROM (SELECT ${credentialCost} cost FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${credentialRows} LIMIT 513)),0)
      + CASE WHEN command_kind='self-email-unlink' THEN coalesce((SELECT sum(cost) FROM (SELECT ${membershipCost} cost FROM memberships m WHERE m.email_id=a.entity_id LIMIT 513)),0)
      + identity_count*(4096+${scalarCost('a.account_id','a.entity_id','a.address')}+coalesce((SELECT max(6*length(CAST(p.subject AS BLOB))) FROM provider_identities p WHERE p.account_id=a.account_id),0)) ELSE 0 END ELSE 0 END,
     largest_source=CASE WHEN exclusion_reason IS NULL THEN max(
      coalesce((SELECT max(cost) FROM (SELECT ${credentialCost} cost FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${credentialRows} LIMIT 513)),0),
      CASE WHEN command_kind='self-email-unlink' THEN max(coalesce((SELECT max(cost) FROM (SELECT ${membershipCost} cost FROM memberships m WHERE m.email_id=a.entity_id LIMIT 513)),0),
      4096+${scalarCost('a.account_id','a.entity_id','a.address')}+coalesce((SELECT max(6*length(CAST(p.subject AS BLOB))) FROM provider_identities p WHERE p.account_id=a.account_id),0)) ELSE 0 END) ELSE 0 END WHERE a.id=?`,[attempt]);
  }
}

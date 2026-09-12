import type { Database, Statement, Value } from './types.ts';

export type BootstrapScope = {
  commandType: 'workspace-sign-in'; receiptId: string; issuer: string; subject: string;
  newAccountId: string; credentialId: string; emailId: string; address: string | null; spaceId: string;
} | {
  commandType: 'organization-create' | 'organization-child-create'; receiptId: string;
  emailId: string; membershipId: string; spaceId: string;
};
const ISSUER='https://auth-api.allen.company';
const bytes=(v:string)=>`coalesce(length(CAST(${v} AS BLOB)),0)`;
const cost=(...v:string[])=>`6*(${v.map(bytes).join('+')})`;
const validId=(v:string)=>`(typeof(${v})='text' AND length(${v}) BETWEEN 1 AND 256 AND substr(${v},1,1) GLOB '[A-Za-z0-9]' AND ${v} NOT GLOB '*[^A-Za-z0-9._:-]*')`;
const validTime=(v:string)=>`(typeof(${v})='integer' AND ${v} BETWEEN 0 AND 9007199254740991)`;
const positions='positions(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM positions WHERE n<512)';
const whitespace='char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279)';
const validSubject=(p:string)=>`(typeof(${p}.subject)='text' AND length(${p}.subject) BETWEEN 1 AND 512 AND instr(${p}.subject,char(0))=0 AND length(trim(${p}.subject,${whitespace}))>0
 AND (SELECT sum(CASE WHEN unicode(substr(${p}.subject,n,1))>65535 THEN 2 ELSE 1 END) FROM positions WHERE n<=length(${p}.subject))<=512
 AND NOT EXISTS(SELECT 1 FROM positions WHERE n<=length(${p}.subject) AND (unicode(substr(${p}.subject,n,1)) BETWEEN 55296 AND 57343 OR hex(CAST(char(unicode(substr(${p}.subject,n,1))) AS BLOB))<>hex(CAST(substr(${p}.subject,n,1) AS BLOB)))))`;
const uuid=`lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))`;
// The additive staging guard admits one transient command per atomic batch.
// These joins always start with that attempt and exact indexed account scope.
const identities=`SELECT a.id attempt_id,p.issuer,p.subject,p.account_id,p.created_at FROM release_seoul_bootstrap_attempts a JOIN provider_identities p ON p.account_id=a.account_id
 UNION ALL SELECT a.id,a.issuer,a.subject,a.account_id,a.captured_at FROM release_seoul_bootstrap_attempts a WHERE a.command_kind='workspace-sign-in' AND a.mapping_before=0`;
const oldSpaces=`SELECT a.id attempt_id,s.id,'mapping' dependency FROM release_seoul_bootstrap_attempts a JOIN spaces s ON s.account_id=a.account_id
 UNION ALL SELECT a.id,s.id,'claim' dependency FROM release_seoul_bootstrap_attempts a JOIN account_emails e ON e.account_id=a.account_id AND e.address=a.address JOIN memberships m ON m.email_id=e.id JOIN spaces s ON s.organization_id=m.organization_id`;

function state():string {
  return `CASE k.stream_kind
   WHEN 'subject' THEN (SELECT json_object('version',3,'kind','subject-source','issuer',k.issuer,'subject',k.subject,'accountId',p.account_id,
    'accountDisabledAtMs',(SELECT disabled_at FROM accounts WHERE id=p.account_id),
    'providerIdentities',json((SELECT json_group_array(json_object('issuer',ordered.issuer,'subject',ordered.subject,'accountId',ordered.account_id,'createdAtMs',ordered.created_at)) FROM (
      SELECT i.* FROM provider_identities i JOIN release_seoul_bootstrap_scope sorted ON sorted.attempt_id=k.attempt_id AND sorted.stream_kind='subject' AND sorted.issuer=i.issuer AND sorted.subject=i.subject
      WHERE i.account_id=p.account_id ORDER BY sorted.subject_sort_key COLLATE BINARY) ordered)),
    'lifecycle',json(coalesce((SELECT json_object('state','event','eventId',l.event_id,'sequence',l.sequence,'kind',l.kind,'occurredAtMs',l.occurred_at) FROM release_identity_lifecycle_state l WHERE l.issuer=k.issuer AND l.subject=k.subject AND l.address=''),'{"state":"absent"}')),
    'legacyDisabled',json(CASE WHEN EXISTS(SELECT 1 FROM release_provider_revocations r WHERE r.issuer=k.issuer AND r.subject=k.subject AND r.kind='account.disabled') THEN 'true' ELSE 'false' END))
    FROM release_seoul_bootstrap_attempts a LEFT JOIN provider_identities p ON p.issuer=k.issuer AND p.subject=k.subject WHERE a.id=k.attempt_id)
   WHEN 'email' THEN (SELECT json_object('version',3,'kind','email-source','issuer',k.issuer,'subject',k.subject,'address',k.address,'accountId',p.account_id,
    'liveClaim',json((SELECT json_object('id',e.id,'verifiedAtMs',e.verified_at) FROM account_emails e WHERE e.account_id=p.account_id AND e.address=k.address AND e.revoked_at IS NULL)),
    'changedClaim',NULL,'addressBlocked',json(CASE WHEN EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=k.address) OR EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=p.account_id AND b.address=k.address) THEN 'true' ELSE 'false' END),
    'legacyRevoked',json(CASE WHEN EXISTS(SELECT 1 FROM release_provider_revocations r WHERE r.issuer=k.issuer AND r.subject=k.subject AND r.kind='email.revoked' AND r.address=k.address) THEN 'true' ELSE 'false' END),
    'lifecycle',json(coalesce((SELECT json_object('state','event','eventId',l.event_id,'sequence',l.sequence,'kind',l.kind,'occurredAtMs',l.occurred_at) FROM release_identity_lifecycle_state l WHERE l.issuer=k.issuer AND l.subject=k.subject AND l.address=k.address),'{"state":"absent"}')))
    FROM release_seoul_bootstrap_attempts a LEFT JOIN provider_identities p ON p.issuer=k.issuer AND p.subject=k.subject WHERE a.id=k.attempt_id)
   WHEN 'organization' THEN (SELECT json_object('version',3,'kind','organization-source','id',o.id,'disabledAtMs',o.disabled_at) FROM organizations o WHERE o.id=k.entity_id)
   WHEN 'membership' THEN (SELECT json_object('version',3,'kind','membership-source','id',m.id,'organizationId',m.organization_id,'accountId',m.account_id,'emailId',m.email_id,'role',m.role,'expiresAtMs',m.expires_at,'revokedAtMs',m.revoked_at) FROM memberships m JOIN release_seoul_bootstrap_attempts a ON a.id=k.attempt_id WHERE m.id=k.entity_id AND m.account_id=a.account_id AND m.organization_id=a.organization_id AND m.email_id=a.email_id)
   WHEN 'space' THEN (SELECT json_object('version',3,'kind','space-source','id',s.id,'accountId',s.account_id,'organizationId',s.organization_id,'securityMode',s.security_mode,'createdAtMs',s.created_at) FROM spaces s JOIN release_seoul_bootstrap_attempts a ON a.id=k.attempt_id WHERE s.id=k.entity_id AND ((a.command_kind='workspace-sign-in' AND s.account_id=a.account_id AND s.organization_id IS NULL) OR (a.command_kind<>'workspace-sign-in' AND s.organization_id=a.organization_id AND s.account_id IS NULL)))
   END`;
}

/** Trusted capture delegation only: no runtime injection or RPC split. */
export function bootstrapStatements(database:Database, scope:BootstrapScope, command:Statement):{statements:Statement[];commandIndex:number} {
  const attempt=crypto.randomUUID(), statements:Statement[]=[];
  const add=(sql:string,values:Value[]=[attempt])=>statements.push(database.prepare(sql).bind(...values));
  const signIn=scope.commandType==='workspace-sign-in';
  if(signIn){
    add(`INSERT INTO release_seoul_bootstrap_attempts(id,command_kind,receipt_id,account_id,candidate_account_id,issuer,subject,address,email_id,credential_id,space_id)
     VALUES(?,'workspace-sign-in',?,coalesce((SELECT account_id FROM provider_identities WHERE issuer=? AND subject=?),?),?,?,?,?,?,?,?)`,
     [attempt,scope.receiptId,scope.issuer,scope.subject,scope.newAccountId,scope.newAccountId,scope.issuer,scope.subject,scope.address,scope.emailId,scope.credentialId,scope.spaceId]);
  } else {
    add(`INSERT INTO release_seoul_bootstrap_attempts(id,command_kind,receipt_id,account_id,email_id,membership_id,space_id,organization_id)
     VALUES(?,?,?,(SELECT account_id FROM account_emails WHERE id=?),?,?,?,?)`,[attempt,scope.commandType,scope.receiptId,scope.emailId,scope.emailId,scope.membershipId,scope.spaceId,scope.receiptId]);
  }
  add(`UPDATE release_seoul_bootstrap_attempts AS a SET
   receipt_before=${signIn?'EXISTS(SELECT 1 FROM workspace_sign_ins WHERE id=a.receipt_id)':scope.commandType==='organization-create'?'EXISTS(SELECT 1 FROM workspace_organization_creations WHERE id=a.receipt_id)':'EXISTS(SELECT 1 FROM workspace_child_organization_creations WHERE id=a.receipt_id)'},
   account_before=EXISTS(SELECT 1 FROM accounts WHERE id=a.candidate_account_id),mapping_before=EXISTS(SELECT 1 FROM provider_identities WHERE issuer=a.issuer AND subject=a.subject),
   email_before=EXISTS(SELECT 1 FROM account_emails WHERE id=a.email_id),credential_before=EXISTS(SELECT 1 FROM credentials WHERE id=a.credential_id),
   space_before=EXISTS(SELECT 1 FROM spaces WHERE id=a.space_id),organization_before=EXISTS(SELECT 1 FROM organizations WHERE id=a.organization_id),membership_before=EXISTS(SELECT 1 FROM memberships WHERE id=a.membership_id) WHERE id=?`);
  add(`WITH RECURSIVE ${positions}, bounded AS (SELECT p.* FROM (${identities}) p WHERE p.attempt_id=? LIMIT 513)
   UPDATE release_seoul_bootstrap_attempts AS a SET identity_count=(SELECT count(*) FROM bounded),identity_bytes=coalesce((SELECT sum(256+${cost('p.issuer','p.subject','p.account_id')}) FROM bounded p),0),
    anchor_subject=(SELECT p.subject FROM (SELECT i.* FROM (${identities}) i WHERE i.attempt_id=a.id AND i.issuer='${ISSUER}' LIMIT 513) p WHERE ${validSubject('p')} ORDER BY p.subject COLLATE BINARY LIMIT 1),
    exclusion_reason=CASE WHEN NOT ${validId('a.account_id')} THEN 'unsupported-state' WHEN NOT EXISTS(SELECT 1 FROM bounded) THEN 'unmapped'
     WHEN (SELECT count(*) FROM bounded)>512 THEN 'identity-count'
     WHEN EXISTS(SELECT 1 FROM bounded p WHERE p.issuer<>'${ISSUER}' OR NOT ${validSubject('p')} OR NOT ${validTime('p.created_at')}) THEN 'unsupported-mapping'
     ELSE (SELECT reason FROM release_seoul_account_exclusions x WHERE x.account_id=a.account_id) END WHERE a.id=?`,[attempt,attempt]);
  add(`UPDATE release_seoul_bootstrap_attempts AS a SET source_count=CASE WHEN command_kind='workspace-sign-in' THEN identity_count*(CASE WHEN address IS NULL THEN 1 ELSE 2 END)+1 ELSE 3 END,
   claim_count=CASE WHEN exclusion_reason IS NULL AND command_kind='workspace-sign-in' AND address IS NOT NULL THEN (SELECT count(*) FROM (SELECT id FROM account_emails e WHERE e.account_id=a.account_id AND e.address=a.address LIMIT 513)) ELSE 0 END WHERE id=?`);
  add(`UPDATE release_seoul_bootstrap_attempts SET exclusion_reason=coalesce(exclusion_reason,CASE WHEN identity_bytes+8192>131072 THEN 'identity-bytes' WHEN source_count>512 OR claim_count>512 THEN 'fanout-count' END) WHERE id=?`);
  add(`UPDATE release_seoul_bootstrap_attempts AS a SET membership_count=CASE WHEN exclusion_reason IS NULL AND command_kind='workspace-sign-in' THEN (SELECT count(*) FROM (SELECT m.id FROM account_emails e JOIN memberships m ON m.email_id=e.id WHERE e.account_id=a.account_id AND e.address=a.address LIMIT 513)) ELSE 0 END WHERE id=?`);
  add(`UPDATE release_seoul_bootstrap_attempts SET exclusion_reason=coalesce(exclusion_reason,CASE WHEN membership_count>512 THEN 'fanout-count' END) WHERE id=?`);
  if(signIn){
    add(`UPDATE release_seoul_bootstrap_attempts AS a SET space_count=CASE WHEN exclusion_reason IS NULL THEN (SELECT count(*) FROM (SELECT DISTINCT s.id FROM (${oldSpaces}) s WHERE s.attempt_id=a.id LIMIT 513)) ELSE 0 END WHERE id=?`);
    add(`UPDATE release_seoul_bootstrap_attempts AS a SET exclusion_reason=CASE WHEN space_count>512 THEN 'fanout-count' WHEN EXISTS(SELECT 1 FROM (${oldSpaces}) s WHERE s.attempt_id=a.id AND (length(s.id)>128 OR NOT ${validId('s.id')})) THEN 'unsupported-state' END WHERE id=? AND exclusion_reason IS NULL`);
  }
  // Include repeated full identity arrays and all potential email rows, not
  // merely one individually bounded aggregate. Padding includes origin/effect.
  add(`UPDATE release_seoul_bootstrap_attempts AS a SET largest_source=CASE WHEN command_kind='workspace-sign-in' THEN 2*identity_bytes+8192+${cost('a.account_id','a.address')} ELSE 8192 END,
   source_bytes=CASE WHEN command_kind='workspace-sign-in' THEN source_count*(2*identity_bytes+8192+${cost('a.account_id','a.address')}) ELSE 24576 END WHERE id=?`);
  add(`UPDATE release_seoul_bootstrap_attempts SET exclusion_reason=coalesce(exclusion_reason,CASE WHEN largest_source>131072 OR source_bytes>524288 THEN 'source-bytes' END) WHERE id=?`);
  add(`UPDATE release_seoul_bootstrap_attempts AS a SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND (
   NOT ${validId('a.email_id')} OR NOT ${validId('a.space_id')} OR length(a.space_id)>128
   OR EXISTS(SELECT 1 FROM accounts x WHERE x.id=a.account_id AND x.disabled_at IS NOT NULL AND NOT ${validTime('x.disabled_at')})
   OR EXISTS(SELECT 1 FROM (${identities}) p JOIN release_identity_lifecycle_state l ON l.issuer=p.issuer AND l.subject=p.subject AND (l.address='' OR l.address=a.address) WHERE p.attempt_id=a.id AND (NOT ${validId('l.event_id')} OR NOT ${validTime('l.sequence')} OR NOT ${validTime('l.occurred_at')}))
   OR EXISTS(SELECT 1 FROM account_emails e WHERE e.address=a.address AND e.revoked_at IS NULL AND e.account_id=a.account_id AND (NOT ${validId('e.id')} OR NOT ${validTime('e.verified_at')}))
  )`);
  if(signIn){
    // The service supplies canonicalEmail's exact output, never request text.
    // Scalar checks still precede any concatenation of the full composite key.
    add(`UPDATE release_seoul_bootstrap_attempts AS a SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND address IS NOT NULL
     AND (length(CAST(address AS BLOB))>254 OR instr(address,char(0))>0 OR address<>lower(trim(address))
      OR EXISTS(SELECT 1 FROM (${identities}) p WHERE p.attempt_id=a.id AND ${bytes('p.issuer')}+1+${bytes('p.subject')}+1+${bytes('a.address')}>2048))`);
    add(`WITH RECURSIVE ${positions}
     INSERT INTO release_seoul_bootstrap_scope(attempt_id,stream_kind,stream_key,issuer,subject,subject_sort_key)
     SELECT a.id,'subject',p.issuer||char(10)||p.subject,p.issuer,p.subject,
      (SELECT group_concat(unit,'') FROM (SELECT CASE WHEN unicode(substr(p.subject,n,1))>65535
        THEN printf('%04X%04X',55296+((unicode(substr(p.subject,n,1))-65536)>>10),56320+((unicode(substr(p.subject,n,1))-65536)&1023))
        ELSE printf('%04X',unicode(substr(p.subject,n,1))) END unit FROM positions WHERE n<=length(p.subject) ORDER BY n))
     FROM release_seoul_bootstrap_attempts a JOIN (${identities}) p ON p.attempt_id=a.id WHERE a.id=? AND a.exclusion_reason IS NULL`);
    add(`INSERT INTO release_seoul_bootstrap_scope(attempt_id,stream_kind,stream_key,issuer,subject,address,subject_sort_key)
     SELECT k.attempt_id,'email',k.stream_key||char(10)||a.address,k.issuer,k.subject,a.address,k.subject_sort_key FROM release_seoul_bootstrap_scope k JOIN release_seoul_bootstrap_attempts a ON a.id=k.attempt_id
     WHERE a.id=? AND a.exclusion_reason IS NULL AND a.address IS NOT NULL AND k.stream_kind='subject'`);
    add(`INSERT INTO release_seoul_bootstrap_spaces(attempt_id,space_id,dependency)
     SELECT DISTINCT a.id,s.id,s.dependency FROM release_seoul_bootstrap_attempts a JOIN (${oldSpaces}) s ON s.attempt_id=a.id WHERE a.id=? AND a.exclusion_reason IS NULL
      AND (EXISTS(SELECT 1 FROM release_seoul_targets t WHERE t.space_id=s.id AND t.selected=1) OR EXISTS(SELECT 1 FROM release_seoul_dirty_spaces d WHERE d.space_id=s.id))`);
  } else {
    add(`INSERT INTO release_seoul_bootstrap_scope(attempt_id,stream_kind,stream_key,entity_id) SELECT id,'organization',organization_id,organization_id FROM release_seoul_bootstrap_attempts WHERE id=? AND exclusion_reason IS NULL`);
    add(`INSERT INTO release_seoul_bootstrap_scope(attempt_id,stream_kind,stream_key,entity_id) SELECT id,'membership',membership_id,membership_id FROM release_seoul_bootstrap_attempts WHERE id=? AND exclusion_reason IS NULL`);
  }
  add(`INSERT INTO release_seoul_bootstrap_scope(attempt_id,stream_kind,stream_key,entity_id) SELECT id,'space',space_id,space_id FROM release_seoul_bootstrap_attempts WHERE id=? AND exclusion_reason IS NULL`);
  add(`UPDATE release_seoul_bootstrap_scope AS k SET before_bytes=${state()} WHERE attempt_id=?`);
  const commandIndex=statements.length;statements.push(command);
  add(`UPDATE release_seoul_bootstrap_attempts AS a SET accepted=CASE WHEN receipt_before=0 AND ${signIn?
    'EXISTS(SELECT 1 FROM workspace_sign_ins r WHERE r.id=a.receipt_id AND r.issuer=a.issuer AND r.subject=a.subject AND r.new_account_id=a.candidate_account_id AND r.credential_id=a.credential_id AND r.email_id=a.email_id AND r.personal_space_id=a.space_id)':
    `EXISTS(SELECT 1 FROM ${scope.commandType==='organization-create'?'workspace_organization_creations':'workspace_child_organization_creations'} r WHERE r.id=a.receipt_id AND r.email_id=a.email_id AND r.membership_id=a.membership_id AND r.space_id=a.space_id)`} THEN 1 ELSE 0 END WHERE id=?`);
  add(`UPDATE release_seoul_bootstrap_attempts AS a SET
   mapping_created=CASE WHEN accepted=1 AND command_kind='workspace-sign-in' AND mapping_before=0 AND account_before=0 AND EXISTS(SELECT 1 FROM provider_identities p WHERE p.issuer=a.issuer AND p.subject=a.subject AND p.account_id=a.candidate_account_id) THEN 1 ELSE 0 END,
   email_created=CASE WHEN accepted=1 AND command_kind='workspace-sign-in' AND email_before=0 AND EXISTS(SELECT 1 FROM account_emails e WHERE e.id=a.email_id AND e.account_id=a.account_id AND e.address=a.address) THEN 1 ELSE 0 END,
   space_created=CASE WHEN accepted=1 AND space_before=0 AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=a.space_id AND ((command_kind='workspace-sign-in' AND s.account_id=a.account_id AND s.organization_id IS NULL) OR (command_kind<>'workspace-sign-in' AND s.organization_id=a.organization_id AND s.account_id IS NULL))) THEN 1 ELSE 0 END WHERE id=?`);
  add(`UPDATE release_seoul_bootstrap_scope AS k SET after_bytes=${state()} WHERE attempt_id=? AND EXISTS(SELECT 1 FROM release_seoul_bootstrap_attempts a WHERE a.id=k.attempt_id AND a.accepted=1 AND a.exclusion_reason IS NULL)`);
  const changed=`(a.command_kind<>'workspace-sign-in' OR a.mapping_created=1 OR a.email_created=1 OR a.space_created=1)`;
  add(`INSERT INTO release_seoul_account_exclusions(account_id,reason,capture_attempt_id,count_lower_bound,byte_estimate,captured_at)
   SELECT account_id,exclusion_reason,id,min(2049,identity_count+claim_count+membership_count+space_count),max(identity_bytes,source_bytes),captured_at FROM release_seoul_bootstrap_attempts a
   WHERE id=? AND accepted=1 AND ${changed} AND exclusion_reason IS NOT NULL AND EXISTS(SELECT 1 FROM accounts WHERE id=a.account_id) AND NOT EXISTS(SELECT 1 FROM release_seoul_account_exclusions x WHERE x.account_id=a.account_id)`);
  add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
   SELECT a.id,'subject','${ISSUER}'||char(10)||anchor_subject,${uuid},json_object('version',3,'kind','subject-source-unrepresentable','issuer','${ISSUER}','subject',anchor_subject,'accountId',account_id,'reason',exclusion_reason,
    'countLowerBound',min(2049,identity_count+claim_count+membership_count+space_count),'byteEstimate',max(identity_bytes,source_bytes),'captureAttemptId',a.id),captured_at
   FROM release_seoul_bootstrap_attempts a WHERE id=? AND accepted=1 AND ${changed} AND exclusion_reason IS NOT NULL AND anchor_subject IS NOT NULL AND ${validId('account_id')}`);
  add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
   SELECT a.id,k.stream_kind,k.stream_key,${uuid},json_set(k.after_bytes,'$.origin',json_object('kind','command','commandType',a.command_kind,'receiptId',a.receipt_id),
    '$.effect',json_object('type','entity-head','disposition',CASE WHEN k.stream_kind IN ('subject','email') THEN 'changed' ELSE 'present' END)),a.captured_at
   FROM release_seoul_bootstrap_scope k JOIN release_seoul_bootstrap_attempts a ON a.id=k.attempt_id WHERE a.id=? AND a.accepted=1 AND a.exclusion_reason IS NULL
    AND k.after_bytes IS NOT NULL AND k.before_bytes IS NOT k.after_bytes AND (k.stream_kind<>'email' OR a.email_created=1) AND (k.stream_kind<>'space' OR a.space_created=1)
   ORDER BY k.stream_kind COLLATE BINARY,k.subject_sort_key COLLATE BINARY,k.stream_key COLLATE BINARY`);
  add(`INSERT INTO release_seoul_bootstrap_spaces(attempt_id,space_id,dependency) SELECT id,space_id,'new' FROM release_seoul_bootstrap_attempts WHERE id=? AND accepted=1 AND exclusion_reason IS NULL AND space_created=1`);
  add(`INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision)
   SELECT DISTINCT s.space_id,(SELECT max(revision) FROM release_seoul_authority_changes WHERE source_command_id=a.id) FROM release_seoul_bootstrap_spaces s JOIN release_seoul_bootstrap_attempts a ON a.id=s.attempt_id
   WHERE a.id=? AND a.exclusion_reason IS NULL AND EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE source_command_id=a.id)
    AND (s.dependency='new' OR (s.dependency='mapping' AND a.mapping_created=1) OR (s.dependency='claim' AND a.email_created=1))
   ON CONFLICT(space_id) DO UPDATE SET dirty_revision=max(release_seoul_dirty_spaces.dirty_revision,excluded.dirty_revision)`);
  add('DELETE FROM release_seoul_bootstrap_scope WHERE attempt_id=?');add('DELETE FROM release_seoul_bootstrap_spaces WHERE attempt_id=?');add('DELETE FROM release_seoul_bootstrap_attempts WHERE id=?');
  if(statements.length>100)throw new Error('seoul_capture_statement_limit');
  return {statements,commandIndex};
}

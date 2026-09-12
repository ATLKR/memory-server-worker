import type { Database, Statement, Value } from './types.ts';

export type WorkspaceCaptureScope = {
  commandType: 'invite-accept' | 'membership-revoke' | 'workspace-key-issue' | 'workspace-key-revoke';
  receiptId: string; entityId: string; actorDigest: string; commandAt: number;
  invitationDigest?: string; organizationId?: string | null;
};
const ISSUER='https://auth-api.allen.company';
const bytes=(v:string)=>`coalesce(length(CAST(${v} AS BLOB)),0)`;
const cost=(...v:string[])=>`6*(${v.map(bytes).join('+')})`;
const validId=(v:string)=>`(typeof(${v})='text' AND length(${v}) BETWEEN 1 AND 256 AND substr(${v},1,1) GLOB '[A-Za-z0-9]' AND ${v} NOT GLOB '*[^A-Za-z0-9._:-]*')`;
const time=(v:string)=>`(typeof(${v})='integer' AND ${v} BETWEEN 0 AND 9007199254740991)`;
const nullableTime=(v:string)=>`(${v} IS NULL OR ${time(v)})`;
const positions='positions(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM positions WHERE n<512)';
const whitespace='char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279)';
const subject=(p:string)=>`(typeof(${p}.subject)='text' AND length(${p}.subject) BETWEEN 1 AND 512 AND instr(${p}.subject,char(0))=0 AND length(trim(${p}.subject,${whitespace}))>0
 AND (SELECT sum(CASE WHEN unicode(substr(${p}.subject,n,1))>65535 THEN 2 ELSE 1 END) FROM positions WHERE n<=length(${p}.subject))<=512
 AND NOT EXISTS(SELECT 1 FROM positions WHERE n<=length(${p}.subject) AND (unicode(substr(${p}.subject,n,1)) BETWEEN 55296 AND 57343 OR hex(CAST(char(unicode(substr(${p}.subject,n,1))) AS BLOB))<>hex(CAST(substr(${p}.subject,n,1) AS BLOB)))))`;
const uuid=`lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))`;
const credentialCost=`4096+${cost('c.id','c.account_id','c.membership_id','c.email_id','p.capabilities','p.space_ids')}`;
const memberCost=`4096+${cost('m.id','m.account_id','m.email_id','m.organization_id')}`;
const policy=`(SELECT json_object('capabilities',json((SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(p.capabilities) ORDER BY value COLLATE BINARY))),
 'spaceIds',CASE WHEN p.space_ids IS NULL THEN NULL ELSE json((SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(p.space_ids) ORDER BY value COLLATE BINARY))) END) FROM release_credential_policies p WHERE p.credential_id=c.id)`;
function state():string {
  return `CASE k.stream_kind
   WHEN 'membership' THEN (SELECT json_object('version',3,'kind','membership-source','id',m.id,'organizationId',m.organization_id,'accountId',m.account_id,'emailId',m.email_id,'role',m.role,'expiresAtMs',m.expires_at,'revokedAtMs',m.revoked_at) FROM memberships m JOIN release_seoul_workspace_attempts a ON a.id=k.attempt_id WHERE m.id=k.entity_id AND m.account_id=a.account_id AND m.organization_id=a.organization_id AND m.email_id=a.email_id)
   WHEN 'credential' THEN (SELECT json_object('version',3,'kind','credential-source','id',c.id,'accountId',c.account_id,'credentialKind',c.kind,'tokenDigest',c.token_digest,'membershipId',c.membership_id,'emailId',c.email_id,'permission',c.permission,'expiresAtMs',c.expires_at,'revokedAtMs',c.revoked_at,'policy',json(${policy})) FROM credentials c JOIN release_seoul_workspace_attempts a ON a.id=k.attempt_id WHERE c.id=k.entity_id AND c.account_id=a.account_id AND c.kind IN ('personal_key','api_key') AND c.membership_id IS a.membership_id AND c.email_id IS a.email_id)
   END`;
}

/** Explicitly trusted same-database delegate. No RPC split or authority wrapper. */
export function workspaceStatements(database:Database, scope:WorkspaceCaptureScope, command:Statement):{statements:Statement[];commandIndex:number} {
  const attempt=crypto.randomUUID(),statements:Statement[]=[];
  const add=(sql:string,values:Value[]=[attempt])=>statements.push(database.prepare(sql).bind(...values));
  const invite=scope.commandType==='invite-accept',member=scope.commandType==='membership-revoke',issue=scope.commandType==='workspace-key-issue';
  const positive=invite||issue;
  const receiptTable=invite?'workspace_invitation_acceptances':member?'workspace_membership_revocations':issue?'workspace_key_issuances':'workspace_key_revocations';
  // Unconditional fresh attempt insertion activates the stale-staging guard,
  // even when the prospective authority lookup has no matching row.
  add(`INSERT INTO release_seoul_workspace_attempts(id,command_kind,receipt_id,entity_id,actor_id,invitation_id,organization_id,command_at)
   VALUES(?,?,?,?,(SELECT id FROM credentials WHERE token_digest=?),(SELECT id FROM workspace_invitations WHERE token_digest=?),?,?)`,
   [attempt,scope.commandType,scope.receiptId,scope.entityId,scope.actorDigest,scope.invitationDigest??null,scope.organizationId??null,scope.commandAt]);
  if(invite){
    add(`UPDATE release_seoul_workspace_attempts AS a SET account_id=(SELECT account_id FROM credentials WHERE id=a.actor_id),organization_id=(SELECT organization_id FROM workspace_invitations WHERE id=a.invitation_id) WHERE id=?`);
    add(`UPDATE release_seoul_workspace_attempts AS a SET membership_id=entity_id,email_id=(SELECT e.id FROM account_emails e JOIN workspace_invitations i ON i.address=e.address WHERE i.id=a.invitation_id AND e.account_id=a.account_id AND e.revoked_at IS NULL) WHERE id=?`);
  } else if(member){
    add(`UPDATE release_seoul_workspace_attempts AS a SET account_id=(SELECT account_id FROM memberships WHERE id=a.entity_id),organization_id=(SELECT organization_id FROM memberships WHERE id=a.entity_id),membership_id=entity_id,email_id=(SELECT email_id FROM memberships WHERE id=a.entity_id) WHERE id=?`);
  } else if(issue){
    add(`UPDATE release_seoul_workspace_attempts AS a SET account_id=(SELECT account_id FROM credentials WHERE id=a.actor_id) WHERE id=?`);
    add(`UPDATE release_seoul_workspace_attempts AS a SET membership_id=(SELECT m.id FROM active_memberships m WHERE m.account_id=a.account_id AND m.organization_id=a.organization_id AND m.expires_at>max(a.command_at,CAST(round(unixepoch('subsec')*1000) AS INTEGER))) WHERE id=?`);
    add(`UPDATE release_seoul_workspace_attempts AS a SET email_id=(SELECT email_id FROM memberships WHERE id=a.membership_id) WHERE id=?`);
  } else {
    add(`UPDATE release_seoul_workspace_attempts AS a SET account_id=(SELECT account_id FROM credentials WHERE id=a.entity_id),membership_id=(SELECT membership_id FROM credentials WHERE id=a.entity_id),email_id=(SELECT email_id FROM credentials WHERE id=a.entity_id),organization_id=(SELECT m.organization_id FROM credentials c JOIN memberships m ON m.id=c.membership_id WHERE c.id=a.entity_id) WHERE id=?`);
  }
  add(`UPDATE release_seoul_workspace_attempts AS a SET address=(SELECT address FROM account_emails WHERE id=a.email_id),receipt_before=EXISTS(SELECT 1 FROM ${receiptTable} WHERE id=a.receipt_id),entity_before=EXISTS(SELECT 1 FROM ${invite||member?'memberships':'credentials'} WHERE id=a.entity_id) WHERE id=?`);
  add(`WITH RECURSIVE ${positions}, bounded AS (SELECT p.* FROM provider_identities p JOIN release_seoul_workspace_attempts a ON a.account_id=p.account_id WHERE a.id=? LIMIT 513)
   UPDATE release_seoul_workspace_attempts AS a SET identity_count=(SELECT count(*) FROM bounded),identity_bytes=coalesce((SELECT sum(256+${cost('p.issuer','p.subject','p.account_id')}) FROM bounded p),0),
    anchor_subject=(SELECT p.subject FROM (SELECT p.* FROM provider_identities p WHERE p.account_id=a.account_id AND p.issuer='${ISSUER}' LIMIT 513) p WHERE ${subject('p')} ORDER BY p.subject COLLATE BINARY LIMIT 1),
    exclusion_reason=CASE WHEN NOT ${validId('a.account_id')} THEN 'unsupported-state' WHEN NOT EXISTS(SELECT 1 FROM bounded) THEN 'unmapped'
     WHEN (SELECT count(*) FROM bounded)>512 THEN 'identity-count' WHEN EXISTS(SELECT 1 FROM bounded p WHERE p.issuer<>'${ISSUER}' OR NOT ${subject('p')} OR NOT ${time('p.created_at')}) THEN 'unsupported-mapping'
     ELSE (SELECT reason FROM release_seoul_account_exclusions x WHERE x.account_id=a.account_id) END WHERE a.id=?`,[attempt,attempt]);
  const credentials=member?`c.membership_id=a.entity_id AND c.revoked_at IS NULL AND c.kind='api_key'`:`c.id=a.entity_id AND c.kind IN ('personal_key','api_key')`;
  add(`UPDATE release_seoul_workspace_attempts AS a SET credential_count=${invite?'0':issue?'1':`(SELECT count(*) FROM (SELECT id FROM credentials c WHERE ${credentials} LIMIT 513))`} WHERE id=?`);
  add(`UPDATE release_seoul_workspace_attempts AS a SET exclusion_reason=coalesce(exclusion_reason,CASE WHEN identity_bytes+4096>131072 THEN 'identity-bytes' WHEN identity_count+credential_count+${invite||member?1:0}>512 THEN 'fanout-count' END) WHERE id=?`);
  // Exactly one indexed personal or organization scope, no global OR scan or
  // materializing UNION. Raw count and ID validation precede policy/selection.
  const spaces=scope.organizationId===null&&issue?'SELECT s.id FROM spaces s WHERE s.account_id=a.account_id':
    invite||member||issue?'SELECT s.id FROM spaces s WHERE s.organization_id=a.organization_id':
    `SELECT s.id FROM spaces s WHERE s.account_id=a.account_id AND a.organization_id IS NULL UNION ALL SELECT s.id FROM spaces s WHERE s.organization_id=a.organization_id AND a.organization_id IS NOT NULL`;
  add(`UPDATE release_seoul_workspace_attempts AS a SET space_count=CASE WHEN exclusion_reason IS NULL THEN (SELECT count(*) FROM (${spaces} LIMIT 513)) ELSE 0 END WHERE id=?`);
  add(`UPDATE release_seoul_workspace_attempts AS a SET exclusion_reason=CASE WHEN space_count>512 THEN 'fanout-count' WHEN EXISTS(SELECT 1 FROM (${spaces}) s WHERE length(s.id)>128 OR NOT ${validId('s.id')}) THEN 'unsupported-state' END WHERE id=? AND exclusion_reason IS NULL`);
  const estimates=()=>{
    const estimate=invite?'8192':issue?`8192+${cost('a.account_id','a.membership_id','a.email_id')}`:
      `coalesce((SELECT sum(${credentialCost}) FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${member?'c.membership_id=a.entity_id AND c.kind=\'api_key\' AND c.revoked_at IS NULL':credentials}),0)${member?`+coalesce((SELECT ${memberCost} FROM memberships m WHERE m.id=a.entity_id),0)`:''}`;
    const largest=positive?estimate:`max(coalesce((SELECT max(${credentialCost}) FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${credentials}),0),${member?`coalesce((SELECT ${memberCost} FROM memberships m WHERE m.id=a.entity_id),0)`:'0'})`;
    add(`UPDATE release_seoul_workspace_attempts AS a SET source_bytes=${estimate},largest_source=${largest} WHERE id=? AND exclusion_reason IS NULL`);
    add(`UPDATE release_seoul_workspace_attempts SET exclusion_reason=CASE WHEN source_bytes>524288 OR largest_source>131072 THEN 'source-bytes' END WHERE id=? AND exclusion_reason IS NULL`);
  };
  estimates();
  // Validate retained scalars and policy only after count/raw byte bounds.
  add(`UPDATE release_seoul_workspace_attempts AS a SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND (
   NOT ${validId('a.entity_id')} OR (a.organization_id IS NOT NULL AND NOT ${validId('a.organization_id')}) OR (a.email_id IS NOT NULL AND NOT ${validId('a.email_id')})
   OR EXISTS(SELECT 1 FROM memberships m WHERE m.id=a.membership_id AND (NOT ${validId('m.id')} OR NOT ${validId('m.organization_id')} OR NOT ${validId('m.account_id')} OR NOT ${validId('m.email_id')} OR NOT ${time('m.expires_at')} OR NOT ${nullableTime('m.revoked_at')}))
   OR EXISTS(SELECT 1 FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${credentials} AND (
    NOT ${validId('c.id')} OR NOT ${validId('c.account_id')} OR NOT ${time('c.expires_at')} OR NOT ${nullableTime('c.revoked_at')}
    OR (c.membership_id IS NOT NULL AND NOT ${validId('c.membership_id')}) OR (c.email_id IS NOT NULL AND NOT ${validId('c.email_id')})
    OR (p.credential_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM json_each(p.capabilities)) OR EXISTS(SELECT 1 FROM json_each(p.capabilities) j WHERE j.type<>'text' OR j.value NOT IN ('create','delete','export','read','update'))
     OR (p.space_ids IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM json_each(p.space_ids)) OR (SELECT count(DISTINCT value) FROM json_each(p.space_ids))>50 OR EXISTS(SELECT 1 FROM json_each(p.space_ids) j WHERE j.type<>'text' OR NOT ${validId('j.value')} OR length(j.value)>128)))))))
  )`);
  // A bound exact claim address is checked without normalizing it, even though
  // these commands emit member/key sources rather than synthetic email heads.
  add(`WITH RECURSIVE bounded AS (SELECT address FROM release_seoul_workspace_attempts WHERE id=? AND exclusion_reason IS NULL AND email_id IS NOT NULL AND length(CAST(address AS BLOB)) BETWEEN 3 AND 254 AND instr(address,char(0))=0),
   parts AS (SELECT address,substr(address,1,instr(address,'@')-1) local,substr(address,instr(address,'@')+1) domain FROM bounded),
   labels(label,remaining) AS (SELECT NULL,domain||'.' FROM parts UNION ALL SELECT substr(remaining,1,instr(remaining,'.')-1),substr(remaining,instr(remaining,'.')+1) FROM labels WHERE remaining<>'')
   UPDATE release_seoul_workspace_attempts SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND email_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM parts WHERE address=lower(trim(address)) AND instr(address,'@')>1 AND instr(domain,'@')=0 AND length(local) BETWEEN 1 AND 64
     AND local NOT GLOB '*[^a-z0-9!#$%&''*+/=?^_\`{|}~.-]*' AND substr(local,1,1)<>'.' AND substr(local,-1)<>'.' AND instr(local,'..')=0 AND length(domain)<=253 AND instr(domain,'.')>0 AND domain NOT GLOB '*[^a-z0-9.-]*'
     AND NOT EXISTS(SELECT 1 FROM labels WHERE label IS NOT NULL AND (length(label) NOT BETWEEN 1 AND 63 OR substr(label,1,1) NOT GLOB '[a-z0-9]' OR substr(label,-1) NOT GLOB '[a-z0-9]'))
   )`,[attempt,attempt]);
  add(`UPDATE release_seoul_workspace_attempts AS a SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND email_id IS NOT NULL AND EXISTS(SELECT 1 FROM provider_identities p WHERE p.account_id=a.account_id AND ${bytes('p.issuer')}+1+${bytes('p.subject')}+1+${bytes('a.address')}>2048)`);
  if(invite||member)add(`INSERT INTO release_seoul_workspace_scope(attempt_id,stream_kind,entity_id) SELECT id,'membership',entity_id FROM release_seoul_workspace_attempts WHERE id=? AND exclusion_reason IS NULL`);
  if(issue)add(`INSERT INTO release_seoul_workspace_scope(attempt_id,stream_kind,entity_id) SELECT id,'credential',entity_id FROM release_seoul_workspace_attempts WHERE id=? AND exclusion_reason IS NULL`);
  if(!positive)add(`INSERT INTO release_seoul_workspace_scope(attempt_id,stream_kind,entity_id) SELECT a.id,'credential',c.id FROM release_seoul_workspace_attempts a JOIN credentials c ON ${credentials} WHERE a.id=? AND a.exclusion_reason IS NULL`);
  const policyAllows=member||invite||issue?'1':`NOT EXISTS(SELECT 1 FROM release_credential_policies p WHERE p.credential_id=a.entity_id AND p.space_ids IS NOT NULL) OR EXISTS(SELECT 1 FROM release_credential_policies p,json_each(p.space_ids) j WHERE p.credential_id=a.entity_id AND j.value=s.id)`;
  add(`INSERT INTO release_seoul_workspace_spaces(attempt_id,space_id) SELECT a.id,s.id FROM release_seoul_workspace_attempts a JOIN spaces s ON s.id IN (${spaces}) WHERE a.id=? AND a.exclusion_reason IS NULL AND (${policyAllows}) AND (EXISTS(SELECT 1 FROM release_seoul_targets t WHERE t.space_id=s.id AND t.selected=1) OR EXISTS(SELECT 1 FROM release_seoul_dirty_spaces d WHERE d.space_id=s.id))`);
  add(`UPDATE release_seoul_workspace_scope AS k SET before_bytes=${state()} WHERE attempt_id=?`);
  const commandIndex=statements.length;statements.push(command);
  const receipt=invite?'r.invitation_id=a.invitation_id AND r.email_id=a.email_id':member?'r.membership_id=a.entity_id AND r.organization_id=a.organization_id':issue?'r.id=a.entity_id AND r.organization_id IS a.organization_id':'r.credential_id=a.entity_id';
  add(`UPDATE release_seoul_workspace_attempts AS a SET accepted=CASE WHEN receipt_before=0 ${positive?'AND entity_before=0':''} AND EXISTS(SELECT 1 FROM ${receiptTable} r WHERE r.id=a.receipt_id AND r.actor_credential_id=a.actor_id AND ${receipt}) THEN 1 ELSE 0 END WHERE id=?`);
  add(`UPDATE release_seoul_workspace_scope AS k SET after_bytes=${state()} WHERE attempt_id=? AND EXISTS(SELECT 1 FROM release_seoul_workspace_attempts a WHERE a.id=k.attempt_id AND a.accepted=1 AND a.exclusion_reason IS NULL)`);
  add(`INSERT INTO release_seoul_account_exclusions(account_id,reason,capture_attempt_id,count_lower_bound,byte_estimate,captured_at) SELECT account_id,exclusion_reason,id,min(2049,identity_count+credential_count+space_count+1),max(identity_bytes,source_bytes),captured_at FROM release_seoul_workspace_attempts a WHERE id=? AND accepted=1 AND exclusion_reason IS NOT NULL AND EXISTS(SELECT 1 FROM accounts WHERE id=a.account_id) AND NOT EXISTS(SELECT 1 FROM release_seoul_account_exclusions x WHERE x.account_id=a.account_id)`);
  add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
   SELECT id,'subject','${ISSUER}'||char(10)||anchor_subject,${uuid},json_object('version',3,'kind','subject-source-unrepresentable','issuer','${ISSUER}','subject',anchor_subject,'accountId',account_id,'reason',exclusion_reason,'countLowerBound',min(2049,identity_count+credential_count+space_count+1),'byteEstimate',max(identity_bytes,source_bytes),'captureAttemptId',id),captured_at
   FROM release_seoul_workspace_attempts WHERE id=? AND accepted=1 AND exclusion_reason IS NOT NULL AND anchor_subject IS NOT NULL AND ${validId('account_id')}`);
  add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
   SELECT a.id,k.stream_kind,k.entity_id,${uuid},json_set(k.after_bytes,'$.origin',json_object('kind','command','commandType',a.command_kind,'receiptId',a.receipt_id),'$.effect',json(${positive?`json_object('type','entity-head','disposition','present')`:`json_object('type','entity-negative','entityKind',k.stream_kind,'entityId',k.entity_id,'state','revoked','occurredAtMs',json_extract(k.after_bytes,'$.revokedAtMs'))`})),a.captured_at
   FROM release_seoul_workspace_scope k JOIN release_seoul_workspace_attempts a ON a.id=k.attempt_id WHERE a.id=? AND a.accepted=1 AND a.exclusion_reason IS NULL AND k.after_bytes IS NOT NULL AND k.before_bytes IS NOT k.after_bytes
    AND ${positive?'k.before_bytes IS NULL':`k.before_bytes IS NOT NULL AND json_extract(k.before_bytes,'$.revokedAtMs') IS NULL AND json_extract(k.after_bytes,'$.revokedAtMs') IS NOT NULL`} ORDER BY k.stream_kind COLLATE BINARY,k.entity_id COLLATE BINARY`);
  add(`INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision) SELECT s.space_id,(SELECT max(revision) FROM release_seoul_authority_changes WHERE source_command_id=a.id) FROM release_seoul_workspace_spaces s JOIN release_seoul_workspace_attempts a ON a.id=s.attempt_id WHERE a.id=? AND a.accepted=1 AND a.exclusion_reason IS NULL AND EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE source_command_id=a.id) ON CONFLICT(space_id) DO UPDATE SET dirty_revision=max(release_seoul_dirty_spaces.dirty_revision,excluded.dirty_revision)`);
  add('DELETE FROM release_seoul_workspace_scope WHERE attempt_id=?');add('DELETE FROM release_seoul_workspace_spaces WHERE attempt_id=?');add('DELETE FROM release_seoul_workspace_attempts WHERE id=?');
  if(statements.length>100)throw new Error('seoul_capture_statement_limit');return {statements,commandIndex};
}

import type { Database, Statement, Value } from './types.ts';

export type ProviderPrimitive = {
  event: {eventId:string; issuer:string; subject:string; address:string; kind:string; sequence:number; occurredAt:number; hash:string};
  commands: Statement[];
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
const credentialCost=`8192+${cost('c.id','c.account_id','c.membership_id','c.email_id','p.capabilities','p.space_ids')}`;
const memberCost=`8192+${cost('m.id','m.account_id','m.email_id','m.organization_id')}`;
const origin=`json_object('kind','provider-v2','eventId',a.publisher_event_id,'eventType',a.event_type,'sequence',a.sequence,'occurredAtMs',a.occurred_at)`;
const directEffect=`CASE WHEN a.address='' THEN json_object('type','subject-lifecycle','subject',a.subject,'state',substr(a.event_type,9),'occurredAtMs',a.occurred_at)
 ELSE json_object('type','email-lifecycle','subject',a.subject,'address',a.address,'state',substr(a.event_type,7),'occurredAtMs',a.occurred_at) END`;
const policy=`(SELECT json_object('capabilities',json((SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(p.capabilities) ORDER BY value COLLATE BINARY))),
 'spaceIds',CASE WHEN p.space_ids IS NULL THEN NULL ELSE json((SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(p.space_ids) ORDER BY value COLLATE BINARY))) END) FROM release_credential_policies p WHERE p.credential_id=c.id)`;
function state():string {
  return `CASE k.stream_kind
   WHEN 'subject' THEN (SELECT json_object('version',3,'kind','subject-source','issuer',k.issuer,'subject',k.subject,'accountId',o.account_id,'accountDisabledAtMs',(SELECT disabled_at FROM accounts WHERE id=o.account_id),
    'providerIdentities',json((SELECT json_group_array(json_object('issuer',i.issuer,'subject',i.subject,'accountId',i.account_id,'createdAtMs',i.created_at)) FROM (SELECT * FROM release_seoul_provider_identities WHERE operation_id=o.id ORDER BY sort_key COLLATE BINARY) i)),
    'lifecycle',json(coalesce((SELECT json_object('state','event','eventId',l.event_id,'sequence',l.sequence,'kind',l.kind,'occurredAtMs',l.occurred_at) FROM release_identity_lifecycle_state l WHERE l.issuer=k.issuer AND l.subject=k.subject AND l.address=''),'{"state":"absent"}')),
    'legacyDisabled',json(CASE WHEN EXISTS(SELECT 1 FROM release_provider_revocations r WHERE r.issuer=k.issuer AND r.subject=k.subject AND r.kind='account.disabled') THEN 'true' ELSE 'false' END)) FROM release_seoul_provider_attempts a JOIN release_seoul_provider_operations o ON o.id=a.operation_id WHERE a.id=k.attempt_id)
   WHEN 'email' THEN (SELECT json_object('version',3,'kind','email-source','issuer',k.issuer,'subject',k.subject,'address',k.address,'accountId',o.account_id,
    'liveClaim',json((SELECT json_object('id',e.id,'verifiedAtMs',e.verified_at) FROM account_emails e WHERE e.account_id=o.account_id AND e.address=k.address AND e.revoked_at IS NULL)),
    'changedClaim',NULL,'addressBlocked',json(CASE WHEN EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=k.address) OR EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=o.account_id AND b.address=k.address) THEN 'true' ELSE 'false' END),
    'legacyRevoked',json(CASE WHEN EXISTS(SELECT 1 FROM release_provider_revocations r WHERE r.issuer=k.issuer AND r.subject=k.subject AND r.kind='email.revoked' AND r.address=k.address) THEN 'true' ELSE 'false' END),
    'lifecycle',json(coalesce((SELECT json_object('state','event','eventId',l.event_id,'sequence',l.sequence,'kind',l.kind,'occurredAtMs',l.occurred_at) FROM release_identity_lifecycle_state l WHERE l.issuer=k.issuer AND l.subject=k.subject AND l.address=k.address),'{"state":"absent"}'))) FROM release_seoul_provider_attempts a JOIN release_seoul_provider_operations o ON o.id=a.operation_id WHERE a.id=k.attempt_id)
   WHEN 'membership' THEN (SELECT json_object('version',3,'kind','membership-source','id',m.id,'organizationId',m.organization_id,'accountId',m.account_id,'emailId',m.email_id,'role',m.role,'expiresAtMs',m.expires_at,'revokedAtMs',m.revoked_at) FROM memberships m WHERE m.id=k.entity_id)
   WHEN 'credential' THEN (SELECT json_object('version',3,'kind','credential-source','id',c.id,'accountId',c.account_id,'credentialKind',c.kind,'tokenDigest',c.token_digest,'membershipId',c.membership_id,'emailId',c.email_id,'permission',c.permission,'expiresAtMs',c.expires_at,'revokedAtMs',c.revoked_at,'policy',json(${policy})) FROM credentials c WHERE c.id=k.entity_id)
   END`;
}

/** One trusted atomic batch, with an initial bounded superset for both events.
 * Provider cascades only revoke existing rows: they cannot expand this set.
 * Full retained history is counted before JSON, so large history conservatively
 * excludes representation without changing the accepted central command.
 */
export function providerStatements(database:Database, primitives:ProviderPrimitive[]):Statement[] {
  if(primitives.length<1||primitives.length>2)throw new Error('seoul_provider_primitive_count');
  const first=primitives[0]!.event;
  if(primitives.some(p=>p.event.issuer!==first.issuer||p.event.subject!==first.subject)||new Set(primitives.map(p=>p.event.address)).size!==primitives.length)throw new Error('seoul_provider_primitive_scope');
  const operation=crypto.randomUUID(),attempts=primitives.map(()=>crypto.randomUUID()),statements:Statement[]=[];
  const add=(sql:string,values:Value[]=[operation])=>statements.push(database.prepare(sql).bind(...values));
  const wide=primitives.some(p=>p.event.address===''),address=primitives.find(p=>p.event.address!=='')?.event.address??'';
  add(`INSERT INTO release_seoul_provider_operations(id,account_id,account_wide,address,event_count) VALUES(?,(SELECT account_id FROM provider_identities WHERE issuer=? AND subject=?),?,?,?)`,[operation,first.issuer,first.subject,wide?1:0,address,primitives.length]);
  for(const [ordinal,primitive] of primitives.entries()){
    const e=primitive.event;
    // Check the original JS string before a SQL driver can replace an unpaired
    // surrogate. The public validator and original command are left unchanged.
    const supported=e.issuer===ISSUER&&e.subject.length<=512&&e.subject.trim().length>0&&!e.subject.includes('\0')&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(e.subject)
      &&new TextEncoder().encode(e.issuer+'\n'+e.subject+(e.address===''?'':'\n'+e.address)).length<=2048;
    add(`INSERT INTO release_seoul_provider_attempts(id,operation_id,ordinal,publisher_event_id,body_hash,issuer,subject,address,event_type,sequence,occurred_at,key_supported) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,[attempts[ordinal]!,operation,ordinal,e.eventId,e.hash,e.issuer,e.subject,e.address,e.kind,e.sequence,e.occurredAt,supported?1:0]);
  }
  add(`WITH RECURSIVE ${positions}, bounded AS (SELECT p.* FROM provider_identities p JOIN release_seoul_provider_operations o ON o.account_id=p.account_id WHERE o.id=? LIMIT 513)
   UPDATE release_seoul_provider_operations AS o SET identity_count=(SELECT count(*) FROM bounded),identity_bytes=coalesce((SELECT sum(256+${cost('p.issuer','p.subject','p.account_id')}) FROM bounded p),0),
    anchor_subject=(SELECT p.subject FROM (SELECT p.* FROM provider_identities p WHERE p.account_id=o.account_id AND p.issuer='${ISSUER}' LIMIT 513) p WHERE ${subject('p')} ORDER BY p.subject COLLATE BINARY LIMIT 1),
    exclusion_reason=CASE WHEN account_id IS NULL THEN 'unmapped' WHEN NOT ${validId('o.account_id')} THEN 'unsupported-state' WHEN (SELECT count(*) FROM bounded)>512 THEN 'identity-count'
     WHEN EXISTS(SELECT 1 FROM bounded p WHERE p.issuer<>'${ISSUER}' OR NOT ${subject('p')} OR NOT ${time('p.created_at')}) THEN 'unsupported-mapping'
     WHEN EXISTS(SELECT 1 FROM release_seoul_provider_attempts a WHERE a.operation_id=o.id AND a.key_supported=0) THEN 'unsupported-state'
     ELSE (SELECT reason FROM release_seoul_account_exclusions x WHERE x.account_id=o.account_id) END WHERE id=?`,[operation,operation]);
  const claims=wide?'e.account_id=o.account_id':'e.account_id=o.account_id AND e.address=o.address';
  const members=wide?'m.account_id=o.account_id':`m.email_id IN(SELECT e.id FROM account_emails e WHERE ${claims})`;
  const credentials=wide?"c.account_id=o.account_id AND c.kind IN ('personal_key','api_key')":`c.kind='api_key' AND c.email_id IN(SELECT e.id FROM account_emails e WHERE ${claims})`;
  add(`UPDATE release_seoul_provider_operations AS o SET claim_count=(SELECT count(*) FROM (SELECT id FROM account_emails e WHERE ${claims} LIMIT 513)) WHERE id=? AND exclusion_reason IS NULL`);
  add(`UPDATE release_seoul_provider_operations SET exclusion_reason=CASE WHEN claim_count>512 THEN 'fanout-count' WHEN identity_bytes+8192>131072 THEN 'identity-bytes' END WHERE id=? AND exclusion_reason IS NULL`);
  add(`UPDATE release_seoul_provider_operations AS o SET membership_count=(SELECT count(*) FROM (SELECT id FROM memberships m WHERE ${members} LIMIT 513)),credential_count=(SELECT count(*) FROM (SELECT id FROM credentials c WHERE ${credentials} LIMIT 513)) WHERE id=? AND exclusion_reason IS NULL`);
  // Both events share the initial superset; multiplying it is conservative and
  // includes duplicate intermediate emissions under distinct sub-attempt IDs.
  add(`UPDATE release_seoul_provider_operations SET source_count=event_count*(identity_count*(${wide?'1+claim_count':'1'})+membership_count+credential_count),
   exclusion_reason=CASE WHEN membership_count>512 OR credential_count>512 OR identity_count+event_count*(identity_count*(${wide?'1+claim_count':'1'})+membership_count+credential_count)>512 THEN 'fanout-count' END WHERE id=? AND exclusion_reason IS NULL`);
  const spaces=`${wide?'SELECT s.id FROM spaces s WHERE s.account_id=o.account_id UNION ALL ':''}SELECT s.id FROM memberships m JOIN spaces s ON s.organization_id=m.organization_id WHERE ${members}`;
  add(`UPDATE release_seoul_provider_operations AS o SET space_count=(SELECT count(*) FROM (SELECT DISTINCT id FROM (${spaces}) LIMIT 513)) WHERE id=? AND exclusion_reason IS NULL`);
  add(`UPDATE release_seoul_provider_operations AS o SET exclusion_reason=CASE WHEN space_count>512 THEN 'fanout-count' WHEN EXISTS(SELECT 1 FROM (${spaces}) s WHERE length(s.id)>128 OR NOT ${validId('s.id')}) THEN 'unsupported-state' END WHERE id=? AND exclusion_reason IS NULL`);
  add(`UPDATE release_seoul_provider_operations AS o SET largest_source=max(identity_bytes+8192+coalesce((SELECT max(${cost('e.id','e.address')}) FROM account_emails e WHERE ${claims}),0),
   coalesce((SELECT max(${credentialCost}) FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${credentials}),0),coalesce((SELECT max(${memberCost}) FROM memberships m WHERE ${members}),0)) WHERE id=? AND exclusion_reason IS NULL`);
  add(`UPDATE release_seoul_provider_operations SET source_bytes=source_count*largest_source,exclusion_reason=CASE WHEN largest_source>131072 OR source_count*largest_source>524288 THEN 'source-bytes' END WHERE id=? AND exclusion_reason IS NULL`);
  add(`UPDATE release_seoul_provider_operations AS o SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND (
   EXISTS(SELECT 1 FROM accounts x WHERE x.id=o.account_id AND NOT ${nullableTime('x.disabled_at')})
   OR EXISTS(SELECT 1 FROM account_emails e WHERE ${claims} AND (NOT ${validId('e.id')} OR NOT ${time('e.verified_at')} OR NOT ${nullableTime('e.revoked_at')}))
   OR EXISTS(SELECT 1 FROM memberships m WHERE ${members} AND (NOT ${validId('m.id')} OR NOT ${validId('m.organization_id')} OR NOT ${validId('m.email_id')} OR NOT ${time('m.expires_at')} OR NOT ${nullableTime('m.revoked_at')}))
   OR EXISTS(SELECT 1 FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${credentials} AND (NOT ${validId('c.id')} OR NOT ${time('c.expires_at')} OR NOT ${nullableTime('c.revoked_at')}
    OR (c.membership_id IS NOT NULL AND NOT ${validId('c.membership_id')}) OR (c.email_id IS NOT NULL AND NOT ${validId('c.email_id')})
    OR (p.credential_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM json_each(p.capabilities)) OR EXISTS(SELECT 1 FROM json_each(p.capabilities) j WHERE j.type<>'text' OR j.value NOT IN ('create','delete','export','read','update'))
     OR (p.space_ids IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM json_each(p.space_ids)) OR (SELECT count(DISTINCT value) FROM json_each(p.space_ids))>50 OR EXISTS(SELECT 1 FROM json_each(p.space_ids) j WHERE j.type<>'text' OR NOT ${validId('j.value')} OR length(j.value)>128)))))))
  )`);
  // Exact canonicalEmail grammar, with no retained-address normalization.
  add(`WITH RECURSIVE bounded AS (SELECT e.address FROM account_emails e JOIN release_seoul_provider_operations o ON ${claims} WHERE o.id=? AND o.exclusion_reason IS NULL),
   parts AS (SELECT address,substr(address,1,instr(address,'@')-1) local,substr(address,instr(address,'@')+1) domain FROM bounded WHERE length(CAST(address AS BLOB)) BETWEEN 3 AND 254 AND instr(address,char(0))=0),
   labels(address,label,remaining) AS (SELECT address,NULL,domain||'.' FROM parts UNION ALL SELECT address,substr(remaining,1,instr(remaining,'.')-1),substr(remaining,instr(remaining,'.')+1) FROM labels WHERE remaining<>'')
   UPDATE release_seoul_provider_operations AS o SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND EXISTS(SELECT 1 FROM bounded b WHERE NOT EXISTS(
    SELECT 1 FROM parts p WHERE p.address=b.address AND p.address=lower(trim(p.address)) AND instr(p.address,'@')>1 AND instr(p.domain,'@')=0 AND length(p.local) BETWEEN 1 AND 64
     AND p.local NOT GLOB '*[^a-z0-9!#$%&''*+/=?^_\`{|}~.-]*' AND substr(p.local,1,1)<>'.' AND substr(p.local,-1)<>'.' AND instr(p.local,'..')=0 AND length(p.domain)<=253 AND instr(p.domain,'.')>0 AND p.domain NOT GLOB '*[^a-z0-9.-]*'
     AND NOT EXISTS(SELECT 1 FROM labels l WHERE l.address=p.address AND l.label IS NOT NULL AND (length(l.label) NOT BETWEEN 1 AND 63 OR substr(l.label,1,1) NOT GLOB '[a-z0-9]' OR substr(l.label,-1) NOT GLOB '[a-z0-9]'))))`,[operation,operation]);
  add(`UPDATE release_seoul_provider_operations AS o SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND EXISTS(SELECT 1 FROM provider_identities p JOIN account_emails e ON ${claims} WHERE p.account_id=o.account_id AND ${bytes('p.issuer')}+1+${bytes('p.subject')}+1+${bytes('e.address')}>2048)`);
  add(`WITH RECURSIVE ${positions} INSERT INTO release_seoul_provider_identities(operation_id,issuer,subject,account_id,created_at,sort_key)
   SELECT o.id,p.issuer,p.subject,p.account_id,p.created_at,(SELECT group_concat(unit,'') FROM (SELECT CASE WHEN unicode(substr(p.subject,n,1))>65535 THEN printf('%04X%04X',55296+((unicode(substr(p.subject,n,1))-65536)>>10),56320+((unicode(substr(p.subject,n,1))-65536)&1023)) ELSE printf('%04X',unicode(substr(p.subject,n,1))) END unit FROM positions WHERE n<=length(p.subject) ORDER BY n))
   FROM release_seoul_provider_operations o JOIN provider_identities p ON p.account_id=o.account_id WHERE o.id=? AND o.exclusion_reason IS NULL`);
  for(const [ordinal,primitive] of primitives.entries()){
    const attempt=attempts[ordinal]!,account=primitive.event.address==='';
    if(account)add(`INSERT INTO release_seoul_provider_scope(attempt_id,stream_kind,stream_key,issuer,subject) SELECT ?,'subject',i.issuer||char(10)||i.subject,i.issuer,i.subject FROM release_seoul_provider_identities i WHERE operation_id=?`,[attempt,operation]);
    add(`INSERT INTO release_seoul_provider_scope(attempt_id,stream_kind,stream_key,issuer,subject,address)
     SELECT a.id,'email',i.issuer||char(10)||i.subject||char(10)||${account?'e.address':'a.address'},i.issuer,i.subject,${account?'e.address':'a.address'} FROM release_seoul_provider_attempts a JOIN release_seoul_provider_identities i ON i.operation_id=a.operation_id ${account?'JOIN (SELECT DISTINCT account_id,address FROM account_emails WHERE account_id=(SELECT account_id FROM release_seoul_provider_operations WHERE id=? AND exclusion_reason IS NULL)) e ON e.account_id=i.account_id':''} WHERE a.id=?`,account?[operation,attempt]:[attempt]);
    add(`INSERT INTO release_seoul_provider_scope(attempt_id,stream_kind,stream_key,entity_id) SELECT a.id,'membership',m.id,m.id FROM release_seoul_provider_attempts a JOIN release_seoul_provider_operations o ON o.id=a.operation_id JOIN memberships m ON ${account?'m.account_id=o.account_id':'m.email_id IN(SELECT e.id FROM account_emails e WHERE e.account_id=o.account_id AND e.address=a.address)'} WHERE a.id=? AND o.exclusion_reason IS NULL`,[attempt]);
    add(`INSERT INTO release_seoul_provider_scope(attempt_id,stream_kind,stream_key,entity_id) SELECT a.id,'credential',c.id,c.id FROM release_seoul_provider_attempts a JOIN release_seoul_provider_operations o ON o.id=a.operation_id JOIN credentials c ON ${account?"c.account_id=o.account_id AND c.kind IN ('personal_key','api_key')":"c.kind='api_key' AND c.email_id IN(SELECT e.id FROM account_emails e WHERE e.account_id=o.account_id AND e.address=a.address)"} WHERE a.id=? AND o.exclusion_reason IS NULL`,[attempt]);
  }
  // Retained lifecycle scalars are validated before either before/after JSON.
  add(`UPDATE release_seoul_provider_operations AS o SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND EXISTS(SELECT 1 FROM release_seoul_provider_attempts a JOIN release_seoul_provider_scope k ON k.attempt_id=a.id JOIN release_identity_lifecycle_state l ON l.issuer=k.issuer AND l.subject=k.subject AND l.address=coalesce(k.address,'') WHERE a.operation_id=o.id AND (NOT ${validId('l.event_id')} OR NOT ${time('l.sequence')} OR l.sequence<1 OR NOT ${time('l.occurred_at')}))`);
  add(`INSERT INTO release_seoul_provider_spaces(operation_id,space_id) SELECT o.id,s.id FROM release_seoul_provider_operations o JOIN spaces s ON s.id IN (${spaces}) WHERE o.id=? AND o.exclusion_reason IS NULL AND (EXISTS(SELECT 1 FROM release_seoul_targets t WHERE t.space_id=s.id AND t.selected=1) OR EXISTS(SELECT 1 FROM release_seoul_dirty_spaces d WHERE d.space_id=s.id))`);
  for(const [ordinal,primitive] of primitives.entries()){
    const attempt=attempts[ordinal]!;
    add(`UPDATE release_seoul_provider_attempts AS a SET event_before=EXISTS(SELECT 1 FROM release_identity_lifecycle_events WHERE id=a.publisher_event_id),receipt_before=EXISTS(SELECT 1 FROM release_webhook_events WHERE provider='identity' AND event_id=a.publisher_event_id) WHERE id=?`,[attempt]);
    add(`UPDATE release_seoul_provider_scope AS k SET prior_claim_id=(SELECT e.id FROM account_emails e JOIN release_seoul_provider_attempts a ON a.id=k.attempt_id JOIN release_seoul_provider_operations o ON o.id=a.operation_id WHERE e.account_id=o.account_id AND e.address=k.address AND e.revoked_at IS NULL),before_bytes=${state()} WHERE attempt_id=? AND EXISTS(SELECT 1 FROM release_seoul_provider_attempts a JOIN release_seoul_provider_operations o ON o.id=a.operation_id WHERE a.id=k.attempt_id AND o.exclusion_reason IS NULL)`,[attempt]);
    statements.push(...primitive.commands);
    add(`UPDATE release_seoul_provider_attempts AS a SET advanced=CASE WHEN event_before=0 AND receipt_before=0 AND EXISTS(SELECT 1 FROM release_identity_lifecycle_events e JOIN release_webhook_events r ON r.provider='identity' AND r.event_id=e.id AND r.body_hash=e.body_hash JOIN release_identity_lifecycle_state l ON l.event_id=e.id AND l.issuer=e.issuer AND l.subject=e.subject AND l.address=e.address AND l.sequence=e.sequence AND l.kind=e.kind AND l.occurred_at=e.occurred_at WHERE e.id=a.publisher_event_id AND e.body_hash=a.body_hash AND e.issuer=a.issuer AND e.subject=a.subject AND e.address=a.address AND e.sequence=a.sequence AND e.kind=a.event_type AND e.occurred_at=a.occurred_at) THEN 1 ELSE 0 END WHERE id=?`,[attempt]);
    add(`UPDATE release_seoul_provider_scope AS k SET after_bytes=${state()} WHERE attempt_id=? AND EXISTS(SELECT 1 FROM release_seoul_provider_attempts a JOIN release_seoul_provider_operations o ON o.id=a.operation_id WHERE a.id=k.attempt_id AND a.advanced=1 AND o.exclusion_reason IS NULL)`,[attempt]);
    add(`INSERT INTO release_seoul_provider_groups(outer_operation_id,ordinal,sub_attempt_id,publisher_event_id) SELECT operation_id,ordinal,id,publisher_event_id FROM release_seoul_provider_attempts WHERE id=? AND advanced=1`,[attempt]);
    add(`INSERT INTO release_seoul_account_exclusions(account_id,reason,capture_attempt_id,count_lower_bound,byte_estimate,captured_at) SELECT o.account_id,o.exclusion_reason,a.id,min(2049,o.identity_count+o.source_count+o.space_count),max(o.identity_bytes,o.source_bytes),o.captured_at FROM release_seoul_provider_attempts a JOIN release_seoul_provider_operations o ON o.id=a.operation_id WHERE a.id=? AND a.advanced=1 AND o.exclusion_reason IS NOT NULL AND EXISTS(SELECT 1 FROM accounts WHERE id=o.account_id) AND NOT EXISTS(SELECT 1 FROM release_seoul_account_exclusions x WHERE x.account_id=o.account_id)`,[attempt]);
    add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
     SELECT a.id,CASE WHEN a.address='' THEN 'subject' ELSE 'email' END,a.issuer||char(10)||a.subject||CASE WHEN a.address='' THEN '' ELSE char(10)||a.address END,${uuid},json_object('version',3,'kind','identity-transition-source','issuer',a.issuer,'subject',a.subject,'address',nullif(a.address,''),'origin',json(${origin}),'effect',json(${directEffect})),o.captured_at
     FROM release_seoul_provider_attempts a JOIN release_seoul_provider_operations o ON o.id=a.operation_id WHERE a.id=? AND a.advanced=1 AND a.key_supported=1 AND o.exclusion_reason IS NOT NULL`,[attempt]);
    add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
     SELECT a.id,'subject','${ISSUER}'||char(10)||o.anchor_subject,${uuid},json_object('version',3,'kind','subject-source-unrepresentable','issuer','${ISSUER}','subject',o.anchor_subject,'accountId',o.account_id,'reason',o.exclusion_reason,'countLowerBound',min(2049,o.identity_count+o.source_count+o.space_count),'byteEstimate',max(o.identity_bytes,o.source_bytes),'captureAttemptId',a.id),o.captured_at
     FROM release_seoul_provider_attempts a JOIN release_seoul_provider_operations o ON o.id=a.operation_id WHERE a.id=? AND a.advanced=1 AND o.exclusion_reason IS NOT NULL AND o.anchor_subject IS NOT NULL AND ${validId('o.account_id')} AND NOT(a.key_supported=1 AND a.address='' AND a.issuer='${ISSUER}' AND a.subject=o.anchor_subject)`,[attempt]);
    const direct=`k.issuer=a.issuer AND k.subject=a.subject AND ((k.stream_kind='subject' AND a.address='') OR (k.stream_kind='email' AND k.address=a.address AND a.address<>''))`;
    const changedClaim=`(SELECT json_object('id',e.id,'verifiedAtMs',e.verified_at,'revokedAtMs',e.revoked_at) FROM account_emails e WHERE e.id=k.prior_claim_id AND e.revoked_at IS NOT NULL)`;
    add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
     SELECT a.id,k.stream_kind,k.stream_key,${uuid},json_set(CASE WHEN k.stream_kind='email' THEN json_set(k.after_bytes,'$.changedClaim',json(${changedClaim})) ELSE k.after_bytes END,
      '$.origin',json(${origin}),'$.effect',json(CASE WHEN ${direct} THEN ${directEffect} WHEN k.stream_kind IN ('membership','credential') THEN json_object('type','entity-negative','entityKind',k.stream_kind,'entityId',k.entity_id,'state','revoked','occurredAtMs',json_extract(k.after_bytes,'$.revokedAtMs')) ELSE json_object('type','entity-head','disposition','changed') END)),o.captured_at
     FROM release_seoul_provider_scope k JOIN release_seoul_provider_attempts a ON a.id=k.attempt_id JOIN release_seoul_provider_operations o ON o.id=a.operation_id
     WHERE a.id=? AND a.advanced=1 AND o.exclusion_reason IS NULL AND k.after_bytes IS NOT NULL AND k.before_bytes IS NOT k.after_bytes AND (k.stream_kind IN ('subject','email') OR (json_extract(k.before_bytes,'$.revokedAtMs') IS NULL AND json_extract(k.after_bytes,'$.revokedAtMs') IS NOT NULL)) ORDER BY k.stream_kind COLLATE BINARY,k.stream_key COLLATE BINARY`,[attempt]);
    add(`INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision,captured_revision) SELECT s.space_id,(SELECT max(revision) FROM release_seoul_authority_changes WHERE source_command_id=a.id),coalesce((SELECT d.captured_revision FROM release_seoul_dirty_spaces d WHERE d.space_id=s.space_id),0) FROM release_seoul_provider_spaces s JOIN release_seoul_provider_attempts a ON a.operation_id=s.operation_id WHERE a.id=? AND a.advanced=1 AND EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE source_command_id=a.id) ON CONFLICT(space_id) DO UPDATE SET dirty_revision=max(release_seoul_dirty_spaces.dirty_revision,excluded.dirty_revision)`,[attempt]);
  }
  add(`DELETE FROM release_seoul_provider_scope WHERE attempt_id IN(SELECT id FROM release_seoul_provider_attempts WHERE operation_id=?)`);
  for(const table of ['spaces','identities','attempts'])add(`DELETE FROM release_seoul_provider_${table} WHERE operation_id=?`);
  add(`DELETE FROM release_seoul_provider_operations WHERE id=?`);
  if(statements.length>100)throw new Error('seoul_provider_statement_bound');
  return statements;
}

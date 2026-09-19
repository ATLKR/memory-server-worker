import type { Database, Statement, Value } from './types.ts';

export type ProviderV1Event = {eventId:string; issuer:string; subject:string; address:string; kind:string; hash:string};
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
const origin=`json_object('kind','provider-v1','eventId',a.publisher_event_id,'eventType',a.event_type,'storedRevocationAtMs',a.stored_revocation_at)`;
const directEffect=`CASE WHEN a.address='' THEN json_object('type','subject-lifecycle','subject',a.subject,'state','deleted','occurredAtMs',a.stored_revocation_at) ELSE json_object('type','email-lifecycle','subject',a.subject,'address',a.address,'state','revoked','occurredAtMs',a.stored_revocation_at) END`;
const policy=`(SELECT json_object('capabilities',json((SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(p.capabilities) ORDER BY value COLLATE BINARY))),
 'spaceIds',CASE WHEN p.space_ids IS NULL THEN NULL ELSE json((SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(p.space_ids) ORDER BY value COLLATE BINARY))) END) FROM release_credential_policies p WHERE p.credential_id=c.id)`;
function state():string {
  return `CASE k.stream_kind
   WHEN 'subject' THEN (SELECT json_object('version',3,'kind','subject-source','issuer',k.issuer,'subject',k.subject,'accountId',o.account_id,'accountDisabledAtMs',(SELECT disabled_at FROM accounts WHERE id=o.account_id),
    'providerIdentities',json((SELECT json_group_array(json_object('issuer',i.issuer,'subject',i.subject,'accountId',i.account_id,'createdAtMs',i.created_at)) FROM (SELECT * FROM release_seoul_provider_v1_identities WHERE attempt_id=o.id ORDER BY sort_key COLLATE BINARY) i)),
    'lifecycle',json(coalesce((SELECT json_object('state','event','eventId',l.event_id,'sequence',l.sequence,'kind',l.kind,'occurredAtMs',l.occurred_at) FROM release_identity_lifecycle_state l WHERE l.issuer=k.issuer AND l.subject=k.subject AND l.address=''),'{"state":"absent"}')),
    'legacyDisabled',json(CASE WHEN EXISTS(SELECT 1 FROM release_provider_revocations r WHERE r.issuer=k.issuer AND r.subject=k.subject AND r.kind='account.disabled') THEN 'true' ELSE 'false' END)) FROM release_seoul_provider_v1_attempts a JOIN release_seoul_provider_v1_attempts o ON o.id=a.id WHERE a.id=k.attempt_id)
   WHEN 'email' THEN (SELECT json_object('version',3,'kind','email-source','issuer',k.issuer,'subject',k.subject,'address',k.address,'accountId',o.account_id,
    'liveClaim',json((SELECT json_object('id',e.id,'verifiedAtMs',e.verified_at) FROM account_emails e WHERE e.account_id=o.account_id AND e.address=k.address AND e.revoked_at IS NULL)),
    'changedClaim',NULL,'addressBlocked',json(CASE WHEN EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=k.address) OR EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=o.account_id AND b.address=k.address) THEN 'true' ELSE 'false' END),
    'legacyRevoked',json(CASE WHEN EXISTS(SELECT 1 FROM release_provider_revocations r WHERE r.issuer=k.issuer AND r.subject=k.subject AND r.kind='email.revoked' AND r.address=k.address) THEN 'true' ELSE 'false' END),
    'lifecycle',json(coalesce((SELECT json_object('state','event','eventId',l.event_id,'sequence',l.sequence,'kind',l.kind,'occurredAtMs',l.occurred_at) FROM release_identity_lifecycle_state l WHERE l.issuer=k.issuer AND l.subject=k.subject AND l.address=k.address),'{"state":"absent"}'))) FROM release_seoul_provider_v1_attempts a JOIN release_seoul_provider_v1_attempts o ON o.id=a.id WHERE a.id=k.attempt_id)
   WHEN 'membership' THEN (SELECT json_object('version',3,'kind','membership-source','id',m.id,'organizationId',m.organization_id,'accountId',m.account_id,'emailId',m.email_id,'role',m.role,'expiresAtMs',m.expires_at,'revokedAtMs',m.revoked_at) FROM memberships m WHERE m.id=k.entity_id)
   WHEN 'credential' THEN (SELECT json_object('version',3,'kind','credential-source','id',c.id,'accountId',c.account_id,'credentialKind',c.kind,'tokenDigest',c.token_digest,'membershipId',c.membership_id,'emailId',c.email_id,'permission',c.permission,'expiresAtMs',c.expires_at,'revokedAtMs',c.revoked_at,'policy',json(${policy})) FROM credentials c WHERE c.id=k.entity_id)
   END`;
}

/** V1's receipt, permanent tombstone and effective fact change are separate.
 * Discover the actual mapping inside this batch. Account disable changes no
 * children; email capture uses only the live claim and live indexed children.
 */
export function providerV1Statements(database:Database,event:ProviderV1Event,commands:Statement[]):Statement[] {
 const attempt=crypto.randomUUID(),statements:Statement[]=[],wide=event.kind==='account.disabled';
 const add=(sql:string,values:Value[]=[attempt])=>statements.push(database.prepare(sql).bind(...values));
 // Public V1 uses UTF-8 bytes; stored aliases use the separate UTF-16 contract.
 // Evaluate the original input before the driver repairs an unpaired surrogate.
 const supported=event.issuer===ISSUER&&new TextEncoder().encode(event.subject).length<=512&&event.subject.trim().length>0&&!event.subject.includes('\0')&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(event.subject);
 add(`INSERT INTO release_seoul_provider_v1_attempts(id,publisher_event_id,body_hash,issuer,subject,address,event_type,account_id,key_supported)
  VALUES(?,?,?,?,?,?,?,(SELECT account_id FROM provider_identities WHERE issuer=? AND subject=?),?)`,[attempt,event.eventId,event.hash,event.issuer,event.subject,event.address,event.kind,event.issuer,event.subject,supported?1:0]);
 const tombstone=`SELECT r.created_at FROM release_provider_revocations r WHERE r.issuer=a.issuer AND r.subject=a.subject AND r.kind=a.event_type AND r.address=a.address`;
 const liveClaim=`SELECT e.id FROM account_emails e WHERE e.account_id=a.account_id AND e.address=a.address AND e.revoked_at IS NULL`;
 const block=`EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=a.address) OR EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=a.account_id AND b.address=a.address)`;
 add(`UPDATE release_seoul_provider_v1_attempts AS a SET receipt_before=EXISTS(SELECT 1 FROM release_webhook_events r WHERE r.provider='identity' AND r.event_id=a.publisher_event_id),
  tombstone_before=EXISTS(${tombstone}),stored_revocation_at=(${tombstone}),disabled_before=(SELECT disabled_at FROM accounts WHERE id=a.account_id),
  block_before=CASE WHEN a.address<>'' THEN (${block}) ELSE 0 END,claim_before=CASE WHEN a.address<>'' THEN (${liveClaim}) END WHERE id=?`);
 add(`WITH RECURSIVE ${positions}, bounded AS (SELECT p.* FROM provider_identities p JOIN release_seoul_provider_v1_attempts o ON o.account_id=p.account_id WHERE o.id=? LIMIT 513)
  UPDATE release_seoul_provider_v1_attempts AS o SET identity_count=(SELECT count(*) FROM bounded),identity_bytes=coalesce((SELECT sum(256+${cost('p.issuer','p.subject','p.account_id')}) FROM bounded p),0),
  anchor_subject=(SELECT p.subject FROM (SELECT p.* FROM provider_identities p WHERE p.account_id=o.account_id AND p.issuer='${ISSUER}' LIMIT 513) p WHERE ${subject('p')} ORDER BY p.subject COLLATE BINARY LIMIT 1),
  exclusion_reason=CASE WHEN account_id IS NULL THEN 'unmapped' WHEN NOT ${validId('o.account_id')} THEN 'unsupported-state' WHEN (SELECT count(*) FROM bounded)>512 THEN 'identity-count'
   WHEN EXISTS(SELECT 1 FROM bounded p WHERE p.issuer<>'${ISSUER}' OR NOT ${subject('p')} OR NOT ${time('p.created_at')}) THEN 'unsupported-mapping'
   WHEN o.key_supported=0 OR (o.tombstone_before=1 AND NOT ${time('o.stored_revocation_at')}) THEN 'unsupported-state'
   ELSE (SELECT reason FROM release_seoul_account_exclusions x WHERE x.account_id=o.account_id) END WHERE id=?`,[attempt,attempt]);
 const claims='e.account_id=o.account_id AND e.address=o.address AND e.revoked_at IS NULL';
 const members=wide?'m.account_id=o.account_id':`m.email_id=o.claim_before AND m.revoked_at IS NULL`;
 const credentials=`c.email_id=o.claim_before AND c.revoked_at IS NULL AND c.kind='api_key'`;
 add(`UPDATE release_seoul_provider_v1_attempts AS o SET membership_count=(SELECT count(*) FROM (SELECT id FROM memberships m WHERE ${members} LIMIT 513)),credential_count=${wide?'0':`(SELECT count(*) FROM (SELECT id FROM credentials c WHERE ${credentials} LIMIT 513))`} WHERE id=? AND exclusion_reason IS NULL`);
 add(`UPDATE release_seoul_provider_v1_attempts SET source_count=identity_count${wide?'':'+membership_count+credential_count'},
  exclusion_reason=CASE WHEN membership_count>512 OR credential_count>512 OR identity_count*2${wide?'':'+membership_count+credential_count'}>512 THEN 'fanout-count' WHEN identity_bytes+8192>131072 THEN 'identity-bytes' END WHERE id=? AND exclusion_reason IS NULL`);
 const spaces=`${wide?'SELECT s.id FROM spaces s WHERE s.account_id=o.account_id UNION ALL ':''}SELECT s.id FROM memberships m JOIN spaces s ON s.organization_id=m.organization_id WHERE ${members}`;
 add(`UPDATE release_seoul_provider_v1_attempts AS o SET space_count=(SELECT count(*) FROM (SELECT DISTINCT id FROM (${spaces}) LIMIT 513)) WHERE id=? AND exclusion_reason IS NULL`);
 add(`UPDATE release_seoul_provider_v1_attempts AS o SET exclusion_reason=CASE WHEN space_count>512 THEN 'fanout-count' WHEN EXISTS(SELECT 1 FROM (${spaces}) s WHERE length(s.id)>128 OR NOT ${validId('s.id')}) THEN 'unsupported-state' END WHERE id=? AND exclusion_reason IS NULL`);
 add(`UPDATE release_seoul_provider_v1_attempts AS o SET largest_source=max(0,identity_bytes+8192+${wide?'0':`coalesce((SELECT max(${cost('e.id','e.address')}) FROM account_emails e WHERE ${claims}),0)`}${wide?'':`,coalesce((SELECT max(${credentialCost}) FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${credentials}),0),coalesce((SELECT max(${memberCost}) FROM memberships m WHERE ${members}),0)`}) WHERE id=? AND exclusion_reason IS NULL`);
 add(`UPDATE release_seoul_provider_v1_attempts SET source_bytes=source_count*largest_source,exclusion_reason=CASE WHEN largest_source>131072 OR source_count*largest_source>524288 THEN 'source-bytes' END WHERE id=? AND exclusion_reason IS NULL`);
 add(`UPDATE release_seoul_provider_v1_attempts AS o SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND (
  EXISTS(SELECT 1 FROM accounts x WHERE x.id=o.account_id AND NOT ${nullableTime('x.disabled_at')})
  ${wide?'':`OR EXISTS(SELECT 1 FROM account_emails e WHERE ${claims} AND (NOT ${validId('e.id')} OR NOT ${time('e.verified_at')}))
  OR EXISTS(SELECT 1 FROM memberships m WHERE ${members} AND (NOT ${validId('m.id')} OR NOT ${validId('m.organization_id')} OR NOT ${validId('m.email_id')} OR NOT ${time('m.expires_at')}))
  OR EXISTS(SELECT 1 FROM credentials c LEFT JOIN release_credential_policies p ON p.credential_id=c.id WHERE ${credentials} AND (NOT ${validId('c.id')} OR NOT ${time('c.expires_at')}
   OR NOT ${validId('c.membership_id')} OR NOT ${validId('c.email_id')}
   OR (p.credential_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM json_each(p.capabilities)) OR EXISTS(SELECT 1 FROM json_each(p.capabilities) j WHERE j.type<>'text' OR j.value NOT IN ('create','delete','export','read','update'))
    OR (p.space_ids IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM json_each(p.space_ids)) OR (SELECT count(DISTINCT value) FROM json_each(p.space_ids))>50 OR EXISTS(SELECT 1 FROM json_each(p.space_ids) j WHERE j.type<>'text' OR NOT ${validId('j.value')} OR length(j.value)>128)))))))`}
 )`);
 if(!wide)add(`UPDATE release_seoul_provider_v1_attempts AS o SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND EXISTS(SELECT 1 FROM provider_identities p WHERE p.account_id=o.account_id AND ${bytes('p.issuer')}+1+${bytes('p.subject')}+1+${bytes('o.address')}>2048)`);
 add(`WITH RECURSIVE ${positions} INSERT INTO release_seoul_provider_v1_identities(attempt_id,issuer,subject,account_id,created_at,sort_key)
  SELECT o.id,p.issuer,p.subject,p.account_id,p.created_at,(SELECT group_concat(unit,'') FROM (SELECT CASE WHEN unicode(substr(p.subject,n,1))>65535 THEN printf('%04X%04X',55296+((unicode(substr(p.subject,n,1))-65536)>>10),56320+((unicode(substr(p.subject,n,1))-65536)&1023)) ELSE printf('%04X',unicode(substr(p.subject,n,1))) END unit FROM positions WHERE n<=length(p.subject) ORDER BY n))
  FROM release_seoul_provider_v1_attempts o JOIN provider_identities p ON p.account_id=o.account_id WHERE o.id=? AND o.exclusion_reason IS NULL`);
 add(`INSERT INTO release_seoul_provider_v1_scope(attempt_id,stream_kind,stream_key,issuer,subject,address)
  SELECT a.id,'${wide?'subject':'email'}',i.issuer||char(10)||i.subject${wide?'':'||char(10)||a.address'},i.issuer,i.subject,${wide?'NULL':'a.address'} FROM release_seoul_provider_v1_attempts a JOIN release_seoul_provider_v1_identities i ON i.attempt_id=a.id WHERE a.id=?`);
 if(!wide){
  add(`INSERT INTO release_seoul_provider_v1_scope(attempt_id,stream_kind,stream_key,entity_id) SELECT o.id,'membership',m.id,m.id FROM release_seoul_provider_v1_attempts o JOIN memberships m ON ${members} WHERE o.id=? AND o.exclusion_reason IS NULL`);
  add(`INSERT INTO release_seoul_provider_v1_scope(attempt_id,stream_kind,stream_key,entity_id) SELECT o.id,'credential',c.id,c.id FROM release_seoul_provider_v1_attempts o JOIN credentials c ON ${credentials} WHERE o.id=? AND o.exclusion_reason IS NULL`);
 }
 add(`UPDATE release_seoul_provider_v1_attempts AS o SET exclusion_reason='unsupported-state' WHERE id=? AND exclusion_reason IS NULL AND EXISTS(SELECT 1 FROM release_seoul_provider_v1_scope k JOIN release_identity_lifecycle_state l ON l.issuer=k.issuer AND l.subject=k.subject AND l.address=coalesce(k.address,'') WHERE k.attempt_id=o.id AND (NOT ${validId('l.event_id')} OR NOT ${time('l.sequence')} OR l.sequence<1 OR NOT ${time('l.occurred_at')}))`);
 add(`INSERT INTO release_seoul_provider_v1_spaces(attempt_id,space_id) SELECT o.id,s.id FROM release_seoul_provider_v1_attempts o JOIN spaces s ON s.id IN (${spaces}) WHERE o.id=? AND o.exclusion_reason IS NULL AND (EXISTS(SELECT 1 FROM release_seoul_targets t WHERE t.space_id=s.id AND t.selected=1) OR EXISTS(SELECT 1 FROM release_seoul_dirty_spaces d WHERE d.space_id=s.id))`);
 add(`UPDATE release_seoul_provider_v1_scope AS k SET prior_claim_id=(SELECT a.claim_before FROM release_seoul_provider_v1_attempts a WHERE a.id=k.attempt_id),before_bytes=${state()} WHERE attempt_id=? AND EXISTS(SELECT 1 FROM release_seoul_provider_v1_attempts a WHERE a.id=k.attempt_id AND a.exclusion_reason IS NULL)`);
 statements.push(...commands);
 add(`UPDATE release_seoul_provider_v1_attempts AS a SET receipt_new=CASE WHEN receipt_before=0 AND EXISTS(SELECT 1 FROM release_webhook_events r WHERE r.provider='identity' AND r.event_id=a.publisher_event_id AND r.body_hash=a.body_hash) THEN 1 ELSE 0 END,
  tombstone_new=CASE WHEN tombstone_before=0 AND EXISTS(${tombstone}) THEN 1 ELSE 0 END,stored_revocation_at=(${tombstone}) WHERE id=?`);
 add(`UPDATE release_seoul_provider_v1_attempts AS a SET changed=CASE WHEN receipt_new=1 AND (tombstone_new=1 OR ${wide?'disabled_before IS NOT (SELECT disabled_at FROM accounts WHERE id=a.account_id)':`block_before IS NOT (${block}) OR claim_before IS NOT (${liveClaim})`}) THEN 1 ELSE 0 END,
  exclusion_reason=CASE WHEN NOT ${time('a.stored_revocation_at')} OR (a.account_id IS NOT NULL AND ${wide?'(SELECT disabled_at FROM accounts WHERE id=a.account_id) IS NULL':`(EXISTS(${liveClaim}) OR NOT (${block}))`}) THEN 'unsupported-state' ELSE exclusion_reason END WHERE id=?`);
 add(`UPDATE release_seoul_provider_v1_scope AS k SET after_bytes=${state()} WHERE attempt_id=? AND EXISTS(SELECT 1 FROM release_seoul_provider_v1_attempts a WHERE a.id=k.attempt_id AND a.changed=1 AND a.exclusion_reason IS NULL)`);
 add(`INSERT INTO release_seoul_account_exclusions(account_id,reason,capture_attempt_id,count_lower_bound,byte_estimate,captured_at) SELECT a.account_id,a.exclusion_reason,a.id,min(2049,a.identity_count+a.source_count+a.space_count),max(a.identity_bytes,a.source_bytes),a.captured_at FROM release_seoul_provider_v1_attempts a WHERE a.id=? AND a.changed=1 AND a.exclusion_reason IS NOT NULL AND EXISTS(SELECT 1 FROM accounts WHERE id=a.account_id) AND NOT EXISTS(SELECT 1 FROM release_seoul_account_exclusions x WHERE x.account_id=a.account_id)`);
 const minimal=`a.changed=1 AND a.key_supported=1 AND ${time('a.stored_revocation_at')} AND a.exclusion_reason IS NOT NULL`;
 add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
  SELECT a.id,CASE WHEN a.address='' THEN 'subject' ELSE 'email' END,a.issuer||char(10)||a.subject||CASE WHEN a.address='' THEN '' ELSE char(10)||a.address END,${uuid},json_object('version',3,'kind','identity-transition-source','issuer',a.issuer,'subject',a.subject,'address',nullif(a.address,''),'origin',json(${origin}),'effect',json(${directEffect})),a.captured_at
  FROM release_seoul_provider_v1_attempts a WHERE a.id=? AND ${minimal}`);
 add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
  SELECT a.id,'subject','${ISSUER}'||char(10)||a.anchor_subject,${uuid},json_object('version',3,'kind','subject-source-unrepresentable','issuer','${ISSUER}','subject',a.anchor_subject,'accountId',a.account_id,'reason',a.exclusion_reason,'countLowerBound',min(2049,a.identity_count+a.source_count+a.space_count),'byteEstimate',max(a.identity_bytes,a.source_bytes),'captureAttemptId',a.id),a.captured_at
  FROM release_seoul_provider_v1_attempts a WHERE a.id=? AND a.changed=1 AND a.exclusion_reason IS NOT NULL AND a.anchor_subject IS NOT NULL AND ${validId('a.account_id')} AND NOT((${minimal}) AND a.address='' AND a.issuer='${ISSUER}' AND a.subject=a.anchor_subject)`);
 const direct=`k.issuer=a.issuer AND k.subject=a.subject AND ((k.stream_kind='subject' AND a.address='') OR (k.stream_kind='email' AND k.address=a.address AND a.address<>''))`;
 const changedClaim=`(SELECT json_object('id',e.id,'verifiedAtMs',e.verified_at,'revokedAtMs',e.revoked_at) FROM account_emails e WHERE e.id=k.prior_claim_id AND e.revoked_at IS NOT NULL)`;
 add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
  SELECT a.id,k.stream_kind,k.stream_key,${uuid},json_set(CASE WHEN k.stream_kind='email' THEN json_set(k.after_bytes,'$.changedClaim',json(${changedClaim})) ELSE k.after_bytes END,
   '$.origin',json(${origin}),'$.effect',json(CASE WHEN ${direct} THEN ${directEffect} WHEN k.stream_kind IN ('membership','credential') THEN json_object('type','entity-negative','entityKind',k.stream_kind,'entityId',k.entity_id,'state','revoked','occurredAtMs',json_extract(k.after_bytes,'$.revokedAtMs')) ELSE json_object('type','entity-head','disposition','changed') END)),a.captured_at
  FROM release_seoul_provider_v1_scope k JOIN release_seoul_provider_v1_attempts a ON a.id=k.attempt_id WHERE a.id=? AND a.changed=1 AND a.exclusion_reason IS NULL AND k.after_bytes IS NOT NULL AND (k.before_bytes IS NOT k.after_bytes OR (a.tombstone_new=1 AND ${direct}))
   AND (k.stream_kind IN ('subject','email') OR (json_extract(k.before_bytes,'$.revokedAtMs') IS NULL AND json_extract(k.after_bytes,'$.revokedAtMs') IS NOT NULL)) ORDER BY k.stream_kind COLLATE BINARY,k.stream_key COLLATE BINARY`);
 add(`INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision,captured_revision) SELECT s.space_id,(SELECT max(revision) FROM release_seoul_authority_changes WHERE source_command_id=a.id),coalesce((SELECT d.captured_revision FROM release_seoul_dirty_spaces d WHERE d.space_id=s.space_id),0) FROM release_seoul_provider_v1_spaces s JOIN release_seoul_provider_v1_attempts a ON a.id=s.attempt_id WHERE a.id=? AND a.changed=1 AND a.exclusion_reason IS NULL AND EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE source_command_id=a.id) ON CONFLICT(space_id) DO UPDATE SET dirty_revision=max(release_seoul_dirty_spaces.dirty_revision,excluded.dirty_revision)`);
 for(const table of ['scope','spaces','identities'])add(`DELETE FROM release_seoul_provider_v1_${table} WHERE attempt_id=?`);
 add(`DELETE FROM release_seoul_provider_v1_attempts WHERE id=?`);
 // This SELECT is consumed inside the atomic batch. A skipped final DELETE
 // must fail before commit; SQLite's lazy CASE evaluates overflow only when
 // staging remains, without creating another guard row that needs cleanup.
 add(`SELECT CASE WHEN EXISTS(SELECT 1 FROM release_seoul_provider_v1_attempts LIMIT 1)
  OR EXISTS(SELECT 1 FROM release_seoul_provider_v1_scope LIMIT 1)
  OR EXISTS(SELECT 1 FROM release_seoul_provider_v1_spaces LIMIT 1)
  OR EXISTS(SELECT 1 FROM release_seoul_provider_v1_identities LIMIT 1)
  THEN abs(-9223372036854775808) ELSE 1 END AS cleanup_guard`,[]);
 if(statements.length>100)throw new Error('seoul_provider_v1_statement_bound');
 return statements;
}

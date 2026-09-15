import type {Database,Value} from './types.ts';
import {digest} from './util.ts';
import {encodeSeoulAuthoritySnapshot} from './seoul-projection-snapshot-codec.ts';
import type {SeoulAuthoritySnapshot} from './seoul-projection-snapshot-codec.ts';
import type {SeoulHead} from './seoul-projection-head-codec.ts';

/** Inert trusted same-database snapshot store. publish(spaceId) reads the
 * current central authority graph for one dirty Space, builds the canonical
 * v3 snapshot under the Space's database-time projection fence and
 * compare-and-publishes the immutable event, delivery and sequence advance in
 * one guarded batch. No dispatcher, route, schedule or runtime factory is
 * wired; this unit cannot dispatch or apply anything regionally. */

type Failure='invalid_input'|'schema_missing'|'staging_retained'|'space_missing'|'space_invalid'|'not_dirty'
 |'heads_pending'|'dependency_missing'|'account_excluded'|'unrepresentable'|'fence_held'|'stale'
 |'event_conflict'|'sequence_conflict'|'request_limit'|'uncertain';
export type SeoulSnapshotPublishResult=Readonly<{status:Failure}|{
 status:'published';spaceId:string;snapshotSeq:number;eventId:string;sourceRevision:number;issuedAtMs:number;expiresAtMs:number;payloadSha256:string;
}>;
export interface SeoulProjectionSnapshotStore{publish(input:unknown):Promise<SeoulSnapshotPublishResult>}

const ISSUER='https://auth-api.allen.company';
const S='release_seoul_snapshot_stage';
const now="CAST(round(unixepoch('subsec')*1000) AS INTEGER)";
const utf8=new TextEncoder(),utf8dec=new TextDecoder('utf-8',{fatal:true});
const LEASE_MS=60000,LOCK_MS=15000;

type Statement=Readonly<{sql:string;values:readonly Value[]}>;
const statement=(sql:string,values:readonly Value[]=[]):Statement=>({sql,values});
function fail():never{throw Error();}

function own(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))throw Error();
 const actual=Reflect.ownKeys(value);if(actual.length!==keys.length||actual.some(k=>typeof k!=='string'||!keys.includes(k)))throw Error();
 const result:Record<string,unknown>={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);if(!d||!d.enumerable||!('value'in d))throw Error();result[k]=d.value;}return result;
}
function integer(v:unknown,min=0):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||Object.is(v,-0)||v<min)throw Error();return v;}
function nullableInteger(v:unknown,min=0):number|null{return v===null?null:integer(v,min);}
function flag(v:unknown):boolean{if(v!==0&&v!==1||Object.is(v,-0))throw Error();return v===1;}
function text(v:unknown,max:number):string{if(typeof v!=='string'||!v.length||utf8.encode(v).length>max)throw Error();return v;}
function nullableText(v:unknown,max:number):string|null{return v===null?null:text(v,max);}
function digestText(v:unknown):string{if(typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v))throw Error();return v;}
function nullableDigest(v:unknown):string|null{return v===null?null:digestText(v);}
function spaceIdOf(v:unknown):string{if(typeof v!=='string'||!v.length||v.length>128||!/^[A-Za-z0-9]/.test(v)||/[^A-Za-z0-9._:-]/.test(v))throw Error();return v;}
function compare(a:string,b:string):number{return a<b?-1:a>b?1:0;}
function rows(value:unknown,max:number):readonly Record<string,unknown>[]{
 const r=own(value,['success','results','meta']);if(r.success!==true||!r.meta||typeof r.meta!=='object')throw Error();
 const list=r.results;if(!Array.isArray(list)||Object.getPrototypeOf(list)!==Array.prototype||list.length>max||Reflect.ownKeys(list).length!==list.length+1)throw Error();
 return list.map(item=>{if(!item||typeof item!=='object'||(Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null))throw Error();return item as Record<string,unknown>;});
}

const eventExact=(s:string)=>`EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE e.event_id=${s}.event_id AND e.source_revision=${s}.source_revision AND e.event_kind='snapshot' AND e.stream_kind IS NULL AND e.stream_key IS NULL AND e.source_sha256 IS NULL AND e.space_id=${s}.space_id AND e.snapshot_seq=${s}.snapshot_seq AND e.issued_at=${s}.issued_at AND e.expires_at=${s}.expires_at AND e.payload_bytes=${s}.payload_bytes AND e.payload_sha256=${s}.payload_sha256)`;
const publishedExact=(s:string)=>`EXISTS(SELECT 1 FROM release_seoul_published_snapshots p WHERE p.space_id=${s}.space_id AND p.snapshot_seq=${s}.snapshot_seq AND p.event_id=${s}.event_id AND p.payload_sha256=${s}.payload_sha256)`;
const deliveryPresent=(s:string)=>`EXISTS(SELECT 1 FROM release_seoul_projection_deliveries d WHERE d.event_id=${s}.event_id)`;
const dirtyCaptured=(s:string)=>`EXISTS(SELECT 1 FROM release_seoul_dirty_spaces d WHERE d.space_id=${s}.space_id AND d.dirty_revision=${s}.source_revision AND d.captured_revision>=${s}.source_revision)`;
const headMatch=(g:string,path:string)=>`EXISTS(SELECT 1 FROM release_seoul_authority_heads h WHERE h.stream_kind=json_extract(${g},'${path}.kind') AND h.stream_key=json_extract(${g},'${path}.key') AND h.revision=json_extract(${g},'${path}.revision') AND h.event_id=json_extract(${g},'${path}.eventId') AND h.payload_sha256=json_extract(${g},'${path}.payloadSha256'))`;
const headElem=(hd:string)=>`EXISTS(SELECT 1 FROM release_seoul_authority_heads h WHERE h.stream_kind=json_extract(${hd}.value,'$.kind') AND h.stream_key=json_extract(${hd}.value,'$.key') AND h.revision=json_extract(${hd}.value,'$.revision') AND h.event_id=json_extract(${hd}.value,'$.eventId') AND h.payload_sha256=json_extract(${hd}.value,'$.payloadSha256'))`;
// Every dependency head pinned inside the candidate payload must still be the
// current head at publish time. The fence/dirty/target/sequence predicates
// bound the examined revision; this recheck is the explicit dependency proof.
const headsCurrent=`NOT EXISTS(SELECT 1 FROM json_each(v.payload_bytes,'$.grants') g WHERE
 NOT ${headMatch('g.value','$.heads.credential')} OR NOT ${headMatch('g.value','$.heads.space')} OR NOT ${headMatch('g.value','$.heads.target')}
 OR (json_type(g.value,'$.heads.organization')='object' AND NOT ${headMatch('g.value','$.heads.organization')})
 OR (json_type(g.value,'$.heads.membership')='object' AND NOT ${headMatch('g.value','$.heads.membership')})
 OR EXISTS(SELECT 1 FROM json_each(g.value,'$.heads.subjects') hd WHERE NOT ${headElem('hd')})
 OR (json_type(g.value,'$.heads.emails')='array' AND EXISTS(SELECT 1 FROM json_each(g.value,'$.heads.emails') hd WHERE NOT ${headElem('hd')})))`;
// Base-table state that informed the payload but carries no authority head:
// exclusions are permanent refusal inputs, and disabled flags sit on the
// canonical rows. Any drift since the build read makes the batch ineligible.
const baseCurrent=`NOT EXISTS(SELECT 1 FROM json_each(v.payload_bytes,'$.accounts') a JOIN release_seoul_account_exclusions x ON x.account_id=json_extract(a.value,'$.id'))
 AND NOT EXISTS(SELECT 1 FROM json_each(v.payload_bytes,'$.accounts') a JOIN accounts x ON x.id=json_extract(a.value,'$.id') WHERE (x.disabled_at IS NULL)!=(json_extract(a.value,'$.disabledAtMs') IS NULL))
 AND NOT EXISTS(SELECT 1 FROM json_each(v.payload_bytes,'$.organizations') o JOIN organizations x ON x.id=json_extract(o.value,'$.id') WHERE (x.disabled_at IS NULL)!=(json_extract(o.value,'$.disabledAtMs') IS NULL))`;

const STAGE_RESIDUE=`EXISTS(SELECT 1 FROM ${S} LIMIT 1)
 OR EXISTS(SELECT 1 FROM release_seoul_preparation_stage LIMIT 1)
 OR EXISTS(SELECT 1 FROM release_seoul_target_preparation_stage LIMIT 1)
 OR EXISTS(SELECT 1 FROM release_seoul_target_attempt LIMIT 1)
 OR EXISTS(SELECT 1 FROM release_seoul_target_manifest_attempt LIMIT 1)`;

const observeKeys=['schema_version','stage_present','space_present','space_account','space_organization','space_disabled_at','space_security_mode','dirty_revision','captured_revision','lock_fence','lock_claimed_revision','lock_claimed_at','lock_expires_at','published_seq','published_event_id','published_sha256','target_revision','target_selected','heads_pending','observed_at'] as const;
type Observation=Readonly<{
 schemaVersion:number;stagePresent:boolean;spacePresent:boolean;spaceAccount:string|null;spaceOrganization:string|null;spaceDisabledAt:number|null;spaceManaged:boolean;
 dirtyRevision:number|null;capturedRevision:number|null;lockFence:string|null;lockClaimedRevision:number|null;lockClaimedAt:number|null;lockExpiresAt:number|null;
 publishedSeq:number|null;publishedEventId:string|null;publishedSha256:string|null;targetRevision:number|null;targetSelected:number|null;headsPending:boolean;observedAt:number;
}>;

const OBSERVE=`WITH v(space_id) AS (VALUES(?)) SELECT
 (SELECT version FROM release_meta) schema_version,(${STAGE_RESIDUE}) stage_present,
 s.id IS NOT NULL space_present,s.account_id space_account,s.organization_id space_organization,NULL space_disabled_at,s.security_mode space_security_mode,
 (SELECT dirty_revision FROM release_seoul_dirty_spaces WHERE space_id=v.space_id) dirty_revision,
 (SELECT captured_revision FROM release_seoul_dirty_spaces WHERE space_id=v.space_id) captured_revision,
 (SELECT fence_token FROM release_seoul_projection_lock WHERE space_id=v.space_id) lock_fence,
 (SELECT claimed_revision FROM release_seoul_projection_lock WHERE space_id=v.space_id) lock_claimed_revision,
 (SELECT claimed_at FROM release_seoul_projection_lock WHERE space_id=v.space_id) lock_claimed_at,
 (SELECT expires_at FROM release_seoul_projection_lock WHERE space_id=v.space_id) lock_expires_at,
 (SELECT snapshot_seq FROM release_seoul_published_snapshots WHERE space_id=v.space_id) published_seq,
 (SELECT event_id FROM release_seoul_published_snapshots WHERE space_id=v.space_id) published_event_id,
 (SELECT payload_sha256 FROM release_seoul_published_snapshots WHERE space_id=v.space_id) published_sha256,
 (SELECT revision FROM release_seoul_targets WHERE space_id=v.space_id) target_revision,
 (SELECT selected FROM release_seoul_targets WHERE space_id=v.space_id) target_selected,
 EXISTS(SELECT 1 FROM release_seoul_authority_heads WHERE payload_sha256 IS NULL) heads_pending,
 ${now} observed_at
 FROM v LEFT JOIN spaces s ON s.id=v.space_id`;

function observation(value:unknown):Observation{
 const x=own(value,observeKeys);
 const o:Observation=Object.freeze({
  schemaVersion:integer(x.schema_version,1),stagePresent:flag(x.stage_present),
  spacePresent:flag(x.space_present),spaceAccount:nullableText(x.space_account,256),spaceOrganization:nullableText(x.space_organization,256),
  spaceDisabledAt:nullableInteger(x.space_disabled_at),spaceManaged:x.space_security_mode==='managed',
  dirtyRevision:nullableInteger(x.dirty_revision,1),capturedRevision:nullableInteger(x.captured_revision),
  lockFence:nullableText(x.lock_fence,32),lockClaimedRevision:nullableInteger(x.lock_claimed_revision,1),
  lockClaimedAt:nullableInteger(x.lock_claimed_at),lockExpiresAt:nullableInteger(x.lock_expires_at),
  publishedSeq:nullableInteger(x.published_seq,1),publishedEventId:nullableText(x.published_event_id,36),publishedSha256:nullableDigest(x.published_sha256),
  targetRevision:nullableInteger(x.target_revision,1),targetSelected:x.target_selected===null?null:(flag(x.target_selected)?1:0),
  headsPending:flag(x.heads_pending),observedAt:integer(x.observed_at),
 });
 if(o.spacePresent?(o.spaceAccount===null)===(o.spaceOrganization===null):o.spaceAccount!==null||o.spaceOrganization!==null)throw Error();
 if((o.lockFence===null)!==(o.lockClaimedAt===null)||(o.lockClaimedRevision===null)!==(o.lockClaimedAt===null)||(o.lockExpiresAt===null)!==(o.lockClaimedAt===null))throw Error();
 if((o.publishedSeq===null)!==(o.publishedEventId===null)||(o.publishedSeq===null)!==(o.publishedSha256===null))throw Error();
 if((o.targetRevision===null)!==(o.targetSelected===null))throw Error();
 if((o.dirtyRevision===null)!==(o.capturedRevision===null)||(o.capturedRevision!==null&&o.dirtyRevision!==null&&o.capturedRevision>o.dirtyRevision))throw Error();
 return o;
}
async function observe(database:Database,spaceId:string):Promise<Observation>{
 return observation(await database.withSession('first-primary').prepare(OBSERVE).bind(spaceId).first());
}

const OBSERVE_EVENT=`WITH v(space_id,event_id,source_revision,snapshot_seq,issued_at,expires_at,payload_bytes,payload_sha256) AS (VALUES(?,?,?,?,?,?,?,?)) SELECT
 EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE e.event_id=v.event_id) event_present,
 EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE e.event_id=v.event_id AND e.source_revision=v.source_revision AND e.event_kind='snapshot' AND e.stream_kind IS NULL AND e.stream_key IS NULL AND e.source_sha256 IS NULL AND e.space_id=v.space_id AND e.snapshot_seq=v.snapshot_seq AND e.issued_at=v.issued_at AND e.expires_at=v.expires_at AND e.payload_bytes=v.payload_bytes AND e.payload_sha256=v.payload_sha256) event_exact,
 EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE e.space_id=v.space_id AND e.snapshot_seq=v.snapshot_seq) seq_event_present,
 EXISTS(SELECT 1 FROM release_seoul_projection_deliveries d WHERE d.event_id=v.event_id) delivery_present,
 EXISTS(SELECT 1 FROM release_seoul_published_snapshots p WHERE p.space_id=v.space_id AND p.snapshot_seq=v.snapshot_seq AND p.event_id=v.event_id AND p.payload_sha256=v.payload_sha256) published_exact
 FROM v`;
const eventKeys=['event_present','event_exact','seq_event_present','delivery_present','published_exact'] as const;
type EventObservation=Readonly<{eventPresent:boolean;eventExact:boolean;seqEventPresent:boolean;deliveryPresent:boolean;publishedExact:boolean}>;
async function observeEvent(database:Database,c:Candidate,payload:string,sha256:string):Promise<EventObservation>{
 const x=own(await database.withSession('first-primary').prepare(OBSERVE_EVENT).bind(c.spaceId,c.eventId,c.sourceRevision,c.snapshotSeq,c.issuedAt,c.issuedAt+LEASE_MS,payload,sha256).first(),eventKeys);
 return Object.freeze({eventPresent:flag(x.event_present),eventExact:flag(x.event_exact),seqEventPresent:flag(x.seq_event_present),deliveryPresent:flag(x.delivery_present),publishedExact:flag(x.published_exact)});
}

// Bounded advisory reads: each statement is its own first-primary query, so a
// concurrent central write can move base state between them. That is safe —
// the publish batch re-verifies every state these reads inform (fence, dirty
// revision, target tuple, sequence, pending heads, pinned dependency heads,
// exclusions and disabled flags) before any durable row lands.
const PERSONAL_CREDENTIALS=`SELECT c.id,c.account_id,c.permission,c.token_digest,c.expires_at,a.disabled_at account_disabled_at,p.capabilities,p.space_ids
 FROM credentials c JOIN accounts a ON a.id=c.account_id LEFT JOIN release_credential_policies p ON p.credential_id=c.id
 WHERE c.account_id=? AND c.kind='personal_key' AND c.revoked_at IS NULL ORDER BY c.id LIMIT 1025`;
const ORGANIZATION_CREDENTIALS=`SELECT c.id,c.account_id,c.permission,c.token_digest,c.expires_at,c.membership_id,c.email_id,
 m.role membership_role,m.expires_at membership_expires_at,
 e.address email_address,e.verified_at email_verified_at,
 a.disabled_at account_disabled_at,o.disabled_at organization_disabled_at,
 p.capabilities,p.space_ids
 FROM credentials c
 JOIN memberships m ON m.id=c.membership_id AND m.account_id=c.account_id AND m.email_id=c.email_id
 JOIN account_emails e ON e.id=m.email_id AND e.account_id=m.account_id
 JOIN accounts a ON a.id=c.account_id
 JOIN organizations o ON o.id=m.organization_id
 LEFT JOIN release_credential_policies p ON p.credential_id=c.id
 WHERE m.organization_id=? AND c.kind='api_key' AND c.revoked_at IS NULL AND m.revoked_at IS NULL AND e.revoked_at IS NULL
 ORDER BY c.id LIMIT 1025`;
const ORGANIZATION_ROW='SELECT id,disabled_at FROM organizations WHERE id=?';
const ACCOUNTS='SELECT id,disabled_at FROM accounts WHERE id IN (SELECT value FROM json_each(?)) LIMIT 4097';
const EXCLUSIONS='SELECT account_id FROM release_seoul_account_exclusions WHERE account_id IN (SELECT value FROM json_each(?)) LIMIT 4097';
const IDENTITIES='SELECT issuer,subject,account_id,created_at FROM provider_identities WHERE account_id IN (SELECT value FROM json_each(?)) LIMIT 4097';
const HEADS=`SELECT h.stream_kind,h.stream_key,h.revision,h.event_id,h.payload_sha256,json_extract(c.record_bytes,'$.kind') source_kind
 FROM release_seoul_authority_heads h LEFT JOIN release_seoul_authority_changes c
 ON c.revision=h.revision AND c.stream_kind=h.stream_kind AND c.stream_key=h.stream_key AND c.event_id=h.event_id
 WHERE h.stream_key IN (SELECT value FROM json_each(?)) LIMIT 8193`;

type Head=Readonly<{kind:string;key:string;revision:number;eventId:string;payloadSha256:string}>;
type Capability='read'|'create'|'update'|'delete'|'export';
type Policy=Readonly<{capabilities:readonly Capability[];spaceIds:readonly string[]|null}>;
type CredentialRow=Readonly<{id:string;accountId:string;permission:'read'|'write';tokenDigest:string;expiresAt:number;capabilities:string|null;spaceIds:string|null;
 membershipId:string|null;emailId:string|null;membershipRole:string|null;membershipExpiresAt:number|null;emailAddress:string|null;emailVerifiedAt:number|null;accountDisabledAt:number|null;organizationDisabledAt:number|null}>;

function credentialRow(value:unknown,organization:boolean):CredentialRow{
 const base=['id','account_id','permission','token_digest','expires_at','capabilities','space_ids'] as const;
 const extra=organization?['membership_id','email_id','membership_role','membership_expires_at','email_address','email_verified_at','account_disabled_at','organization_disabled_at'] as const:['account_disabled_at'] as const;
 const x=own(value,[...base,...extra]);
 const r:CredentialRow=Object.freeze({
  id:text(x.id,256),accountId:text(x.account_id,256),permission:x.permission==='read'||x.permission==='write'?x.permission:fail(),
  tokenDigest:digestText(x.token_digest),expiresAt:integer(x.expires_at),
  capabilities:nullableText(x.capabilities,4096),spaceIds:nullableText(x.space_ids,8192),
  membershipId:organization?nullableText(x.membership_id,256):null,emailId:organization?nullableText(x.email_id,256):null,
  membershipRole:organization?nullableText(x.membership_role,16):null,membershipExpiresAt:organization?nullableInteger(x.membership_expires_at):null,
  emailAddress:organization?nullableText(x.email_address,254):null,emailVerifiedAt:organization?nullableInteger(x.email_verified_at):null,
  accountDisabledAt:nullableInteger(x.account_disabled_at),organizationDisabledAt:organization?nullableInteger(x.organization_disabled_at):null,
 });
 if(organization&&(r.membershipId===null||r.emailId===null||r.emailAddress===null||r.emailVerifiedAt===null))fail();
 return r;
}

function policy(c:CredentialRow):Policy|null{
 if(c.capabilities===null)return null;
 const capabilities=JSON.parse(c.capabilities),scope=c.spaceIds===null?null:JSON.parse(c.spaceIds);
 if(!Array.isArray(capabilities)||capabilities.some(v=>typeof v!=='string'||!['read','create','update','delete','export'].includes(v)))fail();
 if(scope!==null&&(!Array.isArray(scope)||!scope.length||scope.length>50||scope.some(v=>typeof v!=='string'||!v.length||v.length>128||!/^[A-Za-z0-9]/.test(v)||/[^A-Za-z0-9._:-]/.test(v))))fail();
 const dedup=<T extends string>(list:readonly T[])=>Object.freeze([...new Set(list)].sort(compare));
 return Object.freeze({capabilities:dedup(capabilities as Capability[]),spaceIds:scope===null?null:dedup(scope as string[])});
}

const SPACE_POLICY=Object.freeze({policyVersion:1,residency:'kr-seoul',profile:'kr-primary-storage',processingBoundary:'approved-processors',dataClass:'personal',classificationStatus:'declared',sensitivityTags:[] as string[],placementEpoch:1});

type Candidate=Readonly<{
 spaceId:string;spaceAccount:string|null;spaceOrganization:string|null;spaceDisabledAt:number|null;selected:boolean;targetRevision:number|null;targetSelected:number|null;
 sourceRevision:number;snapshotSeq:number;issuedAt:number;lockExpiresAt:number;fence:string;eventId:string;
}>;
type Built=Readonly<{payload:string;sha256:string}>;

async function build(database:Database,c:Candidate):Promise<Built|Failure>{
 // Zero-grant path: a deselected or disabled Space keeps the exact required
 // owner/organization structure and carries no credential rows.
 const organization=c.spaceOrganization!==null,grantable=c.selected&&c.spaceDisabledAt===null;
 const granted:{row:CredentialRow;policy:Policy;canSearch:boolean;canIngest:boolean;expiresAt:number}[]=[];
 if(grantable){
  const list=rows(await database.withSession('first-primary').prepare(organization?ORGANIZATION_CREDENTIALS:PERSONAL_CREDENTIALS).bind(organization?c.spaceOrganization:c.spaceAccount).all(),1025);
  if(list.length===1025)return 'unrepresentable';
  for(const raw of list){
   const row=credentialRow(raw,organization);
   let p:Policy|null;try{p=policy(row);}catch{return 'unrepresentable';}
   if(p===null||row.expiresAt<=c.issuedAt||row.accountDisabledAt!==null)continue;
   if(p.spaceIds!==null&&!p.spaceIds.includes(c.spaceId))continue;
   const canSearch=p.capabilities.includes('read');
   let canIngest=false,expiresAt=row.expiresAt;
   if(!organization)canIngest=p.capabilities.includes('create')&&row.permission==='write';
   else{
    if(row.membershipExpiresAt===null||row.membershipExpiresAt<=c.issuedAt||row.emailVerifiedAt===null||row.emailVerifiedAt>c.issuedAt
     ||row.accountDisabledAt!==null||row.organizationDisabledAt!==null)continue;
    canIngest=p.capabilities.includes('create')&&row.permission==='write'&&(row.membershipRole==='owner'||row.membershipRole==='admin');
    expiresAt=Math.min(expiresAt,row.membershipExpiresAt);
   }
   if(!canSearch&&!canIngest)continue;
   granted.push({row,policy:p,canSearch,canIngest,expiresAt});
  }
 }
 // Excluded accounts can never be represented; refuse rather than publish an
 // incomplete positive graph. The owner account is always needed on a
 // personal Space even when no grant survives eligibility.
 const accountIds=new Set<string>(c.spaceAccount===null?[]:[c.spaceAccount]);
 for(const g of granted)accountIds.add(g.row.accountId);
 if(accountIds.size){
  const excluded=rows(await database.withSession('first-primary').prepare(EXCLUSIONS).bind(JSON.stringify([...accountIds])).all(),4097);
  if(excluded.length)return 'account_excluded';
 }
 const accounts=rows(await database.withSession('first-primary').prepare(ACCOUNTS).bind(JSON.stringify([...accountIds])).all(),4097);
 const accountRows=new Map(accounts.map(raw=>{const x=own(raw,['id','disabled_at']);return [text(x.id,256),nullableInteger(x.disabled_at)] as const;}));
 for(const id of accountIds)if(!accountRows.has(id))return 'dependency_missing';
 const identities=rows(await database.withSession('first-primary').prepare(IDENTITIES).bind(JSON.stringify([...accountIds])).all(),4097);
 if(identities.length===4097)return 'unrepresentable';
 const identityRows=identities.map(raw=>{const x=own(raw,['issuer','subject','account_id','created_at']);return {issuer:text(x.issuer,2048),subject:text(x.subject,1024),accountId:text(x.account_id,256),createdAt:integer(x.created_at)};});
 for(const id of accountIds)if(!identityRows.some(i=>i.accountId===id))return 'unrepresentable';
 if(identityRows.some(i=>i.issuer!==ISSUER))return 'unrepresentable';
 const organizationRow=organization?own(await database.withSession('first-primary').prepare(ORGANIZATION_ROW).bind(c.spaceOrganization).first()??{},['id','disabled_at']):null;
 const organizationDisabledAt=organization?nullableInteger(organizationRow!.disabled_at):null;
 // Pin every dependency head the codec contract requires.
 const needed=new Map<string,{kind:string;key:string}>();
 const need=(kind:string,key:string)=>{if(utf8.encode(key).length>2048)fail();needed.set(JSON.stringify([kind,key]),{kind,key});};
 try{
  for(const g of granted){
   need('credential',g.row.id);need('space',c.spaceId);need('target',c.spaceId);
   const address=organization?g.row.emailAddress:null;
   for(const i of identityRows.filter(i=>i.accountId===g.row.accountId)){
    need('subject',ISSUER+'\n'+i.subject);
    if(address!==null)need('email',ISSUER+'\n'+i.subject+'\n'+address);
   }
   if(organization){need('membership',g.row.membershipId!);need('organization',c.spaceOrganization!);}
  }
 }catch{return 'unrepresentable';}
 if(needed.size>8192)return 'unrepresentable';
 const headRows=needed.size?rows(await database.withSession('first-primary').prepare(HEADS).bind(JSON.stringify([...needed.values()].map(h=>h.key))).all(),8193):[];
 const heads=new Map<string,{kind:SeoulHead['kind'];key:string;revision:number;eventId:string;payloadSha256:string|null}>();
 for(const raw of headRows){
  const x=own(raw,['stream_kind','stream_key','revision','event_id','payload_sha256','source_kind']);
  const kind=text(x.stream_kind,16) as SeoulHead['kind'],key=text(x.stream_key,2048),mapKey=JSON.stringify([kind,key]);
  if(!needed.has(mapKey))continue;
  if(x.source_kind!==null&&text(x.source_kind,64)==='subject-source-unrepresentable')return 'unrepresentable';
  heads.set(mapKey,Object.freeze({kind,key,revision:integer(x.revision,1),eventId:text(x.event_id,36),payloadSha256:nullableDigest(x.payload_sha256)}));
 }
 for(const {kind,key} of needed.values()){
  const h=heads.get(JSON.stringify([kind,key]));
  if(!h)return 'dependency_missing';
  if(h.payloadSha256===null)return 'heads_pending';
 }
 const headOf=(kind:string,key:string):SeoulHead=>{const h=heads.get(JSON.stringify([kind,key]));if(!h||h.payloadSha256===null)fail();return {kind:h.kind,key:h.key,revision:h.revision,eventId:h.eventId,payloadSha256:h.payloadSha256};};
 const identityVector=(accountId:string)=>identityRows.filter(i=>i.accountId===accountId).map(i=>i.subject).sort(compare);
 type El<K extends keyof SeoulAuthoritySnapshot>=SeoulAuthoritySnapshot[K] extends readonly(infer T)[]?T:never;
 const snapshot:SeoulAuthoritySnapshot={
  version:3,kind:'seoul-authority-snapshot',eventId:c.eventId,sourceRevision:c.sourceRevision,snapshotSeq:c.snapshotSeq,
  issuer:ISSUER,spaceId:c.spaceId,selected:c.selected,
  accounts:[...accountIds].sort(compare).map((id):El<'accounts'>=>({id,disabledAtMs:accountRows.get(id)!})),
  providerIdentities:identityRows.map((i):El<'providerIdentities'>=>({issuer:ISSUER,subject:i.subject,accountId:i.accountId,createdAtMs:i.createdAt})).sort((a,b)=>compare(a.issuer,b.issuer)||compare(a.subject,b.subject)||compare(a.accountId,b.accountId)),
  emails:[...new Map(granted.filter(g=>g.row.emailId!==null).map(g=>[g.row.emailId!,{id:g.row.emailId!,accountId:g.row.accountId,address:g.row.emailAddress!,verifiedAtMs:g.row.emailVerifiedAt!,revokedAtMs:null} as El<'emails'>] as const)).values()].sort((a,b)=>compare(a.id,b.id)),
  organizations:organization?[{id:c.spaceOrganization!,disabledAtMs:organizationDisabledAt}]:[],
  memberships:[...new Map(granted.filter(g=>g.row.membershipId!==null).map(g=>[g.row.membershipId!,{id:g.row.membershipId!,accountId:g.row.accountId,emailId:g.row.emailId!,organizationId:c.spaceOrganization!,role:g.row.membershipRole as 'owner'|'admin'|'member',expiresAtMs:g.row.membershipExpiresAt!,revokedAtMs:null} as El<'memberships'>] as const)).values()].sort((a,b)=>compare(a.id,b.id)),
  credentials:granted.map((g):El<'credentials'>=>({id:g.row.id,accountId:g.row.accountId,kind:organization?'api_key':'personal_key',permission:g.row.permission,tokenDigest:g.row.tokenDigest,membershipId:g.row.membershipId,emailId:g.row.emailId,expiresAtMs:g.row.expiresAt,revokedAtMs:null})).sort((a,b)=>compare(a.id,b.id)),
  credentialPolicies:granted.map((g):El<'credentialPolicies'>=>({credentialId:g.row.id,capabilities:[...g.policy.capabilities],spaceIds:g.policy.spaceIds===null?null:[...g.policy.spaceIds]})).sort((a,b)=>compare(a.credentialId,b.credentialId)),
  spaces:[{id:c.spaceId,accountId:c.spaceAccount,organizationId:c.spaceOrganization,disabledAtMs:c.spaceDisabledAt,policy:SPACE_POLICY as SeoulAuthoritySnapshot['spaces'][number]['policy']}],
  grants:granted.map((g):El<'grants'>=>{
   const subjects=identityVector(g.row.accountId).map(s=>headOf('subject',ISSUER+'\n'+s)).sort((a,b)=>compare(a.key,b.key));
   const emails=g.row.emailAddress===null?null:identityVector(g.row.accountId).map(s=>headOf('email',ISSUER+'\n'+s+'\n'+g.row.emailAddress!)).sort((a,b)=>compare(a.key,b.key));
   return {credentialId:g.row.id,accountId:g.row.accountId,spaceId:c.spaceId,provenance:organization?'organization-member':'owner',
    canIngest:g.canIngest,canSearch:g.canSearch,canErase:false,canRetire:false,expiresAtMs:g.expiresAt,revokedAtMs:null,
    heads:{subjects,emails,organization:organization?headOf('organization',c.spaceOrganization!):null,membership:organization?headOf('membership',g.row.membershipId!):null,credential:headOf('credential',g.row.id),space:headOf('space',c.spaceId),target:headOf('target',c.spaceId)}};
  }).sort((a,b)=>compare(a.credentialId,b.credentialId)),
  lease:{issuedAtMs:c.issuedAt,expiresAtMs:c.issuedAt+LEASE_MS},
 };
 let payload:string;
 try{payload=utf8dec.decode(encodeSeoulAuthoritySnapshot(snapshot));}catch{return 'unrepresentable';}
 return Object.freeze({payload,sha256:await digest(payload)});
}

function claimPlans(spaceId:string,fence:string):readonly Statement[]{
 // t.n pins one database-time scalar per statement so claimed_at and
 // expires_at always satisfy the lock CHECK (expires<=claimed+LOCK_MS).
 return [
  statement(`WITH t(n) AS (SELECT ${now})
   INSERT INTO release_seoul_projection_lock(space_id,fence_token,claimed_revision,claimed_at,expires_at)
   SELECT d.space_id,?,d.dirty_revision,t.n,t.n+${LOCK_MS} FROM release_seoul_dirty_spaces d,t
   WHERE d.space_id=? AND NOT EXISTS(SELECT 1 FROM release_seoul_projection_lock l WHERE l.space_id=d.space_id)`,[fence,spaceId]),
  statement(`WITH t(n) AS (SELECT ${now})
   UPDATE release_seoul_projection_lock SET fence_token=?,claimed_revision=(SELECT dirty_revision FROM release_seoul_dirty_spaces WHERE space_id=?),claimed_at=t.n,expires_at=t.n+${LOCK_MS}
   FROM t WHERE space_id=? AND expires_at<=t.n`,[fence,spaceId,spaceId]),
  statement(`SELECT CASE WHEN EXISTS(SELECT 1 FROM release_seoul_projection_lock WHERE space_id=? AND fence_token=? AND expires_at>${now}) THEN 1 ELSE abs(-9223372036854775808) END complete_guard`,[spaceId,fence]),
 ];
}

const stageColumns='token,event_id,space_id,snapshot_seq,source_revision,issued_at,expires_at,payload_bytes,payload_sha256,fence_token,claimed_at,lock_expires_at,target_revision,target_selected,eligible';
function publishPlans(c:Candidate,payload:string,sha256:string,token:string):readonly Statement[]{
 const eligible=`CASE WHEN
  EXISTS(SELECT 1 FROM release_seoul_projection_lock l JOIN release_seoul_dirty_spaces d ON d.space_id=l.space_id
   WHERE l.space_id=v.space_id AND l.fence_token=v.fence_token AND l.claimed_at=v.claimed_at AND l.claimed_revision=v.source_revision
   AND l.expires_at=v.lock_expires_at AND l.expires_at>${now} AND d.dirty_revision=v.source_revision)
  AND (SELECT revision FROM release_seoul_targets WHERE space_id=v.space_id) IS v.target_revision
  AND (SELECT selected FROM release_seoul_targets WHERE space_id=v.space_id) IS v.target_selected
  AND coalesce((SELECT snapshot_seq FROM release_seoul_published_snapshots WHERE space_id=v.space_id),0)+1=v.snapshot_seq
  AND NOT EXISTS(SELECT 1 FROM release_seoul_authority_heads WHERE payload_sha256 IS NULL)
  AND NOT EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE e.event_id=v.event_id)
  AND ${headsCurrent} AND ${baseCurrent} THEN 1 ELSE 0 END`;
 return [
  statement(`INSERT INTO ${S}(${stageColumns}) SELECT v.*,${eligible} FROM (SELECT ? token,? event_id,? space_id,? snapshot_seq,? source_revision,? issued_at,? expires_at,? payload_bytes,? payload_sha256,? fence_token,? claimed_at,? lock_expires_at,? target_revision,? target_selected) v`,
   [token,c.eventId,c.spaceId,c.snapshotSeq,c.sourceRevision,c.issuedAt,c.issuedAt+LEASE_MS,payload,sha256,c.fence,c.issuedAt,c.lockExpiresAt,c.targetRevision,c.targetSelected]),
  statement(`INSERT INTO release_seoul_projection_events(event_id,source_revision,event_kind,stream_kind,stream_key,source_sha256,space_id,snapshot_seq,issued_at,expires_at,payload_bytes,payload_sha256)
   SELECT s.event_id,s.source_revision,'snapshot',NULL,NULL,NULL,s.space_id,s.snapshot_seq,s.issued_at,s.expires_at,s.payload_bytes,s.payload_sha256 FROM ${S} s WHERE s.token=? AND s.eligible=1`,[token]),
  statement(`INSERT INTO release_seoul_projection_deliveries(event_id) SELECT s.event_id FROM ${S} s WHERE s.token=? AND s.eligible=1 AND ${eventExact('s')}`,[token]),
  statement(`INSERT INTO release_seoul_published_snapshots(space_id,snapshot_seq,event_id,payload_sha256) SELECT s.space_id,s.snapshot_seq,s.event_id,s.payload_sha256 FROM ${S} s WHERE s.token=? AND s.eligible=1 AND ${eventExact('s')}
   AND NOT EXISTS(SELECT 1 FROM release_seoul_published_snapshots p WHERE p.space_id=s.space_id)`,[token]),
  // One published watermark row per Space: later sequences advance it under
  // the schema's monotonic/consecutive triggers rather than inserting again.
  statement(`UPDATE release_seoul_published_snapshots AS p SET snapshot_seq=s.snapshot_seq,event_id=s.event_id,payload_sha256=s.payload_sha256 FROM ${S} s
   WHERE s.token=? AND s.eligible=1 AND p.space_id=s.space_id AND p.snapshot_seq=s.snapshot_seq-1 AND ${eventExact('s')}`,[token]),
  statement(`UPDATE release_seoul_dirty_spaces AS d SET captured_revision=s.source_revision FROM ${S} s
   WHERE s.token=? AND s.eligible=1 AND d.space_id=s.space_id AND d.dirty_revision=s.source_revision AND d.captured_revision<s.source_revision AND ${eventExact('s')} AND ${publishedExact('s')}`,[token]),
  statement(`UPDATE ${S} AS s SET complete_guard=CASE WHEN s.eligible=0 THEN 1 WHEN ${eventExact('s')} AND ${deliveryPresent('s')} AND ${publishedExact('s')} AND ${dirtyCaptured('s')} THEN 1 ELSE 0 END WHERE s.token=?`,[token]),
  // Consume the completion proof before removing the stage: an incomplete
  // publication must roll the batch back rather than commit partial state.
  statement(`SELECT complete_guard FROM ${S} WHERE token=?`,[token]),
  statement(`DELETE FROM ${S} WHERE token=?`,[token]),
 ];
}

function bounded(request:readonly Statement[]):boolean{
 return request.length<=100&&request.every(s=>s.values.length<=100&&utf8.encode(s.sql).length<=100000)
  &&utf8.encode(JSON.stringify({statements:request})).length+4096<=1048576;
}
async function batch(database:Database,plans:readonly Statement[],guards:readonly number[]):Promise<void>{
 if(!bounded(plans))throw Error('limit');
 const results=await database.batch(plans.map(p=>database.prepare(p.sql).bind(...p.values)));
 if(!Array.isArray(results)||results.length!==plans.length)throw Error();
 for(const i of guards){const list=rows(results[i],1);if(list.length!==1||own(list[0],['complete_guard']).complete_guard!==1)throw Error();}
}

function staleCheck(o:Observation,e:EventObservation,c:Candidate):Failure{
 if(o.stagePresent)return 'staging_retained';
 if(o.lockFence!==c.fence||o.lockClaimedAt!==c.issuedAt||o.lockExpiresAt!==c.lockExpiresAt||o.lockExpiresAt===null||o.lockExpiresAt<=o.observedAt)return 'fence_held';
 if(o.dirtyRevision!==c.sourceRevision||o.targetRevision!==c.targetRevision||o.targetSelected!==c.targetSelected)return 'stale';
 if(o.publishedSeq!==null&&o.publishedSeq>=c.snapshotSeq)return 'sequence_conflict';
 if(e.seqEventPresent)return 'stale';
 if((o.publishedSeq??0)!==c.snapshotSeq-1)return 'stale';
 if(o.headsPending)return 'heads_pending';
 return 'uncertain';
}

/** Explicit trusted same-database atomic composition only; the adapter label is
 * an assertion by the caller, not proof of arbitrary code. publish remains
 * inert without a dispatcher and cannot create regional authority by itself. */
export function createSeoulProjectionSnapshotStore(database:Database,adapter:'native-d1'|'durable-sql'):SeoulProjectionSnapshotStore{
 if(!database||typeof database.prepare!=='function'||typeof database.batch!=='function'||typeof database.withSession!=='function'||(adapter!=='native-d1'&&adapter!=='durable-sql'))throw Error('seoul_snapshot_store_adapter_unsupported');
 return Object.freeze({async publish(value:unknown):Promise<SeoulSnapshotPublishResult>{
  let spaceId:string;
  try{spaceId=spaceIdOf(own(value,['spaceId']).spaceId);}catch{return{status:'invalid_input'};}
  let schemaVersion:number;
  try{schemaVersion=integer(own(await database.withSession('first-primary').prepare('SELECT version FROM release_meta').first(),['version']).version,1);}
  catch{return{status:'uncertain'};}
  if(schemaVersion<36)return{status:'schema_missing'};
  let before:Observation;
  try{before=await observe(database,spaceId);}catch{return{status:'uncertain'};}
  if(before.stagePresent)return{status:'staging_retained'};
  if(!before.spacePresent)return{status:'space_missing'};
  if(!before.spaceManaged)return{status:'space_invalid'};
  if(before.dirtyRevision===null)return{status:'not_dirty'};
  if(before.headsPending)return{status:'heads_pending'};
  const fence=crypto.randomUUID().replaceAll('-','');
  let claim:Observation;
  try{await batch(database,claimPlans(spaceId,fence),[2]);}
  catch{/* A lost claim acknowledgement still reads back the committed fence. */}
  try{claim=await observe(database,spaceId);}catch{return{status:'uncertain'};}
  if(claim.lockFence!==fence)return{status:claim.lockFence!==null&&claim.lockExpiresAt!==null&&claim.lockExpiresAt>claim.observedAt?'fence_held':'uncertain'};
  if(claim.lockClaimedAt===null||claim.lockExpiresAt===null||claim.lockClaimedRevision===null)return{status:'uncertain'};
  if(claim.lockExpiresAt<=claim.observedAt||claim.lockExpiresAt>claim.lockClaimedAt+LOCK_MS)return{status:'uncertain'};
  const candidate:Candidate=Object.freeze({
   spaceId,spaceAccount:claim.spaceAccount,spaceOrganization:claim.spaceOrganization,spaceDisabledAt:claim.spaceDisabledAt,
   selected:claim.targetSelected===1,targetRevision:claim.targetRevision,targetSelected:claim.targetSelected,
   sourceRevision:claim.lockClaimedRevision,snapshotSeq:(claim.publishedSeq??0)+1,issuedAt:claim.lockClaimedAt,lockExpiresAt:claim.lockExpiresAt,fence,eventId:crypto.randomUUID(),
  });
  let built:Built|Failure;
  try{built=await build(database,candidate);}catch{return{status:'uncertain'};}
  if(typeof built==='string')return{status:built};
  const token=crypto.randomUUID();
  const plans=publishPlans(candidate,built.payload,built.sha256,token);
  if(!bounded(plans))return{status:'request_limit'};
  try{await batch(database,plans,[7]);}
  catch{/* Lost ACK, rollback and a losing comparison all require readback. */}
  let event:EventObservation,after:Observation;
  try{event=await observeEvent(database,candidate,built.payload,built.sha256);after=await observe(database,spaceId);}
  catch{return{status:'uncertain'};}
  if(event.eventPresent&&!event.eventExact)return{status:'event_conflict'};
  // The immutable event, its delivery and the exact sequence row are the
  // publication proof. A dirty advance after the commit is a new change, not
  // evidence that this publish lost its acknowledgement.
  if(event.eventExact&&event.deliveryPresent&&event.publishedExact&&after.capturedRevision!==null&&after.capturedRevision>=candidate.sourceRevision)
   return{status:'published',spaceId,snapshotSeq:candidate.snapshotSeq,eventId:candidate.eventId,sourceRevision:candidate.sourceRevision,issuedAtMs:candidate.issuedAt,expiresAtMs:candidate.issuedAt+LEASE_MS,payloadSha256:built.sha256};
  const status=staleCheck(after,event,candidate);
  if(status!=='uncertain')return{status};
  // One terminal-cause check before reporting an indeterminate outcome: an
  // account excluded between the build read and the batch is a refusal, not
  // an unknown result.
  try{
   const x=own(await database.withSession('first-primary').prepare("SELECT EXISTS(SELECT 1 FROM json_each(?,'$.accounts') a JOIN release_seoul_account_exclusions e ON e.account_id=json_extract(a.value,'$.id')) excluded").bind(built.payload).first(),['excluded']);
   if(flag(x.excluded))return{status:'account_excluded'};
  }catch{/* keep uncertain */}
  return{status};
 }});
}

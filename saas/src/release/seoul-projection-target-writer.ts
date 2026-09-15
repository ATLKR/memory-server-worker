import type {Database,Value} from './types.ts';
import {prepareSeoulHeadCandidate,type SeoulHeadCandidate} from './seoul-projection-source-codec.ts';

export type SeoulTargetCommand=Readonly<{commandId:string;spaceId:string;expectedRevision:number|null;selected:boolean;operatorReference:string}>;
export type SeoulTargetReceipt=Readonly<SeoulTargetCommand&{outcome:'changed'|'unchanged';resultingRevision:number;resultingEventId:string;decidedAtMs:number}>;
type Failure='invalid_command'|'command_conflict'|'target_missing'|'target_state_invalid'|'stale_revision'|'staging_retained'|'request_limit'|'uncertain';
export type SeoulTargetResult={status:'committed'|'already_committed';receipt:SeoulTargetReceipt}|{status:Failure};
export interface SeoulProjectionTargetWriter{setTarget(command:unknown):Promise<SeoulTargetResult>}
type Plan={sql:string;values:Value[];mode:'all'};
type Decision='changed'|'unchanged'|'already_committed'|'command_conflict'|'target_missing'|'target_state_invalid'|'stale_revision';
const utf8=new TextEncoder(),commandKeys=['commandId','spaceId','expectedRevision','selected','operatorReference'] as const;
const receiptKeys=[...commandKeys,'outcome','resultingRevision','resultingEventId','decidedAtMs'] as const;
const failures=['command_conflict','target_missing','target_state_invalid','stale_revision'] as const;
const priorColumns=['prior_revision','prior_selected','prior_event_id','prior_source_command_id','prior_record_bytes','prior_created_at','prior_source_sha256','prior_transport_sha256','prior_payload_bytes','prior_changed_receipt_bytes'] as const;
const commandColumns='command_id,space_id,expected_revision,selected,operator_reference';
const body=(space:string,selected:string,time:string,command:string)=>`json_object('version',3,'kind','target-source','spaceId',${space},'selected',json(CASE WHEN ${selected}=1 THEN 'true' ELSE 'false' END),'changedAtMs',${time},'origin',json_object('kind','command','commandType','target-reconcile','receiptId',${command}),'effect',json(CASE WHEN ${selected}=1 THEN json_object('type','entity-head','disposition','changed') ELSE json_object('type','entity-negative','entityKind','target','entityId',${space},'state','removed','occurredAtMs',${time}) END))`;
const receiptJson=(r:string)=>`json_object('commandId',${r}.command_id,'spaceId',${r}.space_id,'expectedRevision',${r}.expected_revision,'selected',json(CASE WHEN ${r}.selected=1 THEN 'true' ELSE 'false' END),'operatorReference',${r}.operator_reference,'outcome',${r}.outcome,'resultingRevision',${r}.resulting_revision,'resultingEventId',${r}.resulting_event_id,'decidedAtMs',${r}.decided_at)`;
const inputExact=(r:string,v:string)=>`${r}.command_id=${v}.command_id AND ${r}.space_id=${v}.space_id AND ${r}.expected_revision IS ${v}.expected_revision AND ${r}.selected=${v}.selected AND ${r}.operator_reference=${v}.operator_reference`;
// Historical proof uses only immutable indexed source/receipt joins. It does
// not require today's target/head or a preflight digest of a raced winner.
const history=(r:string)=>`EXISTS(SELECT 1 FROM release_seoul_authority_changes c JOIN release_seoul_target_receipts original ON original.command_id=c.source_command_id
 WHERE c.revision=${r}.resulting_revision AND c.event_id=${r}.resulting_event_id AND c.stream_kind='target' AND c.stream_key=${r}.space_id
 AND c.record_bytes=${body(r+'.space_id',r+'.selected','c.created_at','c.source_command_id')}
 AND original.outcome='changed' AND original.space_id=${r}.space_id AND original.selected=${r}.selected AND original.resulting_revision=c.revision AND original.resulting_event_id=c.event_id AND original.decided_at=c.created_at
 AND ((${r}.outcome='changed' AND ${r}.command_id=c.source_command_id AND ${r}.decided_at=c.created_at AND (${r}.expected_revision IS NULL OR ${r}.expected_revision<c.revision))
 OR (${r}.outcome='unchanged' AND ${r}.expected_revision=c.revision AND ${r}.command_id<>c.source_command_id)))`;
const currentLineage=(v:string)=>`EXISTS(SELECT 1 FROM release_seoul_targets t JOIN release_seoul_authority_heads h ON h.stream_kind='target' AND h.stream_key=t.space_id AND h.revision=t.revision
 JOIN release_seoul_authority_changes c ON c.revision=t.revision AND c.event_id=h.event_id JOIN release_seoul_target_receipts original ON original.command_id=c.source_command_id
 WHERE t.space_id=${v}.space_id AND c.stream_kind='target' AND c.stream_key=t.space_id AND c.record_bytes=${body('t.space_id','t.selected','c.created_at','c.source_command_id')}
 AND original.outcome='changed' AND original.space_id=t.space_id AND original.selected=t.selected AND original.resulting_revision=c.revision AND original.resulting_event_id=c.event_id AND original.decided_at=c.created_at)`;
const scalar=(select:string)=>`(${select} LIMIT 1)`;
const targetScalar=(field:string,v:string)=>scalar(`SELECT ${field} FROM release_seoul_targets WHERE space_id=${v}.space_id`);
const headScalar=(field:string,v:string)=>scalar(`SELECT ${field} FROM release_seoul_authority_heads WHERE stream_kind='target' AND stream_key=${v}.space_id`);
const dirtyScalar=(field:string,v:string)=>scalar(`SELECT ${field} FROM release_seoul_dirty_spaces WHERE space_id=${v}.space_id`);
const commandSource=(field:string,v:string)=>scalar(`SELECT ${field} FROM release_seoul_authority_changes WHERE source_command_id=${v}.command_id AND stream_kind='target' AND stream_key=${v}.space_id`);
const commandReceipt=(v:string)=>scalar(`SELECT ${receiptJson('r')} FROM release_seoul_target_receipts r WHERE r.command_id=${v}.command_id`);
const commandSourcePresent=(v:string)=>`EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE source_command_id=${v}.command_id AND stream_kind='target' LIMIT 1)`;
const sourceRow=(c:string)=>`json_object('revision',${c}.revision,'source_command_id',${c}.source_command_id,'stream_kind',${c}.stream_kind,'stream_key',${c}.stream_key,'event_id',${c}.event_id,'record_bytes',${c}.record_bytes,'created_at',${c}.created_at)`;
const OBSERVE=`WITH v(${commandColumns}) AS (VALUES(?,?,?,?,?)) SELECT
 EXISTS(SELECT 1 FROM release_seoul_target_attempt LIMIT 1) stage_present,
 EXISTS(SELECT 1 FROM spaces WHERE id=v.space_id) space_present,
 ${commandReceipt('v')} receipt_bytes,
 EXISTS(SELECT 1 FROM release_seoul_target_receipts r WHERE r.command_id=v.command_id AND ${history('r')}) receipt_valid,
 ${commandSourcePresent('v')} command_source_present,
 ${targetScalar('revision','v')} target_revision,${targetScalar('selected','v')} target_selected,
 ${headScalar('revision','v')} head_revision,${headScalar('event_id','v')} head_event_id,${headScalar('payload_sha256','v')} head_digest,
 ${currentLineage('v')} current_valid,
 CASE WHEN ${currentLineage('v')} THEN ${scalar(`SELECT ${sourceRow('c')} FROM release_seoul_authority_changes c WHERE c.revision=${targetScalar('revision','v')} AND length(CAST(c.record_bytes AS BLOB))<=131072`)} ELSE NULL END source_bytes,
 ${scalar(`SELECT ${receiptJson('r')} FROM release_seoul_target_receipts r WHERE r.command_id=${scalar(`SELECT source_command_id FROM release_seoul_authority_changes WHERE revision=${targetScalar('revision','v')}`)}`)} original_receipt_bytes,
 ${scalar(`SELECT source_sha256 FROM release_seoul_prepared_sources WHERE revision=${targetScalar('revision','v')}`)} prepared_source_sha256,
 ${scalar(`SELECT transport_sha256 FROM release_seoul_prepared_sources WHERE revision=${targetScalar('revision','v')}`)} prepared_transport_sha256,
 ${scalar(`SELECT payload_bytes FROM release_seoul_projection_events WHERE event_id=${headScalar('event_id','v')} AND length(CAST(payload_bytes AS BLOB))<=131072`)} prepared_payload_bytes,
 EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE e.event_id=${headScalar('event_id','v')} AND e.source_revision=${targetScalar('revision','v')} AND e.event_kind='head' AND e.stream_kind='target' AND e.stream_key=v.space_id AND e.space_id IS NULL AND e.snapshot_seq IS NULL AND e.issued_at IS NULL AND e.expires_at IS NULL AND e.source_sha256=${scalar(`SELECT source_sha256 FROM release_seoul_prepared_sources WHERE revision=${targetScalar('revision','v')}`)} AND e.payload_sha256=${scalar(`SELECT transport_sha256 FROM release_seoul_prepared_sources WHERE revision=${targetScalar('revision','v')}`)}) prepared_event_valid,
 EXISTS(SELECT 1 FROM release_seoul_projection_deliveries WHERE event_id=${headScalar('event_id','v')}) prepared_delivery_present FROM v`;
const flagKeys=['stage_present','space_present','receipt_valid','command_source_present','current_valid','prepared_event_valid','prepared_delivery_present'] as const;
const numberKeys=['target_revision','target_selected','head_revision'] as const;
const textKeys=['receipt_bytes','head_event_id','head_digest','source_bytes','original_receipt_bytes','prepared_source_sha256','prepared_transport_sha256','prepared_payload_bytes'] as const;
type Observation=Record<typeof flagKeys[number],0|1>&Record<typeof numberKeys[number],number|null>&Record<typeof textKeys[number],string|null>;
function own(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))throw Error();
 const actual=Reflect.ownKeys(value);if(actual.length!==keys.length||actual.some(k=>typeof k!=='string'||!keys.includes(k)))throw Error();const result=Object.create(null) as Record<string,unknown>;
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!('value'in d))throw Error();result[key]=d.value;}return result;
}
function integer(v:unknown,min=0):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||Object.is(v,-0)||v<min)throw Error();return v;}
function identifier(v:unknown,max:number):string{if(typeof v!=='string'||v.length>max||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v))throw Error();return v;}
function uuid(v:unknown):string{if(typeof v!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))throw Error();return v;}
function commandFrom(x:Record<string,unknown>):SeoulTargetCommand{if(typeof x.selected!=='boolean')throw Error();return Object.freeze({commandId:uuid(x.commandId),spaceId:identifier(x.spaceId,128),expectedRevision:x.expectedRevision===null?null:integer(x.expectedRevision,1),selected:x.selected,operatorReference:identifier(x.operatorReference,256)});}
function parseReceipt(text:string):SeoulTargetReceipt{if(!text||text.length>2048||utf8.encode(text).length>2048)throw Error();const x=own(JSON.parse(text),receiptKeys),c=commandFrom(x);if(x.outcome!=='changed'&&x.outcome!=='unchanged')throw Error();const revision=integer(x.resultingRevision,1);if(x.outcome==='unchanged'?c.expectedRevision!==revision:c.expectedRevision!==null&&revision<=c.expectedRevision)throw Error();const result=Object.freeze({...c,outcome:x.outcome,resultingRevision:revision,resultingEventId:uuid(x.resultingEventId),decidedAtMs:integer(x.decidedAtMs)});if(JSON.stringify(result)!==text)throw Error();return result;}
const matches=(r:SeoulTargetReceipt,c:SeoulTargetCommand)=>commandKeys.every(k=>r[k]===c[k]);
const inputValues=(c:SeoulTargetCommand):Value[]=>[c.commandId,c.spaceId,c.expectedRevision,Number(c.selected),c.operatorReference];
async function observe(database:Database,c:SeoulTargetCommand):Promise<Observation>{
 const x=own(await database.withSession('first-primary').prepare(OBSERVE).bind(...inputValues(c)).first(),[...flagKeys,...numberKeys,...textKeys]);
 for(const key of flagKeys)if((x[key]!==0&&x[key]!==1)||Object.is(x[key],-0))throw Error();for(const key of numberKeys)if(x[key]!==null)integer(x[key],key==='target_selected'?0:1);
 if(x.target_selected!==null&&x.target_selected!==0&&x.target_selected!==1)throw Error();for(const key of textKeys)if(x[key]!==null&&(typeof x[key]!=='string'||!x[key].length||x[key].length>270000||utf8.encode(x[key]).length>270000))throw Error();
 if((x.receipt_bytes===null&&x.receipt_valid===1)||(x.target_revision===null)!==(x.target_selected===null)||(x.head_revision===null)!==(x.head_event_id===null)||(x.head_digest!==null&&x.head_revision===null)||(x.current_valid===1&&(x.source_bytes===null||x.original_receipt_bytes===null||x.target_revision===null)))throw Error();return x as Observation;
}
const currentExact=(s:string)=>`EXISTS(SELECT 1 FROM release_seoul_targets t JOIN release_seoul_authority_heads h ON h.stream_kind='target' AND h.stream_key=t.space_id AND h.revision=t.revision JOIN release_seoul_authority_changes c ON c.revision=t.revision AND c.event_id=h.event_id JOIN release_seoul_target_receipts original ON original.command_id=c.source_command_id
 WHERE t.space_id=${s}.space_id AND t.revision=${s}.prior_revision AND t.selected=${s}.prior_selected AND c.source_command_id=${s}.prior_source_command_id AND c.stream_kind='target' AND c.stream_key=${s}.space_id AND c.event_id=${s}.prior_event_id AND c.record_bytes=${s}.prior_record_bytes AND c.created_at=${s}.prior_created_at
 AND original.outcome='changed' AND original.resulting_revision=c.revision AND original.resulting_event_id=c.event_id AND original.space_id=t.space_id AND original.selected=t.selected AND original.decided_at=c.created_at AND ${receiptJson('original')}=${s}.prior_changed_receipt_bytes
 AND (h.payload_sha256 IS NULL OR (h.payload_sha256=${s}.prior_source_sha256 AND EXISTS(SELECT 1 FROM release_seoul_prepared_sources p JOIN release_seoul_projection_events e ON e.event_id=p.event_id JOIN release_seoul_projection_deliveries delivery ON delivery.event_id=e.event_id
 WHERE p.revision=c.revision AND p.event_id=c.event_id AND p.source_sha256=${s}.prior_source_sha256 AND p.transport_sha256=${s}.prior_transport_sha256 AND e.source_revision=c.revision AND e.event_kind='head' AND e.stream_kind='target' AND e.stream_key=${s}.space_id AND e.source_sha256=p.source_sha256 AND e.payload_sha256=p.transport_sha256 AND e.payload_bytes=${s}.prior_payload_bytes AND e.space_id IS NULL AND e.snapshot_seq IS NULL AND e.issued_at IS NULL AND e.expires_at IS NULL))))`;
const stageObservations=(v:string)=>`${commandReceipt(v)} observed_command_receipt_bytes,EXISTS(SELECT 1 FROM spaces WHERE id=${v}.space_id) observed_space_present,${commandSourcePresent(v)} observed_command_source_present,
 ${dirtyScalar('dirty_revision',v)} prior_dirty_revision,${dirtyScalar('captured_revision',v)} prior_captured_revision,
 ${targetScalar('revision',v)} observed_target_revision,${targetScalar('selected',v)} observed_target_selected,${headScalar('revision',v)} observed_head_revision,${headScalar('event_id',v)} observed_head_event_id,${headScalar('payload_sha256',v)} observed_head_digest,
 ${commandSource('revision',v)} observed_source_revision,${commandSource('event_id',v)} observed_source_event_id,${commandSource('stream_key',v)} observed_source_stream_key,${commandSource('record_bytes',v)} observed_source_record_bytes,${commandSource('created_at',v)} observed_source_created_at`;
const observedColumns=['observed_command_receipt_bytes','observed_space_present','observed_command_source_present','prior_dirty_revision','prior_captured_revision','observed_target_revision','observed_target_selected','observed_head_revision','observed_head_event_id','observed_head_digest','observed_source_revision','observed_source_event_id','observed_source_stream_key','observed_source_record_bytes','observed_source_created_at'];
const unchangedDirty=(s:string)=>`${dirtyScalar('dirty_revision',s)} IS ${s}.prior_dirty_revision AND ${dirtyScalar('captured_revision',s)} IS ${s}.prior_captured_revision`;
const unchangedObserved=(s:string)=>`${commandReceipt(s)} IS ${s}.observed_command_receipt_bytes AND EXISTS(SELECT 1 FROM spaces WHERE id=${s}.space_id)=${s}.observed_space_present AND ${commandSourcePresent(s)}=${s}.observed_command_source_present
 AND ${targetScalar('revision',s)} IS ${s}.observed_target_revision AND ${targetScalar('selected',s)} IS ${s}.observed_target_selected AND ${headScalar('revision',s)} IS ${s}.observed_head_revision AND ${headScalar('event_id',s)} IS ${s}.observed_head_event_id AND ${headScalar('payload_sha256',s)} IS ${s}.observed_head_digest
 AND ${commandSource('revision',s)} IS ${s}.observed_source_revision AND ${commandSource('event_id',s)} IS ${s}.observed_source_event_id AND ${commandSource('stream_key',s)} IS ${s}.observed_source_stream_key AND ${commandSource('record_bytes',s)} IS ${s}.observed_source_record_bytes AND ${commandSource('created_at',s)} IS ${s}.observed_source_created_at AND ${unchangedDirty(s)}`;
const newSource=(c:string,s:string)=>`${c}.source_command_id=${s}.command_id AND ${c}.stream_kind='target' AND ${c}.stream_key=${s}.space_id AND ${c}.event_id=${s}.new_event_id AND ${c}.created_at=${s}.decided_at AND ${c}.record_bytes=${body(s+'.space_id',s+'.selected',s+'.decided_at',s+'.command_id')}`;
function plans(c:SeoulTargetCommand,candidate:SeoulHeadCandidate|null,originalReceipt:string|null):Plan[]{
 const token=crypto.randomUUID(),event=crypto.randomUUID(),prior:Value[]=candidate?[candidate.rowGuard.revision,Number(JSON.parse(candidate.rowGuard.record_bytes).selected),candidate.rowGuard.event_id,candidate.rowGuard.source_command_id,candidate.rowGuard.record_bytes,candidate.rowGuard.created_at,candidate.sourceChangeSha256,candidate.transportPayloadSha256,candidate.eventText,originalReceipt]:Array<Value>(10).fill(null);
 const inputColumns=`token,${commandColumns},new_event_id,prior_state,${priorColumns.join(',')}`;
 const decision=`CASE WHEN o.observed_command_receipt_bytes IS NOT NULL THEN CASE WHEN EXISTS(SELECT 1 FROM release_seoul_target_receipts r WHERE ${inputExact('r','o')}) THEN CASE WHEN EXISTS(SELECT 1 FROM release_seoul_target_receipts r WHERE r.command_id=o.command_id AND ${history('r')}) THEN 'already_committed' ELSE 'target_state_invalid' END ELSE 'command_conflict' END
 WHEN o.observed_space_present=0 THEN 'target_missing' WHEN o.observed_command_source_present=1 THEN 'target_state_invalid'
 WHEN (o.observed_target_revision IS NULL)!=(o.observed_head_revision IS NULL) THEN 'target_state_invalid'
 WHEN o.observed_target_revision IS NULL THEN CASE WHEN o.expected_revision IS NOT NULL THEN 'stale_revision' WHEN o.prior_state<>'absent' THEN 'target_state_invalid' ELSE 'changed' END
 WHEN NOT ${currentLineage('o')} THEN 'target_state_invalid' WHEN o.observed_target_revision IS NOT o.expected_revision THEN 'stale_revision'
 WHEN o.prior_state<>'present' OR NOT ${currentExact('o')} THEN 'target_state_invalid' WHEN o.observed_target_selected=o.selected THEN 'unchanged' ELSE 'changed' END`;
 const result:Plan[]=[];const add=(sql:string,values:Value[]=[token])=>result.push({sql,values,mode:'all'});
 add(`INSERT INTO release_seoul_target_attempt(${inputColumns},decided_at,decision,eligible,${observedColumns.join(',')})
 WITH v(${inputColumns}) AS (VALUES(${Array(18).fill('?').join(',')})),o AS MATERIALIZED(SELECT v.*,CAST(round(unixepoch('subsec')*1000) AS INTEGER) decided_at,${stageObservations('v')} FROM v),d AS MATERIALIZED(SELECT o.*,${decision} decision FROM o)
 SELECT ${inputColumns},decided_at,decision,CASE WHEN decision IN ('changed','unchanged') THEN 1 ELSE 0 END,${observedColumns.join(',')} FROM d`,[token,...inputValues(c),event,candidate?'present':'absent',...prior]);
 add(`INSERT INTO release_seoul_authority_changes(source_command_id,stream_kind,stream_key,event_id,record_bytes,created_at)
 SELECT s.command_id,'target',s.space_id,s.new_event_id,${body('s.space_id','s.selected','s.decided_at','s.command_id')},s.decided_at FROM release_seoul_target_attempt s WHERE s.token=? AND s.eligible=1 AND s.decision='changed'
 AND NOT EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE event_id=s.new_event_id) AND NOT EXISTS(SELECT 1 FROM release_seoul_projection_events WHERE event_id=s.new_event_id)`);
 add(`INSERT INTO release_seoul_target_receipts(command_id,space_id,expected_revision,selected,operator_reference,outcome,resulting_revision,resulting_event_id,decided_at)
 SELECT s.command_id,s.space_id,s.expected_revision,s.selected,s.operator_reference,s.decision,c.revision,c.event_id,s.decided_at FROM release_seoul_target_attempt s JOIN release_seoul_authority_changes c ON c.revision=CASE WHEN s.decision='changed' THEN ${commandSource('revision','s')} ELSE s.prior_revision END
 WHERE s.token=? AND s.eligible=1 AND ((s.decision='changed' AND ${newSource('c','s')}) OR (s.decision='unchanged' AND c.event_id=s.prior_event_id AND c.record_bytes=s.prior_record_bytes AND c.source_command_id=s.prior_source_command_id AND c.created_at=s.prior_created_at))`);
 // Separate initial INSERT/present UPDATE keeps each CAS explicit. Ten actual
 // statements are within the reviewed alternative, without an unsafe UPSERT.
 add(`INSERT INTO release_seoul_targets(space_id,selected,revision) SELECT s.space_id,s.selected,r.resulting_revision FROM release_seoul_target_attempt s JOIN release_seoul_target_receipts r ON ${inputExact('r','s')} AND r.outcome='changed' AND r.decided_at=s.decided_at WHERE s.token=? AND s.eligible=1 AND s.decision='changed' AND s.prior_state='absent' AND NOT EXISTS(SELECT 1 FROM release_seoul_targets WHERE space_id=s.space_id)`);
 add(`UPDATE release_seoul_targets AS t SET selected=(SELECT s.selected FROM release_seoul_target_attempt s WHERE s.token=?),revision=(SELECT r.resulting_revision FROM release_seoul_target_attempt s JOIN release_seoul_target_receipts r ON ${inputExact('r','s')} AND r.outcome='changed' AND r.decided_at=s.decided_at WHERE s.token=?)
 WHERE EXISTS(SELECT 1 FROM release_seoul_target_attempt s JOIN release_seoul_target_receipts r ON ${inputExact('r','s')} AND r.outcome='changed' AND r.decided_at=s.decided_at WHERE s.token=? AND s.eligible=1 AND s.decision='changed' AND s.prior_state='present' AND t.space_id=s.space_id AND t.revision=s.prior_revision AND t.selected=s.prior_selected)`,[token,token,token]);
 add(`INSERT INTO release_seoul_dirty_spaces(space_id,dirty_revision,captured_revision) SELECT s.space_id,max(r.resulting_revision,coalesce(${dirtyScalar('dirty_revision','s')},0)),coalesce(${dirtyScalar('captured_revision','s')},0) FROM release_seoul_target_attempt s JOIN release_seoul_target_receipts r ON ${inputExact('r','s')} AND r.outcome='changed' AND r.decided_at=s.decided_at WHERE s.token=? AND s.eligible=1 AND s.decision='changed'
 ON CONFLICT(space_id) DO UPDATE SET dirty_revision=max(release_seoul_dirty_spaces.dirty_revision,excluded.dirty_revision)`);
 const accepted=`EXISTS(SELECT 1 FROM release_seoul_target_receipts r WHERE ${inputExact('r','s')} AND r.outcome=s.decision AND r.decided_at=s.decided_at AND ${history('r')}
 AND ((s.decision='changed' AND r.resulting_event_id=s.new_event_id AND (s.prior_revision IS NULL OR r.resulting_revision>s.prior_revision)
 AND EXISTS(SELECT 1 FROM release_seoul_targets t JOIN release_seoul_authority_heads h ON h.stream_kind='target' AND h.stream_key=t.space_id AND h.revision=t.revision JOIN release_seoul_dirty_spaces dirty ON dirty.space_id=t.space_id WHERE t.space_id=s.space_id AND t.selected=s.selected AND t.revision=r.resulting_revision AND h.event_id=r.resulting_event_id AND h.payload_sha256 IS NULL AND dirty.dirty_revision>=r.resulting_revision AND dirty.dirty_revision>=coalesce(s.prior_dirty_revision,0) AND dirty.captured_revision>=coalesce(s.prior_captured_revision,0)))
 OR (s.decision='unchanged' AND r.resulting_revision=s.prior_revision AND r.resulting_event_id=s.prior_event_id AND ${currentExact('s')} AND ${headScalar('payload_sha256','s')} IS s.observed_head_digest AND ${unchangedDirty('s')} AND NOT ${commandSourcePresent('s')})))`;
 add(`SELECT (CASE WHEN EXISTS(SELECT 1 FROM release_seoul_target_attempt s WHERE s.token=? AND ((s.eligible=1 AND ${accepted}) OR (s.eligible=0 AND ${unchangedObserved('s')} AND NOT EXISTS(SELECT 1 FROM release_seoul_authority_changes WHERE event_id=s.new_event_id)
 AND (s.decision<>'already_committed' OR EXISTS(SELECT 1 FROM release_seoul_target_receipts r WHERE ${inputExact('r','s')} AND ${history('r')}))))) THEN 1 ELSE abs(-9223372036854775808) END) complete_guard`);
 add(`SELECT s.decision,CASE WHEN s.decision IN ('changed','unchanged','already_committed') THEN ${commandReceipt('s')} ELSE NULL END receipt_bytes FROM release_seoul_target_attempt s WHERE s.token=? LIMIT 1`);
 add('DELETE FROM release_seoul_target_attempt WHERE token=?');
 add('SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM release_seoul_target_attempt LIMIT 1) THEN 1 ELSE abs(-9223372036854775808) END) complete_guard',[]);
 return result;
}
function bounded(request:Plan[]):boolean{return request.length<=100&&request.every(p=>p.values.length<=100&&utf8.encode(p.sql).length<=100000)&&utf8.encode(JSON.stringify({statements:request})).length+4096<=1048576;}
async function historicalAfter(database:Database,c:SeoulTargetCommand):Promise<SeoulTargetResult>{try{const observed=await observe(database,c);if(observed.stage_present||!observed.receipt_bytes||!observed.receipt_valid)return {status:'uncertain'};const receipt=parseReceipt(observed.receipt_bytes);return matches(receipt,c)?{status:'already_committed',receipt}:{status:'uncertain'};}catch{return {status:'uncertain'};}}
/** Inert trusted same-database primitive. The adapter assertion is not public
 * authorization. No route, runtime factory, target list or retry is installed. */
export function createSeoulProjectionTargetWriter(database:Database,adapter:'native-d1'|'durable-sql'):SeoulProjectionTargetWriter{
 if(!database||typeof database.prepare!=='function'||typeof database.batch!=='function'||typeof database.withSession!=='function'||(adapter!=='native-d1'&&adapter!=='durable-sql'))throw Error('seoul_target_writer_adapter_unsupported');
 return Object.freeze({async setTarget(value:unknown):Promise<SeoulTargetResult>{
  let c:SeoulTargetCommand;try{c=commandFrom(own(value,commandKeys));}catch{return {status:'invalid_command'};}
  let before:Observation;try{before=await observe(database,c);}catch{return {status:'uncertain'};}
  if(before.stage_present)return {status:'staging_retained'};
  if(before.receipt_bytes){let receipt:SeoulTargetReceipt;try{receipt=parseReceipt(before.receipt_bytes);}catch{return {status:'uncertain'};}if(!matches(receipt,c))return {status:'command_conflict'};return before.receipt_valid?{status:'already_committed',receipt}:{status:'target_state_invalid'};}
  if(!before.space_present)return {status:'target_missing'};if(before.command_source_present)return {status:'target_state_invalid'};
  let candidate:SeoulHeadCandidate|null=null;
  if(before.target_revision===null){if(before.head_revision!==null)return {status:'target_state_invalid'};if(c.expectedRevision!==null)return {status:'stale_revision'};}
  else{
   if(!before.current_valid||!before.source_bytes||!before.original_receipt_bytes)return {status:'target_state_invalid'};
   try{candidate=await prepareSeoulHeadCandidate(JSON.parse(before.source_bytes));const original=parseReceipt(before.original_receipt_bytes);if(candidate.rowGuard.revision!==before.target_revision||candidate.rowGuard.event_id!==before.head_event_id||candidate.rowGuard.stream_kind!=='target'||candidate.rowGuard.stream_key!==c.spaceId||original.outcome!=='changed'||original.commandId!==candidate.rowGuard.source_command_id||original.spaceId!==c.spaceId||original.selected!==Boolean(before.target_selected)||original.resultingRevision!==candidate.rowGuard.revision||original.resultingEventId!==candidate.rowGuard.event_id||original.decidedAtMs!==candidate.rowGuard.created_at)throw Error();
    if(before.head_digest!==null&&(before.head_digest!==candidate.sourceChangeSha256||before.prepared_source_sha256!==candidate.sourceChangeSha256||before.prepared_transport_sha256!==candidate.transportPayloadSha256||before.prepared_payload_bytes!==candidate.eventText||!before.prepared_event_valid||!before.prepared_delivery_present))throw Error();
   }catch{return {status:'target_state_invalid'};}
   if(before.target_revision!==c.expectedRevision)return {status:'stale_revision'};
  }
  let request:Plan[];try{request=plans(c,candidate,before.original_receipt_bytes);if(!bounded(request))return {status:'request_limit'};}catch{return {status:'uncertain'};}
  try{
   const result=await database.batch(request.map(p=>database.prepare(p.sql).bind(...p.values)));
   if(!Array.isArray(result)||result.length!==request.length)throw Error();
   for(let index=0;index<result.length;index++){const d=Object.getOwnPropertyDescriptor(result,String(index));if(!d||!('value'in d))throw Error();const r=own(d.value,['success','results','meta']);if(r.success!==true||!Array.isArray(r.results)||!r.meta||typeof r.meta!=='object')throw Error();}
   for(const index of [6,9]){const r=result[index];if(!r||r.success!==true||!Array.isArray(r.results)||r.results.length!==1||own(r.results[0],['complete_guard']).complete_guard!==1)throw Error();}
   const r=result[7];if(!r||r.success!==true||!Array.isArray(r.results)||r.results.length!==1)throw Error();const output=own(r.results[0],['decision','receipt_bytes']);
   if(failures.includes(output.decision as typeof failures[number])){if(output.receipt_bytes!==null)throw Error();return {status:output.decision as Failure};}
   if(!['changed','unchanged','already_committed'].includes(output.decision as string)||typeof output.receipt_bytes!=='string')throw Error();const receipt=parseReceipt(output.receipt_bytes);if(!matches(receipt,c)||(output.decision!=='already_committed'&&receipt.outcome!==output.decision))throw Error();return {status:output.decision==='already_committed'?'already_committed':'committed',receipt};
  }catch{return historicalAfter(database,c);}
 }});
}

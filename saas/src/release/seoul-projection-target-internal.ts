import type {Database,Value} from './types.ts';
import {prepareSeoulHeadCandidate} from './seoul-projection-source-codec.ts';

/** Private fixed target proof/plan machinery. No external caller-supplied prior
 * or witness is accepted by the writer/manifest APIs. */

export type SeoulTargetCommand = Readonly<{
  commandId: string; spaceId: string; expectedRevision: number | null;
  selected: boolean; operatorReference: string;
}>;
export type SeoulTargetReceipt = Readonly<SeoulTargetCommand & {
  outcome: 'changed' | 'unchanged'; resultingRevision: number;
  resultingEventId: string; decidedAtMs: number;
}>;

export type TargetControlObservation = Readonly<{
  schemaVersion: number;
  currentGeneration: number | null;
  currentManifestId: string | null;
  cancelled: boolean; sealed: boolean; completed: boolean;
  manifestStagePresent: boolean;
}>;

export type TargetObservation = Readonly<{
  command: SeoulTargetCommand;
  control: TargetControlObservation;
  stagePresent: boolean; spacePresent: boolean;
  receiptBytes: string | null; receiptValid: boolean;
  commandSourcePresent: boolean;
  targetRevision: number | null; targetSelected: boolean | null;
  headRevision: number | null; headEventId: string | null;
  headDigest: string | null; currentDigestsInvalid: boolean; currentValid: boolean;
  sourceRowBytes: string | null;
  originalChangedReceiptBytes: string | null;
  preparedSourceSha256: string | null;
  preparedTransportSha256: string | null;
  preparedPayloadBytes: string | null;
  preparedPayloadOversized: boolean;
  preparedEventValid: boolean; preparedDeliveryPresent: boolean;
}>;

export type TargetPresentPrior = Readonly<{
  state: 'present'; revision: number; selected: boolean;
  eventId: string; sourceCommandId: string; recordBytes: string;
  createdAtMs: number; sourceSha256: string;
  transportSha256: string; payloadBytes: string;
  changedReceiptBytes: string;
}>;
export type TargetPrior = Readonly<{ state: 'absent' }> | TargetPresentPrior;
export type TargetCompletionWitness = Readonly<{
  command: SeoulTargetCommand;
  receipt: SeoulTargetReceipt; receiptBytes: string;
  prior: TargetPresentPrior;
}>;

export type TargetSqlStatement = Readonly<{
  sql: string; values: readonly Value[]; mode: 'all';
}>;
export type TargetTenStatements = readonly [
  TargetSqlStatement, TargetSqlStatement, TargetSqlStatement,
  TargetSqlStatement, TargetSqlStatement, TargetSqlStatement,
  TargetSqlStatement, TargetSqlStatement, TargetSqlStatement,
  TargetSqlStatement
];
export type TargetWritePlan = Readonly<{
  targetToken: string; sourceEventId: string;
  statements: TargetTenStatements;
}>;
export type TargetBatchLayout = 'direct10' | 'manifest13';
export type TargetDecodedResult =
  | Readonly<{ status: 'committed' | 'already_committed';
      receipt: SeoulTargetReceipt }>
  | Readonly<{ status: 'command_conflict' | 'target_missing'
      | 'target_state_invalid' | 'stale_revision' }>;
export type TargetRecovery =
  | Readonly<{ status: 'historical_commit'; receipt: SeoulTargetReceipt;
      control: TargetControlObservation }>
  | Readonly<{ status: 'uncertain';
      control: TargetControlObservation | null }>;

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

export function ownTargetCommand(value:unknown):SeoulTargetCommand{return commandFrom(own(value,commandKeys));}
export function parseTargetReceipt(bytes:string):SeoulTargetReceipt{return parseReceipt(bytes);}
export function targetReceiptMatches(receipt:SeoulTargetReceipt,command:SeoulTargetCommand):boolean{return matches(receipt,command);}

function arrayValues(value:unknown,min:number,max:number):unknown[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<min||value.length>max)throw Error('target_array_invalid');
 const keys=Reflect.ownKeys(value);if(keys.length!==value.length+1)throw Error('target_array_invalid');
 const result:unknown[]=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!d.enumerable||!('value'in d))throw Error('target_array_invalid');result.push(d.value);}return result;
}
function resultRows(value:unknown,max:number):unknown[]{
 const r=own(value,['success','results','meta']);if(r.success!==true||!r.meta||typeof r.meta!=='object')throw Error('target_result_invalid');return arrayValues(r.results,0,max);
}
const byteBound=(expression:string,limit:number)=>`CASE WHEN length(CAST(${expression} AS BLOB))<=${limit} THEN ${expression} ELSE NULL END`;
// SQLite TEXT length/GLOB can stop at NUL. Check both byte and text length
// before output; retain invalid-current state separately from a pending NULL.
const digestValid=(expression:string)=>`(typeof(${expression})='text' AND length(CAST(${expression} AS BLOB))=64 AND length(${expression})=64 AND ${expression} NOT GLOB '*[^0-9a-f]*')`;
const digestNullable=(expression:string)=>`(${expression} IS NULL OR ${digestValid(expression)})`;
const digestBound=(expression:string)=>`CASE WHEN ${digestValid(expression)} THEN ${expression} ELSE NULL END`;
const headDigest=headScalar('payload_sha256','v');
const preparedSourceDigest=scalar(`SELECT source_sha256 FROM release_seoul_prepared_sources WHERE revision=${targetScalar('revision','v')}`);
const preparedTransportDigest=scalar(`SELECT transport_sha256 FROM release_seoul_prepared_sources WHERE revision=${targetScalar('revision','v')}`);
const currentDigestsInvalid=[headDigest,preparedSourceDigest,preparedTransportDigest].map(expression=>`(${expression} IS NOT NULL AND NOT ${digestValid(expression)})`).join(' OR ');
const originalReceipt=(v:string)=>scalar(`SELECT ${receiptJson('r')} FROM release_seoul_target_receipts r WHERE r.command_id=${scalar(`SELECT source_command_id FROM release_seoul_authority_changes WHERE revision=${targetScalar('revision',v)}`)}`);
const preparedPayload=scalar(`SELECT payload_bytes FROM release_seoul_projection_events WHERE event_id=${headScalar('event_id','v')}`);
// Target-only grammar has no arbitrary text: ASCII128 Space (twice for a
// negative), UUID36 identities, safe decimal16 numbers, fixed tags and SHA64.
// The largest record is587 bytes, its escaped SQL source-row wrapper is988,
// and the negative head transport is740. These maxima are exercised outside
// the repo;4096 bounds the complete extracted strings, before page aggregation.
const OBSERVE_COMMANDS=`WITH v AS MATERIALIZED(SELECT CAST(key AS INTEGER) ordinal,
 json_extract(value,'$.commandId') command_id,json_extract(value,'$.spaceId') space_id,
 json_extract(value,'$.expectedRevision') expected_revision,json_extract(value,'$.selected') selected,
 json_extract(value,'$.operatorReference') operator_reference FROM json_each(?)),
 ctl AS MATERIALIZED(SELECT (SELECT version FROM release_meta) schema_version,current_generation,
 (SELECT manifest_id FROM release_seoul_target_manifests WHERE generation=current_generation) current_manifest_id,
 EXISTS(SELECT 1 FROM release_seoul_target_manifest_cancellations WHERE generation=current_generation) cancelled,
 EXISTS(SELECT 1 FROM release_seoul_target_manifest_seals WHERE generation=current_generation) sealed,
 EXISTS(SELECT 1 FROM release_seoul_target_manifest_completions WHERE generation=current_generation) completed,
 EXISTS(SELECT 1 FROM release_seoul_target_manifest_attempt LIMIT 1) manifest_stage_present
 FROM release_seoul_target_manifest_control WHERE singleton=1 AND (SELECT count(*) FROM release_seoul_target_manifest_control)=1)
 SELECT v.*,ctl.*,EXISTS(SELECT 1 FROM release_seoul_target_attempt LIMIT 1) stage_present,
 EXISTS(SELECT 1 FROM spaces WHERE id=v.space_id) space_present,
 ${byteBound(commandReceipt('v'),2048)} receipt_bytes,
 EXISTS(SELECT 1 FROM release_seoul_target_receipts r WHERE r.command_id=v.command_id AND ${history('r')}) receipt_valid,
 ${commandSourcePresent('v')} command_source_present,
 ${targetScalar('revision','v')} target_revision,${targetScalar('selected','v')} target_selected,
 ${headScalar('revision','v')} head_revision,${headScalar('event_id','v')} head_event_id,${digestBound(headDigest)} head_digest,
 ${currentDigestsInvalid} current_digests_invalid,
 ${currentLineage('v')} current_valid,
 CASE WHEN ${currentLineage('v')} THEN ${scalar(`SELECT ${byteBound(sourceRow('c'),4096)} FROM release_seoul_authority_changes c WHERE c.revision=${targetScalar('revision','v')}`)} ELSE NULL END source_row_bytes,
 ${byteBound(originalReceipt('v'),2048)} original_changed_receipt_bytes,
 ${digestBound(preparedSourceDigest)} prepared_source_sha256,
 ${digestBound(preparedTransportDigest)} prepared_transport_sha256,
 ${byteBound(preparedPayload,4096)} prepared_payload_bytes,
 coalesce(length(CAST(${preparedPayload} AS BLOB))>4096,0) prepared_payload_oversized,
 EXISTS(SELECT 1 FROM release_seoul_projection_events e WHERE e.event_id=${headScalar('event_id','v')} AND e.source_revision=${targetScalar('revision','v')} AND e.event_kind='head' AND e.stream_kind='target' AND e.stream_key=v.space_id AND e.space_id IS NULL AND e.snapshot_seq IS NULL AND e.issued_at IS NULL AND e.expires_at IS NULL AND e.source_sha256=${scalar(`SELECT source_sha256 FROM release_seoul_prepared_sources WHERE revision=${targetScalar('revision','v')}`)} AND e.payload_sha256=${scalar(`SELECT transport_sha256 FROM release_seoul_prepared_sources WHERE revision=${targetScalar('revision','v')}`)}) prepared_event_valid,
 EXISTS(SELECT 1 FROM release_seoul_projection_deliveries WHERE event_id=${headScalar('event_id','v')}) prepared_delivery_present
 FROM v CROSS JOIN ctl ORDER BY v.ordinal`;
const observationKeys=['ordinal',...commandColumns.split(','),'schema_version','current_generation','current_manifest_id','cancelled','sealed','completed','manifest_stage_present','stage_present','space_present','receipt_bytes','receipt_valid','command_source_present','target_revision','target_selected','head_revision','head_event_id','head_digest','current_digests_invalid','current_valid','source_row_bytes','original_changed_receipt_bytes','prepared_source_sha256','prepared_transport_sha256','prepared_payload_bytes','prepared_payload_oversized','prepared_event_valid','prepared_delivery_present'] as const;
function flag(v:unknown):boolean{if(v!==0&&v!==1||Object.is(v,-0))throw Error('target_flag_invalid');return v===1;}
function nullableText(v:unknown,max:number):string|null{if(v===null)return null;if(typeof v!=='string'||!v.length||v.length>max||utf8.encode(v).length>max)throw Error('target_text_invalid');return v;}
function nullableInteger(v:unknown,min=1):number|null{return v===null?null:integer(v,min);}
function nullableUuid(v:unknown):string|null{return v===null?null:uuid(v);}
function nullableDigest(v:unknown):string|null{if(v===null)return null;if(typeof v!=='string'||!(/^[a-f0-9]{64}$/).test(v))throw Error('target_digest_invalid');return v;}

export async function observeTargetCommands(database:Database,commands:readonly SeoulTargetCommand[]):Promise<readonly TargetObservation[]>{
 const inputs=arrayValues(commands,1,32).map(ownTargetCommand),encoded=JSON.stringify(inputs);
 const rows=resultRows(await database.withSession('first-primary').prepare(OBSERVE_COMMANDS).bind(encoded).all(),32);
 if(rows.length!==inputs.length)throw Error('target_observation_incomplete');
 let firstControl:string|null=null;
 return Object.freeze(rows.map((row,index)=>{
  const x=own(row,observationKeys),input=inputs[index]!;
  if(integer(x.ordinal)!==index||x.command_id!==input.commandId||x.space_id!==input.spaceId||x.expected_revision!==input.expectedRevision||flag(x.selected)!==input.selected||x.operator_reference!==input.operatorReference)throw Error('target_observation_identity');
  const control:TargetControlObservation=Object.freeze({schemaVersion:integer(x.schema_version,35),currentGeneration:nullableInteger(x.current_generation),currentManifestId:nullableUuid(x.current_manifest_id),cancelled:flag(x.cancelled),sealed:flag(x.sealed),completed:flag(x.completed),manifestStagePresent:flag(x.manifest_stage_present)});
  if((control.currentGeneration===null)!==(control.currentManifestId===null)||(control.currentGeneration===null&&(control.cancelled||control.sealed||control.completed))||(control.completed&&!control.sealed))throw Error('target_control_invalid');
  const encodedControl=JSON.stringify(control);if(firstControl!==null&&encodedControl!==firstControl)throw Error('target_control_incoherent');firstControl=encodedControl;
  const observed:TargetObservation=Object.freeze({command:input,control,stagePresent:flag(x.stage_present),spacePresent:flag(x.space_present),receiptBytes:nullableText(x.receipt_bytes,2048),receiptValid:flag(x.receipt_valid),commandSourcePresent:flag(x.command_source_present),targetRevision:nullableInteger(x.target_revision),targetSelected:x.target_selected===null?null:flag(x.target_selected),headRevision:nullableInteger(x.head_revision),headEventId:nullableUuid(x.head_event_id),headDigest:nullableDigest(x.head_digest),currentDigestsInvalid:flag(x.current_digests_invalid),currentValid:flag(x.current_valid),sourceRowBytes:nullableText(x.source_row_bytes,4096),originalChangedReceiptBytes:nullableText(x.original_changed_receipt_bytes,2048),preparedSourceSha256:nullableDigest(x.prepared_source_sha256),preparedTransportSha256:nullableDigest(x.prepared_transport_sha256),preparedPayloadBytes:nullableText(x.prepared_payload_bytes,4096),preparedPayloadOversized:flag(x.prepared_payload_oversized),preparedEventValid:flag(x.prepared_event_valid),preparedDeliveryPresent:flag(x.prepared_delivery_present)});
  if((observed.receiptBytes===null&&observed.receiptValid)||(observed.targetRevision===null)!==(observed.targetSelected===null)||(observed.headRevision===null)!==(observed.headEventId===null)||(observed.headDigest!==null&&observed.headRevision===null)||(observed.currentValid&&(observed.sourceRowBytes===null||observed.originalChangedReceiptBytes===null||observed.targetRevision===null))||(observed.preparedPayloadOversized&&observed.preparedPayloadBytes!==null))throw Error('target_observation_invalid');
  return observed;
 }));
}

export async function prepareTargetPrior(observation:TargetObservation):Promise<TargetPrior>{
 const x={...observation,command:ownTargetCommand(observation.command)};
 if(x.currentDigestsInvalid)throw Error('target_state_invalid');
 if(x.targetRevision===null){if(x.headRevision!==null)throw Error('target_state_invalid');return Object.freeze({state:'absent'});}
 if(!x.currentValid||!x.sourceRowBytes||!x.originalChangedReceiptBytes)throw Error('target_state_invalid');
 const original=parseReceipt(x.originalChangedReceiptBytes),candidate=await prepareSeoulHeadCandidate(JSON.parse(x.sourceRowBytes)),row=candidate.rowGuard;
 if(row.revision!==x.targetRevision||row.event_id!==x.headEventId||row.stream_kind!=='target'||row.stream_key!==x.command.spaceId||original.outcome!=='changed'||original.commandId!==row.source_command_id||original.spaceId!==x.command.spaceId||original.selected!==x.targetSelected||original.resultingRevision!==row.revision||original.resultingEventId!==row.event_id||original.decidedAtMs!==row.created_at)throw Error('target_state_invalid');
 if(x.headDigest!==null&&(x.preparedPayloadOversized||x.headDigest!==candidate.sourceChangeSha256||x.preparedSourceSha256!==candidate.sourceChangeSha256||x.preparedTransportSha256!==candidate.transportPayloadSha256||x.preparedPayloadBytes!==candidate.eventText||!x.preparedEventValid||!x.preparedDeliveryPresent))throw Error('target_state_invalid');
 return Object.freeze({state:'present',revision:row.revision,selected:original.selected,eventId:row.event_id,sourceCommandId:row.source_command_id,recordBytes:row.record_bytes,createdAtMs:row.created_at,sourceSha256:candidate.sourceChangeSha256,transportSha256:candidate.transportPayloadSha256,payloadBytes:candidate.eventText,changedReceiptBytes:x.originalChangedReceiptBytes});
}
export async function prepareTargetCompletion(observation:TargetObservation):Promise<TargetCompletionWitness>{
 const command=ownTargetCommand(observation.command),receiptBytes=observation.receiptBytes;
 if(!receiptBytes||!observation.receiptValid)throw Error('target_completion_invalid');
 const receipt=parseReceipt(receiptBytes);if(!matches(receipt,command))throw Error('target_completion_invalid');
 const prior=await prepareTargetPrior(observation);
 if(prior.state!=='present'||prior.revision!==receipt.resultingRevision||prior.eventId!==receipt.resultingEventId||prior.selected!==receipt.selected)throw Error('target_completion_invalid');
 return Object.freeze({command,receipt,receiptBytes,prior});
}

export function decodeTargetWriteResults(value:unknown,command:SeoulTargetCommand,layout:TargetBatchLayout):TargetDecodedResult{
 const c=ownTargetCommand(command);if(layout!=='direct10'&&layout!=='manifest13')throw Error('target_layout_invalid');
 const length=layout==='direct10'?10:13,results=arrayValues(value,length,length),rows=results.map(r=>resultRows(r,1));
 for(const index of layout==='direct10'?[6,9]:[7,10,12]){if(rows[index]!.length!==1||own(rows[index]![0],['complete_guard']).complete_guard!==1)throw Error('target_complete_guard');}
 const decisionRows=rows[layout==='direct10'?7:8]!;if(decisionRows.length!==1)throw Error('target_result_invalid');const output=own(decisionRows[0],['decision','receipt_bytes']);
 if(failures.includes(output.decision as typeof failures[number])){if(output.receipt_bytes!==null)throw Error('target_result_invalid');return Object.freeze({status:output.decision as 'command_conflict'|'target_missing'|'target_state_invalid'|'stale_revision'});}
 if(!['changed','unchanged','already_committed'].includes(output.decision as string)||typeof output.receipt_bytes!=='string')throw Error('target_result_invalid');
 const receipt=parseReceipt(output.receipt_bytes);if(!matches(receipt,c)||(output.decision!=='already_committed'&&receipt.outcome!==output.decision))throw Error('target_result_invalid');
 return Object.freeze({status:output.decision==='already_committed'?'already_committed':'committed',receipt});
}
export function targetRequestWithinLimits(statements:readonly TargetSqlStatement[]):boolean{
 try{return statements.length>0&&statements.length<=100&&statements.every(s=>s.mode==='all'&&s.values.length<=100&&s.values.every(v=>v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v))&&utf8.encode(s.sql).length<=100000)&&utf8.encode(JSON.stringify({statements})).length+4096<=1048576;}catch{return false;}
}
export async function recoverTargetWrite(database:Database,command:SeoulTargetCommand):Promise<TargetRecovery>{
 let control:TargetControlObservation|null=null;
 try{const x=(await observeTargetCommands(database,[command]))[0]!;control=x.control;
  if(x.stagePresent||control.manifestStagePresent||!x.receiptBytes||!x.receiptValid)return Object.freeze({status:'uncertain',control});
  const receipt=parseReceipt(x.receiptBytes);if(!matches(receipt,x.command))return Object.freeze({status:'uncertain',control});
  return Object.freeze({status:'historical_commit',receipt,control});
 }catch{return Object.freeze({status:'uncertain',control});}
}

const currentExact=(s:string)=>`EXISTS(SELECT 1 FROM release_seoul_targets t JOIN release_seoul_authority_heads h ON h.stream_kind='target' AND h.stream_key=t.space_id AND h.revision=t.revision JOIN release_seoul_authority_changes c ON c.revision=t.revision AND c.event_id=h.event_id JOIN release_seoul_target_receipts original ON original.command_id=c.source_command_id
 WHERE t.space_id=${s}.space_id AND t.revision=${s}.prior_revision AND t.selected=${s}.prior_selected AND c.source_command_id=${s}.prior_source_command_id AND c.stream_kind='target' AND c.stream_key=${s}.space_id AND c.event_id=${s}.prior_event_id AND c.record_bytes=${s}.prior_record_bytes AND c.created_at=${s}.prior_created_at
 AND original.outcome='changed' AND original.resulting_revision=c.revision AND original.resulting_event_id=c.event_id AND original.space_id=t.space_id AND original.selected=t.selected AND original.decided_at=c.created_at AND ${receiptJson('original')}=${s}.prior_changed_receipt_bytes
 AND ${digestNullable('h.payload_sha256')} AND NOT EXISTS(SELECT 1 FROM release_seoul_prepared_sources current_prepared WHERE current_prepared.revision=c.revision AND NOT (${digestNullable('current_prepared.source_sha256')} AND ${digestNullable('current_prepared.transport_sha256')}))
 AND (h.payload_sha256 IS NULL OR (h.payload_sha256=${s}.prior_source_sha256 AND EXISTS(SELECT 1 FROM release_seoul_prepared_sources p JOIN release_seoul_projection_events e ON e.event_id=p.event_id JOIN release_seoul_projection_deliveries delivery ON delivery.event_id=e.event_id
 WHERE p.revision=c.revision AND p.event_id=c.event_id AND p.source_sha256=${s}.prior_source_sha256 AND p.transport_sha256=${s}.prior_transport_sha256 AND e.source_revision=c.revision AND e.event_kind='head' AND e.stream_kind='target' AND e.stream_key=${s}.space_id AND e.source_sha256=p.source_sha256 AND e.payload_sha256=p.transport_sha256 AND e.payload_bytes=${s}.prior_payload_bytes AND e.space_id IS NULL AND e.snapshot_seq IS NULL AND e.issued_at IS NULL AND e.expires_at IS NULL))))`;
export const TARGET_COMPLETION_FOR_S_SQL=`EXISTS(SELECT 1 FROM release_seoul_target_receipts r WHERE ${inputExact('r','s')} AND ${receiptJson('r')}=s.receipt_bytes AND ${history('r')}
 AND r.resulting_revision=s.prior_revision AND r.resulting_event_id=s.prior_event_id AND r.selected=s.prior_selected AND ${currentExact('s')})`;
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
export function buildTargetWritePlan(command:SeoulTargetCommand,prior:TargetPrior):TargetWritePlan{
 const c=ownTargetCommand(command),candidate=prior.state==='present'?prior:null;
 const token=crypto.randomUUID(),event=crypto.randomUUID(),priorValues:Value[]=candidate?[candidate.revision,Number(candidate.selected),candidate.eventId,candidate.sourceCommandId,candidate.recordBytes,candidate.createdAtMs,candidate.sourceSha256,candidate.transportSha256,candidate.payloadBytes,candidate.changedReceiptBytes]:Array<Value>(10).fill(null);
 const inputColumns=`token,${commandColumns},new_event_id,prior_state,${priorColumns.join(',')}`;
 const decision=`CASE WHEN o.observed_command_receipt_bytes IS NOT NULL THEN CASE WHEN EXISTS(SELECT 1 FROM release_seoul_target_receipts r WHERE ${inputExact('r','o')}) THEN CASE WHEN EXISTS(SELECT 1 FROM release_seoul_target_receipts r WHERE r.command_id=o.command_id AND ${history('r')}) THEN 'already_committed' ELSE 'target_state_invalid' END ELSE 'command_conflict' END
 WHEN o.observed_space_present=0 THEN 'target_missing' WHEN o.observed_command_source_present=1 THEN 'target_state_invalid'
 WHEN (o.observed_target_revision IS NULL)!=(o.observed_head_revision IS NULL) THEN 'target_state_invalid'
 WHEN o.observed_target_revision IS NULL THEN CASE WHEN o.expected_revision IS NOT NULL THEN 'stale_revision' WHEN o.prior_state<>'absent' THEN 'target_state_invalid' ELSE 'changed' END
 WHEN NOT ${currentLineage('o')} THEN 'target_state_invalid' WHEN o.observed_target_revision IS NOT o.expected_revision THEN 'stale_revision'
 WHEN o.prior_state<>'present' OR NOT ${currentExact('o')} THEN 'target_state_invalid' WHEN o.observed_target_selected=o.selected THEN 'unchanged' ELSE 'changed' END`;
 const result:TargetSqlStatement[]=[];const add=(sql:string,values:Value[]=[token])=>result.push({sql,values,mode:'all'});
 add(`INSERT INTO release_seoul_target_attempt(${inputColumns},decided_at,decision,eligible,${observedColumns.join(',')})
 WITH v(${inputColumns}) AS (VALUES(${Array(18).fill('?').join(',')})),o AS MATERIALIZED(SELECT v.*,CAST(round(unixepoch('subsec')*1000) AS INTEGER) decided_at,${stageObservations('v')} FROM v),d AS MATERIALIZED(SELECT o.*,${decision} decision FROM o)
 SELECT ${inputColumns},decided_at,decision,CASE WHEN decision IN ('changed','unchanged') THEN 1 ELSE 0 END,${observedColumns.join(',')} FROM d`,[token,...inputValues(c),event,candidate?'present':'absent',...priorValues]);
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
 return Object.freeze({targetToken:token,sourceEventId:event,statements:Object.freeze(result.map(s=>Object.freeze({...s,values:Object.freeze([...s.values])}))) as unknown as TargetTenStatements});
}

// Offline validation of explicit immutable historical cuts. This is evidence
// validation, not a provider attestation or a claim that HTTP writers drained.
import { createHash } from 'node:crypto';
import { deploymentFingerprint } from './deployment-config.mjs';
const LIMIT = { rows:10000, object:131072 };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(sort(value));
function sort(v) { return Array.isArray(v) ? v.map(sort) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])) : v; }
function insist(ok,message) { if(!ok) throw new Error(message); }
const r2Etag = header => header?.replace(/^W\//,'').replace(/^"|"$/g,'').replace(/-(?:gzip|br)$/,'');
function sourceResources(config) {
 const shards=JSON.parse(config.vars.STORAGE_SHARDS_JSON), d1=[config.d1_databases.find(d=>d.binding==='DB'),...shards.map(s=>config.d1_databases.find(d=>d.binding===s.binding))];
 insist(config.vars.DEPLOYMENT_ENVIRONMENT==='staging'&&config.vars.STORAGE_MODE==='sharded'&&shards.length>=2&&shards.length<=16&&d1.every(Boolean),'Historical capture requires explicit sharded staging');
 const bucket=config.r2_buckets.find(b=>b.binding==='MEMORY_PAYLOADS')?.bucket_name;insist(typeof bucket==='string','Historical payload bucket required');return {d1,shards,bucket};
}
export const HISTORICAL_MODE='immutable-historical-cut-v1';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const revision=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const stamp=v=>Number.isSafeInteger(v)&&v>0;
const name=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const bounded=(v,max=1000)=>{insist(Array.isArray(v)&&v.length<=max,'Evidence item bound exceeded');return v;};
function exact(v,keys){insist(object(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),'Unexpected or missing historical capture evidence');}
function prefixlessMultipartAbort(rule){
 // The provider's default incomplete-upload rule can return conditions:{}.
 // Preserve those observed bytes; accept omission only for this known shape.
 if(Object.keys(rule).sort().join(',')!=='abortMultipartUploadsTransition,conditions,enabled,id'||Object.keys(rule.conditions).length!==0)return false;
 const abort=rule.abortMultipartUploadsTransition,condition=abort?.condition;
 return object(abort)&&Object.keys(abort).join(',')==='condition'&&object(condition)&&Object.keys(condition).sort().join(',')==='maxAge,type'
  &&condition.type==='Age'&&Number.isSafeInteger(condition.maxAge)&&condition.maxAge>0;
}
function moduleList(values){
 const seen=new Set();return bounded(values,100).map(v=>{exact(v,['name','bytes','sha256']);insist(typeof v.name==='string'&&/^[A-Za-z0-9_./-]{1,256}$/.test(v.name)&&!v.name.split('/').includes('..')&&!seen.has(v.name)&&Number.isSafeInteger(v.bytes)&&v.bytes>0&&v.bytes<=8*1024*1024&&digest(v.sha256),'Invalid module identity');seen.add(v.name);return {...v};}).sort((a,b)=>a.name.localeCompare(b.name));
}
export function moduleDigests(modules){return moduleList(bounded(modules,100).map(v=>{insist(v.bytes instanceof Uint8Array,'Actual downloaded module bytes required');return {name:v.name,bytes:v.bytes.length,sha256:sha(v.bytes)};}));}
export function validateHistoricalPolicy(policy,config,context,now){
 exact(policy,['format','contract','accountId','workerName','bucketName','bucketCreatedAt','sourceRevision','resourceFingerprint','writerSourceSha256','versions','coordinator']);
 const resources=sourceResources(config);
 insist(policy.format===1&&policy.contract==='memory-payload-monotonic-v1'&&policy.accountId===config.account_id&&policy.workerName===config.name&&policy.bucketName===resources.bucket&&stamp(policy.bucketCreatedAt)&&policy.bucketCreatedAt<=now,'Writer policy source mismatch');
 insist(context.environment==='staging'&&context.origin===config.vars.PUBLIC_ORIGIN&&revision(context.sourceRevision)&&policy.sourceRevision===context.sourceRevision&&digest(policy.resourceFingerprint)&&policy.resourceFingerprint===context.resourceFingerprint&&context.resourceFingerprint===deploymentFingerprint(config)&&digest(policy.writerSourceSha256),'Writer policy release/config mismatch');
 const c=policy.coordinator;exact(c,['issuedAt','expiresAt','scope','activeWriters','evidenceSha256']);
 insist(stamp(c.issuedAt)&&stamp(c.expiresAt)&&c.issuedAt<=now&&now<c.expiresAt&&c.expiresAt-c.issuedAt<=3600000&&c.scope==='exclusive-operators-during-capture'&&digest(c.evidenceSha256),'Fresh bounded coordinator exclusivity evidence required');
 insist(bounded(c.activeWriters,10).length===1&&c.activeWriters[0]===policy.workerName,'Unsupported active writer inventory');
 const ids=new Set();for(const v of bounded(policy.versions,1000)){exact(v,['id','sourceRevision','writerSourceSha256','modules','receiptSha256']);insist(name(v.id)&&!ids.has(v.id)&&revision(v.sourceRevision)&&v.writerSourceSha256===policy.writerSourceSha256&&digest(v.receiptSha256)&&moduleList(v.modules).length,'Unreviewed writer history or missing retained deployment receipt');ids.add(v.id);}
 insist(ids.size>0,'Retained successful writer deployment history required');return resources;
}
/** No synthetic provider boolean is accepted. The adapter preserves actual
 * version-page counts and hashes the downloaded modules. Historical module
 * identities are supplied by independently retained successful deploy receipts.
 * Absence of out-of-band admin/S3 writes remains the explicit coordinator assumption. */
export function validateWriterObservation(observation,policy,config,context,now=Date.now()){
 validateHistoricalPolicy(policy,config,context,now);
 exact(observation,['format','observedAt','accountId','workerName','currentVersionId','versionPages','modules','bindings','bucket','activeWriters','requestEvidence']);
 insist(observation.format===1&&stamp(observation.observedAt)&&observation.observedAt>=policy.coordinator.issuedAt&&observation.observedAt<=now&&now-observation.observedAt<=300000&&observation.accountId===policy.accountId&&observation.workerName===policy.workerName,'Stale or wrong provider source observation');
 const versions=[],seen=new Set(),pages=bounded(observation.versionPages,10);insist(pages.length>0,'Complete provider version inventory required');
 for(let i=0;i<pages.length;i++){const p=pages[i];exact(p,['page','perPage','items']);insist(p.page===i+1&&p.perPage===100,'Unsupported version pagination');bounded(p.items,100);insist(i===pages.length-1?p.items.length<100:p.items.length===100,'Incomplete provider version inventory');for(const v of p.items){exact(v,['id','createdAt']);insist(name(v.id)&&stamp(v.createdAt)&&v.createdAt<=observation.observedAt&&!seen.has(v.id),'Invalid/duplicate provider version');seen.add(v.id);versions.push(v);}}
 insist(canonical([...seen].sort())===canonical(policy.versions.map(v=>v.id).sort()),'Provider has unsupported or missing writer history');
 const current=policy.versions.find(v=>v.id===observation.currentVersionId);insist(current&&current.sourceRevision===context.sourceRevision&&canonical(moduleList(observation.modules))===canonical(moduleList(current.modules)),'Actual deployed module/source differs from reviewed receipt');
 const actual=new Map();for(const b of bounded(observation.bindings,128)){insist(object(b)&&name(b.name)&&typeof b.type==='string'&&!actual.has(b.name),'Invalid/duplicate provider binding');insist(b.type!=='secret_text'||Object.keys(b).every(k=>['name','type'].includes(k)),'Private binding contents must not enter evidence');actual.set(b.name,b);}
 for(const d of config.d1_databases)insist(actual.get(d.binding)?.type==='d1'&&actual.get(d.binding).id===d.database_id,'Actual D1 binding differs from source config');
 for(const b of config.r2_buckets)insist(actual.get(b.binding)?.type==='r2_bucket'&&actual.get(b.binding).bucket_name===b.bucket_name,'Actual R2 binding differs from source config');
 insist([...actual.values()].filter(b=>b.type==='d1').length===config.d1_databases.length&&[...actual.values()].filter(b=>b.type==='r2_bucket').length===config.r2_buckets.length,'Unexpected source storage binding');
 for(const [key,value] of Object.entries(config.vars))insist(actual.get(key)?.type==='plain_text'&&actual.get(key).text===value,'Actual configuration variable differs from source config');
 exact(observation.bucket,['name','createdAt','lifecycleRules']);insist(observation.bucket.name===policy.bucketName&&observation.bucket.createdAt===policy.bucketCreatedAt,'Actual bucket identity/creation differs');
 for(const rule of bounded(observation.bucket.lifecycleRules,1000)){
  insist(object(rule)&&typeof rule.id==='string'&&typeof rule.enabled==='boolean'&&object(rule.conditions)
   &&(typeof rule.conditions.prefix==='string'||prefixlessMultipartAbort(rule)),'Unknown bucket lifecycle rule');
  // Default incomplete-multipart expiry cannot delete a complete payload. All
  // other enabled transitions are unsupported, even on another prefix.
  const allowed=['id','enabled','conditions','abortMultipartUploadsTransition'];
  insist(!rule.enabled||Object.keys(rule).every(k=>allowed.includes(k)),'Unsupported object lifecycle transition');
 }
 const writers=bounded(observation.activeWriters,1000);for(const w of writers){exact(w,['name','buckets']);insist(name(w.name)&&bounded(w.buckets,100).every(b=>typeof b==='string'),'Invalid actual active writer inventory');}
 insist(canonical(writers.filter(w=>w.buckets.includes(policy.bucketName)).map(w=>w.name).sort())===canonical(policy.coordinator.activeWriters.slice().sort()),'Unsupported actual bucket writer');
 const receipts=bounded(observation.requestEvidence,2000);insist(receipts.length>0,'Actual provider request evidence required');for(const r of receipts){exact(r,['method','path','sha256']);insist(r.method==='GET'&&typeof r.path==='string'&&r.path.startsWith('/accounts/'+policy.accountId+'/')&&!/[\x00-\x20#]/.test(r.path)&&!r.path.includes('..')&&digest(r.sha256),'Invalid read-only provider receipt');}
 const prefix='/accounts/'+policy.accountId, script=prefix+'/workers/scripts/'+policy.workerName, bucket=prefix+'/r2/buckets/'+policy.bucketName;
 const required=[script+'/content/v2',script+'/settings',script+'/deployments',bucket,bucket+'/lifecycle',prefix+'/workers/scripts',...pages.map(p=>script+'/versions?page='+p.page+'&per_page=100'),...writers.map(w=>prefix+'/workers/scripts/'+w.name+'/settings')];
 insist(required.every(path=>receipts.some(r=>r.path===path)),'Missing actual source inventory request evidence');
 return structuredClone(observation);
}
export function comparableSource(value){const {observedAt,requestEvidence,...facts}=value;return canonical(facts);}
export function listedObject(value){
 insist(object(value)&&typeof value.key==='string'&&/^payload\/v1\/[A-Za-z0-9._:-]{1,128}$/.test(value.key)&&Number.isSafeInteger(value.size)&&value.size>=0&&value.size<=LIMIT.object&&typeof value.etag==='string'&&value.etag.length>0&&value.etag.length<=256,'Unsupported R2 object listing');
 const metadata=value.custom_metadata;exact(metadata,['payloadId','shardId','spaceId','memoryId','sha256','state']);
 insist(value.key==='payload/v1/'+metadata.payloadId&&name(metadata.shardId)&&name(metadata.spaceId)&&name(metadata.memoryId)&&digest(metadata.sha256)&&['payload','purged'].includes(metadata.state)&&(metadata.state==='purged'?value.size===0:value.size>0),'Unsupported R2 object state/metadata');
 return {key:value.key,size:value.size,etag:r2Etag(value.etag),custom_metadata:structuredClone(metadata)};
}

function validateScan(scan, startedAt, capturedAt) {
 exact(scan,['startedAt','completedAt','pageSize','objects','pages','listingSha256']);
 insist(stamp(scan.startedAt)&&scan.startedAt>=startedAt&&scan.completedAt>=scan.startedAt&&scan.completedAt<=capturedAt&&Number.isSafeInteger(scan.pageSize)&&scan.pageSize>0&&scan.pageSize<=1000,'Invalid scan bounds/chronology');
 const objects=bounded(scan.objects,LIMIT.rows).map(listedObject);insist(canonical(objects)===canonical(scan.objects)&&sha(canonical(objects))===scan.listingSha256,'Scan listing integrity mismatch');
 insist(objects.every((o,i)=>!i||o.key>objects[i-1].key),'Duplicate/nonadvancing scan key');
 const pages=bounded(scan.pages,LIMIT.rows+1),cursors=new Set();insist(pages.length>0,'Missing complete scan pages');let offset=0,cursor=null;
 for(let i=0;i<pages.length;i++){
  const p=pages[i];exact(p,['cursor','nextCursor','count','terminal','sha256']);insist(p.cursor===cursor&&Number.isSafeInteger(p.count)&&p.count>=0&&p.count<=scan.pageSize&&p.sha256===sha(canonical(objects.slice(offset,offset+p.count))),'Scan page coverage/hash mismatch');offset+=p.count;
  if(i===pages.length-1)insist(p.nextCursor===null&&(p.terminal==='explicit'||p.terminal==='short-page'&&p.count<scan.pageSize),'Incomplete terminal R2 scan');
  else {insist(p.terminal===null&&typeof p.nextCursor==='string'&&p.nextCursor.length>0&&p.nextCursor.length<=4096&&!cursors.has(p.nextCursor)&&p.nextCursor!==cursor,'Invalid/nonadvancing scan cursor');cursors.add(p.nextCursor);cursor=p.nextCursor;}
 }
 insist(offset===objects.length,'Scan page coverage is incomplete');return objects;
}
const payloadRef=r=>({id:r.payload_id??r.id,shardId:r.payload_shard_id,objectKey:r.payload_object_key,sha256:r.payload_sha256,bytes:r.payload_bytes});
function validateReconciliation(record,inventory) {
 exact(record,['format','capturedAt','sourceFingerprint','central']);insist(record.format===1&&record.capturedAt===inventory.capturedAt&&record.sourceFingerprint===inventory.context.resourceFingerprint,'Reconciliation source/capture mismatch');
 const c=record.central;exact(c,['heads','history','stages','purges','erasures','accounts','emails','lifecycle','permanent','intents','retirements']);
 for(const key of Object.keys(c).filter(k=>!['lifecycle','permanent'].includes(k)))bounded(c[key],LIMIT.rows);
 exact(c.permanent,['providerRevocations','externalBlocks','domainBlocks','receipts','domains','revocations']);for(const rows of Object.values(c.permanent))bounded(rows,LIMIT.rows);
 exact(c.lifecycle,['events','heads','receipts','proofs','guards']);for(const rows of Object.values(c.lifecycle))bounded(rows,LIMIT.rows);
 // Preserve exact ordered lifecycle history and temporal DDL in the sidecar.
 // Restore validates the schema-specific rows before any isolated transaction.
 const guards=c.lifecycle.guards;insist(guards.length===2&&canonical(guards.map(g=>g.name).sort())===canonical(['release_lifecycle_event_time','release_lifecycle_jwt_time']),'Complete lifecycle temporal guards required');
 for(const g of guards){exact(g,['name','sql','sha256']);insist(typeof g.sql==='string'&&sha(g.sql)===g.sha256&&new RegExp('^CREATE TRIGGER '+g.name+'\\b','i').test(g.sql),'Lifecycle guard integrity mismatch');}
 const objects=new Map(inventory.objects.map(o=>[o.key,o]));
 for(const r of [...c.heads.filter(h=>h.erased_at===null),...c.history])if(r.payload_id){const m=objects.get(r.payload_object_key)?.metadata;
  insist(m?.state==='payload'&&m.payloadId===r.payload_id&&m.shardId===r.payload_shard_id&&m.memoryId===(r.memory_id??r.id)&&m.spaceId===r.space_id&&m.sha256===r.payload_sha256,'Retained central history/head lacks exact R2 object');}
 for(const o of objects.values()){const s=c.stages.find(s=>s.id===o.metadata.payloadId);insist(s&&s.space_id===o.metadata.spaceId&&s.memory_id===o.metadata.memoryId&&s.payload_shard_id===o.metadata.shardId&&s.payload_sha256===o.metadata.sha256,'R2 object lacks retained central stage');}
 const heads=c.heads.filter(h=>h.deleted_at===null&&h.erased_at===null&&h.payload_id).map(h=>({spaceId:h.space_id,memoryId:h.id,revision:h.revision,payload:payloadRef(h)}));
 const purges=c.purges.filter(p=>p.purged_at===null).map(p=>({spaceId:p.space_id,memoryId:p.memory_id,payload:payloadRef(p)}));
 insist(canonical(heads)===canonical(inventory.currentHeads)&&canonical(purges)===canonical(inventory.pendingPurges),'Reconciliation differs from inventory heads/purges');
}
/** Files are independently read/hash-checked by the traversal-safe manifest
 * reader. This validates the captured logical proof, never queries a provider. */
export function validateHistoricalEvidence(e,inventory,config,files,reconciliation) {
 const capture=inventory.capture;
 exact(capture,['mode','writesStopped','providersDrained','inventoryComplete','consistentAtCut','evidenceRef','evidenceSha256']);
 insist(capture.mode===HISTORICAL_MODE&&capture.writesStopped===false&&capture.providersDrained===null&&capture.inventoryComplete===true&&digest(capture.evidenceSha256),'Historical cut must explicitly avoid claiming a writer/provider drain');
 exact(e,['format','mode','startedAt','capturedAt','consistentAtCut','context','policy','sourceBefore','sourceAfter','before','after','scanA','scanB','downloads','artifacts','reconciliation','inventoryBodySha256','complete','assumption']);
 insist(e.format===2&&e.mode===HISTORICAL_MODE&&e.complete===true&&stamp(e.startedAt)&&e.capturedAt===inventory.capturedAt&&e.capturedAt>=e.startedAt&&canonical(e.context)===canonical(inventory.context),'Historical capture context/time mismatch');
 insist(e.assumption==='Coordinator excludes out-of-band administrative/S3 writers during this bounded interval; provider reads do not prove absence of global credentials.','Explicit bounded operator assumption required');
 validateHistoricalPolicy(e.policy,config,e.context,e.startedAt);validateHistoricalPolicy(e.policy,config,e.context,e.capturedAt);
 validateWriterObservation(e.sourceBefore,e.policy,config,e.context,e.sourceBefore.observedAt);validateWriterObservation(e.sourceAfter,e.policy,config,e.context,e.sourceAfter.observedAt);
 insist(e.sourceBefore.observedAt>=e.startedAt&&e.sourceAfter.observedAt<=e.capturedAt&&comparableSource(e.sourceBefore)===comparableSource(e.sourceAfter),'Actual source changed across historical cut');
 const bindings=config.d1_databases.map(d=>d.binding);exact(e.before,bindings);exact(e.after,bindings);
 insist(Object.values(e.before).every(v=>typeof v==='string'&&v.length>0&&v.length<=4096)&&canonical(e.before)===canonical(e.after),'Primary D1 bookmark changed or missing');
 const a=validateScan(e.scanA,e.startedAt,e.capturedAt),b=validateScan(e.scanB,e.startedAt,e.capturedAt);
 insist(e.sourceBefore.observedAt<=e.scanA.startedAt&&e.scanA.completedAt<=e.scanB.startedAt&&e.scanB.completedAt<=e.sourceAfter.observedAt&&canonical(a)===canonical(b)&&e.consistentAtCut===e.scanA.completedAt&&capture.consistentAtCut===e.consistentAtCut,'R2/source changed or historical cut chronology is invalid');
 const {capture:unused,...body}=inventory;insist(e.inventoryBodySha256===sha(canonical(body)),'Historical inventory body integrity mismatch');
 const inventoryObjects=new Map(inventory.objects.map(o=>[o.key,o])), fileMap=new Map(files.map(f=>[f.path,f]));
 insist(a.length===inventoryObjects.size,'Historical R2 inventory coverage mismatch');
 const downloads=bounded(e.downloads,LIMIT.rows);insist(downloads.length===a.length&&new Set(downloads.map(d=>d.key)).size===a.length,'Every R2 object needs a unique download receipt');
 for(const o of a){const i=inventoryObjects.get(o.key),d=downloads.find(d=>d.key===o.key);exact(d,['key','bytes','sha256','metadataSha256','metadataBasis','etag']);const f=fileMap.get(i?.file);
  insist(i&&f&&canonical(i.metadata)===canonical(o.custom_metadata)&&f.bytes===o.size&&d.bytes===f.bytes&&d.sha256===f.sha256&&d.etag===o.etag&&d.metadataSha256===sha(canonical(o.custom_metadata))&&d.metadataBasis==='matching-complete-scans','R2 download bytes/metadata evidence mismatch');}
 const artifacts=bounded(e.artifacts,LIMIT.rows+17);insist(artifacts.length===files.length&&new Set(artifacts.map(a=>a.file)).size===files.length,'Complete export/object artifact evidence required');
 for(const a of artifacts){exact(a,['file','bytes','sha256']);const f=fileMap.get(a.file);insist(f&&f.bytes===a.bytes&&f.sha256===a.sha256,'Historical artifact integrity mismatch');}
 exact(e.reconciliation,['file','bytes','sha256']);insist(digest(e.reconciliation.sha256)&&Number.isSafeInteger(e.reconciliation.bytes)&&e.reconciliation.bytes>0,'Invalid reconciliation artifact receipt');
 validateReconciliation(reconciliation,inventory);
}

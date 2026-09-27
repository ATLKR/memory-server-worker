import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHeadFixture} from './seoul-projection-head-fixture.mjs';

export const issuer='https://auth-api.allen.company';
export const sourceId=n=>'01234567-89ab-4cde-8fab-'+n.toString(16).padStart(12,'0');
export const head=(kind,key,revision)=>({kind,key,revision,eventId:sourceId(revision),payloadSha256:'0123456789abcdef'.repeat(4)});
export const subjectKey=subject=>issuer+'\n'+subject;
export const policy={policyVersion:1,residency:'kr-seoul',profile:'kr-primary-storage',processingBoundary:'approved-processors',dataClass:'personal',classificationStatus:'declared',sensitivityTags:[],placementEpoch:1};
export function snapshot(org=false,role='admin') {
  return {version:3,kind:'seoul-authority-snapshot',eventId:'fedcba98-7654-4321-8fed-cba987654321',sourceRevision:7,snapshotSeq:1,issuer,spaceId:'space:one',selected:true,
    accounts:[{id:'account:one',disabledAtMs:null}],
    providerIdentities:[{issuer,subject:'alice',accountId:'account:one',createdAtMs:0}],
    emails:org?[{id:'email:one',accountId:'account:one',address:'alice@example.com',verifiedAtMs:0,revokedAtMs:null}]:[],
    organizations:org?[{id:'org:one',disabledAtMs:null}]:[],
    memberships:org?[{id:'membership:one',accountId:'account:one',emailId:'email:one',organizationId:'org:one',role,expiresAtMs:80000,revokedAtMs:null}]:[],
    credentials:[{id:'credential:one',accountId:'account:one',kind:org?'api_key':'personal_key',permission:'write',tokenDigest:'0123456789abcdef'.repeat(4),membershipId:org?'membership:one':null,emailId:org?'email:one':null,expiresAtMs:90000,revokedAtMs:null}],
    credentialPolicies:[{credentialId:'credential:one',capabilities:['create','read'],spaceIds:null}],
    spaces:[{id:'space:one',accountId:org?null:'account:one',organizationId:org?'org:one':null,disabledAtMs:null,policy:structuredClone(policy)}],
    grants:[{credentialId:'credential:one',accountId:'account:one',spaceId:'space:one',provenance:org?'organization-member':'owner',canIngest:!org||role!=='member',canSearch:true,canErase:false,canRetire:false,expiresAtMs:org?80000:90000,revokedAtMs:null,
      heads:{subjects:[head('subject',subjectKey('alice'),1)],emails:org?[head('email',subjectKey('alice')+'\nalice@example.com',2)]:null,organization:org?head('organization','org:one',3):null,membership:org?head('membership','membership:one',4):null,credential:head('credential','credential:one',5),space:head('space','space:one',6),target:head('target','space:one',7)}}],
    lease:{issuedAtMs:1000,expiresAtMs:61000}};
}
export function emptySnapshot(org=false) {
  const value=snapshot(org); for(const name of ['emails','memberships','credentials','credentialPolicies','grants'])value[name]=[];
  if(org){value.accounts=[];value.providerIdentities=[];} return value;
}
const cmp=(a,b)=>a<b?-1:a>b?1:0;
export function addIdentity(value,subject) {
  value.providerIdentities.push({issuer,subject,accountId:'account:one',createdAtMs:0});
  value.providerIdentities.sort((a,b)=>cmp(a.subject,b.subject));
  const sub=head('subject',subjectKey(subject),++value.sourceRevision);
  const mail=value.emails.length?head('email',subjectKey(subject)+'\nalice@example.com',++value.sourceRevision):null;
  for(const g of value.grants){g.heads.subjects.push(structuredClone(sub));g.heads.subjects.sort((a,b)=>cmp(a.key,b.key));if(mail){g.heads.emails.push(structuredClone(mail));g.heads.emails.sort((a,b)=>cmp(a.key,b.key));}}
  return value;
}
export function addCredential(value,index) {
  const id='credential:'+String(index).padStart(3,'0'),c=structuredClone(value.credentials[0]),p=structuredClone(value.credentialPolicies[0]),g=structuredClone(value.grants[0]);
  c.id=id;c.tokenDigest=index.toString(16).padStart(64,'0');p.credentialId=id;g.credentialId=id;g.heads.credential=head('credential',id,++value.sourceRevision);
  value.credentials.push(c);value.credentialPolicies.push(p);value.grants.push(g);
  value.credentials.sort((a,b)=>cmp(a.id,b.id));for(const k of ['credentialPolicies','grants'])value[k].sort((a,b)=>cmp(a.credentialId,b.credentialId));return value;
}
export function twoAccounts() {
  const value=addCredential(snapshot(true),2);
  value.accounts.push({id:'account:two',disabledAtMs:null});value.providerIdentities.push({issuer,subject:'bob',accountId:'account:two',createdAtMs:0});
  value.emails.push({id:'email:two',accountId:'account:two',address:'bob@example.com',verifiedAtMs:0,revokedAtMs:null});
  value.memberships.push({id:'membership:two',accountId:'account:two',emailId:'email:two',organizationId:'org:one',role:'member',expiresAtMs:80000,revokedAtMs:null});
  const c=value.credentials[0],g=value.grants[0];c.accountId='account:two';c.emailId='email:two';c.membershipId='membership:two';g.accountId='account:two';g.canIngest=false;
  g.heads.subjects=[head('subject',subjectKey('bob'),++value.sourceRevision)];g.heads.emails=[head('email',subjectKey('bob')+'\nbob@example.com',++value.sourceRevision)];g.heads.membership=head('membership','membership:two',++value.sourceRevision);
  return value;
}
export function boundarySnapshot() {
  const value=emptySnapshot();value.providerIdentities=Array.from({length:250},(_,i)=>({issuer,subject:'s'+String(i).padStart(3,'0'),accountId:'account:one',createdAtMs:0}));
  let left=131072-Buffer.byteLength(JSON.stringify(value));
  for(const row of value.providerIdentities){const n=Math.min(508,left);row.subject+='x'.repeat(n);left-=n;}assert.equal(left,0);return value;
}
export function compactCredentials(count) {
  const value=emptySnapshot();value.spaceId='s';value.sourceRevision=count+3;value.accounts=[{id:'a',disabledAtMs:null}];value.providerIdentities=[{issuer,subject:'u',accountId:'a',createdAtMs:0}];value.spaces[0].id='s';value.spaces[0].accountId='a';value.lease={issuedAtMs:0,expiresAtMs:60000};
  const chars='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';const ids=Array.from({length:count},(_,i)=>i<62?chars[i]:'0'+chars[i-62]).sort();
  for(const [index,id] of ids.entries()){
    value.credentials.push({id,accountId:'a',kind:'personal_key',permission:'read',tokenDigest:index.toString(16).padStart(64,'0'),membershipId:null,emailId:null,expiresAtMs:1,revokedAtMs:null});
    value.credentialPolicies.push({credentialId:id,capabilities:['read'],spaceIds:null});
    value.grants.push({credentialId:id,accountId:'a',spaceId:'s',provenance:'owner',canIngest:false,canSearch:true,canErase:false,canRetire:false,expiresAtMs:1,revokedAtMs:null,heads:{subjects:[head('subject',subjectKey('u'),1)],emails:null,organization:null,membership:null,credential:head('credential',id,index+4),space:head('space','s',2),target:head('target','s',3)}});
  }return value;
}
export async function createSnapshotFixture(t,{install=true}={}) {
  const f=await createHeadFixture(t,{seed:true});
  const installValidation=async()=>{
    const sql=await readFile(new URL('../../postgres/projection-v3/snapshot-validation.sql',import.meta.url),'utf8');
    await f.asRole('fixture_provisioner',db=>db.exec(sql));
  };
  const validate=raw=>f.asRole('postgres',async db=>(await db.query('SELECT memory_identity.projection_v3_snapshot_canonical($1::text) AS value',[raw])).rows[0].value);
  if(install)await installValidation();return {...f,installValidation,validate};
}

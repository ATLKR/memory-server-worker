import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeSeoulAuthoritySnapshot,decodeSeoulAuthoritySnapshot} from '../../src/release/seoul-projection-snapshot-codec.ts';
import {createSnapshotFixture,snapshot,emptySnapshot,addIdentity,addCredential,twoAccounts,boundarySnapshot,compactCredentials,head,subjectKey,issuer} from './seoul-projection-snapshot-validation-fixture.mjs';
import {event,wire as headWire} from './seoul-projection-head-fixture.mjs';

const wire=value=>Buffer.from(encodeSeoulAuthoritySnapshot(value)).toString('utf8');
const ZERO='{"version":3,"kind":"seoul-authority-snapshot","eventId":"fedcba98-7654-4321-8fed-cba987654321","sourceRevision":7,"snapshotSeq":1,"issuer":"https://auth-api.allen.company","spaceId":"space:one","selected":true,"accounts":[{"id":"account:one","disabledAtMs":null}],"providerIdentities":[{"issuer":"https://auth-api.allen.company","subject":"alice","accountId":"account:one","createdAtMs":0}],"emails":[],"organizations":[],"memberships":[],"credentials":[],"credentialPolicies":[],"spaces":[{"id":"space:one","accountId":"account:one","organizationId":null,"disabledAtMs":null,"policy":{"policyVersion":1,"residency":"kr-seoul","profile":"kr-primary-storage","processingBoundary":"approved-processors","dataClass":"personal","classificationStatus":"declared","sensitivityTags":[],"placementEpoch":1}}],"grants":[],"lease":{"issuedAtMs":1000,"expiresAtMs":61000}}';
const invalid=async(f,raw)=>{
  if(typeof raw==='string')assert.throws(()=>decodeSeoulAuthoritySnapshot(Buffer.from(raw)),/seoul_snapshot_invalid/);
  await assert.rejects(f.validate(raw),e=>e.message==='seoul_projection_input_invalid'&&e.code==='PP001'&&!e.detail&&!e.hint);
};

test('pure snapshot SQL returns exact independent zero wire and populated canonical layouts',async t=>{
  const f=await createSnapshotFixture(t);assert.equal(JSON.stringify(emptySnapshot()),ZERO);assert.equal(wire(emptySnapshot()),ZERO);assert.equal(await f.validate(ZERO),ZERO);
  const engine=(await f.db.query("SELECT version() AS version,current_setting('server_encoding') AS encoding")).rows[0];assert.equal(engine.encoding,'UTF8');t.diagnostic(JSON.stringify({...engine,node:process.version}));
  // Independently enumerate every populated record field; JSON.stringify on the
  // fixture remains independent of the codec reconstruction being compared.
  const expected={accounts:['id','disabledAtMs'],providerIdentities:['issuer','subject','accountId','createdAtMs'],emails:['id','accountId','address','verifiedAtMs','revokedAtMs'],organizations:['id','disabledAtMs'],memberships:['id','accountId','emailId','organizationId','role','expiresAtMs','revokedAtMs'],credentials:['id','accountId','kind','permission','tokenDigest','membershipId','emailId','expiresAtMs','revokedAtMs'],credentialPolicies:['credentialId','capabilities','spaceIds'],spaces:['id','accountId','organizationId','disabledAtMs','policy'],grants:['credentialId','accountId','spaceId','provenance','canIngest','canSearch','canErase','canRetire','expiresAtMs','revokedAtMs','heads']};
  const org=snapshot(true);for(const [key,fields] of Object.entries(expected))assert.deepEqual(Object.keys(org[key][0]),fields);
  assert.deepEqual(Object.keys(org.grants[0].heads),['subjects','emails','organization','membership','credential','space','target']);
  assert.deepEqual(Object.keys(org.grants[0].heads.credential),['kind','key','revision','eventId','payloadSha256']);
  const cases=[snapshot(),org,snapshot(true,'member'),snapshot(true,'owner'),emptySnapshot(true),addCredential(addIdentity(snapshot(true),'bob'),2),twoAccounts()];
  const disabled=emptySnapshot();disabled.selected=false;disabled.accounts[0].disabledAtMs=0;disabled.spaces[0].disabledAtMs=1;cases.push(disabled);
  const scope=snapshot();scope.credentialPolicies[0].spaceIds=['space:one','space:two'];scope.spaces[0].policy.sensitivityTags=['clinical-origin','health'];cases.push(scope);
  const unicode=addIdentity(addIdentity(addIdentity(snapshot(true),'a\n'), 'a'), '\u{10000}');addIdentity(unicode,'\ue000');addIdentity(unicode,'x\t"\\\r\b\f\u2028\u2029');cases.push(unicode);
  const long=addIdentity(snapshot(),'😀'.repeat(256));cases.push(long);
  const maxTime=emptySnapshot();maxTime.sourceRevision=Number.MAX_SAFE_INTEGER;maxTime.snapshotSeq=Number.MAX_SAFE_INTEGER;maxTime.providerIdentities[0].createdAtMs=Number.MAX_SAFE_INTEGER;maxTime.lease={issuedAtMs:Number.MAX_SAFE_INTEGER-60000,expiresAtMs:Number.MAX_SAFE_INTEGER};cases.push(maxTime);
  const explicit50=snapshot();explicit50.credentialPolicies[0].spaceIds=Array.from({length:49},(_,i)=>'s'+String(i).padStart(3,'0')).concat('space:one');cases.push(explicit50);
  const createOnly=snapshot();createOnly.credentialPolicies[0].capabilities=['create'];createOnly.grants[0].canSearch=false;cases.push(createOnly);
  for(const value of cases){const raw=JSON.stringify(value);assert.equal(wire(value),raw);assert.equal(await f.validate(raw),raw);}
  const normalized=(await f.db.query('SELECT $1::jsonb::text AS raw',[ZERO])).rows[0].raw;await invalid(f,normalized);
});

test('pure snapshot SQL rejects noncanonical or unsupported raw text and scalar shapes',async t=>{
  const f=await createSnapshotFixture(t);const org=JSON.stringify(snapshot(true));
  const rawCases=[null,'','{', 'null','[]','{}',' '+ZERO,ZERO+'\n','\ufeff'+ZERO,ZERO.replace('"version":3','"version":3,"version":3'),ZERO.replace('"version":3','"version":3,"\\u0076ersion":3'),ZERO.replace('"version":3','"kind":"seoul-authority-snapshot","version":3'),ZERO.replace('"version":3','"version":3.0'),ZERO.replace('"snapshotSeq":1','"snapshotSeq":1e0'),ZERO.replace('"createdAtMs":0','"createdAtMs":-0'),ZERO.replace('alice','\\u0061lice'),ZERO.replace('https://auth-api','https:\\/\\/auth-api'),ZERO.replace('"version":3','"version":3,"extra":true'),org.replace('"id":"email:one","accountId":"account:one"','"accountId":"account:one","id":"email:one"')];
  for(const raw of rawCases)await invalid(f,raw);
  const mutations=[x=>x.version=4,x=>x.snapshotSeq=0,x=>x.sourceRevision=9007199254740992,x=>x.lease.issuedAtMs=9007199254740990,x=>x.lease.expiresAtMs++,x=>x.selected='true',x=>x.eventId=x.eventId.toUpperCase(),x=>x.spaceId='space/one',x=>x.providerIdentities[0].issuer+='/',x=>x.providerIdentities[0].subject='\u00a0\ufeff',x=>x.providerIdentities[0].subject='a\0b',x=>x.providerIdentities[0].subject='\ud800',x=>x.providerIdentities[0].subject='😀'.repeat(257),x=>x.emails[0].address='Alice@example.com',x=>x.emails[0].address='a..b@example.com',x=>x.emails[0].address='a@-bad.example',x=>x.credentials[0].tokenDigest='A'.repeat(64),x=>x.memberships[0].role='superadmin',x=>x.credentials[0].permission='erase',x=>x.grants[0].canErase=true,x=>x.grants[0].canRetire=true,x=>x.grants[0].revokedAtMs=1,x=>x.spaces[0].policy.retention='forever',x=>x.spaces[0].policy.placementEpoch=2,x=>x.spaces[0].policy.sensitivityTags=['clinical-origin'],x=>x.credentialPolicies[0].capabilities=['read','create'],x=>x.credentialPolicies[0].capabilities=['read','read'],x=>x.credentialPolicies[0].spaceIds=[],x=>x.credentialPolicies[0].spaceIds=Array.from({length:51},(_,i)=>'s'+String(i).padStart(3,'0')),x=>x.grants[0].heads.credential.revision=0,x=>x.grants[0].heads.target.revision=8,x=>x.grants[0].heads.credential.extra=true];
  for(const mutate of mutations){const value=snapshot(true);mutate(value);await invalid(f,JSON.stringify(value));}
  // A newline inside an email must not be reinterpreted as more opaque subject
  // text by the reused composite-head validator.
  for(const address of ['prefix\nalice@example.com','alice@example.com\n','alice@example.com\u2028','a@exa_mple.com','a@x','a@x..com','a'.repeat(65)+'@x.com']){
    const value=snapshot(true);value.emails[0].address=address;value.grants[0].heads.emails[0].key=subjectKey('alice')+'\n'+address;await invalid(f,JSON.stringify(value));
  }
  for(const address of ['a+b@example.com',"!#$%&'*+/=?^_`{|}~@x.example",'a@xn--a.example']){
    const value=snapshot(true);value.emails[0].address=address;value.grants[0].heads.emails[0].key=subjectKey('alice')+'\n'+address;const raw=wire(value);assert.equal(await f.validate(raw),raw);
  }
});

test('pure snapshot SQL enforces complete graph, live policy and immutable source identities',async t=>{
  const f=await createSnapshotFixture(t);
  const mutations=[x=>x.spaces=[],x=>x.spaces.push({...x.spaces[0],id:'space:two'}),x=>x.spaces[0].accountId='account:one',x=>x.accounts=[],x=>x.providerIdentities=[],x=>x.providerIdentities[0].accountId='account:other',x=>x.accounts.push({id:'account:two',disabledAtMs:null}),x=>x.selected=false,x=>x.accounts[0].disabledAtMs=0,x=>x.spaces[0].disabledAtMs=0,x=>x.organizations[0].disabledAtMs=0,x=>x.credentials[0].revokedAtMs=0,x=>x.credentials[0].expiresAtMs=1000,x=>x.emails[0].verifiedAtMs=1001,x=>x.emails[0].revokedAtMs=0,x=>x.memberships[0].revokedAtMs=0,x=>x.memberships[0].expiresAtMs=1000,x=>x.credentials[0].emailId='email:absent',x=>x.credentials[0].membershipId=null,x=>x.credentials[0].accountId='account:other',x=>x.memberships[0].accountId='account:other',x=>x.memberships[0].emailId='email:other',x=>x.memberships[0].organizationId='org:other',x=>x.emails[0].accountId='account:other',x=>x.grants[0].accountId='account:other',x=>x.grants[0].spaceId='space:other',x=>x.grants[0].credentialId='credential:other',x=>x.credentialPolicies[0].credentialId='credential:other',x=>x.credentialPolicies=[],x=>x.grants=[],x=>x.grants[0].provenance='owner',x=>x.credentials[0].kind='personal_key',x=>x.credentialPolicies[0].spaceIds=['space:other'],x=>x.credentialPolicies[0].capabilities=['update'],x=>x.credentials[0].permission='read',x=>x.memberships[0].role='member',x=>x.grants[0].canSearch=false,x=>x.grants[0].canIngest=false,x=>x.grants[0].expiresAtMs=90000,x=>x.grants[0].heads.subjects=[],x=>x.grants[0].heads.emails=null,x=>x.grants[0].heads.organization=null,x=>x.grants[0].heads.membership=null,x=>x.grants[0].heads.target.key='space:other',x=>x.grants[0].heads.credential.kind='organization',x=>x.grants[0].heads.emails[0].key=subjectKey('alice')+'\nother@example.com',x=>x.grants[0].heads.target.revision=6,x=>x.grants[0].heads.target.eventId=x.grants[0].heads.space.eventId,x=>x.eventId=x.grants[0].heads.credential.eventId];
  for(const mutate of mutations){const value=snapshot(true);mutate(value);await invalid(f,JSON.stringify(value));}
  const ownerMutations=[x=>x.credentials[0].kind='api_key',x=>x.credentials[0].membershipId='membership:one',x=>x.credentials[0].emailId='email:one',x=>x.grants[0].heads.emails=[],x=>x.grants[0].heads.organization=head('organization','org:one',3),x=>x.spaces[0].accountId='account:other'];
  for(const mutate of ownerMutations){const value=snapshot();mutate(value);await invalid(f,JSON.stringify(value));}
  const multipleMutations=[x=>x.grants[1].heads.subjects[0].payloadSha256='f'.repeat(64),x=>x.credentials[1].tokenDigest=x.credentials[0].tokenDigest,x=>x.grants[1].heads.subjects.pop(),x=>x.grants[1].heads.emails.pop(),x=>x.grants[0].heads.subjects.reverse(),x=>x.grants[0].heads.emails.reverse(),x=>x.providerIdentities.reverse(),x=>x.credentials.reverse(),x=>x.credentialPolicies.reverse(),x=>x.grants.reverse(),x=>x.providerIdentities.push({...x.providerIdentities[0]}),x=>x.emails.push({...x.emails[0],id:'email:two'}),x=>x.memberships.push({...x.memberships[0],id:'membership:two'})];
  for(const mutate of multipleMutations){const value=addCredential(addIdentity(snapshot(true),'bob'),2);mutate(value);await invalid(f,JSON.stringify(value));}
  // Both aliases remain reachable and every head matches its supplied account:
  // only the cross-account duplicate address violates the regional row graph.
  const duplicateAddress=twoAccounts();duplicateAddress.emails[1].address='alice@example.com';duplicateAddress.grants[0].heads.emails[0].key=subjectKey('bob')+'\nalice@example.com';await invalid(f,JSON.stringify(duplicateAddress));
  // Both memberships remain reachable through different credentials. Their
  // separate IDs/source events cannot authorize two live org/account tuples.
  const duplicateMembership=addCredential(snapshot(true),2);duplicateMembership.memberships.push({...duplicateMembership.memberships[0],id:'membership:two'});duplicateMembership.credentials[0].membershipId='membership:two';duplicateMembership.grants[0].heads.membership=head('membership','membership:two',++duplicateMembership.sourceRevision);await invalid(f,JSON.stringify(duplicateMembership));
  const duplicateIdentity=twoAccounts();duplicateIdentity.providerIdentities[1].subject='alice';duplicateIdentity.grants[0].heads.subjects[0].key=subjectKey('alice');duplicateIdentity.grants[0].heads.emails[0].key=subjectKey('alice')+'\nbob@example.com';await invalid(f,JSON.stringify(duplicateIdentity));
  const swappedEmailOrder=addIdentity(snapshot(true),'alice\n');swappedEmailOrder.grants[0].heads.emails.sort((a,b)=>a.key.replace(/\nalice@example.com$/,'')<b.key.replace(/\nalice@example.com$/,'')?-1:1);await invalid(f,JSON.stringify(swappedEmailOrder));
});

test('pure snapshot SQL matches UTF16 comparison and strict byte/credential boundaries',async t=>{
  const f=await createSnapshotFixture(t);
  const raw=wire(boundarySnapshot());assert.equal(Buffer.byteLength(raw),131072);assert.equal(await f.validate(raw),raw);
  const tooBig=boundarySnapshot();tooBig.providerIdentities.at(-1).subject+='x';assert.equal(Buffer.byteLength(JSON.stringify(tooBig)),131073);await invalid(f,JSON.stringify(tooBig));
  const compact=wire(compactCredentials(100));assert.equal(Buffer.byteLength(compact),130158);assert.equal(await f.validate(compact),compact);
  const over=JSON.stringify(compactCredentials(101));assert.equal(Buffer.byteLength(over),131455);await invalid(f,over);
  const unicode=addIdentity(addIdentity(snapshot(true),'\u{10000}'),'\ue000');assert.equal(await f.validate(wire(unicode)),wire(unicode));
  const wrong=structuredClone(unicode);wrong.providerIdentities.sort((a,b)=>Buffer.compare(Buffer.from(a.subject),Buffer.from(b.subject)));await invalid(f,JSON.stringify(wrong));
  const units=['','a','a\n','a\na','a\nb','\ud7ff','\u{10000}','\u{1f600}','\u{10ffff}','\ue000','\uffff'];
  const sorted=[...units].sort();const result=(await f.db.query('SELECT v FROM unnest($1::text[]) AS x(v) ORDER BY memory_identity.projection_v3_snapshot_utf16(v)',[units])).rows.map(x=>x.v);assert.deepEqual(result,sorted);
  for(const value of units){const expected=Array.from({length:value.length},(_,i)=>value.charCodeAt(i));assert.deepEqual((await f.db.query('SELECT memory_identity.projection_v3_snapshot_utf16($1) AS key',[value])).rows[0].key,expected);}
});

test('pure snapshot SQL agrees on every capability subset, permission and direct role',async t=>{
  const f=await createSnapshotFixture(t),names=['create','delete','export','read','update'];
  for(const [org,role] of [[false,'owner'],[true,'owner'],[true,'admin'],[true,'member']])for(const permission of ['read','write'])for(let bits=0;bits<32;bits++){
    const value=snapshot(org,role),caps=names.filter((_,i)=>(bits&(1<<i))!==0);value.credentialPolicies[0].capabilities=caps;value.credentials[0].permission=permission;
    const g=value.grants[0];g.canSearch=caps.includes('read');g.canIngest=caps.includes('create')&&permission==='write'&&role!=='member';
    const raw=JSON.stringify(value);if(g.canSearch||g.canIngest){assert.equal(wire(value),raw);assert.equal(await f.validate(raw),raw);}else await invalid(f,raw);
  }
});

test('pure snapshot extension preserves authority, catalogue and role boundaries',async t=>{
  const f=await createSnapshotFixture(t,{install:false});
  await f.apply(headWire(event(1)));
  const catalogue=async()=>({
    classes:(await f.db.query("SELECT n.nspname,c.relname,c.relacl,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'memory_%' ORDER BY 1,2")).rows,
    defaults:(await f.db.query('SELECT * FROM pg_default_acl ORDER BY oid')).rows,
    members:(await f.db.query('SELECT * FROM pg_auth_members ORDER BY roleid,member,grantor')).rows,
    schemas:(await f.db.query("SELECT nspname,nspacl FROM pg_namespace WHERE nspname LIKE 'memory_%' ORDER BY 1")).rows,
    functions:(await f.db.query("SELECT p.oid,p.proowner,p.proacl,pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'memory_%' AND p.proname NOT LIKE 'projection_v3_snapshot_%' ORDER BY p.oid")).rows,
  });
  const rows=async()=>{const names=(await f.db.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname LIKE 'memory_%' ORDER BY 1,2")).rows;const out={};for(const n of names)out[n.schemaname+'.'+n.tablename]=(await f.db.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) AS rows FROM ${n.schemaname}.${n.tablename} x`)).rows[0].rows;return out;};
  const before=await catalogue(),beforeRows=await rows();await f.installValidation();assert.deepEqual(await catalogue(),before);assert.deepEqual(await rows(),beforeRows);
  const funcs=(await f.db.query("SELECT p.proname,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.provolatile,p.proconfig,p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='memory_identity' AND p.proname LIKE 'projection_v3_snapshot_%' ORDER BY 1")).rows;
  assert.deepEqual(funcs.map(x=>x.proname),['projection_v3_snapshot_canonical','projection_v3_snapshot_graph','projection_v3_snapshot_utf16','projection_v3_snapshot_value']);for(const x of funcs){assert.equal(x.owner,'memory_projection_owner');assert.equal(x.prosecdef,false);assert.equal(x.provolatile,'i');assert.deepEqual(x.proconfig,['search_path=pg_catalog']);assert.deepEqual(x.proacl,['memory_projection_owner=X/memory_projection_owner']);}
  const privileges=(await f.db.query("SELECT r.rolname,p.proname,has_function_privilege(r.oid,p.oid,'EXECUTE') AS allowed FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='memory_identity' AND p.proname LIKE 'projection_v3_snapshot_%' AND r.rolname IN('memory_owner','memory_runtime','memory_projection_caller','projection_test_login','fixture_provisioner','anon','authenticated')")).rows;assert.equal(privileges.length,funcs.length*7);assert.ok(privileges.every(x=>x.allowed===false));
  for(const role of ['memory_runtime','memory_owner','memory_projection_caller','projection_test_login','fixture_provisioner','anon','authenticated'])await assert.rejects(f.asRole(role,db=>db.query('SELECT memory_identity.projection_v3_snapshot_canonical($1)',[ZERO])),/permission denied/);
  await f.asRole('postgres',async db=>{await db.exec('SET ROLE memory_projection_owner');assert.equal((await db.query('SELECT memory_identity.projection_v3_snapshot_canonical($1) AS value',[ZERO])).rows[0].value,ZERO);});
  assert.equal(await f.validate(wire(snapshot(true))),wire(snapshot(true)));await invalid(f,'private rejected payload');await assert.rejects(f.apply(ZERO),/seoul_projection_input_invalid/);assert.deepEqual(await catalogue(),before);assert.deepEqual(await rows(),beforeRows);
});

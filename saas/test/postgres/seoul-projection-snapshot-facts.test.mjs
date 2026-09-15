import test from 'node:test';
import assert from 'node:assert/strict';
import {createFactsFixture,snapshot,emptySnapshot,addIdentity,addCredential,twoAccounts,subjectKey,issuer,keys,expected,wire,invalid,functionName,otherSpace,surface,largeSubjectSnapshot} from './seoul-projection-snapshot-facts-fixture.mjs';
import {event,wire as headWire,hash} from './seoul-projection-head-fixture.mjs';

test('B1 six independent exact grains and personal optional-null applicability',async t=>{
  const f=await createFactsFixture(t);
  for(const org of [false,true]){const p=snapshot(org),want=expected(org);for(const kind of org?Object.keys(keys):['subject','credential','space'])assert.deepEqual(await f.extract(p,kind,keys[kind]),want[kind]);}
  for(const kind of ['email','organization','membership'])await assert.rejects(f.extract(snapshot(),kind,keys[kind]),invalid);
  const result=await f.extract(snapshot(),'credential',keys.credential);assert.equal(result.credential.membershipId,null);assert.equal(result.credential.emailId,null);assert.equal(result.credential.revokedAtMs,null);assert.equal(result.credentialPolicy.spaceIds,null);
  t.diagnostic(JSON.stringify({node:process.version,...(await f.db.query('SELECT version() AS engine')).rows[0]}));
});

test('B1 aliases and credentials share exact account/member grains without merging references',async t=>{
  const f=await createFactsFixture(t),p=addCredential(addIdentity(snapshot(true),'bob'),2);
  const want=expected(true);want.subject.providerIdentities.push({issuer,subject:'bob',accountId:'account:one',createdAtMs:0});
  for(const subject of ['alice','bob']){assert.deepEqual(await f.extract(p,'subject',subjectKey(subject)),want.subject);assert.deepEqual(await f.extract(p,'email',subjectKey(subject)+'\nalice@example.com'),want.email);}
  assert.deepEqual(await f.extract(p,'membership',keys.membership),want.membership);
  const other=twoAccounts();const a=await f.extract(other,'subject',subjectKey('bob'));assert.deepEqual(a,{account:{id:'account:two',disabledAtMs:null},providerIdentities:[{issuer,subject:'bob',accountId:'account:two',createdAtMs:0}]});
});

test('B1 global grains exclude consuming Space sequence checkpoint lease and derived grants',async t=>{
  const f=await createFactsFixture(t),p=snapshot(true);p.credentialPolicies[0]={credentialId:keys.credential,capabilities:['create','delete','export','read','update'],spaceIds:['space:one','space:two','space:unused']};
  const q=otherSpace(p);
  for(const kind of ['subject','email','organization','membership','credential'])assert.deepEqual(await f.extract(p,kind,keys[kind]),await f.extract(q,kind,keys[kind]));
  assert.notDeepEqual(await f.extract(p,'space',keys.space),await f.extract(q,'space',q.spaceId));
  assert.deepEqual((await f.extract(q,'credential',keys.credential)).credentialPolicy,p.credentialPolicies[0]);
  const member=snapshot(true,'member'),admin=snapshot(true,'admin');assert.equal(member.grants[0].canIngest,false);assert.equal(admin.grants[0].canIngest,true);
  assert.deepEqual(await f.extract(member,'credential',keys.credential),await f.extract(admin,'credential',keys.credential));
  const shorter=structuredClone(p);shorter.credentials[0].expiresAtMs=70000;shorter.grants[0].expiresAtMs=70000;
  assert.deepEqual(await f.extract(shorter,'membership',keys.membership),await f.extract(p,'membership',keys.membership));
});

test('B1 relevant fact changes retain complete signed policies and exact source grain',async t=>{
  const f=await createFactsFixture(t),p=snapshot(true),cases=[
    ['subject',x=>x.providerIdentities[0].createdAtMs=1],['email',x=>x.emails[0].verifiedAtMs=1],
    ['membership',x=>{x.memberships[0].role='member';x.grants[0].canIngest=false;}],
    ['membership',x=>{x.memberships[0].expiresAtMs=70000;x.grants[0].expiresAtMs=70000;}],
    ['credential',x=>x.credentialPolicies[0].capabilities=['create','export','read']],
    ['credential',x=>x.credentialPolicies[0].spaceIds=['space:one','space:other']],
    ['space',x=>x.spaces[0].policy.sensitivityTags=['clinical-origin','health']]
  ];
  for(const [kind,mutate] of cases){const q=structuredClone(p);mutate(q);assert.notDeepEqual(await f.extract(q,kind,keys[kind]),await f.extract(p,kind,keys[kind]));}
  const changed=structuredClone(p);changed.spaces[0].policy.sensitivityTags=['credential'];assert.deepEqual(await f.extract(changed,'credential',keys.credential),await f.extract(p,'credential',keys.credential));
});

test('B1 opaque subject and final mailbox delimiter preserve UTF16 provider order',async t=>{
  const f=await createFactsFixture(t),subjects=['a','a\n','a\na','a"\\\t\r\b\f','\u{10000}','\ue000','😀'.repeat(256)];let p=snapshot(true);for(const value of subjects)addIdentity(p,value);
  const want=expected(true);want.subject.providerIdentities=['alice',...subjects].sort().map(subject=>({issuer,subject,accountId:'account:one',createdAtMs:0}));
  for(const subject of subjects){assert.deepEqual(await f.extract(p,'subject',subjectKey(subject)),want.subject);assert.deepEqual(await f.extract(p,'email',subjectKey(subject)+'\nalice@example.com'),want.email);}
  assert.ok(want.subject.providerIdentities.findIndex(x=>x.subject==='\u{10000}')<want.subject.providerIdentities.findIndex(x=>x.subject==='\ue000'));
});

test('B1 SQL and JSON null invalid requests are distinct from valid nullable fields',async t=>{
  const f=await createFactsFixture(t),p=snapshot();
  for(const [value,kind,key] of [[undefined,'subject',keys.subject],[null,'subject',keys.subject],[p,null,keys.subject],[p,'subject',null],[p,'target',p.spaceId],[p,'unknown','x'],[p,'subject','alice'],[p,'subject',issuer+'\n '],[p,'subject',subjectKey('😀'.repeat(257))],[p,'email',subjectKey('alice')+'\nAlice@example.com'],[p,'credential','bad/id'],[p,'space','s'.repeat(129)]])await assert.rejects(f.local(value,kind,key),invalid);
  for(const org of [false,true])for(const kind of Object.keys(keys))await assert.rejects(f.extract(emptySnapshot(org),kind,keys[kind]),invalid);
});

test('B1 exact kind plus key reference is required, descriptive row alone is insufficient',async t=>{
  const f=await createFactsFixture(t);
  for(const kind of Object.keys(keys)){
    const p=snapshot(true);if(kind==='subject')p.grants[0].heads.subjects=[];else if(kind==='email')p.grants[0].heads.emails=null;else p.grants[0].heads[kind]=null;
    await assert.rejects(f.local(p,kind,keys[kind]),invalid);
    const wrong=snapshot(true);const ref=['subject','email'].includes(kind)?wrong.grants[0].heads[kind==='subject'?'subjects':'emails'][0]:wrong.grants[0].heads[kind];ref.kind='target';await assert.rejects(f.local(wrong,kind,keys[kind]),invalid);
  }
  await assert.rejects(f.extract(snapshot(true),'credential','credential:absent'),invalid);
});

test('B1 duplicate absent and mismatched local row joins fail fixed PP001',async t=>{
  const f=await createFactsFixture(t),mutations=[
    ['subject',p=>p.accounts=[]],['subject',p=>p.accounts.push({...p.accounts[0]})],['subject',p=>p.providerIdentities=[]],['subject',p=>p.providerIdentities.push({...p.providerIdentities[0]})],['subject',p=>p.providerIdentities[0].accountId='account:other'],
    ['email',p=>p.emails=[]],['email',p=>p.emails.push({...p.emails[0]})],['email',p=>p.emails[0].accountId='account:other'],['email',p=>p.credentials[0].emailId='email:other'],['email',p=>p.memberships[0].emailId='email:other'],
    ['organization',p=>p.organizations=[]],['organization',p=>p.organizations.push({...p.organizations[0]})],['organization',p=>p.spaces[0].organizationId='org:other'],
    ['membership',p=>p.memberships=[]],['membership',p=>p.memberships.push({...p.memberships[0]})],['membership',p=>p.memberships[0].accountId='account:other'],['membership',p=>p.memberships[0].organizationId='org:other'],
    ['credential',p=>p.credentials=[]],['credential',p=>p.credentials.push({...p.credentials[0]})],['credential',p=>p.credentialPolicies=[]],['credential',p=>p.credentialPolicies.push({...p.credentialPolicies[0]})],['credential',p=>p.credentialPolicies[0].credentialId='credential:other'],['credential',p=>p.credentialPolicies[0].spaceIds=['space:elsewhere']],
    ['space',p=>p.spaces=[]],['space',p=>p.spaces.push({...p.spaces[0]})],['space',p=>p.spaces[0].accountId='account:one'],['space',p=>p.spaceId='space:other'],
    ['subject',p=>p.grants[0].accountId='account:other'],['credential',p=>p.grants[0].credentialId='credential:other']
  ];
  for(const [kind,mutate] of mutations){const p=snapshot(true);mutate(p);await assert.rejects(f.local(p,kind,keys[kind]),invalid);}
});

test('B1 required closed results reject extra missing or ill-typed local fields',async t=>{
  const f=await createFactsFixture(t),rows={subject:'accounts',email:'emails',organization:'organizations',membership:'memberships',credential:'credentials',space:'spaces'};
  for(const [kind,table] of Object.entries(rows))for(const mutate of [row=>row.extra=true,row=>delete row.id,row=>row.id=null]){const p=snapshot(true);mutate(p[table][0]);await assert.rejects(f.local(p,kind,keys[kind]),invalid);}
  for(const mutate of [p=>p.credentialPolicies[0].extra=true,p=>p.credentialPolicies[0].capabilities=null,p=>p.spaces[0].policy.placementEpoch=2,p=>p.providerIdentities[0].createdAtMs=null]){const p=snapshot(true);mutate(p);await assert.rejects(f.local(p,p.credentialPolicies[0].extra||p.credentialPolicies[0].capabilities===null?'credential':p.spaces[0].policy.placementEpoch===2?'space':'subject',p.credentialPolicies[0].extra||p.credentialPolicies[0].capabilities===null?keys.credential:p.spaces[0].policy.placementEpoch===2?keys.space:keys.subject),invalid);}
});

test('B1 raw-validator composition rejects duplicate noncanonical malformed and oversized input',async t=>{
  const f=await createFactsFixture(t),raw=wire(snapshot());
  for(const bad of [null,'','{','null','[]',' '+raw,raw+'\n',raw.replace('"version":3','"version":3,"version":3'),raw.replace('"version":3','"version":3.0'),raw.replace('alice','\\u0061lice'),raw+' '.repeat(131072)])await assert.rejects(f.fromRaw(bad,'subject',keys.subject),invalid);
});

test('B1 largest fixture measures compact and PostgreSQL fact sizes separately',async t=>{
  const f=await createFactsFixture(t),p=largeSubjectSnapshot(),raw=wire(p),fact=await f.extract(p,'subject',keys.subject);
  const expectedProviders=p.providerIdentities.map(row=>({issuer:row.issuer,subject:row.subject,accountId:row.accountId,createdAtMs:row.createdAtMs}));assert.deepEqual(fact,{account:{id:'account:one',disabledAtMs:null},providerIdentities:expectedProviders});
  const compact=Buffer.byteLength(JSON.stringify({account:fact.account,providerIdentities:expectedProviders}));
  const pg=(await f.db.query('SELECT octet_length($1::jsonb::text) AS bytes',[JSON.stringify(fact)])).rows[0].bytes;
  assert.ok(Buffer.byteLength(raw)>129000);assert.ok(compact<Buffer.byteLength(raw));assert.ok(pg>compact);t.diagnostic(JSON.stringify({inputBytes:Buffer.byteLength(raw),providerCount:p.providerIdentities.length,compactFactBytes:compact,postgresJsonbTextBytes:pg}));
});

test('B1 installation and extraction preserve every old row catalogue ACL role and caller boundary',async t=>{
  const f=await createFactsFixture(t,{install:false}),head=headWire(event(1));const receipt=await f.apply(head);const before=await surface(f.db);await f.installFacts();
  assert.deepEqual(await surface(f.db),before);
  for(const kind of Object.keys(keys))await f.extract(snapshot(true),kind,keys[kind]);
  await assert.rejects(f.apply(wire(snapshot())),invalid);assert.equal(await f.status(event(1).eventId,hash(head)),receipt);assert.deepEqual(await surface(f.db),before);
  const meta=(await f.db.query(`SELECT pg_get_userbyid(proowner) AS owner,provolatile,prosecdef,proisstrict,proconfig,proacl::text,pg_get_function_result(oid) AS result FROM pg_proc WHERE oid=$1::regprocedure`,[functionName])).rows[0];
  assert.deepEqual(meta,{owner:'memory_projection_owner',provolatile:'i',prosecdef:false,proisstrict:false,proconfig:['search_path=pg_catalog'],proacl:'{memory_projection_owner=X/memory_projection_owner}',result:'jsonb'});
  for(const role of ['memory_owner','memory_runtime','memory_background','memory_commands','memory_lifecycle','memory_projection_caller','projection_test_login','fixture_provisioner','anon','authenticated'])await assert.rejects(f.asRole(role,db=>db.query('SELECT memory_identity.projection_v3_snapshot_fact($1::jsonb,$2,$3)',[JSON.stringify(snapshot()),'subject',keys.subject])),/permission denied/);
});

test('B1 exact collision aborts installation without replacing prior function or privileges',async t=>{
  const f=await createFactsFixture(t);const before=await surface(f.db),definition=(await f.db.query('SELECT pg_get_functiondef($1::regprocedure) AS def',[functionName])).rows[0].def;
  await assert.rejects(f.installFacts(),e=>e.code==='PP004'&&e.message==='seoul_projection_unavailable');assert.deepEqual(await surface(f.db),before);assert.equal((await f.db.query('SELECT pg_get_functiondef($1::regprocedure) AS def',[functionName])).rows[0].def,definition);
});

test('B1 existing SET authority is required and role edges are never repaired',async t=>{
  const f=await createFactsFixture(t,{install:false});await f.db.exec('REVOKE memory_owner FROM fixture_provisioner');const before=await surface(f.db);
  await assert.rejects(f.installFacts(),e=>e.code==='PP004'||e.code==='42501');assert.deepEqual(await surface(f.db),before);assert.equal((await f.db.query('SELECT to_regprocedure($1) AS oid',[functionName])).rows[0].oid,null);
});

test('B1 actual new-function ACL closes arbitrary quoted inherited and grant-option defaults',async t=>{
  const f=await createFactsFixture(t,{install:false});
  await f.db.exec(`CREATE ROLE "facts odd\"group" NOLOGIN; CREATE ROLE facts_inherited LOGIN INHERIT; GRANT "facts odd\"group" TO facts_inherited WITH INHERIT TRUE,SET FALSE;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_projection_owner GRANT EXECUTE ON FUNCTIONS TO memory_runtime WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES FOR ROLE memory_projection_owner IN SCHEMA memory_identity GRANT EXECUTE ON FUNCTIONS TO "facts odd\"group",projection_test_login WITH GRANT OPTION;`.replaceAll('odd"group','odd""group'));
  const before=await surface(f.db);await f.installFacts();assert.deepEqual(await surface(f.db),before);
  const acl=(await f.db.query('SELECT a.grantee::regrole::text AS role,a.privilege_type,a.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure',[functionName])).rows;
  assert.deepEqual(acl,[{role:'memory_projection_owner',privilege_type:'EXECUTE',is_grantable:false}]);
  for(const role of ['memory_runtime','facts_inherited','projection_test_login'])assert.equal((await f.db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[role,functionName])).rows[0].allowed,false);
  await assert.rejects(f.asRole('facts_inherited',db=>db.query('SELECT memory_identity.projection_v3_snapshot_fact($1::jsonb,$2,$3)',[JSON.stringify(snapshot()),'subject',keys.subject])),/permission denied/);
});

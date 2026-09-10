import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDatabase, NOW} from '../../test/helpers.mjs';
import {WorkspaceService} from '../../src/workspace.ts';
import {Admin} from '../../src/release/admin.ts';
import {Billing} from '../../src/release/billing.ts';
import {interactive, requireSpace} from '../../src/release/authority.ts';
import {digest, hmac} from '../../src/release/util.ts';

const principal=subject=>({issuer:'https://auth-api.allen.company',subject,email:subject+'@corp.example',emailVerified:true,permission:'write',expiresAt:NOW+900000});
async function fixture(t){
  const f=createDatabase({workspace:true}); t.after(f.close);
  f.raw.exec(readFileSync(new URL('../../release-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../maintenance-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../checkout-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../job-progress-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../protocol-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../pagination-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../lookup-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../key-lookup-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../tenant-queue-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../workspace-lookup-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../retrieval-progress-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../vector-reconciliation-schema.sql',import.meta.url),'utf8'));
  f.raw.exec(readFileSync(new URL('../../outbound-share-schema.sql',import.meta.url),'utf8'));
  f.db.batch=async statements=>{f.raw.exec('BEGIN IMMEDIATE');try{const results=[];for(const statement of statements)results.push(await statement.all());f.raw.exec('COMMIT');return results;}catch(error){f.raw.exec('ROLLBACK');throw error;}};
  const workspace=new WorkspaceService(f.db,()=>NOW),owner=await workspace.signIn(principal('owner'));
  f.raw.prepare('UPDATE credentials SET reauthenticated_at=? WHERE token_digest=?').run(NOW,await digest(owner.token));
  const snapshot=await workspace.snapshot(owner.token),org=await workspace.createOrganization(owner.token,{name:'Root',emailId:snapshot.account.emails[0].id});
  return {...f,workspace,owner,snapshot,org,admin:new Admin({DB:f.db},()=>NOW)};
}
async function webhook(admin,event){
  const raw=JSON.stringify({issuer:principal('owner').issuer,...event}), timestamp=String(NOW/1000);
  return admin.identityWebhook(new Request('https://memory.allenlabs.org/webhooks/identity',{method:'POST',body:raw,headers:{'x-memory-timestamp':timestamp,'x-memory-signature':await hmac('x'.repeat(64),timestamp+'.'+raw)}}));
}
const forbidden=fn=>assert.rejects(fn,error=>[401,403].includes(error.status));

test('SCIM keys cannot regain authority through a new membership or email claim',async t=>{
  const f=await fixture(t),key=await f.admin.issueScimKey(f.owner.token,f.org.id);
  const original=f.raw.prepare('SELECT * FROM memberships WHERE organization_id=?').get(f.org.id);
  f.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE id=?').run(NOW,original.email_id);
  await forbidden(()=>f.admin.scimAuthority(key.token,f.org.id));
  f.raw.prepare('INSERT INTO account_emails(id,account_id,address,domain,verified_at) VALUES(?,?,?,?,?)').run('new-claim',f.owner.accountId,'owner@corp.example','corp.example',NOW);
  f.raw.prepare('INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES(?,?,?,?,?)').run('new-membership',f.org.id,f.owner.accountId,'new-claim','owner');
  await forbidden(()=>f.admin.scimAuthority(key.token,f.org.id));
  assert.equal(f.raw.prepare('SELECT revoked_at FROM release_scim_keys WHERE id=?').get(key.id).revoked_at,NOW);
});

test('SCIM protects the final owner and requires owner authority to remove another owner',async t=>{
  const f=await fixture(t),key=await f.admin.issueScimKey(f.owner.token,f.org.id);
  const original=f.raw.prepare('SELECT id FROM memberships WHERE organization_id=?').get(f.org.id).id;
  await forbidden(()=>f.admin.scimDeactivate(key.token,f.org.id,original));
  const second=await f.workspace.signIn(principal('second'));
  const secondSnapshot=await f.workspace.snapshot(second.token);
  f.raw.prepare('INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES(?,?,?,?,?)').run('second-owner',f.org.id,second.accountId,secondSnapshot.account.emails[0].id,'owner');
  f.raw.prepare("UPDATE memberships SET role='admin' WHERE id=?").run(original);
  await forbidden(()=>f.admin.scimDeactivate(key.token,f.org.id,'second-owner'));
  f.raw.prepare("UPDATE memberships SET role='owner' WHERE id=?").run(original);
  await f.admin.scimDeactivate(key.token,f.org.id,'second-owner');
  await forbidden(()=>f.admin.scimDeactivate(key.token,f.org.id,original));
  assert.equal(f.raw.prepare('SELECT revoked_at FROM memberships WHERE id=?').get(original).revoked_at,null);
});

test('SCIM checks the exact organization and live role, expiry, and immutable key binding',async t=>{
  const f=await fixture(t),key=await f.admin.issueScimKey(f.owner.token,f.org.id);
  const child=await f.workspace.createOrganization(f.owner.token,{name:'Child',emailId:f.snapshot.account.emails[0].id,parentOrganizationId:f.org.id});
  await forbidden(()=>f.admin.scimAuthority(key.token,child.id));
  const membership=f.raw.prepare('SELECT id FROM memberships WHERE organization_id=?').get(f.org.id).id;
  f.raw.prepare("UPDATE memberships SET role='member' WHERE id=?").run(membership);
  await forbidden(()=>f.admin.scimAuthority(key.token,f.org.id));
  f.raw.prepare("UPDATE memberships SET role='owner',expires_at=? WHERE id=?").run(NOW,membership);
  await forbidden(()=>f.admin.scimAuthority(key.token,f.org.id));
  for(const mode of ['ON','OFF']){
    f.raw.exec('PRAGMA recursive_triggers='+mode);
    assert.throws(()=>f.raw.prepare('UPDATE release_scim_keys SET organization_id=? WHERE id=?').run(child.id,key.id));
    assert.throws(()=>f.raw.exec('INSERT OR REPLACE INTO release_scim_keys SELECT * FROM release_scim_keys'));
    assert.throws(()=>f.raw.exec('DELETE FROM release_scim_keys'));
  }
});

for(const beforeMapping of [false,true])test('email-only revocation preserves personal sign-in and never restores claim authority; first mapping='+beforeMapping,async t=>{
  const f=await fixture(t),admin=new Admin({DB:f.db,IDENTITY_WEBHOOK_SECRET:'x'.repeat(64)},()=>NOW),subject=beforeMapping?'future':'owner';
  await webhook(admin,{id:'email-revocation',subject,type:'email.revoked',email:principal(subject).email});
  const signedIn=await f.workspace.signIn(principal(subject));
  const snapshot=await f.workspace.snapshot(signedIn.token);
  assert.deepEqual(snapshot.account.emails,[]); assert.deepEqual(snapshot.organizations,[]);
  assert.ok(snapshot.spaces.some(space=>space.organizationId===null));
  if(!beforeMapping){assert.equal(signedIn.accountId,f.owner.accountId);await forbidden(()=>requireSpace(f.db,signedIn.token,f.org.spaceId,'read', () => NOW));}
});

for(const kind of ['account.disabled','email.revoked'])test('identity webhook atomically covers a first sign-in racing its batch: '+kind,async t=>{
  const f=await fixture(t),admin=new Admin({DB:f.db,IDENTITY_WEBHOOK_SECRET:'x'.repeat(64)},()=>NOW);
  const original=f.db.batch.bind(f.db);let raced;
  f.db.batch=async statements=>{raced=await f.workspace.signIn(principal('racer'));return original(statements);};
  await webhook(admin,{id:'identity-race',subject:'racer',type:kind,...(kind==='email.revoked'?{email:principal('racer').email}:{})});
  if(kind==='account.disabled'){
    await forbidden(()=>interactive(f.db,raced.token, () => NOW));
    await assert.rejects(()=>f.workspace.signIn(principal('racer')));
  }else{
    await interactive(f.db,raced.token, () => NOW);
    assert.deepEqual((await f.workspace.snapshot(raced.token)).account.emails,[]);
    assert.deepEqual((await f.workspace.snapshot((await f.workspace.signIn(principal('racer'))).token)).account.emails,[]);
  }
});

test('provider revocation rolls back webhook receipt and tombstone if the authority mutation fails',async t=>{
  const f=await fixture(t),admin=new Admin({DB:f.db,IDENTITY_WEBHOOK_SECRET:'x'.repeat(64)},()=>NOW);
  f.raw.exec("CREATE TRIGGER reject_disable BEFORE UPDATE OF disabled_at ON accounts BEGIN SELECT RAISE(ABORT,'injected mutation failure'); END;");
  await assert.rejects(()=>webhook(admin,{id:'failed-disable',subject:'owner',type:'account.disabled'}));
  assert.equal(f.raw.prepare('SELECT count(*) n FROM release_webhook_events').get().n,0);
  assert.equal(f.raw.prepare('SELECT count(*) n FROM release_provider_revocations').get().n,0);
  await interactive(f.db,f.owner.token, () => NOW);
});

test('checkout retry after a lost provider response retains the original Stripe parameters and expires locally',async t=>{
  const f=await fixture(t);let now=NOW,firstBody,firstKey,sessionCalls=0;
  const billing=new Billing({DB:f.db,BACKGROUND_JOBS_ENABLED:'true',PUBLIC_ORIGIN:'https://memory.allenlabs.org',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async(url,init)=>{
    if(String(url).endsWith('/customers'))return Response.json({id:'cus_test'});
    sessionCalls++;
    if(!firstBody){firstBody=init.body;firstKey=init.headers['idempotency-key'];throw new Error('Response lost after provider acceptance');}
    assert.equal(init.body,firstBody);assert.equal(init.headers['idempotency-key'],firstKey);
    return Response.json({id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});
  }},()=>now);
  const space=f.snapshot.spaces[0].id;
  await assert.rejects(()=>billing.checkout(f.owner.token,space,'price_test','same-operation'));
  now+=1000;
  assert.equal((await billing.checkout(f.owner.token,space,'price_test','same-operation')).url,'https://checkout.stripe.com/c/pay/test');
  assert.equal(sessionCalls,2);
  const expiration=f.raw.prepare('SELECT expires_at FROM release_checkout_requests').get().expires_at;
  assert.equal(Number(new URLSearchParams(firstBody).get('expires_at')),Math.floor(expiration/1000));
  // A fresh session cannot revive the expired operation or obtain its old URL.
  now=expiration;
  f.raw.prepare('UPDATE credentials SET expires_at=?,reauthenticated_at=? WHERE token_digest=?').run(now+900000,now,await digest(f.owner.token));
  await assert.rejects(()=>billing.checkout(f.owner.token,space,'price_test','same-operation'),error=>error.code==='checkout_expired');
  assert.equal(sessionCalls,2);
});

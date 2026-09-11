import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { Admin } from '../../src/release/admin.ts';
import { Billing } from '../../src/release/billing.ts';
import { digest } from '../../src/release/util.ts';

async function setup(t) {
  const f=await fixture();t.after(()=>f.db.close());let now=at;
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+100);
  const advance=()=>{now=at+200;};
  const afterRead=fragment=>{const prepare=f.db.prepare.bind(f.db);let fired=false;f.db.prepare=sql=>{const statement=prepare(sql),first=statement.first.bind(statement);statement.first=async()=>{const result=await first();if(!fired&&sql.includes(fragment)){fired=true;advance();}return result;};return statement;};};
  const afterDigest=predicate=>{const original=crypto.subtle.digest;crypto.subtle.digest=async function(algorithm,data){const result=await original.call(this,algorithm,data);if(predicate(new TextDecoder().decode(data)))advance();return result;};t.after(()=>{crypto.subtle.digest=original;});};
  return {...f,advance,afterRead,afterDigest,clock:()=>now,admin:new Admin({DB:f.db},()=>now)};
}
const denied=operation=>assert.rejects(operation,error=>[401,403].includes(error.status));

test('key issuance cannot persist a credential when its scoped read crosses session expiry',async t=>{
  const f=await setup(t),before=f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n;
  f.afterRead('SELECT organization_id AS organizationId FROM spaces');
  await denied(()=>f.admin.issueKey(f.token,{label:'expired',capabilities:['read'],spaceIds:['s1'],expiresInDays:1}));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n,before);
});

test('key issuance cannot persist a credential when token hashing crosses recent-proof expiry',async t=>{
  const f=await setup(t),before=f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n;
  f.db.raw.prepare("UPDATE credentials SET expires_at=?,reauthenticated_at=? WHERE id='session:alice'").run(at+900000,at-299900);
  f.afterDigest(value=>value.startsWith('mem_'));
  await denied(()=>f.admin.issueKey(f.token,{label:'expired',capabilities:['read'],expiresInDays:1}));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM credentials').get().n,before);
});

test('reauth challenge does not survive an email lookup crossing session expiry',async t=>{
  const f=await setup(t);f.afterRead('SELECT address FROM account_emails');
  await denied(()=>f.admin.startReauth(f.token,'e1'));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_reauth_challenges').get().n,0);
});

test('reauth completion does not consume a proof after the session expires during its prerequisite read',async t=>{
  const f=await setup(t);
  f.db.raw.prepare('INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at) VALUES(?,?,?,?,?)').run('proof','session:alice','e1',await digest('synthetic-proof'),at+600000);
  f.afterRead('SELECT c.id,c.account_id AS accountId');
  await denied(()=>f.admin.completeReauth(f.token,'proof','synthetic-proof'));
  assert.equal(f.db.raw.prepare("SELECT used_at FROM release_reauth_challenges WHERE id='proof'").get().used_at,null);
});

test('domain challenge creation checks time after hashing the caller token',async t=>{
  const f=await setup(t);let hashes=0;f.afterDigest(value=>value===f.token&&++hashes===2);
  await denied(()=>f.admin.beginDomain(f.token,'org','example.net'));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_domain_challenges').get().n,0);
});

test('domain verification does not persist ownership after its existing-domain read crosses expiry',async t=>{
  const f=await setup(t),challenge=await f.admin.beginDomain(f.token,'org','example.net');
  f.admin.fetcher=async()=>Response.json({Status:0,Answer:[{name:challenge.name,type:16,data:JSON.stringify(challenge.value)}]});
  f.afterRead('SELECT id,organization_id AS organizationId,revoked_at AS revokedAt FROM domains');
  await denied(()=>f.admin.verifyDomain(f.token,challenge.id));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM domains').get().n,0);
  assert.equal(f.db.raw.prepare('SELECT used_at FROM release_domain_challenges WHERE id=?').get(challenge.id).used_at,null);
});

test('domain delegation checks time after its interactive prerequisite read',async t=>{
  const f=await setup(t);
  f.db.raw.exec(`INSERT INTO domains(id,organization_id,name,verified_until) VALUES('domain','org','example.net',${at+900000});INSERT INTO domain_managers(domain_id,membership_id) VALUES('domain','m1');UPDATE memberships SET role='admin' WHERE id='m2';`);
  f.afterRead('SELECT c.id,c.account_id AS accountId');
  await denied(()=>f.admin.delegateDomain(f.token,'domain','m2'));
  assert.equal(f.db.raw.prepare("SELECT count(*) n FROM domain_managers WHERE membership_id='m2'").get().n,0);
});

test('SCIM key issuance cannot persist a key after hashing crosses session expiry',async t=>{
  const f=await setup(t);f.afterDigest(value=>value.startsWith('scim_'));
  await denied(()=>f.admin.issueScimKey(f.token,'org'));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_scim_keys').get().n,0);
});

test('SCIM deletion checks issuer membership expiry after target lookup',async t=>{
  const f=await setup(t),key=await f.admin.issueScimKey(f.token,'org');
  f.db.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m1'").run(at+100);
  f.afterRead('SELECT id FROM memberships WHERE id=? AND organization_id=?');
  await denied(()=>f.admin.scimDelete(key.token,'org','m2'));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_scim_deletions').get().n,0);
  assert.equal(f.db.raw.prepare("SELECT revoked_at FROM memberships WHERE id='m2'").get().revoked_at,null);
});

test('customer creation response cannot update the pool or claim checkout after session expiry',async t=>{
  const f=await setup(t);let checkoutCalls=0;
  const billing=new Billing({DB:f.db,BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async url=>{if(String(url).endsWith('/customers')){f.advance();return Response.json({id:'cus_test'});}checkoutCalls++;return Response.json({id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});}},f.clock);
  await denied(()=>billing.checkout(f.token,'s1','price_test','expiry'));
  assert.equal(checkoutCalls,0);
  assert.equal(f.db.raw.prepare("SELECT customer_id FROM release_pools WHERE id='account:alice'").get().customer_id,null);
  assert.equal(f.db.raw.prepare('SELECT checkout_attempted FROM release_checkout_requests').get().checkout_attempted,0);
});

test('checkout first-attempt claim checks time after the persisted customer read',async t=>{
  const f=await setup(t);let checkoutCalls=0;
  f.afterRead('SELECT customer_id AS id FROM release_pools');
  const billing=new Billing({DB:f.db,BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async url=>{if(String(url).endsWith('/customers'))return Response.json({id:'cus_test'});checkoutCalls++;return Response.json({id:'cs_test',url:'https://checkout.stripe.com/c/pay/test'});}},f.clock);
  await denied(()=>billing.checkout(f.token,'s1','price_test','expiry'));
  assert.equal(checkoutCalls,0);
  assert.equal(f.db.raw.prepare('SELECT checkout_attempted FROM release_checkout_requests').get().checkout_attempted,0);
});

test('checkout closure cannot persist a receipt when Stripe evidence arrives after expiry',async t=>{
  const f=await setup(t);
  f.db.raw.exec(`UPDATE release_pools SET customer_id='cus_test' WHERE id='account:alice';INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,expires_at,session_id,created_at,checkout_attempted) VALUES('old','account:alice','price_test','old',${at-1},'cs_old',${at-2100001},1);`);
  const billing=new Billing({DB:f.db,BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async url=>{assert.ok(String(url).endsWith('/checkout/sessions/cs_old'));f.advance();return Response.json({id:'cs_old',customer:'cus_test',client_reference_id:'old',mode:'subscription',status:'expired',subscription:null});}},f.clock);
  await denied(()=>billing.checkout(f.token,'s1','price_test','replacement'));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_checkout_closures').get().n,0);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_checkout_requests').get().n,1);
});

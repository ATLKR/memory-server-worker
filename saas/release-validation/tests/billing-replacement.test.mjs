import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { Billing } from '../../src/release/billing.ts';

async function setup(t, status = 'complete', subscriptionStatus = 'active') {
  const f = await fixture(); t.after(() => f.db.close());
  let now = at, creations = 0, firstRequest;
  const reads = [];
  const env = { DB: f.db, BACKGROUND_JOBS_ENABLED: 'true', STRIPE_SECRET_KEY: 'synthetic',
    STRIPE_WEBHOOK_SECRET: 'w'.repeat(64), STRIPE_API_VERSION: 'synthetic',
    BILLING_PRICES_JSON: JSON.stringify({ price_test: { plan: 'team', monthlyUnits: 10000, storageBytes: 1048576000 } }),
    fetch: async (url, init) => {
      const path = String(url).replace('https://api.stripe.com/v1/', '');
      if (path === 'customers') return Response.json({ id: 'cus_test' });
      if (path === 'checkout/sessions' && init.method === 'POST') {
        creations++;
        firstRequest ??= new URLSearchParams(init.body).get('client_reference_id');
        return Response.json({ id: 'cs_' + creations, url: 'https://checkout.stripe.com/c/pay/' + creations });
      }
      reads.push(path);
      if (path === 'checkout/sessions/cs_1') return Response.json({ id: 'cs_1', customer: 'cus_test',
        mode: 'subscription', client_reference_id: firstRequest, status, subscription: status === 'complete' ? 'sub_paid' : null });
      if (path === 'subscriptions/sub_paid') return Response.json({ id: 'sub_paid', customer: 'cus_test',
        metadata: { memory_request_id: firstRequest }, status: subscriptionStatus,
        items: { data: [{ price: { id: 'price_test' }, quantity: 1 }] } });
      throw new Error('Unexpected provider request ' + path);
    } };
  const billing = new Billing(env, () => now);
  await billing.checkout(f.token, 's1', 'price_test', 'first');
  now += 2160000;
  f.db.raw.prepare("UPDATE credentials SET expires_at=?,reauthenticated_at=? WHERE id='session:alice'").run(now + 900000, now);
  return { ...f, billing, env, reads, now, creations: () => creations };
}

test('a completed checkout blocks a second subscription after local expiry and before webhook processing', async t => {
  const f = await setup(t);
  await assert.rejects(() => f.billing.checkout(f.token, 's1', 'price_test', 'replacement'), error => error.status === 409);
  assert.equal(f.creations(), 1);
  assert.ok(f.reads.includes('checkout/sessions/cs_1'));
  assert.equal(f.db.raw.prepare("SELECT count(*) AS n FROM release_billing_events WHERE subscription_id='sub_paid'").get().n, 1);
  await f.billing.drain();
  assert.equal(f.db.raw.prepare("SELECT subscription_id FROM release_pools WHERE id='account:alice'").get().subscription_id, 'sub_paid');
  await assert.rejects(() => f.billing.checkout(f.token, 's1', 'price_test', 'replacement'), error => error.code === 'use_billing_portal');
});

for (const [status,subscriptionStatus,closure] of [['expired','active','expired'],['complete','canceled','subscription_ended'],['complete','incomplete_expired','subscription_ended']])
test('replacement requires verified terminal provider state: '+status+'/'+subscriptionStatus,async t=>{
  const f=await setup(t,status,subscriptionStatus);
  assert.equal((await f.billing.checkout(f.token,'s1','price_test','replacement')).url,'https://checkout.stripe.com/c/pay/2');
  assert.equal(f.creations(),2);
  const closed=f.db.raw.prepare('SELECT state,subscription_id FROM release_checkout_closures').get();
  assert.equal(closed.state,closure);assert.equal(closed.subscription_id,status==='expired'?null:'sub_paid');
  for(const sql of ['UPDATE release_checkout_closures SET checked_at=checked_at+1','DELETE FROM release_checkout_closures'])
    assert.throws(()=>f.db.raw.exec(sql),/immutable/);
});

for(const state of ['open','unrecognized'])test('provider '+state+' never frees a locally expired checkout',async t=>{
  const f=await setup(t,state);
  await assert.rejects(()=>f.billing.checkout(f.token,'s1','price_test','replacement'),error=>[409,502].includes(error.status));
  assert.equal(f.creations(),1);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_checkout_closures').get().n,0);
});

test('unknown lost checkout attempts stay blocked after their local expiry',async t=>{
  const f=await setup(t);
  f.db.raw.prepare('UPDATE release_checkout_requests SET session_id=NULL,checkout_url=NULL').run();
  await assert.rejects(()=>f.billing.checkout(f.token,'s1','price_test','replacement'),error=>error.code==='checkout_reconciliation_required');
  assert.equal(f.creations(),1);assert.deepEqual(f.reads,[]);
});

for(const [response,field] of [['session','id'],['session','customer'],['session','client_reference_id'],['session','mode'],['subscription','id'],['subscription','customer'],['subscription','metadata']])
test('replacement rejects mismatched '+response+' '+field,async t=>{
  const f=await setup(t,'complete','canceled'),fetcher=f.env.fetch;
  f.env.fetch=async(url,init)=>{const result=await fetcher(url,init);if((response==='session'&&String(url).endsWith('/checkout/sessions/cs_1'))||(response==='subscription'&&String(url).endsWith('/subscriptions/sub_paid'))){const body=await result.json();body[field]=field==='metadata'?{memory_request_id:'other-request'}:'other';return Response.json(body);}return result;};
  await assert.rejects(()=>f.billing.checkout(f.token,'s1','price_test','replacement'),error=>error.status===502);
  assert.equal(f.creations(),1);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_checkout_closures').get().n,0);
});

test('replacement rechecks authorization after awaiting provider closure evidence',async t=>{
  const f=await setup(t,'expired'),fetcher=f.env.fetch;
  f.env.fetch=async(url,init)=>{const result=await fetcher(url,init);if(String(url).endsWith('/checkout/sessions/cs_1'))f.db.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='session:alice'").run(f.now);return result;};
  await assert.rejects(()=>f.billing.checkout(f.token,'s1','price_test','replacement'),error=>error.status===403);
  assert.equal(f.creations(),1);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_checkout_closures').get().n,0);
});

test('replacement insertion checks a concurrent unresolved attempt after closure reads',async t=>{
  const f=await setup(t,'expired'),prepare=f.db.prepare.bind(f.db);let injected=false;
  f.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('INSERT INTO release_checkout_requests')){const run=statement.run.bind(statement);statement.run=async()=>{if(!injected){injected=true;f.db.raw.prepare(`INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,created_at,expires_at)
      VALUES('concurrent-unknown','account:alice','price_test','other-key',?,?)`).run(at,at+1000);}return run();};}return statement;};
  await assert.rejects(()=>f.billing.checkout(f.token,'s1','price_test','replacement'),error=>error.code==='checkout_already_pending');
  assert.equal(injected,true);assert.equal(f.creations(),1);
});

test('historical checkout reconciliation is bounded and continues on the next retry',async t=>{
  const f=await setup(t,'expired'),fetcher=f.env.fetch;
  for(let i=2;i<=7;i++)f.db.raw.prepare(`INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,created_at,expires_at,session_id)
    VALUES(?,'account:alice','price_test',?,?,?,?)`).run('old-'+i,'old-key-'+i,at+i,at+1000,'cs_old_'+i);
  let reads=0;
  f.env.fetch=async(url,init)=>{if(String(url).includes('/checkout/sessions/')&&init.method==='GET'){reads++;const sessionId=String(url).split('/').at(-1);if(sessionId!=='cs_1')return Response.json({id:sessionId,customer:'cus_test',mode:'subscription',client_reference_id:'old-'+sessionId.split('_').at(-1),status:'expired',subscription:null});}return fetcher(url,init);};
  await assert.rejects(()=>f.billing.checkout(f.token,'s1','price_test','replacement'),error=>error.code==='checkout_already_pending');
  assert.equal(reads,5);assert.equal(f.creations(),1);
  await f.billing.checkout(f.token,'s1','price_test','replacement');
  assert.equal(reads,7);assert.equal(f.creations(),2);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_checkout_closures').get().n,7);
});

test('concurrent replacements create at most one new checkout',async t=>{
  const f=await setup(t,'expired'),prepare=f.db.prepare.bind(f.db);let winner;
  f.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('INSERT INTO release_checkout_requests')){const run=statement.run.bind(statement);statement.run=async()=>{if(!winner){winner=Promise.resolve();winner=await f.billing.checkout(f.token,'s1','price_test','replacement-b');}return run();};}return statement;};
  await assert.rejects(()=>f.billing.checkout(f.token,'s1','price_test','replacement-a'),error=>error.code==='checkout_already_pending');
  assert.equal(winner.url,'https://checkout.stripe.com/c/pay/2');assert.equal(f.creations(),2);
});

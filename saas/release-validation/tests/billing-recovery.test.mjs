import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DB, fixture, at } from './db.mjs';
import { Billing } from '../../src/release/billing.ts';
import { createRelease } from '../../src/release/extension.ts';

function environment(db, fetcher) {
  return { DB: db, BACKGROUND_JOBS_ENABLED: 'true', STRIPE_SECRET_KEY: 'synthetic',
    STRIPE_WEBHOOK_SECRET: 'w'.repeat(64), STRIPE_API_VERSION: 'synthetic',
    BILLING_PRICES_JSON: JSON.stringify({ price_test: { plan: 'team', monthlyUnits: 10000, storageBytes: 1048576000 } }),
    REQUEST_LIMITER: { limit: async () => ({ success: true }) }, fetch: fetcher };
}

test('checkout recovers a customer failure after six minutes with a fresh Stripe expiry', async t => {
  const { db, token } = await fixture(); t.after(() => db.close());
  let now = at, customerCalls = 0, checkoutCalls = 0;
  const billing = new Billing(environment(db, async (url, init) => {
    if (String(url).endsWith('/customers')) {
      if (++customerCalls === 1) return Response.json({ error: 'temporary_failure' }, { status: 503 });
      return Response.json({ id: 'cus_test' });
    }
    checkoutCalls++;
    const remaining = Number(new URLSearchParams(init.body).get('expires_at')) - now / 1000;
    // Stripe's documented creation window is at least 30 minutes in the future.
    if (remaining < 1800) return Response.json({ error: 'invalid_expiry' }, { status: 400 });
    assert.equal(remaining, 2100);
    return Response.json({ id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/test' });
  }), () => now);
  await assert.rejects(() => billing.checkout(token, 's1', 'price_test', 'recovery'), error => error.status === 502);
  assert.equal(checkoutCalls, 0);
  assert.equal(db.raw.prepare('SELECT checkout_attempted FROM release_checkout_requests').get().checkout_attempted, 0);
  now += 360000;
  db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(now);
  assert.equal((await billing.checkout(token, 's1', 'price_test', 'recovery')).url, 'https://checkout.stripe.com/c/pay/test');
  assert.equal(checkoutCalls, 1);
  const request = db.raw.prepare('SELECT expires_at FROM release_checkout_requests').get();
  assert.equal(request.expires_at, now + 2100000);
});

test('concurrent checkout claims reuse the winning persisted expiry and Stripe parameters', async t => {
  const { db, token } = await fixture(); t.after(() => db.close());
  let now = at + 360000, claimed = false;
  db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(now);
  db.raw.prepare("UPDATE release_pools SET customer_id='cus_test' WHERE id='account:alice'").run();
  db.raw.prepare(`INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,created_at,expires_at,checkout_attempted)
    VALUES('concurrent-request','account:alice','price_test','concurrent',?,?,0)`).run(at, at + 2100000);
  const calls = [], prepare = db.prepare.bind(db);
  let competing;
  db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('UPDATE release_checkout_requests SET expires_at=')) {
      const run = statement.run.bind(statement);
      statement.run = async () => {
        const result = await run();
        if (!claimed) {
          claimed = true;
          // The first caller is paused after its atomic claim; the second caller
          // arrives later and must not replace the winning expiry with its own.
          now += 1000;
          competing = await billing.checkout(token, 's1', 'price_test', 'concurrent');
        }
        return result;
      };
    }
    return statement;
  };
  const billing = new Billing(environment(db, async (_url, init) => {
    calls.push({ body: init.body, key: init.headers['idempotency-key'] });
    return Response.json({ id: 'cs_concurrent', url: 'https://checkout.stripe.com/c/pay/concurrent' });
  }), () => now);
  const result = await billing.checkout(token, 's1', 'price_test', 'concurrent');
  assert.equal(claimed, true);
  assert.deepEqual(result, competing);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(Number(new URLSearchParams(calls[0].body).get('expires_at')), (at + 360000 + 2100000) / 1000);
  assert.deepEqual({ ...db.raw.prepare('SELECT checkout_attempted,expires_at FROM release_checkout_requests').get() },
    { checkout_attempted: 1, expires_at: at + 360000 + 2100000 });
});

test('lost checkout responses retain their attempt and identical parameters after six minutes', async t => {
  const { db, token } = await fixture(); t.after(() => db.close());
  let now = at;
  const calls = [];
  const billing = new Billing(environment(db, async (url, init) => {
    if (String(url).endsWith('/customers')) return Response.json({ id: 'cus_test' });
    calls.push({ body: init.body, key: init.headers['idempotency-key'] });
    if (calls.length === 1) throw new Error('Response lost after Stripe created the session');
    return Response.json({ id: 'cs_lost', url: 'https://checkout.stripe.com/c/pay/lost' });
  }), () => now);
  await assert.rejects(() => billing.checkout(token, 's1', 'price_test', 'lost'));
  const original = db.raw.prepare('SELECT checkout_attempted,expires_at,session_id FROM release_checkout_requests').get();
  assert.equal(original.checkout_attempted, 1);
  assert.equal(original.session_id, null);
  now += 360000;
  db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(now);
  assert.equal((await billing.checkout(token, 's1', 'price_test', 'lost')).url, 'https://checkout.stripe.com/c/pay/lost');
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(db.raw.prepare('SELECT expires_at FROM release_checkout_requests').get().expires_at, original.expires_at);
  await assert.rejects(() => billing.checkout(token, 's1', 'price_test', 'replacement'), error => error.code === 'checkout_already_pending');
});

test('a failed first-attempt authorization does not mark an unattempted checkout', async t => {
  const { db, token } = await fixture(); t.after(() => db.close());
  let checkoutCalls = 0;
  const billing = new Billing(environment(db, async url => {
    if (String(url).endsWith('/customers')) {
      db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m1'").run(at);
      return Response.json({ id: 'cus_test' });
    }
    checkoutCalls++;
    return Response.json({ id: 'cs_forbidden', url: 'https://checkout.stripe.com/c/pay/forbidden' });
  }), () => at);
  await assert.rejects(() => billing.checkout(token, 'so', 'price_test', 'revoked'), error => error.status === 403);
  assert.equal(checkoutCalls, 0);
  assert.equal(db.raw.prepare('SELECT checkout_attempted FROM release_checkout_requests').get().checkout_attempted, 0);
});

test('migration eight preserves populated checkout history and freezes attempted parameters', async t => {
  const db = new DB(); db.migrate(7); t.after(() => db.close());
  db.raw.prepare("INSERT INTO release_pools(id,customer_id) VALUES('legacy-pool','cus_legacy')").run();
  const insert = db.raw.prepare(`INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,created_at,expires_at,session_id,checkout_url)
    VALUES(?,'legacy-pool','price_test',?,?,?,?,?)`);
  insert.run('unknown', 'legacy-unknown', at, at + 2100000, null, null);
  insert.run('completed', 'legacy-completed', at - 3600000, at - 1500000, 'cs_old', 'https://checkout.stripe.com/c/pay/old');
  const before = db.raw.prepare('SELECT * FROM release_checkout_requests ORDER BY id').all().map(row => ({ ...row }));
  const env = environment(db, async () => { throw new Error('Migration must not call Stripe'); });
  const readiness = async () => (await (await createRelease(env, { clock: () => at }).publicRoute(new Request('https://memory.allenlabs.org/ready'))).json()).checks.schema;
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0008_checkout-schema.sql', import.meta.url), 'utf8'));
  assert.deepEqual(db.raw.prepare('SELECT * FROM release_checkout_requests ORDER BY id').all().map(row => ({ ...row })),
    before.map(row => ({ ...row, checkout_attempted: 1 })));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0009_job-progress-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0010_protocol-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0011_pagination-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0012_lookup-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0013_key-lookup-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0014_tenant-queue-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0015_workspace-lookup-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0016_retrieval-progress-schema.sql', import.meta.url), 'utf8'));
  db.raw.exec(readFileSync(new URL('../../migrations/0017_vector-reconciliation-schema.sql', import.meta.url), 'utf8'));
  db.raw.exec(readFileSync(new URL('../../migrations/0018_outbound-share-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0019_execution-time-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0020_domain-verification-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0021_domain-retention-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0022_payload-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), false);
  db.raw.exec(readFileSync(new URL('../../migrations/0023_operational-schema.sql', import.meta.url), 'utf8'));
  db.raw.exec(readFileSync(new URL('../../migrations/0024_lifecycle-schema.sql', import.meta.url), 'utf8'));
  db.raw.exec(readFileSync(new URL('../../migrations/0025_queue-episode-schema.sql', import.meta.url), 'utf8'));
  assert.equal(await readiness(), true);
  for (const sql of ["UPDATE release_checkout_requests SET checkout_attempted=0 WHERE id='unknown'",
    "UPDATE release_checkout_requests SET expires_at=expires_at+1000 WHERE id='unknown'",
    "UPDATE release_checkout_requests SET price_id='price_other' WHERE id='unknown'"])
    assert.throws(() => db.raw.exec(sql), /immutable/);
  insert.run('old-code', 'legacy-writer', at, at + 2100000, null, null);
  assert.equal(db.raw.prepare("SELECT checkout_attempted FROM release_checkout_requests WHERE id='old-code'").get().checkout_attempted, 1);
  db.raw.prepare(`INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,created_at,expires_at,checkout_attempted)
    VALUES('new-code','legacy-pool','price_test','new-writer',?,?,0)`).run(at, at + 2100000);
  assert.equal(db.raw.prepare("SELECT checkout_attempted FROM release_checkout_requests WHERE id='new-code'").get().checkout_attempted, 0);
  db.raw.prepare("UPDATE release_checkout_requests SET expires_at=?,checkout_attempted=1 WHERE id='new-code' AND checkout_attempted=0").run(at + 2400000);
  assert.throws(() => db.raw.exec("UPDATE release_checkout_requests SET expires_at=expires_at+1000 WHERE id='new-code'"), /immutable/);
  assert.equal(db.raw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), []);
});

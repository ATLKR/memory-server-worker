import type { ReleaseEnv } from './types.ts';
import { authority, params, interactive, requireSpace, recentSql } from './authority.ts';
import { batch, canonical, digest, equal, fail, hmac, id, integer, json, month, object, one, readBytes, remoteJson, stmt, str, tokenHash } from './util.ts';
type Plan = {
    plan: string;
    monthlyUnits: number;
    storageBytes: number;
};
/** Calendar-month product units, not a claim about provider token accounting. */
export class Billing {
    env: ReleaseEnv;
    clock: () => number;
    constructor(env: ReleaseEnv, clock: () => number = Date.now) { this.env = env; this.clock = clock; }
    plans(): Record<string, Plan> { const value = object(JSON.parse(this.env.BILLING_PRICES_JSON ?? '{}')); const out: Record<string, Plan> = {}; for (const [price, raw] of Object.entries(value)) {
        if (!/^price_[A-Za-z0-9_]+$/.test(price))
            fail(503, 'billing_configuration_invalid');
        const p = object(raw);
        out[price] = { plan: str(p.plan, 64), monthlyUnits: integer(p.monthlyUnits, 1), storageBytes: integer(p.storageBytes, 1) };
    } return out; }
    async api(path: string, method = 'GET', form?: URLSearchParams, key?: string) { if (!this.env.STRIPE_SECRET_KEY || !this.env.STRIPE_API_VERSION)
        fail(503, 'billing_not_configured'); return remoteJson(this.env.fetch ?? fetch, 'https://api.stripe.com/v1/' + path, { method, headers: { authorization: 'Bearer ' + this.env.STRIPE_SECRET_KEY, 'stripe-version': this.env.STRIPE_API_VERSION, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, ...(form ? { body: form.toString() } : {}) }); }
    async usage(token: string, spaceId: string) { await requireSpace(this.env.DB, token, spaceId, 'read', this.clock()); const hash = await tokenHash(token), at = this.clock(); return one(this.env.DB, `SELECT p.id,p.plan,p.monthly_units AS monthlyUnits,p.storage_limit_bytes AS storageLimitBytes,p.storage_bytes AS storageBytes,p.state,coalesce(u.units,0) AS usedUnits,? AS period FROM release_pools p JOIN release_space_pools sp ON sp.pool_id=p.id JOIN spaces s ON s.id=sp.space_id CROSS JOIN active_credentials c LEFT JOIN release_usage_counters u ON u.pool_id=p.id AND u.period=? WHERE s.id=? AND ${authority('read')}`, [month(at), month(at), id(spaceId), ...params(hash, at, 'read')]); }
    async checkout(token: string, spaceId: string, priceId: string, operationId: string) {
        await interactive(this.env.DB, token, this.clock(), true);
        await requireSpace(this.env.DB, token, spaceId, 'update', this.clock());
        if (!Object.hasOwn(this.plans(), priceId))
            fail(400, 'unknown_price');
        id(operationId);
        const at = this.clock(), hash = await tokenHash(token), db = this.env.DB;
        const pool = await one<{
            id: string;
            customerId: string | null;
            subscriptionId: string | null;
        }>(db, 'SELECT p.id,p.customer_id AS customerId,p.subscription_id AS subscriptionId FROM release_space_pools sp JOIN release_pools p ON p.id=sp.pool_id WHERE sp.space_id=?', [spaceId]);
        if (!pool)
            fail(403, 'access_denied');
        if (pool.subscriptionId)
            fail(409, 'use_billing_portal');
        let request = await one<{
            id: string;
            priceId: string;
            url: string | null;
            expiresAt: number;
        }>(db, 'SELECT id,price_id AS priceId,checkout_url AS url,expires_at AS expiresAt FROM release_checkout_requests WHERE pool_id=? AND operation_key=?', [pool.id, operationId]);
        if (request) {
            if (request.priceId !== priceId)
                fail(409, 'idempotency_conflict');
            if (request.expiresAt <= at)
                fail(409, 'checkout_expired');
            if (request.url)
                return { url: request.url, id: request.id };
        }
        if (!request) {
            const requestId = crypto.randomUUID();
            const inserted = await db.prepare(`INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,expires_at,created_at) SELECT ?,sp.pool_id,?,?,?,? FROM release_space_pools sp JOIN spaces s ON s.id=sp.space_id CROSS JOIN active_credentials c JOIN release_pools p ON p.id=sp.pool_id WHERE s.id=? AND ${authority('update')} AND ${recentSql()} AND p.subscription_id IS NULL AND NOT EXISTS(SELECT 1 FROM release_checkout_requests old WHERE old.pool_id=sp.pool_id AND old.expires_at>?)`).bind(requestId, priceId, operationId, at + 2100000, at, spaceId, ...params(hash, at, 'update'), at - 300000, at, at).run();
            if (!inserted.meta.changes)
                fail(409, 'checkout_already_pending');
            request = { id: requestId, priceId, url: null, expiresAt: at + 2100000 };
        }
        let customer = pool.customerId;
        if (!customer) {
            const created = await this.api('customers', 'POST', new URLSearchParams({ 'metadata[memory_pool_id]': pool.id }), 'memory-customer-' + pool.id);
            customer = str(created.id, 100);
            if (!/^cus_[A-Za-z0-9_]+$/.test(customer))
                fail(502, 'invalid_customer');
            await db.prepare('UPDATE release_pools SET customer_id=? WHERE id=? AND customer_id IS NULL').bind(customer, pool.id).run();
            const actual = await one<{
                id: string;
            }>(db, 'SELECT customer_id AS id FROM release_pools WHERE id=?', [pool.id]);
            customer = actual!.id;
        }
        await interactive(db, token, this.clock(), true);
        await requireSpace(db, token, spaceId, 'update', this.clock());
        // Persisted request expiry is also Stripe's expiry. Replays after a lost
        // response must keep identical parameters under the same idempotency key.
        const session = await this.api('checkout/sessions', 'POST', new URLSearchParams({ mode: 'subscription', customer, success_url: this.env.PUBLIC_ORIGIN + '/manage?billing=success', cancel_url: this.env.PUBLIC_ORIGIN + '/manage?billing=cancel', 'line_items[0][price]': priceId, 'line_items[0][quantity]': '1', 'subscription_data[metadata][memory_request_id]': request.id, client_reference_id: request.id, expires_at: String(Math.floor(request.expiresAt / 1000)) }), 'memory-checkout-' + request.id);
        const url = new URL(str(session.url, 2048));
        if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com')
            fail(502, 'invalid_checkout_url');
        await db.prepare('UPDATE release_checkout_requests SET session_id=?,checkout_url=? WHERE id=?').bind(str(session.id, 128), url.href, request.id).run();
        await requireSpace(db, token, spaceId, 'update', this.clock());
        return { id: request.id, url: url.href };
    }
    async portal(token: string, spaceId: string) { await interactive(this.env.DB, token, this.clock(), true); await requireSpace(this.env.DB, token, spaceId, 'update', this.clock()); const pool = await one<{
        customerId: string | null;
    }>(this.env.DB, 'SELECT p.customer_id AS customerId FROM release_space_pools sp JOIN release_pools p ON p.id=sp.pool_id WHERE sp.space_id=?', [spaceId]); if (!pool?.customerId)
        fail(409, 'billing_customer_missing'); const result = await this.api('billing_portal/sessions', 'POST', new URLSearchParams({ customer: pool.customerId, return_url: this.env.PUBLIC_ORIGIN + '/manage' })); const url = new URL(str(result.url, 2048)); if (url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com')
        fail(502, 'invalid_portal_url'); await requireSpace(this.env.DB, token, spaceId, 'update', this.clock()); return { url: url.href }; }
    async webhook(request: Request) {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(request, 262144)), header = request.headers.get('stripe-signature') ?? '';
        if (header.length > 4096)
            fail(401, 'invalid_signature');
        const fields = header.split(',').map(x => x.split('='));
        const times = fields.filter(x => x[0] === 't'), signatures = fields.filter(x => x[0] === 'v1').map(x => x[1] ?? '');
        const t = times[0]?.[1] ?? '';
        if (times.length !== 1 || !/^\d{10}$/.test(t) || Math.abs(this.clock() / 1000 - Number(t)) > 300)
            fail(401, 'invalid_signature');
        const signed = await hmac(this.env.STRIPE_WEBHOOK_SECRET ?? '', t + '.' + raw);
        if (!signatures.some(s => equal(s, signed)))
            fail(401, 'invalid_signature');
        const event = object(JSON.parse(raw)), eventId = id(event.id), type = str(event.type, 128);
        if (!type.startsWith('customer.subscription.'))
            return json({ received: true, ignored: true });
        const data = object(object(event.data).object), subscription = id(data.id);
        if (!/^sub_[A-Za-z0-9_]+$/.test(subscription))
            fail(400, 'invalid_subscription');
        const hash = await digest(raw), db = this.env.DB;
        const accepted = await one<{
            hash: string;
        }>(db, "SELECT body_hash AS hash FROM release_webhook_events WHERE provider='stripe' AND event_id=?", [eventId]);
        if (accepted) {
            if (accepted.hash !== hash)
                fail(409, 'webhook_conflict');
            return json({ received: true, replayed: true });
        }
        try {
            await batch(db, [stmt(db, "INSERT INTO release_webhook_events VALUES('stripe',?,?,?)", [eventId, hash, this.clock()]), stmt(db, 'INSERT INTO release_billing_events(id,subscription_id,available_at,created_at) VALUES(?,?,?,?)', [eventId, subscription, this.clock(), this.clock()])]);
        }
        catch (error) {
            const row = await one<{
                hash: string;
            }>(db, "SELECT body_hash AS hash FROM release_webhook_events WHERE provider='stripe' AND event_id=?", [eventId]);
            if (!row)
                throw error;
            if (row.hash !== hash)
                fail(409, 'webhook_conflict');
        }
        return json({ received: true });
    }
    /** Periodic authoritative reads repair missed webhooks for already bound subscriptions. */
    async reconcile(): Promise<void> {
        if (!this.env.STRIPE_SECRET_KEY || !this.env.STRIPE_API_VERSION)
            return;
        const at = this.clock(), hour = Math.floor(at / 3600000);
        await this.env.DB.prepare(`INSERT INTO release_billing_events(id,subscription_id,available_at,created_at)
  SELECT 'reconcile:'||subscription_id||':'||?,subscription_id,?,? FROM release_pools
  WHERE subscription_id IS NOT NULL AND updated_at<? AND NOT EXISTS(SELECT 1 FROM release_billing_events e WHERE e.subscription_id=release_pools.subscription_id AND e.state='pending') ORDER BY updated_at,id LIMIT 20
  ON CONFLICT(id) DO NOTHING`).bind(hour, at, at, at - 3600000).run();
    }
    async drain(limit = 3): Promise<void> {
        const db = this.env.DB, lease = crypto.randomUUID(), at = this.clock();
        const acquired = await db.prepare('UPDATE release_billing_lock SET token=?,expires_at=? WHERE id=1 AND expires_at<=? RETURNING id').bind(lease, at + 120000, at).first();
        if (!acquired)
            return;
        try {
            for (let n = 0; n < limit; n++) {
                const job = await one<{
                    id: string;
                    subscriptionId: string;
                    attempt: number;
                }>(db, "SELECT id,subscription_id AS subscriptionId,attempt FROM release_billing_events WHERE state='pending' AND available_at<=? ORDER BY created_at,id LIMIT 1", [this.clock()]);
                if (!job)
                    return;
                try {
                    const sub = await this.api('subscriptions/' + encodeURIComponent(job.subscriptionId));
                    if (sub.id !== job.subscriptionId)
                        fail(502, 'invalid_subscription');
                    const customer = str(sub.customer, 128), metadata = object(sub.metadata ?? {});
                    const requestId = typeof metadata.memory_request_id === 'string' ? metadata.memory_request_id : '';
                    const pool = await one<{
                        id: string;
                        subscriptionId: string | null;
                    }>(db, `SELECT p.id,p.subscription_id AS subscriptionId FROM release_pools p WHERE p.customer_id=? AND (p.subscription_id=? OR (p.subscription_id IS NULL AND EXISTS(SELECT 1 FROM release_checkout_requests r WHERE r.pool_id=p.id AND r.id=?)))`, [customer, job.subscriptionId, requestId]);
                    if (!pool)
                        fail(409, 'unbound_subscription');
                    const items = object(sub.items).data;
                    if (!Array.isArray(items) || items.length !== 1)
                        fail(409, 'unsupported_subscription_items');
                    const item = object(items[0]), price = object(item.price), plan = this.plans()[String(price.id)];
                    const status = str(sub.status, 64), cancelled = ['canceled', 'incomplete_expired'].includes(status), active = ['active', 'trialing'].includes(status) && item.quantity === 1 && !!plan;
                    const now = this.clock();
                    await batch(db, [stmt(db, `UPDATE release_pools SET plan=?,monthly_units=?,storage_limit_bytes=?,state=?,subscription_id=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM release_billing_lock WHERE id=1 AND token=? AND expires_at>?)`, [cancelled ? 'free' : (plan?.plan ?? 'unrecognized'), cancelled ? 1000 : (active ? plan!.monthlyUnits : 0), cancelled ? 104857600 : (plan?.storageBytes ?? 104857600), cancelled || active ? 'active' : 'read_only', cancelled ? null : job.subscriptionId, now, pool.id, lease, now]), stmt(db, `UPDATE release_billing_events SET state='done',last_error=NULL WHERE id=? AND EXISTS(SELECT 1 FROM release_billing_lock WHERE id=1 AND token=? AND expires_at>?)`, [job.id, lease, now])]);
                }
                catch {
                    await db.prepare(`UPDATE release_billing_events SET state=?,attempt=attempt+1,available_at=?,last_error='billing_reconciliation_failed' WHERE id=? AND EXISTS(SELECT 1 FROM release_billing_lock WHERE id=1 AND token=? AND expires_at>?)`).bind(job.attempt >= 9 ? 'dead' : 'pending', this.clock() + Math.min(3600000, 1000 * 2 ** job.attempt), job.id, lease, this.clock()).run();
                }
            }
        }
        finally {
            await db.prepare('UPDATE release_billing_lock SET token=NULL,expires_at=0 WHERE id=1 AND token=?').bind(lease).run();
        }
    }
}

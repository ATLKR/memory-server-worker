import { sqlNow } from '../sql-clock.ts';
import type { ReleaseEnv } from './types.ts';
import { readSettings } from '../config.ts';
import { authority, params, accessExpiry, recentSql } from './authority.ts';
import { batch, canonical, digest, enc, equal, fail, hmac, id, integer, json, month, object, one, remoteJson, requestObject, requestText, rows, stmt, str, tokenHash } from './util.ts';
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
    configuration(): { available: boolean; prices: Record<string, Plan> } {
        const policy = this.env;
        if (policy.PAID_BILLING_ENABLED === 'false' || policy.GA_PROFILE === 'managed-ai-metered' ||
            (policy.RELEASE_MODE === 'ga' && policy.PAID_BILLING_ENABLED !== 'true'))
            return { available: false, prices: {} };
        let prices: Record<string, Plan>;
        try { prices = this.plans(); }
        catch { return { available: false, prices: {} }; }
        const available = this.env.BACKGROUND_JOBS_ENABLED === 'true'
            && Boolean(this.env.STRIPE_SECRET_KEY?.trim() && this.env.STRIPE_API_VERSION?.trim())
            && enc.encode(this.env.STRIPE_WEBHOOK_SECRET ?? '').length >= 32
            && Object.keys(prices).length > 0;
        return { available, prices };
    }
    private requireAvailable(): Record<string, Plan> {
        if (this.env.BACKGROUND_JOBS_ENABLED !== 'true')
            fail(503, 'billing_processing_disabled');
        const configuration = this.configuration();
        if (!configuration.available)
            fail(503, 'billing_not_configured');
        return configuration.prices;
    }
    async api(path: string, method = 'GET', form?: URLSearchParams, key?: string) { if (!this.env.STRIPE_SECRET_KEY || !this.env.STRIPE_API_VERSION)
        fail(503, 'billing_not_configured'); return remoteJson(this.env.fetch ?? fetch, 'https://api.stripe.com/v1/' + path, { method, headers: { authorization: 'Bearer ' + this.env.STRIPE_SECRET_KEY, 'stripe-version': this.env.STRIPE_API_VERSION, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, ...(form ? { body: form.toString() } : {}) }); }
    private async authorize(token: string, spaceId: string): Promise<void> {
        const hash = await tokenHash(token), at = this.clock();
        const actor = await one<{ credentialExpiresAt: number; grantExpiresAt: number; reauthenticatedAt: number }>(this.env.DB,
            `SELECT min(c.expires_at,c.membership_expires_at) AS credentialExpiresAt,${accessExpiry('update')} AS grantExpiresAt,
                c.reauthenticated_at AS reauthenticatedAt FROM spaces s CROSS JOIN active_credentials c
             WHERE s.id=? AND ${authority('update')} AND ${recentSql()}`,
            [id(spaceId), ...params(hash, at, 'update'), at - 300000, at]);
        const checkedAt = this.clock();
        if (!actor || Math.min(actor.credentialExpiresAt, actor.grantExpiresAt) <= checkedAt ||
            actor.reauthenticatedAt < checkedAt - 300000 || actor.reauthenticatedAt > checkedAt)
            fail(403, 'recent_reauthentication_required');
    }
    async usage(token: string, spaceId: string) {
        const hash = await tokenHash(token), at = this.clock();
        const value = await one<{ id: string; plan: string; monthlyUnits: number; storageLimitBytes: number; storageBytes: number; state: string; usedUnits: number; period: string; credentialExpiresAt: number; grantExpiresAt: number }>(this.env.DB,
            `SELECT p.id,p.plan,p.monthly_units AS monthlyUnits,p.storage_limit_bytes AS storageLimitBytes,p.storage_bytes AS storageBytes,p.state,coalesce(u.units,0) AS usedUnits,? AS period,
                min(c.expires_at,c.membership_expires_at) AS credentialExpiresAt,${accessExpiry('read')} AS grantExpiresAt
             FROM release_pools p JOIN release_space_pools sp ON sp.pool_id=p.id JOIN spaces s ON s.id=sp.space_id CROSS JOIN active_credentials c LEFT JOIN release_usage_counters u ON u.pool_id=p.id AND u.period=? WHERE s.id=? AND ${authority('read')}`,
            [month(at), month(at), id(spaceId), ...params(hash, at, 'read')]);
        if (!value || Math.min(value.credentialExpiresAt, value.grantExpiresAt) <= this.clock()) fail(403, 'access_denied');
        const { credentialExpiresAt, grantExpiresAt, ...usage } = value;
        return usage;
    }
    private async closePreviousCheckouts(token: string, spaceId: string, poolId: string, customerId: string | null): Promise<void> {
        const db = this.env.DB, hash = await tokenHash(token);
        // Bound recovery work. A later retry continues after the durable closures
        // from this page; the final insertion still checks every prior attempt.
        const previous = await rows<{ id: string; sessionId: string | null }>(db,
            `SELECT r.id,r.session_id AS sessionId FROM release_checkout_requests r WHERE r.pool_id=?
              AND r.checkout_attempted=1 AND r.expires_at<=?
              AND NOT EXISTS(SELECT 1 FROM release_checkout_closures closed WHERE closed.request_id=r.id)
              ORDER BY r.created_at,r.id LIMIT 5`, [poolId, this.clock()]);
        for (const request of previous) {
            if (!request.sessionId || !customerId)
                fail(409, 'checkout_reconciliation_required');
            await this.authorize(token, spaceId);
            const session = await this.api('checkout/sessions/' + encodeURIComponent(request.sessionId));
            if (session.id !== request.sessionId || session.customer !== customerId || session.client_reference_id !== request.id || session.mode !== 'subscription')
                fail(502, 'invalid_checkout_session');
            let state: 'expired' | 'subscription_ended', subscriptionId: string | null = null;
            if (session.status === 'expired') {
                if (session.subscription !== null && session.subscription !== undefined)
                    fail(502, 'invalid_checkout_session');
                state = 'expired';
            } else if (session.status === 'complete') {
                subscriptionId = str(session.subscription, 128);
                if (!/^sub_[A-Za-z0-9_]+$/.test(subscriptionId))
                    fail(502, 'invalid_subscription');
                await this.authorize(token, spaceId);
                const sub = await this.api('subscriptions/' + encodeURIComponent(subscriptionId));
                if (sub.id !== subscriptionId || sub.customer !== customerId || object(sub.metadata).memory_request_id !== request.id)
                    fail(502, 'invalid_subscription');
                if (!['canceled', 'incomplete_expired'].includes(String(sub.status))) {
                    const at = this.clock();
                    await db.prepare(`INSERT INTO release_billing_events(id,subscription_id,available_at,created_at)
                        SELECT ?,?,?,? FROM spaces s CROSS JOIN active_credentials c
                        WHERE s.id=? AND ${authority('update')} AND ${recentSql()}
                        ON CONFLICT(id) DO NOTHING`).bind('checkout:' + request.id, subscriptionId, at, at,
                        spaceId, ...params(hash, at, 'update'), at - 300000, at).run();
                    await this.authorize(token, spaceId);
                    fail(409, 'checkout_already_completed');
                }
                state = 'subscription_ended';
            } else if (session.status === 'open') {
                fail(409, 'checkout_already_pending');
            } else {
                fail(502, 'invalid_checkout_session');
            }
            const at = this.clock();
            await batch(db, [stmt(db, `INSERT INTO release_checkout_closures(request_id,session_id,state,subscription_id,actor_credential_id,checked_at)
                SELECT ?,?,?,?,c.id,? FROM spaces s CROSS JOIN active_credentials c
                WHERE s.id=? AND ${authority('update')} AND ${recentSql()}
                  AND NOT EXISTS(SELECT 1 FROM release_checkout_closures closed WHERE closed.request_id=?)`,
                [request.id, request.sessionId, state, subscriptionId, at, spaceId, ...params(hash, at, 'update'), at - 300000, at, request.id])]);
            await this.authorize(token, spaceId);
        }
    }
    async checkout(token: string, spaceId: string, priceId: string, operationId: string) {
        const plans = this.requireAvailable();
        await this.authorize(token, spaceId);
        if (!Object.hasOwn(plans, priceId))
            fail(400, 'unknown_price');
        id(operationId);
        const hash = await tokenHash(token), db = this.env.DB;
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
            if (request.expiresAt <= this.clock())
                fail(409, 'checkout_expired');
            if (request.url) {
                await this.authorize(token, spaceId);
                if (request.expiresAt <= this.clock())
                    fail(409, 'checkout_expired');
                return { url: request.url, id: request.id };
            }
        }
        if (!request) {
            await this.closePreviousCheckouts(token, spaceId, pool.id, pool.customerId);
            const claimAt = this.clock();
            const requestId = crypto.randomUUID();
            const inserted = await db.prepare(`INSERT INTO release_checkout_requests(id,pool_id,price_id,operation_key,expires_at,created_at,checkout_attempted) SELECT ?,sp.pool_id,?,?,?,?,0 FROM release_space_pools sp JOIN spaces s ON s.id=sp.space_id CROSS JOIN active_credentials c JOIN release_pools p ON p.id=sp.pool_id WHERE s.id=? AND ${authority('update')} AND ${recentSql()} AND p.subscription_id IS NULL AND NOT EXISTS(SELECT 1 FROM release_checkout_requests old WHERE old.pool_id=sp.pool_id AND (old.expires_at>${sqlNow()} OR (old.checkout_attempted=1 AND NOT EXISTS(SELECT 1 FROM release_checkout_closures closed WHERE closed.request_id=old.id))))`).bind(requestId, priceId, operationId, claimAt + 2100000, claimAt, spaceId, ...params(hash, claimAt, 'update'), claimAt - 300000, claimAt, claimAt).run();
            if (!inserted.meta.changes)
                fail(409, 'checkout_already_pending');
            request = { id: requestId, priceId, url: null, expiresAt: claimAt + 2100000 };
        }
        let customer = pool.customerId;
        if (!customer) {
            await this.authorize(token, spaceId);
            const created = await this.api('customers', 'POST', new URLSearchParams({ 'metadata[memory_pool_id]': pool.id }), 'memory-customer-' + pool.id);
            customer = str(created.id, 100);
            if (!/^cus_[A-Za-z0-9_]+$/.test(customer))
                fail(502, 'invalid_customer');
            const customerAt = this.clock();
            await db.prepare(`UPDATE release_pools SET customer_id=? WHERE id=? AND customer_id IS NULL
                AND EXISTS(SELECT 1 FROM release_space_pools sp JOIN spaces s ON s.id=sp.space_id CROSS JOIN active_credentials c
                    WHERE sp.pool_id=release_pools.id AND s.id=? AND ${authority('update')} AND ${recentSql()})`)
                .bind(customer, pool.id, spaceId, ...params(hash, customerAt, 'update'), customerAt - 300000, customerAt).run();
            const actual = await one<{
                id: string;
            }>(db, 'SELECT customer_id AS id FROM release_pools WHERE id=?', [pool.id]);
            if (!actual?.id)
                fail(403, 'access_denied');
            customer = actual!.id;
        }
        // Customer creation can fail long before Stripe sees a Checkout request.
        // Claim the first attempt and its 35-minute expiry together. Once claimed,
        // even a lost response is uncertain: no retry may extend that expiry.
        const attemptAt = this.clock();
        const claimed = await db.prepare(`UPDATE release_checkout_requests SET expires_at=${sqlNow()}+2100000,checkout_attempted=1
            WHERE id=? AND checkout_attempted=0 AND expires_at>${sqlNow()}
              AND EXISTS(SELECT 1 FROM release_space_pools sp JOIN release_pools p ON p.id=sp.pool_id
                JOIN spaces s ON s.id=sp.space_id CROSS JOIN active_credentials c
                WHERE sp.pool_id=release_checkout_requests.pool_id AND s.id=? AND p.subscription_id IS NULL
                  AND ${authority('update')} AND ${recentSql()})`)
            .bind(attemptAt, request.id, attemptAt, spaceId, ...params(hash, attemptAt, 'update'), attemptAt - 300000, attemptAt).run();
        if (!claimed.success)
            fail(503, 'database_unavailable');
        // A concurrent caller may have won the claim. Every caller uses the
        // primary's persisted expiry, never the value it proposed for the claim.
        const attempted = await one<{ expiresAt: number; checkoutAttempted: number }>(db,
            'SELECT expires_at AS expiresAt,checkout_attempted AS checkoutAttempted FROM release_checkout_requests WHERE id=?', [request.id]);
        if (!attempted || attempted.expiresAt <= this.clock())
            fail(409, 'checkout_expired');
        if (attempted.checkoutAttempted !== 1)
            fail(403, 'access_denied');
        request.expiresAt = attempted.expiresAt;
        await this.authorize(token, spaceId);
        if (request.expiresAt <= this.clock())
            fail(409, 'checkout_expired');
        // Persisted request expiry is also Stripe's expiry. Replays after a lost
        // response must keep identical parameters under the same idempotency key.
        const origin = readSettings(this.env).origin;
        const session = await this.api('checkout/sessions', 'POST', new URLSearchParams({ mode: 'subscription', customer, success_url: origin + '/manage?billing=success', cancel_url: origin + '/manage?billing=cancel', 'line_items[0][price]': priceId, 'line_items[0][quantity]': '1', 'subscription_data[metadata][memory_request_id]': request.id, client_reference_id: request.id, expires_at: String(Math.floor(request.expiresAt / 1000)) }), 'memory-checkout-' + request.id);
        const url = new URL(str(session.url, 2048));
        if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com')
            fail(502, 'invalid_checkout_url');
        await db.prepare('UPDATE release_checkout_requests SET session_id=?,checkout_url=? WHERE id=?').bind(str(session.id, 128), url.href, request.id).run();
        await this.authorize(token, spaceId);
        if (request.expiresAt <= this.clock())
            fail(409, 'checkout_expired');
        return { id: request.id, url: url.href };
    }
    async portal(token: string, spaceId: string) { this.requireAvailable(); await this.authorize(token, spaceId); const pool = await one<{
        customerId: string | null;
    }>(this.env.DB, 'SELECT p.customer_id AS customerId FROM release_space_pools sp JOIN release_pools p ON p.id=sp.pool_id WHERE sp.space_id=?', [spaceId]); if (!pool?.customerId)
        fail(409, 'billing_customer_missing'); await this.authorize(token, spaceId); const result = await this.api('billing_portal/sessions', 'POST', new URLSearchParams({ customer: pool.customerId, return_url: readSettings(this.env).origin + '/manage' })); const url = new URL(str(result.url, 2048)); if (url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com')
        fail(502, 'invalid_portal_url'); await this.authorize(token, spaceId); return { url: url.href }; }
    async webhook(request: Request) {
        const raw = await requestText(request, 262144), header = request.headers.get('stripe-signature') ?? '';
        if (header.length > 4096)
            fail(401, 'invalid_signature');
        const fields = header.split(',').map(x => x.split('='));
        const times = fields.filter(x => x[0] === 't'), signatures = fields.filter(x => x[0] === 'v1').map(x => x[1] ?? '');
        const t = times[0]?.[1] ?? '';
        if (times.length !== 1 || !/^\d{10}$/.test(t) || Math.abs(this.clock() / 1000 - Number(t)) > 300)
            fail(401, 'invalid_signature');
        const signed = await hmac(this.env.STRIPE_WEBHOOK_SECRET ?? '', t + '.' + raw);
        if (!signatures.some(s => equal(s, signed)) || Math.abs(this.clock() / 1000 - Number(t)) > 300)
            fail(401, 'invalid_signature');
        const event = requestObject(raw), eventId = id(event.id), type = str(event.type, 128);
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
        const at = this.clock();
        if (Math.abs(at / 1000 - Number(t)) > 300)
            fail(401, 'invalid_signature');
        try {
            await batch(db, [stmt(db, `INSERT INTO release_webhook_events SELECT 'stripe',?,?,? WHERE ${sqlNow()} BETWEEN ? AND ?`, [eventId, hash, at, at, Number(t) * 1000 - 300000, Number(t) * 1000 + 300000]), stmt(db, `INSERT INTO release_billing_events(id,subscription_id,available_at,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM release_webhook_events WHERE provider='stripe' AND event_id=? AND body_hash=?)`, [eventId, subscription, at, at, eventId, hash])]);
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
        if (!await one(db, `SELECT event_id FROM release_webhook_events WHERE provider='stripe' AND event_id=? AND body_hash=?`, [eventId, hash]))
            fail(401, 'invalid_signature');
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
        const acquired = await db.prepare(`UPDATE release_billing_lock SET token=?,expires_at=${sqlNow()}+120000 WHERE id=1 AND expires_at<=${sqlNow()} RETURNING expires_at AS expiresAt`).bind(lease, at, at).first<{ expiresAt: number }>();
        if (!acquired || acquired.expiresAt <= this.clock())
            return;
        try {
            for (let n = 0; n < limit; n++) {
                const job = await one<{
                    id: string;
                    subscriptionId: string;
                    attempt: number;
                    leaseExpiresAt: number;
                }>(db, `SELECT e.id,e.subscription_id AS subscriptionId,e.attempt,l.expires_at AS leaseExpiresAt
                    FROM release_billing_events e CROSS JOIN release_billing_lock l
                    WHERE e.state='pending' AND e.available_at<=? AND l.id=1 AND l.token=? AND l.expires_at>${sqlNow()}
                    ORDER BY e.created_at,e.id LIMIT 1`, [this.clock(), lease, this.clock()]);
                if (!job || job.leaseExpiresAt <= this.clock())
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
                    await batch(db, [stmt(db, `UPDATE release_pools SET plan=?,monthly_units=?,storage_limit_bytes=?,state=?,subscription_id=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM release_billing_lock WHERE id=1 AND token=? AND expires_at>${sqlNow()})`, [cancelled ? 'free' : (plan?.plan ?? 'unrecognized'), cancelled ? 1000 : (active ? plan!.monthlyUnits : 0), cancelled ? 104857600 : (plan?.storageBytes ?? 104857600), cancelled || active ? 'active' : 'read_only', cancelled ? null : job.subscriptionId, now, pool.id, lease, now]), stmt(db, `UPDATE release_billing_events SET state='done',last_error=NULL WHERE id=? AND EXISTS(SELECT 1 FROM release_billing_lock WHERE id=1 AND token=? AND expires_at>${sqlNow()})`, [job.id, lease, now])]);
                }
                catch {
                    await db.prepare(`UPDATE release_billing_events SET state=?,attempt=attempt+1,available_at=?,last_error='billing_reconciliation_failed' WHERE id=? AND EXISTS(SELECT 1 FROM release_billing_lock WHERE id=1 AND token=? AND expires_at>${sqlNow()})`).bind(job.attempt >= 9 ? 'dead' : 'pending', this.clock() + Math.min(3600000, 1000 * 2 ** job.attempt), job.id, lease, this.clock()).run();
                }
            }
        }
        finally {
            await db.prepare('UPDATE release_billing_lock SET token=NULL,expires_at=0 WHERE id=1 AND token=?').bind(lease).run();
        }
    }
}

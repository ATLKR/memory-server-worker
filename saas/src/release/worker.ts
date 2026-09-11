import { Hono } from 'hono';
import { createApplication } from '../app.ts';
import { readSettings } from '../config.ts';
import { IdentityService } from '../identity.ts';
import type { PublicKeyCache } from '../auth.ts';
import type { ReleaseEnv, WorkerEnv } from './types.ts';
import { resolveReleaseEnv } from '../durable-sql/runtime.ts';
import { createRelease } from './extension.ts';
import { json } from './util.ts';
import { recordMetric } from './telemetry.ts';
import { BUILD_REVISION, BUILD_FINGERPRINT } from './build-info.ts';
// Only the original issuer's public JWKS are shared between requests.
const publicKeyCache: PublicKeyCache = {};
function unavailable(includeBuild = false): Response {
    return json({ error: 'service_unavailable', ...(includeBuild ? { build: { sourceRevision: BUILD_REVISION, resourceFingerprint: BUILD_FINGERPRINT, payloadFormat: 2 } } : {}) }, 503, { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-request-id': crypto.randomUUID() });
}
function maintenance(bindings: WorkerEnv): boolean {
    const value = bindings.MEMORY_SQL_MAINTENANCE;
    if (value === 'true') return true;
    if (value === undefined || value === 'false') return false;
    throw new Error('memory_sql_maintenance_configuration_invalid');
}

// Hono owns the deployed HTTP entry and per-request environment. The product
// router receives the original Request so signature bytes, OAuth/CSRF checks,
// MCP transport and existing response contracts remain unchanged.
const http = new Hono<{ Bindings: WorkerEnv; Variables: { releaseEnv: ReleaseEnv } }>();
http.onError(() => unavailable());
http.use('*', async (context, next) => {
    const start = Date.now();
    try { await next(); }
    catch { context.res = unavailable(); } // Also normalize non-Error provider throws.
    finally {
        // Telemetry reads only METRICS, even when backend resolution fails.
        recordMetric(context.env as ReleaseEnv, context.req.raw, context.res.status, Date.now() - start);
    }
});
http.use('*', async (context, next) => {
    // Stop before binding resolution, authentication and body consumption.
    // Operators must additionally fence SQL writes and drain in-flight work.
    if (maintenance(context.env)) {
        // Keep the normal public build attestation available during cutover,
        // without resolving a database or treating maintenance as readiness.
        const response = unavailable(context.req.method === 'GET' && context.req.path === '/health'); response.headers.set('retry-after', '60');
        return response;
    }
    context.set('releaseEnv', resolveReleaseEnv(context.env));
    await next();
});
http.all('*', context => {
    const env = context.get('releaseEnv');
    const settings = readSettings(env), release = createRelease(env, { identity: new IdentityService(env.DB) });
    const app = createApplication(env.DB, settings, { auth: { publicKeyCache }, limit: key => env.REQUEST_LIMITER.limit({ key }), release });
    return app(context.req.raw);
});

export default {
    async fetch(request: Request, bindings: WorkerEnv): Promise<Response> { return http.fetch(request, bindings); },
    async scheduled(_controller: unknown, bindings: WorkerEnv): Promise<void> {
        if (maintenance(bindings)) return;
        const env = resolveReleaseEnv(bindings);
        await createRelease(env, { identity: new IdentityService(env.DB) }).scheduled();
    }
};

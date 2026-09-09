import { createApplication } from '../app.ts';
import { readSettings } from '../config.ts';
import { IdentityService } from '../identity.ts';
import type { PublicKeyCache } from '../auth.ts';
import type { ReleaseEnv } from './types.ts';
import { createRelease } from './extension.ts';
import { json } from './util.ts';
import { recordMetric } from './telemetry.ts';
// Only the original issuer's public JWKS are shared between requests.
const publicKeyCache: PublicKeyCache = {};
export default {
    async fetch(request: Request, env: ReleaseEnv): Promise<Response> {
        const start = Date.now();
        let response: Response;
        try {
            const settings = readSettings(env), release = createRelease(env, { identity: new IdentityService(env.DB) });
            const app = createApplication(env.DB, settings, { auth: { publicKeyCache }, limit: key => env.REQUEST_LIMITER.limit({ key }), release });
            response = await app(request);
        }
        catch {
            response = json({ error: 'service_unavailable' }, 503, { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-request-id': crypto.randomUUID() });
        }
        recordMetric(env, request, response.status, Date.now() - start);
        return response;
    },
    async scheduled(_controller: unknown, env: ReleaseEnv): Promise<void> { await createRelease(env, { identity: new IdentityService(env.DB) }).scheduled(); }
};

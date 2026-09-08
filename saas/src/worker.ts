import { createApplication } from './app.ts';
import { readSettings } from './config.ts';
import type { PublicKeyCache } from './auth.ts';

// Only the fixed issuer's public keys and fetch time are cached. No token,
// identity, resolver, fetch promise or authorization result is shared.
const publicKeyCache: PublicKeyCache = {};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const settings = readSettings(env);
      const app = createApplication(env.DB, settings, { auth: { publicKeyCache }, limit: key => env.REQUEST_LIMITER.limit({ key }) });
      return await app(request);
    } catch {
      return new Response(JSON.stringify({ error: 'service_unavailable' }), {
        status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
  },
} satisfies ExportedHandler<Env>;

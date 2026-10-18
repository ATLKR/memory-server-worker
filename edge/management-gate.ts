interface Env {
  MEMORY_API: { fetch(request: Request): Promise<Response> };
  PUBLIC_ORIGIN: string;
}

function closed(status: 302 | 403 | 421 | 429 | 503, location?: string): Response {
  const headers = new Headers({
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  if (location) headers.set('location', location);
  if (status === 503) headers.set('retry-after', '60');
  return new Response(null, { status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !url.pathname.endsWith('/manage')) {
      return env.MEMORY_API.fetch(request);
    }
    try {
      const target = new URL(env.PUBLIC_ORIGIN);
      if (target.protocol !== 'https:' || target.origin !== env.PUBLIC_ORIGIN) return closed(503);
      if (url.origin !== target.origin) return closed(421);
      const prefix = url.pathname.slice(0, -'/manage'.length);
      target.pathname = `${prefix}/v1/workspace`;
      const headers = new Headers({ accept: 'application/json', 'cache-control': 'no-store' });
      for (const name of ['cookie', 'origin', 'cf-connecting-ip']) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const probe = await env.MEMORY_API.fetch(new Request(target, {
        headers, redirect: 'manual', signal: AbortSignal.timeout(5000),
      }));
      void probe.body?.cancel().catch(() => {});
      if (probe.status === 401) {
        target.pathname = `${prefix}/auth/login`;
        return closed(302, target.href);
      }
      if (probe.status === 429) {
        const response = closed(429);
        const delay = probe.headers.get('retry-after');
        if (delay !== null && (/^\d+$/.test(delay) || (Number.isFinite(Date.parse(delay)) && new Date(delay).toUTCString() === delay))) {
          response.headers.set('retry-after', delay);
        }
        return response;
      }
      if (probe.status !== 200) return closed(probe.status === 403 ? 403 : 503);
      const forwarded = new Headers(request.headers);
      forwarded.delete('authorization');
      const response = await env.MEMORY_API.fetch(new Request(request, { headers: forwarded }));
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('cache-control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    } catch {
      return closed(503);
    }
  },
};

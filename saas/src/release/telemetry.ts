import type { ReleaseEnv } from './types.ts';
/** No URL/query/header/body, account, email, or token is sent to telemetry. */
export function recordMetric(env: ReleaseEnv, request: Request, status: number, durationMs: number): void {
    const path = new URL(request.url).pathname;
    const route = path.startsWith('/auth/') ? 'auth' : path === '/mcp' ? 'mcp' : path.startsWith('/v1/spaces') ? 'memory' : path.startsWith('/v1/') ? 'account' : path.startsWith('/webhooks/') ? 'webhook' : path.startsWith('/scim/') ? 'scim' : 'public';
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(request.method) ? request.method : 'OTHER';
    try {
        env.METRICS?.writeDataPoint({ indexes: ['memory'], blobs: [route, method, String(status)], doubles: [1, Math.max(0, durationMs)] });
    }
    catch { /* Telemetry never changes a committed response. */ }
}

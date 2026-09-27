import { resolveMemoryRoute } from './placement.ts';
import { createPostgresDatabase } from '../postgres/database.ts';
import { resolvePostgresConnection } from '../postgres/region-app.ts';
import type { RegionConnection, RegionDeploymentConfig, RegionWorkerTestOptions } from '../postgres/region-app.ts';
import type { PostgresRegion } from '../postgres/connection.ts';
import { json } from '../release/util.ts';

/** Edge router: a Space-scoped request is proxied to the deployment that owns
 * its home region. The placement directory is the only route source — a miss,
 * a closed Space, or an ambiguous directory never guesses a target. */
export interface RouterDeploymentConfig {
    control: RegionDeploymentConfig;
}

const endpointsKey = 'MEMORY_REGION_ENDPOINTS_JSON';
const encoder = new TextEncoder();

function ownValue(source: object, key: string): string | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    if (descriptor.value !== undefined && typeof descriptor.value !== 'string') throw new Error('router_configuration_invalid');
    return descriptor.value;
}

function parseEndpoints(value: string | undefined): ReadonlyMap<PostgresRegion, string> {
    const endpoints = new Map<PostgresRegion, string>();
    if (value === undefined) return endpoints;
    if (!value || value.includes('\0') || encoder.encode(value).length > 8192) throw new Error('router_configuration_invalid');
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype)
        throw new Error('router_configuration_invalid');
    for (const [region, endpoint] of Object.entries(parsed)) {
        if (!['sg', 'kr-seoul'].includes(region) || typeof endpoint !== 'string') throw new Error('router_configuration_invalid');
        let url: URL;
        try { url = new URL(endpoint); } catch { throw new Error('router_configuration_invalid'); }
        if (url.origin !== endpoint || url.protocol !== 'https:' || url.username || url.password) throw new Error('router_configuration_invalid');
        endpoints.set(region as PostgresRegion, endpoint);
    }
    return endpoints;
}

function spaceIdFrom(request: Request): string | null {
    const match = /^\/v1\/spaces\/([^/?#]+)/.exec(new URL(request.url).pathname);
    return match ? decodeURIComponent(match[1]!) : null;
}

/** Router worker composition. `${control.prefix}_*` bindings configure the
 * control-plane connection; `MEMORY_REGION_ENDPOINTS_JSON` maps each region to
 * the regional worker's public https origin. Space-scoped requests are proxied
 * with method, headers and body intact; everything else gets a typed refusal —
 * non-Space operations must be addressed to the regional endpoint directly. */
export function createRoutingWorkerApp(env: object, config: RouterDeploymentConfig, testOptions?: RegionWorkerTestOptions) {
    let control: RegionConnection | null = null;
    let endpoints: ReadonlyMap<PostgresRegion, string> = new Map();
    try {
        if (!config?.control) throw new Error('router_configuration_invalid');
        const clientFactory = testOptions && typeof testOptions === 'object' ? testOptions.clientFactory : undefined;
        control = resolvePostgresConnection(env, config.control, '_', `${config.control.prefix}_HYPERDRIVE`, clientFactory);
        if (!control) throw new Error('router_configuration_invalid');
        endpoints = parseEndpoints(ownValue(env, endpointsKey));
    }
    catch {
        control = null; endpoints = new Map();
    }
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/health') return json({ status: 'ok', role: 'router' });
        if (!control) return json({ error: 'service_unavailable' }, 503, { 'retry-after': '60' });
        const spaceId = spaceIdFrom(request);
        if (spaceId === null) return json({ error: 'space_scope_required' }, 404);
        try {
            return await control.withConnection(async session => {
                const route = await resolveMemoryRoute(createPostgresDatabase(session), spaceId);
                if (route.kind === 'not_found') return json({ error: 'not_found' }, 404);
                if (route.kind === 'closed') return json({ error: 'space_closed' }, 410);
                if (route.kind !== 'routed') return json({ error: 'service_unavailable' }, 503, { 'retry-after': '60' });
                const endpoint = endpoints.get(route.region);
                if (!endpoint) return json({ error: 'service_unavailable' }, 503, { 'retry-after': '60' });
                return fetch(new URL(url.pathname + url.search, endpoint), request);
            });
        }
        catch {
            return json({ error: 'service_unavailable' }, 503, { 'retry-after': '60' });
        }
    };
}

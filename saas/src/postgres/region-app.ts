import { Hono } from 'hono';
import { createApplication } from '../app.ts';
import { readSettings } from '../config.ts';
import { IdentityService } from '../identity.ts';
import type { PublicKeyCache } from '../auth.ts';
import type { Database, ReleaseEnv, WorkerEnv } from '../release/types.ts';
import { createRelease } from '../release/extension.ts';
import { json } from '../release/util.ts';
import { createPostgresConnection } from './connection.ts';
import type { ConnectionOptions, HyperdriveBindingSnapshot, PostgresRegion, PostgresTarget, PgSession } from './connection.ts';
import { verifyPostgresDeployment } from './deployment.ts';
import type { ExpectedPostgresDeployment } from './deployment.ts';
import { createPostgresDatabase } from './database.ts';
import { BUILD_REVISION, BUILD_FINGERPRINT } from '../release/build-info.ts';

/** Fixed regional deployment facts. Expectations come from this configuration,
 * never request metadata or the directory — a region app only ever attests the
 * deployment it was configured to serve. */
export interface RegionDeploymentConfig {
    region: PostgresRegion;
    processingPolicyId: string;
    /** Pinned expected regional migration count (contiguous 1..N). */
    schemaVersion: number;
    /** Pinned expected control-plane migration count for the `_CONTROL_`
     * connection. The control lineage is separate from the regional one, so
     * its attestation can never share `schemaVersion`. */
    controlSchemaVersion?: number;
    /** Region the control plane's deployment identity declares. The control
     * cluster is shared infrastructure homed independently of the serving
     * region, so its attestation is pinned separately. */
    controlRegion?: PostgresRegion;
    /** Environment key prefix, e.g. `MEMORY_SG` → `MEMORY_SG_TARGET_JSON`. */
    prefix: string;
    /** Hyperdrive binding name for the regional database, e.g. `SG_HYPERDRIVE`. */
    hyperdriveBinding: string;
}

export interface RegionWorkerTestOptions {
    readonly clientFactory?: ConnectionOptions['clientFactory'];
}

const applicationSchemas = Object.freeze([
    'memory_control', 'memory_identity', 'memory_content', 'memory_search', 'memory_jobs', 'memory_ops',
]);
const targetKeys = Object.freeze([
    'connectionMode', 'database', 'deploymentId', 'expectedRole', 'host', 'port', 'user',
]);
const hyperdriveTargetKeys = Object.freeze(['database', 'deploymentId', 'expectedRole']);
const encoder = new TextEncoder();
const publicKeyCache: PublicKeyCache = {};

type Scalar = Readonly<{ present: boolean; valid: boolean; value?: string }>;
export type RegionConnection = ReturnType<typeof createPostgresConnection>;

function unavailable(includeBuild = false): Response {
    return json({ error: 'service_unavailable', ...(includeBuild ? { build: { sourceRevision: BUILD_REVISION, resourceFingerprint: BUILD_FINGERPRINT, payloadFormat: 2 } } : {}) }, 503, { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-request-id': crypto.randomUUID() });
}

function ownScalar(source: object, key: string): Scalar {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) return { present: false, valid: true };
    if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string'))
        return { present: true, valid: false };
    return { present: true, valid: true, value: descriptor.value };
}

function parseTargetJson(value: string, keys: readonly string[]): Record<string, unknown> {
    if (!value || value.includes('\0') || encoder.encode(value).length > 8192) throw new Error('region_configuration_invalid');
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype
        || Reflect.ownKeys(parsed).some(key => typeof key !== 'string')
        || Object.keys(parsed).sort().join(',') !== keys.join(',')) throw new Error('region_configuration_invalid');
    return parsed as Record<string, unknown>;
}

function expectedDeployment(config: RegionDeploymentConfig, deploymentId: string, schemaVersion = config.schemaVersion,
    region = config.region): ExpectedPostgresDeployment {
    return Object.freeze({ region, deploymentId, processingPolicyId: config.processingPolicyId, schemaVersion });
}

/** Provider↔region pairing is pinned by `validateTarget`: sg→neon,
 * kr-seoul→supabase. A region's provider is fixed config, not env choice. */
function regionProvider(region: PostgresRegion): 'neon' | 'supabase' {
    return region === 'sg' ? 'neon' : 'supabase';
}

function parseNativeTarget(value: string, password: string, ca: string | undefined, config: RegionDeploymentConfig,
    control = false): PostgresTarget {
    const input = parseTargetJson(value, targetKeys);
    if (typeof input.host !== 'string' || typeof input.port !== 'number' || typeof input.database !== 'string'
        || typeof input.user !== 'string' || typeof input.expectedRole !== 'string' || typeof input.deploymentId !== 'string'
        || !['direct', 'session-pooler'].includes(String(input.connectionMode))) throw new Error('region_configuration_invalid');
    return {
        transport: 'native', provider: control ? 'control' : regionProvider(config.region),
        region: control ? (config.controlRegion ?? config.region) : config.region,
        callerRegion: config.region, host: input.host, port: input.port,
        database: input.database, user: input.user, password, expectedRole: input.expectedRole,
        deploymentId: input.deploymentId, applicationSchemas,
        connectionMode: input.connectionMode as 'direct' | 'session-pooler',
        ssl: { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) },
    };
}

function hyperdriveSnapshot(env: object, binding: string): HyperdriveBindingSnapshot {
    const descriptor = Object.getOwnPropertyDescriptor(env, binding);
    if (!descriptor || !('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object')
        throw new Error('region_configuration_invalid');
    const snapshot: Record<string, string | number> = {};
    for (const key of ['connectionString', 'host', 'port', 'user', 'password', 'database']) {
        const field = Object.getOwnPropertyDescriptor(descriptor.value, key);
        if (!field || !('value' in field) || typeof field.value !== (key === 'port' ? 'number' : 'string'))
            throw new Error('region_configuration_invalid');
        snapshot[key] = field.value;
    }
    return Object.freeze({ connectionString: snapshot.connectionString as string, host: snapshot.host as string,
        port: snapshot.port as number, user: snapshot.user as string, password: snapshot.password as string, database: snapshot.database as string });
}

function parseHyperdriveTarget(value: string, env: object, binding: string, config: RegionDeploymentConfig): PostgresTarget {
    const input = parseTargetJson(value, hyperdriveTargetKeys);
    if (typeof input.database !== 'string' || typeof input.expectedRole !== 'string' || typeof input.deploymentId !== 'string')
        throw new Error('region_configuration_invalid');
    return {
        transport: 'hyperdrive', provider: 'supabase', region: config.region, database: input.database,
        expectedRole: input.expectedRole, deploymentId: input.deploymentId, applicationSchemas,
        hyperdrive: hyperdriveSnapshot(env, binding),
    };
}

/** Resolve `${prefix}${suffix}TARGET_JSON`+transport credentials into an
 * attested connection, or null when no target JSON is present. */
export function resolvePostgresConnection(env: object, config: RegionDeploymentConfig, suffix: string,
    hyperdriveBinding: string, clientFactory: ConnectionOptions['clientFactory']): RegionConnection | null {
    const targetJson = ownScalar(env, `${config.prefix}${suffix}TARGET_JSON`);
    if (!targetJson.present) return null;
    if (!targetJson.valid || typeof targetJson.value !== 'string') throw new Error('region_configuration_invalid');
    const transport = ownScalar(env, `${config.prefix}${suffix}TRANSPORT`);
    if (!transport.valid || (transport.value !== undefined && !['native', 'hyperdrive'].includes(transport.value)))
        throw new Error('region_configuration_invalid');
    let target: PostgresTarget;
    if (transport.value === 'hyperdrive') {
        target = parseHyperdriveTarget(targetJson.value, env, hyperdriveBinding, config);
    } else {
        const password = ownScalar(env, `${config.prefix}${suffix}RUNTIME_PASSWORD`);
        const tlsCa = ownScalar(env, `${config.prefix}${suffix}TLS_CA`);
        if (!password.valid || !tlsCa.valid || typeof password.value !== 'string'
            || !password.value || password.value.includes('\0') || encoder.encode(password.value).length > 4096
            || (tlsCa.value !== undefined && (!tlsCa.value || tlsCa.value.includes('\0') || encoder.encode(tlsCa.value).length > 65536)))
            throw new Error('region_configuration_invalid');
        target = parseNativeTarget(targetJson.value, password.value, tlsCa.value, config, suffix === '_CONTROL_');
    }
    const expected = suffix === '_CONTROL_'
        ? expectedDeployment(config, target.deploymentId, config.controlSchemaVersion ?? config.schemaVersion, config.controlRegion ?? config.region)
        : expectedDeployment(config, target.deploymentId);
    return createPostgresConnection(target, {
        verifyDeployment: async (session: PgSession) => verifyPostgresDeployment(session, expected),
        clientFactory,
    });
}

/** Compose the release service over one attested regional session per request.
 * The session is scoped to the request so a pooled transport cannot interleave
 * statements with another request's transaction. */
function serve(env: WorkerEnv, region: RegionConnection, control: RegionConnection | null, request: Request): Promise<Response> {
    const compose = (db: Database, controlDb: Database | undefined): Promise<Response> => {
        const descriptors = Object.getOwnPropertyDescriptors(env);
        delete descriptors.DB;
        delete descriptors.CONTROL_DB;
        const resolved = Object.defineProperties(Object.create(null), descriptors) as ReleaseEnv;
        Object.defineProperty(resolved, 'DB', { value: db, enumerable: true });
        if (controlDb) Object.defineProperty(resolved, 'CONTROL_DB', { value: controlDb, enumerable: true });
        const settings = readSettings(resolved), release = createRelease(resolved, { identity: new IdentityService(db) });
        const app = createApplication(db, settings, { auth: { publicKeyCache }, limit: key => resolved.REQUEST_LIMITER.limit({ key }), release, control: controlDb });
        return app(request);
    };
    return region.withConnection(async session => {
        const db = createPostgresDatabase(session);
        if (!control) return compose(db, undefined);
        return control.withConnection(async controlSession => compose(db, createPostgresDatabase(controlSession)));
    });
}

/** Regional serving composition: the release app over the attested regional
 * cluster, with an optional separate control-plane target for the billing
 * catalog. Unconfigured or misconfigured deployments answer a stable 503 and
 * never evaluate irrelevant binding accessors. */
export function createRegionWorkerApp(env: WorkerEnv, config: RegionDeploymentConfig, testOptions?: RegionWorkerTestOptions) {
    const http = new Hono();
    http.onError(() => unavailable());
    let region: RegionConnection | null = null, control: RegionConnection | null = null, ready = false;
    try {
        if (!config || typeof config !== 'object' || !['sg', 'kr-seoul'].includes(config.region)
            || typeof config.prefix !== 'string' || !/^[A-Z][A-Z0-9_]{0,40}$/.test(config.prefix)
            || typeof config.hyperdriveBinding !== 'string' || !/^[A-Z][A-Z0-9_]{0,60}$/.test(config.hyperdriveBinding)) {
            throw new Error('region_configuration_invalid');
        }
        const enabled = ownScalar(env, `${config.prefix}_ENABLED`);
        if (!enabled.valid) throw new Error('region_configuration_invalid');
        if (enabled.value === 'true') {
            const clientFactory = testOptions && typeof testOptions === 'object' ? testOptions.clientFactory : undefined;
            region = resolvePostgresConnection(env, config, '_', config.hyperdriveBinding, clientFactory);
            if (!region) throw new Error('region_configuration_invalid');
            control = resolvePostgresConnection(env, config, '_CONTROL_', `${config.prefix}_CONTROL_HYPERDRIVE`, clientFactory);
            ready = true;
        }
    }
    catch {
        region = null; control = null; ready = false;
    }
    http.all('*', async context => {
        if (!ready || !region) {
            const response = unavailable(context.req.method === 'GET' && context.req.path === '/health');
            response.headers.set('retry-after', '60');
            return response;
        }
        try {
            return await serve(context.env as WorkerEnv, region, control, context.req.raw);
        }
        catch {
            return unavailable();
        }
    });
    const scheduled = async (): Promise<void> => {
        if (!ready || !region) return;
        const run = (db: Database, controlDb: Database | undefined) => {
            const descriptors = Object.getOwnPropertyDescriptors(env);
            delete descriptors.DB;
            delete descriptors.CONTROL_DB;
            const resolved = Object.defineProperties(Object.create(null), descriptors) as ReleaseEnv;
            Object.defineProperty(resolved, 'DB', { value: db, enumerable: true });
            if (controlDb) Object.defineProperty(resolved, 'CONTROL_DB', { value: controlDb, enumerable: true });
            return createRelease(resolved, { identity: new IdentityService(db) }).scheduled();
        };
        await region.withConnection(async session => {
            const db = createPostgresDatabase(session);
            if (!control) return run(db, undefined);
            return control.withConnection(async controlSession => run(db, createPostgresDatabase(controlSession)));
        });
    };
    return { fetch: (request: Request, bindings: WorkerEnv) => http.fetch(request, bindings), scheduled };
}

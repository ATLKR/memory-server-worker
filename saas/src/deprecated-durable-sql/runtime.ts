import type { Database, ReleaseEnv, WorkerEnv } from '../release/types.ts';
import { createDurableDatabase } from './client.ts';
import { durableSqlObjectName } from './types.ts';
import type { DurableSqlIdentity, DurableSqlStub } from './types.ts';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const hotBinding = /^HOT_[A-Z0-9_]{1,60}$/;
const invalid = (): never => { throw new Error('memory_sql_configuration_invalid'); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string): boolean => Object.keys(value).sort().join(',') === keys;

function json(value: unknown): unknown {
    if (typeof value !== 'string' || value.length > 8192) return invalid();
    try { return JSON.parse(value); } catch { return invalid(); }
}

/** Bound the registry before resolving any provider binding. Its shard IDs and
 * active/draining state keep the existing payload placement contract unchanged. */
function hotBindings(env: WorkerEnv): string[] {
    if (env.STORAGE_MODE !== undefined && env.STORAGE_MODE !== 'inline' && env.STORAGE_MODE !== 'sharded') return invalid();
    if (env.STORAGE_SHARDS_JSON === undefined) return env.STORAGE_MODE === 'sharded' ? invalid() : [];
    const shards = json(env.STORAGE_SHARDS_JSON);
    if (!Array.isArray(shards) || shards.length === 0 || shards.length > 16) return invalid();
    const bindings: string[] = [], ids = new Set<string>();
    let active = false;
    for (const shard of shards) {
        if (!object(shard) || !exact(shard, 'binding,id,mode')
            || typeof shard.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(shard.id)
            || typeof shard.binding !== 'string' || !hotBinding.test(shard.binding)
            || (shard.mode !== 'active' && shard.mode !== 'draining')
            || ids.has(shard.id) || bindings.includes(shard.binding)) return invalid();
        ids.add(shard.id); bindings.push(shard.binding); active ||= shard.mode === 'active';
    }
    if (env.STORAGE_MODE === 'sharded' && !active) return invalid();
    return bindings;
}

/** Resolve once per invocation. The raw Worker environment may contain no D1
 * bindings. Durable mode never reads a D1 getter or falls back to a legacy DB. */
export function resolveReleaseEnv(env: WorkerEnv): ReleaseEnv {
    const backend = env.MEMORY_SQL_BACKEND;
    if (backend === undefined || backend === 'd1') {
        // A namespace alone is permitted while importing an unserved target.
        // Selection variables in D1 mode would make an operator's intent unclear.
        if (env.MEMORY_SQL_DEPLOYMENT_ID !== undefined || env.MEMORY_SQL_EPOCH !== undefined || env.MEMORY_SQL_DATABASES_JSON !== undefined) return invalid();
        if (!env.DB || typeof env.DB.prepare !== 'function' || typeof env.DB.batch !== 'function' || typeof env.DB.withSession !== 'function') return invalid();
        return env as ReleaseEnv;
    }
    if (backend !== 'durable') return invalid();
    const deploymentId = env.MEMORY_SQL_DEPLOYMENT_ID, rawEpoch = env.MEMORY_SQL_EPOCH;
    if (typeof deploymentId !== 'string' || !identifier.test(deploymentId)
        || typeof rawEpoch !== 'string' || !/^[1-9][0-9]{0,15}$/.test(rawEpoch)
        || !Number.isSafeInteger(Number(rawEpoch))) return invalid();
    const epoch = Number(rawEpoch), mapping = json(env.MEMORY_SQL_DATABASES_JSON);
    if (!object(mapping)) return invalid();
    const bindings = ['DB', ...hotBindings(env).sort()];
    if (Object.keys(mapping).sort().join(',') !== [...bindings].sort().join(',')) return invalid();
    const identities = new Map<string, DurableSqlIdentity>(), databaseIds = new Set<string>();
    for (const binding of bindings) {
        const item = mapping[binding], kind = binding === 'DB' ? 'control' : 'hot';
        if (!object(item) || !exact(item, 'databaseId,kind') || item.kind !== kind
            || typeof item.databaseId !== 'string' || !identifier.test(item.databaseId) || databaseIds.has(item.databaseId)) return invalid();
        databaseIds.add(item.databaseId);
        identities.set(binding, Object.freeze({ deploymentId, databaseId: item.databaseId, kind, epoch }));
    }
    const namespace = env.MEMORY_SQL;
    if (!namespace || typeof namespace.getByName !== 'function') return invalid();
    // Descriptors preserve other native bindings without invoking any accessor.
    // Remove SQL descriptors before copying; even non-configurable D1 getters
    // must never be evaluated, copied over an adapter, or accessed by the app.
    const descriptors = Object.getOwnPropertyDescriptors(env);
    for (const binding of bindings) delete descriptors[binding];
    const resolved = Object.defineProperties(Object.create(null), descriptors) as ReleaseEnv;
    for (const [binding, identity] of identities) {
        const name = durableSqlObjectName(identity);
        const stub: DurableSqlStub = namespace.getByName(name);
        const db: Database = createDurableDatabase(stub, identity);
        Object.defineProperty(resolved, binding, { value: db, enumerable: true, writable: false, configurable: false });
    }
    return resolved;
}

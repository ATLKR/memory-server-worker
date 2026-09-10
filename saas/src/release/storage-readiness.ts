import type { ReleaseEnv, Database } from './types.ts';
import { PayloadStore } from './payloads.ts';
import { BUILD_FINGERPRINT } from './build-info.ts';
import type { StorageReadiness } from './readiness.ts';
import { deadline } from './search.ts';

/** Runtime provider/schema probes. Resource identities are pinned by the
 * deployment build and independently checked in the live acceptance evidence. */
export async function inspectStorage(env: ReleaseEnv): Promise<StorageReadiness> {
    const result = { ready: false, hotSchemaVersion: 1, resourceFingerprint: BUILD_FINGERPRINT };
    try {
        const storage = new PayloadStore(env);
        if (!storage.enabled || storage.shardIds().length < 2 || !env.MEMORY_PAYLOADS) return result;
        const shards = JSON.parse(env.STORAGE_SHARDS_JSON!) as { binding: string }[], bindings = env as unknown as Record<string, Database>;
        for (let offset = 0; offset < shards.length; offset += 4) {
            const probes = await Promise.all(shards.slice(offset, offset + 4).map(async shard =>
                deadline(bindings[shard.binding]!.withSession('first-primary').prepare('SELECT max(version) AS version FROM payload_meta').first<{ version: number }>(), 3000)));
            if (probes.some(row => row?.version !== 1)) return result;
        }
        // Missing is a healthy response to this deliberately unused key. No
        // private payload bytes, user object names, or writes enter /ready.
        await deadline(env.MEMORY_PAYLOADS.head('_health/provider-probe'), 3000);
        result.ready = true;
    } catch { /* A missing/unavailable binding keeps GA readiness false. */ }
    return result;
}

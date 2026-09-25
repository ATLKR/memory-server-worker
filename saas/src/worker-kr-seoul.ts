import { createRegionWorkerApp } from './postgres/region-app.ts';
import type { WorkerEnv } from './release/types.ts';

/** kr-seoul regional worker. Serves the full release surface over the attested
 * Supabase regional cluster; the control-plane connection is optional
 * (replicated read surface homed on the sg control cluster). */
const CONFIG = {
    region: 'kr-seoul',
    processingPolicyId: 'kr-primary-storage-v1',
    schemaVersion: 18,
    controlSchemaVersion: 7,
    controlRegion: 'sg',
    prefix: 'MEMORY_KR',
    hyperdriveBinding: 'KR_HYPERDRIVE',
} as const;

export default {
    fetch: (request: Request, env: WorkerEnv): Promise<Response> =>
        createRegionWorkerApp(env, CONFIG).fetch(request, env),
    scheduled: (_controller: unknown, env: WorkerEnv): Promise<void> =>
        createRegionWorkerApp(env, CONFIG).scheduled(),
};

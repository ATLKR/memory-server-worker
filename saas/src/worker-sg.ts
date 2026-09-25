import { createRegionWorkerApp } from './postgres/region-app.ts';
import type { WorkerEnv } from './release/types.ts';

/** sg regional worker. Serves the full release surface over the attested Neon
 * regional cluster; the control-plane connection is optional (control is homed
 * on the sg cluster itself for the pilot). */
const CONFIG = {
    region: 'sg',
    processingPolicyId: 'standard-v1',
    schemaVersion: 18,
    controlSchemaVersion: 7,
    controlRegion: 'sg',
    prefix: 'MEMORY_SG',
    hyperdriveBinding: 'SG_HYPERDRIVE',
} as const;

export default {
    fetch: (request: Request, env: WorkerEnv): Promise<Response> =>
        createRegionWorkerApp(env, CONFIG).fetch(request, env),
    scheduled: (_controller: unknown, env: WorkerEnv): Promise<void> =>
        createRegionWorkerApp(env, CONFIG).scheduled(),
};

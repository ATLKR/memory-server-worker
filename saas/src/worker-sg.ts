import { createRegionWorkerApp } from './postgres/region-app.ts';
import type { WorkerEnv } from './release/types.ts';

/** sg regional worker. Serves the full release surface over the attested Neon
 * regional cluster; the control-plane connection is optional (control is homed
 * on the sg cluster itself for the pilot). */
const CONFIG = {
    region: 'sg',
    processingPolicyId: 'sg-primary-storage-v1',
    schemaVersion: 19,
    controlSchemaVersion: 7,
    controlRegion: 'sg',
    controlPolicyId: 'standard-v1',
    prefix: 'MEMORY_SG',
    hyperdriveBinding: 'SG_HYPERDRIVE',
} as const;

export default {
    fetch: (request: Request, env: WorkerEnv): Promise<Response> =>
        createRegionWorkerApp(env, CONFIG).fetch(request, env),
    scheduled: (_controller: unknown, env: WorkerEnv): Promise<void> =>
        createRegionWorkerApp(env, CONFIG).scheduled(),
};

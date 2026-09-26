import { createRoutingWorkerApp } from './routing/router.ts';
import type { WorkerEnv } from './release/types.ts';

/** Placement router: unprefixed `/v1/spaces/{id}/...` requests resolve the
 * Space's home region on the control-plane directory and proxy to the
 * regional worker origin in MEMORY_REGION_ENDPOINTS_JSON. Non-Space paths get
 * a typed refusal — the control surface itself is not served here. */
const CONTROL = {
    region: 'sg',
    processingPolicyId: 'standard-v1',
    schemaVersion: 7,
    prefix: 'MEMORY_CONTROL',
    hyperdriveBinding: 'CONTROL_HYPERDRIVE',
} as const;

export default {
    fetch: (request: Request, env: WorkerEnv): Promise<Response> =>
        createRoutingWorkerApp(env, { control: CONTROL })(request),
};

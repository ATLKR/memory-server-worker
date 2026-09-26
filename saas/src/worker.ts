// Personal root Worker is unchanged. This entry belongs only to saas/.
// Production serves the kr-seoul regional deployment over attested
// PostgreSQL; the D1 `DB` binding stays declared for the deploy validator
// and is ignored by the region wrapper.
import { createRegionWorkerApp } from './postgres/region-app.ts';
import type { WorkerEnv } from './release/types.ts';

const CONFIG = {
    region: 'kr-seoul',
    processingPolicyId: 'kr-primary-storage-v1',
    schemaVersion: 19,
    controlSchemaVersion: 7,
    controlRegion: 'sg',
    controlPolicyId: 'standard-v1',
    prefix: 'MEMORY_KR',
    hyperdriveBinding: 'KR_HYPERDRIVE',
} as const;

export default {
    fetch: (request: Request, env: WorkerEnv): Promise<Response> =>
        createRegionWorkerApp(env, CONFIG).fetch(request, env),
    scheduled: (_controller: unknown, env: WorkerEnv): Promise<void> =>
        createRegionWorkerApp(env, CONFIG).scheduled(),
};
export {OrganizationConsentLedger} from './routing/ledger-object.ts';
export {AgentMemorySpaceLedger} from './routing/general-ledger-object.ts';
export {AgentMemoryBudgetLedger} from './routing/budget-ledger-object.ts';
export {MemorySqlDatabase} from './deprecated-durable-sql/object.ts';

import type { Database } from '../release/types.ts';
import type { PostgresRegion } from '../postgres/connection.ts';
import { parseDataPolicy, type DataPolicy } from '../postgres/residency-policy.ts';
import { id } from '../release/util.ts';

/** Placement-directory resolution result. A request never falls back across
 * regions: anything that is not an exact live route is a typed refusal. */
export type MemoryRoute = Readonly<{
    kind: 'routed';
    spaceId: string;
    region: PostgresRegion;
    deploymentId: string;
    processingPolicyId: string;
    placementEpoch: number;
    dataPolicy: DataPolicy;
}> | Readonly<{ kind: 'not_found' | 'closed' | 'unavailable' }>;

function failure(code: string): Error & { code: string } {
    return Object.assign(new Error(code), { code });
}

/** Resolve a Space's serving route from the control-plane placement directory.
 * A single indexed read per call — revocation freshness is preferred over a
 * cached placement token (open decision 1, decided for the directory read).
 * Fails closed: a corrupted or ambiguous directory never routes a request. */
export async function resolveMemoryRoute(directory: Database, spaceId: string): Promise<MemoryRoute> {
    const key = id(spaceId);
    let space: { homeRegion: string; policy: string; placementEpoch: number; closedAt: number | null; regionRetiredAt: number | null } | null;
    try {
        space = await directory.prepare(`SELECT s.home_region AS "homeRegion",s.data_policy::text AS policy,
            s.placement_epoch AS "placementEpoch",s.closed_at_ms AS "closedAt",r.retired_at_ms AS "regionRetiredAt"
            FROM memory_control.spaces s JOIN memory_control.regions r ON r.region=s.home_region WHERE s.id=?`)
            .bind(key).first();
    }
    catch {
        throw failure('placement_directory_unavailable');
    }
    if (!space) return Object.freeze({ kind: 'not_found' });
    if (space.closedAt !== null) return Object.freeze({ kind: 'closed' });
    let dataPolicy: DataPolicy;
    try {
        dataPolicy = parseDataPolicy(JSON.parse(space.policy));
    }
    catch {
        return Object.freeze({ kind: 'unavailable' });
    }
    if (dataPolicy.residency !== space.homeRegion || dataPolicy.placementEpoch !== space.placementEpoch
        || !['sg', 'kr-seoul'].includes(space.homeRegion)) {
        return Object.freeze({ kind: 'unavailable' });
    }
    let deployments: { deploymentId: string; processingPolicyId: string }[];
    try {
        deployments = (await directory.prepare(`SELECT deployment_id AS "deploymentId",processing_policy_id AS "processingPolicyId"
            FROM memory_control.deployments WHERE region=? AND retired_at_ms IS NULL ORDER BY deployment_id`)
            .bind(space.homeRegion).all()).results as { deploymentId: string; processingPolicyId: string }[];
    }
    catch {
        throw failure('placement_directory_unavailable');
    }
    // Exactly one live deployment serves a region; zero or several is a
    // directory inconsistency and never silently selects a target.
    if (deployments.length !== 1 || space.regionRetiredAt !== null) return Object.freeze({ kind: 'unavailable' });
    return Object.freeze({
        kind: 'routed', spaceId: key, region: space.homeRegion as PostgresRegion,
        deploymentId: deployments[0]!.deploymentId, processingPolicyId: deployments[0]!.processingPolicyId,
        placementEpoch: space.placementEpoch, dataPolicy,
    });
}

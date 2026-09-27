/** Space data_policy construction for Space-creating commands.
 *
 * Every Space carries an immutable data_policy: a customer-declared residency
 * plus the platform placement facts. The SQL fragment builds it inside the
 * mutating statement so the deployment singleton supplies the residency when
 * the caller passes NULL, and the region apply asserts residency equals this
 * deployment's storage_region — a customer may declare a residency only the
 * serving deployment can honor. placementEpoch starts at 1.
 */
export function dataPolicySql(residencyParam: string): string {
    return `jsonb_build_object('policyVersion',1,'residency',coalesce(${residencyParam},
        (SELECT storage_region FROM memory_control.deployment_identity)),
      'profile','standard','processingBoundary','approved-processors','dataClass','general',
      'classificationStatus','declared','sensitivityTags','[]'::jsonb,'placementEpoch',1)`;
}

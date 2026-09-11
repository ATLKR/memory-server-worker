import type { PgSession, PostgresRegion } from './connection.ts';

export interface ExpectedPostgresDeployment {
  region: PostgresRegion;
  deploymentId: string;
  processingPolicyId: string;
  schemaVersion: number;
}

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** Expectations come from the fixed deployment configuration, never request metadata.
 * This attests the database identity and schema only, not residency or compliance.
 */
export async function verifyPostgresDeployment(session: PgSession, expected: ExpectedPostgresDeployment): Promise<ExpectedPostgresDeployment> {
  if (!expected || !['sg', 'kr-seoul'].includes(expected.region)
    || typeof expected.deploymentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(expected.deploymentId)
    || typeof expected.processingPolicyId !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(expected.processingPolicyId)
    || !Number.isSafeInteger(expected.schemaVersion) || expected.schemaVersion < 1 || expected.schemaVersion > 10000) {
    throw failure('postgres_deployment_expectation_invalid');
  }
  // Freeze the expected values before awaiting the database; an external mutable
  // object cannot change the deployment we attest during a query.
  const wanted = { ...expected };
  let rows: Record<string, unknown>[];
  try {
    rows = (await session.query(`SELECT d.singleton, d.deployment_id, d.storage_region, d.processing_policy_id,
      ARRAY(SELECT version FROM memory_control.schema_migrations ORDER BY version LIMIT $1::integer) AS versions
      FROM memory_control.deployment_identity d LIMIT 2`, [wanted.schemaVersion + 1])).rows;
  } catch {
    throw failure('postgres_deployment_unavailable');
  }
  const row = rows[0];
  if (rows.length !== 1 || !row || row.singleton !== 1 || row.deployment_id !== wanted.deploymentId
    || row.storage_region !== wanted.region || row.processing_policy_id !== wanted.processingPolicyId
    || !Array.isArray(row.versions) || row.versions.length !== wanted.schemaVersion
    || row.versions.some((version, index) => version !== index + 1)) {
    throw failure('postgres_deployment_mismatch');
  }
  return Object.freeze(wanted);
}

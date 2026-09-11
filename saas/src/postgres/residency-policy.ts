import { z } from 'zod';
import type { PostgresRegion } from './connection.ts';

const policySchema = z.strictObject({
  policyVersion: z.literal(1),
  residency: z.enum(['sg', 'kr-seoul']),
  profile: z.enum(['standard', 'kr-primary-storage', 'medical-strict']),
  processingBoundary: z.enum(['approved-processors', 'kr', 'kr-seoul']),
  dataClass: z.enum(['general', 'personal', 'health', 'clinical', 'restricted']),
  classificationStatus: z.enum(['unclassified', 'declared', 'verified']),
  sensitivityTags: z.array(z.enum(['health', 'clinical-origin', 'government-id', 'credential'])).max(4),
  placementEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
type PolicyFields = z.infer<typeof policySchema>;
export type DataPolicy = Readonly<Omit<PolicyFields, 'sensitivityTags'> & { sensitivityTags: readonly PolicyFields['sensitivityTags'][number][] }>;
export interface RegionalIngressContext {
  databaseRegion: PostgresRegion;
  credentialRegion: PostgresRegion;
  tenantRegion: PostgresRegion;
}
function reject(code: string): never { throw Object.assign(new Error(code), { code }); }

const placementRequest = z.strictObject({
  dataClass: policySchema.shape.dataClass,
  profile: z.enum(['general', 'medical', 'strict']).optional(),
  sensitivityTags: policySchema.shape.sensitivityTags.default([]),
});

/** User-selected product placement: general data consolidates in Singapore;
 * medical, restricted and explicitly strict profiles always use Seoul.
 * This uses the declaration, never IP/email/TLD or an overseas classifier.
 */
export function selectStoragePlacement(input: unknown): Readonly<Pick<DataPolicy, 'residency' | 'profile'>> {
  const parsed = placementRequest.safeParse(input);
  if (!parsed.success) reject('data_policy_invalid');
  const p = parsed.data, sensitive = !['general', 'personal'].includes(p.dataClass) || p.sensitivityTags.length > 0;
  if (p.profile === 'general' && sensitive) reject('sensitive_storage_requires_seoul');
  if (p.profile === 'strict') return Object.freeze({ residency: 'kr-seoul', profile: 'medical-strict' });
  if (p.profile === 'medical' || sensitive) return Object.freeze({ residency: 'kr-seoul', profile: 'kr-primary-storage' });
  return Object.freeze({ residency: 'sg', profile: 'standard' });
}

/** A policy label never proves legal basis, tenant authority or deployment readiness. */
export function parseDataPolicy(input: unknown): DataPolicy {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) reject('data_policy_invalid');
  const p = parsed.data;
  if ((p.profile === 'standard' && p.residency !== 'sg')
    || (p.profile !== 'standard' && p.residency !== 'kr-seoul')
    || (p.profile === 'medical-strict' ? p.processingBoundary === 'approved-processors' : p.processingBoundary !== 'approved-processors')) {
    reject('data_policy_invalid');
  }
  const tags = new Set(p.sensitivityTags);
  if (p.dataClass === 'health' || p.dataClass === 'clinical' || tags.has('clinical-origin')) tags.add('health');
  if (p.dataClass === 'clinical') tags.add('clinical-origin');
  if (p.residency !== 'kr-seoul' && (!['general', 'personal'].includes(p.dataClass) || tags.size > 0)) {
    reject('sensitive_storage_requires_seoul');
  }
  return Object.freeze({ ...p, sensitivityTags: Object.freeze([...tags].sort()) });
}

/** Storage admission for trusted, regionally verified context. This is not an
 * HTTP/AI/MCP processing permit: the caller separately verifies authority,
 * purpose and processor capabilities. User-requested Seoul medical storage is
 * supported without equating it to end-to-end local processing or a signed BAA.
 */
export function assertRegionalStorageAdmission(input: unknown, context: RegionalIngressContext): void {
  const p = parseDataPolicy(input);
  if (!context || [context.databaseRegion, context.credentialRegion, context.tenantRegion].some(region => region !== p.residency)) {
    reject('storage_region_mismatch');
  }
  if (p.classificationStatus === 'unclassified') reject('classification_required');
}

/** Internal storage placement only; passing is not permission to export to a
 * recipient or to use an inference provider in the same country.
 */
export function assertSameStorageRegion(input: unknown, target: unknown): void {
  const p = parseDataPolicy(input);
  if (target !== p.residency) reject('storage_region_mismatch');
}

/** Conservative same-placement policy merge. Source IDs, current ACL intersection,
 * purpose, retention and permitted-recipient intersection remain mandatory in
 * the caller; this helper must not be used as an authorization decision.
 */
export function deriveDataPolicy(sources: readonly unknown[]): DataPolicy {
  if (!Array.isArray(sources) || !sources.length || sources.length > 32) reject('derived_policy_conflict');
  const policies = sources.map(parseDataPolicy), first = policies[0]!;
  if (policies.some(p => p.residency !== first.residency || p.profile !== first.profile
    || p.processingBoundary !== first.processingBoundary || p.placementEpoch !== first.placementEpoch)) {
    reject('derived_policy_conflict');
  }
  const classes = new Set(policies.map(p => p.dataClass));
  const dataClass = (['restricted', 'clinical', 'health', 'personal', 'general'] as const).find(c => classes.has(c))!;
  // New output can infer sensitive facts absent from its inputs. Source labels
  // provide minimum restrictions, not classification evidence for that output.
  return parseDataPolicy({ ...first, dataClass, classificationStatus: 'unclassified',
    sensitivityTags: [...new Set(policies.flatMap(p => [...p.sensitivityTags]))] });
}

import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const maxTimestamp = 8_640_000_000_000_000;
const timestamp = z.number().int().min(0).max(maxTimestamp);
const clock = timestamp.max(maxTimestamp - 60_000);
export const medicalCloudflareConsentReferenceSchema = z.strictObject({ consentId: identifier, version });
export type MedicalCloudflareConsentReference = Readonly<z.infer<typeof medicalCloudflareConsentReferenceSchema>>;
export const medicalCloudflareConsentOperationSchema = z.enum(['memory_ingest', 'memory_search']);
export type MedicalCloudflareConsentOperation = z.infer<typeof medicalCloudflareConsentOperationSchema>;
export const medicalCloudflareConsentScopeSchema = z.enum(['ingest', 'storage', 'extraction', 'embedding', 'recall']);
const unique = (values: string[]) => new Set(values).size === values.length;

/** Service-owned ledger record. `storage` includes verbatim raw messages.
 * Evidence references are opaque ledger IDs, not document contents or secrets.
 * The schema records a product permission; it makes no legal determination.
 */
export const cloudflareMedicalConsentSchema = z.strictObject({
  id: identifier, version, organizationId: identifier,
  spaceScope: z.union([
    z.strictObject({ kind: z.literal('all-spaces') }),
    z.strictObject({ kind: z.literal('spaces'), spaceIds: z.array(identifier).min(1).max(1024).refine(unique) }),
  ]),
  provider: z.literal('cloudflare-agent-memory'), classification: z.literal('medical'),
  scopes: z.array(medicalCloudflareConsentScopeSchema).min(1).max(5).refine(unique),
  validFromMs: timestamp, expiresAtMs: timestamp.optional(),
  status: z.enum(['granted', 'revoked']), approvedBy: identifier, evidenceRef: identifier,
  revokedAtMs: timestamp.optional(),
}).refine(record => record.expiresAtMs === undefined || record.expiresAtMs > record.validFromMs)
  .refine(record => record.status === 'granted' ? record.revokedAtMs === undefined
    : record.revokedAtMs !== undefined);

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type CloudflareMedicalConsent = DeepReadonly<z.infer<typeof cloudflareMedicalConsentSchema>>;

/** This object must be assembled from server authentication, current organization
 * membership/Space ACLs, and the latest service-owned ledger row. Never accept it
 * from tool arguments, client claims, or an earlier permit. This pure module does
 * not load or persist a ledger and cannot establish freshness by itself.
 */
export const medicalCloudflareConsentContextSchema = z.strictObject({
  organizationId: identifier, accountId: identifier, spaceId: identifier,
  membership: z.strictObject({ organizationId: identifier, accountId: identifier,
    status: z.enum(['active', 'suspended', 'removed']) }),
  spaceAuthorized: z.boolean(), operation: medicalCloudflareConsentOperationSchema,
  record: z.unknown(), reference: medicalCloudflareConsentReferenceSchema.optional(), now: clock,
});
export type MedicalCloudflareConsentContext = z.infer<typeof medicalCloudflareConsentContextSchema>;
export type MedicalCloudflareConsentPermit = Readonly<{
  consentId: string; version: number; organizationId: string; accountId: string; spaceId: string;
  provider: 'cloudflare-agent-memory'; classification: 'medical'; operation: MedicalCloudflareConsentOperation;
  checkedAtMs: number; validUntilMs: number;
}>;

function reject(code: string): never { throw Object.assign(new Error(code), { code }); }

export function parseCloudflareMedicalConsent(input: unknown): CloudflareMedicalConsent {
  const result = cloudflareMedicalConsentSchema.safeParse(input);
  if (!result.success) reject('routing_consent_unavailable');
  const record = result.data;
  Object.freeze(record.scopes);
  if (record.spaceScope.kind === 'spaces') Object.freeze(record.spaceScope.spaceIds);
  Object.freeze(record.spaceScope);
  return Object.freeze(record);
}

/** No employee consent prompt is required: absent reference means evaluate the
 * current organization standing grant selected by the service. The returned
 * metadata is unsigned and is not a transferable authorization receipt. Re-read
 * current consent and ACLs when performing the operation; expiry never overrides
 * revocation. Hard region restrictions remain a separate mandatory routing check.
 */
export function assertMedicalCloudflareConsent(input: unknown): MedicalCloudflareConsentPermit {
  const parsed = medicalCloudflareConsentContextSchema.safeParse(input);
  if (!parsed.success) reject('routing_consent_context_invalid');
  const context = parsed.data, record = parseCloudflareMedicalConsent(context.record);
  if (record.status !== 'granted' || context.now < record.validFromMs
    || (record.expiresAtMs !== undefined && context.now >= record.expiresAtMs)) reject('routing_consent_unavailable');
  if (record.organizationId !== context.organizationId || context.membership.organizationId !== context.organizationId
    || context.membership.accountId !== context.accountId || context.membership.status !== 'active' || !context.spaceAuthorized
    || (record.spaceScope.kind === 'spaces' && !record.spaceScope.spaceIds.includes(context.spaceId))) {
    reject('routing_consent_scope_denied');
  }
  if (context.reference && (context.reference.consentId !== record.id || context.reference.version !== record.version)) {
    reject('routing_consent_reference_mismatch');
  }
  const needed: readonly z.infer<typeof medicalCloudflareConsentScopeSchema>[] = context.operation === 'memory_ingest'
    ? ['ingest', 'storage', 'extraction', 'embedding'] : ['storage', 'embedding', 'recall'];
  if (needed.some(scope => !record.scopes.includes(scope))) reject('routing_consent_scope_denied');
  return Object.freeze({ consentId: record.id, version: record.version, organizationId: context.organizationId,
    accountId: context.accountId, spaceId: context.spaceId, provider: record.provider, classification: record.classification,
    operation: context.operation, checkedAtMs: context.now, validUntilMs: Math.min(context.now + 60_000, record.expiresAtMs ?? maxTimestamp) });
}

/** Pure monotonic transition only. The caller must persist with a compare-and-set
 * against expectedVersion. Repeating a revocation preserves its original version
 * and timestamp; this helper cannot grant consent or resurrect a revoked record.
 */
export function revokeCloudflareMedicalConsent(input: unknown, options: unknown): CloudflareMedicalConsent {
  const record = parseCloudflareMedicalConsent(input);
  const parsed = z.strictObject({ now: timestamp, expectedVersion: version }).safeParse(options);
  if (!parsed.success || parsed.data.expectedVersion !== record.version
    || (record.revokedAtMs !== undefined && parsed.data.now < record.revokedAtMs)) reject('routing_consent_transition_invalid');
  if (record.status === 'revoked') return record;
  if (record.version === Number.MAX_SAFE_INTEGER) reject('routing_consent_transition_invalid');
  return parseCloudflareMedicalConsent({ ...record, status: 'revoked', version: record.version + 1, revokedAtMs: parsed.data.now });
}

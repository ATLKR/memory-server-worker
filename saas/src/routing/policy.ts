import { z } from 'zod';
import { assertMedicalCloudflareConsent, medicalCloudflareConsentReferenceSchema } from './consent.ts';

export const routingDecisionSchema = z.strictObject({
  version: z.literal(1),
  classification: z.enum(['general', 'medical', 'region-locked', 'uncertain']),
  destination: z.enum(['auto', 'agent-memory', 'seoul']).optional(),
  requiredRegion: z.literal('kr-seoul').optional(),
  // A reference requests the consent path; it is not consent evidence. Clients
  // obtain a current server receipt before egress, and servers recheck at use.
  medicalCloudflareConsent: z.union([medicalCloudflareConsentReferenceSchema,
    z.strictObject({ mode: z.literal('organization') })]).optional(),
});
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;
const restrictionSchema = z.strictObject({
  route: z.enum(['agent-memory', 'seoul']), requiredRegion: z.literal('kr-seoul').optional(),
}).refine(r => r.route !== 'agent-memory' || r.requiredRegion === undefined);
export type RoutingRestriction = z.infer<typeof restrictionSchema>;
const planSchema = z.union([
  z.strictObject({ version: z.literal(1), route: z.literal('agent-memory'), storage: z.literal('cloudflare-agent-memory'),
    vector: z.literal('managed-agent-memory'), requiredRegion: z.null() }),
  z.strictObject({ version: z.literal(1), route: z.literal('seoul'), storage: z.literal('postgres'),
    vector: z.literal('pgvector'), requiredRegion: z.literal('kr-seoul') }),
]);
export type RoutingPlan = Readonly<z.infer<typeof planSchema>>;
export const routingTargetSchema = z.union([
  z.strictObject({ route: z.literal('agent-memory'), storage: z.literal('cloudflare-agent-memory'),
    vector: z.literal('managed-agent-memory'), region: z.literal('cloudflare'), ready: z.boolean() }),
  z.strictObject({ route: z.literal('seoul'), storage: z.literal('postgres'), vector: z.literal('pgvector'),
    region: z.literal('kr-seoul'), ready: z.boolean() }),
]);
export type RoutingTarget = Readonly<z.infer<typeof routingTargetSchema>>;
function reject(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Run locally before sending content. Topic decisions are product routing labels,
 * not legal conclusions. Server callers supply current Space/source restrictions
 * from their own authority store; an agent declaration cannot waive those rules.
 */
export function resolveMemoryRoute(decision: unknown, restrictions: readonly unknown[] = []): RoutingPlan {
  const input = routingDecisionSchema.safeParse(decision);
  if (!input.success) reject('routing_decision_invalid');
  const inherited = z.array(restrictionSchema).max(128).safeParse(restrictions);
  if (!inherited.success) reject('routing_restrictions_invalid');
  const d = input.data;
  const locked = d.classification === 'region-locked' || d.classification === 'uncertain'
    || (d.classification === 'medical' && !d.medicalCloudflareConsent) || d.requiredRegion === 'kr-seoul'
    || inherited.data.some(r => r.route === 'seoul');
  if (locked && d.destination === 'agent-memory') reject('routing_downgrade_denied');
  if (locked || d.destination === 'seoul') return Object.freeze({ version: 1, route: 'seoul',
    storage: 'postgres', vector: 'pgvector', requiredRegion: 'kr-seoul' });
  return Object.freeze({ version: 1, route: 'agent-memory', storage: 'cloudflare-agent-memory',
    vector: 'managed-agent-memory', requiredRegion: null });
}

/** Metadata matching is necessary but not proof of a provider's physical location.
 * The deployed endpoint must independently verify bindings, ACLs and readiness.
 */
export function assertRoutingTarget(input: unknown, target: unknown): asserts target is RoutingTarget {
  const plan = planSchema.safeParse(input);
  if (!plan.success) reject('routing_plan_invalid');
  const configured = routingTargetSchema.safeParse(target);
  if (!configured.success || !configured.data.ready || configured.data.route !== plan.data.route
    || configured.data.storage !== plan.data.storage || configured.data.vector !== plan.data.vector
    || (plan.data.requiredRegion !== null && configured.data.region !== plan.data.requiredRegion)) {
    reject('routing_target_unavailable');
  }
}

/** Shared server boundary. The returned plan is not an authorization grant:
 * authenticate first and retain current credential/Space checks at commit and read.
 */
export function assertServerRouting(decision: unknown, target: unknown, trustedRestrictions: readonly unknown[] = [], trustedConsentContext?: unknown): RoutingPlan {
  const plan = resolveMemoryRoute(decision, trustedRestrictions);
  assertRoutingTarget(plan, target);
  const input = routingDecisionSchema.parse(decision);
  if (plan.route === 'agent-memory' && input.classification === 'medical') {
    // The service supplies a fresh ledger row, authenticated membership/Space
    // and the actual operation. A client flag is only a selector, never a grant.
    if (!trustedConsentContext || typeof trustedConsentContext !== 'object' || Array.isArray(trustedConsentContext)
      || Object.hasOwn(trustedConsentContext, 'reference')) reject('routing_consent_context_invalid');
    const consent = input.medicalCloudflareConsent;
    assertMedicalCloudflareConsent({ ...trustedConsentContext,
      ...(consent && 'consentId' in consent ? { reference: consent } : {}) });
  }
  return plan;
}

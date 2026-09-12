import { createRoutingClient } from '../../src/routing/client.ts';
import type { RoutingClient, RoutingClientConfig, RoutingToolResult } from '../../src/routing/client.ts';
import type { RoutingPlan, SeoulPlacement } from '../../src/routing/policy.ts';

// Compiled, never executed. Existing typed consumers keep the v1 result even
// when calling through the exported config interface rather than a literal.
export async function legacyConsumer(config: RoutingClientConfig) {
  const client: Readonly<RoutingClient<RoutingPlan>> = createRoutingClient(config);
  const plan: RoutingPlan = client.plan({ version: 1, classification: 'general' });
  const vector: 'pgvector' | 'managed-agent-memory' = plan.vector;
  const response: { routing: RoutingPlan; result: RoutingToolResult } = await client.call('memory_search', {});
  return { vector, response };
}

export function explicitV2Consumer() {
  const client = createRoutingClient({ targets: { seoul: { origin: 'https://seoul.test', spaceId: 'space', protocol: 'memory-routing-v2' } },
    credential: async () => ({ kind: 'pat', token: 'synthetic' }) });
  const plan: RoutingPlan | SeoulPlacement = client.plan({ version: 1, classification: 'medical' });
  if (plan.version === 2) {
    const storage: 'postgres' = plan.storage;
    // @ts-expect-error v2 placement does not claim a vector capability.
    plan.vector;
    return storage;
  }
  // @ts-expect-error Explicit v2 consumers cannot assume a legacy-only client.
  const legacy: Readonly<RoutingClient<RoutingPlan>> = client;
  return legacy;
}

export function defaultLiteralConsumer() {
  const client = createRoutingClient({ targets: { seoul: { origin: 'https://seoul.test', spaceId: 'space' } },
    credential: async () => ({ kind: 'pat', token: 'synthetic' }) });
  const plan: RoutingPlan = client.plan({ version: 1, classification: 'medical' });
  return plan.vector;
}

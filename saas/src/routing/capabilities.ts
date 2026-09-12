import { z } from 'zod';
import { seoulPlacementSchema } from './policy.ts';

export const searchModeSchema = z.enum(['keyword', 'semantic']);
export const seoulRoutingMetadataSchema = z.strictObject({
  version: z.literal(2), protocol: z.literal('memory-routing-v2'),
  target: z.strictObject({
    route: z.literal('seoul'), storage: z.literal('postgres'), region: z.literal('kr-seoul'), ready: z.boolean(),
    capabilities: z.strictObject({ ingest: z.boolean(), search: z.strictObject({
      keyword: z.boolean(),
      // No encoder or generation-attested semantic adapter exists in this
      // protocol. Enabling one requires a separately reviewed wire contract.
      semantic: z.literal(false),
    }) }),
  }).refine(t => t.ready === (t.capabilities.ingest || t.capabilities.search.keyword)),
});
export type SeoulRoutingMetadata = z.infer<typeof seoulRoutingMetadataSchema>;
function reject(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Metadata admission only. A server still verifies deployment, current Space
 * authority and processing permission at use; these declarations grant none. */
export function assertSeoulRoutingCapability(placement: unknown, metadata: unknown, operation: unknown, mode?: unknown): void {
  if (!seoulPlacementSchema.safeParse(placement).success) reject('routing_plan_invalid');
  if (operation === 'memory_search' && mode !== 'keyword') reject('routing_search_mode_unavailable');
  const parsed = seoulRoutingMetadataSchema.safeParse(metadata);
  if (!parsed.success || !parsed.data.target.ready) reject('routing_target_unavailable');
  const capabilities = parsed.data.target.capabilities;
  if (operation === 'memory_search') {
    if (!capabilities.search.keyword) reject('routing_search_mode_unavailable');
  } else if (operation !== 'memory_ingest' || mode !== undefined || !capabilities.ingest) reject('routing_target_unavailable');
}

const encoder = new TextEncoder();
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const excerpt = z.string().refine(value => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  && encoder.encode(value).length <= 32768);
export const seoulKeywordSearchResultSchema = z.strictObject({
  spaceId: identifier, mode: z.literal('keyword'),
  matches: z.array(z.strictObject({ memoryId: identifier,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), excerpt })).max(50),
  count: z.number().int().min(0).max(50),
}).refine(value => value.count === value.matches.length && new Set(value.matches.map(m => m.memoryId)).size === value.count);
export type SeoulKeywordSearchResult = z.infer<typeof seoulKeywordSearchResultSchema>;

/** Validate source references and the executed mode before exposing result text.
 * This verifies the wire contract, not the truth of an upstream source or ACL. */
export function parseSeoulKeywordSearchResult(input: unknown, spaceId: string, limit: number): SeoulKeywordSearchResult {
  const parsed = seoulKeywordSearchResultSchema.safeParse(input);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !parsed.success
    || parsed.data.spaceId !== spaceId || parsed.data.count > limit) reject('routing_response_invalid');
  return parsed.data;
}

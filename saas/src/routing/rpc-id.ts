import { z } from 'zod';
import { digest } from '../release/util.ts';

const utf8 = new TextEncoder();
export const routingRequestIdSchema = z.union([
  z.string().max(128).refine(value => utf8.encode(value).length <= 128),
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
]);
export type RoutingRequestId = z.infer<typeof routingRequestIdSchema>;

/** Wire IDs retain their original type in HTTP/MCP responses. Only the private
 * ledger key is normalized. Reserve both namespaces so a literal string cannot
 * impersonate a numeric or hashed ID; ordinary UUID clients remain unchanged.
 * JSON encoding preserves lone surrogates rather than hashing replacement bytes. */
export async function routingLedgerRequestId(value: RoutingRequestId): Promise<string> {
  if (typeof value === 'number') return 'rpc-number:' + String(value);
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !/^rpc-(?:number|text):/.test(value)) return value;
  return 'rpc-text:' + await digest(JSON.stringify(value));
}

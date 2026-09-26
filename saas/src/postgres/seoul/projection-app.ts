/** Private HTTP composition only. No Worker/configuration/SQL wiring.
 * The trusted store owns transaction completion and supplies stored receipts;
 * this callback interface and a validated response prove no durable COMMIT. */
import { Hono } from 'hono';
import { verifySeoulProjectionRequest } from '../../release/seoul-projection-auth.ts';
import type { SeoulVerifiedProjectionRequest } from '../../release/seoul-projection-auth.ts';
import { decodeSeoulHeadReceipt, verifySeoulHeadReceiptForEvent } from '../../release/seoul-projection-head-receipt-codec.ts';
import { decodeSeoulSnapshotReceipt, verifySeoulSnapshotReceiptForEvent } from '../../release/seoul-projection-snapshot-receipt-codec.ts';

export type SeoulProjectionStoreCommand =
  | Readonly<{ method: 'POST'; eventId: string; transportPayloadSha256: string; payloadText: string }>
  | Readonly<{ method: 'GET'; eventId: string; payloadSha256: string }>;
export type SeoulProjectionAppOptions = {
  enabled: boolean; origin: string; key: CryptoKey;
  store: (command: SeoulProjectionStoreCommand) => Promise<string> | string;
  clock: () => number;
};
const MAX_BYTES = 131072;
const utf8 = new TextEncoder(), strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
class BodyLimit extends Error {}
function failure(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader(), result = new Uint8Array(MAX_BYTES);
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return result.slice(0, size);
      if (next.value.byteLength > MAX_BYTES - size) {
        await reader.cancel().catch(() => undefined);
        throw new BodyLimit();
      }
      result.set(next.value, size); size += next.value.byteLength;
    }
  } finally { reader.releaseLock(); }
}
function storedBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BYTES) throw new Error();
  const bytes = utf8.encode(value);
  // TextEncoder replaces raw lone surrogates. Such malformed adapter output
  // must not become a different, apparently canonical stored receipt.
  if (bytes.length > MAX_BYTES || strictUtf8.decode(bytes) !== value) throw new Error();
  return bytes;
}
function storeFailure(error: unknown, method: 'GET' | 'POST'): Response {
  let code: unknown;
  try { code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined; }
  catch { /* A malformed error supplies no trusted status code. */ }
  if (code === 'PP001') return failure(400, 'seoul_projection_invalid');
  if (code === 'PP002') return failure(409, 'seoul_projection_conflict');
  if (code === 'PP003' && method === 'GET') return failure(404, 'seoul_projection_not_found');
  return failure(503, 'seoul_projection_uncertain');
}

/** Pin a scoped origin in addition to the MAC: its frozen format omits host.
 * The supplied key/store/clock are trusted configuration, never request data.
 * Production callers must authenticate the response channel independently. */
export function createSeoulProjectionApp(options: SeoulProjectionAppOptions): Hono {
  let config: SeoulProjectionAppOptions;
  try {
    const { enabled, origin, key, store, clock } = options;
    const url = new URL(origin);
    if (typeof enabled !== 'boolean' || url.protocol !== 'https:' || origin !== url.origin
      || url.username || url.password || typeof store !== 'function' || typeof clock !== 'function'
      || key.type !== 'secret' || key.algorithm.name !== 'HMAC'
      || (key.algorithm as HmacKeyAlgorithm).hash.name !== 'SHA-256' || !key.usages.includes('verify')) throw new Error();
    config = Object.freeze({ enabled, origin, key, store, clock });
  } catch { throw new Error('seoul_projection_config_invalid'); }
  const app = new Hono();
  app.onError(() => failure(503, 'seoul_projection_uncertain'));
  app.all('*', async context => {
    if (!config.enabled) return failure(404, 'seoul_projection_not_found');
    const request = context.req.raw;
    let verified: SeoulVerifiedProjectionRequest;
    try {
      const encoding = request.headers.get('content-encoding');
      if (new URL(request.url).origin !== config.origin || (encoding !== null && encoding !== 'identity')) throw new Error();
      const body = await readBody(request);
      // These are the bytes consumed above from this exact Request; the
      // verifier owns them again before hashing, then parses only after MAC.
      verified = await verifySeoulProjectionRequest(config.key, request, body, config.clock());
    } catch (error) {
      return error instanceof BodyLimit ? failure(413, 'seoul_projection_request_too_large') : failure(401, 'seoul_projection_auth_denied');
    }
    const command: SeoulProjectionStoreCommand = verified.method === 'GET'
      ? Object.freeze({ method: 'GET', eventId: verified.eventId, payloadSha256: verified.payloadSha256 })
      : Object.freeze({ method: 'POST', eventId: verified.eventId, transportPayloadSha256: verified.transportPayloadSha256,
        payloadText: strictUtf8.decode(verified.rawBody) });
    let stored: unknown;
    try { stored = await config.store(command); }
    catch (error) { return storeFailure(error, command.method); }
    try {
      const bytes = storedBytes(stored);
      if (verified.method === 'POST') {
        if (verified.envelope.kind === 'seoul-authority-head') await verifySeoulHeadReceiptForEvent(bytes, verified.rawBody);
        else await verifySeoulSnapshotReceiptForEvent(bytes, verified.rawBody);
      } else {
        let receipt;
        try { receipt = decodeSeoulHeadReceipt(bytes); }
        catch { receipt = decodeSeoulSnapshotReceipt(bytes); }
        if (receipt.eventId !== verified.eventId || receipt.transportPayloadSha256 !== verified.payloadSha256) throw new Error();
      }
      // Exact stored bytes, including historical decision time. A canonical
      // conflict/pending result is still 200; it is not a transport error.
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    } catch { return failure(503, 'seoul_projection_uncertain'); }
  });
  return app;
}

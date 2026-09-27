/** Inert v1 HMAC boundary for v3 projection bytes. No key store, server,
 * network access, database, regional authority application or readiness gate. */
import { decodeSeoulHeadEvent } from './seoul-projection-head-codec.ts';
import type { SeoulHeadEvent } from './seoul-projection-head-codec.ts';
import { decodeSeoulAuthoritySnapshot } from './seoul-projection-snapshot-codec.ts';
import type { SeoulAuthoritySnapshot } from './seoul-projection-snapshot-codec.ts';

const BASE_PATH = '/internal/v1/seoul/projections';
const MAX_BYTES = 128 * 1024;
const utf8 = new TextEncoder();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBrand = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
type Envelope = SeoulHeadEvent | SeoulAuthoritySnapshot;
export type SeoulVerifiedProjectionRequest =
  | { method: 'POST'; eventId: string; transportPayloadSha256: string; envelope: Envelope; rawBody: Uint8Array }
  | { method: 'GET'; eventId: string; payloadSha256: string };
type Route =
  | { method: 'POST'; pathname: string; query: '' }
  | { method: 'GET'; pathname: string; query: string; eventId: string; payloadSha256: string };

function invalid(): never { throw new Error(); }
function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  // Actual internal brand supports Buffer/subclasses/cross-realm byte arrays;
  // spoofed wider arrays, DataViews and proxies never reach numerical copying.
  if (typedArrayBrand.call(value) !== 'Uint8Array') invalid();
  const length = byteLength.call(value) as number;
  if (length > MAX_BYTES) invalid();
  const copy = new Uint8Array(length);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function route(method: unknown, value: unknown): Route {
  if ((method !== 'POST' && method !== 'GET') || typeof value !== 'string'
    || /[\u0000-\u0020\u007f\\#]/u.test(value)) invalid();
  const absolute = /^https:\/\/([^/?#]+)(.*)$/i.exec(value);
  if (!absolute || absolute[1]!.includes('@')) invalid();
  const url = new URL(value), rawPathQuery = absolute[2]!;
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || rawPathQuery.includes('%') || rawPathQuery !== url.pathname + url.search) invalid();
  if (method === 'POST') {
    if (url.pathname !== BASE_PATH || url.search !== '') invalid();
    return { method, pathname: BASE_PATH, query: '' };
  }
  const prefix = BASE_PATH + '/';
  if (!url.pathname.startsWith(prefix)) invalid();
  const eventId = uuid(url.pathname.slice(prefix.length));
  const query = url.search.slice(1), expectedPrefix = 'payloadSha256=';
  if (!query.startsWith(expectedPrefix)) invalid();
  const payloadSha256 = digest(query.slice(expectedPrefix.length));
  return { method, pathname: url.pathname, query, eventId, payloadSha256 };
}
function keyFor(key: CryptoKey, operation: 'sign' | 'verify'): void {
  const algorithm = key.algorithm as HmacKeyAlgorithm;
  if (key.type !== 'secret' || algorithm.name !== 'HMAC' || algorithm.hash.name !== 'SHA-256' || !key.usages.includes(operation)) invalid();
  // Web Crypto also validates the actual CryptoKey brand and operation below.
}
function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}
function unhex(value: string): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index++) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}
async function checksum(value: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}
function equalChecksum(actual: Uint8Array, expected: Uint8Array): boolean {
  // Both arrays have the validated SHA-256 length. Accumulate every byte;
  // no stronger JavaScript engine timing guarantee is asserted here.
  let difference = 0;
  for (let index = 0; index < 32; index++) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}
function signingBytes(target: Route, time: number, hash: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = utf8.encode('memory-seoul-projection-v1\n' + target.method + '\n' + target.pathname + '\n'
    + target.query + '\n' + time + '\n' + hash + '\n');
  const result = new Uint8Array(prefix.length + body.length);
  result.set(prefix); result.set(body, prefix.length);
  return result;
}
function envelope(body: Uint8Array): Envelope {
  try { return decodeSeoulHeadEvent(body); }
  catch { return decodeSeoulAuthoritySnapshot(body); }
}

/** The supplied key is a trusted scoped configuration input, never sourced by
 * this module. The frozen MAC omits origin: isolate endpoints in trusted Worker
 * or service-binding configuration. Returned headers do not send a request. */
export async function signSeoulProjectionRequest(key: CryptoKey, input: {
  method: 'POST' | 'GET'; url: string; body: Uint8Array; timestampMs: number;
}): Promise<Headers> {
  try {
    const target = route(input.method, input.url), body = bytes(input.body), time = timestamp(input.timestampMs);
    keyFor(key, 'sign');
    if (target.method === 'GET' ? body.length !== 0 : body.length === 0) invalid();
    const eventId = target.method === 'GET' ? target.eventId : envelope(body).eventId;
    const hash = hex(await checksum(body));
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, signingBytes(target, time, hash, body)));
    return new Headers({
      ...(target.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      'x-memory-projection-event-id': eventId,
      'x-memory-projection-timestamp': String(time),
      'x-memory-projection-content-sha256': hash,
      'x-memory-projection-signature': 'v1=' + hex(signature),
    });
  } catch { throw new Error('seoul_projection_signing_invalid'); }
}

/** Composition MUST supply exactly the bounded bytes read from this same HTTP
 * request. This function never consumes Request.body or proves that association.
 * Route/header checks use the normalized values retained by Request/Headers;
 * original syntax discarded by those APIs cannot be reconstructed here.
 * A result proves transport verification only, never authority or readiness. */
export async function verifySeoulProjectionRequest(key: CryptoKey, request: Request,
  rawBody: Uint8Array, nowMs: number): Promise<SeoulVerifiedProjectionRequest> {
  try {
    const target = route(request.method, request.url), body = bytes(rawBody), now = timestamp(nowMs);
    keyFor(key, 'verify');
    if (target.method === 'GET' ? body.length !== 0 : body.length === 0) invalid();
    if (target.method === 'POST' && request.headers.get('content-type') !== 'application/json') invalid();
    const eventId = uuid(request.headers.get('x-memory-projection-event-id'));
    const rawTime = request.headers.get('x-memory-projection-timestamp');
    if (rawTime === null || rawTime.length > 16 || !/^(0|[1-9][0-9]*)$/.test(rawTime)) invalid();
    const time = timestamp(Number(rawTime));
    if (Math.abs(now - time) > 300000) invalid();
    const hash = digest(request.headers.get('x-memory-projection-content-sha256'));
    const signature = request.headers.get('x-memory-projection-signature');
    if (signature === null || signature.length !== 67 || !/^v1=[a-f0-9]{64}$/.test(signature)) invalid();
    if (target.method === 'GET' && eventId !== target.eventId) invalid();
    if (!equalChecksum(await checksum(body), unhex(hash))) invalid();
    if (!await crypto.subtle.verify('HMAC', key, unhex(signature.slice(3)), signingBytes(target, time, hash, body))) invalid();
    if (target.method === 'GET') return { method: 'GET', eventId, payloadSha256: target.payloadSha256 };
    // Parse only authenticated bytes, then bind the separately supplied header
    // ID to the envelope ID protected by the MAC over the exact body bytes.
    const verifiedEnvelope = envelope(body);
    if (verifiedEnvelope.eventId !== eventId) invalid();
    return { method: 'POST', eventId, transportPayloadSha256: hash, envelope: verifiedEnvelope, rawBody: body };
  } catch { throw new Error('seoul_projection_auth_denied'); }
}

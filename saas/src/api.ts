import { IdentityDenied } from './identity.ts';
import type { IdentityDatabase } from './identity.ts';
import { MemoryService, MemoryDenied, MemoryInvalid, MemoryConflict } from './memory.ts';

const MAX_REQUEST_BYTES = 24 * 1024;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly allow?: string;
  constructor(status: number, code: string, allow?: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.allow = allow;
  }
}

/** Call only after matching a known route, before interpreting its payload. */
export function requireMethod(request: Request, ...allowed: string[]): true {
  if (!allowed.includes(request.method)) throw new HttpError(405, 'method_not_allowed', allowed.join(', '));
  return true;
}

/** Decode one captured URL segment, never the entire route or a JSON identifier. */
export function pathIdentifier(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new HttpError(400, 'invalid_identifier'); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(decoded)) throw new HttpError(400, 'invalid_identifier');
  return decoded;
}

export function json(value: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (status === 401) headers.set('www-authenticate', 'Bearer');
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
}

export async function body(request: Request, keys: string[]): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
  if (!request.body) throw new MemoryInvalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 10000);
  try {
    while (true) {
      const next = await reader.read();
      if (timedOut) throw new HttpError(408, 'read_timeout');
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        throw new HttpError(413, 'request_too_large');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    // Cancelling an incoming workerd body rejects its pending read.
    if (timedOut) throw new HttpError(408, 'read_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
    // A client stream's cancellation callback must not delay the HTTP error.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new MemoryInvalid();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MemoryInvalid();
  if (Object.keys(value).some(key => !keys.includes(key))) throw new MemoryInvalid();
  return value as Record<string, unknown>;
}

export function textField(value: unknown): string {
  if (typeof value !== 'string') throw new MemoryInvalid();
  return value;
}
export function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : textField(value);
}
function sourceField(value: unknown): string | null | undefined {
  return value === null ? null : optionalText(value);
}
function revisionField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new MemoryInvalid();
  return value;
}

/** Transport for the isolated Standard core. It does not issue credentials. */
export function createMemoryApi(db: IdentityDatabase, clock: () => number = Date.now): (request: Request) => Promise<Response> {
  const memory = new MemoryService(db, clock);
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health' && requireMethod(request, 'GET')) return json({ status: 'ok', mode: 'managed', stage: 'foundation' });
      const route = /^\/v1\/spaces(?:\/([^/]+)\/memories(?:\/([^/]+))?)?$/.exec(url.pathname);
      if (!route) throw new HttpError(404, 'not_found');
      const match = /^Bearer ([^\s,]+)$/i.exec(request.headers.get('authorization') ?? '');
      if (!match?.[1]) throw new HttpError(401, 'authentication_required');
      const token = match[1];
      const spaceId = route[1] === undefined ? undefined : pathIdentifier(route[1]);
      const memoryId = route[2] === undefined ? undefined : pathIdentifier(route[2]);
      if (!spaceId) {
        requireMethod(request, 'POST');
        const value = await body(request, ['name', 'organizationId', 'securityMode']);
        return json(await memory.createSpace(token, {
          name: textField(value.name),
          organizationId: optionalText(value.organizationId),
          securityMode: optionalText(value.securityMode),
        }), 201);
      }
      if (!memoryId) {
        requireMethod(request, 'GET', 'POST');
        if (request.method === 'POST') {
          const value = await body(request, ['body', 'source']);
          return json(await memory.create(token, spaceId, { body: textField(value.body), source: sourceField(value.source) }), 201);
        }
        if (request.method === 'GET') {
          if ([...url.searchParams.keys()].some(key => !['query', 'limit', 'cursor'].includes(key))) throw new MemoryInvalid();
          if (['query', 'limit', 'cursor'].some(key => url.searchParams.getAll(key).length > 1)) throw new MemoryInvalid();
          const limitText = url.searchParams.get('limit');
          if (limitText !== null && !/^[1-9][0-9]?$/.test(limitText)) throw new MemoryInvalid();
          if (!url.searchParams.has('query')) return json(await memory.list(token, spaceId, {
            limit: limitText === null ? undefined : Number(limitText),
            cursor: url.searchParams.get('cursor') ?? undefined,
          }));
          if (url.searchParams.has('cursor')) throw new MemoryInvalid();
          return json({ results: await memory.search(token, spaceId, {
            query: url.searchParams.get('query') ?? '',
            limit: limitText === null ? undefined : Number(limitText),
          }) });
        }
      } else {
        requireMethod(request, 'GET', 'PATCH', 'DELETE');
        if (request.method === 'GET') return json(await memory.get(token, spaceId, memoryId));
        if (request.method === 'PATCH') {
          const value = await body(request, ['body', 'source', 'expectedRevision']);
          return json(await memory.update(token, spaceId, memoryId, {
            body: textField(value.body), source: sourceField(value.source), expectedRevision: revisionField(value.expectedRevision),
          }));
        }
        if (request.method === 'DELETE') {
          const value = await body(request, ['expectedRevision']);
          await memory.remove(token, spaceId, memoryId, revisionField(value.expectedRevision));
          return json(null, 204);
        }
      }
      throw new HttpError(404, 'not_found');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status, error.allow ? { allow: error.allow } : {});
      if (error instanceof MemoryInvalid) return json({ error: 'invalid_request' }, 400);
      if (error instanceof IdentityDenied || error instanceof MemoryDenied) return json({ error: 'access_denied' }, 403);
      if (error instanceof MemoryConflict) return json({ error: 'revision_conflict' }, 409);
      // Never log/reflect database errors, request text, tokens or memory bodies.
      return json({ error: 'internal_error' }, 500);
    }
  };
}

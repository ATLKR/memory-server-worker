import type { Capability, Database, Statement, Value } from './types.ts';
export class ReleaseError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export function fail(status: number, code: string): never { throw new ReleaseError(status, code); }
export const enc = new TextEncoder();
export const DAY = 86400000;
export function json(value: unknown, status = 200, extra: HeadersInit = {}): Response {
    return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...Object.fromEntries(new Headers(extra)) } });
}
export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(400, 'invalid_object');
    return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, allowed: string[]): void {
    if (Object.keys(value).some(k => !allowed.includes(k)))
        fail(400, 'unknown_field');
}
export function str(value: unknown, max = 256, empty = false): string {
    if (typeof value !== 'string' || value.includes('\0') || (!empty && !value.trim()) || enc.encode(value).length > max)
        fail(400, 'invalid_string');
    return value as string;
}
export function id(value: unknown): string {
    const s = str(value, 256);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s))
        fail(400, 'invalid_identifier');
    return s;
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
        fail(400, 'invalid_integer');
    return value as number;
}
export function canonical(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    const o = object(value);
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}
export async function digest(value: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)));
    return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}
export async function tokenHash(value: string): Promise<string> { str(value, 8192); if (value.length < 32 || /\s/.test(value))
    fail(401, 'authentication_required'); return digest(value); }
export function randomToken(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export function unbase64url(text: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]*$/.test(text))
        fail(400, 'invalid_encoding');
    try {
        return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    }
    catch {
        return fail(400, 'invalid_encoding');
    }
}
export function encodeCursor(resource: string, keys: (string | number)[]): string { return base64url(enc.encode(JSON.stringify([1, resource, ...keys]))); }
export function decodeCursor(cursor: unknown, resource: string): unknown[] {
    str(cursor, 2048);
    try {
        const a: unknown = JSON.parse(new TextDecoder().decode(unbase64url(cursor as string)));
        if (!Array.isArray(a) || a[0] !== 1 || a[1] !== resource)
            fail(400, 'invalid_cursor');
        return a.slice(2);
    }
    catch {
        return fail(400, 'invalid_cursor');
    }
}
export function capabilitiesFromScopes(scopes: string[]): Capability[] {
    const out: Capability[] = [];
    if (scopes.includes('memory:read'))
        out.push('read');
    if (scopes.includes('memory:create') || scopes.includes('memory:write'))
        out.push('create');
    if (scopes.includes('memory:update') || scopes.includes('memory:write'))
        out.push('update');
    if (scopes.includes('memory:delete'))
        out.push('delete');
    if (scopes.includes('memory:export'))
        out.push('export');
    return out;
}
export function capabilities(value: unknown): Capability[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 5 || value.some(v => !['read', 'create', 'update', 'delete', 'export'].includes(v)))
        fail(400, 'invalid_capabilities');
    return [...new Set(value)] as Capability[];
}
export function month(at: number): string { return new Date(at).toISOString().slice(0, 7); }
export function stmt(db: Database, sql: string, values: Value[] = []): Statement { return db.prepare(sql).bind(...values); }
export async function rows<T>(db: Database, sql: string, values: Value[] = []): Promise<T[]> {
    const result = await db.withSession('first-primary').prepare(sql).bind(...values).all<T>();
    if (!result.success)
        fail(503, 'database_unavailable');
    return result.results;
}
export async function one<T>(db: Database, sql: string, values: Value[] = []): Promise<T | null> { return db.withSession('first-primary').prepare(sql).bind(...values).first<T>(); }
export async function batch(db: Database, statements: Statement[]): Promise<void> {
    try {
        const result = await db.batch(statements);
        if (result.some(r => !r.success))
            fail(503, 'database_unavailable');
    }
    catch (e) {
        if (e instanceof ReleaseError)
            throw e;
        const m = e instanceof Error ? e.message : '';
        if (m.includes('release_quota'))
            fail(429, 'quota_exceeded');
        if (m.includes('release_storage'))
            fail(413, 'storage_quota_exceeded');
        if (m.includes('release_conflict'))
            fail(409, 'revision_conflict');
        if (m.includes('release_denied'))
            fail(403, 'access_denied');
        throw e;
    }
}
/** Bound both streamed bytes and time, including responses without Content-Length. */
export async function readBytes(response: Response | Request, maximum = 65536): Promise<Uint8Array> {
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > maximum))
        fail(413, 'payload_too_large');
    if (!response.body)
        return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => { }); }, 10000);
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (timedOut)
                fail(408, 'read_timeout');
            if (done)
                break;
            count += value.length;
            if (count > maximum)
                fail(413, 'payload_too_large');
            chunks.push(value);
        }
        const out = new Uint8Array(count);
        let offset = 0;
        for (const c of chunks) {
            out.set(c, offset);
            offset += c.length;
        }
        return out;
    }
    finally {
        clearTimeout(timer);
        void reader.cancel().catch(() => { });
    }
}
export async function body(request: Request, allowed?: string[], max = 65536, mediaTypes: readonly string[] = ['application/json']): Promise<Record<string, unknown>> {
    if (!mediaTypes.includes(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''))
        fail(415, 'json_required');
    let out: Record<string, unknown>;
    try {
        out = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(request, max))));
    }
    catch (e) {
        if (e instanceof ReleaseError)
            throw e;
        return fail(400, 'invalid_json');
    }
    if (allowed)
        exact(out, allowed);
    return out;
}
export async function remoteJson(fetcher: typeof fetch, url: string, init: RequestInit = {}, max = 65536): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        // workerd rejects redirect:'error' before sending. Manual preserves
        // the no-redirect policy: response.ok below rejects every 3xx.
        const response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('json'))
            fail(502, 'provider_unavailable');
        return object(JSON.parse(new TextDecoder().decode(await readBytes(response, max))));
    }
    finally {
        clearTimeout(timer);
    }
}
export async function hmac(secret: string, value: string): Promise<string> {
    if (enc.encode(secret).length < 32)
        fail(503, 'webhook_not_configured');
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export function equal(a: string, b: string): boolean { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++)
    d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }
export async function encrypt(secret: string, value: unknown, aad: string): Promise<string> {
    const bytes = unbase64url(secret);
    if (bytes.length !== 32)
        fail(503, 'payload_key_invalid');
    const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(canonical(value))));
    return base64url(iv) + '.' + base64url(ciphertext);
}
export async function decrypt(secret: string, value: string, aad: string): Promise<unknown> {
    const [iv, data, ...rest] = value.split('.');
    if (!iv || !data || rest.length)
        fail(500, 'invalid_ciphertext');
    const bytes = unbase64url(secret);
    if (bytes.length !== 32)
        fail(503, 'payload_key_invalid');
    const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(iv), additionalData: enc.encode(aad) }, key, unbase64url(data));
    return JSON.parse(new TextDecoder().decode(plain));
}

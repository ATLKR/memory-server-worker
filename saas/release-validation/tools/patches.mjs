import { createHash } from 'node:crypto';
export const BASE = 'b94c434f2074ea975111cb4e3efd4371a9481ac1';
export const HASHES = {
    'saas/src/app.ts': 'efd4c8953ac964321cb6795d01c1c9cc702d2da4',
    'saas/src/worker.ts': '150d5e3ab329a12b05646d573dd0cdb0fccefdfb',
    'saas/src/config.ts': '01db234351c2e2c0e9328d231cc446a3f8579024',
    'saas/scripts/migrations.mjs': '8fe77d11ee1261876263c2f6f52aa5ef0a6bb706',
    'saas/wrangler.jsonc': '5f214ba7e7643f21627e25389830a92adf764805'
};
export function verifyBlob(value, expected) { const data = Buffer.isBuffer(value) ? value : Buffer.from(value); const actual = createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex'); if (actual !== expected)
    throw Error('Baseline blob mismatch: expected ' + expected + ', got ' + actual); }
export function once(source, from, to) { const first = source.indexOf(from); if (first < 0 || source.indexOf(from, first + from.length) >= 0)
    throw Error('Patch anchor absent or ambiguous: ' + from.slice(0, 100)); return source.slice(0, first) + to + source.slice(first + from.length); }
export function patchApp(source) {
    source = once(source, 'export interface ApplicationOptions {', 'export interface ApplicationOptions {\n  release?: import(\'./release/types.ts\').Extension;');
    source = once(source, '(p, token) => workspace.signIn(p, token)', `async (p, token) => {
    const session = await workspace.signIn(p, token);
    await options.release?.signedIn(p, session, token !== undefined);
    return session;
  }`);
    const origin = "    if (request.headers.has('origin') && request.headers.get('origin') !== settings.origin) throw new HttpError(403, 'origin_denied');";
    source = once(source, origin, origin + `\n    const publicResponse = await options.release?.publicRoute(request);
    if (publicResponse) return publicResponse;`);
    const limit = "    if (options.limit && !(await options.limit(`account:${credential.accountId}`)).success) throw new HttpError(429, 'rate_limited');";
    source = once(source, limit, limit + `\n    const releaseResponse = await options.release?.route(request, token);
    if (releaseResponse) return releaseResponse;`);
    source = once(source, 'new Response(renderPage(settings.brand),', `new Response(options.release ? renderPage(settings.brand).replace(/<body([^>]*)>/, '<body$1><p><a href="/manage">Memory 서비스 관리</a></p>') : renderPage(settings.brand),`);
    return source;
}
export function patchMigrations(source) { return once(source, "'auth-schema.sql', 'hierarchy-schema.sql'", "'auth-schema.sql', 'hierarchy-schema.sql', 'release-schema.sql'"); }
export function patchConfig(source) { return once(source, "SERVICE_VERSION = '0.3.0'", "SERVICE_VERSION = '0.4.0-rc.1'"); }
export function patchWrangler(source) { source = once(source, '"limits": { "cpu_ms": 50 }', '"limits": { "cpu_ms": 1000 },\n  "triggers": { "crons": ["* * * * *"] }'); return once(source, '"vars": {', '"vars": {\n    "RELEASE_MODE": "pilot",\n    "LIVE_ACCEPTANCE_ID": "",'); }

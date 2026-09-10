import type { IdentityDatabase } from './identity.ts';
import { digestToken, IdentityDenied, IdentityInvalid } from './identity.ts';
import { createMemoryApi, body, json, HttpError, textField, optionalText, pathIdentifier, requireMethod } from './api.ts';
import { MemoryService, MemoryInvalid, MemoryDenied, MemoryConflict } from './memory.ts';
import { WorkspaceService, WorkspaceError } from './workspace.ts';
import { createAuthController, SESSION_COOKIE } from './auth.ts';
import type { AuthOptions } from './auth.ts';
import type { Settings } from './config.ts';
import { SERVICE_VERSION } from './config.ts';
import { appScript, renderPage, renderStyles } from './ui.ts';
import { handleMcp } from './mcp.ts';

export interface ApplicationOptions {
  release?: import('./release/types.ts').Extension;
  clock?: () => number;
  auth?: AuthOptions;
  limit?: (key: string) => Promise<{ success: boolean }>;
}
function cookieToken(request: Request): string | null {
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(x => x.trim())
    .filter(x => x.startsWith(`${SESSION_COOKIE}=`));
  if (cookies.length !== 1) return null;
  const token = cookies[0]!.slice(SESSION_COOKIE.length + 1);
  return /^[a-zA-Z0-9_-]{32,256}$/.test(token) ? token : null;
}
function permission(value: unknown): 'read' | 'write' {
  if (value !== 'read' && value !== 'write') throw new MemoryInvalid();
  return value;
}
function role(value: unknown): 'member' | 'admin' {
  if (value !== 'member' && value !== 'admin') throw new MemoryInvalid();
  return value;
}
function protect(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.set('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'no-referrer');
  out.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  out.headers.set('strict-transport-security', 'max-age=31536000');
  out.headers.set('cache-control', 'no-store');
  out.headers.set('x-request-id', crypto.randomUUID());
  return out;
}

export function createApplication(db: IdentityDatabase, settings: Settings, options: ApplicationOptions = {}) {
  const clock = options.clock ?? Date.now;
  const workspace = new WorkspaceService(db, clock, { identityLifecycle: options.release?.identityLifecycle === 2 });
  const memory = new MemoryService(db, clock);
  const memoryApi = createMemoryApi(db, clock);
  const auth = createAuthController(db, settings.auth, async (p, token) => {
    await options.release?.beforeSignIn?.(p);
    const session = await workspace.signIn(p, token);
    await options.release?.signedIn(p, session, token !== undefined);
    return session;
  }, { ...options.auth, clock });
  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== settings.origin) throw new HttpError(421, 'invalid_host');
    if (request.headers.has('origin') && request.headers.get('origin') !== settings.origin) throw new HttpError(403, 'origin_denied');
    const publicResponse = await options.release?.publicRoute(request);
    if (publicResponse) return publicResponse;
    if (['/', '/assets/app.js', '/assets/app.css', '/health', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) requireMethod(request, 'GET');
    if (request.method === 'GET') {
      if (url.pathname === '/') return new Response(options.release ? renderPage(settings.brand, true, settings.origin).replace(/<body([^>]*)>/, '<body$1><p><a href="/manage">서비스 관리</a></p>') : renderPage(settings.brand, false, settings.origin), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (url.pathname === '/assets/app.js') return new Response(appScript, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
      if (url.pathname === '/assets/app.css') return new Response(renderStyles(settings.brand), { headers: { 'content-type': 'text/css; charset=utf-8' } });
      if (url.pathname === '/health') return json({ status: 'ok', version: SERVICE_VERSION, mode: 'managed' });
      if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') return json({
        resource: settings.origin, resource_name: settings.brand.name,
        authorization_servers: [settings.auth.issuer],
        scopes_supported: ['memory:read', 'memory:write', 'memory:delete'], bearer_methods_supported: ['header'],
      });
    }
    if (url.pathname.startsWith('/auth/')) {
      if (options.limit && !await options.limit(`auth:${request.headers.get('cf-connecting-ip') ?? 'local'}`).then(r => r.success)) throw new HttpError(429, 'rate_limited');
      const expectedAccount = request.headers.get('x-memory-account-id');
      if (url.pathname === '/auth/logout' && expectedAccount !== null) {
        const token = cookieToken(request);
        const credential = token ? await db.withSession('first-primary').prepare(
          "SELECT account_id AS accountId FROM credentials WHERE token_digest=? AND kind='session' AND membership_id IS NULL"
        ).bind(await digestToken(token)).first<{ accountId: string }>() : null;
        if (credential && credential.accountId !== expectedAccount) throw new HttpError(409, 'account_mismatch');
      }
      const response = await auth.handle(request);
      if (response) return response;
      throw new HttpError(404, 'not_found');
    }
    if (!url.pathname.startsWith('/v1/') && url.pathname !== '/mcp') throw new HttpError(404, 'not_found');
    // Protect signature verification/JWKS fetching before trusting a bearer.
    if (options.limit && !(await options.limit(`preauth:${request.headers.get('cf-connecting-ip') ?? 'local'}`)).success) throw new HttpError(429, 'rate_limited');
    const authorization = request.headers.get('authorization');
    const bearer = authorization === null ? null : /^Bearer ([^\s,]+)$/i.exec(authorization)?.[1];
    if (authorization !== null && !bearer) throw new HttpError(401, 'authentication_required');
    let token = bearer ?? (url.pathname === '/mcp' ? null : cookieToken(request));
    if (!token) throw new HttpError(401, 'authentication_required');
    // Cookie credentials are browser sessions only. Agent OAuth grants expose memory data, not account administration.
    const external = Boolean(bearer?.includes('.'));
    if (external) {
      if (url.pathname !== '/mcp' && !url.pathname.startsWith('/v1/spaces')) throw new HttpError(403, 'scope_denied');
      try { token = await auth.resolveBearer(token); } catch { throw new HttpError(401, 'invalid_token'); }
    }
    if (!bearer && !['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== settings.origin) throw new HttpError(403, 'origin_required');
    let hash: string;
    try { hash = await digestToken(token); } catch { throw new HttpError(401, 'authentication_required'); }
    const at = clock();
    const credential = await db.withSession('first-primary').prepare(`
      SELECT account_id AS accountId,kind,min(expires_at,membership_expires_at) AS expiresAt FROM active_credentials
      WHERE token_digest=? AND expires_at>? AND membership_expires_at>?`)
      .bind(hash, at, at).first<{ accountId: string; kind: string; expiresAt: number }>();
    if (!credential || credential.expiresAt <= clock() || (!bearer && credential.kind !== 'session')) throw new HttpError(401, external ? 'invalid_token' : 'authentication_required');
    // Bind browser intent to the credential used by this exact request. A
    // separate workspace preflight cannot prevent another tab replacing cookies.
    const expectedAccount = request.headers.get('x-memory-account-id');
    if (expectedAccount !== null && expectedAccount !== credential.accountId) throw new HttpError(409, 'account_mismatch');
    if (options.limit && !(await options.limit(`account:${credential.accountId}`)).success) throw new HttpError(429, 'rate_limited');
    if (credential.expiresAt <= clock()) throw new HttpError(401, external ? 'invalid_token' : 'authentication_required');
    const releaseResponse = await options.release?.route(request, token);
    if (releaseResponse) return releaseResponse;
    if (url.pathname === '/mcp') return handleMcp(request, memory, token, settings.brand.name, db, clock);
    if (url.pathname.startsWith('/v1/spaces')) {
      if (url.pathname === '/v1/spaces') requireMethod(request, 'GET', 'POST');
      if (url.pathname === '/v1/spaces' && request.method === 'GET') return json({ results: await memory.listSpaces(token) });
      const headers = new Headers(request.headers); headers.set('authorization', `Bearer ${token}`); headers.delete('cookie');
      return memoryApi(new Request(request, { headers }));
    }
    if (url.pathname === '/v1/workspace' && requireMethod(request, 'GET')) return json(await workspace.snapshot(token, options.release?.workspaceSpaceAccess));
    if (url.pathname === '/v1/organizations' && requireMethod(request, 'POST')) {
      const input = await body(request, ['name', 'emailId', 'parentOrganizationId']);
      return json(await workspace.createOrganization(token, {
        name: textField(input.name), emailId: textField(input.emailId),
        parentOrganizationId: optionalText(input.parentOrganizationId),
      }), 201);
    }
    const invite = /^\/v1\/organizations\/([^/]+)\/invites$/.exec(url.pathname);
    if (invite && requireMethod(request, 'POST')) {
      const input = await body(request, ['email', 'role']);
      return json(await workspace.createInvite(token, pathIdentifier(invite[1]!), { email: textField(input.email), role: role(input.role) }), 201);
    }
    const members = /^\/v1\/organizations\/([^/]+)\/members$/.exec(url.pathname);
    if (members && requireMethod(request, 'GET')) return json({ results: await workspace.listMembers(token, pathIdentifier(members[1]!)) });
    if (url.pathname === '/v1/invitations/accept' && requireMethod(request, 'POST')) {
      const input = await body(request, ['token']);
      return json(await workspace.acceptInvite(token, textField(input.token)));
    }
    const membership = /^\/v1\/organizations\/([^/]+)\/memberships\/([^/]+)$/.exec(url.pathname);
    if (membership && requireMethod(request, 'DELETE')) {
      await workspace.revokeMembership(token, pathIdentifier(membership[1]!), pathIdentifier(membership[2]!)); return json(null, 204);
    }
    if (url.pathname === '/v1/keys' && requireMethod(request, 'POST')) {
      const input = await body(request, ['label', 'organizationId', 'permission', 'expiresInDays']);
      if (typeof input.expiresInDays !== 'number') throw new MemoryInvalid();
      return json(await workspace.issueKey(token, { label: textField(input.label), organizationId: optionalText(input.organizationId), permission: permission(input.permission), expiresInDays: input.expiresInDays }), 201);
    }
    const key = /^\/v1\/keys\/([^/]+)$/.exec(url.pathname);
    if (key && requireMethod(request, 'DELETE')) { await workspace.revokeKey(token, pathIdentifier(key[1]!)); return json(null, 204); }
    throw new HttpError(404, 'not_found');
  }
  return async (request: Request): Promise<Response> => {
    let response: Response, invalidToken = false;
    try { response = await route(request); }
    catch (error) {
      const status = error instanceof HttpError || error instanceof WorkspaceError || error instanceof IdentityInvalid ? error.status :
        error instanceof MemoryInvalid ? 400 : error instanceof MemoryDenied || error instanceof IdentityDenied ? 403 : error instanceof MemoryConflict ? 409 : 500;
      const code = error instanceof HttpError || error instanceof WorkspaceError || error instanceof IdentityInvalid ? error.code : status === 400 ? 'invalid_request' : status === 403 ? 'access_denied' : status === 409 ? 'revision_conflict' : 'internal_error';
      invalidToken = status === 401 && code === 'invalid_token';
      response = json({ error: code }, status, error instanceof HttpError && error.allow ? { allow: error.allow } : {});
    }
    if (response.status === 401 && !response.headers.get('www-authenticate')?.includes('resource_metadata=')) response.headers.set('www-authenticate', new URL(request.url).pathname.startsWith('/scim/')
      ? 'Bearer realm="scim"'
      : `Bearer ${invalidToken ? 'error="invalid_token", ' : ''}resource_metadata="${settings.origin}/.well-known/oauth-protected-resource", scope="memory:read"`);
    if (response.status === 429) response.headers.set('retry-after', '60');
    return protect(response);
  };
}

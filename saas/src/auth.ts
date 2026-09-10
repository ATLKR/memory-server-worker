import { sqlNow } from './sql-clock.ts';
/** Central OAuth access-token authentication; the provider does not issue ID tokens. */
import { createRemoteJWKSet, customFetch, jwksCache, jwtVerify, type JWTVerifyGetKey, type JWKSCacheInput } from 'jose';
import { digestToken, IdentityDenied, type IdentityDatabase } from './identity.ts';

export const FLOW_COOKIE = '__Host-memory_flow';
export const SESSION_COOKIE = '__Host-memory_session';
const FLOW_TTL = 600_000;
const TOKEN_TTL = 900;
const REQUEST_TIMEOUT = 8_000;
const SCOPES = 'openid profile email memory:read memory:write memory:delete';
class AuthUpstreamFailure extends IdentityDenied {
  readonly status: number;
  constructor(status: number) { super(); this.status = status; }
}
type AuthProgress = { phase: 'login' | 'callback_validation' | 'flow_claim' | 'token_exchange' | 'token_response' | 'token_verification' | 'workspace_sign_in' };

export interface AuthSettings {
  origin: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
}
export interface AuthPrincipal {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  expiresAt: number;
  permission: 'read' | 'write';
}
export type WorkspaceSignIn = (principal: AuthPrincipal, externalToken?: string) =>
  Promise<{ token: string; accountId: string; expiresAt: number }>;
export interface AuthOptions {
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  jwks?: JWTVerifyGetKey;
  /** Trusted public-key data for this JWKS URL only; no request promises or credentials. */
  publicKeyCache?: JWKSCacheInput;
}
export type { JWKSCacheInput as PublicKeyCache } from 'jose';

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
function readCookie(request: Request, name: string): string | null {
  const matches = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{32,256}$/.test(value) ? value : null;
}
function response(status: number, message: string, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(message, { status, headers });
}
function configured(settings: AuthSettings): boolean {
  try {
    const origin = new URL(settings.origin);
    const issuer = new URL(settings.issuer);
    if (origin.protocol !== 'https:' || origin.origin !== settings.origin ||
        issuer.protocol !== 'https:' || issuer.href.replace(/\/$/, '') !== settings.issuer ||
        issuer.username || issuer.password || issuer.search || issuer.hash ||
        typeof settings.clientId !== 'string' || !settings.clientId.trim() ||
        settings.clientId.length > 256 || /\s/.test(settings.clientId)) return false;
    return [settings.authorizationEndpoint, settings.tokenEndpoint, settings.jwksUri].every(value => {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === issuer.origin && !url.username && !url.password && !url.hash;
    });
  } catch { return false; }
}

/** Bound network time AND bytes; redirects never carry a token exchange elsewhere. */
async function boundedFetch(fetchFn: typeof fetch, url: string, init: RequestInit, maximum: number): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new IdentityDenied()); }, REQUEST_TIMEOUT);
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    return await Promise.race([timeout, (async () => {
      // workerd supports manual/follow only. Keep 3xx responses here and reject
      // them below, before a code, verifier or key request can follow Location.
      const res = await fetchFn(url, { ...init, redirect: 'manual', signal: controller.signal });
      if (res.status !== 200) throw new AuthUpstreamFailure(res.status);
      if (res.redirected || (res.url && res.url !== url) ||
          !res.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new IdentityDenied();
      const length = res.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new IdentityDenied();
      if (!res.body) throw new IdentityDenied();
      reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximum) throw new IdentityDenied();
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } });
    })()]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

export function createAuthController(
  db: IdentityDatabase, settings: AuthSettings, workspaceSignIn: WorkspaceSignIn, options: AuthOptions = {},
): { handle(request: Request): Promise<Response | null>; resolveBearer(token: string): Promise<string> } {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? Date.now;
  const isConfigured = configured(settings);
  const callbackUri = `${settings.origin}/auth/callback`;
  let resolver: JWTVerifyGetKey | undefined = options.jwks;
  function now(): number {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new IdentityDenied();
    return value;
  }
  function keyResolver(): JWTVerifyGetKey {
    if (!resolver) resolver = createRemoteJWKSet(new URL(settings.jwksUri), {
      timeoutDuration: REQUEST_TIMEOUT, cooldownDuration: 30_000, cacheMaxAge: 600_000,
      [jwksCache]: options.publicKeyCache,
      [customFetch]: (url, init) => boundedFetch(fetchFn, url, init, 65_536),
    });
    return resolver;
  }
  async function verify(token: string, browser: boolean): Promise<AuthPrincipal> {
    if (!isConfigured || typeof token !== 'string' || token.length > 8_192 || token.split('.').length !== 3) throw new IdentityDenied();
    const { payload, protectedHeader } = await jwtVerify(token, keyResolver(), {
      issuer: settings.issuer, audience: settings.origin, algorithms: ['RS256'], typ: 'at+jwt',
      currentDate: new Date(now()), clockTolerance: 0,
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti', 'client_id', 'azp', 'scope', 'token_use'],
    });
    const at = now();
    const { sub, jti, iat, exp } = payload;
    if (protectedHeader.typ !== 'at+jwt' || payload.aud !== settings.origin || payload.token_use !== 'access' ||
        typeof sub !== 'string' || !sub || sub.length > 256 ||
        typeof jti !== 'string' || !jti || jti.length > 256 ||
        typeof payload.client_id !== 'string' || !payload.client_id || payload.client_id.length > 256 ||
        payload.azp !== payload.client_id || (browser && payload.client_id !== settings.clientId) ||
        !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || typeof iat !== 'number' || typeof exp !== 'number' ||
        iat < 0 || iat > Math.floor(at / 1000) || exp <= iat || exp - iat > TOKEN_TTL || exp * 1000 <= at ||
        (payload.banned !== undefined && payload.banned !== false && payload.banned !== 0) ||
        typeof payload.scope !== 'string' || payload.scope.length > 1024) throw new IdentityDenied();
    const scopes = new Set(payload.scope.split(/\s+/));
    if (!scopes.has('memory:read')) throw new IdentityDenied();
    return {
      issuer: settings.issuer, subject: sub,
      ...(scopes.has('email') && typeof payload.email === 'string' && payload.email.length <= 254
        ? { email: payload.email, emailVerified: payload.emailVerified === true } : {}),
      ...(scopes.has('profile') && typeof payload.name === 'string' && payload.name.length <= 256
        ? { displayName: payload.name } : {}),
      expiresAt: exp * 1000,
      permission: scopes.has('memory:write') && scopes.has('memory:delete') ? 'write' : 'read',
    };
  }
  async function login(): Promise<Response> {
    if (!isConfigured) return response(503, 'Sign-in is not configured.');
    const state = randomToken();
    const binding = randomToken();
    const verifier = randomToken();
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const stateDigest = await digestToken(state);
    const browserDigest = await digestToken(binding);
    await db.prepare('DELETE FROM auth_flows WHERE expires_at<=?').bind(now()).run();
    const at = now();
    const inserted = await db.prepare(`INSERT INTO auth_flows
      (state_digest,browser_digest,verifier,issuer,client_id,redirect_uri,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(stateDigest, browserDigest, verifier, settings.issuer,
      settings.clientId, callbackUri, at, at + FLOW_TTL).run();
    if (!inserted.success || inserted.meta.changes !== 1) throw new IdentityDenied();
    const destination = new URL(settings.authorizationEndpoint);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: settings.clientId,
      redirect_uri: callbackUri, scope: SCOPES, state, resource: settings.origin,
      code_challenge: challenge, code_challenge_method: 'S256' })) destination.searchParams.set(key, value);
    return response(302, '', { Location: destination.href, 'Set-Cookie': cookie(FLOW_COOKIE, binding, 600) });
  }
  async function callback(request: Request, progress: AuthProgress): Promise<Response> {
    if (!isConfigured) return response(503, 'Sign-in is not configured.');
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const issuer = url.searchParams.get('iss');
    const binding = readCookie(request, FLOW_COOKIE);
    if (url.searchParams.has('error') || !code || code.length > 2048 || !state ||
        !/^[A-Za-z0-9_-]{43}$/.test(state) || !binding || issuer !== settings.issuer ||
        ['code', 'state', 'iss'].some(name => url.searchParams.getAll(name).length !== 1)) throw new IdentityDenied();
    const stateDigest = await digestToken(state);
    const browserDigest = await digestToken(binding);
    const at = now();
    progress.phase = 'flow_claim';
    const flow = await db.prepare(`UPDATE auth_flows SET consumed_at=?
      WHERE state_digest=? AND browser_digest=? AND consumed_at IS NULL AND expires_at>${sqlNow()}
        AND created_at<=? AND issuer=? AND client_id=? AND redirect_uri=?
      RETURNING verifier,expires_at AS expiresAt`).bind(at, stateDigest, browserDigest, at, at,
      settings.issuer, settings.clientId, callbackUri).first<{ verifier: string | null; expiresAt: number }>();
    if (!flow?.verifier) throw new IdentityDenied();
    const erased = await db.prepare('UPDATE auth_flows SET verifier=NULL WHERE state_digest=? AND consumed_at=?')
      .bind(stateDigest, at).run();
    if (!erased.success || erased.meta.changes !== 1 || flow.expiresAt <= now()) throw new IdentityDenied();
    progress.phase = 'token_exchange';
    const tokenResponse = await boundedFetch(fetchFn, settings.tokenEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code,
        client_id: settings.clientId, redirect_uri: callbackUri, code_verifier: flow.verifier, resource: settings.origin }),
    }, 32_768);
    progress.phase = 'token_response';
    const tokens = await tokenResponse.json() as Record<string, unknown>;
    if (typeof tokens.access_token !== 'string' || tokens.token_type !== 'Bearer') throw new IdentityDenied();
    progress.phase = 'token_verification';
    const principal = await verify(tokens.access_token, true);
    // A token refresh is not fresh user reauthentication. No auth_time is supplied.
    progress.phase = 'workspace_sign_in';
    const session = await workspaceSignIn(principal);
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(session.token) || !Number.isSafeInteger(session.expiresAt) ||
        session.expiresAt > principal.expiresAt || session.expiresAt <= now()) throw new IdentityDenied();
    const headers = new Headers({ Location: '/' });
    headers.append('Set-Cookie', cookie(FLOW_COOKIE, '', 0));
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, session.token, Math.floor((session.expiresAt - now()) / 1000)));
    return response(303, '', headers);
  }
  async function logout(request: Request): Promise<Response> {
    if (request.headers.get('origin') !== settings.origin) return response(403, 'Request denied.');
    const token = readCookie(request, SESSION_COOKIE);
    if (token) {
      const hash = await digestToken(token);
      const revoked = await db.prepare(`UPDATE credentials SET revoked_at=?
        WHERE token_digest=? AND kind='session' AND membership_id IS NULL AND revoked_at IS NULL`)
        .bind(now(), hash).run();
      if (!revoked.success) throw new IdentityDenied();
    }
    const headers = new Headers({ Location: '/' });
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
    headers.append('Set-Cookie', cookie(FLOW_COOKIE, '', 0));
    return response(303, '', headers);
  }
  return {
    async handle(request) {
      const url = new URL(request.url);
      if (!['/auth/login', '/auth/callback', '/auth/logout'].includes(url.pathname)) return null;
      if (url.origin !== settings.origin) return response(400, 'Request denied.');
      const method = url.pathname === '/auth/logout' ? 'POST' : 'GET';
      if (request.method !== method) return response(405, 'Method not allowed.', { Allow: method });
      const progress: AuthProgress = { phase: url.pathname === '/auth/callback' ? 'callback_validation' : 'login' };
      try {
        if (url.pathname === '/auth/login') return await login();
        if (url.pathname === '/auth/callback') return await callback(request, progress);
        return await logout(request);
      } catch (error) {
        // A fixed support code identifies the failed boundary without logging or
        // reflecting authorization codes, JWTs, cookies, DB errors or provider bodies.
        const diagnostic = `AUTH_${progress.phase.toUpperCase()}${error instanceof AuthUpstreamFailure ? `_${error.status}` : ''}`;
        return response(400, `Authentication failed. Please sign in again. (${diagnostic})`, {
          'X-Auth-Failure': diagnostic,
          ...(url.pathname === '/auth/callback' ? { 'Set-Cookie': cookie(FLOW_COOKIE, '', 0) } : {}),
        });
      }
    },
    async resolveBearer(token) {
      try {
        const principal = await verify(token, false);
        const session = await workspaceSignIn(principal, token);
        if (session.expiresAt > principal.expiresAt || session.expiresAt <= now()) throw new IdentityDenied();
        return session.token;
      } catch { throw new IdentityDenied(); }
    },
  };
}

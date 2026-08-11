/**
 * JWT verification via JWKS — delegates authentication to the Allen Labs
 * central auth server (auth-api.allen.company).
 *
 * This mirrors the pattern used across the Allen Labs worker suite
 * (packages/pm-core/src/server/session.server.ts):
 *
 *   1. Client sends an RS256 JWT as `Authorization: Bearer <jwt>`.
 *   2. The worker verifies the JWT signature against the JWKS published by
 *      the auth server at `{AUTH_API_URL}/.well-known/jwks.json`.
 *   3. `createRemoteJWKSet` from `jose` caches the key set in-process with
 *      a 5-minute TTL and auto-refetches on key rotation.
 *   4. Issuer + audience must match `AUTH_API_URL`.
 *
 * The JWT payload (SessionPayload) carries the user's identity:
 *   - `sub`    — Better Auth user id (UUID string)
 *   - `email`  — user email
 *   - `name`   — display name
 *   - `role`   — platform role ('admin' | 'user')
 *   - `memberships` — org memberships
 *
 * No secrets are stored on this worker — auth is fully delegated. The JWT
 * is valid for 8h (per auth-api config), after which the client must
 * re-authenticate.
 */

import { createLocalJWKSet, jwtVerify, type JWTPayload, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";

export interface SessionPayload extends JWTPayload {
  sub: string; // Better Auth user id (UUID string)
  email?: string;
  name?: string | null;
  username?: string | null;
  preferredName?: string | null;
  role?: string | null; // platform role: 'admin' | 'user'
  banned?: boolean | number | null;
  site?: string | null;
}

// ---------- JWKS cache ----------
// Fetching the JWKS on every request adds ~100-200ms latency. We cache it
// in-process (per Worker isolate) with a 5-minute TTL. Worker isolates are
// ephemeral but typically live for many requests, so this dramatically
// reduces auth latency while still refreshing on key rotation.

let jwksGetKey: JWTVerifyGetKey | null = null;
let jwksExpires = 0;
const JWKS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const JWKS_FETCH_TIMEOUT = 5000; // 5 seconds

/**
 * Verify a JWT bearer token against the auth server's JWKS.
 * Returns the session payload (user identity) or null if invalid/expired.
 *
 * The JWKS is cached in-process for 5 minutes to avoid fetching it on
 * every request. A 5-second timeout prevents hanging if the auth server
 * is slow or unresponsive.
 */
export async function verifyJwt(
  authApiUrl: string,
  token: string,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const jwksUrl = `${authApiUrl.replace(/\/$/, "")}/.well-known/jwks.json`;

    // Check cache — refresh if expired.
    const now = Date.now();
    if (!jwksGetKey || now >= jwksExpires) {
      const resp = await fetch(jwksUrl, {
        signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT),
      });
      if (!resp.ok) {
        console.error(`[verifyJwt] JWKS fetch failed: ${resp.status}`);
        return null;
      }
      const jwksData = (await resp.json()) as JSONWebKeySet;
      if (!jwksData?.keys || !Array.isArray(jwksData.keys)) {
        console.error("[verifyJwt] JWKS response missing keys array");
        return null;
      }
      jwksGetKey = createLocalJWKSet(jwksData);
      jwksExpires = now + JWKS_CACHE_TTL;
    }

    const { payload } = await jwtVerify(token, jwksGetKey, {
      issuer: authApiUrl,
      audience: authApiUrl,
    });
    if (typeof payload.sub !== "string") return null;
    return payload as SessionPayload;
  } catch (err) {
    console.error(
      "[verifyJwt] failed:",
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    return null;
  }
}

/**
 * Extract the bearer token from an Authorization header.
 * Returns null if the header is missing or not a Bearer token.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (!trimmed.startsWith("Bearer ")) return null;
  const token = trimmed.slice("Bearer ".length).trim();
  return token || null;
}

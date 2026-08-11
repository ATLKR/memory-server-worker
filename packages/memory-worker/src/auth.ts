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

import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";

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

/**
 * Verify a JWT bearer token against the auth server's JWKS.
 * Returns the session payload (user identity) or null if invalid/expired.
 *
 * We fetch the JWKS fresh on each call (rather than using createRemoteJWKSet's
 * in-process cache) to avoid stale key issues during key rotation. The JWKS
 * is small (single key) so the overhead is negligible.
 */
export async function verifyJwt(
  authApiUrl: string,
  token: string,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const jwksUrl = `${authApiUrl.replace(/\/$/, "")}/.well-known/jwks.json`;
    const resp = await fetch(jwksUrl);
    if (!resp.ok) {
      console.error(`[verifyJwt] JWKS fetch failed: ${resp.status}`);
      return null;
    }
    const jwks = createLocalJWKSet(await resp.json());
    const { payload } = await jwtVerify(token, jwks, {
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

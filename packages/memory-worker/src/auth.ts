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
 *   4. Issuer must match `AUTH_API_URL`; the audience is the protected
 *      Memory resource origin (with an explicit, temporary legacy-audience
 *      compatibility switch for staged migrations).
 *
 * The JWT payload (SessionPayload) carries the user's identity:
 *   - `sub`    — Better Auth user id (UUID string)
 *   - `email`  — user email
 *   - `name`   — display name
 *   - `role`   — platform role ('admin' | 'user')
 *   - `memberships` — org memberships
 *
 * JWT verification itself needs no shared secret. API-key authentication is
 * handled separately below through a digest-only Worker secret. The JWT
 * access token is valid for 15 minutes. Browser/CLI clients can use the
 * auth server's one-time rotating refresh token for up to the family's
 * absolute 30-day lifetime.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export interface SessionPayload extends JWTPayload {
  sub: string; // Stable Better Auth user id (format is provider-defined)
  email?: string;
  name?: string | null;
  username?: string | null;
  preferredName?: string | null;
  role?: string | null; // platform role: 'admin' | 'user'
  banned?: boolean | number | null;
  site?: string | null;
  scope?: string;
}

// ---------- JWKS cache ----------
// Fetching the JWKS on every request adds ~100-200ms latency. We cache it
// in-process (per Worker isolate) with a 5-minute TTL. Worker isolates are
// ephemeral but typically live for many requests, so this dramatically
// reduces auth latency while still refreshing on key rotation.

let jwksGetKey: JWTVerifyGetKey | null = null;
let jwksSourceUrl = "";
const JWKS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const JWKS_FETCH_TIMEOUT = 5000; // 5 seconds
const ACCESS_TOKEN_MAX_LIFETIME_SECONDS = 15 * 60;
const LEGACY_TOKEN_MAX_LIFETIME_SECONDS = 8 * 60 * 60;
const JWT_CLOCK_TOLERANCE_SECONDS = 60;

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
  requestId?: string,
  options?: {
    resourceAudience?: string;
    legacyAudienceCutoff?: string;
    now?: Date;
  },
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const normalizedAuthApiUrl = authApiUrl.replace(/\/$/, "");
    const jwksUrl = `${normalizedAuthApiUrl}/.well-known/jwks.json`;

    // createRemoteJWKSet caches successful fetches and refreshes immediately
    // when a JWT references an unknown key id, so auth survives key rotation.
    if (!jwksGetKey || jwksSourceUrl !== jwksUrl) {
      jwksGetKey = createRemoteJWKSet(new URL(jwksUrl), {
        timeoutDuration: JWKS_FETCH_TIMEOUT,
        cacheMaxAge: JWKS_CACHE_TTL,
        cooldownDuration: 30_000,
      });
      jwksSourceUrl = jwksUrl;
    }

    const resourceAudience = options?.resourceAudience?.replace(/\/$/, "");
    const nowMs = (options?.now ?? new Date()).getTime();
    const legacyCutoffMs = options?.legacyAudienceCutoff
      ? Date.parse(options.legacyAudienceCutoff)
      : Number.NaN;
    const legacyWindowOpen =
      Number.isFinite(legacyCutoffMs) &&
      Number.isFinite(nowMs) &&
      nowMs <= legacyCutoffMs + (8 * 60 + 5) * 60 * 1000;
    const audiences = resourceAudience
      ? [
          resourceAudience,
          ...(legacyWindowOpen ? [normalizedAuthApiUrl] : []),
        ]
      : [normalizedAuthApiUrl];

    const { payload } = await jwtVerify(token, jwksGetKey, {
      issuer: normalizedAuthApiUrl,
      audience: audiences,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "iat", "exp"],
      currentDate: options?.now,
      clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.iat * 1000 > nowMs + JWT_CLOCK_TOLERANCE_SECONDS * 1000
    ) {
      return null;
    }

    const resourceBound = Boolean(resourceAudience && payload.aud === resourceAudience);
    const lifetimeSeconds = payload.exp - payload.iat;
    if (resourceBound) {
      if (
        lifetimeSeconds > ACCESS_TOKEN_MAX_LIFETIME_SECONDS ||
        payload.token_use !== "access" ||
        typeof payload.client_id !== "string" ||
        !payload.client_id.trim() ||
        payload.azp !== payload.client_id ||
        typeof payload.jti !== "string" ||
        !payload.jti.trim()
      ) {
        return null;
      }
    } else if (resourceAudience) {
      const issuedAtMs = payload.iat * 1000;
      if (
        payload.aud !== normalizedAuthApiUrl ||
        !legacyWindowOpen ||
        !Number.isFinite(issuedAtMs) ||
        issuedAtMs >= legacyCutoffMs ||
        lifetimeSeconds > LEGACY_TOKEN_MAX_LIFETIME_SECONDS
      ) {
        return null;
      }
    }
    return payload as SessionPayload;
  } catch (err) {
    const rawErrorType = err instanceof Error ? err.name : typeof err;
    const errorType = /^[A-Za-z0-9_.-]{1,64}$/.test(rawErrorType)
      ? rawErrorType
      : "UnknownError";
    console.error(JSON.stringify({
      level: "error",
      event: "jwt_verification_failed",
      ...(requestId ? { requestId } : {}),
      errorType,
    }));
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

// ---------- Digest-backed credential registry ----------

/**
 * API keys and personal access tokens (PATs) are stored as SHA-256 digests in
 * one Worker secret named
 * MEMORY_API_KEY_REGISTRY. The secret uses this versioned JSON shape:
 *
 * {
 *   "version": 3,
 *   "keys": [{
 *     "id": "automation",
 *     "kind": "api-key",
 *     "digest": "sha256:<64 lowercase hex characters>",
 *     "userId": "stable-user-id",
 *     "logicalScope": "optional-fixed-scope",
 *     "permissions": ["read", "write"],
 *     "expiresAt": "2026-09-12T00:00:00Z",
 *     "disabledAt": "2026-08-20T00:00:00Z"
 *   }]
 * }
 *
 * Versions 1 and 2 remain API-key-only. Version 1 accepts only the legacy
 * digest/user/scope shape and retains historical read/write/delete access.
 * Version 2 requires every key to declare the narrowest required permission
 * set and an expiry. Version 3 additionally requires `kind` to be either
 * `api-key` or `pat`, preventing one stored digest from crossing credential
 * schemes. PAT plaintext has the reserved `memory_pat_` prefix followed by 43
 * base64url characters and is accepted only as an Authorization Bearer token.
 * `expiresAt` rejects the key at and after that instant. `disabledAt` can
 * revoke immediately or schedule revocation. Plaintext API keys must never be
 * placed in the registry. `strict()` also rejects accidental fields such as
 * `key` or `token`, and prevents new policy fields from being smuggled into a
 * version-1 registry where they would otherwise look enforced.
 */
export const API_KEY_PERMISSIONS = ["read", "write", "delete"] as const;
export type ApiKeyPermission = typeof API_KEY_PERMISSIONS[number];

const apiKeyTimestampSchema = z
  .string()
  .min(20)
  .max(64)
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    { message: "must be an RFC 3339 timestamp with a timezone" },
  );

const apiKeyRegistryBaseEntryShape = {
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  userId: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value === value.trim(), {
      message: "userId must not have surrounding whitespace",
    }),
  logicalScope: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => value === value.trim(), {
      message: "logicalScope must not have surrounding whitespace",
    })
    .optional(),
} as const;

const apiKeyPermissionsSchema = z
  .array(z.enum(API_KEY_PERMISSIONS))
  .min(1)
  .max(API_KEY_PERMISSIONS.length)
  .refine((permissions) => new Set(permissions).size === permissions.length, {
    message: "permissions must be unique",
  });

const legacyApiKeyRegistryEntrySchema = z
  .object(apiKeyRegistryBaseEntryShape)
  .strict();

const apiKeyRegistryEntrySchema = z
  .object({
    ...apiKeyRegistryBaseEntryShape,
    permissions: apiKeyPermissionsSchema,
    expiresAt: apiKeyTimestampSchema,
    disabledAt: apiKeyTimestampSchema.optional(),
  })
  .strict();

export const REGISTRY_CREDENTIAL_KINDS = ["api-key", "pat"] as const;
export type RegistryCredentialKind = typeof REGISTRY_CREDENTIAL_KINDS[number];

const credentialRegistryEntrySchema = z
  .object({
    ...apiKeyRegistryBaseEntryShape,
    kind: z.enum(REGISTRY_CREDENTIAL_KINDS),
    permissions: apiKeyPermissionsSchema,
    expiresAt: apiKeyTimestampSchema,
    disabledAt: apiKeyTimestampSchema.optional(),
  })
  .strict();

const apiKeyRegistrySchema = z
  .discriminatedUnion("version", [
    z.object({
      version: z.literal(1),
      keys: z.array(legacyApiKeyRegistryEntrySchema).min(1).max(20),
    }).strict(),
    z.object({
      version: z.literal(2),
      keys: z.array(apiKeyRegistryEntrySchema).min(1).max(20),
    }).strict(),
    z.object({
      version: z.literal(3),
      keys: z.array(credentialRegistryEntrySchema).min(1).max(20),
    }).strict(),
  ])
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    const digests = new Set<string>();
    for (const [index, entry] of registry.keys.entries()) {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "id"],
          message: "credential ids must be unique",
        });
      }
      if (digests.has(entry.digest)) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "digest"],
          message: "credential digests must be unique",
        });
      }
      ids.add(entry.id);
      digests.add(entry.digest);
    }
  });

// Cloudflare limits each Worker secret/environment variable to 5 KiB.
export const API_KEY_REGISTRY_MAX_BYTES = 5 * 1024;
export const API_KEY_MAX_BYTES = 512;
export const PERSONAL_ACCESS_TOKEN_PREFIX = "memory_pat_";
// Provision keys from at least 32 cryptographically random bytes. Base64url
// encoding that material produces a convenient 43-character header value.
const API_KEY_MIN_BYTES = 32;
const SHA_256_BYTES = 32;
const API_KEY_AUTHORIZATION_PATTERN = /^ApiKey[ \t]+([^\s]+)$/i;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const PERSONAL_ACCESS_TOKEN_PATTERN = /^memory_pat_[A-Za-z0-9_-]{43}$/;

export interface ApiKeyIdentity {
  keyId: string;
  userId: string;
  logicalScope: string | null;
  permissions: readonly ApiKeyPermission[];
}

/** Extract an API key from `Authorization: ApiKey <key>`. */
export function extractAuthorizationApiKey(authHeader: string | null): string | null {
  if (!authHeader) return null;
  return API_KEY_AUTHORIZATION_PATTERN.exec(authHeader.trim())?.[1] ?? null;
}

function decodeSha256Digest(value: string): Uint8Array {
  const hex = value.slice("sha256:".length);
  const bytes = new Uint8Array(SHA_256_BYTES);
  for (let index = 0; index < SHA_256_BYTES; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parseApiKeyRegistry(registryJson: string): z.infer<typeof apiKeyRegistrySchema> | null {
  // Check code-unit length before encoding so an unexpectedly huge binding
  // cannot force a proportionally larger temporary allocation.
  if (!registryJson || registryJson.length > API_KEY_REGISTRY_MAX_BYTES) return null;
  const bytes = new TextEncoder().encode(registryJson);
  if (bytes.byteLength > API_KEY_REGISTRY_MAX_BYTES) return null;

  let value: unknown;
  try {
    value = JSON.parse(registryJson);
  } catch {
    return null;
  }

  const parsed = apiKeyRegistrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Verify one presented API key against the digest-only registry.
 *
 * Both operands passed to `timingSafeEqual` are SHA-256 digests, so their
 * length is always fixed at 32 bytes. The plaintext key is never logged or
 * retained in the returned identity.
 */
async function verifyRegistryCredential(
  registryJson: string | undefined,
  providedCredential: string,
  expectedKind: RegistryCredentialKind,
  now: Date = new Date(),
): Promise<ApiKeyIdentity | null> {
  if (
    !registryJson ||
    providedCredential !== providedCredential.trim() ||
    !VISIBLE_ASCII_PATTERN.test(providedCredential)
  ) {
    return null;
  }

  const isPat = PERSONAL_ACCESS_TOKEN_PATTERN.test(providedCredential);
  if (
    (expectedKind === "pat" && !isPat) ||
    (expectedKind === "api-key" && isPat)
  ) {
    return null;
  }

  const credentialBytes = new TextEncoder().encode(providedCredential);
  if (
    credentialBytes.byteLength < API_KEY_MIN_BYTES ||
    credentialBytes.byteLength > API_KEY_MAX_BYTES
  ) return null;

  const registry = parseApiKeyRegistry(registryJson);
  if (!registry) return null;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;

  const providedDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", credentialBytes),
  );
  let identity: ApiKeyIdentity | null = null;
  for (const entry of registry.keys) {
    const expectedDigest = decodeSha256Digest(entry.digest);
    if (crypto.subtle.timingSafeEqual(providedDigest, expectedDigest)) {
      const entryKind = "kind" in entry ? entry.kind : "api-key";
      if (entryKind !== expectedKind) continue;
      const expiresAt = "expiresAt" in entry ? entry.expiresAt : undefined;
      const disabledAt = "disabledAt" in entry ? entry.disabledAt : undefined;
      const expired = expiresAt !== undefined && Date.parse(expiresAt) <= nowMs;
      const disabled = disabledAt !== undefined && Date.parse(disabledAt) <= nowMs;
      if (expired || disabled) continue;
      identity = {
        keyId: entry.id,
        userId: entry.userId,
        logicalScope: entry.logicalScope ?? null,
        permissions: "permissions" in entry
          ? entry.permissions
          : API_KEY_PERMISSIONS,
      };
    }
  }
  return identity;
}

/** Verify a key presented through x-memory-api-key or Authorization: ApiKey. */
export async function verifyApiKey(
  registryJson: string | undefined,
  providedKey: string,
  now: Date = new Date(),
): Promise<ApiKeyIdentity | null> {
  return verifyRegistryCredential(registryJson, providedKey, "api-key", now);
}

/**
 * Verify a prefixed, opaque personal access token presented as Bearer auth.
 * Versions 1 and 2 are deliberately API-key-only; PATs require a v3 entry.
 */
export async function verifyPersonalAccessToken(
  registryJson: string | undefined,
  providedToken: string,
  now: Date = new Date(),
): Promise<ApiKeyIdentity | null> {
  return verifyRegistryCredential(registryJson, providedToken, "pat", now);
}

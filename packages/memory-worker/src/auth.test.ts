import assert from "node:assert/strict";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  API_KEY_MAX_BYTES,
  API_KEY_PERMISSIONS,
  API_KEY_REGISTRY_MAX_BYTES,
  PERSONAL_ACCESS_TOKEN_PREFIX,
  type ApiKeyPermission,
  type RegistryCredentialKind,
  extractAuthorizationApiKey,
  verifyApiKey,
  verifyJwt,
  verifyPersonalAccessToken,
} from "./auth.ts";

// Node 24 does not yet expose the Workers-only SubtleCrypto extension. Keep
// this compatibility shim in tests; production always calls the Workers Web
// Crypto implementation directly.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value: (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) => {
      const leftBytes = ArrayBuffer.isView(left)
        ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
        : new Uint8Array(left);
      const rightBytes = ArrayBuffer.isView(right)
        ? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
        : new Uint8Array(right);
      return leftBytes.byteLength === rightBytes.byteLength &&
        nodeTimingSafeEqual(leftBytes, rightBytes);
    },
  });
}

async function digest(key: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function registry(
  entries: Array<{
    id: string;
    key: string;
    userId: string;
    logicalScope?: string;
    permissions?: ApiKeyPermission[];
    expiresAt?: string;
    disabledAt?: string;
    kind?: RegistryCredentialKind;
  }>,
  version: 1 | 2 | 3 = 2,
): Promise<string> {
  return JSON.stringify({
    version,
    keys: await Promise.all(
      entries.map(async ({ key, permissions, expiresAt, disabledAt, kind, ...entry }) => ({
        ...entry,
        digest: await digest(key),
        ...(version >= 2
          ? {
              permissions: permissions ?? [...API_KEY_PERMISSIONS],
              expiresAt: expiresAt ?? "2099-01-01T00:00:00Z",
              ...(disabledAt ? { disabledAt } : {}),
            }
          : {}),
        ...(version === 3 ? { kind: kind ?? "api-key" } : {}),
      })),
    ),
  });
}

async function jwtFixture(
  authApiUrl: string,
  audience: string,
  issuedAt: number,
): Promise<{ token: string; jwks: { keys: Array<Record<string, unknown>> } }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const kid = crypto.randomUUID();
  const token = await new SignJWT({
    email: "user@example.test",
    ...(audience === authApiUrl
      ? {}
      : {
          token_use: "access",
          client_id: "memory-test-client",
          azp: "memory-test-client",
          scope: "memory:read memory:write memory:delete",
        }),
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject("user-1")
    .setIssuer(authApiUrl)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (audience === authApiUrl ? 8 * 60 * 60 : 15 * 60))
    .setJti(crypto.randomUUID())
    .sign(privateKey);
  return {
    token,
    jwks: { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] },
  };
}

describe("resource-bound JWT authentication", () => {
  it("accepts the exact Memory audience", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const resource = "https://memory.allenlim.net";
    const fixture = await jwtFixture(
      authApiUrl,
      resource,
      Math.floor(Date.now() / 1000),
    );
    t.mock.method(globalThis, "fetch", async () => Response.json(fixture.jwks));

    assert.equal(
      (await verifyJwt(authApiUrl, fixture.token, undefined, {
        resourceAudience: resource,
      }))?.sub,
      "user-1",
    );
  });

  it("automatically sunsets the legacy auth-api audience", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const resource = "https://memory.allenlim.net";
    const baseMs = Math.floor(Date.now() / 1000) * 1000;
    const cutoff = new Date(baseMs + 60_000).toISOString();
    const fixture = await jwtFixture(
      authApiUrl,
      authApiUrl,
      Math.floor(baseMs / 1000),
    );
    t.mock.method(globalThis, "fetch", async () => Response.json(fixture.jwks));

    assert.equal(
      (await verifyJwt(authApiUrl, fixture.token, undefined, {
        resourceAudience: resource,
        legacyAudienceCutoff: cutoff,
        now: new Date(baseMs + 2 * 60_000),
      }))?.sub,
      "user-1",
    );
    assert.equal(
      await verifyJwt(authApiUrl, fixture.token, undefined, {
        resourceAudience: resource,
        legacyAudienceCutoff: cutoff,
        now: new Date(baseMs + (8 * 60 + 7) * 60_000),
      }),
      null,
    );
  });

  it("rejects legacy tokens issued at or after the migration cutoff", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const resource = "https://memory.allenlim.net";
    const cutoffMs = Math.floor(Date.now() / 1000) * 1000;
    const fixture = await jwtFixture(
      authApiUrl,
      authApiUrl,
      Math.floor(cutoffMs / 1000),
    );
    t.mock.method(globalThis, "fetch", async () => Response.json(fixture.jwks));

    assert.equal(
      await verifyJwt(authApiUrl, fixture.token, undefined, {
        resourceAudience: resource,
        legacyAudienceCutoff: new Date(cutoffMs).toISOString(),
        now: new Date(cutoffMs),
      }),
      null,
    );
  });

  it("rejects resource tokens missing access-token claims or exceeding 15 minutes", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const resource = "https://memory.allenlim.net";
    const issuedAt = Math.floor(Date.now() / 1000);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const kid = crypto.randomUUID();
    const publicJwk = await exportJWK(publicKey);
    t.mock.method(globalThis, "fetch", async () => Response.json({
      keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }],
    }));

    const missingClaims = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject("user-1")
      .setIssuer(authApiUrl)
      .setAudience(resource)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 15 * 60)
      .sign(privateKey);
    const tooLong = await new SignJWT({
      token_use: "access",
      client_id: "memory-test-client",
      azp: "memory-test-client",
    })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject("user-1")
      .setIssuer(authApiUrl)
      .setAudience(resource)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 16 * 60)
      .setJti(crypto.randomUUID())
      .sign(privateKey);

    assert.equal(await verifyJwt(authApiUrl, missingClaims, undefined, {
      resourceAudience: resource,
    }), null);
    assert.equal(await verifyJwt(authApiUrl, tooLong, undefined, {
      resourceAudience: resource,
    }), null);
  });
});

describe("API key authentication", () => {
  it("matches one of multiple digest-only entries and returns its fixed identity", async () => {
    const firstKey = "memory_test_first_0123456789abcdef";
    const secondKey = "memory_test_second_9876543210abcdef";
    const value = await registry([
      { id: "first", key: firstKey, userId: "user-a" },
      {
        id: "second",
        key: secondKey,
        userId: "user-b",
        logicalScope: "automation",
      },
    ]);

    assert.deepEqual(await verifyApiKey(value, secondKey), {
      keyId: "second",
      userId: "user-b",
      logicalScope: "automation",
      permissions: API_KEY_PERMISSIONS,
    });
    assert.equal(
      await verifyApiKey(value, "memory_test_wrong_0123456789abcdef"),
      null,
    );
  });

  it("returns declared least-privilege permissions and keeps version-1 entries compatible", async () => {
    const readOnlyKey = "memory_test_read_only_0123456789abcdef";
    const legacyKey = "memory_test_legacy_full_0123456789abcdef";
    const value = await registry([
      {
        id: "read-only",
        key: readOnlyKey,
        userId: "user-a",
        permissions: ["read"],
      },
    ]);
    const legacyValue = await registry(
      [{ id: "legacy", key: legacyKey, userId: "user-b" }],
      1,
    );

    assert.deepEqual(await verifyApiKey(value, readOnlyKey), {
      keyId: "read-only",
      userId: "user-a",
      logicalScope: null,
      permissions: ["read"],
    });
    assert.deepEqual(
      (await verifyApiKey(legacyValue, legacyKey))?.permissions,
      API_KEY_PERMISSIONS,
    );
  });

  it("requires explicit permissions and expiry in version 2", async () => {
    const key = "memory_test_v2_policy_0123456789abcdef";
    const keyDigest = await digest(key);
    const baseEntry = {
      id: "v2-policy",
      digest: keyDigest,
      userId: "user-a",
    };

    for (const invalid of [
      { version: 2, keys: [{ ...baseEntry, expiresAt: "2099-01-01T00:00:00Z" }] },
      { version: 2, keys: [{ ...baseEntry, permissions: ["read"] }] },
      {
        version: 1,
        keys: [{
          ...baseEntry,
          permissions: ["read"],
          expiresAt: "2099-01-01T00:00:00Z",
        }],
      },
    ]) {
      assert.equal(await verifyApiKey(JSON.stringify(invalid), key), null);
    }
  });

  it("supports scheme-bound PATs only through explicit version-3 entries", async () => {
    const pat = `${PERSONAL_ACCESS_TOKEN_PREFIX}${"A".repeat(43)}`;
    const apiKey = "memory_test_v3_api_key_0123456789abcdef";
    const value = await registry([
      {
        id: "pat",
        key: pat,
        kind: "pat",
        userId: "user-pat",
        logicalScope: "headless",
        permissions: ["read", "write"],
      },
      {
        id: "api-key",
        key: apiKey,
        kind: "api-key",
        userId: "user-api-key",
        permissions: ["read"],
      },
    ], 3);

    assert.deepEqual(await verifyPersonalAccessToken(value, pat), {
      keyId: "pat",
      userId: "user-pat",
      logicalScope: "headless",
      permissions: ["read", "write"],
    });
    assert.deepEqual(await verifyApiKey(value, apiKey), {
      keyId: "api-key",
      userId: "user-api-key",
      logicalScope: null,
      permissions: ["read"],
    });
    assert.equal(await verifyApiKey(value, pat), null);
    assert.equal(await verifyPersonalAccessToken(value, apiKey), null);

    const version2 = await registry([
      { id: "legacy-shape", key: pat, userId: "user-pat" },
    ], 2);
    assert.equal(await verifyPersonalAccessToken(version2, pat), null);
    assert.equal(await verifyApiKey(version2, pat), null);
  });

  it("requires exact PAT syntax and applies expiry and disable policy", async () => {
    const activePat = `${PERSONAL_ACCESS_TOKEN_PREFIX}${"B".repeat(43)}`;
    const expiredPat = `${PERSONAL_ACCESS_TOKEN_PREFIX}${"C".repeat(43)}`;
    const disabledPat = `${PERSONAL_ACCESS_TOKEN_PREFIX}${"D".repeat(43)}`;
    const value = await registry([
      { id: "active", key: activePat, kind: "pat", userId: "user-a" },
      {
        id: "expired",
        key: expiredPat,
        kind: "pat",
        userId: "user-a",
        expiresAt: "2026-08-12T23:59:59Z",
      },
      {
        id: "disabled",
        key: disabledPat,
        kind: "pat",
        userId: "user-a",
        disabledAt: "2026-08-13T00:00:00Z",
      },
    ], 3);
    const now = new Date("2026-08-13T00:00:00Z");

    assert.equal((await verifyPersonalAccessToken(value, activePat, now))?.keyId, "active");
    assert.equal(await verifyPersonalAccessToken(value, expiredPat, now), null);
    assert.equal(await verifyPersonalAccessToken(value, disabledPat, now), null);
    for (const malformed of [
      `${PERSONAL_ACCESS_TOKEN_PREFIX}${"A".repeat(42)}`,
      `${PERSONAL_ACCESS_TOKEN_PREFIX}${"A".repeat(44)}`,
      `${PERSONAL_ACCESS_TOKEN_PREFIX}${"A".repeat(42)}.`,
      ` ${activePat}`,
    ]) {
      assert.equal(await verifyPersonalAccessToken(value, malformed, now), null);
    }
  });

  it("rejects expired or disabled keys while allowing scheduled revocation", async () => {
    const expiredKey = "memory_test_expired_0123456789abcdef";
    const disabledKey = "memory_test_disabled_0123456789abcdef";
    const scheduledKey = "memory_test_scheduled_0123456789abcdef";
    const value = await registry([
      {
        id: "expired",
        key: expiredKey,
        userId: "user-a",
        expiresAt: "2026-08-13T00:00:00Z",
      },
      {
        id: "disabled",
        key: disabledKey,
        userId: "user-a",
        disabledAt: "2026-08-12T23:59:59Z",
      },
      {
        id: "scheduled",
        key: scheduledKey,
        userId: "user-a",
        disabledAt: "2026-08-14T00:00:00Z",
      },
    ]);
    const now = new Date("2026-08-13T00:00:00Z");

    assert.equal(await verifyApiKey(value, expiredKey, now), null);
    assert.equal(await verifyApiKey(value, disabledKey, now), null);
    assert.deepEqual(
      (await verifyApiKey(value, scheduledKey, now))?.permissions,
      API_KEY_PERMISSIONS,
    );
  });

  it("rejects malformed and oversized presented keys before lookup", async () => {
    const validKey = "memory_test_valid_0123456789abcdef";
    const value = await registry([
      { id: "valid", key: validKey, userId: "user-a" },
    ]);

    for (const malformed of [
      "short",
      ` ${validKey}`,
      `${validKey}\n`,
      "unicode-key-열여섯자하나둘셋",
      "x".repeat(API_KEY_MAX_BYTES + 1),
    ]) {
      assert.equal(await verifyApiKey(value, malformed), null);
    }
  });

  it("strictly rejects invalid, duplicate, and oversized registries", async () => {
    const key = "memory_test_duplicate_0123456789";
    const keyDigest = await digest(key);
    const otherDigest = await digest("memory_test_other_0123456789abcdef");
    const plaintextRegistry = JSON.stringify({
      version: 1,
      keys: [{
        id: "unsafe",
        digest: keyDigest,
        userId: "user-a",
        key,
      }],
    });
    const duplicateRegistry = JSON.stringify({
      version: 1,
      keys: [
        { id: "first", digest: keyDigest, userId: "user-a" },
        { id: "second", digest: keyDigest, userId: "user-b" },
      ],
    });
    const duplicateIdRegistry = JSON.stringify({
      version: 1,
      keys: [
        { id: "duplicate", digest: keyDigest, userId: "user-a" },
        { id: "duplicate", digest: otherDigest, userId: "user-b" },
      ],
    });
    const wrongVersionRegistry = JSON.stringify({
      version: 2,
      keys: [{ id: "wrong-version", digest: keyDigest, userId: "user-a" }],
    });
    const badDigestRegistry = JSON.stringify({
      version: 1,
      keys: [{ id: "bad-digest", digest: "sha256:not-a-digest", userId: "user-a" }],
    });
    const duplicatePermissionRegistry = JSON.stringify({
      version: 2,
      keys: [{
        id: "duplicate-permission",
        digest: keyDigest,
        userId: "user-a",
        permissions: ["read", "read"],
        expiresAt: "2099-01-01T00:00:00Z",
      }],
    });
    const invalidTimestampRegistry = JSON.stringify({
      version: 2,
      keys: [{
        id: "invalid-timestamp",
        digest: keyDigest,
        userId: "user-a",
        permissions: ["read"],
        expiresAt: "tomorrow",
      }],
    });
    const missingKindRegistry = JSON.stringify({
      version: 3,
      keys: [{
        id: "missing-kind",
        digest: keyDigest,
        userId: "user-a",
        permissions: ["read"],
        expiresAt: "2099-01-01T00:00:00Z",
      }],
    });
    const kindInVersion2Registry = JSON.stringify({
      version: 2,
      keys: [{
        id: "wrong-version-kind",
        digest: keyDigest,
        userId: "user-a",
        kind: "pat",
        permissions: ["read"],
        expiresAt: "2099-01-01T00:00:00Z",
      }],
    });
    const invalidKindRegistry = JSON.stringify({
      version: 3,
      keys: [{
        id: "invalid-kind",
        digest: keyDigest,
        userId: "user-a",
        kind: "jwt",
        permissions: ["read"],
        expiresAt: "2099-01-01T00:00:00Z",
      }],
    });

    assert.equal(await verifyApiKey(plaintextRegistry, key), null);
    assert.equal(await verifyApiKey(duplicateRegistry, key), null);
    assert.equal(await verifyApiKey(duplicateIdRegistry, key), null);
    assert.equal(await verifyApiKey(wrongVersionRegistry, key), null);
    assert.equal(await verifyApiKey(badDigestRegistry, key), null);
    assert.equal(await verifyApiKey(duplicatePermissionRegistry, key), null);
    assert.equal(await verifyApiKey(invalidTimestampRegistry, key), null);
    assert.equal(await verifyApiKey(missingKindRegistry, key), null);
    assert.equal(await verifyApiKey(kindInVersion2Registry, key), null);
    assert.equal(await verifyApiKey(invalidKindRegistry, key), null);
    assert.equal(
      await verifyApiKey("x".repeat(API_KEY_REGISTRY_MAX_BYTES + 1), key),
      null,
    );
  });

  it("parses only a complete Authorization ApiKey credential", () => {
    assert.equal(
      extractAuthorizationApiKey("ApiKey memory_test_valid_0123456789"),
      "memory_test_valid_0123456789",
    );
    assert.equal(
      extractAuthorizationApiKey("apikey\tmemory_test_valid_0123456789"),
      "memory_test_valid_0123456789",
    );
    assert.equal(extractAuthorizationApiKey("ApiKey"), null);
    assert.equal(extractAuthorizationApiKey("Bearer token"), null);
    assert.equal(extractAuthorizationApiKey("ApiKey key with spaces"), null);
  });
});

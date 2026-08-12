import assert from "node:assert/strict";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { describe, it } from "node:test";
import {
  API_KEY_MAX_BYTES,
  API_KEY_REGISTRY_MAX_BYTES,
  extractAuthorizationApiKey,
  verifyApiKey,
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
  }>,
): Promise<string> {
  return JSON.stringify({
    version: 1,
    keys: await Promise.all(
      entries.map(async ({ key, ...entry }) => ({
        ...entry,
        digest: await digest(key),
      })),
    ),
  });
}

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
    });
    assert.equal(
      await verifyApiKey(value, "memory_test_wrong_0123456789abcdef"),
      null,
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

    assert.equal(await verifyApiKey(plaintextRegistry, key), null);
    assert.equal(await verifyApiKey(duplicateRegistry, key), null);
    assert.equal(await verifyApiKey(duplicateIdRegistry, key), null);
    assert.equal(await verifyApiKey(wrongVersionRegistry, key), null);
    assert.equal(await verifyApiKey(badDigestRegistry, key), null);
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

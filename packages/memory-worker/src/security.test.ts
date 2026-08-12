import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidSsoState, legacyProfileName, resolveProfileName } from "./security.ts";

describe("resolveProfileName", () => {
  it("preserves the legacy personal profile when no logical scope is used", async () => {
    const userId = "2ce0b53f-f7c0-4cee-a150-dd2616213d8f";
    assert.equal(await resolveProfileName(userId), legacyProfileName(userId));
  });

  it("binds the same logical scope to the authenticated user", async () => {
    const first = await resolveProfileName("user-a", "shared-name");
    const second = await resolveProfileName("user-b", "shared-name");

    assert.match(first, /^user-[a-f0-9]{64}$/);
    assert.match(second, /^user-[a-f0-9]{64}$/);
    assert.notEqual(first, second);
  });

  it("does not collapse distinct logical scopes during sanitization", async () => {
    const first = await resolveProfileName("user-a", "Ab_C");
    const second = await resolveProfileName("user-a", "ab-c");

    assert.notEqual(first, second);
  });

  it("hashes unexpected subject formats instead of collapsing them", async () => {
    const first = await resolveProfileName("Ab_C");
    const second = await resolveProfileName("ab-c");

    assert.notEqual(first, second);
  });

  it("keeps an unscoped profile distinct from a scope named personal", async () => {
    const unscoped = await resolveProfileName("non-uuid-subject");
    const explicitlyScoped = await resolveProfileName("non-uuid-subject", "personal");

    assert.notEqual(unscoped, explicitlyScoped);
  });
});

describe("isValidSsoState", () => {
  it("requires both values and an exact match", () => {
    assert.equal(isValidSsoState("state", "state"), true);
    assert.equal(isValidSsoState("state", null), false);
    assert.equal(isValidSsoState("state", "other"), false);
  });
});

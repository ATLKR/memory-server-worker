const PROFILE_NAME_MAX_LENGTH = 100;
const SCOPED_PROFILE_PREFIX = "user-";
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Reproduce the pre-2.0 lossy profile-name sanitizer for migration only. */
export function legacyProfileName(userId: string): string {
  return (
    userId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, PROFILE_NAME_MAX_LENGTH) || "default"
  );
}

/**
 * Resolve an Agent Memory profile without allowing a caller-controlled scope
 * to escape the authenticated user's boundary.
 *
 * Unscoped UUID subjects retain the legacy user profile name. Unexpected
 * subject formats and explicit logical scopes (including DEFAULT_SCOPE) are
 * bound to the JWT subject with SHA-256, avoiding lossy-name collisions.
 */
export async function resolveProfileName(
  userId: string,
  logicalScope?: string | null,
): Promise<string> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("Authenticated user id is required");
  }

  const normalizedScope = logicalScope?.trim();
  if (!normalizedScope && UUID_PATTERN.test(normalizedUserId)) {
    return legacyProfileName(normalizedUserId);
  }

  // JSON tuple encoding keeps the identity components unambiguous even if a
  // JWT subject or logical scope contains delimiter characters. `null` also
  // remains distinct from an explicit scope named "personal".
  const input = new TextEncoder().encode(
    JSON.stringify(["memory-profile-v1", normalizedUserId, normalizedScope || null]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${SCOPED_PROFILE_PREFIX}${hex}`;
}

/** Compare fixed-size SSO state values without an early-exit timing signal. */
export function isValidSsoState(cookieState: string | null, queryState: string | null): boolean {
  if (!cookieState || !queryState || cookieState.length !== queryState.length) {
    return false;
  }

  let difference = 0;
  for (let i = 0; i < cookieState.length; i += 1) {
    difference |= cookieState.charCodeAt(i) ^ queryState.charCodeAt(i);
  }
  return difference === 0;
}

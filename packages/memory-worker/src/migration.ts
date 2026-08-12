import { legacyProfileName, resolveProfileName } from "./security";

const LEGACY_PERSONAL_PROFILE_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USER_BOUND_PROFILE_PATTERN = /^user-[a-f0-9]{64}$/;

export interface ScopeMigrationPlan {
  profileKind: "scoped";
  ownerSub: string;
  logicalScope: string;
  sourceProfile: string;
  targetProfile: string;
}

export interface PersonalMigrationPlan {
  profileKind: "personal";
  ownerSub: string;
  logicalScope: null;
  sourceProfile: string;
  targetProfile: string;
}

export type LegacyProfileMigrationPlan = ScopeMigrationPlan | PersonalMigrationPlan;

export interface MigrationMemory {
  id: string;
  content: string;
  sessionId: string | null;
}

export interface ScopeMigrationClient {
  listProfile(profileName: string): Promise<readonly MigrationMemory[]>;
  remember(
    profileName: string,
    memory: { content: string; sessionId: string | null },
  ): Promise<void>;
}

export interface ScopeMigrationResult {
  sourceCount: number;
  uniqueSourceCount: number;
  copied: number;
  alreadyPresent: number;
  verified: true;
}

/**
 * Build the only supported legacy scoped-profile migration direction.
 *
 * The source name exactly reproduces the pre-2.0 profile-name sanitization;
 * the destination is the new JWT-sub-bound name. Some source names are too
 * ambiguous to automate because they can overlap a personal or new-format
 * profile. Those cases must be investigated manually instead of guessed.
 */
export async function buildScopeMigrationPlan(
  ownerSub: string,
  logicalScope: string,
): Promise<ScopeMigrationPlan> {
  const normalizedOwnerSub = ownerSub.trim();
  const normalizedLogicalScope = logicalScope.trim();

  if (!normalizedOwnerSub) throw new Error("Owner JWT subject is required");
  if (!normalizedLogicalScope) throw new Error("Legacy logical scope is required");

  const sourceProfile = legacyProfileName(normalizedLogicalScope);
  const targetProfile = await resolveProfileName(normalizedOwnerSub, normalizedLogicalScope);

  if (
    sourceProfile === "default" ||
    LEGACY_PERSONAL_PROFILE_PATTERN.test(sourceProfile) ||
    USER_BOUND_PROFILE_PATTERN.test(sourceProfile)
  ) {
    throw new Error(
      `Legacy profile "${sourceProfile}" is ambiguous and cannot be migrated automatically`,
    );
  }

  if (sourceProfile === targetProfile) {
    throw new Error("Legacy source and user-bound target profiles must be different");
  }

  return {
    profileKind: "scoped",
    ownerSub: normalizedOwnerSub,
    logicalScope: normalizedLogicalScope,
    sourceProfile,
    targetProfile,
  };
}

/**
 * Build a migration plan for a pre-2.0 personal profile whose JWT subject is
 * not a UUID. UUID subjects already resolve to their legacy personal profile,
 * while non-UUID subjects now use a collision-resistant user-bound name.
 */
export async function buildPersonalMigrationPlan(
  ownerSub: string,
): Promise<PersonalMigrationPlan> {
  const normalizedOwnerSub = ownerSub.trim();
  if (!normalizedOwnerSub) throw new Error("Owner JWT subject is required");

  const sourceProfile = legacyProfileName(normalizedOwnerSub);
  const targetProfile = await resolveProfileName(normalizedOwnerSub, null);

  if (sourceProfile === targetProfile) {
    throw new Error("Legacy personal source and user-bound target profiles must be different");
  }

  if (
    sourceProfile === "default" ||
    LEGACY_PERSONAL_PROFILE_PATTERN.test(sourceProfile) ||
    USER_BOUND_PROFILE_PATTERN.test(sourceProfile)
  ) {
    throw new Error(
      `Legacy personal profile "${sourceProfile}" is ambiguous and cannot be migrated automatically`,
    );
  }

  return {
    profileKind: "personal",
    ownerSub: normalizedOwnerSub,
    logicalScope: null,
    sourceProfile,
    targetProfile,
  };
}

/**
 * Require the operator to attest that the complete legacy profile belongs to
 * one owner. Normal authenticated callers never receive this capability.
 */
export function assertExclusiveLegacyOwnership(
  plan: LegacyProfileMigrationPlan,
  confirmedOwnerSub: string,
): void {
  if (confirmedOwnerSub.trim() !== plan.ownerSub) {
    throw new Error(
      "Exclusive legacy-profile ownership must be confirmed with the exact owner JWT subject",
    );
  }
}

async function memoryFingerprint(memory: {
  content: string;
  sessionId: string | null;
}): Promise<string> {
  const encoded = new TextEncoder().encode(
    JSON.stringify(["memory-scope-copy-v1", memory.content, memory.sessionId]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fingerprintSet(
  memories: readonly MigrationMemory[],
): Promise<Set<string>> {
  const fingerprints = new Set<string>();
  for (const memory of memories) {
    fingerprints.add(await memoryFingerprint(memory));
  }
  return fingerprints;
}

/**
 * Copy active memories into a user-bound profile without deleting the source.
 *
 * Exact content/session duplicates are skipped, making an interrupted run safe
 * to retry. A non-empty target is accepted only when every target entry is
 * already part of the source snapshot; unknown target data requires manual
 * reconciliation before migration. A final read verifies every unique source
 * entry exists at the destination.
 */
export async function migrateLegacyScopedProfile(
  plan: LegacyProfileMigrationPlan,
  confirmedOwnerSub: string,
  client: ScopeMigrationClient,
): Promise<ScopeMigrationResult> {
  assertExclusiveLegacyOwnership(plan, confirmedOwnerSub);

  const source = await client.listProfile(plan.sourceProfile);
  if (source.length === 0) {
    throw new Error("Legacy source profile has no active memories; nothing was migrated");
  }
  const targetBefore = await client.listProfile(plan.targetProfile);
  const sourceFingerprints = await fingerprintSet(source);
  const targetFingerprints = await fingerprintSet(targetBefore);

  for (const fingerprint of targetFingerprints) {
    if (!sourceFingerprints.has(fingerprint)) {
      throw new Error(
        "Target profile contains data outside the legacy source; reconcile it manually before migration",
      );
    }
  }

  let copied = 0;
  let alreadyPresent = 0;
  const seenSource = new Set<string>();

  for (const memory of source) {
    const fingerprint = await memoryFingerprint(memory);
    if (seenSource.has(fingerprint) || targetFingerprints.has(fingerprint)) {
      alreadyPresent += 1;
      seenSource.add(fingerprint);
      continue;
    }

    await client.remember(plan.targetProfile, {
      content: memory.content,
      sessionId: memory.sessionId,
    });
    copied += 1;
    seenSource.add(fingerprint);
    targetFingerprints.add(fingerprint);
  }

  const sourceAfterFingerprints = await fingerprintSet(
    await client.listProfile(plan.sourceProfile),
  );
  if (
    sourceAfterFingerprints.size !== sourceFingerprints.size ||
    [...sourceFingerprints].some((fingerprint) => !sourceAfterFingerprints.has(fingerprint))
  ) {
    throw new Error("Legacy source changed during migration; keep traffic paused and retry");
  }

  const targetAfterFingerprints = await fingerprintSet(await client.listProfile(plan.targetProfile));
  for (const fingerprint of sourceFingerprints) {
    if (!targetAfterFingerprints.has(fingerprint)) {
      throw new Error("Destination verification failed; the legacy source was left untouched");
    }
  }

  return {
    sourceCount: source.length,
    uniqueSourceCount: sourceFingerprints.size,
    copied,
    alreadyPresent,
    verified: true,
  };
}

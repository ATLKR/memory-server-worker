import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPersonalMigrationPlan,
  buildScopeMigrationPlan,
  migrateLegacyScopedProfile,
  type MigrationMemory,
  type ScopeMigrationClient,
} from "./migration.ts";
import { legacyProfileName, resolveProfileName } from "./security.ts";

class FakeMigrationClient implements ScopeMigrationClient {
  readonly profiles = new Map<string, MigrationMemory[]>();
  rememberCalls = 0;
  discardWrites = false;
  mutateSourceOnSecondRead: { profileName: string; memory: MigrationMemory } | null = null;
  #readCounts = new Map<string, number>();

  async listProfile(profileName: string): Promise<readonly MigrationMemory[]> {
    const readCount = (this.#readCounts.get(profileName) ?? 0) + 1;
    this.#readCounts.set(profileName, readCount);
    if (
      readCount === 2 &&
      this.mutateSourceOnSecondRead?.profileName === profileName
    ) {
      const entries = this.profiles.get(profileName) ?? [];
      entries.push(this.mutateSourceOnSecondRead.memory);
      this.profiles.set(profileName, entries);
    }
    return structuredClone(this.profiles.get(profileName) ?? []);
  }

  async remember(
    profileName: string,
    memory: { content: string; sessionId: string | null },
  ): Promise<void> {
    this.rememberCalls += 1;
    if (this.discardWrites) return;
    const entries = this.profiles.get(profileName) ?? [];
    entries.push({ id: `copied-${this.rememberCalls}`, ...memory });
    this.profiles.set(profileName, entries);
  }
}

describe("legacy scoped-profile migration", () => {
  it("maps the old sanitized scope to the user-bound destination", async () => {
    const plan = await buildScopeMigrationPlan(" user-a ", " Team_Memory ");

    assert.equal(plan.ownerSub, "user-a");
    assert.equal(plan.logicalScope, "Team_Memory");
    assert.equal(plan.sourceProfile, legacyProfileName("Team_Memory"));
    assert.equal(plan.targetProfile, await resolveProfileName("user-a", "Team_Memory"));
    assert.notEqual(plan.sourceProfile, plan.targetProfile);
  });

  it("refuses source names that can overlap personal or new-format profiles", async () => {
    await assert.rejects(
      buildScopeMigrationPlan("user-a", "---"),
      /ambiguous.*cannot be migrated automatically/,
    );
    await assert.rejects(
      buildScopeMigrationPlan("user-a", "2ce0b53f-f7c0-4cee-a150-dd2616213d8f"),
      /ambiguous.*cannot be migrated automatically/,
    );
    await assert.rejects(
      buildScopeMigrationPlan("user-a", `user-${"a".repeat(64)}`),
      /ambiguous.*cannot be migrated automatically/,
    );
  });

  it("requires an exact exclusive-owner confirmation before reading data", async () => {
    const plan = await buildScopeMigrationPlan("user-a", "team-memory");
    const client = new FakeMigrationClient();

    await assert.rejects(
      migrateLegacyScopedProfile(plan, "user-b", client),
      /ownership must be confirmed/,
    );
    assert.equal(client.rememberCalls, 0);
  });

  it("copies exact content/session pairs, verifies them, and is retry-safe", async () => {
    const plan = await buildScopeMigrationPlan("user-a", "team-memory");
    const client = new FakeMigrationClient();
    const first = { id: "source-1", content: "Prefers concise answers", sessionId: "s-1" };
    const second = { id: "source-2", content: "Uses TypeScript", sessionId: null };
    client.profiles.set(plan.sourceProfile, [first, second, { ...first, id: "source-3" }]);
    client.profiles.set(plan.targetProfile, [{ ...first, id: "existing-1" }]);

    const firstRun = await migrateLegacyScopedProfile(plan, "user-a", client);
    assert.deepEqual(firstRun, {
      sourceCount: 3,
      uniqueSourceCount: 2,
      copied: 1,
      alreadyPresent: 2,
      verified: true,
    });
    assert.equal(client.rememberCalls, 1);
    assert.deepEqual(client.profiles.get(plan.sourceProfile), [
      first,
      second,
      { ...first, id: "source-3" },
    ]);

    const retry = await migrateLegacyScopedProfile(plan, "user-a", client);
    assert.equal(retry.copied, 0);
    assert.equal(retry.verified, true);
    assert.equal(client.rememberCalls, 1);
  });

  it("fails closed for an unrelated target or an unverifiable write", async () => {
    const plan = await buildScopeMigrationPlan("user-a", "team-memory");
    const contaminated = new FakeMigrationClient();
    contaminated.profiles.set(plan.sourceProfile, [
      { id: "source-1", content: "source", sessionId: null },
    ]);
    contaminated.profiles.set(plan.targetProfile, [
      { id: "target-1", content: "unrelated", sessionId: null },
    ]);
    await assert.rejects(
      migrateLegacyScopedProfile(plan, "user-a", contaminated),
      /contains data outside the legacy source/,
    );

    const broken = new FakeMigrationClient();
    broken.discardWrites = true;
    broken.profiles.set(plan.sourceProfile, [
      { id: "source-1", content: "source", sessionId: null },
    ]);
    await assert.rejects(
      migrateLegacyScopedProfile(plan, "user-a", broken),
      /Destination verification failed/,
    );

    const racing = new FakeMigrationClient();
    racing.profiles.set(plan.sourceProfile, [
      { id: "source-1", content: "source", sessionId: null },
    ]);
    racing.mutateSourceOnSecondRead = {
      profileName: plan.sourceProfile,
      memory: { id: "source-2", content: "late write", sessionId: null },
    };
    await assert.rejects(
      migrateLegacyScopedProfile(plan, "user-a", racing),
      /source changed during migration/,
    );
  });
});

describe("legacy personal-profile migration", () => {
  it("maps the operational non-UUID subject from its old sanitized profile", async () => {
    const ownerSub = "2KUUAVv0owg34VbAO4zpxtfhm0kRvKjO";
    const plan = await buildPersonalMigrationPlan(ownerSub);

    assert.equal(plan.profileKind, "personal");
    assert.equal(plan.ownerSub, ownerSub);
    assert.equal(plan.logicalScope, null);
    assert.equal(plan.sourceProfile, "2kuuavv0owg34vbao4zpxtfhm0krvkjo");
    assert.equal(plan.sourceProfile, legacyProfileName(ownerSub));
    assert.equal(plan.targetProfile, await resolveProfileName(ownerSub, null));
    assert.equal(
      plan.targetProfile,
      "user-459dd2abc870a038f5be1c22ca2f8b7a7bfbd61e00caa367bd08d7aa40c36c93",
    );
    assert.notEqual(plan.sourceProfile, plan.targetProfile);
  });

  it("refuses default, new-format, and unchanged personal profiles", async () => {
    await assert.rejects(
      buildPersonalMigrationPlan("---"),
      /ambiguous.*cannot be migrated automatically/,
    );
    await assert.rejects(
      buildPersonalMigrationPlan(`user-${"a".repeat(64)}`),
      /ambiguous.*cannot be migrated automatically/,
    );
    await assert.rejects(
      buildPersonalMigrationPlan("2ce0b53f-f7c0-4cee-a150-dd2616213d8f!"),
      /ambiguous.*cannot be migrated automatically/,
    );
    await assert.rejects(
      buildPersonalMigrationPlan("2ce0b53f-f7c0-4cee-a150-dd2616213d8f"),
      /source and user-bound target profiles must be different/,
    );
  });

  it("reuses exact ownership, copy-only, retry, and verification guarantees", async () => {
    const plan = await buildPersonalMigrationPlan("subject-without-a-uuid");
    const client = new FakeMigrationClient();
    const source = { id: "source-1", content: "Personal preference", sessionId: null };
    client.profiles.set(plan.sourceProfile, [source]);

    await assert.rejects(
      migrateLegacyScopedProfile(plan, "different-subject", client),
      /ownership must be confirmed/,
    );
    assert.equal(client.rememberCalls, 0);

    const result = await migrateLegacyScopedProfile(
      plan,
      "subject-without-a-uuid",
      client,
    );
    assert.deepEqual(result, {
      sourceCount: 1,
      uniqueSourceCount: 1,
      copied: 1,
      alreadyPresent: 0,
      verified: true,
    });
    assert.deepEqual(client.profiles.get(plan.sourceProfile), [source]);

    const retry = await migrateLegacyScopedProfile(
      plan,
      "subject-without-a-uuid",
      client,
    );
    assert.equal(retry.copied, 0);
    assert.equal(client.rememberCalls, 1);
  });
});

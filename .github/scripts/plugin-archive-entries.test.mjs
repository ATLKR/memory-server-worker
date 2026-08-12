import assert from "node:assert/strict";
import test from "node:test";

import { validateExactArchiveEntries } from "./plugin-archive-entries.mjs";

const expectedFiles = [
  ".codex-plugin/plugin.json",
  "LICENSE",
  "skills/capture/SKILL.md",
  "skills/recall/SKILL.md",
  "skills/remember/SKILL.md",
];

test("accepts the exact canonical archive entry set", () => {
  assert.deepEqual(
    validateExactArchiveEntries(`${expectedFiles.join("\r\n")}\r\n`, expectedFiles),
    expectedFiles,
  );
});

const rejectedListings = [
  {
    name: "additional entry",
    listing: [...expectedFiles, "unexpected.txt"],
    error: /entry set mismatch.*additional/i,
  },
  {
    name: "duplicate entry",
    listing: [...expectedFiles, expectedFiles[0]],
    error: /duplicate entry/i,
  },
  {
    name: "parent traversal",
    listing: [...expectedFiles, "../outside.txt"],
    error: /path traversal/i,
  },
  {
    name: "nested parent traversal",
    listing: [...expectedFiles, "skills/recall/../../outside.txt"],
    error: /path traversal/i,
  },
  {
    name: "POSIX absolute path",
    listing: [...expectedFiles, "/tmp/outside.txt"],
    error: /absolute/i,
  },
  {
    name: "Windows absolute path",
    listing: [...expectedFiles, "C:/tmp/outside.txt"],
    error: /absolute/i,
  },
  {
    name: "backslash path",
    listing: [...expectedFiles, "skills\\recall\\SKILL.md"],
    error: /backslash/i,
  },
  {
    name: "non-canonical path",
    listing: [...expectedFiles, "./unexpected.txt"],
    error: /canonical path/i,
  },
];

for (const fixture of rejectedListings) {
  test(`rejects ${fixture.name}`, () => {
    assert.throws(
      () => validateExactArchiveEntries(`${fixture.listing.join("\n")}\n`, expectedFiles),
      fixture.error,
    );
  });
}

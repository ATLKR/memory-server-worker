import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseTag } from "./validate-release-tag.mjs";

test("accepts only the v-prefixed package version", () => {
  assert.equal(validateReleaseTag("v2.1.0", "2.1.0"), "v2.1.0");
});

for (const tag of ["2.1.0", "v2.1.1", "v2.1.0-forged", "v9.9.9"]) {
  test(`rejects mismatched release tag ${tag}`, () => {
    assert.throws(
      () => validateReleaseTag(tag, "2.1.0"),
      /release tag\/version mismatch/i,
    );
  });
}

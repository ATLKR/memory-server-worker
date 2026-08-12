import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function validateReleaseTag(tag, version) {
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`Release tag/version mismatch: expected ${expected}, received ${tag}.`);
  }
  return expected;
}

export async function validateRepositoryReleaseTag(
  tag,
  root = process.cwd(),
) {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  return validateReleaseTag(tag, packageJson.version);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  const tag = process.argv[2];
  if (!tag) throw new Error("Usage: validate-release-tag.mjs <tag>");
  const expected = await validateRepositoryReleaseTag(tag);
  console.log(`Release tag ${expected} matches package.json.`);
}

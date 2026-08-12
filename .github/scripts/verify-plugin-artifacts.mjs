import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  ARCHIVE_ENTRIES,
  ARCHIVE_NAME,
  CHECKSUM_NAME,
  createDeterministicZip,
} from "./build-plugin-artifact.mjs";

const root = process.cwd();
const releaseVersion = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).version;

const packageLock = JSON.parse(
  await readFile(path.join(root, "package-lock.json"), "utf8"),
);
assert.equal(packageLock.version, releaseVersion, "package-lock.json version drift");
assert.equal(
  packageLock.packages?.[""]?.version,
  releaseVersion,
  "package-lock.json root package version drift",
);

const jsonVersionFiles = [
  "packages/memory-worker/package.json",
  "packages/memory-ui/package.json",
  "plugins/allenlim-memory-server/package.json",
  "plugins/allenlim-memory-server/.codex-plugin/plugin.json",
  "plugins/allenlim-memory-server/.claude-plugin/plugin.json",
  "plugins/allenlim-memory-server/.devin-plugin/plugin.json",
  "distributions/chatgpt/allenlim-memory-server/.codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

for (const relative of jsonVersionFiles) {
  const parsed = JSON.parse(await readFile(path.join(root, relative), "utf8"));
  assert.equal(parsed.version, releaseVersion, `${relative} version drift`);
}

for (const relative of [
  "packages/memory-worker",
  "packages/memory-ui",
  "plugins/allenlim-memory-server",
]) {
  assert.equal(
    packageLock.packages?.[relative]?.version,
    releaseVersion,
    `package-lock.json ${relative} version drift`,
  );
}

const marketplace = JSON.parse(
  await readFile(path.join(root, ".claude-plugin/marketplace.json"), "utf8"),
);
assert.equal(marketplace.name, "allenlim-plugins", "Claude marketplace name drift");
assert.equal(
  marketplace.plugins[0]?.name,
  "allenlim-memory-server",
  "Claude marketplace plugin name drift",
);
assert.equal(
  marketplace.plugins[0]?.source,
  "./plugins/allenlim-memory-server",
  "Claude marketplace plugin path drift",
);
assert.equal(
  marketplace.plugins[0]?.version,
  releaseVersion,
  "Claude marketplace plugin version drift",
);

const workerSource = await readFile(
  path.join(root, "packages/memory-worker/src/index.ts"),
  "utf8",
);
assert.match(
  workerSource,
  new RegExp(`version:\\s*"${releaseVersion.replaceAll(".", "\\.")}"`),
  "MCP server version drift",
);

const pluginLibrary = await readFile(
  path.join(root, "plugins/allenlim-memory-server/scripts/lib.mjs"),
  "utf8",
);
assert.match(
  pluginLibrary,
  new RegExp(`PLUGIN_VERSION\\s*=\\s*"${releaseVersion.replaceAll(".", "\\.")}"`),
  "plugin client version drift",
);

const codexMarketplace = JSON.parse(
  await readFile(path.join(root, ".agents/plugins/marketplace.json"), "utf8"),
);
assert.equal(codexMarketplace.name, "allenlim-plugins", "Codex marketplace name drift");
assert.equal(
  codexMarketplace.plugins[0]?.name,
  "allenlim-memory-server",
  "Codex marketplace plugin name drift",
);
assert.equal(
  codexMarketplace.plugins[0]?.source?.path,
  "./plugins/allenlim-memory-server",
  "Codex marketplace plugin path drift",
);

const pluginIdentityFiles = [
  "plugins/allenlim-memory-server/package.json",
  "plugins/allenlim-memory-server/.codex-plugin/plugin.json",
  "plugins/allenlim-memory-server/.claude-plugin/plugin.json",
  "plugins/allenlim-memory-server/.devin-plugin/plugin.json",
  "distributions/chatgpt/allenlim-memory-server/.codex-plugin/plugin.json",
];
for (const relative of pluginIdentityFiles) {
  const parsed = JSON.parse(await readFile(path.join(root, relative), "utf8"));
  assert.equal(parsed.name, "allenlim-memory-server", `${relative} name drift`);
}

const archive = path.join(root, ARCHIVE_NAME);
const archiveBytes = await readFile(archive);
const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
assert.equal(
  await readFile(path.join(root, CHECKSUM_NAME), "utf8"),
  `${archiveDigest}  ${ARCHIVE_NAME}\n`,
  "plugin ZIP checksum drift",
);
const sourceRoot = path.join(
  root,
  "distributions",
  "chatgpt",
  "allenlim-memory-server",
);
const expectedEntries = await Promise.all(
  ARCHIVE_ENTRIES.map(async (name) => ({
    name,
    contents: Buffer.from(
      (await readFile(path.join(sourceRoot, name), "utf8")).replaceAll(
        "\r\n",
        "\n",
      ),
      "utf8",
    ),
  })),
);
assert.deepEqual(
  archiveBytes,
  createDeterministicZip(expectedEntries),
  "plugin ZIP bytes drift from canonical distribution sources",
);

console.log(`Plugin artifacts verified at version ${releaseVersion}.`);

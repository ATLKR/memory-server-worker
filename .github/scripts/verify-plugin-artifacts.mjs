import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { validateExactArchiveEntries } from "./plugin-archive-entries.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const releaseVersion = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).version;

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

const archive = path.join(root, "allenlim-memory-server-chatgpt.zip");
const archiveTool = process.platform === "win32" ? "tar" : "unzip";
const listArgs = process.platform === "win32" ? ["-tf", archive] : ["-Z1", archive];
const { stdout: archiveEntries } = await execFileAsync(archiveTool, listArgs);
const expectedFiles = [
  ".codex-plugin/plugin.json",
  "skills/capture/SKILL.md",
  "skills/recall/SKILL.md",
  "skills/remember/SKILL.md",
];
validateExactArchiveEntries(archiveEntries, expectedFiles);
for (const relative of expectedFiles) {
  const extractArgs =
    process.platform === "win32"
      ? ["-xOf", archive, relative]
      : ["-p", archive, relative];
  const { stdout } = await execFileAsync(archiveTool, extractArgs, {
    encoding: "buffer",
    maxBuffer: 2 * 1024 * 1024,
  });
  const source = await readFile(
    path.join(root, "distributions/chatgpt/allenlim-memory-server", relative),
  );
  // Git normalizes these text files to LF, while a Windows working tree can
  // present CRLF. Compare their canonical text bytes so verification behaves
  // identically on developer machines and Linux CI.
  const digest = (value) =>
    createHash("sha256")
      .update(value.toString("utf8").replaceAll("\r\n", "\n"), "utf8")
      .digest("hex");
  assert.equal(digest(stdout), digest(source), `ZIP content drift: ${relative}`);
}

console.log(`Plugin artifacts verified at version ${releaseVersion}.`);

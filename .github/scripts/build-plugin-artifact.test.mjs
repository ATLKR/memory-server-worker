import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ARCHIVE_ENTRIES,
  ARCHIVE_NAME,
  CHECKSUM_NAME,
  buildPluginArtifact,
  createDeterministicZip,
} from "./build-plugin-artifact.mjs";

test("ZIP output is byte-for-byte deterministic regardless of input order", () => {
  const entries = [
    { name: "b.txt", contents: Buffer.from("second\n") },
    { name: "a.txt", contents: Buffer.from("first\n") },
  ];
  assert.deepEqual(
    createDeterministicZip(entries),
    createDeterministicZip([...entries].reverse()),
  );
});

test("ZIP entries use locale-independent UTF-8 byte ordering", () => {
  const archive = createDeterministicZip([
    { name: "z.txt", contents: Buffer.from("z") },
    { name: "A.txt", contents: Buffer.from("A") },
    { name: ".metadata", contents: Buffer.from("dot") },
  ]);
  const names = [];
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    names.push(archive.subarray(nameStart, nameStart + nameLength).toString("utf8"));
    offset = nameStart + nameLength + extraLength + compressedSize;
  }
  assert.deepEqual(names, [".metadata", "A.txt", "z.txt"]);
});

test("artifact builder normalizes line endings and writes a matching checksum", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-plugin-artifact-"));
  try {
    const sourceRoot = path.join(
      root,
      "distributions",
      "chatgpt",
      "allenlim-memory-server",
    );
    for (const [index, name] of ARCHIVE_ENTRIES.entries()) {
      const target = path.join(sourceRoot, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `entry ${index}\r\n`, "utf8");
    }

    const first = await buildPluginArtifact(root);
    const firstBytes = await readFile(path.join(root, ARCHIVE_NAME));
    const second = await buildPluginArtifact(root);
    const checksum = await readFile(path.join(root, CHECKSUM_NAME), "utf8");

    assert.deepEqual(second.archive, firstBytes);
    assert.equal(second.digest, first.digest);
    assert.equal(checksum, `${first.digest}  ${ARCHIVE_NAME}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

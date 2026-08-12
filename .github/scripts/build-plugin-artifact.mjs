import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { validateArchiveEntryNames } from "./plugin-archive-entries.mjs";

export const ARCHIVE_NAME = "allenlim-memory-server-chatgpt.zip";
export const CHECKSUM_NAME = `${ARCHIVE_NAME}.sha256`;
export const ARCHIVE_ENTRIES = [
  ".codex-plugin/plugin.json",
  "LICENSE",
  "skills/capture/SKILL.md",
  "skills/recall/SKILL.md",
  "skills/remember/SKILL.md",
];

const CRC32_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  CRC32_TABLE[value] = crc >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, contents) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc32(contents), 14);
  header.writeUInt32LE(contents.length, 18);
  header.writeUInt32LE(contents.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(name, contents, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(crc32(contents), 16);
  header.writeUInt32LE(contents.length, 20);
  header.writeUInt32LE(contents.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

export function createDeterministicZip(entries) {
  validateArchiveEntryNames(entries.map((entry) => entry.name));
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // Compare the UTF-8 bytes directly. localeCompare() can produce different
  // orders with different ICU builds or host locales, which would make the
  // release archive vary between developer machines and Linux CI.
  const sortedEntries = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")),
  );
  for (const entry of sortedEntries) {
    const name = Buffer.from(entry.name, "utf8");
    const contents = Buffer.from(entry.contents);
    const local = localHeader(name, contents);
    localParts.push(local, name, contents);
    centralParts.push(centralHeader(name, contents, offset), name);
    offset += local.length + name.length + contents.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

export async function buildPluginArtifact(root = process.cwd()) {
  const sourceRoot = path.join(
    root,
    "distributions",
    "chatgpt",
    "allenlim-memory-server",
  );
  const entries = await Promise.all(
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
  const archive = createDeterministicZip(entries);
  const digest = createHash("sha256").update(archive).digest("hex");
  await writeFile(path.join(root, ARCHIVE_NAME), archive);
  await writeFile(
    path.join(root, CHECKSUM_NAME),
    `${digest}  ${ARCHIVE_NAME}\n`,
    "utf8",
  );
  return { archive, digest };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const { digest } = await buildPluginArtifact();
  console.log(`Built ${ARCHIVE_NAME} (${digest}).`);
}

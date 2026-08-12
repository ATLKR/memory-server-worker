import path from "node:path";

function parseArchiveListing(listing) {
  if (typeof listing !== "string") {
    throw new TypeError("Archive listing must be a string");
  }

  let text = listing;
  if (text.endsWith("\r\n")) {
    text = text.slice(0, -2);
  } else if (text.endsWith("\n")) {
    text = text.slice(0, -1);
  }

  if (!text) return [];
  const entries = text.split(/\r?\n/);
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error("Archive contains an empty or newline-delimited entry name");
  }
  return entries;
}

/**
 * Validate an archive listing before extracting any entry from it.
 *
 * Every entry must already be a canonical relative POSIX path, appear once,
 * and match the expected file set exactly. This rejects path aliases that
 * different ZIP readers could otherwise interpret inconsistently.
 */
export function validateExactArchiveEntries(listing, expectedFiles) {
  const expected = new Set(expectedFiles);
  if (expected.size !== expectedFiles.length) {
    throw new TypeError("Expected archive entries must be unique");
  }

  const entries = validateArchiveEntryNames(parseArchiveListing(listing));
  const seen = new Set(entries);
  const missing = expectedFiles.filter((entry) => !seen.has(entry));
  const additional = [...seen].filter((entry) => !expected.has(entry));
  if (missing.length > 0 || additional.length > 0) {
    throw new Error(
      `Archive entry set mismatch (missing: ${JSON.stringify(missing)}, additional: ${JSON.stringify(additional)})`,
    );
  }

  return entries;
}

export function validateArchiveEntryNames(entries) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new TypeError("Archive entries must be an array of strings");
  }
  const seen = new Set();
  for (const entry of entries) {
    if (entry.includes("\\")) {
      throw new Error(`Archive entry uses a backslash: ${JSON.stringify(entry)}`);
    }
    if (entry.includes("\0")) {
      throw new Error(`Archive entry contains a NUL byte: ${JSON.stringify(entry)}`);
    }
    if (path.posix.isAbsolute(entry) || /^[A-Za-z]:\//.test(entry)) {
      throw new Error(`Archive entry is absolute: ${JSON.stringify(entry)}`);
    }

    const segments = entry.split("/");
    if (segments.includes("..")) {
      throw new Error(`Archive entry contains path traversal: ${JSON.stringify(entry)}`);
    }

    const normalized = path.posix.normalize(entry);
    if (normalized === "." || normalized !== entry) {
      throw new Error(`Archive entry is not a canonical path: ${JSON.stringify(entry)}`);
    }
    if (seen.has(normalized)) {
      throw new Error(`Archive contains a duplicate entry: ${JSON.stringify(normalized)}`);
    }
    seen.add(normalized);
  }
  return [...seen];
}

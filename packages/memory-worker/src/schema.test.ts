import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  addMemoryShape,
  ingestMemoryShape,
  MAX_INGEST_BYTES,
  MAX_INGEST_MESSAGES,
  MAX_MEMORY_CONTENT_BYTES,
  MAX_SEARCH_QUERY_BYTES,
  searchMemoryShape,
  utf8ByteLength,
} from "./schema.ts";

describe("UTF-8 field limits", () => {
  it("accepts and rejects memory content at the 32 KiB emoji boundary", () => {
    const exact = "\u{1f600}".repeat(MAX_MEMORY_CONTENT_BYTES / 4);
    assert.equal(utf8ByteLength(exact), MAX_MEMORY_CONTENT_BYTES);
    assert.equal(z.object(addMemoryShape).safeParse({ content: exact }).success, true);

    const over = `${exact}\u{1f600}`;
    assert.equal(utf8ByteLength(over), MAX_MEMORY_CONTENT_BYTES + 4);
    const result = z.object(addMemoryShape).safeParse({ content: over });
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, /UTF-8 limit/);
  });

  it("accepts and rejects search queries at the 1 KiB Korean boundary", () => {
    const exact = `${"\uac00".repeat(341)}a`;
    assert.equal(utf8ByteLength(exact), MAX_SEARCH_QUERY_BYTES);
    assert.equal(z.object(searchMemoryShape).safeParse({ query: exact }).success, true);

    const over = `${exact}\uac00`;
    assert.equal(utf8ByteLength(over), MAX_SEARCH_QUERY_BYTES + 3);
    assert.equal(z.object(searchMemoryShape).safeParse({ query: over }).success, false);
  });
});

describe("ingestMemoryShape", () => {
  it("accepts a normal conversation", () => {
    const result = ingestMemoryShape.messages.safeParse([
      { role: "user", content: "Remember that I prefer dark mode." },
      { role: "assistant", content: "Got it." },
    ]);
    assert.equal(result.success, true);
  });

  it("rejects excessive message counts", () => {
    const messages = Array.from({ length: MAX_INGEST_MESSAGES + 1 }, () => ({
      role: "user" as const,
      content: "x",
    }));
    assert.equal(ingestMemoryShape.messages.safeParse(messages).success, false);
  });

  it("rejects aggregate content larger than one MiB", () => {
    const content = "x".repeat(32_768);
    const messages = Array.from(
      { length: Math.floor(MAX_INGEST_BYTES / content.length) + 1 },
      () => ({ role: "user" as const, content }),
    );
    assert.equal(ingestMemoryShape.messages.safeParse(messages).success, false);
  });

  it("applies the per-message limit to UTF-8 bytes", () => {
    const exact = `${"\uac00".repeat(10_922)}ab`;
    assert.equal(utf8ByteLength(exact), MAX_MEMORY_CONTENT_BYTES);
    assert.equal(
      ingestMemoryShape.messages.safeParse([{ role: "user", content: exact }]).success,
      true,
    );
    assert.equal(
      ingestMemoryShape.messages.safeParse([
        { role: "user", content: `${exact}\uac00` },
      ]).success,
      false,
    );
  });

  it("counts emoji bytes toward the aggregate one MiB limit", () => {
    const content = "\u{1f600}".repeat(MAX_MEMORY_CONTENT_BYTES / 4);
    const exact = Array.from(
      { length: MAX_INGEST_BYTES / MAX_MEMORY_CONTENT_BYTES },
      () => ({ role: "user" as const, content }),
    );
    assert.equal(ingestMemoryShape.messages.safeParse(exact).success, true);
    assert.equal(
      ingestMemoryShape.messages.safeParse([
        ...exact,
        { role: "assistant", content: "a" },
      ]).success,
      false,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_MEMORY_CONTENT_BYTES,
  MAX_SEARCH_QUERY_BYTES,
  utf8ByteLength,
} from "./validation";

describe("UTF-8 request limits", () => {
  it("counts encoded bytes instead of JavaScript characters", () => {
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("한")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("keeps UI limits aligned with the API contract", () => {
    expect(MAX_SEARCH_QUERY_BYTES).toBe(1024);
    expect(MAX_MEMORY_CONTENT_BYTES).toBe(32 * 1024);
    expect(utf8ByteLength("한".repeat(342))).toBeGreaterThan(MAX_SEARCH_QUERY_BYTES);
  });
});

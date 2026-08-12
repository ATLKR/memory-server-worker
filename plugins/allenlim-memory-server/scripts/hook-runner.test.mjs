import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTranscript,
  trimMessagesForIngest,
  truncateUtf8,
} from "./hook-runner.mjs";

test("truncateUtf8 keeps a pre-prompt query within 1 KiB without splitting Unicode", () => {
  const exactPrefix = `${"\uac00".repeat(340)}\u{1f600}`;
  const truncated = truncateUtf8(`${exactPrefix}\uac00`, 1024);

  assert.equal(Buffer.byteLength(exactPrefix, "utf8"), 1024);
  assert.equal(Buffer.byteLength(truncated, "utf8"), 1024);
  assert.equal(truncated, exactPrefix);
});

test("parseTranscript ignores malformed JSONL rows and keeps valid messages", () => {
  const transcript = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "remember this" },
    }),
    "{this row is incomplete",
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "stored" },
          { type: "tool_use", name: "memory_add" },
          { type: "text", text: "successfully" },
        ],
      },
    }),
    JSON.stringify({ type: "progress", message: { content: "ignored" } }),
  ].join("\n");

  assert.deepEqual(parseTranscript(transcript), [
    { role: "user", content: "remember this" },
    { role: "assistant", content: "stored\nsuccessfully" },
  ]);
});

test("trimMessagesForIngest keeps the newest 100 valid messages", () => {
  const messages = Array.from({ length: 105 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`,
  }));

  const trimmed = trimMessagesForIngest(messages);

  assert.equal(trimmed.length, 100);
  assert.equal(trimmed[0].content, "message-5");
  assert.equal(trimmed.at(-1).content, "message-104");
});

test("trimMessagesForIngest truncates a message at 32 KiB on a UTF-8 boundary", () => {
  const trimmed = trimMessagesForIngest([
    { role: "user", content: "😀".repeat(9_000) },
  ]);

  assert.equal(trimmed.length, 1);
  assert.equal(Buffer.byteLength(trimmed[0].content, "utf8"), 32 * 1024);
  assert.equal(Array.from(trimmed[0].content).length, 8_192);
  assert.equal(trimmed[0].content, "😀".repeat(8_192));
});

test("trimMessagesForIngest keeps the newest messages within 1 MiB of UTF-8", () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${String(index).padStart(2, "0")}${"가".repeat(10_922)}`,
  }));

  const trimmed = trimMessagesForIngest(messages);
  const totalBytes = trimmed.reduce(
    (sum, message) => sum + Buffer.byteLength(message.content, "utf8"),
    0,
  );

  assert.equal(trimmed.length, 32);
  assert.equal(totalBytes, 1024 * 1024);
  assert.match(trimmed[0].content, /^08/);
  assert.match(trimmed.at(-1).content, /^39/);
});

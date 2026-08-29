import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMemoryClient,
  normalizeConfig,
  normalizeMessages,
  sessionIdFor,
  truncateUtf8,
} from "./index.js";

describe("OpenClaw memory adapter", () => {
  it("defaults to the group-chat application partition", () => {
    assert.equal(normalizeConfig().application, "OpenClaw Group Chat");
  });

  it("normalizes transcript messages and drops tool records", () => {
    assert.deepEqual(normalizeMessages([
      { role: "user", content: "hello" },
      { role: "tool", content: "secret tool output" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]), [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("creates stable bounded session identifiers", () => {
    assert.equal(sessionIdFor("agent:main:test"), sessionIdFor("agent:main:test"));
    assert.match(sessionIdFor("agent:main:test"), /^oc-[a-f0-9]{32}$/);
  });

  it("enforces UTF-8 query and transcript limits", () => {
    assert.ok(Buffer.byteLength(truncateUtf8("한".repeat(1000), 1024), "utf8") <= 1024);
    const normalized = normalizeMessages(
      Array.from({ length: 100 }, () => ({ role: "user", content: "한".repeat(20_000) })),
    );
    assert.ok(
      normalized.reduce((total, message) => total + Buffer.byteLength(message.content), 0)
        <= 1024 * 1024,
    );
  });

  it("sends the application designator on every MCP call", async () => {
    let request;
    const client = createMemoryClient(normalizeConfig(), {
      readCredential: async () => `memory_pat_${"A".repeat(43)}`,
      fetchImpl: async (_url, init) => {
        request = init;
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            content: [{ type: "text", text: JSON.stringify({ count: 0 }) }],
            structuredContent: { count: 0 },
          },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    await client.call("memory_search", { query: "test" });
    assert.equal(
      new Headers(request.headers).get("x-memory-application"),
      "OpenClaw Group Chat",
    );
  });
});

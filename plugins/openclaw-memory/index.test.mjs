import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMemoryClient,
  normalizeConfig,
  normalizeMessages,
  sessionIdFor,
  truncateUtf8,
} from "./index.js";

function testConfig(overrides = {}) {
  return normalizeConfig({
    credentialCommand: "/test/memory-pat",
    ...overrides,
  });
}

describe("OpenClaw memory adapter", () => {
  it("defaults to the group-chat application partition", () => {
    assert.equal(testConfig().application, "OpenClaw Group Chat");
    assert.equal(
      testConfig({ serverUrl: `https://memory.allenlim.net${"/".repeat(10_000)}` })
        .serverUrl,
      "https://memory.allenlim.net",
    );
  });

  it("rejects missing credential commands and insecure remote URLs", () => {
    assert.throws(() => normalizeConfig(), /credentialCommand is required/);
    assert.throws(
      () => testConfig({ serverUrl: "http://memory.example.com" }),
      /must use HTTPS/,
    );
    assert.equal(
      testConfig({ serverUrl: "http://127.0.0.1:8787/" }).serverUrl,
      "http://127.0.0.1:8787",
    );
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
    const client = createMemoryClient(testConfig(), {
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

  it("bounds explicit search queries to the worker's UTF-8 limit", async () => {
    let requestBody;
    const client = createMemoryClient(testConfig(), {
      readCredential: async () => `memory_pat_${"A".repeat(43)}`,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
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

    await client.call("memory_search", { query: "한".repeat(1000) });

    assert.ok(
      Buffer.byteLength(requestBody.params.arguments.query, "utf8") <= 1024,
    );
  });

  it("aborts stalled MCP requests at the configured timeout", async () => {
    const client = createMemoryClient(testConfig({ requestTimeoutMs: 100 }), {
      readCredential: async () => `memory_pat_${"A".repeat(43)}`,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), {
          once: true,
        });
      }),
    });

    await assert.rejects(
      client.call("memory_search", { query: "timeout" }),
      (error) => error?.name === "TimeoutError",
    );
  });
});

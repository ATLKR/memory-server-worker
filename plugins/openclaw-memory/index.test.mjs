import assert from "node:assert/strict";
import { describe, it } from "node:test";
import plugin, {
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
  it("rejects multiline credential output without exposing the PAT in header errors", async () => {
    const credential = `memory_pat_${"A".repeat(43)}`;
    let requests = 0;
    const client = createMemoryClient(testConfig({
      credentialCommand: process.execPath,
      credentialArgs: ["-e", `process.stdout.write(${JSON.stringify(`${credential}\ncommand notice`)})`],
    }), {
      fetchImpl: async (url, init) => {
        requests += 1;
        new Request(url, init);
        throw new Error("Invalid credential reached the transport");
      },
    });

    await assert.rejects(client.call("memory_search", { query: "test" }), (error) => {
      assert.ok(!error.message.includes(credential));
      assert.match(error.message, /invalid credential/i);
      return true;
    });
    assert.equal(requests, 0);
  });

  it("does not expose failed credential-command output or arguments", async () => {
    const credential = `memory_pat_${"B".repeat(43)}`;
    const client = createMemoryClient(testConfig({
      credentialCommand: process.execPath,
      credentialArgs: ["-e", `process.stderr.write(${JSON.stringify(credential)}); process.exit(1)`],
    }));

    await assert.rejects(client.call("memory_search", { query: "test" }), (error) => {
      assert.ok(!String(error.stack).includes(credential));
      assert.ok(!JSON.stringify(error).includes(credential));
      assert.match(error.message, /credential command.*failed/i);
      return true;
    });
  });

  it("keeps credential-bearing transport errors out of automatic hook logs", async (t) => {
    const credential = `memory_pat_${"C".repeat(43)}`;
    const warnings = [];
    const hooks = new Map();
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      throw new Error(`invalid Authorization header: Bearer ${credential}`);
    });
    plugin.register({
      pluginConfig: testConfig({
        credentialCommand: process.execPath,
        credentialArgs: ["-e", `process.stdout.write(${JSON.stringify(credential)})`],
      }),
      registerMemoryCapability() {},
      registerTool() {},
      on: (name, handler) => hooks.set(name, handler),
      logger: { warn: (message) => warnings.push(message) },
    });

    await hooks.get("before_prompt_build")({ prompt: "test" });
    await hooks.get("agent_end")({
      success: true,
      messages: [{ role: "user", content: "test" }],
    }, { sessionKey: "test-session" });

    assert.equal(requests, 2);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((message) => !message.includes(credential)));
  });

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
        const watchdog = setTimeout(
          () => reject(new Error("MCP request did not abort")),
          1_000,
        );
        init.signal.addEventListener("abort", () => {
          clearTimeout(watchdog);
          reject(init.signal.reason);
        }, { once: true });
      }),
    });

    await assert.rejects(
      client.call("memory_search", { query: "timeout" }),
      (error) => error?.name === "TimeoutError",
    );
  });
});

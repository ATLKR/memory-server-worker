import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";

import {
  callTool,
  getMemoryDestinationFingerprint,
  getRequestTimeoutMs,
} from "./lib.mjs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const originalFetch = globalThis.fetch;
const managedEnvironment = [
  "MEMORY_API_KEY",
  "MEMORY_REQUEST_TIMEOUT_MS",
  "MEMORY_SCOPE",
  "MEMORY_SERVER_URL",
  "MEMORY_TOKEN",
];
const originalEnvironment = Object.fromEntries(
  managedEnvironment.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  for (const name of managedEnvironment) delete process.env[name];
  process.env.MEMORY_TOKEN = "test-jwt";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of managedEnvironment) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function captureSingleRequest(response) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return response;
  };
  return requests;
}

function assertToolsCallRequest(requests, expectedName, expectedArguments) {
  assert.equal(requests.length, 1, "callTool must issue exactly one request");

  const [{ url, init }] = requests;
  assert.equal(url, "https://memory.allenlim.net/mcp");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");

  const requestHeaders = new Headers(init.headers);
  assert.equal(requestHeaders.get("authorization"), "Bearer test-jwt");
  assert.equal(requestHeaders.get("x-memory-api-key"), null);
  assert.equal(requestHeaders.get("accept"), "application/json, text/event-stream");
  assert.equal(requestHeaders.get("content-type"), "application/json");
  assert.equal(requestHeaders.get("mcp-protocol-version"), "2025-11-25");
  assert.equal(
    requestHeaders.get("user-agent"),
    `allenlim-memory-server/${packageJson.version}`,
  );

  assert.deepEqual(JSON.parse(init.body), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: expectedName,
      arguments: expectedArguments,
    },
  });
}

test("callTool sends one authenticated tools/call POST and parses JSON", async () => {
  const requests = captureSingleRequest(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            { type: "text", text: "first" },
            { type: "image", data: "ignored" },
            { type: "text", text: "second" },
          ],
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );

  const result = await callTool("memory_search", { query: "project context" });

  assert.equal(result, "first\nsecond");
  assertToolsCallRequest(requests, "memory_search", {
    query: "project context",
  });
});

test("callTool parses an SSE tools/call response without another request", async () => {
  const eventPayload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "from sse" }] },
  });
  const requests = captureSingleRequest(
    new Response(`event: message\ndata: not-json\n\ndata: ${eventPayload}\n\n`, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
  );

  const result = await callTool("memory_stats", {});

  assert.equal(result, "from sse");
  assertToolsCallRequest(requests, "memory_stats", {});
});

test("MEMORY_API_KEY takes precedence and omits JWT and scope headers", async () => {
  process.env.MEMORY_API_KEY = "  api-secret  ";
  process.env.MEMORY_SCOPE = "must-not-leak";
  const requests = captureSingleRequest(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "ok" }] },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );

  assert.equal(await callTool("memory_stats"), "ok");

  const requestHeaders = new Headers(requests[0].init.headers);
  assert.equal(requestHeaders.get("x-memory-api-key"), "api-secret");
  assert.equal(requestHeaders.get("authorization"), null);
  assert.equal(requestHeaders.get("x-memory-scope"), null);
});

test("JWT auth sends a dynamic optional memory scope", async () => {
  process.env.MEMORY_SCOPE = "project-a";
  const requests = captureSingleRequest(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [] },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );

  await callTool("memory_stats");

  assert.equal(
    new Headers(requests[0].init.headers).get("x-memory-scope"),
    "project-a",
  );
});

test("callTool rejects a JSON-RPC error before reading result content", async () => {
  captureSingleRequest(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "upstream failed" },
        result: { content: [{ type: "text", text: "must not succeed" }] },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );

  await assert.rejects(
    callTool("memory_add", { content: "test" }),
    /MCP error -32603: upstream failed/,
  );
});

test("callTool rejects an MCP tool result marked isError", async () => {
  captureSingleRequest(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: "memory write failed" }],
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );

  await assert.rejects(
    callTool("memory_add", { content: "test" }),
    /memory write failed/,
  );
});

test("callTool rejects malformed JSON and malformed tool results", async () => {
  captureSingleRequest(
    new Response("not-json", {
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(callTool("memory_stats"), /Malformed MCP response/);

  captureSingleRequest(
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(callTool("memory_stats"), /missing tool result content/);

  captureSingleRequest(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 999,
        result: { content: [] },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await assert.rejects(callTool("memory_stats"), /mismatched request id/);
});

test("request timeout is bounded and aborts a stalled call", async () => {
  process.env.MEMORY_REQUEST_TIMEOUT_MS = "1";
  assert.equal(getRequestTimeoutMs(), 100);
  process.env.MEMORY_REQUEST_TIMEOUT_MS = "999999";
  assert.equal(getRequestTimeoutMs(), 60_000);
  process.env.MEMORY_REQUEST_TIMEOUT_MS = "100";

  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      });
    });

  await assert.rejects(
    callTool("memory_stats"),
    /Memory request timed out after 100 ms/,
  );
});

test("cross-origin redirects never receive API-key or JWT credentials", async () => {
  for (const status of [301, 302, 307, 308]) {
    for (const authMode of ["api-key", "jwt"]) {
      process.env.MEMORY_TOKEN = "redirect-test-jwt";
      process.env.MEMORY_SCOPE = "private-scope";
      if (authMode === "api-key") {
        process.env.MEMORY_API_KEY = "redirect-test-api-key";
      } else {
        delete process.env.MEMORY_API_KEY;
      }

      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url, init });
        return new Response(null, {
          status,
          headers: { location: "https://attacker.invalid/collect" },
        });
      };

      await assert.rejects(
        callTool("memory_stats"),
        /refused a cross-origin redirect/,
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://memory.allenlim.net/mcp");
      assert.equal(requests[0].init.redirect, "manual");
      assert.equal(
        requests.some(({ url }) => String(url).includes("attacker.invalid")),
        false,
      );

      const requestHeaders = new Headers(requests[0].init.headers);
      if (authMode === "api-key") {
        assert.equal(
          requestHeaders.get("x-memory-api-key"),
          "redirect-test-api-key",
        );
        assert.equal(requestHeaders.get("authorization"), null);
        assert.equal(requestHeaders.get("x-memory-scope"), null);
      } else {
        assert.equal(
          requestHeaders.get("authorization"),
          "Bearer redirect-test-jwt",
        );
        assert.equal(requestHeaders.get("x-memory-api-key"), null);
        assert.equal(requestHeaders.get("x-memory-scope"), "private-scope");
      }
    }
  }
});

test("same-origin redirects preserve the authenticated POST safely", async () => {
  process.env.MEMORY_SCOPE = "same-origin-scope";
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) {
      return new Response(null, {
        status: 308,
        headers: { location: "/mcp-v2" },
      });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "redirected" }] },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

  assert.equal(await callTool("memory_stats"), "redirected");
  assert.deepEqual(
    requests.map(({ url }) => url),
    ["https://memory.allenlim.net/mcp", "https://memory.allenlim.net/mcp-v2"],
  );
  for (const { init } of requests) {
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer test-jwt",
    );
    assert.equal(
      new Headers(init.headers).get("x-memory-scope"),
      "same-origin-scope",
    );
  }
});

test("same-origin redirect loops are capped", async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(null, {
      status: 307,
      headers: { location: `/redirect-${requests.length}` },
    });
  };

  await assert.rejects(callTool("memory_stats"), /redirect limit/);
  assert.equal(requests.length, 4);
  assert.equal(
    requests.every(({ url }) => new URL(url).origin === "https://memory.allenlim.net"),
    true,
  );
});

test("MCP and HTTP error details are bounded to roughly 4 KiB", async () => {
  const huge = "secret-upstream-detail-".repeat(1_000);
  const responses = [
    new Response(huge, { status: 500 }),
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: huge, data: huge },
      }),
      { headers: { "content-type": "application/json" } },
    ),
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: huge }],
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  ];

  for (const response of responses) {
    captureSingleRequest(response);
    await assert.rejects(callTool("memory_stats"), (error) => {
      assert.equal(Buffer.byteLength(error.message, "utf8") <= 4_200, true);
      assert.equal(error.message.includes(huge), false);
      return true;
    });
  }
});

test("destination fingerprints partition server, auth identity, and JWT scope", () => {
  const jwtFor = (subject, nonce) =>
    `header.${Buffer.from(JSON.stringify({ sub: subject, nonce })).toString("base64url")}.signature`;

  process.env.MEMORY_TOKEN = jwtFor("stable-user", "first");
  process.env.MEMORY_SCOPE = "scope-a";
  const first = getMemoryDestinationFingerprint();
  assert.match(first, /^[a-f0-9]{64}$/);

  process.env.MEMORY_TOKEN = jwtFor("stable-user", "refreshed-token");
  assert.equal(getMemoryDestinationFingerprint(), first);

  process.env.MEMORY_SCOPE = "scope-b";
  assert.notEqual(getMemoryDestinationFingerprint(), first);

  process.env.MEMORY_SCOPE = "scope-a";
  process.env.MEMORY_SERVER_URL = "https://other-memory.example";
  assert.notEqual(getMemoryDestinationFingerprint(), first);

  process.env.MEMORY_SERVER_URL = "https://memory.allenlim.net";
  process.env.MEMORY_API_KEY = "api-key-a";
  const apiKeyA = getMemoryDestinationFingerprint();
  process.env.MEMORY_SCOPE = "ignored-for-api-key";
  assert.equal(getMemoryDestinationFingerprint(), apiKeyA);
  process.env.MEMORY_API_KEY = "api-key-b";
  assert.notEqual(getMemoryDestinationFingerprint(), apiKeyA);
});

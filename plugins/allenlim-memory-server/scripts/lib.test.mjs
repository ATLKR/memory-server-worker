import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";

import { callTool } from "./lib.mjs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const originalFetch = globalThis.fetch;
const originalToken = process.env.MEMORY_TOKEN;

beforeEach(() => {
  process.env.MEMORY_TOKEN = "test-jwt";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.MEMORY_TOKEN;
  } else {
    process.env.MEMORY_TOKEN = originalToken;
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

  const requestHeaders = new Headers(init.headers);
  assert.equal(requestHeaders.get("authorization"), "Bearer test-jwt");
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

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const API_KEY = "a".repeat(32);
const PAT = `memory_pat_${"b".repeat(43)}`;

test("stdio bridge forwards JSON-RPC with API-key auth and preserves ids", async (context) => {
  let received;
  const server = createServer(async (request, response) => {
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(await collectRequest(request)),
      key: request.headers["x-memory-api-key"],
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: received.body.id,
      result: { tools: [] },
    }));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listenOrigin(server);
  const request = {
    jsonrpc: "2.0",
    id: "devin-request-1",
    method: "tools/list",
    params: {},
  };

  const result = await runBridge(`${JSON.stringify(request)}\n`, {
    MEMORY_API_KEY: API_KEY,
    MEMORY_SERVER_URL: origin,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    jsonrpc: "2.0",
    id: request.id,
    result: { tools: [] },
  });
  assert.equal(received.key, API_KEY);
  assert.equal(received.authorization, undefined);
  assert.deepEqual(received.body, request);
});

test("stdio bridge sends a PAT only as a prefixed Bearer credential", async (context) => {
  let headers;
  const server = createServer(async (request, response) => {
    headers = request.headers;
    const body = JSON.parse(await collectRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listenOrigin(server);

  const result = await runBridge(
    `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`,
    { MEMORY_PAT: PAT, MEMORY_SERVER_URL: origin },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(headers.authorization, `Bearer ${PAT}`);
  assert.equal(headers["x-memory-api-key"], undefined);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(PAT));
});

test("stdio bridge does not answer successful JSON-RPC notifications", async (context) => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls += 1;
    await collectRequest(request);
    response.writeHead(202, { "content-type": "application/json" });
    response.end();
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listenOrigin(server);

  const result = await runBridge(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    { MEMORY_API_KEY: API_KEY, MEMORY_SERVER_URL: origin },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(calls, 1);
});

test("stdio bridge forwards JSON-RPC request batches", async (context) => {
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await collectRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body.map((entry) => ({
      jsonrpc: "2.0",
      id: entry.id,
      result: { ok: true },
    }))));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listenOrigin(server);
  const request = [
    { jsonrpc: "2.0", id: "one", method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];

  const result = await runBridge(`${JSON.stringify(request)}\n`, {
    MEMORY_API_KEY: API_KEY,
    MEMORY_SERVER_URL: origin,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map((entry) => entry.id), ["one", 2]);
});

test("stdio bridge returns bounded protocol errors without leaking upstream content", async (context) => {
  const server = createServer(async (request, response) => {
    await collectRequest(request);
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(`upstream diagnostic accidentally contained ${PAT}`);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listenOrigin(server);
  const inputs = [
    "{not-json}\n",
    `${JSON.stringify({ hello: "world" })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 8, result: {} })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`,
  ].join("");

  const result = await runBridge(inputs, {
    MEMORY_PAT: PAT,
    MEMORY_SERVER_URL: origin,
  });

  assert.equal(result.code, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    responses.map((response) => response.error.code),
    [-32700, -32600, -32600, -32603],
  );
  assert.equal(responses[3].id, 9);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(PAT));
});

test("stdio bridge maps an upstream batch failure only to request ids", async (context) => {
  const server = createServer(async (request, response) => {
    await collectRequest(request);
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("unavailable");
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listenOrigin(server);
  const request = [
    { jsonrpc: "2.0", id: "one", method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];

  const result = await runBridge(`${JSON.stringify(request)}\n`, {
    MEMORY_API_KEY: API_KEY,
    MEMORY_SERVER_URL: origin,
  });

  assert.equal(result.code, 0);
  const responses = JSON.parse(result.stdout);
  assert.deepEqual(responses.map((response) => response.id), ["one", 2]);
  assert.ok(responses.every((response) => response.error.code === -32603));
});

test("stdio bridge rejects a message above the four MiB transport bound", async () => {
  const oversized = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { value: "x".repeat(4 * 1024 * 1024) },
  })}\n`;
  const result = await runBridge(oversized, { MEMORY_API_KEY: API_KEY });

  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.error.code, -32600);
  assert.equal(response.id, null);
});

test("stdio bridge rejects non-UTF-8 input as a parse error", async () => {
  const result = await runBridge(
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
    { MEMORY_API_KEY: API_KEY },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, -32700);
});

function runBridge(input, environment) {
  const testHome = join(
    tmpdir(),
    `memory-mcp-stdio-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const cleanEnvironment = { ...process.env };
  for (const name of ["MEMORY_API_KEY", "MEMORY_PAT", "MEMORY_TOKEN", "MEMORY_SCOPE"]) {
    delete cleanEnvironment[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./mcp-stdio.mjs", import.meta.url))],
      {
        env: {
          ...cleanEnvironment,
          HOME: testHome,
          USERPROFILE: testHome,
          MEMORY_REQUEST_TIMEOUT_MS: "2000",
          ...environment,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
    child.stdin.end(input);
  });
}

function listenOrigin(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function collectRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

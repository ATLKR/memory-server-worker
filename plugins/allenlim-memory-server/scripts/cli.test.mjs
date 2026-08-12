import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("CLI exits nonzero when an MCP result reports isError", async (context) => {
  const server = createServer((request, response) => {
    assert.equal(request.headers["x-memory-api-key"], "test-api-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: "simulated tool failure" }],
        },
      }),
    );
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  const result = await runCli(["stats"], {
    MEMORY_API_KEY: "test-api-key",
    MEMORY_REQUEST_TIMEOUT_MS: "2000",
    MEMORY_SERVER_URL: `http://127.0.0.1:${address.port}`,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Error: simulated tool failure/);
  assert.equal(result.stdout, "");
});

test("post-turn hook remains fail-open when an MCP ingest fails", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: "simulated ingest failure" }],
        },
      }),
    );
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  const result = await runNodeScript(
    "post-turn.mjs",
    [],
    {
      MEMORY_API_KEY: "test-api-key",
      MEMORY_REQUEST_TIMEOUT_MS: "2000",
      MEMORY_SERVER_URL: `http://127.0.0.1:${address.port}`,
    },
    JSON.stringify({
      messages: [{ role: "user", content: "remember this" }],
    }),
  );

  assert.equal(result.code, 0);
  assert.match(result.stderr, /simulated ingest failure/);
});

test("post-turn falls back to direct messages when transcript setup fails", async (context) => {
  let receivedBody;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "captured" }] },
        }),
      );
    });
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  const result = await runNodeScript(
    "post-turn.mjs",
    [],
    {
      MEMORY_API_KEY: "test-api-key",
      MEMORY_REQUEST_TIMEOUT_MS: "2000",
      MEMORY_SERVER_URL: `http://127.0.0.1:${address.port}`,
    },
    JSON.stringify({
      transcript_path: join(
        tmpdir(),
        `missing-memory-transcript-${process.pid}-${Date.now()}.jsonl`,
      ),
      messages: [
        { role: "user", content: "fallback user message" },
        { role: "assistant", content: "fallback assistant message" },
      ],
    }),
  );

  assert.equal(result.code, 0);
  assert.match(result.stderr, /Could not process the transcript/);
  assert.deepEqual(receivedBody.params.arguments.messages, [
    { role: "user", content: "fallback user message" },
    { role: "assistant", content: "fallback assistant message" },
  ]);
});

function runCli(arguments_, environment) {
  return runNodeScript("cli.mjs", arguments_, environment);
}

function runNodeScript(scriptName, arguments_, environment, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL(`./${scriptName}`, import.meta.url)), ...arguments_],
      {
        env: { ...process.env, ...environment },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
    child.stdin.end(input);
  });
}

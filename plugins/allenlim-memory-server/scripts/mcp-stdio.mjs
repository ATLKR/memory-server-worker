#!/usr/bin/env node

/**
 * Secret-free Devin MCP bridge.
 *
 * Devin speaks newline-delimited JSON-RPC over stdio. This process forwards
 * each message to the remote Memory MCP endpoint and obtains authentication
 * only through lib.mjs. In the recommended setup, Proton Pass injects
 * MEMORY_API_KEY or MEMORY_PAT into this process at launch; neither the Devin
 * config nor this protocol stream contains the credential.
 */

import { proxyMcpRequest } from "./lib.mjs";

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

async function main() {
  let parts = [];
  let bufferedBytes = 0;
  let discardingOversizedMessage = false;

  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let segmentStart = 0;

    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(segmentStart, index);
      if (discardingOversizedMessage) {
        await writeJsonRpcError(null, -32600, "Invalid Request");
      } else if (appendSegment(parts, segment, bufferedBytes)) {
        bufferedBytes += segment.length;
        await handleLine(Buffer.concat(parts, bufferedBytes));
      } else {
        await writeJsonRpcError(null, -32600, "Invalid Request");
      }
      parts = [];
      bufferedBytes = 0;
      discardingOversizedMessage = false;
      segmentStart = index + 1;
    }

    const tail = chunk.subarray(segmentStart);
    if (discardingOversizedMessage) continue;
    if (appendSegment(parts, tail, bufferedBytes)) {
      bufferedBytes += tail.length;
    } else {
      parts = [];
      bufferedBytes = 0;
      discardingOversizedMessage = true;
    }
  }

  if (discardingOversizedMessage) {
    await writeJsonRpcError(null, -32600, "Invalid Request");
  } else if (bufferedBytes > 0) {
    await handleLine(Buffer.concat(parts, bufferedBytes));
  }
}

function appendSegment(parts, segment, previousBytes) {
  if (previousBytes + segment.length > MAX_MESSAGE_BYTES) return false;
  if (segment.length > 0) parts.push(segment);
  return true;
}

async function handleLine(lineBytes) {
  if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
  if (lineBytes.length === 0) return;

  let message;
  try {
    message = JSON.parse(UTF8_DECODER.decode(lineBytes));
  } catch {
    await writeJsonRpcError(null, -32700, "Parse error");
    return;
  }

  if (!isJsonRpcMessage(message)) {
    await writeJsonRpcError(null, -32600, "Invalid Request");
    return;
  }

  try {
    const response = await proxyMcpRequest(message);
    if (response !== null) await writeProtocolMessage(response);
  } catch {
    // Notifications do not receive JSON-RPC responses. Keep diagnostics
    // deliberately generic so an upstream body can never disclose a secret.
    process.stderr.write("Memory MCP upstream request failed.\n");
    await writeUpstreamError(message);
  }
}

function isJsonRpcMessage(value) {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isJsonRpcRequest);
  }
  return isJsonRpcRequest(value);
}

function isJsonRpcRequest(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    value.method.length > 0 &&
    (!Object.hasOwn(value, "id") ||
      typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null),
  );
}

async function writeUpstreamError(message) {
  if (!Array.isArray(message)) {
    if (Object.hasOwn(message, "id")) {
      await writeJsonRpcError(message.id, -32603, "Memory MCP upstream request failed");
    }
    return;
  }

  const errors = message
    .filter((entry) => Object.hasOwn(entry, "id"))
    .map((entry) => ({
      jsonrpc: "2.0",
      id: entry.id,
      error: { code: -32603, message: "Memory MCP upstream request failed" },
    }));
  if (errors.length > 0) await writeProtocolMessage(errors);
}

async function writeJsonRpcError(id, code, message) {
  await writeProtocolMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function writeProtocolMessage(message) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

main().catch(() => {
  process.stderr.write("Memory MCP stdio bridge stopped unexpectedly.\n");
  process.exitCode = 1;
});

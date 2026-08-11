/**
 * Shared library for talking to the memory-server-worker MCP endpoint.
 *
 * Used by the hook scripts (pre-prompt, post-turn) and the CLI helper.
 * All requests go over HTTP to the deployed (or local) Worker's /mcp route
 * using the MCP "tools/call" JSON-RPC method.
 *
 * Auth: RS256 JWT obtained via the Allen Labs auth server SSO flow.
 * The JWT is stored in a local credential file (~/.memory/credentials.json)
 * after `mem login`. It's sent as `Authorization: Bearer <jwt>`.
 *
 * Configuration via environment variables:
 *   MEMORY_SERVER_URL  — base URL of the worker (e.g. https://memory.example.workers.dev)
 *   MEMORY_TOKEN       — JWT bearer token (overrides credential file; for CI/headless)
 *   MEMORY_SCOPE       — optional scope header (defaults to JWT sub or worker's DEFAULT_SCOPE)
 *   MEMORY_AUTH_API_URL — auth API URL for login (defaults to https://auth-api.allen.company)
 *
 * Credential file (~/.memory/credentials.json):
 *   { "token": "<jwt>", "expiresAt": "<iso>", "user": { "id": "...", "email": "..." } }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_PATH = join(homedir(), ".memory", "credentials.json");

const SERVER_URL = (process.env.MEMORY_SERVER_URL ?? "https://memory.allenlim.net").replace(/\/$/, "");
const AUTH_API_URL = (process.env.MEMORY_AUTH_API_URL ?? "https://auth-api.allen.company").replace(/\/$/, "");
const SCOPE = process.env.MEMORY_SCOPE ?? "";

if (!SERVER_URL) {
  console.error(
    "[memory-plugin] MEMORY_SERVER_URL is not set. " +
      "Set it in your environment or .env file.",
  );
}

/**
 * Load the stored JWT from the credential file. Returns null if the file
 * doesn't exist or the token is expired. Sets `TOKEN_EXPIRED` flag when
 * the token exists but is expired, so callers can give a helpful message.
 */
let TOKEN_EXPIRED = false;

function loadStoredToken() {
  TOKEN_EXPIRED = false;
  // Env var takes precedence (for CI/headless use).
  if (process.env.MEMORY_TOKEN) return process.env.MEMORY_TOKEN;
  try {
    if (!existsSync(CREDENTIALS_PATH)) return null;
    const data = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
    if (!data?.token) return null;
    // Check expiry — allow 5 min buffer for clock skew.
    if (data.expiresAt) {
      const expiresAt = new Date(data.expiresAt).getTime();
      const now = Date.now();
      if (now >= expiresAt - 5 * 60 * 1000) {
        TOKEN_EXPIRED = true;
        return null;
      }
    }
    return data.token;
  } catch {
    return null;
  }
}

/** Check if the last loadStoredToken() failed due to expiry. */
export function isTokenExpired() {
  return TOKEN_EXPIRED;
}

/**
 * Save a JWT + user info to the credential file.
 */
export function saveCredentials(token, expiresIn, user) {
  const expiresAt = new Date(Date.now() + (expiresIn ?? 8 * 60 * 60) * 1000).toISOString();
  const dir = dirname(CREDENTIALS_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify({ token, expiresAt, user }, null, 2),
    { mode: 0o600 },
  );
}

/**
 * Get the current authenticated user from the credential file.
 */
export function getCurrentUser() {
  try {
    if (!existsSync(CREDENTIALS_PATH)) return null;
    const data = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
    return data?.user ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if we have a valid (non-expired) token.
 */
export function isLoggedIn() {
  return loadStoredToken() !== null;
}

/**
 * Log out by deleting the credential file.
 */
export function logout() {
  try {
    if (existsSync(CREDENTIALS_PATH)) {
      unlinkSync(CREDENTIALS_PATH);
    }
  } catch {
    // ignore
  }
}

function getToken() {
  const token = loadStoredToken();
  if (!token) {
    if (TOKEN_EXPIRED) {
      throw new Error(
        "Memory token has expired. Run `mem login` to refresh your session.",
      );
    }
    throw new Error(
      "Not authenticated. Run `mem login` to sign in via the Allen Labs auth server.",
    );
  }
  return token;
}

function headers() {
  const h = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${getToken()}`,
  };
  if (SCOPE) h["x-memory-scope"] = SCOPE;
  return h;
}

/**
 * Call an MCP tool on the memory server. Returns the text content from the
 * response, or throws on error.
 *
 * The MCP Streamable HTTP transport requires a full handshake:
 *   1. POST initialize → get session ID (if stateful) or just ack (stateless)
 *   2. POST notifications/initialized (no response expected)
 *   3. POST tools/call with the same session ID
 *
 * The Cloudflare Agents MCP handler is stateless by default but still
 * requires the initialized notification before accepting tool calls.
 * Without it, tools/call returns 400 "Not Initialized".
 *
 * Performance: We cache the session ID in-process so subsequent calls within
 * the same Node process (e.g. a hook that calls search then add) skip the
 * initialize round-trip. The cache is short-lived (2 min) to avoid stale
 * sessions. If a cached session fails, we invalidate and retry once.
 */

// Session cache — shared across all callTool() invocations in this process.
let cachedSessionId = "";
let sessionExpiresAt = 0;
const SESSION_TTL = 2 * 60 * 1000; // 2 minutes

export async function callTool(name, args = {}) {
  if (!SERVER_URL) {
    throw new Error("MEMORY_SERVER_URL is not set");
  }

  const baseHeaders = headers();
  const now = Date.now();
  const hasValidSession = cachedSessionId && now < sessionExpiresAt;

  // Step 1: Initialize the MCP session (only if no valid cached session).
  if (!hasValidSession) {
    const initRes = await fetch(`${SERVER_URL}/mcp`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "memory-plugin", version: "0.1.0" },
        },
      }),
    });

    if (!initRes.ok) {
      const text = await initRes.text().catch(() => "");
      throw new Error(`MCP initialize failed (${initRes.status}): ${text}`);
    }

    // Parse the init result (may be JSON or SSE).
    await parseMcpResponse(initRes);
    cachedSessionId = initRes.headers.get("mcp-session-id") ?? "";
    sessionExpiresAt = now + SESSION_TTL;

    // Step 2: Send the initialized notification.
    const notifHeaders = { ...baseHeaders };
    if (cachedSessionId) notifHeaders["mcp-session-id"] = cachedSessionId;

    await fetch(`${SERVER_URL}/mcp`, {
      method: "POST",
      headers: notifHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }).catch(() => {
      // Stateless servers may return 202 with empty body or 400 — ignore.
    });
  }

  // Step 3: Send the tool call.
  const callHeaders = { ...baseHeaders };
  if (cachedSessionId) callHeaders["mcp-session-id"] = cachedSessionId;

  let callRes = await fetch(`${SERVER_URL}/mcp`, {
    method: "POST",
    headers: callHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  // If the cached session was rejected (e.g. expired on server side),
  // invalidate the cache and retry the full handshake once.
  if (callRes.status === 400 && hasValidSession) {
    cachedSessionId = "";
    sessionExpiresAt = 0;
    return callTool(name, args);
  }

  if (!callRes.ok) {
    const text = await callRes.text().catch(() => "");
    throw new Error(`MCP tools/call failed (${callRes.status}): ${text}`);
  }

  const callResult = await parseMcpResponse(callRes);

  // Extract text content from the result.
  if (callResult?.result?.content) {
    return callResult.result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (callResult?.error) {
    throw new Error(`MCP error: ${JSON.stringify(callResult.error)}`);
  }
  return JSON.stringify(callResult);
}

/**
 * Parse an MCP response that may be JSON or SSE (text/event-stream).
 * The stateless handler returns JSON for simple requests.
 */
async function parseMcpResponse(res) {
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    // Extract the data: lines and parse the JSON-RPC message.
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          return JSON.parse(line.slice(6));
        } catch {
          // continue
        }
      }
    }
    return null;
  }

  // Plain JSON response.
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Convenience wrappers for common memory operations. */
export const memory = {
  add: (params) => callTool("memory_add", params),
  search: (params) => callTool("memory_search", params),
  get: (params) => callTool("memory_get", params),
  list: (params) => callTool("memory_list", params),
  update: (params) => callTool("memory_update", params),
  delete: (params) => callTool("memory_delete", params),
  load: (params) => callTool("memory_load", params),
  stats: () => callTool("memory_stats", {}),
};

/** Read all stdin as a string. */
export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

/**
 * Shared library for talking to the memory-server-worker MCP endpoint.
 *
 * Used by the hook scripts (pre-prompt, post-turn) and the CLI helper.
 * All requests go over HTTP to the deployed (or local) Worker's /mcp route
 * using the MCP "tools/call" JSON-RPC method.
 *
 * Auth: an API key from MEMORY_API_KEY, or an RS256 JWT obtained through the
 * Allen Labs auth server SSO flow. API-key auth takes precedence and is sent
 * only as x-memory-api-key. JWT auth uses Authorization: Bearer <jwt>.
 *
 * Configuration via environment variables:
 *   MEMORY_SERVER_URL  — base URL of the worker (defaults to https://memory.allenlim.net)
 *   MEMORY_API_KEY     — API key (takes precedence over JWT credentials)
 *   MEMORY_TOKEN       — JWT bearer token (overrides credential file; for CI/headless)
 *   MEMORY_SCOPE       — optional logical sub-scope within the authenticated user
 *   MEMORY_AUTH_API_URL — auth API URL for login (defaults to https://auth-api.allen.company)
 *   MEMORY_REQUEST_TIMEOUT_MS — request timeout in milliseconds (default 10000; 100-60000)
 *
 * Credential file (~/.memory/credentials.json):
 *   { "token": "<jwt>", "expiresAt": "<iso>", "user": { "id": "...", "email": "..." } }
 */

import { createHash, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_PATH = join(homedir(), ".memory", "credentials.json");

const PLUGIN_VERSION = "2.1.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const MAX_ERROR_TEXT_BYTES = 4 * 1024;
const CREDENTIAL_FINGERPRINT_BYTES = 32;
const CREDENTIAL_FINGERPRINT_SCRYPT_OPTIONS = Object.freeze({
  N: 2 ** 14,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
});

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
  if (getApiKey()) {
    TOKEN_EXPIRED = false;
    return true;
  }
  return loadStoredToken() !== null;
}

/** Return the active auth mode without exposing the credential itself. */
export function getAuthenticationMode() {
  if (getApiKey()) {
    TOKEN_EXPIRED = false;
    return "api-key";
  }
  return loadStoredToken() ? "jwt" : null;
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
      "Not authenticated. Set MEMORY_API_KEY or run `mem login` to sign in.",
    );
  }
  return token;
}

function getApiKey() {
  return process.env.MEMORY_API_KEY?.trim() || null;
}

function getServerUrl() {
  return (
    process.env.MEMORY_SERVER_URL?.trim() || "https://memory.allenlim.net"
  ).replace(/\/$/, "");
}

function getCanonicalServerUrl() {
  const serverUrl = new URL(getServerUrl());
  if (
    !["http:", "https:"].includes(serverUrl.protocol) ||
    serverUrl.username ||
    serverUrl.password
  ) {
    throw new Error("MEMORY_SERVER_URL must be an HTTP(S) URL without credentials.");
  }
  serverUrl.hash = "";
  serverUrl.search = "";
  serverUrl.pathname = serverUrl.pathname.replace(/\/$/, "");
  return serverUrl.href.replace(/\/$/, "");
}

/**
 * Return a one-way identity for the active server/auth destination.
 *
 * This value is safe to use in checkpoint keys: it never contains the raw
 * server URL, API key, JWT, user id, or logical scope. A stable JWT subject is
 * preferred so refreshing the same user's token does not replay transcripts.
 */
export function getMemoryDestinationFingerprint() {
  const apiKey = getApiKey();
  let authIdentity;
  let scopeIdentity = "none";

  if (apiKey) {
    authIdentity = `api-key:${deriveCredentialFingerprint(apiKey, "api-key")}`;
  } else {
    const token = loadStoredToken();
    if (token) {
      const stableUserId = getStableJwtUserId(token);
      authIdentity = stableUserId
        ? `jwt-user:${sha256(stableUserId)}`
        : `jwt-credential:${deriveCredentialFingerprint(token, "jwt")}`;
      scopeIdentity = sha256(process.env.MEMORY_SCOPE?.trim() || "");
    } else {
      authIdentity = "anonymous";
    }
  }

  return sha256(
    JSON.stringify({
      authIdentity,
      scopeIdentity,
      server: getCanonicalServerUrl(),
    }),
  );
}

function getStableJwtUserId(token) {
  const tokenSubject = decodeJwtSubject(token);
  if (process.env.MEMORY_TOKEN) return tokenSubject;

  const user = getCurrentUser();
  const storedUserId = user?.id ?? user?.sub;
  return typeof storedUserId === "string" && storedUserId.trim()
    ? storedUserId.trim()
    : tokenSubject;
}

function decodeJwtSubject(token) {
  try {
    const payloadSegment = token.split(".")[1];
    if (!payloadSegment || payloadSegment.length > 16 * 1024) return null;
    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    );
    return typeof payload?.sub === "string" && payload.sub.trim()
      ? payload.sub.trim()
      : null;
  } catch {
    return null;
  }
}

export function getRequestTimeoutMs() {
  const raw = process.env.MEMORY_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  const configured = Number(raw);
  if (!Number.isFinite(configured)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(
    MAX_REQUEST_TIMEOUT_MS,
    Math.max(MIN_REQUEST_TIMEOUT_MS, Math.trunc(configured)),
  );
}

function headers() {
  const h = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
    "user-agent": `allenlim-memory-server/${PLUGIN_VERSION}`,
  };

  const apiKey = getApiKey();
  if (apiKey) {
    TOKEN_EXPIRED = false;
    h["x-memory-api-key"] = apiKey;
    return h;
  }

  h.authorization = `Bearer ${getToken()}`;
  const scope = process.env.MEMORY_SCOPE?.trim();
  if (scope) h["x-memory-scope"] = scope;
  return h;
}

/**
 * Call an MCP tool on the memory server. Returns the text content from the
 * response, or throws on error.
 *
 * Agents SDK 0.20's SDK-v2 handler exposes a stateless compatibility lane for
 * published 2025 clients. Each invocation is one authenticated tools/call
 * request, so the plugin no longer pays for an initialize handshake.
 */
export async function callTool(name, args = {}) {
  const timeoutMs = getRequestTimeoutMs();
  const timeoutController = new AbortController();
  // Keep this timer referenced. AbortSignal.timeout() deliberately uses an
  // unref'ed timer in some Node releases, which can let short-lived CLI and
  // hook processes exit before a stalled request is rejected.
  const timeoutId = setTimeout(() => {
    const error = new Error(`Memory request timed out after ${timeoutMs} ms.`);
    error.name = "TimeoutError";
    timeoutController.abort(error);
  }, timeoutMs);
  const { signal } = timeoutController;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  try {
    const callRes = await fetchWithSameOriginRedirects(
      `${getCanonicalServerUrl()}/mcp`,
      { body, headers: headers(), signal },
    );

    if (!callRes.ok) {
      const text = await readBoundedErrorText(callRes).catch(() => "");
      throw new Error(`MCP tools/call failed (${callRes.status}): ${text}`);
    }

    const callResult = await parseMcpResponse(callRes);

    if (callResult.error) {
      throw new Error(
        `MCP error ${callResult.error.code}: ${truncateErrorText(callResult.error.message)}`,
      );
    }

    const result = callResult.result;
    if (result.isError === true) {
      const errorText = joinTextContent(result.content, { bounded: true });
      throw new Error(errorText || "MCP tool returned an error result.");
    }

    return joinTextContent(result.content);
  } catch (error) {
    if (
      signal.aborted ||
      error?.name === "AbortError" ||
      error?.name === "TimeoutError"
    ) {
      throw new Error(`Memory request timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithSameOriginRedirects(initialUrl, { body, headers, signal }) {
  const initial = new URL(initialUrl);
  let current = initial;

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(current.href, {
      method: "POST",
      headers: { ...headers },
      body,
      signal,
      redirect: "manual",
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects >= MAX_REDIRECTS) {
      throw new Error("Memory request exceeded the same-origin redirect limit.");
    }

    const target = new URL(location, current);
    await response.body?.cancel().catch(() => {});
    if (
      target.origin !== initial.origin ||
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password
    ) {
      throw new Error("Memory server refused a cross-origin redirect.");
    }

    current = target;
  }
}

function joinTextContent(contents, { bounded = false } = {}) {
  let output = "";
  for (const content of contents) {
    if (content?.type !== "text" || typeof content.text !== "string") continue;
    const separator = output ? "\n" : "";
    if (!bounded) {
      output += `${separator}${content.text}`;
      continue;
    }

    // Only retain a small prefix before applying the UTF-8 byte bound. This
    // avoids constructing an unbounded joined error string from many blocks.
    output += `${separator}${content.text.slice(0, MAX_ERROR_TEXT_BYTES + 1)}`;
    if (Buffer.byteLength(output, "utf8") > MAX_ERROR_TEXT_BYTES) {
      return truncateErrorText(output);
    }
  }
  return output;
}

async function readBoundedErrorText(response) {
  if (!response.body?.getReader) {
    return truncateErrorText(await response.text());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (bytes <= MAX_ERROR_TEXT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_TEXT_BYTES + 1 - bytes;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
      if (bytes > MAX_ERROR_TEXT_BYTES) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
  return truncateErrorText(text);
}

function truncateErrorText(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= MAX_ERROR_TEXT_BYTES) return text;

  let end = MAX_ERROR_TEXT_BYTES;
  while (end > 0) {
    const candidate = Buffer.from(text, "utf8").subarray(0, end).toString("utf8");
    if (!candidate.endsWith("\uFFFD")) return `${candidate}\u2026`;
    end -= 1;
  }
  return "\u2026";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deriveCredentialFingerprint(credential, kind) {
  return scryptSync(
    credential,
    `allenlim-memory-server:${kind}-destination:v1`,
    CREDENTIAL_FINGERPRINT_BYTES,
    CREDENTIAL_FINGERPRINT_SCRYPT_OPTIONS,
  ).toString("hex");
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
      if (line.startsWith("data:")) {
        try {
          return validateMcpResponse(JSON.parse(line.slice(5).trimStart()));
        } catch {
          // continue
        }
      }
    }
    throw new Error("Malformed MCP response: no valid JSON-RPC event.");
  }

  // Plain JSON response.
  try {
    return validateMcpResponse(await res.json());
  } catch (error) {
    if (error?.message?.startsWith("Malformed MCP response:")) throw error;
    throw new Error("Malformed MCP response: invalid JSON.");
  }
}

function validateMcpResponse(value) {
  if (!value || typeof value !== "object" || value.jsonrpc !== "2.0") {
    throw new Error("Malformed MCP response: expected a JSON-RPC 2.0 object.");
  }
  if (value.id !== 1) {
    throw new Error("Malformed MCP response: mismatched request id.");
  }

  if (value.error !== undefined) {
    if (
      !value.error ||
      typeof value.error !== "object" ||
      !Number.isInteger(value.error.code) ||
      typeof value.error.message !== "string"
    ) {
      throw new Error("Malformed MCP response: invalid error object.");
    }
    return value;
  }

  if (
    !value.result ||
    typeof value.result !== "object" ||
    !Array.isArray(value.result.content)
  ) {
    throw new Error("Malformed MCP response: missing tool result content.");
  }

  return value;
}

/** Convenience wrappers for common memory operations (Agent Memory API). */
export const memory = {
  add: (params) => callTool("memory_add", params),
  search: (params) => callTool("memory_search", params),
  ingest: (params) => callTool("memory_ingest", params),
  list: (params) => callTool("memory_list", params),
  get: (params) => callTool("memory_get", params),
  delete: (params) => callTool("memory_delete", params),
  deleteSession: (params) => callTool("memory_delete_session", params),
  summary: (params) => callTool("memory_summary", params ?? {}),
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

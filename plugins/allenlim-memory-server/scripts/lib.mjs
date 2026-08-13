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

import { randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_PATH = join(homedir(), ".memory", "credentials.json");
const CREDENTIALS_LOCK_PATH = join(homedir(), ".memory", "credentials.lock");
const OAUTH_CLIENT_PATH = join(homedir(), ".memory", "oauth-client.json");

const PLUGIN_VERSION = "3.0.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const MAX_ERROR_TEXT_BYTES = 4 * 1024;
const MAX_SUCCESS_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_CREDENTIALS_BYTES = 64 * 1024;
const MAX_OAUTH_CLIENT_RECORD_BYTES = 8 * 1024;
const MAX_OAUTH_CLIENT_ID_BYTES = 1024;
const MAX_REFRESH_TOKEN_BYTES = 16 * 1024;
const MAX_RESULT_TEXT_BYTES = MAX_SUCCESS_RESPONSE_BYTES;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const OAUTH_CLIENT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_LOCK_STALE_MS = MAX_REQUEST_TIMEOUT_MS + 5_000;
const DEFAULT_AUTH_API_URL = "https://auth-api.allen.company";
const DEFAULT_MEMORY_RESOURCE = "https://memory.allenlim.net";
const DESTINATION_FINGERPRINT_BYTES = 32;
const DESTINATION_FINGERPRINT_SALT =
  "allenlim-memory-server:checkpoint-destination:v1";
const DESTINATION_FINGERPRINT_SCRYPT_OPTIONS = Object.freeze({
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
let refreshInFlight = null;

function loadStoredCredentials() {
  try {
    if (!existsSync(CREDENTIALS_PATH)) return null;
    const raw = readFileSync(CREDENTIALS_PATH, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_CREDENTIALS_BYTES) return null;
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** Reuse a recent public DCR client without treating its identifier as a secret. */
export function getCachedOAuthClientRegistration(authApiUrl) {
  try {
    if (!existsSync(OAUTH_CLIENT_PATH)) return null;
    const raw = readFileSync(OAUTH_CLIENT_PATH, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_OAUTH_CLIENT_RECORD_BYTES) return null;
    const data = JSON.parse(raw);
    const createdAt = new Date(data?.createdAt ?? 0).getTime();
    if (
      typeof data?.clientId !== "string" ||
      !data.clientId ||
      Buffer.byteLength(data.clientId, "utf8") > MAX_OAUTH_CLIENT_ID_BYTES ||
      data.authApiUrl !== authApiUrl ||
      data.redirectUri !== "http://127.0.0.1/callback" ||
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() + 60_000 ||
      Date.now() - createdAt > OAUTH_CLIENT_CACHE_TTL_MS
    ) {
      return null;
    }
    return { clientId: data.clientId, redirectUri: data.redirectUri };
  } catch {
    return null;
  }
}

export function saveOAuthClientRegistration(authApiUrl, clientId) {
  assertBoundedCredential(clientId, "OAuth client id", MAX_OAUTH_CLIENT_ID_BYTES);
  const dir = dirname(OAUTH_CLIENT_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictCredentialDirectoryPermissions(dir);
  writePrivateJsonAtomically(
    OAUTH_CLIENT_PATH,
    {
      authApiUrl,
      clientId,
      createdAt: new Date().toISOString(),
      redirectUri: "http://127.0.0.1/callback",
    },
    MAX_OAUTH_CLIENT_RECORD_BYTES,
    "OAuth client registration",
  );
}

function loadStoredToken() {
  TOKEN_EXPIRED = false;
  if (process.env.MEMORY_TOKEN) {
    try {
      validateAccessToken(process.env.MEMORY_TOKEN);
      return process.env.MEMORY_TOKEN;
    } catch {
      TOKEN_EXPIRED = true;
      return null;
    }
  }
  const data = loadStoredCredentials();
  if (!data?.token) return null;
  try {
    validateAccessToken(data.token);
    return data.token;
  } catch {
    TOKEN_EXPIRED = true;
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
export function saveCredentials(token, expiresIn, user, refresh = {}) {
  const claims = validateAccessToken(token);
  if (expiresIn !== undefined &&
      (!Number.isSafeInteger(expiresIn) || expiresIn <= 0)) {
    throw new Error("Memory access-token lifetime is invalid.");
  }
  const refreshToken = refresh.refreshToken;
  const clientId = refresh.clientId;
  if (refreshToken !== undefined) {
    assertBoundedCredential(refreshToken, "Memory refresh token", MAX_REFRESH_TOKEN_BYTES);
    assertBoundedCredential(clientId, "OAuth client id", MAX_OAUTH_CLIENT_ID_BYTES);
    if (!Number.isSafeInteger(refresh.refreshTokenExpiresIn) ||
        refresh.refreshTokenExpiresIn <= 0) {
      throw new Error("Memory refresh-token lifetime is invalid.");
    }
    if (claims.client_id !== clientId) {
      throw new Error("Memory access token is bound to a different OAuth client.");
    }
  } else if (clientId !== undefined) {
    throw new Error("OAuth client id requires a refresh token.");
  }
  if (refresh.resource !== undefined && refresh.resource !== expectedResource()) {
    throw new Error("Memory credentials target a different memory server.");
  }
  const jwtExpiresAt = claims.exp * 1000;
  const declaredExpiresAt = Number.isFinite(expiresIn)
    ? Date.now() + Math.max(0, expiresIn) * 1000
    : jwtExpiresAt;
  const expiresAt = new Date(Math.min(jwtExpiresAt, declaredExpiresAt)).toISOString();
  const nowMs = Date.now();
  const refreshExpiresAt = Number.isFinite(refresh.refreshTokenExpiresIn)
    ? new Date(nowMs + Math.max(0, refresh.refreshTokenExpiresIn) * 1000).toISOString()
    : refresh.refreshTokenExpiresAt;
  const refreshFamilyExpiresAt = refresh.refreshFamilyExpiresAt || refreshExpiresAt;
  const boundedRefreshExpiresAt = refreshExpiresAt && refreshFamilyExpiresAt
    ? new Date(Math.min(
      new Date(refreshExpiresAt).getTime(),
      new Date(refreshFamilyExpiresAt).getTime(),
    )).toISOString()
    : refreshExpiresAt;
  const credentials = {
    token,
    expiresAt,
    user: user ?? null,
    ...(refreshToken ? { refreshToken } : {}),
    ...(boundedRefreshExpiresAt ? { refreshTokenExpiresAt: boundedRefreshExpiresAt } : {}),
    ...(refreshFamilyExpiresAt ? { refreshFamilyExpiresAt } : {}),
    ...(clientId ? { clientId } : {}),
    ...(refresh.resource ? { resource: refresh.resource } : {}),
  };
  const dir = dirname(CREDENTIALS_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictCredentialDirectoryPermissions(dir);
  writeCredentialsAtomically(credentials);
}

/** Replace credentials while excluding concurrent refresh/logout writers. */
export async function saveCredentialsWithLock(token, expiresIn, user, refresh = {}) {
  const releaseLock = await acquireCredentialRefreshLock();
  try {
    saveCredentials(token, expiresIn, user, refresh);
  } finally {
    releaseLock();
  }
}

function restrictCredentialDirectoryPermissions(dir) {
  chmodSync(dir, 0o700);
  if (process.platform !== "win32") return;
  const account = [process.env.USERDOMAIN, process.env.USERNAME]
    .filter(Boolean)
    .join("\\");
  if (!account) {
    throw new Error("Could not determine the Windows account for credential ACLs.");
  }
  execFileSync(
    "icacls.exe",
    [dir, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)(F)`],
    { stdio: "ignore", windowsHide: true },
  );
}

function writeCredentialsAtomically(credentials) {
  writePrivateJsonAtomically(
    CREDENTIALS_PATH,
    credentials,
    MAX_CREDENTIALS_BYTES,
    "Memory credentials",
  );
}

function writePrivateJsonAtomically(targetPath, value, maxBytes, label) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes.`);
  }
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, targetPath);
    restrictCredentialPermissions(targetPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function restrictCredentialPermissions(path) {
  chmodSync(path, 0o600);
  if (process.platform !== "win32") return;
  const account = [process.env.USERDOMAIN, process.env.USERNAME]
    .filter(Boolean)
    .join("\\");
  if (!account) {
    throw new Error("Could not determine the Windows account for credential ACLs.");
  }
  execFileSync(
    "icacls.exe",
    [path, "/inheritance:r", "/grant:r", `${account}:(F)`],
    { stdio: "ignore", windowsHide: true },
  );
}

/**
 * Get the current authenticated user from the credential file.
 */
export function getCurrentUser() {
  return loadStoredCredentials()?.user ?? null;
}

/**
 * Check if we have a valid (non-expired) token.
 */
export function isLoggedIn() {
  if (getApiKey()) {
    TOKEN_EXPIRED = false;
    return true;
  }
  if (loadStoredToken() !== null) return true;
  return hasUsableRefreshToken(loadStoredCredentials());
}

/** Return the active auth mode without exposing the credential itself. */
export function getAuthenticationMode() {
  if (getApiKey()) {
    TOKEN_EXPIRED = false;
    return "api-key";
  }
  return loadStoredToken() || hasUsableRefreshToken(loadStoredCredentials())
    ? "jwt"
    : null;
}

/** Revoke the renewable OAuth session, then always remove local credentials. */
export async function logout() {
  const initialCredentials = loadStoredCredentials();
  let releaseLock;
  try {
    if (!initialCredentials) return true;
    releaseLock = await acquireCredentialRefreshLock();
    const credentials = loadStoredCredentials();
    if (!credentials) return true;
    if (credentials?.refreshToken && credentials?.clientId) {
      const { resource } = validateStoredRefreshBinding(credentials, {
        requireUnexpired: false,
      });
      const response = await fetch(`${getCanonicalAuthApiUrl()}/oauth/revoke`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: credentials.refreshToken,
          token_type_hint: "refresh_token",
          client_id: credentials.clientId,
          resource,
        }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(getRequestTimeoutMs()),
      });
      if (!response.ok) {
        await readBoundedErrorText(response).catch(() => "");
        throw new Error(`Authorization server rejected session revocation (${response.status}).`);
      }
      await response.body?.cancel().catch(() => {});
    }
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (existsSync(CREDENTIALS_PATH)) unlinkSync(CREDENTIALS_PATH);
    } catch {
      // Revocation is best effort; local cleanup must never depend on it.
    }
    releaseLock?.();
  }
}

async function getToken() {
  if (process.env.MEMORY_TOKEN) {
    return validateAccessToken(process.env.MEMORY_TOKEN) && process.env.MEMORY_TOKEN;
  }

  const credentials = loadStoredCredentials();
  if (!credentials) return missingToken();
  const expiresAt = getTokenExpiryMs(credentials.token, credentials.expiresAt);
  if (expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    validateAccessToken(credentials.token);
    return credentials.token;
  }

  if (hasUsableRefreshToken(credentials)) {
    try {
      return await refreshAccessToken(credentials);
    } catch (error) {
      if (expiresAt > Date.now()) {
        validateAccessToken(credentials.token);
        return credentials.token;
      }
      TOKEN_EXPIRED = true;
      throw error;
    }
  }

  TOKEN_EXPIRED = expiresAt <= Date.now();
  return missingToken();
}

function missingToken() {
  if (TOKEN_EXPIRED) {
    throw new Error(
      "Memory session expired and could not be refreshed. Sign in again with the plugin CLI.",
    );
  }
  throw new Error(
    "Not authenticated. Set MEMORY_API_KEY or sign in with the plugin CLI.",
  );
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
  const serverUrl = parseSecureServiceUrl(getServerUrl(), "MEMORY_SERVER_URL");
  serverUrl.hash = "";
  serverUrl.search = "";
  serverUrl.pathname = serverUrl.pathname.replace(/\/$/, "");
  return serverUrl.href.replace(/\/$/, "");
}

function getCanonicalAuthApiUrl() {
  const authApiUrl = parseSecureServiceUrl(
    process.env.MEMORY_AUTH_API_URL?.trim() || DEFAULT_AUTH_API_URL,
    "MEMORY_AUTH_API_URL",
  );
  authApiUrl.hash = "";
  authApiUrl.search = "";
  authApiUrl.pathname = authApiUrl.pathname.replace(/\/$/, "");
  return authApiUrl.href.replace(/\/$/, "");
}

export function getAuthApiUrl() {
  return getCanonicalAuthApiUrl();
}

export function getMemoryResource() {
  return expectedResource();
}

export async function readBoundedJsonResponse(response, maxBytes = MAX_CREDENTIALS_BYTES) {
  const raw = await readBoundedResponseText(response, maxBytes);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Authentication server returned invalid JSON.");
  }
}

function parseSecureServiceUrl(value, variableName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid absolute URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${variableName} must not contain credentials.`);
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return parsed;
  }
  throw new Error(`${variableName} must use HTTPS (HTTP is allowed only for loopback development).`);
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".").map(Number);
  return octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 127;
}

function expectedResource() {
  return getCanonicalServerUrl() || DEFAULT_MEMORY_RESOURCE;
}

function decodeJwtPayload(token) {
  if (typeof token !== "string" || token.length > 16 * 1024) {
    throw new Error("Memory access token is not a valid JWT.");
  }
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new Error("Memory access token is not a valid JWT.");
  }
  try {
    const header = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (!header || typeof header !== "object" || header.alg !== "RS256") throw new Error();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return payload;
  } catch {
    throw new Error("Memory access token is not a valid JWT.");
  }
}

export function validateAccessToken(token, now = Date.now()) {
  return validateAccessTokenClaims(token, now, { validateTime: true });
}

function validateAccessTokenClaims(token, now, { validateTime }) {
  const payload = decodeJwtPayload(token);
  const issuer = getCanonicalAuthApiUrl();
  const resource = expectedResource();
  const audiences = typeof payload.aud === "string"
    ? [payload.aud]
    : Array.isArray(payload.aud)
      ? payload.aud
      : [];
  if (payload.iss !== issuer) {
    throw new Error("Memory access token has an unexpected issuer.");
  }
  if (audiences.length !== 1 || audiences[0] !== resource) {
    throw new Error("Memory access token is not scoped to this memory server.");
  }
  if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 1024) {
    throw new Error("Memory access token has no valid subject.");
  }
  if (typeof payload.client_id !== "string" || !payload.client_id ||
      Buffer.byteLength(payload.client_id, "utf8") > MAX_OAUTH_CLIENT_ID_BYTES) {
    throw new Error("Memory access token has no valid OAuth client binding.");
  }
  if (payload.azp !== payload.client_id) {
    throw new Error("Memory access token has an inconsistent authorized party.");
  }
  if (payload.token_use !== "access") {
    throw new Error("Memory access token has an unexpected token type.");
  }
  if (!Number.isSafeInteger(payload.exp) || (validateTime && payload.exp * 1000 <= now)) {
    throw new Error("Memory access token has expired.");
  }
  if (validateTime && payload.nbf !== undefined &&
      (!Number.isSafeInteger(payload.nbf) || payload.nbf * 1000 > now + 60_000)) {
    throw new Error("Memory access token is not active yet.");
  }
  return payload;
}

function getTokenExpiryMs(token, storedExpiresAt) {
  try {
    const jwtExpiry = decodeJwtPayload(token).exp * 1000;
    const storedExpiry = new Date(storedExpiresAt ?? 0).getTime();
    return Number.isFinite(storedExpiry) && storedExpiry > 0
      ? Math.min(jwtExpiry, storedExpiry)
      : jwtExpiry;
  } catch {
    return 0;
  }
}

function hasUsableRefreshToken(credentials) {
  try {
    validateStoredRefreshBinding(credentials, { requireUnexpired: true });
    return true;
  } catch {
    return false;
  }
}

async function refreshAccessToken(credentials) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performTokenRefresh(credentials).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function performTokenRefresh(credentials) {
  const releaseLock = await acquireCredentialRefreshLock();
  try {
    const latest = loadStoredCredentials();
    if (!latest) {
      throw new Error(
        "Memory credentials were removed while session refresh was waiting. Sign in again with the plugin CLI.",
      );
    }
    if (!isSameRefreshSession(credentials, latest)) {
      throw new Error(
        "Memory credentials changed while session refresh was waiting. Retry the request.",
      );
    }
    if (latest?.token &&
        getTokenExpiryMs(latest.token, latest.expiresAt) > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      validateAccessToken(latest.token);
      return latest.token;
    }
    credentials = latest;
    return await performLockedTokenRefresh(credentials);
  } finally {
    releaseLock();
  }
}

async function acquireCredentialRefreshLock() {
  const dir = dirname(CREDENTIALS_LOCK_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictCredentialDirectoryPermissions(dir);
  const deadline = Date.now() + getRequestTimeoutMs();
  for (;;) {
    try {
      const lockId = `${process.pid}:${randomBytes(12).toString("hex")}`;
      let descriptor;
      try {
        descriptor = openSync(CREDENTIALS_LOCK_PATH, "wx", 0o600);
        writeFileSync(descriptor, `${lockId}\n${Date.now()}\n`, "utf8");
        closeSync(descriptor);
        descriptor = undefined;
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        try {
          const currentLock = readFileSync(CREDENTIALS_LOCK_PATH, "utf8");
          if (currentLock.startsWith(`${lockId}\n`)) unlinkSync(CREDENTIALS_LOCK_PATH);
        } catch {
          // The exclusive create may have failed before this process owned it.
        }
        throw error;
      }
      return () => {
        try {
          const currentLock = readFileSync(CREDENTIALS_LOCK_PATH, "utf8");
          if (currentLock.startsWith(`${lockId}\n`)) unlinkSync(CREDENTIALS_LOCK_PATH);
        } catch {
          // A stale-lock recovery may already have removed it.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - statSync(CREDENTIALS_LOCK_PATH).mtimeMs;
        if (age > REFRESH_LOCK_STALE_MS) {
          unlinkSync(CREDENTIALS_LOCK_PATH);
          continue;
        }
      } catch (lockError) {
        if (lockError?.code !== "ENOENT") throw lockError;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for another process to refresh the memory session.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function performLockedTokenRefresh(credentials) {
  const { resource } = validateStoredRefreshBinding(credentials, {
    requireUnexpired: true,
  });
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
    resource,
  });
  const response = await fetch(`${getCanonicalAuthApiUrl()}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(getRequestTimeoutMs()),
  });
  const raw = await readBoundedResponseText(
    response,
    response.ok ? MAX_CREDENTIALS_BYTES : MAX_ERROR_TEXT_BYTES,
  );
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`Memory session refresh failed (${response.status}): invalid response.`);
  }
  if (!response.ok) {
    const description = typeof result.error_description === "string"
      ? truncateErrorText(result.error_description)
      : "authorization server rejected the refresh token";
    throw new Error(`Memory session refresh failed (${response.status}): ${description}.`);
  }
  if (
    typeof result.access_token !== "string" ||
    typeof result.refresh_token !== "string" ||
    Buffer.byteLength(result.refresh_token, "utf8") > MAX_REFRESH_TOKEN_BYTES ||
    result.token_type !== "Bearer" ||
    !Number.isSafeInteger(result.expires_in) ||
    result.expires_in <= 0 ||
    !Number.isSafeInteger(result.refresh_token_expires_in) ||
    result.refresh_token_expires_in <= 0
  ) {
    throw new Error("Memory session refresh failed: incomplete token response.");
  }
  if (result.resource !== resource) {
    throw new Error("Memory session refresh failed: resource mismatch.");
  }
  saveCredentials(result.access_token, result.expires_in, credentials.user, {
    refreshToken: result.refresh_token,
    refreshTokenExpiresIn: result.refresh_token_expires_in,
    refreshFamilyExpiresAt: credentials.refreshFamilyExpiresAt || credentials.refreshTokenExpiresAt,
    clientId: credentials.clientId,
    resource,
  });
  TOKEN_EXPIRED = false;
  return result.access_token;
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
  let authKind;
  let identity;
  let logicalScope = null;

  if (apiKey) {
    authKind = "api-key";
    identity = apiKey;
  } else {
    const environmentToken = process.env.MEMORY_TOKEN;
    const credentials = environmentToken ? null : loadStoredCredentials();
    const token = environmentToken || credentials?.token;
    const stableUserId = getStableJwtUserId(token, credentials);
    if (stableUserId) {
      authKind = "jwt-user";
      identity = stableUserId;
      logicalScope = process.env.MEMORY_SCOPE?.trim() || "";
    } else {
      authKind = "anonymous";
      identity = "";
    }
  }

  return deriveDestinationFingerprint({
    authKind,
    identity,
    logicalScope,
    server: getCanonicalServerUrl(),
  });
}

function getStableJwtUserId(token, credentials) {
  if (!token) return null;
  try {
    const claims = validateAccessTokenClaims(token, Date.now(), {
      // An expired access token remains a safe, stable checkpoint identity
      // while its issuer-bound refresh grant is still usable.
      validateTime: Boolean(process.env.MEMORY_TOKEN),
    });
    if (!process.env.MEMORY_TOKEN && !hasUsableRefreshToken(credentials) &&
        claims.exp * 1000 <= Date.now()) {
      return null;
    }
    return claims.sub.trim();
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

async function headers() {
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

  h.authorization = `Bearer ${await getToken()}`;
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
      { body, headers: await headers(), signal },
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
  const byteLimit = bounded ? MAX_ERROR_TEXT_BYTES : MAX_RESULT_TEXT_BYTES;
  for (const content of contents) {
    if (content?.type !== "text" || typeof content.text !== "string") continue;
    const separator = output ? "\n" : "";
    output += `${separator}${content.text.slice(0, byteLimit + 1)}`;
    if (Buffer.byteLength(output, "utf8") > byteLimit) {
      if (bounded) return truncateErrorText(output);
      throw new Error(`Memory tool output exceeded ${byteLimit} bytes.`);
    }
  }
  return output;
}

async function readBoundedErrorText(response) {
  try {
    return truncateErrorText(
      await readBoundedResponseText(response, MAX_ERROR_TEXT_BYTES),
    );
  } catch (error) {
    if (error?.code === "MEMORY_RESPONSE_TOO_LARGE") {
      return "Response body exceeded the safe error-detail limit.";
    }
    throw error;
  }
}

function assertBoundedCredential(value, name, maxBytes) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} is invalid.`);
  }
}

function validateStoredRefreshBinding(credentials, { requireUnexpired }) {
  assertBoundedCredential(
    credentials?.refreshToken,
    "Memory refresh token",
    MAX_REFRESH_TOKEN_BYTES,
  );
  assertBoundedCredential(
    credentials?.clientId,
    "OAuth client id",
    MAX_OAUTH_CLIENT_ID_BYTES,
  );
  const resource = credentials.resource || expectedResource();
  if (resource !== expectedResource()) {
    throw new Error("Stored refresh credentials target a different memory server.");
  }
  const claims = validateAccessTokenClaims(credentials.token, Date.now(), {
    validateTime: false,
  });
  if (claims.client_id !== credentials.clientId) {
    throw new Error("Stored refresh credentials are bound to a different OAuth client.");
  }
  if (requireUnexpired) {
    const expiry = new Date(credentials.refreshTokenExpiresAt ?? 0).getTime();
    const familyExpiry = new Date(credentials.refreshFamilyExpiresAt ?? expiry).getTime();
    if (!Number.isFinite(expiry) || !Number.isFinite(familyExpiry) ||
        expiry <= Date.now() || familyExpiry <= Date.now()) {
      throw new Error(
        "Memory refresh token is missing or expired. Sign in again with the plugin CLI.",
      );
    }
  }
  return { resource };
}

function isSameRefreshSession(expected, actual) {
  try {
    const expectedBinding = validateStoredRefreshBinding(expected, {
      requireUnexpired: false,
    });
    const actualBinding = validateStoredRefreshBinding(actual, {
      requireUnexpired: false,
    });
    const expectedClaims = validateAccessTokenClaims(expected.token, Date.now(), {
      validateTime: false,
    });
    const actualClaims = validateAccessTokenClaims(actual.token, Date.now(), {
      validateTime: false,
    });
    return expected.clientId === actual.clientId &&
      expectedBinding.resource === actualBinding.resource &&
      expectedClaims.sub === actualClaims.sub;
  } catch {
    return false;
  }
}

async function readBoundedResponseText(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      const error = new Error(`Memory response exceeded ${maxBytes} bytes.`);
      error.code = "MEMORY_RESPONSE_TOO_LARGE";
      throw error;
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes + 1 - bytes;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        bytes += remaining;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
      if (bytes > maxBytes) break;
    }
  } finally {
    if (bytes > maxBytes) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (bytes > maxBytes) {
    const error = new Error(`Memory response exceeded ${maxBytes} bytes.`);
    error.code = "MEMORY_RESPONSE_TOO_LARGE";
    throw error;
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
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

function deriveDestinationFingerprint(destinationMaterial) {
  // This is a deterministic local checkpoint partition ID, not a stored
  // password verifier. A random per-record salt would make existing
  // checkpoints undiscoverable on the next process run. The fixed,
  // feature-specific salt provides domain separation, while scrypt makes the
  // final returned value a one-way KDF output even if a credential is weaker
  // than the normally high-entropy API keys and JWTs. Raw destination material
  // exists only for this call and is never returned or written to disk.
  return scryptSync(
    JSON.stringify(destinationMaterial),
    DESTINATION_FINGERPRINT_SALT,
    DESTINATION_FINGERPRINT_BYTES,
    DESTINATION_FINGERPRINT_SCRYPT_OPTIONS,
  ).toString("hex");
}

/**
 * Parse an MCP response that may be JSON or SSE (text/event-stream).
 * The stateless handler returns JSON for simple requests.
 */
async function parseMcpResponse(res) {
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const text = await readBoundedResponseText(res, MAX_SUCCESS_RESPONSE_BYTES);
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
    const text = await readBoundedResponseText(res, MAX_SUCCESS_RESPONSE_BYTES);
    return validateMcpResponse(JSON.parse(text));
  } catch (error) {
    if (error?.code === "MEMORY_RESPONSE_TOO_LARGE") throw error;
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
export function readStdin(maxBytes = MAX_STDIN_BYTES) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let settled = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > maxBytes) {
        settled = true;
        process.stdin.pause();
        reject(new Error(`Standard input exceeded ${maxBytes} bytes.`));
        return;
      }
      data += chunk;
    });
    process.stdin.on("end", () => {
      if (!settled) resolve(data);
    });
    process.stdin.on("error", reject);
  });
}

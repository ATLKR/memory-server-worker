/**
 * Types matching the backend REST API responses (Agent Memory).
 */

export type MemoryType = "fact" | "event" | "instruction" | "task";

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  summary: string;
  content: string;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryListItem {
  id: string;
  type: MemoryType;
  summary: string;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListResponse {
  count: number;
  memories: MemoryListItem[];
  cursor: string | null;
}

export interface SearchResponse {
  count: number;
  answer: string;
  candidates: Array<{
    id: string;
    summary: string;
    sessionId: string | null;
    score: number;
  }>;
}

export interface StatsResponse {
  total: number;
  byType: Partial<Record<MemoryType, number>>;
  truncated: boolean;
}

interface ApiErrorBody {
  error?: string;
  error_code?: string;
  retry_after?: number;
}

export interface SummaryResponse {
  summary: string;
}

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
}

export type AuthMode = "session" | "jwt" | "api-key" | "pat";

export interface AuthenticatedSession {
  authenticated: true;
  authMode: AuthMode;
  user: SessionUser;
  expiresAt: string | null;
  refreshable: boolean;
  permissions?: Array<"read" | "write" | "delete">;
}

export interface AnonymousSession {
  authenticated: false;
  authMode: null;
  user: null;
}

export type AuthSession = AuthenticatedSession | AnonymousSession;

export const ANONYMOUS_SESSION: AnonymousSession = {
  authenticated: false,
  authMode: null,
  user: null,
};

export const AUTH_INVALIDATED_EVENT = "memory-auth-invalidated";

export function clearLegacyClientCredentials(): void {
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem("memory_token");
      window.sessionStorage.removeItem("memory_expires_at");
    } catch {
      // Storage can be unavailable in hardened/private browsing contexts.
    }
  }
  if (typeof document !== "undefined") {
    try {
      document.cookie =
        "memory_token=; Secure; SameSite=Lax; Max-Age=0; Path=/";
    } catch {
      // Cookie access can be disabled; the server also expires this cookie.
    }
  }
}

/**
 * API client — calls the REST API on the same origin.
 * The UI worker proxies /api/* to the backend worker via service binding.
 *
 * Auth: the browser uses an HttpOnly, Secure, SameSite session cookie. The
 * cookie is never exposed to JavaScript; `credentials: same-origin` lets the
 * browser attach it only to this origin.
 */

function isSessionUser(value: unknown): value is SessionUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === "string" &&
    (user.email === null || typeof user.email === "string") &&
    (user.name === null || typeof user.name === "string");
}

export function parseSessionResponse(value: unknown): AuthenticatedSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Record<string, unknown>;
  if (
    session.authenticated !== true ||
    !["session", "jwt", "api-key", "pat"].includes(String(session.authMode)) ||
    !isSessionUser(session.user) ||
    !(
      session.expiresAt === undefined ||
      session.expiresAt === null ||
      (typeof session.expiresAt === "string" &&
        Number.isFinite(Date.parse(session.expiresAt)))
    ) ||
    !(
      session.permissions === undefined ||
      (Array.isArray(session.permissions) &&
        session.permissions.every((permission) =>
          ["read", "write", "delete"].includes(String(permission))
        ))
    ) ||
    !(session.refreshable === undefined || typeof session.refreshable === "boolean")
  ) {
    return null;
  }
  return {
    authenticated: true,
    authMode: session.authMode as AuthMode,
    user: session.user,
    expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : null,
    refreshable: session.refreshable === true,
    ...(Array.isArray(session.permissions)
      ? { permissions: session.permissions as Array<"read" | "write" | "delete"> }
      : {}),
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function notifyAuthInvalidated(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT));
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const send = () => fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  let resp = await send();
  if (resp.status === 401 && path.startsWith("/api/")) {
    const refreshed = await refreshSession();
    if (!refreshed.authenticated) return resp;
    resp = await send();
  }
  if (resp.status === 401) {
    notifyAuthInvalidated();
  }
  return resp;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  const body = (await response.json().catch(() => null)) as (ApiErrorBody & T) | null;

  if (!response.ok) {
    const message = body?.error || `Request failed (${response.status})`;
    throw new ApiError(message, response.status, response.headers.get("x-request-id"));
  }
  if (body === null) {
    throw new Error("The server returned an invalid JSON response");
  }
  return body;
}

export async function fetchSession(signal?: AbortSignal): Promise<AuthSession> {
  const response = await fetch("/api/session", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (response.status === 401) return ANONYMOUS_SESSION;

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body === "object"
      ? (body as ApiErrorBody).error
      : null;
    throw new ApiError(
      error || "Unable to verify the session",
      response.status,
      response.headers.get("x-request-id"),
    );
  }

  const session = parseSessionResponse(body);
  if (!session) {
    throw new ApiError(
      "The server returned an invalid session response",
      502,
      response.headers.get("x-request-id"),
    );
  }
  return session;
}

let sharedRefreshRequest: Promise<AuthSession> | null = null;

function refreshRetryDelay(response: Response, body: unknown): number | null {
  if (response.status !== 409 || !body || typeof body !== "object") return null;
  const error = body as ApiErrorBody;
  if (
    error.error !== "temporarily_unavailable" ||
    error.error_code !== "refresh_in_progress"
  ) {
    return null;
  }
  const headerSeconds = Number(response.headers.get("retry-after"));
  const bodySeconds = error.retry_after;
  const seconds = Number.isInteger(headerSeconds) && headerSeconds >= 1
    ? headerSeconds
    : Number.isInteger(bodySeconds) && Number(bodySeconds) >= 1
      ? Number(bodySeconds)
      : 1;
  return Math.min(seconds, 10) * 1000;
}

async function requestSessionRefresh(): Promise<AuthSession> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) {
      notifyAuthInvalidated();
      return ANONYMOUS_SESSION;
    }

    const body: unknown = await response.json().catch(() => null);
    const retryDelay = refreshRetryDelay(response, body);
    if (retryDelay !== null && attempt === 0) {
      // A concurrent tab won rotation. Its Set-Cookie response updates the
      // browser's shared cookie jar; a fresh request re-reads that successor.
      await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelay));
      continue;
    }
    if (!response.ok) {
      const error = body && typeof body === "object"
        ? (body as ApiErrorBody).error
        : null;
      throw new ApiError(
        error || "Unable to refresh the session",
        response.status,
        response.headers.get("x-request-id"),
      );
    }

    const session = parseSessionResponse(body);
    if (!session) {
      throw new ApiError(
        "The server returned an invalid refreshed session",
        502,
        response.headers.get("x-request-id"),
      );
    }
    return session;
  }
  throw new ApiError("Unable to refresh the session", 409);
}

export function refreshSession(_signal?: AbortSignal): Promise<AuthSession> {
  if (sharedRefreshRequest) return sharedRefreshRequest;
  sharedRefreshRequest = requestSessionRefresh().finally(() => {
    sharedRefreshRequest = null;
  });
  return sharedRefreshRequest;
}

export async function logout(): Promise<void> {
  clearLegacyClientCredentials();
  // A 401-triggered refresh may have rotated the HttpOnly cookie outside the
  // React session provider. Let it settle so logout revokes the newest token.
  await sharedRefreshRequest?.catch(() => undefined);
  const response = await apiFetch("/auth/logout", { method: "POST" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      body?.error || "Unable to sign out",
      response.status,
      response.headers.get("x-request-id"),
    );
  }
}

export const api = {
  async list(params?: {
    type?: MemoryType;
    sessionId?: string;
    limit?: number;
    cursor?: string;
  }, signal?: AbortSignal): Promise<ListResponse> {
    const search = new URLSearchParams();
    if (params?.type) search.set("type", params.type);
    if (params?.sessionId) search.set("sessionId", params.sessionId);
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.cursor) search.set("cursor", params.cursor);
    const qs = search.toString();
    return apiJson<ListResponse>(`/api/memories${qs ? "?" + qs : ""}`, { signal });
  },

  async search(query: string, params?: {
    thinkingLevel?: "low" | "medium" | "high";
    responseLength?: "short" | "medium" | "long";
  }, signal?: AbortSignal): Promise<SearchResponse> {
    return apiJson<SearchResponse>("/api/search", {
      method: "POST",
      body: JSON.stringify({ query, ...params }),
      signal,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<MemoryEntry> {
    return apiJson<MemoryEntry>(`/api/memories/${encodeURIComponent(id)}`, { signal });
  },

  async add(params: {
    content: string;
    sessionId?: string;
  }): Promise<MemoryEntry> {
    return apiJson<MemoryEntry>("/api/memories", {
      method: "POST",
      body: JSON.stringify(params),
    });
  },

  async delete(id: string, signal?: AbortSignal): Promise<{ deleted: boolean }> {
    return apiJson<{ deleted: boolean }>(`/api/memories/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
    });
  },

  async deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    return apiJson<{ deleted: boolean }>(
      `/api/session/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
  },

  async stats(): Promise<StatsResponse> {
    return apiJson<StatsResponse>("/api/stats");
  },

  async summary(sessionId?: string, signal?: AbortSignal): Promise<SummaryResponse> {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return apiJson<SummaryResponse>(`/api/summary${qs}`, { signal });
  },
};

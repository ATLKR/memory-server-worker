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
}

export interface SummaryResponse {
  summary: string;
}

/**
 * API client — calls the REST API on the same origin.
 * The UI worker proxies /api/* to the backend worker via service binding.
 *
 * Auth: the browser must have a valid JWT. For the web UI, we store the
 * token in sessionStorage after SSO login and attach it as a Bearer token.
 */

function getToken(): string | null {
  let token: string | null = null;
  try {
    token = sessionStorage.getItem("memory_token");
  } catch {
    // ignore
  }

  if (!token && typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|;\s*)memory_token=([^;]+)/);
    if (match?.[1]) {
      token = match[1];
      try {
        sessionStorage.setItem("memory_token", token);
        document.cookie = "memory_token=; Max-Age=0; Path=/; SameSite=Lax";
      } catch {
        // ignore
      }
    }
  }

  return token;
}

export function setToken(token: string, expiresAt?: string): void {
  try {
    sessionStorage.setItem("memory_token", token);
    if (expiresAt) sessionStorage.setItem("memory_expires_at", expiresAt);
  } catch {
    // ignore
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem("memory_token");
    sessionStorage.removeItem("memory_expires_at");
  } catch {
    // ignore
  }
}

export function isLoggedIn(): boolean {
  const token = getToken();
  if (!token) return false;
  const expiresAt = sessionStorage.getItem("memory_expires_at");
  if (expiresAt) {
    const exp = new Date(expiresAt).getTime();
    if (Date.now() >= exp - 5 * 60 * 1000) return false;
  }
  return true;
}

export function getUserInfo(): { email?: string; name?: string } | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!));
    return { email: payload.email, name: payload.name ?? payload.preferredName };
  } catch {
    return null;
  }
}

export function logout(): void {
  clearToken();
  window.location.href = "/";
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const resp = await fetch(path, { ...init, headers });
  if (resp.status === 401) {
    clearToken();
    window.location.href = "/auth/sso?ui=1";
    throw new Error("Authentication required");
  }
  return resp;
}

export const api = {
  async list(params?: {
    type?: MemoryType;
    sessionId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListResponse> {
    const search = new URLSearchParams();
    if (params?.type) search.set("type", params.type);
    if (params?.sessionId) search.set("sessionId", params.sessionId);
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.cursor) search.set("cursor", params.cursor);
    const qs = search.toString();
    const resp = await apiFetch(`/api/memories${qs ? "?" + qs : ""}`);
    return resp.json();
  },

  async search(query: string, params?: {
    thinkingLevel?: "low" | "medium" | "high";
    responseLength?: "short" | "medium" | "long";
  }): Promise<SearchResponse> {
    const resp = await apiFetch("/api/search", {
      method: "POST",
      body: JSON.stringify({ query, ...params }),
    });
    return resp.json();
  },

  async get(id: string): Promise<MemoryEntry> {
    const resp = await apiFetch(`/api/memories/${encodeURIComponent(id)}`);
    if (!resp.ok) throw new Error(`Failed to get memory: ${resp.status}`);
    return resp.json();
  },

  async add(params: {
    content: string;
    sessionId?: string;
  }): Promise<MemoryEntry> {
    const resp = await apiFetch("/api/memories", {
      method: "POST",
      body: JSON.stringify(params),
    });
    if (!resp.ok) throw new Error(`Failed to add memory: ${resp.status}`);
    return resp.json();
  },

  async delete(id: string): Promise<{ deleted: boolean }> {
    const resp = await apiFetch(`/api/memories/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!resp.ok) throw new Error(`Failed to delete memory: ${resp.status}`);
    return resp.json();
  },

  async deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    const resp = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (!resp.ok) throw new Error(`Failed to delete session: ${resp.status}`);
    return resp.json();
  },

  async stats(): Promise<StatsResponse> {
    const resp = await apiFetch("/api/stats");
    return resp.json();
  },

  async summary(sessionId?: string): Promise<SummaryResponse> {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const resp = await apiFetch(`/api/summary${qs}`);
    return resp.json();
  },
};

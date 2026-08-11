/**
 * Types matching the backend REST API responses.
 */

export interface MemoryEntry {
  id: string;
  key: string | null;
  content: string;
  namespace: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResponse {
  count: number;
  results: MemoryEntry[];
}

export interface ListResponse {
  count: number;
  results: MemoryEntry[];
}

export interface StatsResponse {
  total: number;
  byNamespace: Record<string, number>;
}

/**
 * API client — calls the REST API on the same origin.
 * The UI worker proxies /api/* to the backend worker via service binding.
 *
 * Auth: the browser must have a valid JWT. For the web UI, we store the
 * token in sessionStorage after SSO login and attach it as a Bearer token.
 */

function getToken(): string | null {
  // First check sessionStorage (the normal storage location).
  let token: string | null = null;
  try {
    token = sessionStorage.getItem("memory_token");
  } catch {
    // ignore
  }

  // If not in sessionStorage, check for a transfer cookie set by /auth/callback
  // during the UI SSO flow. Move it to sessionStorage and delete the cookie.
  if (!token && typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|;\s*)memory_token=([^;]+)/);
    if (match?.[1]) {
      token = match[1];
      try {
        sessionStorage.setItem("memory_token", token);
        // Delete the transfer cookie (Max-Age=0).
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

/**
 * Get the current user's display info from the token (if decodable).
 * Returns null if the token can't be parsed.
 */
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
    // Token expired or missing — redirect to SSO (UI flow).
    clearToken();
    window.location.href = "/auth/sso?ui=1";
    throw new Error("Authentication required");
  }
  return resp;
}

export const api = {
  async list(params?: {
    namespace?: string;
    tag?: string;
    limit?: number;
  }): Promise<ListResponse> {
    const search = new URLSearchParams();
    if (params?.namespace) search.set("namespace", params.namespace);
    if (params?.tag) search.set("tag", params.tag);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    const resp = await apiFetch(`/api/memories${qs ? "?" + qs : ""}`);
    return resp.json();
  },

  async search(query: string, params?: {
    namespace?: string;
    limit?: number;
  }): Promise<SearchResponse> {
    const search = new URLSearchParams({ q: query });
    if (params?.namespace) search.set("namespace", params.namespace);
    if (params?.limit) search.set("limit", String(params.limit));
    const resp = await apiFetch(`/api/search?${search}`);
    return resp.json();
  },

  async get(key: string): Promise<MemoryEntry> {
    const resp = await apiFetch(`/api/memories/${encodeURIComponent(key)}`);
    if (!resp.ok) throw new Error(`Failed to get memory: ${resp.status}`);
    return resp.json();
  },

  async add(params: {
    content: string;
    key?: string;
    namespace?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<MemoryEntry> {
    const resp = await apiFetch("/api/memories", {
      method: "POST",
      body: JSON.stringify(params),
    });
    if (!resp.ok) throw new Error(`Failed to add memory: ${resp.status}`);
    return resp.json();
  },

  async update(key: string, params: {
    content?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    appendContent?: boolean;
  }): Promise<MemoryEntry> {
    const resp = await apiFetch(`/api/memories/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
    if (!resp.ok) throw new Error(`Failed to update memory: ${resp.status}`);
    return resp.json();
  },

  async delete(key: string): Promise<{ deleted: boolean }> {
    const resp = await apiFetch(`/api/memories/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    if (!resp.ok) throw new Error(`Failed to delete memory: ${resp.status}`);
    return resp.json();
  },

  async stats(): Promise<StatsResponse> {
    const resp = await apiFetch("/api/stats");
    return resp.json();
  },
};

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_INVALIDATED_EVENT,
  api,
  fetchSession,
  logout,
  refreshSession,
} from "./api";

const AUTHENTICATED_SESSION = {
  authenticated: true,
  authMode: "session",
  user: { id: "user-1", email: "user@example.test", name: "Memory User" },
  expiresAt: "2026-08-13T01:45:00.000Z",
  refreshable: true,
} as const;

describe("cookie-based API client", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("rotates the HttpOnly browser session through the same-origin refresh endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(AUTHENTICATED_SESSION));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshSession()).resolves.toEqual(AUTHENTICATED_SESSION);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/refresh");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("retries one refresh after a concurrent tab wins token rotation", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(Response.json({
          error: "temporarily_unavailable",
          error_code: "refresh_in_progress",
          retry_after: 1,
        }, {
          status: 409,
          headers: { "retry-after": "1" },
        }))
        .mockResolvedValueOnce(Response.json(AUTHENTICATED_SESSION));
      vi.stubGlobal("fetch", fetchMock);

      const pending = refreshSession();
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toEqual(AUTHENTICATED_SESSION);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads only the safe server session using same-origin credentials", async () => {
    const storageRead = vi.spyOn(Storage.prototype, "getItem");
    const fetchMock = vi.fn().mockResolvedValue(Response.json(AUTHENTICATED_SESSION));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSession()).resolves.toEqual(AUTHENTICATED_SESSION);
    expect(storageRead).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/session");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("logs out without bearer auth and removes legacy browser credentials", async () => {
    sessionStorage.setItem("memory_token", "legacy-token-must-not-be-read");
    sessionStorage.setItem("memory_expires_at", "2099-01-01T00:00:00.000Z");
    document.cookie = "memory_token=legacy-token-must-not-be-read; Secure; SameSite=Lax; Path=/";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(sessionStorage.getItem("memory_token")).toBeNull();
    expect(sessionStorage.getItem("memory_expires_at")).toBeNull();
    expect(document.cookie).not.toContain("memory_token=");
  });

  it("invalidates the client session on a 401 without redirecting", async () => {
    const invalidated = vi.fn();
    window.addEventListener(AUTH_INVALIDATED_EVENT, invalidated, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ error: "Authentication required" }, { status: 401 }),
    ));

    await expect(api.stats()).rejects.toMatchObject({ status: 401 });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(window.location.href).toBe("https://memory.example.test/");
  });

  it("refreshes once and retries an API request after an expired access token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "expired" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json(AUTHENTICATED_SESSION))
      .mockResolvedValueOnce(Response.json({
        total: 1,
        byType: { fact: 1 },
        truncated: false,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.stats()).resolves.toEqual({
      total: 1,
      byType: { fact: 1 },
      truncated: false,
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/stats",
      "/auth/refresh",
      "/api/stats",
    ]);
  });
});

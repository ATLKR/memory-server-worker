import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_INVALIDATED_EVENT,
  api,
  fetchSession,
  logout,
} from "./api";

const AUTHENTICATED_SESSION = {
  authenticated: true,
  authMode: "session",
  user: { id: "user-1", email: "user@example.test", name: "Memory User" },
} as const;

describe("cookie-based API client", () => {
  beforeEach(() => {
    sessionStorage.clear();
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
});

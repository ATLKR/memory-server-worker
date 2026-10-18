// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { contentSecurityPolicy, cspNonceMeta, shouldProxy, type UiEnv } from "./server";

const { render } = vi.hoisted(() => ({
  render: vi.fn<(...args: unknown[]) => Promise<Response>>(),
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: render },
}));

const backendFetch = vi.fn<UiEnv["MEMORY_API"]["fetch"]>();
const context: ExecutionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  abort: vi.fn(),
  exports: {},
  props: {},
  get tracing(): never { throw new Error("Unexpected tracing access"); },
};

function environment(resourceUrl?: string): UiEnv {
  return {
    MEMORY_API: {
      fetch: backendFetch,
      connect() { throw new Error("Unexpected socket connection"); },
    },
    CF_VERSION_METADATA: { id: "test-version", tag: "test-tag", timestamp: "" },
    AUTH_WEB_URL: "https://auth.example.test",
    AUTH_API_URL: "https://auth-api.example.test",
    ...(resourceUrl === undefined ? {} : { MEMORY_RESOURCE_URL: resourceUrl }),
  };
}

beforeEach(() => {
  render.mockResolvedValue(new Response("<html><head></head></html>", {
    headers: { "content-type": "text/html" },
  }));
  backendFetch.mockImplementation(async () => new Response(null, {
    status: 302,
    headers: {
      location: "https://auth.example.test/sign-in",
      "set-cookie": "__Host-state=test-state; Path=/; Secure; HttpOnly",
      "x-backend": "preserved",
    },
  }));
  vi.stubGlobal("HTMLRewriter", class {
    on() { return this; }
    transform(response: Response) { return response; }
  });
});

describe("UI worker security boundaries", () => {
  it("uses exact path segments for backend proxy routes", () => {
    expect(shouldProxy("/api/session")).toBe(true);
    expect(shouldProxy("/auth/logout")).toBe(true);
    expect(shouldProxy("/mcp")).toBe(true);
    expect(shouldProxy("/mcp-attacker")).toBe(false);
    expect(shouldProxy("/apiary")).toBe(false);
  });

  it("builds a nonce CSP without unsafe-inline", () => {
    const nonce = "test-nonce";
    const policy = contentSecurityPolicy(nonce);
    const meta = cspNonceMeta(nonce);

    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(meta).toBe(
      `<meta property="csp-nonce" content="${nonce}" nonce="${nonce}">`,
    );
    // TanStack hydration reads `content`; Vite's preload helper reads `nonce`.
    expect(meta.match(/content="([^"]+)"/)?.[1]).toBe(nonce);
    expect(meta.match(/nonce="([^"]+)"/)?.[1]).toBe(nonce);
  });

  it("redirects alias HTML to the configured origin while preserving path and query", async () => {
    const response = await worker.fetch(
      new Request("https://alias.example.test/memories?search=hello%20world", {
        headers: { "x-request-id": "test-request" },
      }),
      environment("https://memory.example.test"),
      context,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://memory.example.test/memories?search=hello%20world");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe("test-request");
    expect(response.headers.get("x-worker-version")).toBe("test-tag");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("keeps a double-slash path on the configured origin", async () => {
    const response = await worker.fetch(
      new Request("https://alias.example.test//evil.example.test/path?next=%2Fauth"),
      environment("https://memory.example.test/"),
      context,
    );

    expect(response.headers.get("location")).toBe("https://memory.example.test//evil.example.test/path?next=%2Fauth");
  });

  it("redirects an alias UI SSO start before the backend can issue a state cookie", async () => {
    const response = await worker.fetch(
      new Request("https://alias.example.test/auth/sso?ui=1"),
      environment("https://memory.example.test"),
      context,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://memory.example.test/auth/sso?ui=1");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(backendFetch).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("cancels discarded streaming HTML without failing the redirect if cleanup rejects", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("Synthetic cancellation rejection"));
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("<html>streaming")); },
      cancel,
    });
    render.mockResolvedValue(new Response(body, { headers: { "content-type": "text/html" } }));
    const response = await worker.fetch(
      new Request("https://alias.example.test/"), environment("https://memory.example.test"), context,
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(response.status).toBe(302);
    expect(await response.text()).toBe("");
  });

  it("renders canonical HTML without a redirect", async () => {
    const response = await worker.fetch(
      new Request("https://memory.example.test/"),
      environment("https://memory.example.test"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'nonce-");
    expect(await response.text()).toContain("<html>");
    expect(render).toHaveBeenCalledOnce();
  });

  it("proxies canonical UI SSO and preserves backend cookies and headers", async () => {
    const request = new Request("https://memory.example.test/auth/sso?ui=1");
    const response = await worker.fetch(request, environment("https://memory.example.test"), context);

    expect(backendFetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(response.headers.get("location")).toBe("https://auth.example.test/sign-in");
    expect(response.headers.get("set-cookie")).toContain("__Host-state=test-state");
    expect(response.headers.get("x-backend")).toBe("preserved");
    expect(render).not.toHaveBeenCalled();
  });

  it.each([
    { resourceUrl: "https://memory.example.test", status: 302 },
    { resourceUrl: "invalid", status: 503 },
  ])("preserves renderer cookies and drops discarded HTML framing for $status", async ({ resourceUrl, status }) => {
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "content-length": "13",
      "content-encoding": "identity",
      vary: "Accept-Encoding",
    });
    headers.append("set-cookie", "first=one; Path=/; Secure");
    headers.append("set-cookie", "second=two; Path=/; Secure");
    render.mockResolvedValue(new Response("<html></html>", { headers }));
    const response = await worker.fetch(
      new Request("https://alias.example.test/"),
      environment(resourceUrl),
      context,
    );

    expect(response.status).toBe(status);
    expect(response.headers.getSetCookie()).toEqual([
      "first=one; Path=/; Secure",
      "second=two; Path=/; Secure",
    ]);
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.has("content-encoding")).toBe(false);
    if (status === 302) {
      expect(response.headers.has("content-type")).toBe(false);
      expect(await response.text()).toBe("");
    } else {
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ error: "Service temporarily unavailable" });
    }
  });

  it.each([
    "", "not-a-url", "http://memory.example.test", "//memory.example.test",
    "https://user:pass@memory.example.test", "https://memory.example.test/path",
    "https://memory.example.test?query=1", "https://memory.example.test#fragment",
    " https://memory.example.test", "https://memory.example.test/../",
  ])("fails closed for malformed HTML origin configuration %j", async (resourceUrl) => {
    const response = await worker.fetch(
      new Request("https://alias.example.test/"), environment(resourceUrl), context,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("location")).toBe(false);
    expect(await response.json()).toEqual({ error: "Service temporarily unavailable" });
  });

  it("fails closed before an alias UI SSO start with malformed configuration", async () => {
    const response = await worker.fetch(
      new Request("https://alias.example.test/auth/sso?ui=1"),
      environment("http://memory.example.test"), context,
    );

    expect(response.status).toBe(503);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(backendFetch).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it.each(["https://memory.example.test", "invalid"]) (
    "leaves API, machine SSO and alias callbacks on their existing proxy path with %j configuration",
    async (resourceUrl) => {
      for (const path of ["/api/session", "/mcp", "/healthz", "/.well-known/oauth-authorization-server", "/auth/sso", "/auth/sso?ui=0", "/auth/callback?code=synthetic&state=synthetic"]) {
        const request = new Request(`https://alias.example.test${path}`);
        const response = await worker.fetch(request, environment(resourceUrl), context);
        expect(backendFetch).toHaveBeenLastCalledWith(request);
        expect(response.headers.get("location")).toBe("https://auth.example.test/sign-in");
        expect(response.headers.get("set-cookie")).toContain("__Host-state=test-state");
      }
      expect(render).not.toHaveBeenCalled();
    },
  );

  it.each(["https://memory.example.test", "invalid"]) (
    "leaves static and other non-HTML responses unchanged with %j configuration",
    async (resourceUrl) => {
      for (const path of ["/assets/app-fingerprint.js", "/server-function"]) {
        render.mockResolvedValue(new Response("export default 1", {
          headers: { "content-type": "application/javascript" },
        }));
        const response = await worker.fetch(
          new Request(`https://alias.example.test${path}`), environment(resourceUrl), context,
        );
        expect(response.status).toBe(200);
        expect(response.headers.has("location")).toBe(false);
        expect(await response.text()).toBe("export default 1");
        if (path.startsWith("/assets/")) {
          expect(response.headers.get("cache-control")).toContain("immutable");
        }
      }
    },
  );

  it.each(["https://memory.example.test", "invalid"]) (
    "leaves POST requests unchanged with %j configuration", async (resourceUrl) => {
      const response = await worker.fetch(
        new Request("https://alias.example.test/", { method: "POST", body: "synthetic" }),
        environment(resourceUrl), context,
      );
      expect(response.status).toBe(200);
      const request = new Request("https://alias.example.test/auth/sso?ui=1", { method: "POST" });
      await worker.fetch(request, environment(resourceUrl), context);
      expect(backendFetch).toHaveBeenCalledExactlyOnceWith(request);
    },
  );

  it("preserves existing behavior when the optional canonical origin is absent", async () => {
    const response = await worker.fetch(
      new Request("https://alias.example.test/"), environment(), context,
    );
    expect(response.status).toBe(200);
    const request = new Request("https://alias.example.test/auth/sso?ui=1");
    await worker.fetch(request, environment(), context);
    expect(backendFetch).toHaveBeenCalledExactlyOnceWith(request);
  });
});

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Memory Worker in workerd", () => {
  it("serves health and canonical protected-resource metadata", async () => {
    const health = await SELF.fetch("https://memory.allenlim.net/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      service: "memory-server",
    });
    expect(health.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9._-]+$/);

    const metadata = await SELF.fetch(
      "https://memory.allenlim.net/.well-known/oauth-protected-resource",
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      resource: "https://memory.allenlim.net",
      authorization_servers: ["https://auth-api.allen.company"],
      scopes_supported: expect.arrayContaining([
        "memory:read",
        "memory:write",
        "memory:delete",
      ]),
    });
  });

  it("applies MCP CORS and the resource discovery challenge before auth", async () => {
    const preflight = await SELF.fetch("https://memory.allenlim.net/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "https://chatgpt.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );

    const unauthorized = await SELF.fetch("https://memory.allenlim.net/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        origin: "https://chatgpt.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://memory.allenlim.net/.well-known/oauth-protected-resource"',
    );
    expect(unauthorized.headers.get("access-control-allow-origin")).toBe("*");
  });
});

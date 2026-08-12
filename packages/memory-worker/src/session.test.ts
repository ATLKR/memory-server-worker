import assert from "node:assert/strict";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "./index.ts";

const ORIGIN = "https://memory.allenlim.net";
const API_KEY = "memory_session_test_0123456789abcdef";

if (typeof crypto.subtle.timingSafeEqual !== "function") {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value: (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) => {
      const leftBytes = ArrayBuffer.isView(left)
        ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
        : new Uint8Array(left);
      const rightBytes = ArrayBuffer.isView(right)
        ? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
        : new Uint8Array(right);
      return leftBytes.byteLength === rightBytes.byteLength &&
        nodeTimingSafeEqual(leftBytes, rightBytes);
    },
  });
}

function executionContext(): ExecutionContext {
  return {} as ExecutionContext;
}

function getSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
}

function assertHostCookie(cookie: string): void {
  assert.match(cookie, /; HttpOnly; Secure; SameSite=Lax;/);
  assert.match(cookie, /; Path=\/$/);
  assert.doesNotMatch(cookie, /;\s*Domain=/i);
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

async function apiKeyRegistry(): Promise<string> {
  return JSON.stringify({
    version: 1,
    keys: [{
      id: "session-test",
      digest: await sha256(API_KEY),
      userId: "api-key-user",
      logicalScope: "tests",
    }],
  });
}

function testEnv(
  options: {
    authApiUrl?: string;
    registry?: string;
    profile?: Record<string, unknown>;
  } = {},
): Env {
  return {
    AUTH_API_URL: options.authApiUrl ?? "https://auth.example.test",
    AUTH_WEB_URL: "https://auth.example.test",
    DEFAULT_SCOPE: "",
    MEMORY_API_KEY_REGISTRY: options.registry ?? "",
    MEMORY: {
      getProfile() {
        return options.profile ?? {};
      },
    },
  } as Env;
}

async function sessionJwt(authApiUrl: string): Promise<{
  token: string;
  jwks: { keys: Array<Record<string, unknown>> };
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const kid = crypto.randomUUID();
  const token = await new SignJWT({
    email: "user@example.test",
    name: "Memory User",
    role: "admin",
    site: "internal",
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject("11111111-1111-4111-8111-111111111111")
    .setIssuer(authApiUrl)
    .setAudience(authApiUrl)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return {
    token,
    jwks: { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] },
  };
}

async function parseMcpResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body) as Record<string, unknown>;
  }
  const frames = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line && line !== "[DONE]");
  return JSON.parse(frames.at(-1)!) as Record<string, unknown>;
}

describe("browser SSO session", () => {
  it("uses host-bound SSO cookies and clears every legacy auth cookie", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/sso?ui=1`),
      testEnv(),
      executionContext(),
    );

    assert.equal(response.status, 302);
    const setCookies = getSetCookies(response);
    const stateCookie = setCookies.find((cookie) =>
      cookie.startsWith("__Host-memory_sso_state=") && !cookie.includes("Max-Age=0")
    );
    const uiFlowCookie = setCookies.find((cookie) =>
      cookie.startsWith("__Host-memory_sso_ui=1;")
    );
    assert.ok(stateCookie);
    assert.ok(uiFlowCookie);
    assertHostCookie(stateCookie);
    assertHostCookie(uiFlowCookie);

    const cookies = setCookies.join("\n");
    assert.match(cookies, /memory_sso_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/auth/);
    assert.match(cookies, /memory_sso_ui=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/auth/);
    assert.match(cookies, /memory_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//);
    assert.match(cookies, /memory_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/api/);
    assert.match(cookies, /memory_token=; Secure; SameSite=Lax; Max-Age=0; Path=\//);

    const cliResponse = await worker.fetch(
      new Request(`${ORIGIN}/auth/sso`),
      testEnv(),
      executionContext(),
    );
    assert.match(
      getSetCookies(cliResponse).join("\n"),
      /__Host-memory_sso_ui=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//,
    );
  });

  it("stores UI tokens only in an HttpOnly session cookie", async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({
      token: "header.payload.signature",
      expires_in: 1_200,
      user: { id: "user-1", email: "user@example.test" },
    }));

    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/callback?state=test-state&code=test-code`, {
        headers: {
          cookie:
            "memory_sso_state=attacker-state; memory_sso_ui=0; " +
            "__Host-memory_sso_state=test-state; __Host-memory_sso_ui=1",
        },
      }),
      testEnv(),
      executionContext(),
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(response.headers.get("x-request-id"));
    const setCookies = getSetCookies(response);
    const sessionCookie = setCookies.find((cookie) =>
      cookie.startsWith("__Host-memory_session=header.payload.signature;")
    );
    assert.ok(sessionCookie);
    assertHostCookie(sessionCookie);
    assert.match(sessionCookie, /Max-Age=1200/);

    const cookies = setCookies.join("\n");
    assert.match(
      cookies,
      /memory_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/api/,
    );
    assert.match(cookies, /memory_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//);
    assert.match(cookies, /memory_token=; Secure; SameSite=Lax; Max-Age=0; Path=\//);
    assert.match(cookies, /__Host-memory_sso_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//);
    assert.match(cookies, /__Host-memory_sso_ui=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//);
    assert.match(cookies, /memory_sso_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/auth/);
    assert.match(cookies, /memory_sso_ui=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/auth/);
    assert.doesNotMatch(cookies, /memory_token=header\.payload\.signature/);
  });

  it("never authenticates with unprefixed legacy SSO cookies", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/callback?state=legacy-state&code=test-code`, {
        headers: { cookie: "memory_sso_state=legacy-state; memory_sso_ui=1" },
      }),
      testEnv(),
      executionContext(),
    );

    assert.equal(response.status, 400);
    assert.match(await response.text(), /missing state cookie/);
  });

  it("does not expose auth-server exchange details to callers", async (t) => {
    t.mock.method(console, "error", () => undefined);
    t.mock.method(globalThis, "fetch", async () => Response.json(
      { error: "upstream secret diagnostic" },
      { status: 400 },
    ));

    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/callback?state=test-state&code=bad-code`, {
        headers: { cookie: "__Host-memory_sso_state=test-state" },
      }),
      testEnv(),
      executionContext(),
    );

    assert.equal(response.status, 400);
    const body = await response.text();
    assert.match(body, /SSO exchange failed/);
    assert.doesNotMatch(body, /upstream secret diagnostic/);
    const cookies = getSetCookies(response).join("\n");
    assert.match(cookies, /__Host-memory_sso_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//);
    assert.match(cookies, /__Host-memory_sso_ui=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//);
    assert.match(cookies, /memory_sso_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/auth/);
    assert.match(cookies, /memory_sso_ui=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/auth/);
  });

  it("enforces endpoint methods and same-origin logout", async () => {
    for (const [path, method, allow] of [
      ["/auth/sso", "POST", "GET"],
      ["/auth/callback", "POST", "GET"],
      ["/auth/logout", "GET", "POST"],
    ] as const) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}${path}`, { method }),
        testEnv(),
        executionContext(),
      );
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), allow);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }

    const forbidden = await worker.fetch(
      new Request(`${ORIGIN}/auth/logout`, { method: "POST" }),
      testEnv(),
      executionContext(),
    );
    assert.equal(forbidden.status, 403);

    const loggedOut = await worker.fetch(
      new Request(`${ORIGIN}/auth/logout`, {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
      testEnv(),
      executionContext(),
    );
    assert.equal(loggedOut.status, 200);
    assert.deepEqual(await loggedOut.json(), { loggedOut: true });
    const cookies = getSetCookies(loggedOut).join("\n");
    assert.match(
      cookies,
      /__Host-memory_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//,
    );
    assert.match(
      cookies,
      /memory_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/api/,
    );
    assert.match(cookies, /memory_token=; Secure/);
    assert.match(cookies, /__Host-memory_sso_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//);
    assert.match(cookies, /__Host-memory_sso_ui=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//);
    assert.match(cookies, /memory_sso_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/auth/);
    assert.match(cookies, /memory_sso_ui=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\/auth/);
  });
});

describe("cookie authentication and CSRF", () => {
  it("returns only safe session fields and never accepts the cookie on MCP", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const { token, jwks } = await sessionJwt(authApiUrl);
    t.mock.method(globalThis, "fetch", async (input) => {
      assert.match(String(input), /\.well-known\/jwks\.json$/);
      return Response.json(jwks);
    });

    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/session`, {
        headers: {
          cookie: `memory_session=attacker-token; __Host-memory_session=${token}`,
          "sec-fetch-site": "same-origin",
        },
      }),
      testEnv({ authApiUrl }),
      executionContext(),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      authenticated: true,
      authMode: "session",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "user@example.test",
        name: "Memory User",
      },
    });

    const mcpResponse = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          cookie: `__Host-memory_session=${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      testEnv({ authApiUrl }),
      executionContext(),
    );
    assert.equal(mcpResponse.status, 401);

    const legacyResponse = await worker.fetch(
      new Request(`${ORIGIN}/api/session`, {
        headers: {
          cookie: `memory_session=${token}`,
          "sec-fetch-site": "same-origin",
        },
      }),
      testEnv({ authApiUrl }),
      executionContext(),
    );
    assert.equal(legacyResponse.status, 401);
  });

  it("rejects cross-site and missing-Origin unsafe cookie requests", async () => {
    for (const headers of [
      { cookie: "__Host-memory_session=unverified", "sec-fetch-site": "cross-site" },
      { cookie: "__Host-memory_session=unverified", "sec-fetch-site": "same-origin" },
      { cookie: "__Host-memory_session=unverified", origin: "https://evil.example" },
    ]) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}/api/memories`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ content: "test" }),
        }),
        testEnv(),
        executionContext(),
      );
      assert.equal(response.status, 403);
    }
  });

  it("does not apply browser-cookie CSRF checks to API-key authentication", async () => {
    const registry = await apiKeyRegistry();
    const now = new Date("2026-08-12T00:00:00.000Z");
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/memories`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://automation.example",
          "x-memory-api-key": API_KEY,
        },
        body: JSON.stringify({ content: "header-authenticated request" }),
      }),
      testEnv({
        registry,
        profile: {
          async remember() {
            return {
              id: "memory-id",
              type: "fact",
              summary: "Stored",
              content: "header-authenticated request",
              sessionId: null,
              createdAt: now,
              updatedAt: now,
            };
          },
        },
      }),
      executionContext(),
    );

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  });
});

describe("Agent Memory error taxonomy", () => {
  it("maps only explicit 404 statuses to not-found", async () => {
    const registry = await apiKeyRegistry();
    const notFound = await worker.fetch(
      new Request(`${ORIGIN}/api/memories/missing`, {
        headers: { "x-memory-api-key": API_KEY },
      }),
      testEnv({
        registry,
        profile: { async get() { throw { status: 404 }; } },
      }),
      executionContext(),
    );
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: "not found" });
  });

  it("keeps unknown failures generic in REST responses and structured logs", async (t) => {
    const logs: string[] = [];
    t.mock.method(console, "error", (...values: unknown[]) => {
      logs.push(values.map(String).join(" "));
    });
    const registry = await apiKeyRegistry();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/memories/known-id`, {
        headers: {
          "x-memory-api-key": API_KEY,
          "x-request-id": "rest-taxonomy-test",
        },
      }),
      testEnv({
        registry,
        profile: {
          async get() {
            throw new Error("sensitive-token profile-name memory-content");
          },
        },
      }),
      executionContext(),
    );

    assert.equal(response.status, 500);
    assert.equal(response.headers.get("x-request-id"), "rest-taxonomy-test");
    const body = await response.text();
    assert.match(body, /internal server error/);
    assert.doesNotMatch(body, /sensitive-token|profile-name|memory-content/);
    const log = logs.join("\n");
    assert.match(log, /"requestId":"rest-taxonomy-test"/);
    assert.match(log, /"operation":"memory_get"/);
    assert.doesNotMatch(log, /sensitive-token|profile-name|memory-content/);
  });

  it("keeps MCP tool failures generic and correlated", async (t) => {
    const logs: string[] = [];
    t.mock.method(console, "error", (...values: unknown[]) => {
      logs.push(values.map(String).join(" "));
    });
    const registry = await apiKeyRegistry();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          host: "memory.allenlim.net",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
          "x-memory-api-key": API_KEY,
          "x-request-id": "mcp-taxonomy-test",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "memory_search", arguments: { query: "test" } },
        }),
      }),
      testEnv({
        registry,
        profile: {
          async recall() {
            throw new Error("sensitive-token profile-name memory-content");
          },
        },
      }),
      executionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-request-id"), "mcp-taxonomy-test");
    const rpc = await parseMcpResponse(response);
    const serialized = JSON.stringify(rpc);
    assert.match(serialized, /Unable to search memories/);
    assert.match(serialized, /mcp-taxonomy-test/);
    assert.doesNotMatch(serialized, /sensitive-token|profile-name|memory-content/);
    assert.doesNotMatch(logs.join("\n"), /sensitive-token|profile-name|memory-content/);
  });
});

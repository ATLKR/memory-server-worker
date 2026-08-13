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

async function sessionJwt(
  authApiUrl: string,
  audience = ORIGIN,
  issuedAt?: number,
  scope = "memory:read memory:write memory:delete",
  expiresAt: string | number = "15m",
): Promise<{
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
    ...(audience === authApiUrl
      ? {}
      : {
          token_use: "access",
          client_id: ORIGIN,
          azp: ORIGIN,
          scope,
        }),
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject("11111111-1111-4111-8111-111111111111")
    .setIssuer(authApiUrl)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti(crypto.randomUUID())
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
  it("uses host-bound SSO cookies without orphaning the current refresh family", async () => {
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
    assert.doesNotMatch(cookies, /__Host-memory_session=/);
    assert.doesNotMatch(cookies, /__Host-memory_refresh=/);
    assert.doesNotMatch(cookies, /__Host-memory_refresh_client=/);

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

  it("stores access and rotating refresh tokens only in HttpOnly cookies", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const { token, jwks } = await sessionJwt(authApiUrl);
    t.mock.method(globalThis, "fetch", async (input, init) => {
      if (String(input).endsWith("/.well-known/jwks.json")) {
        return Response.json(jwks);
      }
      assert.deepEqual(JSON.parse(String(init?.body)), {
        code: "test-code",
        client_id: ORIGIN,
        include_token: true,
        resource: ORIGIN,
        scope:
          "openid profile email offline_access memory:read memory:write memory:delete",
      });
      return Response.json({
        token,
        expires_in: 900,
        refresh_token: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
        refresh_token_expires_in: 2_592_000,
        client_id: ORIGIN,
        resource: ORIGIN,
        scope:
          "openid profile email offline_access memory:read memory:write memory:delete",
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "user@example.test",
        },
      });
    });

    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/callback?state=test-state&code=test-code`, {
        headers: {
          cookie:
            "memory_sso_state=attacker-state; memory_sso_ui=0; " +
            "__Host-memory_sso_state=test-state; __Host-memory_sso_ui=1",
        },
      }),
      testEnv({ authApiUrl }),
      executionContext(),
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(response.headers.get("x-request-id"));
    const setCookies = getSetCookies(response);
    const sessionCookie = setCookies.find((cookie) =>
      cookie.startsWith(`__Host-memory_session=${token};`)
    );
    assert.ok(sessionCookie);
    assertHostCookie(sessionCookie);
    assert.match(sessionCookie, /Max-Age=(?:89[0-9]|900)/);
    const refreshCookie = setCookies.find((cookie) =>
      cookie.startsWith("__Host-memory_refresh=abcdefghijklmnopqrstuvwxyz")
    );
    const clientCookie = setCookies.find((cookie) =>
      cookie.startsWith("__Host-memory_refresh_client=")
    );
    assert.ok(refreshCookie);
    assert.ok(clientCookie);
    assertHostCookie(refreshCookie);
    assertHostCookie(clientCookie);
    assert.match(refreshCookie, /Max-Age=2592000/);
    assert.match(clientCookie, /Max-Age=2592000/);

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
    assert.doesNotMatch(cookies, /memory_token=eyJ/);
  });

  it("revokes the prior UI refresh family only after verifying a replacement", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const { token, jwks } = await sessionJwt(authApiUrl);
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/jwks.json")) return Response.json(jwks);
      calls.push(url);
      if (url.endsWith("/oauth/revoke")) {
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get("token"), "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq");
        assert.equal(form.get("client_id"), ORIGIN);
        assert.equal(form.get("resource"), ORIGIN);
        return new Response(null, { status: 200 });
      }
      assert.equal(url, `${authApiUrl}/sso/exchange`);
      return Response.json({
        token,
        expires_in: 900,
        refresh_token: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
        refresh_token_expires_in: 2_592_000,
        client_id: ORIGIN,
        resource: ORIGIN,
        scope:
          "openid profile email offline_access memory:read memory:write memory:delete",
      });
    });

    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/callback?state=test-state&code=test-code`, {
        headers: {
          cookie:
            "__Host-memory_sso_state=test-state; __Host-memory_sso_ui=1; " +
            "__Host-memory_refresh=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
        },
      }),
      testEnv({ authApiUrl }),
      executionContext(),
    );

    assert.equal(response.status, 302);
    assert.deepEqual(calls, [
      `${authApiUrl}/sso/exchange`,
      `${authApiUrl}/oauth/revoke`,
    ]);
  });

  it("rotates a browser refresh token and verifies its resource-bound access token", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const { token, jwks } = await sessionJwt(authApiUrl);
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/jwks.json")) return Response.json(jwks);
      assert.equal(url, `${authApiUrl}/oauth/token`);
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("content-type"),
        "application/x-www-form-urlencoded",
      );
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq");
      assert.equal(form.get("client_id"), ORIGIN);
      assert.equal(form.get("resource"), ORIGIN);
      return Response.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
        refresh_token_expires_in: 2_500_000,
        scope: "openid profile email",
        resource: ORIGIN,
      });
    });

    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/refresh`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie:
            "__Host-memory_refresh=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq; " +
            `__Host-memory_refresh_client=${encodeURIComponent(ORIGIN)}`,
        },
      }),
      testEnv({ authApiUrl }),
      executionContext(),
    );

    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.authenticated, true);
    assert.equal(body.authMode, "session");
    assert.equal((body.user as Record<string, unknown>).id, "11111111-1111-4111-8111-111111111111");
    assert.match(String(body.expiresAt), /^\d{4}-\d{2}-\d{2}T/);
    const cookies = getSetCookies(response).join("\n");
    assert.match(cookies, /__Host-memory_session=.*Max-Age=(?:89[0-9]|900)/);
    assert.match(cookies, /__Host-memory_refresh=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG.*Max-Age=2500000/);
    assert.match(cookies, /__Host-memory_refresh_client=.*Max-Age=2500000/);
  });

  it("limits the refreshed access cookie to the JWT's actual remaining lifetime", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await sessionJwt(
      authApiUrl,
      ORIGIN,
      now - 850,
      "memory:read memory:write memory:delete",
      now + 50,
    );
    t.mock.method(globalThis, "fetch", async (input) => {
      if (String(input).endsWith("/.well-known/jwks.json")) return Response.json(jwks);
      return Response.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
        refresh_token_expires_in: 2_500_000,
        scope: "memory:read memory:write memory:delete",
        resource: ORIGIN,
      });
    });

    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/refresh`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie: "__Host-memory_refresh=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
        },
      }),
      testEnv({ authApiUrl }),
      executionContext(),
    );

    assert.equal(response.status, 200);
    const sessionCookie = getSetCookies(response).find((cookie) =>
      cookie.startsWith("__Host-memory_session=")
    );
    assert.ok(sessionCookie);
    const maxAge = Number(/Max-Age=(\d+)/.exec(sessionCookie)?.[1]);
    assert.ok(maxAge >= 45 && maxAge <= 50, `unexpected access Max-Age ${maxAge}`);
  });

  it("preserves cookies when another tab is already rotating the refresh token", async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({
      error: "temporarily_unavailable",
      error_code: "refresh_in_progress",
      retry_after: 1,
    }, {
      status: 409,
      headers: { "retry-after": "1" },
    }));

    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/refresh`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie:
            "__Host-memory_refresh=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq; " +
            `__Host-memory_refresh_client=${encodeURIComponent(ORIGIN)}`,
        },
      }),
      testEnv(),
      executionContext(),
    );

    assert.equal(response.status, 409);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), {
      error: "temporarily_unavailable",
      error_code: "refresh_in_progress",
      retry_after: 1,
    });
    assert.equal(response.headers.has("set-cookie"), false);
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

  it("revokes a refresh family on same-origin logout and clears local state", async (t) => {
    const calls: Array<{ url: string; form: URLSearchParams }> = [];
    t.mock.method(globalThis, "fetch", async (input, init) => {
      calls.push({ url: String(input), form: new URLSearchParams(String(init?.body)) });
      return new Response(null, { status: 200 });
    });
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
        headers: {
          origin: ORIGIN,
          cookie:
            "__Host-memory_refresh=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq; " +
            `__Host-memory_refresh_client=${encodeURIComponent(ORIGIN)}`,
        },
      }),
      testEnv(),
      executionContext(),
    );
    assert.equal(loggedOut.status, 200);
    assert.deepEqual(await loggedOut.json(), { loggedOut: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://auth.example.test/oauth/revoke");
    assert.equal(calls[0]?.form.get("token"), "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq");
    assert.equal(calls[0]?.form.get("token_type_hint"), "refresh_token");
    assert.equal(calls[0]?.form.get("client_id"), ORIGIN);
    assert.equal(calls[0]?.form.get("resource"), ORIGIN);
    const cookies = getSetCookies(loggedOut).join("\n");
    assert.match(
      cookies,
      /__Host-memory_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//,
    );
    assert.match(
      cookies,
      /__Host-memory_refresh=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//,
    );
    assert.match(
      cookies,
      /__Host-memory_refresh_client=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//,
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

  it("revokes a valid host refresh token even when the client cookie is absent", async (t) => {
    const calls: URLSearchParams[] = [];
    t.mock.method(globalThis, "fetch", async (_input, init) => {
      calls.push(new URLSearchParams(String(init?.body)));
      return new Response(null, { status: 200 });
    });

    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/logout`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie: "__Host-memory_refresh=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
        },
      }),
      testEnv(),
      executionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.get("client_id"), ORIGIN);
    assert.match(
      getSetCookies(response).join("\n"),
      /__Host-memory_refresh=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//,
    );
  });

  it("clears local cookies even when upstream revocation is unavailable", async (t) => {
    t.mock.method(console, "error", () => undefined);
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("upstream offline");
    });

    const response = await worker.fetch(
      new Request(`${ORIGIN}/auth/logout`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie:
            "__Host-memory_refresh=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq; " +
            `__Host-memory_refresh_client=${encodeURIComponent(ORIGIN)}`,
        },
      }),
      testEnv(),
      executionContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { loggedOut: true });
    assert.match(
      getSetCookies(response).join("\n"),
      /__Host-memory_refresh=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=\//,
    );
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
      expiresAt: new Date(
        JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).exp * 1000,
      ).toISOString(),
      permissions: ["read", "write", "delete"],
      refreshable: false,
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

  it("does not expose an API key's internal profile owner in session metadata", async () => {
    const registry = await apiKeyRegistry();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/session`, {
        headers: { "x-memory-api-key": API_KEY },
      }),
      testEnv({ registry }),
      executionContext(),
    );

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /api-key-user/);
    assert.deepEqual(JSON.parse(text), {
      authenticated: true,
      authMode: "api-key",
      user: { id: "session-test", email: null, name: null },
      expiresAt: null,
      permissions: ["read", "write", "delete"],
      refreshable: false,
    });
  });

  it("enforces memory OAuth scopes consistently across REST and MCP", async (t) => {
    const authApiUrl = `https://auth-${crypto.randomUUID()}.example.test`;
    const { token, jwks } = await sessionJwt(
      authApiUrl,
      ORIGIN,
      undefined,
      "openid profile email memory:read",
    );
    t.mock.method(globalThis, "fetch", async (input) => {
      assert.match(String(input), /\.well-known\/jwks\.json$/);
      return Response.json(jwks);
    });
    let profileCalls = 0;
    const env = testEnv({
      authApiUrl,
      profile: {
        async remember() {
          profileCalls += 1;
          throw new Error("write must not run");
        },
        async delete() {
          profileCalls += 1;
          throw new Error("delete must not run");
        },
      },
    });

    const write = await worker.fetch(
      new Request(`${ORIGIN}/api/memories`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "must not be written" }),
      }),
      env,
      executionContext(),
    );
    assert.equal(write.status, 403);
    assert.match(write.headers.get("www-authenticate") ?? "", /memory:write/);
    assert.match(await write.text(), /write permission/);

    const deleted = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          host: "memory.allenlim.net",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "memory_delete", arguments: { id: "memory-id" } },
        }),
      }),
      env,
      executionContext(),
    );
    assert.equal(deleted.status, 200);
    const rpc = await parseMcpResponse(deleted);
    assert.match(JSON.stringify(rpc), /delete permission/);
    assert.equal(profileCalls, 0);
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

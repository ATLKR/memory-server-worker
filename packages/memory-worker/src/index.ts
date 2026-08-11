/**
 * Memory Server Worker ??entry point.
 *
 * Exposes a stateless MCP server (via `createMcpHandler` from the Agents SDK)
 * whose tools are backed by a `MemoryAgent` Durable Object. Each MCP tool call
 * routes to the DO instance named by the request's *scope*.
 *
 * Auth: SSO via the Allen Labs central auth server (auth-api.allen.company).
 * The client sends an RS256 JWT as `Authorization: Bearer <jwt>`. The worker
 * verifies the JWT signature against the auth server's JWKS endpoint
 * ({AUTH_API_URL}/.well-known/jwks.json) using `jose`. No static tokens or
 * secrets are stored on this worker ??auth is fully delegated.
 *
 * Scope resolution (each scope ??its own Durable Object ??isolated SQLite):
 *   1. `x-memory-scope` header if present
 *   2. `DEFAULT_SCOPE` var if non-empty
 *   3. JWT `sub` (Better Auth user id) ??the default for personal use
 *
 * The memory tools mirror the Cloudflare Agents SDK memory-layer concepts:
 *   - `memory_add`     ??writable short-form context (set_context equivalent)
 *   - `memory_search`  ??searchable context (search_context / AgentSearchProvider)
 *   - `memory_load`    ??loadable context / skills (load_context equivalent)
 *   - `memory_get` / `memory_list` / `memory_update` / `memory_delete` / `memory_stats`
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createMcpHandler } from "agents/mcp";
import { verifyJwt, extractBearerToken, type SessionPayload } from "./auth";
import type { MemoryEntry } from "./schema";
import {
  addMemoryShape,
  searchMemoryShape,
  getMemoryShape,
  listMemoryShape,
  updateMemoryShape,
  deleteMemoryShape,
  loadMemoryShape,
  memoryEntryOutputShape,
  searchOutputShape,
  deleteOutputShape,
  statsOutputShape,
  loadOutputShape,
} from "./schema";
import {
  handleSkillsList,
  handleSkillsGet,
  handleResourceRead,
  hasSkills,
} from "./skills";

// Re-export the DO class ??wrangler.jsonc references it by name.
export { MemoryAgent } from "./memory-do";

// ---------- DO RPC interface ----------

/**
 * Interface describing the RPC methods exposed by MemoryAgent.
 * We cast the DO stub to this interface because the full Agent type
 * hierarchy is too complex for TypeScript to resolve the RPC method
 * signatures automatically.
 */
interface MemoryAgentRpc {
  add(params: {
    content: string;
    key?: string;
    namespace?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<MemoryEntry>;
  search(params: {
    query: string;
    namespace?: string;
    limit?: number;
  }): Promise<MemoryEntry[]>;
  get(params: { key: string }): Promise<MemoryEntry | null>;
  list(params: {
    namespace?: string;
    tag?: string;
    limit?: number;
  }): Promise<MemoryEntry[]>;
  update(params: {
    key: string;
    content?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    appendContent?: boolean;
  }): Promise<MemoryEntry | null>;
  delete(params: { key: string }): Promise<{ deleted: boolean }>;
  load(params: { key: string }): Promise<MemoryEntry | null>;
  stats(): Promise<{
    total: number;
    byNamespace: Record<string, number>;
  }>;
}

/**
 * Return a typed RPC stub for the MemoryAgent DO addressed by `scope`.
 * Each scope gets its own DO instance ??its own SQLite database.
 */
function memoryStub(env: Env, scope: string): MemoryAgentRpc {
  const id = env.MEMORY_AGENT.idFromName(scope);
  const stub = env.MEMORY_AGENT.get(id);
  return stub as unknown as MemoryAgentRpc;
}

// ---------- Auth (JWT via Allen Labs auth server JWKS) ----------

/**
 * Authenticate the request by verifying the bearer JWT against the auth
 * server's JWKS. Returns the resolved scope + session payload, or null
 * if auth fails.
 *
 * Scope resolution order:
 *   1. `x-memory-scope` header (explicit override)
 *   2. `DEFAULT_SCOPE` var if non-empty
 *   3. JWT `sub` (user id) ??default for personal use
 */
async function authenticate(
  request: Request,
  env: Env,
): Promise<{ scope: string; session: SessionPayload } | null> {
  const authApiUrl = env.AUTH_API_URL;
  if (!authApiUrl) {
    console.error("[auth] AUTH_API_URL is not configured");
    return null;
  }

  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) return null;

  const session = await verifyJwt(authApiUrl, token);
  if (!session) return null;

  const scope =
    request.headers.get("x-memory-scope") ||
    env.DEFAULT_SCOPE ||
    session.sub;
  return { scope, session };
}

// ---------- MCP server factory ----------

function createServer(env: Env, scope: string): McpServer {
  const server = new McpServer(
    { name: "memory-server", version: "0.1.0" },
    {
      // Server-level instructions ??ChatGPT/Codex read these on initialize.
      // Keep the most important guidance in the first 512 characters.
      instructions:
        "This is a personal persistent-memory server. ALWAYS call memory_search " +
        "at the start of every user message to recall relevant context before " +
        "responding. After responding, save any new preferences, decisions, " +
        "facts, or project details using memory_add. Use memory_update to " +
        "append to existing memories. Namespaces: preferences, projects, " +
        "decisions, facts, conversations.",
    },
  );

  // ---- Skills extension ----
  // Register capabilities for resources (needed for resources/read) and
  // the skills extension (io.modelcontextprotocol/skills) so ChatGPT's
  // "Scan Tools" can discover and import skill files.
  if (hasSkills()) {
    server.server.registerCapabilities({
      resources: { listChanged: true },
    });
    server.server.registerCapabilities({
      extensions: { "io.modelcontextprotocol/skills": {} },
    } as Record<string, unknown>);

    // Zod schemas for custom skills/* methods (SEP-2640).
    const SkillsListSchema = z.object({
      method: z.literal("skills/list"),
      params: z
        .object({ cursor: z.string().optional() })
        .optional(),
    });
    const SkillsGetSchema = z.object({
      method: z.literal("skills/get"),
      params: z.object({ uri: z.string() }),
    });

    // skills/list ??paginated catalog of skills
    server.server.setRequestHandler(
      SkillsListSchema as unknown as Parameters<typeof server.server.setRequestHandler>[0],
      async (req: { params?: { cursor?: string } }) => {
        return await handleSkillsList({ cursor: req.params?.cursor });
      },
    );

    // skills/get ??fetch a single skill entry by URI
    server.server.setRequestHandler(
      SkillsGetSchema as unknown as Parameters<typeof server.server.setRequestHandler>[0],
      async (req: { params?: { uri?: string } }) => {
        const result = await handleSkillsGet({ uri: req.params?.uri ?? "" });
        if (!result) {
          return { error: { code: -32602, message: "skill not found" } };
        }
        return result;
      },
    );

    // resources/read ??fetch a skill resource by URI
    server.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (req: { params: { uri: string } }) => {
        const result = await handleResourceRead({ uri: req.params.uri });
        if (!result) {
          return { contents: [] };
        }
        return result;
      },
    );
  }

  const stub = memoryStub(env, scope);

  // ---- memory_add ----
  server.registerTool(
    "memory_add",
    {
      description:
        "Store a memory entry. Use for facts, preferences, decisions, " +
        "learned information, or any text you want to recall later. " +
        "If a memory with the same key already exists, it is updated. " +
        "Provide a descriptive `key` for entries you want to fetch by name " +
        "(e.g. 'project-alpha-overview'). Omit `key` for ephemeral notes.",
      inputSchema: addMemoryShape,
      outputSchema: memoryEntryOutputShape,
    },
    async (params) => {
      const entry = await stub.add({
        content: params.content,
        key: params.key,
        namespace: params.namespace,
        tags: params.tags,
        metadata: params.metadata,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }],
        structuredContent: entry as unknown as Record<string, unknown>,
      };
    },
  );

  // ---- memory_search ----
  server.registerTool(
    "memory_search",
    {
      description:
        "Full-text search across all stored memories. Returns ranked " +
        "results matching the query. Optionally filter by namespace.",
      inputSchema: searchMemoryShape,
      outputSchema: searchOutputShape,
    },
    async (params) => {
      const results = await stub.search({
        query: params.query,
        namespace: params.namespace,
        limit: params.limit,
      });
      const structured = { count: results.length, results };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(structured, null, 2),
          },
        ],
        structuredContent: structured as unknown as Record<string, unknown>,
      };
    },
  );

  // ---- memory_get ----
  server.registerTool(
    "memory_get",
    {
      description:
        "Fetch a single memory by its key. Returns the full entry " +
        "including content, tags, and metadata.",
      inputSchema: getMemoryShape,
      outputSchema: memoryEntryOutputShape,
    },
    async (params) => {
      const entry = await stub.get({ key: params.key });
      if (!entry) {
        return {
          content: [
            { type: "text" as const, text: `No memory found with key: ${params.key}` },
          ],
          isError: true as const,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }],
        structuredContent: entry as unknown as Record<string, unknown>,
      };
    },
  );

  // ---- memory_list ----
  server.registerTool(
    "memory_list",
    {
      description:
        "List stored memories, optionally filtered by namespace or tag. " +
        "Returns entries ordered by most recently updated.",
      inputSchema: listMemoryShape,
      outputSchema: searchOutputShape,
    },
    async (params) => {
      const results = await stub.list({
        namespace: params.namespace,
        tag: params.tag,
        limit: params.limit,
      });
      const structured = { count: results.length, results };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(structured, null, 2),
          },
        ],
        structuredContent: structured as unknown as Record<string, unknown>,
      };
    },
  );

  // ---- memory_update ----
  server.registerTool(
    "memory_update",
    {
      description:
        "Update an existing memory by key. Can replace or append content, " +
        "replace tags, and merge metadata. Use appendContent to add to " +
        "existing content (e.g. appending new notes to a running document).",
      inputSchema: updateMemoryShape,
      outputSchema: memoryEntryOutputShape,
    },
    async (params) => {
      const entry = await stub.update({
        key: params.key,
        content: params.content,
        tags: params.tags,
        metadata: params.metadata,
        appendContent: params.appendContent,
      });
      if (!entry) {
        return {
          content: [
            { type: "text" as const, text: `No memory found with key: ${params.key}` },
          ],
          isError: true as const,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }],
        structuredContent: entry as unknown as Record<string, unknown>,
      };
    },
  );

  // ---- memory_delete ----
  server.registerTool(
    "memory_delete",
    {
      description: "Delete a memory by key. This is irreversible.",
      inputSchema: deleteMemoryShape,
      outputSchema: deleteOutputShape,
    },
    async (params) => {
      const result = await stub.delete({ key: params.key });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  // ---- memory_load ----
  server.registerTool(
    "memory_load",
    {
      description:
        "Load a large document (skill-style) by key in full. Use for " +
        "reference material, runbooks, or templates stored as memories. " +
        "Equivalent to the loadable context / skills pattern in the " +
        "Agents SDK memory layer.",
      inputSchema: loadMemoryShape,
      outputSchema: loadOutputShape,
    },
    async (params) => {
      const entry = await stub.load({ key: params.key });
      if (!entry) {
        return {
          content: [
            { type: "text" as const, text: `No memory found with key: ${params.key}` },
          ],
          isError: true as const,
        };
      }
      return {
        content: [{ type: "text" as const, text: entry.content }],
        structuredContent: { content: entry.content } as unknown as Record<string, unknown>,
      };
    },
  );

  // ---- memory_stats ----
  server.registerTool(
    "memory_stats",
    {
      description:
        "Return memory statistics: total count and per-namespace breakdown.",
      outputSchema: statsOutputShape,
    },
    async () => {
      const stats = await stub.stats();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
        structuredContent: stats as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

// ---------- SSO endpoints ----------
//
// The CLI plugin uses these to obtain a JWT through the Allen Labs auth
// server's SSO flow:
//
//   1. `mem login` opens a browser to {MEMORY_SERVER_URL}/auth/sso
//   2. The worker generates a random `state` value, stores it in an
//      HttpOnly SameSite=Lax cookie, and 302-redirects to
//      {AUTH_WEB_URL}/sign-in?return_to={MEMORY_SERVER_URL}/auth/callback?state=...
//   3. The user signs in on auth.allen.company
//   4. auth-web mints a code and redirects back to /auth/callback?code=...&state=...
//   5. The worker validates the state cookie (CSRF protection), exchanges
//      the code at {AUTH_API_URL}/sso/exchange, and returns the JWT as JSON.
//
// The state cookie proves the callback originated from a legitimate
// /auth/sso flow on this worker. An attacker on a different origin cannot
// set cookies on this worker's domain, so they cannot forge the state.
//
// The worker needs AUTH_WEB_URL (the auth UI origin) configured as a var.

const AUTH_WEB_URL_DEFAULT = "https://auth.allen.company";
const SSO_STATE_COOKIE = "memory_sso_state";
const SSO_UI_FLOW_COOKIE = "memory_sso_ui";
const SSO_TOKEN_COOKIE = "memory_token";
const SSO_STATE_MAX_AGE = 600; // 10 minutes

/**
 * Generate a cryptographically random state value for CSRF protection.
 * Uses the Web Crypto API available in the Workers runtime.
 */
function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64url encode without padding.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function handleSsoStart(env: Env, requestUrl: URL): Promise<Response> {
  const authWebUrl = (env.AUTH_WEB_URL || AUTH_WEB_URL_DEFAULT).replace(/\/$/, "");
  const state = generateState();

  // Detect UI flow: /auth/sso?ui=1 means the browser is logging in
  // through the web UI (not the CLI). The callback will set a token
  // cookie and redirect to / instead of returning raw JSON.
  const isUiFlow = requestUrl.searchParams.get("ui") === "1";

  // Build the callback URL with state param. We include state in return_to
  // so auth-web can pass it back (if it preserves query params). The cookie
  // is the primary validation mechanism.
  const callbackUrl = `${requestUrl.origin}/auth/callback?state=${encodeURIComponent(state)}`;
  const signInUrl = `${authWebUrl}/sign-in?return_to=${encodeURIComponent(callbackUrl)}`;

  const redirect = Response.redirect(signInUrl, 302);
  const headers = new Headers(redirect.headers);
  // State cookie (CSRF protection) — always set.
  headers.append(
    "Set-Cookie",
    `${SSO_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SSO_STATE_MAX_AGE}; Path=/auth`,
  );
  // UI flow flag — only set when ?ui=1 is present.
  if (isUiFlow) {
    headers.append(
      "Set-Cookie",
      `${SSO_UI_FLOW_COOKIE}=1; HttpOnly; Secure; SameSite=Lax; Max-Age=${SSO_STATE_MAX_AGE}; Path=/auth`,
    );
  }
  return new Response(redirect.body, {
    status: redirect.status,
    statusText: redirect.statusText,
    headers,
  });
}

async function handleSsoCallback(env: Env, requestUrl: URL, request: Request): Promise<Response> {
  // --- CSRF: validate state cookie ---
  const cookieHeader = request.headers.get("cookie") ?? "";
  const stateCookie = parseCookie(cookieHeader, SSO_STATE_COOKIE);
  const stateParam = requestUrl.searchParams.get("state");
  const isUiFlow = parseCookie(cookieHeader, SSO_UI_FLOW_COOKIE) === "1";

  // Cookies to clear on any exit path (state + ui flow flag).
  const clearStateCookie = `${SSO_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/auth`;
  const clearUiFlowCookie = `${SSO_UI_FLOW_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/auth`;

  // Build a JSON error response with cookie-clearing headers.
  // Each Set-Cookie MUST be a separate header (appended, not joined).
  function errorResponse(
    body: string,
    status: number,
    cookies: string[] = [clearStateCookie, clearUiFlowCookie],
  ): Response {
    const headers = new Headers();
    headers.set("content-type", "application/json");
    for (const c of cookies) {
      headers.append("Set-Cookie", c);
    }
    return new Response(body, { status, headers });
  }

  if (!stateCookie) {
    return errorResponse(
      JSON.stringify({
        error: "missing state cookie — start the login flow from /auth/sso",
      }),
      400,
    );
  }

  // If state param is present (auth-web passed it back), it must match
  // the cookie. If state param is absent, the cookie alone proves the
  // flow started from /auth/sso.
  if (stateParam && stateParam !== stateCookie) {
    return errorResponse(
      JSON.stringify({ error: "state mismatch — possible CSRF attempt" }),
      400,
    );
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    return errorResponse(JSON.stringify({ error: "missing code parameter" }), 400);
  }

  const authApiUrl = (env.AUTH_API_URL ?? "").replace(/\/$/, "");
  if (!authApiUrl) {
    return errorResponse(JSON.stringify({ error: "AUTH_API_URL not configured" }), 500);
  }

  // The client_id must match the origin the code was minted for.
  // For the worker-hosted callback, the origin is the worker's own URL.
  const clientId = requestUrl.origin;

  const exchangeRes = await fetch(`${authApiUrl}/sso/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      client_id: clientId,
      include_token: true,
    }),
  });

  const exchange = (await exchangeRes.json().catch(() => null)) as
    | { token?: string; expires_in?: number; user?: { id?: string; email?: string; name?: string | null } }
    | { error?: string }
    | null;

  if (!exchangeRes.ok || !exchange || !("token" in exchange) || !exchange.token) {
    const error =
      exchange && "error" in exchange ? exchange.error : `SSO exchange failed (${exchangeRes.status})`;
    return errorResponse(
      JSON.stringify({ error }),
      exchangeRes.status === 400 ? 400 : 502,
    );
  }

  const token = exchange.token;
  const expiresIn = exchange.expires_in ?? 8 * 60 * 60;

  // --- UI flow: set token cookie + redirect to / ---
  // The token cookie is non-HttpOnly so the UI's JavaScript can read it
  // and move it to sessionStorage. The UI deletes the cookie after reading.
  if (isUiFlow) {
    const tokenCookie = `${SSO_TOKEN_COOKIE}=${token}; Secure; SameSite=Lax; Max-Age=60; Path=/`;
    const headers = new Headers();
    headers.set("Location", "/");
    headers.append("Set-Cookie", tokenCookie);
    headers.append("Set-Cookie", clearStateCookie);
    headers.append("Set-Cookie", clearUiFlowCookie);
    return new Response(null, { status: 302, headers });
  }

  // --- CLI flow: return JSON (existing behavior) ---
  return errorResponse(
    JSON.stringify({
      token,
      expires_in: expiresIn,
      user: exchange.user,
    }),
    200,
  );
}

/**
 * Parse a specific cookie value from a Cookie header.
 * Returns null if the cookie is not present.
 */
function parseCookie(cookieHeader: string, name: string): string | null {
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const eqIdx = cookie.indexOf("=");
    if (eqIdx === -1) continue;
    const key = cookie.slice(0, eqIdx).trim();
    const value = cookie.slice(eqIdx + 1).trim();
    if (key === name) return value;
  }
  return null;
}

// ---------- REST API for the web UI ----------
//
// Simple REST endpoints that call the same Durable Object methods as the
// MCP tools. The web UI (served by a separate UI worker) proxies these
// through a service binding, so they share the same origin and auth.
//
// All endpoints require a valid JWT (verified by the `authenticate`
// function before reaching here).

async function handleRestApi(
  request: Request,
  env: Env,
  url: URL,
  scope: string,
): Promise<Response> {
  const stub = memoryStub(env, scope);
  const method = request.method;
  const path = url.pathname.replace(/^\/api\/?/, "");

  try {
    // GET /api/stats
    if (path === "stats" && method === "GET") {
      const stats = await stub.stats();
      return Response.json(stats);
    }

    // GET /api/memories?namespace=&tag=&limit=
    if (path === "memories" && method === "GET") {
      const namespace = url.searchParams.get("namespace") ?? undefined;
      const tag = url.searchParams.get("tag") ?? undefined;
      const limit = url.searchParams.get("limit")
        ? Math.min(parseInt(url.searchParams.get("limit")!, 10), 500)
        : 50;
      const results = await stub.list({ namespace, tag, limit });
      return Response.json({ count: results.length, results });
    }

    // POST /api/memories  { content, key?, namespace?, tags?, metadata? }
    if (path === "memories" && method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        content?: string;
        key?: string;
        namespace?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
      } | null;
      if (!body?.content) {
        return Response.json({ error: "content is required" }, { status: 400 });
      }
      const entry = await stub.add({
        content: body.content,
        key: body.key,
        namespace: body.namespace,
        tags: body.tags,
        metadata: body.metadata,
      });
      return Response.json(entry, { status: 201 });
    }

    // GET /api/search?q=&namespace=&limit=
    if (path === "search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) {
        return Response.json({ count: 0, results: [] });
      }
      const namespace = url.searchParams.get("namespace") ?? undefined;
      const limit = url.searchParams.get("limit")
        ? Math.min(parseInt(url.searchParams.get("limit")!, 10), 100)
        : 20;
      const results = await stub.search({ query: q, namespace, limit });
      return Response.json({ count: results.length, results });
    }

    // /api/memories/:key
    const keyMatch = path.match(/^memories\/(.+)$/);
    if (keyMatch) {
      const key = decodeURIComponent(keyMatch[1]!);

      // GET /api/memories/:key
      if (method === "GET") {
        const entry = await stub.get({ key });
        if (!entry) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return Response.json(entry);
      }

      // PATCH /api/memories/:key  { content?, tags?, metadata?, appendContent? }
      if (method === "PATCH") {
        const body = (await request.json().catch(() => null)) as {
          content?: string;
          tags?: string[];
          metadata?: Record<string, unknown>;
          appendContent?: boolean;
        } | null;
        if (!body) {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }
        const entry = await stub.update({
          key,
          content: body.content,
          tags: body.tags,
          metadata: body.metadata,
          appendContent: body.appendContent,
        });
        if (!entry) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return Response.json(entry);
      }

      // DELETE /api/memories/:key
      if (method === "DELETE") {
        const result = await stub.delete({ key });
        return Response.json(result);
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    console.error("[rest-api] error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 },
    );
  }
}

// ---------- Worker entry ----------

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint (outside MCP + auth).
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "memory-server" });
    }

    // OAuth 2.1 resource server metadata (RFC 9728). Tells MCP clients
    // (ChatGPT, Claude, Codex) where the authorization server lives.
    // The auth server publishes its own /.well-known/oauth-authorization-server
    // which clients fetch to discover the authorize/token/register endpoints.
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      const authApiUrl = (env.AUTH_API_URL ?? "").replace(/\/$/, "");
      return Response.json({
        resource: url.origin,
        authorization_servers: [authApiUrl],
        scopes_supported: ["openid", "profile", "email"],
        bearer_methods_supported: ["header"],
        resource_documentation: `${url.origin}/healthz`,
      });
    }

    // SSO endpoints (outside MCP auth — they're the auth bootstrap).
    if (url.pathname === "/auth/sso") {
      return handleSsoStart(env, url);
    }
    if (url.pathname === "/auth/callback") {
      return handleSsoCallback(env, url, request);
    }

    // Auth check — verify JWT via JWKS before entering MCP or REST API.
    // On 401, return a WWW-Authenticate header pointing to the resource
    // metadata so MCP clients can auto-discover the OAuth flow.
    const auth = await authenticate(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate":
            `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
        },
      });
    }

    // REST API for the web UI. Same auth + same DO as MCP tools.
    if (url.pathname.startsWith("/api/")) {
      return handleRestApi(request, env, url, auth.scope);
    }

    // Build a fresh McpServer for this request (authenticated + scoped),
    // then pass it to createMcpHandler. The handler processes the MCP
    // Streamable HTTP protocol on the /mcp route.
    const server = createServer(env, auth.scope);
    const handler = createMcpHandler(server, {
      route: "/mcp",
      corsOptions: {
        origin: "*",
        methods: "GET,POST,DELETE,OPTIONS",
        headers: "content-type,authorization,x-memory-scope",
      },
    });

    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

/**
 * Memory Server Worker — entry point.
 *
 * Exposes a stateless MCP server (via `createMcpHandler` from the Agents SDK)
 * whose tools are backed by Cloudflare Agent Memory — a managed service that
 * provides automatic extraction, classification, supersession, and hybrid
 * search (keyword + semantic + topic key).
 *
 * Auth: SSO via the Allen Labs central auth server (auth-api.allen.company).
 * The client sends an RS256 JWT as `Authorization: Bearer <jwt>`. The worker
 * verifies the JWT signature against the auth server's JWKS endpoint
 * ({AUTH_API_URL}/.well-known/jwks.json) using `jose`.
 *
 * Scope resolution (each scope → its own Agent Memory profile):
 *   1. `x-memory-scope` header if present
 *   2. `DEFAULT_SCOPE` var if non-empty
 *   3. JWT `sub` (Better Auth user id) — the default for personal use
 *
 * MCP tools:
 *   - memory_add      → profile.remember()  (store a single memory)
 *   - memory_search   → profile.recall()    (hybrid search + synthesis)
 *   - memory_ingest   → profile.ingest()    (extract memories from conversation)
 *   - memory_list     → profile.list()      (paginated list with filters)
 *   - memory_get      → profile.get()       (fetch by ID)
 *   - memory_delete   → profile.delete()    (delete by ID)
 *   - memory_delete_session → profile.deleteSession() (delete by session)
 *   - memory_summary  → profile.getSummary() (structured Markdown summary)
 *   - memory_stats    → computed from list() (total + per-type counts)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createMcpHandler } from "agents/mcp";
import { verifyJwt, extractBearerToken, type SessionPayload } from "./auth";
import type { MemoryEntry, MemoryType, RecallResult, StatsResponse } from "./schema";
import {
  addMemoryShape,
  searchMemoryShape,
  ingestMemoryShape,
  listMemoryShape,
  getMemoryShape,
  deleteMemoryShape,
  deleteSessionShape,
  summaryShape,
  memoryEntryOutputShape,
  searchOutputShape,
  ingestOutputShape,
  listOutputShape,
  deleteOutputShape,
  deleteSessionOutputShape,
  statsOutputShape,
  summaryOutputShape,
} from "./schema";
import {
  handleSkillsList,
  handleSkillsGet,
  handleResourceRead,
  hasSkills,
} from "./skills";

// ---------- Agent Memory helpers ----------

/**
 * Get an Agent Memory profile for the given scope.
 * Each scope gets its own isolated memory profile.
 *
 * Agent Memory profile names must contain only lowercase letters (a-z),
 * digits (0-9), and hyphens (-), max 100 characters. We sanitize the
 * scope (which may be a JWT subject like "abc123_Uvwx") to fit.
 */
function getProfile(env: Env, scope: string) {
  const profileName = scope
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "default";
  return env.MEMORY.getProfile(profileName);
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
 *   3. JWT `sub` (user id) — default for personal use
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
    { name: "memory-server", version: "0.2.0" },
    {
      // Server-level instructions — ChatGPT/Codex read these on initialize.
      instructions:
        "This is a personal persistent-memory server powered by Cloudflare " +
        "Agent Memory. ALWAYS call memory_search at the start of every " +
        "user message to recall relevant context before responding. " +
        "After a conversation turn, use memory_ingest to automatically " +
        "extract and store facts, events, instructions, and tasks. " +
        "Use memory_add to store a specific memory explicitly. " +
        "Use memory_summary to get a structured overview of everything " +
        "you know about the user. Memories are automatically classified, " +
        "deduplicated, and superseded when newer facts replace older ones.",
    },
  );

  // ---- Skills extension ----
  if (hasSkills()) {
    server.server.registerCapabilities({
      resources: { listChanged: true },
    });
    server.server.registerCapabilities({
      extensions: { "io.modelcontextprotocol/skills": {} },
    } as Record<string, unknown>);

    const SkillsListSchema = z.object({
      method: z.literal("skills/list"),
      params: z.object({ cursor: z.string().optional() }).optional(),
    });
    const SkillsGetSchema = z.object({
      method: z.literal("skills/get"),
      params: z.object({ uri: z.string() }),
    });

    server.server.setRequestHandler(
      SkillsListSchema as unknown as Parameters<typeof server.server.setRequestHandler>[0],
      async (req: { params?: { cursor?: string } }) => {
        return await handleSkillsList({ cursor: req.params?.cursor });
      },
    );

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

  // ---- memory_add ----
  server.registerTool(
    "memory_add",
    {
      description:
        "Store a memory explicitly. Agent Memory will automatically " +
        "classify it (fact/event/instruction/task), generate a summary, " +
        "and handle deduplication. If a similar fact or instruction " +
        "already exists, the new one supersedes the old (history is " +
        "preserved). Use this when you know exactly what to remember. " +
        "For extracting memories from a conversation, use memory_ingest " +
        "instead.",
      inputSchema: addMemoryShape,
      outputSchema: memoryEntryOutputShape,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, scope);
        const memory = await profile.remember({
          content: params.content,
          sessionId: params.sessionId ?? null,
        });
        const entry: MemoryEntry = {
          id: memory.id,
          type: memory.type,
          summary: memory.summary,
          content: memory.content,
          sessionId: memory.sessionId,
          createdAt: memory.createdAt.toISOString(),
          updatedAt: memory.updatedAt.toISOString(),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }],
          structuredContent: entry as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to store memory: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
  );

  // ---- memory_search ----
  server.registerTool(
    "memory_search",
    {
      description:
        "Search memories using natural language. Agent Memory runs " +
        "hybrid search (keyword + semantic + topic key) in parallel " +
        "and returns a synthesized answer grounded in stored content. " +
        "Call this at the start of every user message to recall " +
        "relevant context.",
      inputSchema: searchMemoryShape,
      outputSchema: searchOutputShape,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, scope);
        const result: RecallResult = await profile.recall(params.query, {
          thinkingLevel: params.thinkingLevel,
          responseLength: params.responseLength,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
  );

  // ---- memory_ingest ----
  server.registerTool(
    "memory_ingest",
    {
      description:
        "Extract memories from a conversation. Agent Memory reads the " +
        "messages and automatically identifies facts, events, " +
        "instructions, and tasks. Re-ingesting the same conversation " +
        "is idempotent — no duplicates are created. Call this after " +
        "a conversation turn or when the user goes idle, NOT after " +
        "every single message.",
      inputSchema: ingestMemoryShape,
      outputSchema: ingestOutputShape,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, scope);
        await profile.ingest(
          params.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          { sessionId: params.sessionId ?? null },
        );
        const result = { ingested: true };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
  );

  // ---- memory_list ----
  server.registerTool(
    "memory_list",
    {
      description:
        "List stored memories, optionally filtered by type or session. " +
        "Returns entries ordered by most recently updated. Use the " +
        "cursor for pagination.",
      inputSchema: listMemoryShape,
      outputSchema: listOutputShape,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, scope);
        const result = await profile.list({
          type: params.type,
          sessionId: params.sessionId,
          limit: params.limit ?? 50,
          cursor: params.cursor,
        });
        const structured = {
          count: result.memories.length,
          memories: result.memories.map((m) => ({
            id: m.id,
            type: m.type,
            summary: m.summary,
            sessionId: m.sessionId,
            createdAt: m.createdAt.toISOString(),
            updatedAt: m.updatedAt.toISOString(),
          })),
          cursor: result.cursor ?? null,
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(structured, null, 2) },
          ],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `List failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
  );

  // ---- memory_get ----
  server.registerTool(
    "memory_get",
    {
      description:
        "Fetch a single memory by its ID. Returns the full entry " +
        "including content and metadata.",
      inputSchema: getMemoryShape,
      outputSchema: memoryEntryOutputShape,
    },
    async (params) => {
      const profile = await getProfile(env, scope);
      try {
        const memory = await profile.get(params.id);
        const entry: MemoryEntry = {
          id: memory.id,
          type: memory.type,
          summary: memory.summary,
          content: memory.content,
          sessionId: memory.sessionId,
          createdAt: memory.createdAt.toISOString(),
          updatedAt: memory.updatedAt.toISOString(),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }],
          structuredContent: entry as unknown as Record<string, unknown>,
        };
      } catch {
        return {
          content: [
            { type: "text" as const, text: `No memory found with id: ${params.id}` },
          ],
          isError: true as const,
        };
      }
    },
  );

  // ---- memory_delete ----
  server.registerTool(
    "memory_delete",
    {
      description: "Delete a memory by ID. This is irreversible.",
      inputSchema: deleteMemoryShape,
      outputSchema: deleteOutputShape,
    },
    async (params) => {
      const profile = await getProfile(env, scope);
      try {
        await profile.delete(params.id);
        const result = { deleted: true };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch {
        return {
          content: [
            { type: "text" as const, text: `No memory found with id: ${params.id}` },
          ],
          isError: true as const,
        };
      }
    },
  );

  // ---- memory_delete_session ----
  server.registerTool(
    "memory_delete_session",
    {
      description:
        "Delete all memories associated with a session ID. " +
        "Idempotent — deleting a session with no memories is a no-op.",
      inputSchema: deleteSessionShape,
      outputSchema: deleteSessionOutputShape,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, scope);
        await profile.deleteSession(params.sessionId);
        const result = { deleted: true };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to delete session: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
  );

  // ---- memory_summary ----
  server.registerTool(
    "memory_summary",
    {
      description:
        "Generate a structured Markdown summary of everything stored " +
        "in memory. Use this to inspect what Agent Memory remembers " +
        "about the user, or to bootstrap a new session with context.",
      inputSchema: summaryShape,
      outputSchema: summaryOutputShape,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, scope);
        const result = await profile.getSummary({
          sessionId: params.sessionId ?? null,
        });
        const structured = { summary: result.summary };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(structured, null, 2) },
          ],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Summary failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
  );

  // ---- memory_stats ----
  server.registerTool(
    "memory_stats",
    {
      description:
        "Return memory statistics: total count and per-type breakdown " +
        "(fact, event, instruction, task). Note: counts are approximate " +
        "for profiles with more than 500 memories.",
      outputSchema: statsOutputShape,
    },
    async () => {
      try {
        const profile = await getProfile(env, scope);
        // Agent Memory doesn't have a direct stats endpoint, so we
        // compute from list() with a large limit. If there are more
        // than 500 memories, we note the approximate count.
        const all = await profile.list({ limit: 500 });
        const byType: Partial<Record<MemoryType, number>> = {};
        for (const m of all.memories) {
          byType[m.type] = (byType[m.type] ?? 0) + 1;
        }
        const stats: StatsResponse = {
          total: all.cursor ? 500 : all.memories.length,
          byType,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
          structuredContent: stats as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Stats failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
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
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function handleSsoStart(env: Env, requestUrl: URL): Promise<Response> {
  const authWebUrl = (env.AUTH_WEB_URL || AUTH_WEB_URL_DEFAULT).replace(/\/$/, "");
  const state = generateState();

  const isUiFlow = requestUrl.searchParams.get("ui") === "1";

  const callbackUrl = `${requestUrl.origin}/auth/callback?state=${encodeURIComponent(state)}`;
  const signInUrl = `${authWebUrl}/sign-in?return_to=${encodeURIComponent(callbackUrl)}`;

  const redirect = Response.redirect(signInUrl, 302);
  const headers = new Headers(redirect.headers);
  headers.append(
    "Set-Cookie",
    `${SSO_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SSO_STATE_MAX_AGE}; Path=/auth`,
  );
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
  const cookieHeader = request.headers.get("cookie") ?? "";
  const stateCookie = parseCookie(cookieHeader, SSO_STATE_COOKIE);
  const stateParam = requestUrl.searchParams.get("state");
  const isUiFlow = parseCookie(cookieHeader, SSO_UI_FLOW_COOKIE) === "1";

  const clearStateCookie = `${SSO_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/auth`;
  const clearUiFlowCookie = `${SSO_UI_FLOW_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/auth`;

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
      JSON.stringify({ error: "missing state cookie — start the login flow from /auth/sso" }),
      400,
    );
  }

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

  const clientId = requestUrl.origin;

  const exchangeRes = await fetch(`${authApiUrl}/sso/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, client_id: clientId, include_token: true }),
  });

  const exchange = (await exchangeRes.json().catch(() => null)) as
    | { token?: string; expires_in?: number; user?: { id?: string; email?: string; name?: string | null } }
    | { error?: string }
    | null;

  if (!exchangeRes.ok || !exchange || !("token" in exchange) || !exchange.token) {
    const error =
      exchange && "error" in exchange ? exchange.error : `SSO exchange failed (${exchangeRes.status})`;
    return errorResponse(JSON.stringify({ error }), exchangeRes.status === 400 ? 400 : 502);
  }

  const token = exchange.token;
  const expiresIn = exchange.expires_in ?? 8 * 60 * 60;

  if (isUiFlow) {
    const tokenCookie = `${SSO_TOKEN_COOKIE}=${token}; Secure; SameSite=Lax; Max-Age=60; Path=/`;
    const headers = new Headers();
    headers.set("Location", "/");
    headers.append("Set-Cookie", tokenCookie);
    headers.append("Set-Cookie", clearStateCookie);
    headers.append("Set-Cookie", clearUiFlowCookie);
    return new Response(null, { status: 302, headers });
  }

  return errorResponse(
    JSON.stringify({ token, expires_in: expiresIn, user: exchange.user }),
    200,
  );
}

/**
 * Parse a specific cookie value from a Cookie header.
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
// Simple REST endpoints that call the same Agent Memory APIs as the MCP
// tools. The web UI proxies these through a service binding.
//
// All endpoints require a valid JWT.

async function handleRestApi(
  request: Request,
  env: Env,
  url: URL,
  scope: string,
): Promise<Response> {
  const profile = await getProfile(env, scope);
  const method = request.method;
  const path = url.pathname.replace(/^\/api\/?/, "");

  try {
    // GET /api/stats
    if (path === "stats" && method === "GET") {
      const all = await profile.list({ limit: 500 });
      const byType: Partial<Record<MemoryType, number>> = {};
      for (const m of all.memories) {
        byType[m.type] = (byType[m.type] ?? 0) + 1;
      }
      return Response.json({
        total: all.cursor ? 500 : all.memories.length,
        byType,
      });
    }

    // GET /api/memories?type=&sessionId=&limit=&cursor=
    if (path === "memories" && method === "GET") {
      const type = url.searchParams.get("type") as MemoryType | null;
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const limit = url.searchParams.get("limit")
        ? Math.min(parseInt(url.searchParams.get("limit")!, 10), 500)
        : 50;
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const result = await profile.list({
        type: type ?? undefined,
        sessionId,
        limit,
        cursor,
      });
      return Response.json({
        count: result.memories.length,
        memories: result.memories.map((m) => ({
          id: m.id,
          type: m.type,
          summary: m.summary,
          sessionId: m.sessionId,
          createdAt: m.createdAt.toISOString(),
          updatedAt: m.updatedAt.toISOString(),
        })),
        cursor: result.cursor ?? null,
      });
    }

    // POST /api/memories  { content, sessionId? }
    if (path === "memories" && method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        content?: string;
        sessionId?: string;
      } | null;
      if (!body?.content) {
        return Response.json({ error: "content is required" }, { status: 400 });
      }
      if (body.content.length > 32768) {
        return Response.json({ error: "content exceeds 32KB limit" }, { status: 400 });
      }
      const memory = await profile.remember({
        content: body.content,
        sessionId: body.sessionId ?? null,
      });
      return Response.json(
        {
          id: memory.id,
          type: memory.type,
          summary: memory.summary,
          content: memory.content,
          sessionId: memory.sessionId,
          createdAt: memory.createdAt.toISOString(),
          updatedAt: memory.updatedAt.toISOString(),
        },
        { status: 201 },
      );
    }

    // POST /api/search  { query, thinkingLevel?, responseLength? }
    if (path === "search" && method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        query?: string;
        thinkingLevel?: "low" | "medium" | "high";
        responseLength?: "short" | "medium" | "long";
      } | null;
      if (!body?.query) {
        return Response.json({ error: "query is required" }, { status: 400 });
      }
      if (body.query.length > 1024) {
        return Response.json({ error: "query exceeds 1KB limit" }, { status: 400 });
      }
      const result = await profile.recall(body.query, {
        thinkingLevel: body.thinkingLevel,
        responseLength: body.responseLength,
      });
      return Response.json(result);
    }

    // GET /api/search?q=  (query param style for simple GET requests)
    if (path === "search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) {
        return Response.json({ count: 0, answer: "", candidates: [] });
      }
      const result = await profile.recall(q);
      return Response.json(result);
    }

    // GET /api/summary
    if (path === "summary" && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const result = await profile.getSummary({
        sessionId: sessionId ?? null,
      });
      return Response.json(result);
    }

    // /api/memories/:id
    const idMatch = path.match(/^memories\/(.+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]!);

      if (method === "GET") {
        try {
          const memory = await profile.get(id);
          return Response.json({
            id: memory.id,
            type: memory.type,
            summary: memory.summary,
            content: memory.content,
            sessionId: memory.sessionId,
            createdAt: memory.createdAt.toISOString(),
            updatedAt: memory.updatedAt.toISOString(),
          });
        } catch {
          return Response.json({ error: "not found" }, { status: 404 });
        }
      }

      if (method === "DELETE") {
        try {
          await profile.delete(id);
          return Response.json({ deleted: true });
        } catch {
          return Response.json({ error: "not found" }, { status: 404 });
        }
      }
    }

    // DELETE /api/session/:sessionId
    const sessionMatch = path.match(/^session\/(.+)$/);
    if (sessionMatch && method === "DELETE") {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      await profile.deleteSession(sessionId);
      return Response.json({ deleted: true });
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

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "memory-server" });
    }

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

    if (url.pathname === "/auth/sso") {
      return handleSsoStart(env, url);
    }
    if (url.pathname === "/auth/callback") {
      return handleSsoCallback(env, url, request);
    }

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

    if (url.pathname.startsWith("/api/")) {
      return handleRestApi(request, env, url, auth.scope);
    }

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

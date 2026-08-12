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
 * Profile resolution:
 *   1. JWT `sub` is always the user isolation boundary.
 *   2. `x-memory-scope`, or `DEFAULT_SCOPE` when present, selects a logical
 *      sub-scope that is cryptographically bound to that user.
 *   3. With no logical scope, the legacy JWT-sub profile name is retained.
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

import {
  INVALID_PARAMS,
  McpServer,
  ProtocolError,
  ResourceNotFoundError,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMcpHandler } from "agents/mcp/server";
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
import { isValidSsoState, resolveProfileName } from "./security";
import { readBoundedBody, readJsonRequestBody } from "./body";

const addMemoryInputSchema = z.object(addMemoryShape);
const searchMemoryInputSchema = z.object(searchMemoryShape);
const ingestMemoryInputSchema = z.object(ingestMemoryShape);
const listMemoryInputSchema = z.object(listMemoryShape);
const getMemoryInputSchema = z.object(getMemoryShape);
const deleteMemoryInputSchema = z.object(deleteMemoryShape);
const deleteSessionInputSchema = z.object(deleteSessionShape);
const summaryInputSchema = z.object(summaryShape);

const memoryEntrySchema = z.object(memoryEntryOutputShape);
const searchResultSchema = z.object(searchOutputShape);
const ingestResultSchema = z.object(ingestOutputShape);
const listResultSchema = z.object(listOutputShape);
const deleteResultSchema = z.object(deleteOutputShape);
const deleteSessionResultSchema = z.object(deleteSessionOutputShape);
const statsResultSchema = z.object(statsOutputShape);
const summaryResultSchema = z.object(summaryOutputShape);
const skillResourceSchema = z.object({
  uri: z.string(),
  digest: z.string(),
});
const skillEntrySchema = z.object({
  uri: z.string(),
  frontmatter: z.object({
    name: z.string(),
    description: z.string(),
  }),
  resources: z.array(skillResourceSchema),
});
const cacheMetadataSchema = {
  ttlMs: z.number().int().nonnegative().optional(),
  cacheScope: z.enum(["private", "public"]).optional(),
};
const skillsListResultSchema = z.object({
  skills: z.array(skillEntrySchema),
  nextCursor: z.string().optional(),
  ...cacheMetadataSchema,
});
const skillsGetResultSchema = z.object({
  skill: skillEntrySchema,
  ...cacheMetadataSchema,
});

// ---------- Agent Memory helpers ----------

/**
 * Get an Agent Memory profile by its already validated, user-bound name.
 */
function getProfile(env: Env, profileName: string) {
  return env.MEMORY.getProfile(profileName);
}

// ---------- Auth (JWT via Allen Labs auth server JWKS) ----------

/**
 * Authenticate the request by verifying the bearer JWT against the auth
 * server's JWKS. Returns the resolved profile name + session payload, or null
 * if auth fails.
 *
 * The JWT subject is always the profile boundary. A requested logical scope
 * is hashed together with that subject before an Agent Memory profile is used.
 */
async function authenticate(
  request: Request,
  env: Env,
): Promise<{ profileName: string; session: SessionPayload } | null> {
  const authApiUrl = env.AUTH_API_URL;
  if (!authApiUrl) {
    console.error("[auth] AUTH_API_URL is not configured");
    return null;
  }

  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) return null;

  const session = await verifyJwt(authApiUrl, token);
  if (!session || !session.sub.trim() || session.banned === true || session.banned === 1) {
    return null;
  }

  // A caller may choose a logical sub-scope, but resolveProfileName binds it
  // cryptographically to the authenticated subject. It can never select
  // another user's profile, even when two users provide the same header.
  const logicalScope =
    request.headers.get("x-memory-scope")?.trim() || env.DEFAULT_SCOPE?.trim() || null;
  // Never fall back to the old caller-selected profile name. Legacy scoped
  // data is copied offline only after an operator verifies exclusive ownership.
  const profileName = await resolveProfileName(session.sub, logicalScope);
  return { profileName, session };
}

// ---------- MCP server factory ----------

function createServer(
  env: Env,
  profileName: string,
  era: "legacy" | "modern",
): McpServer {
  const server = new McpServer(
    { name: "memory-server", version: "2.0.0" },
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
      extensions: { "io.modelcontextprotocol/skills": {} },
    });

    const skillsListParamsSchema = z.object({ cursor: z.string().optional() });
    const skillsGetParamsSchema = z.object({ uri: z.string() });

    server.server.setRequestHandler(
      "skills/list",
      { params: skillsListParamsSchema, result: skillsListResultSchema },
      async (params) => {
        const result = await handleSkillsList({ cursor: params.cursor });
        return era === "modern"
          ? { ...result, ttlMs: 300_000, cacheScope: "private" as const }
          : result;
      },
    );

    server.server.setRequestHandler(
      "skills/get",
      { params: skillsGetParamsSchema, result: skillsGetResultSchema },
      async (params) => {
        const result = await handleSkillsGet({ uri: params.uri });
        if (!result) {
          throw new ProtocolError(INVALID_PARAMS, "skill not found");
        }
        return era === "modern"
          ? { ...result, ttlMs: 300_000, cacheScope: "private" as const }
          : result;
      },
    );

    for (const skill of [
      {
        name: "memory-recall-skill",
        uri: "skill://memory/recall/SKILL.md",
        description: "Instructions for recalling relevant personal memories.",
      },
      {
        name: "memory-capture-skill",
        uri: "skill://memory/capture/SKILL.md",
        description: "Instructions for capturing durable personal memories.",
      },
    ]) {
      server.registerResource(
        skill.name,
        skill.uri,
        {
          description: skill.description,
          mimeType: "text/markdown",
          cacheHint: { ttlMs: 300_000, cacheScope: "private" },
        },
        async (uri) => {
          const result = await handleResourceRead({ uri: uri.href });
          if (!result) {
            throw new ResourceNotFoundError(uri.href);
          }
          return result;
        },
      );
    }
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
      inputSchema: addMemoryInputSchema,
      outputSchema: memoryEntrySchema,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, profileName);
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
      inputSchema: searchMemoryInputSchema,
      outputSchema: searchResultSchema,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, profileName);
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
      inputSchema: ingestMemoryInputSchema,
      outputSchema: ingestResultSchema,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, profileName);
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
      inputSchema: listMemoryInputSchema,
      outputSchema: listResultSchema,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, profileName);
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
        "including content, type, and timestamps.",
      inputSchema: getMemoryInputSchema,
      outputSchema: memoryEntrySchema,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, profileName);
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
      inputSchema: deleteMemoryInputSchema,
      outputSchema: deleteResultSchema,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, profileName);
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
      inputSchema: deleteSessionInputSchema,
      outputSchema: deleteSessionResultSchema,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, profileName);
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
      inputSchema: summaryInputSchema,
      outputSchema: summaryResultSchema,
    },
    async (params) => {
      try {
        const profile = await getProfile(env, profileName);
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
      inputSchema: z.object({}),
      outputSchema: statsResultSchema,
    },
    async () => {
      try {
        const profile = await getProfile(env, profileName);
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
          truncated: Boolean(all.cursor),
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
    headers.set("cache-control", "no-store");
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

  if (!isValidSsoState(stateCookie, stateParam)) {
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

  let exchangeRes: Response;
  try {
    exchangeRes = await fetch(`${authApiUrl}/sso/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, client_id: clientId, include_token: true }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return errorResponse(JSON.stringify({ error: "SSO exchange unavailable" }), 502);
  }

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
    headers.set("Cache-Control", "no-store");
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

const restAddMemorySchema = z.object(addMemoryShape).strict();
const restSearchSchema = z.object(searchMemoryShape).strict();
const restListSchema = z.object(listMemoryShape).strict();
const restSummarySchema = z.object(summaryShape).strict();
const restIdSchema = z.string().min(1).max(512);
const restSessionIdSchema = z.string().min(1).max(64);
// A 32K-character content string can expand to almost 192 KiB when every
// character requires a JSON escape, so leave encoding headroom while keeping
// REST requests tightly bounded.
const MAX_REST_JSON_BYTES = 256 * 1024;

function validationError(error: z.ZodError): Response {
  return Response.json(
    {
      error: "invalid request",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
    { status: 400 },
  );
}

function decodePathPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function handleRestApi(
  request: Request,
  env: Env,
  url: URL,
  profileName: string,
): Promise<Response> {
  const method = request.method;
  const path = url.pathname.replace(/^\/api\/?/, "");

  try {
    const profile = await getProfile(env, profileName);
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
        truncated: Boolean(all.cursor),
      });
    }

    // GET /api/memories?type=&sessionId=&limit=&cursor=
    if (path === "memories" && method === "GET") {
      const limitParam = url.searchParams.get("limit");
      const parsed = restListSchema.safeParse({
        type: url.searchParams.get("type") || undefined,
        sessionId: url.searchParams.get("sessionId") || undefined,
        limit: limitParam === null ? undefined : Number(limitParam),
        cursor: url.searchParams.get("cursor") || undefined,
      });
      if (!parsed.success) return validationError(parsed.error);

      const result = await profile.list({
        type: parsed.data.type,
        sessionId: parsed.data.sessionId,
        limit: parsed.data.limit ?? 50,
        cursor: parsed.data.cursor,
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
      const body = await readJsonRequestBody(request, MAX_REST_JSON_BYTES);
      if (!body.ok) return Response.json({ error: body.error }, { status: body.status });
      const parsed = restAddMemorySchema.safeParse(body.value);
      if (!parsed.success) return validationError(parsed.error);

      const memory = await profile.remember({
        content: parsed.data.content,
        sessionId: parsed.data.sessionId ?? null,
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
      const body = await readJsonRequestBody(request, MAX_REST_JSON_BYTES);
      if (!body.ok) return Response.json({ error: body.error }, { status: body.status });
      const parsed = restSearchSchema.safeParse(body.value);
      if (!parsed.success) return validationError(parsed.error);

      const result = await profile.recall(parsed.data.query, {
        thinkingLevel: parsed.data.thinkingLevel,
        responseLength: parsed.data.responseLength,
      });
      return Response.json(result);
    }

    // GET /api/search?q=  (query param style for simple GET requests)
    if (path === "search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) {
        return Response.json({ count: 0, answer: "", candidates: [] });
      }
      const parsed = restSearchSchema.pick({ query: true }).safeParse({ query: q });
      if (!parsed.success) return validationError(parsed.error);
      const result = await profile.recall(parsed.data.query);
      return Response.json(result);
    }

    // GET /api/summary
    if (path === "summary" && method === "GET") {
      const parsed = restSummarySchema.safeParse({
        sessionId: url.searchParams.get("sessionId") || undefined,
      });
      if (!parsed.success) return validationError(parsed.error);
      const result = await profile.getSummary({
        sessionId: parsed.data.sessionId ?? null,
      });
      return Response.json(result);
    }

    // /api/memories/:id
    const idMatch = path.match(/^memories\/(.+)$/);
    if (idMatch) {
      const decodedId = decodePathPart(idMatch[1]!);
      const parsedId = restIdSchema.safeParse(decodedId);
      if (!parsedId.success) return validationError(parsedId.error);
      const id = parsedId.data;

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
      const decodedSessionId = decodePathPart(sessionMatch[1]!);
      const parsedSessionId = restSessionIdSchema.safeParse(decodedSessionId);
      if (!parsedSessionId.success) return validationError(parsedSessionId.error);
      await profile.deleteSession(parsedSessionId.data);
      return Response.json({ deleted: true });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    console.error("[rest-api] error:", err);
    return Response.json(
      { error: "internal server error" },
      { status: 500 },
    );
  }
}

// ---------- Worker entry ----------

const MCP_ALLOWED_HEADERS = [
  "content-type",
  "accept",
  "authorization",
  "x-memory-scope",
  "mcp-session-id",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "last-event-id",
].join(",");
const MCP_EXPOSED_HEADERS = [
  "mcp-session-id",
  "mcp-protocol-version",
  "www-authenticate",
].join(",");
const MAX_MCP_JSON_BYTES = 4 * 1024 * 1024;

function mcpCorsHeaders(): Headers {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", MCP_ALLOWED_HEADERS);
  headers.set("access-control-expose-headers", MCP_EXPOSED_HEADERS);
  headers.set("access-control-max-age", "86400");
  return headers;
}

function mcpJsonError(status: 400 | 413, message: string): Response {
  const headers = mcpCorsHeaders();
  headers.set("content-type", "application/json");
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: status === 413 ? -32000 : -32700, message },
      id: null,
    }),
    { status, headers },
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Browser MCP clients send an unauthenticated preflight before the actual
    // bearer-authenticated request. Handle it before JWT verification.
    if (url.pathname === "/mcp" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: mcpCorsHeaders() });
    }

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
      const headers = new Headers({
        "content-type": "application/json",
        "www-authenticate":
          `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
      });
      if (url.pathname === "/mcp") {
        for (const [name, value] of mcpCorsHeaders()) headers.set(name, value);
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers,
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleRestApi(request, env, url, auth.profileName);
    }

    let handlerRequest = request;
    if (url.pathname === "/mcp" && request.method === "POST") {
      // The Agents SDK only checks Content-Length before request.json(). Read
      // the stream ourselves so chunked requests cannot bypass its 4 MiB cap.
      const body = await readBoundedBody(request, MAX_MCP_JSON_BYTES);
      if (!body.ok) {
        if (body.reason === "too_large") {
          return mcpJsonError(413, "Request body too large");
        }
        return mcpJsonError(400, "Parse error: Invalid JSON request body");
      }
      const headers = new Headers(request.headers);
      headers.set("content-length", String(body.bytes.byteLength));
      handlerRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: body.bytes,
        redirect: request.redirect,
        signal: request.signal,
      });
    }

    const handler = createMcpHandler(
      ({ era }) => createServer(env, auth.profileName, era),
      {
        route: "/mcp",
        corsOptions: {
          origin: "*",
          methods: "GET,POST,DELETE,OPTIONS",
          headers: MCP_ALLOWED_HEADERS,
          exposeHeaders: MCP_EXPOSED_HEADERS,
        },
        // The public UI domain proxies this endpoint through a service binding.
        // Keep the direct Worker and local development endpoints explicit too.
        allowedHostnames: [
          "memory.allenlim.net",
          "memory-server.allenlim.workers.dev",
          "localhost",
          "127.0.0.1",
          "[::1]",
        ],
        allowedOriginHostnames: [
          "memory.allenlim.net",
          "memory-server.allenlim.workers.dev",
          "chatgpt.com",
          "chat.openai.com",
          "platform.openai.com",
          "localhost",
          "127.0.0.1",
          "[::1]",
        ],
      },
    );

    return handler(handlerRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;

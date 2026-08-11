/**
 * Memory Server Worker — entry point.
 *
 * Exposes a stateless MCP server (via `createMcpHandler` from the Agents SDK)
 * whose tools are backed by a `MemoryAgent` Durable Object. Each MCP tool call
 * routes to the DO instance named by the request's *scope*.
 *
 * Auth: SSO via the Allen Labs central auth server (auth-api.allen.company).
 * The client sends an RS256 JWT as `Authorization: Bearer <jwt>`. The worker
 * verifies the JWT signature against the auth server's JWKS endpoint
 * ({AUTH_API_URL}/.well-known/jwks.json) using `jose`. No static tokens or
 * secrets are stored on this worker — auth is fully delegated.
 *
 * Scope resolution (each scope → its own Durable Object → isolated SQLite):
 *   1. `x-memory-scope` header if present
 *   2. `DEFAULT_SCOPE` var if non-empty
 *   3. JWT `sub` (Better Auth user id) — the default for personal use
 *
 * The memory tools mirror the Cloudflare Agents SDK memory-layer concepts:
 *   - `memory_add`     → writable short-form context (set_context equivalent)
 *   - `memory_search`  → searchable context (search_context / AgentSearchProvider)
 *   - `memory_load`    → loadable context / skills (load_context equivalent)
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

// Re-export the DO class — wrangler.jsonc references it by name.
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
 * Each scope gets its own DO instance → its own SQLite database.
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
    { name: "memory-server", version: "0.1.0" },
    {
      // Server-level instructions — ChatGPT/Codex read these on initialize.
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

    // skills/list — paginated catalog of skills
    server.server.setRequestHandler(
      SkillsListSchema as unknown as Parameters<typeof server.server.setRequestHandler>[0],
      async (req: { params?: { cursor?: string } }) => {
        return await handleSkillsList({ cursor: req.params?.cursor });
      },
    );

    // skills/get — fetch a single skill entry by URI
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

    // resources/read — fetch a skill resource by URI
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
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: results.length, results }, null, 2),
          },
        ],
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
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: results.length, results }, null, 2),
          },
        ],
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
//   2. The worker 302-redirects to {AUTH_WEB_URL}/sign-in?return_to={MEMORY_SERVER_URL}/auth/callback
//   3. The user signs in on auth.allen.company
//   4. auth-web mints a code and redirects back to /auth/callback?code=...
//   5. The worker exchanges the code at {AUTH_API_URL}/sso/exchange and
//      returns the JWT as JSON for the CLI to capture.
//
// The worker needs AUTH_WEB_URL (the auth UI origin) configured as a var.

const AUTH_WEB_URL_DEFAULT = "https://auth.allen.company";

async function handleSsoStart(env: Env, requestUrl: URL): Promise<Response> {
  const authWebUrl = (env.AUTH_WEB_URL || AUTH_WEB_URL_DEFAULT).replace(/\/$/, "");
  const callbackUrl = `${requestUrl.origin}/auth/callback`;
  const signInUrl = `${authWebUrl}/sign-in?return_to=${encodeURIComponent(callbackUrl)}`;
  return Response.redirect(signInUrl, 302);
}

async function handleSsoCallback(env: Env, requestUrl: URL): Promise<Response> {
  const code = requestUrl.searchParams.get("code");
  if (!code) {
    return new Response(JSON.stringify({ error: "missing code parameter" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const authApiUrl = (env.AUTH_API_URL ?? "").replace(/\/$/, "");
  if (!authApiUrl) {
    return new Response(JSON.stringify({ error: "AUTH_API_URL not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  // The client_id must match the origin the code was minted for.
  // The plugin's local callback server uses http://localhost:<port>, so
  // we pass the worker's origin here. For the worker-hosted callback,
  // the origin is the worker's own URL.
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
    return new Response(JSON.stringify({ error }), {
      status: exchangeRes.status === 400 ? 400 : 502,
      headers: { "content-type": "application/json" },
    });
  }

  // Return the JWT + user info as JSON. The CLI captures this and stores
  // the token locally for subsequent MCP calls.
  return new Response(
    JSON.stringify({
      token: exchange.token,
      expires_in: exchange.expires_in ?? 8 * 60 * 60,
      user: exchange.user,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
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
      return handleSsoCallback(env, url);
    }

    // Auth check — verify JWT via JWKS before entering the MCP handler.
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

/**
 * Custom server entry point for the Memory UI Worker.
 *
 * This worker serves the TanStack Start UI for all browser routes,
 * and proxies API/MCP/auth requests to the backend `memory-api` worker
 * via a service binding.
 *
 * Path routing:
 *   /mcp                  → backend (MCP Streamable HTTP)
 *   /auth/sso             → backend (SSO start)
 *   /auth/callback        → backend (SSO callback)
 *   /.well-known/*        → backend (OAuth metadata)
 *   /healthz              → backend (health check)
 *   /api/*                → backend (REST API for UI)
 *   everything else       → TanStack Start (UI)
 */

import handler from "@tanstack/react-start/server-entry";

interface UiEnv {
  MEMORY_API: Fetcher;
  AUTH_WEB_URL: string;
  AUTH_API_URL: string;
}

// Paths that should be proxied to the backend worker.
const PROXY_PREFIXES = [
  "/mcp",
  "/auth/",
  "/.well-known/",
  "/api/",
  "/healthz",
];

function shouldProxy(pathname: string): boolean {
  return PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export default {
  async fetch(
    request: Request,
    env: UiEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Proxy API/MCP/auth requests to the backend worker.
    if (shouldProxy(url.pathname)) {
      if (!env.MEMORY_API) {
        return new Response(
          JSON.stringify({ error: "MEMORY_API service binding not configured" }),
          {
            status: 502,
            headers: { "content-type": "application/json" },
          },
        );
      }
      // Forward the request as-is to the backend worker.
      // The service binding preserves the URL path, headers, and body.
      return env.MEMORY_API.fetch(request);
    }

    // Everything else: TanStack Start UI.
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<UiEnv>;

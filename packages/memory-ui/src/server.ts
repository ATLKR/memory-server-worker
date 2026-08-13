/**
 * Memory UI Worker entry point. Browser-facing API and auth routes are
 * forwarded to the backend service binding; all other routes are rendered by
 * TanStack Start.
 */

import handler from "@tanstack/react-start/server-entry";
import type { UiRequestContext } from "./lib/request-context";

export interface UiEnv {
  MEMORY_API: Fetcher;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  AUTH_WEB_URL: string;
  AUTH_API_URL: string;
}

const PROXY_PREFIXES = [
  "/mcp",
  "/auth",
  "/.well-known",
  "/api",
  "/healthz",
] as const;

const STATIC_SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "x-frame-options": "DENY",
} as const;

export function shouldProxy(pathname: string): boolean {
  return PROXY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function requestId(request: Request): string {
  const provided = request.headers.get("x-request-id");
  return provided && /^[A-Za-z0-9._:-]{1,128}$/.test(provided)
    ? provided
    : crypto.randomUUID();
}

function nonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function contentSecurityPolicy(cspNonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${cspNonce}' 'strict-dynamic'`,
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${cspNonce}'`,
    "style-src-attr 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function cspNonceMeta(cspNonce: string): string {
  // TanStack reads `content` while Vite's dynamic-import preload helper reads
  // the `nonce` property/attribute. Keep both on the same meta element.
  return `<meta property="csp-nonce" content="${cspNonce}" nonce="${cspNonce}">`;
}

function withHeaders(
  response: Response,
  extra: Record<string, string>,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extra)) {
    if (name.toLowerCase() === "vary" && headers.has(name)) {
      const existing = headers.get(name) ?? "";
      const values = new Set(
        `${existing},${value}`.split(",").map((item) => item.trim()).filter(Boolean),
      );
      headers.set(name, [...values].join(", "));
    } else {
      headers.set(name, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function nonceHtml(response: Response, cspNonce: string): Response {
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(cspNonceMeta(cspNonce), { html: true });
      },
    })
    .on("script", {
      element(element) {
        element.setAttribute("nonce", cspNonce);
      },
    })
    .on("style", {
      element(element) {
        element.setAttribute("nonce", cspNonce);
      },
    })
    .transform(response);
}

export default {
  async fetch(
    request: Request,
    env: UiEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const currentRequestId = requestId(request);
    const version = env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id;

    if (shouldProxy(url.pathname)) {
      if (!env.MEMORY_API) {
        console.error(JSON.stringify({
          level: "error",
          event: "ui_service_binding_unavailable",
          requestId: currentRequestId,
          path: url.pathname,
        }));
        return withHeaders(
          Response.json({ error: "Service temporarily unavailable" }, { status: 503 }),
          {
            "cache-control": "no-store",
            "x-request-id": currentRequestId,
            ...(version ? { "x-worker-version": version } : {}),
          },
        );
      }

      const response = await env.MEMORY_API.fetch(request);
      return withHeaders(response, {
        "x-request-id": response.headers.get("x-request-id") ?? currentRequestId,
        ...(version ? { "x-worker-version": version } : {}),
      });
    }

    const cspNonce = nonce();
    const context: UiRequestContext = { memoryApi: env.MEMORY_API };
    const rendered = await handler.fetch(request, {
      context,
    });
    const contentType = rendered.headers.get("content-type") ?? "";
    const isHtml = contentType.toLowerCase().includes("text/html");
    const isFingerprintAsset = url.pathname.startsWith("/assets/");

    const secured = withHeaders(rendered, {
      "x-request-id": currentRequestId,
      ...(version ? { "x-worker-version": version } : {}),
      ...(isFingerprintAsset
        ? { "cache-control": "public, max-age=31536000, immutable" }
        : {}),
      ...(isHtml
        ? {
            "cache-control": "private, no-cache, must-revalidate",
            "content-security-policy": contentSecurityPolicy(cspNonce),
            vary: "Cookie",
          }
        : {}),
    });

    return isHtml ? nonceHtml(secured, cspNonce) : secured;
  },
} satisfies ExportedHandler<UiEnv>;

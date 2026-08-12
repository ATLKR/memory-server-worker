// @vitest-environment node

import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, cspNonceMeta, shouldProxy } from "./server";

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
});

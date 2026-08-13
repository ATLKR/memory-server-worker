import assert from "node:assert/strict";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { describe, it } from "node:test";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  INVALID_PARAMS,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import worker from "./index.ts";
import {
  addMemoryShape,
  deleteMemoryShape,
  deleteSessionShape,
  getMemoryShape,
  ingestMemoryShape,
  listMemoryShape,
  MAX_INGEST_BYTES,
  MAX_MEMORY_CONTENT_BYTES,
  MAX_SEARCH_QUERY_BYTES,
  searchMemoryShape,
  summaryShape,
} from "./schema.ts";
import {
  handleResourceRead,
  handleSkillsGet,
  handleSkillsList,
  hasSkills,
} from "./skills.ts";
import { resolveProfileName } from "./security.ts";

const MCP_URL = "https://memory.allenlim.net/mcp";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const TEST_AUTHORIZATION = "Bearer plugin-regression-token";
const TEST_SCOPE = "codex-plugin-regression";

// Node 24 lacks the Workers-only SubtleCrypto extension used in production.
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

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

function textResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const contractFactory: McpServerFactory = (ctx) => {
  const server = new McpServer(
    { name: "memory-v2-contract-test", version: "2.0.0" },
    { instructions: "MCP v2 integration contract test server." },
  );

  server.server.registerCapabilities({
    resources: { listChanged: false },
    extensions: { "io.modelcontextprotocol/skills": {} },
  });

  server.registerTool(
    "memory_add",
    {
      description: "Validate the production memory_add input contract.",
      inputSchema: z.object(addMemoryShape),
      outputSchema: z.object({
        acceptedChars: z.number().int().nonnegative(),
        authorization: z.string().nullable(),
        scope: z.string().nullable(),
        era: z.enum(["legacy", "modern"]),
      }),
    },
    async ({ content }) => {
      return textResult({
        acceptedChars: content.length,
        authorization:
          ctx.requestInfo?.headers.get("authorization") ?? null,
        scope: ctx.requestInfo?.headers.get("x-memory-scope") ?? null,
        era: ctx.era,
      });
    },
  );

  server.server.setRequestHandler(
    "skills/list",
    { params: z.object({ cursor: z.string().optional() }) },
    async (params) => handleSkillsList({ cursor: params.cursor }),
  );

  server.server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.string() }) },
    async ({ uri }) => {
      const result = await handleSkillsGet({ uri });
      if (!result) throw new ProtocolError(INVALID_PARAMS, "skill not found");
      return result;
    },
  );

  server.server.setRequestHandler("resources/read", async (request) => {
    return (await handleResourceRead({ uri: request.params.uri })) ?? {
      contents: [],
    };
  });

  return server;
};

const handler = createMcpHandler(contractFactory, {
  route: "/mcp",
  legacy: "stateless",
  corsOptions: {
    origin: "*",
    methods: "GET,POST,DELETE,OPTIONS",
    headers: [
      "content-type",
      "accept",
      "authorization",
      "x-memory-scope",
      "mcp-session-id",
      "mcp-protocol-version",
      "mcp-method",
      "mcp-name",
      "last-event-id",
    ].join(","),
    exposeHeaders: [
      "mcp-session-id",
      "mcp-protocol-version",
      "www-authenticate",
    ].join(","),
  },
  allowedHostnames: ["memory.allenlim.net"],
  allowedOriginHostnames: [
    "memory.allenlim.net",
    "chatgpt.com",
    "chat.openai.com",
    "platform.openai.com",
  ],
});

async function parseJsonRpc(response: Response): Promise<JsonRpcResponse> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body) as JsonRpcResponse;
  }

  const messages = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line) as JsonRpcResponse);
  assert.ok(messages.length > 0, `expected an SSE data frame, got: ${body}`);
  return messages.at(-1)!;
}

async function legacyRequest(
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ response: Response; rpc: JsonRpcResponse }> {
  const response = await handler.fetch(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        host: "memory.allenlim.net",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": LEGACY_PROTOCOL_VERSION,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return { response, rpc: await parseJsonRpc(response) };
}

async function modernRequest(
  method: string,
  params: Record<string, unknown>,
  name?: string,
): Promise<{ response: Response; rpc: JsonRpcResponse }> {
  const response = await handler.fetch(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        host: "memory.allenlim.net",
        accept: "application/json",
        "content-type": "application/json",
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "modern-1",
        method,
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
            [CLIENT_INFO_META_KEY]: {
              name: "memory-v2-regression-test",
              version: "1.0.0",
            },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
          ...params,
        },
      }),
    }),
  );
  return { response, rpc: await parseJsonRpc(response) };
}

function headerNames(value: string | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function apiKeyRegistry(
  key: string,
  options: {
    userId?: string;
    logicalScope?: string;
    permissions?: Array<"read" | "write" | "delete">;
    expiresAt?: string;
    disabledAt?: string;
  } = {},
): Promise<string> {
  return JSON.stringify({
    version: 2,
    keys: [{
      id: "worker-test",
      digest: await sha256(key),
      userId: options.userId ?? "worker-api-user",
      ...(options.logicalScope
        ? { logicalScope: options.logicalScope }
        : {}),
      permissions: options.permissions ?? ["read", "write", "delete"],
      expiresAt: options.expiresAt ?? "2099-01-01T00:00:00Z",
      ...(options.disabledAt ? { disabledAt: options.disabledAt } : {}),
    }],
  });
}

function apiKeyEnv(
  registry: string,
  resolvedProfiles: string[],
  profile: Record<string, unknown> = {},
): Env {
  return {
    AUTH_API_URL: "https://auth.example.test",
    AUTH_WEB_URL: "https://auth.example.test",
    DEFAULT_SCOPE: "jwt-default-scope",
    MEMORY_API_KEY_REGISTRY: registry,
    MEMORY: {
      getProfile(profileName: string) {
        resolvedProfiles.push(profileName);
        return profile;
      },
    },
  } as Env;
}

describe("MCP v2 runtime", () => {
  it("loads the v2 packages and serves a modern envelope", async () => {
    assert.equal(typeof McpServer, "function");
    assert.equal(typeof createMcpHandler, "function");

    const listed = await modernRequest("tools/list", {});
    assert.equal(listed.response.status, 200);
    assert.equal(listed.rpc.error, undefined);
    assert.equal(listed.rpc.result?.resultType, "complete");

    const tools = listed.rpc.result?.tools as Array<{
      name: string;
      inputSchema: {
        properties: { content: { maxLength: number } };
        required: string[];
      };
    }>;
    const memoryAdd = tools.find((tool) => tool.name === "memory_add");
    assert.ok(memoryAdd);
    assert.equal(memoryAdd.inputSchema.properties.content.maxLength, 32_768);
    assert.ok(memoryAdd.inputSchema.required.includes("content"));

    const called = await modernRequest(
      "tools/call",
      { name: "memory_add", arguments: { content: "modern request" } },
      "memory_add",
    );
    assert.equal(called.response.status, 200);
    assert.equal(called.rpc.error, undefined);
    assert.equal(called.rpc.result?.resultType, "complete");
    assert.deepEqual(called.rpc.result?.structuredContent, {
      acceptedChars: 14,
      authorization: null,
      scope: null,
      era: "modern",
    });
  });

  it("accepts plugin-style legacy payloads and forwards request headers", async () => {
    const { response, rpc } = await legacyRequest(
      "tools/call",
      {
        name: "memory_add",
        arguments: { content: "remember this", sessionId: "plugin-session" },
      },
      {
        authorization: TEST_AUTHORIZATION,
        "x-memory-scope": TEST_SCOPE,
        origin: "https://chatgpt.com",
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(rpc.error, undefined);
    assert.deepEqual(rpc.result?.structuredContent, {
      acceptedChars: 13,
      authorization: TEST_AUTHORIZATION,
      scope: TEST_SCOPE,
      era: "legacy",
    });

    const invalid = await legacyRequest("tools/call", {
      name: "memory_add",
      arguments: { content: "" },
    });
    assert.equal(invalid.response.status, 200);
    assert.equal(invalid.rpc.error, undefined);
    assert.equal(invalid.rpc.result?.isError, true);
    assert.match(
      JSON.stringify(invalid.rpc.result?.content),
      /validation|too small|minimum/i,
    );
  });
});

describe("Skills extension", () => {
  it("lists, gets, and reads every embedded skill with a valid digest", async () => {
    assert.equal(hasSkills(), true);
    const catalog = await handleSkillsList({});
    assert.deepEqual(
      catalog.skills.map((skill) => skill.frontmatter.name),
      ["capture", "recall"],
    );
    assert.equal(catalog.nextCursor, undefined);

    for (const skill of catalog.skills) {
      assert.match(skill.uri, /^skill:\/\/memory\/(capture|recall)\/SKILL\.md$/);
      assert.ok(skill.frontmatter.description.length > 0);
      assert.equal(skill.resources.length, 1);

      const got = await handleSkillsGet({ uri: skill.uri });
      assert.deepEqual(got?.skill, skill);
      const read = await handleResourceRead({ uri: skill.resources[0]!.uri });
      assert.equal(read?.contents[0]?.uri, skill.uri);
      assert.match(read?.contents[0]?.text ?? "", /^---\nname:/);
      assert.equal(
        skill.resources[0]!.digest,
        await sha256(read!.contents[0]!.text),
      );
    }

    assert.equal(
      await handleSkillsGet({ uri: "skill://memory/missing/SKILL.md" }),
      null,
    );
    assert.equal(
      await handleResourceRead({ uri: "skill://memory/missing/SKILL.md" }),
      null,
    );
  });

  it("serves skills/list, skills/get, and resources/read over MCP", async () => {
    const listed = await legacyRequest("skills/list", {});
    assert.equal(listed.response.status, 200);
    assert.equal(listed.rpc.error, undefined);
    const skills = listed.rpc.result?.skills as Array<{
      uri: string;
      frontmatter: { name: string };
    }>;
    assert.deepEqual(
      skills.map((skill) => skill.frontmatter.name),
      ["capture", "recall"],
    );

    const selected = skills.find(
      (skill) => skill.frontmatter.name === "recall",
    )!;
    const got = await legacyRequest("skills/get", { uri: selected.uri });
    assert.equal(got.rpc.error, undefined);
    assert.equal(
      (got.rpc.result?.skill as { uri: string }).uri,
      selected.uri,
    );

    const read = await legacyRequest("resources/read", { uri: selected.uri });
    assert.equal(read.rpc.error, undefined);
    const contents = read.rpc.result?.contents as Array<{
      uri: string;
      text: string;
    }>;
    assert.equal(contents[0]?.uri, selected.uri);
    assert.match(contents[0]?.text ?? "", /# Recall Memories/);

    const missing = await legacyRequest("skills/get", {
      uri: "skill://memory/missing/SKILL.md",
    });
    assert.equal(missing.rpc.error?.code, INVALID_PARAMS);
    assert.match(missing.rpc.error?.message ?? "", /skill not found/i);
  });
});

describe("MCP input schema limits", () => {
  it("accepts every documented upper boundary", () => {
    assert.equal(
      z.object(addMemoryShape).safeParse({
        content: "x".repeat(32_768),
        sessionId: "s".repeat(64),
      }).success,
      true,
    );
    assert.equal(
      z.object(searchMemoryShape).safeParse({ query: "q".repeat(1_024) })
        .success,
      true,
    );
    assert.equal(
      z.object(listMemoryShape).safeParse({
        limit: 500,
        cursor: "c".repeat(4_096),
        sessionId: "s".repeat(64),
      }).success,
      true,
    );
    assert.equal(
      z.object(getMemoryShape).safeParse({ id: "i".repeat(512) }).success,
      true,
    );
    assert.equal(
      z.object(deleteMemoryShape).safeParse({ id: "i".repeat(512) }).success,
      true,
    );
    assert.equal(
      z
        .object(deleteSessionShape)
        .safeParse({ sessionId: "s".repeat(64) }).success,
      true,
    );
    assert.equal(
      z.object(summaryShape).safeParse({ sessionId: "s".repeat(64) }).success,
      true,
    );

    const exactMiB = Array.from(
      { length: MAX_INGEST_BYTES / 32_768 },
      () => ({ role: "user" as const, content: "x".repeat(32_768) }),
    );
    assert.equal(
      z.object(ingestMemoryShape).safeParse({ messages: exactMiB }).success,
      true,
    );
  });

  it("rejects values immediately beyond every documented boundary", () => {
    const invalidInputs = [
      z.object(addMemoryShape).safeParse({ content: "x".repeat(32_769) }),
      z.object(addMemoryShape).safeParse({ content: "x", sessionId: "s".repeat(65) }),
      z.object(searchMemoryShape).safeParse({ query: "q".repeat(1_025) }),
      z.object(listMemoryShape).safeParse({ limit: 501 }),
      z.object(listMemoryShape).safeParse({ limit: 0 }),
      z.object(listMemoryShape).safeParse({ cursor: "c".repeat(4_097) }),
      z.object(getMemoryShape).safeParse({ id: "i".repeat(513) }),
      z.object(deleteMemoryShape).safeParse({ id: "i".repeat(513) }),
      z.object(deleteSessionShape).safeParse({ sessionId: "s".repeat(65) }),
      z.object(summaryShape).safeParse({ sessionId: "s".repeat(65) }),
    ];
    assert.ok(invalidInputs.every((result) => !result.success));

    const overMiB = [
      ...Array.from({ length: MAX_INGEST_BYTES / 32_768 }, () => ({
        role: "user" as const,
        content: "x".repeat(32_768),
      })),
      { role: "user" as const, content: "x" },
    ];
    assert.equal(
      z.object(ingestMemoryShape).safeParse({ messages: overMiB }).success,
      false,
    );
  });

  it("enforces multibyte UTF-8 boundaries through MCP tools/call", async () => {
    const exact = "\u{1f600}".repeat(MAX_MEMORY_CONTENT_BYTES / 4);
    const accepted = await legacyRequest("tools/call", {
      name: "memory_add",
      arguments: { content: exact },
    });
    assert.equal(accepted.rpc.error, undefined);
    assert.equal(accepted.rpc.result?.isError, undefined);
    assert.equal(
      (accepted.rpc.result?.structuredContent as { acceptedChars: number }).acceptedChars,
      exact.length,
    );

    const rejected = await legacyRequest("tools/call", {
      name: "memory_add",
      arguments: { content: `${exact}\u{1f600}` },
    });
    assert.equal(rejected.rpc.error, undefined);
    assert.equal(rejected.rpc.result?.isError, true);
    assert.match(JSON.stringify(rejected.rpc.result?.content), /UTF-8 limit/);

    const exactQuery = `${"\uac00".repeat(341)}a`;
    assert.equal(new TextEncoder().encode(exactQuery).byteLength, MAX_SEARCH_QUERY_BYTES);
    assert.equal(
      z.object(searchMemoryShape).safeParse({ query: exactQuery }).success,
      true,
    );
    assert.equal(
      z.object(searchMemoryShape).safeParse({ query: `${exactQuery}\uac00` }).success,
      false,
    );
  });
});

describe("MCP CORS contract", () => {
  it("exposes the plugin and MCP v2 headers on the production preflight", async () => {
    const response = await worker.fetch(
      new Request(MCP_URL, {
        method: "OPTIONS",
        headers: {
          origin: "https://chatgpt.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": [
            "authorization",
            "content-type",
            "x-memory-api-key",
            "x-memory-scope",
            "mcp-protocol-version",
            "mcp-method",
            "mcp-name",
          ].join(","),
        },
      }),
      {} as Env,
      {} as ExecutionContext,
    );

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const allowed = headerNames(
      response.headers.get("access-control-allow-headers"),
    );
    for (const name of [
      "authorization",
      "content-type",
      "accept",
      "x-memory-api-key",
      "x-memory-scope",
      "mcp-protocol-version",
      "mcp-method",
      "mcp-name",
    ]) {
      assert.ok(allowed.has(name), `${name} must be allowed by CORS`);
    }
    const exposed = headerNames(
      response.headers.get("access-control-expose-headers"),
    );
    assert.ok(exposed.has("mcp-session-id"));
    assert.ok(exposed.has("mcp-protocol-version"));
    assert.ok(exposed.has("www-authenticate"));
    assert.ok(exposed.has("x-request-id"));
  });

  it("rejects an unapproved browser Origin in the v2 wrapper", async () => {
    const response = await handler.fetch(
      new Request(MCP_URL, {
        method: "OPTIONS",
        headers: {
          host: "memory.allenlim.net",
          origin: "https://evil.example",
          "access-control-request-method": "POST",
        },
      }),
    );
    assert.equal(response.status, 403);
  });

  it("returns OAuth discovery headers and CORS for an unauthenticated plugin call", async () => {
    const response = await worker.fetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": LEGACY_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
      { AUTH_API_URL: "https://auth.example.test" } as Env,
      {} as ExecutionContext,
    );

    assert.equal(response.status, 401);
    assert.match(
      response.headers.get("www-authenticate") ?? "",
      /Bearer resource_metadata=/,
    );
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
});

describe("Worker API key authentication", () => {
  const apiUrl = "https://memory.allenlim.net/api/not-found";
  const validKey = "memory_worker_test_0123456789abcdef";

  it("accepts either API-key header and uses only the registry-fixed scope", async () => {
    const registry = await apiKeyRegistry(validKey, {
      userId: "service-user",
      logicalScope: "automation",
    });
    const expectedProfile = await resolveProfileName("service-user", "automation");

    for (const headers of [
      { "x-memory-api-key": validKey },
      { authorization: `ApiKey ${validKey}` },
    ]) {
      const profiles: string[] = [];
      const response = await worker.fetch(
        new Request(apiUrl, { headers }),
        apiKeyEnv(registry, profiles),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 404);
      assert.deepEqual(profiles, [expectedProfile]);
    }
  });

  it("uses the personal profile when the registry has no logical scope", async () => {
    const userId = "2ce0b53f-f7c0-4cee-a150-dd2616213d8f";
    const registry = await apiKeyRegistry(validKey, { userId });
    const profiles: string[] = [];
    const response = await worker.fetch(
      new Request(apiUrl, { headers: { "x-memory-api-key": validKey } }),
      apiKeyEnv(registry, profiles),
      {} as ExecutionContext,
    );

    assert.equal(response.status, 404);
    assert.deepEqual(profiles, [await resolveProfileName(userId, null)]);
  });

  it("authorizes a real REST operation with the resolved profile", async () => {
    const registry = await apiKeyRegistry(validKey, {
      userId: "service-user",
      logicalScope: "reporting",
    });
    const profiles: string[] = [];
    const profile = {
      async list() {
        return {
          memories: [
            { type: "fact" },
            { type: "fact" },
            { type: "task" },
          ],
          cursor: null,
        };
      },
    };
    const response = await worker.fetch(
      new Request("https://memory.allenlim.net/api/stats", {
        headers: { "x-memory-api-key": validKey },
      }),
      apiKeyEnv(registry, profiles, profile),
      {} as ExecutionContext,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      total: 3,
      byType: { fact: 2, task: 1 },
      truncated: false,
    });
    assert.deepEqual(profiles, [
      await resolveProfileName("service-user", "reporting"),
    ]);
  });

  it("rejects wrong and malformed API keys", async () => {
    const registry = await apiKeyRegistry(validKey);
    for (const key of [
      "memory_worker_wrong_0123456789abcdef",
      "short",
      `${validKey} invalid`,
    ]) {
      const profiles: string[] = [];
      const response = await worker.fetch(
        new Request(apiUrl, { headers: { "x-memory-api-key": key } }),
        apiKeyEnv(registry, profiles),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 401);
      assert.deepEqual(profiles, []);
    }
  });

  it("rejects API-key scope overrides and API-key/JWT ambiguity", async () => {
    const registry = await apiKeyRegistry(validKey, { logicalScope: "fixed" });
    for (const headers of [
      { "x-memory-api-key": validKey, "x-memory-scope": "fixed" },
      {
        "x-memory-api-key": validKey,
        authorization: "Bearer should-not-take-precedence",
      },
    ]) {
      const profiles: string[] = [];
      const response = await worker.fetch(
        new Request(apiUrl, { headers }),
        apiKeyEnv(registry, profiles),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 401);
      assert.deepEqual(profiles, []);
    }
  });

  it("enforces least-privilege API-key permissions before profile access", async () => {
    const registry = await apiKeyRegistry(validKey, { permissions: ["read"] });
    const profiles: string[] = [];
    const rest = await worker.fetch(
      new Request("https://memory.allenlim.net/api/memories", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-memory-api-key": validKey,
        },
        body: JSON.stringify({ content: "must not be written" }),
      }),
      apiKeyEnv(registry, profiles),
      {} as ExecutionContext,
    );
    assert.equal(rest.status, 403);
    assert.match(await rest.text(), /write permission/);
    assert.deepEqual(profiles, []);

    const mcp = await worker.fetch(
      new Request("https://memory.allenlim.net/mcp", {
        method: "POST",
        headers: {
          host: "memory.allenlim.net",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": LEGACY_PROTOCOL_VERSION,
          "x-memory-api-key": validKey,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "memory_delete", arguments: { id: "memory-id" } },
        }),
      }),
      apiKeyEnv(registry, profiles),
      {} as ExecutionContext,
    );
    assert.equal(mcp.status, 200);
    assert.match(JSON.stringify(await parseJsonRpc(mcp)), /delete permission/);
    assert.deepEqual(profiles, []);
  });
});

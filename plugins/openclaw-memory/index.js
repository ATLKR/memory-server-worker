import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_SERVER_URL = "https://memory.allenlim.net";
const DEFAULT_APPLICATION = "OpenClaw Group Chat";
const MAX_CAPTURE_MESSAGES = 100;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_INGEST_BYTES = 1024 * 1024;
const MAX_QUERY_BYTES = 1024;

export function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let result = text.slice(0, low);
  if (/^[\uDC00-\uDFFF]/.test(text.slice(low))) result = result.slice(0, -1);
  return result;
}

export function normalizeConfig(raw = {}) {
  return {
    serverUrl: String(raw.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, ""),
    application: String(raw.application || DEFAULT_APPLICATION).trim(),
    credentialCommand: String(raw.credentialCommand || "").trim(),
    credentialArgs: Array.isArray(raw.credentialArgs)
      ? raw.credentialArgs.map(String)
      : [],
    autoRecall: raw.autoRecall !== false,
    autoCapture: raw.autoCapture !== false,
  };
}

export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const normalized = messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const role = message.role;
    if (role !== "system" && role !== "user" && role !== "assistant") return [];
    let content = message.content;
    if (Array.isArray(content)) {
      content = content
        .filter((part) => part && typeof part === "object" && part.type === "text")
        .map((part) => part.text)
        .filter((text) => typeof text === "string")
        .join("\n");
    }
    if (typeof content !== "string" || !content.trim()) return [];
    return [{ role, content: truncateUtf8(content, MAX_MESSAGE_BYTES) }];
  }).slice(-MAX_CAPTURE_MESSAGES);
  const selected = [];
  let totalBytes = 0;
  for (const message of normalized.toReversed()) {
    const bytes = Buffer.byteLength(message.content, "utf8");
    if (totalBytes + bytes > MAX_INGEST_BYTES) continue;
    selected.push(message);
    totalBytes += bytes;
  }
  return selected.reverse();
}

export function sessionIdFor(sessionKey, runId) {
  const identity = String(sessionKey || runId || "openclaw");
  return `oc-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function parseMcpResponse(text, contentType) {
  let payload;
  if (contentType.includes("text/event-stream")) {
    const frames = text.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    payload = JSON.parse(frames.at(-1) || "null");
  } else {
    payload = JSON.parse(text);
  }
  if (payload?.error) throw new Error(`Memory MCP error: ${payload.error.message}`);
  const result = payload?.result;
  if (!result) throw new Error("Memory MCP returned no result");
  if (result.isError) throw new Error("Memory MCP tool returned an error");
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text || "null");
}

export function createMemoryClient(config, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  let cachedCredential;
  let credentialExpiresAt = 0;

  async function readCredential() {
    if (deps.readCredential) return deps.readCredential();
    if (cachedCredential && Date.now() < credentialExpiresAt) return cachedCredential;
    if (!config.credentialCommand) throw new Error("credentialCommand is required");
    const { stdout } = await execFileAsync(
      config.credentialCommand,
      config.credentialArgs,
      { encoding: "utf8", maxBuffer: 16 * 1024 },
    );
    const credential = stdout.trim();
    if (!credential.startsWith("memory_pat_")) {
      throw new Error("Memory credential command returned an invalid credential");
    }
    cachedCredential = credential;
    credentialExpiresAt = Date.now() + 5 * 60 * 1000;
    return credential;
  }

  return {
    async call(name, args = {}) {
      const credential = await readCredential();
      const response = await fetchImpl(`${config.serverUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
          "x-memory-application": config.application,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Memory MCP request failed (${response.status})`);
      return parseMcpResponse(text, response.headers.get("content-type") || "");
    },
  };
}

function jsonToolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const plugin = {
  id: "allenlim-memory",
  name: "Allenlim Memory",
  description: "Cloudflare Agent Memory as OpenClaw's primary memory slot",
  kind: "memory",
  register(api) {
    const config = normalizeConfig(api.pluginConfig);
    const client = createMemoryClient(config);

    api.registerMemoryCapability({
      promptBuilder: ({ availableTools }) => {
        if (!availableTools.has("memory_search")) return [];
        return [
          "## Personal Memory",
          `The primary memory store is Allenlim Memory, partitioned as application ${JSON.stringify(config.application)}.`,
          "Use memory_search for recall and memory_get for an exact memory. File-backed MEMORY.md is not the source of truth.",
          "",
        ];
      },
    });

    api.registerTool({
      label: "Memory Search",
      name: "memory_search",
      description: "Search the primary personal memory store using hybrid semantic and keyword recall.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          thinkingLevel: { type: "string", enum: ["low", "medium", "high"] },
          responseLength: { type: "string", enum: ["short", "medium", "long"] },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (_id, params) => jsonToolResult(
        await client.call("memory_search", params),
      ),
    });

    api.registerTool({
      label: "Memory Get",
      name: "memory_get",
      description: "Fetch one exact memory by its memory ID.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (_id, params) => jsonToolResult(
        await client.call("memory_get", params),
      ),
    });

    if (config.autoRecall) {
      api.on("before_prompt_build", async (event) => {
        const query = String(event.prompt || "").trim();
        if (!query) return;
        try {
          const result = await client.call("memory_search", {
            query: truncateUtf8(query, MAX_QUERY_BYTES),
            thinkingLevel: "low",
            responseLength: "short",
          });
          if (!result?.count) return;
          return {
            prependContext: `<personal-memory application=${JSON.stringify(config.application)}>\n${result.answer}\n</personal-memory>`,
          };
        } catch (error) {
          api.logger.warn(`automatic memory recall failed: ${error.message}`);
        }
      }, { timeoutMs: 120_000 });
    }

    if (config.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success) return;
        const messages = normalizeMessages(event.messages);
        if (messages.length === 0) return;
        try {
          await client.call("memory_ingest", {
            messages,
            sessionId: sessionIdFor(ctx.sessionKey, event.runId),
          });
        } catch (error) {
          api.logger.warn(`automatic memory capture failed: ${error.message}`);
        }
      }, { timeoutMs: 120_000 });
    }
  },
};

export default plugin;

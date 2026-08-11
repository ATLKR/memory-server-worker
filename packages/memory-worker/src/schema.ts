/**
 * Shared types and Zod schemas for the memory store.
 *
 * The memory model mirrors the concepts in the Cloudflare Agents SDK memory
 * layer (agents/experimental/memory/session):
 *
 *   - **Writable short-form context** → `namespace` + `content` entries that
 *     an agent reads/writes via `memory_add` / `memory_update`.
 *   - **Searchable context** → FTS5-backed `memory_search`, equivalent to the
 *     `AgentSearchProvider` pattern.
 *   - **Loadable context / Skills** → large documents stored by `key` and
 *     loaded whole via `memory_load`.
 *
 * Each entry belongs to a *scope* (→ its own Durable Object instance) so
 * memories from different projects / identities never collide.
 */

import { z } from "zod";

/** A single memory entry as stored in SQLite. */
export interface MemoryEntry {
  id: string;
  key: string | null;
  content: string;
  namespace: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Row shape coming out of the SQLite driver (JSON columns are strings). */
export interface MemoryRow {
  id: string;
  key: string | null;
  content: string;
  namespace: string;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

/** Convert a raw SQLite row into a MemoryEntry. */
export function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    key: row.key,
    content: row.content,
    namespace: row.namespace,
    tags: safeParseJson(row.tags, []) as string[],
    metadata: safeParseJson(row.metadata, {}) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseJson(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ---------- Zod raw shapes (for MCP tool inputSchema) ----------
// The MCP SDK v2 registerTool accepts a ZodRawShape (object of zod types)
// directly as inputSchema. We export the shapes here so the tool definitions
// in index.ts can reference them.

export const addMemoryShape = {
  content: z.string().min(1).describe("The memory content to store."),
  key: z
    .string()
    .optional()
    .describe(
      "Human-readable unique key within this scope. " +
        "If omitted, a UUID is generated. Use keys for loadable " +
        "documents you want to fetch by name later.",
    ),
  namespace: z
    .string()
    .optional()
    .describe(
      "Logical grouping — e.g. 'facts', 'preferences', 'projects'. " +
        "Defaults to 'default'.",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("Free-form tags for filtering and organization."),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arbitrary JSON metadata to attach to the memory."),
};

export const searchMemoryShape = {
  query: z.string().min(1).describe("Full-text search query."),
  namespace: z
    .string()
    .optional()
    .describe("Restrict search to a namespace."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of results. Defaults to 10."),
};

export const getMemoryShape = {
  key: z.string().describe("The memory key to fetch."),
};

export const listMemoryShape = {
  namespace: z.string().optional().describe("Filter by namespace."),
  tag: z.string().optional().describe("Filter by tag."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum number of results. Defaults to 50."),
};

export const updateMemoryShape = {
  key: z.string().describe("The memory key to update."),
  content: z
    .string()
    .optional()
    .describe("New content. If omitted, the existing content is kept."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Replace tags. If omitted, existing tags are kept."),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Merge metadata. If omitted, existing metadata is kept. " +
        "Provide a key with null to remove it.",
    ),
  appendContent: z
    .boolean()
    .optional()
    .describe(
      "If true, append to existing content instead of replacing it.",
    ),
};

export const deleteMemoryShape = {
  key: z.string().describe("The memory key to delete."),
};

export const loadMemoryShape = {
  key: z.string().describe("The skill/document key to load in full."),
};

// ---------- Zod raw shapes (for MCP tool outputSchema) ----------
// ChatGPT's MCP connector requires outputSchema on tools to surface them
// as Actions. Each shape describes the JSON structure of the text content
// returned in the tool result's content[0].text field.

export const memoryEntryOutputShape = {
  id: z.string().describe("Unique identifier (UUID)."),
  key: z.string().nullable().describe("Human-readable key, or null if auto-generated."),
  content: z.string().describe("The memory content text."),
  namespace: z.string().describe("Namespace grouping this memory belongs to."),
  tags: z.array(z.string()).describe("Tags attached to this memory."),
  metadata: z.record(z.string(), z.unknown()).describe("Arbitrary JSON metadata."),
  createdAt: z.string().describe("ISO timestamp of creation."),
  updatedAt: z.string().describe("ISO timestamp of last update."),
};

export const searchOutputShape = {
  count: z.number().describe("Number of results returned."),
  results: z.array(z.object(memoryEntryOutputShape)).describe("Matching memory entries, ranked by relevance."),
};

export const deleteOutputShape = {
  deleted: z.boolean().describe("Whether the memory was deleted."),
};

export const statsOutputShape = {
  total: z.number().describe("Total number of memories across all namespaces."),
  byNamespace: z.record(z.string(), z.number()).describe("Count per namespace."),
};

export const loadOutputShape = {
  content: z.string().describe("The full text content of the loaded document."),
};

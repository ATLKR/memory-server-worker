/**
 * Shared types and Zod schemas for the Agent Memory–backed memory server.
 *
 * Cloudflare Agent Memory automatically classifies every memory into one of
 * four types:
 *   - **fact** — Stable knowledge (preferences, identities, relationships)
 *   - **event** — Completed actions anchored to a point in time
 *   - **instruction** — Reusable procedures, workflows, conventions
 *   - **task** — Short-lived, session-scoped items
 *
 * Memories also support supersession: when a newer fact/instruction replaces
 * an older one on the same topic, the old version is preserved but the latest
 * surfaces in recall results.
 */

import { z } from "zod";

export const MAX_MEMORY_CONTENT_BYTES = 32 * 1024;
export const MAX_SEARCH_QUERY_BYTES = 1024;
export const MAX_INGEST_MESSAGES = 100;
export const MAX_INGEST_BYTES = 1024 * 1024;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utf8BoundedString(maxBytes: number, label: string) {
  const message = `${label} exceeds the ${maxBytes}-byte UTF-8 limit.`;
  return z
    .string()
    .min(1)
    // Retain maxLength in the generated MCP JSON Schema. Any value within the
    // UTF-8 limit is also within this UTF-16 code-unit ceiling.
    .max(maxBytes, message)
    .refine((value) => utf8ByteLength(value) <= maxBytes, { message });
}

/** Memory types supported by Agent Memory. */
export type MemoryType = "fact" | "event" | "instruction" | "task";

/** A single memory entry as returned by Agent Memory. */
export interface MemoryEntry {
  id: string;
  type: MemoryType;
  summary: string;
  content: string;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Result from a recall() call. */
export interface RecallResult {
  count: number;
  answer: string;
  candidates: Array<{
    id: string;
    summary: string;
    sessionId: string | null;
    score: number;
  }>;
}

/** Stats response computed from list(). */
export interface StatsResponse {
  total: number;
  byType: Partial<Record<MemoryType, number>>;
  truncated: boolean;
}

// ---------- Zod raw shapes (for MCP tool inputSchema) ----------

export const addMemoryShape = {
  content: utf8BoundedString(MAX_MEMORY_CONTENT_BYTES, "Memory content")
    .describe(
      "The memory content to store (max 32 KiB UTF-8). Agent Memory will " +
        "automatically classify it as a fact, event, instruction, or " +
        "task, and generate a summary. If a similar fact or instruction " +
        "already exists, it will be superseded (the old version is " +
        "preserved but the new one surfaces in recall).",
    ),
  sessionId: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Optional session identifier to group related memories. " +
        "Max 64 characters.",
    ),
};

export const searchMemoryShape = {
  query: utf8BoundedString(MAX_SEARCH_QUERY_BYTES, "Search query")
    .describe(
      "Natural language search query (max 1 KiB UTF-8). Agent Memory runs " +
        "hybrid search (keyword + semantic + topic key) and returns a " +
        "synthesized answer grounded in stored content.",
    ),
  thinkingLevel: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe(
      "Controls retrieval breadth. Higher levels search more candidates " +
        "but take longer. Defaults to 'low'.",
    ),
  responseLength: z
    .enum(["short", "medium", "long"])
    .optional()
    .describe(
      "Controls the verbosity of the synthesized answer. " +
        "Defaults to 'medium'.",
    ),
};

export const ingestMemoryShape = {
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: utf8BoundedString(MAX_MEMORY_CONTENT_BYTES, "Message content"),
      }),
    )
    .min(1)
    .max(MAX_INGEST_MESSAGES)
    .superRefine((messages, ctx) => {
      let totalBytes = 0;
      for (const message of messages) {
        totalBytes += utf8ByteLength(message.content);
        if (totalBytes > MAX_INGEST_BYTES) {
          ctx.addIssue({
            code: "custom",
            message: "Combined message content exceeds the 1 MiB limit.",
          });
          return;
        }
      }
    })
    .describe(
      "Conversation messages to process (max 100 and 1 MiB total, each max 32 KiB UTF-8). " +
        "Agent Memory will automatically extract facts, events, " +
        "instructions, and tasks from the conversation. Re-ingesting " +
        "the same messages is idempotent — no duplicates are created.",
    ),
  sessionId: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Optional session identifier (max 64 chars). If omitted, one " +
        "is derived from the message content.",
    ),
};

export const listMemoryShape = {
  type: z
    .enum(["fact", "event", "instruction", "task"])
    .optional()
    .describe("Filter by memory type."),
  sessionId: z
    .string()
    .max(64)
    .optional()
    .describe("Filter by session ID (max 64 chars)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum number of results. Defaults to 50."),
  cursor: z
    .string()
    .max(4096)
    .optional()
    .describe("Opaque cursor from a previous page for pagination."),
};

export const getMemoryShape = {
  id: z.string().min(1).max(512).describe("The memory ID to fetch."),
};

export const deleteMemoryShape = {
  id: z.string().min(1).max(512).describe("The memory ID to delete."),
};

export const deleteSessionShape = {
  sessionId: z
    .string()
    .min(1)
    .max(64)
    .describe("The session ID to delete all memories for."),
};

export const summaryShape = {
  sessionId: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Optional session ID (max 64 chars) to scope the 'Last Session' " +
        "section. If omitted, the most recent session is used.",
    ),
};

// ---------- Zod raw shapes (for MCP tool outputSchema) ----------

export const memoryEntryOutputShape = {
  id: z.string().describe("Unique identifier."),
  type: z.string().describe("Memory type: fact, event, instruction, or task."),
  summary: z.string().describe("Auto-generated summary."),
  content: z.string().describe("Full memory content."),
  sessionId: z.string().nullable().describe("Session ID, if associated."),
  createdAt: z.string().describe("ISO timestamp of creation."),
  updatedAt: z.string().describe("ISO timestamp of last update."),
};

export const searchOutputShape = {
  count: z.number().describe("Number of candidate memories found."),
  answer: z.string().describe("Synthesized answer grounded in stored content."),
  candidates: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string(),
        sessionId: z.string().nullable(),
        score: z.number(),
      }),
    )
    .describe("Ranked candidate memories."),
};

export const ingestOutputShape = {
  ingested: z.boolean().describe("Whether ingestion was successful."),
};

export const listOutputShape = {
  count: z.number().describe("Number of memories returned."),
  memories: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        summary: z.string(),
        sessionId: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    )
    .describe("Memory entries."),
  cursor: z.string().nullable().describe("Cursor for the next page, if any."),
};

export const deleteOutputShape = {
  deleted: z.boolean().describe("Whether the memory was deleted."),
};

export const deleteSessionOutputShape = {
  deleted: z.boolean().describe("Whether the session memories were deleted."),
};

export const statsOutputShape = {
  total: z.number().describe("Total number of memories."),
  byType: z
    .record(z.string(), z.number())
    .describe("Count per memory type (fact, event, instruction, task)."),
  truncated: z
    .boolean()
    .describe("Whether total and per-type counts are lower bounds capped at 500."),
};

export const summaryOutputShape = {
  summary: z.string().describe("Structured Markdown summary of all memories."),
};

/**
 * SQLite + FTS5 memory store, running inside the MemoryAgent Durable Object.
 *
 * This mirrors the storage patterns from the Cloudflare Agents SDK memory
 * layer:
 *
 *   - Durable Object SQLite for structured, durable persistence.
 *   - An FTS5 virtual table for full-text search — the same mechanism the
 *     SDK's AgentSearchProvider uses.
 *
 * The store is a thin layer over the Durable Object's SqlStorage
 * (this.ctx.storage.sql), accessed via the exec() method.
 */

import type { SqlStorage, SqlStorageCursor } from "@cloudflare/workers-types";
import { rowToEntry, type MemoryEntry } from "./schema";

/** Row shape coming out of SQLite (JSON columns are strings). */
type MemoryRow = {
  id: string;
  key: string | null;
  content: string;
  namespace: string;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS memories (
    id          TEXT PRIMARY KEY,
    key         TEXT UNIQUE,
    content     TEXT NOT NULL,
    namespace   TEXT NOT NULL DEFAULT 'default',
    tags        TEXT NOT NULL DEFAULT '[]',
    metadata    TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace)`,
  // FTS5 virtual table for full-text search. We keep it in sync manually
  // (insert/delete) rather than using external-content tables — simpler and
  // avoids the rowid mapping complexity. The UNINDEXED columns let us
  // return the full entry directly from FTS results without a join.
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    namespace,
    tags,
    id UNINDEXED,
    key UNINDEXED
  )`,
];

export class MemoryStore {
  constructor(private sql: SqlStorage) {
    for (const stmt of DDL_STATEMENTS) {
      this.sql.exec(stmt);
    }
  }

  /** Insert a new memory entry. Returns the stored entry. */
  add(entry: MemoryEntry): MemoryEntry {
    this.sql.exec(
      `INSERT INTO memories (id, key, content, namespace, tags, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.key,
      entry.content,
      entry.namespace,
      JSON.stringify(entry.tags),
      JSON.stringify(entry.metadata),
      entry.createdAt,
      entry.updatedAt,
    );
    this.syncFtsInsert(entry);
    return entry;
  }

  /** Get a memory by its key. Returns null if not found. */
  getByKey(key: string): MemoryEntry | null {
    const cursor = this.sql.exec<MemoryRow>(
      `SELECT * FROM memories WHERE key = ?`,
      key,
    );
    const row = cursor.toArray()[0];
    return row ? rowToEntry(row) : null;
  }

  /** List memories, optionally filtered by namespace and/or tag. */
  list(opts: {
    namespace?: string;
    tag?: string;
    limit?: number;
  }): MemoryEntry[] {
    const conditions: string[] = [];
    const binds: (string | number)[] = [];

    if (opts.namespace) {
      conditions.push("namespace = ?");
      binds.push(opts.namespace);
    }
    if (opts.tag) {
      conditions.push("tags LIKE ?");
      binds.push(`%"${escapeLike(opts.tag)}"%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    binds.push(limit);

    const cursor = this.sql.exec<MemoryRow>(
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`,
      ...binds,
    );
    return cursor.toArray().map(rowToEntry);
  }

  /**
   * Full-text search across memory content.
   *
   * Uses FTS5 with an OR-based query so that memories matching *any* of the
   * query terms are returned (ranked by relevance). If FTS5 returns nothing
   * (e.g. the query contained no indexed tokens), falls back to a LIKE
   * search on the content column.
   */
  search(query: string, opts: { namespace?: string; limit?: number }): MemoryEntry[] {
    const limit = opts.limit ?? 10;
    const ftsQuery = sanitizeFtsQuery(query);

    if (ftsQuery) {
      let sql: string;
      const binds: (string | number)[] = [ftsQuery];

      if (opts.namespace) {
        sql = `
          SELECT m.* FROM memories_fts f
          JOIN memories m ON m.id = f.id
          WHERE memories_fts MATCH ? AND m.namespace = ?
          ORDER BY rank
          LIMIT ?
        `;
        binds.push(opts.namespace, limit);
      } else {
        sql = `
          SELECT m.* FROM memories_fts f
          JOIN memories m ON m.id = f.id
          WHERE memories_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `;
        binds.push(limit);
      }

      const cursor = this.sql.exec<MemoryRow>(sql, ...binds);
      const results = cursor.toArray().map(rowToEntry);
      if (results.length > 0) return results;
    }

    // Fallback: LIKE search on content for queries that FTS5 can't handle
    // (e.g. very long natural language with no matching tokens, or queries
    // with only short stopwords).
    return this.likeSearch(query, opts, limit);
  }

  /** LIKE-based fallback search on content, key, and tags. */
  private likeSearch(
    query: string,
    opts: { namespace?: string; limit?: number },
    limit: number,
  ): MemoryEntry[] {
    const conditions: string[] = [];
    const binds: (string | number)[] = [];

    // Extract the most significant terms (length >= 3) for LIKE search.
    const terms = extractSignificantTerms(query);
    if (terms.length === 0) return [];

    // Build OR conditions for each term against content + key.
    const orParts: string[] = [];
    for (const term of terms.slice(0, 5)) {
      orParts.push("content LIKE ?");
      binds.push(`%${escapeLike(term)}%`);
    }
    conditions.push(`(${orParts.join(" OR ")})`);

    if (opts.namespace) {
      conditions.push("namespace = ?");
      binds.push(opts.namespace);
    }
    binds.push(limit);

    const where = `WHERE ${conditions.join(" AND ")}`;
    const cursor = this.sql.exec<MemoryRow>(
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`,
      ...binds,
    );
    return cursor.toArray().map(rowToEntry);
  }

  /** Update a memory by key. Returns the updated entry or null if not found. */
  update(
    key: string,
    patch: {
      content?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      appendContent?: boolean;
    },
  ): MemoryEntry | null {
    const existing = this.getByKey(key);
    if (!existing) return null;

    const now = new Date().toISOString();
    const newContent = patch.appendContent
      ? existing.content + "\n" + (patch.content ?? "")
      : patch.content ?? existing.content;
    const newTags = patch.tags ?? existing.tags;
    const newMetadata = patch.metadata
      ? mergeMetadata(existing.metadata, patch.metadata)
      : existing.metadata;

    this.sql.exec(
      `UPDATE memories SET content = ?, tags = ?, metadata = ?, updated_at = ? WHERE key = ?`,
      newContent,
      JSON.stringify(newTags),
      JSON.stringify(newMetadata),
      now,
      key,
    );

    this.syncFtsDelete(existing.id);
    const updated: MemoryEntry = {
      ...existing,
      content: newContent,
      tags: newTags,
      metadata: newMetadata,
      updatedAt: now,
    };
    this.syncFtsInsert(updated);
    return updated;
  }

  /** Delete a memory by key. Returns true if deleted, false if not found. */
  deleteByKey(key: string): boolean {
    const existing = this.getByKey(key);
    if (!existing) return false;
    this.sql.exec(`DELETE FROM memories WHERE key = ?`, key);
    this.syncFtsDelete(existing.id);
    return true;
  }

  /** Count total memories, optionally filtered by namespace. */
  count(namespace?: string): number {
    const cursor = namespace
      ? this.sql.exec<{ n: number }>(
          `SELECT COUNT(*) as n FROM memories WHERE namespace = ?`,
          namespace,
        )
      : this.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM memories`);
    return cursor.one().n;
  }

  /** Per-namespace counts. */
  countsByNamespace(): Record<string, number> {
    const cursor = this.sql.exec<{ namespace: string; n: number }>(
      `SELECT namespace, COUNT(*) as n FROM memories GROUP BY namespace`,
    );
    const result: Record<string, number> = {};
    for (const row of cursor.toArray()) {
      result[row.namespace] = row.n;
    }
    return result;
  }

  // ---------- FTS sync helpers ----------

  private syncFtsInsert(entry: MemoryEntry): void {
    this.sql.exec(
      `INSERT INTO memories_fts (id, key, content, namespace, tags) VALUES (?, ?, ?, ?, ?)`,
      entry.id,
      entry.key ?? "",
      entry.content,
      entry.namespace,
      entry.tags.join(" "),
    );
  }

  private syncFtsDelete(id: string): void {
    this.sql.exec(`DELETE FROM memories_fts WHERE id = ?`, id);
  }
}

// ---------- utils ----------

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => "\\" + c);
}

/**
 * Sanitize a user query for FTS5 MATCH.
 *
 * Strategy:
 *   - Strip FTS5 special characters that would be interpreted as operators
 *     (hyphens become NOT, colons become column filters, etc.).
 *   - Split into tokens, filter out very short tokens (< 2 chars) and
 *     common English stopwords.
 *   - Wrap each token in double-quotes so FTS5 treats it as a literal
 *     string (no operator interpretation).
 *   - Join with OR so that memories matching *any* term are returned,
 *     ranked by relevance. This is critical for long natural-language
 *     queries where an AND of all terms would almost never match.
 *   - Cap at 20 tokens to avoid overly broad queries.
 */
function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";

  // Remove FTS5 operator characters: - : * ( ) " ^ + AND OR NOT NEAR
  // Replace them with spaces so tokens split cleanly.
  const cleaned = trimmed.replace(/[-:*()+"^]/g, " ");

  const tokens = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= 2)
    .filter((t) => !STOPWORDS.has(t.toLowerCase()));

  if (tokens.length === 0) return "";

  // OR query: match any token, ranked by how many match.
  const quoted = tokens
    .slice(0, 20)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(" OR ");
}

/**
 * Extract the most significant terms from a query for LIKE fallback search.
 * Returns terms of length >= 3, with stopwords removed, capped at 10.
 */
function extractSignificantTerms(query: string): string[] {
  const cleaned = query.replace(/[-:*()+"^]/g, " ");
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !STOPWORDS.has(t.toLowerCase()))
    .slice(0, 10);
}

/** Common English stopwords to filter out of search queries. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "can",
  "this", "that", "these", "those", "i", "you", "he", "she", "it",
  "we", "they", "what", "which", "who", "when", "where", "why", "how",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "of", "in", "on", "at", "to", "for",
  "with", "about", "as", "by", "from", "up", "out", "if", "my", "me",
  "let", "get", "got", "want", "need", "like", "also", "into", "via",
  "use", "using", "used", "them", "then", "here", "there", "now",
  "any", "one", "two", "our", "us", "your", "his", "her", "its",
]);

/** Merge metadata patches. Null values remove keys. */
function mergeMetadata(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete result[k];
    } else {
      result[k] = v;
    }
  }
  return result;
}

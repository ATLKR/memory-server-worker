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
  // FTS5 virtual table for full-text search.
  //
  // We use the trigram tokenizer instead of the default unicode61 because
  // trigram handles CJK (Chinese/Japanese/Korean) text correctly — it
  // splits on every 3-character sequence, so Korean words like "메모리서버"
  // become searchable via overlapping trigrams. unicode61 would treat the
  // entire unspaced Korean phrase as a single token, making substring
  // matching impossible.
  //
  // The trade-off: trigram requires queries of >= 3 characters and produces
  // larger indexes. For a personal memory store this is fine.
  //
  // UNINDEXED columns let us return the full entry directly from FTS
  // results without a join.
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    namespace,
    tags,
    id UNINDEXED,
    key UNINDEXED,
    tokenize = 'trigram'
  )`,
];

export class MemoryStore {
  constructor(private sql: SqlStorage) {
    // Migrate FTS table from unicode61 to trigram tokenizer if needed.
    // SQLite doesn't support ALTER on virtual tables, so we check and
    // recreate. This is safe because we rebuild the FTS index from the
    // base table.
    this.migrateFtsTokenizer();

    for (const stmt of DDL_STATEMENTS) {
      this.sql.exec(stmt);
    }

    // If the FTS table was just recreated, re-index all existing memories.
    this.reindexFtsIfNeeded();
  }

  /**
   * Check if the FTS table uses the trigram tokenizer. If it uses the
   * old unicode61 tokenizer (or has no tokenizer), drop it so the DDL
   * can recreate it with trigram.
   */
  private migrateFtsTokenizer(): void {
    try {
      const cursor = this.sql.exec<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'`,
      );
      const row = cursor.toArray()[0];
      if (row && !row.sql.toLowerCase().includes("trigram")) {
        // Old FTS table with unicode61 — drop it so DDL recreates with trigram.
        this.sql.exec(`DROP TABLE IF EXISTS memories_fts`);
      }
    } catch {
      // Table doesn't exist yet — DDL will create it.
    }
  }

  /**
   * If the FTS table is empty but the base table has rows, re-index.
   * This happens after a tokenizer migration drops the old FTS table.
   */
  private reindexFtsIfNeeded(): void {
    const ftsCount = this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM memories_fts`,
    ).one().n;
    if (ftsCount > 0) return;

    const rows = this.sql.exec<MemoryRow>(
      `SELECT * FROM memories`,
    ).toArray();
    for (const row of rows) {
      const entry = rowToEntry(row);
      this.sql.exec(
        `INSERT INTO memories_fts (id, key, content, namespace, tags) VALUES (?, ?, ?, ?, ?)`,
        entry.id,
        entry.key ?? "",
        entry.content,
        entry.namespace,
        entry.tags.join(" "),
      );
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

  /**
   * Upsert a memory entry by key. If the key exists, update content/tags/
   * metadata/updated_at (preserving id, namespace, created_at). If not,
   * insert a new row. Returns the final entry.
   *
   * This uses SQLite's ON CONFLICT clause for an atomic single-statement
   * upsert, avoiding the need for a separate getByKey check.
   */
  upsert(entry: MemoryEntry): MemoryEntry {
    // First, check if the key exists so we know the existing id for FTS sync.
    const existing = entry.key ? this.getByKey(entry.key) : null;
    if (existing) {
      // Update in place — preserve the original id and created_at.
      this.sql.exec(
        `UPDATE memories SET
           content = ?, tags = ?, metadata = ?, updated_at = ?
         WHERE key = ?`,
        entry.content,
        JSON.stringify(entry.tags),
        JSON.stringify(entry.metadata),
        entry.updatedAt,
        entry.key,
      );
      // Sync FTS: delete old + insert new.
      this.sql.exec(`DELETE FROM memories_fts WHERE id = ?`, existing.id);
      const updated: MemoryEntry = {
        ...existing,
        content: entry.content,
        tags: entry.tags,
        metadata: entry.metadata,
        updatedAt: entry.updatedAt,
      };
      this.syncFtsInsert(updated);
      return updated;
    }
    // No existing row — insert new.
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
      conditions.push("tags LIKE ? ESCAPE '\\'");
      binds.push(`%"${escapeLike(opts.tag)}"%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(opts.limit ?? 50, 500);
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
   * query terms are returned (ranked by relevance). Results are filtered by
   * a relevance threshold to avoid injecting low-quality matches. If FTS5
   * returns nothing (e.g. the query contained no indexed tokens), falls
   * back to a LIKE search on the content column.
   */
  search(query: string, opts: { namespace?: string; limit?: number }): MemoryEntry[] {
    // Early exit for empty queries — avoids unnecessary FTS/LIKE work.
    if (!query || query.trim().length === 0) return [];

    const limit = Math.min(opts.limit ?? 10, 100);
    const ftsQuery = sanitizeFtsQuery(query);

    if (ftsQuery) {
      let sql: string;
      const binds: (string | number)[] = [ftsQuery];

      if (opts.namespace) {
        sql = `
          SELECT m.*, f.rank as fts_rank
          FROM memories_fts f
          JOIN memories m ON m.id = f.id
          WHERE memories_fts MATCH ? AND m.namespace = ?
          ORDER BY f.rank
          LIMIT ?
        `;
        binds.push(opts.namespace, limit * 2);
      } else {
        sql = `
          SELECT m.*, f.rank as fts_rank
          FROM memories_fts f
          JOIN memories m ON m.id = f.id
          WHERE memories_fts MATCH ?
          ORDER BY f.rank
          LIMIT ?
        `;
        binds.push(limit * 2);
      }

      const cursor = this.sql.exec<MemoryRow & { fts_rank: number }>(sql, ...binds);
      const rows = cursor.toArray();

      // Filter by relevance: FTS5 rank is a negative number (more negative =
      // better match). We compute a threshold based on the best rank and
      // drop results that are significantly worse.
      const filtered = this.filterByRelevance(rows, limit);
      if (filtered.length > 0) return filtered.map(rowToEntry);
    }

    // Fallback: LIKE search on content for queries that FTS5 can't handle.
    return this.likeSearch(query, opts, limit);
  }

  /**
   * Filter FTS5 results by relevance. FTS5 rank values are negative (more
   * negative = better match). We keep results whose rank is within a factor
   * of the best result's rank, dropping low-quality matches from OR queries.
   */
  private filterByRelevance(
    rows: (MemoryRow & { fts_rank: number })[],
    limit: number,
  ): (MemoryRow & { fts_rank: number })[] {
    if (rows.length === 0) return [];
    if (rows.length === 1) return rows;

    // FTS5 rank is negative. Best = most negative. We keep results whose
    // rank is within 3x of the best (i.e. not more than 3x less relevant).
    // This prevents injecting a memory that only matched one common word
    // when other memories matched multiple query terms.
    const bestRank = rows[0]!.fts_rank;
    const threshold = bestRank * 3; // bestRank is negative, so *3 is more negative

    const filtered = rows.filter((r) => r.fts_rank >= threshold);
    return filtered.slice(0, limit);
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
      orParts.push("content LIKE ? ESCAPE '\\'");
      binds.push(`%${escapeLike(term)}%`);
    }

    // For CJK queries, also try matching with spaces removed from content.
    // This handles the case where the query is "메모리서버" but the stored
    // content is "메모리 서버" — a LIKE '%메모리서버%' won't match, but
    // REPLACE(content, ' ', '') LIKE '%메모리서버%' will.
    const hasCJK = /[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/.test(query);
    if (hasCJK) {
      const noSpaceQuery = query.replace(/\s+/g, "");
      if (noSpaceQuery.length >= 2) {
        orParts.push("REPLACE(content, ' ', '') LIKE ? ESCAPE '\\'");
        binds.push(`%${escapeLike(noSpaceQuery)}%`);
      }
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
    // Only append if there's actual new content to add — avoids trailing
    // newlines from empty append calls.
    const newContent =
      patch.appendContent && patch.content
        ? existing.content + "\n" + patch.content
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
 * Sanitize a user query for FTS5 MATCH with the trigram tokenizer.
 *
 * The trigram tokenizer splits text into overlapping 3-character sequences.
 * This works well for CJK (Korean/Chinese/Japanese) and Western text alike,
 * but requires queries of >= 3 characters to produce any trigrams.
 *
 * Strategy:
 *   - Strip FTS5 operator characters that would be interpreted as operators.
 *   - For CJK-containing queries: keep the full query as a single phrase
 *     (trigram handles substring matching across CJK well, but splitting on
 *     spaces breaks CJK trigram continuity — e.g. "메모리서버" stored as
 *     "메모리 서버" won't match if we query "메모리서버" as one phrase,
 *     but will match if we query "메모리" OR "서버" as separate phrases).
 *     We split into phrases but also include the full de-spaced version.
 *   - For Latin-only queries: split into phrases, filter stopwords, OR them.
 *   - Cap at 10 phrases to avoid overly broad queries.
 */
function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";

  // Remove FTS5 operator characters: - : * ( ) " ^ + AND OR NOT NEAR
  const cleaned = trimmed.replace(/[-:*()+"^]/g, " ");

  const hasCJK = /[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/.test(cleaned);

  if (hasCJK) {
    // For CJK queries, we want both individual phrases AND the full
    // de-spaced query as a single phrase. The trigram tokenizer matches
    // on 3-char substrings, so "메모리서버" will produce trigrams that
    // partially overlap with "메모리 서버" stored text.
    const phrases = cleaned
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => t.length >= 2);

    // Also add the full query with spaces removed — this helps when the
    // stored text has spaces but the query doesn't (or vice versa).
    const fullNoSpaces = cleaned.replace(/\s+/g, "");
    if (fullNoSpaces.length >= 3 && !phrases.includes(fullNoSpaces)) {
      phrases.push(fullNoSpaces);
    }

    if (phrases.length === 0) return "";

    const quoted = phrases
      .slice(0, 10)
      .map((t) => `"${t.replace(/"/g, '""')}"`);
    return quoted.join(" OR ");
  }

  // Latin-only: split into phrases, filter stopwords, OR them.
  const phrases = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !STOPWORDS.has(t.toLowerCase()));

  if (phrases.length === 0) return "";

  const quoted = phrases
    .slice(0, 10)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(" OR ");
}

/**
 * Extract the most significant terms from a query for LIKE fallback search.
 * Returns terms of length >= 2 (shorter for CJK where 2 chars can be
 * meaningful), with stopwords removed, capped at 10.
 */
function extractSignificantTerms(query: string): string[] {
  const cleaned = query.replace(/[-:*()+"^]/g, " ");
  const terms = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => {
      // Latin: >= 3 chars; CJK: >= 2 chars (2 Korean chars can be a word)
      const hasCJK = /[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/.test(t);
      return hasCJK ? t.length >= 2 : t.length >= 3;
    })
    .filter((t) => !STOPWORDS.has(t.toLowerCase()))
    .slice(0, 10);
  return terms;
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

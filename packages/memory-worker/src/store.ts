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

  /** Full-text search across memory content. */
  search(query: string, opts: { namespace?: string; limit?: number }): MemoryEntry[] {
    const limit = opts.limit ?? 10;
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

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

/** Sanitize a user query for FTS5 MATCH. Wraps tokens in quotes. */
function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

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

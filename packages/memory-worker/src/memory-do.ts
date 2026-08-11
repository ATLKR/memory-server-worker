/**
 * MemoryAgent — a Durable Object backed by the Cloudflare Agents SDK
 * `Agent` base class, providing durable SQLite storage for personal memories.
 *
 * One DO instance per *scope* (e.g. "personal", "project-foo"). The scope
 * is the `name` used to address the DO via `idFromName(scope)`, so memories
 * from different scopes are fully isolated in separate SQLite databases.
 *
 * The storage layer (SQLite + FTS5) mirrors the patterns used by the Agents
 * SDK memory layer:
 *   - Durable Object SQLite (this.ctx.storage.sql) for structured persistence
 *   - FTS5 virtual table for full-text search (same as AgentSearchProvider)
 *
 * Methods are called via Durable Object RPC from the stateless MCP handler
 * in `index.ts`.
 */

import { Agent } from "agents";
import { MemoryStore } from "./store";
import type { MemoryEntry } from "./schema";

export class MemoryAgent extends Agent<Env> {
  private store!: MemoryStore;

  async onStart(): Promise<void> {
    // this.ctx.storage.sql is the raw SqlStorage from the Durable Object
    // runtime. The store constructor runs schema migrations (CREATE TABLE /
    // FTS5). We use the raw SqlStorage (not this.sql) because it supports
    // multi-statement DDL via exec(string).
    this.store = new MemoryStore(this.ctx.storage.sql);
  }

  // Ensure the store is initialized even if onStart hasn't run yet (e.g.
  // on the very first RPC call to a cold DO — onStart fires before the
  // first request is processed, but being defensive costs nothing).
  private ensureStore(): MemoryStore {
    if (!this.store) {
      this.store = new MemoryStore(this.ctx.storage.sql);
    }
    return this.store;
  }

  // ---------- RPC methods (called from the MCP handler) ----------

  async add(params: {
    content: string;
    key?: string;
    namespace?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<MemoryEntry> {
    const store = this.ensureStore();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const key = params.key ?? id;

    // If the key already exists, treat as update (upsert semantics).
    const existing = store.getByKey(key);
    if (existing) {
      return store.update(key, {
        content: params.content,
        tags: params.tags,
        metadata: params.metadata,
        appendContent: false,
      }) ?? existing;
    }

    const entry: MemoryEntry = {
      id,
      key,
      content: params.content,
      namespace: params.namespace ?? "default",
      tags: params.tags ?? [],
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    return store.add(entry);
  }

  async search(params: {
    query: string;
    namespace?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    return this.ensureStore().search(params.query, {
      namespace: params.namespace,
      limit: params.limit,
    });
  }

  async get(params: { key: string }): Promise<MemoryEntry | null> {
    return this.ensureStore().getByKey(params.key);
  }

  async list(params: {
    namespace?: string;
    tag?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    return this.ensureStore().list(params);
  }

  async update(params: {
    key: string;
    content?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    appendContent?: boolean;
  }): Promise<MemoryEntry | null> {
    return this.ensureStore().update(params.key, {
      content: params.content,
      tags: params.tags,
      metadata: params.metadata,
      appendContent: params.appendContent ?? false,
    });
  }

  async delete(params: { key: string }): Promise<{ deleted: boolean }> {
    const ok = this.ensureStore().deleteByKey(params.key);
    return { deleted: ok };
  }

  async load(params: { key: string }): Promise<MemoryEntry | null> {
    // Skill-style: load a large document by key in full.
    return this.ensureStore().getByKey(params.key);
  }

  async stats(): Promise<{
    total: number;
    byNamespace: Record<string, number>;
  }> {
    const store = this.ensureStore();
    return {
      total: store.count(),
      byNamespace: store.countsByNamespace(),
    };
  }
}

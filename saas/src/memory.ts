import { digestToken } from './identity.ts';
import type { IdentityDatabase, SqlValue } from './identity.ts';

export type Space = {
  id: string;
  name: string;
  organizationId: string | null;
  securityMode: 'managed';
};
export type Memory = {
  id: string;
  spaceId: string;
  body: string;
  source: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type MemoryHit = {
  id: string;
  spaceId: string;
  snippet: string;
  revision: number;
  source: string | null;
};
export class MemoryDenied extends Error {
  constructor() { super('Memory operation denied'); this.name = 'MemoryDenied'; }
}
export class MemoryInvalid extends Error {
  constructor() { super('Invalid memory input'); this.name = 'MemoryInvalid'; }
}
export class MemoryConflict extends Error {
  constructor() { super('Memory revision conflict'); this.name = 'MemoryConflict'; }
}

const encoder = new TextEncoder();
function record(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MemoryInvalid();
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new MemoryInvalid();
}
function text(value: unknown, max: number, bytes = false): asserts value is string {
  // SQLite text length/substr stop at NUL; reject it before storage or search.
  if (typeof value !== 'string' || value.includes('\0') || !value.trim() ||
      (bytes ? encoder.encode(value).length : value.length) > max) throw new MemoryInvalid();
}
function source(value: unknown): asserts value is string | null | undefined {
  if (value !== undefined && value !== null && (typeof value !== 'string' || value.includes('\0') ||
      encoder.encode(value).length > 2048)) throw new MemoryInvalid();
}
function revision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) throw new MemoryInvalid();
}
async function tokenDigest(token: string): Promise<string> {
  try { return await digestToken(token); } catch { throw new MemoryDenied(); }
}

// Each query supplies the digest and the current time three times. Views are
// clock-independent; credential and membership expiry is checked in SQL here.
// The aliases s (Space) and c (credential) are local to the querying statement.
function authority(write: boolean): string {
  return `c.token_digest=? AND c.expires_at>? AND c.membership_expires_at>?
    ${write ? "AND c.permission='write'" : ''}
    AND s.security_mode='managed' AND (
      (s.organization_id IS NULL AND s.account_id=c.account_id
        AND c.kind IN ('session','personal_key') AND c.membership_id IS NULL)
      OR (s.organization_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM active_memberships m
        WHERE m.account_id=c.account_id AND m.organization_id=s.organization_id AND m.expires_at>?
          AND ((c.kind='session' AND c.membership_id IS NULL) OR (c.kind='api_key' AND c.membership_id=m.id))
          ${write ? "AND m.role IN ('owner','admin')" : ''}
      )))`;
}
const memoryColumns = `r.id,r.space_id AS spaceId,r.body,r.source,r.revision,
  r.created_at AS createdAt,r.updated_at AS updatedAt`;
const spaceColumns = `s.id,s.name,s.organization_id AS organizationId,s.security_mode AS securityMode`;

/** Canonical managed memory storage. Authorization is never cached. */
export class MemoryService {
  private readonly db: IdentityDatabase;
  private readonly clock: () => number;
  constructor(db: IdentityDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }
  private now(): number {
    const at = this.clock();
    if (!Number.isSafeInteger(at) || at < 0) throw new MemoryInvalid();
    return at;
  }
  private async write(sql: string, values: SqlValue[]): Promise<boolean> {
    const result = await this.db.prepare(sql).bind(...values).run();
    const changes = result.meta.changes;
    if (!result.success || typeof changes !== 'number' || !Number.isSafeInteger(changes) || changes < 0) throw new MemoryDenied();
    // D1 may count trigger side effects; any positive count is a successful
    // conditional mutation. A zero-row mutation has no trigger side effects.
    return changes > 0;
  }
  private async readMemory(hash: string, spaceId: string, memoryId: string, write = false): Promise<Memory> {
    const at = this.now();
    const row = await this.db.withSession('first-primary').prepare(`
      SELECT ${memoryColumns} FROM memories r JOIN spaces s ON s.id=r.space_id
      CROSS JOIN active_credentials c
      WHERE r.id=? AND s.id=? AND r.deleted_at IS NULL AND ${authority(write)}`)
      .bind(memoryId, spaceId, hash, at, at, at).first<Memory>();
    if (!row) throw new MemoryDenied();
    return row;
  }
  private async conflict(hash: string, spaceId: string, memoryId: string, expectedRevision: number): Promise<never> {
    // Read permission alone is insufficient to disclose a write conflict: a
    // concurrently demoted writer must receive the same denial as any outsider.
    const current = await this.readMemory(hash, spaceId, memoryId, true);
    if (current.revision !== expectedRevision) throw new MemoryConflict();
    throw new MemoryDenied();
  }

  async createSpace(token: string, input: { name: string; organizationId?: string; securityMode?: string }): Promise<Space> {
    record(input);
    text(input.name, 100);
    if (input.organizationId !== undefined) identifier(input.organizationId);
    if (input.securityMode !== undefined && input.securityMode !== 'managed') throw new MemoryInvalid();
    const hash = await tokenDigest(token);
    const at = this.now();
    const id = crypto.randomUUID();
    const organizationId = input.organizationId ?? null;
    const inserted = await this.write(`
      INSERT INTO spaces(id,name,account_id,organization_id,security_mode,created_at,actor_credential_id)
      SELECT ?,?,s.account_id,s.organization_id,s.security_mode,?,c.id
      FROM active_credentials c CROSS JOIN (
        SELECT CASE WHEN ? IS NULL THEN account_id ELSE NULL END AS account_id,
          ? AS organization_id,'managed' AS security_mode
        FROM active_credentials WHERE token_digest=?
      ) s WHERE ${authority(true)} AND c.kind='session' AND c.id NOT LIKE 'oauth:%'`,
      [id, input.name, at, organizationId, organizationId, hash, hash, at, at, at]);
    if (!inserted) throw new MemoryDenied();
    const fresh = this.now();
    const row = await this.db.withSession('first-primary').prepare(`
      SELECT ${spaceColumns} FROM spaces s CROSS JOIN active_credentials c
      WHERE s.id=? AND ${authority(false)}`).bind(id, hash, fresh, fresh, fresh).first<Space>();
    if (!row) throw new MemoryDenied();
    return row;
  }

  async create(token: string, spaceId: string, input: { body: string; source?: string | null }): Promise<Memory> {
    identifier(spaceId);
    record(input);
    text(input.body, 16384, true);
    source(input.source);
    const hash = await tokenDigest(token);
    const at = this.now();
    const id = crypto.randomUUID();
    const inserted = await this.write(`
      INSERT INTO memories(id,space_id,body,source,revision,created_at,updated_at,actor_credential_id)
      SELECT ?,s.id,?,?,1,?,?,c.id FROM spaces s CROSS JOIN active_credentials c
      WHERE s.id=? AND ${authority(true)}`,
      [id, input.body, input.source ?? null, at, at, spaceId, hash, at, at, at]);
    if (!inserted) throw new MemoryDenied();
    return this.readMemory(hash, spaceId, id);
  }

  async get(token: string, spaceId: string, memoryId: string): Promise<Memory> {
    identifier(spaceId);
    identifier(memoryId);
    return this.readMemory(await tokenDigest(token), spaceId, memoryId);
  }

  async listSpaces(token: string): Promise<Space[]> {
    const hash = await tokenDigest(token);
    const at = this.now();
    const rows = await this.db.withSession('first-primary').prepare(`
      SELECT ${spaceColumns} FROM active_credentials c LEFT JOIN spaces s ON ${authority(false)}
      WHERE c.token_digest=? AND c.expires_at>? AND c.membership_expires_at>?
      ORDER BY s.created_at,s.id LIMIT 100`)
      .bind(hash, at, at, at, hash, at, at).all<Space & { id: string | null }>();
    if (!rows.success || !rows.results.length) throw new MemoryDenied();
    return rows.results.filter(row => row.id !== null);
  }

  async update(token: string, spaceId: string, memoryId: string, input: { body: string; source?: string | null; expectedRevision: number }): Promise<Memory> {
    identifier(spaceId);
    identifier(memoryId);
    record(input);
    text(input.body, 16384, true);
    source(input.source);
    revision(input.expectedRevision);
    const hash = await tokenDigest(token);
    const at = this.now();
    const updated = await this.write(`
      UPDATE memories SET body=?,source=CASE WHEN ? THEN ? ELSE source END,
        revision=revision+1,updated_at=MAX(updated_at,?),
        actor_credential_id=(SELECT id FROM active_credentials WHERE token_digest=?)
      WHERE id=? AND space_id=? AND deleted_at IS NULL AND revision=? AND EXISTS (
        SELECT 1 FROM spaces s CROSS JOIN active_credentials c
        WHERE s.id=memories.space_id AND ${authority(true)}
      )`,
      [input.body, input.source === undefined ? 0 : 1, input.source ?? null, at, hash,
        memoryId, spaceId, input.expectedRevision, hash, at, at, at]);
    if (!updated) return this.conflict(hash, spaceId, memoryId, input.expectedRevision);
    return this.readMemory(hash, spaceId, memoryId);
  }

  async remove(token: string, spaceId: string, memoryId: string, expectedRevision: number): Promise<void> {
    identifier(spaceId);
    identifier(memoryId);
    revision(expectedRevision);
    const hash = await tokenDigest(token);
    const at = this.now();
    const removed = await this.write(`
      UPDATE memories SET deleted_at=MAX(updated_at,?),updated_at=MAX(updated_at,?),revision=revision+1,
        actor_credential_id=(SELECT id FROM active_credentials WHERE token_digest=?)
      WHERE id=? AND space_id=? AND deleted_at IS NULL AND revision=? AND EXISTS (
        SELECT 1 FROM spaces s CROSS JOIN active_credentials c
        WHERE s.id=memories.space_id AND ${authority(true)}
      )`, [at, at, hash, memoryId, spaceId, expectedRevision, hash, at, at, at]);
    if (!removed) return this.conflict(hash, spaceId, memoryId, expectedRevision);
  }

  async list(token: string, spaceId: string, input: { limit?: number; cursor?: string } = {}): Promise<{results: Memory[]; nextCursor: string | null}> {
    identifier(spaceId);
    record(input);
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MemoryInvalid();
    let before = Number.MAX_SAFE_INTEGER;
    let afterId = '';
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== 'string' || input.cursor.length > 400) throw new MemoryInvalid();
      try {
        const cursor: unknown = JSON.parse(atob(input.cursor));
        if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isSafeInteger(cursor[0]) || cursor[0] < 0) throw new MemoryInvalid();
        identifier(cursor[1]);
        [before, afterId] = cursor;
      } catch { throw new MemoryInvalid(); }
    }
    const hash = await tokenDigest(token);
    const at = this.now();
    const rows = await this.db.withSession('first-primary').prepare(`
      SELECT ${memoryColumns} FROM spaces s CROSS JOIN active_credentials c
      LEFT JOIN memories r ON r.space_id=s.id AND r.deleted_at IS NULL
        AND (r.updated_at<? OR (r.updated_at=? AND r.id>?))
      WHERE s.id=? AND ${authority(false)}
      ORDER BY r.updated_at DESC,r.id ASC LIMIT ?`)
      .bind(before, before, afterId, spaceId, hash, at, at, at, limit + 1)
      .all<Memory & { id: string | null }>();
    if (!rows.success || !rows.results.length) throw new MemoryDenied();
    const present = rows.results.filter(row => row.id !== null);
    const results = present.slice(0, limit);
    const last = results.at(-1);
    return { results, nextCursor: present.length > limit && last ? btoa(JSON.stringify([last.updatedAt, last.id])) : null };
  }

  async search(token: string, spaceId: string, input: { query: string; limit?: number }): Promise<MemoryHit[]> {
    identifier(spaceId);
    record(input);
    text(input.query, 256);
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MemoryInvalid();
    const hash = await tokenDigest(token);
    const at = this.now();
    // A LEFT JOIN produces one empty sentinel row for an authorized Space with
    // no hits; zero rows always means denial. No separate stale auth pre-read.
    const rows = await this.db.withSession('first-primary').prepare(`
      SELECT r.id,s.id AS spaceId,
        substr(r.body,MAX(1,instr(lower(r.body),lower(?))-100),500) AS snippet,r.revision,r.source
      FROM spaces s CROSS JOIN active_credentials c LEFT JOIN memories r
        ON r.space_id=s.id AND r.deleted_at IS NULL AND instr(lower(r.body),lower(?))>0
      WHERE s.id=? AND ${authority(false)} ORDER BY r.updated_at DESC,r.id ASC LIMIT ?`)
      .bind(input.query, input.query, spaceId, hash, at, at, at, limit)
      .all<MemoryHit & { id: string | null; snippet: string | null }>();
    if (!rows.success || rows.results.length === 0) throw new MemoryDenied();
    return rows.results.flatMap(row => {
      if (row.id === null || row.snippet === null) return [];
      // Keep the wire representation bounded even for astral Unicode symbols,
      // without cutting a surrogate pair at the truncation boundary.
      const snippet = row.snippet.slice(0, 500).replace(/[\uD800-\uDBFF]$/, '');
      return [{ id: row.id, spaceId: row.spaceId, snippet, revision: row.revision, source: row.source }];
    });
  }
}

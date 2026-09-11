import { digestToken } from './identity.ts';
import type { IdentityDatabase, SqlValue } from './identity.ts';
import { json } from './api.ts';

export function invalidTokenResponse(origin: string): Response {
  const response = json({ error: 'invalid_token' }, 401);
  response.headers.set('www-authenticate', `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="memory:read"`);
  return response;
}

export type ToolAction = 'read' | 'create' | 'update' | 'delete';
export interface ToolAuthority {
  sql(action: ToolAction): string;
  values(hash: string, at: number, action: ToolAction): SqlValue[];
  expiry(action: ToolAction): string;
  // Local aliases r=memory and w=one server-created manifest entry.
  liveMemory: string;
}
type Disclosure = { spaceId: string; action: ToolAction; memoryId?: string; revision?: number;
  name?: string; organizationId?: string | null; securityMode?: string; currentFact?: boolean };
type Manifest = { required: Disclosure[]; content: Disclosure[]; receipt?: unknown };
/** A stable reference is essential: legacy SSE finishes its callback while the
 * response is buffered, after handler.fetch has already returned. */
export interface ToolResponseContext { manifest?: Manifest }

/** Capture typed callback arguments and actual service DTOs, never memory text
 * or a client-provided manifest. No authority facts are exposed on the wire. */
export function captureToolResponse(context: ToolResponseContext, name: string, args: Record<string, unknown>, value: unknown, release = false): void {
  const action: ToolAction = name === 'memory_add' || name === 'memory_ingest' ? 'create' :
    name === 'memory_update' ? 'update' : name === 'memory_delete' ? 'delete' : 'read';
  const manifest: Manifest = { required: [], content: [] };
  if (name !== 'memory_spaces') manifest.required.push({ spaceId: args.spaceId as string, action });
  if (name === 'memory_add' && args.supersedesMemoryId) manifest.required.push({ spaceId: args.spaceId as string, action: 'update' });
  const dto = value as Record<string, unknown>;
  const entries = (Array.isArray(value) ? value : Array.isArray(dto?.results) ? dto.results : [value]) as Record<string, unknown>[];
  if (name === 'memory_spaces') {
    manifest.content = entries.map(row => ({ spaceId: row.id as string, action: 'read', name: row.name as string,
      organizationId: row.organizationId as string | null, securityMode: row.securityMode as string }));
  } else if (!['memory_delete', 'memory_ingest'].includes(name)) {
    manifest.content = entries.filter(row => row.representation !== 'receipt').map(row => ({
      spaceId: row.spaceId as string, action: 'read', memoryId: row.id as string, revision: row.revision as number,
      currentFact: release && ['memory_search', 'memory_list'].includes(name),
    }));
    if (release && ['memory_add', 'memory_update'].includes(name) && dto.representation !== 'receipt') {
      manifest.receipt = { id: dto.id, spaceId: dto.spaceId, revision: dto.committedRevision ?? dto.revision,
        committedRevision: dto.committedRevision, replayed: dto.replayed, representation: 'receipt' };
    }
  }
  context.manifest = manifest;
}

function replaceToolResult(bytes: ArrayBuffer, response: Response, result: unknown): Response {
  const text = new TextDecoder().decode(bytes);
  const replace = (data: string) => {
    const envelope = JSON.parse(data) as Record<string, unknown>;
    if ('result' in envelope) envelope.result = result;
    return JSON.stringify(envelope);
  };
  const content = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.replace(/(^|\n)data: ?([^\r\n]+)(?=\r?\n|$)/g, (_match, prefix: string, data: string) => prefix + 'data: ' + replace(data))
    : replace(text);
  const headers = new Headers(response.headers);
  headers.delete('content-length'); headers.delete('content-encoding');
  return new Response(content, { status: response.status, headers });
}

/** Finish bounded SDK results before sending any bytes. Credential, every
 * required grant, and each emitted revision share ONE final primary snapshot.
 * Only synchronous expiry checks and envelope serialization follow that read. */
export async function toolResponse(response: Response, token: string, db: IdentityDatabase, clock: () => number, origin: string,
  authority: ToolAuthority, context: ToolResponseContext): Promise<Response> {
  if (response.status !== 200) return response;
  const bytes = await response.arrayBuffer();
  const manifest = context.manifest, checks = [...(manifest?.required ?? []), ...(manifest?.content ?? [])];
  const wire = new TextDecoder().decode(bytes);
  const envelopes = response.headers.get('content-type')?.includes('text/event-stream')
    ? [...wire.matchAll(/(?:^|\n)data: ?([^\r\n]+)(?=\r?\n|$)/g)].map(match => JSON.parse(match[1]!)) : [JSON.parse(wire)];
  const untrackedSuccess = !manifest && envelopes.some(envelope => envelope.result && envelope.result.isError !== true);
  const hash = await digestToken(token), at = clock(), actions = [...new Set(checks.map(check => check.action))];
  const branches = actions.map(action => `SELECT w.key,${authority.expiry(action)} AS expiresAt
    FROM wanted w JOIN spaces s ON s.id=json_extract(w.value,'$.spaceId') CROSS JOIN actor c
    WHERE json_extract(w.value,'$.action')='${action}' AND ${authority.sql(action)}
      AND (json_type(w.value,'$.name') IS NULL OR (s.name IS json_extract(w.value,'$.name')
        AND s.organization_id IS json_extract(w.value,'$.organizationId') AND s.security_mode IS json_extract(w.value,'$.securityMode')))
      AND (json_type(w.value,'$.memoryId') IS NULL OR EXISTS(SELECT 1 FROM memories r
        WHERE r.id=json_extract(w.value,'$.memoryId') AND r.space_id=s.id AND r.revision=json_extract(w.value,'$.revision')
          AND ${authority.liveMemory}))`);
  const snapshot = await db.withSession('first-primary').prepare(`/* mcp-response-authority */
    WITH actor AS MATERIALIZED (SELECT id,account_id,kind,token_digest,expires_at,membership_expires_at,permission,membership_id
      FROM active_credentials WHERE token_digest=?),
    wanted AS MATERIALIZED (SELECT key,value FROM json_each(?)),
    allowed AS MATERIALIZED (${branches.length ? branches.join(' UNION ALL ') : 'SELECT NULL AS key,0 AS expiresAt WHERE 0'})
    SELECT min(c.expires_at,c.membership_expires_at) AS expiresAt,
      (SELECT json_group_array(json_object('index',w.key,'expiresAt',coalesce(a.expiresAt,0)))
        FROM wanted w LEFT JOIN allowed a ON a.key=w.key) AS grants FROM actor c`)
    .bind(hash, JSON.stringify(checks), ...actions.flatMap(action => authority.values(hash, at, action)))
    .first<{ expiresAt: number; grants: string }>();
  const checkedAt = clock();
  const denied = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'access_denied', status: 403 }) }] };
  if (!snapshot || snapshot.expiresAt <= checkedAt) return token.includes('.') ? invalidTokenResponse(origin) : replaceToolResult(bytes, response, denied);
  const grants = JSON.parse(snapshot.grants) as { index: number; expiresAt: number }[];
  if (untrackedSuccess || grants.length !== checks.length || grants.some(grant => grant.index < (manifest?.required.length ?? 0) && grant.expiresAt <= checkedAt))
    return replaceToolResult(bytes, response, denied);
  if (grants.some(grant => grant.expiresAt <= checkedAt)) return replaceToolResult(bytes, response,
    manifest?.receipt === undefined ? denied : { isError: false, content: [{ type: 'text', text: JSON.stringify(manifest.receipt) }] });
  return new Response(bytes, response);
}

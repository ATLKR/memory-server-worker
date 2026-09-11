/** Cloudflare Agent Memory HTTP protocol only; callers own authorization and durable journals. */
export type AgentMemoryType = 'fact' | 'event' | 'instruction' | 'task';
export interface AgentMemoryMessage { role: 'system' | 'user' | 'assistant'; content: string; timestamp?: string }
export interface AgentMemoryCall { signal?: AbortSignal; deadlineMs?: number }
export interface AgentMemoryListOptions { limit?: number; cursor?: string; sessionId?: string; type?: AgentMemoryType }
export interface AgentMemoryRecallOptions { thinkingLevel?: 'low' | 'medium' | 'high'; responseLength?: 'short' | 'medium' | 'long'; referenceDate?: string }
export interface AgentMemoryEntry { id: string; type: AgentMemoryType; summary: string; sessionId: string | null; createdAt: string; updatedAt: string }
export interface AgentMemoryMemory extends AgentMemoryEntry { content: string }
export interface AgentMemoryPage { memories: AgentMemoryEntry[]; cursor?: string }
export interface AgentMemoryCandidate { id: string; summary: string; sessionId: string | null; score: number }
export interface AgentMemoryRecall { count: number; answer: string; candidates: AgentMemoryCandidate[] }
export type AgentMemoryOperation = 'ingest' | 'list' | 'get' | 'recall' | 'deleteSession' | 'deleteProfile';
export type AgentMemoryFailureOutcome = 'not_dispatched' | 'unknown' | 'read_failed';
export type AgentMemoryErrorCode = 'agent_memory_configuration_invalid' | 'agent_memory_input_invalid' |
  'agent_memory_aborted' | 'agent_memory_timeout' | 'agent_memory_transport_failed' |
  'agent_memory_response_invalid' | 'agent_memory_response_too_large' |
  'agent_memory_http_error' | 'agent_memory_provider_error';

export class AgentMemoryHttpError extends Error {
  readonly code: AgentMemoryErrorCode;
  readonly operation: AgentMemoryOperation | 'configure';
  readonly outcome: AgentMemoryFailureOutcome;
  readonly status?: number;
  constructor(code: AgentMemoryErrorCode, operation: AgentMemoryOperation | 'configure', outcome: AgentMemoryFailureOutcome, status?: number) {
    super(code);
    this.name = 'AgentMemoryHttpError';
    this.code = code;
    this.operation = operation;
    this.outcome = outcome;
    if (status !== undefined) this.status = status;
  }
}

export interface AgentMemoryHttpConfig {
  accountId: string;
  namespace: string;
  token: string;
  /** Injection is for server-side testing; never accept configuration from an end user. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
}
export interface AgentMemoryHttp {
  ingest(profile: string, messages: AgentMemoryMessage[], sessionId: string, call?: AgentMemoryCall): Promise<void>;
  list(profile: string, options?: AgentMemoryListOptions, call?: AgentMemoryCall): Promise<AgentMemoryPage>;
  get(profile: string, id: string, call?: AgentMemoryCall): Promise<AgentMemoryMemory>;
  recall(profile: string, query: string, options?: AgentMemoryRecallOptions, call?: AgentMemoryCall): Promise<AgentMemoryRecall>;
  deleteSession(profile: string, sessionId: string, call?: AgentMemoryCall): Promise<void>;
  deleteProfile(profile: string, call?: AgentMemoryCall): Promise<void>;
}

const encoder = new TextEncoder();
const kinds = ['fact', 'event', 'instruction', 'task'];
const byteLength = (value: string) => encoder.encode(value).byteLength;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const wellFormed = (value: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const textWithin = (value: unknown, maxBytes: number): value is string => typeof value === 'string' && value.length <= maxBytes && wellFormed(value) && byteLength(value) <= maxBytes;
const nameWithin = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && wellFormed(value) && !/[\u0000-\u001f\u007f]/u.test(value) && value !== '.' && value !== '..';
const cursorValid = (value: unknown): value is string => textWithin(value, 4096) && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
const timestampValid = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59 && Number(match[7] ?? 0) <= 23 && Number(match[8] ?? 0) <= 59 && Number.isFinite(Date.parse(value));
};
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function cancelBody(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* Cleanup must not mask the sanitized outcome. */ }
}

export function createAgentMemoryHttp(config: AgentMemoryHttpConfig): AgentMemoryHttp {
  const invalid = () => new AgentMemoryHttpError('agent_memory_configuration_invalid', 'configure', 'not_dispatched');
  if (!record(config) || typeof config.accountId !== 'string' || !/^[a-f0-9]{32}$/.test(config.accountId) ||
      !nameWithin(config.namespace, 32) || typeof config.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(config.token)) throw invalid();
  const timeoutMs = config.timeoutMs ?? 15000;
  const maxResponseBytes = config.maxResponseBytes ?? 4 * 1024 * 1024;
  const maxRequestBytes = config.maxRequestBytes ?? 20 * 1024 * 1024;
  const fetcher = config.fetch ?? globalThis.fetch;
  if (!integer(timeoutMs, 1, 60000) || !integer(maxResponseBytes, 1, 16 * 1024 * 1024) ||
      !integer(maxRequestBytes, 1, 100 * 1024 * 1024) || typeof fetcher !== 'function') throw invalid();
  // Copy target and credentials into this closure; later config mutation cannot retarget a request.
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/agent-memory/namespaces/${encodeURIComponent(config.namespace)}/profiles/`;
  const authorization = `Bearer ${config.token}`;

  async function request<T>(operation: AgentMemoryOperation, profile: string, make: () => {
    method: 'GET' | 'POST' | 'DELETE'; suffix: string; body?: unknown;
    parse: (result: unknown, envelope: Record<string, unknown>) => T;
  }, call: AgentMemoryCall = {}): Promise<T> {
    const mutation = operation === 'ingest' || operation === 'deleteSession' || operation === 'deleteProfile';
    let dispatched = false;
    const fail = (code: AgentMemoryErrorCode, status?: number) => new AgentMemoryHttpError(code, operation, dispatched ? mutation ? 'unknown' : 'read_failed' : 'not_dispatched', status);
    const input = (condition: unknown): void => { if (!condition) throw fail('agent_memory_input_invalid'); };
    input(nameWithin(profile, 100) && record(call) && onlyKeys(call, ['signal', 'deadlineMs']));
    // Capture caller-owned options once. Cleanup must detach from the same signal
    // even if the caller reuses/mutates its options object during this request.
    const signal = call.signal, requestedDeadlineMs = call.deadlineMs;
    input(requestedDeadlineMs === undefined || integer(requestedDeadlineMs, 1, Number.MAX_SAFE_INTEGER));
    input(signal === undefined || (record(signal) && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'));
    if (signal?.aborted) throw fail('agent_memory_aborted');
    const deadline = Math.min(Date.now() + timeoutMs, requestedDeadlineMs ?? Number.MAX_SAFE_INTEGER);
    if (deadline <= Date.now()) throw fail('agent_memory_timeout');
    let spec: ReturnType<typeof make>;
    let body: string | undefined;
    try {
      spec = make();
      if (spec.body !== undefined) {
        body = JSON.stringify(spec.body);
        if (byteLength(body) > maxRequestBytes) throw fail('agent_memory_input_invalid');
      }
    } catch (error) {
      if (error instanceof AgentMemoryHttpError) throw error;
      throw fail('agent_memory_input_invalid');
    }
    if (signal?.aborted) throw fail('agent_memory_aborted');
    if (Date.now() >= deadline) throw fail('agent_memory_timeout');
    const url = base + encodeURIComponent(profile) + spec.suffix;
    const controller = new AbortController();
    let active = true;
    let abortCode: 'agent_memory_aborted' | 'agent_memory_timeout' | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let received: Response | undefined;
    let rejectAbort!: (error: AgentMemoryHttpError) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const stop = (code: 'agent_memory_aborted' | 'agent_memory_timeout') => {
      if (!active || abortCode) return;
      abortCode = code;
      controller.abort();
      try { void reader?.cancel().catch(() => {}); } catch { /* No raw cleanup error escapes. */ }
      rejectAbort(fail(code));
    };
    const onAbort = () => stop('agent_memory_aborted');
    const timer = setTimeout(() => stop('agent_memory_timeout'), Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', onAbort, { once: true });
    const checkpoint = () => {
      if (abortCode) throw fail(abortCode);
      if (signal?.aborted) throw fail('agent_memory_aborted');
      if (Date.now() >= deadline) throw fail('agent_memory_timeout');
      if (!active) throw fail('agent_memory_aborted');
    };
    const work = async (): Promise<T> => {
      checkpoint();
      const headers: Record<string, string> = { authorization, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      dispatched = true;
      const response = await fetcher(url, { method: spec.method, headers, body, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      received = response;
      if (!active || abortCode) { cancelBody(response); checkpoint(); }
      checkpoint();
      if (response.redirected || (response.url && response.url !== url)) { cancelBody(response); throw fail('agent_memory_response_invalid'); }
      if (!integer(response.status, 200, 299)) { cancelBody(response); throw fail('agent_memory_http_error', integer(response.status, 100, 599) ? response.status : undefined); }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { cancelBody(response); throw fail('agent_memory_response_invalid'); }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) { cancelBody(response); throw fail('agent_memory_response_too_large'); }
      if (!response.body) throw fail('agent_memory_response_invalid');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          checkpoint();
          const chunk = await reader.read();
          checkpoint();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw fail('agent_memory_response_invalid');
          size += chunk.value.byteLength;
          if (size > maxResponseBytes) throw fail('agent_memory_response_too_large');
          chunks.push(chunk.value);
        }
      } catch (error) {
        try { void reader.cancel().catch(() => {}); } catch { /* Best-effort cancellation is bounded by the call deadline. */ }
        throw error;
      } finally {
        try { reader.releaseLock(); } catch { /* An aborted pending read may still own the lock. */ }
      }
      checkpoint();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw fail('agent_memory_response_invalid'); }
      checkpoint();
      if (!record(parsed) || typeof parsed.success !== 'boolean') throw fail('agent_memory_response_invalid');
      if (!parsed.success) throw fail('agent_memory_provider_error');
      if (!Array.isArray(parsed.errors) || parsed.errors.length || !Array.isArray(parsed.messages) || !Object.hasOwn(parsed, 'result')) throw fail('agent_memory_response_invalid');
      let output: T;
      try { output = spec.parse(parsed.result, parsed); }
      catch { throw fail('agent_memory_response_invalid'); }
      checkpoint();
      return output;
    };
    try {
      return await Promise.race([work(), interrupted]);
    } catch (error) {
      if (error instanceof AgentMemoryHttpError && error.operation === operation) throw error;
      throw fail(abortCode ?? 'agent_memory_transport_failed');
    } finally {
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
      if (!reader && received) cancelBody(received);
      try { void reader?.cancel().catch(() => {}); } catch { /* A released/closed stream needs no further cleanup. */ }
    }
  }

  const check = (ok: unknown): void => { if (!ok) throw new Error('invalid'); };
  const nullableSession = (value: unknown): value is string | null => value === null || nameWithin(value, 64);
  const entry = (value: unknown): AgentMemoryEntry => {
    check(record(value));
    const v = value as Record<string, unknown>;
    check(nameWithin(v.id, 256) && kinds.includes(v.type as string) && textWithin(v.summary, 65536) && nullableSession(v.sessionId) && timestampValid(v.createdAt) && timestampValid(v.updatedAt));
    return { id: v.id as string, type: v.type as AgentMemoryType, summary: v.summary as string, sessionId: v.sessionId as string | null, createdAt: v.createdAt as string, updatedAt: v.updatedAt as string };
  };
  const empty = (value: unknown): void => { check(value === null); };

  return Object.freeze<AgentMemoryHttp>({
    ingest(profile, messages, sessionId, call) {
      return request('ingest', profile, () => {
        check(Array.isArray(messages) && messages.length >= 1 && messages.length <= 500 && nameWithin(sessionId, 64));
        const copied = Array.from(messages, message => {
          check(record(message) && onlyKeys(message, ['role', 'content', 'timestamp']) && ['system', 'user', 'assistant'].includes(message.role) && textWithin(message.content, 32768) && (message.timestamp === undefined || timestampValid(message.timestamp)));
          return { role: message.role, content: message.content, ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }) };
        });
        return { method: 'POST', suffix: '/ingest', body: { messages: copied, sessionId }, parse: empty };
      }, call);
    },
    list(profile, options = {}, call) {
      return request('list', profile, () => {
        check(record(options) && onlyKeys(options, ['limit', 'cursor', 'sessionId', 'type']));
        const limit = options.limit ?? 20;
        check(integer(limit, 1, 500) && (options.cursor === undefined || cursorValid(options.cursor)) && (options.sessionId === undefined || nameWithin(options.sessionId, 64)) && (options.type === undefined || kinds.includes(options.type)));
        const requestedCursor = options.cursor;
        const params = new URLSearchParams({ per_page: String(limit) });
        if (options.cursor !== undefined) params.set('cursor', options.cursor);
        if (options.sessionId !== undefined) params.set('session_id', options.sessionId);
        if (options.type !== undefined) params.set('type', options.type);
        return { method: 'GET', suffix: `/memories?${params}`, parse: (result: unknown, envelope: Record<string, unknown>): AgentMemoryPage => {
          check(Array.isArray(result) && result.length <= limit);
          const memories = (result as unknown[]).map(entry);
          const info = envelope.result_info;
          check(info === undefined || record(info));
          const metadata = (info ?? {}) as Record<string, unknown>;
          check(metadata.count === undefined || (integer(metadata.count, 0, limit) && metadata.count === memories.length));
          check(metadata.per_page === undefined || integer(metadata.per_page, 1, 1000));
          const cursor = metadata.cursor;
          check(cursor === undefined || cursor === null || (cursorValid(cursor) && cursor !== requestedCursor));
          return { memories, ...(typeof cursor === 'string' ? { cursor } : {}) };
        } };
      }, call);
    },
    get(profile, id, call) {
      return request('get', profile, () => {
        check(nameWithin(id, 256));
        return { method: 'GET', suffix: `/memories/${encodeURIComponent(id)}`, parse: (result: unknown): AgentMemoryMemory => {
          const parsed = entry(result);
          check(parsed.id === id && record(result) && textWithin(result.content, 1024 * 1024));
          return { ...parsed, content: (result as Record<string, unknown>).content as string };
        } };
      }, call);
    },
    recall(profile, query, options = {}, call) {
      return request('recall', profile, () => {
        check(textWithin(query, 1024) && query.length > 0 && record(options) && onlyKeys(options, ['thinkingLevel', 'responseLength', 'referenceDate']) &&
          (options.thinkingLevel === undefined || (typeof options.thinkingLevel === 'string' && ['low', 'medium', 'high'].includes(options.thinkingLevel))) &&
          (options.responseLength === undefined || (typeof options.responseLength === 'string' && ['short', 'medium', 'long'].includes(options.responseLength))) &&
          (options.referenceDate === undefined || timestampValid(options.referenceDate)));
        return { method: 'POST', suffix: '/recall', body: { query, ...options }, parse: (result: unknown): AgentMemoryRecall => {
          check(record(result));
          const v = result as Record<string, unknown>;
          check(integer(v.count, 0, Number.MAX_SAFE_INTEGER) && textWithin(v.answer, 1024 * 1024) && Array.isArray(v.candidates) && v.candidates.length <= 1000);
          const candidates = (v.candidates as unknown[]).map(candidate => {
            check(record(candidate));
            const c = candidate as Record<string, unknown>;
            check(nameWithin(c.id, 256) && textWithin(c.summary, 65536) && nullableSession(c.sessionId) && typeof c.score === 'number' && Number.isFinite(c.score));
            return { id: c.id as string, summary: c.summary as string, sessionId: c.sessionId as string | null, score: c.score as number };
          });
          return { count: v.count as number, answer: v.answer as string, candidates };
        } };
      }, call);
    },
    deleteSession(profile, sessionId, call) {
      return request('deleteSession', profile, () => {
        check(nameWithin(sessionId, 64));
        return { method: 'DELETE', suffix: `/sessions/${encodeURIComponent(sessionId)}`, parse: empty };
      }, call);
    },
    deleteProfile(profile, call) { return request('deleteProfile', profile, () => ({ method: 'DELETE', suffix: '', parse: empty }), call); },
  });
}

import { z } from 'zod';
import { assertRoutingTarget, resolveMemoryRoute, routingDecisionSchema, routingTargetSchema } from './policy.ts';
import type { RoutingPlan, RoutingRestriction } from './policy.ts';

type Route = RoutingPlan['route'];
export interface RoutingClientConfig {
  targets: Partial<Record<Route, { origin: string; spaceId: string }>>;
  credential: (target: { route: Route; origin: string }) => Promise<{ kind: 'pat' | 'sso'; token: string }>;
  /** Local operator/source-context constraints. Recreate the client for a new
   * source context; tool input must never replace these inherited restrictions. */
  restrictions?: readonly RoutingRestriction[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export interface RoutingCallOptions { signal?: AbortSignal }
export interface RoutingToolResult { content: { type: 'text'; text: string }[]; isError?: boolean }
const utf8 = new TextEncoder();
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const messageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().refine(s => utf8.encode(s).length <= 32768),
  timestamp: z.iso.datetime({ offset: true }).optional(),
});
export const ingestRoutingInputSchema = z.strictObject({
  routing: routingDecisionSchema, operationId: identifier,
  messages: z.array(messageSchema).min(1).max(500).refine(messages => messages.reduce((n, m) => n + utf8.encode(m.content).length, 0) <= 1024 * 1024),
  sessionId: z.string().min(1).max(64).optional(),
});
export const searchRoutingInputSchema = z.strictObject({
  routing: routingDecisionSchema, query: z.string().min(1).refine(s => utf8.encode(s).length <= 1024),
  limit: z.number().int().min(1).max(50).optional(),
});
const metadataSchema = z.strictObject({ version: z.literal(1), protocol: z.literal('memory-routing-v1'), target: routingTargetSchema });
const consentReceiptSchema = z.strictObject({
  version: z.literal(1), allowed: z.literal(true), requestId: z.string(), spaceId: identifier,
  consentId: identifier, consentVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operation: z.enum(['memory_ingest', 'memory_search']),
  expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  receipt: z.string().regex(/^[\x21-\x7e]{1,4096}$/),
});
const resultSchema = z.object({
  content: z.array(z.strictObject({ type: z.literal('text'), text: z.string() })).max(100),
  isError: z.boolean().optional(),
});
const endpoint = z.strictObject({ origin: z.string(), spaceId: identifier });
const targetsSchema = z.strictObject({ 'agent-memory': endpoint.optional(), seoul: endpoint.optional() });

class RoutingClientError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function fail(code: string): never { throw new RoutingClientError(code); }
function mediaType(response: Response): string { return (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase(); }

/** Runs in the user's client process, before any transcript or query egress.
 * Target URLs and credentials are operator configuration, never tool arguments.
 * A ready manifest is a protocol declaration, not physical residency attestation.
 */
export function createRoutingClient(config: RoutingClientConfig) {
  const parsed = targetsSchema.safeParse(config?.targets);
  if (!parsed.success || typeof config?.credential !== 'function') fail('routing_configuration_invalid');
  const targets = parsed.data;
  for (const target of Object.values(targets)) {
    let url: URL;
    try { url = new URL(target.origin); } catch { fail('routing_configuration_invalid'); }
    if (url.protocol !== 'https:' || url.origin !== target.origin || url.username || url.password) fail('routing_configuration_invalid');
    Object.freeze(target);
  }
  Object.freeze(targets);
  let restrictions: readonly RoutingRestriction[];
  try {
    const copied = structuredClone(config.restrictions ?? []);
    resolveMemoryRoute({ version: 1, classification: 'general' }, copied);
    restrictions = Object.freeze(copied.map(restriction => Object.freeze(restriction)));
  } catch { fail('routing_configuration_invalid'); }
  function planDecision(decision: unknown, ...unexpected: unknown[]): RoutingPlan {
    // Do not present the policy helper's optional argument as a one-off plan
    // override that a later call() could forget. Bind constraints to the client.
    if (unexpected.length) fail('routing_configuration_invalid');
    return resolveMemoryRoute(decision, restrictions);
  }
  const timeoutMs = config.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('routing_configuration_invalid');
  const request = config.fetch ?? globalThis.fetch;
  const credential = config.credential;
  if (typeof request !== 'function') fail('routing_configuration_invalid');

  async function call(name: 'memory_ingest' | 'memory_search', args: unknown, options: RoutingCallOptions = {}): Promise<{ routing: RoutingPlan; result: RoutingToolResult }> {
    if (!['memory_ingest', 'memory_search'].includes(name)) fail('routing_request_invalid');
    const parsedArgs = (name === 'memory_ingest' ? ingestRoutingInputSchema : searchRoutingInputSchema).safeParse(args);
    if (!parsedArgs.success) fail('routing_request_invalid');
    const input = parsedArgs.data, plan = planDecision(input.routing), target = targets[plan.route];
    if (!target) fail('routing_target_unavailable');
    const id = crypto.randomUUID();
    // Serialize the validated copy before any await. The caller cannot swap the
    // content or its classification during discovery or credential refresh.
    const effectiveRouting = { ...input.routing, destination: plan.route,
      ...(plan.requiredRegion === 'kr-seoul' ? { requiredRegion: 'kr-seoul' as const } : {}) };
    const serialize = () => {
      const value = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { ...input, routing: effectiveRouting, spaceId: target.spaceId } } });
      if (utf8.encode(value).length > 2 * 1024 * 1024) fail('routing_request_invalid');
      return value;
    };
    let body = serialize();
    const controller = new AbortController();
    const signal = options.signal;
    let timedOut = false, dispatched = false;
    // Timers cannot fire while an injected provider blocks the event loop.
    // Check a monotonic deadline as well before any content dispatch.
    const deadline = performance.now() + timeoutMs;
    const onAbort = () => controller.abort();
    if (signal?.aborted) fail('routing_request_aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const check = () => {
      if (performance.now() >= deadline) { timedOut = true; controller.abort(); }
      if (controller.signal.aborted) fail(timedOut ? 'routing_request_timeout' : 'routing_request_aborted');
    };
    // Also bounds injected providers which ignore cancellation. Late responses
    // cannot trigger another dispatch, refresh or alternate-region request.
    const bounded = <T>(work: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const stop = () => reject(new RoutingClientError(timedOut ? 'routing_request_timeout' : 'routing_request_aborted'));
      if (controller.signal.aborted) return stop();
      controller.signal.addEventListener('abort', stop, { once: true });
      Promise.resolve().then(() => { check(); return work(); }).then(value => {
        controller.signal.removeEventListener('abort', stop);
        try { check(); } catch (error) {
          if (value instanceof Response) void value.body?.cancel().catch(() => undefined);
          reject(error); return;
        }
        resolve(value);
      }, error => {
        controller.signal.removeEventListener('abort', stop);
        try { check(); } catch (deadlineError) { reject(deadlineError); return; }
        reject(error);
      });
    });
    const text = async (response: Response, max: number): Promise<string> => {
      if (!response.body) fail('routing_response_invalid');
      const reader = response.body.getReader(), parts: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const part = await bounded(() => reader.read());
          if (part.done) break;
          total += part.value.length;
          if (total > max) fail('routing_response_invalid');
          parts.push(part.value);
        }
        const bytes = new Uint8Array(total); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } finally { void reader.cancel().catch(() => undefined); }
    };
    const sseResult = async (response: Response): Promise<unknown> => {
      if (!response.body) fail('routing_response_invalid');
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '', total = 0, skipLf = false;
      let data: string[] = [];
      try {
        while (true) {
          const part = await bounded(() => reader.read());
          if (!part.done) {
            total += part.value.length;
            if (total > 1024 * 1024) fail('routing_response_invalid');
          }
          buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
          if (skipLf && buffer.length) {
            if (buffer[0] === '\n') buffer = buffer.slice(1);
            skipLf = false;
          }
          while (true) {
            const ending = /[\r\n]/.exec(buffer);
            if (!ending) break;
            const line = buffer.slice(0, ending.index);
            buffer = buffer.slice(ending.index + 1);
            if (ending[0] === '\r') {
              if (buffer[0] === '\n') buffer = buffer.slice(1);
              else if (!buffer.length) skipLf = true;
            }
            if (!line) {
              if (data.length) {
                const payload = data.join('\n'); data = [];
                // MCP permits an empty priming event before the JSON-RPC result.
                if (!payload) continue;
                const value: unknown = JSON.parse(payload);
                if (value && typeof value === 'object' && !Array.isArray(value)
                  && (value as Record<string, unknown>).id === id) return value;
              }
            } else if (line === 'data' || line.startsWith('data:')) data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
          }
          if (part.done) fail('routing_response_invalid');
        }
      } finally { void reader.cancel().catch(() => undefined); }
    };
    const init = { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal } as const;
    try {
      check();
      const discovery = await bounded(() => request(target.origin + '/.well-known/memory-routing', {
        ...init, method: 'GET', headers: { accept: 'application/json' },
      }));
      if (!discovery.ok || mediaType(discovery) !== 'application/json') {
        void discovery.body?.cancel().catch(() => undefined); fail('routing_target_unavailable');
      }
      let advertised;
      try { advertised = metadataSchema.safeParse(JSON.parse(await text(discovery, 8192))); }
      catch (error) { if (error instanceof RoutingClientError && ['routing_request_timeout', 'routing_request_aborted'].includes(error.code)) throw error; fail('routing_target_unavailable'); }
      if (!advertised.success) fail('routing_target_unavailable');
      assertRoutingTarget(plan, advertised.data.target);
      check();
      const auth = await bounded(() => credential({ route: plan.route, origin: target.origin }));
      if (!auth || !['pat', 'sso'].includes(auth.kind) || typeof auth.token !== 'string'
        || auth.token.length < 1 || auth.token.length > 16384 || /[\s\x00-\x1f\x7f]/.test(auth.token)) fail('routing_auth_unavailable');
      let consentReceipt: string | undefined;
      let consentExpiresAt = Number.MAX_SAFE_INTEGER;
      const consent = input.routing.medicalCloudflareConsent;
      if (plan.route === 'agent-memory' && consent) {
        // Ask with references only. A request-supplied boolean/reference alone
        // cannot authorize the raw body. The server checks its actual ledger
        // and must recheck the receipt, identity, consent and hard locks at use.
        check();
        try {
          const response = await bounded(() => request(target.origin + '/v1/routing/consent/check', {
            ...init, method: 'POST', headers: { authorization: 'Bearer ' + auth.token, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ version: 1, requestId: id, spaceId: target.spaceId, consent, operation: name }),
          }));
          if (!response.ok || mediaType(response) !== 'application/json') {
            void response.body?.cancel().catch(() => undefined); fail('routing_consent_unavailable');
          }
          const receipt = consentReceiptSchema.safeParse(JSON.parse(await text(response, 8192)));
          const now = Date.now();
          if (!receipt.success || receipt.data.requestId !== id || receipt.data.spaceId !== target.spaceId
            || ('consentId' in consent && (receipt.data.consentId !== consent.consentId || receipt.data.consentVersion !== consent.version))
            || receipt.data.operation !== name || receipt.data.expiresAtMs <= now || receipt.data.expiresAtMs > now + 120000) {
            fail('routing_consent_unavailable');
          }
          consentReceipt = receipt.data.receipt; consentExpiresAt = receipt.data.expiresAtMs;
          // Resolve a customer-wide selector to the precise current grant. No
          // employee prompt or stored client-side consent grant is involved.
          effectiveRouting.medicalCloudflareConsent = { consentId: receipt.data.consentId, version: receipt.data.consentVersion };
          body = serialize();
        } catch (error) {
          if (error instanceof RoutingClientError && ['routing_request_timeout', 'routing_request_aborted'].includes(error.code)) throw error;
          fail('routing_consent_unavailable');
        }
      }
      check();
      const response = await bounded(() => {
        check();
        if (Date.now() >= consentExpiresAt) fail('routing_consent_unavailable');
        dispatched = true;
        return request(target.origin + '/mcp', { ...init, method: 'POST', body, headers: {
          authorization: 'Bearer ' + auth.token, 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25',
          ...(consentReceipt ? { 'x-memory-consent-receipt': consentReceipt } : {}),
        } });
      });
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); fail('routing_upstream_unavailable'); }
      const contentType = mediaType(response);
      let results: unknown[];
      if (contentType === 'application/json') results = [JSON.parse(await text(response, 1024 * 1024))];
      else if (contentType === 'text/event-stream') results = [await sseResult(response)];
      else { void response.body?.cancel().catch(() => undefined); fail('routing_response_invalid'); }
      const matching = results.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object'
        && !Array.isArray(value) && (value as Record<string, unknown>).jsonrpc === '2.0' && (value as Record<string, unknown>).id === id);
      if (matching.length !== 1 || matching[0]!.error !== undefined) fail('routing_response_invalid');
      const tool = resultSchema.safeParse(matching[0]!.result);
      if (!tool.success) fail('routing_response_invalid');
      // Upstream tool failures may contain arbitrary diagnostics, including
      // reflected credentials or transcript fragments. Do not expose them.
      if (tool.data.isError) fail('routing_upstream_rejected');
      check();
      return { routing: plan, result: tool.data };
    } catch (error) {
      if (name === 'memory_ingest' && dispatched) fail('routing_write_outcome_unknown');
      if (error instanceof RoutingClientError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'routing_target_unavailable') fail('routing_target_unavailable');
      return fail('routing_upstream_unavailable');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
    }
  }
  return Object.freeze({ plan: planDecision, call });
}

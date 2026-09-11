import { z } from 'zod';
import type { ReleaseEnv } from '../release/types.ts';
import { fail, json, requestObject, requestText } from '../release/util.ts';
import { requireMethod, pathIdentifier } from '../api.ts';
import { cloudflareMedicalConsentSchema, medicalCloudflareConsentOperationSchema, medicalCloudflareConsentReferenceSchema, parseCloudflareMedicalConsent } from './consent.ts';
import { resolveOrganizationAdmin, resolveRoutingAuthority, routingIdentifier, routingNow } from './server-authority.ts';
import type { RoutingLedger, RoutingLedgerStub } from './ledger-types.ts';
import { routedMcp } from './server-mcp.ts';
import { routingLedgerRequestId, routingRequestIdSchema } from './rpc-id.ts';

type RoutingApiEnv = ReleaseEnv & { MEMORY_CONSENT_LEDGER?: RoutingLedger };
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const grantSchema = z.strictObject({
  spaceScope: cloudflareMedicalConsentSchema.shape.spaceScope,
  scopes: cloudflareMedicalConsentSchema.shape.scopes,
  validFromMs: cloudflareMedicalConsentSchema.shape.validFromMs,
  expiresAtMs: cloudflareMedicalConsentSchema.shape.expiresAtMs,
  evidenceRef: identifier,
}).refine(value => value.expiresAtMs === undefined || value.expiresAtMs > value.validFromMs);
const updateSchema = z.strictObject({ expectedVersion: version.or(z.literal(0)), grant: grantSchema });
const revokeSchema = z.strictObject({ expectedVersion: version });
const checkSchema = z.strictObject({ version: z.literal(1), requestId: routingRequestIdSchema, spaceId: identifier,
  operation: medicalCloudflareConsentOperationSchema,
  consent: z.union([medicalCloudflareConsentReferenceSchema,z.strictObject({ mode: z.literal('organization') })]),
});
const receiptSchema = z.strictObject({ version:z.literal(1),allowed:z.literal(true),requestId:identifier,spaceId:identifier,
  consentId:identifier,consentVersion:version,operation:medicalCloudflareConsentOperationSchema,
  expiresAtMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),receipt:z.string().regex(/^[\x21-\x7e]{1,4096}$/),
});
const ledgerCodes: Record<string, number> = {
  routing_ledger_input_invalid:400,routing_ledger_organization_mismatch:403,routing_ledger_version_conflict:409,
  routing_ledger_capacity_exceeded:429,routing_ledger_receipt_invalid:403,routing_ledger_operation_conflict:409,
  routing_ledger_ticket_unavailable:403,routing_ledger_transition_invalid:409,routing_ledger_authority_expired:403,
  routing_consent_unavailable:403,routing_consent_scope_denied:403,routing_consent_reference_mismatch:403,routing_consent_context_invalid:400,
  routing_consent_transition_invalid:409,
};
async function ledgerCall<T>(work: () => Promise<T>, mutation = false): Promise<T> {
  try { return await work(); } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (Object.hasOwn(ledgerCodes,code)) fail(ledgerCodes[code]!,code);
    fail(503,mutation ? 'routing_consent_write_outcome_unknown' : 'routing_consent_unavailable');
  }
}
async function input<T>(request: Request, schema: z.ZodType<T>, maximum: number): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') fail(415,'json_required');
  const parsed = schema.safeParse(requestObject(await requestText(request,maximum)));
  if (!parsed.success) fail(400,'routing_request_invalid');
  return parsed.data;
}
function stub(env: RoutingApiEnv, organizationId: string): RoutingLedgerStub {
  if (!env.MEMORY_CONSENT_LEDGER) fail(503,'routing_consent_unavailable');
  try { return env.MEMORY_CONSENT_LEDGER.getByName('organization:'+organizationId); }
  catch { return fail(503,'routing_consent_unavailable'); }
}
function consentRecord(value: unknown, organizationId: string) {
  try {
    const record = parseCloudflareMedicalConsent(value);
    if (record.organizationId !== organizationId) fail(503,'routing_consent_response_invalid');
    return record;
  } catch { return fail(503,'routing_consent_response_invalid'); }
}

/** Hook runs only after application authentication/host/CSRF/rate checks.
 * Current D1 authorization and the DO ledger are separate stores. We re-read
 * immediately before dispatch and after its response; these checks do not make
 * revocation atomic across stores. A failed write response can mean committed.
 * Receipts always require fresh authority and ledger validation at actual use. */
export function createRoutingApi(env: RoutingApiEnv, options: { clock?: () => number } = {}) {
  const clock = options.clock ?? Date.now;
  return async function route(request: Request, token: string): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === '/mcp' && request.headers.has('x-memory-consent-receipt')) return routedMcp(request,token,env,clock);
    const admin = /^\/v1\/organizations\/([^/]+)\/medical-cloudflare-consent$/.exec(url.pathname);
    const check = url.pathname === '/v1/routing/consent/check';
    if (!admin && !check) return null;
    if (url.search) fail(400,'routing_request_invalid');
    if (check) {
      requireMethod(request,'POST');
      const value = await input(request,checkSchema,8192);
      const ledgerRequestId = await routingLedgerRequestId(value.requestId);
      const actor = await resolveRoutingAuthority(env.DB,token,value.spaceId,value.operation,clock);
      const ledger = stub(env,actor.organizationId);
      const raw = await ledgerCall(() => ledger.issue({ organizationId:actor.organizationId,accountId:actor.accountId,
        credentialId:actor.credentialId,spaceId:actor.spaceId,operation:value.operation,requestId:ledgerRequestId,
        ...('consentId' in value.consent ? { reference:value.consent } : {}),authorityExpiresAtMs:actor.authorityExpiresAtMs }));
      const receipt = receiptSchema.safeParse(raw), now = routingNow(clock);
      if (!receipt.success || receipt.data.requestId !== ledgerRequestId || receipt.data.spaceId !== value.spaceId
        || receipt.data.operation !== value.operation || receipt.data.expiresAtMs <= now
        || receipt.data.expiresAtMs > Math.min(now+60000,actor.authorityExpiresAtMs)
        || ('consentId' in value.consent && (receipt.data.consentId !== value.consent.consentId || receipt.data.consentVersion !== value.consent.version))) fail(503,'routing_consent_response_invalid');
      const current = await resolveRoutingAuthority(env.DB,token,value.spaceId,value.operation,clock);
      if (current.organizationId !== actor.organizationId || current.accountId !== actor.accountId || current.credentialId !== actor.credentialId) fail(403,'access_denied');
      if (receipt.data.expiresAtMs > current.authorityExpiresAtMs) fail(403,'routing_consent_unavailable');
      if (receipt.data.expiresAtMs <= routingNow(clock)) fail(403,'routing_consent_unavailable');
      return json({...receipt.data,requestId:value.requestId});
    }
    requireMethod(request,'GET','PUT','DELETE');
    const organizationId = routingIdentifier(pathIdentifier(admin![1]!));
    if (request.method === 'GET') {
      await resolveOrganizationAdmin(env.DB,token,organizationId,clock);
      const value = await ledgerCall(() => stub(env,organizationId).get({organizationId}));
      const record = value === null ? null : consentRecord(value,organizationId);
      await resolveOrganizationAdmin(env.DB,token,organizationId,clock);
      return json(record);
    }
    const update = request.method === 'PUT' ? await input(request,updateSchema,262144) : undefined;
    const expectedVersion = update?.expectedVersion ?? (await input(request,revokeSchema,8192)).expectedVersion;
    const proposedGrant = update?.grant;
    const spaceIds = proposedGrant?.spaceScope.kind === 'spaces' ? proposedGrant.spaceScope.spaceIds : [];
    const adminOptions = {recent:true,spaceIds};
    const actor = await resolveOrganizationAdmin(env.DB,token,organizationId,clock,adminOptions), ledger = stub(env,organizationId);
    const raw = await ledgerCall(() => proposedGrant
      ? ledger.grant({organizationId,approvedBy:actor.accountId,expectedVersion,grant:proposedGrant})
      : ledger.revoke({organizationId,approvedBy:actor.accountId,expectedVersion}),true);
    // The ledger may already have committed. Never relabel a post-dispatch
    // authorization/output failure as proof that the mutation did not happen.
    try {
      const record = consentRecord(raw,organizationId);
      await resolveOrganizationAdmin(env.DB,token,organizationId,clock,adminOptions);
      return json(record);
    } catch { return fail(503,'routing_consent_write_outcome_unknown'); }
  };
}

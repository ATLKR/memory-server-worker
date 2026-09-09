import type { Extension, ReleaseEnv, Value } from './types.ts';
import { MemoryStore, type CreateInput } from './memory.ts';
import { Search } from './search.ts';
import { Jobs } from './jobs.ts';
import { Ingest } from './ingest.ts';
import { Transfers } from './transfer.ts';
import { Admin } from './admin.ts';
import { Billing } from './billing.ts';
import { mcp } from './mcp.ts';
import { authority, params, interactive, requireSpace, recentSql } from './authority.ts';
import { ReleaseError, batch, body, canonical, capabilitiesFromScopes, fail, id, integer, json, object, one, rows, stmt, str, tokenHash, unbase64url } from './util.ts';
import { renderManagement, managementScript, managementStyles } from './console.ts';
import { readSettings } from '../config.ts';
export interface IdentityAdapter {
    getAccount(token: string): Promise<unknown>;
    beginEmailLink(token: string, email: string, deliver: (mail: {
        address: string;
        challengeId: string;
        proofToken: string;
        expiresAt: number;
    }) => Promise<void>): Promise<string>;
    completeEmailLink(token: string, challengeId: string, proof: string): Promise<string>;
    unlinkEmail(token: string, emailId: string): Promise<void>;
    revokeDomainEmail(token: string, domainId: string, email: string): Promise<void>;
}
export interface ReleaseOptions {
    clock?: () => number;
    identity?: IdentityAdapter;
}
function numberParam(url: URL, name: string, defaultValue: number, max: number): number { const text = url.searchParams.get(name); if (text === null)
    return defaultValue; if (!/^\d+$/.test(text))
    fail(400, 'invalid_' + name); return integer(Number(text), 1, max); }
function key(request: Request, input: Record<string, unknown>): string { const header = request.headers.get('idempotency-key'), arg = input.operationId; if (header && arg !== undefined && header !== arg)
    fail(400, 'operation_id_mismatch'); return id(header ?? arg ?? crypto.randomUUID()); }
function content(input: Record<string, unknown>): CreateInput { const { operationId, ...rest } = input; return rest as CreateInput; }
/** Called only after original app.ts has authenticated the bearer/session. */
export function createRelease(env: ReleaseEnv, options: ReleaseOptions = {}): Extension {
    const clock = options.clock ?? Date.now, db = env.DB, store = new MemoryStore(db, clock), search = new Search(env, clock), ingest = new Ingest(env, clock), transfers = new Transfers(db, clock), admin = new Admin(env, clock), billing = new Billing(env, clock), jobs = new Jobs(env, clock);
    jobs.ingest = j => ingest.process(j);
    const settings = readSettings(env), origin = settings.origin;
    const guarded = async (run: () => Promise<Response | null>): Promise<Response | null> => { try {
        return await run();
    }
    catch (e) {
        const identityDenied = e instanceof Error && (e.name === 'IdentityDenied' || e.constructor.name === 'IdentityDenied');
        const status = e instanceof ReleaseError ? e.status : identityDenied ? 403 : 500;
        return json({ error: e instanceof ReleaseError ? e.code : identityDenied ? 'access_denied' : 'internal_error' }, status, status === 429 ? { 'retry-after': '60' } : {});
    } };
    function originCheck(request: Request) { if (new URL(request.url).origin !== origin)
        fail(421, 'invalid_host'); if (request.headers.has('origin') && request.headers.get('origin') !== origin)
        fail(403, 'origin_denied'); }
    async function ready(): Promise<Response> { const checks: Record<string, boolean> = {}; checks.schema = Boolean(await one(db, 'SELECT version FROM release_meta WHERE version=6')); checks.sso = Boolean(env.SSO_CLIENT_ID); checks.semantic = Boolean(env.AI && env.MEMORY_INDEX); checks.encryptedIngest = Boolean(env.PAYLOAD_KEY && env.AI); checks.mail = Boolean(env.EMAIL && env.MAIL_FROM); checks.deprovisioning = Boolean(env.IDENTITY_WEBHOOK_SECRET); checks.billing = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_API_VERSION && Object.keys(billing.plans()).length); const heartbeat = await one<{
        at: number;
    }>(db, "SELECT last_success_at AS at FROM release_heartbeats WHERE name='maintenance'"); checks.maintenance = Boolean(heartbeat && clock() - heartbeat.at < 300000); checks.operatorAcceptance = env.RELEASE_MODE === 'ga' && Boolean(env.LIVE_ACCEPTANCE_ID); const ready = Object.values(checks).every(Boolean); return json({ ready, stage: ready ? 'operator-enabled-ga' : 'release-candidate', checks, notice: 'Readiness is configuration/heartbeat checking, not independent security or production certification.' }, ready ? 200 : 503); }
    const identity = () => { if (!options.identity)
        fail(503, 'identity_adapter_missing'); return options.identity; };
    return {
        publicRoute(request) {
            return guarded(async () => {
                originCheck(request);
                const url = new URL(request.url);
                if (request.method === 'GET' && url.pathname === '/manage')
                    return new Response(renderManagement(settings.brand), { headers: { 'content-type': 'text/html; charset=utf-8' } });
                if (request.method === 'GET' && url.pathname === '/assets/release.js')
                    return new Response(managementScript, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
                if (request.method === 'GET' && url.pathname === '/assets/release.css')
                    return new Response(managementStyles, { headers: { 'content-type': 'text/css; charset=utf-8' } });
                if (url.pathname === '/ready' || url.pathname.startsWith('/webhooks/') || url.pathname.startsWith('/scim/')) {
                    if (!await env.REQUEST_LIMITER.limit({ key: 'release-public:' + (request.headers.get('cf-connecting-ip') ?? 'local') }).then(x => x.success))
                        fail(429, 'rate_limited');
                    if (url.pathname === '/ready' && request.method === 'GET')
                        return ready();
                    if (url.pathname === '/webhooks/identity' && request.method === 'POST')
                        return admin.identityWebhook(request);
                    if (url.pathname === '/webhooks/stripe' && request.method === 'POST')
                        return billing.webhook(request);
                    const scim = /^\/scim\/v2\/([^/]+)\/Users(?:\/([^/]+))?$/.exec(url.pathname);
                    if (scim)
                        return admin.scim(request, id(scim[1]), scim[2] === undefined ? undefined : id(scim[2]));
                    return json({ error: 'not_found' }, 404);
                }
                return null;
            });
        },
        route(request, token) {
            return guarded(async () => {
                originCheck(request);
                const url = new URL(request.url), path = url.pathname, method = request.method;
                if (path === '/mcp')
                    return mcp(request, token, store, search, ingest, settings.brand.name);
                if (path === '/v1/spaces' && method === 'GET')
                    return json(await store.spaces(token, { limit: numberParam(url, 'limit', 50, 100), cursor: url.searchParams.get('cursor') }));
                if (path === '/v1/spaces' && method === 'POST')
                    return null; // Original SQL-authorized Space creation, no memory data operation.
                const space = /^\/v1\/spaces\/([^/]+)(?:\/(.*))?$/.exec(path);
                if (space) {
                    const s = id(space[1]), tail = space[2] ?? '';
                    if (tail === 'memories') {
                        if (method === 'POST') {
                            const input = await body(request, ['body', 'source', 'kind', 'provenance', 'eventTime', 'supersedesMemoryId', 'operationId']);
                            return json(await store.create(token, s, content(input), key(request, input)), 201);
                        }
                        if (method === 'GET') {
                            for (const field of url.searchParams.keys())
                                if (!['limit', 'cursor', 'query', 'deleted'].includes(field) || url.searchParams.getAll(field).length > 1)
                                    fail(400, 'invalid_query');
                            if (url.searchParams.has('query')) {
                                if (url.searchParams.has('cursor') || url.searchParams.has('deleted'))
                                    fail(400, 'invalid_query');
                                return json(await search.query(token, s, str(url.searchParams.get('query'), 1024), numberParam(url, 'limit', 10, 50)));
                            }
                            if (url.searchParams.has('deleted') && !['true', 'false'].includes(url.searchParams.get('deleted')!))
                                fail(400, 'invalid_query');
                            return json(await store.list(token, s, { limit: numberParam(url, 'limit', 25, 100), cursor: url.searchParams.get('cursor'), deleted: url.searchParams.get('deleted') === 'true' }));
                        }
                    }
                    const memory = /^memories\/([^/]+)(?:\/(restore|erase))?$/.exec(tail);
                    if (memory) {
                        const memoryId = id(memory[1]);
                        if (method === 'GET' && !memory[2])
                            return json(await store.get(token, s, memoryId));
                        if (method === 'PATCH' && !memory[2]) {
                            const input = await body(request, ['body', 'source', 'expectedRevision', 'operationId']);
                            return json(await store.update(token, s, memoryId, { body: str(input.body, 16384), ...(input.source !== undefined ? { source: input.source as string | null } : {}), expectedRevision: integer(input.expectedRevision, 1) }, key(request, input)));
                        }
                        if (method === 'DELETE' && !memory[2]) {
                            const input = await body(request, ['expectedRevision', 'operationId']);
                            await store.remove(token, s, memoryId, integer(input.expectedRevision, 1), key(request, input));
                            return json(null, 204);
                        }
                        if (method === 'POST' && memory[2] === 'restore') {
                            const input = await body(request, ['expectedRevision', 'operationId']);
                            return json(await store.restore(token, s, memoryId, integer(input.expectedRevision, 1), key(request, input)));
                        }
                        if (method === 'POST' && memory[2] === 'erase') {
                            const input = await body(request, ['expectedRevision', 'confirmation', 'operationId']);
                            return json(await store.erase(token, s, memoryId, integer(input.expectedRevision, 1), str(input.confirmation), key(request, input)));
                        }
                    }
                    if (tail === 'usage' && method === 'GET')
                        return json(await billing.usage(token, s));
                    if (tail === 'billing/checkout' && method === 'POST') {
                        const input = await body(request, ['priceId', 'operationId']);
                        return json(await billing.checkout(token, s, str(input.priceId, 128), key(request, input)));
                    }
                    if (tail === 'billing/portal' && method === 'POST')
                        return json(await billing.portal(token, s));
                    if (tail === 'retention' && method === 'PUT') {
                        const input = await body(request, ['days']);
                        await store.retention(token, s, integer(input.days, 1, 3650));
                        return json({ days: input.days });
                    }
                    if (tail === 'exports' && method === 'POST')
                        return json(await transfers.startExport(token, s), 201);
                    const exportRoute = /^exports\/([^/]+)$/.exec(tail);
                    if (exportRoute && method === 'GET')
                        return json(await transfers.exportPage(token, s, id(exportRoute[1]), url.searchParams.get('cursor') ?? undefined, numberParam(url, 'limit', 50, 50)));
                    if (tail === 'shares' && method === 'POST') {
                        const input = await body(request, ['email', 'days']);
                        return json(await transfers.share(token, s, str(input.email, 254), integer(input.days ?? 7, 1, 30)), 201);
                    }
                    const share = /^shares\/([^/]+)$/.exec(tail);
                    if (share && method === 'DELETE') {
                        await transfers.revoke(token, s, id(share[1]));
                        return json(null, 204);
                    }
                    if (tail === 'ingests' && method === 'POST') {
                        const input = await body(request, ['messages', 'operationId']);
                        return json(await ingest.submit(token, s, { messages: input.messages }, key(request, input)), 202);
                    }
                    if (tail === 'ingests' && method === 'GET') {
                        const actor = await requireSpace(db, token, s, 'read', clock());
                        const values = await rows(db, 'SELECT id,state,expires_at AS expiresAt FROM release_ingests WHERE account_id=? AND space_id=? ORDER BY created_at DESC,id LIMIT 50', [actor.accountId, s]);
                        await requireSpace(db, token, s, 'read', clock());
                        return json({ results: values });
                    }
                    const ingestion = /^ingests\/([^/]+)(?:\/(approve))?$/.exec(tail);
                    if (ingestion) {
                        const ingestId = id(ingestion[1]);
                        if (method === 'GET' && !ingestion[2])
                            return json(await ingest.get(token, s, ingestId));
                        if (method === 'POST' && ingestion[2]) {
                            const input = await body(request, ['selected', 'operationId']);
                            return json(await ingest.approve(token, s, ingestId, input.selected, key(request, input)));
                        }
                        if (method === 'DELETE' && !ingestion[2]) {
                            const actor = await interactive(db, token, clock()), hash = await tokenHash(token), at = clock();
                            await db.prepare(`UPDATE release_ingests SET ciphertext=NULL,proposals=NULL,state='cancelled' WHERE id=? AND space_id=? AND account_id=? AND state IN ('queued','review') AND EXISTS(SELECT 1 FROM spaces s CROSS JOIN active_credentials c WHERE s.id=release_ingests.space_id AND ${authority('create')})`).bind(ingestId, s, actor.accountId, ...params(hash, at, 'create')).run();
                            return json(null, 204);
                        }
                    }
                    if (tail === 'index/rebuild' && method === 'POST') {
                        await search.rebuild(token, s);
                        return json({ queued: true }, 202);
                    }
                    if (tail === 'jobs' && method === 'GET') {
                        await interactive(db, token, clock());
                        await requireSpace(db, token, s, 'update', clock());
                        const values = await rows(db, 'SELECT id,kind,state,attempt,last_error AS lastError,created_at AS createdAt FROM release_jobs WHERE space_id=? ORDER BY created_at DESC,id LIMIT 100', [s]);
                        await requireSpace(db, token, s, 'update', clock());
                        return json({ results: values });
                    }
                    const job = /^jobs\/([^/]+)\/retry$/.exec(tail);
                    if (job && method === 'POST') {
                        await interactive(db, token, clock(), true);
                        const hash = await tokenHash(token), at = clock();
                        const updated = await db.prepare(`UPDATE release_jobs SET state='pending',attempt=0,available_at=?,last_error=NULL WHERE id=? AND space_id=? AND state='dead' AND EXISTS(SELECT 1 FROM spaces s CROSS JOIN active_credentials c WHERE s.id=release_jobs.space_id AND ${authority('update')} AND ${recentSql()})`).bind(at, id(job[1]), s, ...params(hash, at, 'update'), at - 300000, at).run();
                        if (!updated.meta.changes)
                            fail(409, 'job_not_retryable');
                        return json({ queued: true }, 202);
                    }
                    return json({ error: 'not_found' }, 404); // Never fall through to legacy broad-permission memory routes.
                }
                if (path === '/v1/keys' && method === 'POST') {
                    const input = await body(request, ['label', 'organizationId', 'permission', 'capabilities', 'spaceIds', 'expiresInDays']);
                    if (input.permission !== undefined && !['read', 'write'].includes(String(input.permission)))
                        fail(400, 'invalid_permission');
                    const caps = input.capabilities ?? (input.permission === 'write' ? ['read', 'create', 'update', 'delete', 'export'] : ['read']);
                    return json(await admin.issueKey(token, { label: str(input.label, 100), organizationId: input.organizationId === undefined ? undefined : id(input.organizationId), capabilities: caps, spaceIds: input.spaceIds, expiresInDays: integer(input.expiresInDays, 1, 90) }), 201);
                }
                if (path === '/v1/release/config' && method === 'GET') {
                    await interactive(db, token, clock());
                    return json({ version: '0.4.0-rc.1', mode: 'managed', prices: billing.plans(), features: { semantic: Boolean(env.AI && env.MEMORY_INDEX), ingestion: Boolean(env.AI && env.PAYLOAD_KEY), mail: Boolean(env.EMAIL && env.MAIL_FROM), billing: Boolean(env.STRIPE_SECRET_KEY) }, policy: { sourceRetentionHours: 24, defaultTrashDays: 30, scim: 'deprovisioning-only' } });
                }
                if (path === '/v1/account/reauth' && method === 'POST') {
                    const input = await body(request, ['emailId']);
                    return json(await admin.startReauth(token, id(input.emailId)), 202);
                }
                if (path === '/v1/account/reauth/complete' && method === 'POST') {
                    const input = await body(request, ['challengeId', 'proof']);
                    await admin.completeReauth(token, id(input.challengeId), str(input.proof, 256));
                    return json({ reauthenticated: true });
                }
                if (path === '/v1/account/emails' && method === 'GET') {
                    await interactive(db, token, clock());
                    return json(await identity().getAccount(token));
                }
                if (path === '/v1/account/emails' && method === 'POST') {
                    await interactive(db, token, clock(), true);
                    const input = await body(request, ['email']);
                    const challengeId = await identity().beginEmailLink(token, str(input.email, 254), mail => admin.mail(token, mail.address, settings.brand.name + ' 이메일 확인', `Challenge: ${mail.challengeId}\nProof: ${mail.proofToken}\nExpires: ${new Date(mail.expiresAt).toISOString()}\n이 코드는 ${settings.brand.name} 관리 콘솔에서 직접 입력하세요.`, mail.challengeId));
                    return json({ challengeId }, 202);
                }
                if (path === '/v1/account/emails/verify' && method === 'POST') {
                    await interactive(db, token, clock(), true);
                    const input = await body(request, ['challengeId', 'proof']);
                    return json({ emailId: await identity().completeEmailLink(token, id(input.challengeId), str(input.proof, 256)) });
                }
                const email = /^\/v1\/account\/emails\/([^/]+)$/.exec(path);
                if (email && method === 'DELETE') {
                    await interactive(db, token, clock(), true);
                    await identity().unlinkEmail(token, id(email[1]));
                    return json(null, 204);
                }
                const domains = /^\/v1\/organizations\/([^/]+)\/domains$/.exec(path);
                if (domains && method === 'POST') {
                    const input = await body(request, ['domain']);
                    return json(await admin.beginDomain(token, id(domains[1]), str(input.domain, 253)), 201);
                }
                if (path === '/v1/domains/verify' && method === 'POST') {
                    const input = await body(request, ['challengeId']);
                    return json(await admin.verifyDomain(token, id(input.challengeId)));
                }
                const domain = /^\/v1\/domains\/([^/]+)\/(delegates|emails\/revoke)$/.exec(path);
                if (domain && method === 'POST') {
                    await interactive(db, token, clock(), true);
                    if (domain[2] === 'delegates') {
                        const input = await body(request, ['membershipId']);
                        await admin.delegateDomain(token, id(domain[1]), id(input.membershipId));
                    }
                    else {
                        const input = await body(request, ['email']);
                        await identity().revokeDomainEmail(token, id(domain[1]), str(input.email, 254));
                    }
                    return json({ completed: true });
                }
                const scimKey = /^\/v1\/organizations\/([^/]+)\/scim-keys(?:\/([^/]+))?$/.exec(path);
                if (scimKey) {
                    const org = id(scimKey[1]);
                    if (method === 'POST' && !scimKey[2])
                        return json(await admin.issueScimKey(token, org), 201);
                    if (method === 'DELETE' && scimKey[2]) {
                        await admin.orgAdmin(token, org);
                        const at = clock(), hash = await tokenHash(token);
                        await db.prepare(`UPDATE release_scim_keys SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id WHERE c.token_digest=? AND c.expires_at>? AND ${recentSql()} AND m.organization_id=release_scim_keys.organization_id AND m.role IN ('owner','admin') AND m.expires_at>?)`).bind(at, id(scimKey[2]), org, hash, at, at - 300000, at, at).run();
                        return json(null, 204);
                    }
                }
                if (path === '/v1/shares' && method === 'GET')
                    return json({ results: await transfers.invitations(token) });
                const acceptance = /^\/v1\/shares\/([^/]+)\/accept$/.exec(path);
                if (acceptance && method === 'POST') {
                    await transfers.accept(token, id(acceptance[1]));
                    return json({ accepted: true });
                }
                return null; // Existing organization/session/revocation routes remain original code.
            });
        },
        async signedIn(_principal, session, external) {
            if (!external)
                return;
            // app.ts invokes this hook only AFTER the original JWT verifier and the
            // issuer+subject sign-in transaction. This is NOT a standalone JWT verifier.
            const payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unbase64url(session.token.split('.')[1] ?? ''))));
            const scope = str(payload.scope, 1024);
            const caps = capabilitiesFromScopes(scope.split(/\s+/));
            if (!caps.length)
                fail(403, 'scope_denied');
            const at = clock();
            await db.prepare(`INSERT INTO release_credential_policies(credential_id,capabilities,space_ids,verified_oauth) SELECT c.id,?,NULL,1 FROM active_credentials c WHERE c.token_digest=? AND c.expires_at>? AND c.kind='session' AND c.id LIKE 'oauth:%' ON CONFLICT(credential_id) DO UPDATE SET capabilities=excluded.capabilities,verified_oauth=1 WHERE release_credential_policies.verified_oauth=0`).bind(canonical(caps), await tokenHash(session.token), at).run();
        },
        async scheduled() { await jobs.drain(5); await jobs.maintain(); await billing.reconcile(); await billing.drain(3); await db.prepare("INSERT INTO release_heartbeats(name,last_success_at) VALUES('maintenance',?) ON CONFLICT(name) DO UPDATE SET last_success_at=excluded.last_success_at").bind(clock()).run(); }
    };
}

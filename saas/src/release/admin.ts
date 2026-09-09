import type { Database, ReleaseEnv, Capability } from './types.ts';
import { INTERACTIVE, interactive, requireSpace, recentSql } from './authority.ts';
import { batch, body, canonical, capabilities, digest, equal, fail, hmac, id, integer, json, object, one, randomToken, readBytes, remoteJson, rows, stmt, str, tokenHash } from './util.ts';
const ISSUER = 'https://auth-api.allen.company';
function email(value: unknown): string { const s = str(value, 254).trim().toLowerCase(); if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+\.[a-z0-9-]+$/.test(s))
    fail(400, 'invalid_email'); return s; }
function domainName(value: unknown): string { const s = str(value, 253).trim().toLowerCase(); if (!s.includes('.') || !s.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)))
    fail(400, 'invalid_domain'); return s; }
function adminSql(): string { return `c.token_digest=? AND c.expires_at>? AND ${recentSql()} AND m.organization_id=? AND m.account_id=c.account_id AND m.expires_at>? AND m.role IN ('owner','admin')`; }
function adminValues(hash: string, at: number, org: string) { return [hash, at, at - 300000, at, org, at]; }
export class Admin {
    env: ReleaseEnv;
    db: Database;
    clock: () => number;
    fetcher: typeof fetch;
    constructor(env: ReleaseEnv, clock: () => number = Date.now) { this.env = env; this.db = env.DB; this.clock = clock; this.fetcher = env.fetch ?? globalThis.fetch; }
    async orgAdmin(token: string, org: string): Promise<{
        accountId: string;
        membershipId: string;
        credentialId: string;
    }> { const at = this.clock(), hash = await tokenHash(token); const row = await one<{
        accountId: string;
        membershipId: string;
        credentialId: string;
    }>(this.db, `SELECT c.account_id AS accountId,m.id AS membershipId,c.id AS credentialId FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id WHERE ${adminSql()}`, adminValues(hash, at, id(org))); if (!row)
        fail(403, 'organization_admin_required'); return row!; }
    async issueKey(token: string, input: {
        label: string;
        capabilities: unknown;
        spaceIds?: unknown;
        organizationId?: string;
        expiresInDays: number;
    }): Promise<{
        id: string;
        token: string;
        capabilities: Capability[];
        spaceIds: string[] | null;
        expiresAt: number;
    }> {
        const at = this.clock(), hash = await tokenHash(token), actor = await interactive(this.db, token, at, true), caps = capabilities(input.capabilities), label = str(input.label, 100), org = input.organizationId === undefined ? null : id(input.organizationId);
        integer(input.expiresInDays, 1, 90);
        if (input.spaceIds !== undefined && (!Array.isArray(input.spaceIds) || input.spaceIds.length === 0 || input.spaceIds.length > 50))
            fail(400, 'invalid_space_scope');
        const spaceIds = input.spaceIds === undefined ? null : [...new Set((input.spaceIds as unknown[]).map(id))];
        for (const s of spaceIds ?? []) {
            await requireSpace(this.db, token, s, caps.some(c => c !== 'read') ? 'update' : 'read', at);
            const row = await one<{
                organizationId: string | null;
            }>(this.db, 'SELECT organization_id AS organizationId FROM spaces WHERE id=?', [s]);
            if (row?.organizationId !== org)
                fail(403, 'scope_tenant_mismatch');
        }
        if (org)
            await this.orgAdmin(token, org);
        const keyId = 'key:' + crypto.randomUUID(), raw = 'mem_' + randomToken(), expiresAt = at + input.expiresInDays * 86400000;
        const granted = caps.some(c => c !== 'read') ? 'write' : 'read';
        await batch(this.db, [
            stmt(this.db, `INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission)
    SELECT ?,c.account_id,m.id,m.email_id,CASE WHEN ? IS NULL THEN 'personal_key' ELSE 'api_key' END,?,?,? FROM active_credentials c LEFT JOIN active_memberships m ON m.account_id=c.account_id AND m.organization_id=?
    WHERE c.token_digest=? AND c.expires_at>? AND ${recentSql()} AND (? IS NULL OR (m.id IS NOT NULL AND m.expires_at>? AND m.role IN ('owner','admin')))
    AND (SELECT count(*) FROM credentials k WHERE k.account_id=c.account_id AND k.kind<>'session' AND k.revoked_at IS NULL AND k.expires_at>?)<100`, [keyId, org, await tokenHash(raw), expiresAt, granted, org, hash, at, at - 300000, at, org, at, at]),
            stmt(this.db, 'INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) SELECT id,?,? FROM credentials WHERE id=?', [canonical(caps), spaceIds ? canonical(spaceIds) : null, keyId]),
            stmt(this.db, 'INSERT INTO workspace_key_metadata(credential_id,label,actor_credential_id,created_at) SELECT id,?,?,? FROM credentials WHERE id=?', [label, actor.id, at, keyId]),
            stmt(this.db, "INSERT INTO release_events(action,actor_credential_id,resource_id,created_at) SELECT 'scoped_key_issued',?,?,? FROM credentials WHERE id=?", [actor.id, keyId, at, keyId])
        ]);
        if (!await one(this.db, 'SELECT id FROM credentials WHERE id=?', [keyId]))
            fail(403, 'key_limit_or_authority');
        await interactive(this.db, token, this.clock(), true);
        return { id: keyId, token: raw, capabilities: caps, spaceIds, expiresAt };
    }
    async mail(token: string, to: string, subject: string, text: string, _key: string): Promise<void> {
        if (!this.env.EMAIL || !this.env.MAIL_FROM)
            fail(503, 'mail_not_configured');
        const displayName = str(this.env.PRODUCT_NAME ?? 'Memory by Allen Labs', 80);
        const message = { from: email(this.env.MAIL_FROM), to: email(to),
            subject: str(subject.replace(/^Memory: /, () => displayName + ': '), 256),
            text: str(text.replaceAll('Memory 관리 화면', () => displayName + ' 관리 화면'), 8192) };
        const actor = await interactive(this.db, token, this.clock());
        try {
            await this.db.prepare('INSERT INTO release_mail_budget(account_id,day,quantity) VALUES(?,?,1) ON CONFLICT(account_id,day) DO UPDATE SET quantity=quantity+1').bind(actor.accountId, new Date(this.clock()).toISOString().slice(0, 10)).run();
        }
        catch {
            fail(429, 'daily_email_limit');
        }
        // Cloudflare's native send API has no documented idempotency contract or
        // cancellation signal. An uncertain send is never retried here. Callers
        // invalidate the proof on failure, even if delivery later completes.
        let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => { timedOut = true; reject(new Error('send_timeout')); }, 10000);
            });
            const result = await Promise.race([this.env.EMAIL.send(message), timeout]);
            if (!result || typeof result.messageId !== 'string' || !result.messageId)
                throw new Error('invalid_send_result');
        } catch {
            fail(timedOut ? 504 : 502, timedOut ? 'mail_delivery_timeout' : 'mail_delivery_failed');
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
        await interactive(this.db, token, this.clock());
    }
    async startReauth(token: string, emailId: string): Promise<{
        id: string;
        expiresAt: number;
    }> {
        const at = this.clock(), hash = await tokenHash(token), actor = await interactive(this.db, token, at), challengeId = crypto.randomUUID(), proof = randomToken();
        const address = await one<{
            address: string;
        }>(this.db, 'SELECT address FROM account_emails WHERE id=? AND account_id=? AND revoked_at IS NULL', [id(emailId), actor.accountId]);
        if (!address)
            fail(403, 'email_unavailable');
        const r = await this.db.prepare(`INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at)
   SELECT ?,c.id,e.id,?,? FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id WHERE c.token_digest=? AND c.expires_at>? AND ${INTERACTIVE} AND e.id=? AND e.revoked_at IS NULL`).bind(challengeId, await tokenHash(proof), at + 600000, hash, at, emailId).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'access_denied');
        try {
            await this.mail(token, address!.address, 'Memory: 추가 본인 확인', `본인이 요청한 경우에만 Memory 관리 화면에 아래 증명을 입력하세요.\nChallenge: ${challengeId}\nProof: ${proof}\n10분 후 만료되며 이 브라우저 로그인에만 사용할 수 있습니다.`, challengeId);
        }
        catch (e) {
            await this.db.prepare('DELETE FROM release_reauth_challenges WHERE id=?').bind(challengeId).run();
            throw e;
        }
        return { id: challengeId, expiresAt: at + 600000 };
    }
    async completeReauth(token: string, challengeId: string, proof: string): Promise<void> {
        const at = this.clock(), hash = await tokenHash(token);
        await interactive(this.db, token, at);
        // A mistyped proof is not a failed session credential. Keep it retryable
        // without making the console discard the valid browser session.
        const proofHash = await digest(str(proof, 256));
        // UPDATE RETURNING consumes the proof exactly once. The credential update is
        // part of the same batch and only sees that consumption's unique timestamp
        // and a per-attempt marker (token digest is replaced by a random digest).
        const marker = await digest(randomToken());
        await batch(this.db, [
            stmt(this.db, `UPDATE release_reauth_challenges SET used_at=?,token_digest=? WHERE id=? AND token_digest=? AND used_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id WHERE c.id=release_reauth_challenges.credential_id AND e.id=release_reauth_challenges.email_id AND e.revoked_at IS NULL AND c.token_digest=? AND c.expires_at>? AND ${INTERACTIVE})`, [at, marker, id(challengeId), proofHash, at, hash, at]),
            stmt(this.db, `UPDATE credentials SET reauthenticated_at=? WHERE token_digest=? AND id=(SELECT credential_id FROM release_reauth_challenges WHERE id=? AND token_digest=? AND used_at=?)`, [at, hash, challengeId, marker, at])
        ]);
        if (!await one(this.db, 'SELECT id FROM release_reauth_challenges WHERE id=? AND token_digest=?', [challengeId, marker]))
            fail(403, 'reauthentication_failed');
    }
    async beginDomain(token: string, org: string, domain: string): Promise<{
        id: string;
        name: string;
        type: string;
        value: string;
        expiresAt: number;
    }> {
        const actor = await this.orgAdmin(token, org), at = this.clock(), hash = await tokenHash(token), d = domainName(domain), challengeId = crypto.randomUUID(), proof = 'memory-verification=' + randomToken();
        const r = await this.db.prepare(`INSERT INTO release_domain_challenges(id,organization_id,actor_account_id,domain,proof,expires_at)
   SELECT ?,m.organization_id,c.account_id,?,?,? FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id WHERE ${adminSql()}`).bind(challengeId, d, proof, at + 3600000, ...adminValues(hash, at, org)).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'access_denied');
        return { id: challengeId, name: '_memory-verification.' + d, type: 'TXT', value: proof, expiresAt: at + 3600000 };
    }
    async verifyDomain(token: string, challengeId: string): Promise<{
        id: string;
        name: string;
        verifiedUntil: number;
    }> {
        const actor = await interactive(this.db, token, this.clock(), true), challenge = await one<{
            organizationId: string;
            domain: string;
            proof: string;
        }>(this.db, 'SELECT organization_id AS organizationId,domain,proof FROM release_domain_challenges WHERE id=? AND actor_account_id=? AND expires_at>? AND used_at IS NULL', [id(challengeId), actor.accountId, this.clock()]);
        if (!challenge)
            fail(403, 'domain_challenge_unavailable');
        const name = '_memory-verification.' + challenge!.domain;
        const dns = await remoteJson(this.fetcher, 'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=TXT', { headers: { accept: 'application/dns-json' } }, 16384);
        const found = dns.Status === 0 && Array.isArray(dns.Answer) && dns.Answer.some(v => { const answer = object(v); if (answer.type !== 16 || String(answer.name).replace(/\.$/, '') !== name || typeof answer.data !== 'string')
            return false; try {
            return (answer.data.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map(s => JSON.parse(s)).join('') === challenge!.proof;
        }
        catch {
            return false;
        } });
        if (!found)
            fail(409, 'dns_proof_missing');
        const at = this.clock(), hash = await tokenHash(token), org = challenge!.organizationId;
        await this.orgAdmin(token, org);
        const existing = await one<{
            id: string;
            organizationId: string;
            revokedAt: number | null;
        }>(this.db, 'SELECT id,organization_id AS organizationId,revoked_at AS revokedAt FROM domains WHERE name=? AND revoked_at IS NULL', [challenge!.domain]);
        if (existing && existing.organizationId !== org)
            fail(409, 'domain_already_claimed');
        const domainId = existing?.id ?? crypto.randomUUID(), verification = crypto.randomUUID(), until = at + 30 * 86400000;
        await batch(this.db, [
            stmt(this.db, `UPDATE release_domain_challenges SET used_at=?,verification_id=? WHERE id=? AND actor_account_id=? AND used_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id WHERE ${adminSql()})`, [at, verification, challengeId, actor.accountId, at, ...adminValues(hash, at, org)]),
            ...(existing ? [stmt(this.db, 'UPDATE domains SET verified_until=? WHERE id=? AND EXISTS(SELECT 1 FROM release_domain_challenges WHERE verification_id=?)', [until, domainId, verification])] : [stmt(this.db, 'INSERT INTO domains(id,organization_id,name,verified_until) SELECT ?,organization_id,domain,? FROM release_domain_challenges WHERE verification_id=?', [domainId, until, verification])]),
            stmt(this.db, `INSERT INTO domain_managers(domain_id,membership_id) SELECT ?,m.id FROM active_memberships m WHERE m.organization_id=? AND m.account_id=? AND m.expires_at>? AND m.role IN ('owner','admin') AND EXISTS(SELECT 1 FROM release_domain_challenges WHERE verification_id=?) AND NOT EXISTS(SELECT 1 FROM domain_managers g WHERE g.domain_id=? AND g.membership_id=m.id)`, [domainId, org, actor.accountId, at, verification, domainId])
        ]);
        if (!await one(this.db, 'SELECT id FROM release_domain_challenges WHERE verification_id=?', [verification]))
            fail(403, 'access_denied');
        return { id: domainId, name: challenge!.domain, verifiedUntil: until };
    }
    async delegateDomain(token: string, domainId: string, membershipId: string): Promise<void> {
        const at = this.clock(), hash = await tokenHash(token);
        await interactive(this.db, token, at, true);
        const r = await this.db.prepare(`INSERT INTO domain_managers(domain_id,membership_id)
   SELECT d.id,target.id FROM domains d JOIN active_memberships own ON own.organization_id=d.organization_id JOIN domain_managers manager ON manager.domain_id=d.id AND manager.membership_id=own.id AND manager.revoked_at IS NULL
   JOIN active_credentials c ON c.account_id=own.account_id JOIN active_memberships target ON target.organization_id=d.organization_id
   WHERE d.id=? AND target.id=? AND d.revoked_at IS NULL AND d.verified_until>? AND own.expires_at>? AND target.expires_at>? AND own.role IN ('owner','admin') AND target.role IN ('owner','admin') AND c.token_digest=? AND c.expires_at>? AND ${recentSql()}`).bind(id(domainId), id(membershipId), at, at, at, hash, at, at - 300000, at).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'domain_delegation_denied');
    }
    async identityWebhook(request: Request): Promise<Response> {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(request, 65536)), timestamp = request.headers.get('x-memory-timestamp') ?? '', sig = request.headers.get('x-memory-signature') ?? '';
        if (!/^\d{10}$/.test(timestamp) || Math.abs(this.clock() / 1000 - Number(timestamp)) > 300 || !equal(await hmac(this.env.IDENTITY_WEBHOOK_SECRET ?? '', timestamp + '.' + raw), sig))
            fail(401, 'invalid_signature');
        const event = object(JSON.parse(raw));
        const eventId = id(event.id), subject = str(event.subject, 512), kind = str(event.type, 64);
        if (event.issuer !== ISSUER || !['email.revoked', 'account.disabled'].includes(kind))
            fail(400, 'unsupported_identity_event');
        const hash = await digest(raw);
        const existing = await one<{
            hash: string;
        }>(this.db, "SELECT body_hash AS hash FROM release_webhook_events WHERE provider='identity' AND event_id=?", [eventId]);
        if (existing) {
            if (existing.hash !== hash)
                fail(409, 'webhook_conflict');
            return json({ received: true, replayed: true });
        }
        const at = this.clock();
        const revokedAddress = kind === 'email.revoked' ? email(event.email) : '';
        const statements = [stmt(this.db, "INSERT INTO release_webhook_events(provider,event_id,body_hash,created_at) VALUES('identity',?,?,?)", [eventId, hash, at]),
            stmt(this.db, 'INSERT INTO release_provider_revocations(issuer,subject,kind,address,created_at) VALUES(?,?,?,?,?) ON CONFLICT(issuer,subject,kind,address) DO NOTHING', [ISSUER,subject,kind,revokedAddress,at])];
        // Resolve the mapping in the same atomic batch as the receipt and
        // tombstone. A first sign-in may have committed since this request began.
        if (kind === 'account.disabled') {
            statements.push(stmt(this.db, `UPDATE accounts SET disabled_at=? WHERE disabled_at IS NULL
                AND id IN (SELECT account_id FROM provider_identities WHERE issuer=? AND subject=?)`, [at, ISSUER, subject]));
        } else {
            statements.push(
                stmt(this.db, `INSERT INTO release_external_email_blocks(account_id,address,created_at)
                    SELECT account_id,?,? FROM provider_identities WHERE issuer=? AND subject=?
                    ON CONFLICT(account_id,address) DO NOTHING`, [revokedAddress, at, ISSUER, subject]),
                stmt(this.db, `UPDATE account_emails SET revoked_at=? WHERE address=? AND revoked_at IS NULL
                    AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=? AND subject=?)`, [at, revokedAddress, ISSUER, subject])
            );
        }
        try {
            await batch(this.db, statements);
        }
        catch (error) {
            const accepted = await one<{
                hash: string;
            }>(this.db, "SELECT body_hash AS hash FROM release_webhook_events WHERE provider='identity' AND event_id=?", [eventId]);
            if (!accepted)
                throw error;
            if (accepted.hash !== hash)
                fail(409, 'webhook_conflict');
        }
        return json({ received: true });
    }
    async issueScimKey(token: string, org: string): Promise<{
        id: string;
        token: string;
        expiresAt: number;
    }> {
        const actor = await this.orgAdmin(token, org), raw = 'scim_' + randomToken(), keyId = crypto.randomUUID(), at = this.clock(), hash = await tokenHash(token);
        const r = await this.db.prepare(`INSERT INTO release_scim_keys
            (id,organization_id,token_digest,creator_credential_id,expires_at,creator_membership_id,creator_email_id,created_at)
   SELECT ?,m.organization_id,?,c.id,?,m.id,m.email_id,? FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id WHERE ${adminSql()}`).bind(keyId, await tokenHash(raw), at + 30 * 86400000, at, ...adminValues(hash, at, org)).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'access_denied');
        return { id: keyId, token: raw, expiresAt: at + 30 * 86400000 };
    }
    async scimAuthority(token: string, org: string): Promise<void> {
        const at = this.clock(), hash = await tokenHash(token);
        if (!await one(this.db, `SELECT k.id FROM release_scim_keys k JOIN credentials issuer ON issuer.id=k.creator_credential_id
            JOIN active_memberships m ON m.id=k.creator_membership_id AND m.account_id=issuer.account_id
                AND m.email_id=k.creator_email_id AND m.organization_id=k.organization_id
            WHERE k.token_digest=? AND k.organization_id=? AND k.revoked_at IS NULL AND k.expires_at>?
                AND m.expires_at>? AND m.role IN ('owner','admin')`, [hash, id(org), at, at]))
            fail(401, 'scim_unauthorized');
    }
    async scimDeactivate(token: string, org: string, membershipId: string): Promise<void> {
        await this.scimAuthority(token, org);
        const at = this.clock(), hash = await tokenHash(token);
        const result = await this.db.prepare(`UPDATE memberships SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL
            AND EXISTS(SELECT 1 FROM release_scim_keys k JOIN credentials issuer ON issuer.id=k.creator_credential_id
                JOIN active_memberships admin ON admin.id=k.creator_membership_id AND admin.account_id=issuer.account_id
                    AND admin.email_id=k.creator_email_id AND admin.organization_id=k.organization_id
                WHERE k.token_digest=? AND k.organization_id=memberships.organization_id AND k.revoked_at IS NULL AND k.expires_at>?
                    AND admin.expires_at>? AND admin.role IN ('owner','admin')
                    AND (memberships.role<>'owner' OR (admin.role='owner' AND EXISTS(
                        SELECT 1 FROM active_memberships other WHERE other.organization_id=memberships.organization_id
                            AND other.role='owner' AND other.expires_at>? AND other.id<>memberships.id))))`)
            .bind(at, id(membershipId), id(org), hash, at, at, at).run();
        if (!result.success)
            fail(503, 'database_unavailable');
        if (!result.meta.changes) {
            // A repeated deactivation of the same already-revoked member is
            // idempotent. Live owner/authority denials must not look successful.
            const target = await one<{ revokedAt: number | null }>(this.db,
                'SELECT revoked_at AS revokedAt FROM memberships WHERE id=? AND organization_id=?', [membershipId, org]);
            if (!target || target.revokedAt === null)
                fail(403, 'membership_deactivation_denied');
        }
    }
    async scim(request: Request, org: string, membershipId?: string): Promise<Response> {
        const bearer = /^Bearer ([^\s,]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
        if (!bearer)
            fail(401, 'scim_unauthorized');
        await this.scimAuthority(bearer, org);
        const url = new URL(request.url);
        if (request.method === 'GET') {
            const start = membershipId ? 1 : integer(Number(url.searchParams.get('startIndex') ?? 1), 1), count = membershipId ? 1 : integer(Number(url.searchParams.get('count') ?? 100), 0, 200);
            if (url.searchParams.has('filter'))
                fail(400, 'scim_filter_not_supported');
            const values = await rows<{
                id: string;
                userName: string;
                active: number;
            }>(this.db, `SELECT m.id,e.address AS userName,EXISTS(SELECT 1 FROM active_memberships live WHERE live.id=m.id AND live.expires_at>?) AS active FROM memberships m JOIN account_emails e ON e.id=m.email_id WHERE m.organization_id=? ${membershipId ? 'AND m.id=?' : ''} ORDER BY m.id LIMIT ? OFFSET ?`, [this.clock(), org, ...(membershipId ? [id(membershipId)] : []), count, start - 1]);
            const resources = values.map(v => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: v.id, userName: v.userName, active: Boolean(v.active) }));
            if (membershipId) {
                await this.scimAuthority(bearer, org);
                if (!resources[0])
                    fail(404, 'scim_user_not_found');
                return json(resources[0], 200, { 'content-type': 'application/scim+json; charset=utf-8' });
            }
            const total = await one<{
                n: number;
            }>(this.db, 'SELECT count(*) AS n FROM memberships WHERE organization_id=?', [org]);
            await this.scimAuthority(bearer, org);
            return json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: total?.n ?? 0, startIndex: start, itemsPerPage: resources.length, Resources: resources }, 200, { 'content-type': 'application/scim+json; charset=utf-8' });
        }
        if (!membershipId)
            fail(405, 'deprovisioning_only');
        if (request.method === 'PATCH') {
            const input = await body(request, ['schemas', 'Operations'], 65536, ['application/json', 'application/scim+json']);
            if (input.schemas !== undefined && (!Array.isArray(input.schemas) || input.schemas.length !== 1 || input.schemas[0] !== 'urn:ietf:params:scim:api:messages:2.0:PatchOp'))
                fail(400, 'unsupported_scim_patch');
            if (!Array.isArray(input.Operations) || input.Operations.length !== 1)
                fail(400, 'unsupported_scim_patch');
            const op = object(input.Operations[0]);
            if (Object.keys(op).some(k => !['op', 'path', 'value'].includes(k)) || String(op.op).toLowerCase() !== 'replace' ||
                !((typeof op.path === 'string' && op.path.toLowerCase() === 'active' && op.value === false) ||
                    (op.path === undefined && object(op.value).active === false && Object.keys(object(op.value)).length === 1)))
                fail(400, 'unsupported_scim_patch');
        }
        else if (request.method !== 'DELETE')
            fail(405, 'deprovisioning_only');
        await this.scimDeactivate(bearer, org, membershipId);
        return json(null, 204);
    }
}

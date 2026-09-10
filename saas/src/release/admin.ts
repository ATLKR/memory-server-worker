import { sqlNow } from '../sql-clock.ts';
import type { Database, ReleaseEnv, Capability } from './types.ts';
import { readSettings } from '../config.ts';
import { requireMethod } from '../api.ts';
import { canonicalEmail, IdentityInvalid } from '../identity.ts';
import { INTERACTIVE, interactive, requireSpace, recentSql, acceptedShareAuthority } from './authority.ts';
import { batch, canonical, capabilities, digest, equal, fail, hmac, id, integer, json, object, one, randomToken, readBytes, remoteJson, requestObject, requestText, rows, stmt, str, tokenHash } from './util.ts';
const ISSUER = 'https://auth-api.allen.company';
const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
function scimObject(value: unknown, allowed: string[]): Record<string, unknown> {
    const normalized: Record<string, unknown> = Object.create(null);
    for (const [key, content] of Object.entries(object(value))) {
        const name = key.toLowerCase();
        if (!allowed.includes(name) || Object.hasOwn(normalized, name)) fail(400, 'unsupported_scim_patch');
        normalized[name] = content;
    }
    return normalized;
}
async function scimBody(request: Request): Promise<Record<string, unknown>> {
    if (!['application/json', 'application/scim+json'].includes(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''))
        fail(415, 'json_required');
    const bytes = await readBytes(request, 65536);
    let raw: string, parsed: unknown;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); parsed = JSON.parse(raw); }
    catch { return fail(400, 'invalid_json'); }
    // JSON.parse validates syntax but discards exact/escaped duplicate keys.
    // Scan its valid token stream first so every object has unique SCIM names,
    // including spellings such as "op" and "\\u006fp". Values are untouched.
    const frames: { object: boolean; key: boolean; names: Set<string> }[] = [];
    for (const [token] of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
        if (token === '{' || token === '[') frames.push({ object: token === '{', key: true, names: new Set() });
        else if (token === '}' || token === ']') frames.pop();
        else {
            const frame = frames.at(-1);
            if (frame?.object && token === ',') frame.key = true;
            else if (frame?.object && frame.key && token.startsWith('"')) {
                const name = (JSON.parse(token) as string).toLowerCase();
                if (frame.names.has(name)) fail(400, 'duplicate_scim_attribute');
                frame.names.add(name); frame.key = false;
            }
        }
    }
    return scimObject(parsed, ['schemas', 'operations']);
}
type ScimUser = { id: string; userName: string; active: number };
function scimVisible(alias: 'm' | 'memberships' | 'target'): string {
    // Membership history is retained and cannot be deleted or replaced. The
    // latest insertion owns this SCIM username; a deleted successor must still
    // suppress its predecessors, without transferring any credential authority.
    return `NOT EXISTS(SELECT 1 FROM release_scim_deletions deleted WHERE deleted.membership_id=${alias}.id)
        AND NOT EXISTS(SELECT 1 FROM memberships newer JOIN account_emails newer_email ON newer_email.id=newer.email_id
            WHERE newer.organization_id=${alias}.organization_id AND newer.rowid>${alias}.rowid
              AND newer_email.address=(SELECT address FROM account_emails WHERE id=${alias}.email_id))`;
}
function scimPage(url: URL, name: 'startIndex' | 'count', fallback: number): number {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (url.searchParams.getAll(name).length !== 1 || !/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        fail(400, 'invalid_' + name);
    return name === 'startIndex' ? Math.max(1, Number(raw)) : Math.max(0, Math.min(200, Number(raw)));
}
function scimProjection(url: URL): (value: ScimUser) => Record<string, unknown> {
    const include = url.searchParams.has('attributes'), exclude = url.searchParams.has('excludedAttributes');
    if (include && exclude) fail(400, 'conflicting_attribute_selection');
    const name = include ? 'attributes' : 'excludedAttributes';
    let selected: Set<string> | null = null;
    if (include || exclude) {
        if (url.searchParams.getAll(name).length !== 1) fail(400, 'invalid_attribute_selection');
        const attributes = str(url.searchParams.get(name), 2048).split(',').map(value => value.trim().toLowerCase());
        if (attributes.some(value => !/^(?:urn:[^\s,]+:)?[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(value)))
            fail(400, 'invalid_attribute_selection');
        const prefix = SCIM_USER_SCHEMA.toLowerCase() + ':';
        selected = new Set(attributes.map(value => value.startsWith(prefix) ? value.slice(prefix.length) : value));
    }
    return value => {
        const result: Record<string, unknown> = { schemas: [SCIM_USER_SCHEMA], id: value.id };
        for (const [field, content] of Object.entries({ userName: value.userName, active: Boolean(value.active) }))
            if (!selected || (include ? selected.has(field.toLowerCase()) : !selected.has(field.toLowerCase()))) result[field] = content;
        return result;
    };
}
function email(value: unknown): string {
    try { return canonicalEmail(str(value, 254)).address; }
    catch (error) { if (error instanceof IdentityInvalid) fail(400, 'invalid_email'); throw error; }
}
function domainName(value: unknown): string { const s = str(value, 253).trim().toLowerCase(); if (!s.includes('.') || !s.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)))
    fail(400, 'invalid_domain'); return s; }
function adminSql(): string { return `c.token_digest=? AND c.expires_at>${sqlNow()} AND ${recentSql()} AND m.organization_id=? AND m.account_id=c.account_id AND m.expires_at>${sqlNow()} AND m.role IN ('owner','admin')`; }
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
    }> { const hash = await tokenHash(token), at = this.clock(); const row = await one<{
        accountId: string;
        membershipId: string;
        credentialId: string;
        credentialExpiresAt: number;
        membershipExpiresAt: number;
        reauthenticatedAt: number;
    }>(this.db, `SELECT c.account_id AS accountId,m.id AS membershipId,c.id AS credentialId,
        c.expires_at AS credentialExpiresAt,m.expires_at AS membershipExpiresAt,c.reauthenticated_at AS reauthenticatedAt
        FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id WHERE ${adminSql()}`, adminValues(hash, at, id(org)));
        const checkedAt = this.clock();
        if (!row || Math.min(row.credentialExpiresAt, row.membershipExpiresAt) <= checkedAt ||
            row.reauthenticatedAt < checkedAt - 300000 || row.reauthenticatedAt > checkedAt)
            fail(403, 'organization_admin_required');
        return { accountId: row.accountId, membershipId: row.membershipId, credentialId: row.credentialId }; }
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
        const hash = await tokenHash(token), actor = await interactive(this.db, token, this.clock, true), caps = capabilities(input.capabilities), label = str(input.label, 100), org = input.organizationId === undefined ? null : id(input.organizationId);
        const granted = caps.some(c => c !== 'read') ? 'write' : 'read';
        integer(input.expiresInDays, 1, 90);
        if (input.spaceIds !== undefined && (!Array.isArray(input.spaceIds) || input.spaceIds.length === 0 || input.spaceIds.length > 50))
            fail(400, 'invalid_space_scope');
        const spaceIds = input.spaceIds === undefined ? null : [...new Set((input.spaceIds as unknown[]).map(id))];
        for (const s of spaceIds ?? []) {
            await requireSpace(this.db, token, s, granted === 'write' ? 'update' : 'read', this.clock);
            const row = await one<{
                organizationId: string | null;
            }>(this.db, 'SELECT organization_id AS organizationId FROM spaces WHERE id=?', [s]);
            if (row?.organizationId !== org) {
                const at = this.clock();
                // Personal read keys can select a separately accepted share.
                // Organization membership alone never satisfies this exception.
                if (org !== null || granted !== 'read' || !await one(this.db,
                    `SELECT s.id FROM spaces s CROSS JOIN active_credentials c WHERE s.id=?
                      AND c.token_digest=? AND c.expires_at>${sqlNow()} AND ${acceptedShareAuthority()}`,
                    [s, hash, at, at, at]))
                    fail(403, 'scope_tenant_mismatch');
            }
        }
        if (org && granted === 'write')
            await this.orgAdmin(token, org);
        const keyId = 'key:' + crypto.randomUUID(), raw = 'mem_' + randomToken(), keyHash = await tokenHash(raw);
        const at = this.clock(), expiresAt = at + input.expiresInDays * 86400000;
        await batch(this.db, [
            stmt(this.db, `INSERT INTO credentials(id,account_id,membership_id,email_id,kind,token_digest,expires_at,permission)
    SELECT ?,c.account_id,m.id,m.email_id,CASE WHEN ? IS NULL THEN 'personal_key' ELSE 'api_key' END,?,?,? FROM active_credentials c
    LEFT JOIN memberships m ON m.id=(SELECT candidate.id FROM active_memberships candidate WHERE candidate.account_id=c.account_id AND candidate.organization_id=?)
    WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${recentSql()} AND (? IS NULL OR (m.id IS NOT NULL AND m.expires_at>${sqlNow()} AND (?='read' OR m.role IN ('owner','admin'))))
    AND (SELECT count(*) FROM credentials k WHERE k.account_id=c.account_id AND k.kind<>'session' AND k.revoked_at IS NULL AND k.expires_at>${sqlNow()})<100`, [keyId, org, keyHash, expiresAt, granted, org, hash, at, at - 300000, at, org, at, granted, at]),
            stmt(this.db, 'INSERT INTO release_credential_policies(credential_id,capabilities,space_ids) SELECT id,?,? FROM credentials WHERE id=?', [canonical(caps), spaceIds ? canonical(spaceIds) : null, keyId]),
            stmt(this.db, 'INSERT INTO workspace_key_metadata(credential_id,label,actor_credential_id,created_at) SELECT id,?,?,? FROM credentials WHERE id=?', [label, actor.id, at, keyId]),
            stmt(this.db, "INSERT INTO release_events(action,actor_credential_id,resource_id,created_at) SELECT 'scoped_key_issued',?,?,? FROM credentials WHERE id=?", [actor.id, keyId, at, keyId])
        ]);
        if (!await one(this.db, 'SELECT id FROM credentials WHERE id=?', [keyId]))
            fail(403, 'key_limit_or_authority');
        await interactive(this.db, token, this.clock, true);
        return { id: keyId, token: raw, capabilities: caps, spaceIds, expiresAt };
    }
    private mailPredicate(hash: string, at: number, recipient: string, challengeId: string, recent: boolean) {
        return { sql: `FROM active_credentials c JOIN ${recent ? 'email_challenges' : 'release_reauth_challenges'} p
              ON ${recent ? 'p.account_id=c.account_id' : 'p.credential_id=c.id'}
            ${recent ? '' : 'JOIN account_emails e ON e.id=p.email_id AND e.account_id=c.account_id AND e.revoked_at IS NULL'}
            WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND c.membership_expires_at>${sqlNow()} AND ${INTERACTIVE} AND c.permission='write'
              AND p.id=? AND p.used_at IS NULL AND p.expires_at>${sqlNow()}
              AND ${recent ? 'p.address=? AND p.invalidated_at IS NULL' : 'e.address=?'}
              AND NOT EXISTS(SELECT 1 FROM email_blocks b WHERE b.address=?)
              AND NOT EXISTS(SELECT 1 FROM release_external_email_blocks b WHERE b.account_id=c.account_id AND b.address=?)
              ${recent ? `AND NOT EXISTS(SELECT 1 FROM account_emails claimed WHERE claimed.address=p.address AND claimed.revoked_at IS NULL) AND ${recentSql()}` : ''}`,
            values: [hash, at, at, id(challengeId), at, recipient, recipient, recipient, ...(recent ? [at - 300000, at] : [])] };
    }
    private async mailAuthority(token: string, recipient: string, challengeId: string, kind: 'reauth' | 'email_link'): Promise<void> {
        const hash = await tokenHash(token), at = this.clock(), recent = kind === 'email_link';
        // Session, exact proof and destination share one final primary snapshot.
        // Compare expiry facts after the read; no asynchronous work precedes send.
        const predicate = this.mailPredicate(hash, at, recipient, challengeId, recent);
        const proof = await one<{ expiresAt: number; reauthenticatedAt: number }>(this.db, `
            SELECT min(c.expires_at,c.membership_expires_at,p.expires_at) AS expiresAt,c.reauthenticated_at AS reauthenticatedAt
            ${predicate.sql}`, predicate.values);
        const checkedAt = this.clock();
        if (!proof || proof.expiresAt <= checkedAt || (recent &&
            (proof.reauthenticatedAt < checkedAt - 300000 || proof.reauthenticatedAt > checkedAt)))
            fail(403, 'email_proof_unavailable');
    }
    async mail(token: string, to: string, subject: string, text: string, challengeId: string, kind: 'reauth' | 'email_link' = 'reauth'): Promise<void> {
        if (!this.env.EMAIL || !this.env.MAIL_FROM)
            fail(503, 'mail_not_configured');
        const message = { from: email(this.env.MAIL_FROM), to: email(to),
            // The configuration allows 80 UTF-16 code units, up to 240 UTF-8
            // bytes. Leave bounded room for the translated subject suffix.
            subject: str(subject, 512),
            text: str(text, 8192) };
        await interactive(this.db, token, this.clock, kind === 'email_link');
        const hash = await tokenHash(token), at = this.clock(), predicate = this.mailPredicate(hash, at, message.to, challengeId, kind === 'email_link');
        let charged = false;
        try {
            const result = await this.db.prepare(`INSERT INTO release_mail_budget(account_id,day,quantity)
                SELECT c.account_id,strftime('%Y-%m-%d',${sqlNow()}/1000.0,'unixepoch'),1 ${predicate.sql}
                ON CONFLICT(account_id,day) DO UPDATE SET quantity=quantity+1`).bind(at, ...predicate.values).run();
            charged = result.success && !!result.meta.changes;
        }
        catch {
            fail(429, 'daily_email_limit');
        }
        if (!charged) fail(403, 'email_proof_unavailable');
        await this.mailAuthority(token, message.to, challengeId, kind);
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
        await this.mailAuthority(token, message.to, challengeId, kind);
    }
    async startReauth(token: string, emailId: string): Promise<{
        id: string;
        expiresAt: number;
    }> {
        const displayName = readSettings(this.env).brand.name;
        const hash = await tokenHash(token), actor = await interactive(this.db, token, this.clock), challengeId = crypto.randomUUID(), proof = randomToken();
        const address = await one<{
            address: string;
        }>(this.db, 'SELECT address FROM account_emails WHERE id=? AND account_id=? AND revoked_at IS NULL', [id(emailId), actor.accountId]);
        if (!address)
            fail(403, 'email_unavailable');
        const proofHash = await tokenHash(proof), at = this.clock();
        const r = await this.db.prepare(`INSERT INTO release_reauth_challenges(id,credential_id,email_id,token_digest,expires_at)
   SELECT ?,c.id,e.id,?,? FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id WHERE c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE} AND e.id=? AND e.revoked_at IS NULL`).bind(challengeId, proofHash, at + 600000, hash, at, emailId).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'access_denied');
        try {
            await this.mail(token, address!.address, displayName + ': 추가 본인 확인', `본인이 요청한 경우에만 ${displayName} 관리 화면에 아래 증명을 입력하세요.\nChallenge: ${challengeId}\nProof: ${proof}\n10분 후 만료되며 이 브라우저 로그인에만 사용할 수 있습니다.`, challengeId);
        }
        catch (e) {
            await this.db.prepare('DELETE FROM release_reauth_challenges WHERE id=?').bind(challengeId).run();
            throw e;
        }
        return { id: challengeId, expiresAt: at + 600000 };
    }
    async completeReauth(token: string, challengeId: string, proof: string): Promise<void> {
        const hash = await tokenHash(token);
        await interactive(this.db, token, this.clock);
        // A mistyped proof is not a failed session credential. Keep it retryable
        // without making the console discard the valid browser session.
        const proofHash = await digest(str(proof, 256));
        // The execution-time guard and trigger consume the proof and update its
        // exact credential in one statement. No queued second statement may
        // refresh a credential after the proof or credential has expired.
        const marker = await digest(randomToken()), at = this.clock();
        await batch(this.db, [
            stmt(this.db, `UPDATE release_reauth_challenges SET used_at=${sqlNow()},token_digest=? WHERE id=? AND token_digest=? AND used_at IS NULL AND expires_at>${sqlNow()} AND EXISTS(SELECT 1 FROM active_credentials c JOIN account_emails e ON e.account_id=c.account_id WHERE c.id=release_reauth_challenges.credential_id AND e.id=release_reauth_challenges.email_id AND e.revoked_at IS NULL AND c.token_digest=? AND c.expires_at>${sqlNow()} AND ${INTERACTIVE})`, [at, marker, id(challengeId), proofHash, at, hash, at])
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
        await this.orgAdmin(token, org);
        const hash = await tokenHash(token), d = domainName(domain), challengeId = crypto.randomUUID(), proof = 'memory-verification=' + randomToken(), at = this.clock();
        const r = await this.db.prepare(`INSERT INTO release_domain_challenges(id,organization_id,actor_account_id,domain,proof,expires_at)
   SELECT ?,m.organization_id,c.account_id,?,?,? FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id WHERE ${adminSql()}`).bind(challengeId, d, proof, at + 3600000, ...adminValues(hash, at, org)).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'access_denied');
        return { id: challengeId, name: '_memory-verification.' + d, type: 'TXT', value: proof, expiresAt: at + 3600000 };
    }
    private async domainVerificationResult(token: string, challengeId: string): Promise<{ id: string; name: string; verifiedUntil: number }> {
        const hash = await tokenHash(token), at = this.clock();
        const result = await one<{ id: string; name: string; verifiedUntil: number; expiresAt: number; reauthenticatedAt: number }>(this.db,
            `/* domain-verification-result */ SELECT d.id,d.name,v.verified_until AS verifiedUntil,
                min(d.verified_until,v.verified_until,c.expires_at,c.membership_expires_at,m.expires_at) AS expiresAt,
                c.reauthenticated_at AS reauthenticatedAt
             FROM release_domain_verifications v JOIN release_domain_challenges p ON p.id=v.challenge_id
             JOIN domains d ON d.id=v.domain_id AND d.organization_id=p.organization_id AND d.name=p.domain AND d.revoked_at IS NULL
             JOIN active_credentials c ON c.account_id=p.actor_account_id
             JOIN active_memberships m ON m.id=v.membership_id AND m.account_id=c.account_id AND m.organization_id=p.organization_id
             JOIN domain_managers g ON g.domain_id=d.id AND g.membership_id=m.id AND g.revoked_at IS NULL
             WHERE v.challenge_id=? AND c.token_digest=? AND c.expires_at>${sqlNow()} AND c.membership_expires_at>${sqlNow()}
               AND ${recentSql()} AND m.expires_at>${sqlNow()} AND m.role IN ('owner','admin')`,
            [challengeId, hash, at, at, at - 300000, at, at]);
        const checkedAt = this.clock();
        if (!result || result.expiresAt <= checkedAt || result.reauthenticatedAt < checkedAt - 300000 || result.reauthenticatedAt > checkedAt)
            fail(403, 'domain_challenge_unavailable');
        return { id: result.id, name: result.name, verifiedUntil: result.verifiedUntil };
    }
    async verifyDomain(token: string, challengeId: string): Promise<{
        id: string;
        name: string;
        verifiedUntil: number;
    }> {
        const actor = await interactive(this.db, token, this.clock, true);
        challengeId = id(challengeId);
        // A completed command is a durable result. A retry must resolve that
        // exact live assignment, not consume DNS proof or extend its lease again.
        if (await one(this.db, 'SELECT id FROM release_domain_verifications WHERE challenge_id=?', [challengeId]))
            return this.domainVerificationResult(token, challengeId);
        const challenge = await one<{
            organizationId: string;
            domain: string;
            proof: string;
            expiresAt: number;
        }>(this.db, `SELECT organization_id AS organizationId,domain,proof,expires_at AS expiresAt FROM release_domain_challenges WHERE id=? AND actor_account_id=? AND expires_at>${sqlNow()} AND used_at IS NULL`, [id(challengeId), actor.accountId, this.clock()]);
        if (!challenge)
            return this.domainVerificationResult(token, challengeId);
        await this.orgAdmin(token, challenge.organizationId);
        if (challenge.expiresAt <= this.clock())
            fail(403, 'domain_challenge_unavailable');
        const name = '_memory-verification.' + challenge!.domain;
        const dns = await remoteJson(this.fetcher, 'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=TXT', { headers: { accept: 'application/dns-json' } }, 16384);
        const found = dns.Status === 0 && Array.isArray(dns.Answer) && dns.Answer.some(v => { const answer = object(v); if (answer.type !== 16 || typeof answer.name !== 'string' || answer.name.replace(/\.$/, '').toLowerCase() !== name || typeof answer.data !== 'string')
            return false; try {
            return (answer.data.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map(s => JSON.parse(s)).join('') === challenge!.proof;
        }
        catch {
            return false;
        } });
        if (!found)
            fail(409, 'dns_proof_missing');
        const hash = await tokenHash(token), org = challenge!.organizationId;
        await this.orgAdmin(token, org);
        const existing = await one<{
            id: string;
            organizationId: string;
            revokedAt: number | null;
        }>(this.db, 'SELECT id,organization_id AS organizationId,revoked_at AS revokedAt FROM domains WHERE name=? AND revoked_at IS NULL', [challenge!.domain]);
        if (existing && existing.organizationId !== org)
            fail(409, 'domain_already_claimed');
        const at = this.clock(), domainId = existing?.id ?? crypto.randomUUID(), verification = crypto.randomUUID();
        const command = stmt(this.db, `/* domain-verification-command */ INSERT INTO release_domain_verifications
                (id,challenge_id,domain_id,actor_credential_id,membership_id,created_at,verified_until)
                SELECT ?,p.id,coalesce((SELECT d.id FROM domains d WHERE d.name=p.domain AND d.revoked_at IS NULL),?),
                    c.id,m.id,${sqlNow()},${sqlNow()}+2592000000
                FROM release_domain_challenges p JOIN active_credentials c ON c.account_id=p.actor_account_id
                JOIN active_memberships m ON m.account_id=c.account_id AND m.organization_id=p.organization_id
                WHERE p.id=? AND p.actor_account_id=? AND p.used_at IS NULL AND p.verification_id IS NULL AND p.expires_at>${sqlNow()}
                  AND ${adminSql()} AND NOT EXISTS(SELECT 1 FROM release_domain_verifications v WHERE v.challenge_id=p.id)`,
                [verification, domainId, at, at, challengeId, actor.accountId, at, ...adminValues(hash, at, org)]);
        try {
            const written = await command.run();
            if (!written.success) fail(503, 'database_unavailable');
        } catch (error) {
            if (error instanceof Error && error.message.includes('release_denied')) fail(403, 'access_denied');
            throw error;
        }
        return this.domainVerificationResult(token, challengeId);
    }
    async delegateDomain(token: string, domainId: string, membershipId: string): Promise<void> {
        const hash = await tokenHash(token);
        await interactive(this.db, token, this.clock, true);
        const domain = id(domainId), target = id(membershipId);
        const authorized = `FROM domains d JOIN active_memberships own ON own.organization_id=d.organization_id JOIN domain_managers manager ON manager.domain_id=d.id AND manager.membership_id=own.id AND manager.revoked_at IS NULL
   JOIN active_credentials c ON c.account_id=own.account_id JOIN active_memberships target ON target.organization_id=d.organization_id
   WHERE d.id=? AND target.id=? AND d.revoked_at IS NULL AND d.verified_until>${sqlNow()} AND own.expires_at>${sqlNow()} AND target.expires_at>${sqlNow()} AND own.role IN ('owner','admin') AND target.role IN ('owner','admin') AND c.token_digest=? AND c.expires_at>${sqlNow()} AND c.membership_expires_at>${sqlNow()} AND ${recentSql()}`;
        const values = (at: number) => [domain, target, at, at, at, hash, at, at, at - 300000, at];
        // Never replace a retained assignment, including a revoked one. This
        // predicate also makes concurrent first requests converge on one row.
        const r = await this.db.prepare(`INSERT INTO domain_managers(domain_id,membership_id)
   SELECT d.id,target.id ${authorized}
     AND NOT EXISTS(SELECT 1 FROM domain_managers existing WHERE existing.domain_id=d.id AND existing.membership_id=target.id)`)
            .bind(...values(this.clock())).run();
        if (!r.success)
            fail(503, 'database_unavailable');
        if (r.meta.changes)
            return;
        const existing = await one<{ expiresAt: number; reauthenticatedAt: number }>(this.db, `/* domain-delegation-replay */
            SELECT min(d.verified_until,own.expires_at,target.expires_at,c.expires_at,c.membership_expires_at) AS expiresAt,
                c.reauthenticated_at AS reauthenticatedAt ${authorized}
                AND EXISTS(SELECT 1 FROM domain_managers existing WHERE existing.domain_id=d.id
                    AND existing.membership_id=target.id AND existing.revoked_at IS NULL)`, values(this.clock()));
        const checkedAt = this.clock();
        if (!existing || existing.expiresAt <= checkedAt || existing.reauthenticatedAt < checkedAt - 300000 || existing.reauthenticatedAt > checkedAt)
            fail(403, 'domain_delegation_denied');
    }
    async identityWebhook(request: Request): Promise<Response> {
        const raw = await requestText(request, 65536), timestamp = request.headers.get('x-memory-timestamp') ?? '', sig = request.headers.get('x-memory-signature') ?? '';
        if (!/^\d{10}$/.test(timestamp) || !equal(await hmac(this.env.IDENTITY_WEBHOOK_SECRET ?? '', timestamp + '.' + raw), sig) || Math.abs(this.clock() / 1000 - Number(timestamp)) > 300)
            fail(401, 'invalid_signature');
        const event = requestObject(raw);
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
        if (Math.abs(at / 1000 - Number(timestamp)) > 300)
            fail(401, 'invalid_signature');
        const revokedAddress = kind === 'email.revoked' ? email(event.email) : '';
        const receipt = `EXISTS(SELECT 1 FROM release_webhook_events WHERE provider='identity' AND event_id=? AND body_hash=?)`;
        const statements = [stmt(this.db, `INSERT INTO release_webhook_events(provider,event_id,body_hash,created_at) SELECT 'identity',?,?,? WHERE ${sqlNow()} BETWEEN ? AND ?`, [eventId, hash, at, at, Number(timestamp) * 1000 - 300000, Number(timestamp) * 1000 + 300000]),
            stmt(this.db, `INSERT INTO release_provider_revocations(issuer,subject,kind,address,created_at) SELECT ?,?,?,?,? WHERE ${receipt} ON CONFLICT(issuer,subject,kind,address) DO NOTHING`, [ISSUER,subject,kind,revokedAddress,at,eventId,hash])];
        // Resolve the mapping in the same atomic batch as the receipt and
        // tombstone. A first sign-in may have committed since this request began.
        if (kind === 'account.disabled') {
            statements.push(stmt(this.db, `UPDATE accounts SET disabled_at=? WHERE disabled_at IS NULL
                AND id IN (SELECT account_id FROM provider_identities WHERE issuer=? AND subject=?) AND ${receipt}`, [at, ISSUER, subject, eventId, hash]));
        } else {
            statements.push(
                stmt(this.db, `INSERT INTO release_external_email_blocks(account_id,address,created_at)
                    SELECT account_id,?,? FROM provider_identities WHERE issuer=? AND subject=? AND ${receipt}
                    ON CONFLICT(account_id,address) DO NOTHING`, [revokedAddress, at, ISSUER, subject, eventId, hash]),
                stmt(this.db, `UPDATE account_emails SET revoked_at=? WHERE address=? AND revoked_at IS NULL
                    AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=? AND subject=?) AND ${receipt}`, [at, revokedAddress, ISSUER, subject, eventId, hash]),
                stmt(this.db, `UPDATE email_challenges SET invalidated_at=${sqlNow()} WHERE used_at IS NULL AND invalidated_at IS NULL
                    AND address=? AND account_id IN (SELECT account_id FROM provider_identities WHERE issuer=? AND subject=?)
                    AND ${receipt}`, [at, revokedAddress, ISSUER, subject, eventId, hash])
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
        if (!await one(this.db, `SELECT event_id FROM release_webhook_events WHERE provider='identity' AND event_id=? AND body_hash=?`, [eventId, hash]))
            fail(401, 'invalid_signature');
        return json({ received: true });
    }
    async issueScimKey(token: string, org: string): Promise<{
        id: string;
        token: string;
        expiresAt: number;
    }> {
        await this.orgAdmin(token, org);
        const raw = 'scim_' + randomToken(), keyId = crypto.randomUUID(), hash = await tokenHash(token), keyHash = await tokenHash(raw), at = this.clock();
        const r = await this.db.prepare(`INSERT INTO release_scim_keys
            (id,organization_id,token_digest,creator_credential_id,expires_at,creator_membership_id,creator_email_id,created_at)
   SELECT ?,m.organization_id,?,c.id,?,m.id,m.email_id,? FROM active_credentials c JOIN active_memberships m ON m.account_id=c.account_id WHERE ${adminSql()}`).bind(keyId, keyHash, at + 30 * 86400000, at, ...adminValues(hash, at, org)).run();
        if (!r.success || !r.meta.changes)
            fail(403, 'access_denied');
        return { id: keyId, token: raw, expiresAt: at + 30 * 86400000 };
    }
    async scimAuthority(token: string, org: string): Promise<void> {
        const hash = await tokenHash(token), at = this.clock();
        const key = await one<{ expiresAt: number; membershipExpiresAt: number }>(this.db,
            `SELECT k.id,k.expires_at AS expiresAt,m.expires_at AS membershipExpiresAt FROM release_scim_keys k JOIN credentials issuer ON issuer.id=k.creator_credential_id
            JOIN active_memberships m ON m.id=k.creator_membership_id AND m.account_id=issuer.account_id
                AND m.email_id=k.creator_email_id AND m.organization_id=k.organization_id
            WHERE k.token_digest=? AND k.organization_id=? AND k.revoked_at IS NULL AND k.expires_at>${sqlNow()}
                AND m.expires_at>${sqlNow()} AND m.role IN ('owner','admin')`, [hash, id(org), at, at]);
        if (!key || Math.min(key.expiresAt, key.membershipExpiresAt) <= this.clock())
            fail(401, 'scim_unauthorized');
    }
    async scimDeactivate(token: string, org: string, membershipId: string): Promise<ScimUser> {
        await this.scimAuthority(token, org);
        const hash = await tokenHash(token), at = this.clock();
        const result = await this.db.prepare(`UPDATE memberships SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL
            AND ${scimVisible('memberships')}
            AND EXISTS(SELECT 1 FROM release_scim_keys k JOIN credentials issuer ON issuer.id=k.creator_credential_id
                JOIN active_memberships admin ON admin.id=k.creator_membership_id AND admin.account_id=issuer.account_id
                    AND admin.email_id=k.creator_email_id AND admin.organization_id=k.organization_id
                WHERE k.token_digest=? AND k.organization_id=memberships.organization_id AND k.revoked_at IS NULL AND k.expires_at>${sqlNow()}
                    AND admin.expires_at>${sqlNow()} AND admin.role IN ('owner','admin')
                    AND (memberships.role<>'owner' OR (admin.role='owner' AND EXISTS(
                        SELECT 1 FROM active_memberships other WHERE other.organization_id=memberships.organization_id
                            AND other.role='owner' AND other.expires_at>${sqlNow()} AND other.id<>memberships.id))))
            RETURNING id,(SELECT address FROM account_emails WHERE id=memberships.email_id) AS userName,0 AS active`)
            .bind(at, id(membershipId), id(org), hash, at, at, at).first<ScimUser>();
        if (result) return result;
        {
            // A repeated deactivation of the same already-revoked member is
            // idempotent. Live owner/authority denials must not look successful.
            await this.scimAuthority(token, org);
            const target = await one<ScimUser & { revokedAt: number | null }>(this.db,
                `SELECT id,(SELECT address FROM account_emails WHERE id=memberships.email_id) AS userName,0 AS active,revoked_at AS revokedAt
                 FROM memberships WHERE id=? AND organization_id=? AND ${scimVisible('memberships')}`, [membershipId, org]);
            if (!target)
                fail(404, 'scim_user_not_found');
            if (target.revokedAt === null)
                fail(403, 'membership_deactivation_denied');
            await this.scimAuthority(token, org);
            return { id: target.id, userName: target.userName, active: target.active };
        }
    }
    async scimDelete(token: string, org: string, membershipId: string): Promise<void> {
        await this.scimAuthority(token, org);
        const hash = await tokenHash(token);
        if (!await one(this.db, `SELECT id FROM memberships WHERE id=? AND organization_id=?
            AND ${scimVisible('memberships')}`, [id(membershipId), id(org)]))
            fail(404, 'scim_user_not_found');
        const at = this.clock();
        // The tombstone trigger rechecks the exact key, current administrator and
        // owner rule, then revokes the membership in this same transaction.
        await batch(this.db, [stmt(this.db, `INSERT INTO release_scim_deletions(membership_id,scim_key_id,deleted_at)
            SELECT target.id,k.id,? FROM memberships target JOIN release_scim_keys k ON k.organization_id=target.organization_id
            WHERE target.id=? AND target.organization_id=? AND k.token_digest=?
              AND ${scimVisible('target')}`,
            [at, membershipId, org, hash])]);
        if (!await one(this.db, 'SELECT membership_id FROM release_scim_deletions WHERE membership_id=?', [membershipId]))
            fail(403, 'membership_deletion_denied');
    }
    async scim(request: Request, org: string, membershipId?: string): Promise<Response> {
        const bearer = /^Bearer ([^\s,]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
        if (!bearer)
            fail(401, 'scim_unauthorized');
        await this.scimAuthority(bearer, org);
        requireMethod(request, ...(membershipId ? ['GET', 'PATCH', 'DELETE'] : ['GET']));
        const url = new URL(request.url);
        if (request.method === 'GET') {
            const start = membershipId ? 1 : scimPage(url, 'startIndex', 1), count = membershipId ? 1 : scimPage(url, 'count', 100);
            const project = scimProjection(url);
            if (url.searchParams.has('filter'))
                fail(400, 'scim_filter_not_supported');
            const values = await rows<{
                id: string;
                userName: string;
                activeUntil: number;
            }>(this.db, `SELECT m.id,e.address AS userName,coalesce((SELECT live.expires_at FROM active_memberships live WHERE live.id=m.id),0) AS activeUntil FROM memberships m JOIN account_emails e ON e.id=m.email_id WHERE m.organization_id=?
                AND ${scimVisible('m')}
                ${membershipId ? 'AND m.id=?' : ''} ORDER BY m.id LIMIT ? OFFSET ?`, [org, ...(membershipId ? [id(membershipId)] : []), count, start - 1]);
            const resources = () => { const at = this.clock(); return values.map(value => project({ id: value.id, userName: value.userName, active: value.activeUntil > at ? 1 : 0 })); };
            if (membershipId) {
                await this.scimAuthority(bearer, org);
                const resource = resources()[0];
                if (!resource)
                    fail(404, 'scim_user_not_found');
                return json(resource, 200, { 'content-type': 'application/scim+json; charset=utf-8' });
            }
            const total = await one<{
                n: number;
            }>(this.db, `SELECT count(*) AS n FROM memberships WHERE organization_id=? AND ${scimVisible('memberships')}`, [org]);
            await this.scimAuthority(bearer, org);
            return json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: total?.n ?? 0, startIndex: start, itemsPerPage: values.length, Resources: resources() }, 200, { 'content-type': 'application/scim+json; charset=utf-8' });
        }
        if (!membershipId)
            fail(404, 'scim_user_not_found');
        if (!await one(this.db, `SELECT id FROM memberships WHERE id=? AND organization_id=?
            AND ${scimVisible('memberships')}`, [id(membershipId), org]))
            fail(404, 'scim_user_not_found');
        if (request.method === 'PATCH') {
            scimProjection(url);
            const input = await scimBody(request);
            if (!Array.isArray(input.schemas) || input.schemas.length !== 1 || input.schemas[0] !== 'urn:ietf:params:scim:api:messages:2.0:PatchOp')
                fail(400, 'unsupported_scim_patch');
            if (!Array.isArray(input.operations) || input.operations.length !== 1)
                fail(400, 'unsupported_scim_patch');
            const op = scimObject(input.operations[0], ['op', 'path', 'value']);
            if (typeof op.op !== 'string' || op.op.toLowerCase() !== 'replace' ||
                !((typeof op.path === 'string' && ['active', SCIM_USER_SCHEMA.toLowerCase() + ':active'].includes(op.path.toLowerCase()) && op.value === false) ||
                    (op.path === undefined && scimObject(op.value, ['active']).active === false)))
                fail(400, 'unsupported_scim_patch');
        }
        if (request.method === 'DELETE') await this.scimDelete(bearer, org, membershipId);
        else {
            const resource = await this.scimDeactivate(bearer, org, membershipId);
            // The guarded update can revoke its own SCIM key. Its RETURNING
            // representation belongs to that authorized mutation; a second GET
            // would incorrectly turn successful self-deactivation into a 401.
            if (url.searchParams.has('attributes') || url.searchParams.has('excludedAttributes'))
                return json(scimProjection(url)(resource), 200, { 'content-type': 'application/scim+json; charset=utf-8' });
        }
        return json(null, 204);
    }
}

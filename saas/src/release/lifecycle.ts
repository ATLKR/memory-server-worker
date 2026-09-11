import type { Database } from './types.ts';
import { canonicalEmail } from '../identity.ts';
import { sqlNow } from '../sql-clock.ts';
import { batch, digest, exact, fail, id, integer, json, one, requestObject, stmt, str } from './util.ts';

function lifecycleEvent(event: Record<string, unknown>, timestamp: number) {
    exact(event, ['version', 'id', 'sequence', 'issuer', 'subject', 'type', 'occurredAt', 'email']);
    if (event.version !== 2 || event.issuer !== 'https://auth-api.allen.company') fail(400, 'unsupported_identity_event');
    const eventId = id(event.id), subject = str(event.subject, 512), kind = str(event.type, 64);
    const sequence = integer(event.sequence, 1, Number.MAX_SAFE_INTEGER), occurredAt = integer(event.occurredAt, 0, Number.MAX_SAFE_INTEGER);
    if (!['account.suspended', 'account.resumed', 'account.deleted', 'email.revoked', 'email.verified'].includes(kind)
        || occurredAt > timestamp + 300000) fail(400, 'unsupported_identity_event');
    let address = '';
    if (kind.startsWith('email.')) {
        try { address = canonicalEmail(event.email as string).address; } catch { fail(400, 'invalid_email'); }
    } else if (event.email !== undefined && event.email !== null) fail(400, 'unsupported_identity_event');
    return { eventId, subject, kind, sequence, occurredAt, address, issuer: event.issuer as string };
}

/** Only the application callback after RS256 issuer/audience verification may
 * call this. All bounded heads commit together before sign-in creates claims. */
export async function applyVerifiedLifecycle(db: Database, clock: () => number, principal: unknown): Promise<void> {
    if (!principal || typeof principal !== 'object' || !('identityLifecycle' in principal)) return;
    const proof = principal as { issuer: string; subject: string; issuedAt: number; expiresAt: number; email?: string; emailVerified?: boolean; identityLifecycle: unknown };
    if (proof.issuer !== 'https://auth-api.allen.company' || typeof proof.subject !== 'string'
        || !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt)
        || proof.issuedAt < 0 || proof.expiresAt <= proof.issuedAt || proof.expiresAt - proof.issuedAt > 900000
        || !Array.isArray(proof.identityLifecycle) || proof.identityLifecycle.length > 2) fail(401, 'invalid_identity_lifecycle');
    const seen = new Set<string>();
    const heads = [];
    for (const raw of proof.identityLifecycle) {
        if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 4096) fail(401, 'invalid_identity_lifecycle');
        const value = lifecycleEvent(requestObject(raw), proof.issuedAt);
        if (value.subject !== proof.subject || seen.has(value.address) || (value.address !== '' &&
            (proof.emailVerified !== true || value.address !== canonicalEmail(proof.email!).address))) fail(401, 'invalid_identity_lifecycle');
        seen.add(value.address);
        const hash = await digest(raw), existing = await one<{ hash: string }>(db,
            "SELECT body_hash AS hash FROM release_webhook_events WHERE provider='identity' AND event_id=?", [value.eventId]);
        if (existing && existing.hash !== hash) fail(409, 'webhook_conflict');
        if (!existing) heads.push({ ...value, hash });
    }
    const at = clock();
    if (proof.issuedAt > at || proof.expiresAt <= at) fail(401, 'invalid_identity_lifecycle');
    if (!heads.length) return;
    await batch(db, heads.flatMap(value => [
        stmt(db, `INSERT INTO release_identity_lifecycle_jwt_proofs(event_id,body_hash,issued_at,expires_at)
            SELECT ?,?,?,? WHERE ?<=${sqlNow()} AND ?>${sqlNow()}
              AND NOT EXISTS(SELECT 1 FROM release_webhook_events WHERE provider='identity' AND event_id=?)`,
            [value.eventId, value.hash, proof.issuedAt, proof.expiresAt, proof.issuedAt, at, proof.expiresAt, at, value.eventId]),
        stmt(db, `INSERT INTO release_webhook_events(provider,event_id,body_hash,created_at)
            SELECT 'identity',?,?,${sqlNow()} WHERE EXISTS(SELECT 1 FROM release_identity_lifecycle_jwt_proofs WHERE event_id=? AND body_hash=? AND expires_at>${sqlNow()})
              AND NOT EXISTS(SELECT 1 FROM release_webhook_events WHERE provider='identity' AND event_id=?)`,
            [value.eventId, value.hash, at, value.eventId, value.hash, at, value.eventId]),
        stmt(db, `INSERT INTO release_identity_lifecycle_events(id,issuer,subject,sequence,kind,address,occurred_at,received_at,signed_at,body_hash)
            SELECT ?,?,?,?,?,?,?,${sqlNow()},?,? WHERE EXISTS(SELECT 1 FROM release_identity_lifecycle_jwt_proofs WHERE event_id=? AND body_hash=?)
              AND NOT EXISTS(SELECT 1 FROM release_identity_lifecycle_events WHERE id=?)`,
            [value.eventId, value.issuer, value.subject, value.sequence, value.kind, value.address, value.occurredAt, at, proof.issuedAt, value.hash, value.eventId, value.hash, value.eventId]),
    ]));
    const accepted = await one<{ count: number }>(db, `SELECT count(*) AS count FROM json_each(?) head
        JOIN release_webhook_events w ON w.provider='identity' AND w.event_id=json_extract(head.value,'$.eventId')
            AND w.body_hash=json_extract(head.value,'$.hash')`, [JSON.stringify(heads)]);
    if (accepted?.count !== heads.length || proof.expiresAt <= clock()) fail(401, 'invalid_identity_lifecycle');
}

/** Called only after Admin verifies the original request's HMAC signature. */
export async function receiveLifecycle(db: Database, clock: () => number, event: Record<string, unknown>, raw: string, timestamp: number): Promise<Response> {
    const { eventId, subject, kind, sequence, occurredAt, address, issuer } = lifecycleEvent(event, timestamp);
    const hash = await digest(raw);
    const accepted = () => one<{ hash: string }>(db, "SELECT body_hash AS hash FROM release_webhook_events WHERE provider='identity' AND event_id=?", [eventId]);
    const existing = await accepted();
    if (existing) {
        if (existing.hash !== hash) fail(409, 'webhook_conflict');
        return json({ received: true, replayed: true });
    }
    const at = clock();
    if (Math.abs(at - timestamp) > 300000) fail(401, 'invalid_signature');
    try {
        await batch(db, [
            stmt(db, `INSERT INTO release_webhook_events(provider,event_id,body_hash,created_at)
                SELECT 'identity',?,?,${sqlNow()} WHERE ${sqlNow()} BETWEEN ? AND ?`, [eventId, hash, at, at, timestamp - 300000, timestamp + 300000]),
            stmt(db, `INSERT INTO release_identity_lifecycle_events(id,issuer,subject,sequence,kind,address,occurred_at,received_at,signed_at,body_hash)
                SELECT ?,?,?,?,?,?,?,${sqlNow()},?,? WHERE EXISTS(SELECT 1 FROM release_webhook_events WHERE provider='identity' AND event_id=? AND body_hash=?)`,
                [eventId, issuer, subject, sequence, kind, address, occurredAt, at, timestamp, hash, eventId, hash]),
        ]);
    } catch (error) {
        const receipt = await accepted();
        if (receipt) {
            if (receipt.hash !== hash) fail(409, 'webhook_conflict');
            return json({ received: true, replayed: true });
        }
        if (error instanceof Error && error.message.includes('identity_lifecycle_signature_expired')) fail(401, 'invalid_signature');
        if (error instanceof Error && error.message.includes('identity_lifecycle_event_conflict')) fail(409, 'webhook_conflict');
        throw error;
    }
    if (!await accepted()) fail(401, 'invalid_signature');
    return json({ received: true });
}

import type { ReleaseEnv } from './types.ts';
import { canonicalEmail } from '../identity.ts';
import { digest, fail, one } from './util.ts';

/** Only a verified issuer principal reaches this internal hook. Signup admission
 * is separate from ongoing account/Space authority and never grants an ACL. */
export async function admitSignIn(env: ReleaseEnv, principal: unknown): Promise<void> {
    if (env.ENROLLMENT_MODE === undefined || env.ENROLLMENT_MODE === 'open') {
        if (env.RELEASE_MODE === 'ga') fail(503, 'enrollment_not_configured');
        return;
    }
    if (env.ENROLLMENT_MODE !== 'invite') fail(503, 'enrollment_not_configured');
    if (!principal || typeof principal !== 'object' || Array.isArray(principal)) fail(403, 'invitation_required');
    const p = principal as Record<string, unknown>;
    if (typeof p.issuer !== 'string' || typeof p.subject !== 'string') fail(403, 'invitation_required');
    const existing = await one<{ disabledAt: number | null }>(env.DB, `SELECT a.disabled_at AS disabledAt FROM provider_identities p JOIN accounts a ON a.id=p.account_id
        WHERE p.issuer=? AND p.subject=?`, [p.issuer, p.subject]);
    if (existing) {
        if (existing.disabledAt !== null) fail(403, 'invitation_required');
        return;
    }
    let roster: unknown;
    if (env.ENROLLMENT_EMAIL_HASHES_JSON !== undefined && typeof env.ENROLLMENT_EMAIL_HASHES_JSON !== 'string')
        fail(503, 'enrollment_not_configured');
    try { roster = JSON.parse(env.ENROLLMENT_EMAIL_HASHES_JSON ?? '[]'); } catch { fail(503, 'enrollment_not_configured'); }
    if (!Array.isArray(roster) || roster.length > 200 || roster.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))
        fail(503, 'enrollment_not_configured');
    if (p.emailVerified !== true || typeof p.email !== 'string') fail(403, 'invitation_required');
    let address: string;
    try { address = canonicalEmail(p.email).address; } catch { fail(403, 'invitation_required'); }
    if (!roster.includes(await digest(address!))) fail(403, 'invitation_required');
}

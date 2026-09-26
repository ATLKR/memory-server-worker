import type { Database } from '../release/types.ts';
import type { PostgresRegion } from './connection.ts';
import { id, str } from '../release/util.ts';

/** Control-plane regional-enrollment commands. The canonical id registry and
 * enrollment directory live on the control cluster; regional identity rows are
 * owned by the region and created by the region's own commands. Every command
 * fails closed — a retired region or a removed enrollment is terminal. */

export type EnrollmentOutcome = Readonly<{ kind: 'enrolled' | 'already_enrolled' }>;
export type RemovalOutcome = Readonly<{ kind: 'removed' | 'not_enrolled' }>;
export type UnlinkOutcome = Readonly<{ kind: 'unlinked' | 'already_unlinked' }>;

function failure(code: string): Error & { code: string } {
    return Object.assign(new Error(code), { code });
}

async function liveRegion(control: Database, region: PostgresRegion): Promise<void> {
    const row = await control.prepare('SELECT retired_at_ms AS "retiredAt" FROM memory_control.regions WHERE region=?')
        .bind(region).first<{ retiredAt: number | null }>();
    if (!row || row.retiredAt !== null) throw failure('region_unavailable');
}

/** Register the canonical account skeleton (if absent) and the live per-region
 * enrollment. Idempotent: a second enrollment for the same (account, region)
 * is a no-op, not a second live row. */
export async function enrollAccount(control: Database, accountId: string, region: PostgresRegion, at: number): Promise<EnrollmentOutcome> {
    const key = id(accountId);
    await liveRegion(control, region);
    if (await accountEnrolled(control, key, region)) return Object.freeze({ kind: 'already_enrolled' });
    // Owner-side command: creates the canonical skeleton if absent, then the
    // live enrollment row, and asserts the target region is live and the
    // caller's own (memory.caller_region is pinned at attestation).
    await control.prepare('SELECT memory_control.enroll_account(?,?,?)').bind(key, region, at).run();
    return Object.freeze({ kind: 'enrolled' });
}

export async function enrollOrganization(control: Database, organizationId: string, region: PostgresRegion, at: number): Promise<EnrollmentOutcome> {
    const key = id(organizationId);
    await liveRegion(control, region);
    if (await organizationEnrolled(control, key, region)) return Object.freeze({ kind: 'already_enrolled' });
    await control.prepare('SELECT memory_control.enroll_organization(?,?,?)').bind(key, region, at).run();
    return Object.freeze({ kind: 'enrolled' });
}

/** Removal is terminal: the row's removed_at_ms can never be cleared, and a
 * later re-enrollment inserts a fresh row. Regional teardown is a separately
 * reviewed command — this only closes the directory entry. */
export async function removeAccountEnrollment(control: Database, accountId: string, region: PostgresRegion, at: number): Promise<RemovalOutcome> {
    const key = id(accountId);
    const result = await control.prepare('SELECT memory_control.remove_account_enrollment(?,?,?) AS applied')
        .bind(key, region, at).first<{ applied: boolean }>();
    return Object.freeze({ kind: result?.applied ? 'removed' : 'not_enrolled' });
}

export async function removeOrganizationEnrollment(control: Database, organizationId: string, region: PostgresRegion, at: number): Promise<RemovalOutcome> {
    const key = id(organizationId);
    const result = await control.prepare('SELECT memory_control.remove_organization_enrollment(?,?,?) AS applied')
        .bind(key, region, at).first<{ applied: boolean }>();
    return Object.freeze({ kind: result?.applied ? 'removed' : 'not_enrolled' });
}

/** Console/admin origin for severing an SSO binding: stamps the binding's
 * unlinked_at_ms and appends a control-channel subject.unlinked journal event
 * in the same transaction. Idempotent — a binding already unlinked reports
 * 'already_unlinked' rather than failing. */
export async function unlinkSubject(control: Database, issuer: string, subject: string, at: number): Promise<UnlinkOutcome> {
    const result = await control.prepare('SELECT memory_control.unlink_subject(?,?,?) AS applied')
        .bind(str(issuer, 2048), str(subject, 512), at).first<{ applied: boolean }>();
    return Object.freeze({ kind: result?.applied ? 'unlinked' : 'already_unlinked' });
}

export async function accountEnrolled(control: Database, accountId: string, region: PostgresRegion): Promise<boolean> {
    return !!(await control.prepare(`SELECT 1 FROM memory_control.account_enrollments
        WHERE account_id=? AND region=? AND removed_at_ms IS NULL`).bind(id(accountId), region).first());
}

export async function organizationEnrolled(control: Database, organizationId: string, region: PostgresRegion): Promise<boolean> {
    return !!(await control.prepare(`SELECT 1 FROM memory_control.organization_enrollments
        WHERE organization_id=? AND region=? AND removed_at_ms IS NULL`).bind(id(organizationId), region).first());
}

/** Minimal reader both `Database` and `IdentityDatabase` satisfy — admission
 * checks only ever run bound SELECTs. */
interface EnrollmentReader {
    prepare(sql: string): {
        bind(...values: (string | number | null)[]): {
            first<T = Record<string, unknown>>(): Promise<T | null>;
        };
    };
}

/** The serving deployment's storage region from the regional singleton; null
 * when the deployment was never provisioned. */
export async function deploymentRegion(region: EnrollmentReader): Promise<PostgresRegion | null> {
    const row = await region.prepare('SELECT storage_region AS "region" FROM memory_control.deployment_identity')
        .bind().first<{ region: string }>();
    return row?.region === 'sg' || row?.region === 'kr-seoul' ? row.region : null;
}

/** Grant admission: a grant on a Space homed in region R may only name an
 * account enrolled in R. Accounts carrying central SSO bindings (any regional
 * provider_identities row) must hold a live enrollment row; region-only
 * accounts are enrolled by their regional existence. Fail closed when the
 * deployment identity or directory is unreadable. Single-cluster deployments
 * (no control handle) skip the directory — the only region is the serving one. */
export async function accountGrantAdmission(region: EnrollmentReader, control: Database | undefined, accountId: string): Promise<boolean> {
    if (!control) return true;
    const home = await deploymentRegion(region);
    if (!home) return false;
    const bound = await region.prepare('SELECT 1 FROM memory_identity.runtime_provider_identities WHERE account_id=? LIMIT 1')
        .bind(id(accountId)).first();
    if (!bound) return true;
    return accountEnrolled(control, accountId, home);
}

/** Organization grants (org-scoped keys, memberships) additionally require the
 * organization's own live enrollment in the serving region. */
export async function organizationGrantAdmission(region: EnrollmentReader, control: Database | undefined, organizationId: string): Promise<boolean> {
    if (!control) return true;
    const home = await deploymentRegion(region);
    return home !== null && organizationEnrolled(control, organizationId, home);
}

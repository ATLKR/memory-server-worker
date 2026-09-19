import type { Database } from '../release/types.ts';

/** Central lifecycle journal → regional apply. The control-plane journal
 * (`memory_ops.lifecycle_events`) is the only cross-tier identity transport:
 * regions apply events in per-issuer sequence order into their own
 * `lifecycle_applied_state`, which the regional live views already enforce.
 * Account content rows are not copied — only revocation-relevant state. */

/** Reserved issuer for control-authored rows (enrollment removal/restore and
 * console-initiated subject unlink). Never a valid HTTPS issuer, so it cannot
 * collide with a provider's UNIQUE(issuer, sequence) space. */
export const CONTROL_CHANNEL = 'memory:control';

export interface ProviderLifecycleEvent {
    channel: 'provider';
    id: string;
    issuer: string;
    subject: string;
    sequence: number;
    kind: 'account.suspended' | 'account.resumed' | 'account.deleted' | 'email.revoked' | 'email.verified' | 'subject.unlinked';
    address: string;
    occurredAtMs: number;
}

export interface ControlLifecycleEvent {
    channel: 'control';
    id: string;
    sequence: number;
    kind: 'enrollment.removed' | 'enrollment.restored' | 'subject.unlinked';
    issuer: typeof CONTROL_CHANNEL;
    subject: string;
    occurredAtMs: number;
    region: string | null;
    scope: 'account' | 'organization' | null;
    targetId: string | null;
    targetIssuer: string | null;
}

export type CentralLifecycleEvent = ProviderLifecycleEvent | ControlLifecycleEvent;

export interface ApplyResult {
    applied: number;
    head: number;
}

const PROVIDER_KINDS = new Set(['account.suspended', 'account.resumed', 'account.deleted', 'email.revoked', 'email.verified', 'subject.unlinked']);
const CONTROL_KINDS = new Set(['enrollment.removed', 'enrollment.restored', 'subject.unlinked']);

function invalid(): never {
    throw Object.assign(new Error('lifecycle_event_invalid'), { code: 'lifecycle_event_invalid' });
}

function event(input: Record<string, unknown>): CentralLifecycleEvent {
    const e = input;
    // Journal rows carry `source`; programmatic callers carry `channel`. Either
    // may assert the control channel — the reserved issuer is the authority.
    const channel = e.channel ?? e.source;
    if (typeof e.id !== 'string' || typeof e.issuer !== 'string' || typeof e.subject !== 'string'
        || typeof e.sequence !== 'number' || !Number.isSafeInteger(e.sequence) || e.sequence < 1
        || typeof e.kind !== 'string' || (e.address !== undefined && typeof e.address !== 'string')
        || typeof e.occurredAtMs !== 'number' || !Number.isSafeInteger(e.occurredAtMs)
        || (channel !== undefined && channel !== 'provider' && channel !== 'control')) {
        invalid();
    }
    if (e.issuer === CONTROL_CHANNEL || channel === 'control') {
        // Control rows restate directory truth: reserved issuer, empty (or, on
        // already-parsed events, omitted) address, and per-kind targets —
        // enrollment events name region+scope+target, subject.unlinked names
        // the binding issuer it converges.
        if (e.issuer !== CONTROL_CHANNEL || (channel !== undefined && channel !== 'control')
            || (e.address !== undefined && e.address !== '') || !CONTROL_KINDS.has(e.kind)
            || (e.kind === 'subject.unlinked'
                ? typeof e.targetIssuer !== 'string'
                : typeof e.region !== 'string' || (e.scope !== 'account' && e.scope !== 'organization')
                  || typeof e.targetId !== 'string')) {
            invalid();
        }
        return {
            channel: 'control', id: e.id, sequence: e.sequence,
            kind: e.kind as ControlLifecycleEvent['kind'], issuer: CONTROL_CHANNEL,
            subject: e.subject, occurredAtMs: e.occurredAtMs,
            region: typeof e.region === 'string' ? e.region : null,
            scope: e.scope === 'account' || e.scope === 'organization' ? e.scope : null,
            targetId: typeof e.targetId === 'string' ? e.targetId : null,
            targetIssuer: typeof e.targetIssuer === 'string' ? e.targetIssuer : null,
        };
    }
    if (typeof e.address !== 'string' || !PROVIDER_KINDS.has(e.kind) || (e.kind === 'subject.unlinked' && e.address !== '')) {
        invalid();
    }
    return {
        channel: 'provider', id: e.id, issuer: e.issuer, subject: e.subject,
        sequence: e.sequence, kind: e.kind as ProviderLifecycleEvent['kind'],
        address: e.address, occurredAtMs: e.occurredAtMs,
    };
}

/** Apply one central journal event to the regional applied state, preserving
 * order and the terminal `account.deleted` rule. The applied-state upsert
 * refuses regression; the apply-head only advances. Enrollment events land in
 * `enrollment_applied_state` (keyed by scope+target, restorable by sequence);
 * `subject.unlinked` converges through `apply_subject_unlink` onto a
 * provider_revocations tombstone rather than applied state — a non-resumed
 * row on (issuer, subject, '') would deny the whole account. */
export async function applyLifecycleEvent(region: Database, input: CentralLifecycleEvent): Promise<void> {
    const e = event(input as unknown as Record<string, unknown>);
    const head = region.prepare(`INSERT INTO memory_ops.lifecycle_apply_head(issuer, applied_sequence, applied_at_ms)
        VALUES (?,?,memory_control.now_ms())
        ON CONFLICT (issuer) DO UPDATE SET
          applied_sequence = EXCLUDED.applied_sequence, applied_at_ms = EXCLUDED.applied_at_ms
        WHERE memory_ops.lifecycle_apply_head.applied_sequence < EXCLUDED.applied_sequence`)
        .bind(e.issuer, e.sequence);
    if (e.channel === 'control') {
        if (e.kind === 'subject.unlinked') {
            await region.batch([
                region.prepare('SELECT memory_ops.apply_subject_unlink(?,?,?)')
                    .bind(e.targetIssuer ?? e.issuer, e.subject, e.occurredAtMs),
                head,
            ]);
            return;
        }
        await region.batch([
            region.prepare(`INSERT INTO memory_ops.enrollment_applied_state(scope, subject_id, sequence, kind, occurred_at_ms, event_id)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT (scope, subject_id) DO UPDATE SET
                  sequence = EXCLUDED.sequence, kind = EXCLUDED.kind,
                  occurred_at_ms = EXCLUDED.occurred_at_ms, event_id = EXCLUDED.event_id
                WHERE memory_ops.enrollment_applied_state.sequence < EXCLUDED.sequence`)
                .bind(e.scope, e.targetId, e.sequence, e.kind, e.occurredAtMs, e.id),
            head,
        ]);
        return;
    }
    if (e.kind === 'subject.unlinked') {
        await region.batch([
            region.prepare('SELECT memory_ops.apply_subject_unlink(?,?,?)')
                .bind(e.issuer, e.subject, e.occurredAtMs),
            head,
        ]);
        return;
    }
    await region.batch([
        region.prepare(`INSERT INTO memory_ops.lifecycle_applied_state(issuer, subject, address, sequence, kind, occurred_at_ms, event_id)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT (issuer, subject, address) DO UPDATE SET
              sequence = EXCLUDED.sequence, kind = EXCLUDED.kind,
              occurred_at_ms = EXCLUDED.occurred_at_ms, event_id = EXCLUDED.event_id
            WHERE memory_ops.lifecycle_applied_state.sequence < EXCLUDED.sequence
              AND memory_ops.lifecycle_applied_state.kind <> 'account.deleted'`)
            .bind(e.issuer, e.subject, e.address, e.sequence, e.kind, e.occurredAtMs, e.id),
        head,
    ]);
}

/** Pull the central journal forward per issuer and apply each event in order.
 * Returns the number of events applied and the highest sequence seen. A
 * directory read failure propagates — an unreadable journal is unavailable,
 * never caught-up. The control channel is always synced alongside provider
 * issuers so its head stays fresh for the staleness gate. */
export async function syncLifecycleJournal(control: Database, region: Database,
    options: { issuers?: readonly string[]; limit?: number } = {}): Promise<ApplyResult> {
    const limit = options.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw Object.assign(new Error('lifecycle_sync_options_invalid'), { code: 'lifecycle_sync_options_invalid' });
    }
    const issuers = options.issuers ?? [...((await region.prepare(
        `SELECT issuer FROM memory_identity.runtime_provider_identities GROUP BY issuer`).bind().all()).results.map(row => row.issuer as string)),
        CONTROL_CHANNEL];
    let applied = 0, head = 0;
    for (const issuer of issuers) {
        const appliedHead = await region.prepare(
            `SELECT applied_sequence AS "appliedSequence" FROM memory_ops.lifecycle_apply_head WHERE issuer=?`)
            .bind(issuer).first<{ appliedSequence: number }>();
        const after = appliedHead?.appliedSequence ?? 0;
        // The central journal is owner-written; regions read it forward only
        // through this bounded definer entry point.
        const events = (await control.prepare(`SELECT id, issuer, subject, sequence, kind, address,
                occurred_at_ms AS "occurredAtMs", source, region, scope,
                target_id AS "targetId", target_issuer AS "targetIssuer"
            FROM memory_ops.lifecycle_events_after(?,?,?)`)
            .bind(issuer, after, limit).all()).results.map(row => event(row));
        let issuerHead = after;
        for (const e of events) {
            await applyLifecycleEvent(region, e);
            applied += 1;
            issuerHead = Math.max(issuerHead, e.sequence);
            head = Math.max(head, e.sequence);
        }
        // A successful empty read is itself the catch-up watermark: an issuer
        // with no pending events still gets a fresh apply-head, otherwise every
        // account bound to it would be denied by the staleness gate forever.
        // A journal read failure propagates before this stamp.
        await region.prepare(`INSERT INTO memory_ops.lifecycle_apply_head(issuer, applied_sequence, applied_at_ms)
            VALUES (?,?,memory_control.now_ms())
            ON CONFLICT (issuer) DO UPDATE SET applied_at_ms = EXCLUDED.applied_at_ms`)
            .bind(issuer, issuerHead).run();
    }
    return { applied, head };
}

import type { Database } from '../release/types.ts';

/** Central lifecycle journal → regional apply. The control-plane journal
 * (`memory_ops.lifecycle_events`) is the only cross-tier identity transport:
 * regions apply events in per-issuer sequence order into their own
 * `lifecycle_applied_state`, which the regional live views already enforce.
 * Account content rows are not copied — only revocation-relevant state. */

export interface CentralLifecycleEvent {
    id: string;
    issuer: string;
    subject: string;
    sequence: number;
    kind: 'account.suspended' | 'account.resumed' | 'account.deleted' | 'email.revoked' | 'email.verified';
    address: string;
    occurredAtMs: number;
}

export interface ApplyResult {
    applied: number;
    head: number;
}

const KINDS = new Set(['account.suspended', 'account.resumed', 'account.deleted', 'email.revoked', 'email.verified']);

function event(input: Record<string, unknown>): CentralLifecycleEvent {
    const e = input;
    if (typeof e.id !== 'string' || typeof e.issuer !== 'string' || typeof e.subject !== 'string'
        || typeof e.sequence !== 'number' || !Number.isSafeInteger(e.sequence) || e.sequence < 1
        || typeof e.kind !== 'string' || !KINDS.has(e.kind) || typeof e.address !== 'string'
        || typeof e.occurredAtMs !== 'number' || !Number.isSafeInteger(e.occurredAtMs)) {
        throw Object.assign(new Error('lifecycle_event_invalid'), { code: 'lifecycle_event_invalid' });
    }
    return e as unknown as CentralLifecycleEvent;
}

/** Apply one central journal event to the regional applied state, preserving
 * order and the terminal `account.deleted` rule. The applied-state upsert
 * refuses regression; the apply-head only advances. */
export async function applyLifecycleEvent(region: Database, input: CentralLifecycleEvent): Promise<void> {
    const e = event(input as unknown as Record<string, unknown>);
    await region.batch([
        region.prepare(`INSERT INTO memory_ops.lifecycle_applied_state(issuer, subject, address, sequence, kind, occurred_at_ms, event_id)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT (issuer, subject, address) DO UPDATE SET
              sequence = EXCLUDED.sequence, kind = EXCLUDED.kind,
              occurred_at_ms = EXCLUDED.occurred_at_ms, event_id = EXCLUDED.event_id
            WHERE memory_ops.lifecycle_applied_state.sequence < EXCLUDED.sequence
              AND memory_ops.lifecycle_applied_state.kind <> 'account.deleted'`)
            .bind(e.issuer, e.subject, e.address, e.sequence, e.kind, e.occurredAtMs, e.id),
        region.prepare(`INSERT INTO memory_ops.lifecycle_apply_head(issuer, applied_sequence, applied_at_ms)
            VALUES (?,?,memory_control.now_ms())
            ON CONFLICT (issuer) DO UPDATE SET
              applied_sequence = EXCLUDED.applied_sequence, applied_at_ms = EXCLUDED.applied_at_ms
            WHERE memory_ops.lifecycle_apply_head.applied_sequence < EXCLUDED.applied_sequence`)
            .bind(e.issuer, e.sequence),
    ]);
}

/** Pull the central journal forward per issuer and apply each event in order.
 * Returns the number of events applied and the highest sequence seen. A
 * directory read failure propagates — an unreadable journal is unavailable,
 * never caught-up. */
export async function syncLifecycleJournal(control: Database, region: Database,
    options: { issuers?: readonly string[]; limit?: number } = {}): Promise<ApplyResult> {
    const limit = options.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw Object.assign(new Error('lifecycle_sync_options_invalid'), { code: 'lifecycle_sync_options_invalid' });
    }
    const issuers = options.issuers ?? ((await region.prepare(
        `SELECT issuer FROM memory_identity.runtime_provider_identities GROUP BY issuer`).bind().all()).results.map(row => row.issuer as string));
    let applied = 0, head = 0;
    for (const issuer of issuers) {
        const appliedHead = await region.prepare(
            `SELECT applied_sequence AS "appliedSequence" FROM memory_ops.lifecycle_apply_head WHERE issuer=?`)
            .bind(issuer).first<{ appliedSequence: number }>();
        const after = appliedHead?.appliedSequence ?? 0;
        // The central journal is owner-written; regions read it forward only
        // through this bounded definer entry point.
        const events = (await control.prepare(`SELECT id, issuer, subject, sequence, kind, address,
                occurred_at_ms AS "occurredAtMs" FROM memory_ops.lifecycle_events_after(?,?,?)`)
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

import type { ReleaseEnv } from './types.ts';
import { SQL_NOW_MS } from '../sql-clock.ts';
import { fail } from './util.ts';

/** Conservative reservation, not a Cloudflare invoice. Prices and input/output
 * bounds are documented in OPERATIONS.md and checked when the model changes. */
export async function reserveProvider(env: ReleaseEnv, kind: 'embedding' | 'extraction'): Promise<void> {
    if (env.AI_MONTHLY_BUDGET_MICROUSD === undefined) {
        if (env.RELEASE_MODE === 'ga') fail(503, 'provider_budget_not_configured');
        return;
    }
    const text = env.AI_MONTHLY_BUDGET_MICROUSD;
    if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(text)) fail(503, 'provider_budget_not_configured');
    const limit = Number(text), reservation = kind === 'embedding' ? 200 : 30000;
    // The UTC period and remaining budget share the execution-time D1 snapshot.
    // Different accounts, retries and scheduled workers compete for one cap.
    const month = `strftime('%Y-%m',${SQL_NOW_MS}/1000,'unixepoch')`;
    const accepted = await env.DB.prepare(`INSERT INTO release_provider_budgets(month,kind,calls,reserved_microusd)
        SELECT ${month},?,1,? WHERE
            (SELECT coalesce(sum(reserved_microusd),0) FROM release_provider_budgets WHERE month=${month})+?<=?
        ON CONFLICT(month,kind) DO UPDATE SET calls=calls+1,reserved_microusd=reserved_microusd+excluded.reserved_microusd
        RETURNING calls`).bind(kind, reservation, reservation, limit).first();
    if (!accepted) fail(429, 'provider_budget_exhausted');
}

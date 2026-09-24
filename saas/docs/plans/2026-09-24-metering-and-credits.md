# Metering + launch credits — design plan (2026-09-24)

Scope: record enough usage now that pricing can be decided later without
data loss. No billing at launch; users receive generous free credits.
Workers run at edge — there are no per-region Workers; residency lives
in the data tier, not compute.

Reviewed against two independent consults (gpt-6-astra, gpt-5.6-sol);
both landed on the same model: **raw physical facts per operation +
separate grant ledger + regional transactional writes**.

## What already exists (no new build)

- `memory_ops.release_operations` — per-op receipts (action, units,
  period, account, space).
- `memory_ops.usage_events` — append-only ledger (pool, account, units,
  period). Note: `units` is already a *rating* (embeds today's weights:
  ingest=100, search=1) — it is not raw measurement.
- `memory_ops.usage_counters` — monthly units per pool (regional).
- `memory_ops.space_storage_counters` — per-space bytes gauge
  (trigger-fed). A gauge cannot price byte-hours; deltas need rows.
- `memory_control.pools` — plan, monthly_units, storage_limit_bytes,
  state. Quota catalog (control cluster).
- `memory_ops.provider_budgets` — platform AI cost cap (microusd/mo,
  control).
- `billing.ts` — Stripe checkout/portal/webhook, dormant under
  `managed-ai-metered`.
- `usage()` API — {plan, monthlyUnits, usedUnits, storageBytes, period}.

## Launch credits (no new code)

`pools.monthly_units` IS the credit balance. Set it high per plan at
provisioning (e.g. launch plan 100k units) — quota enforcement already
checks used vs monthly_units per calendar month.

## Gaps to close (ordered)

1. **Raw physical measurements per operation** — extend `usage_events`
   (or a sibling `usage_facts`) with the priceable dimensions, not just
   rated units: bytes_in/out, item counts, results_returned,
   embedding/extraction calls, provider+model, token types,
   observed microusd, outcome, timestamps, region, schema/rate-card
   version. Include zero-unit ops (delete/erase) and failed ops that
   consumed provider work. Counters stay rebuildable projections;
   events/facts stay the raw source of truth.
2. **Storage byte-hours** — the bytes gauge alone can't price
   byte-hours. The trigger already knows each delta; record timestamped
   delta rows (or retain the delta stream) so byte-hours are
   reconstructable.
3. **Credit grants ledger** — `memory_control.credit_grants`
   append-only: pool_id, units, denomination kind
   ('launch_promo'|'purchased'|'monthly_allowance'|'adjustment'),
   campaign, effective/expiry, idempotency key. Balance = quota +
   sum(grants) − usage; consumption order bounded (earliest expiry,
   then issuance). Keep gross usage, promo consumption, and provider
   cost as separate streams — promo credits must not contaminate
   real-usage analytics. Build before paid billing resumes; not needed
   at launch.
4. **Aggregation placement** — admission, reservation, settlement and
   counter updates in atomic regional transactions (authority is
   regional). Publish outbox-backed summaries to control for reporting
   only; control never co-writes regional counters. A strict *global*
   cap (e.g. provider_budgets) needs central reservation or
   preallocated regional slices — async rollups cannot fail-close a
   global limit. provider_budgets already lives on control for exactly
   this reason.

## What NOT to build

- No per-request raw event stream — request volume isn't billable
  units; the rate limiter bounds abuse.
- No usage rows on control beyond the catalog — regional usage stays
  in-region (residency).
- No Stripe work now — webhook machinery is complete and dormant.

## Open

- Future per-byte or per-token pricing: the raw `detail`/facts columns
  carry the inputs, so units can be re-derived retroactively under a new
  rate card.

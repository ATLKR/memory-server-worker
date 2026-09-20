# Residency verification + GA acceptance — P-7 evidence

Status: **partially evidenced** (2026-09-19). In-band residency facts are
proven; provider-console evidence for backup/object-store residency and
billing is still required before GA acceptance can be signed.

## What is proven in-band (SQL-observable, no console needed)

### sg — Neon `memoryservice-nonseoul`

Evidence: `residency-sg.json` (ops evidence store, outside repository).

- **Compute + durable storage in ap-southeast-1.** The endpoint hostname is
  `ep-lingering-pine-azosommb.c-3.ap-southeast-1.aws.neon.tech` and —
  stronger — `neon.pageserver_connstring` reports
  `pageserver-2.cell-3.ap-southeast-1.aws.neon.tech`: the pageserver that
  owns WAL and base backups is in the Singapore region. WAL never leaves
  the region in the Neon architecture (compute → regional pageserver →
  regional object storage).
- `branch_id br-silent-term-azdcvcc3`, `compute_id compute-icy-bonus-azem2fg8`,
  `endpoint_id ep-lingering-pine-azosommb` — stable identifiers for the
  console record.
- `data_checksums on`, `wal_level replica`, `archive_mode off` (Neon
  archives through the pageserver, not `archive_command`).
- `ssl off` on the compute — TLS terminates at Neon's regional proxy;
  the operator connection was verify-full to the endpoint.
- Database `memoryservice-nonseoul`, 13 MB.
- PostgreSQL 18.6 aarch64.

### kr-seoul — Supabase project `dnhcszbgdzgjpsktjaxn`

Evidence: `residency-seoul.json` + Management API facts (2026-09-19,
personal-account PAT from the vault).

- **Compute in ap-northeast-2 (Seoul).** Management API: project region
  `ap-northeast-2`, `ACTIVE_HEALTHY`, created 2026-09-11. Session pooler
  `aws-0-ap-northeast-2.pooler.supabase.com`. The `postgres` database is
  the deployment database.
- **Backup residency proven via API**: `database/backups` reports
  `region: ap-northeast-2`, `walg_enabled: true`, `pitr_enabled: false`
  (free tier — no PITR). In-band: `archive_mode on`,
  `archive_command /usr/bin/admin-mgr wal-push` — consistent.
- **Cost**: organization `Allen Labs` plan `free` → $0/month for the
  Supabase tier.
- `ssl on` at the compute, `data_checksums on`, `wal_level logical`;
  `ssl_enforcement` API reports enforcement `false` — non-TLS conns are
  not rejected provider-side (our connections are verify-full).
- Pooler CA is self-signed — pinned TOFU for rehearsal; production
  evidence needs the dashboard CA download.
- Database `postgres`, 15 MB. PostgreSQL 17.6 x86_64.

## Cut/integrity evidence (P-6, feeding the acceptance record)

Both regions passed the live sealed cut (`postgres-rehearse.mjs --run`)
on 2026-09-19 against a fresh `memory_rehearsal_cutover` database:

| | sg | kr-seoul |
|---|---|---|
| tables | 79 | 79 |
| rows copied | 37 | 198 |
| mismatches | 0 | 0 |
| freeze→verify | 104.9 s | 15.2 s |
| RPO | 0 | 0 |
| unfrozen | true | true |

Post-cut attestation as the runtime login on each target:
`attested:true`, `allDenialsHeld:true` (denials: `pg_authid`,
`pg_shadow`, public-schema DDL, `COPY TO STDOUT`, `ALTER SYSTEM`).

## Not yet evidenced (GA blockers)

1. **Neon durable-tier region** — the in-band probe proves the
   *pageserver* is in `ap-southeast-1` (WAL and base backups go there),
   but Neon's S3 cold-storage region is console/API-only. Needs a Neon
   API key (console.neon.tech → Account → API keys — not yet in vault).
2. **Neon plan/cost** — plan tier is not SQL-visible; needs the same
   API key or console evidence.
3. **Logs residency** — provider log pipelines (Neon logs, Supabase
   Logflare/drain config) are not SQL-visible on either side.
   Needs console evidence.
4. **Cloudflare Workers plan** — the $50/month budget includes the
   Workers tier; account billing facts need the CF dashboard or API.
5. **Control-plane placement** — open decision 4 in the re-platform plan
   (which region hosts it) is undecided; residency proof for the control
   tier can't start until then.
6. **Supabase dashboard CA** — the pinned pooler CA should be replaced
   with the dashboard-downloaded certificate for production attestation.

### Resolved since first draft

- ~~Supabase PAT~~ — personal-account PAT added to the vault resolves a
  valid `sbp_` token; Management API evidence collected 2026-09-19.
- ~~Supabase backup region + plan~~ — `backups.region: ap-northeast-2`,
  `walg_enabled: true`, org plan `free` ($0/month).

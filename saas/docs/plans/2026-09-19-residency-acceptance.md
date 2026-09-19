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

Evidence: `residency-seoul.json`.

- **Compute in ap-northeast-2 (Seoul).** Session pooler
  `aws-0-ap-northeast-2.pooler.supabase.com`; the project region was fixed
  at creation. The `postgres` database is the deployment database.
- **WAL archiving is active in-region path**: `archive_mode on`,
  `archive_command /usr/bin/admin-mgr wal-push` (WAL-G → Supabase-managed
  object storage). The archive *destination* region is a console item —
  see gaps.
- `ssl on` at the compute, `data_checksums on`, `wal_level logical`.
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

1. **Backup/object-store residency** — Neon durable tier region and
   Supabase WAL-G/PITR destination region are provider-side facts; the
   in-band probe proves the *pageserver/archiver path* but not the S3
   bucket region. Needs console screenshot or provider API output.
2. **Logs residency** — provider log pipelines (Neon logs, Supabase
   Logflare/drain config) are not SQL-visible. Needs console evidence.
3. **Cost ≤ $50/month** — neither project's plan/billing tier is
   SQL-visible. Needs billing-console or API evidence for: Neon plan +
   compute/storage sizing, Supabase plan, Cloudflare Workers plan.
4. **Control-plane placement** — open decision 4 in the re-platform plan
   (which region hosts it) is undecided; residency proof for the control
   tier can't start until then.
5. **Supabase PAT** — the vault's `SUPABASE_PAT` field holds a corrupted
   value (Korean label artifact); Management API evidence needs a fresh
   token.

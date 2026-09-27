# Provider attestation evidence (P-4/P-7 input)

Evidence gathered 2026-09-19 for the region→provider pairing pinned by
`src/postgres/region-app.ts` (`sg`→Neon, `kr-seoul`→Supabase). This is
documentation research, not live verification — nothing here satisfies a GA
gate by itself.

## Region availability

| Deployment | Provider | Provider region | Evidence |
|---|---|---|---|
| `sg` | Neon | `aws-ap-southeast-1` (AWS Singapore) | Neon regions doc lists `aws-ap-southeast-1`; endpoint hostnames embed `ap-southeast-1.aws.neon.tech`. |
| `kr-seoul` | Supabase | `ap-northeast-2` (AWS Seoul) | Supabase regions doc lists Northeast Asia (Seoul) `ap-northeast-2` as an exact-region choice. |

Neon operates no Seoul region — `kr-seoul` cannot be served by Neon. Supabase
supports both `ap-southeast-1` and `ap-northeast-2`, so the current pairing is
the only consistent one for these two regions.

## What the provider pin actually covers

**Neon (sg).** WAL is replicated across multi-AZ Safekeepers inside the
project region; Pageservers materialize into object storage. Neon documents
no cross-region replication for a project, so primary data and WAL stay
in-region by construction. Open: the object-storage bucket's region binding
is not explicitly documented — needs contractual/audit confirmation before
the strictest residency tier is claimed. Neon also offers no managed daily
backup export; PITR history lives in the same object store.

**Supabase (kr-seoul).** The exact-region pin covers the primary Postgres
database, the Auth service, and Storage objects. Supabase's own GDPR/residency
guidance is explicit that the pin does **not** cover: daily backups/PITR
snapshots ("a storage system independent of the Customer's project
resources", region undocumented), logs, Edge Function execution, and
sub-processors. The DPA commits to storing Covered Data "primarily" in the
directed region but preserves these carve-outs.

## Consequences for the residency classification

1. `kr-seoul` strict-residency tier (backups + WAL + logs in-region) is **not
   yet provable** on Supabase managed: backup storage location is
   undocumented. Options before GA for that tier: obtain written confirmation
   of backup placement from Supabase, or scope the strict tier to primary-data
   residency with documented backup handling (encryption + deletion
   semantics), or evaluate a BYO-cloud/self-hosted Postgres in ap-northeast-2.
2. `sg` on Neon needs the same confirmation for object-storage region, plus a
   documented restore story (PITR is in-place; there is no exportable daily
   backup to hold in-region).
3. Operator-access bounds are unevidenced on both providers — support-access
   scope, region of support staff, and audit logs need provider documents or
   contractual terms before residency claims.
4. Neither provider pairing should be advertised as residency-compliant until
   the above confirmations are on file; `data_policy` residency declarations
   stronger than "primary storage in region" stay unclaimed.

## Still required for the GA gate

- Written/contractual backup-and-log region confirmation per provider.
- Operator-access and sub-processor bounds per provider.
- Live acceptance per region (existing `GA_ACCEPTANCE.md` gates, extended to
  the PostgreSQL topology: attested regional session, control-plane session,
  enrollment round-trip, lifecycle journal apply).
- Cost evidence within the $50/month budget including Neon/Supabase spend.

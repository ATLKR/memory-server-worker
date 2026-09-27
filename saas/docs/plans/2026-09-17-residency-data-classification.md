# Residency data classification — P-0 freeze

**Status:** frozen inventory, 2026-09-17. Companion to
[`2026-09-16-postgres-regional-authority.md`](2026-09-16-postgres-regional-authority.md)
(the re-platform design, including the central-subject + regional-enrollment
identity amendment). This document classifies every D1 table in
`saas/migrations/0001–0036` into its two-tier destination. It is the
classification freeze required by phase P-0; changing a row here is a
design amendment, not an implementation detail.

## Buckets

| Bucket | Meaning |
| --- | --- |
| `control-plane` | Tier-1 cluster: globally unique routing/directory/billing-catalog/platform data only |
| `regional-identity` | Tier-2 `memory_identity`: account/org/email/membership/credential/PAT/grant/command/lifecycle rows owned by the enrolling region |
| `regional-space` | Tier-2: Space-scoped content, payloads, search, jobs, usage, ops |
| `dropped-projection` | Exists only for the retired D1→Seoul projection transport; not ported |
| `cross-border` | Inherently crosses regions; deferred to the separately-reviewed federation unit |

Split tables exist in **both** tiers: a minimal control-plane skeleton
(canonical id + status/placement fields only) and the full regional
authority row. Three tables are split: `accounts`, `organizations`,
`spaces`.

New tables the model requires (not ports): the **enrollment directory**
(`account_id`/`organization_id` × `region`, with enrollment state and
epoch) on the control plane, and the regional **apply-head** table for the
central lifecycle journal (per-region applied position — the v3
head-comparison pattern).

Audit normalization: every audit/event ledger table targets `memory_ops`
on whichever tier owns it — audit is ops evidence, not identity truth.

## Summary

| Bucket | Tables | Target |
| --- | --- | --- |
| control-plane | 14 (+3 split skeletons) | `memory_control`, `memory_ops` |
| regional-identity | 33 | `memory_identity`, `memory_ops` |
| regional-space | 27 | `memory_content`, `memory_search`, `memory_jobs`, `memory_ops`, `memory_control` |
| cross-border | 1 | deferred |
| dropped-projection | 47 | — |
| **total** | **122** (+11 views/virtual) | |

## Full classification

### 0001_schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| accounts | split: control-plane skeleton + regional-identity | `memory_control` (skeleton: id, disabled flag) / `memory_identity` | Canonical account-id registry central; full row regional |
| organizations | split: control-plane skeleton + regional-identity | `memory_control` (skeleton) / `memory_identity` | Same pattern as accounts |
| account_emails | regional-identity | `memory_identity` | Verified email claims bound to an account |
| memberships | regional-identity | `memory_identity` | Org membership with role/expires/revoked |
| credentials | regional-identity | `memory_identity` | Session/personal-key/api-key token digests and permissions |
| domains | regional-identity | `memory_identity` | Org-owned domain with verification window |
| domain_managers | regional-identity | `memory_identity` | Domain admin delegation to memberships |
| email_challenges | regional-identity | `memory_identity` | Pending email-verification token digests |
| email_consumptions | regional-identity | `memory_identity` | Challenge-consumption receipts creating claims |
| revocations | regional-identity | `memory_identity` | Self/domain email-revocation records |
| email_blocks | regional-identity | `memory_identity` | Blocked addresses emitted by revocations |
| audit_events | regional-identity | `memory_ops` | Identity-authority audit → ops ledger |

### 0002_memory-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| spaces | split: control-plane skeleton + regional-space | `memory_control` (both tiers) | Placement skeleton central; serving row regional |
| memories | regional-space | `memory_content` | Managed plaintext memory records |
| memory_versions | regional-space | `memory_content` | Archived revision history |
| memory_audit_events | regional-space | `memory_ops` | Space-scoped create/update/delete audit |

### 0003_product-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| provider_identities | control-plane | `memory_control` | SSO issuer/subject → canonical account-id binding; the only identity row that is central by design |
| workspace_sign_ins | regional-identity | `memory_identity` | Sign-in/session creation command records |
| workspace_organization_creations | regional-identity | `memory_identity` | Org creation command receipts |
| workspace_organization_metadata | regional-identity | `memory_identity` | Org display-name metadata |
| workspace_invitations | regional-identity | `memory_identity` | Email invitations to join an org |
| workspace_invitation_acceptances | regional-identity | `memory_identity` | Invitation acceptance receipts |
| workspace_key_issuances | regional-identity | `memory_identity` | Personal/API key issuance commands |
| workspace_key_metadata | regional-identity | `memory_identity` | Labels for issued non-session keys |
| workspace_membership_revocations | regional-identity | `memory_identity` | Membership revocation command receipts |
| workspace_key_revocations | regional-identity | `memory_identity` | Key revocation command receipts |
| workspace_audit_events | regional-identity | `memory_ops` | Workspace command audit → ops ledger |

### 0004_auth-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| auth_flows | regional-identity | `memory_identity` | OAuth/PKCE transaction state; sign-in is served by the regional endpoint |

### 0005_hierarchy-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| workspace_child_organization_creations | regional-identity | `memory_identity` | Child-org creation receipts |
| organization_hierarchy | regional-identity | `memory_identity` | Parent-child org edges |

### 0006_release-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| release_meta | control-plane | `memory_control` | Migration/version ledger |
| release_credential_policies | regional-identity | `memory_identity` | Capability + per-space grant arrays per credential |
| release_pools | control-plane | `memory_control` | Billing plan/subscription pool catalog |
| release_usage_counters | regional-space | `memory_ops` | Pool/period usage metering; coupled to `release_pools` across the tier boundary — quota checks read central catalog + regional counters |
| release_operations | regional-space | `memory_ops` | Idempotent memory operation requests |
| release_usage_events | regional-space | `memory_ops` | Per-operation billed usage events |
| release_space_policies | regional-space | `memory_ops` | Per-space retention-day policy |
| release_erasure_permits | regional-space | `memory_ops` | Erasure authorization permits |
| release_erasure_ledger | regional-space | `memory_ops` | Erasure completion log |
| release_events | regional-space | `memory_ops` | Generic action/audit events |
| release_jobs | regional-space | `memory_jobs` | Indexing/erasure job queue |
| release_vector_refs | regional-space | `memory_search` | Memory→vector-store id references |
| release_ingests | regional-space | `memory_content` | Ingest job row holding ciphertext/proposals — content-bearing, so content schema despite the jobs link |
| release_ingest_operations | regional-space | `memory_jobs` | Ingest→operation links |
| release_ingest_approvals | regional-space | `memory_jobs` | Ingest approval results |
| release_export_sessions | regional-space | `memory_ops` | Memory export session watermarks |
| release_shares | cross-border | deferred | Cross-account/cross-space access grants — federation unit |
| release_domain_challenges | regional-identity | `memory_identity` | Pending DNS proof challenges |
| release_scim_keys | regional-identity | `memory_identity` | Org SCIM API token bindings |
| release_webhook_events | control-plane | `memory_ops` | Raw provider webhook journal |
| release_checkout_requests | control-plane | `memory_control` | Stripe checkout session requests |
| release_billing_events | control-plane | `memory_ops` | Subscription billing event records |
| release_reauth_challenges | regional-identity | `memory_identity` | Re-authentication token challenges |
| release_external_email_blocks | regional-identity | `memory_identity` | Account-specific externally revoked addresses |
| release_mail_budget | regional-identity | `memory_ops` | Per-account daily outbound mail quota — travels with the account's region |
| release_billing_lock | control-plane | `memory_control` | Singleton checkout/billing lock |
| release_heartbeats | control-plane | `memory_ops` | Named process last-success timestamps; a regional instance likely needed for regional job runners |
| release_provider_revocations | control-plane | `memory_ops` | Provider-level subject/address tombstones — part of the central revocation surface |

### 0010_protocol-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| release_checkout_closures | control-plane | `memory_control` | Checkout session closure receipts |
| release_scim_deletions | regional-identity | `memory_identity` | SCIM-driven membership deletion log |

### 0012_lookup-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| release_fts_rows | regional-space | `memory_search` | Stable FTS rowid→memory mapping |

### 0014_tenant-queue-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| release_maintenance_progress | regional-space | `memory_ops` | Per-cluster maintenance cursor |
| release_fts (VIRTUAL) | regional-space | `memory_search` | FTS5 index over memories — replaced by the regional search mechanism (pgvector/postgres FTS decision is separate) |

### 0020_domain-verification-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| release_domain_verifications | regional-identity | `memory_identity` | DNS verification receipts + manager assignment |

### 0022_payload-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| release_payload_intents | regional-space | `memory_content` | Multi-item payload staging intents |
| release_payload_stage_accounts | regional-space | `memory_ops` | Per-account staging budget accumulator |
| release_payload_stages | regional-space | `memory_content` | Staged payload items before publication |
| release_payload_purges | regional-space | `memory_ops` | Pending object-purge queue |
| release_payload_retirements | regional-space | `memory_ops` | Pending object-retirement queue |
| release_payload_archive_permits | regional-space | `memory_content` | Payload archival permits |
| release_payload_archives | regional-space | `memory_content` | Committed payload archival records |

### 0023_operational-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| release_provider_budgets | control-plane | `memory_ops` | Provider cost reservation per month/kind |
| release_payload_backfill_progress | regional-space | `memory_ops` | Per-cluster backfill cursor |

### 0024_lifecycle-schema.sql

| Table | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| release_identity_lifecycle_jwt_proofs | control-plane | `memory_ops` | JWT proofs for lifecycle events |
| release_identity_lifecycle_events | control-plane | `memory_ops` | **This is the central lifecycle journal** the identity model requires — ordered events applied to regions with a per-region head |
| release_identity_lifecycle_state | control-plane | `memory_ops` | Current provider lifecycle state per subject/address |

### 0026–0036 seoul-projection schemas — all `dropped-projection`

47 tables, none ported. The regional-side SQL drafts in
`postgres/projection-v3/` keep their role/preflight/ACL patterns; the D1
transport state does not.

| Migration | Tables |
| --- | --- |
| 0026 | release_seoul_projection_state, release_seoul_authority_changes, release_seoul_authority_heads, release_seoul_prepared_sources, release_seoul_projection_events, release_seoul_targets, release_seoul_dirty_spaces, release_seoul_projection_lock, release_seoul_published_snapshots, release_seoul_projection_deliveries |
| 0027 | release_seoul_capture_attempts, release_seoul_capture_scope, release_seoul_capture_spaces, release_seoul_account_exclusions |
| 0028 | release_seoul_bootstrap_attempts, release_seoul_bootstrap_scope, release_seoul_bootstrap_spaces |
| 0029 | release_seoul_preparation_stage |
| 0030 | release_seoul_workspace_attempts, release_seoul_workspace_scope, release_seoul_workspace_spaces |
| 0031 | release_seoul_provider_operations, release_seoul_provider_attempts, release_seoul_provider_identities, release_seoul_provider_scope, release_seoul_provider_spaces, release_seoul_provider_groups |
| 0032 | release_seoul_command_attempts, release_seoul_command_scope, release_seoul_command_spaces |
| 0033 | release_seoul_provider_v1_attempts, release_seoul_provider_v1_identities, release_seoul_provider_v1_scope, release_seoul_provider_v1_spaces |
| 0034 | release_seoul_target_attempt, release_seoul_target_receipts, release_seoul_target_preparation_stage |
| 0035 | release_seoul_target_manifests, release_seoul_target_manifest_members, release_seoul_target_manifest_control, release_seoul_target_manifest_pages, release_seoul_target_manifest_steps, release_seoul_target_manifest_seals, release_seoul_target_manifest_completions, release_seoul_target_manifest_cancellations, release_seoul_target_manifest_attempt |
| 0036 | release_seoul_snapshot_stage |

## Views / virtual tables

| View | Bucket | Target schema | Notes |
| --- | --- | --- | --- |
| active_memberships (0001, redefined 0024) | regional-identity | `memory_identity` | Live-memberships view |
| active_credentials (0001, redefined 0012, 0024) | regional-identity | `memory_identity` | Live-credentials view |
| release_space_pools (0006) | regional-space | `memory_ops` | Derived space→pool mapping |
| release_memory_sizes (0006, redefined 0022) | regional-space | `memory_content` | Memory byte-size view |
| release_version_sizes (0006, redefined 0022) | regional-space | `memory_content` | Version byte-size view |
| release_fts (VIRTUAL, 0006 + 0014) | regional-space | `memory_search` | FTS5 index — postgres FTS/pgvector decision separate |

## Ambiguity resolutions

| Table | Resolution | Reasoning |
| --- | --- | --- |
| spaces | split | Directory skeleton is the placement record (central); the serving row with name/mode stays regional — both already described in the design |
| provider_identities | control-plane | The subject binding is exactly the "central SSO subject" of the decided model; regions need no copy since sessions are minted regionally |
| release_identity_lifecycle_* | control-plane | Already shaped as an ordered JWT-proofed journal — becomes the central lifecycle journal feeding regional apply-heads |
| release_pools vs release_usage_counters | split across tiers | Catalog central, counters regional; quota enforcement is a documented cross-tier read, not a reason to merge |
| release_maintenance_progress / release_payload_backfill_progress | regional-space | Per-cluster operational cursors — each region runs its own maintenance |
| release_ingests | memory_content | Holds ciphertext/proposals — content residency rules apply to the payload, not the job link |
| release_mail_budget | regional-identity → memory_ops | Per-account quota travels with the account's region; schema is ops (budget), not identity truth |
| release_heartbeats | control-plane → memory_ops | Central process heartbeats; regional runners get a regional instance when they exist |
| audit_events / workspace_audit_events | memory_ops | All audit ledgers normalize to ops schema on their owning tier |

## Out of scope here (decided elsewhere)

- `release_shares` federation design (cross-border unit).
- Vector store choice per region (pgvector vs external).
- The `data_policy`/`home_region` columns on the central `spaces` skeleton
  and the enrollment-directory DDL — P-2 schema work.

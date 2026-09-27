# Inactive protected provisioning and retained dispositions

`provisioning-foundation.sql` is explicitly loaded local SQL after installed schema 1–5 and the inactive head foundation. It requires an existing operator permitted to `SET ROLE memory_owner`. It creates no role, membership, login, deployment/approval seed, migration marker, public entry, snapshot apply, positive identity, provenance, grant or lease. It changes no installed migration, validator, existing function body, policy or privilege.

The two tables install empty, including when `deployment_identity` is empty. Their only FKs point to that immutable singleton; no positive Space is needed for provisioning. PostgreSQL necessarily adds **four internal RI triggers to the existing deployment table**, the UPDATE/DELETE pair for each new FK. Tests permit only those exact constraint-associated additions and pin every preexisting trigger OID/definition. Existing parent guards still prohibit ordinary deployment mutation. “Preserved existing surface” does not mean its complete trigger inventory is unchanged.

## Protected records

All IDs use existing `memory_control.identifier` (ASCII 1–256) except Space IDs (same grammar, 1–128). Epochs are integer 0–9007199254740991. UUIDs are native PostgreSQL UUID values. No operational quota has a default.

Both tables have these approval/deployment columns:

| Columns | Meaning |
| --- | --- |
| `approval_id`, `approval_reference` | UUID identity and bounded identifier for the explicitly reviewed manifest. UUID is unique per table. A caller's reference is audit information, never a capability. |
| `approved_at_ms`, `approved_by_session` | Database clock epoch and real `session_user`, always overwritten in the insert trigger. Neither is an authorization assertion or lease. |
| `deployment_singleton` | Required 1, FK to the existing deployment singleton. |
| `deployment_id`, `storage_region`, `processing_policy_id`, `deployment_created_at_ms` | Exact supplied tuple must equal the existing singleton, with region `kr-seoul` and supported processing policy ID `kr-primary-storage-v1`. No inferred deployment ID or timestamp. |

`memory_ops.identity_projection_space_provisioning` adds primary-key `space_id`, exact `data_policy`, `source_byte_limit` (0–67108864 bigint), and `message_limit` (1–100000 integer). These are the old storage domains, not recommended rollout quotas. Before approving an already existing Space, its deployment, policy and both limits must equal the proposed provision. No quota or policy adjustment occurs. A provision may precede a Space; a later disposition rechecks exact deployment/policy/limits rather than assuming that later creation followed the approval.

The policy is a closed object with exactly:

```json
{"policyVersion":1,"residency":"kr-seoul","profile":"kr-primary-storage","processingBoundary":"approved-processors","dataClass":"personal","classificationStatus":"declared","sensitivityTags":[],"placementEpoch":1}
```

Only `sensitivityTags` may vary: a strictly ASCII-sorted, duplicate-free subset of `clinical-origin`, `credential`, `government-id`, `health`. `clinical-origin` requires `health`; at most four tags. Exact JSONB equality is local evidence comparison, not canonical transport hashing.

`memory_identity.identity_projection_retained_dispositions` has primary-key `approval_id`, the common columns, and:

| Columns | Closed shape |
| --- | --- |
| `entity_kind` | account, organization, provider_identity, email, membership, credential, space or legacy_grant. |
| `entity_id` | Required only for the six ID kinds; all composite locator columns then null. Space additionally uses its 128-character grammar. |
| `issuer`, `subject` | Required only for provider_identity; every other locator column null. Issuer is exactly `https://auth-api.allen.company`. Subject is preserved, nonblank under the reviewed JavaScript whitespace set and at most 512 UTF-16 code units. PostgreSQL UTF-8 text/JSONB cannot represent NUL or unpaired surrogates. Newlines, permitted controls, quotes, backslashes, BMP and astral characters remain opaque. |
| `credential_id`, `space_id` | Required only for legacy_grant; every other locator null. |
| `disposition` | Exactly `adopt_exact_binding`. No wildcard, withdrawal or inferred allow. |
| `retained_basis`, `authorized_binding` | Two explicit, complete closed schema-5 row objects. Their combined JSONB text representation is at most 131072 UTF-8 bytes; finite per-kind shapes make ordinary rows substantially smaller. They are not canonical wire envelopes. |

Partial unique indexes enforce one record per `(entity_kind,entity_id)`, provider `(issuer,subject)`, or grant `(credential_id,space_id)`. Provider locators use the real tuple, not an invented ID, escaped JSON key or opaque hash. Duplicate identity/approval attempts raise a fixed conflict and cannot refresh audit fields.

## Exact retained row compatibility

The caller supplies the full basis and first-adoption result. The trigger compares the basis to the actual locked row; it never constructs an approval by copying that row. All columns below are required, including explicit nulls. Immutable fields and preserved regional fields must be equal between basis and target. Only the listed projection fields may change in the target; **inserting a disposition does not change any retained field**.

| Kind | Complete basis and target keys | Permitted target differences |
| --- | --- | --- |
| account / organization | `id`, `disabled_at` | None. |
| provider_identity | `issuer`, `subject`, `account_id`, `created_at` | None; all actual provider columns are immutable. |
| email | `id`, `account_id`, `address`, `domain`, `verified_at`, `revoked_at` | None. Address uses exact canonical ASCII mailbox grammar, at most 254 characters; local part at most 64, domain labels at most 63, no adjacent/leading/trailing local dots. Domain is its exact suffix. No normalization or refreshed verification time. |
| membership | `id`, `organization_id`, `account_id`, `email_id`, `role`, `expires_at`, `revoked_at` | Only role (owner/admin/member) and expiry. |
| credential | `id`, `account_id`, `membership_id`, `email_id`, `kind`, `token_digest`, `expires_at`, `reauthenticated_at`, `revoked_at`, `permission` | Only read/write permission and expiry. Personal keys have null member/email; API keys have both. Session credentials are unsupported. Preserve `reauthenticated_at` verbatim. |
| space | `id`, `owner_account_id`, `organization_id`, `deployment_id`, `data_policy`, `disabled_at`, `source_byte_limit`, `message_limit` | None, including quotas in this slice. Exact owner-account XOR organization. Require matching provision and existing usage row. |
| legacy_grant | `credential_id`, `account_id`, `space_id`, `can_ingest`, `can_search`, `expires_at`, `revoked_at`, `can_erase`, `can_retire` | Only ingest/search and expiry. Preserve `can_erase` and `can_retire` exactly, even when true. |

Every applicable disabled/revoked field in both objects must be null. An actual retained negative cannot match a positive basis and cannot be cleared. Expiry is a mutable source fact, not a permanent revocation; the future apply still needs the exact authorized target, current complete source proof and live signed deadlines.

The actual retained row supplies the complete primary/unique/composite binding enforced by schema 5, including credential digest/account/member/email and grant credential/account/Space. A substitute target cannot move it to another account, email, organization, credential or Space. New ID creation, collision reconciliation and changes to existing uniqueness/FKs are outside this slice.

An account disposition requires at least one existing canonical-issuer mapping through the existing account index. This **does not prove a complete mapping set**. The future candidate-dependent apply must inspect all retained mappings, reject omitted/foreign mappings, and require the complete supplied subject/email head vectors. No subject is fabricated for an unmapped account.

For a retained Space, keep all actual usage counters: `source_bytes`, `message_count`, `retained_source_bytes`, `retained_message_count`. A missing usage row prevents disposition; no counter is inferred or reset. No archive or meter data is touched. Snapshot policy/scope/capabilities, source identities, and positive authority are never derived from an approval.

## Transactions and privileges

1. A BEFORE STATEMENT INSERT trigger requires actual `current_user=memory_owner` and locks the existing singleton projection fence `FOR UPDATE` before any retained-row read/lock. Inherited-only owner privileges do not satisfy this direct setup context. This is not a replacement for the separate real-role proof required by a future operator entry.
2. The BEFORE ROW trigger validates closed data, exact existing deployment, uniqueness and full basis/target compatibility, using fixed per-kind SQL and existing row locks. It stamps clock/session audit fields. No input chooses SQL identifiers or statement text.
3. The AFTER STATEMENT trigger reads **at most two transition rows** using `LIMIT 2` and requires exactly one inserted row. Zero and multiple inserted rows fail atomically. A manifest can explicitly enumerate single-row statements in a transaction; no automatic enumeration/import function is supplied. A later failure rolls back all its inserts.
4. BEFORE STATEMENT UPDATE/DELETE/TRUNCATE guards always reject, including no-op and zero-matching/hidden-row statements. No update policy exists. No mutable “consumed” bit, replacement, UUID-based duplicate workaround, revision or withdrawal exists.

Both tables are owned by `memory_owner`, with ENABLE and FORCE RLS. Each has exactly owner SELECT, owner INSERT and projection-owner SELECT policies. Only the projection owner receives column SELECT on decision-bearing fields: approval ID, complete deployment tuple, locator, policy/quotas or disposition/basis/binding. It receives **no SELECT** on manifest reference or audit time/session, no table-wide SELECT and no setup-table DML/lock-only UPDATE. Immutable setup reads use its existing global fence; no setup-row `FOR SHARE` grant is added.

PUBLIC, projection caller, runtime/background, commands/lifecycle, and any existing anon/authenticated role receive no new capability. The four new shape/trigger helpers are owned by `memory_owner`, SECURITY INVOKER, with `search_path=pg_catalog`; no projection/runtime/helper EXECUTE is granted. Existing pure snapshot/head helpers and their ACLs remain unchanged. Table owner/superuser DDL remains trusted: these guards do not defend against deliberately replacing a function, changing RLS or disabling a trigger.

Installation revokes PUBLIC and enumerates every non-owner ACL grantee on exactly the two new tables and four new helpers, including arbitrary runtime logins or groups named by retained global or schema-specific owner defaults. It revokes ALL on those fixed objects from each catalogued role using identifier quoting, then grants only the intended projection decision columns. It creates no role and changes no old-object ACL, default ACL or membership edge. Existing owner/superuser and legitimate owner-role membership remain trusted. RESTRICT aborts installation if an unexpected dependent grant prevents this closure. The two optional API roles need not exist. Focused tests exercise both API roles, the actual runtime login, a quoted role name with inherited login access, and grant options; exact ACL inspection also covers version-specific privileges such as MAINTAIN. Prior/default surface checks remain exact. PostgreSQL documents the catalogue decomposition in [aclexplode](https://www.postgresql.org/docs/18/functions-info.html) and privilege/option removal in [REVOKE](https://www.postgresql.org/docs/18/sql-revoke.html).

Custom guard failures have fixed messages without input-bearing DETAIL/HINT:

| SQLSTATE | Message | Meaning |
| --- | --- | --- |
| `PP004` | `seoul_projection_setup_invalid` | Invalid explicit shape/domain, non-owner effective context, or zero/multiple inserted rows. |
| `PP005` | `seoul_projection_setup_conflict` | Missing or mismatched deployment/retained basis/provision/usage/mapping prerequisite, duplicate identity, or forbidden target binding. |
| `55000` | `memory_immutable_record` | Any ordinary UPDATE, DELETE or TRUNCATE statement. |

These are private direct-SQL guard errors, not snapshot receipts. Native PostgreSQL SQL parsing and typed parameter conversion can fail before a trigger, and lack of capability produces native permission denial. The later operator boundary must validate/sanitize those failures before exposing or logging caller-supplied content; this foundation supplies no public/error-translation entry and does not widen UUID/domain columns to text to conceal that distinction.

## Required later integration

The sole write-once row is the only approval for its key. A stale retained basis cannot silently be replaced or fall back to historical approval. First successful apply must recheck the full basis, exact authorized target and all independent positive prerequisites under the fence, then atomically record creation versus adoption, the precise disposition approval ID and consuming event/hash/source/Space/sequence/head evidence. Pending or failed apply must create no provenance or authority. Subsequent v3-owned mutable changes require separately reviewed monotonic global source-fact provenance; a Space sequence alone cannot order a credential shared by two Spaces.

Persist the exact provisioning approval reference in eventual Space/grant generations. Gate reads must compare current Space deployment/policy/quotas with that provision. Before adding any revision/correction/withdrawal facility, implement immutable approval versions, explicit current-active references, references in applied generations/provenance and SHARE-fence admission comparison. Operator changes take the UPDATE fence and invalidate mismatched already-applied authority before lease expiry. No such facility or gate is implemented here.

Ordinary v3 grants retain false erase/retire in their immutable per-Space generation and gate. They must not overwrite the retained legacy operator flags. Retained credential reauthentication is preserved; truly new credential creation later starts with null, not a fabricated interactive event. Capability/scope and complete head vectors remain per-generation facts, never global mutable policy shared across Space leases.

A zero-grant snapshot requires no positive provisioning/disposition and creates/adopts no positive row or usage. Its eventual empty sequence/receipt is independent of these tables. Head apply still creates no positive authority. Exact receipt replay/status/lease semantics and the adopted closed snapshot outcomes are unchanged.

Focused tests use disposable actual PGlite with schema 1–5, the head foundation and pure snapshot validator. They cover exact old-row/function/ACL/role/policy/trigger preservation with the four specifically identified FK-trigger additions, full actual retained shapes, real role denials, statement atomicity, maximum Unicode/mailbox boundaries and locks. A disposable restrictive RLS observer verifies the fence relation lock is already present when the first retained account read occurs. This is single-session local evidence, not PostgreSQL 17.6 provider verification, independent-session blocking/deadlock proof, production setup authority or rollout readiness.

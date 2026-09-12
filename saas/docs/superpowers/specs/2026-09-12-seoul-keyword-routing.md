# Seoul storage and keyword routing

The Seoul route currently couples storage admission to a `pgvector` target in the
strict v1 protocol. A PostgreSQL service that can store transcripts and search
literal terms must be able to describe those capabilities without claiming an
embedding model or semantic index is available.

## Scope

Introduce an explicitly configured Seoul v2 client/plugin contract. Keep v1
configuration, plans, discovery and omitted search-mode behavior compatible.
General memory continues to use the existing Cloudflare managed route. This
change does not install a database migration, activate an endpoint, create a
runtime credential or make a GA declaration.

Supabase Seoul supplies database storage and SQL execution in Seoul. The
`kr-primary-storage / approved-processors` profile can use a Cloudflare Hono API.
An explicit requirement that ingress or processing remain in Korea still needs
its own verified execution boundary. Discovery metadata is not proof of physical
residency or authorization.

## Contract

- The operator selects `memory-routing-v2` for a Seoul endpoint. Unset settings
  keep v1. The selection is never a tool argument and does not change origins,
  selected Space or credential audiences.
- V2 placement has version 2, route `seoul`, storage `postgres` and requiredRegion
  `kr-seoul`. It has no vector field. Reuse the same classification, inherited
  restriction and medical-consent route decision as v1.
- Discovery uses `/.well-known/memory-routing-v2` on the configured origin, with
  no credential or content. The strict manifest advertises readiness, ingest,
  keyword search and semantic search independently of placement. In this first
  version semantic must be false; future activation requires a reviewed model
  generation contract. A foundation-only service advertises no content capability.
- There is one chosen endpoint and no protocol, region or origin fallback.
  Existing limits, no-store, redirect rejection, input snapshots, deadlines and
  cancellation also apply to v2 discovery and content requests.
- V2 omitted search mode means keyword and is sent explicitly. An explicit
  semantic request fails before credentials or content are dispatched. Explicit
  modes on v1 are rejected; omission retains existing v1 behavior. Both general
  and medical Cloudflare server paths also reject unsupported modes rather than
  accepting and ignoring them.
- A v2 search response must confirm keyword execution and contain bounded,
  source-backed matches tied to the selected Space and stable memory/revision
  identifiers. Reject missing/wrong mode and malformed successful responses.
  Discovery is not a grant: a future server must authenticate and revalidate
  current authority, residency and capability at operation execution.
- Plugin local planning requires neither a credential nor a network request.
  Its Seoul protocol setting is opt-in. Standalone artifacts are regenerated
  through the existing build script, never edited by hand.

## Acceptance

Exercise a local Hono fixture and actual routing client: keyword-only discovery
admits supported operations; semantic and unavailable capabilities cause zero
credential callbacks and zero content dispatch; malformed metadata and responses
fail closed; expiry, cancellation and caller mutation cannot change the target or
operation. Preserve v1 fixtures, Cloudflare medical consent/restrictions and plugin
configuration behavior. Typecheck the exported v1 API contract, run the focused
client/server/plugin tests, rebuild/check the artifact and run the complete SaaS
suite before integration.

Actual PostgreSQL authority, canonical content, transcript archives, lexical
queries, quota/metering, deletion, SSO/PAT lifecycle and regional recovery remain
separate serving work. A local fixture proves this protocol, not an operational
Seoul backend.

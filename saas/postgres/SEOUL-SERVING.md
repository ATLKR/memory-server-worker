# Seoul PAT archive service

This package implements a native PostgreSQL archive and keyword-search path for
an explicitly selected Seoul Space. It now has a standalone fetch-only Hono
Worker composition, but no route or deployed origin selects it. Source tests do
not enable a provider, install migrations, provision a runtime login, or
establish GA acceptance.

## Storage and processing policy

Supabase Seoul supplies database storage and SQL execution in Seoul. This path
accepts only the fixed `kr-primary-storage` profile with
`processingBoundary: approved-processors`, under deployment policy
`kr-primary-storage-v1`. Application request processing may run outside Seoul
when that policy permits it. A Space requiring Korea-only ingress, application
processing or inference needs a separate regional execution deployment. The
`medical-strict` profile is not silently downgraded to storage-only semantics.

The current product preference remains Cloudflare for general memory and
approved managed Agent Memory ingest. This module does not activate Neon as a
general default, send data to Cloudflare, perform classification, or invoke an
embedding model. Its selected Space policy is checked in SQL; caller routing
metadata cannot override it. Medical overseas-processing consent in routing
metadata does not change the native Space policy.

## Composition and protocol

Trusted deployment code constructs `createSeoulRepository` with an explicit
Supabase Seoul transport, expected origin database/login/deployment identity,
the six private schemas and schema version 4 or 5. Version 5 explicitly enables
the lifecycle commands below; version 4 keeps the archive/search contract. It passes that repository to
`createSeoulApp`. Neither constructor discovers ambient credentials or falls
back to another backend. `title` supplies renameable product branding.

`src/postgres/seoul/worker.ts` is the route-free schema-5 composition.
Activation requires `MEMORY_SEOUL_ENABLED=true`. Native compatibility mode
(`MEMORY_SEOUL_TRANSPORT=native`, also the legacy default) uses a separate bounded
`MEMORY_SEOUL_RUNTIME_PASSWORD` secret and a trusted
`MEMORY_SEOUL_TARGET_JSON` scalar containing only host, port, database, user,
expected role, deployment ID and direct or session-pooler mode. Provider,
`kr-seoul` region, the six schemas and `kr-primary-storage-v1` policy are fixed
by source. Missing, accessor-backed or malformed configuration stays unready
without opening a client. An optional bounded `MEMORY_SEOUL_TLS_CA` supplies a
reviewed CA for local native transport testing; the native client requires
certificate verification. This composition carries no enrollment, migration, operator,
scheduled or queue handler.

`MEMORY_SEOUL_TRANSPORT=hyperdrive` selects a first-class Hyperdrive transport.
Its `MEMORY_SEOUL_TARGET_JSON` contains exactly `database`, `expectedRole`, and
`deploymentId`, and `SEOUL_HYPERDRIVE` is a generated Workers `Hyperdrive` binding.
The composition snapshots six own primitive binding fields and rejects native
password/CA bindings in this mode. Proxy startup identity is checked against
that snapshot. The same transaction then independently checks the origin
database and role, deployment, schema and privileges before every operation.
Both transports use one client and one bounded transaction per operation, with
unchanged exact numeric parsing, uncertain-COMMIT handling and no retries.

The binding connection string must contain the runtime's exact
`?sslmode=disable` proxy parameter, with no other parameters or fragment.
This describes the in-runtime Worker-to-Hyperdrive connection. The Hyperdrive
origin must separately use `verify-full` and the approved CA certificate.
See [the runtime binding implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/hyperdrive.c%2B%2B)
and [origin TLS configuration](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates/).

Deployment requires provider read-back proving `caching.disabled === true`, the
exact Supabase Seoul direct origin, runtime role, database, approved CA and
`verify-full` mode. Zero cache durations, mock bindings or a local development
connection do not prove this configuration. Keep provider credentials outside
Worker bindings and public configuration. After deployment, exercise current
PAT revocation and data freshness through the real bound endpoint.

Workerd tests verify module loading, disabled behavior and real binding shape
without making a database connection. PGlite tests execute the Hono/repository
contract under distinct proxy and origin identities. These tests do not prove
provider networking, origin TLS, remote Hyperdrive caching, production routing
or public readiness. Fresh synthetic authority acceptance and central SSO
projection remain required for product serving.

The application exposes:

| Request | Behavior |
| --- | --- |
| `GET /.well-known/memory-routing-v2` | Fresh repository/privilege check; advertises archive ingest and keyword search only when enabled and ready. Semantic search remains false. |
| `POST /mcp`, `x-memory-routing: 2` | Native PAT authentication followed by the MCP SDK's initialize, ping, tool discovery and tool-call handling. |
| `memory_ingest` | Saves the complete accepted transcript verbatim and returns archive metadata. It performs no AI extraction. |
| `memory_search` | Literal NFC-normalized substring search with ASCII case folding; returns stable message IDs, revision 1 and original excerpts. Explicit semantic requests are rejected. |
| `memory_archive_erase` (v5) | Removes one archive's active source rows and identifying source metadata under explicit erase authority; returns a revision-bound receipt. |
| `memory_space_retire` (v5) | Closes the selected Space after its retained source is erased; requires a separate retirement grant. |
| `memory_pat_revoke_self` (v5) | Revokes only the PAT authenticating the request. |
| `memory_lifecycle_status` (v5) | Reads an archive state/revision or the current actor's erase receipt under fresh authority. |

The existing routing client can select this origin with
`protocol: memory-routing-v2`. A credential and Space belong to that selected
origin. V1 remains separate; this application does not mount the old Worker,
management UI, SSO callbacks or other product tools.

Bearer tokens are hashed in memory. Authentication happens before reading the
request body, and the content command independently checks current authority.
The endpoint accepts at most 2 MiB of JSON, 500 messages, 32 KiB per message and
1 MiB of total source text. It rejects NUL, unsupported fields and malformed
timestamps. Accepted message text, ordering, timestamp spelling and session ID
are preserved. Search returns at most 50 excerpts, each bounded to 2 KiB UTF-8.

## Native authority and transaction boundary

Migration 0004 adds Space policy, explicit PAT-to-Space grants, archives,
messages, usage and meter tables. Runtime has metadata SELECT and EXECUTE on
three fixed commands. `memory_commands` is a separate NOLOGIN, non-owner role
with narrowly granted table/column privileges. Private helpers have no runtime
EXECUTE grant. The new tables use forced RLS. Runtime checks reject drift in
roles, memberships, schemas, table/column/function grants, RLS policies, the
deferred expiry trigger and migration names. Installation/preflight must
separately pin function bodies and constraints to reviewed source hashes.

Each content command checks the current account, PAT, grant and exact Space under row
locks. Organization PATs also require the exact organization, current membership
and verified email. Owner/admin membership is required for organization ingest;
members may search if their PAT and Space grant allow it. Personal PATs can use
only their owner's personal Space. Parent organizations confer no permission.
Preauthentication is not reusable authorization for later content operations.

Archive insertion, source-byte/message-count quota updates and one logical
meter event commit together. The per-Space usage row serializes writes. A
repeated operation ID returns only the existing receipt when the canonical
JSONB request and actor match and current authority still permits the command.
A changed request or actor conflicts. Replay does not create another archive
or meter event. The meter measures source bytes and message count, not provider
disk usage or billing. Empty messages still consume the message quota.

Migration 0005 adds a separate NOLOGIN `memory_lifecycle` role and explicit
`can_erase`/`can_retire` grants, both false by default. Erasure removes message
rows, session/routing metadata, original ingest operation text/digest and precise
ingest timestamps. It preserves a minimal archive tombstone, actor/Space
references, operation-key hash and cumulative meter quantities; these references
are not anonymous. Retained counters decrease once without refunding cumulative
quota. An old ingest operation cannot recreate an erased archive.

Erase receipts report active primary-row removal, not physical media or backup
purge. There is no native restore command. Already admitted reads may finish;
retirement and self-revocation prevent subsequent ordinary requests. If their
acknowledgement is lost, an administrator must reconcile the original operation
manifest through metadata reads. The closed Space or revoked PAT cannot authorize
its own retry/status request. See [the lifecycle SQL contract](SEOUL-LIFECYCLE-SQL.md)
for exact inputs, replay behavior and retained data.

An admission lasts at most 30 seconds and is capped by credential, membership
and grant expiry. The repository includes connection/lock/commit time in that
budget, retains an unforgeable in-process lease on the original result, and
checks it immediately before response disclosure. Hono also enforces its
request deadline independently of timer scheduling. An expired result is not
sent. A dispatched write whose completion cannot be safely reported returns
`operation_outcome_unknown` with its operation ID; there is no automatic retry.

The initially deferred archive trigger checks expiry at the fixed repository's
COMMIT. This is not a guarantee against an arbitrary compromised SQL client:
PostgreSQL lets such a client force deferred constraints early. Runtime
credentials must remain private to the fixed repository transaction, which
never changes constraint mode. Unknown outcomes require reconciliation before
any repeat attempt; confirmed rollback and confirmed commit remain distinct.

## Installation and release gates

Migrations 0001–0004 retain their original source. Apply each new migration through a reviewed incremental
operator that verifies the existing foundation and reviewed source, temporarily
permits the provisioner to create the command role and SET the migration owner,
and restores those permissions after commit or rollback. Do not rerun the empty
foundation installer, recreate reserved schemas, or substitute a privileged
provider login for runtime. Keep all six schemas out of the Supabase Data API.

Before activating a real endpoint, finish and record:

- Actual provider migration rehearsal, exact catalog/source verification,
  least-privilege runtime login, verified TLS/pooler behavior and independent
  native-client concurrency/expiry tests.
- Approved ingress and application execution deployment, real PAT onboarding,
  supported central SSO/lifecycle projection, and production routing verification.
- Live verification of the v5 erasure/lifecycle commands, regional retention and
  restore/quarantine handling. Marker-only search exclusion does not prove source
  deletion, and active-row erasure does not prove backup or physical media purge.
- Regional backup/recovery evidence, operating alerts and the invite-based,
  metered GA budget/acceptance checks. PostgreSQL source completion does not
  establish production D1 cutover or complete managed Agent Memory recovery.

## Verification

From `saas`, run `npm run test:postgres` and `npm run typecheck`; the full
`npm run check` also covers the existing product and routing contracts. Native
engine tests execute SQL, forced RLS and actual catalogs through PGlite,
including routing-client ingest/search and Hono → native-repository lifecycle tests.
Failure cases cover payload conflict, quotas, revocation, invalid policy,
partial-write rollback, delayed COMMIT and final response expiry. PGlite is not
evidence of provider networking, real TLS, independent sockets or deployment.

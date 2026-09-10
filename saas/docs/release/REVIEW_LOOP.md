# PR #22 independent review loop

Requested on 2026-09-09: review the full PR with fresh agents, fix every confirmed
actionable finding including minor errors, and repeat on the corrected source.
Reviewers receive the requirements and checkout, not earlier reviewers' reasoning.
This is a record of review evidence, not proof that software has no possible bugs.

Base: `8b5a9bbe9e815c6e75ff811b4073e038394dfaf1` (`master`).
Starting PR head: `8ca8944d639c4c2fb709cd0f71a07e1f41568770`.

## Current source verification, 2026-09-10

The candidate is rc.4, schema 21. The entries below this section are chronological
checkpoints; their then-pending findings are superseded by later corrections.
Confirmed findings, including minor tooling and presentation defects, were
reproduced and corrected. Final independent review status:

| Assigned scope | Fresh review | Actionable findings |
| --- | --- | --- |
| Authentication and administration | Authentication19 | 0 |
| Storage, retrieval and background processing | Storage20 | 0 |
| Both consoles, clients and maintained documentation | Console22 | 0 |
| Cross-domain recovery after a lost mutation response | Recovery4 | 0 |
| Generated Unicode tooling and Windows checkout | Tooling1 | 0 |

The loop has launched 66 separate fresh sessions: 16 built-in agents and 50
ephemeral, read-only CLI sessions. Supporting implementation owners and their
secondary checks are not counted as fresh reviews. This is a session count,
not a defect count. Assigned runtime domains are frozen after their final review;
later additions are independently reviewed tooling or verification documentation.

Final local validation passes 1,410 tests (208 foundation, 1,196 release and six
client/template), strict typechecking, all 21 source/migration comparisons and
the seven frozen deployed hashes. The full native command passes the build,
populated upgrades 5–21, all bundled D1 scenarios including the final Unicode
search cases, six real-clock admission cases, ten domain/proof/cleanup cases and
seven authentication/HTTP cases. The dependency audit reports no known
vulnerabilities. The PR checks and linked handoff report identify the eventual
commit and its separate GitHub Actions results.

The 51-case lexical evaluation retains recall@5 0.62, MRR@5 0.59, zero forbidden
or stale hits and one negative-query false positive. This is synthetic lexical
quality evidence, not a semantic or performance acceptance claim. Production
remains the recorded rc.3 Worker with migrations 1–7; this review does not deploy
rc.4 or apply remote migrations. External client, provider, load and recovery
acceptance gates remain documented in [INTEGRATION.md](INTEGRATION.md).

## Round 1

Three fresh reviewers independently inspected authentication/administration,
storage/search/jobs/transfers, and browser/client/MCP behavior. The coordinator
checked deployment, CI and documentation. Confirmed findings:

| Finding | Correction |
| --- | --- |
| Organization members could not issue read-only PATs | Read issuance retains exact live membership/email binding; non-read capabilities still require owner/admin |
| Later embedding chunks could be sent after source mutation or erasure | Recheck the canonical live revision after each lease renewal, before another provider call |
| Competing memory successors produced HTTP 500 | Return `409 revision_conflict`; retain the atomic winner and retry receipt |
| Another tab's account switch could attribute an old draft to the new account | Bind each console's request intent to its displayed account; reject mismatches before executing the request |
| Original editor's legacy key dialog could not complete the recent-proof PAT flow | Direct hosted PAT issuance to the scoped management flow; keep existing key revocation |
| Explicitly scoped personal PATs could not select accepted organization shares | Permit read-only scope for independently accepted shares; organization membership alone still requires an organization PAT |
| Current instructions contained obsolete status, limits and nonexistent ZIP tools | Correct README/runbook/API instructions and clearly separate historical verification |

Regression tests reproduce the code defects before their fixes. Native D1
coverage additionally checks supersession error mapping, member PAT issuance and
the account-intent boundary. Applied migrations 1–7 remain byte-frozen.

## Follow-up review and verification

The fresh follow-up round identified additional provider-boundary defects:

- A changed or erased revision could be newly upserted after an intervening D1
  write; final provider checks must combine the live revision and job lease.
- Canonical indexing must stop for a disabled owning account/organization.
  It remains independent of the lifetime of the member who wrote the memory.
- Extraction jobs exhausted after five failures still appeared queued; the API
  must expose failure, preserve cancellation, and reflect an authorized retry.
- Accepted multibyte product names could exceed an inconsistent mail byte limit.
- Billing checkout/portal could call providers while background processing was
  disabled and the console correctly reported billing unavailable.
- The original editor could overwrite edits typed while a different memory's
  detail request was pending; its response now checks the edit generation.
- Literal dollar sequences in configured branding were interpreted as string
  replacement patterns; callbacks preserve the exact configured text.

The next fresh round corrected these additional findings:

- Billing configuration must use the same complete availability predicate for
  discovery, readiness and admission; redirects must use the configured/default
  service origin.
- Ingestion submission replay must return persisted effective state, and manual
  retry must atomically reject cancelled, expired or source-less ingestion.
- Branding must replace original template markers in one pass, including names
  that themselves contain marker text or literal dollar sequences.
- A pending workspace refresh must lock navigation/editor controls, preserve
  drafts on transient failure, and ignore results after logout.
- Conversation source drafts must stay with their selected Space and clear when
  accounts change, just like ordinary memory drafts.
- Remove a hardcoded product title and a documentation link to a nonexistent
  evidence file.

A fourth fresh round found and corrected:

- Approval receipt reads must recheck current interactive/create authority after
  asynchronous work, including replay; concurrent approval must report the
  actual committed replay result. A current authorized human may approve an
  ingestion after the original submitting credential expires.
- Mail must apply branding exactly once and preserve already-final literal
  content, including Unicode names and template-like text.
- Cached and newly created billing URLs must recheck recent proof and current
  authority immediately before returning them.
- Removing one's own organization membership must ask before discarding an
  unrelated unsaved draft during workspace refresh.
- The README must distinguish the release API's 64 KiB JSON request limit, the
  foundation API's 24 KiB limit and ingestion's 24,000-byte messages limit.

A fifth fresh round found and corrected:

- Space-list and share-invitation metadata must be filtered against a current
  authority snapshot after the initial read. Batched JSON parameters keep these
  checks within D1's bind limit.
- Each newly initiated semantic-search provider call must check current read
  authority after preceding asynchronous work.
- Cancelled, expired or completed ingestion must not consume automatic retries;
  terminal cleanup and the claim/failure predicates must agree atomically.
- Sharing with a disabled recipient must return a controlled authorization
  response rather than a raw trigger error/HTTP 500.
- A customer-creation failure followed by a delayed checkout retry must not send
  an expiry shorter than Stripe's minimum. Forward migration 8 records whether
  Checkout was attempted: only never-attempted requests may refresh their expiry;
  uncertain attempts retain identical parameters for idempotent retries. Existing
  rows migrate conservatively as attempted. Applied migrations 1–7 stay frozen.

The next independent passes also reproduced:

- A paginated management refresh temporarily selected a different Space before
  completion, allowing a private draft to be submitted to that temporary Space.
- The original editor omitted operation IDs, so an uncertain successful write
  followed by retry could create duplicate memories or fail revision recovery.
- The original editor described restricted append-only PATs as read/write; it now
  accurately refers to the capabilities and Spaces selected at issuance.
- Repeatedly crashed workers bypassed the five-attempt limit because only caught
  errors exhausted jobs; expired leases also need bounded exhaustion handling.
- Vector cleanup scanned all retained historical references in one invocation.
  A legitimate 250-revision memory with slow successful provider calls exceeded
  the scheduled runtime limit and restarted from the first reference on retry.

The following independent protocol pass reproduced encoded PAT revocation and
revision-job retry IDs being rejected. Path identifiers now decode exactly once
after route matching, reject malformed escapes/encoded separators, and retain
normal authorization. It also identified replacement checkout before a queued
payment event had bound the subscription, SCIM DELETE remaining visible in GET
and lists, incorrect SCIM pagination normalization, and ignored SCIM attribute
projection. Migration 10 implements immutable checkout closure and SCIM deletion
receipts while preserving prior records. Pagination and attribute selection now
follow the supported SCIM contract, with native D1 upgrade/protocol coverage.

The subsequent fresh browser and storage passes also reproduced and corrected:

- Receipt-only write replays displayed an undefined body and a misleading saved
  message. The console now distinguishes the receipt, preserves the submitted
  copy and reconciles the current representation without selecting another item.
- Session expiry discarded account-bound drafts, and failed edits lost their
  input. Recovery keeps drafts scoped to the same verified account, Space and
  memory, while logout and account changes still clear them.
- A deliberate extraction after cancelling a confirmed submission reused its old
  operation key. Uncertain retries retain their key; confirmed new attempts do not.
- The root workspace omitted accepted shared Spaces. Its snapshot now uses the
  release authority policy and includes accurate read/write capability metadata.
- Read-only organization members and share recipients saw enabled write controls;
  management ignored the configured accent; root list labels described the wrong
  ordering. The controls, styling and ordering labels now match their contracts.
- Claude SSO instructions implied a working localhost callback despite central
  registration incompatibility. Documentation and management UI identify that
  acceptance gate and the currently available PAT path explicitly.
- A credential, membership or recent proof could expire during awaited work
  before a mutation. A fresh timestamp now binds the final authorized write and
  replay checks, including storage, transfer, billing and SCIM mutations.
- Already-approved ingestion bypassed operation-key conflict checks. Approval
  receipts now pass through the same fingerprint and idempotency mechanism with
  zero additional memory writes or quota charges.
- Late provider upserts could resurrect vectors for soft-deleted memories when
  source erasure was disabled. Bounded cleanup eligible after 24 hours includes current soft
  tombstones as well as erased memories, retaining identifier references and
  excluding restored memories and active leases.

One suggested change was rejected after checking the user's actual request and
the existing contract: targeted PAT Spaces are optional, and the console defaults
to a selected Space but offers an explicit broader-scope choice. Omitting
`spaceIds` is documented in `docs/CONNECTING.md`; it still checks current rights
and capabilities. Requiring all PATs to have exact Space lists would remove this
intentional option. This is not treated as an unresolved implementation defect.

The next authentication and storage passes found further concrete cases:
proof hashing after a captured authorization time, qualified SCIM deactivation
paths, duplicate usernames after rejoining, PATCH attribute projection, DNS name
case comparison, expired checkout URLs, late obsolete vectors for live memories,
unindexed/unbounded pagination work, unbounded share invitations and a search
candidate limit smaller than the accepted result limit. These are corrected with
live clock callbacks, protocol regressions and migration 11's pagination indexes.
The coordinator additionally reproduced export-session expiry during hashing and
checked filtered-empty invitation pages: expiry is revalidated and raw bounded
targets advance the cursor even when no visible invitation remains in that page.

The next browser pass corrected seven further cases: late receipt reconciliation
crossing Spaces, receipt-only retries clearing management drafts, no explicit new
checkout attempt after expiry, ungated jobs/export/SCIM/PAT controls, organization
selection clearing unrelated memory results, obsolete failures overwriting newer
success, and a composer limit below the server's valid UTF-8 byte limit. Received
invitations now load additional pages only when requested, retaining account and
request-generation checks on both successful and failed responses.

The latest local checkpoint passes 1,238 foundation/release/client tests (192,
1,040 and six), seven native auth/HTTP tests and the bundled Worker/D1 integration
through migration 18. The new indexes and lookup migrations preserve populated
memory/version/audit and identity data. Native tests also exercise account-bound
invitation cursors, lost-response outbound grant recovery in a new browser
session, qualified SCIM PATCH projection, stable FTS row identifiers
and foundation-key issuance with its original metadata and audit behavior.
The unchanged legacy tree's 208 tests and build/artifact checks passed earlier in
this review. The 51-case lexical evaluation returns recall@5 0.62, MRR@5 0.59,
zero forbidden/stale hits and one negative-query false positive. Tenant-local
ranking lowers MRR by 0.01 against the preceding implementation on this fixture.

Further fresh independent passes are in progress. Passing test totals are
checkpoints, not a claim that the source has completed review.
Those passes identified and corrected additional cases: SCIM-key and
OAuth-flow expiry during hashing, HTTP-level OAuth scope challenges for MCP,
case-variant pathless SCIM attributes, recovered editor save-context fencing,
logout retries losing their account binding, stale results overwriting one-time
PATs, validation discarding edit input, and one outdated deployment paragraph.
They also reproduced an export session check running after the final authority
check, globally scanned FTS identifiers and materialized unrelated memberships.
The query-plan fixes use additive migrations 12 and 13; retained source and
identity data and all existing migration files remain unchanged. Clock checks
also cover final credential, membership, grant, export-session and JWT expiry
after asynchronous reads, without exposing internal authority facts in DTOs.

The next fresh console pass reproduced and corrected six additional cases:
an unrelated action suppressing a newly issued one-time PAT, false cancellation
success after extraction approval, an orphaned edit becoming inaccessible after
refresh, broad personal PAT disclosure omitting accepted shares, an older save
overwriting a newer search view, and an enabled last-owner removal action.
Its 139 focused tests pass. A separately labelled, time-limited issuance receipt
survives unrelated results and same-account Space changes, while explicit clear,
logout and account changes remove it and fence late responses. Cancellation now
checks the persisted state and never describes an approved extraction as cancelled.

The following storage and authentication passes independently reproduced final
SQL reads outliving credential, organization membership or job lease deadlines.
The affected paths include provider ingestion/indexing, foundation and release
memory/Space reads, invitation metadata, billing usage/provider sessions and SCIM
effective member status. The same-class sweep also covers email/DNS delivery,
OAuth flow claims, billing webhook freshness and background billing leases.
These corrections carry expiry facts through the last awaited read and compare
them synchronously before disclosure or a new provider request.

The storage pass also measured global Space scans, FTS matching/ranking work
across tenants and repeated queue-backlog sorting. Additive migrations 14 and 15
and tenant-bound candidate queries address these cases. Benchmarking identified
that a tenant filter alone does not eliminate FTS5's global prefix setup or BM25
phrase counts. The replacement uses indexed prefixes of 1–31 code points and
tenant-local body match density; overlong processed terms fail before metering.
The physical FTS index grew 2.83 times on a synthetic 1,000-document bilingual
fixture, which is disclosed as an operational capacity tradeoff rather than a
production forecast. A caller's own membership/share set can still require
sorting; unrelated tenants are excluded from those candidate sets.

The following authentication pass corrected OAuth tokens expiring during an MCP
tool call and global scans while assembling workspace Spaces and key history.
MCP responses are bounded and fully produced before a final primary credential
snapshot; expired or revoked OAuth credentials receive an HTTP authentication
challenge, while ordinary tool authorization errors retain their protocol shape.
Organization key history remains tied to exact current owner/admin membership.

The next console pass corrected cross-Space responses and form resets, inaccessible
drafts after a Space disappears, owner removal offered to organization admins,
and cancelled actions reported as successful. The next independent pass found
five further cases: account-unbound editor GETs, save completion overriding a new
memory selection, late key-revocation errors reaching another dialog, and two
indefinite processing indicators. All five and an adjacent stale selection-error
case were reproduced before correction; 159 focused tests pass. A further fresh
console review is in progress.

Native Workers/D1 testing exposed a queue query that passed ordinary SQLite but
failed when six compound SELECT branches were enabled. Candidate selection now
uses at most eight indexed scalar subqueries collected with json_array/json_each,
preserving atomic claim updates and bounded work without a compound SELECT. The
native test enables all eight branches and passes. Resumable vector cleanup and
source erasure use durable bounded scan cursors; eligibility does not promise a
complete daily scan of an arbitrarily large backlog.

The eleventh storage pass found normal asynchronous vector-deletion visibility
consuming the five-failure budget, missing tenant indexes for ingest/job lists
and full-state rebuilds, and query-only NFKC normalization preventing identical
fullwidth/ligature words from matching. Migration 16 adds operational indexes and
durable accepted-deletion pages. Visibility waits preserve actual failure counts;
only confirmed absence advances deletion progress. Query processing retains the
stored text's Unicode61 semantics. All 222 focused storage tests pass. Native D1
also preserves populated schema 5–16 data and confirms 1,001 asynchronously deleted
vectors across 11 accepted pages without exhausting the prior failure count.

The eleventh authentication pass reproduced revoked-recipient proof dispatch,
malformed legacy PAT and SCIM PATCH inputs accepted through coercion, missing
Allow headers, and known routes returning 404 for unsupported methods. The broader
input/method sweep also corrected explicit-null defaults, invalidated-proof cleanup
returning 500, newly claimed email destinations, DNS name types, and ingestion
role/provider-kind coercion. Focused authentication checks pass, including the
complete recognized-route method matrix and final proof-dispatch boundaries.
The twelfth console pass found same-view refresh suppressing committed mutation
results, result clearing discarding retained invitation pagination, and incorrect
root-editor search guidance. These were corrected across all five memory mutation
types; 171 focused tests pass. The thirteenth console review then reproduced
editing during pending logout, late challenge responses changing a newer proof
pair, obsolete organization controls after reconnect, and staging consoles
showing the production MCP origin. All four are corrected, with 18 new
regressions and 238 passing focused tests. A fresh fourteenth console review is
inspecting the corrected source. It found three further cases: an outbound share
receipt or verified domain ID lost after an unrelated request, and an old expired
read clearing a newly issued invitation after the same account reconnected.
The same-class sweep also reproduced a newer failed/pending request suppressing
genuine expiry recovery, and DNS proof text outliving the result panel's secret
timeout. All are corrected, with 25 new regressions and 263 passing focused
checks. The fresh fifteenth console review found pending dialog inputs being
discarded, extraction controls using an older list state instead of fresh detail,
enabled but inert controls after failed logout, unsupported last-owner guidance,
and a README paragraph with an obsolete migration count. The README now points
to the maintained deployment table. All four UI findings are corrected, with
22 new regressions including outbound recovery and 285 passing focused tests.
A fresh sixteenth console review is inspecting the corrected source.

A separate fresh, bounded recovery review reproduced a higher-impact case:
lost share-issuance responses leave the sender unable to discover/revoke the
original grant through supported APIs. Retrying creates a second grant; revoking
only that ID leaves the original usable. Outbound-share discovery and management
now use a newest-first, bounded history endpoint and explicit refresh/revoke
controls. Additive migration 18 indexes each Space’s retained outbound grants.
Current interactive manager authority and returned facts share one final primary
snapshot; listing does not require recent proof, while revocation still does.
The lost-response case is reproduced through actual HTTP and a page reload,
including the recipient losing access after the original grant is revoked.
Fifteen backend regressions and 94 focused checks pass; fresh authentication,
storage and console reviews are running against this integrated source.
Non-idempotent POST semantics alone were not treated as a defect. Domain recovery was independently verified: a fresh DNS challenge
returns the existing domain ID and permits subsequent authorized management.

The twelfth storage pass found a final OAuth MCP credential check that omitted
the returned Space's membership/share authority. Signed HTTP reproductions returned
buffered memory after that authority expired or was revoked. It also found private-use
Unicode61 token characters discarded by query preprocessing; the coordinator
independently reproduced combining marks widening a word into unrelated prefixes.
Both storage findings are corrected. The final MCP snapshot now checks the
credential and every required Space action, emitted memory revision/liveness and
current-fact status. It retains non-content write receipts when appropriate and
keeps OAuth challenges distinct from ordinary SDK tool errors. The manifest is
collected after the SDK finishes producing the response, including delayed SSE.
The first SQL implementation passed ordinary SQLite but exceeded native D1's
expression-depth limit. Flat, token-bound materialized queries resolved that
failure; native D1 also passes a 100-Space response and a superseding write with
three required actions. Fifty-three new MCP regressions and 16 Unicode query
regressions pass. Unicode preprocessing now preserves combining marks and
private-use characters for the database tokenizer, without query-only NFKC.
The twelfth authentication reviewer reported zero actionable findings, but that
did not close the cross-domain MCP finding. Fresh thirteenth authentication and
storage reviews inspected that source. The thirteenth authentication pass then
found case-sensitive SCIM envelope/operation names and malformed email inputs
reported as authorization failures. Both are corrected, including ambiguous
duplicate SCIM attributes and the same public share-recipient input case; 53 new
regressions and 341 focused tests pass. The fresh fourteenth authentication review
reports zero actionable findings, with 594 passing tests across 33 explicit files.
The subsequent storage schema-version literal is reviewed with the storage change;
the authentication implementation remains unchanged.

The thirteenth storage pass reproduced an older asynchronous upsert completing
between deletion and confirmation, leaving the accepted page pending forever.
Additive migration 17 records a durable retry deadline and increasing delay so
pending pages can reconcile again without treating ordinary visibility waits as
provider failures. The implementation passes 95 focused tests, including late
upserts, slow normal propagation, restart/lease failures, bounded pages and retained
failure counts. The native Worker/D1 upgrade through schema 17 passes, preserving
all prior columns and verifying late-upsert reconciliation across restarts,
retained failure counts and historical confirmation timestamps. The mixed-case
SCIM PATCH and seven native authentication/HTTP checks pass as well. The fresh
fourteenth storage review reports zero actionable findings, with 618 passing
tests across 45 explicit files and all 17 migration/source pairs verified.
The maintained runbooks also clarify that a 24-hour resweep threshold
is eligibility, not a promise to process the full backlog within one day.
The final review result must identify the inspected revision and outstanding
findings; the GitHub PR records the corresponding CI runs.

After the built-in agent creation limit was reached, additional fresh reviews
use ephemeral, read-only Codex CLI sessions. They receive the requirements and
checkout without prior review conversations; their transcripts remain local.
The eleventh storage session accidentally invoked default Node test discovery
after a PowerShell selector error. Its resulting broad run failed and is excluded
from validation evidence. The coordinator's audit found a completed transcript,
no remaining runner, and only local/synthetic native fixtures or isolated temporary
files in the invoked test paths; no remote command or tracked-source write path
was found. Later reviewer prompts require a verified nonempty explicit test list.

The existing pilot limits remain explicit: live mail/PAT and external MCP-client
acceptance, provider activation, load/recovery drills, account-wide deletion and
physical D1 sharding/R2 offload are not established by this review.

The fifteenth authentication pass reproduced two minor input-contract defects:
valid ASCII support mailboxes were rejected while malformed domain labels were
accepted, and malformed signed webhook JSON/UTF-8 became HTTP 500. Both defects
are corrected, with 39 new and 207 focused tests passing. Shared mailbox URI
encoding preserves the literal address separator and reserved local-part content.
Provider and database failures retain their server-error classification.
The sixteenth console pass reproduced a committed invitation whose one-time
code was discarded when its pending dialog was dismissed. Pending root dialogs
now retain their result through close, cancel and replacement attempts; failure
restores dismissal while logout still clears the account. Actual HTTP/DOM tests
cover delayed success and failure across equivalent dialogs.

The fifteenth storage pass reproduced two further disclosure races: REST get,
list, search and export could return buffered plaintext after permanent erasure
committed before their final authority query, and ingest detail could return old
quotations after cancellation cleared them. The fixes combine current content
eligibility with the final authority snapshot, retaining bounded page work and
cursor progress, including empty invalidated pages. Ingest detail and list use
the final current state. This finding is distinct from the earlier MCP wrapper
check: both direct REST and MCP paths require their own correct final boundary.

The second independent recovery pass confirmed outbound share recovery and
found organization creation's network-error guidance incorrectly recommending
immediate retry after a possibly committed POST. The UI correction covers
organization and Space creation, invalid successful bodies, body-read failure
and server errors without changing non-idempotent server semantics.
The sixteenth authentication pass also reproduced duplicate domain delegation
returning HTTP 500. Exact live-assignment retries now converge on one retained
row and return success only after current manager/target/proof checks; revoked
assignments are not revived. Twenty-six new and 146 focused tests pass.

The seventeenth console pass identified the default mailto compatibility failure,
MCP supersession incorrectly advertised as additive-only, and expired trash still
offering restoration with an inaccurate revision-conflict error. Mailbox links
must preserve RFC 6068's literal separator while escaping local-part content
([RFC 6068 section 2](https://www.rfc-editor.org/rfc/rfc6068#section-2)). The MCP
annotation is corrected and seven PAT/MCP tests pass, including an independent
replacement/listing regression: a tool capable of replacing an existing fact
cannot promise exclusively additive updates
([MCP ToolAnnotations](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations)).
Trash responses now expose retention eligibility; expired restore controls are
disabled and a current-policy expiry returns `restore_expired`. Genuine revision
conflicts, failed authority and committed receipts keep their original behavior.
Nineteen retention regressions pass without rewriting the frozen migration rule.

The coordinated corrections now pass 1,238 tests (192 foundation, 1,040 release,
six client/template), typecheck and all 18 migration/source comparisons. The
final native Worker/D1 run passes its populated upgrade and all original checks,
eight explicit erasure/ingest-state disclosure interleavings, restore expiry and
policy-change classification, and seven native authentication/HTTP tests.
The first expanded native run completed the new disclosure probes but its newly
created jobs interfered with the existing queue fixture. Moving those probes
after queue scheduling assertions restored isolation; the full rerun passed.
The lexical evaluation still returns recall@5 0.62 and MRR@5 0.59 on all 51 cases.
The seventeenth authentication review reports zero actionable findings with 661
passing tests. The eighteenth console review found only a stale scaling guide:
the served release uses tenant FTS5 token-prefix search, not the historical
foundation substring scan. The guide now names the current implementation,
retained index cost and explicit erasure contract. The sixteenth storage review
found Space creation's byte-limited body reader had no elapsed-time deadline.
The shared foundation reader now has one ten-second deadline, cancels without
awaiting an uncooperative cancellation callback, and clears its timer and reader
lock on exit. Twelve new regressions and 139 focused tests pass, covering
delegated Space/organization/invitation routes, progressive input, stalled or
rejected cancellation, normal/oversized bodies and genuine stream errors.
The third independent recovery review reports zero actionable findings with
382 tests passing; retained shares/PATs and domain recovery remain discoverable
and revocable. Fresh storage17 and console19 reviews are still in progress.

The coordinator's full follow-up check passed 1,250 tests after the initial
deadline fix. A new bundled workerd probe then reproduced HTTP 500 rather than
408: native cancellation rejects the pending `read()` with `Stream was
cancelled.`, skipping a timeout check placed only after the await. An isolated
native probe confirmed the same mechanism in the existing release reader.
Both readers now narrowly classify cancellation after their own deadline as
408; unrelated stream failures keep their original classification. Four further
regressions and 162 focused tests pass. Isolated native probes confirm both
readers return 408 after ten seconds. The full bundled Worker/D1 rerun also
passes both stalled-request routes, all prior integration checks and seven
native authentication/HTTP tests. The failed run is retained separately.

The nineteenth console review found stale extraction cards after a refresh
overlapped approval/cancellation, missing uncertain-share guidance for HTTP 5xx,
and the root release editor retaining the foundation's shorter search limit.
All three are corrected. Twenty additional regressions and 334 UI/HTTP/transport
tests pass, including context changes and definitive authentication failures.

## Database execution-time admission

The seventeenth storage review reproduced writes admitted after credential,
membership, recent-proof, retention or ingest deadlines elapsed in the SQL queue.
It also reproduced renewal of an already expired lease followed by new provider
calls. JavaScript checks before or after the database await cannot provide this
admission guarantee. The shared predicate now compares deadlines with the later
of the bound application timestamp and SQLite's execution-time millisecond clock.
The same SQL runs in tests; fixture-owned clock injection occurs inside SQLite
at execution, without a production guard bypass.

Additive migration 19 updates temporal command validators and makes reauth proof
consumption plus credential refresh one guarded statement. The implementation
also applies execution-time admission to foundation/admin/SCIM mutations, signed
webhook receipts, mail budgets, checkout attempts and lease-owned state changes.
Operation timestamps and quota month, new checkout windows, retention starts and
delete retry windows derive from execution time. Committed receipts and already
attempted checkout history remain durable. Migrations 1–18 are unchanged.

The implementation passes 46 new storage deadline regressions, 32 new auth/admin
deadline regressions plus an auth-flow queue case, and eight common predicate and
route checks. The auth owner reports 476 passing focused tests. Historical browser
fixtures now advance their SQLite clock during historical setup and restore live
time before the scenario; all original assertions remain. Native historical rows
are inserted as retained fixture data, with normal version/index triggers.

Six native D1 probes preserve the real database clock and hold already prepared
work across its deadline: credential create, membership delete, proof-gated erase,
retention restore, ingest approval and lease renewal. All six pass with unchanged
source/history, no late operation receipt and no provider call under an expired
lease. The initial two-second setup allowance could expire before reaching the
controlled queue under concurrent load; the ten-second allowance retains the
assertion that every request reached admission while still valid.

The schema19 checkpoint passes 1,361 checks (208 foundation, 1,147 release and
six client/template), strict typechecking, all 19 schema/migration pairs and the
seven frozen deployed hashes. The full native command passes populated upgrades
through 19, all prior bundled D1 scenarios, six execution-time cases and seven
authentication/HTTP runtime tests. The first combined run exposed the native auth
fixture's fixed September 8 clock; using real wall time for both JWT issuance and
the controller preserves every original assertion and the subsequent complete run
passes. The 51-case lexical evaluation retains recall@5 0.62 and MRR@5 0.59,
zero forbidden/stale hits and one negative-query false positive.

Console20 then confirmed two response-order defects: an older successful edit
could delete a newer failed draft, and a delayed outgoing-share page could replace
a confirmed revocation with stale active controls. Both are being corrected and
will receive a fresh independent follow-up. Authentication18 is checking a
domain-verification transaction that can consume proof without finishing its
domain/manager updates when execution-time deadlines change between statements.
The final review matrix remains pending.

This review has launched 59 separate fresh sessions so far, including
the original 16 built-in reviewers and later ephemeral CLI reviewers; this count
is neither the number of completed clean reviews nor the number of defects.

## Domain transactions, retained proof history and response ownership

Authentication18 completed with two confirmed findings: a domain verification
could consume its proof without completing domain/manager setup, and an accepted
provider email revocation could leave a pending link proof returning 500. Both
are fixed. Migration20 adds a single guarded domain verification command whose
receipt, proof consumption, domain ownership/renewal and exact manager assignment
commit together. A completed challenge resolves the original result under current
same-account, exact-membership and recent-proof authority, without repeating DNS
or extending the verified period. Revoked assignments are never revived. Pending
email proof invalidation uses the exact revoked account/address; standing blocks
deny further proof consumption while unrelated database failures remain 500.
Only unused blocked proofs receive a new invalidation timestamp during upgrade.

The coordinator found that the receipt's retained challenge reference would make
the old transient cleanup fail a foreign-key constraint. Migration21 adds a
partial expiry index for unused domain proofs, and maintenance removes at most
100 unused expired rows. Consumed DNS proofs and immutable receipts remain intact.
The regression first reproduced the constraint failure, then verified 101 real
receipts, three legacy consumed proofs and 105 unused expired proofs: cleanup
removes 100 then five, preserves every retained row and still enforces revocation.

Console20's two findings are fixed with exact submission ownership for edit
drafts and current account/Space revocation facts that reconcile delayed pages.
Six new browser regressions and 340 console/HTTP/transport tests pass. The auth
owner reports 441 focused tests and 1,173 full release tests passing. The new
native domain suite passes all ten checks, including queue expiry, trigger
rollback, exact authorized replay, provider revocation and retained cleanup.
Its initial missing synthetic request limiter and later fixture count mismatch
were corrected without changing product expectations; the final cleanup test
compares complete retained row snapshots rather than a hardcoded count.

The implementation is frozen at schema21 for fresh authentication19, storage19
and console21 reviews. The preceding storage18 review reported zero actionable
findings, including independent lifecycle and HTTP/MCP/provider checks. Combined
schema21 validation and a further recovery review are pending. A total of62 fresh
sessions have been launched (16 built-in,46 ephemeral CLI); this is a session
count, not a count of defects or completed clean passes.

The full schema21 command subsequently passed 1,387 tests (208 foundation,
1,173 release and six client/template), strict typechecking, all21 source/migration
pairs and seven deployed hashes. The full native command passed populated
upgrades5–21, including the exact pending-proof invalidation change and otherwise
unchanged rows, the original bundled integration, six queued-clock cases, ten
domain/proof/cleanup tests and seven authentication/HTTP tests.

Console21 found one additional P3: the SCIM issuance click handler allowed a
second click while the first request was pending, producing two active keys.
Both one-time receipts survived, so this was duplicate issuance rather than receipt
loss. SCIM, export and billing-portal click actions now lock during issuance and
unlock for an explicit retry after failure. Seven new regressions and all 347
console/HTTP/transport checks pass. Console22 subsequently reports zero actionable
findings. Authentication19 and recovery4 also report zero actionable findings.

Storage19 then found a Unicode61 mismatch: SQLite indexes recently assigned
symbols that a modern JavaScript category expression had removed from the query.
Exact bodies such as `₿budget` and `🫠alpha` were missed, and `x🫠y` could return
unrelated prefix hits. The query now combines the existing compatible mark and
underscore grouping with a generated, pinned SQLite Unicode61 classification.
Known punctuation retains independent OR groups; tenant isolation, raw term
length, distinct-group and UTF-8 byte limits remain intact. The generator records
the official public-domain source URL and SHA-256 and does not fetch at runtime
or during normal CI. Native D1 regressions reproduced the failure before the fix
and now pass all 20 exact-body cases and punctuation OR controls. All 780 focused
storage/search checks pass. A separate supporting reviewer found no issues after
comparing 145,151 code points with actual SQLite indexing; this support check does
not substitute for the fresh Storage20 review.

The coordinator additionally reproduced a Windows checkout defect: automatic
CRLF conversion made the generated helper fail its byte-exact reproducibility
check. A narrowly scoped `saas/.gitattributes` entry keeps that helper at LF while
other files retain their existing checkout settings. The isolated Windows Git
checkout reproduced failure before the attribute and success after it. The
independent Tooling1 review covers this final non-runtime correction and reports
zero actionable findings. It verifies the actual generator, LF/CRLF and simulated
Windows/Linux path combinations, failure-without-write cases and 32 focused tests.
Its independent SQLite oracle matches all 1,112,064 scalar values plus 2,048 lone
surrogate inputs with zero mismatches. A separate real Windows scratch checkout
confirms that the nested attribute preserves LF for the helper while the generator
may use CRLF. Storage20 reports zero actionable findings, with 566 distinct tests,
eight independent MCP protocol probes, export/erasure lifecycle probes, all 21
migrations and database integrity checks passing. Thus every final assigned-domain
and supplemental fresh pass reports zero actionable findings. No runtime source
was modified after these passes; the remaining step is commit-specific CI.

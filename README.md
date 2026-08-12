# memory-server-worker

Personal Memory MCP server + plugin on Cloudflare Workers, backed by
[Cloudflare Agent Memory](https://developers.cloudflare.com/agent-memory/) —
a managed service that provides automatic extraction, classification,
deduplication, supersession, and hybrid search (keyword + semantic + topic key).

## What this is

A two-part system for giving AI agents persistent, searchable memory:

1. **`packages/memory-worker`** — a Cloudflare Worker that exposes an MCP
   server (Streamable HTTP) and REST API backed by Agent Memory. Each
   authenticated user gets their own isolated memory profile.
2. **`packages/memory-ui`** — a TanStack Start web UI served from
   `https://memory.allenlim.net` that proxies API/MCP/auth requests to the
   backend worker via a service binding.

Plus integration packages:

- **`plugins/allenlim-memory-server`** — Devin / Claude Code / Codex plugin with
  hooks for automatic recall (pre-prompt) and capture (post-turn).
- **`distributions/chatgpt/allenlim-memory-server`** — ChatGPT-compatible
  alternate distribution.

Current release: **2.1.0**. This release adds operator-mapped API keys,
HttpOnly browser sessions, incremental capture checkpoints, and security and
release hardening on top of the Agents/MCP SDK 2.0 migration.

## Architecture

```
Browser / AI Client
    │
    ▼
memory.allenlim.net (UI Worker — TanStack Start)
    ├── /                → Web UI
    ├── /api/*           → proxy to backend
    ├── /mcp             → proxy to backend (MCP Streamable HTTP)
    └── /auth/*          → proxy to backend (SSO)
            │
            ▼
    memory-server.allenlim.workers.dev (Backend Worker)
            │
            ▼
    Cloudflare Agent Memory (namespace: "memory")
```

Auth supports Allen Labs SSO and operator-provisioned API keys. CLI/MCP clients
send an RS256 JWT as `Authorization: Bearer <jwt>` or a high-entropy key as
`x-memory-api-key`. Browser SSO uses a Secure, HttpOnly session cookie that is
accepted only on same-origin `/api/*` requests and never on `/mcp`.

API-key plaintext belongs in a secret manager such as Proton Pass. The Worker
receives only a SHA-256 digest registry in the `MEMORY_API_KEY_REGISTRY` secret;
each entry maps a key to one fixed user identity and optional logical scope.
Callers cannot override an API key's scope.

Every profile is isolated by the authenticated JWT subject. An optional
`x-memory-scope` value creates a logical sub-scope that is SHA-256-bound to
that subject, so a caller cannot select another user's profile.

### Migrating pre-2.0 profiles

Before 2.0, `x-memory-scope` selected a sanitized Agent Memory profile name
without binding it to the authenticated user. Version 2.0 deliberately has no
runtime fallback to those names: a self-service fallback would let any user
claim another legacy scope and would restore the original isolation flaw.

Use the operator-only copy tool for a legacy profile that has been proven to
belong to exactly one JWT subject and, for a scoped migration, one logical
scope. First pause affected client traffic, deploy the user-bound worker to cut
off arbitrary legacy-name access, and keep affected traffic paused while
copying. Inventory normalization collisions as part of the ownership audit
(for example, `Team_Memory` and `team-memory` formerly addressed the same
profile).

```bash
# Cloudflare API token: grant only the required Agent Memory permissions.
# Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment.

# Plan only (default): computes names, makes no network request, writes nothing.
npm -w memory-worker run migrate:legacy-scope -- \
  --owner-sub "<JWT_SUB>" --logical-scope "<OLD_SCOPE>"

# Personal profile plan for a non-UUID JWT subject. This maps the former
# sanitized subject name to the new collision-resistant user-bound name.
npm -w memory-worker run migrate:legacy-scope -- \
  --owner-sub "<JWT_SUB>" --personal

# Apply: requires an explicit attestation that the whole source is exclusive
# to this owner. Copies active memories and verifies the destination.
npm -w memory-worker run migrate:legacy-scope -- \
  --owner-sub "<JWT_SUB>" --logical-scope "<OLD_SCOPE>" \
  --execute --confirm-exclusive-owner "<JWT_SUB>"

# Use --personal instead of --logical-scope to apply a personal-profile plan.
```

The tool is copy-only and retry-safe: it matches exact content/session pairs,
rejects unrelated data already present at the target, verifies that the source
snapshot stayed stable and that the copy completed, and never deletes the
legacy source. It refuses ambiguous `default`, UUID-shaped, and new-format
source names. Do not automate a mixed or uncertain profile; manually classify
it with the affected owners instead.

Cloudflare's current public API enumerates active memories only. The copy
preserves active memory text and session linkage, but Agent Memory assigns new
IDs, classifications, summaries, and timestamps; superseded history remains in
the untouched legacy profile. After the owner verifies recall/list behavior on
the new scope, resume traffic. Keep the old profile dormant unless a separate
retention review proves deletion is safe.

## MCP Tools

| Tool | Agent Memory API | Description |
|------|-----------------|-------------|
| `memory_add` | `profile.remember()` | Store a single memory explicitly |
| `memory_search` | `profile.recall()` | Hybrid search with synthesized answer |
| `memory_ingest` | `profile.ingest()` | Extract memories from a conversation |
| `memory_list` | `profile.list()` | List memories (filter by type/session, paginated) |
| `memory_get` | `profile.get()` | Fetch a single memory by ID |
| `memory_delete` | `profile.delete()` | Delete a memory by ID |
| `memory_delete_session` | `profile.deleteSession()` | Delete all memories for a session |
| `memory_summary` | `profile.getSummary()` | Structured Markdown summary |
| `memory_stats` | computed from `list()` | Total count + per-type breakdown (with truncation flag) |

### Memory types

Agent Memory automatically classifies every memory as one of:

- **fact** — Stable knowledge (preferences, identities, relationships)
- **event** — Completed actions anchored to a point in time
- **instruction** — Reusable procedures, workflows, conventions
- **task** — Short-lived, session-scoped items

### Key features

- **Automatic extraction** — `ingest()` reads conversations and identifies
  facts, events, instructions, and tasks automatically.
- **Deduplication + supersession** — If a newer fact/instruction replaces an
  older one on the same topic, the old version is preserved but the latest
  surfaces in recall.
- **Hybrid search** — `recall()` runs keyword, semantic, and topic-key search
  in parallel and returns a synthesized answer grounded in stored content.
- **Idempotent ingestion** — Re-ingesting the same conversation creates no
  duplicates.
- **Session scoping** — Memories can be grouped by session ID.

## CLI

```bash
# Login (opens browser for SSO)
mem login

# Store a memory
mem add "User prefers TypeScript for all new projects"

# Search memories
mem search "what language does the user prefer?"

# Ingest a conversation (JSON array of {role, content})
echo '[{"role":"user","content":"I like Vim"},{"role":"assistant","content":"Got it."}]' | mem ingest

# List memories (filter by type)
mem list --type fact
mem list --session my-session-id

# Get a specific memory
mem get 01KZR5ZD6ZMQNQ36FR98EP4Y40

# Delete
mem delete 01KZR5ZD6ZMQNQ36FR98EP4Y40
mem delete-session my-session-id

# Summary and stats
mem summary
mem stats

# Headless/automation use (resolve this from a secret manager)
MEMORY_API_KEY="..." mem stats
```

## Configuration

### Environment variables (plugin)

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMORY_SERVER_URL` | Worker URL | `https://memory.allenlim.net` |
| `MEMORY_API_KEY` | API key for headless automation; takes precedence over JWT auth | — |
| `MEMORY_TOKEN` | JWT bearer token (overrides credential file) | — |
| `MEMORY_SCOPE` | Optional JWT logical sub-scope; ignored for API-key auth | — |
| `MEMORY_REQUEST_TIMEOUT_MS` | Plugin request timeout, clamped to 100–60000 ms | `10000` |

### Wrangler bindings (backend)

```jsonc
{
  "agent_memory": [
    { "binding": "MEMORY", "namespace": "memory" }
  ],
  "vars": {
    "AUTH_API_URL": "https://auth-api.allen.company",
    "AUTH_WEB_URL": "https://auth.allen.company",
    "DEFAULT_SCOPE": ""
  }
}
```

Provision `MEMORY_API_KEY_REGISTRY` with `wrangler secret put`; never place the
registry or API-key plaintext in `wrangler.jsonc`, `.dev.vars`, source control,
shell history, or command arguments. The registry is versioned JSON containing
digest-only entries:

```json
{"version":1,"keys":[{"id":"automation","digest":"sha256:<64-lowercase-hex>","userId":"<stable-user-id>"}]}
```

## Development

```bash
# Install dependencies
npm install

# Run all type checks, tests, and production builds
npm run check

# Rebuild the deterministic ChatGPT plugin ZIP + SHA-256 checksum
npm run build:plugin-artifact

# Build backend
cd packages/memory-worker && npx tsc --noEmit

# Build UI
cd packages/memory-ui && npx vite build

# Deploy backend
cd packages/memory-worker && npx wrangler deploy

# Deploy UI
cd packages/memory-ui && npx wrangler deploy
```

## Plugin installation and updates

Install from the repository marketplace:

```bash
codex plugin marketplace add https://github.com/ATLKR/memory-server-worker
codex plugin add allenlim-memory-server@allenlim-plugins
```

After a new release is pushed, refresh the marketplace metadata and the
installed plugin, then start a new Codex conversation:

```bash
codex plugin marketplace upgrade allenlim-plugins
codex plugin add allenlim-memory-server@allenlim-plugins
```

Release versions are synchronized across workspace packages, Codex, Claude,
Devin, ChatGPT manifests, marketplace metadata, and the packaged ZIP.
Tagged releases additionally publish the ZIP, checksum, and a CycloneDX SBOM.

## License

MIT

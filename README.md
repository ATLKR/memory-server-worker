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

- **`packages/memory-plugin`** — Devin / Claude Code / Codex plugin with
  hooks for automatic recall (pre-prompt) and capture (post-turn).
- **`packages/memory-chatgpt-plugin`** — ChatGPT-compatible skills package.

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

Auth: SSO via Allen Labs central auth server (`auth-api.allen.company`).
The client sends an RS256 JWT as `Authorization: Bearer <jwt>`. The worker
verifies the JWT against the auth server's JWKS endpoint.

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
| `memory_stats` | computed from `list()` | Total count + per-type breakdown |

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
```

## Configuration

### Environment variables (plugin)

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMORY_SERVER_URL` | Worker URL | `https://memory.allenlim.net` |
| `MEMORY_TOKEN` | JWT bearer token (overrides credential file) | — |
| `MEMORY_SCOPE` | Scope header (defaults to JWT sub) | — |

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

## Development

```bash
# Install dependencies
npm install

# Build backend
cd packages/memory-worker && npx tsc --noEmit

# Build UI
cd packages/memory-ui && npx vite build

# Deploy backend
cd packages/memory-worker && npx wrangler deploy

# Deploy UI
cd packages/memory-ui && npx wrangler deploy
```

## License

MIT

# memory-server-worker

Personal Memory MCP server + plugin on Cloudflare Workers, built on the
Cloudflare Agents SDK memory layer (Durable Object SQLite + FTS5).

## What this is

A two-part system for giving AI agents persistent, searchable memory:

1. **`packages/memory-worker`** — a Cloudflare Worker that exposes an MCP
   server with memory tools (`memory_add`, `memory_search`, `memory_get`,
   `memory_list`, `memory_update`, `memory_delete`, `memory_load`,
   `memory_stats`). Memories are stored in a Durable Object with SQLite +
   FTS5 full-text search. Authentication is delegated to the Allen Labs
   central auth server via RS256 JWT / JWKS.

2. **`packages/memory-plugin`** — a hook-compatible plugin (Claude Code,
   etc.) that auto-injects relevant memories before each prompt and
   captures conversation summaries after each turn. Includes a CLI with
   SSO login (`mem login`).

```
  AI Client (Claude Code, Cursor, etc.)
       │
       ├── MCP tools/call ──────────────┐
       │   Authorization: Bearer <JWT>  │
       ▼                                ▼
  memory-plugin (hooks)          memory-worker (Cloudflare)
  · pre-prompt: search+inject    · createMcpHandler (/mcp route)
  · post-turn: capture summary   · MemoryAgent Durable Object
  · mem login (SSO → JWT)          - SQLite: structured storage
                                   - FTS5: full-text search
  · auth.allen.company ── JWT ──→ · JWKS verification (jose)
```

## Technology

This project uses the same storage patterns as the Cloudflare Agents SDK
memory layer ([Conversation state and memory][cf-memory]):

| Agents SDK concept          | This project's equivalent             |
| --------------------------- | ------------------------------------- |
| Writable short-form context | `memory_add` / `memory_update`        |
| Searchable context (FTS5)   | `memory_search` (SQLite FTS5)         |
| Loadable context / Skills   | `memory_load` (by key)                |
| Durable Object SQLite       | `MemoryAgent` DO (`this.ctx.storage.sql`) |
| `AgentSearchProvider`       | FTS5 virtual table `memories_fts`     |

The `Agent` base class from `agents` provides durable identity, SQLite
storage, and hibernation survival. Each *scope* gets its own DO instance
with an isolated SQLite database.

[cf-memory]: https://developers.cloudflare.com/agents/concepts/conversation-state-and-memory/

## Authentication

Auth is fully delegated to the **Allen Labs central auth server**
(`auth-api.allen.company`). No static tokens or secrets are stored on the
worker.

### How it works

1. The client obtains an RS256 JWT through the SSO flow (see `mem login`).
2. The JWT is sent as `Authorization: Bearer <jwt>` on every MCP request.
3. The worker verifies the JWT signature against the auth server's JWKS
   endpoint (`{AUTH_API_URL}/.well-known/jwks.json`) using `jose`.
4. Issuer + audience must match `AUTH_API_URL`.
5. The JWT's `sub` (Better Auth user id) identifies the user.

JWTs are valid for 8 hours (per auth-api config). The JWKS key set is
cached in-process with a 5-minute TTL and auto-refetches on key rotation.

### SSO flow

```
mem login
  → browser opens {MEMORY_SERVER_URL}/auth/sso
  → worker 302 → {AUTH_WEB_URL}/sign-in?return_to=.../auth/callback
  → user signs in on auth.allen.company
  → auth-web mints code, redirects to /auth/callback?code=...
  → worker calls {AUTH_API_URL}/sso/exchange { code, client_id, include_token: true }
  → returns { token: <JWT>, expires_in: 28800, user: { id, email, name } }
  → CLI stores JWT in ~/.memory/credentials.json
```

### Scope resolution

Each scope → its own Durable Object → isolated SQLite DB. Resolution order:

1. `x-memory-scope` header (explicit override)
2. `DEFAULT_SCOPE` var if non-empty
3. JWT `sub` (user id) — the default for personal use

## Quick start

### Prerequisites

- Node 20+ and npm
- Cloudflare account (for deployment)
- Access to the Allen Labs auth server (for SSO login)

### Local dev

```bash
# Install dependencies
npm install --legacy-peer-deps

# Start the worker locally (port 8787)
npm run dev
```

The MCP endpoint is at `http://localhost:8787/mcp`. For local dev, you'll
need a valid JWT from the auth server — use `mem login` with the deployed
worker URL, then point `MEMORY_SERVER_URL` to localhost with the same JWT.

### Deploy

```bash
# No secrets to set — auth is delegated to the Allen Labs auth server.
# The AUTH_API_URL and AUTH_WEB_URL vars are pre-configured in wrangler.jsonc.
# Just deploy:
cd packages/memory-worker
wrangler deploy
```

The MCP endpoint will be at `https://memory-server.<your-subdomain>.workers.dev/mcp`.

**Important:** The worker's origin must be added to the auth server's
`TRUSTED_ORIGINS` list for the SSO callback to work. Contact the auth
server admin to add `https://memory-server.<your-subdomain>.workers.dev`.

## MCP tools

| Tool             | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `memory_add`     | Store a memory entry (upsert by key)                     |
| `memory_search`  | Full-text search across all memories                     |
| `memory_get`     | Fetch a single memory by key                             |
| `memory_list`    | List memories (filter by namespace/tag)                  |
| `memory_update`  | Update content/tags/metadata (replace or append)         |
| `memory_delete`  | Delete a memory by key                                   |
| `memory_load`    | Load a large document by key (skill-style)               |
| `memory_stats`   | Total count + per-namespace breakdown                    |

## Memory Plugin (hooks)

The plugin in `packages/memory-plugin` provides two hooks:

### Pre-prompt hook (`UserPromptSubmit`)

Searches the memory server for memories relevant to the user's prompt and
injects them as additional context before the agent processes the prompt.

### Post-turn hook (`Stop`)

After the agent finishes a turn, captures a summary of the conversation
(user prompt + assistant response) and stores it as a memory entry in the
"conversations" namespace.

### Setup

1. Copy the environment template:

```bash
cd packages/memory-plugin
cp .env.example .env
# Edit .env with your MEMORY_SERVER_URL
```

2. Log in via SSO:

```bash
node scripts/cli.mjs login
# Browser opens → sign in on auth.allen.company → JWT is stored locally
```

3. Register the hooks in Claude Code's settings (or your tool's hook config):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/memory-server-worker/packages/memory-plugin/scripts/pre-prompt.mjs"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/memory-server-worker/packages/memory-plugin/scripts/post-turn.mjs"
          }
        ]
      }
    ]
  }
}
```

Make sure `MEMORY_SERVER_URL` is set in the environment where Claude Code
runs. The JWT is read from `~/.memory/credentials.json` (created by
`mem login`).

### CLI helper

```bash
# SSO login (opens browser)
node packages/memory-plugin/scripts/cli.mjs login

# Check current user
node packages/memory-plugin/scripts/cli.mjs whoami

# Log out
node packages/memory-plugin/scripts/cli.mjs logout

# Add a memory
node packages/memory-plugin/scripts/cli.mjs add "User prefers dark mode" --key preference-theme --namespace preferences --tags ui,theme

# Search
node packages/memory-plugin/scripts/cli.mjs search "dark mode"

# List by namespace
node packages/memory-plugin/scripts/cli.mjs list --namespace preferences

# Get by key
node packages/memory-plugin/scripts/cli.mjs get preference-theme

# Update (append)
node packages/memory-plugin/scripts/cli.mjs update preference-theme --content "Also prefers large fonts" --append

# Delete
node packages/memory-plugin/scripts/cli.mjs delete preference-theme

# Stats
node packages/memory-plugin/scripts/cli.mjs stats
```

### Headless / CI usage

For CI or headless environments where browser SSO isn't possible, set the
`MEMORY_TOKEN` environment variable to a valid JWT. This overrides the
credential file:

```bash
export MEMORY_TOKEN="<jwt-from-auth-server>"
```

You can also pipe a token or JSON response from `/auth/callback`:

```bash
echo '{"token":"...","expires_in":28800}' | node scripts/cli.mjs login --pipe
echo "<jwt>" | node scripts/cli.mjs login --pipe
```

## Project structure

```
memory-server-worker/
├── packages/
│   ├── memory-worker/              # Cloudflare Worker (MCP server)
│   │   ├── src/
│   │   │   ├── index.ts            # Worker entry — MCP handler + SSO + auth
│   │   │   ├── auth.ts             # JWT/JWKS verification (jose)
│   │   │   ├── memory-do.ts        # MemoryAgent Durable Object (Agent class)
│   │   │   ├── store.ts            # SQLite + FTS5 memory store
│   │   │   └── schema.ts           # Types + Zod shapes
│   │   ├── wrangler.jsonc
│   │   └── package.json
│   └── memory-plugin/              # Hook-compatible plugin
│       ├── scripts/
│       │   ├── pre-prompt.mjs      # UserPromptSubmit hook
│       │   ├── post-turn.mjs       # Stop hook
│       │   ├── cli.mjs             # CLI helper (login, CRUD, search)
│       │   └── lib.mjs             # Shared HTTP client + credential store
│       ├── hooks.json              # Claude Code hook config
│       └── package.json
├── package.json                    # workspace root
└── tsconfig.base.json
```

## Configuration reference

### Worker (`packages/memory-worker`)

| Var             | Default                          | Description                          |
| --------------- | -------------------------------- | ------------------------------------ |
| `AUTH_API_URL`  | `https://auth-api.allen.company` | Auth API base URL (JWT issuer + JWKS) |
| `AUTH_WEB_URL`  | `https://auth.allen.company`     | Auth web UI origin (SSO sign-in)     |
| `DEFAULT_SCOPE` | `""` (uses JWT `sub`)            | Default memory scope                 |

No secrets required — auth is fully delegated.

### Plugin (`packages/memory-plugin`)

| Env var               | Default                          | Description                          |
| --------------------- | -------------------------------- | ------------------------------------ |
| `MEMORY_SERVER_URL`   | (required)                       | Worker URL                           |
| `MEMORY_AUTH_API_URL` | `https://auth-api.allen.company` | Auth API URL (for login reference)   |
| `MEMORY_TOKEN`        | (optional)                       | JWT (overrides credential file)      |
| `MEMORY_SCOPE`        | (optional)                       | Scope header override                |

Credentials are stored in `~/.memory/credentials.json` (mode 0600).

## License

MIT

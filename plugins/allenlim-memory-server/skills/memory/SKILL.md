---
name: memory
description: Personal persistent memory tools and client-specific recall/capture guidance. Use MCP tools directly or the optional repository `mem` CLI.
---

# Memory Skill

You have access to a personal persistent memory system. Memories are stored in
[Cloudflare Agent Memory](https://developers.cloudflare.com/agent-memory/) —
a managed service with automatic extraction, classification, deduplication,
supersession, and hybrid search (keyword + semantic + topic key).
Authentication uses a server-issued API key, a personal access token (PAT),
or Allen Labs SSO (JWT/JWKS). API keys are suitable for CI/services; PATs are
suitable for browser-free personal CLI access.

## How it works by client

- **Claude Code, before each prompt**: The `UserPromptSubmit` hook searches
  the memory server for memories relevant to your current prompt and injects
  them as additional context.

- **Claude Code, after each turn**: The `Stop` hook ingests the conversation
  messages into Agent Memory, which extracts facts, events, instructions, and
  tasks automatically. This happens silently.

- **Codex**: The registered Memory app provides all nine MCP tools. The recall
  and capture skills direct the agent to call them; Claude hooks are not used.

- **Devin**: Use the bundled `memory-mcp-stdio` bridge with Proton Pass CLI.
  This avoids browser approval and keeps only a `pass://` URI in configuration:

  ```json
  {
    "command": "pass-cli",
    "args": ["run", "--", "memory-mcp-stdio"],
    "env": {
      "MEMORY_PAT": "pass://Development/Memory Server PAT - personal CLI - 2026-08-13/password",
      "MEMORY_SERVER_URL": "https://memory.allenlim.net",
      "PROTON_PASS_AGENT_REASON": "Use personal Memory MCP without browser approval"
    }
  }
  ```

  `pass-cli run` resolves the PAT only in the bridge's child environment.
  `devin mcp login` is not required. Claude hooks remain unsupported by Devin.

## Manual memory operations

Use the MCP tools directly when they are available. The optional `mem` CLI can
also manage memories. A plugin install does not add it to `PATH`; from this
repository run `npm exec --workspace allenlim-memory-server -- mem ...`, or
first run `npm link --workspace allenlim-memory-server` to create `mem`:

```bash
# Check authentication status
mem whoami

# Store a credential from a secret manager without browser approval or argv exposure
secret-manager-command | mem auth set --api-key-stdin
secret-manager-command | mem auth set --pat-stdin
mem auth status

# Add a memory
mem add "User prefers dark mode"

# Search memories (hybrid search with synthesized answer)
mem search "dark mode preferences"

# Ingest a conversation (JSON array of {role, content})
echo '[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]' | mem ingest

# Get a specific memory by ID
mem get 01KZR5ZD6ZMQNQ36FR98EP4Y40

# List memories (optionally filtered by type or session)
mem list --type fact
mem list --session my-session-id

# Delete a memory
mem delete 01KZR5ZD6ZMQNQ36FR98EP4Y40

# Delete all memories for a session
mem delete-session my-session-id --yes

# Generate a structured summary
mem summary

# Show memory statistics
mem stats

# Login (if not authenticated)
mem login

# Logout
mem logout
```

## Configuration

The memory server URL defaults to `https://memory.allenlim.net`.
`MEMORY_SERVER_URL` and `MEMORY_AUTH_API_URL` require HTTPS except for explicit
loopback development URLs.

`mem login` uses OAuth state and PKCE S256 with a temporary loopback callback;
tokens are never copied through the terminal. The 15-minute access token is
automatically refreshed for up to 30 days. Rotated credentials are stored
atomically in `~/.memory/credentials.json` with owner-only permissions. For
CI/headless use, prefer `MEMORY_API_KEY`; `MEMORY_TOKEN` is a non-renewable
override.

The CLI reuses a recent public OAuth client registration across ephemeral
loopback ports to avoid unbounded registrations. This public identifier (not a
credential) is stored in `~/.memory/oauth-client.json`. If an administrator has
removed that registration, retry once with `mem login --new-client`.

For API-key authentication, set `MEMORY_API_KEY`; for PAT authentication, set
`MEMORY_PAT`. Environment credentials take precedence over the owner-only
`~/.memory/service-credential.json`, which takes precedence over
`MEMORY_TOKEN` and stored SSO credentials. Setting both environment variables
fails closed. API keys send only `x-memory-api-key`; PATs send only
`Authorization: Bearer memory_pat_...`. Neither sends `x-memory-scope`.
The server determines the memory profile and permissions associated with the
key, so `MEMORY_SCOPE` applies only to JWT authentication.

Set `MEMORY_REQUEST_TIMEOUT_MS` to change the per-request timeout. It defaults
to 10 seconds and is clamped to 100-60000 milliseconds.

## Tips

- Memories are scoped to your user ID (JWT `sub`) by default.
- With API-key auth, memories are scoped to the profile assigned to the key.
- Claude transcript capture is incremental. Privacy-preserving checkpoints
  under `~/.memory/transcript-checkpoints/` contain hashes and byte offsets,
  never transcript paths, conversation content, session IDs, or credentials.
- Agent Memory automatically classifies memories as **fact**, **event**,
  **instruction**, or **task**.
- If a newer fact/instruction replaces an older one on the same topic, the
  old version is preserved but the latest surfaces in recall.
- `memory_ingest` is idempotent — re-ingesting the same conversation creates
  no duplicates.
- Each ingest accepts at most 100 messages, 32 KiB of UTF-8 content per
  message, and 1 MiB of message content in total.
- Use `memory_summary` to get a structured Markdown overview of everything
  stored in memory.

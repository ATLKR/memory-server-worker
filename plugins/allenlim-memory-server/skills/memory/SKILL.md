---
name: memory
description: Personal persistent memory tools and client-specific recall/capture guidance. Use MCP tools directly or the optional repository `mem` CLI.
---

# Memory Skill

You have access to a personal persistent memory system. Memories are stored in
[Cloudflare Agent Memory](https://developers.cloudflare.com/agent-memory/) —
a managed service with automatic extraction, classification, deduplication,
supersession, and hybrid search (keyword + semantic + topic key).
Authentication uses either a server-issued API key or Allen Labs SSO
(JWT/JWKS). API keys are suitable for CI, services, and headless automation.

## How it works by client

- **Claude Code, before each prompt**: The `UserPromptSubmit` hook searches
  the memory server for memories relevant to your current prompt and injects
  them as additional context.

- **Claude Code, after each turn**: The `Stop` hook ingests the conversation
  messages into Agent Memory, which extracts facts, events, instructions, and
  tasks automatically. This happens silently.

- **Codex**: The registered Memory app provides all nine MCP tools. The recall
  and capture skills direct the agent to call them; Claude hooks are not used.

- **Devin**: This plugin supplies skills only. The remote HTTP MCP must be
  added separately at `https://memory.allenlim.net/mcp`; Claude hooks are not
  supported by Devin's plugin package.

  ```bash
  devin mcp add --scope user allenlim-memory-server https://memory.allenlim.net/mcp --oauth-resource https://memory.allenlim.net
  devin mcp login allenlim-memory-server --scopes openid,profile,email,offline_access,memory:read,memory:write,memory:delete --oauth-resource https://memory.allenlim.net
  ```

  Keep the explicit `--oauth-resource` value: Devin otherwise derives it from
  the `/mcp` endpoint URL, while Memory access tokens are audience-bound to the
  protected resource origin.

## Manual memory operations

Use the MCP tools directly when they are available. The optional `mem` CLI can
also manage memories. A plugin install does not add it to `PATH`; from this
repository run `npm exec --workspace allenlim-memory-server -- mem ...`, or
first run `npm link --workspace allenlim-memory-server` to create `mem`:

```bash
# Check authentication status
mem whoami

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

For API-key authentication, set `MEMORY_API_KEY`. It takes precedence over
`MEMORY_TOKEN` and stored SSO credentials. In API-key mode, the client sends
only `x-memory-api-key`; it does not send `Authorization` or `x-memory-scope`.
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

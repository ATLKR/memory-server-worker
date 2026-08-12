---
name: memory
description: Personal persistent memory — auto-recalls relevant memories before each prompt and captures conversation summaries after each turn. Use `mem` CLI to manually add, search, get, list, or delete memories.
---

# Memory Skill

You have access to a personal persistent memory system. Memories are stored in
[Cloudflare Agent Memory](https://developers.cloudflare.com/agent-memory/) —
a managed service with automatic extraction, classification, deduplication,
supersession, and hybrid search (keyword + semantic + topic key).
Authentication is via Allen Labs SSO (JWT/JWKS).

## How it works

- **Before each prompt**: The `UserPromptSubmit` hook automatically searches
  the memory server for memories relevant to your current prompt and injects
  them as additional context. You don't need to do anything — just use the
  recalled memories as relevant context.

- **After each turn**: The `Stop` hook automatically ingests the conversation
  messages into Agent Memory, which extracts facts, events, instructions, and
  tasks automatically. This happens silently.

## Manual memory operations

Use the `mem` CLI to manually manage memories:

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
mem delete-session my-session-id

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
Override with the `MEMORY_SERVER_URL` environment variable if needed.

Credentials are stored in `~/.memory/credentials.json` after `mem login`.
For CI/headless use, set `MEMORY_TOKEN` to a JWT directly.

## Tips

- Memories are scoped to your user ID (JWT `sub`) by default.
- Agent Memory automatically classifies memories as **fact**, **event**,
  **instruction**, or **task**.
- If a newer fact/instruction replaces an older one on the same topic, the
  old version is preserved but the latest surfaces in recall.
- `memory_ingest` is idempotent — re-ingesting the same conversation creates
  no duplicates.
- Use `memory_summary` to get a structured Markdown overview of everything
  stored in memory.

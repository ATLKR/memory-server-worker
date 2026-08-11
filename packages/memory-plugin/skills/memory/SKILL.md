---
name: memory
description: Personal persistent memory — auto-recalls relevant memories before each prompt and captures conversation summaries after each turn. Use `mem` CLI to manually add, search, get, list, update, or delete memories.
---

# Memory Skill

You have access to a personal persistent memory system. Memories are stored in
a Cloudflare Worker (`https://memory.allenlim.net`) with Durable Object SQLite
+ FTS5 full-text search. Authentication is via Allen Labs SSO (JWT/JWKS).

## How it works

- **Before each prompt**: The `UserPromptSubmit` hook automatically searches
  the memory server for memories relevant to your current prompt and injects
  them as additional context. You don't need to do anything — just use the
  recalled memories as relevant context.

- **After each turn**: The `Stop` hook automatically captures a summary of the
  conversation (user's question + your response) as a memory entry in the
  `conversations` namespace. This happens silently.

## Manual memory operations

Use the `mem` CLI to manually manage memories:

```bash
# Check authentication status
mem whoami

# Add a memory
mem add "User prefers dark mode" --key preference-theme --namespace preferences --tags ui,theme

# Search memories (FTS5 full-text search)
mem search "dark mode preferences"

# Get a specific memory by key
mem get preference-theme

# List all memories (optionally filtered by namespace or tag)
mem list --namespace preferences
mem list --tag ui

# Update a memory (append or replace)
mem update preference-theme --content "Also prefers Monokai" --append

# Delete a memory
mem delete preference-theme

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
- Use namespaces to organize memories (e.g., `preferences`, `projects`, `facts`).
- Use tags for cross-namespace filtering (e.g., `ui`, `cloudflare`, `auth`).
- The FTS5 search supports multi-word queries and ranks by relevance.
- Conversation summaries are auto-captured with the `auto-captured` tag in the `conversations` namespace.

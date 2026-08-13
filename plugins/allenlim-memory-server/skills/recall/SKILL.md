---
name: recall
description: Search personal memories for relevant context before responding to the user. Always run memory_search at the start of EVERY conversation turn — no exceptions.
---

# Recall Memories

**Always** call `memory_search` at the start of **every** user message, before
you respond. No exceptions. This is your persistent memory — without searching,
you will miss context from previous conversations, decisions, and preferences.

## When to activate

- **Every** user message, without exception.
- Even short messages like "yes", "continue", or "what do you think?" may
  reference prior context stored in memory.
- Even if the topic seems new — the user may have discussed related things
  before that you should recall.

## Procedure

1. Take the user's message and use it as the search query for `memory_search`.
   - The query is natural language — Agent Memory runs hybrid search
     (keyword + semantic + topic key) and returns a synthesized answer.
   - Keep the query under 1 KB.
2. If the first search returns nothing useful, try a second search with
   broader or different terms.

## What you get back

`memory_search` returns:

- **`answer`** — a synthesized answer grounded in stored content. This is
  the most useful field — it combines relevant memories into a coherent
  response.
- **`candidates`** — individual scored memory entries that matched the
  query. Each has `id`, `summary`, `sessionId`, and `score`.

## Example

```
memory_search({ query: "what editor does the user prefer?" })
```

Returns:

```json
{
  "answer": "User prefers dark mode with large fonts in code editors.",
  "count": 1,
  "candidates": [
    {
      "id": "01KZR5ZD6Z...",
      "summary": "Prefers dark mode with large fonts in code editors",
      "sessionId": null,
      "score": 0.93
    }
  ]
}
```

## Additional tools

- **`memory_summary`** — get a structured Markdown summary of everything
  stored in memory. Useful for bootstrapping a new session.
- **`memory_list`** — list all memories, optionally filtered by type
  (fact/event/instruction/task) or session ID.
- **`memory_get`** — fetch a single memory by its ID for full content.

## Authentication

The plugin accepts `MEMORY_API_KEY` for service/headless use, `MEMORY_PAT` for
browser-free personal use, or renewable OAuth credentials from the plugin CLI
login. `mem auth set --api-key-stdin|--pat-stdin` stores a credential locally
without exposing it in argv. `MEMORY_TOKEN` is a non-renewable JWT override.

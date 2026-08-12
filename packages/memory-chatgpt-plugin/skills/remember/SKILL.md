---
name: remember
description: Explicitly store or recall a memory when the user says "remember this", "remember that", "what do you remember about", "recall", or asks you to save something for later.
---

# Remember

The user explicitly asked you to remember or recall something. Use the memory
tools to fulfill their request.

## Trigger phrases

- "Remember that..." / "Remember this..."
- "Don't forget that..."
- "Save this for later"
- "What do you know about..." / "What do you remember about..."
- "Do you remember..."
- "Recall..."
- "Look up..." / "Find what I said about..."
- "What did we decide about..."

## When the user says "remember this"

1. Call `memory_add` with the content the user wants to remember.
   - Agent Memory will automatically classify it as a fact, event,
     instruction, or task and generate a summary.
   - If a similar fact or instruction already exists, the new one
     supersedes the old (history is preserved).

```
memory_add({
  content: "User wants to use PostgreSQL for the new project database"
})
```

## When the user asks "what do you remember about..."

1. Call `memory_search` with the topic as the query.
2. Share the synthesized `answer` with the user.
3. If they want more detail, use `memory_get` with a candidate's `id` to
   fetch the full content.

```
memory_search({ query: "what database did the user choose?" })
```

## When the user says "forget..."

1. If they reference a specific memory, use `memory_search` to find it,
   then `memory_delete` with the memory's `id`.
2. If they want to forget an entire session, use `memory_delete_session`
   with the session ID.

```
memory_delete({ id: "01KZR5ZD6ZMQNQ36FR98EP4Y40" })
```

## Available tools

| Tool | Description |
|------|-------------|
| `memory_add` | Store a single memory explicitly |
| `memory_search` | Hybrid search with synthesized answer |
| `memory_ingest` | Extract memories from a conversation |
| `memory_list` | List memories (filter by type/session) |
| `memory_get` | Fetch a single memory by ID |
| `memory_delete` | Delete a memory by ID |
| `memory_delete_session` | Delete all memories for a session |
| `memory_summary` | Structured Markdown summary of all memories |
| `memory_stats` | Total count + per-type breakdown |

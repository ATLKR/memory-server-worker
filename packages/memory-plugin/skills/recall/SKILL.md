---
name: recall
description: Search personal memories for relevant context before responding to the user. Always run memory_search at the start of every conversation turn to recall stored knowledge.
---

# Recall Memories

**Always** call `memory_search` at the start of every user message, before you
respond. This is your persistent memory — without searching, you will miss
context from previous conversations.

## When to activate

- **Every** user message, without exception.
- Even short messages like "yes", "continue", or "what do you think?" may
  reference prior context stored in memory.

## Procedure

1. Take the user's message and use it as the search query for `memory_search`.
   - If the message is very short (under 3 words), also try searching with
     related terms from the conversation context.
   - Use `limit: 5` (the default) for most queries.
2. Review the returned memories. They are ranked by relevance.
3. Use the recalled memories as context for your response:
   - If a memory directly answers or relates to the user's question, reference
     it naturally.
   - If memories contradict each other, prefer the most recently updated one
     and note the discrepancy.
   - If no memories are returned, proceed normally — this is expected for new
     topics.
4. Do NOT tell the user "I searched my memory" unless they ask. Just use the
     context silently, the same way you'd use conversation history.

## Search tips

- The search is full-text (FTS5), so multi-word queries work well.
- If the user mentions a project name, person, or specific term, include it
  in the query.
- If the user asks about preferences, also search with the word "preference"
  or "prefer".
- If the user asks about a past decision, also search with "decision" or
  "decided".

## Example

User: "What editor theme did I settle on?"

→ Call `memory_search` with query "editor theme"
→ Memory returns: `{ key: "preference-theme", content: "User prefers dark mode and Monokai syntax highlighting" }`
→ Respond: "You settled on dark mode with Monokai syntax highlighting."

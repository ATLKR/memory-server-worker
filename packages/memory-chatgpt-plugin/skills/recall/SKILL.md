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
   - If the message is very short (under 3 words), also try searching with
     related terms from the conversation context.
   - Use `limit: 10` for most queries to get broader context.
2. If the first search returns nothing useful, try a second search with
   broader or different terms. For example:
   - User says "let's continue" → search "continue" AND the main topic
     from recent conversation history.
   - User mentions a project name → search the project name AND "project".
3. Review the returned memories. They are ranked by relevance.
4. Use the recalled memories as context for your response:
   - If a memory directly answers or relates to the user's question, reference
     it naturally.
   - If memories contradict each other, prefer the most recently updated one
     and note the discrepancy.
   - If no memories are returned, proceed normally — this is expected for
     genuinely new topics.
5. Do NOT tell the user "I searched my memory" unless they ask. Just use the
   context silently, the same way you'd use conversation history.

## What you'll find in memory

- **Preferences** — editor settings, tool choices, workflow habits, coding style.
- **Decisions** — technology choices, architecture decisions, approach selections.
- **Facts** — name, role, timezone, workspace setup, ongoing projects.
- **Project context** — project names, goals, tech stacks, file paths, repos.
- **Conversation summaries** — what was discussed and decided in past chats.
- **Corrections** — things the user corrected you on so you don't repeat mistakes.

## Search tips

- The search is full-text (FTS5), so multi-word queries work well.
- If the user mentions a project name, person, or specific term, include it
  in the query.
- If the user asks about preferences, also search with "preference" or "prefer".
- If the user asks about a past decision, also search with "decision" or "decided".
- If the user asks "what did we talk about", search "conversation" and
  "summary" in the `conversations` namespace.

## Example

User: "What editor theme did I settle on?"

→ Call `memory_search` with query "editor theme"
→ Memory returns: `{ key: "preference-theme", content: "User prefers dark mode and Monokai syntax highlighting" }`
→ Respond: "You settled on dark mode with Monokai syntax highlighting."

User: "Let's continue with the auth setup."

→ Call `memory_search` with query "auth setup"
→ Memory returns: `{ key: "project-memory-auth", content: "Using Allen Labs Auth with JWT/JWKS. OAuth 2.1 provider added for ChatGPT MCP connector." }`
→ Respond with full context of where the auth setup left off.

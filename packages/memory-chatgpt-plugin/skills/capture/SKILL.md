---
name: capture
description: Save important information to memory after each conversation turn. Capture user preferences, decisions, facts, project details, corrections, and conversation summaries so they can be recalled in future conversations.
---

# Capture Memories

After you finish responding to the user, save any new, valuable information to
memory using `memory_add`. This ensures future conversations can recall what
was discussed and decided. **When in doubt, save it.**

## When to capture

Save a memory entry when the conversation reveals any of the following:

- **User preferences** — editor settings, tool choices, workflow habits,
  coding style, UI preferences, language preferences.
- **Decisions** — technology choices, architecture decisions, approach
  selections, "let's go with X" statements, "I prefer X over Y" statements.
- **Facts about the user** — name, role, timezone, workspace setup, ongoing
  projects, environment details.
- **Project context** — project names, goals, tech stacks, file paths,
  repository URLs, deployment targets, architecture overviews.
- **Corrections** — when the user corrects you or clarifies a misconception,
  save the correction so you don't repeat the mistake.
- **Important outcomes** — when a task is completed, a bug is fixed, or a
  milestone is reached.
- **Conversation summaries** — at the end of every substantive turn, save a
  brief summary of what was discussed.

## When NOT to capture

- Sensitive data (passwords, tokens, secrets, API keys).
- Ephemeral details that won't matter in future conversations.
- Exact duplicate of an existing memory (search first to check).

## Procedure

1. **Before saving**, call `memory_search` with the key topic to check if a
   similar memory already exists.
   - If a memory exists and needs updating, use `memory_update` with
     `appendContent: true` to add new information.
   - If no matching memory exists, use `memory_add` to create a new one.
2. **Choose a descriptive `key`** — use kebab-case, make it specific and
   searchable. Examples:
   - `preference-editor-theme`
   - `project-memory-server-stack`
   - `decision-auth-jwt-vs-static-token`
   - `fact-user-timezone`
3. **Choose a `namespace`** — group related memories:
   - `preferences` — user preferences and habits
   - `projects` — project details and context
   - `decisions` — architectural and design decisions
   - `facts` — general facts about the user or environment
   - `conversations` — conversation summaries
4. **Add `tags`** for cross-namespace filtering. Examples: `ui`, `auth`,
   `cloudflare`, `config`, `windows`, `typescript`.
5. **Write clear content** — future-you should be able to understand the
   memory without the surrounding conversation context. Include:
   - What was decided/learned/preferred.
   - Why (if a reason was given).
   - Any relevant context (e.g., "decided because X is faster than Y").

## Conversation summaries

At the end of **every substantive conversation turn**, save a brief summary:

```
key: turn-<topic-slug>-<YYYY-MM-DD-HHMM>
namespace: conversations
tags: ["auto-captured", "<topic-tag>"]
content: |
  ## Conversation Turn

  **User asked:** <brief summary of the question/request>

  **What was done:** <brief summary of what was accomplished>

  **Key decisions/outcomes:** <any decisions made or conclusions reached>
```

Save conversation summaries even for moderately substantive exchanges. It's
better to have too many memories than too few — the search will filter by
relevance when recalling.

## Example

User: "Let's use Cloudflare Durable Objects for the memory store instead of KV."

→ After responding, call `memory_search` with "memory store durable objects"
→ No existing memory found
→ Call `memory_add`:
  - key: `decision-memory-store-durable-objects`
  - namespace: `decisions`
  - tags: `["architecture", "cloudflare", "memory"]`
  - content: `Decided to use Cloudflare Durable Objects for the memory store instead of KV. Durable Objects provide per-scope SQLite databases with FTS5 search, which is better for structured memory than KV's flat key-value model.`

→ Also save a conversation summary:
  - key: `turn-memory-store-2026-08-11-1430`
  - namespace: `conversations`
  - tags: `["auto-captured", "architecture"]`
  - content: `User asked about memory store technology. Decided to use Cloudflare Durable Objects instead of KV for SQLite + FTS5 search capabilities.`

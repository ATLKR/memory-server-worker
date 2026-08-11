---
name: capture
description: Save important information to memory after each conversation turn. Capture user preferences, decisions, facts, project details, and conversation summaries so they can be recalled in future conversations.
---

# Capture Memories

After you finish responding to the user, save any new, valuable information to
memory using `memory_add`. This ensures future conversations can recall what
was discussed and decided.

## When to capture

Save a memory entry when the conversation reveals any of the following:

- **User preferences** — editor settings, tool choices, workflow habits,
  coding style, UI preferences.
- **Decisions** — technology choices, architecture decisions, approach
  selections, "let's go with X" statements.
- **Facts about the user** — name, role, timezone, workspace setup, ongoing
  projects.
- **Project context** — project names, goals, tech stacks, file paths,
  repository URLs, deployment targets.
- **Corrections** — when the user corrects you or clarifies a misconception,
  save the correction so you don't repeat the mistake.
- **Important outcomes** — when a task is completed, a bug is fixed, or a
  milestone is reached.

## When NOT to capture

- Casual conversation or small talk with no lasting value.
- Information already stored in memory (search first to avoid duplicates).
- Sensitive data (passwords, tokens, secrets, API keys).
- Ephemeral details that won't matter in future conversations.

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
   - `conversations` — conversation summaries (auto-captured)
4. **Add `tags`** for cross-namespace filtering. Examples: `ui`, `auth`,
   `cloudflare`, `config`.
5. **Write clear content** — future-you should be able to understand the
   memory without the surrounding conversation context. Include:
   - What was decided/learned/preferred.
   - Why (if a reason was given).
   - When (timestamp is auto-added).

## Conversation summaries

At the end of a substantive conversation (not every turn), save a brief
summary:

```
key: turn-<topic-slug>-<timestamp>
namespace: conversations
tags: ["auto-captured"]
content: |
  ## Conversation Summary

  **User asked:** <brief summary of the question>

  **Outcome:** <brief summary of what was done/decided>
```

Only save conversation summaries when the exchange had real substance —
not for quick Q&A or confirmations.

## Example

User: "Let's use Cloudflare Durable Objects for the memory store instead of KV."

→ After responding, call `memory_search` with "memory store durable objects"
→ No existing memory found
→ Call `memory_add`:
  - key: `decision-memory-store-durable-objects`
  - namespace: `decisions`
  - tags: `["architecture", "cloudflare", "memory"]`
  - content: `Decided to use Cloudflare Durable Objects for the memory store instead of KV. Durable Objects provide per-scope SQLite databases with FTS5 search, which is better for structured memory than KV's flat key-value model.`

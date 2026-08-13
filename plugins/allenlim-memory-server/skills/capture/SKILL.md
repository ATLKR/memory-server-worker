---
name: capture
description: Save important information to memory after each conversation turn. Capture user preferences, decisions, facts, project details, corrections, and conversation summaries so they can be recalled in future conversations.
---

# Capture Memories

After you finish responding to the user, save any new, valuable information to
memory. This ensures future conversations can recall what was discussed and
decided. **When in doubt, save it.**

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

## How to capture

There are two ways to save memories:

### 1. `memory_ingest` — automatic extraction (preferred for conversations)

Pass the conversation messages to `memory_ingest`. Agent Memory will
automatically identify and extract facts, events, instructions, and tasks
from the conversation. This is the preferred method after a conversation
turn because it handles classification, deduplication, and supersession
automatically.

```
memory_ingest({
  messages: [
    { role: "user", content: "..." },
    { role: "assistant", content: "..." }
  ]
})
```

Keep each call within the server contract: at most **100 messages**, no more
than **32 KiB of UTF-8 content per message**, and no more than **1 MiB of
message content in total**. For longer conversations, retain the newest
relevant messages and trim older context first.

### 2. `memory_add` — explicit single memory

Use `memory_add` when you know exactly what should be stored and want to
save it as a specific entry. Agent Memory will still classify and summarize
it automatically.

```
memory_add({
  content: "User prefers TypeScript for all new projects"
})
```

## Important notes

- Agent Memory automatically classifies memories as **fact**, **event**,
  **instruction**, or **task**.
- If a similar fact or instruction already exists, the new one **supersedes**
  the old (the old version is preserved but the new one surfaces in recall).
- `memory_ingest` is **idempotent** — re-ingesting the same conversation
  does not create duplicates.
- Ingest requests are limited to 100 messages, 32 KiB per message, and
  1 MiB of UTF-8 message content in total.
- Do not ingest after every single message. Do it after a meaningful
  conversation turn or when the user goes idle.
- Claude Stop hooks capture only complete, previously unacknowledged JSONL
  records. A checkpoint advances after each successful ingest batch, so a
  timeout or server failure is retried without skipping later messages.
- Configure `MEMORY_API_KEY` for API-key auth, or use the plugin CLI login for
  a renewable 30-day OAuth session. `MEMORY_TOKEN` is a non-renewable JWT
  override. API-key auth takes precedence and does not send JWT scope.

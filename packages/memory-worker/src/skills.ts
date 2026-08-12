/**
 * MCP Skills extension — serves skill files to ChatGPT's "Scan Tools"
 * import flow.
 *
 * Implements the draft SEP-2640 Skills extension:
 *   - capabilities.extensions["io.modelcontextprotocol/skills"]
 *   - skills/list  — paginated catalog of skills
 *   - skills/get   — fetch a single skill entry
 *   - resources/read — fetch a skill resource by URI
 *
 * Skill content is embedded as string constants (not read from disk)
 * because Cloudflare Workers don't have a filesystem at runtime. The
 * source SKILL.md files live in skills/recall/ and skills/capture/ for
 * editing; this file is the canonical bundled copy.
 */

// ---------- Skill content (embedded at build time) ----------

const RECALL_SKILL_MD = `---
name: recall
description: Search personal memories for relevant context before responding to the user. Always run memory_search at the start of every conversation turn — no exceptions.
---

# Recall Memories

**Always** call \`memory_search\` at the start of **every** user message, before
you respond. No exceptions. This is your persistent memory — without searching,
you will miss context from previous conversations, decisions, and preferences.

## When to activate

- **Every** user message, without exception.
- Even short messages like "yes", "continue", or "what do you think?" may
  reference prior context stored in memory.
- Even if the topic seems new — the user may have discussed related things
  before that you should recall.

## Procedure

1. Take the user's message and use it as the search query for \`memory_search\`.
   - The query is natural language — Agent Memory runs hybrid search
     (keyword + semantic + topic key) and returns a synthesized answer.
   - Keep the query under 1 KB.
2. If the first search returns nothing useful, try a second search with
   broader or different terms.

## What you get back

\`memory_search\` returns:

- **\`answer\`** — a synthesized answer grounded in stored content. This is
  the most useful field — it combines relevant memories into a coherent
  response.
- **\`candidates\`** — individual scored memory entries that matched the
  query. Each has \`id\`, \`summary\`, \`sessionId\`, and \`score\`.

## Example

\`\`\`
memory_search({ query: "what editor does the user prefer?" })
\`\`\`

Returns:

\`\`\`json
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
\`\`\`

## Additional tools

- **\`memory_summary\`** — get a structured Markdown summary of everything
  stored in memory. Useful for bootstrapping a new session.
- **\`memory_list\`** — list all memories, optionally filtered by type
  (fact/event/instruction/task) or session ID.
- **\`memory_get\`** — fetch a single memory by its ID for full content.
`;

const CAPTURE_SKILL_MD = `---
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

### 1. \`memory_ingest\` — automatic extraction (preferred for conversations)

Pass the conversation messages to \`memory_ingest\`. Agent Memory will
automatically identify and extract facts, events, instructions, and tasks
from the conversation. This is the preferred method after a conversation
turn because it handles classification, deduplication, and supersession
automatically.

\`\`\`
memory_ingest({
  messages: [
    { role: "user", content: "..." },
    { role: "assistant", content: "..." }
  ]
})
\`\`\`

Keep each call within the server contract: at most **100 messages**, no more
than **32 KiB of UTF-8 content per message**, and no more than **1 MiB of
message content in total**. For longer conversations, retain the newest
relevant messages and trim older context first.

### 2. \`memory_add\` — explicit single memory

Use \`memory_add\` when you know exactly what should be stored and want to
save it as a specific entry. Agent Memory will still classify and summarize
it automatically.

\`\`\`
memory_add({
  content: "User prefers TypeScript for all new projects"
})
\`\`\`

## Important notes

- Agent Memory automatically classifies memories as **fact**, **event**,
  **instruction**, or **task**.
- If a similar fact or instruction already exists, the new one **supersedes**
  the old (the old version is preserved but the new one surfaces in recall).
- \`memory_ingest\` is **idempotent** — re-ingesting the same conversation
  does not create duplicates.
- Ingest requests are limited to 100 messages, 32 KiB per message, and
  1 MiB of UTF-8 message content in total.
- Do not ingest after every single message. Do it after a meaningful
  conversation turn or when the user goes idle.
`;

// ---------- Skill registry ----------

interface SkillResource {
  uri: string;
  digest: string;
}

interface SkillEntry {
  uri: string;
  frontmatter: {
    name: string;
    description: string;
  };
  resources: SkillResource[];
}

interface SkillFile {
  uri: string;
  content: string;
  digest: string;
}

/** SHA-256 digest of UTF-8 text content, formatted as sha256:<hex>.
 *  Uses Web Crypto API (available in Cloudflare Workers). */
async function sha256hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return "sha256:" + hex;
}

/** Parse YAML-like frontmatter from a SKILL.md file. */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = value;
  }
  return frontmatter;
}

// Skill content registry — digests are computed lazily on first access
// because Web Crypto's digest() is async.
const SKILL_CONTENT: Map<string, { uri: string; content: string }> = new Map([
  [
    "recall",
    { uri: "skill://memory/recall/SKILL.md", content: RECALL_SKILL_MD },
  ],
  [
    "capture",
    { uri: "skill://memory/capture/SKILL.md", content: CAPTURE_SKILL_MD },
  ],
]);

// Cached resolved skills (with digests), populated on first access.
let SKILLS_CACHE: Map<string, SkillFile[]> | null = null;

async function ensureSkillsLoaded(): Promise<Map<string, SkillFile[]>> {
  if (SKILLS_CACHE) return SKILLS_CACHE;
  const cache = new Map<string, SkillFile[]>();
  for (const [name, { uri, content }] of SKILL_CONTENT) {
    const digest = await sha256hex(content);
    cache.set(name, [{ uri, content, digest }]);
  }
  SKILLS_CACHE = cache;
  return cache;
}

/** Build a skill catalog entry for skills/list + skills/get. */
function buildSkillEntry(skillName: string, files: SkillFile[]): SkillEntry {
  const skillMd = files.find((f) => f.uri.endsWith("SKILL.md"));
  if (!skillMd) throw new Error(`No SKILL.md found for skill ${skillName}`);

  const fm = parseFrontmatter(skillMd.content);
  return {
    uri: skillMd.uri,
    frontmatter: {
      name: fm.name ?? skillName,
      description: fm.description ?? "",
    },
    resources: files.map((f) => ({ uri: f.uri, digest: f.digest })),
  };
}

/** Handle skills/list — paginated catalog of all skills. */
export async function handleSkillsList(params: {
  cursor?: string;
}): Promise<{ skills: SkillEntry[]; nextCursor?: string }> {
  const SKILLS = await ensureSkillsLoaded();
  const allNames = [...SKILLS.keys()].sort();
  const cursor = params.cursor;
  const startIndex = cursor ? parseInt(cursor, 10) || 0 : 0;

  const PAGE_SIZE = 10;
  const pageNames = allNames.slice(startIndex, startIndex + PAGE_SIZE);
  const skills: SkillEntry[] = [];

  for (const name of pageNames) {
    const files = SKILLS.get(name);
    if (!files) continue;
    try {
      skills.push(buildSkillEntry(name, files));
    } catch (err) {
      console.error(`[skills] Failed to build entry for ${name}:`, err);
    }
  }

  const nextIndex = startIndex + PAGE_SIZE;
  const nextCursor = nextIndex < allNames.length ? String(nextIndex) : undefined;

  return { skills, nextCursor };
}

/** Handle skills/get — fetch a single skill entry by URI. */
export async function handleSkillsGet(params: {
  uri: string;
}): Promise<{ skill: SkillEntry } | null> {
  const SKILLS = await ensureSkillsLoaded();
  for (const [name, files] of SKILLS) {
    const skillMd = files.find((f) => f.uri === params.uri);
    if (skillMd) {
      try {
        return { skill: buildSkillEntry(name, files) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Handle resources/read — fetch a resource by URI. */
export async function handleResourceRead(params: {
  uri: string;
}): Promise<{ contents: { uri: string; text: string }[] } | null> {
  const SKILLS = await ensureSkillsLoaded();
  for (const files of SKILLS.values()) {
    const file = files.find((f) => f.uri === params.uri);
    if (file) {
      return {
        contents: [{ uri: file.uri, text: file.content }],
      };
    }
  }
  return null;
}

/** Whether any skills are available. */
export function hasSkills(): boolean {
  return SKILL_CONTENT.size > 0;
}

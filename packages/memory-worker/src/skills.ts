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
description: Search personal memories for relevant context before responding to the user. Always run memory_search at the start of every conversation turn to recall stored knowledge.
---

# Recall Memories

**Always** call \`memory_search\` at the start of every user message, before you
respond. This is your persistent memory — without searching, you will miss
context from previous conversations.

## When to activate

- **Every** user message, without exception.
- Even short messages like "yes", "continue", or "what do you think?" may
  reference prior context stored in memory.

## Procedure

1. Take the user's message and use it as the search query for \`memory_search\`.
   - If the message is very short (under 3 words), also try searching with
     related terms from the conversation context.
   - Use \`limit: 5\` (the default) for most queries.
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

→ Call \`memory_search\` with query "editor theme"
→ Memory returns: \`{ key: "preference-theme", content: "User prefers dark mode and Monokai syntax highlighting" }\`
→ Respond: "You settled on dark mode with Monokai syntax highlighting."
`;

const CAPTURE_SKILL_MD = `---
name: capture
description: Save important information to memory after each conversation turn. Capture user preferences, decisions, facts, project details, and conversation summaries so they can be recalled in future conversations.
---

# Capture Memories

After you finish responding to the user, save any new, valuable information to
memory using \`memory_add\`. This ensures future conversations can recall what
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

1. **Before saving**, call \`memory_search\` with the key topic to check if a
   similar memory already exists.
   - If a memory exists and needs updating, use \`memory_update\` with
     \`appendContent: true\` to add new information.
   - If no matching memory exists, use \`memory_add\` to create a new one.
2. **Choose a descriptive \`key\`** — use kebab-case, make it specific and
   searchable. Examples:
   - \`preference-editor-theme\`
   - \`project-memory-server-stack\`
   - \`decision-auth-jwt-vs-static-token\`
   - \`fact-user-timezone\`
3. **Choose a \`namespace\`** — group related memories:
   - \`preferences\` — user preferences and habits
   - \`projects\` — project details and context
   - \`decisions\` — architectural and design decisions
   - \`facts\` — general facts about the user or environment
   - \`conversations\` — conversation summaries (auto-captured)
4. **Add \`tags\`** for cross-namespace filtering. Examples: \`ui\`, \`auth\`,
   \`cloudflare\`, \`config\`.
5. **Write clear content** — future-you should be able to understand the
   memory without the surrounding conversation context. Include:
   - What was decided/learned/preferred.
   - Why (if a reason was given).
   - When (timestamp is auto-added).

## Conversation summaries

At the end of a substantive conversation (not every turn), save a brief
summary:

\`\`\`
key: turn-<topic-slug>-<timestamp>
namespace: conversations
tags: ["auto-captured"]
content: |
  ## Conversation Summary

  **User asked:** <brief summary of the question>

  **Outcome:** <brief summary of what was done/decided>
\`\`\`

Only save conversation summaries when the exchange had real substance —
not for quick Q&A or confirmations.

## Example

User: "Let's use Cloudflare Durable Objects for the memory store instead of KV."

→ After responding, call \`memory_search\` with "memory store durable objects"
→ No existing memory found
→ Call \`memory_add\`:
  - key: \`decision-memory-store-durable-objects\`
  - namespace: \`decisions\`
  - tags: \`["architecture", "cloudflare", "memory"]\`
  - content: \`Decided to use Cloudflare Durable Objects for the memory store instead of KV. Durable Objects provide per-scope SQLite databases with FTS5 search, which is better for structured memory than KV's flat key-value model.\`
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

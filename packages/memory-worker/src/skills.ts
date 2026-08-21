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
 * The editable source files live in skills/recall/ and skills/capture/.
 * scripts/generate-skills.mjs turns those files into the generated module
 * imported below so the Worker bundle never depends on a runtime filesystem.
 */
import {
  CAPTURE_SKILL_MD,
  RECALL_SKILL_MD,
} from "./skills-content.generated";

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

// Skill content is generated from the editable SKILL.md sources. Digests are
// computed lazily on first access because Web Crypto's digest() is async.
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
      const rawErrorType = err instanceof Error ? err.name : typeof err;
      console.error(JSON.stringify({
        level: "error",
        event: "skill_entry_build_failed",
        skill: name,
        errorType: /^[A-Za-z0-9_.-]{1,64}$/.test(rawErrorType)
          ? rawErrorType
          : "UnknownError",
      }));
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

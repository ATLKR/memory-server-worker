/**
 * Hook runner — entry point for lifecycle hooks invoked by hooks.json.
 *
 * Usage:
 *   node cli.mjs hook pre-prompt    # Claude Code: UserPromptSubmit
 *   node cli.mjs hook post-turn     # Claude Code: Stop
 *
 * Reads the hook event data from stdin (JSON) and outputs the hook-specific
 * JSON response on stdout. Fails silently (exit 0, no output) on errors so
 * it never blocks the conversation.
 */

import { readFileSync } from "node:fs";
import { memory, readStdin } from "./lib.mjs";

export async function runHook(hookName) {
  switch (hookName) {
    case "pre-prompt":
    case "UserPromptSubmit":
      return runPrePrompt();
    case "post-turn":
    case "Stop":
      return runPostTurn();
    default:
      console.error(`[memory-plugin] Unknown hook: ${hookName}`);
      process.exit(0);
  }
}

// --- Pre-prompt: search memories and inject as context ---

async function runPrePrompt() {
  const raw = await readStdin();
  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    hookInput = { prompt: raw.trim() };
  }

  const prompt = hookInput.prompt ?? "";
  if (!prompt) {
    process.exit(0);
  }

  const query = prompt.slice(0, 500);

  try {
    const resultsText = await memory.search({ query, limit: 5 });
    const results = JSON.parse(resultsText);
    const memories = results.results ?? [];

    if (memories.length === 0) {
      process.exit(0);
    }

    const lines = memories.map((m, i) => {
      const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
      const ns = m.namespace && m.namespace !== "default" ? ` (${m.namespace})` : "";
      return `### Memory ${i + 1}${ns}${tags}\nKey: ${m.key ?? m.id}\n${m.content}`;
    });

    const additionalContext =
      `--- Retrieved from Personal Memory (${memories.length} entries) ---\n` +
      `The following memories were recalled based on your current prompt. ` +
      `Use them as relevant context, but verify against the actual task:\n\n` +
      lines.join("\n\n") +
      `\n\n--- End of Retrieved Memories ---`;

    const output = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    };
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    console.error(`[memory-plugin:pre-prompt] ${err.message}`);
    process.exit(0);
  }
}

// --- Post-turn: store conversation summary ---

async function runPostTurn() {
  const raw = await readStdin();
  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  if (hookInput.stop_hook_active) {
    process.exit(0);
  }

  const transcriptPath = hookInput.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  let transcript;
  try {
    transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  } catch {
    process.exit(0);
  }

  if (!Array.isArray(transcript) || transcript.length === 0) {
    process.exit(0);
  }

  const lastUser = [...transcript].reverse().find((m) => m.role === "user");
  const lastAssistant = [...transcript].reverse().find((m) => m.role === "assistant");

  if (!lastUser || !lastAssistant) {
    process.exit(0);
  }

  const userText = extractText(lastUser);
  const assistantText = extractText(lastAssistant);

  if (!userText && !assistantText) {
    process.exit(0);
  }

  const maxLen = 2000;
  const content =
    `## Conversation Summary\n\n` +
    `**User asked:**\n${truncate(userText, maxLen / 2)}\n\n` +
    `**Assistant responded:**\n${truncate(assistantText, maxLen / 2)}\n\n` +
    `*Session: ${hookInput.session_id ?? "unknown"}*\n` +
    `*Timestamp: ${new Date().toISOString()}*`;

  const key = `turn-${slugify(truncate(userText, 60))}-${Date.now()}`;

  try {
    await memory.add({
      content,
      key,
      namespace: "conversations",
      tags: ["auto-captured"],
      metadata: {
        session_id: hookInput.session_id,
        captured_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(`[memory-plugin:post-turn] ${err.message}`);
  }

  process.exit(0);
}

function extractText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (msg.message) return extractText(msg.message);
  return "";
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function slugify(s) {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

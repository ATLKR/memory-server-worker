#!/usr/bin/env node
/**
 * Pre-prompt hook (Claude Code: UserPromptSubmit)
 *
 * Reads the user's prompt from stdin, searches the memory server for
 * relevant memories, and injects them as additional context so the agent
 * has access to stored knowledge before processing the prompt.
 *
 * Input (stdin JSON, Claude Code hook format):
 *   { "session_id": "...", "prompt": "user's prompt text", "cwd": "..." }
 *
 * Output (stdout JSON):
 *   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
 *     "additionalContext": "..." } }
 *
 * If the memory server is unreachable, the hook fails silently (returns no
 * additional context) so it never blocks the conversation.
 */

import { memory, readStdin } from "./lib.mjs";

async function main() {
  const raw = await readStdin();
  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    // Not JSON input — treat raw text as the prompt.
    hookInput = { prompt: raw.trim() };
  }

  const prompt = hookInput.prompt ?? "";
  if (!prompt) {
    process.exit(0);
  }

  // Extract keywords from the prompt for searching. We use the full prompt
  // as the search query — FTS5 handles multi-word queries well.
  // Trim to avoid overly long queries.
  const query = prompt.slice(0, 500);

  try {
    const resultsText = await memory.search({ query, limit: 5 });
    const results = JSON.parse(resultsText);
    const memories = results.results ?? [];

    if (memories.length === 0) {
      process.exit(0);
    }

    // Format memories as context for the agent.
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

    // Output in Claude Code hook format.
    const output = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    };
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    // Fail silently — never block the conversation.
    console.error(`[memory-plugin:pre-prompt] ${err.message}`);
    process.exit(0);
  }
}

main();

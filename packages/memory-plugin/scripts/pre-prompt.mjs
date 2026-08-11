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

import { memory, readStdin, isTokenExpired } from "./lib.mjs";

async function main() {
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

  // Agent Memory recall() accepts natural language queries. Trim to the
  // 1 KB limit to avoid API errors on very long prompts.
  const query = prompt.slice(0, 1000);

  try {
    const resultsText = await memory.search({ query });
    const results = JSON.parse(resultsText);
    const answer = results.answer ?? "";
    const candidates = results.candidates ?? [];

    if (!answer && candidates.length === 0) {
      process.exit(0);
    }

    // Format the synthesized answer + candidate memories as context.
    const lines = candidates.map((c, i) => {
      return `### Memory ${i + 1}\n${c.summary}`;
    });

    const additionalContext =
      `--- Retrieved from Personal Memory (${candidates.length} entries) ---\n` +
      `The following memories were recalled based on your current prompt. ` +
      `Use them as relevant context, but verify against the actual task:\n\n` +
      (answer ? `**Synthesized answer:** ${answer}\n\n` : "") +
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
    if (isTokenExpired()) {
      console.error(
        "[memory-plugin:pre-prompt] Token expired. Run `mem login` to refresh.",
      );
    } else {
      console.error(`[memory-plugin:pre-prompt] ${err.message}`);
    }
    process.exit(0);
  }
}

main();

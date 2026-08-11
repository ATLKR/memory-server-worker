#!/usr/bin/env node
/**
 * Post-turn hook (Claude Code: Stop)
 *
 * Fires after the agent finishes a turn. Reads the conversation transcript
 * and stores a summary memory entry so future conversations can recall what
 * was discussed and decided.
 *
 * Input (stdin JSON, Claude Code hook format):
 *   { "session_id": "...", "transcript_path": "/path/to/transcript.json",
 *     "stop_hook_active": false }
 *
 * The transcript is a JSON array of message objects with role + content.
 * We extract the last user prompt and the assistant's final response, then
 * store them as a memory entry tagged with the session id.
 *
 * If the memory server is unreachable, the hook fails silently.
 */

import { readFileSync } from "node:fs";
import { memory, readStdin } from "./lib.mjs";

async function main() {
  const raw = await readStdin();
  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // If stop_hook_active is true, this is a re-entry — skip to avoid loops.
  if (hookInput.stop_hook_active) {
    process.exit(0);
  }

  const transcriptPath = hookInput.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  // Read and parse the transcript.
  let transcript;
  try {
    transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  } catch {
    process.exit(0);
  }

  if (!Array.isArray(transcript) || transcript.length === 0) {
    process.exit(0);
  }

  // Extract the last user message and the last assistant message.
  const lastUser = [...transcript].reverse().find((m) => m.role === "user");
  const lastAssistant = [...transcript].reverse().find((m) => m.role === "assistant");

  if (!lastUser || !lastAssistant) {
    process.exit(0);
  }

  // Extract text content from the messages (they may have content arrays
  // with text blocks, or plain strings).
  const userText = extractText(lastUser);
  const assistantText = extractText(lastAssistant);

  if (!userText && !assistantText) {
    process.exit(0);
  }

  // Build a concise memory entry. We truncate to keep entries manageable —
  // the full transcript remains in Claude Code's own storage.
  const maxLen = 2000;
  const content =
    `## Conversation Summary\n\n` +
    `**User asked:**\n${truncate(userText, maxLen / 2)}\n\n` +
    `**Assistant responded:**\n${truncate(assistantText, maxLen / 2)}\n\n` +
    `*Session: ${hookInput.session_id ?? "unknown"}*\n` +
    `*Timestamp: ${new Date().toISOString()}*`;

  // Generate a key from the user prompt (slugged, truncated).
  const key = `turn-${slugify(truncate(userText, 60))}-${Date.now()}`;

  try {
    await memory.add({
      content,
      key,
      namespace: "conversations",
      tags: ["auto-captured", "claude-code"],
      metadata: {
        session_id: hookInput.session_id,
        captured_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    // Fail silently.
    console.error(`[memory-plugin:post-turn] ${err.message}`);
  }

  process.exit(0);
}

/** Extract text from a message that may have a string or array content. */
function extractText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  // Some transcript formats use .message.content
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

main();

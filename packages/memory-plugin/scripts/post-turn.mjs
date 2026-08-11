#!/usr/bin/env node
/**
 * Post-turn hook (Claude Code: Stop, Devin: Stop)
 *
 * Fires after the agent finishes a turn. Reads the conversation transcript
 * and sends it to Agent Memory's ingest() API, which automatically extracts
 * facts, events, instructions, and tasks from the conversation.
 *
 * Supports multiple input formats:
 *
 * 1. Claude Code: { "session_id": "...", "transcript_path": "/path/to/transcript.json",
 *    "stop_hook_active": false }
 *    The transcript is a JSON array of message objects with role + content.
 *
 * 2. Devin: { "session_id": "...", "cwd": "...", "stop_hook_active": false,
 *    "messages": [{ "role": "user", "content": "..." }, ...] }
 *
 * 3. Generic: { "session_id": "...", "user_message": "...", "assistant_message": "..." }
 *
 * If the memory server is unreachable, the hook fails silently.
 */

import { readFileSync } from "node:fs";
import { memory, readStdin, isTokenExpired } from "./lib.mjs";

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

  // Extract conversation messages from whichever format we received.
  const messages = extractMessages(hookInput);

  if (messages.length === 0) {
    process.exit(0);
  }

  // Agent Memory ingest() handles extraction, classification, dedup, and
  // supersession automatically. We just pass the conversation messages.
  // Limit to the last 50 messages to stay within the 500-message limit
  // and keep ingestion fast.
  const recentMessages = messages.slice(-50);

  // Truncate each message to 32 KB (Agent Memory limit).
  const truncated = recentMessages.map((m) => ({
    role: m.role,
    content: truncate(m.content, 32000),
  }));

  try {
    await memory.ingest({
      messages: truncated,
      sessionId: hookInput.session_id
        ? String(hookInput.session_id).slice(0, 64)
        : undefined,
    });
  } catch (err) {
    if (isTokenExpired()) {
      console.error(
        "[memory-plugin:post-turn] Token expired. Run `mem login` to refresh.",
      );
    } else {
      console.error(`[memory-plugin:post-turn] ${err.message}`);
    }
  }

  process.exit(0);
}

/**
 * Extract conversation messages from various hook input formats.
 * Returns an array of { role, content } objects.
 */
function extractMessages(hookInput) {
  // Format 1: Claude Code with transcript_path
  if (hookInput.transcript_path) {
    try {
      const transcript = JSON.parse(readFileSync(hookInput.transcript_path, "utf8"));
      if (Array.isArray(transcript) && transcript.length > 0) {
        return transcript
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: extractText(m) }))
          .filter((m) => m.content.trim().length > 0);
      }
    } catch {
      // Fall through to other formats.
    }
  }

  // Format 2: Devin with messages array directly in stdin
  if (Array.isArray(hookInput.messages) && hookInput.messages.length > 0) {
    return hookInput.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: extractText(m) }))
      .filter((m) => m.content.trim().length > 0);
  }

  // Format 3: Generic with user_message / assistant_message
  if (hookInput.user_message || hookInput.assistant_message) {
    const msgs = [];
    if (hookInput.user_message) {
      msgs.push({ role: "user", content: String(hookInput.user_message) });
    }
    if (hookInput.assistant_message) {
      msgs.push({ role: "assistant", content: String(hookInput.assistant_message) });
    }
    return msgs;
  }

  // Format 4: Devin with prompt / response
  if (hookInput.prompt || hookInput.response) {
    const msgs = [];
    if (hookInput.prompt) {
      msgs.push({ role: "user", content: String(hookInput.prompt) });
    }
    if (hookInput.response) {
      msgs.push({ role: "assistant", content: String(hookInput.response) });
    }
    return msgs;
  }

  // Format 5: Devin with last_user_message / last_assistant_message
  if (hookInput.last_user_message || hookInput.last_assistant_message) {
    const msgs = [];
    if (hookInput.last_user_message) {
      msgs.push({ role: "user", content: String(hookInput.last_user_message) });
    }
    if (hookInput.last_assistant_message) {
      msgs.push({ role: "assistant", content: String(hookInput.last_assistant_message) });
    }
    return msgs;
  }

  return [];
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
  if (msg.message) return extractText(msg.message);
  if (typeof msg.text === "string") return msg.text;
  return "";
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

main();

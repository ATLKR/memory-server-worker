#!/usr/bin/env node
/**
 * Post-turn hook (Claude Code: Stop, Devin: Stop)
 *
 * Fires after the agent finishes a turn. Reads the conversation transcript
 * and stores a summary memory entry so future conversations can recall what
 * was discussed and decided.
 *
 * Supports multiple input formats:
 *
 * 1. Claude Code: { "session_id": "...", "transcript_path": "/path/to/transcript.json",
 *    "stop_hook_active": false }
 *    The transcript is a JSON array of message objects with role + content.
 *
 * 2. Devin: { "session_id": "...", "cwd": "...", "stop_hook_active": false,
 *    "messages": [{ "role": "user", "content": "..." }, ...] }
 *    Devin may provide messages directly in the stdin JSON.
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

  // Extract user and assistant text from whichever format we received.
  const { userText, assistantText } = extractConversation(hookInput);

  if (!userText && !assistantText) {
    process.exit(0);
  }

  // Build a concise memory entry. We truncate to keep entries manageable.
  const maxLen = 2000;
  const content =
    `## Conversation Summary\n\n` +
    `**User asked:**\n${truncate(userText, maxLen / 2)}\n\n` +
    `**Assistant responded:**\n${truncate(assistantText, maxLen / 2)}\n\n` +
    `*Session: ${hookInput.session_id ?? "unknown"}*\n` +
    `*Timestamp: ${new Date().toISOString()}*`;

  // Generate a key from the user prompt (slugged, truncated).
  const key = `turn-${slugify(truncate(userText || assistantText, 60))}-${Date.now()}`;

  // Check for existing similar memories to avoid duplicates.
  // If we find a recent conversation summary about the same topic,
  // append to it instead of creating a new entry.
  try {
    const existingKey = await findSimilarConversation(userText || assistantText);
    if (existingKey) {
      // Append this turn to the existing conversation memory.
      const appendContent =
        `\n\n---\n\n**Next turn (${new Date().toISOString()}):**\n` +
        `**User asked:**\n${truncate(userText, maxLen / 2)}\n\n` +
        `**Assistant responded:**\n${truncate(assistantText, maxLen / 2)}`;
      await memory.update({
        key: existingKey,
        content: appendContent,
        appendContent: true,
      });
    } else {
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
    }
  } catch (err) {
    // Fail silently.
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
 * Extract user and assistant text from various hook input formats.
 */
function extractConversation(hookInput) {
  // Format 1: Claude Code with transcript_path
  if (hookInput.transcript_path) {
    try {
      const transcript = JSON.parse(readFileSync(hookInput.transcript_path, "utf8"));
      if (Array.isArray(transcript) && transcript.length > 0) {
        const lastUser = [...transcript].reverse().find((m) => m.role === "user");
        const lastAssistant = [...transcript].reverse().find((m) => m.role === "assistant");
        return {
          userText: lastUser ? extractText(lastUser) : "",
          assistantText: lastAssistant ? extractText(lastAssistant) : "",
        };
      }
    } catch {
      // Fall through to other formats.
    }
  }

  // Format 2: Devin with messages array directly in stdin
  if (Array.isArray(hookInput.messages) && hookInput.messages.length > 0) {
    const lastUser = [...hookInput.messages].reverse().find((m) => m.role === "user");
    const lastAssistant = [...hookInput.messages].reverse().find((m) => m.role === "assistant");
    return {
      userText: lastUser ? extractText(lastUser) : "",
      assistantText: lastAssistant ? extractText(lastAssistant) : "",
    };
  }

  // Format 3: Generic with user_message / assistant_message
  if (hookInput.user_message || hookInput.assistant_message) {
    return {
      userText: hookInput.user_message ?? "",
      assistantText: hookInput.assistant_message ?? "",
    };
  }

  // Format 4: Devin with prompt / response
  if (hookInput.prompt || hookInput.response) {
    return {
      userText: hookInput.prompt ?? "",
      assistantText: hookInput.response ?? "",
    };
  }

  // Format 5: Devin with last_user_message / last_assistant_message
  if (hookInput.last_user_message || hookInput.last_assistant_message) {
    return {
      userText: hookInput.last_user_message ?? "",
      assistantText: hookInput.last_assistant_message ?? "",
    };
  }

  return { userText: "", assistantText: "" };
}

/**
 * Search for an existing conversation memory about the same topic.
 * If found, return its key so we can append instead of creating a duplicate.
 * Only matches conversations from the last hour to avoid appending to
 * very old conversations.
 */
async function findSimilarConversation(query) {
  if (!query || query.length < 5) return null;
  try {
    const resultsText = await memory.search({
      query: query.slice(0, 200),
      namespace: "conversations",
      limit: 3,
    });
    const results = JSON.parse(resultsText);
    const memories = results.results ?? [];
    if (memories.length === 0) return null;

    // Only append to conversations from the last hour.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const m of memories) {
      const updatedAt = new Date(m.updatedAt).getTime();
      if (updatedAt >= oneHourAgo && m.key) {
        return m.key;
      }
    }
    return null;
  } catch {
    return null;
  }
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
  // Some formats use .text directly
  if (typeof msg.text === "string") return msg.text;
  return "";
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function slugify(s) {
  return (s ?? "")
    .toLowerCase()
    // Keep Korean, alphanumerics. Replace other scripts/whitespace with -.
    .replace(/[^\w\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

main();

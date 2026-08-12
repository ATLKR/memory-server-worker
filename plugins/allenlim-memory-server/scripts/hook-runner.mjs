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
import { memory, readStdin, isTokenExpired } from "./lib.mjs";

const MAX_INGEST_MESSAGES = 100;
const MAX_INGEST_MESSAGE_BYTES = 32 * 1024;
const MAX_INGEST_TOTAL_BYTES = 1024 * 1024;
const MAX_SEARCH_QUERY_BYTES = 1024;

export async function runHook(hookName) {
  switch (hookName) {
    case "pre-prompt":
    case "UserPromptSubmit":
      return runPrePrompt();
    case "post-turn":
    case "Stop":
      return runPostTurn();
    default:
      console.error(`[allenlim-memory-server] Unknown hook: ${hookName}`);
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

  // Agent Memory recall() accepts natural language. Trim on a code-point
  // boundary so multilingual prompts stay within the 1 KiB UTF-8 contract.
  const query = truncateUtf8(prompt, MAX_SEARCH_QUERY_BYTES);

  try {
    const resultsText = await memory.search({ query });
    const results = JSON.parse(resultsText);
    const answer = results.answer ?? "";
    const candidates = results.candidates ?? [];

    if (candidates.length === 0) {
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
        "[allenlim-memory-server:pre-prompt] Token expired. Run `mem login` to refresh.",
      );
    } else {
      console.error(`[allenlim-memory-server:pre-prompt] ${err.message}`);
    }
    process.exit(0);
  }
}

// --- Post-turn: ingest conversation into Agent Memory ---

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

  // Extract conversation messages from whichever format we received.
  const messages = extractMessages(hookInput);

  if (messages.length === 0) {
    process.exit(0);
  }

  // Preserve the newest messages while staying inside the server contract:
  // 100 messages, 32 KiB per message, and 1 MiB combined UTF-8 content.
  const trimmedMessages = trimMessagesForIngest(messages);

  if (trimmedMessages.length === 0) {
    process.exit(0);
  }

  try {
    await memory.ingest({
      messages: trimmedMessages,
      sessionId: hookInput.session_id
        ? String(hookInput.session_id).slice(0, 64)
        : undefined,
    });
  } catch (err) {
    if (isTokenExpired()) {
      console.error(
        "[allenlim-memory-server:post-turn] Token expired. Run `mem login` to refresh.",
      );
    } else {
      console.error(`[allenlim-memory-server:post-turn] ${err.message}`);
    }
  }

  process.exit(0);
}

/**
 * Extract conversation messages from various hook input formats.
 * Returns an array of { role, content } objects.
 */
export function extractMessages(hookInput) {
  // Format 1: Claude Code with transcript_path
  if (hookInput.transcript_path) {
    try {
      const transcript = parseTranscript(
        readFileSync(hookInput.transcript_path, "utf8"),
      );
      if (transcript.length > 0) {
        return transcript;
      }
    } catch {
      // Fall through to other formats.
    }
  }

  // Format 2: messages array directly in stdin (Devin or generic)
  if (Array.isArray(hookInput.messages) && hookInput.messages.length > 0) {
    return normalizeConversationRecords(hookInput.messages);
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

  // Format 4: prompt / response
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

  // Format 5: last_user_message / last_assistant_message
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

/**
 * Parse Claude Code's JSONL transcript format. A JSON array is also accepted
 * for compatibility with older/generic hook producers. Malformed JSONL rows
 * are ignored so one incomplete record does not discard the whole transcript.
 */
export function parseTranscript(contents) {
  const raw = typeof contents === "string" ? contents.trim() : "";
  if (!raw) return [];

  let records;
  try {
    const parsed = JSON.parse(raw);
    records = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    records = raw.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }

  return normalizeConversationRecords(records);
}

function normalizeConversationRecords(records) {
  return records
    .map((record) => {
      if (!record || typeof record !== "object") return null;

      const message =
        record.message && typeof record.message === "object"
          ? record.message
          : record;
      const role =
        message.role ??
        (record.type === "user" || record.type === "assistant"
          ? record.type
          : undefined);

      if (role !== "user" && role !== "assistant") return null;

      const content = extractText(message);
      if (!content.trim()) return null;
      return { role, content };
    })
    .filter(Boolean);
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

/** Truncate without splitting a Unicode code point. */
export function truncateUtf8(value, maxBytes) {
  if (maxBytes <= 0 || value == null) return "";

  const text = String(value);
  let bytes = 0;
  let end = 0;

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }

  return text.slice(0, end);
}

/**
 * Keep the most recent valid messages within the Agent Memory ingest limits.
 * Iterating newest-to-oldest prevents an old transcript prefix from crowding
 * the current turn out of the request.
 */
export function trimMessagesForIngest(messages) {
  if (!Array.isArray(messages)) return [];

  const recentMessages = messages.slice(-MAX_INGEST_MESSAGES);
  const selected = [];
  let remainingBytes = MAX_INGEST_TOTAL_BYTES;

  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    if (remainingBytes <= 0) break;

    const message = recentMessages[index];
    if (
      !message ||
      (message.role !== "user" && message.role !== "assistant")
    ) {
      continue;
    }

    const rawContent = message.content == null ? "" : String(message.content);
    if (!rawContent.trim()) continue;

    const content = truncateUtf8(
      rawContent,
      Math.min(MAX_INGEST_MESSAGE_BYTES, remainingBytes),
    );
    if (!content) continue;

    selected.push({ role: message.role, content });
    remainingBytes -= Buffer.byteLength(content, "utf8");
  }

  return selected.reverse();
}

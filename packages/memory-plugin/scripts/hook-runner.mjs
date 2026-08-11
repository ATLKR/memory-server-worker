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

  // Extract user and assistant text from whichever format we received.
  const { userText, assistantText } = extractConversation(hookInput);

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

  const key = `turn-${slugify(truncate(userText || assistantText, 60))}-${Date.now()}`;

  try {
    // Check for existing similar conversation to append to.
    const existingKey = await findSimilarConversation(userText || assistantText);
    if (existingKey) {
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

  // Format 2: messages array directly in stdin (Devin or generic)
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

  // Format 4: prompt / response
  if (hookInput.prompt || hookInput.response) {
    return {
      userText: hookInput.prompt ?? "",
      assistantText: hookInput.response ?? "",
    };
  }

  // Format 5: last_user_message / last_assistant_message
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
    // Keep Korean, alphanumerics. Replace other scripts/whitespace with -.
    .replace(/[^\w\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

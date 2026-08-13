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

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getMemoryDestinationFingerprint,
  isTokenExpired,
  memory,
  readStdin,
} from "./lib.mjs";

const MAX_INGEST_MESSAGES = 100;
const MAX_INGEST_MESSAGE_BYTES = 32 * 1024;
const MAX_INGEST_TOTAL_BYTES = 1024 * 1024;
const MAX_SEARCH_QUERY_BYTES = 1024;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_RECORD_BYTES = 1024 * 1024;
const CHECKPOINT_ANCHOR_BYTES = 64;
const CHECKPOINT_VERSION = 1;
const CHECKPOINT_LOCK_ATTEMPTS = 100;
const CHECKPOINT_LOCK_RETRY_MS = 10;
const CHECKPOINT_LOCK_STALE_MS = 30_000;

export async function runHook(hookName) {
  try {
    switch (hookName) {
      case "pre-prompt":
      case "UserPromptSubmit":
        return await runPrePrompt();
      case "post-turn":
      case "Stop":
        return await runPostTurn();
      default:
        console.error(`[allenlim-memory-server] Unknown hook: ${hookName}`);
        return;
    }
  } catch (error) {
    const label = hookName === "post-turn" || hookName === "Stop"
      ? "post-turn"
      : "pre-prompt";
    console.error(`[allenlim-memory-server:${label}] ${error.message}`);
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
    return;
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
      return;
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
        "[allenlim-memory-server:pre-prompt] Session refresh failed. Sign in again with the plugin CLI.",
      );
    } else {
      console.error(`[allenlim-memory-server:pre-prompt] ${err.message}`);
    }
    return;
  }
}

// --- Post-turn: ingest conversation into Agent Memory ---

async function runPostTurn() {
  const raw = await readStdin();
  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    return;
  }

  if (hookInput.stop_hook_active) {
    return;
  }

  const sessionId = hookInput.session_id
    ? String(hookInput.session_id).slice(0, 64)
    : undefined;

  // Claude transcripts are append-only JSONL in normal operation. Read only
  // bytes not acknowledged by a previous successful ingest so Stop hooks stay
  // fast even for long sessions. Any failure remains fail-open and leaves the
  // checkpoint unchanged for a safe retry.
  let incrementalIngestAttempted = false;
  let incrementalFallback = false;
  if (
    typeof hookInput.transcript_path === "string" &&
    hookInput.transcript_path &&
    !transcriptStartsWithJsonArray(hookInput.transcript_path)
  ) {
    try {
      await ingestTranscriptIncrementally(hookInput.transcript_path, {
        ingest: async (params) => {
          incrementalIngestAttempted = true;
          return memory.ingest(params);
        },
        sessionId,
      });
      return;
    } catch {
      console.error(
        incrementalIngestAttempted
          ? "[allenlim-memory-server:post-turn] Could not process the transcript; it will be retried."
          : "[allenlim-memory-server:post-turn] Could not process the transcript incrementally; using direct hook messages when available.",
      );
      // If an incremental server request was already attempted, do not send a
      // second overlapping fallback payload. Filesystem/setup failures that
      // happened before any request can still use the hook's direct messages.
      if (incrementalIngestAttempted) return;
      incrementalFallback = true;
    }
  }

  // Extract conversation messages from whichever format we received.
  const messages = extractMessages(hookInput, {
    includeTranscript: !incrementalFallback,
  });

  if (messages.length === 0) {
    return;
  }

  // Preserve the newest messages while staying inside the server contract:
  // 100 messages, 32 KiB per message, and 1 MiB combined UTF-8 content.
  const trimmedMessages = trimMessagesForIngest(messages);

  if (trimmedMessages.length === 0) {
    return;
  }

  try {
    await memory.ingest({
      messages: trimmedMessages,
      sessionId,
    });
  } catch (err) {
    if (isTokenExpired()) {
      console.error(
        "[allenlim-memory-server:post-turn] Session refresh failed. Sign in again with the plugin CLI.",
      );
    } else {
      console.error(`[allenlim-memory-server:post-turn] ${err.message}`);
    }
  }

}

/**
 * Extract conversation messages from various hook input formats.
 * Returns an array of { role, content } objects.
 */
export function extractMessages(hookInput, { includeTranscript = true } = {}) {
  // Format 1: Claude Code with transcript_path
  if (includeTranscript && hookInput.transcript_path) {
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

function transcriptStartsWithJsonArray(transcriptPath) {
  let file;
  try {
    file = openSync(transcriptPath, "r");
    const prefix = Buffer.alloc(4 * 1024);
    const bytesRead = readSync(file, prefix, 0, prefix.length, 0);
    return prefix
      .subarray(0, bytesRead)
      .toString("utf8")
      .trimStart()
      .startsWith("[");
  } catch {
    return false;
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

/**
 * Incrementally ingest a Claude JSONL transcript.
 *
 * Checkpoints contain only hashed source/file identifiers, a byte offset, and
 * a hash of the bytes immediately before that offset. They never contain the
 * transcript path, transcript content, session identifiers, or credentials.
 * Message offsets are persisted only after their batch is accepted. Complete
 * malformed/non-message/oversized rows are acknowledged without a retry loop.
 */
export async function ingestTranscriptIncrementally(
  transcriptPath,
  {
    checkpointDir = join(homedir(), ".memory", "transcript-checkpoints"),
    destinationFingerprint = getMemoryDestinationFingerprint(),
    ingest = (params) => memory.ingest(params),
    sessionId,
  } = {},
) {
  const canonicalPath = realpathSync.native(transcriptPath);
  const sourceId = getCheckpointSourceId(
    canonicalPath,
    destinationFingerprint,
  );
  const checkpointPath = join(checkpointDir, `${sourceId}.json`);
  mkdirSync(checkpointDir, { recursive: true, mode: 0o700 });

  const file = openSync(canonicalPath, "r");
  try {
    const stat = fstatSync(file);
    const fileId = getFileId(stat);
    const fileSize = stat.size;
    const checkpoint = loadCheckpoint(checkpointPath);
    const startOffset = isCheckpointCurrent(
      checkpoint,
      { sourceId, fileId, fileSize },
      file,
    )
      ? checkpoint.offset
      : 0;

    let position = startOffset;
    let lineChunks = [];
    let lineBytes = 0;
    let discardingOversizedRecord = false;
    let batch = [];
    let batchBytes = 0;
    let processedOffset = startOffset;
    let checkpointAttemptedOffset = startOffset;
    let ingestedMessages = 0;
    let ingestedBatches = 0;

    const commitProcessed = async () => {
      if (processedOffset <= checkpointAttemptedOffset) return;
      const value = {
        version: CHECKPOINT_VERSION,
        sourceId,
        fileId,
        offset: processedOffset,
        anchor: readAnchor(file, processedOffset),
      };
      await commitCheckpoint(checkpointPath, value, {
        canonicalPath,
        transcriptPath,
      });
      checkpointAttemptedOffset = processedOffset;
    };

    const flush = async () => {
      if (batch.length > 0) {
        const messages = batch;
        await ingest({ messages, sessionId });
        ingestedMessages += messages.length;
        ingestedBatches += 1;
        batch = [];
        batchBytes = 0;
      }
      await commitProcessed();
    };

    const queueRecord = async (
      recordBytes,
      endOffset,
      { completeRecord },
    ) => {
      const line = stripTrailingCarriageReturn(recordBytes).toString("utf8");
      if (!line.trim()) {
        processedOffset = endOffset;
        return;
      }

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // Newline-terminated malformed records can never become valid later,
        // so acknowledge them. A bounded incomplete tail remains pending.
        if (completeRecord) processedOffset = endOffset;
        return;
      }

      const message = normalizeConversationRecords([record])[0];
      if (!message) {
        processedOffset = endOffset;
        return;
      }

      const content = truncateUtf8(message.content, MAX_INGEST_MESSAGE_BYTES);
      if (!content) {
        processedOffset = endOffset;
        return;
      }
      const contentBytes = Buffer.byteLength(content, "utf8");

      if (
        batch.length >= MAX_INGEST_MESSAGES ||
        batchBytes + contentBytes > MAX_INGEST_TOTAL_BYTES
      ) {
        await flush();
      }

      batch.push({ role: message.role, content });
      batchBytes += contentBytes;
      processedOffset = endOffset;
    };

    while (position < fileSize) {
      const requested = Math.min(
        TRANSCRIPT_READ_CHUNK_BYTES,
        fileSize - position,
      );
      const chunk = Buffer.allocUnsafe(requested);
      const chunkStart = position;
      const bytesRead = readSync(file, chunk, 0, requested, position);
      if (bytesRead === 0) break;
      position += bytesRead;

      let cursor = 0;
      let newline;
      while ((newline = chunk.indexOf(0x0a, cursor)) !== -1) {
        const segment = chunk.subarray(cursor, newline);
        const endOffset = chunkStart + newline + 1;

        if (discardingOversizedRecord) {
          processedOffset = endOffset;
        } else if (
          lineBytes + segment.length > MAX_TRANSCRIPT_RECORD_BYTES
        ) {
          processedOffset = endOffset;
        } else {
          if (segment.length > 0) {
            lineChunks.push(segment);
            lineBytes += segment.length;
          }
          const recordBytes = materializeLine(lineChunks, lineBytes);
          await queueRecord(recordBytes, endOffset, { completeRecord: true });
        }

        lineChunks = [];
        lineBytes = 0;
        discardingOversizedRecord = false;
        cursor = newline + 1;
      }

      const tail = chunk.subarray(cursor, bytesRead);
      if (
        !discardingOversizedRecord &&
        lineBytes + tail.length > MAX_TRANSCRIPT_RECORD_BYTES
      ) {
        lineChunks = [];
        lineBytes = 0;
        discardingOversizedRecord = true;
      } else if (!discardingOversizedRecord && tail.length > 0) {
        lineChunks.push(tail);
        lineBytes += tail.length;
      }
    }

    // A valid JSON object at EOF is a complete record even if the producer has
    // not written its trailing newline yet. A bounded invalid tail is retained
    // for a future append. An oversized tail is intentionally acknowledged so
    // it cannot cause an unbounded retry loop.
    if (discardingOversizedRecord) {
      processedOffset = fileSize;
    } else if (lineBytes > 0) {
      await queueRecord(materializeLine(lineChunks, lineBytes), fileSize, {
        completeRecord: false,
      });
    }

    await flush();
    return {
      batches: ingestedBatches,
      messages: ingestedMessages,
      startOffset,
    };
  } finally {
    closeSync(file);
  }
}

/** Return the privacy-preserving checkpoint path for a transcript. */
export function getTranscriptCheckpointPath(
  transcriptPath,
  checkpointDir = join(homedir(), ".memory", "transcript-checkpoints"),
  destinationFingerprint = getMemoryDestinationFingerprint(),
) {
  const sourceId = getCheckpointSourceId(
    realpathSync.native(transcriptPath),
    destinationFingerprint,
  );
  return join(checkpointDir, `${sourceId}.json`);
}

function getCheckpointSourceId(canonicalPath, destinationFingerprint) {
  // Hash the destination again before combining it with the canonical path so
  // even an injected/raw test identity can never appear in the checkpoint.
  const destinationId = sha256(String(destinationFingerprint));
  return sha256(`${canonicalPath}\0${destinationId}`);
}

function loadCheckpoint(checkpointPath) {
  try {
    const value = JSON.parse(readFileSync(checkpointPath, "utf8"));
    if (
      value?.version !== CHECKPOINT_VERSION ||
      !/^[a-f0-9]{64}$/.test(value.sourceId) ||
      !/^[a-f0-9]{64}$/.test(value.fileId) ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      (value.anchor !== null && !/^[a-f0-9]{64}$/.test(value.anchor))
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isCheckpointCurrent(checkpoint, fileMetadata, file) {
  if (!checkpoint) return false;
  if (
    checkpoint.sourceId !== fileMetadata.sourceId ||
    checkpoint.fileId !== fileMetadata.fileId ||
    checkpoint.offset > fileMetadata.fileSize
  ) {
    return false;
  }

  try {
    return checkpoint.anchor === readAnchor(file, checkpoint.offset);
  } catch {
    return false;
  }
}

function readAnchor(file, offset) {
  if (offset === 0) return null;
  const length = Math.min(CHECKPOINT_ANCHOR_BYTES, offset);
  const bytes = Buffer.allocUnsafe(length);
  const bytesRead = readSync(file, bytes, 0, length, offset - length);
  if (bytesRead !== length) {
    throw new Error("Could not verify transcript checkpoint anchor.");
  }
  return sha256(bytes);
}

async function commitCheckpoint(
  checkpointPath,
  value,
  { canonicalPath, transcriptPath },
) {
  return withCheckpointLock(checkpointPath, () => {
    const stillCurrent = () =>
      isTranscriptCommitCurrent(transcriptPath, canonicalPath, value);
    if (!stillCurrent()) return false;

    const current = loadCheckpoint(checkpointPath);
    if (
      current?.sourceId === value.sourceId &&
      current.fileId === value.fileId &&
      current.offset >= value.offset &&
      isTranscriptCommitCurrent(transcriptPath, canonicalPath, current)
    ) {
      return false;
    }

    return saveCheckpoint(checkpointPath, value, stillCurrent);
  });
}

async function withCheckpointLock(checkpointPath, operation) {
  const lockPath = `${checkpointPath}.lock`;
  let lock;

  for (let attempt = 0; attempt < CHECKPOINT_LOCK_ATTEMPTS; attempt += 1) {
    try {
      lock = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      removeStaleCheckpointLock(lockPath);
      await new Promise((resolve) =>
        setTimeout(resolve, CHECKPOINT_LOCK_RETRY_MS),
      );
    }
  }

  if (lock === undefined) {
    throw new Error("Could not acquire the transcript checkpoint lock.");
  }

  try {
    return operation();
  } finally {
    try {
      closeSync(lock);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // Another process can only create the next lock after this unlink.
      }
    }
  }
}

function removeStaleCheckpointLock(lockPath) {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > CHECKPOINT_LOCK_STALE_MS) {
      unlinkSync(lockPath);
    }
  } catch {
    // The owner may have released the lock between the failed open and stat.
  }
}

function isTranscriptCommitCurrent(transcriptPath, canonicalPath, value) {
  let currentFile;
  try {
    if (realpathSync.native(transcriptPath) !== canonicalPath) return false;
    currentFile = openSync(transcriptPath, "r");
    const stat = fstatSync(currentFile);
    if (getFileId(stat) !== value.fileId || stat.size < value.offset) {
      return false;
    }
    return readAnchor(currentFile, value.offset) === value.anchor;
  } catch {
    return false;
  } finally {
    if (currentFile !== undefined) closeSync(currentFile);
  }
}

function getFileId(stat) {
  return sha256(
    `${String(stat.dev)}:${String(stat.ino)}:${String(stat.birthtimeMs)}`,
  );
}

function saveCheckpoint(checkpointPath, value, stillCurrent) {
  const temporaryPath = `${checkpointPath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let renamed = false;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    });
    if (!stillCurrent()) return false;
    renameSync(temporaryPath, checkpointPath);
    renamed = true;
    return true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup; the temporary file contains metadata only.
      }
    }
  }
}

function materializeLine(chunks, length) {
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks, length);
}

function stripTrailingCarriageReturn(bytes) {
  return bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

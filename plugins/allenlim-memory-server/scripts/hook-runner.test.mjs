import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  getTranscriptCheckpointPath,
  ingestTranscriptIncrementally,
  parseTranscript,
  trimMessagesForIngest,
  truncateUtf8,
} from "./hook-runner.mjs";

const originalMemoryApiKey = process.env.MEMORY_API_KEY;
process.env.MEMORY_API_KEY = "hook-runner-test-api-key-0123456789";
after(() => {
  if (originalMemoryApiKey === undefined) delete process.env.MEMORY_API_KEY;
  else process.env.MEMORY_API_KEY = originalMemoryApiKey;
});

test("truncateUtf8 keeps a pre-prompt query within 1 KiB without splitting Unicode", () => {
  const exactPrefix = `${"\uac00".repeat(340)}\u{1f600}`;
  const truncated = truncateUtf8(`${exactPrefix}\uac00`, 1024);

  assert.equal(Buffer.byteLength(exactPrefix, "utf8"), 1024);
  assert.equal(Buffer.byteLength(truncated, "utf8"), 1024);
  assert.equal(truncated, exactPrefix);
});

test("parseTranscript ignores malformed JSONL rows and keeps valid messages", () => {
  const transcript = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "remember this" },
    }),
    "{this row is incomplete",
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "stored" },
          { type: "tool_use", name: "memory_add" },
          { type: "text", text: "successfully" },
        ],
      },
    }),
    JSON.stringify({ type: "progress", message: { content: "ignored" } }),
  ].join("\n");

  assert.deepEqual(parseTranscript(transcript), [
    { role: "user", content: "remember this" },
    { role: "assistant", content: "stored\nsuccessfully" },
  ]);
});

test("trimMessagesForIngest keeps the newest 100 valid messages", () => {
  const messages = Array.from({ length: 105 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`,
  }));

  const trimmed = trimMessagesForIngest(messages);

  assert.equal(trimmed.length, 100);
  assert.equal(trimmed[0].content, "message-5");
  assert.equal(trimmed.at(-1).content, "message-104");
});

test("trimMessagesForIngest truncates a message at 32 KiB on a UTF-8 boundary", () => {
  const trimmed = trimMessagesForIngest([
    { role: "user", content: "😀".repeat(9_000) },
  ]);

  assert.equal(trimmed.length, 1);
  assert.equal(Buffer.byteLength(trimmed[0].content, "utf8"), 32 * 1024);
  assert.equal(Array.from(trimmed[0].content).length, 8_192);
  assert.equal(trimmed[0].content, "😀".repeat(8_192));
});

test("trimMessagesForIngest keeps the newest messages within 1 MiB of UTF-8", () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${String(index).padStart(2, "0")}${"가".repeat(10_922)}`,
  }));

  const trimmed = trimMessagesForIngest(messages);
  const totalBytes = trimmed.reduce(
    (sum, message) => sum + Buffer.byteLength(message.content, "utf8"),
    0,
  );

  assert.equal(trimmed.length, 32);
  assert.equal(totalBytes, 1024 * 1024);
  assert.match(trimmed[0].content, /^08/);
  assert.match(trimmed.at(-1).content, /^39/);
});

test("incremental transcript ingestion sends only appended records and stores no raw data", async (context) => {
  const fixture = createTranscriptFixture(context);
  const secretContent = "private conversation content";
  writeFileSync(
    fixture.transcriptPath,
    `${jsonlMessage("user", secretContent)}\n${jsonlMessage("assistant", "answer")}\n`,
  );
  const calls = [];

  const first = await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => calls.push(params),
    sessionId: "session-for-request-only",
  });
  assert.deepEqual(first, { batches: 1, messages: 2, startOffset: 0 });
  assert.deepEqual(calls[0].messages.map((message) => message.content), [
    secretContent,
    "answer",
  ]);

  const checkpointPath = getTranscriptCheckpointPath(
    fixture.transcriptPath,
    fixture.checkpointDir,
  );
  assert.match(checkpointPath.split(/[\\/]/).at(-1), /^[a-f0-9]{64}\.json$/);
  const checkpointContents = readFileSync(checkpointPath, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(checkpointContents)).sort(), [
    "anchor",
    "fileId",
    "offset",
    "sourceId",
    "version",
  ]);
  assert.doesNotMatch(checkpointContents, /private conversation content/);
  assert.doesNotMatch(checkpointContents, /session-for-request-only/);
  assert.equal(checkpointContents.includes(fixture.transcriptPath), false);

  appendFileSync(
    fixture.transcriptPath,
    `${jsonlMessage("user", "new append only")}\n`,
  );
  const secondCalls = [];
  const second = await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => secondCalls.push(params),
  });
  assert.equal(second.startOffset > 0, true);
  assert.deepEqual(secondCalls[0].messages, [
    { role: "user", content: "new append only" },
  ]);
});

test("a partial final JSONL row remains pending until a later append completes it", async (context) => {
  const fixture = createTranscriptFixture(context);
  const complete = `${jsonlMessage("user", "complete")}\n`;
  writeFileSync(
    fixture.transcriptPath,
    `${complete}{"type":"assistant","message":{"role":"assistant","content":"par`,
  );
  const firstCalls = [];

  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => firstCalls.push(params),
  });
  assert.deepEqual(firstCalls.flatMap((call) => call.messages), [
    { role: "user", content: "complete" },
  ]);

  appendFileSync(fixture.transcriptPath, `tial"}}\n`);
  const secondCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => secondCalls.push(params),
  });
  assert.deepEqual(secondCalls.flatMap((call) => call.messages), [
    { role: "assistant", content: "partial" },
  ]);
});

test("checkpoints advance per successful batch and retry every unacknowledged message", async (context) => {
  const fixture = createTranscriptFixture(context);
  const records = Array.from({ length: 205 }, (_, index) =>
    jsonlMessage(index % 2 === 0 ? "user" : "assistant", `message-${index}`),
  );
  writeFileSync(fixture.transcriptPath, `${records.join("\n")}\n`);
  let attemptedBatches = 0;

  await assert.rejects(
    ingestTranscriptIncrementally(fixture.transcriptPath, {
      checkpointDir: fixture.checkpointDir,
      ingest: async () => {
        attemptedBatches += 1;
        if (attemptedBatches === 2) throw new Error("temporary failure");
      },
    }),
    /temporary failure/,
  );
  assert.equal(attemptedBatches, 2);

  const retryCalls = [];
  const retry = await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => retryCalls.push(params),
  });
  assert.deepEqual(retryCalls.map((call) => call.messages.length), [100, 5]);
  assert.deepEqual(
    retryCalls.flatMap((call) => call.messages.map((message) => message.content)),
    Array.from({ length: 105 }, (_, index) => `message-${index + 100}`),
  );
  assert.equal(retry.messages, 105);
});

test("backlogs larger than 1 MiB are partitioned without dropping records", async (context) => {
  const fixture = createTranscriptFixture(context);
  const records = Array.from({ length: 60 }, (_, index) =>
    jsonlMessage(
      index % 2 === 0 ? "user" : "assistant",
      `${String(index).padStart(2, "0")}:${"가".repeat(8_000)}`,
    ),
  );
  writeFileSync(fixture.transcriptPath, `${records.join("\n")}\n`);
  const calls = [];

  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => calls.push(params),
  });

  assert.equal(calls.length > 1, true);
  assert.equal(calls.flatMap((call) => call.messages).length, 60);
  for (const call of calls) {
    assert.equal(call.messages.length <= 100, true);
    assert.equal(
      call.messages.reduce(
        (total, message) => total + Buffer.byteLength(message.content, "utf8"),
        0,
      ) <= 1024 * 1024,
      true,
    );
  }
  assert.deepEqual(
    calls.flatMap((call) => call.messages.map((message) => message.content.slice(0, 3))),
    Array.from({ length: 60 }, (_, index) => `${String(index).padStart(2, "0")}:`),
  );
});

test("truncated and replaced transcripts reset stale checkpoints safely", async (context) => {
  const fixture = createTranscriptFixture(context);
  writeFileSync(
    fixture.transcriptPath,
    `${jsonlMessage("user", "original one")}\n${jsonlMessage("assistant", "original two")}\n`,
  );
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async () => {},
  });

  writeFileSync(fixture.transcriptPath, `${jsonlMessage("user", "truncated")}\n`);
  const truncatedCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => truncatedCalls.push(params),
  });
  assert.deepEqual(truncatedCalls[0].messages, [
    { role: "user", content: "truncated" },
  ]);

  unlinkSync(fixture.transcriptPath);
  writeFileSync(
    fixture.transcriptPath,
    `${jsonlMessage("assistant", "replacement one")}\n${jsonlMessage("user", "replacement two")}\n`,
  );
  const replacementCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => replacementCalls.push(params),
  });
  assert.deepEqual(
    replacementCalls.flatMap((call) => call.messages.map((message) => message.content)),
    ["replacement one", "replacement two"],
  );
});

test("a changed destination identity re-ingests from the beginning without storing it", async (context) => {
  const fixture = createTranscriptFixture(context);
  writeFileSync(
    fixture.transcriptPath,
    `${jsonlMessage("user", "destination-specific memory")}\n`,
  );

  const firstCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    destinationFingerprint: "server-a/auth-a/scope-a",
    ingest: async (params) => firstCalls.push(params),
  });
  assert.equal(firstCalls.length, 1);

  const sameCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    destinationFingerprint: "server-a/auth-a/scope-a",
    ingest: async (params) => sameCalls.push(params),
  });
  assert.equal(sameCalls.length, 0);

  const changedCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    destinationFingerprint: "server-b/auth-b/scope-b",
    ingest: async (params) => changedCalls.push(params),
  });
  assert.deepEqual(changedCalls[0].messages, [
    { role: "user", content: "destination-specific memory" },
  ]);

  const firstPath = getTranscriptCheckpointPath(
    fixture.transcriptPath,
    fixture.checkpointDir,
    "server-a/auth-a/scope-a",
  );
  const changedPath = getTranscriptCheckpointPath(
    fixture.transcriptPath,
    fixture.checkpointDir,
    "server-b/auth-b/scope-b",
  );
  assert.notEqual(firstPath, changedPath);
  assert.doesNotMatch(readFileSync(firstPath, "utf8"), /server-a|auth-a|scope-a/);
  assert.doesNotMatch(readFileSync(changedPath, "utf8"), /server-b|auth-b|scope-b/);
});

test("late same-file completion cannot move a checkpoint backward", async (context) => {
  const fixture = createTranscriptFixture(context);
  writeFileSync(
    fixture.transcriptPath,
    `${jsonlMessage("user", "first snapshot")}\n`,
  );

  const firstStarted = deferred();
  const releaseFirst = deferred();
  const firstRun = ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  });
  await firstStarted.promise;

  appendFileSync(
    fixture.transcriptPath,
    `${jsonlMessage("assistant", "newer snapshot")}\n`,
  );
  const newerCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => newerCalls.push(params),
  });
  assert.deepEqual(
    newerCalls.flatMap((call) => call.messages.map((message) => message.content)),
    ["first snapshot", "newer snapshot"],
  );

  releaseFirst.resolve();
  await firstRun;

  const checkpoint = JSON.parse(
    readFileSync(
      getTranscriptCheckpointPath(
        fixture.transcriptPath,
        fixture.checkpointDir,
      ),
      "utf8",
    ),
  );
  assert.equal(checkpoint.offset, readFileSync(fixture.transcriptPath).length);

  const finalCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => finalCalls.push(params),
  });
  assert.equal(finalCalls.length, 0);
});

test("late completion for a rotated file cannot overwrite the replacement checkpoint", async (context) => {
  const fixture = createTranscriptFixture(context);
  writeFileSync(
    fixture.transcriptPath,
    `${jsonlMessage("user", "old file")}\n`,
  );

  const oldStarted = deferred();
  const releaseOld = deferred();
  const oldRun = ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async () => {
      oldStarted.resolve();
      await releaseOld.promise;
    },
  });
  await oldStarted.promise;

  renameSync(fixture.transcriptPath, `${fixture.transcriptPath}.rotated`);
  writeFileSync(
    fixture.transcriptPath,
    `${jsonlMessage("assistant", "replacement file")}\n`,
  );
  const replacementCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => replacementCalls.push(params),
  });
  assert.deepEqual(replacementCalls[0].messages, [
    { role: "assistant", content: "replacement file" },
  ]);

  releaseOld.resolve();
  await oldRun;

  const finalCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => finalCalls.push(params),
  });
  assert.equal(finalCalls.length, 0);
});

test("oversized tool-output records are skipped without losing following records", async (context) => {
  const fixture = createTranscriptFixture(context);
  const oversizedToolRecord = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_result", content: "x".repeat(1024 * 1024) }],
    },
  });
  writeFileSync(
    fixture.transcriptPath,
    `${oversizedToolRecord}\n${jsonlMessage("user", "survives oversized record")}\n`,
  );

  const calls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => calls.push(params),
  });
  assert.deepEqual(calls.flatMap((call) => call.messages), [
    { role: "user", content: "survives oversized record" },
  ]);

  const retryCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => retryCalls.push(params),
  });
  assert.equal(retryCalls.length, 0);
});

test("an oversized newline-free tail is checkpointed once and later records still ingest", async (context) => {
  const fixture = createTranscriptFixture(context);
  writeFileSync(fixture.transcriptPath, "z".repeat(1024 * 1024 + 128));

  const firstCalls = [];
  const first = await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => firstCalls.push(params),
  });
  assert.equal(firstCalls.length, 0);
  assert.equal(first.startOffset, 0);

  const unchanged = await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async () => assert.fail("oversized tail must not retry"),
  });
  assert.equal(unchanged.startOffset, readFileSync(fixture.transcriptPath).length);

  appendFileSync(
    fixture.transcriptPath,
    `\n${jsonlMessage("assistant", "valid after oversized tail")}\n`,
  );
  const appendedCalls = [];
  await ingestTranscriptIncrementally(fixture.transcriptPath, {
    checkpointDir: fixture.checkpointDir,
    ingest: async (params) => appendedCalls.push(params),
  });
  assert.deepEqual(appendedCalls.flatMap((call) => call.messages), [
    { role: "assistant", content: "valid after oversized tail" },
  ]);
});

function createTranscriptFixture(context) {
  const root = mkdtempSync(join(tmpdir(), "memory-hook-test-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  return {
    checkpointDir: join(root, "checkpoints"),
    transcriptPath: join(root, "transcript.jsonl"),
  };
}

function jsonlMessage(role, content) {
  return JSON.stringify({
    type: role,
    message: { role, content },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBoundedBody, readJsonRequestBody } from "./body.ts";

const URL = "https://memory.example.test/mcp";

describe("readBoundedBody", () => {
  it("accepts a body exactly at the byte limit", async () => {
    const result = await readBoundedBody(
      new Request(URL, { method: "POST", body: new Uint8Array([1, 2, 3, 4]) }),
      4,
    );

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.bytes.byteLength, 4);
  });

  it("rejects an oversized Content-Length without reading the body", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "content-length": "5" },
      body: new Uint8Array([1]),
    });

    assert.deepEqual(await readBoundedBody(request, 4), {
      ok: false,
      reason: "too_large",
    });
  });

  it("caps a streamed body even when cancellation fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      },
      cancel() {
        throw new Error("source cannot cancel");
      },
    });
    const request = new Request(URL, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    assert.deepEqual(await readBoundedBody(request, 4), {
      ok: false,
      reason: "too_large",
    });
  });
});

describe("readJsonRequestBody", () => {
  it("parses valid JSON", async () => {
    const result = await readJsonRequestBody(
      new Request(URL, { method: "POST", body: '{"ok":true}' }),
      64,
    );

    assert.deepEqual(result, { ok: true, value: { ok: true } });
  });

  it("rejects invalid UTF-8 and invalid JSON", async () => {
    const invalidUtf8 = await readJsonRequestBody(
      new Request(URL, { method: "POST", body: new Uint8Array([0xff]) }),
      64,
    );
    const invalidJson = await readJsonRequestBody(
      new Request(URL, { method: "POST", body: "{" }),
      64,
    );

    assert.deepEqual(invalidUtf8, {
      ok: false,
      status: 400,
      error: "invalid JSON request body",
    });
    assert.deepEqual(invalidJson, {
      ok: false,
      status: 400,
      error: "invalid JSON request body",
    });
  });
});

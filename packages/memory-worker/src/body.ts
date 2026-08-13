export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "missing" | "too_large" | "unreadable" };

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

type BodySource = Pick<Request | Response, "headers" | "body">;
const INITIAL_BODY_BUFFER_BYTES = 16 * 1024;

/** Read a request body without trusting Content-Length or buffering past the limit. */
export async function readBoundedBody(
  request: BodySource,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  if (!request.body) return { ok: false, reason: "missing" };

  const reader = request.body.getReader();
  let bytes = new Uint8Array(Math.min(maxBytes, INITIAL_BODY_BUFFER_BYTES));
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextTotalBytes = totalBytes + value.byteLength;
      if (nextTotalBytes > maxBytes) {
        try {
          await reader.cancel("request body too large");
        } catch {
          // The size decision is final even if the source cannot be cancelled.
        }
        return { ok: false, reason: "too_large" };
      }
      if (nextTotalBytes > bytes.byteLength) {
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(nextTotalBytes, Math.max(1, bytes.byteLength * 2)),
        );
        const expanded = new Uint8Array(nextCapacity);
        expanded.set(bytes.subarray(0, totalBytes));
        bytes = expanded;
      }
      bytes.set(value, totalBytes);
      totalBytes = nextTotalBytes;
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  return {
    ok: true,
    bytes: totalBytes === bytes.byteLength ? bytes : bytes.slice(0, totalBytes),
  };
}

/** Read and decode a bounded JSON response from a trusted upstream. */
export async function readJsonResponseBody(
  response: Response,
  maxBytes: number,
): Promise<unknown | null> {
  const body = await readBoundedBody(response, maxBytes);
  if (!body.ok) return null;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body.bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Read and decode a bounded UTF-8 JSON body. */
export async function readJsonRequestBody(
  request: Request,
  maxBytes: number,
): Promise<JsonBodyResult> {
  const body = await readBoundedBody(request, maxBytes);
  if (!body.ok) {
    if (body.reason === "too_large") {
      return { ok: false, status: 413, error: "request body too large" };
    }
    if (body.reason === "missing") {
      return { ok: false, status: 400, error: "JSON request body is required" };
    }
    return { ok: false, status: 400, error: "invalid request body" };
  }

  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body.bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON request body" };
  }
}

export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "missing" | "too_large" | "unreadable" };

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

/** Read a request body without trusting Content-Length or buffering past the limit. */
export async function readBoundedBody(
  request: Request,
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
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel("request body too large");
        } catch {
          // The size decision is final even if the source cannot be cancelled.
        }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
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

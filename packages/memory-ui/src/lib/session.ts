import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeaders } from "@tanstack/react-start/server";
import {
  ANONYMOUS_SESSION,
  parseSessionResponse,
  type AuthSession,
} from "./api";
import type { UiRequestContext } from "./request-context";

const SESSION_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  vary: "Cookie",
} as const;

function safeRequestId(value: string | null): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : crypto.randomUUID();
}

export const loadSession = createServerFn({ method: "GET" }).handler(
  async ({ context }): Promise<AuthSession> => {
    const { memoryApi } = context as UiRequestContext;
    const request = getRequest();
    const requestUrl = new URL(request.url);
    const headers = new Headers({
      accept: "application/json",
      origin: requestUrl.origin,
      "sec-fetch-site": "same-origin",
      "x-request-id": safeRequestId(request.headers.get("x-request-id")),
    });
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);

    setResponseHeaders(new Headers(SESSION_RESPONSE_HEADERS));

    try {
      const response = await memoryApi.fetch(
        new Request(new URL("/api/session", requestUrl), { headers }),
      );
      if (response.status === 401) return ANONYMOUS_SESSION;
      if (!response.ok) throw new Error("session endpoint unavailable");

      const body: unknown = await response.json().catch(() => null);
      const session = parseSessionResponse(body);
      if (!session) throw new Error("invalid session response");
      return session;
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "ui_session_check_failed",
        requestId: headers.get("x-request-id"),
        errorType: error instanceof Error ? error.name : "UnknownError",
      }));
      throw new Error("Unable to verify your session. Please retry.");
    }
  },
);

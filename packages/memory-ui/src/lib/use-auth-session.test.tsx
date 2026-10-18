import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANONYMOUS_SESSION, AUTH_INVALIDATED_EVENT, type AuthSession } from "./api";
import {
  AuthSessionProvider,
  sessionRefreshDelay,
  useAuthSession,
} from "./use-auth-session";

const SESSION: AuthSession = {
  authenticated: true,
  authMode: "session",
  user: { id: "user-1", email: "user@example.test", name: "Memory User" },
  expiresAt: "2099-08-13T01:45:00.000Z",
  refreshable: true,
};

function SessionHarness() {
  const { loggedIn, user, refreshing, signingOut, signOut, error } = useAuthSession();
  return (
    <div>
      <output>{loggedIn ? user?.name : "Signed out"}</output>
      <output aria-label="Refresh state">{refreshing ? "Refreshing" : "Idle"}</output>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => void signOut()} disabled={signingOut}>
        {signingOut ? "Signing out" : "Sign out"}
      </button>
    </div>
  );
}

describe("AuthSessionProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts SSO once after the real initial refresh confirms an invalid session", async () => {
    const signInAction = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AuthSessionProvider initialSession={ANONYMOUS_SESSION} signInAction={signInAction}>
        <SessionHarness />
      </AuthSessionProvider>,
    );

    await waitFor(() => expect(signInAction).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/auth/refresh", expect.objectContaining({ method: "POST" }));
    act(() => window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT)));
    expect(signInAction).toHaveBeenCalledOnce();
  });

  it("recovers an expired access session before deciding whether to start SSO", async () => {
    const signInAction = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(SESSION)));
    render(
      <AuthSessionProvider initialSession={ANONYMOUS_SESSION} signInAction={signInAction}>
        <SessionHarness />
      </AuthSessionProvider>,
    );

    expect(await screen.findByText("Memory User")).toBeInTheDocument();
    expect(signInAction).not.toHaveBeenCalled();
  });

  it("keeps a transient refresh failure retryable without starting SSO", async () => {
    const signInAction = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "temporarily unavailable" }, { status: 503 })));
    render(
      <AuthSessionProvider initialSession={ANONYMOUS_SESSION} signInAction={signInAction}>
        <SessionHarness />
      </AuthSessionProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(signInAction).not.toHaveBeenCalled();
  });

  it("ignores a refresh invalidation after the provider unmounts", async () => {
    let resolveResponse!: (response: Response) => void;
    const signInAction = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve; })));
    const view = render(
      <AuthSessionProvider initialSession={ANONYMOUS_SESSION} signInAction={signInAction}>
        <SessionHarness />
      </AuthSessionProvider>,
    );

    view.unmount();
    await act(async () => resolveResponse(new Response(null, { status: 401 })));
    expect(signInAction).not.toHaveBeenCalled();
  });

  it("does not restart SSO when a pending real refresh fails during explicit logout", async () => {
    let resolveResponse!: (response: Response) => void;
    const signInAction = vi.fn();
    const logoutAction = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AuthSessionProvider initialSession={SESSION} signInAction={signInAction} logoutAction={logoutAction}>
        <SessionHarness />
      </AuthSessionProvider>,
    );

    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await act(async () => resolveResponse(new Response(null, { status: 401 })));
    await waitFor(() => expect(logoutAction).toHaveBeenCalledOnce());
    expect(signInAction).not.toHaveBeenCalled();
  });

  it("schedules refresh two minutes before access-token expiry", () => {
    expect(sessionRefreshDelay(
      { ...SESSION, expiresAt: "2026-08-13T01:45:00.000Z" },
      Date.parse("2026-08-13T01:30:00.000Z"),
    )).toBe(13 * 60 * 1000);
    expect(sessionRefreshDelay(
      { ...SESSION, expiresAt: "2026-08-13T01:45:00.000Z" },
      Date.parse("2026-08-13T01:44:00.000Z"),
    )).toBe(0);
  });
  it("removes legacy JS-readable credentials during hydration", async () => {
    sessionStorage.setItem("memory_token", "legacy-token-must-not-be-read");
    sessionStorage.setItem("memory_expires_at", "2099-01-01T00:00:00.000Z");
    document.cookie = "memory_token=legacy-token-must-not-be-read; Secure; SameSite=Lax; Path=/";

    render(
      <AuthSessionProvider initialSession={SESSION}>
        <SessionHarness />
      </AuthSessionProvider>,
    );

    await waitFor(() => expect(sessionStorage.getItem("memory_token")).toBeNull());
    expect(sessionStorage.getItem("memory_expires_at")).toBeNull();
    expect(document.cookie).not.toContain("memory_token=");
  });

  it("hydrates from the server session and clears it after server logout", async () => {
    const logoutAction = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <AuthSessionProvider initialSession={SESSION} logoutAction={logoutAction}>
        <SessionHarness />
      </AuthSessionProvider>,
    );

    expect(screen.getByText("Memory User")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(logoutAction).toHaveBeenCalledOnce();
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
  });

  it("becomes anonymous when any API call reports an invalid session", async () => {
    const signInAction = vi.fn();
    render(
      <AuthSessionProvider initialSession={SESSION} signInAction={signInAction}>
        <SessionHarness />
      </AuthSessionProvider>,
    );

    window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT));
    await waitFor(() => expect(screen.getByText("Signed out")).toBeInTheDocument());
    expect(signInAction).toHaveBeenCalledOnce();
  });

  it("deduplicates overlapping refresh triggers without rotating twice", async () => {
    let resolveRefresh!: (session: AuthSession) => void;
    const sessionLoader = vi.fn((_signal?: AbortSignal) => new Promise<AuthSession>(
      (resolve) => { resolveRefresh = resolve; },
    ));
    render(
      <AuthSessionProvider initialSession={SESSION} sessionLoader={sessionLoader}>
        <SessionHarness />
      </AuthSessionProvider>,
    );

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await waitFor(() => expect(sessionLoader).toHaveBeenCalledOnce());
    resolveRefresh(SESSION);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(sessionLoader).toHaveBeenCalledOnce();
  });

  it("cannot be signed back in by a refresh that was pending during logout", async () => {
    let resolveRefresh!: (session: AuthSession) => void;
    const sessionLoader = vi.fn((_signal?: AbortSignal) => new Promise<AuthSession>(
      (resolve) => { resolveRefresh = resolve; },
    ));
    const logoutAction = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <AuthSessionProvider
        initialSession={SESSION}
        sessionLoader={sessionLoader}
        logoutAction={logoutAction}
      >
        <SessionHarness />
      </AuthSessionProvider>,
    );

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await waitFor(() => expect(sessionLoader).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    resolveRefresh({
      authenticated: true,
      authMode: "session",
      user: { id: "late-user", email: null, name: "Late refresh" },
      expiresAt: "2026-08-13T02:00:00.000Z",
      refreshable: true,
    });

    await waitFor(() => expect(logoutAction).toHaveBeenCalledOnce());
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(screen.queryByText("Late refresh")).not.toBeInTheDocument();
  });

  it("clears refreshing after a concurrent logout fails", async () => {
    let resolveRefresh!: (session: AuthSession) => void;
    const sessionLoader = () => new Promise<AuthSession>((resolve) => {
      resolveRefresh = resolve;
    });
    const logoutAction = async () => { throw new Error("Logout temporarily unavailable"); };
    const user = userEvent.setup();
    render(
      <AuthSessionProvider
        initialSession={SESSION}
        sessionLoader={sessionLoader}
        logoutAction={logoutAction}
      >
        <SessionHarness />
      </AuthSessionProvider>,
    );

    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(screen.getByLabelText("Refresh state")).toHaveTextContent("Refreshing");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await act(async () => resolveRefresh(SESSION));

    expect(await screen.findByRole("alert")).toHaveTextContent("Logout temporarily unavailable");
    expect(screen.getByText("Memory User")).toBeInTheDocument();
    expect(screen.getByLabelText("Refresh state")).toHaveTextContent("Idle");
  });
});

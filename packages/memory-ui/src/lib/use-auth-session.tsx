import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ANONYMOUS_SESSION,
  AUTH_INVALIDATED_EVENT,
  clearLegacyClientCredentials,
  logout,
  refreshSession,
  type AuthMode,
  type AuthSession,
  type SessionUser,
} from "./api";

interface AuthSessionState {
  ready: true;
  loggedIn: boolean;
  user: SessionUser | null;
  authMode: AuthMode | null;
  refreshing: boolean;
  signingOut: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<boolean>;
}

interface AuthSessionProviderProps {
  children: ReactNode;
  initialSession: AuthSession;
  sessionLoader?: typeof refreshSession;
  logoutAction?: typeof logout;
}

const AuthSessionContext = createContext<AuthSessionState | null>(null);
const SESSION_REFRESH_SKEW_MS = 2 * 60 * 1000;
const LEGACY_SESSION_REFRESH_INTERVAL_MS = 12 * 60 * 1000;
const MAX_BROWSER_TIMEOUT_MS = 2_147_000_000;
const TRANSIENT_REFRESH_RETRY_MS = 30 * 1000;

export function sessionRefreshDelay(
  session: AuthSession,
  now = Date.now(),
): number | null {
  if (!session.authenticated) return null;
  if (!session.refreshable) return null;
  if (!session.expiresAt) return LEGACY_SESSION_REFRESH_INTERVAL_MS;
  const expiry = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiry)) return 0;
  return Math.min(
    MAX_BROWSER_TIMEOUT_MS,
    Math.max(0, expiry - now - SESSION_REFRESH_SKEW_MS),
  );
}

export function AuthSessionProvider({
  children,
  initialSession,
  sessionLoader = refreshSession,
  logoutAction = logout,
}: AuthSessionProviderProps) {
  const [session, setSession] = useState(initialSession);
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const refreshPromise = useRef<Promise<AuthSession> | null>(null);
  const signingOutRef = useRef(false);
  const invalidatedRef = useRef(false);
  const retryTimer = useRef<number | null>(null);
  const attemptedInitialRefresh = useRef(false);
  const sessionRef = useRef(session);
  const mounted = useRef(true);
  sessionRef.current = session;

  const refresh = useCallback(async () => {
    if (signingOutRef.current || invalidatedRef.current) return;
    if (refreshPromise.current) {
      return;
    }
    const controller = new AbortController();
    refreshController.current = controller;
    const generation = ++refreshGeneration.current;
    setRefreshing(true);
    setError(null);
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }

    try {
      const pending = sessionLoader(controller.signal);
      refreshPromise.current = pending;
      const nextSession = await pending;
      if (mounted.current && generation === refreshGeneration.current) {
        setSession(nextSession);
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        setError(cause instanceof Error ? cause.message : "Unable to verify your session.");
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          void refresh();
        }, TRANSIENT_REFRESH_RETRY_MS);
      }
    } finally {
      if (generation === refreshGeneration.current) {
        refreshController.current = null;
        refreshPromise.current = null;
        if (mounted.current) setRefreshing(false);
      }
    }
  }, [sessionLoader]);

  const signOut = useCallback(async () => {
    if (signingOutRef.current) return false;
    signingOutRef.current = true;
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    refreshGeneration.current += 1;
    refreshController.current?.abort();
    const pendingRefresh = refreshPromise.current;
    setSigningOut(true);
    setError(null);
    try {
      await pendingRefresh?.catch(() => undefined);
      if (refreshPromise.current === pendingRefresh) {
        refreshPromise.current = null;
        refreshController.current = null;
      }
      await logoutAction();
      if (mounted.current) setSession(ANONYMOUS_SESSION);
      return true;
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Unable to sign out.");
      }
      return false;
    } finally {
      signingOutRef.current = false;
      if (mounted.current) setSigningOut(false);
    }
  }, [logoutAction]);

  useEffect(() => {
    mounted.current = true;
    clearLegacyClientCredentials();
    const invalidate = () => {
      invalidatedRef.current = true;
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      refreshGeneration.current += 1;
      refreshController.current?.abort();
      refreshController.current = null;
      refreshPromise.current = null;
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      setSession(ANONYMOUS_SESSION);
      setRefreshing(false);
      setSigningOut(false);
    };
    const revalidateRestoredPage = (event: PageTransitionEvent) => {
      if (event.persisted) void refresh();
    };
    const refreshActivePage = () => {
      if (document.visibilityState !== "visible") return;
      const delay = sessionRefreshDelay(sessionRef.current);
      if (delay !== null && delay <= SESSION_REFRESH_SKEW_MS) void refresh();
    };
    window.addEventListener(AUTH_INVALIDATED_EVENT, invalidate);
    window.addEventListener("pageshow", revalidateRestoredPage);
    window.addEventListener("focus", refreshActivePage);
    document.addEventListener("visibilitychange", refreshActivePage);
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
      refreshController.current?.abort();
      window.removeEventListener(AUTH_INVALIDATED_EVENT, invalidate);
      window.removeEventListener("pageshow", revalidateRestoredPage);
      window.removeEventListener("focus", refreshActivePage);
      document.removeEventListener("visibilitychange", refreshActivePage);
    };
  }, [refresh]);

  useEffect(() => {
    if (!session.authenticated) {
      if (!attemptedInitialRefresh.current) {
        attemptedInitialRefresh.current = true;
        void refresh();
      }
      return;
    }

    invalidatedRef.current = false;
    attemptedInitialRefresh.current = true;
    const delay = sessionRefreshDelay(session);
    if (delay === null) return;
    const timer = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [refresh, session]);

  const value = useMemo<AuthSessionState>(() => ({
    ready: true,
    loggedIn: session.authenticated,
    user: session.user,
    authMode: session.authMode,
    refreshing,
    signingOut,
    error,
    refresh,
    signOut,
  }), [error, refresh, refreshing, session, signOut, signingOut]);

  return (
    <AuthSessionContext.Provider value={value}>
      {children}
    </AuthSessionContext.Provider>
  );
}

export function useAuthSession(): AuthSessionState {
  const session = useContext(AuthSessionContext);
  if (!session) {
    throw new Error("useAuthSession must be used inside AuthSessionProvider");
  }
  return session;
}

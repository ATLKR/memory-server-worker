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
  fetchSession,
  logout,
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
  sessionLoader?: typeof fetchSession;
  logoutAction?: typeof logout;
}

const AuthSessionContext = createContext<AuthSessionState | null>(null);

export function AuthSessionProvider({
  children,
  initialSession,
  sessionLoader = fetchSession,
  logoutAction = logout,
}: AuthSessionProviderProps) {
  const [session, setSession] = useState(initialSession);
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const generation = ++refreshGeneration.current;
    setRefreshing(true);
    setError(null);

    try {
      const nextSession = await sessionLoader(controller.signal);
      if (mounted.current && generation === refreshGeneration.current) {
        setSession(nextSession);
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        setError(cause instanceof Error ? cause.message : "Unable to verify your session.");
      }
    } finally {
      if (generation === refreshGeneration.current) {
        refreshController.current = null;
        if (mounted.current) setRefreshing(false);
      }
    }
  }, [sessionLoader]);

  const signOut = useCallback(async () => {
    if (signingOut) return false;
    setSigningOut(true);
    setError(null);
    try {
      await logoutAction();
      if (mounted.current) setSession(ANONYMOUS_SESSION);
      return true;
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Unable to sign out.");
      }
      return false;
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  }, [logoutAction, signingOut]);

  useEffect(() => {
    mounted.current = true;
    clearLegacyClientCredentials();
    const invalidate = () => {
      setSession(ANONYMOUS_SESSION);
      setRefreshing(false);
      setSigningOut(false);
    };
    const revalidateRestoredPage = (event: PageTransitionEvent) => {
      if (event.persisted) void refresh();
    };
    window.addEventListener(AUTH_INVALIDATED_EVENT, invalidate);
    window.addEventListener("pageshow", revalidateRestoredPage);
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
      refreshController.current?.abort();
      window.removeEventListener(AUTH_INVALIDATED_EVENT, invalidate);
      window.removeEventListener("pageshow", revalidateRestoredPage);
    };
  }, [refresh]);

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
